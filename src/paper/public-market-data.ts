import { PolymarketPublicApi } from "../adapters/polymarket-public.js";
import { decimalToScaled } from "../domain/fixed.js";
import type {
  PaperFeeSnapshot,
  PaperMarketDataProvider,
  PaperOrderbookSnapshot,
  PaperResolutionSnapshot,
} from "./types.js";

function sourceTime(value: string): string {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) throw new Error(`Invalid orderbook timestamp: ${value}`);
  return new Date(numeric < 1_000_000_000_000 ? numeric * 1_000 : numeric).toISOString();
}

export class PublicPaperMarketDataProvider implements PaperMarketDataProvider {
  constructor(private readonly api = new PolymarketPublicApi()) {}

  async orderbook(assetId: string, conditionId: string): Promise<PaperOrderbookSnapshot> {
    const capture = await this.api.orderbook(assetId);
    if (capture.data.asset_id !== assetId || capture.data.market.toLowerCase() !== conditionId.toLowerCase()) {
      throw new Error("ORDERBOOK_IDENTITY_MISMATCH");
    }
    return {
      assetId,
      conditionId,
      marketSnapshotTime: sourceTime(capture.data.timestamp),
      receivedAt: capture.fetchedAt,
      sourceUrl: capture.url,
      bids: capture.data.bids,
      asks: capture.data.asks,
    };
  }

  async fee(assetId: string, conditionId: string): Promise<PaperFeeSnapshot> {
    try {
      const capture = await this.api.clobMarketInfo(conditionId);
      const token = capture.data.t.find((item) => item.t === assetId);
      if (!token) throw new Error("FEE_ASSET_NOT_FOUND");
      const exponent = capture.data.fd ? Number(capture.data.fd.e) : 1;
      const feeRatePpm = capture.data.fd
        ? decimalToScaled(capture.data.fd.r, 6).toString()
        : capture.data.tbf === 0 ? "0" : null;
      if (!Number.isSafeInteger(capture.data.tbf) || capture.data.tbf < 0 || !Number.isSafeInteger(exponent) || exponent < 1 || exponent > 4 || feeRatePpm === null) {
        throw new Error("UNSUPPORTED_FEE_MODEL");
      }
      return {
        assetId,
        status: "AVAILABLE",
        baseFee: capture.data.tbf,
        feeRatePpm,
        exponent,
        sourceUrl: capture.url,
        snapshotTime: capture.fetchedAt,
      };
    } catch {
      return {
        assetId,
        status: "UNAVAILABLE",
        baseFee: null,
        feeRatePpm: null,
        exponent: null,
        sourceUrl: `https://clob.polymarket.com/clob-markets/${encodeURIComponent(conditionId)}`,
        snapshotTime: new Date().toISOString(),
      };
    }
  }

  async resolution(conditionId: string, assetId: string): Promise<PaperResolutionSnapshot> {
    const capture = await this.api.clobMarket(conditionId);
    const token = capture.data.tokens.find((item) => item.token_id === assetId);
    if (!token) throw new Error("RESOLUTION_ASSET_NOT_FOUND");
    const winnerKnown = capture.data.tokens.some((item) => item.winner === true);
    let numerator: string | null = null;
    let denominator: string | null = null;
    if (capture.data.closed && capture.data.is_50_50_outcome) {
      numerator = "1";
      denominator = "2";
    } else if (capture.data.closed && winnerKnown) {
      numerator = token.winner ? "1" : "0";
      denominator = "1";
    }
    return {
      conditionId,
      assetId,
      resolved: numerator !== null,
      payoutNumerator: numerator,
      payoutDenominator: denominator,
      sourceUrl: capture.url,
      snapshotTime: capture.fetchedAt,
      raw: capture.data as unknown as Record<string, unknown>,
    };
  }
}
