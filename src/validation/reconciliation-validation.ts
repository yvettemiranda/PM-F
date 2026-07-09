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
          status: observeReports.length === 0 ? "WARN" : "PASS",
          blocking: false,
          reason: observeReports.length === 0 ? "OBSERVE_RECONCILIATION_NOT_RUN" : "OK",
          metrics: { observeReports },
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
