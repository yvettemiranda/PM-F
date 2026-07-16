import { createHash } from "node:crypto";
import { PRICE_SCALE_DIGITS } from "../domain/fixed.js";
import { stableJson } from "../domain/versioning.js";

const PRICE_SCALE = 10n ** BigInt(PRICE_SCALE_DIGITS);
const PPM = 1_000_000n;
const RATIO_DISPLAY_DIGITS = 24;

export const CAPITAL_SIZING_VERSION = "EXACT_RATIONAL_V1";
export const LEGACY_CAPITAL_SIZING_VERSION = "LEGACY_PPM_V1";

export interface ExactCapitalRatioSnapshot {
  calculationVersion: typeof CAPITAL_SIZING_VERSION;
  targetPriceUnits: string;
  targetSizeMicros: string;
  targetTradeAmountMicros: string;
  targetVisibleCapitalMicros: string;
  ratioNumerator: string;
  ratioDenominator: string;
  ratioExact: string;
  ratioDecimal: string;
  ratioPpmDecimal: string;
  legacyRatioPpm: string;
}

export interface BuyCapitalSizingDecision {
  calculationVersion: typeof CAPITAL_SIZING_VERSION | typeof LEGACY_CAPITAL_SIZING_VERSION | "FIXED_FALLBACK_V1";
  capitalMode: "PROPORTIONAL" | "FIXED_FALLBACK" | null;
  accountCapitalMicros: string;
  targetPriceUnits: string | null;
  targetSizeMicros: string | null;
  targetTradeAmountMicros: string | null;
  targetVisibleCapitalMicros: string | null;
  ratioNumerator: string | null;
  ratioDenominator: string | null;
  ratioExact: string | null;
  ratioDecimal: string | null;
  ratioPpmDecimal: string | null;
  calculationNumerator: string | null;
  calculationDenominator: string | null;
  calculatedAmountMicros: string | null;
  remainderNumerator: string | null;
  roundingMode: "FLOOR_ONCE_AT_PUSD_MICRO" | "EXACT_FIXED_AMOUNT" | null;
  result: "CALCULATED" | "REJECTED";
  reason: string | null;
  evidenceHash: string;
}

export interface CapitalDecisionInput {
  status: "COMPLETE" | "INCOMPLETE" | "FAILED";
  confidence: "HIGH" | "MEDIUM" | "LOW";
  ratioPpm: string | null;
  fallbackAmountMicros: string;
}

function unsigned(value: string, field: string, allowZero = false): bigint {
  if (!/^\d+$/.test(value)) throw new Error(`${field}_INVALID`);
  const parsed = BigInt(value);
  if (allowZero ? parsed < 0n : parsed <= 0n) throw new Error(`${field}_INVALID`);
  return parsed;
}

function gcd(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

function decimalRatio(numerator: bigint, denominator: bigint, digits = RATIO_DISPLAY_DIGITS): string {
  const integer = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder === 0n) return integer.toString();
  const scale = 10n ** BigInt(digits);
  const fraction = ((remainder * scale) / denominator)
    .toString()
    .padStart(digits, "0")
    .replace(/0+$/, "");
  return fraction.length === 0 ? integer.toString() : `${integer}.${fraction}`;
}

export function capitalSizingHash(value: object): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

export function isBuyCapitalSizingDecisionValid(value: BuyCapitalSizingDecision): boolean {
  const { evidenceHash, ...payload } = value;
  return capitalSizingHash(payload) === evidenceHash;
}

