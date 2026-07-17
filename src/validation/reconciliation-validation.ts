import { DatabaseSync } from "node:sqlite";
import { check, errorCheck } from "./checks.js";
import { checkScopedInvariants, scopedObserveRunIds } from "./scoped-invariants.js";
import type { ValidationCheckResult, ValidationValidator, ValidationValidatorContext } from "./types.js";

interface ReconciliationReportRow {
  reconciliation_report_id: string;
  observe_run_id: string;
  sync_status: "SYNCED" | "MINOR_DIFF" | "MAJOR_DESYNC";
  created_at: string;
}

export class ReconciliationValidation implements ValidationValidator {
  readonly type = "RECONCILIATION" as const;

  async run(context: ValidationValidatorContext): Promise<ValidationCheckResult[]> {
    const database = new DatabaseSync(context.databasePath, { readOnly: true });
    try {
      const invariantEvidence = checkScopedInvariants(database, context.scope);
      const runIds = scopedObserveRunIds(database, context.scope);
      const reports = runIds.flatMap((runId) => database.prepare(
        `SELECT reconciliation_report_id,observe_run_id,sync_status,created_at
         FROM reconciliation_reports WHERE observe_run_id=?
         ORDER BY created_at,reconciliation_report_id`,
      ).all(runId) as unknown as ReconciliationReportRow[]);
      const latestObserveReport = reports.at(-1);
      const historicalMajorDesyncCount = reports.filter((report) => report.sync_status === "MAJOR_DESYNC").length;
      const observeStatus = latestObserveReport?.sync_status === "SYNCED"
        ? "PASS"
        : latestObserveReport?.sync_status === "MAJOR_DESYNC" ? "FAIL" : "WARN";
      const observeReason = !latestObserveReport
        ? "SCOPED_OBSERVE_RECONCILIATION_NOT_RUN"
        : latestObserveReport.sync_status === "SYNCED"
          ? "OK"
          : `SCOPED_OBSERVE_RECONCILIATION_${latestObserveReport.sync_status}`;
      return [
        check({
          checkType: this.type,
          checkName: "scoped_local_evidence_chain",
          status: invariantEvidence.passed ? "PASS" : "FAIL",
          reason: invariantEvidence.passed ? "OK" : "SCOPED_LOCAL_INVARIANTS_FAILED",
          metrics: invariantEvidence,
          now: context.now,
        }),
        check({
          checkType: this.type,
          checkName: "scoped_observe_major_desync",
          status: historicalMajorDesyncCount === 0 ? "PASS" : "FAIL",
          reason: historicalMajorDesyncCount === 0 ? "OK" : `MAJOR_DESYNC:${historicalMajorDesyncCount}`,
          metrics: { observeRunIds: runIds, historicalMajorDesyncCount },
          now: context.now,
        }),
        check({
          checkType: this.type,
          checkName: "scoped_observe_reconciliation_reports",
          status: observeStatus,
          blocking: observeStatus === "FAIL",
          reason: observeReason,
          metrics: {
            observeRunIds: runIds,
            latestReport: latestObserveReport ?? null,
            latestSyncStatus: latestObserveReport?.sync_status ?? null,
            historicalMajorDesyncCount,
            reportCount: reports.length,
          },
          now: context.now,
        }),
      ];
    } catch (error) {
      return [errorCheck({
        checkType: this.type,
        checkName: "reconciliation_exception",
        reason: "RECONCILIATION_VALIDATION_FAILED",
        error,
        now: context.now,
      })];
    } finally {
      database.close();
    }
  }
}
