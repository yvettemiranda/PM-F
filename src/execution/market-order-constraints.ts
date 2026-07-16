import { createHash } from "node:crypto";
import { decimalToScaled, PRICE_SCALE_DIGITS, SHARE_SCALE_DIGITS } from "../domain/fixed.js";
import { stableJson } from "../domain/versioning.js";

const PRICE_SCALE = 10n ** BigInt(PRICE_SCALE_DIGITS);
const CLOB_MARKET_BUY_AMOUNT_STEP_MICROS = 10_000n;
// Mirrors @polymarket/clob-client-v2 ROUNDING_CONFIG. Unknown tick sizes must
// fail closed instead of being assigned an invented precision.
const CLOB_AMOUNT_DIGITS_BY_TICK_UNITS = new Map<string, number>([
  ["100000000000000000", 3], // 0.1
  ["10000000000000000", 4], // 0.01
  ["5000000000000000", 5], // 0.005
  ["2500000000000000", 6], // 0.0025
  ["1000000000000000", 5], // 0.001
  ["100000000000000", 6], // 0.0001
]);

export type MarketConstraintResult = "PASS" | "REJECT" | "UNAVAILABLE";

export interface MarketOrderConstraintEvidence {
  side: "BUY" | "SELL";
  result: MarketConstraintResult;
  reason: string;
  minOrderSize: string | null;
  minOrderSizeMicros: string | null;
  tickSize: string | null;
  tickSizeUnits: string | null;
  proposedAmountMicros: string | null;
  normalizedOrderAmountMicros: string | null;
  proposedSizeMicros: string | null;
  normalizedOrderSizeMicros: string | null;
  effectivePriceUnits: string | null;
  derivedMinNotionalMicros: string | null;
  priceRounding: "FLOOR_TO_TICK" | "CEIL_TO_TICK" | null;
  evidenceHash: string;
}

function finish(value: Omit<MarketOrderConstraintEvidence, "evidenceHash">): MarketOrderConstraintEvidence {
  return { ...value, evidenceHash: createHash("sha256").update(stableJson(value)).digest("hex") };
}

export function parseMarketOrderConstraints(input: { minOrderSize: string | undefined; tickSize: string | undefined }):
  | { minOrderSizeMicros: bigint; tickSizeUnits: bigint; amountScaleDigits: number }
  | { error: string } {
  if (!input.minOrderSize) return { error: "MIN_ORDER_SIZE_UNAVAILABLE" };
  if (!input.tickSize) return { error: "TICK_SIZE_UNAVAILABLE" };
  try {
    const minSize = decimalToScaled(input.minOrderSize, SHARE_SCALE_DIGITS);
    const tick = decimalToScaled(input.tickSize, PRICE_SCALE_DIGITS);
    if (minSize <= 0n) return { error: "MIN_ORDER_SIZE_INVALID" };
    if (tick <= 0n || tick >= PRICE_SCALE || PRICE_SCALE % tick !== 0n) return { error: "TICK_SIZE_INVALID" };
    const amountScaleDigits = CLOB_AMOUNT_DIGITS_BY_TICK_UNITS.get(tick.toString());
    if (amountScaleDigits === undefined) return { error: "TICK_SIZE_UNSUPPORTED_BY_CLOB_SDK" };
    return { minOrderSizeMicros: minSize, tickSizeUnits: tick, amountScaleDigits };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { error: message.startsWith("Precision exceeds") ? "ORDERBOOK_CONSTRAINT_PRECISION_UNSUPPORTED" : "ORDERBOOK_CONSTRAINT_INVALID" };
  }
}

export function orderbookConstraintAvailability(input: {
  minOrderSize: string | undefined;
  tickSize: string | undefined;
}): string | null {
  const parsed = parseMarketOrderConstraints(input);
  return "error" in parsed ? parsed.error : null;
}

