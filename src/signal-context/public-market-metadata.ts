import { PolymarketPublicApi } from "../adapters/polymarket-public.js";
import type { SignalMarketMetadataProvider } from "./execution-context.js";

export class PublicSignalMarketMetadataProvider implements SignalMarketMetadataProvider {
  constructor(private readonly api = new PolymarketPublicApi()) {}

  async market(conditionId: string, signal?: AbortSignal) {
    const capture = await this.api.clobMarket(conditionId, signal);
    return { sourceUrl: capture.url, fetchedAt: capture.fetchedAt, market: capture.data };
  }
}
