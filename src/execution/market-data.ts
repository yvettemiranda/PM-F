import { PolymarketPublicApi, PolymarketPublicHttpError } from "../adapters/polymarket-public.js";
import { decimalToScaled } from "../domain/fixed.js";
import { RULESET } from "../domain/versioning.js";
import { marketRoute, type PolymarketMarketRoute } from "../live/market-protocol.js";

export interface ExecutionOrderbookLevel {
  price: string;
  size: string;
}

/**
 * Immutable public-response material carried from the unauthenticated API
 * adapter to the Paper evidence store. Fake/disabled providers deliberately
 * omit this field, so their snapshots can never qualify as real replay proof.
 */
export interface PublicMarketDataCapture {
  endpoint: "clob-orderbook" | "clob-market-info" | "clob-fee-rate";
  requestUrl: string;
  fetchedAt: string;
  latencyMs: number;
  httpStatus: number;
  payload: unknown;
}

export interface ExecutionOrderbookSnapshot {
  assetId: string;
  conditionId: string;
  marketSnapshotTime: string;
  receivedAt: string;
  sourceUrl: string;
  minOrderSize?: string;
  tickSize?: string;
  bids: ExecutionOrderbookLevel[];
  asks: ExecutionOrderbookLevel[];
  publicCapture?: PublicMarketDataCapture;
  marketRoute?: PolymarketMarketRoute;
}