export function buildExactCapitalRatio(input: {
  targetPriceUnits: string;
  targetSizeMicros: string;
  targetVisibleCapitalMicros: string;
}): ExactCapitalRatioSnapshot {
  const price = unsigned(input.targetPriceUnits, "TARGET_PRICE_UNITS");
  const size = unsigned(input.targetSizeMicros, "TARGET_SIZE_MICROS");
  const visible = unsigned(input.targetVisibleCapitalMicros, "TARGET_VISIBLE_CAPITAL_MICROS");
  if (price >= PRICE_SCALE) throw new Error("TARGET_PRICE_UNITS_INVALID");
  const ratioNumerator = price * size;
  const ratioDenominator = PRICE_SCALE * visible;
  const divisor = gcd(ratioNumerator, ratioDenominator);
  return {
    calculationVersion: CAPITAL_SIZING_VERSION,
    targetPriceUnits: price.toString(),
    targetSizeMicros: size.toString(),
    targetTradeAmountMicros: (ratioNumerator / PRICE_SCALE).toString(),
    targetVisibleCapitalMicros: visible.toString(),
    ratioNumerator: ratioNumerator.toString(),
    ratioDenominator: ratioDenominator.toString(),
    ratioExact: `${ratioNumerator / divisor}/${ratioDenominator / divisor}`,
    ratioDecimal: decimalRatio(ratioNumerator, ratioDenominator),
    ratioPpmDecimal: decimalRatio(ratioNumerator * PPM, ratioDenominator),
    legacyRatioPpm: ((ratioNumerator * PPM) / ratioDenominator).toString(),
  };
}

function finish(
  decision: Omit<BuyCapitalSizingDecision, "evidenceHash">,
): BuyCapitalSizingDecision {
  return { ...decision, evidenceHash: capitalSizingHash(decision) };
}

/**
 * Shared deterministic sizing used by Paper and by the disabled/fake Live
 * planning path. It never rounds a positive ratio up to a minimum amount.
 */
