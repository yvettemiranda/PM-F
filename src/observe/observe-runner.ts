import {
  activityEventKey,
  resolveSourceEventMultiplicity,
  sourceEventKey,
} from "../domain/idempotency.js";
import { activityAsTrade } from "../domain/activity-trade.js";
import { estimateTargetCapital } from "../services/capital-estimator.js";
import { projectObserveEvents } from "./position-projector.js";
import { reconcileProjection } from "./reconciliation.js";
import { ObserveStore, type StartedObserveRun } from "./observe-store.js";
import type {
  ObserveDataSource,
  ObserveEvent,
  ObserveRunMetrics,
  SourceEventMultiplicityAmbiguity,
} from "./types.js";
import { buildSignalExecutionContext, type SignalContextBundle, type SignalMarketMetadataProvider } from "../signal-context/execution-context.js";
import type { SourceVersion } from "../infra/source-version.js";
import { observeSchedulingGapThresholdMs } from "./scheduling.js";
import { marketClockOffsetIsValid } from "../execution/market-data.js";

const ACTIVITY_CURSOR_OVERLAP_SECONDS = 5 * 60;

export interface ObserveRunnerOptions {
  walletAddress: string;
  baselineRunId?: string;
  campaignId?: string;
  campaignSessionId?: string;
  pollIntervalMs: number;
  durationMs?: number;
  staleRunAfterMs?: number;
  now?: () => Date;
  monotonicNow?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
  marketClockOffsetMs?: number;
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
  private readonly monotonicNow: () => number;
  private readonly wait: (milliseconds: number) => Promise<void>;
  private started: StartedObserveRun | null = null;
  private gapActive = true;
  private gapCutoffAt: string | null = null;
  private checkpointHashMismatch = false;
  private lastSuccessfulAt: string | null = null;
  private lastPollCompletedAt: string | null = null;
  private readonly marketClockOffsetMs: number;

  constructor(
    private readonly store: ObserveStore,
    private readonly source: ObserveDataSource,
    private readonly options: ObserveRunnerOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.monotonicNow = options.monotonicNow
      ?? (options.now ? () => this.now().valueOf() : () => performance.now());
    this.wait = options.wait ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.marketClockOffsetMs = options.marketClockOffsetMs ?? 0;
    if (!marketClockOffsetIsValid(this.marketClockOffsetMs)) {
      throw new Error("OBSERVE_MARKET_CLOCK_OFFSET_INVALID");
    }
  }

  private marketTime(value: Date | string): Date {
    const localMs = typeof value === "string" ? Date.parse(value) : value.valueOf();
    if (!Number.isFinite(localMs)) throw new Error("OBSERVE_LOCAL_TIME_INVALID");
    return new Date(localMs + this.marketClockOffsetMs);
  }

  private recoveryStartAt(started: StartedObserveRun): string {
    return this.lastSuccessfulAt ?? this.marketTime(started.gapFrom).toISOString();
  }

