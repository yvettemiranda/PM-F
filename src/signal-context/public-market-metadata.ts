import { PolymarketPublicApi } from "../adapters/polymarket-public.js";
import type { SignalMarketMetadataProvider } from "./execution-context.js";

export class PublicSignalMarketMetadataProvider implements SignalMarketMetadataProvider {
  constructor(private readonly api = new PolymarketPublicApi()) {}

  async market(conditionId: string) {
    const capture = await this.api.clobMarket(conditionId);
    return { sourceUrl: capture.url, fetchedAt: capture.fetchedAt, market: capture.data };
  }
}
