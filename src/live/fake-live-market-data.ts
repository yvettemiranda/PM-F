import type {
  ExecutionFeeSnapshot,
  ExecutionOrderbookLevel,
  ExecutionOrderbookSnapshot,
  ExecutionResolutionSnapshot,
} from "../execution/market-data.js";
import type { LiveMarketDataProvider } from "./live-market-data.js";

export interface FakeLiveMarketDataOptions {
  now?: () => Date;
  marketSnapshotTime?: string;
  bids?: ExecutionOrderbookLevel[];
  asks?: ExecutionOrderbookLevel[];
  feeStatus?: "AVAILABLE" | "UNAVAILABLE";
  feeRatePpm?: string;
  feeExponent?: number;
  resolution?: {
    resolved: boolean;
    payoutNumerator: string | null;
    payoutDenominator: string | null;
  };
}

/** Deterministic, test-only public market evidence. */
export class FakeLiveMarketDataProvider implements LiveMarketDataProvider {
  readonly providerType = "FAKE" as const;
  private readonly now: () => Date;

  constructor(private readonly options: FakeLiveMarketDataOptions = {}) {
    this.now = options.now ?? (() => new Date());
  }

  async orderbook(assetId: string, conditionId: string): Promise<ExecutionOrderbookSnapshot> {
    const receivedAt = this.now().toISOString();
    return {
      assetId,
      conditionId,
      marketSnapshotTime: this.options.marketSnapshotTime ?? receivedAt,
      receivedAt,
      sourceUrl: "fake://live-orderbook",
      bids: this.options.bids ?? [{ price: "0.5", size: "1000000000000000000000000000000" }],
      asks: this.options.asks ?? [{ price: "0.5", size: "1000000000000000000000000000000" }],
    };
  }

  async fee(assetId: string, _conditionId: string): Promise<ExecutionFeeSnapshot> {
    const available = (this.options.feeStatus ?? "AVAILABLE") === "AVAILABLE";
    return {
      assetId,
      status: available ? "AVAILABLE" : "UNAVAILABLE",
      baseFee: available ? 0 : null,
      feeRatePpm: available ? (this.options.feeRatePpm ?? "0") : null,
      exponent: available ? (this.options.feeExponent ?? 1) : null,
      sourceUrl: "fake://live-fee",
      snapshotTime: this.now().toISOString(),
    };
  }

  async resolution(conditionId: string, assetId: string): Promise<ExecutionResolutionSnapshot> {
    const resolution = this.options.resolution ?? {
      resolved: false,
      payoutNumerator: null,
      payoutDenominator: null,
    };
    return {
      conditionId,
      assetId,
      ...resolution,
      sourceUrl: "fake://live-resolution",
      snapshotTime: this.now().toISOString(),
      raw: { fake: true, ...resolution },
    };
  }
}
