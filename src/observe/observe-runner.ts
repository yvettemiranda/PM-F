import {
  activityEventKey,
  resolveSourceEventMultiplicity,
  sourceEventKey,
  sourceEventOccurrences,
} from "../domain/idempotency.js";
import { activityAsTrade } from "../domain/activity-trade.js";
import { decimalToScaled, PRICE_SCALE_DIGITS, SHARE_SCALE_DIGITS } from "../domain/fixed.js";
import { RULESET } from "../domain/versioning.js";
import type { PublicTrade } from "../domain/models.js";
import { estimateTargetCapital } from "../services/capital-estimator.js";
import { projectObserveEvents } from "./position-projector.js";
import { reconcileProjection } from "./reconciliation.js";
import { ObserveStore, type StartedObserveRun } from "./observe-store.js";
import type {
  ObserveDataSource,
  ObserveEvent,
  ObserveRunMetrics,
  SourceEventMultiplicityAmbiguity,
  UnsupportedTargetActivity,
} from "./types.js";
import { buildSignalExecutionContext, type SignalContextBundle, type SignalMarketMetadataProvider } from "../signal-context/execution-context.js";
import type { SourceVersion } from "../infra/source-version.js";
import { observeSchedulingGapThresholdMs } from "./scheduling.js";
import { marketClockOffsetIsValid } from "../execution/market-data.js";
import {
  verifyNegativeRiskConversion,
  type NegativeRiskConversionReceiptProvider,
} from "./negative-risk-conversion.js";
import { verifiedBinaryMarketOutcomeAssets } from "../signal-context/market-outcome-set.js";
import { PolygonOrderFilledFeedUnsafeError } from "./polygon-order-filled-trade-feed.js";
import type { ObserveWakeResult, ObserveWakeSource } from "./polygon-order-filled-wake-feed.js";

const ACTIVITY_CURSOR_OVERLAP_SECONDS = 5 * 60;

function crossSourceTradeLocator(trade: {
  transactionHash: string;
  asset: string;
  side: string;
  size: string | number;
  timestamp: number;
}): string {
  return [
    trade.transactionHash.toLowerCase(),
    trade.asset,
    trade.side,
    decimalToScaled(trade.size, SHARE_SCALE_DIGITS).toString(),
    String(trade.timestamp),
  ].join("\u001f");
}

function crossSourceTradeGroupLocator(trade: {
  transactionHash: string;
  conditionId: string;
  asset: string;
  side: string;
  timestamp: number;
}): string {
  return [
    trade.transactionHash.toLowerCase(),
    trade.conditionId.toLowerCase(),
    trade.asset,
    trade.side,
    String(trade.timestamp),
  ].join("\u001f");
}

function aggregatedTradeEconomics(trades: readonly PublicTrade[]): {
  sizeMicros: bigint;
  priceTenDigits: bigint;
} {
  let sizeMicros = 0n;
  let priceSizeNumerator = 0n;
  for (const trade of trades) {
    const size = decimalToScaled(trade.size, SHARE_SCALE_DIGITS);
    if (size <= 0n) throw new Error("CROSS_SOURCE_TRADE_SIZE_INVALID");
    sizeMicros += size;
    priceSizeNumerator += decimalToScaled(trade.price, PRICE_SCALE_DIGITS) * size;
  }
  if (sizeMicros <= 0n) throw new Error("CROSS_SOURCE_TRADE_SIZE_INVALID");
  const priceRoundingDivisor = 10n ** BigInt(PRICE_SCALE_DIGITS - 10);
  const denominator = sizeMicros * priceRoundingDivisor;
  return {
    sizeMicros,
    priceTenDigits: (priceSizeNumerator + denominator / 2n) / denominator,
  };
}

function sameAggregatedTradeEconomics(
  left: readonly PublicTrade[],
  right: readonly PublicTrade[],
): boolean {
  const leftEconomics = aggregatedTradeEconomics(left);
  const rightEconomics = aggregatedTradeEconomics(right);
  return leftEconomics.sizeMicros === rightEconomics.sizeMicros
    && leftEconomics.priceTenDigits === rightEconomics.priceTenDigits;
}