  start(): StartedObserveRun {
    if (this.started) {
      if (this.checkpointHashMismatch) throw new Error("CHECKPOINT_PROJECTION_HASH_MISMATCH");
      return this.started;
    }
    if (Boolean(this.options.campaignId) !== Boolean(this.options.campaignSessionId)) {
      throw new Error("OBSERVE_CAMPAIGN_SCOPE_INCOMPLETE");
    }
    const now = this.now().toISOString();
    this.started = this.store.startRun(
      this.options.walletAddress,
      this.options.pollIntervalMs,
      now,
      this.options.staleRunAfterMs ?? Math.max(this.options.pollIntervalMs * 3, 30_000),
      this.options.baselineRunId,
      this.options.campaignId && this.options.campaignSessionId
        ? { campaignId: this.options.campaignId, sessionId: this.options.campaignSessionId }
        : undefined,
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
    this.lastSuccessfulAt = this.marketTime(
      this.started.checkpoint?.createdAt ?? this.started.baseline.snapshotTime,
    ).toISOString();
    this.gapActive = true;
    // Only events that happened on or before startup belong to the offline
    // window. An event arriving after this runner started but before its first
    // successful poll is live data and must remain execution eligible.
    this.gapCutoffAt = this.marketTime(now).toISOString();
    return this.started;
  }

  async pollOnce(signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return false;
    const started = this.start();
    const storedEvents = this.store.loadObservedEvents(started.baseline.baselineRunId);
    const baselineSecond = Math.floor(this.marketTime(started.baseline.snapshotTime).valueOf() / 1_000);
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
        // A baseline with no later events still needs an incremental Activity
        // cursor. Falling back to the unbounded history endpoint repeatedly
        // hits its offset limit for high-frequency wallets.
        : Math.max(1, baselineSecond - 1);
    const sequence = this.store.nextPollSequence(started.observeRunId);
    const pollStartedAt = this.now().toISOString();
    if (
      this.lastPollCompletedAt
      && Date.parse(pollStartedAt) - Date.parse(this.lastPollCompletedAt)
        > observeSchedulingGapThresholdMs(this.options.pollIntervalMs)
    ) {
      this.gapActive = true;
      this.gapCutoffAt = this.marketTime(pollStartedAt).toISOString();
    }
    let recoveryFrom = this.gapActive ? this.recoveryStartAt(started) : null;
    let snapshot;
    try {
      snapshot = await this.source.poll(
        this.options.walletAddress,
        recoveryFrom ? Math.floor(Date.parse(recoveryFrom) / 1_000) : undefined,
        activityFromTimestamp,
        signal,
      );
    } catch (error) {
      if (signal?.aborted) return false;
      const failedAt = this.now().toISOString();
      this.store.recordFailedPoll(started.observeRunId, sequence, pollStartedAt, failedAt, error);
      this.lastPollCompletedAt = failedAt;
      this.gapActive = true;
      this.gapCutoffAt = this.marketTime(failedAt).toISOString();
      return false;
    }

    let completedAt = this.now().toISOString();
    if (
      Date.parse(completedAt) - Date.parse(pollStartedAt)
        > observeSchedulingGapThresholdMs(this.options.pollIntervalMs)
    ) {
      this.gapActive = true;
      this.gapCutoffAt = this.marketTime(completedAt).toISOString();
      recoveryFrom = this.recoveryStartAt(started);
      try {
        snapshot = await this.source.poll(
          this.options.walletAddress,
          Math.floor(Date.parse(recoveryFrom) / 1_000),
          activityFromTimestamp,
          signal,
        );
        completedAt = this.now().toISOString();
      } catch (error) {
        if (signal?.aborted) return false;
        const failedAt = this.now().toISOString();
        this.store.recordFailedPoll(started.observeRunId, sequence, pollStartedAt, failedAt, error);
        this.lastPollCompletedAt = failedAt;
        this.gapActive = true;
        this.gapCutoffAt = this.marketTime(failedAt).toISOString();
        return false;
      }
    }
    try {
      if (recoveryFrom) assertRecoveryCoverage(snapshot, recoveryFrom);
    } catch (error) {
      const failedAt = this.now().toISOString();
      this.store.recordFailedPoll(started.observeRunId, sequence, pollStartedAt, failedAt, error, "PROCESSING_FAILED");
      this.lastPollCompletedAt = failedAt;
      this.gapActive = true;
      this.gapCutoffAt = this.marketTime(failedAt).toISOString();
      return false;
    }

    const tradeRows = snapshot.trades.data.filter((trade) => trade.timestamp > baselineSecond);
    const activityRows = snapshot.activity.data.filter((activity) => activity.timestamp > baselineSecond);
    const activityTrades = activityRows.flatMap((activity) => {
      const trade = activityAsTrade(activity);
      return trade ? [{ activity, trade }] : [];
    });
    const multiplicity = resolveSourceEventMultiplicity(
      tradeRows,
      activityTrades.map((item) => item.trade),
    );
    const confirmedRepeatedKeys = new Set(multiplicity.confirmedRepeatedKeys);
    const storedTradeKeys = new Set(
      storedEvents.filter((event) => event.trade !== undefined).map((event) => event.sourceEventKey),
    );
    // Trades and Activity need not expose the same occurrence in the same
    // response. A persisted Trade occurrence is durable evidence, so a later
    // Activity occurrence with the same deterministic rank may confirm it.
    for (const item of multiplicity.activityTrades) {
      if (item.occurrenceIndex > 0 && storedTradeKeys.has(item.sourceEventKey)) {
        confirmedRepeatedKeys.add(item.sourceEventKey);
      }
    }
    let ambiguousActivityOccurrences = 0;
    const eventIsGap = (sourceTimestamp: number): boolean => this.gapActive
      && (this.gapCutoffAt === null
        || sourceTimestamp <= Math.floor(Date.parse(this.gapCutoffAt) / 1_000));
    const incoming: ObserveEvent[] = [
      ...multiplicity.trades
        .map(({ trade, sourceEventKey }): ObserveEvent => ({
          sourceEventKey,
          sourceType: "DATA_API_TRADE",
          sourceTimestamp: trade.timestamp,
          isGap: eventIsGap(trade.timestamp),
          isCombo: false,
          activityConfirmed: false,
          trade,
        })),
      ...multiplicity.activityTrades
        .flatMap(({ trade, sourceEventKey, occurrenceIndex }, index): ObserveEvent[] => {
          const activity = activityTrades[index]!.activity;
          // A single Activity trade remains a valid source on its own. A later
          // byte-identical occurrence has no public row id and is admitted only
          // when Trades independently exposes the same multiset occurrence.
          if (occurrenceIndex > 0 && !confirmedRepeatedKeys.has(sourceEventKey)) {
            ambiguousActivityOccurrences += 1;
            return [];
          }
          return [{
            sourceEventKey,
            sourceType: "DATA_API_TRADE",
            sourceTimestamp: trade.timestamp,
            isGap: eventIsGap(trade.timestamp),
            isCombo: activity.isCombo === true,
            activityConfirmed: true,
            trade,
          }];
        }),
      ...activityRows
        .filter((activity) => activityAsTrade(activity) === null)
        .map((activity): ObserveEvent => ({
            sourceEventKey: activityEventKey(activity),
            sourceType: "DATA_API_ACTIVITY",
            sourceTimestamp: activity.timestamp,
            isGap: eventIsGap(activity.timestamp),
            isCombo: ["SPLIT", "MERGE", "CONVERSION"].includes(activity.type),
            activityConfirmed: true,
            activity,
          })),
    ];
    const unique = new Map<string, ObserveEvent>();
    let duplicateEvents = ambiguousActivityOccurrences;
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
      .map((event) => ({
        sourceEventKey: event.sourceEventKey,
        isCombo: event.isCombo,
        isGap: (storedByKey.get(event.sourceEventKey)?.isGap ?? false) || event.isGap,
      }));
    for (const confirmation of eventConfirmations) {
      const stored = storedByKey.get(confirmation.sourceEventKey);
      if (!stored) throw new Error(`Observed event missing during confirmation: ${confirmation.sourceEventKey}`);
      stored.activityConfirmed = true;
      stored.isCombo = stored.isCombo || confirmation.isCombo;
      stored.isGap = stored.isGap || confirmation.isGap;
    }
    const allEvents = [...storedEvents, ...newEvents];
    const projection = projectObserveEvents(started.baseline, allEvents);
    const signalCandidateKeys = new Set([
      ...newEvents.filter((event) => event.activityConfirmed).map((event) => event.sourceEventKey),
      ...eventConfirmations.map((event) => event.sourceEventKey),
    ]);
    const signalsToEmit = projection.signals.filter((signal) => signalCandidateKeys.has(signal.sourceEventKey));
    const currentTradeKeys = new Set(multiplicity.trades.map((item) => item.sourceEventKey));
    const currentActivityKeys = new Set(multiplicity.activityTrades.map((item) => item.sourceEventKey));
    const ambiguousKeys = new Set(
      multiplicity.ambiguousRepeatedKeys.filter((key) => !confirmedRepeatedKeys.has(key)),
    );
    for (const event of allEvents) {
      if (
        event.trade
        && event.sourceEventKey !== sourceEventKey(event.trade)
        && !event.activityConfirmed
      ) {
        ambiguousKeys.add(event.sourceEventKey);
      }
    }
    const sourceEventAmbiguities: SourceEventMultiplicityAmbiguity[] = [...ambiguousKeys]
      .sort()
      .map((key) => ({
        sourceEventKey: key,
        tradesCount: currentTradeKeys.has(key) || storedTradeKeys.has(key) ? 1 : 0,
        activityCount: currentActivityKeys.has(key) ? 1 : 0,
      }));
    const previousReport = this.store.latestReconciliationReport(started.observeRunId);
    const reconciliation = reconcileProjection(
      projection.projection,
      snapshot.positions.data,
      completedAt,
      previousReport,
      sourceEventAmbiguities,
    );
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
      for (const candidateSignal of signalsToEmit.filter((item) => item.executionEligible)) {
        const event = eventByKey.get(candidateSignal.sourceEventKey);
        if (!event?.trade) throw new Error(`Signal event missing: ${candidateSignal.signalId}`);
        let market = marketCache.get(candidateSignal.conditionId);
        if (!market) {
          market = await this.options.signalMarketMetadataProvider.market(candidateSignal.conditionId, signal);
          marketCache.set(candidateSignal.conditionId, market);
        }
        const capitalDecision = candidateSignal.signalType === "TARGET_BUY" ? estimateTargetCapital({
          walletAddress: this.options.walletAddress,
          sourceEventKey: candidateSignal.sourceEventKey,
          identityStatus: "IDENTITY_CONFIRMED",
          syncStatus: reconciliation.syncStatus,
          positions: snapshot.positions.data,
          positionSnapshotTime: snapshot.positions.fetchedAt,
          walletBalanceMicros,
          walletBalanceSnapshotTime: snapshot.pUsdBalance.fetchedAt,
          targetTrade: event.trade,
        }) : null;
        signalContexts.push({
          signal: candidateSignal,
          capitalDecision,
          context: buildSignalExecutionContext({
            signal: candidateSignal,
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
      this.gapCutoffAt = this.marketTime(completedAt).toISOString();
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
    this.lastSuccessfulAt = this.marketTime(completedAt).toISOString();
    this.lastPollCompletedAt = completedAt;
    this.gapActive = false;
    this.gapCutoffAt = null;
    return true;
  }

  async run(signal?: AbortSignal): Promise<ObserveRunMetrics> {
    const started = this.start();
    const runStartedMs = this.monotonicNow();
    const deadline = this.options.durationMs && this.options.durationMs > 0
      ? runStartedMs + this.options.durationMs
      : Number.POSITIVE_INFINITY;
    let scheduledPollAt = runStartedMs;
    let failed = false;
    let reason = "DURATION_COMPLETE";
    try {
      while (!signal?.aborted && this.monotonicNow() < deadline) {
        await this.pollOnce(signal);
        const completedAt = this.monotonicNow();
        const nextPollAt = Math.max(scheduledPollAt + this.options.pollIntervalMs, completedAt);
        const remaining = deadline - completedAt;
        if (remaining <= 0) break;
        await this.waitForNextPoll(
          Math.min(Math.max(0, nextPollAt - completedAt), remaining),
          signal,
        );
        scheduledPollAt = nextPollAt;
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

  private async waitForNextPoll(milliseconds: number, signal?: AbortSignal): Promise<void> {
    if (milliseconds <= 0 || signal?.aborted) return;
    if (!signal) {
      await this.wait(milliseconds);
      return;
    }
    await Promise.race([
      this.wait(milliseconds),
      new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true })),
    ]);
  }
}
