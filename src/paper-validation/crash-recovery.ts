import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { stableJson } from "../domain/versioning.js";
import { registeredExecutionRules } from "../domain/ruleset-registry.js";
import { projectObserveEvents } from "../observe/position-projector.js";
import {
  decodePersistedObserveEvent,
  assertObserveOrderingCompatible,
  type PersistedObserveEventRow,
} from "../observe/observe-store.js";
import type { ObserveBaseline, ObserveEvent } from "../observe/types.js";
import type { PaperAcceptanceSummary } from "../paper/paper-acceptance-summary.js";
import { PAPER_CONSUMER_CUTOFF_SIGNAL_SENTINEL } from "../paper/paper-executor.js";
import type { FinalIntegrityEvidence } from "./final-integrity.js";
import type { CheckpointEvidence, ValidationCheckpoint } from "./types.js";

export type CampaignRuntimeProcessRole = "SUPERVISOR" | "PAPER" | "OBSERVE";

export interface CampaignRuntimeProcess {
  pid: number;
  role: CampaignRuntimeProcessRole;
  command: string;
}

export interface InterruptedSessionRecoveryDecision {
  confirmed: boolean;
  blockers: string[];
  latestCheckpointId: string | null;
  latestCheckpointKind: string | null;
  lingeringProcesses: Array<Pick<CampaignRuntimeProcess, "pid" | "role">>;
}

