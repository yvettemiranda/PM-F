import { existsSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { OperationalHealthSnapshot } from "./types.js";

function count(database: DatabaseSync, sql: string): number {
  return (database.prepare(sql).get() as { count: number }).count;
}

export class OperationalHealthMonitor {
  constructor(
    private readonly databasePath: string,
    private readonly startedAt: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  snapshot(): OperationalHealthSnapshot {
    const database = new DatabaseSync(this.databasePath, { readOnly: true });
    try {
      // The 1-second health path uses SQLite's bounded quick check. Full
      // integrity_check remains in startup/final consistency validation; doing
      // a full database scan every heartbeat would itself create soak drift.
      const integrity = (database.prepare("PRAGMA quick_check(1)").get() as { quick_check: string }).quick_check;
      const migration = database.prepare("SELECT version FROM schema_migrations ORDER BY applied_at DESC,version DESC LIMIT 1")
        .get() as { version: string } | undefined;
      const observe = database.prepare(
        `SELECT
           COALESCE(sum(failed_polls),0) api_failure_count,
           COALESCE(sum(duplicate_events),0) duplicate_event_count,
           COALESCE(sum(gap_events),0) missed_event_count
         FROM observe_runs`,
      ).get() as { api_failure_count: number; duplicate_event_count: number; missed_event_count: number };
      const reconnectCount = count(database, "SELECT count(*) count FROM observe_polls WHERE status='API_FAILED'");
      return {
        uptimeMs: Math.max(0, this.now().valueOf() - Date.parse(this.startedAt)),
        databaseSizeBytes: existsSync(this.databasePath) ? statSync(this.databasePath).size : 0,
        migrationVersion: migration?.version ?? null,
        // Foreign-key validation remains part of the full consistency pass.
        // Running foreign_key_check on every heartbeat would scan all child
        // tables and reintroduce the same soak-time cost as integrity_check.
        databaseIntegrityStatus: integrity === "ok" ? "OK" : "FAILED",
        apiFailureCount: Number(observe.api_failure_count ?? 0),
        reconnectCount,
        duplicateEventCount: Number(observe.duplicate_event_count ?? 0),
        missedEventCount: Number(observe.missed_event_count ?? 0),
      };
    } finally {
      database.close();
    }
  }
}
