import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { ApiCapture } from "../adapters/polymarket-public.js";
import { ACTIVITY_IDENTITY_VERSION, SOURCE_IDENTITY_VERSION } from "../domain/idempotency.js";
import { decimalToScaled, PRICE_SCALE_DIGITS, SHARE_SCALE_DIGITS } from "../domain/fixed.js";
import { RULESET_HASH, RULESET_SNAPSHOT_JSON, VERSIONS, stableJson } from "../domain/versioning.js";
import type { SourceVersion } from "../infra/source-version.js";
import { captureIdentityFromResponseJson } from "../services/capture-manifest.js";
import type { CapitalEstimate } from "../services/capital-estimator.js";
import type { SignalContextBundle } from "../signal-context/execution-context.js";
import { OBSERVE_SIGNAL_VERSION } from "./position-projector.js";
import { deriveObserveSchedulingMetrics } from "./scheduling.js";
import { storeCompressedCapturePayload } from "../infra/sqlite/capture-payload.js";
import type {
  ObserveBaseline,
  ObserveEvent,
  ObservePollSnapshot,
  ObserveProjectionResult,
  ObserveRunMetrics,
  ObserveSignal,
  ReconciliationResult,
} from "./types.js";

export interface ObserveCheckpoint {
  checkpointId: string;
  createdAt: string;
  positionProjectionHash: string;
  replayState: string;
  lastProcessedTimestamp: number | null;
  lastProcessedEventId: string | null;
}

export interface StartedObserveRun {
  observeRunId: string;
  baseline: ObserveBaseline;
  checkpoint: ObserveCheckpoint | null;
  recoveredFromCheckpoint: boolean;
  gapFrom: string;
}

export interface CommitPollInput {
  observeRunId: string;
  baseline: ObserveBaseline;
  sequence: number;
  startedAt: string;
  completedAt: string;
  snapshot: ObservePollSnapshot;
  newEvents: ObserveEvent[];
  eventConfirmations: Array<{ sourceEventKey: string; isCombo: boolean; isGap: boolean }>;
  duplicateEvents: number;
  projection: ObserveProjectionResult;
  signalsToEmit: ObserveSignal[];
  capitalEstimate: CapitalEstimate;
  signalContexts: SignalContextBundle[];
  reconciliation: ReconciliationResult;
  replayState: string;
  gapRecovered: boolean;
}

export class ObserveStore {
  private readonly database: DatabaseSync;

  constructor(path: string, private readonly sourceVersion: SourceVersion) {
    this.database = new DatabaseSync(path);
    this.database.exec("PRAGMA foreign_keys=ON; PRAGMA recursive_triggers=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;");
  }

