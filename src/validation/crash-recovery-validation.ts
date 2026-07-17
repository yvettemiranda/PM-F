import { randomUUID } from "node:crypto";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { check, errorCheck } from "./checks.js";
import type { ValidationCheckResult, ValidationValidator, ValidationValidatorContext } from "./types.js";

function count(database: DatabaseSync, sql: string, ...params: SQLInputValue[]): number {
  return (database.prepare(sql).get(...params) as { count: number }).count;
}

export class CrashRecoveryValidation implements ValidationValidator {
  readonly type = "CRASH_RECOVERY" as const;

  async run(context: ValidationValidatorContext): Promise<ValidationCheckResult[]> {
    const database = new DatabaseSync(context.databasePath);
    database.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;");
    try {
      return [
        this.snapshotTransactionRollbackProbe(database, context.now),
        this.recoveryIdempotency(database, context.scope.accountId, context.now),
        this.recoveryStateIntegrity(database, context.scope.accountId, context.now),
        this.runtimeCrashRecoveryEvidence(database, context.scope.campaignId, context.scope.sessionId, context.now),
      ];
    } catch (error) {
      return [errorCheck({ checkType: this.type, checkName: "crash_recovery_exception", reason: "CRASH_RECOVERY_VALIDATION_FAILED", error, now: context.now })];
    } finally {
      database.close();
    }
  }

  private snapshotTransactionRollbackProbe(database: DatabaseSync, now: () => Date): ValidationCheckResult {
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
      checkName: "snapshot_transaction_rollback_probe",
      status: row.count === 0 ? "PASS" : "FAIL",
      reason: row.count === 0 ? "OK" : "ROLLBACK_PROBE_PERSISTED",
      metrics: {
        probePersisted: row.count,
        evidenceLevel: "CONTROLLED_SNAPSHOT_TRANSACTION",
        provesProcessCrashRecovery: false,
      },
      now,
    });
  }

  private recoveryIdempotency(database: DatabaseSync, accountId: string, now: () => Date): ValidationCheckResult {
    const metrics = {
      duplicatePaperExecutions: count(database, `SELECT count(*) count FROM (
        SELECT execution_idempotency_key FROM paper_executions WHERE paper_account_id=?
        GROUP BY execution_idempotency_key HAVING count(*)>1
      )`, accountId),
      duplicateSignalConsumptions: count(database, `SELECT count(*) count FROM (
        SELECT signal_id FROM paper_signal_consumptions WHERE paper_account_id=?
        GROUP BY signal_id HAVING count(*)>1
      )`, accountId),
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

  private recoveryStateIntegrity(database: DatabaseSync, accountId: string, now: () => Date): ValidationCheckResult {
    const metrics = {
      paperWaitingWithoutReservation: count(database, `SELECT count(*) count
        FROM paper_executions e
        LEFT JOIN paper_reservations r ON r.paper_execution_id=e.paper_execution_id
        WHERE e.paper_account_id=? AND e.execution_type='TARGET_BUY'
          AND e.state='WAITING_EXECUTION' AND r.paper_execution_id IS NULL`, accountId),
      fillsWithoutScopedOrders: count(database, `SELECT count(*) count
        FROM paper_fill_ledger f
        JOIN paper_executions e ON e.paper_execution_id=f.paper_execution_id
        LEFT JOIN paper_orders o ON o.paper_order_id=f.paper_order_id
        WHERE e.paper_account_id=? AND o.paper_order_id IS NULL`, accountId),
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

  private runtimeCrashRecoveryEvidence(
    database: DatabaseSync,
    campaignId: string,
    sessionId: string,
    now: () => Date,
  ): ValidationCheckResult {
    const row = database.prepare(
      `SELECT report_id,report_json FROM paper_validation_reports
       WHERE campaign_id=? AND session_id=? AND report_scope='SESSION'
       ORDER BY created_at DESC LIMIT 1`,
    ).get(campaignId, sessionId) as { report_id: string; report_json: string } | undefined;
    let evidence: unknown = null;
    if (row) {
      try {
        const report = JSON.parse(row.report_json) as { coverage?: Record<string, unknown> };
        evidence = report.coverage?.CRASH_RECOVERY ?? null;
      } catch {
        evidence = null;
      }
    }
    const source = evidence && typeof evidence === "object" && "source" in evidence
      ? String((evidence as { source: unknown }).source)
      : null;
    const runtimeEvidence = source === "NATURAL" || source === "REAL_EXECUTION_REPLAY";
    return check({
      checkType: this.type,
      checkName: "runtime_process_crash_recovery_evidence",
      status: runtimeEvidence ? "PASS" : "WARN",
      blocking: false,
      reason: runtimeEvidence ? "OK" : "PROCESS_CRASH_RECOVERY_EVIDENCE_NOT_ESTABLISHED",
      metrics: {
        reportId: row?.report_id ?? null,
        evidence,
        evidenceLevel: runtimeEvidence ? source : "CONTROLLED_OR_MISSING",
      },
      now,
    });
  }
}
