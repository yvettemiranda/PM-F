import { roundedClobPlatformFeeMicros } from "../execution/clob-fee.js";
import type { LiveFillEvent, LiveOrderSide, LiveOrderState } from "./live-types.js";

const PRICE_SCALE = 1_000_000_000_000_000_000n;

function unsigned(value: string, code: string): bigint {
  if (!/^\d+$/.test(value)) throw new Error(code);
  return BigInt(value);
}

function confirmedClobFee(fill: LiveFillEvent): bigint {
  const rawStatus = typeof fill.raw.status === "string"
    ? fill.raw.status.trim().toUpperCase().replace(/^TRADE_STATUS_/, "")
    : null;
  if (rawStatus !== "CONFIRMED") {
    throw new Error(`CLOB_FILL_NOT_CONFIRMED:${fill.externalFillId}:${rawStatus ?? "MISSING"}`);
  }
  const evidence = fill.raw.niKFeeEvidence;
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    throw new Error(`CLOB_FILL_FEE_EVIDENCE_MISSING:${fill.externalFillId}`);
  }
  const record = evidence as Record<string, unknown>;
  if (typeof record.isTaker !== "boolean" || typeof record.platformFeeRateBps !== "string") {
    throw new Error(`CLOB_FILL_FEE_EVIDENCE_INVALID:${fill.externalFillId}`);
  }
  const rate = unsigned(record.platformFeeRateBps, "CLOB_FILL_FEE_RATE_INVALID");
  if (!record.isTaker || rate === 0n) return 0n;
  if (typeof record.feeExponent !== "number") {
    throw new Error(`CLOB_FILL_FEE_EXPONENT_MISSING:${fill.externalFillId}`);
  }
  return roundedClobPlatformFeeMicros({
    sizeMicros: unsigned(fill.sizeMicros, "ORDER_FILL_SIZE_INVALID"),
    priceUnits: unsigned(fill.priceUnits, "ORDER_FILL_PRICE_INVALID"),
    feeRateBps: rate,
    feeExponent: record.feeExponent,
  });
}

export interface LiveFillValidationInput {
  adapterType: string;
  side: LiveOrderSide;
  status: LiveOrderState;
  fills: LiveFillEvent[];
  requestedSizeMicros: string;
  limitPriceUnits: string;
  buyBudgetMicros: string | null;
  availableSellSizeMicros: string | null;
  reportedFilledSizeMicros?: string;
}

export interface LiveFillValidationResult {
  filledSizeMicros: bigint;
  filledNotionalMicros: bigint;
  feeMicros: bigint;
}

/**
 * Single accounting validator used by both immediate submit handling and
 * Crash Recovery. External data must never get a weaker validation path just
 * because it arrived after a restart.
 */
export function validateLiveOrderFills(input: LiveFillValidationInput): LiveFillValidationResult {
  if (["FILLED", "PARTIALLY_FILLED"].includes(input.status) && input.fills.length === 0) {
    throw new Error("ORDER_STATUS_FILL_MISMATCH");
  }
  const requestedSize = unsigned(input.requestedSizeMicros, "ORDER_REQUESTED_SIZE_INVALID");
  const limitPrice = unsigned(input.limitPriceUnits, "ORDER_LIMIT_PRICE_INVALID");
  if (requestedSize <= 0n || limitPrice <= 0n || limitPrice >= PRICE_SCALE) {
    throw new Error("ORDER_IMMUTABLE_ECONOMICS_INVALID");
  }
  const ids = new Set<string>();
  let filledSize = 0n;
  let filledNotional = 0n;
  let totalFee = 0n;
  for (const fill of input.fills) {
    if (!fill.externalFillId || ids.has(fill.externalFillId)) {
      throw new Error(`ORDER_DUPLICATE_OR_MISSING_FILL_ID:${fill.externalFillId || "MISSING"}`);
    }
    ids.add(fill.externalFillId);
    const size = unsigned(fill.sizeMicros, "ORDER_FILL_SIZE_INVALID");
    const price = unsigned(fill.priceUnits, "ORDER_FILL_PRICE_INVALID");
    const notional = unsigned(fill.notionalMicros, "ORDER_FILL_NOTIONAL_INVALID");
    const fee = unsigned(fill.feeMicros, "ORDER_FILL_FEE_INVALID");
    if (size <= 0n || price <= 0n || price >= PRICE_SCALE || notional <= 0n) {
      throw new Error("ORDER_FILL_ACCOUNTING_INVALID");
    }
    const product = size * price;
    const expectedNotional = input.side === "BUY"
      ? (product + PRICE_SCALE - 1n) / PRICE_SCALE
      : product / PRICE_SCALE;
    if (notional !== expectedNotional) throw new Error("ORDER_FILL_NOTIONAL_MISMATCH");
    if (input.side === "BUY" && price > limitPrice) throw new Error("BUY_FILL_LIMIT_PRICE_BREACH");
    if (input.side === "SELL" && price < limitPrice) throw new Error("SELL_FILL_LIMIT_PRICE_BREACH");
    if (input.adapterType === "POLYMARKET_CLOB" && fee !== confirmedClobFee(fill)) {
      throw new Error(`CLOB_FILL_FEE_MISMATCH:${fill.externalFillId}`);
    }
    filledSize += size;
    filledNotional += notional;
    totalFee += fee;
  }
  if (filledSize > requestedSize) {
    throw new Error(input.side === "BUY" ? "BUY_FILL_EXCEEDS_APPROVED_SIZE" : "SELL_FILL_EXCEEDS_APPROVED_SIZE");
  }
  if (input.side === "BUY") {
    if (input.buyBudgetMicros === null) throw new Error("BUY_RISK_BUDGET_MISSING");
    const budget = unsigned(input.buyBudgetMicros, "BUY_RISK_BUDGET_INVALID");
    if (filledNotional + totalFee > budget) throw new Error("BUY_FILL_EXCEEDS_RISK_BUDGET");
  } else {
    if (input.availableSellSizeMicros === null) throw new Error("SELL_AVAILABLE_POSITION_MISSING");
    const available = unsigned(input.availableSellSizeMicros, "SELL_AVAILABLE_POSITION_INVALID");
    if (filledSize > available) throw new Error("SELL_FILL_EXCEEDS_LOCAL_POSITION");
  }
  if (input.reportedFilledSizeMicros !== undefined) {
    const reported = unsigned(input.reportedFilledSizeMicros, "ORDER_REPORTED_FILL_SIZE_INVALID");
    if (reported !== filledSize) throw new Error("ORDER_EXTERNAL_FILL_TOTAL_MISMATCH");
  }
  if (input.status === "FILLED" && filledSize !== requestedSize) {
    throw new Error("ORDER_FILLED_STATUS_SIZE_MISMATCH");
  }
  if (input.status === "PARTIALLY_FILLED" && (filledSize <= 0n || filledSize >= requestedSize)) {
    throw new Error("ORDER_PARTIAL_STATUS_SIZE_MISMATCH");
  }
  if (["CREATED", "SUBMITTED", "ACKNOWLEDGED"].includes(input.status) && filledSize !== 0n) {
    throw new Error("ORDER_OPEN_STATUS_HAS_CONFIRMED_FILLS");
  }
  return { filledSizeMicros: filledSize, filledNotionalMicros: filledNotional, feeMicros: totalFee };
}
