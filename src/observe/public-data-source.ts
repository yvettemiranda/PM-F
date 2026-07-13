import { PolymarketPublicApi } from "../adapters/polymarket-public.js";
import type { ApiCapture } from "../adapters/polymarket-public.js";
import type { ObserveDataSource, ObservePollSnapshot } from "./types.js";

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

  constructor(private readonly api = new PolymarketPublicApi()) {}

  async poll(
    walletAddress: string,
    recoveryFromTimestamp?: number,
    activityFromTimestamp?: number,
  ): Promise<ObservePollSnapshot> {
    if (recoveryFromTimestamp !== undefined) {
      const [tradeHistory, activityHistory, positionHistory, pUsdBalance] = await Promise.all([
        this.api.trades(walletAddress),
        this.api.activity(walletAddress),
        this.api.allPositions(walletAddress),
        this.api.pUsdBalance(walletAddress),
      ]);
      this.tradeCoverageWatermarks.set(walletAddress, Math.max(
        recoveryFromTimestamp,
        ...tradeHistory.rows.map((row) => row.timestamp),
      ));
      return {
        trades: mergeCaptures("trades", tradeHistory.captures, tradeHistory.rows),
        activity: mergeCaptures("activity", activityHistory.captures, activityHistory.rows),
        positions: positionHistory.merged,
        pUsdBalance,
      };
    }
    const tradeWatermark = this.tradeCoverageWatermarks.get(walletAddress);
    const [trades, activityHistory, positionHistory, pUsdBalance] = await Promise.all([
      this.api.recentTrades(walletAddress),
      activityFromTimestamp === undefined
        ? this.api.activity(walletAddress)
        : this.api.activitySince(walletAddress, activityFromTimestamp),
      this.api.allPositions(walletAddress),
      this.api.pUsdBalance(walletAddress),
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
    return { trades, activity, positions: positionHistory.merged, pUsdBalance };
  }
}
