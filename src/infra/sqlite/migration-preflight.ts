import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { stableJson } from "../../domain/versioning.js";

interface LegacyProjectionCheckpointRow {
  checkpoint_id: string;
  position_projection_json: string;
  position_projection_hash: string;
}

/**
 * SQLite has no project-canonical JSON serializer or SHA-256 primitive. Run
 * this check in the same migration transaction immediately before migration
 * 028 creates content-addressed projection snapshots.
 */
export function assertObserveProjectionSnapshotMigrationPreflight(database: DatabaseSync): void {
  const rows = database.prepare(
    `SELECT checkpoint_id,position_projection_json,position_projection_hash
     FROM observe_checkpoints
     ORDER BY checkpoint_id`,
  ).all() as unknown as LegacyProjectionCheckpointRow[];
  const canonicalPayloadByHash = new Map<string, string>();

  for (const row of rows) {
    let canonicalPayload: string;
    try {
      canonicalPayload = stableJson(JSON.parse(row.position_projection_json) as unknown);
    } catch {
      throw new Error(`MIGRATION_028_PROJECTION_JSON_INVALID:${row.checkpoint_id}`);
    }

    const previousPayload = canonicalPayloadByHash.get(row.position_projection_hash);
    if (previousPayload !== undefined && previousPayload !== canonicalPayload) {
      throw new Error(`MIGRATION_028_PROJECTION_HASH_PAYLOAD_CONFLICT:${row.position_projection_hash}`);
    }
    canonicalPayloadByHash.set(row.position_projection_hash, canonicalPayload);

    const canonicalHash = createHash("sha256").update(canonicalPayload).digest("hex");
    if (canonicalHash !== row.position_projection_hash) {
      throw new Error(`MIGRATION_028_PROJECTION_HASH_MISMATCH:${row.checkpoint_id}`);
    }
  }
}
