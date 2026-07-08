import { PolymarketPublicApi } from "../adapters/polymarket-public.js";
import type { ApiCapture } from "../adapters/polymarket-public.js";
import type { ObserveDataSource, ObservePollSnapshot } from "./types.js";

function mergeCaptures<T>(endpoint: string, captures: ApiCapture<T[]>[], rows: T[]): ApiCapture<T[]> {
  const last = captures.at(-1);
  if (!last) throw new Error(`Recovery returned no capture for ${endpoint}`);
  return {
    url: `${last.url}&observeRecovery=merged`,
    fetchedAt: last.fetchedAt,
    latencyMs: captures.reduce((total, capture) => total + capture.latencyMs, 0),
    status: last.status,
    data: rows,
  };
}

export class PublicObserveDataSource implements ObserveDataSource {
  constructor(private readonly api = new PolymarketPublicApi()) {}

  async poll(walletAddress: string, recoveryFromTimestamp?: number): Promise<ObservePollSnapshot> {
    if (recoveryFromTimestamp !== undefined) {
      const [tradeHistory, activityHistory, positions, pUsdBalance] = await Promise.all([
        this.api.trades(walletAddress),
        this.api.activity(walletAddress),
        this.api.positions(walletAddress),
        this.api.pUsdBalance(walletAddress),
      ]);
      return {
        trades: mergeCaptures("trades", tradeHistory.captures, tradeHistory.rows),
        activity: mergeCaptures("activity", activityHistory.captures, activityHistory.rows),
        positions,
        pUsdBalance,
      };
    }
    const [trades, activity, positions, pUsdBalance] = await Promise.all([
      this.api.recentTrades(walletAddress),
      this.api.recentActivity(walletAddress),
      this.api.positions(walletAddress),
      this.api.pUsdBalance(walletAddress),
    ]);
    return { trades, activity, positions, pUsdBalance };
  }
}
