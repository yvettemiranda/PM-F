import { DatabaseSync } from "node:sqlite";
import { LiveGateReconciliation } from "../live/live-gate-reconciliation.js";
import { check, errorCheck } from "./checks.js";
import type { ValidationCheckResult, ValidationValidator, ValidationValidatorContext } from "./types.js";

export class ReconciliationValidation implements ValidationValidator {
  readonly type = "RECONCILIATION" as const;

  async run(context: ValidationValidatorContext): Promise<ValidationCheckResult[]> {
    const database = new DatabaseSync(context.databasePath, { readOnly: true });
    try {
      const gateChecks = new LiveGateReconciliation(database).check();
      const failed = gateChecks.filter((item) => !item.passed);
      const majorDesync = (database.prepare(
        "SELECT count(*) count FROM reconciliation_issues WHERE sync_status='MAJOR_DESYNC' AND status!='RESOLVED'",
      ).get() as { count: number }).count;
      const observeReports = database.prepare(
        `SELECT sync_status,count(*) count FROM reconciliation_reports GROUP BY sync_status`,
      ).all() as unknown as Array<{ sync_status: string; count: number }>;
      const latestObserveReport = database.prepare(
        `SELECT reconciliation_report_id,observe_run_id,sync_status,created_at
         FROM reconciliation_reports ORDER BY created_at DESC,reconciliation_report_id DESC LIMIT 1`,
      ).get() as {
        reconciliation_report_id: string;
        observe_run_id: string;
        sync_status: "SYNCED" | "MINOR_DIFF" | "MAJOR_DESYNC";
        created_at: string;
      } | undefined;
      const historicalMajorDesyncCount = observeReports
        .find((report) => report.sync_status === "MAJOR_DESYNC")?.count ?? 0;
      const observeStatus = latestObserveReport?.sync_status === "SYNCED"
        ? "PASS"
        : latestObserveReport?.sync_status === "MAJOR_DESYNC" ? "FAIL" : "WARN";
      const observeReason = !latestObserveReport
        ? "OBSERVE_RECONCILIATION_NOT_RUN"
        : latestObserveReport.sync_status === "SYNCED"
          ? "OK"
          : `OBSERVE_RECONCILIATION_${latestObserveReport.sync_status}`;
      return [
        check({
          checkType: this.type,
          checkName: "local_reconciliation",
          status: failed.length === 0 ? "PASS" : "FAIL",
          reason: failed.length === 0 ? "OK" : "LOCAL_RECONCILIATION_FAILED",
          metrics: { failed, totalChecks: gateChecks.length },
          now: context.now,
        }),
        check({
          checkType: this.type,
          checkName: "major_desync",
          status: majorDesync === 0 ? "PASS" : "FAIL",
          reason: majorDesync === 0 ? "OK" : `MAJOR_DESYNC:${majorDesync}`,
          metrics: { majorDesync },
          now: context.now,
        }),
        check({
          checkType: this.type,
          checkName: "observe_reconciliation_reports",
          status: observeStatus,
          blocking: observeStatus === "FAIL",
          reason: observeReason,
          metrics: {
            latestReport: latestObserveReport ?? null,
            latestSyncStatus: latestObserveReport?.sync_status ?? null,
            historicalMajorDesyncCount,
            observeReports,
          },
          now: context.now,
        }),
      ];
    } catch (error) {
      return [errorCheck({ checkType: this.type, checkName: "reconciliation_exception", reason: "RECONCILIATION_VALIDATION_FAILED", error, now: context.now })];
    } finally {
      database.close();
    }
  }
}
