import {
  PublicExecutionMarketDataProvider,
  type ExecutionFeeSnapshot,
  type ExecutionOrderbookSnapshot,
  type ExecutionResolutionSnapshot,
} from "../execution/market-data.js";

export type LiveMarketDataProviderType = "DISABLED" | "FAKE" | "PUBLIC_CLOB";

/** Read-only market evidence required immediately before every Live order. */
export interface LiveMarketDataProvider {
  readonly providerType: LiveMarketDataProviderType;
  orderbook(assetId: string, conditionId: string): Promise<ExecutionOrderbookSnapshot>;
  fee(assetId: string, conditionId: string): Promise<ExecutionFeeSnapshot>;
  resolution(conditionId: string, assetId: string): Promise<ExecutionResolutionSnapshot>;
}

export class DisabledLiveMarketDataProvider implements LiveMarketDataProvider {
  readonly providerType = "DISABLED" as const;

  async orderbook(_assetId: string, _conditionId: string): Promise<ExecutionOrderbookSnapshot> {
    throw new Error("LIVE_MARKET_DATA_DISABLED");
  }

  async fee(_assetId: string, _conditionId: string): Promise<ExecutionFeeSnapshot> {
    throw new Error("LIVE_MARKET_DATA_DISABLED");
  }

  async resolution(_conditionId: string, _assetId: string): Promise<ExecutionResolutionSnapshot> {
    throw new Error("LIVE_MARKET_DATA_DISABLED");
  }
}

/**
 * Public CLOB reads only. This provider has no authenticated client and cannot
 * submit, cancel, approve, redeem, sign, or otherwise mutate external state.
 */
export class PublicClobLiveMarketDataProvider
  extends PublicExecutionMarketDataProvider
  implements LiveMarketDataProvider {
  readonly providerType = "PUBLIC_CLOB" as const;
}