export interface ExecutionFeeSnapshot {
  assetId: string;
  status: "AVAILABLE" | "UNAVAILABLE";
  baseFee: number | null;
  feeRatePpm: string | null;
  exponent: number | null;
  sourceUrl: string;
  snapshotTime: string;
  publicCapture?: PublicMarketDataCapture;
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

/**
 * Load fee evidence before the orderbook so a slower fee lookup cannot make an
 * already-returned book cross the execution freshness boundary while waiting.
 * The caller must still validate the source snapshot timestamp immediately.
 */
export async function loadFeeThenOrderbook(
  provider: Pick<ExecutionMarketDataProvider, "fee" | "orderbook">,
  assetId: string,
  conditionId: string,
  signal?: AbortSignal,
): Promise<{ fee: ExecutionFeeSnapshot; book: ExecutionOrderbookSnapshot }> {
  const fee = await provider.fee(assetId, conditionId, signal);
  const book = await provider.orderbook(assetId, conditionId, signal);
  return { fee, book };
}

/**
 * Freshness is the age of this authoritative HTTP capture, not the age of the
 * last orderbook content change. The raw source timestamp remains immutable
 * audit evidence and is still rejected when invalid or beyond the shared
 * clock-safety threshold.
 */
export interface ExecutableOrderbookTimingAssessment {
  status: "VALID" | "INVALID" | "CLOCK_UNSAFE";
  ageMs: number;
  sourceClockOffsetMs: number;
  appliedMarketClockOffsetMs: number;
}

export interface ExecutableOrderbookTimingFailure {
  code: "ORDERBOOK_STALE" | "ORDERBOOK_CLOCK_UNSAFE";
  message: string;
}

export const MAX_MARKET_CLOCK_CALIBRATION_OFFSET_MS = 5_000;

export function marketClockOffsetIsValid(offsetMs: number): boolean {
  return Number.isSafeInteger(offsetMs)
    && Math.abs(offsetMs) <= MAX_MARKET_CLOCK_CALIBRATION_OFFSET_MS;
}

export function assessExecutableOrderbookTiming(
  book: Pick<ExecutionOrderbookSnapshot, "marketSnapshotTime" | "receivedAt" | "publicCapture">,
  nowMs: number,
  marketClockOffsetMs = 0,
): ExecutableOrderbookTimingAssessment {
  const sourceTimeMs = Date.parse(book.marketSnapshotTime);
  const receivedAtMs = Date.parse(book.receivedAt);
  const requestLatencyMs = book.publicCapture?.endpoint === "clob-orderbook"
    ? book.publicCapture.latencyMs
    : 0;
  if (
    !Number.isFinite(nowMs)
    || !Number.isFinite(sourceTimeMs)
    || !Number.isFinite(receivedAtMs)
    || !Number.isFinite(requestLatencyMs)
    || requestLatencyMs < 0
    || !marketClockOffsetIsValid(marketClockOffsetMs)
  ) {
    return {
      status: "INVALID",
      ageMs: Number.NaN,
      sourceClockOffsetMs: Number.NaN,
      appliedMarketClockOffsetMs: Number.NaN,
    };
  }
  const sourceClockOffsetMs = sourceTimeMs - (nowMs + marketClockOffsetMs);
  if (sourceClockOffsetMs > RULESET.clockUnsafeThresholdMs) {
    return {
      status: "CLOCK_UNSAFE",
      ageMs: Number.NaN,
      sourceClockOffsetMs,
      appliedMarketClockOffsetMs: marketClockOffsetMs,
    };
  }
  // A fresh receipt can still be unsafe when the HTTP request itself took
  // longer than the execution freshness budget. Conservatively age public
  // captures from request start; fake/isolated snapshots have no capture and
  // retain receipt-time semantics.
  return {
    status: "VALID",
    ageMs: Math.ceil(nowMs - receivedAtMs + requestLatencyMs),
    sourceClockOffsetMs,
    appliedMarketClockOffsetMs: marketClockOffsetMs,
  };
}

export function executableOrderbookAgeMs(
  book: Pick<ExecutionOrderbookSnapshot, "marketSnapshotTime" | "receivedAt" | "publicCapture">,
  nowMs: number,
  marketClockOffsetMs = 0,
): number {
  return assessExecutableOrderbookTiming(book, nowMs, marketClockOffsetMs).ageMs;
}

export function executableOrderbookTimingFailure(
  assessment: ExecutableOrderbookTimingAssessment,
): ExecutableOrderbookTimingFailure | null {
  if (assessment.status === "VALID") return null;
  if (assessment.status === "CLOCK_UNSAFE") {
    return {
      code: "ORDERBOOK_CLOCK_UNSAFE",
      message: `Orderbook source clock offset ${assessment.sourceClockOffsetMs}ms exceeds ${RULESET.clockUnsafeThresholdMs}ms`,
    };
  }
  return {
    code: "ORDERBOOK_STALE",
    message: "Orderbook timing evidence is invalid",
  };
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
      ...(capture.data.min_order_size === undefined ? {} : { minOrderSize: capture.data.min_order_size }),
      ...(capture.data.tick_size === undefined ? {} : { tickSize: capture.data.tick_size }),
      ...((capture.data.version !== undefined || typeof capture.data.neg_risk === "boolean")
        && /^[0-9]+$/.test(assetId) && /^0x[0-9a-f]{62}(?:[0-9a-f]{2})?$/i.test(conditionId)
        ? { marketRoute: marketRoute({ assetId, conditionId, version: capture.data.version, neg_risk: capture.data.neg_risk }) } : {}),
      bids: capture.data.bids,
      asks: capture.data.asks,
      publicCapture: {
        endpoint: "clob-orderbook",
        requestUrl: capture.url,
        fetchedAt: capture.fetchedAt,
        latencyMs: capture.latencyMs,
        httpStatus: capture.status,
        payload: capture.data,
      },
    };
  }

  async fee(assetId: string, conditionId: string, signal?: AbortSignal): Promise<ExecutionFeeSnapshot> {
    let publicBaseFee: Awaited<ReturnType<PolymarketPublicApi["feeRate"]>> | null = null;
    try {
      publicBaseFee = await this.api.feeRate(assetId, signal);
      if (publicBaseFee.data.base_fee === 0) {
        return {
          assetId,
          status: "AVAILABLE",
          baseFee: 0,
          feeRatePpm: "0",
          // The exponent is mathematically inert when the explicit fee
          // coefficient is zero. Keep a canonical value for the shared
          // Paper/Live fee interface; never infer zero from a missing field.
          exponent: 1,
          sourceUrl: publicBaseFee.url,
          snapshotTime: publicBaseFee.fetchedAt,
          publicCapture: {
            endpoint: "clob-fee-rate",
            requestUrl: publicBaseFee.url,
            fetchedAt: publicBaseFee.fetchedAt,
            latencyMs: publicBaseFee.latencyMs,
            httpStatus: publicBaseFee.status,
            payload: publicBaseFee.data,
          },
        };
      }
    } catch (error) {
      if (signal?.aborted) throw error;
    }
    try {
      const capture = await this.api.clobMarketInfo(conditionId, signal);
      const token = capture.data.t.find((item) => item.t === assetId);
      if (!token) throw new Error("FEE_ASSET_NOT_FOUND");
      const exponent = capture.data.fd ? Number(capture.data.fd.e) : 1;
      // A single immutable market-info capture must fully explain a non-zero
      // fee model. Do not combine an unpersisted /fee-rate value with partial
      // curve details, because that result could not be replayed later.
      const baseFee = capture.data.tbf ?? null;
      const feeRatePpm = capture.data.fd
        ? decimalToScaled(capture.data.fd.r, 6).toString()
        : baseFee === 0 ? "0" : null;
      if (
        baseFee === null
        || !Number.isSafeInteger(baseFee)
        || baseFee < 0
        || (publicBaseFee !== null && baseFee !== publicBaseFee.data.base_fee)
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
        baseFee,
        feeRatePpm,
        exponent,
        sourceUrl: capture.url,
        snapshotTime: capture.fetchedAt,
        publicCapture: {
          endpoint: "clob-market-info",
          requestUrl: capture.url,
          fetchedAt: capture.fetchedAt,
          latencyMs: capture.latencyMs,
          httpStatus: capture.status,
          payload: capture.data,
        },
      };
    } catch (error) {
      if (signal?.aborted) throw error;
      return {
        assetId,
        status: "UNAVAILABLE",
        baseFee: null,
        feeRatePpm: null,
        exponent: null,
        sourceUrl: publicBaseFee?.url
          ?? `https://clob.polymarket.com/clob-markets/${encodeURIComponent(conditionId)}`,
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
