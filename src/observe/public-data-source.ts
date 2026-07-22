import { createHash } from "node:crypto";
import { PolymarketPublicApi } from "../adapters/polymarket-public.js";
import type { ApiCapture } from "../adapters/polymarket-public.js";
import { stableJson } from "../domain/canonical-json.js";
import type { ObserveDataSource, ObservePollSnapshot } from "./types.js";
import {
  PolygonOrderFilledFeedUnsafeError,
  PolygonOrderFilledTradeFeed,
} from "./polygon-order-filled-trade-feed.js";

const INCREMENTAL_TRADE_HEAD_LIMIT = 100;
const DEFAULT_RECONCILIATION_INTERVAL_MS = 15_000;
const DEFAULT_EVENT_INTERVAL_MS = 3_000;

export interface PublicObserveDataSourceOptions {
  reconciliationIntervalMs?: number;
  eventIntervalMs?: number;
  polygonTradeFeed?: PolygonOrderFilledTradeFeed | null;
  now?: () => Date;
}

interface CachedReconciliationState {
  positions: ObservePollSnapshot["positions"];
  pUsdBalance: ObservePollSnapshot["pUsdBalance"];
  refreshedAtMs: number;
}

interface CachedEventState {
  trades: ObservePollSnapshot["trades"];
  activity: ObservePollSnapshot["activity"];
  refreshedAtMs: number;
}

function mergeCaptures<T>(endpoint: string, captures: ApiCapture<T[]>[], rows: T[]): ApiCapture<T[]> {
  const last = captures.at(-1);
  if (!last) throw new Error(`Recovery returned no capture for ${endpoint}`);
  return {
    url: `${last.url}&observePages=merged`,
    fetchedAt: last.fetchedAt,
    latencyMs: captures.reduce((total, capture) => total + capture.latencyMs, 0),
    status: last.status,
    data: rows,
  };
}

export class PublicObserveDataSource implements ObserveDataSource {
  private readonly tradeCoverageWatermarks = new Map<string, number>();
  private readonly reconciliationState = new Map<string, CachedReconciliationState>();
  private readonly eventState = new Map<string, CachedEventState>();
  private readonly eventHeadHashes = new Map<string, string>();
  private readonly reconciliationIntervalMs: number;
  private readonly eventIntervalMs: number;
  private readonly polygonTradeFeed: PolygonOrderFilledTradeFeed | null;
  private readonly now: () => Date;

  constructor(
    private readonly api = new PolymarketPublicApi(),
    options: PublicObserveDataSourceOptions = {},
  ) {
    this.reconciliationIntervalMs = options.reconciliationIntervalMs
      ?? DEFAULT_RECONCILIATION_INTERVAL_MS;
    this.eventIntervalMs = options.eventIntervalMs ?? DEFAULT_EVENT_INTERVAL_MS;
    this.polygonTradeFeed = options.polygonTradeFeed === undefined
      ? new PolygonOrderFilledTradeFeed(api)
      : options.polygonTradeFeed;
    this.now = options.now ?? (() => new Date());
    if (!Number.isSafeInteger(this.reconciliationIntervalMs) || this.reconciliationIntervalMs <= 0) {
      throw new Error("OBSERVE_RECONCILIATION_INTERVAL_INVALID");
    }
    if (!Number.isSafeInteger(this.eventIntervalMs) || this.eventIntervalMs <= 0) {
      throw new Error("OBSERVE_EVENT_INTERVAL_INVALID");
    }
  }

