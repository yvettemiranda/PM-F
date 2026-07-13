import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { ApiCapture } from "../src/adapters/polymarket-public.js";
import { VERSIONS } from "../src/domain/versioning.js";
import { Phase0Database } from "../src/infra/sqlite/database.js";
import type { SourceVersion } from "../src/infra/source-version.js";
import { buildCaptureManifest, captureIdentity } from "../src/services/capture-manifest.js";

const directories: string[] = [];
const sourceVersion: SourceVersion = { commit: "capture-storage-test", dirty: false };

function setup() {
  const directory = mkdtempSync(join(tmpdir(), "ni-k-capture-storage-"));
  directories.push(directory);
  const databasePath = join(directory, "phase0.sqlite");
  const database = new Phase0Database(databasePath, sourceVersion);
  database.initialize();
  return { database, databasePath };
}

function capture(fetchedAt: string): ApiCapture<Array<{ timestamp: number; payload: string }>> {
  return {
    url: "https://example.test/trades?user=wallet",
    fetchedAt,
    latencyMs: 10,
    status: 200,
    data: Array.from({ length: 100 }, (_, index) => ({ timestamp: index, payload: "same-payload".repeat(20) })),
  };
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("capture payload storage", () => {
  it("gzip-compresses and deduplicates identical payloads without losing replay input", () => {
    const env = setup();
    const first = capture("2026-07-10T00:00:00.000Z");
    const second = capture("2026-07-10T00:00:15.000Z");
    env.database.saveCapture("data-trades", first);
    env.database.saveCapture("data-trades", second);
    const manifest = buildCaptureManifest({
      walletAddress: "0x0000000000000000000000000000000000000001",
      sampleRole: "TARGET",
      purpose: "CAPTURE_STORAGE_TEST",
      sourceVersion,
      sources: [
        { endpoint: "data-trades", capture: first, pageIndex: 0, paginationStatus: "HAS_MORE" },
        { endpoint: "data-trades", capture: second, pageIndex: 1, paginationStatus: "END_OF_DATA" },
      ],
    });
    env.database.saveCaptureManifest(null, manifest);

    expect(env.database.loadCapturePayloads(manifest.captureRunId, "data-trades")).toEqual([first.data, second.data]);
    env.database.close();

    const sql = new DatabaseSync(env.databasePath, { readOnly: true });
    const payloads = sql.prepare(
      "SELECT count(*) count,sum(compressed_bytes) compressed,sum(uncompressed_bytes) uncompressed FROM api_capture_payloads",
    ).get() as { count: number; compressed: number; uncompressed: number };
    const captures = sql.prepare(
      "SELECT count(*) count,count(DISTINCT payload_sha256) hashes,min(response_encoding) encoding FROM api_captures",
    ).get() as { count: number; hashes: number; encoding: string };
    sql.close();
    expect(captures).toEqual({ count: 2, hashes: 1, encoding: "GZIP_SHA256" });
    expect(payloads.count).toBe(1);
    expect(payloads.compressed).toBeLessThan(payloads.uncompressed);
  });

  it("continues to read captures stored before the compression migration", () => {
    const env = setup();
    const legacy = capture("2026-07-09T00:00:00.000Z");
    const identity = captureIdentity(legacy);
    const sql = new DatabaseSync(env.databasePath);
    sql.prepare(
      `INSERT INTO api_captures(
        capture_id,endpoint,request_url,fetched_at,latency_ms,http_status,payload_sha256,
        response_json,schema_version,response_encoding
      ) VALUES (?, 'data-trades', ?, ?, ?, ?, ?, ?, ?, 'INLINE_JSON')`,
    ).run(
      identity.captureId,
      legacy.url,
      legacy.fetchedAt,
      legacy.latencyMs,
      legacy.status,
      identity.payloadSha256,
      JSON.stringify(legacy.data),
      VERSIONS.schemaVersion,
    );
    sql.close();
    const manifest = buildCaptureManifest({
      walletAddress: "0x0000000000000000000000000000000000000001",
      sampleRole: "TARGET",
      purpose: "LEGACY_CAPTURE_STORAGE_TEST",
      sourceVersion,
      sources: [{ endpoint: "data-trades", capture: legacy, paginationStatus: "END_OF_DATA" }],
    });
    env.database.saveCaptureManifest(null, manifest);
    expect(env.database.loadCapturePayloads(manifest.captureRunId, "data-trades")).toEqual([legacy.data]);
    env.database.close();
  });

  it("fails closed when compressed capture bytes are corrupt", () => {
    const env = setup();
    const value = capture("2026-07-10T00:00:00.000Z");
    env.database.saveCapture("data-trades", value);
    const manifest = buildCaptureManifest({
      walletAddress: "0x0000000000000000000000000000000000000001",
      sampleRole: "TARGET",
      purpose: "CORRUPT_CAPTURE_STORAGE_TEST",
      sourceVersion,
      sources: [{ endpoint: "data-trades", capture: value, paginationStatus: "END_OF_DATA" }],
    });
    env.database.saveCaptureManifest(null, manifest);
    const sql = new DatabaseSync(env.databasePath);
    // Explicitly bypass the production append-only guard to simulate physical
    // corruption in this fail-closed decoder test.
    sql.exec("DROP TRIGGER api_capture_payloads_no_update");
    sql.prepare("UPDATE api_capture_payloads SET payload_blob=x'00010203'").run();
    sql.close();
    expect(() => env.database.loadCapturePayloads(manifest.captureRunId, "data-trades")).toThrow();
    env.database.close();
  });
});