  startRun(walletAddress: string, pollIntervalMs: number, now: string, staleAfterMs: number): StartedObserveRun {
    let baseline: ObserveBaseline;
    let checkpointRow: {
      checkpoint_id: string;
      created_at: string;
      position_projection_hash: string;
      replay_state: string;
      last_processed_timestamp: number | null;
      last_processed_event_id: string | null;
    } | undefined;
    const observeRunId = randomUUID();
    const staleBefore = Date.parse(now) - staleAfterMs;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      baseline = this.loadBaseline(walletAddress);
      const target = this.database
        .prepare("SELECT target_id FROM monitor_targets WHERE wallet_address=?")
        .get(walletAddress.toLowerCase()) as { target_id: string } | undefined;
      if (!target) throw new Error(`Monitor target not found: ${walletAddress}`);
      const latestRunning = this.database
        .prepare("SELECT observe_run_id,last_heartbeat_at FROM observe_runs WHERE target_id=? AND state='RUNNING' ORDER BY started_at DESC LIMIT 1")
        .get(target.target_id) as { observe_run_id: string; last_heartbeat_at: string } | undefined;
      if (latestRunning && Date.parse(latestRunning.last_heartbeat_at) >= staleBefore) {
        throw new Error(`OBSERVE_INSTANCE_ACTIVE:${latestRunning.observe_run_id}`);
      }
      checkpointRow = this.database
        .prepare(
          `SELECT checkpoint_id,created_at,position_projection_hash,replay_state,
                  last_processed_timestamp,last_processed_event_id
           FROM observe_checkpoints
           WHERE target_id=? AND baseline_run_id=?
           ORDER BY created_at DESC LIMIT 1`,
        )
        .get(target.target_id, baseline.baselineRunId) as typeof checkpointRow;
      if (latestRunning) {
        this.database
          .prepare("UPDATE observe_runs SET state='INTERRUPTED',stopped_at=?,stop_reason='STALE_RUN_RECOVERED' WHERE observe_run_id=?")
          .run(now, latestRunning.observe_run_id);
      }
      this.database
        .prepare(
          `INSERT INTO observe_runs(
            observe_run_id,target_id,baseline_run_id,state,recovered_from_checkpoint,
            poll_interval_ms,started_at,last_heartbeat_at,schema_version,signal_version,
            strategy_version,risk_version,ruleset_hash,source_code_commit,source_code_dirty,created_at
          ) VALUES (?, ?, ?, 'RUNNING', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          observeRunId,
          target.target_id,
          baseline.baselineRunId,
          checkpointRow ? 1 : 0,
          pollIntervalMs,
          now,
          now,
          VERSIONS.schemaVersion,
          OBSERVE_SIGNAL_VERSION,
          VERSIONS.strategyVersion,
          VERSIONS.riskVersion,
          RULESET_HASH,
          this.sourceVersion.commit,
          this.sourceVersion.dirty ? 1 : 0,
          now,
        );
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return {
      observeRunId,
      baseline,
      checkpoint: checkpointRow ? {
        checkpointId: checkpointRow.checkpoint_id,
        createdAt: checkpointRow.created_at,
        positionProjectionHash: checkpointRow.position_projection_hash,
        replayState: checkpointRow.replay_state,
        lastProcessedTimestamp: checkpointRow.last_processed_timestamp,
        lastProcessedEventId: checkpointRow.last_processed_event_id,
      } : null,
      recoveredFromCheckpoint: checkpointRow !== undefined,
      gapFrom: checkpointRow?.created_at ?? baseline.snapshotTime,
    };
  }

  loadBaseline(walletAddress: string): ObserveBaseline {
    const run = this.database
      .prepare(
        `SELECT b.baseline_run_id,b.target_id,b.wallet_address,b.snapshot_time
         FROM position_baseline_runs b
         WHERE b.wallet_address=? AND b.status='READY'
         ORDER BY b.snapshot_time DESC LIMIT 1`,
      )
      .get(walletAddress.toLowerCase()) as {
        baseline_run_id: string;
        target_id: string;
        wallet_address: string;
        snapshot_time: string;
      } | undefined;
    if (!run) throw new Error(`Ready position baseline not found: ${walletAddress}`);
    const items = this.database
      .prepare("SELECT asset_id,condition_id,size_micros FROM position_baseline_items WHERE baseline_run_id=? ORDER BY asset_id")
      .all(run.baseline_run_id) as Array<{ asset_id: string; condition_id: string; size_micros: string }>;
    return {
      baselineRunId: run.baseline_run_id,
      targetId: run.target_id,
      walletAddress: run.wallet_address,
      snapshotTime: run.snapshot_time,
      items: items.map((item) => ({ asset: item.asset_id, conditionId: item.condition_id, sizeMicros: item.size_micros })),
    };
  }

  loadObservedEvents(baselineRunId: string): ObserveEvent[] {
    const rows = this.database
      .prepare(
        `SELECT o.source_event_key,o.source_type,o.source_timestamp,o.is_gap,
                o.activity_confirmed,r.is_combo,r.raw_json
         FROM observe_events o JOIN raw_events r ON r.source_event_key=o.source_event_key
         WHERE o.baseline_run_id=? ORDER BY o.source_timestamp,o.source_event_key`,
      )
      .all(baselineRunId) as Array<{
        source_event_key: string;
        source_type: "DATA_API_TRADE" | "DATA_API_ACTIVITY";
        source_timestamp: number;
        is_gap: number;
        activity_confirmed: number;
        is_combo: number;
        raw_json: string;
      }>;
    return rows.map((row) => ({
      sourceEventKey: row.source_event_key,
      sourceType: row.source_type,
      sourceTimestamp: row.source_timestamp,
      isGap: row.is_gap !== 0,
      isCombo: row.is_combo !== 0,
      activityConfirmed: row.activity_confirmed !== 0,
      ...(row.source_type === "DATA_API_TRADE" ? { trade: JSON.parse(row.raw_json) } : { activity: JSON.parse(row.raw_json) }),
    }));
  }

  existingEventKeys(baselineRunId: string, keys: string[]): Set<string> {
    if (keys.length === 0) return new Set();
    const existing = new Set<string>();
    const query = this.database.prepare("SELECT 1 FROM observe_events WHERE baseline_run_id=? AND source_event_key=?");
    for (const key of keys) if (query.get(baselineRunId, key)) existing.add(key);
    return existing;
  }

  consecutiveDiffCount(baselineRunId: string): number {
    const rows = this.database
      .prepare("SELECT sync_status FROM reconciliation_reports WHERE baseline_run_id=? ORDER BY created_at DESC LIMIT 10")
      .all(baselineRunId) as Array<{ sync_status: string }>;
    let count = 0;
    for (const row of rows) {
      if (row.sync_status === "SYNCED") break;
      count += 1;
    }
    return count;
  }

  targetSyncStatus(targetId: string): "SYNCED" | "MINOR_DIFF" | "MAJOR_DESYNC" {
    const row = this.database
      .prepare("SELECT sync_status FROM monitor_targets WHERE target_id=?")
      .get(targetId) as { sync_status: "SYNCED" | "MINOR_DIFF" | "MAJOR_DESYNC" };
    return row.sync_status;
  }

  failCheckpointProjectionMismatch(input: {
    observeRunId: string;
    baseline: ObserveBaseline;
    checkpoint: ObserveCheckpoint;
    calculatedProjectionHash: string;
    detectedAt: string;
  }): void {
    const issueId = createHash("sha256").update(stableJson({
      issueType: "CHECKPOINT_PROJECTION_HASH_MISMATCH",
      targetId: input.baseline.targetId,
      baselineRunId: input.baseline.baselineRunId,
      checkpointId: input.checkpoint.checkpointId,
      expected: input.checkpoint.positionProjectionHash,
      observed: input.calculatedProjectionHash,
    })).digest("hex");
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(
        `INSERT OR IGNORE INTO reconciliation_issues(
          issue_id,target_id,asset_id,issue_type,expected_value,observed_value,
          sync_status,status,detail_json,created_at,resolved_at
        ) VALUES (?, ?, NULL, 'CHECKPOINT_PROJECTION_HASH_MISMATCH', ?, ?,
          'MAJOR_DESYNC', 'OPEN', ?, ?, NULL)`,
      ).run(
        issueId,
        input.baseline.targetId,
        input.checkpoint.positionProjectionHash,
        input.calculatedProjectionHash,
        stableJson({
          observeRunId: input.observeRunId,
          baselineRunId: input.baseline.baselineRunId,
          checkpointId: input.checkpoint.checkpointId,
        }),
        input.detectedAt,
      );
      this.database.prepare(
        "UPDATE monitor_targets SET sync_status='MAJOR_DESYNC',updated_at=? WHERE target_id=?",
      ).run(input.detectedAt, input.baseline.targetId);
      this.database.prepare(
        `UPDATE observe_runs
         SET state='FAILED',stopped_at=?,stop_reason='CHECKPOINT_PROJECTION_HASH_MISMATCH',last_heartbeat_at=?
         WHERE observe_run_id=? AND state='RUNNING'`,
      ).run(input.detectedAt, input.detectedAt, input.observeRunId);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  nextPollSequence(observeRunId: string): number {
    const row = this.database
      .prepare("SELECT COALESCE(MAX(sequence),0)+1 next_sequence FROM observe_polls WHERE observe_run_id=?")
      .get(observeRunId) as { next_sequence: number };
    return row.next_sequence;
  }

  recordFailedPoll(
    observeRunId: string,
    sequence: number,
    startedAt: string,
    completedAt: string,
    error: unknown,
    status: "API_FAILED" | "PROCESSING_FAILED" = "API_FAILED",
  ): void {
    const pollId = randomUUID();
    const errorDetail = error instanceof Error ? error.message : String(error);
    const run = this.database
      .prepare("SELECT target_id FROM observe_runs WHERE observe_run_id=? AND state='RUNNING'")
      .get(observeRunId) as { target_id: string } | undefined;
    if (!run) throw new Error(`Running observe run not found: ${observeRunId}`);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database
        .prepare(
          `INSERT INTO observe_polls(
            poll_id,observe_run_id,sequence,status,started_at,completed_at,error_detail
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(pollId, observeRunId, sequence, status, startedAt, completedAt, errorDetail);
      this.database
        .prepare("UPDATE observe_runs SET failed_polls=failed_polls+1,last_heartbeat_at=? WHERE observe_run_id=?")
        .run(completedAt, observeRunId);
      const openWindow = this.database
        .prepare("SELECT window_id FROM connection_windows WHERE target_id=? AND reconnected_at IS NULL ORDER BY disconnected_at DESC LIMIT 1")
        .get(run.target_id);
      if (!openWindow) {
        this.database
          .prepare("INSERT INTO connection_windows(window_id,target_id,disconnected_at,status,reason) VALUES (?, ?, ?, 'DISCONNECTED', ?)")
          .run(randomUUID(), run.target_id, startedAt, errorDetail);
      }
      this.database.exec("COMMIT");
    } catch (failure) {
      this.database.exec("ROLLBACK");
      throw failure;
    }
  }

  commitSuccessfulPoll(input: CommitPollInput): string {
    const pollId = randomUUID();
    const checkpointId = randomUUID();
    const reconciliationId = randomUUID();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database
        .prepare(
          `INSERT INTO observe_polls(
            poll_id,observe_run_id,sequence,status,started_at,completed_at,
            trades_received,activity_received,positions_received,new_events,
            duplicate_events,signals_emitted,gap_events,reconciliation_count,checkpoint_id
          ) VALUES (?, ?, ?, 'SUCCESS', ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
        )
        .run(
          pollId,
          input.observeRunId,
          input.sequence,
          input.startedAt,
          input.completedAt,
          input.snapshot.trades.data.length,
          input.snapshot.activity.data.length,
          input.snapshot.positions.data.length,
          input.newEvents.length,
          input.duplicateEvents,
          input.signalsToEmit.length,
          input.newEvents.filter((event) => event.isGap).length,
          checkpointId,
        );
      this.savePollCaptures(pollId, input.snapshot);
      for (const event of input.newEvents) this.insertObserveEvent(input, pollId, event);
      for (const confirmation of input.eventConfirmations) {
        if (confirmation.isCombo) {
          const existingSignal = this.database.prepare(
            "SELECT signal_id FROM signals WHERE source_event_key=? AND producer_mode='OBSERVE_ONLY' LIMIT 1",
          ).get(confirmation.sourceEventKey) as { signal_id: string } | undefined;
          if (existingSignal) throw new Error(`COMBO_SIGNAL_CONFLICT:${existingSignal.signal_id}`);
          this.database.prepare(
            "UPDATE raw_events SET is_combo=1,event_classification='COMBO_ACTIVITY' WHERE source_event_key=?",
          ).run(confirmation.sourceEventKey);
        }
        if (confirmation.isGap) {
          this.database.prepare(
            `UPDATE raw_events
             SET gap_event=1,
                 event_classification=CASE WHEN is_combo=1 THEN 'COMBO_ACTIVITY' ELSE 'GAP_TRADE' END
             WHERE source_event_key=?`,
          ).run(confirmation.sourceEventKey);
        }
        this.database.prepare(
          `UPDATE observe_events
           SET activity_confirmed=1,is_gap=CASE WHEN is_gap=1 OR ?=1 THEN 1 ELSE 0 END
           WHERE baseline_run_id=? AND source_event_key=?`,
        ).run(confirmation.isGap ? 1 : 0, input.baseline.baselineRunId, confirmation.sourceEventKey);
      }
      this.insertCapitalEstimate(input.baseline.targetId, null, input.capitalEstimate, input.completedAt);
      for (const bundle of input.signalContexts) {
        if (bundle.capitalDecision) {
          this.insertCapitalEstimate(input.baseline.targetId, bundle.signal.sourceEventKey, bundle.capitalDecision, input.completedAt);
        }
      }
      for (const signal of input.signalsToEmit) this.insertObserveSignal(input, pollId, signal);
      for (const bundle of input.signalContexts) this.insertSignalExecutionContext(bundle);

      this.database.prepare("DELETE FROM observe_position_projection WHERE baseline_run_id=?").run(input.baseline.baselineRunId);
      const insertProjection = this.database.prepare(
        `INSERT INTO observe_position_projection(
          baseline_run_id,asset_id,historical_micros,tracked_micros,
          expected_total_micros,last_source_event_key,updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const entry of input.projection.projection) {
        insertProjection.run(
          input.baseline.baselineRunId,
          entry.asset,
          entry.historicalMicros,
          entry.trackedMicros,
          entry.expectedTotalMicros,
          entry.lastSourceEventKey,
          input.completedAt,
        );
      }
      this.database
        .prepare(
          `INSERT INTO reconciliation_reports(
            reconciliation_report_id,target_id,baseline_run_id,observe_run_id,poll_id,
            sync_status,issue_count,expected_projection_hash,observed_positions_hash,
            detail_json,created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          reconciliationId,
          input.baseline.targetId,
          input.baseline.baselineRunId,
          input.observeRunId,
          pollId,
          input.reconciliation.syncStatus,
          input.reconciliation.issueCount,
          input.projection.projectionHash,
          input.reconciliation.observedPositionsHash,
          JSON.stringify(input.reconciliation.details),
          input.completedAt,
        );
      const projectionJson = JSON.stringify(input.projection.projection);
      this.database
        .prepare(
          `INSERT INTO observe_checkpoints(
            checkpoint_id,target_id,baseline_run_id,observe_run_id,poll_id,
            last_processed_timestamp,last_processed_event_id,replay_state,
            position_projection_json,position_projection_hash,capital_snapshot_id,created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          checkpointId,
          input.baseline.targetId,
          input.baseline.baselineRunId,
          input.observeRunId,
          pollId,
          input.projection.lastProcessedTimestamp,
          input.projection.lastProcessedEventId,
          input.replayState,
          projectionJson,
          input.projection.projectionHash,
          input.capitalEstimate.capitalEstimateId,
          input.completedAt,
        );
      this.database
        .prepare(
          `INSERT INTO monitor_checkpoints(
            target_id,last_trade_timestamp,last_success_at,last_source_event_key,
            history_complete,updated_at,checkpoint_id,baseline_run_id,observe_run_id,
            replay_state,position_projection_hash,capital_snapshot_id
          ) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(target_id) DO UPDATE SET
            last_trade_timestamp=excluded.last_trade_timestamp,
            last_success_at=excluded.last_success_at,
            last_source_event_key=excluded.last_source_event_key,
            updated_at=excluded.updated_at,
            checkpoint_id=excluded.checkpoint_id,
            baseline_run_id=excluded.baseline_run_id,
            observe_run_id=excluded.observe_run_id,
            replay_state=excluded.replay_state,
            position_projection_hash=excluded.position_projection_hash,
            capital_snapshot_id=excluded.capital_snapshot_id`,
        )
        .run(
          input.baseline.targetId,
          input.projection.lastProcessedTimestamp,
          input.completedAt,
          input.projection.lastProcessedEventId,
          input.completedAt,
          checkpointId,
          input.baseline.baselineRunId,
          input.observeRunId,
          input.replayState,
          input.projection.projectionHash,
          input.capitalEstimate.capitalEstimateId,
        );
      this.database
        .prepare("UPDATE monitor_targets SET sync_status=?,updated_at=? WHERE target_id=?")
        .run(input.reconciliation.syncStatus, input.completedAt, input.baseline.targetId);
      this.database
        .prepare(
          `UPDATE observe_runs SET
            successful_polls=successful_polls+1,
            processed_events=processed_events+?,
            emitted_signals=emitted_signals+?,
            duplicate_events=duplicate_events+?,
            gap_events=gap_events+?,
            reconciliation_count=reconciliation_count+1,
            last_heartbeat_at=?
          WHERE observe_run_id=?`,
        )
        .run(
          input.newEvents.length,
          input.signalsToEmit.length,
          input.duplicateEvents,
          input.newEvents.filter((event) => event.isGap).length,
          input.completedAt,
          input.observeRunId,
        );
      if (input.gapRecovered) {
        this.database
          .prepare("UPDATE connection_windows SET reconnected_at=?,status='RECOVERED' WHERE target_id=? AND reconnected_at IS NULL")
          .run(input.completedAt, input.baseline.targetId);
      }
      this.database.exec("COMMIT");
      return checkpointId;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  stopRun(observeRunId: string, stoppedAt: string, reason: string, failed = false): void {
    this.database
      .prepare("UPDATE observe_runs SET state=?,stopped_at=?,stop_reason=?,last_heartbeat_at=? WHERE observe_run_id=? AND state='RUNNING'")
      .run(failed ? "FAILED" : "COMPLETED", stoppedAt, reason, stoppedAt, observeRunId);
  }

  runMetrics(observeRunId: string): ObserveRunMetrics {
    const row = this.database
      .prepare(
        `SELECT started_at,COALESCE(stopped_at,last_heartbeat_at) stopped_at,poll_interval_ms,
                successful_polls,failed_polls,processed_events,emitted_signals,
                duplicate_events,gap_events,reconciliation_count,recovered_from_checkpoint
         FROM observe_runs WHERE observe_run_id=?`,
      )
      .get(observeRunId) as {
        started_at: string;
        stopped_at: string;
        poll_interval_ms: number;
        successful_polls: number;
        failed_polls: number;
        processed_events: number;
        emitted_signals: number;
        duplicate_events: number;
        gap_events: number;
        reconciliation_count: number;
        recovered_from_checkpoint: number;
      };
    const pollTimings = this.database
      .prepare("SELECT started_at,completed_at FROM observe_polls WHERE observe_run_id=? ORDER BY sequence")
      .all(observeRunId) as Array<{ started_at: string; completed_at: string }>;
    const scheduling = deriveObserveSchedulingMetrics(
      row.started_at,
      row.stopped_at,
      row.poll_interval_ms,
      pollTimings.map((poll) => ({ startedAt: poll.started_at, completedAt: poll.completed_at })),
    );
    const checkpoint = this.database
      .prepare("SELECT checkpoint_id FROM observe_checkpoints WHERE observe_run_id=? ORDER BY created_at DESC LIMIT 1")
      .get(observeRunId) as { checkpoint_id: string } | undefined;
    const reconciliation = this.database
      .prepare("SELECT sync_status FROM reconciliation_reports WHERE observe_run_id=? ORDER BY created_at DESC LIMIT 1")
      .get(observeRunId) as { sync_status: "SYNCED" | "MINOR_DIFF" | "MAJOR_DESYNC" } | undefined;
    const drift = this.database
      .prepare("SELECT 1 FROM reconciliation_reports WHERE observe_run_id=? AND sync_status!='SYNCED' LIMIT 1")
      .get(observeRunId);
    const reconciliationCounts = this.database
      .prepare(
        `SELECT
          SUM(CASE WHEN sync_status='MINOR_DIFF' THEN 1 ELSE 0 END) minor_count,
          SUM(CASE WHEN sync_status='MAJOR_DESYNC' THEN 1 ELSE 0 END) major_count
         FROM reconciliation_reports WHERE observe_run_id=?`,
      )
      .get(observeRunId) as { minor_count: number | null; major_count: number | null };
    const runTarget = this.database
      .prepare("SELECT target_id FROM observe_runs WHERE observe_run_id=?")
      .get(observeRunId) as { target_id: string };
    const openConnectionWindow = this.database
      .prepare("SELECT 1 FROM connection_windows WHERE target_id=? AND reconnected_at IS NULL LIMIT 1")
      .get(runTarget.target_id);
    return {
      observeRunId,
      startedAt: row.started_at,
      stoppedAt: row.stopped_at,
      durationMs: Date.parse(row.stopped_at) - Date.parse(row.started_at),
      ...scheduling,
      successfulPolls: row.successful_polls,
      failedPolls: row.failed_polls,
      processedEvents: row.processed_events,
      emittedSignals: row.emitted_signals,
      duplicateEvents: row.duplicate_events,
      gapEvents: row.gap_events,
      reconciliationCount: row.reconciliation_count,
      stateDriftDetected: drift !== undefined,
      minorDiffCount: reconciliationCounts.minor_count ?? 0,
      majorDesyncCount: reconciliationCounts.major_count ?? 0,
      unrecoveredConnectionGap: openConnectionWindow !== undefined,
      checkpointRecovered: row.recovered_from_checkpoint !== 0,
      checkpointProjectionHashMismatch: false,
      lastCheckpointId: checkpoint?.checkpoint_id ?? null,
      finalSyncStatus: reconciliation?.sync_status ?? null,
    };
  }

  close(): void {
    this.database.close();
  }

  private savePollCaptures(pollId: string, snapshot: ObservePollSnapshot): void {
    const entries: Array<[string, ApiCapture<unknown>]> = [
      ["data-trades-recent", snapshot.trades],
      ["data-activity-recent", snapshot.activity],
      ["data-positions", snapshot.positions],
      ["polygon-pusd-balance", snapshot.pUsdBalance],
    ];
    const insertCapture = this.database.prepare(
      `INSERT OR IGNORE INTO api_captures(
        capture_id,endpoint,request_url,fetched_at,latency_ms,http_status,
        payload_sha256,response_json,schema_version,response_encoding
      ) VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, 'GZIP_SHA256')`,
    );
    const link = this.database.prepare("INSERT INTO observe_poll_captures(poll_id,endpoint,capture_id) VALUES (?, ?, ?)");
    for (const [endpoint, capture] of entries) {
      const responseJson = JSON.stringify(capture.data);
      const identity = captureIdentityFromResponseJson(capture.url, capture.fetchedAt, responseJson);
      storeCompressedCapturePayload(this.database, identity.payloadSha256, responseJson, capture.fetchedAt);
      insertCapture.run(
        identity.captureId,
        endpoint,
        capture.url,
        capture.fetchedAt,
        capture.latencyMs,
        capture.status,
        identity.payloadSha256,
        VERSIONS.schemaVersion,
      );
      link.run(pollId, endpoint, identity.captureId);
    }
  }

  private insertObserveEvent(input: CommitPollInput, pollId: string, event: ObserveEvent): void {
    const raw = event.trade ?? event.activity!;
    const trade = event.trade;
    const activityType = event.activity?.type;
    const classification = trade
      ? event.isCombo ? "COMBO_ACTIVITY" : event.isGap ? "GAP_TRADE" : "STANDARD_TRADE"
      : activityType && ["SPLIT", "MERGE", "CONVERSION"].includes(activityType)
        ? "COMBO_ACTIVITY"
        : activityType && ["REDEEM", "REWARD", "MAKER_REBATE", "REFERRAL_REWARD"].includes(activityType)
          ? "NON_TRADE_ACTIVITY"
          : "UNRECOGNIZED";
    this.database
      .prepare(
        `INSERT OR IGNORE INTO raw_events(
          source_event_key,target_id,identity_version,source_type,source_transaction_hash,
          source_timestamp,asset_id,condition_id,side,price_units,size_micros,gap_event,
          is_combo,raw_json,created_at,capture_run_id,event_classification
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      )
      .run(
        event.sourceEventKey,
        input.baseline.targetId,
        trade ? SOURCE_IDENTITY_VERSION : ACTIVITY_IDENTITY_VERSION,
        event.sourceType,
        raw.transactionHash.toLowerCase(),
        event.sourceTimestamp,
        trade?.asset ?? event.activity?.asset ?? "",
        trade?.conditionId.toLowerCase() ?? event.activity?.conditionId?.toLowerCase() ?? "",
        trade?.side ?? event.activity?.side ?? "NONE",
        trade ? decimalToScaled(trade.price, PRICE_SCALE_DIGITS).toString() : "0",
        trade ? decimalToScaled(trade.size, SHARE_SCALE_DIGITS).toString() : "0",
        event.isGap ? 1 : 0,
        event.isCombo ? 1 : 0,
        JSON.stringify(raw),
        input.completedAt,
        classification,
      );
    this.database
      .prepare(
        `INSERT INTO observe_events(
          observe_event_id,baseline_run_id,source_event_key,source_type,source_timestamp,
          is_gap,activity_confirmed,first_observe_run_id,first_poll_id,first_observed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        createHash("sha256").update(`${input.baseline.baselineRunId}|${event.sourceEventKey}`).digest("hex"),
        input.baseline.baselineRunId,
        event.sourceEventKey,
        event.sourceType,
        event.sourceTimestamp,
        event.isGap ? 1 : 0,
        event.activityConfirmed ? 1 : 0,
        input.observeRunId,
        pollId,
        input.completedAt,
      );
  }

  private insertCapitalEstimate(
    targetId: string,
    sourceEventKey: string | null,
    estimate: CapitalEstimate,
    createdAt: string,
  ): void {
    this.database
      .prepare(
        `INSERT OR IGNORE INTO capital_estimates(
          capital_estimate_id,target_id,source_event_key,position_value_micros,wallet_balance_micros,
          target_visible_capital_micros,target_trade_amount_micros,target_trade_capital_ratio_ppm,
          capital_estimate_status,capital_confidence,capital_estimate_reason,position_snapshot_time,
          wallet_balance_snapshot_time,target_trade_timestamp,fallback_amount_micros,schema_version,
          strategy_version,risk_version,ruleset_snapshot_json,ruleset_hash,source_code_commit,
          source_code_dirty,created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        estimate.capitalEstimateId,
        targetId,
        sourceEventKey,
        estimate.positionValueMicros,
        estimate.walletBalanceMicros,
        estimate.targetVisibleCapitalMicros,
        estimate.targetTradeAmountMicros,
        estimate.targetTradeCapitalRatioPpm,
        estimate.capitalEstimateStatus,
        estimate.capitalConfidence,
        estimate.capitalEstimateReason,
        estimate.positionSnapshotTime,
        estimate.walletBalanceSnapshotTime,
        estimate.targetTradeTimestamp,
        estimate.fallbackAmountMicros,
        VERSIONS.schemaVersion,
        VERSIONS.strategyVersion,
        VERSIONS.riskVersion,
        RULESET_SNAPSHOT_JSON,
        RULESET_HASH,
        this.sourceVersion.commit,
        this.sourceVersion.dirty ? 1 : 0,
        createdAt,
      );
    const stored = this.database.prepare(
      `SELECT target_id,source_event_key,position_value_micros,wallet_balance_micros,
              target_visible_capital_micros,target_trade_amount_micros,target_trade_capital_ratio_ppm,
              capital_estimate_status,capital_confidence,capital_estimate_reason,
              position_snapshot_time,wallet_balance_snapshot_time,target_trade_timestamp,
              fallback_amount_micros,schema_version,strategy_version,risk_version,
              ruleset_snapshot_json,ruleset_hash
       FROM capital_estimates WHERE capital_estimate_id=?`,
    ).get(estimate.capitalEstimateId) as Record<string, unknown> | undefined;
    const expected = {
      target_id: targetId,
      source_event_key: sourceEventKey,
      position_value_micros: estimate.positionValueMicros,
      wallet_balance_micros: estimate.walletBalanceMicros,
      target_visible_capital_micros: estimate.targetVisibleCapitalMicros,
      target_trade_amount_micros: estimate.targetTradeAmountMicros,
      target_trade_capital_ratio_ppm: estimate.targetTradeCapitalRatioPpm,
      capital_estimate_status: estimate.capitalEstimateStatus,
      capital_confidence: estimate.capitalConfidence,
      capital_estimate_reason: estimate.capitalEstimateReason,
      position_snapshot_time: estimate.positionSnapshotTime,
      wallet_balance_snapshot_time: estimate.walletBalanceSnapshotTime,
      target_trade_timestamp: estimate.targetTradeTimestamp,
      fallback_amount_micros: estimate.fallbackAmountMicros,
      schema_version: VERSIONS.schemaVersion,
      strategy_version: VERSIONS.strategyVersion,
      risk_version: VERSIONS.riskVersion,
      ruleset_snapshot_json: RULESET_SNAPSHOT_JSON,
      ruleset_hash: RULESET_HASH,
    };
    if (!stored || stableJson(stored) !== stableJson(expected)) {
      throw new Error(`CAPITAL_ESTIMATE_CONFLICT:${estimate.capitalEstimateId}`);
    }
  }

  private insertObserveSignal(input: CommitPollInput, pollId: string, signal: ObserveSignal): void {
    const bundle = input.signalContexts.find((item) => item.signal.signalId === signal.signalId);
    this.database
      .prepare(
        `INSERT OR IGNORE INTO signals(
          signal_id,signal_idempotency_key,source_event_key,signal_type,status,asset_id,
          condition_id,target_price_units,target_size_micros,sell_ratio_numerator,
          sell_ratio_denominator,reason,schema_version,signal_version,strategy_version,
          risk_version,replay_version,ruleset_snapshot_json,ruleset_hash,source_code_commit,
          created_at,execution_eligible,execution_block_reason,event_classification,
          capital_estimate_id,capture_run_id,source_code_dirty,producer_mode,baseline_run_id,observe_run_id
        ) VALUES (?, ?, ?, ?, 'PUBLISHED', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 'OBSERVE_ONLY', ?, ?)`,
      )
      .run(
        signal.signalId,
        signal.signalIdempotencyKey,
        signal.sourceEventKey,
        signal.signalType,
        signal.asset,
        signal.conditionId,
        signal.targetPriceUnits,
        signal.targetSizeMicros,
        signal.sellRatioNumerator,
        signal.sellRatioDenominator,
        signal.reason,
        VERSIONS.schemaVersion,
        OBSERVE_SIGNAL_VERSION,
        VERSIONS.strategyVersion,
        VERSIONS.riskVersion,
        VERSIONS.replayVersion,
        RULESET_SNAPSHOT_JSON,
        RULESET_HASH,
        this.sourceVersion.commit,
        input.completedAt,
        signal.executionEligible ? 1 : 0,
        signal.executionBlockReason,
        signal.eventClassification,
        bundle?.capitalDecision?.capitalEstimateId ?? null,
        this.sourceVersion.dirty ? 1 : 0,
        input.baseline.baselineRunId,
        input.observeRunId,
      );
    this.database
      .prepare(
        `INSERT OR IGNORE INTO observe_signal_emissions(
          emission_id,baseline_run_id,observe_run_id,poll_id,source_event_key,signal_id,
          execution_eligible,event_classification,created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        createHash("sha256").update(`${input.baseline.baselineRunId}|${signal.sourceEventKey}`).digest("hex"),
        input.baseline.baselineRunId,
        input.observeRunId,
        pollId,
        signal.sourceEventKey,
        signal.signalId,
        signal.executionEligible ? 1 : 0,
        signal.eventClassification,
        input.completedAt,
      );
    const transitions = [
      [null, "CREATED", "SOURCE_EVENT_ACCEPTED"],
      ["CREATED", "VALIDATING", "OBSERVE_VALIDATION"],
      ["VALIDATING", "READY", "SIGNAL_VALID"],
      ["READY", "PUBLISHED", "OBSERVE_ONLY_PUBLISHED"],
    ] as const;
    const insertTransition = this.database.prepare(
      `INSERT OR IGNORE INTO state_transitions(
        transition_id,entity_type,entity_id,from_state,to_state,reason,schema_version,
        signal_version,strategy_version,risk_version,replay_version,ruleset_snapshot_json,
        ruleset_hash,source_code_commit,created_at,source_code_dirty
      ) VALUES (?, 'SIGNAL', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    transitions.forEach(([from, to, reason], index) => {
      insertTransition.run(
        createHash("sha256").update(`${signal.signalId}|${index}|${to}`).digest("hex"),
        signal.signalId,
        from,
        to,
        reason,
        VERSIONS.schemaVersion,
        OBSERVE_SIGNAL_VERSION,
        VERSIONS.strategyVersion,
        VERSIONS.riskVersion,
        VERSIONS.replayVersion,
        RULESET_SNAPSHOT_JSON,
        RULESET_HASH,
        this.sourceVersion.commit,
        input.completedAt,
        this.sourceVersion.dirty ? 1 : 0,
      );
    });
  }

  private insertSignalExecutionContext(bundle: SignalContextBundle): void {
    this.database
      .prepare(
        `INSERT INTO signal_execution_contexts(
          context_id,signal_id,capital_decision_id,target_trade_capital_ratio_ppm,
          target_trade_timestamp,market_end_time,market_metadata_snapshot_json,
          market_metadata_hash,ruleset_hash,schema_version,signal_version,
          strategy_version,source_code_commit,source_code_dirty,config_version,created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        bundle.context.contextId,
        bundle.context.signalId,
        bundle.context.capitalDecisionId,
        bundle.context.targetTradeCapitalRatioPpm,
        bundle.context.targetTradeTimestamp,
        bundle.context.marketEndTime,
        JSON.stringify(bundle.context.marketMetadataSnapshot),
        bundle.context.marketMetadataHash,
        bundle.context.rulesetHash,
        VERSIONS.schemaVersion,
        VERSIONS.signalVersion,
        VERSIONS.strategyVersion,
        bundle.context.sourceCodeCommit,
        bundle.context.sourceCodeDirty ? 1 : 0,
        bundle.context.configVersion,
        bundle.context.createdAt,
      );
  }
}
