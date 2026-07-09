import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { check, errorCheck } from "./checks.js";
import type { ValidationCheckResult, ValidationValidator, ValidationValidatorContext } from "./types.js";

function count(database: DatabaseSync, sql: string): number {
  return (database.prepare(sql).get() as { count: number }).count;
}

export class CrashRecoveryValidation implements ValidationValidator {
  readonly type = "CRASH_RECOVERY" as const;

  async run(context: ValidationValidatorContext): Promise<ValidationCheckResult[]> {
    const database = new DatabaseSync(context.databasePath);
    database.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;");
    try {
      return [
        this.transactionRollback(database, context.now),
        this.recoveryIdempotency(database, context.now),
        this.recoveryStateIntegrity(database, context.now),
      ];
    } catch (error) {
      return [errorCheck({ checkType: this.type, checkName: "crash_recovery_exception", reason: "CRASH_RECOVERY_VALIDATION_FAILED", error, now: context.now })];
    } finally {
      database.close();
    }
  }

  private transactionRollback(database: DatabaseSync, now: () => Date): ValidationCheckResult {
    const probeId = `probe-${randomUUID()}`;
    database.exec("CREATE TABLE IF NOT EXISTS validation_crash_probe(probe_id TEXT PRIMARY KEY, created_at TEXT NOT NULL)");
    database.exec("BEGIN IMMEDIATE");
    try {
      database.prepare("INSERT INTO validation_crash_probe(probe_id,created_at) VALUES (?, ?)").run(probeId, now().toISOString());
      throw new Error("INTENTIONAL_CRASH_PROBE");
    } catch {
      database.exec("ROLLBACK");
    }
    const row = database.prepare("SELECT count(*) count FROM validation_crash_probe WHERE probe_id=?").get(probeId) as { count: number };
    return check({
      checkType: this.type,
      checkName: "transaction_rollback",
      status: row.count === 0 ? "PASS" : "FAIL",
      reason: row.count === 0 ? "OK" : "ROLLBACK_PROBE_PERSISTED",
      metrics: { probePersisted: row.count },
      now,
    });
  }

  private recoveryIdempotency(database: DatabaseSync, now: () => Date): ValidationCheckResult {
    const metrics = {
      duplicatePaperExecutions: count(database, `SELECT count(*) count FROM (
        SELECT execution_idempotency_key FROM paper_executions GROUP BY execution_idempotency_key HAVING count(*)>1
      )`),
      duplicateLiveExecutions: count(database, `SELECT count(*) count FROM (
        SELECT execution_idempotency_key FROM live_executions GROUP BY execution_idempotency_key HAVING count(*)>1
      )`),
      duplicateLiveFills: count(database, `SELECT count(*) count FROM (
        SELECT fill_idempotency_key FROM live_fills GROUP BY fill_idempotency_key HAVING count(*)>1
      )`),
    };
    const failures = Object.values(metrics).reduce((total, value) => total + value, 0);
    return check({
      checkType: this.type,
      checkName: "restart_idempotency",
      status: failures === 0 ? "PASS" : "FAIL",
      reason: failures === 0 ? "OK" : "DUPLICATE_IDEMPOTENCY_KEYS",
      metrics,
      now,
    });
  }

  private recoveryStateIntegrity(database: DatabaseSync, now: () => Date): ValidationCheckResult {
    const metrics = {
      paperWaitingWithoutReservation: count(database, `SELECT count(*) count
        FROM paper_executions e
        LEFT JOIN paper_reservations r ON r.paper_execution_id=e.paper_execution_id
        WHERE e.execution_type='TARGET_BUY' AND e.state='WAITING_EXECUTION' AND r.paper_execution_id IS NULL`),
      liveFilledOrdersWithoutFills: count(database, `SELECT count(*) count
        FROM live_orders o
        LEFT JOIN live_fills f ON f.live_order_id=o.live_order_id
        WHERE o.status IN ('FILLED','PARTIALLY_FILLED') AND f.live_order_id IS NULL`),
      liveUnknownExecutions: count(database, "SELECT count(*) count FROM live_executions WHERE state='FAILED' AND reason LIKE '%UNKNOWN%'"),
    };
    const failures = Object.values(metrics).reduce((total, value) => total + value, 0);
    return check({
      checkType: this.type,
      checkName: "recovery_state_integrity",
      status: failures === 0 ? "PASS" : "FAIL",
      reason: failures === 0 ? "OK" : "RECOVERY_STATE_INCONSISTENT",
      metrics,
      now,
    });
  }
}
