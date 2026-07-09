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
      const integrity = (database.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check;
      const foreignKeys = database.prepare("PRAGMA foreign_key_check").all() as unknown[];
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
        databaseIntegrityStatus: integrity === "ok" && foreignKeys.length === 0 ? "OK" : "FAILED",
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
