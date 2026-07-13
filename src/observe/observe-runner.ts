import { activityEventKey, sourceEventKey } from "../domain/idempotency.js";
import { activityAsTrade } from "../domain/activity-trade.js";
import { estimateTargetCapital } from "../services/capital-estimator.js";
import { projectObserveEvents } from "./position-projector.js";
import { reconcileProjection } from "./reconciliation.js";
import { ObserveStore, type StartedObserveRun } from "./observe-store.js";
import type { ObserveDataSource, ObserveEvent, ObserveRunMetrics } from "./types.js";
import { buildSignalExecutionContext, type SignalContextBundle, type SignalMarketMetadataProvider } from "../signal-context/execution-context.js";
import type { SourceVersion } from "../infra/source-version.js";
import { observeSchedulingGapThresholdMs } from "./scheduling.js";

const ACTIVITY_CURSOR_OVERLAP_SECONDS = 5 * 60;

export interface ObserveRunnerOptions {
  walletAddress: string;
  pollIntervalMs: number;
  durationMs?: number;
  staleRunAfterMs?: number;
  now?: () => Date;
  wait?: (milliseconds: number) => Promise<void>;
  signalMarketMetadataProvider?: SignalMarketMetadataProvider;
  sourceVersion?: SourceVersion;
}

function assertRecoveryCoverage(snapshot: Awaited<ReturnType<ObserveDataSource["poll"]>>, gapFrom: string): void {
  const gapSecond = Math.floor(Date.parse(gapFrom) / 1_000);
  const checks = [
    { name: "Trades", timestamps: snapshot.trades.data.map((row) => row.timestamp), pageLimit: 1_000 },
    { name: "Activity", timestamps: snapshot.activity.data.map((row) => row.timestamp), pageLimit: 500 },
  ];
  for (const check of checks) {
    if (check.timestamps.length < check.pageLimit) continue;
    const oldest = Math.min(...check.timestamps);
    if (oldest > gapSecond) {
      throw new Error(`${check.name} recovery window is truncated before ${gapFrom}`);
    }
  }
}

export class ObserveOnlyRunner {
  private readonly now: () => Date;
  private readonly wait: (milliseconds: number) => Promise<void>;
  private started: StartedObserveRun | null = null;
  private gapActive = true;
  private checkpointHashMismatch = false;
  private lastSuccessfulAt: string | null = null;
  private lastPollCompletedAt: string | null = null;