export interface InterruptedDatabaseContinuity {
  blockers: string[];
  abandonedObserveRunIds: string[];
  waitingBuyCount: number;
  pendingExitCount: number;
  currentObserveCheckpointId: string | null;
  currentPaperConsumerCreatedAt: string | null;
  currentPaperConsumerSignalId: string | null;
  currentPositionProjectionHash: string | null;
  currentPortfolioProjectionHash: string | null;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

export function validationCheckpointChainBlockers(input: {
  checkpoints: ValidationCheckpoint[];
  campaignId: string;
  sessionId: string;
  sessionStartedAt: string;
  expectedLiveGateTransitionCount: number;
}): string[] {
  const blockers: string[] = [];
  const startedAt = Date.parse(input.sessionStartedAt);
  if (!Number.isFinite(startedAt)) return ["RECOVERY_SESSION_STARTED_AT_INVALID"];
  let previousObservedAt = startedAt;
  let previousElapsedRuntimeMs = 0;
  for (const [index, checkpoint] of input.checkpoints.entries()) {
    const expectedSequence = index + 1;
    if (checkpoint.sequence !== expectedSequence) blockers.push(`RECOVERY_CHECKPOINT_SEQUENCE_INVALID:${checkpoint.sequence}`);
    if (checkpoint.campaignId !== input.campaignId || checkpoint.sessionId !== input.sessionId) {
      blockers.push(`RECOVERY_CHECKPOINT_BINDING_INVALID:${checkpoint.checkpointId}`);
    }
    const observedAt = Date.parse(checkpoint.observedAt);
    const monotonicRuntime = checkpoint.evidence.detail?.runtimeClock === "MONOTONIC_V1";
    if (!Number.isFinite(observedAt) || (!monotonicRuntime && observedAt < previousObservedAt)) {
      blockers.push(`RECOVERY_CHECKPOINT_TIME_INVALID:${checkpoint.checkpointId}`);
    }
    if (monotonicRuntime) {
      if (!Number.isSafeInteger(checkpoint.elapsedRuntimeMs)
        || checkpoint.elapsedRuntimeMs < previousElapsedRuntimeMs
        || checkpoint.evidence.detail?.monotonicElapsedRuntimeMs !== checkpoint.elapsedRuntimeMs) {
        blockers.push(`RECOVERY_CHECKPOINT_ELAPSED_INVALID:${checkpoint.checkpointId}`);
      }
    } else if (Number.isFinite(observedAt) && checkpoint.elapsedRuntimeMs !== observedAt - startedAt) {
      blockers.push(`RECOVERY_CHECKPOINT_ELAPSED_INVALID:${checkpoint.checkpointId}`);
    }
    previousObservedAt = Number.isFinite(observedAt) ? observedAt : previousObservedAt;
    previousElapsedRuntimeMs = checkpoint.elapsedRuntimeMs;
    if (checkpoint.executionMode !== "PAPER" || checkpoint.liveGateState !== "LIVE_DISABLED") {
      blockers.push(`RECOVERY_CHECKPOINT_SAFETY_INVALID:${checkpoint.checkpointId}`);
    }
    if (checkpoint.liveGateTransitionCount !== input.expectedLiveGateTransitionCount) {
      blockers.push(`RECOVERY_CHECKPOINT_LIVE_GATE_TRANSITION:${checkpoint.checkpointId}`);
    }
    const expectedHash = sha256({
      sessionId: checkpoint.sessionId,
      checkpointKind: checkpoint.checkpointKind,
      observedAt: checkpoint.observedAt,
      executionMode: checkpoint.executionMode,
      liveGateState: checkpoint.liveGateState,
      liveGateTransitionCount: checkpoint.liveGateTransitionCount,
      ...(monotonicRuntime ? { elapsedRuntimeMs: checkpoint.elapsedRuntimeMs } : {}),
      evidence: checkpoint.evidence,
    });
    if (checkpoint.checkpointHash !== expectedHash) {
      blockers.push(`RECOVERY_CHECKPOINT_HASH_MISMATCH:${checkpoint.checkpointId}`);
    }
  }
  return normalized(blockers);
}

function compareCursor(
  leftAt: string | null | undefined,
  leftId: string | null | undefined,
  rightAt: string | null | undefined,
  rightId: string | null | undefined,
): number {
  if (leftAt === rightAt) return (leftId ?? "").localeCompare(rightId ?? "");
  if (leftAt === null || leftAt === undefined) return rightAt === null || rightAt === undefined ? 0 : -1;
  if (rightAt === null || rightAt === undefined) return 1;
  return leftAt.localeCompare(rightAt);
}

function observeProjection(database: DatabaseSync, baselineRunId: string): {
  baseline: ObserveBaseline;
  projectionHash: string;
  lastProcessedTimestamp: number | null;
  lastProcessedEventId: string | null;
} {
  const run = database.prepare(
    `SELECT baseline_run_id,target_id,wallet_address,snapshot_time
     FROM position_baseline_runs WHERE baseline_run_id=? AND status='READY'`,
  ).get(baselineRunId) as {
    baseline_run_id: string;
    target_id: string;
    wallet_address: string;
    snapshot_time: string;
  } | undefined;
  if (!run) throw new Error("RECOVERY_BASELINE_NOT_READY");
  const items = database.prepare(
    `SELECT asset_id,condition_id,size_micros FROM position_baseline_items
     WHERE baseline_run_id=? ORDER BY asset_id`,
  ).all(baselineRunId) as Array<{ asset_id: string; condition_id: string; size_micros: string }>;
  const baseline: ObserveBaseline = {
    baselineRunId,
    targetId: run.target_id,
    walletAddress: run.wallet_address,
    snapshotTime: run.snapshot_time,
    items: items.map((item) => ({
      asset: item.asset_id,
      conditionId: item.condition_id,
      sizeMicros: item.size_micros,
    })),
  };
  assertObserveOrderingCompatible(database, baselineRunId);
  const rows = database.prepare(
    `SELECT o.source_event_key,o.source_type,o.source_timestamp,o.is_gap,
            o.activity_confirmed,r.is_combo,r.raw_json,
            ordering.chain_order_json,ordering.evidence_hash chain_order_hash,
            c.transaction_hash conversion_transaction_hash,
            c.group_condition_id conversion_group_condition_id,
            c.event_slug conversion_event_slug,
            c.source_asset_id conversion_source_asset_id,
            c.destination_legs_json conversion_destination_legs_json,
            c.amount_micros conversion_amount_micros,
            c.receipt_block_number conversion_receipt_block_number,
            c.receipt_payload_hash conversion_receipt_payload_hash,
            c.evidence_hash conversion_evidence_hash,
            sp.transaction_hash split_transaction_hash,
            sp.condition_id split_condition_id,
            sp.outcome_assets_json split_outcome_assets_json,
            sp.amount_micros split_amount_micros,
            sp.market_source_url split_market_source_url,
            sp.market_fetched_at split_market_fetched_at,
            sp.market_snapshot_json split_market_snapshot_json,
            sp.market_snapshot_hash split_market_snapshot_hash,
            sp.positions_snapshot_time split_positions_snapshot_time,
            sp.positions_snapshot_json split_positions_snapshot_json,
            sp.positions_snapshot_hash split_positions_snapshot_hash,
            sp.evidence_hash split_evidence_hash
     FROM observe_events o JOIN raw_events r ON r.source_event_key=o.source_event_key
     LEFT JOIN observe_event_order_evidence ordering ON ordering.source_event_key=o.source_event_key
     LEFT JOIN negative_risk_conversion_evidence c ON c.source_event_key=o.source_event_key
     LEFT JOIN split_projection_evidence sp ON sp.source_event_key=o.source_event_key
     WHERE o.baseline_run_id=? ORDER BY o.source_timestamp,o.source_event_key`,
  ).all(baselineRunId) as unknown as PersistedObserveEventRow[];
  const events: ObserveEvent[] = rows.map(decodePersistedObserveEvent);
  const observeRun = database.prepare(
    `SELECT ruleset_hash FROM observe_runs
     WHERE baseline_run_id=? ORDER BY started_at DESC,observe_run_id DESC LIMIT 1`,
  ).get(baselineRunId) as { ruleset_hash: string } | undefined;
  const executionRules = observeRun
    ? registeredExecutionRules(database, observeRun.ruleset_hash)
    : null;
  const projection = projectObserveEvents(baseline, events, {
    followSellFullExitThresholdPpm: executionRules?.followSellFullExitThresholdPpm ?? 1_000_000,
  });
  return {
    baseline,
    projectionHash: projection.projectionHash,
    lastProcessedTimestamp: projection.lastProcessedTimestamp,
    lastProcessedEventId: projection.lastProcessedEventId,
  };
}

/** Read-only proof that persisted Observe/Paper cursors did not roll back. */
export function inspectInterruptedDatabaseContinuity(input: {
  databasePath: string;
  campaignId: string;
  sessionId: string;
  sessionStartedAt: string;
  targetId: string;
  baselineRunId: string;
  paperAccountId: string;
  latestCheckpoint: ValidationCheckpoint | null;
  currentEvidence: CheckpointEvidence;
}): InterruptedDatabaseContinuity {
  const database = new DatabaseSync(input.databasePath, { readOnly: true });
  database.exec("PRAGMA query_only=ON; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
  const blockers: string[] = [];
  try {
    const projected = observeProjection(database, input.baselineRunId);
    if (projected.baseline.targetId !== input.targetId) blockers.push("RECOVERY_BASELINE_TARGET_MISMATCH");
    const currentObserve = database.prepare(
      `SELECT c.checkpoint_id,c.target_id,c.baseline_run_id,c.observe_run_id,c.created_at,
              c.last_processed_timestamp,c.last_processed_event_id,c.replay_state,
              COALESCE(NULLIF(c.position_projection_json,''),s.projection_json) position_projection_json,
              c.position_projection_hash,c.capital_snapshot_id
       FROM observe_checkpoints c
       JOIN observe_runs o ON o.observe_run_id=c.observe_run_id
       LEFT JOIN observe_projection_snapshots s
         ON s.projection_snapshot_hash=c.projection_snapshot_hash
       WHERE c.target_id=? AND c.baseline_run_id=?
         AND o.campaign_id=? AND o.campaign_session_id=?
       ORDER BY c.created_at DESC,c.checkpoint_id DESC LIMIT 1`,
    ).get(input.targetId, input.baselineRunId, input.campaignId, input.sessionId) as {
      checkpoint_id: string;
      target_id: string;
      baseline_run_id: string;
      observe_run_id: string;
      created_at: string;
      last_processed_timestamp: number | null;
      last_processed_event_id: string | null;
      replay_state: string;
      position_projection_json: string;
      position_projection_hash: string;
      capital_snapshot_id: string;
    } | undefined;
    const previousObserveId = input.latestCheckpoint?.evidence.observeCheckpointId ?? null;
    const previousObserve = previousObserveId ? database.prepare(
      `SELECT c.checkpoint_id,c.target_id,c.baseline_run_id,c.observe_run_id,c.created_at,
              c.position_projection_hash,c.capital_snapshot_id,c.last_processed_timestamp,
              c.last_processed_event_id
       FROM observe_checkpoints c
       JOIN observe_runs o ON o.observe_run_id=c.observe_run_id
       WHERE c.checkpoint_id=? AND o.campaign_id=? AND o.campaign_session_id=?`,
    ).get(previousObserveId, input.campaignId, input.sessionId) as {
      checkpoint_id: string;
      target_id: string;
      baseline_run_id: string;
      observe_run_id: string;
      created_at: string;
      position_projection_hash: string;
      capital_snapshot_id: string;
      last_processed_timestamp: number | null;
      last_processed_event_id: string | null;
    } | undefined : undefined;
    if (previousObserveId && !previousObserve) blockers.push("RECOVERY_HEARTBEAT_OBSERVE_CHECKPOINT_MISSING");
    if (previousObserve && (
      previousObserve.target_id !== input.targetId
      || previousObserve.baseline_run_id !== input.baselineRunId
      || previousObserve.position_projection_hash !== input.latestCheckpoint?.evidence.positionProjectionHash
    )) blockers.push("RECOVERY_HEARTBEAT_OBSERVE_CHECKPOINT_MISMATCH");
    if (previousObserve && currentObserve && Date.parse(currentObserve.created_at) < Date.parse(previousObserve.created_at)) {
      blockers.push("RECOVERY_OBSERVE_CHECKPOINT_ROLLBACK");
    }
    if (previousObserve && currentObserve
      && previousObserve.last_processed_timestamp !== null
      && (currentObserve.last_processed_timestamp === null
        || currentObserve.last_processed_timestamp < previousObserve.last_processed_timestamp)) {
      blockers.push("RECOVERY_OBSERVE_CURSOR_ROLLBACK");
    }
    if (previousObserve && !currentObserve) blockers.push("RECOVERY_CURRENT_OBSERVE_CHECKPOINT_MISSING");
    if (currentObserve) {
      let persistedProjectionHash = "INVALID";
      try {
        persistedProjectionHash = sha256(JSON.parse(currentObserve.position_projection_json));
      } catch {
        blockers.push("RECOVERY_OBSERVE_PROJECTION_JSON_INVALID");
      }
      if (
        currentObserve.position_projection_hash !== projected.projectionHash
        || persistedProjectionHash !== currentObserve.position_projection_hash
        || currentObserve.last_processed_timestamp !== projected.lastProcessedTimestamp
        || currentObserve.last_processed_event_id !== projected.lastProcessedEventId
      ) blockers.push("RECOVERY_OBSERVE_PROJECTION_MISMATCH");
      if (
        input.currentEvidence.observeCheckpointId !== currentObserve.checkpoint_id
        || input.currentEvidence.positionProjectionHash !== currentObserve.position_projection_hash
        || input.currentEvidence.lastProcessedEventId !== currentObserve.last_processed_event_id
        || input.currentEvidence.replayState !== currentObserve.replay_state
        || input.currentEvidence.capitalSnapshotId !== currentObserve.capital_snapshot_id
      ) blockers.push("RECOVERY_CURRENT_OBSERVE_EVIDENCE_MISMATCH");
      const monitor = database.prepare(
        `SELECT checkpoint_id,baseline_run_id,replay_state,position_projection_hash,
                capital_snapshot_id,last_source_event_key
         FROM monitor_checkpoints WHERE target_id=?`,
      ).get(input.targetId) as {
        checkpoint_id: string | null;
        baseline_run_id: string | null;
        replay_state: string | null;
        position_projection_hash: string | null;
        capital_snapshot_id: string | null;
        last_source_event_key: string | null;
      } | undefined;
      if (!monitor
        || monitor.checkpoint_id !== currentObserve.checkpoint_id
        || monitor.baseline_run_id !== input.baselineRunId
        || monitor.replay_state !== currentObserve.replay_state
        || monitor.position_projection_hash !== currentObserve.position_projection_hash
        || monitor.capital_snapshot_id !== currentObserve.capital_snapshot_id
        || monitor.last_source_event_key !== currentObserve.last_processed_event_id) {
        blockers.push("RECOVERY_MONITOR_CHECKPOINT_MISMATCH");
      }
    }

    const consumer = database.prepare(
      `SELECT last_signal_created_at,last_signal_id FROM paper_consumer_checkpoints
       WHERE paper_account_id=?`,
    ).get(input.paperAccountId) as {
      last_signal_created_at: string | null;
      last_signal_id: string | null;
    } | undefined;
    if (!consumer) blockers.push("RECOVERY_PAPER_CONSUMER_CHECKPOINT_MISSING");
    const previousConsumerAt = input.latestCheckpoint?.evidence.paperConsumerCreatedAt ?? null;
    const previousConsumerId = input.latestCheckpoint?.evidence.paperConsumerSignalId ?? null;
    const consumerRolledBack = consumer && compareCursor(
      consumer.last_signal_created_at,
      consumer.last_signal_id,
      previousConsumerAt,
      previousConsumerId,
    ) < 0;
    if (consumerRolledBack) blockers.push("RECOVERY_PAPER_CONSUMER_CURSOR_ROLLBACK");
    if (consumer && !consumerRolledBack) {
      const cursorCandidates: Array<{ createdAt: string; signalId: string }> = [];
      const consumed = database.prepare(
        `SELECT s.created_at,s.signal_id
         FROM paper_signal_consumptions c JOIN signals s ON s.signal_id=c.signal_id
         WHERE c.paper_account_id=?`,
      ).all(input.paperAccountId) as Array<{ created_at: string; signal_id: string }>;
      cursorCandidates.push(...consumed.map((row) => ({ createdAt: row.created_at, signalId: row.signal_id })));
      const cutoffAudits = database.prepare(
        `SELECT metadata_json FROM audit_log
         WHERE entity_type='PAPER_CONSUMER_CHECKPOINT' AND entity_id=?
           AND action='CHECKPOINT_ADVANCED'`,
      ).all(input.paperAccountId) as Array<{ metadata_json: string }>;
      for (const row of cutoffAudits) {
        try {
          const metadata = JSON.parse(row.metadata_json) as { cutoffAt?: unknown };
          if (typeof metadata.cutoffAt !== "string" || !Number.isFinite(Date.parse(metadata.cutoffAt))) {
            blockers.push("RECOVERY_PAPER_CONSUMER_CUTOFF_AUDIT_INVALID");
            continue;
          }
          cursorCandidates.push({
            createdAt: new Date(metadata.cutoffAt).toISOString(),
            signalId: PAPER_CONSUMER_CUTOFF_SIGNAL_SENTINEL,
          });
        } catch {
          blockers.push("RECOVERY_PAPER_CONSUMER_CUTOFF_AUDIT_INVALID");
        }
      }
      const expectedCursor = cursorCandidates.sort((left, right) => compareCursor(
        left.createdAt,
        left.signalId,
        right.createdAt,
        right.signalId,
      )).at(-1) ?? null;
      const currentIsEmpty = consumer.last_signal_created_at === null && consumer.last_signal_id === null;
      const cursorExactlyBound = expectedCursor === null
        ? currentIsEmpty
        : consumer.last_signal_created_at === expectedCursor.createdAt
          && consumer.last_signal_id === expectedCursor.signalId;
      if (!cursorExactlyBound) blockers.push("RECOVERY_PAPER_CONSUMER_CURSOR_UNBOUND");
    }

    const portfolioRows = database.prepare(
      `SELECT portfolio_snapshot_id,cash_balance_micros,reserved_balance_micros,
              position_value_micros,realized_pnl_micros,unrealized_pnl_micros,
              total_equity_micros,valuation_status,unpriced_position_count,created_at
       FROM paper_portfolio_snapshots WHERE paper_account_id=?
       ORDER BY created_at,portfolio_snapshot_id`,
    ).all(input.paperAccountId) as Array<{
      portfolio_snapshot_id: string;
      cash_balance_micros: string;
      reserved_balance_micros: string;
      position_value_micros: string;
      realized_pnl_micros: string;
      unrealized_pnl_micros: string;
      total_equity_micros: string;
      valuation_status: string;
      unpriced_position_count: number;
      created_at: string;
    }>;
    const portfolioHashes = portfolioRows.map((row) => sha256(row));
    const previousPortfolioHash = input.latestCheckpoint?.evidence.portfolioProjectionHash ?? null;
    if (previousPortfolioHash && !portfolioHashes.includes(previousPortfolioHash)) {
      blockers.push("RECOVERY_HEARTBEAT_PORTFOLIO_SNAPSHOT_MISSING");
    }
    const currentPortfolioHash = portfolioHashes.at(-1) ?? null;
    if (currentPortfolioHash !== input.currentEvidence.portfolioProjectionHash) {
      blockers.push("RECOVERY_CURRENT_PORTFOLIO_SNAPSHOT_MISMATCH");
    }
    const currentPortfolio = portfolioRows.at(-1) ?? null;
    const currentAccount = database.prepare(
      `SELECT cash_balance_micros,reserved_balance_micros,realized_pnl_micros
       FROM paper_accounts WHERE paper_account_id=?`,
    ).get(input.paperAccountId) as {
      cash_balance_micros: string;
      reserved_balance_micros: string;
      realized_pnl_micros: string;
    } | undefined;
    if (!currentAccount) {
      blockers.push("RECOVERY_PAPER_ACCOUNT_MISSING");
    } else if (currentPortfolio && (
      currentPortfolio.cash_balance_micros !== currentAccount.cash_balance_micros
      || currentPortfolio.reserved_balance_micros !== currentAccount.reserved_balance_micros
      || currentPortfolio.realized_pnl_micros !== currentAccount.realized_pnl_micros
      || BigInt(currentPortfolio.total_equity_micros)
        !== BigInt(currentPortfolio.cash_balance_micros) + BigInt(currentPortfolio.position_value_micros)
    )) {
      blockers.push("RECOVERY_CURRENT_PORTFOLIO_ACCOUNT_MISMATCH");
    }

    for (const capitalId of [
      input.latestCheckpoint?.evidence.capitalSnapshotId,
      currentObserve?.capital_snapshot_id,
    ].filter((value): value is string => Boolean(value))) {
      if (!database.prepare("SELECT 1 present FROM capital_estimates WHERE capital_estimate_id=?").get(capitalId)) {
        blockers.push(`RECOVERY_CAPITAL_SNAPSHOT_MISSING:${capitalId}`);
      }
    }

    const pending = database.prepare(
      `SELECT
         SUM(CASE WHEN execution_type='TARGET_BUY' AND state='WAITING_EXECUTION' THEN 1 ELSE 0 END) waiting_buy_count,
         SUM(CASE WHEN state IN ('EXIT_PENDING','STOP_EXIT_PENDING') THEN 1 ELSE 0 END) pending_exit_count
       FROM paper_executions WHERE paper_account_id=?`,
    ).get(input.paperAccountId) as { waiting_buy_count: number | null; pending_exit_count: number | null };
    const runningObserveRows = database.prepare(
      `SELECT observe_run_id,baseline_run_id,started_at,campaign_id,campaign_session_id FROM observe_runs
       WHERE target_id=? AND state='RUNNING' ORDER BY started_at,observe_run_id`,
    ).all(input.targetId) as Array<{
      observe_run_id: string;
      baseline_run_id: string;
      started_at: string;
      campaign_id: string | null;
      campaign_session_id: string | null;
    }>;
    const abandonedObserveRunIds = runningObserveRows
      .filter((row) => row.baseline_run_id === input.baselineRunId
        && row.campaign_id === input.campaignId
        && row.campaign_session_id === input.sessionId)
      .map((row) => row.observe_run_id);
    if (runningObserveRows.some((row) => !abandonedObserveRunIds.includes(row.observe_run_id))) {
      blockers.push("RECOVERY_UNBOUND_RUNNING_OBSERVE_RUN");
    }
    if (abandonedObserveRunIds.length > 1) blockers.push("RECOVERY_MULTIPLE_RUNNING_OBSERVE_RUNS");
    if (previousObserve && abandonedObserveRunIds.length === 1
      && Date.parse(previousObserve.created_at) >= Date.parse(input.sessionStartedAt)
      && previousObserve.observe_run_id !== abandonedObserveRunIds[0]) {
      blockers.push("RECOVERY_RUNNING_OBSERVE_BINDING_MISMATCH");
    }
    return {
      blockers: normalized(blockers),
      abandonedObserveRunIds,
      waitingBuyCount: Number(pending.waiting_buy_count ?? 0),
      pendingExitCount: Number(pending.pending_exit_count ?? 0),
      currentObserveCheckpointId: currentObserve?.checkpoint_id ?? null,
      currentPaperConsumerCreatedAt: consumer?.last_signal_created_at ?? null,
      currentPaperConsumerSignalId: consumer?.last_signal_id ?? null,
      currentPositionProjectionHash: currentObserve?.position_projection_hash ?? null,
      currentPortfolioProjectionHash: currentPortfolioHash,
    };
  } finally {
    database.close();
  }
}

/**
 * Parses a process listing without trusting persisted PIDs. PIDs can be reused;
 * command-line role and campaign/session bindings are therefore checked too.
 */
export function findCampaignRuntimeProcesses(input: {
  psOutput: string;
  campaignId: string;
  sessionId: string;
  currentPid: number;
}): CampaignRuntimeProcess[] {
  const campaignArgument = `--campaign-id=${input.campaignId}`;
  const sessionArgument = `--session-id=${input.sessionId}`;
  const processes: CampaignRuntimeProcess[] = [];
  for (const line of input.psOutput.split("\n")) {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const command = match[2]!;
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid === input.currentPid) continue;
    if (command.includes("src/cli/paper-campaign-run.ts")) {
      processes.push({ pid, role: "SUPERVISOR", command });
      continue;
    }
    if (!command.includes(campaignArgument) || !command.includes(sessionArgument)) continue;
    if (command.includes("src/cli/paper-run.ts")) {
      processes.push({ pid, role: "PAPER", command });
    } else if (command.includes("src/cli/observe-only.ts")) {
      processes.push({ pid, role: "OBSERVE", command });
    }
  }
  return processes.sort((left, right) => left.pid - right.pid || left.role.localeCompare(right.role));
}

function normalized(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}

/**
 * A crash is recoverable only when the stopped runtime, immutable checkpoint,
 * current database state and Paper safety boundary all independently agree.
 * This decision never repairs or rewrites business data.
 */
export function evaluateInterruptedSessionRecovery(input: {
  checkpoints: ValidationCheckpoint[];
  currentEvidence: CheckpointEvidence;
  integrity: FinalIntegrityEvidence;
  acceptance: PaperAcceptanceSummary;
  lingeringProcesses: CampaignRuntimeProcess[];
  processInspectionError?: string | null;
  continuityBlockers?: string[];
}): InterruptedSessionRecoveryDecision {
  const latest = input.checkpoints.at(-1) ?? null;
  const blockers = [
    ...(input.processInspectionError ? [`RECOVERY_PROCESS_INSPECTION_FAILED:${input.processInspectionError}`] : []),
    ...(input.continuityBlockers ?? []),
    ...input.lingeringProcesses.map((process) => `RECOVERY_PROCESS_STILL_RUNNING:${process.role}:${process.pid}`),
    ...input.integrity.blockers,
    ...(input.acceptance.consistency.passed ? [] : ["PAPER_CONSISTENCY_FAILED"]),
    ...(input.acceptance.consistency.reservations.activeReservationsMicros === "0"
      ? [] : ["ACTIVE_RESERVATION_REMAINS"]),
    ...(input.acceptance.marketData.blockerCount === 0 ? [] : ["UNRECOVERED_MARKET_DATA_BLOCKER"]),
    ...(latest ? [] : ["RECOVERY_VALIDATION_CHECKPOINT_MISSING"]),
    ...(latest && ["SAFE_STOP", "CRASH_RECOVERY"].includes(latest.checkpointKind)
      ? [`RECOVERY_LATEST_CHECKPOINT_KIND_INVALID:${latest.checkpointKind}`]
      : []),
    ...(latest?.consistencySafe === false ? ["RECOVERY_LATEST_CHECKPOINT_UNSAFE"] : []),
    ...(input.currentEvidence.observeActive || input.currentEvidence.paperActive
      ? ["RECOVERY_RUNTIME_NOT_QUIESCENT"]
      : []),
    ...(input.currentEvidence.consistencySafe ? [] : ["RECOVERY_CURRENT_STATE_UNSAFE"]),
  ];
  const uniqueBlockers = normalized(blockers);
  return {
    confirmed: uniqueBlockers.length === 0,
    blockers: uniqueBlockers,
    latestCheckpointId: latest?.checkpointId ?? null,
    latestCheckpointKind: latest?.checkpointKind ?? null,
    lingeringProcesses: input.lingeringProcesses.map(({ pid, role }) => ({ pid, role })),
  };
}
