import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import type { DatabaseSync } from "node:sqlite";

export type CaptureResponseEncoding = "INLINE_JSON" | "GZIP_SHA256";

export interface CapturePayloadRow {
  payload_sha256: string;
  response_json: string;
  response_encoding: CaptureResponseEncoding;
  payload_blob: Uint8Array | null;
  uncompressed_bytes: number | null;
}

export function storeCompressedCapturePayload(
  database: DatabaseSync,
  payloadSha256: string,
  responseJson: string,
  createdAt: string,
): void {
  const uncompressedBytes = Buffer.byteLength(responseJson, "utf8");
  const existing = database.prepare(
    "SELECT uncompressed_bytes FROM api_capture_payloads WHERE payload_sha256=?",
  ).get(payloadSha256) as { uncompressed_bytes: number } | undefined;
  if (existing) {
    if (existing.uncompressed_bytes !== uncompressedBytes) throw new Error("CAPTURE_PAYLOAD_DEDUPLICATION_MISMATCH");
    return;
  }
  const calculated = createHash("sha256").update(responseJson).digest("hex");
  if (calculated !== payloadSha256) throw new Error("CAPTURE_PAYLOAD_HASH_MISMATCH");
  const compressed = gzipSync(Buffer.from(responseJson, "utf8"));
  database.prepare(
    `INSERT OR IGNORE INTO api_capture_payloads(
      payload_sha256,compression,payload_blob,uncompressed_bytes,compressed_bytes,created_at
    ) VALUES (?, 'GZIP', ?, ?, ?, ?)`,
  ).run(payloadSha256, compressed, uncompressedBytes, compressed.byteLength, createdAt);

  const stored = database.prepare(
    "SELECT uncompressed_bytes FROM api_capture_payloads WHERE payload_sha256=?",
  ).get(payloadSha256) as { uncompressed_bytes: number } | undefined;
  if (!stored || stored.uncompressed_bytes !== uncompressedBytes) {
    throw new Error("CAPTURE_PAYLOAD_DEDUPLICATION_MISMATCH");
  }
}

export function decodeCapturePayload(row: CapturePayloadRow): unknown {
  if (row.response_encoding === "INLINE_JSON") return JSON.parse(row.response_json) as unknown;
  if (row.response_encoding !== "GZIP_SHA256" || row.payload_blob === null || row.uncompressed_bytes === null) {
    throw new Error(`CAPTURE_PAYLOAD_UNAVAILABLE:${row.payload_sha256}`);
  }
  const json = gunzipSync(row.payload_blob).toString("utf8");
  if (Buffer.byteLength(json, "utf8") !== row.uncompressed_bytes) {
    throw new Error(`CAPTURE_PAYLOAD_SIZE_MISMATCH:${row.payload_sha256}`);
  }
  const calculated = createHash("sha256").update(json).digest("hex");
  if (calculated !== row.payload_sha256) throw new Error(`CAPTURE_PAYLOAD_CORRUPT:${row.payload_sha256}`);
  return JSON.parse(json) as unknown;
}