function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    if (signal?.aborted) finish();
    else signal?.addEventListener("abort", finish, { once: true });
  });
}

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
  wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  marketClockOffsetMs?: number;
  signalMarketMetadataProvider?: SignalMarketMetadataProvider;
  negativeRiskConversionReceiptProvider?: NegativeRiskConversionReceiptProvider;
  sourceVersion?: SourceVersion;
  wakeSource?: ObserveWakeSource;
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
  private readonly wait: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
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
    this.wait = options.wait ?? abortableDelay;
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
      const projection = projectObserveEvents(this.started.baseline, existing, {
        followSellFullExitThresholdPpm: RULESET.followSellFullExitThresholdPpm,
      });
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
      if (error instanceof PolygonOrderFilledFeedUnsafeError) {
        this.store.failPolygonTradeFeedUnsafe({
          observeRunId: started.observeRunId,
          baseline: started.baseline,
          errorDetail: error.message,
          detectedAt: failedAt,
        });
        this.lastPollCompletedAt = failedAt;
        throw error;
      }
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
    const polygonTradeOccurrences = sourceEventOccurrences(
      (snapshot.polygonOrderFilled?.trades ?? [])
        .filter((trade) => trade.timestamp > baselineSecond),
    );
    type CrossSourceIdentity = { sourceEventKey: string; trade: PublicTrade };
    const polygonIdentities = new Map<string, CrossSourceIdentity[]>();
    const polygonGroups = new Map<string, CrossSourceIdentity[]>();
    for (const event of [
      ...storedEvents.filter((item) => item.sourceType === "POLYGON_ORDER_FILLED" && item.trade),
      ...polygonTradeOccurrences.map((occurrence): ObserveEvent => ({
        sourceEventKey: occurrence.sourceEventKey,
        sourceType: "POLYGON_ORDER_FILLED",
        sourceTimestamp: occurrence.trade.timestamp,
        isGap: false,
        isCombo: false,
        activityConfirmed: false,
        trade: occurrence.trade,
      })),
    ]) {
      const trade = event.trade!;
      const locator = crossSourceTradeLocator(trade);
      const group = polygonIdentities.get(locator) ?? [];
      if (!group.some((item) => item.sourceEventKey === event.sourceEventKey)) {
        group.push({ sourceEventKey: event.sourceEventKey, trade });
      }
      polygonIdentities.set(locator, group);
      const groupLocator = crossSourceTradeGroupLocator(trade);
      const transactionGroup = polygonGroups.get(groupLocator) ?? [];
      if (!transactionGroup.some((item) => item.sourceEventKey === event.sourceEventKey)) {
        transactionGroup.push({ sourceEventKey: event.sourceEventKey, trade });
      }
      polygonGroups.set(groupLocator, transactionGroup);
    }
    const crossSourceAliases = new Map<string, string>();
    const failCrossSourceMismatch = (polygonIdentity: CrossSourceIdentity, apiIdentity: CrossSourceIdentity): never => {
      const detectedAt = this.now().toISOString();
      this.store.failCrossSourceTradeIdentityMismatch({
        observeRunId: started.observeRunId,
        baseline: started.baseline,
        polygonSourceEventKey: polygonIdentity.sourceEventKey,
        dataApiSourceEventKey: apiIdentity.sourceEventKey,
        transactionHash: apiIdentity.trade.transactionHash.toLowerCase(),
        asset: apiIdentity.trade.asset,
        detectedAt,
      });
      throw new Error(`POLYGON_DATA_API_TRADE_IDENTITY_MISMATCH:${apiIdentity.trade.transactionHash}`);
    };
    const reconcileApiSource = (apiOccurrences: readonly CrossSourceIdentity[]): void => {
      const apiGroups = new Map<string, CrossSourceIdentity[]>();
      for (const occurrence of apiOccurrences) {
        const locator = crossSourceTradeGroupLocator(occurrence.trade);
        const group = apiGroups.get(locator) ?? [];
        group.push(occurrence);
        apiGroups.set(locator, group);
      }
      for (const [locator, apiGroup] of apiGroups) {
        const polygonGroup = polygonGroups.get(locator);
        if (!polygonGroup || polygonGroup.length === 0) continue;

        const allExact = apiGroup.every((apiIdentity) => {
          const exact = polygonIdentities.get(crossSourceTradeLocator(apiIdentity.trade))
            ?.find((polygonIdentity) => polygonIdentity.sourceEventKey === apiIdentity.sourceEventKey);
          if (!exact) return false;
          crossSourceAliases.set(apiIdentity.sourceEventKey, exact.sourceEventKey);
          return true;
        });
        if (allExact) continue;

        // Polygon can prove that multiple public Data API rows are one economic
        // execution only when the transaction contains exactly one decoded
        // target order. Multiple order hashes deliberately remain separate.
        if (
          polygonGroup.length === 1
          && polygonGroup[0]!.trade.orderHash
          && sameAggregatedTradeEconomics(
            apiGroup.map((item) => item.trade),
            [polygonGroup[0]!.trade],
          )
        ) {
          for (const apiIdentity of apiGroup) {
            crossSourceAliases.set(apiIdentity.sourceEventKey, polygonGroup[0]!.sourceEventKey);
          }
          continue;
        }
        failCrossSourceMismatch(polygonGroup[0]!, apiGroup.find(
          (apiIdentity) => !crossSourceAliases.has(apiIdentity.sourceEventKey),
        ) ?? apiGroup[0]!);
      }
    };
    // Reconcile each public endpoint independently. Trades may expose component
    // fills while Activity exposes the already-aggregated economic execution.
    reconcileApiSource(multiplicity.trades);
    reconcileApiSource(multiplicity.activityTrades);

    const canonicalCrossSourceKey = (key: string): string => crossSourceAliases.get(key) ?? key;
    const confirmedPolygonKeys = new Set(
      multiplicity.activityTrades
        .map((item) => crossSourceAliases.get(item.sourceEventKey))
        .filter((key): key is string => key !== undefined),
    );
    const confirmedRepeatedKeys = new Set(multiplicity.confirmedRepeatedKeys);
    for (const occurrence of polygonTradeOccurrences) {
      if (occurrence.occurrenceIndex > 0) confirmedRepeatedKeys.add(occurrence.sourceEventKey);
    }
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
      ...polygonTradeOccurrences.map(({ trade, sourceEventKey }): ObserveEvent => ({
        sourceEventKey,
        sourceType: "POLYGON_ORDER_FILLED",
        sourceTimestamp: trade.timestamp,
        isGap: eventIsGap(trade.timestamp),
        isCombo: false,
        activityConfirmed: confirmedPolygonKeys.has(sourceEventKey),
        trade,
      })),
      ...multiplicity.trades
        .map(({ trade, sourceEventKey }): ObserveEvent => ({
          sourceEventKey: canonicalCrossSourceKey(sourceEventKey),
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
            sourceEventKey: canonicalCrossSourceKey(sourceEventKey),
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
    const signalEnrichmentFailures: Parameters<ObserveStore["commitSuccessfulPoll"]>[0]["signalEnrichmentFailures"] = [];
    const sourceWarnings = snapshot.polygonOrderFilled?.status === "DEGRADED"
      ? [`POLYGON_ORDER_FILLED_DEGRADED:${snapshot.polygonOrderFilled.errorDetail}`]
      : [];
    const marketCache = new Map<string, Promise<Awaited<ReturnType<SignalMarketMetadataProvider["market"]>>>>();
    const mergeOutcomeAssetsByCondition = new Map<string, readonly string[]>();
    const pendingMergeConditions = new Set<string>();
    const mergeEventsByCondition = new Map<string, ObserveEvent[]>();
    for (const event of allEvents) {
      const conditionId = event.activity?.type === "MERGE"
        ? event.activity.conditionId?.toLowerCase()
        : undefined;
      if (!conditionId) continue;
      const grouped = mergeEventsByCondition.get(conditionId) ?? [];
      grouped.push(event);
      mergeEventsByCondition.set(conditionId, grouped);
    }
    for (const [conditionId, mergeEvents] of mergeEventsByCondition) {
      if (!this.options.signalMarketMetadataProvider) continue;
      try {
        const marketPromise = this.options.signalMarketMetadataProvider.market(conditionId, signal);
        marketCache.set(conditionId, marketPromise);
        const market = await marketPromise;
        mergeOutcomeAssetsByCondition.set(
          conditionId,
          verifiedBinaryMarketOutcomeAssets(market.market, conditionId),
        );
      } catch (error) {
        const errorDetail = error instanceof Error ? error.message : String(error);
        if (!errorDetail.startsWith("MARKET_OUTCOME_SET_")) pendingMergeConditions.add(conditionId);
        for (const event of mergeEvents) {
          signalEnrichmentFailures.push({
            signalId: `MERGE_MARKET_OUTCOME_SET:${event.sourceEventKey}`,
            sourceEventKey: event.sourceEventKey,
            conditionId,
            errorDetail,
          });
        }
      }
    }
    const conversionEvidence: Parameters<ObserveStore["commitSuccessfulPoll"]>[0]["conversionEvidence"] = [];
    let projection: ReturnType<typeof projectObserveEvents>;
    try {
      for (const event of allEvents) {
        if (event.activity?.type !== "CONVERSION" || event.conversion) continue;
        const provider = this.options.negativeRiskConversionReceiptProvider;
        if (!provider) throw new Error("NEGATIVE_RISK_CONVERSION_RECEIPT_PROVIDER_UNAVAILABLE");
        const receipt = await provider.transactionReceipt(event.activity.transactionHash, signal);
        const conversion = verifyNegativeRiskConversion({
          activity: event.activity,
          walletAddress: this.options.walletAddress,
          positions: snapshot.positions.data,
          receipt,
        });
        event.conversion = conversion;
        conversionEvidence.push({ sourceEventKey: event.sourceEventKey, conversion, receipt });
      }
      projection = projectObserveEvents(
        started.baseline,
        allEvents,
        {
          requireVerifiedConversions: true,
          mergeOutcomeAssetsByCondition,
          pendingMergeConditions,
          followSellFullExitThresholdPpm: RULESET.followSellFullExitThresholdPpm,
        },
      );
    } catch (error) {
      this.store.recordFailedPoll(started.observeRunId, sequence, pollStartedAt, completedAt, error, "PROCESSING_FAILED");
      this.lastPollCompletedAt = completedAt;
      return false;
    }
    const existingSignalIds = this.store.existingSignalIds(
      started.baseline.baselineRunId,
      projection.signals.map((candidate) => candidate.signalId),
    );
    const signalCandidates = projection.signals.filter((candidate) => !existingSignalIds.has(candidate.signalId));
    const currentTradeKeys = new Set([
      ...multiplicity.trades.map((item) => canonicalCrossSourceKey(item.sourceEventKey)),
      ...polygonTradeOccurrences.map((item) => item.sourceEventKey),
    ]);
    const currentActivityKeys = new Set(
      multiplicity.activityTrades.map((item) => canonicalCrossSourceKey(item.sourceEventKey)),
    );
    const ambiguousKeys = new Set(
      multiplicity.ambiguousRepeatedKeys.filter(
        (key) => !confirmedRepeatedKeys.has(key) && !crossSourceAliases.has(key),
      ),
    );
    for (const event of allEvents) {
      if (
        event.trade
        && event.sourceEventKey !== sourceEventKey(event.trade)
        && !event.activityConfirmed
        && event.sourceType !== "POLYGON_ORDER_FILLED"
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
    const unsupportedActivities: UnsupportedTargetActivity[] = projection.unsupportedActivities;
    const previousReport = this.store.latestReconciliationReport(started.observeRunId);
    const reconciliation = reconcileProjection(
      projection.projection,
      snapshot.positions.data,
      completedAt,
      previousReport,
      sourceEventAmbiguities,
      unsupportedActivities,
    );
    const expectedPositions = new Map(
      projection.projection.map((entry) => [entry.asset, BigInt(entry.expectedTotalMicros)]),
    );
    const observedPositions = new Map(
      snapshot.positions.data.map((position) => [
        position.asset,
        decimalToScaled(position.size, SHARE_SCALE_DIGITS),
      ]),
    );
    const conversionAssets = new Set(
      conversionEvidence.flatMap(({ conversion }) => [
        conversion.sourceAsset,
        ...conversion.destinationAssets.map((destination) => destination.asset),
      ]),
    );
    const exactMismatchAsset = [...conversionAssets].find((asset) => (
      (expectedPositions.get(asset) ?? 0n) !== (observedPositions.get(asset) ?? 0n)
    ));
    // A receipt proves the on-chain conversion, but it is not sufficient on
    // its own: the same poll's public Positions snapshot must also reconcile
    // with the complete ordered projection before evidence becomes immutable.
    // Retrying the poll is safer than certifying a conversion during even a
    // transient quantity disagreement.
    if (conversionEvidence.length > 0 && exactMismatchAsset) {
      this.store.recordFailedPoll(
        started.observeRunId,
        sequence,
        pollStartedAt,
        completedAt,
        new Error(`NEGATIVE_RISK_CONVERSION_POSITION_QUANTITY_MISMATCH:${exactMismatchAsset}`),
        "PROCESSING_FAILED",
      );
      this.lastPollCompletedAt = completedAt;
      return false;
    }
    if (conversionEvidence.length > 0 && reconciliation.syncStatus !== "SYNCED") {
      this.store.recordFailedPoll(
        started.observeRunId,
        sequence,
        pollStartedAt,
        completedAt,
        new Error(`NEGATIVE_RISK_CONVERSION_POSITIONS_UNVERIFIED:${reconciliation.syncStatus}`),
        "PROCESSING_FAILED",
      );
      this.lastPollCompletedAt = completedAt;
      return false;
    }
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
    const signalsToEmit: typeof signalCandidates = [];
    if (this.options.signalMarketMetadataProvider) {
      const eventByKey = new Map(
        [...storedEvents, ...newEvents].map((event) => [event.sourceEventKey, event]),
      );
      for (const candidateSignal of signalCandidates) {
        if (!candidateSignal.executionEligible) {
          signalsToEmit.push(candidateSignal);
          continue;
        }
        try {
          const event = eventByKey.get(candidateSignal.sourceEventKey);
          if (!event) throw new Error(`Signal event missing: ${candidateSignal.signalId}`);
          let marketPromise = marketCache.get(candidateSignal.conditionId);
          if (!marketPromise) {
            marketPromise = this.options.signalMarketMetadataProvider.market(candidateSignal.conditionId, signal);
            marketCache.set(candidateSignal.conditionId, marketPromise);
          }
          const market = await marketPromise;
          if (candidateSignal.signalType === "TARGET_BUY" && !event.trade) {
            throw new Error(`Signal source trade missing: ${candidateSignal.signalId}`);
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
            targetTrade: event.trade!,
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
          signalsToEmit.push(candidateSignal);
        } catch (error) {
          signalEnrichmentFailures.push({
            signalId: candidateSignal.signalId,
            sourceEventKey: candidateSignal.sourceEventKey,
            conditionId: candidateSignal.conditionId,
            errorDetail: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } else {
      signalsToEmit.push(...signalCandidates);
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
      conversionEvidence,
      duplicateEvents,
      projection,
      signalsToEmit,
      capitalEstimate,
      signalContexts,
      signalEnrichmentFailures,
      sourceWarnings,
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
    let nextCadenceAt = runStartedMs;
    let failed = false;
    let reason = "DURATION_COMPLETE";
    try {
      while (!signal?.aborted && this.monotonicNow() < deadline) {
        await this.pollOnce(signal);
        const completedAt = this.monotonicNow();
        if (completedAt >= nextCadenceAt) {
          nextCadenceAt = Math.max(nextCadenceAt + this.options.pollIntervalMs, completedAt);
        }
        const remaining = deadline - completedAt;
        if (remaining <= 0) break;
        await this.waitForNextPoll(
          Math.min(Math.max(0, nextCadenceAt - completedAt), remaining),
          signal,
        );
      }
      if (signal?.aborted) reason = "ABORTED";
    } catch (error) {
      failed = true;
      reason = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      try {
        this.options.wakeSource?.close();
      } catch {
        // A public wake hint must never mask Observe shutdown evidence.
      }
      this.store.stopRun(started.observeRunId, this.now().toISOString(), reason, failed);
    }
    const metrics = this.store.runMetrics(started.observeRunId);
    if (this.checkpointHashMismatch) {
      metrics.stateDriftDetected = true;
      metrics.checkpointProjectionHashMismatch = true;
    }
    return metrics;
  }

  private async waitForNextPoll(
    milliseconds: number,
    signal?: AbortSignal,
  ): Promise<ObserveWakeResult> {
    if (milliseconds <= 0 || signal?.aborted) return "TIMEOUT";
    if (!this.options.wakeSource) {
      await this.wait(milliseconds, signal);
      return "TIMEOUT";
    }
    const startedAt = this.monotonicNow();
    try {
      return await this.options.wakeSource.waitForWake(
        this.options.walletAddress,
        milliseconds,
        signal,
      );
    } catch {
      const elapsed = Math.max(0, this.monotonicNow() - startedAt);
      const fallbackMs = Math.max(0, milliseconds - elapsed);
      if (fallbackMs > 0 && !signal?.aborted) await this.wait(fallbackMs, signal);
      return "TIMEOUT";
    }
  }
}