export function calculateBuyCapitalSizing(input: {
  accountCapitalMicros: bigint;
  capitalDecision: CapitalDecisionInput | null;
  exactRatio: ExactCapitalRatioSnapshot | null;
  exactRatioHash: string | null;
}): BuyCapitalSizingDecision {
  const account = input.accountCapitalMicros;
  const base = {
    accountCapitalMicros: account.toString(),
    targetPriceUnits: input.exactRatio?.targetPriceUnits ?? null,
    targetSizeMicros: input.exactRatio?.targetSizeMicros ?? null,
    targetTradeAmountMicros: input.exactRatio?.targetTradeAmountMicros ?? null,
    targetVisibleCapitalMicros: input.exactRatio?.targetVisibleCapitalMicros ?? null,
    ratioNumerator: input.exactRatio?.ratioNumerator ?? null,
    ratioDenominator: input.exactRatio?.ratioDenominator ?? null,
    ratioExact: input.exactRatio?.ratioExact ?? null,
    ratioDecimal: input.exactRatio?.ratioDecimal ?? null,
    ratioPpmDecimal: input.exactRatio?.ratioPpmDecimal ?? null,
  };
  const reject = (
    reason: string,
    version: BuyCapitalSizingDecision["calculationVersion"] = CAPITAL_SIZING_VERSION,
    mode: BuyCapitalSizingDecision["capitalMode"] = null,
  ): BuyCapitalSizingDecision => finish({
    calculationVersion: version,
    capitalMode: mode,
    ...base,
    calculationNumerator: null,
    calculationDenominator: null,
    calculatedAmountMicros: null,
    remainderNumerator: null,
    roundingMode: null,
    result: "REJECTED",
    reason,
  });

  if (account <= 0n) return reject("ACCOUNT_CAPITAL_UNAVAILABLE");
  const capital = input.capitalDecision;
  if (!capital || capital.confidence === "LOW" || capital.status === "FAILED") {
    return reject("CAPITAL_CONFIDENCE_LOW");
  }
  if (capital.confidence === "MEDIUM") {
    let fallback: bigint;
    try {
      fallback = unsigned(capital.fallbackAmountMicros, "FALLBACK_AMOUNT_MICROS");
    } catch {
      return reject("FALLBACK_AMOUNT_UNAVAILABLE", "FIXED_FALLBACK_V1", "FIXED_FALLBACK");
    }
    if (fallback > account) return reject("INSUFFICIENT_AVAILABLE_CASH", "FIXED_FALLBACK_V1", "FIXED_FALLBACK");
    return finish({
      calculationVersion: "FIXED_FALLBACK_V1",
      capitalMode: "FIXED_FALLBACK",
      ...base,
      calculationNumerator: fallback.toString(),
      calculationDenominator: "1",
      calculatedAmountMicros: fallback.toString(),
      remainderNumerator: "0",
      roundingMode: "EXACT_FIXED_AMOUNT",
      result: "CALCULATED",
      reason: null,
    });
  }
  if (capital.status !== "COMPLETE") return reject("CAPITAL_DECISION_UNSUPPORTED");

  if (input.exactRatio) {
    if (input.exactRatio.calculationVersion !== CAPITAL_SIZING_VERSION) {
      return reject("CAPITAL_SIZING_VERSION_UNSUPPORTED");
    }
    if (!input.exactRatioHash || capitalSizingHash(input.exactRatio) !== input.exactRatioHash) {
      return reject("CAPITAL_SIZING_HASH_MISMATCH");
    }
    let numerator: bigint;
    let denominator: bigint;
    try {
      numerator = unsigned(input.exactRatio.ratioNumerator, "CAPITAL_RATIO_NUMERATOR");
      denominator = unsigned(input.exactRatio.ratioDenominator, "CAPITAL_RATIO_DENOMINATOR");
    } catch {
      return reject("CAPITAL_RATIO_UNAVAILABLE");
    }
    const calculationNumerator = account * numerator;
    const amount = calculationNumerator / denominator;
    const remainder = calculationNumerator % denominator;
    if (amount === 0n) return finish({
      calculationVersion: CAPITAL_SIZING_VERSION,
      capitalMode: "PROPORTIONAL",
      ...base,
      calculationNumerator: calculationNumerator.toString(),
      calculationDenominator: denominator.toString(),
      calculatedAmountMicros: "0",
      remainderNumerator: remainder.toString(),
      roundingMode: "FLOOR_ONCE_AT_PUSD_MICRO",
      result: "REJECTED",
      reason: "PROPORTIONAL_AMOUNT_BELOW_ACCOUNT_PRECISION",
    });
    if (amount > account) return reject("INSUFFICIENT_AVAILABLE_CASH", CAPITAL_SIZING_VERSION, "PROPORTIONAL");
    return finish({
      calculationVersion: CAPITAL_SIZING_VERSION,
      capitalMode: "PROPORTIONAL",
      ...base,
      calculationNumerator: calculationNumerator.toString(),
      calculationDenominator: denominator.toString(),
      calculatedAmountMicros: amount.toString(),
      remainderNumerator: remainder.toString(),
      roundingMode: "FLOOR_ONCE_AT_PUSD_MICRO",
      result: "CALCULATED",
      reason: null,
    });
  }

  // Historical contexts are replayed with their original ppm semantics. New
  // contexts always carry exactRatio and therefore never enter this branch.
  if (capital.ratioPpm === null || !/^\d+$/.test(capital.ratioPpm)) {
    return reject("CAPITAL_RATIO_UNAVAILABLE", LEGACY_CAPITAL_SIZING_VERSION);
  }
  const ratioPpm = BigInt(capital.ratioPpm);
  const calculationNumerator = account * ratioPpm;
  const amount = calculationNumerator / PPM;
  const remainder = calculationNumerator % PPM;
  if (amount === 0n) return finish({
    calculationVersion: LEGACY_CAPITAL_SIZING_VERSION,
    capitalMode: "PROPORTIONAL",
    ...base,
    calculationNumerator: calculationNumerator.toString(),
    calculationDenominator: PPM.toString(),
    calculatedAmountMicros: "0",
    remainderNumerator: remainder.toString(),
    roundingMode: "FLOOR_ONCE_AT_PUSD_MICRO",
    result: "REJECTED",
    reason: "PROPORTIONAL_AMOUNT_BELOW_ACCOUNT_PRECISION",
  });
  return finish({
    calculationVersion: LEGACY_CAPITAL_SIZING_VERSION,
    capitalMode: "PROPORTIONAL",
    ...base,
    calculationNumerator: calculationNumerator.toString(),
    calculationDenominator: PPM.toString(),
    calculatedAmountMicros: amount.toString(),
    remainderNumerator: remainder.toString(),
    roundingMode: "FLOOR_ONCE_AT_PUSD_MICRO",
    result: "CALCULATED",
    reason: null,
  });
}
