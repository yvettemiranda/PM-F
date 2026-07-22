import { createHash } from "node:crypto";
import { PolymarketPublicApi } from "../adapters/polymarket-public.js";
import type { ApiCapture } from "../adapters/polymarket-public.js";
import { stableJson } from "../domain/canonical-json.js";
import type { ObserveDataSource, ObservePollSnapshot } from "./types.js";

const INCREMENTAL_TRADE_HEAD_LIMIT = 100;
const DEFAULT_RECONCILIATION_INTERVAL_MS = 15_000;

export interface PublicObserveDataSourceOptions {
  reconciliationIntervalMs?: number;
  now?: () => Date;
}

interface CachedReconciliationState {
  positions: ObservePollSnapshot["positions"];
  pUsdBalance: ObservePollSnapshot["pUsdBalance"];
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
  private readonly eventHeadHashes = new Map<string, string>();
  private readonly reconciliationIntervalMs: number;
  private readonly now: () => Date;

  constructor(
    private readonly api = new PolymarketPublicApi(),
    options: PublicObserveDataSourceOptions = {},
  ) {
    this.reconciliationIntervalMs = options.reconciliationIntervalMs
      ?? DEFAULT_RECONCILIATION_INTERVAL_MS;
    this.now = options.now ?? (() => new Date());
    if (!Number.isSafeInteger(this.reconciliationIntervalMs) || this.reconciliationIntervalMs <= 0) {
      throw new Error("OBSERVE_RECONCILIATION_INTERVAL_INVALID");
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

  async poll(
    walletAddress: string,
    recoveryFromTimestamp?: number,
    activityFromTimestamp?: number,
    signal?: AbortSignal,
  ): Promise<ObservePollSnapshot> {
    if (recoveryFromTimestamp !== undefined) {
      const [tradeHistory, activityHistory, state] = await Promise.all([
        this.api.tradesSince(walletAddress, recoveryFromTimestamp, signal),
        this.api.activitySince(
          walletAddress,
          activityFromTimestamp ?? recoveryFromTimestamp,
          signal,
        ),
        this.freshReconciliationState(walletAddress, signal),
      ]);
      if (!tradeHistory.historyComplete || !activityHistory.historyComplete) {
        throw new Error("OBSERVE_RECOVERY_PAGE_SATURATED");
      }
      this.tradeCoverageWatermarks.set(walletAddress, Math.max(
        recoveryFromTimestamp,
        ...tradeHistory.rows.map((row) => row.timestamp),
      ));
      return {
        trades: mergeCaptures("trades", tradeHistory.captures, tradeHistory.rows),
        activity: mergeCaptures("activity", activityHistory.captures, activityHistory.rows),
        positions: state.positions,
        pUsdBalance: state.pUsdBalance,
      };
    }
    const tradeWatermark = this.tradeCoverageWatermarks.get(walletAddress);
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
      // A full trade head is safe only when it overlaps the last committed
      // cursor. Activity uses a server-side start cursor and complete paging.
      throw new Error("OBSERVE_INCREMENTAL_PAGE_SATURATED");
    }
    this.tradeCoverageWatermarks.set(walletAddress, Math.max(
      tradeWatermark ?? 0,
      ...trades.data.map((row) => row.timestamp),
    ));
    const eventHeadHash = createHash("sha256").update(stableJson({
      trades: trades.data,
      activity: activity.data,
    })).digest("hex");
    const eventHeadChanged = this.eventHeadHashes.get(walletAddress) !== eventHeadHash;
    this.eventHeadHashes.set(walletAddress, eventHeadHash);
    const state = await this.currentReconciliationState(walletAddress, signal, eventHeadChanged);
    return { trades, activity, positions: state.positions, pUsdBalance: state.pUsdBalance };
  }
}
