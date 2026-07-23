import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { stableJson } from "../domain/versioning.js";
import { check, errorCheck } from "./checks.js";
import { scopedObserveRunIds } from "./scoped-invariants.js";
import type { ValidationCheckResult, ValidationValidator, ValidationValidatorContext } from "./types.js";

interface ObserveRunRow {
  observe_run_id: string;
  target_id: string;
  state: string;
  successful_polls: number;
  failed_polls: number;
  processed_events: number;
  emitted_signals: number;
  duplicate_events: number;
  gap_events: number;
  reconciliation_count: number;
}

interface ObserveCheckpointRow {
  checkpoint_id: string;
  poll_id: string;
  last_processed_timestamp: number | null;
  last_processed_event_id: string | null;
  replay_state: string;
  position_projection_json: string;
  position_projection_hash: string;
  capital_snapshot_id: string;
}

function projectionHash(projectionJson: string): string {
  return createHash("sha256").update(stableJson(JSON.parse(projectionJson) as unknown)).digest("hex");
}

export class ObserveOnlyValidation implements ValidationValidator {
  readonly type = "OBSERVE_ONLY" as const;

  async run(context: ValidationValidatorContext): Promise<ValidationCheckResult[]> {
    const database = new DatabaseSync(context.databasePath, { readOnly: true });
    try {
      const runIds = scopedObserveRunIds(database, context.scope);
      const latestRunId = runIds.at(-1);
      const latest = database.prepare(
        `SELECT observe_run_id,target_id,state,successful_polls,failed_polls,processed_events,
                emitted_signals,duplicate_events,gap_events,reconciliation_count
         FROM observe_runs WHERE observe_run_id=?`,
      ).get(latestRunId ?? "") as ObserveRunRow | undefined;
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
        `SELECT checkpoint_id,poll_id,last_processed_timestamp,last_processed_event_id,replay_state,
                COALESCE(NULLIF(c.position_projection_json,''),s.projection_json) position_projection_json,
                c.position_projection_hash,c.capital_snapshot_id
         FROM observe_checkpoints c
         LEFT JOIN observe_projection_snapshots s
           ON s.projection_snapshot_hash=c.projection_snapshot_hash
         WHERE c.observe_run_id=? ORDER BY c.created_at DESC,c.checkpoint_id DESC LIMIT 1`,
      ).get(latest.observe_run_id) as ObserveCheckpointRow | undefined;
      const checkpointPoll = database.prepare(
        `SELECT poll_id,checkpoint_id,status FROM observe_polls
         WHERE observe_run_id=? AND poll_id=?`,
      ).get(latest.observe_run_id, checkpoint?.poll_id ?? "") as {
        poll_id: string;
        checkpoint_id: string | null;
        status: string;
      } | undefined;
      const successfulPollCount = (database.prepare(
        "SELECT count(*) count FROM observe_polls WHERE observe_run_id=? AND status='SUCCESS'",
      ).get(latest.observe_run_id) as { count: number }).count;
      const latestReconciliation = database.prepare(
        `SELECT sync_status,reconciliation_report_id FROM reconciliation_reports
         WHERE observe_run_id=? ORDER BY created_at DESC,reconciliation_report_id DESC LIMIT 1`,
      ).get(latest.observe_run_id) as { sync_status: string; reconciliation_report_id: string } | undefined;
      const majorDesyncCount = runIds.reduce((total, runId) => total + Number((database.prepare(
        "SELECT count(*) count FROM reconciliation_reports WHERE observe_run_id=? AND sync_status='MAJOR_DESYNC'",
      ).get(runId) as { count: number }).count), 0);
      const latestRun = database.prepare(
        "SELECT started_at,COALESCE(stopped_at,last_heartbeat_at) stopped_at FROM observe_runs WHERE observe_run_id=?",
      ).get(latest.observe_run_id) as { started_at: string; stopped_at: string };
      const openGapCount = (database.prepare(
        `SELECT count(*) count FROM connection_windows
         WHERE target_id=? AND disconnected_at>=? AND disconnected_at<=? AND reconnected_at IS NULL`,
      ).get(latest.target_id, latestRun.started_at, latestRun.stopped_at) as { count: number }).count;
      const latency = database.prepare(
        `SELECT status,count(*) count,
                avg((julianday(completed_at)-julianday(started_at))*86400000.0) avg_duration_ms
         FROM observe_polls WHERE observe_run_id=? GROUP BY status`,
      ).all(latest.observe_run_id) as unknown[];
      const pollCountersConsistent = successfulPollCount > 0 && successfulPollCount === latest.successful_polls;
      const checkpointConsistent = checkpoint !== undefined
        && checkpointPoll !== undefined
        && checkpointPoll.status === "SUCCESS"
        && checkpoint.checkpoint_id === checkpointPoll.checkpoint_id
        && checkpoint.poll_id === checkpointPoll.poll_id
        && checkpoint.position_projection_hash === projectionHash(checkpoint.position_projection_json);
      const finalSync = latestReconciliation?.sync_status === "SYNCED";
      return [
        check({
          checkType: this.type,
          checkName: "observe_only_run_available",
          status: "PASS",
          reason: "OK",
          metrics: { ...latest, scopedObserveRunIds: runIds },
          now: context.now,
        }),
        check({
          checkType: this.type,
          checkName: "observe_run_completed",
          status: latest.state === "COMPLETED" ? "PASS" : "FAIL",
          reason: latest.state === "COMPLETED" ? "OK" : `OBSERVE_RUN_NOT_COMPLETED:${latest.state}`,
          metrics: { observeRunId: latest.observe_run_id, state: latest.state },
          now: context.now,
        }),
        check({
          checkType: this.type,
          checkName: "observe_successful_poll",
          status: pollCountersConsistent ? "PASS" : "FAIL",
          reason: successfulPollCount === 0
            ? "OBSERVE_SUCCESSFUL_POLL_MISSING"
            : pollCountersConsistent ? "OK" : "OBSERVE_POLL_COUNTER_MISMATCH",
          metrics: { recordedSuccessfulPolls: latest.successful_polls, successfulPollCount },
          now: context.now,
        }),
        check({
          checkType: this.type,
          checkName: "observe_final_sync",
          status: finalSync ? "PASS" : "FAIL",
          reason: finalSync
            ? "OK"
            : `OBSERVE_FINAL_NOT_SYNCED:${latestReconciliation?.sync_status ?? "MISSING"}`,
          metrics: { latestReconciliation },
          now: context.now,
        }),
        check({
          checkType: this.type,
          checkName: "observe_historical_major_desync",
          status: majorDesyncCount === 0 ? "PASS" : "FAIL",
          reason: majorDesyncCount === 0 ? "OK" : `OBSERVE_MAJOR_DESYNC_DETECTED:${majorDesyncCount}`,
          metrics: { observeRunId: latest.observe_run_id, majorDesyncCount },
          now: context.now,
        }),
        check({
          checkType: this.type,
          checkName: "observe_checkpoint",
          status: checkpointConsistent ? "PASS" : "FAIL",
          reason: checkpointConsistent ? "OK" : checkpoint ? "OBSERVE_CHECKPOINT_INCONSISTENT" : "OBSERVE_CHECKPOINT_MISSING",
          metrics: { checkpoint, checkpointPoll },
          now: context.now,
        }),
        check({
          checkType: this.type,
          checkName: "observe_connection_gap",
          status: openGapCount === 0 ? "PASS" : "FAIL",
          reason: openGapCount === 0 ? "OK" : `OBSERVE_UNRECOVERED_CONNECTION_GAP:${openGapCount}`,
          metrics: { openGapCount },
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
