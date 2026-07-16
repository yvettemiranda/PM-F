import type { DatabaseSync } from "node:sqlite";
import type { PublicMarketDataCapture } from "../../execution/market-data.js";
import { VERSIONS } from "../../domain/versioning.js";
import { captureIdentityFromResponseJson } from "../../services/capture-manifest.js";
import { storeCompressedCapturePayload } from "./capture-payload.js";

export function persistPublicMarketCapture(
  database: DatabaseSync,
  capture: PublicMarketDataCapture | undefined,
  expected: {
    endpoint: PublicMarketDataCapture["endpoint"];
    requestUrl: string;
    fetchedAt: string;
  },
): string | null {
  if (!capture) return null;
  if (
    capture.endpoint !== expected.endpoint
    || capture.requestUrl !== expected.requestUrl
    || capture.fetchedAt !== expected.fetchedAt
    || capture.httpStatus !== 200
    || !Number.isFinite(capture.latencyMs)
    || capture.latencyMs < 0
  ) {
    throw new Error("PUBLIC_MARKET_CAPTURE_BINDING_INVALID");
  }
  const responseJson = JSON.stringify(capture.payload);
  const { captureId, payloadSha256 } = captureIdentityFromResponseJson(
    capture.requestUrl,
    capture.fetchedAt,
    responseJson,
  );
  storeCompressedCapturePayload(database, payloadSha256, responseJson, capture.fetchedAt);
  database.prepare(
    `INSERT OR IGNORE INTO api_captures(
      capture_id,endpoint,request_url,fetched_at,latency_ms,http_status,
      payload_sha256,response_json,schema_version,response_encoding
    ) VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, 'GZIP_SHA256')`,
  ).run(
    captureId,
    capture.endpoint,
    capture.requestUrl,
    capture.fetchedAt,
    capture.latencyMs,
    capture.httpStatus,
    payloadSha256,
    VERSIONS.schemaVersion,
  );
  const stored = database.prepare(
    `SELECT endpoint,request_url,fetched_at,latency_ms,http_status,payload_sha256,
            schema_version,response_encoding
     FROM api_captures WHERE capture_id=?`,
  ).get(captureId) as {
    endpoint: string;
    request_url: string;
    fetched_at: string;
    latency_ms: number;
    http_status: number;
    payload_sha256: string;
    schema_version: string;
    response_encoding: string;
  } | undefined;
  if (
    !stored
    || stored.endpoint !== capture.endpoint
    || stored.request_url !== capture.requestUrl
    || stored.fetched_at !== capture.fetchedAt
    || stored.latency_ms !== capture.latencyMs
    || stored.http_status !== capture.httpStatus
    || stored.payload_sha256 !== payloadSha256
    || stored.schema_version !== VERSIONS.schemaVersion
    || stored.response_encoding !== "GZIP_SHA256"
  ) {
    throw new Error("PUBLIC_MARKET_CAPTURE_IMMUTABLE_CONFLICT");
  }
  return captureId;
}

export function assertPaperMarketSnapshotCaptureBinding(
  database: DatabaseSync,
  table: "paper_orderbook_snapshots" | "paper_fee_snapshots",
  idColumn: "orderbook_snapshot_id" | "fee_snapshot_id",
  snapshotId: string,
  expectedCaptureId: string | null,
): void {
  const stored = database.prepare(
    `SELECT source_capture_id FROM ${table} WHERE ${idColumn}=?`,
  ).get(snapshotId) as { source_capture_id: string | null } | undefined;
  if (!stored || stored.source_capture_id !== expectedCaptureId) {
    throw new Error(`PAPER_MARKET_SNAPSHOT_CAPTURE_CONFLICT:${table}:${snapshotId}`);
  }
}