function ceilDivide(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

function floorToStep(value: bigint, step: bigint): bigint {
  return (value / step) * step;
}

export function evaluateBuyMarketConstraint(input: {
  minOrderSize: string | undefined;
  tickSize: string | undefined;
  requestedAmountMicros: bigint;
  upperPriceUnits: bigint;
}): MarketOrderConstraintEvidence {
  const parsed = parseMarketOrderConstraints(input);
  const unavailable = (reason: string): MarketOrderConstraintEvidence => finish({
    side: "BUY",
    result: "UNAVAILABLE",
    reason,
    minOrderSize: input.minOrderSize ?? null,
    minOrderSizeMicros: null,
    tickSize: input.tickSize ?? null,
    tickSizeUnits: null,
    proposedAmountMicros: input.requestedAmountMicros.toString(),
    normalizedOrderAmountMicros: null,
    proposedSizeMicros: null,
    normalizedOrderSizeMicros: null,
    effectivePriceUnits: null,
    derivedMinNotionalMicros: null,
    priceRounding: null,
  });
  if ("error" in parsed) return unavailable(parsed.error);
  if (input.requestedAmountMicros <= 0n || input.upperPriceUnits <= 0n || input.upperPriceUnits >= PRICE_SCALE) {
    return unavailable("BUY_ORDER_CONSTRAINT_INPUT_INVALID");
  }
  // A BUY must not exceed the configured upper price; flooring is the safe
  // SDK-compatible tick direction.
  const effectivePrice = (input.upperPriceUnits / parsed.tickSizeUnits) * parsed.tickSizeUnits;
  if (effectivePrice <= 0n) return unavailable("BUY_LIMIT_PRICE_BELOW_TICK");
  // clob-client-v2 normalizes market BUY amounts to two USDC decimals. Mirror
  // that floor exactly; never round a small proportional amount up to 0.01.
  const normalizedAmount = (input.requestedAmountMicros / CLOB_MARKET_BUY_AMOUNT_STEP_MICROS)
    * CLOB_MARKET_BUY_AMOUNT_STEP_MICROS;
  if (normalizedAmount === 0n) return finish({
    side: "BUY",
    result: "REJECT",
    reason: "ORDER_AMOUNT_BELOW_EXECUTOR_PRECISION",
    minOrderSize: input.minOrderSize!,
    minOrderSizeMicros: parsed.minOrderSizeMicros.toString(),
    tickSize: input.tickSize!,
    tickSizeUnits: parsed.tickSizeUnits.toString(),
    proposedAmountMicros: input.requestedAmountMicros.toString(),
    normalizedOrderAmountMicros: "0",
    proposedSizeMicros: "0",
    normalizedOrderSizeMicros: "0",
    effectivePriceUnits: effectivePrice.toString(),
    derivedMinNotionalMicros: ceilDivide(parsed.minOrderSizeMicros * effectivePrice, PRICE_SCALE).toString(),
    priceRounding: "FLOOR_TO_TICK",
  });
  const proposedSize = (normalizedAmount * PRICE_SCALE) / effectivePrice;
  const sharePrecision = Math.min(SHARE_SCALE_DIGITS, parsed.amountScaleDigits);
  const shareStep = 10n ** BigInt(SHARE_SCALE_DIGITS - sharePrecision);
  const normalizedSize = floorToStep(proposedSize, shareStep);
  const derivedMinNotional = ceilDivide(parsed.minOrderSizeMicros * effectivePrice, PRICE_SCALE);
  const pass = normalizedSize >= parsed.minOrderSizeMicros;
  return finish({
    side: "BUY",
    result: pass ? "PASS" : "REJECT",
    reason: pass ? "MARKET_MIN_ORDER_SIZE_SATISFIED" : "BELOW_MARKET_MIN_ORDER_SIZE",
    minOrderSize: input.minOrderSize!,
    minOrderSizeMicros: parsed.minOrderSizeMicros.toString(),
    tickSize: input.tickSize!,
    tickSizeUnits: parsed.tickSizeUnits.toString(),
    proposedAmountMicros: input.requestedAmountMicros.toString(),
    normalizedOrderAmountMicros: normalizedAmount.toString(),
    proposedSizeMicros: proposedSize.toString(),
    normalizedOrderSizeMicros: normalizedSize.toString(),
    effectivePriceUnits: effectivePrice.toString(),
    derivedMinNotionalMicros: derivedMinNotional.toString(),
    priceRounding: "FLOOR_TO_TICK",
  });
}

export function evaluateSellMarketConstraint(input: {
  minOrderSize: string | undefined;
  tickSize: string | undefined;
  requestedSizeMicros: bigint;
  minimumPriceUnits: bigint;
}): MarketOrderConstraintEvidence {
  const parsed = parseMarketOrderConstraints(input);
  const unavailable = (reason: string): MarketOrderConstraintEvidence => finish({
    side: "SELL",
    result: "UNAVAILABLE",
    reason,
    minOrderSize: input.minOrderSize ?? null,
    minOrderSizeMicros: null,
    tickSize: input.tickSize ?? null,
    tickSizeUnits: null,
    proposedAmountMicros: null,
    normalizedOrderAmountMicros: null,
    proposedSizeMicros: input.requestedSizeMicros.toString(),
    normalizedOrderSizeMicros: null,
    effectivePriceUnits: null,
    derivedMinNotionalMicros: null,
    priceRounding: null,
  });
  if ("error" in parsed) return unavailable(parsed.error);
  if (input.requestedSizeMicros <= 0n || input.minimumPriceUnits <= 0n || input.minimumPriceUnits >= PRICE_SCALE) {
    return unavailable("SELL_ORDER_CONSTRAINT_INPUT_INVALID");
  }
  // A SELL must not cross below the minimum protected price; ceiling is the
  // safe SDK-compatible tick direction.
  const effectivePrice = ceilDivide(input.minimumPriceUnits, parsed.tickSizeUnits) * parsed.tickSizeUnits;
  if (effectivePrice >= PRICE_SCALE) return unavailable("SELL_LIMIT_PRICE_ABOVE_MARKET_RANGE");
  const normalizedSize = floorToStep(input.requestedSizeMicros, 10_000n);
  const derivedMinNotional = ceilDivide(parsed.minOrderSizeMicros * effectivePrice, PRICE_SCALE);
  const pass = normalizedSize >= parsed.minOrderSizeMicros;
  const reason = normalizedSize === 0n
    ? "ORDER_SIZE_BELOW_EXECUTOR_PRECISION"
    : pass ? "MARKET_MIN_ORDER_SIZE_SATISFIED" : "BELOW_MARKET_MIN_ORDER_SIZE";
  return finish({
    side: "SELL",
    result: pass ? "PASS" : "REJECT",
    reason,
    minOrderSize: input.minOrderSize!,
    minOrderSizeMicros: parsed.minOrderSizeMicros.toString(),
    tickSize: input.tickSize!,
    tickSizeUnits: parsed.tickSizeUnits.toString(),
    proposedAmountMicros: null,
    normalizedOrderAmountMicros: null,
    proposedSizeMicros: input.requestedSizeMicros.toString(),
    normalizedOrderSizeMicros: normalizedSize.toString(),
    effectivePriceUnits: effectivePrice.toString(),
    derivedMinNotionalMicros: derivedMinNotional.toString(),
    priceRounding: "CEIL_TO_TICK",
  });
}
