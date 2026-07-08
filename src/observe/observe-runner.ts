import { activityEventKey, sourceEventKey } from "../domain/idempotency.js";
import type { PublicActivity, PublicTrade } from "../domain/models.js";
import { estimateTargetCapital } from "../services/capital-estimator.js";
import { projectObserveEvents } from "./position-projector.js";
import { reconcileProjection } from "./reconciliation.js";
import { ObserveStore, type StartedObserveRun } from "./observe-store.js";
import type { ObserveDataSource, ObserveEvent, ObserveRunMetrics } from "./types.js";

export interface ObserveRunnerOptions {
  walletAddress: string;
  pollIntervalMs: number;
  durationMs?: number;
  staleRunAfterMs?: number;
  now?: () => Date;
  wait?: (milliseconds: number) => Promise<void>;
}

function activityAsTrade(activity: PublicActivity): PublicTrade | null {
  if (
    activity.type !== "TRADE"
    || !activity.conditionId
    || !activity.asset
    || (activity.side !== "BUY" && activity.side !== "SELL")
    || activity.price === undefined
    || activity.size === undefined
  ) return null;
  return {
    proxyWallet: activity.proxyWallet,
    transactionHash: activity.transactionHash,
    conditionId: activity.conditionId,
    asset: activity.asset,
    side: activity.side,
    price: activity.price,
    size: activity.size,
    timestamp: activity.timestamp,
    ...(activity.outcome !== undefined ? { outcome: activity.outcome } : {}),
    ...(activity.title !== undefined ? { title: activity.title } : {}),
  };
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

  constructor(
    private readonly store: ObserveStore,
    private readonly source: ObserveDataSource,
    private readonly options: ObserveRunnerOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.wait = options.wait ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  start(): StartedObserveRun {
    if (this.started) return this.started;
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
    }
    this.gapActive = true;
    return this.started;
  }

  async pollOnce(): Promise<boolean> {
    const started = this.start();
    const sequence = this.store.nextPollSequence(started.observeRunId);
    const pollStartedAt = this.now().toISOString();
    let snapshot;
    try {
      snapshot = await this.source.poll(
        this.options.walletAddress,
        this.gapActive ? Math.floor(Date.parse(started.gapFrom) / 1_000) : undefined,
      );
    } catch (error) {
      const failedAt = this.now().toISOString();
      this.store.recordFailedPoll(started.observeRunId, sequence, pollStartedAt, failedAt, error);
      this.gapActive = true;
      return false;
    }

    try {
      if (this.gapActive) assertRecoveryCoverage(snapshot, started.gapFrom);
    } catch (error) {
      const failedAt = this.now().toISOString();
      this.store.recordFailedPoll(started.observeRunId, sequence, pollStartedAt, failedAt, error, "PROCESSING_FAILED");
      this.gapActive = true;
      return false;
    }

    const completedAt = this.now().toISOString();
    const baselineSecond = Math.floor(Date.parse(started.baseline.snapshotTime) / 1_000);
    const incoming: ObserveEvent[] = [
      ...snapshot.trades.data
        .filter((trade) => trade.timestamp > baselineSecond)
        .map((trade): ObserveEvent => ({
          sourceEventKey: sourceEventKey(trade),
          sourceType: "DATA_API_TRADE",
          sourceTimestamp: trade.timestamp,
          isGap: this.gapActive,
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
            trade: normalizedTrade,
          } : {
            sourceEventKey: activityEventKey(activity),
            sourceType: "DATA_API_ACTIVITY",
            sourceTimestamp: activity.timestamp,
            isGap: this.gapActive,
            activity,
          };
        }),
    ];
    const unique = new Map<string, ObserveEvent>();
    let duplicateEvents = 0;
    for (const event of incoming) {
      if (unique.has(event.sourceEventKey)) duplicateEvents += 1;
      else unique.set(event.sourceEventKey, event);
    }
    const existingKeys = this.store.existingEventKeys(started.baseline.baselineRunId, [...unique.keys()]);
    duplicateEvents += existingKeys.size;
    const newEvents = [...unique.values()].filter((event) => !existingKeys.has(event.sourceEventKey));
    const storedEvents = this.store.loadObservedEvents(started.baseline.baselineRunId);
    const projection = projectObserveEvents(started.baseline, [...storedEvents, ...newEvents]);
    const newKeys = new Set(newEvents.map((event) => event.sourceEventKey));
    const signalsToEmit = projection.signals.filter((signal) => newKeys.has(signal.sourceEventKey));
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
    this.store.commitSuccessfulPoll({
      observeRunId: started.observeRunId,
      baseline: started.baseline,
      sequence,
      startedAt: pollStartedAt,
      completedAt,
      snapshot,
      newEvents,
      duplicateEvents,
      projection,
      signalsToEmit,
      capitalEstimate,
      reconciliation,
      replayState: this.gapActive ? "GAP_RECOVERED" : "ONLINE",
      gapRecovered: this.gapActive,
    });
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
    if (this.checkpointHashMismatch) metrics.stateDriftDetected = true;
    return metrics;
  }
}
