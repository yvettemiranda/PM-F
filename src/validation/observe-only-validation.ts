import { DatabaseSync } from "node:sqlite";
import { check, errorCheck } from "./checks.js";
import type { ValidationCheckResult, ValidationValidator, ValidationValidatorContext } from "./types.js";

export class ObserveOnlyValidation implements ValidationValidator {
  readonly type = "OBSERVE_ONLY" as const;

  async run(context: ValidationValidatorContext): Promise<ValidationCheckResult[]> {
    const database = new DatabaseSync(context.databasePath, { readOnly: true });
    try {
      const latest = database.prepare(
        `SELECT observe_run_id,state,successful_polls,failed_polls,processed_events,
                emitted_signals,duplicate_events,gap_events,reconciliation_count
         FROM observe_runs ORDER BY started_at DESC LIMIT 1`,
      ).get() as {
        observe_run_id: string;
        state: string;
        successful_polls: number;
        failed_polls: number;
        processed_events: number;
        emitted_signals: number;
        duplicate_events: number;
        gap_events: number;
        reconciliation_count: number;
      } | undefined;
      if (!latest) {
        return [check({
          checkType: this.type,
          checkName: "observe_only_run_available",
          status: "SKIPPED",
          blocking: false,
          reason: "OBSERVE_ONLY_NOT_RUN",
          metrics: {},
          now: context.now,
        })];
      }
      const checkpoint = database.prepare(
        "SELECT checkpoint_id,position_projection_hash,last_processed_event_id FROM observe_checkpoints ORDER BY created_at DESC LIMIT 1",
      ).get() as { checkpoint_id: string; position_projection_hash: string; last_processed_event_id: string | null } | undefined;
      const latency = database.prepare(
        `SELECT component,operation,count(*) count,avg(duration_ms) avg_duration_ms
         FROM latency_metrics GROUP BY component,operation`,
      ).all() as unknown[];
      return [
        check({
          checkType: this.type,
          checkName: "observe_only_run_available",
          status: latest.state === "FAILED" ? "FAIL" : "PASS",
          reason: latest.state === "FAILED" ? "OBSERVE_RUN_FAILED" : "OK",
          metrics: latest,
          now: context.now,
        }),
        check({
          checkType: this.type,
          checkName: "observe_checkpoint",
          status: checkpoint ? "PASS" : "WARN",
          blocking: false,
          reason: checkpoint ? "OK" : "OBSERVE_CHECKPOINT_MISSING",
          metrics: { checkpoint },
          now: context.now,
        }),
        check({
          checkType: this.type,
          checkName: "observe_latency",
          status: latency.length > 0 ? "PASS" : "WARN",
          blocking: false,
          reason: latency.length > 0 ? "OK" : "LATENCY_METRICS_NOT_AVAILABLE",
          metrics: { latency },
          now: context.now,
        }),
      ];
    } catch (error) {
      return [errorCheck({ checkType: this.type, checkName: "observe_only_exception", reason: "OBSERVE_ONLY_VALIDATION_FAILED", error, now: context.now })];
    } finally {
      database.close();
    }
  }
}
