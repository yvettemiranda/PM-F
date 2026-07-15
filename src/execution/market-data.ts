import { PolymarketPublicApi, PolymarketPublicHttpError } from "../adapters/polymarket-public.js";
import { decimalToScaled } from "../domain/fixed.js";

export interface ExecutionOrderbookLevel {
  price: string;
  size: string;
}

export interface ExecutionOrderbookSnapshot {
  assetId: string;
  conditionId: string;
  marketSnapshotTime: string;
  receivedAt: string;
  sourceUrl: string;
  bids: ExecutionOrderbookLevel[];
  asks: ExecutionOrderbookLevel[];
}

export interface ExecutionFeeSnapshot {
  assetId: string;
  status: "AVAILABLE" | "UNAVAILABLE";
  baseFee: number | null;
  feeRatePpm: string | null;
  exponent: number | null;
  sourceUrl: string;
  snapshotTime: string;
}

export interface ExecutionResolutionSnapshot {
  conditionId: string;
  resolved: boolean;
  assetId: string;
  payoutNumerator: string | null;
  payoutDenominator: string | null;
  sourceUrl: string;
  snapshotTime: string;
  raw: Record<string, unknown>;
}

export class OrderbookUnavailableError extends Error {
  readonly code = "NO_ORDERBOOK_EXISTS";

  constructor(
    readonly assetId: string,
    readonly conditionId: string,
    options: { cause?: unknown } = {},
  ) {
    super(`No orderbook exists for ${assetId}`, options);
    this.name = "OrderbookUnavailableError";
  }
}

export function isOrderbookUnavailableError(error: unknown): boolean {
  return error instanceof OrderbookUnavailableError
    || (typeof error === "object" && error !== null && "code" in error
      && (error as { code?: unknown }).code === "NO_ORDERBOOK_EXISTS");
}

export interface ExecutionMarketDataProvider {
  orderbook(assetId: string, conditionId: string, signal?: AbortSignal): Promise<ExecutionOrderbookSnapshot>;
  fee(assetId: string, conditionId: string, signal?: AbortSignal): Promise<ExecutionFeeSnapshot>;
  resolution(conditionId: string, assetId: string, signal?: AbortSignal): Promise<ExecutionResolutionSnapshot>;
}

function sourceTime(value: string): string {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) throw new Error(`Invalid orderbook timestamp: ${value}`);
  return new Date(numeric < 1_000_000_000_000 ? numeric * 1_000 : numeric).toISOString();
}

/**
 * Public, unauthenticated market data shared by Paper and future Live planning.
 * This class has no signing, order submission, allowance, or chain-write ability.
 */
export class PublicExecutionMarketDataProvider implements ExecutionMarketDataProvider {
  constructor(private readonly api = new PolymarketPublicApi()) {}

  async orderbook(assetId: string, conditionId: string, signal?: AbortSignal): Promise<ExecutionOrderbookSnapshot> {
    let capture;
    try {
      capture = await this.api.orderbook(assetId, signal);
    } catch (error) {
      if (
        error instanceof PolymarketPublicHttpError
        && error.status === 404
        && /no orderbook exists/i.test(error.body)
      ) {
        throw new OrderbookUnavailableError(assetId, conditionId, { cause: error });
      }
      throw error;
    }
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

  async fee(assetId: string, conditionId: string, signal?: AbortSignal): Promise<ExecutionFeeSnapshot> {
    try {
      const capture = await this.api.clobMarketInfo(conditionId, signal);
      const token = capture.data.t.find((item) => item.t === assetId);
      if (!token) throw new Error("FEE_ASSET_NOT_FOUND");
      const exponent = capture.data.fd ? Number(capture.data.fd.e) : 1;
      const feeRatePpm = capture.data.fd
        ? decimalToScaled(capture.data.fd.r, 6).toString()
        : capture.data.tbf === 0 ? "0" : null;
      if (
        !Number.isSafeInteger(capture.data.tbf)
        || capture.data.tbf < 0
        || !Number.isSafeInteger(exponent)
        || exponent < 1
        || exponent > 4
        || feeRatePpm === null
      ) {
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
    } catch (error) {
      if (signal?.aborted) throw error;
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

  async resolution(conditionId: string, assetId: string, signal?: AbortSignal): Promise<ExecutionResolutionSnapshot> {
    const capture = await this.api.clobMarket(conditionId, signal);
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