  private async polygonTrades(
    walletAddress: string,
    signal?: AbortSignal,
  ): Promise<ObservePollSnapshot["polygonOrderFilled"]> {
    if (!this.polygonTradeFeed) return undefined;
    try {
      return await this.polygonTradeFeed.poll(walletAddress, signal);
    } catch (error) {
      if (error instanceof PolygonOrderFilledFeedUnsafeError) throw error;
      return {
        status: "DEGRADED",
        confirmedHead: null,
        fromBlock: null,
        toBlock: null,
        trades: [],
        capture: null,
        errorDetail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async freshReconciliationState(
    walletAddress: string,
    signal?: AbortSignal,
  ): Promise<CachedReconciliationState> {
    const [positionHistory, pUsdBalance] = await Promise.all([
      this.api.allPositions(walletAddress, signal),
      this.api.pUsdBalance(walletAddress, signal),
    ]);
    const state = {
      positions: positionHistory.merged,
      pUsdBalance,
      refreshedAtMs: this.now().valueOf(),
    };
    this.reconciliationState.set(walletAddress, state);
    return state;
  }

  private async currentReconciliationState(
    walletAddress: string,
    signal?: AbortSignal,
    forceRefresh = false,
  ): Promise<CachedReconciliationState> {
    const cached = this.reconciliationState.get(walletAddress);
    const nowMs = this.now().valueOf();
    if (
      !forceRefresh
      && cached
      && nowMs >= cached.refreshedAtMs
      && nowMs - cached.refreshedAtMs < this.reconciliationIntervalMs
    ) return cached;
    return this.freshReconciliationState(walletAddress, signal);
  }

  private async incrementalTrades(
    walletAddress: string,
    tradeWatermark?: number,
    signal?: AbortSignal,
  ) {
    const head = await this.api.recentTrades(walletAddress, INCREMENTAL_TRADE_HEAD_LIMIT, signal);
    const oldest = head.data.length === 0 ? null : Math.min(...head.data.map((row) => row.timestamp));
    if (
      head.data.length < INCREMENTAL_TRADE_HEAD_LIMIT
      || (tradeWatermark !== undefined && oldest !== null && oldest < tradeWatermark)
    ) {
      return head;
    }
    return this.api.recentTrades(walletAddress, 1_000, signal);
  }

  private async freshEventState(
    walletAddress: string,
    tradeWatermark: number | undefined,
    activityFromTimestamp: number | undefined,
    signal?: AbortSignal,
  ): Promise<CachedEventState> {
    const [trades, activityHistory] = await Promise.all([
      this.incrementalTrades(walletAddress, tradeWatermark, signal),
      activityFromTimestamp === undefined
        ? this.api.activity(walletAddress, signal)
        : this.api.activitySince(walletAddress, activityFromTimestamp, signal),
    ]);
    const activity = mergeCaptures("activity", activityHistory.captures, activityHistory.rows);
    const oldestTrade = trades.data.length === 0 ? null : Math.min(...trades.data.map((row) => row.timestamp));
    if (
      (trades.data.length >= 1_000 && (
        tradeWatermark === undefined || oldestTrade === null || oldestTrade >= tradeWatermark
      ))
      || !activityHistory.historyComplete
    ) {
      throw new Error("OBSERVE_INCREMENTAL_PAGE_SATURATED");
    }
    this.tradeCoverageWatermarks.set(walletAddress, Math.max(
      tradeWatermark ?? 0,
      ...trades.data.map((row) => row.timestamp),
    ));
    const state = { trades, activity, refreshedAtMs: this.now().valueOf() };
    this.eventState.set(walletAddress, state);
    return state;
  }

  private async currentEventState(
    walletAddress: string,
    activityFromTimestamp: number | undefined,
    signal?: AbortSignal,
  ): Promise<CachedEventState> {
    const cached = this.eventState.get(walletAddress);
    const nowMs = this.now().valueOf();
    if (
      cached
      && nowMs >= cached.refreshedAtMs
      && nowMs - cached.refreshedAtMs < this.eventIntervalMs
    ) return cached;
    return this.freshEventState(
      walletAddress,
      this.tradeCoverageWatermarks.get(walletAddress),
      activityFromTimestamp,
      signal,
    );
  }

  async poll(
    walletAddress: string,
    recoveryFromTimestamp?: number,
    activityFromTimestamp?: number,
    signal?: AbortSignal,
  ): Promise<ObservePollSnapshot> {
    if (recoveryFromTimestamp !== undefined) {
      const [tradeHistory, activityHistory, state, polygonOrderFilled] = await Promise.all([
        this.api.tradesSince(walletAddress, recoveryFromTimestamp, signal),
        this.api.activitySince(
          walletAddress,
          activityFromTimestamp ?? recoveryFromTimestamp,
          signal,
        ),
        this.freshReconciliationState(walletAddress, signal),
        this.polygonTrades(walletAddress, signal),
      ]);
      if (!tradeHistory.historyComplete || !activityHistory.historyComplete) {
        throw new Error("OBSERVE_RECOVERY_PAGE_SATURATED");
      }
      this.tradeCoverageWatermarks.set(walletAddress, Math.max(
        recoveryFromTimestamp,
        ...tradeHistory.rows.map((row) => row.timestamp),
      ));
      const trades = mergeCaptures("trades", tradeHistory.captures, tradeHistory.rows);
      const activity = mergeCaptures("activity", activityHistory.captures, activityHistory.rows);
      this.eventState.set(walletAddress, {
        trades,
        activity,
        refreshedAtMs: this.now().valueOf(),
      });
      return {
        trades,
        activity,
        positions: state.positions,
        pUsdBalance: state.pUsdBalance,
        ...(polygonOrderFilled ? { polygonOrderFilled } : {}),
      };
    }
    const [events, polygonOrderFilled] = await Promise.all([
      this.currentEventState(walletAddress, activityFromTimestamp, signal),
      this.polygonTrades(walletAddress, signal),
    ]);
    const eventHeadHash = createHash("sha256").update(stableJson({
      trades: events.trades.data,
      activity: events.activity.data,
      polygonTrades: polygonOrderFilled?.trades ?? [],
    })).digest("hex");
    const eventHeadChanged = this.eventHeadHashes.get(walletAddress) !== eventHeadHash;
    this.eventHeadHashes.set(walletAddress, eventHeadHash);
    const state = await this.currentReconciliationState(walletAddress, signal, eventHeadChanged);
    return {
      trades: events.trades,
      activity: events.activity,
      positions: state.positions,
      pUsdBalance: state.pUsdBalance,
      ...(polygonOrderFilled ? { polygonOrderFilled } : {}),
    };
  }
}