  constructor(
    private readonly store: ObserveStore,
    private readonly source: ObserveDataSource,
    private readonly options: ObserveRunnerOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.wait = options.wait ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  start(): StartedObserveRun {
    if (this.started) {
      if (this.checkpointHashMismatch) throw new Error("CHECKPOINT_PROJECTION_HASH_MISMATCH");
      return this.started;
    }
    const now = this.now().toISOString();
    this.started = this.store.startRun(
      this.options.walletAddress,
      this.options.pollIntervalMs,
      now,
      this.options.staleRunAfterMs ?? Math.max(this.options.pollIntervalMs * 3, 30_000),
    );
    const existing = this.store.loadObservedEvents(this.started.baseline.baselineRunId);
    if (this.started.checkpoint) {
      const projection = projectObserveEvents(this.started.baseline, existing);
      this.checkpointHashMismatch = projection.projectionHash !== this.started.checkpoint.positionProjectionHash;
      if (this.checkpointHashMismatch) {
        this.store.failCheckpointProjectionMismatch({
          observeRunId: this.started.observeRunId,
          baseline: this.started.baseline,
          checkpoint: this.started.checkpoint,
          calculatedProjectionHash: projection.projectionHash,
          detectedAt: now,
        });
        throw new Error("CHECKPOINT_PROJECTION_HASH_MISMATCH");
      }
    }
    this.lastSuccessfulAt = this.started.checkpoint?.createdAt ?? this.started.baseline.snapshotTime;
    this.gapActive = true;
    return this.started;
  }

  async pollOnce(): Promise<boolean> {
    const started = this.start();
    const storedEvents = this.store.loadObservedEvents(started.baseline.baselineRunId);
    const oldestUnconfirmedTradeTimestamp = storedEvents
      .filter((event) => event.trade && !event.activityConfirmed)
      .reduce<number | null>((oldest, event) => (
        oldest === null || event.sourceTimestamp < oldest ? event.sourceTimestamp : oldest
      ), null);
    const latestConfirmedActivityTimestamp = storedEvents
      .filter((event) => event.activityConfirmed)
      .reduce<number | null>((latest, event) => (
        latest === null || event.sourceTimestamp > latest ? event.sourceTimestamp : latest
      ), null);
    const activityFromTimestamp = oldestUnconfirmedTradeTimestamp !== null
      ? Math.max(1, oldestUnconfirmedTradeTimestamp - 1)
      : latestConfirmedActivityTimestamp !== null
        ? Math.max(1, latestConfirmedActivityTimestamp - ACTIVITY_CURSOR_OVERLAP_SECONDS)
        : undefined;
    const sequence = this.store.nextPollSequence(started.observeRunId);
    const pollStartedAt = this.now().toISOString();
    if (
      this.lastPollCompletedAt
      && Date.parse(pollStartedAt) - Date.parse(this.lastPollCompletedAt)
        > observeSchedulingGapThresholdMs(this.options.pollIntervalMs)
    ) {
      this.gapActive = true;
    }
    let recoveryFrom = this.gapActive ? (this.lastSuccessfulAt ?? started.gapFrom) : null;
    let snapshot;
    try {
      snapshot = await this.source.poll(
        this.options.walletAddress,
        recoveryFrom ? Math.floor(Date.parse(recoveryFrom) / 1_000) : undefined,
        activityFromTimestamp,
      );
    } catch (error) {
      const failedAt = this.now().toISOString();
      this.store.recordFailedPoll(started.observeRunId, sequence, pollStartedAt, failedAt, error);
      this.lastPollCompletedAt = failedAt;
      this.gapActive = true;
      return false;
    }

    const completedAt = this.now().toISOString();
    if (
      Date.parse(completedAt) - Date.parse(pollStartedAt)
        > observeSchedulingGapThresholdMs(this.options.pollIntervalMs)
    ) {
      this.gapActive = true;
      recoveryFrom = this.lastSuccessfulAt ?? started.gapFrom;
    }
    try {
      if (recoveryFrom) assertRecoveryCoverage(snapshot, recoveryFrom);
    } catch (error) {
      const failedAt = this.now().toISOString();
      this.store.recordFailedPoll(started.observeRunId, sequence, pollStartedAt, failedAt, error, "PROCESSING_FAILED");
      this.lastPollCompletedAt = failedAt;
      this.gapActive = true;
      return false;
    }

    const baselineSecond = Math.floor(Date.parse(started.baseline.snapshotTime) / 1_000);
    const incoming: ObserveEvent[] = [
      ...snapshot.trades.data
        .filter((trade) => trade.timestamp > baselineSecond)
        .map((trade): ObserveEvent => ({
          sourceEventKey: sourceEventKey(trade),
          sourceType: "DATA_API_TRADE",
          sourceTimestamp: trade.timestamp,
          isGap: this.gapActive,
          isCombo: false,
          activityConfirmed: false,
          trade,
        })),
      ...snapshot.activity.data
        .filter((activity) => activity.timestamp > baselineSecond)
        .map((activity): ObserveEvent => {
          const normalizedTrade = activityAsTrade(activity);
          return normalizedTrade ? {
            sourceEventKey: sourceEventKey(normalizedTrade),
            sourceType: "DATA_API_TRADE",
            sourceTimestamp: normalizedTrade.timestamp,
            isGap: this.gapActive,
            isCombo: activity.isCombo === true,
            activityConfirmed: true,
            trade: normalizedTrade,
          } : {
            sourceEventKey: activityEventKey(activity),
            sourceType: "DATA_API_ACTIVITY",
            sourceTimestamp: activity.timestamp,
            isGap: this.gapActive,
            isCombo: ["SPLIT", "MERGE", "CONVERSION"].includes(activity.type),
            activityConfirmed: true,
            activity,
          };
        }),
    ];
    const unique = new Map<string, ObserveEvent>();
    let duplicateEvents = 0;
    for (const event of incoming) {
      const prior = unique.get(event.sourceEventKey);
      if (prior) {
        duplicateEvents += 1;
        if (event.activityConfirmed || event.isCombo) {
          unique.set(event.sourceEventKey, {
            ...prior,
            isCombo: prior.isCombo || event.isCombo,
            activityConfirmed: prior.activityConfirmed || event.activityConfirmed,
          });
        }
      } else unique.set(event.sourceEventKey, event);
    }
    const existingKeys = this.store.existingEventKeys(started.baseline.baselineRunId, [...unique.keys()]);
    duplicateEvents += existingKeys.size;
    const newEvents = [...unique.values()].filter((event) => !existingKeys.has(event.sourceEventKey));
    const storedByKey = new Map(storedEvents.map((event) => [event.sourceEventKey, event]));
    const eventConfirmations = [...unique.values()]
      .filter((event) => {
        if (!existingKeys.has(event.sourceEventKey) || !event.activityConfirmed) return false;
        const stored = storedByKey.get(event.sourceEventKey);
        return stored !== undefined && (!stored.activityConfirmed || (event.isCombo && !stored.isCombo));
      })
      .map((event) => ({ sourceEventKey: event.sourceEventKey, isCombo: event.isCombo }));
    for (const confirmation of eventConfirmations) {
      const stored = storedByKey.get(confirmation.sourceEventKey);
      if (!stored) throw new Error(`Observed event missing during confirmation: ${confirmation.sourceEventKey}`);
      stored.activityConfirmed = true;
      stored.isCombo = stored.isCombo || confirmation.isCombo;
    }
    const projection = projectObserveEvents(started.baseline, [...storedEvents, ...newEvents]);
    const signalCandidateKeys = new Set([
      ...newEvents.filter((event) => event.activityConfirmed).map((event) => event.sourceEventKey),
      ...eventConfirmations.map((event) => event.sourceEventKey),
    ]);
    const signalsToEmit = projection.signals.filter((signal) => signalCandidateKeys.has(signal.sourceEventKey));
    const previousDiffs = this.store.consecutiveDiffCount(started.baseline.baselineRunId);
    const reconciliation = reconcileProjection(projection.projection, snapshot.positions.data, previousDiffs);
    const balanceResult = snapshot.pUsdBalance.data.result;
    const walletBalanceMicros = balanceResult && /^0x[0-9a-f]+$/i.test(balanceResult) ? BigInt(balanceResult) : null;
    const capitalEstimate = estimateTargetCapital({
      walletAddress: this.options.walletAddress,
      identityStatus: "IDENTITY_CONFIRMED",
      syncStatus: this.store.targetSyncStatus(started.baseline.targetId),
      positions: snapshot.positions.data,
      positionSnapshotTime: snapshot.positions.fetchedAt,
      walletBalanceMicros,
      walletBalanceSnapshotTime: snapshot.pUsdBalance.fetchedAt,
    });
    const signalContexts: SignalContextBundle[] = [];
    try {
      if (this.options.signalMarketMetadataProvider) {
      const marketCache = new Map<string, Awaited<ReturnType<SignalMarketMetadataProvider["market"]>>>();
      const eventByKey = new Map(
        [...storedEvents, ...newEvents].map((event) => [event.sourceEventKey, event]),
      );
      for (const signal of signalsToEmit.filter((item) => item.executionEligible)) {
        const event = eventByKey.get(signal.sourceEventKey);
        if (!event?.trade) throw new Error(`Signal event missing: ${signal.signalId}`);
        let market = marketCache.get(signal.conditionId);
        if (!market) {
          market = await this.options.signalMarketMetadataProvider.market(signal.conditionId);
          marketCache.set(signal.conditionId, market);
        }
        const capitalDecision = signal.signalType === "TARGET_BUY" ? estimateTargetCapital({
          walletAddress: this.options.walletAddress,
          sourceEventKey: signal.sourceEventKey,
          identityStatus: "IDENTITY_CONFIRMED",
          syncStatus: reconciliation.syncStatus,
          positions: snapshot.positions.data,
          positionSnapshotTime: snapshot.positions.fetchedAt,
          walletBalanceMicros,
          walletBalanceSnapshotTime: snapshot.pUsdBalance.fetchedAt,
          targetTrade: event.trade,
        }) : null;
        signalContexts.push({
          signal,
          capitalDecision,
          context: buildSignalExecutionContext({
            signal,
            event,
            market: market.market,
            marketSourceUrl: market.sourceUrl,
            marketFetchedAt: market.fetchedAt,
            capitalDecision,
            ...(this.options.sourceVersion ? { sourceVersion: this.options.sourceVersion } : {}),
            createdAt: completedAt,
          }),
        });
      }
      }
    } catch (error) {
      this.store.recordFailedPoll(started.observeRunId, sequence, pollStartedAt, completedAt, error, "PROCESSING_FAILED");
      this.lastPollCompletedAt = completedAt;
      this.gapActive = true;
      return false;
    }
    this.store.commitSuccessfulPoll({
      observeRunId: started.observeRunId,
      baseline: started.baseline,
      sequence,
      startedAt: pollStartedAt,
      completedAt,
      snapshot,
      newEvents,
      eventConfirmations,
      duplicateEvents,
      projection,
      signalsToEmit,
      capitalEstimate,
      signalContexts,
      reconciliation,
      replayState: this.gapActive ? "GAP_RECOVERED" : "ONLINE",
      gapRecovered: this.gapActive,
    });
    this.lastSuccessfulAt = completedAt;
    this.lastPollCompletedAt = completedAt;
    this.gapActive = false;
    return true;
  }

  async run(signal?: AbortSignal): Promise<ObserveRunMetrics> {
    const started = this.start();
    const runStartedMs = this.now().valueOf();
    const deadline = this.options.durationMs && this.options.durationMs > 0
      ? runStartedMs + this.options.durationMs
      : Number.POSITIVE_INFINITY;
    let failed = false;
    let reason = "DURATION_COMPLETE";
    try {
      while (!signal?.aborted && this.now().valueOf() < deadline) {
        await this.pollOnce();
        const remaining = deadline - this.now().valueOf();
        if (remaining <= 0) break;
        await this.wait(Math.min(this.options.pollIntervalMs, remaining));
      }
      if (signal?.aborted) reason = "ABORTED";
    } catch (error) {
      failed = true;
      reason = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      this.store.stopRun(started.observeRunId, this.now().toISOString(), reason, failed);
    }
    const metrics = this.store.runMetrics(started.observeRunId);
    if (this.checkpointHashMismatch) {
      metrics.stateDriftDetected = true;
      metrics.checkpointProjectionHashMismatch = true;
    }
    return metrics;
  }
}
