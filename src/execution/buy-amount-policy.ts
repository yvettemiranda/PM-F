import { createHash } from "node:crypto";
import { stableJson } from "../domain/versioning.js";

export const BUY_AMOUNT_POLICY_VERSION = "BUY_AMOUNT_POLICY_V4";
const PRIOR_BUY_AMOUNT_POLICY_VERSION = "BUY_AMOUNT_POLICY_V3";
const LEGACY_BUY_AMOUNT_POLICY_VERSION = "BUY_AMOUNT_POLICY_V2";

export type BuyMinimumLiftEligibility = "FIRST_ENTRY" | "AMPLIFIED_POSITION" | "NONE";
export type BuyAmountPolicyClass = "SMALL_BUY" | "PROPORTIONAL_BUY";

export const SMALL_BUY_RATIO_NUMERATOR = 1n;
export const SMALL_BUY_RATIO_DENOMINATOR = 100n;

export function classifyTargetBuyRatio(input: {
  ratioNumerator?: string | null;
  ratioDenominator?: string | null;
  legacyRatioPpm?: string | null;
  fixedFallback?: boolean;
}): BuyAmountPolicyClass | null {
  try {
    if (input.ratioNumerator !== null && input.ratioNumerator !== undefined
      && input.ratioDenominator !== null && input.ratioDenominator !== undefined) {
      if (!/^\d+$/.test(input.ratioNumerator) || !/^\d+$/.test(input.ratioDenominator)) return null;
      const numerator = BigInt(input.ratioNumerator);
      const denominator = BigInt(input.ratioDenominator);
      if (numerator <= 0n || denominator <= 0n) return null;
      return numerator * SMALL_BUY_RATIO_DENOMINATOR
        < denominator * SMALL_BUY_RATIO_NUMERATOR
        ? "SMALL_BUY"
        : "PROPORTIONAL_BUY";
    }
    if (input.legacyRatioPpm !== null && input.legacyRatioPpm !== undefined) {
      if (!/^\d+$/.test(input.legacyRatioPpm)) return null;
      return BigInt(input.legacyRatioPpm) < 10_000n ? "SMALL_BUY" : "PROPORTIONAL_BUY";
    }
  } catch {
    return null;
  }
  return input.fixedFallback ? "SMALL_BUY" : null;
}

export interface CurrentBuyAmountPolicyDecision {
  version: typeof BUY_AMOUNT_POLICY_VERSION;
  result: "UNCHANGED" | "LIFTED" | "CAPPED";
  reason:
    | "CALCULATED_AMOUNT_RETAINED"
    | "SMALL_BUY_MINIMUM_APPLIED"
    | "SMALL_BUY_MARKET_MINIMUM_APPLIED"
    | "SMALL_BUY_HARD_CAP_APPLIED"
    | "AVAILABLE_CASH_CAP_APPLIED";
  calculatedAmountMicros: string;
  finalAmountMicros: string;
  policyClass: BuyAmountPolicyClass;
  firstEntryMinimumAmountMicros: string;
  marketMinimumAmountMicros: string | null;
  marketMinimumAutoLiftCapMicros: string;
  availableCashCapMicros: string | null;
  evidenceHash: string;
}

export interface PriorBuyAmountPolicyDecision {
  version: typeof PRIOR_BUY_AMOUNT_POLICY_VERSION;
  result: "UNCHANGED" | "LIFTED" | "CAPPED";
  reason:
    | "CALCULATED_AMOUNT_RETAINED"
    | "FIRST_ENTRY_MINIMUM_APPLIED"
    | "AMPLIFIED_POSITION_MINIMUM_APPLIED"
    | "MARKET_MINIMUM_APPLIED"
    | "AVAILABLE_CASH_CAP_APPLIED";
  calculatedAmountMicros: string;
  finalAmountMicros: string;
  minimumLiftEligibility: BuyMinimumLiftEligibility;
  firstEntryMinimumAmountMicros: string;
  marketMinimumAmountMicros: string | null;
  marketMinimumAutoLiftCapMicros: string;
  availableCashCapMicros: string | null;
  evidenceHash: string;
}

export type BuyAmountPolicyDecision = CurrentBuyAmountPolicyDecision | PriorBuyAmountPolicyDecision;

function finish(value: Omit<CurrentBuyAmountPolicyDecision, "evidenceHash">): CurrentBuyAmountPolicyDecision {
  return {
    ...value,
    evidenceHash: createHash("sha256").update(stableJson(value)).digest("hex"),
  };
}

export function applyBuyAmountPolicy(input: {
  calculatedAmountMicros: bigint;
  policyClass: BuyAmountPolicyClass;
  firstEntryMinimumAmountMicros: bigint;
  marketMinimumAmountMicros?: bigint | null;
  marketMinimumAutoLiftCapMicros: bigint;
  availableCashCapMicros?: bigint | null;
}): CurrentBuyAmountPolicyDecision {
  if (
    input.calculatedAmountMicros < 0n
    || !(["SMALL_BUY", "PROPORTIONAL_BUY"] as const).includes(input.policyClass)
    || input.firstEntryMinimumAmountMicros <= 0n
    || input.marketMinimumAutoLiftCapMicros < input.firstEntryMinimumAmountMicros
    || (input.marketMinimumAmountMicros !== undefined
      && input.marketMinimumAmountMicros !== null
      && input.marketMinimumAmountMicros <= 0n)
    || (input.availableCashCapMicros !== undefined
      && input.availableCashCapMicros !== null
      && input.availableCashCapMicros < 0n)
  ) throw new Error("BUY_AMOUNT_POLICY_INPUT_INVALID");

  let finalAmount = input.calculatedAmountMicros;
  let reason: CurrentBuyAmountPolicyDecision["reason"] = "CALCULATED_AMOUNT_RETAINED";
  const smallBuy = input.policyClass === "SMALL_BUY";
  if (smallBuy && finalAmount < input.firstEntryMinimumAmountMicros) {
    finalAmount = input.firstEntryMinimumAmountMicros;
    reason = "SMALL_BUY_MINIMUM_APPLIED";
  }
  const marketMinimum = input.marketMinimumAmountMicros ?? null;
  if (
    smallBuy
    && marketMinimum !== null
    && marketMinimum > finalAmount
    && marketMinimum <= input.marketMinimumAutoLiftCapMicros
  ) {
    finalAmount = marketMinimum;
    reason = "SMALL_BUY_MARKET_MINIMUM_APPLIED";
  }
  if (smallBuy && finalAmount > input.marketMinimumAutoLiftCapMicros) {
    finalAmount = input.marketMinimumAutoLiftCapMicros;
    reason = "SMALL_BUY_HARD_CAP_APPLIED";
  }
  const availableCashCap = input.availableCashCapMicros ?? null;
  if (
    availableCashCap !== null
    && finalAmount > availableCashCap
    && (input.policyClass === "PROPORTIONAL_BUY" || availableCashCap >= input.firstEntryMinimumAmountMicros)
  ) {
    finalAmount = availableCashCap;
    reason = "AVAILABLE_CASH_CAP_APPLIED";
  }
  return finish({
    version: BUY_AMOUNT_POLICY_VERSION,
    result: reason === "AVAILABLE_CASH_CAP_APPLIED"
      ? "CAPPED"
      : finalAmount === input.calculatedAmountMicros
        ? "UNCHANGED"
        : reason === "SMALL_BUY_HARD_CAP_APPLIED" ? "CAPPED" : "LIFTED",
    reason,
    calculatedAmountMicros: input.calculatedAmountMicros.toString(),
    finalAmountMicros: finalAmount.toString(),
    policyClass: input.policyClass,
    firstEntryMinimumAmountMicros: input.firstEntryMinimumAmountMicros.toString(),
    marketMinimumAmountMicros: marketMinimum?.toString() ?? null,
    marketMinimumAutoLiftCapMicros: input.marketMinimumAutoLiftCapMicros.toString(),
    availableCashCapMicros: availableCashCap?.toString() ?? null,
  });
}

function currentDecisionValid(value: CurrentBuyAmountPolicyDecision): boolean {
  try {
    if (value.version !== BUY_AMOUNT_POLICY_VERSION) return false;
    const expected = applyBuyAmountPolicy({
      calculatedAmountMicros: BigInt(value.calculatedAmountMicros),
      policyClass: value.policyClass,
      firstEntryMinimumAmountMicros: BigInt(value.firstEntryMinimumAmountMicros),
      marketMinimumAmountMicros: value.marketMinimumAmountMicros === null
        ? null
        : BigInt(value.marketMinimumAmountMicros),
      marketMinimumAutoLiftCapMicros: BigInt(value.marketMinimumAutoLiftCapMicros),
      availableCashCapMicros: value.availableCashCapMicros === null
        ? null
        : BigInt(value.availableCashCapMicros),
    });
    return stableJson(expected) === stableJson(value);
  } catch {
    return false;
  }
}

function priorDecisionValid(value: PriorBuyAmountPolicyDecision): boolean {
  try {
    if (value.version !== PRIOR_BUY_AMOUNT_POLICY_VERSION) return false;
    const expected = applyPriorBuyAmountPolicy({
      calculatedAmountMicros: BigInt(value.calculatedAmountMicros),
      minimumLiftEligibility: value.minimumLiftEligibility,
      firstEntryMinimumAmountMicros: BigInt(value.firstEntryMinimumAmountMicros),
      marketMinimumAmountMicros: value.marketMinimumAmountMicros === null
        ? null
        : BigInt(value.marketMinimumAmountMicros),
      marketMinimumAutoLiftCapMicros: BigInt(value.marketMinimumAutoLiftCapMicros),
      availableCashCapMicros: value.availableCashCapMicros === null
        ? null
        : BigInt(value.availableCashCapMicros),
    });
    return stableJson(expected) === stableJson(value);
  } catch {
    return false;
  }
}

export function applyPriorBuyAmountPolicy(input: {
  calculatedAmountMicros: bigint;
  minimumLiftEligibility: BuyMinimumLiftEligibility;
  firstEntryMinimumAmountMicros: bigint;
  marketMinimumAmountMicros?: bigint | null;
  marketMinimumAutoLiftCapMicros: bigint;
  availableCashCapMicros?: bigint | null;
}): PriorBuyAmountPolicyDecision {
  if (
    input.calculatedAmountMicros < 0n
    || !(["FIRST_ENTRY", "AMPLIFIED_POSITION", "NONE"] as const).includes(input.minimumLiftEligibility)
    || input.firstEntryMinimumAmountMicros <= 0n
    || input.marketMinimumAutoLiftCapMicros < input.firstEntryMinimumAmountMicros
    || (input.marketMinimumAmountMicros !== undefined
      && input.marketMinimumAmountMicros !== null
      && input.marketMinimumAmountMicros <= 0n)
    || (input.availableCashCapMicros !== undefined
      && input.availableCashCapMicros !== null
      && input.availableCashCapMicros < 0n)
  ) throw new Error("BUY_AMOUNT_POLICY_INPUT_INVALID");
  let finalAmount = input.calculatedAmountMicros;
  let reason: PriorBuyAmountPolicyDecision["reason"] = "CALCULATED_AMOUNT_RETAINED";
  if (input.minimumLiftEligibility !== "NONE" && finalAmount < input.firstEntryMinimumAmountMicros) {
    finalAmount = input.firstEntryMinimumAmountMicros;
    reason = input.minimumLiftEligibility === "FIRST_ENTRY"
      ? "FIRST_ENTRY_MINIMUM_APPLIED"
      : "AMPLIFIED_POSITION_MINIMUM_APPLIED";
  }
  const marketMinimum = input.marketMinimumAmountMicros ?? null;
  if (
    input.minimumLiftEligibility !== "NONE"
    && marketMinimum !== null
    && marketMinimum > finalAmount
    && marketMinimum <= input.marketMinimumAutoLiftCapMicros
  ) {
    finalAmount = marketMinimum;
    reason = "MARKET_MINIMUM_APPLIED";
  }
  const availableCashCap = input.availableCashCapMicros ?? null;
  if (availableCashCap !== null && finalAmount > availableCashCap) {
    finalAmount = availableCashCap;
    reason = "AVAILABLE_CASH_CAP_APPLIED";
  }
  const payload: Omit<PriorBuyAmountPolicyDecision, "evidenceHash"> = {
    version: PRIOR_BUY_AMOUNT_POLICY_VERSION,
    result: reason === "AVAILABLE_CASH_CAP_APPLIED"
      ? "CAPPED"
      : finalAmount === input.calculatedAmountMicros ? "UNCHANGED" : "LIFTED",
    reason,
    calculatedAmountMicros: input.calculatedAmountMicros.toString(),
    finalAmountMicros: finalAmount.toString(),
    minimumLiftEligibility: input.minimumLiftEligibility,
    firstEntryMinimumAmountMicros: input.firstEntryMinimumAmountMicros.toString(),
    marketMinimumAmountMicros: marketMinimum?.toString() ?? null,
    marketMinimumAutoLiftCapMicros: input.marketMinimumAutoLiftCapMicros.toString(),
    availableCashCapMicros: availableCashCap?.toString() ?? null,
  };
  return {
    ...payload,
    evidenceHash: createHash("sha256").update(stableJson(payload)).digest("hex"),
  };
}

export function isBuyAmountPolicyDecisionValid(value: BuyAmountPolicyDecision): boolean {
  return value.version === BUY_AMOUNT_POLICY_VERSION
    ? currentDecisionValid(value)
    : priorDecisionValid(value);
}

interface LegacyBuyAmountPolicyDecision {
  version: typeof LEGACY_BUY_AMOUNT_POLICY_VERSION;
  result: "UNCHANGED" | "LIFTED" | "CAPPED";
  reason:
    | "CALCULATED_AMOUNT_RETAINED"
    | "FIRST_ENTRY_MINIMUM_APPLIED"
    | "MARKET_MINIMUM_APPLIED"
    | "AVAILABLE_CASH_CAP_APPLIED";
  calculatedAmountMicros: string;
  finalAmountMicros: string;
  firstEntryEligible: boolean;
  firstEntryMinimumAmountMicros: string;
  marketMinimumAmountMicros: string | null;
  marketMinimumAutoLiftCapMicros: string;
  availableCashCapMicros: string | null;
  evidenceHash: string;
}

function legacyDecisionValid(value: LegacyBuyAmountPolicyDecision): boolean {
  try {
    const calculatedAmountMicros = BigInt(value.calculatedAmountMicros);
    const firstEntryMinimumAmountMicros = BigInt(value.firstEntryMinimumAmountMicros);
    const marketMinimumAmountMicros = value.marketMinimumAmountMicros === null
      ? null
      : BigInt(value.marketMinimumAmountMicros);
    const marketMinimumAutoLiftCapMicros = BigInt(value.marketMinimumAutoLiftCapMicros);
    const availableCashCapMicros = value.availableCashCapMicros === null
      ? null
      : BigInt(value.availableCashCapMicros);
    if (
      calculatedAmountMicros < 0n
      || firstEntryMinimumAmountMicros <= 0n
      || marketMinimumAutoLiftCapMicros < firstEntryMinimumAmountMicros
      || (marketMinimumAmountMicros !== null && marketMinimumAmountMicros <= 0n)
      || (availableCashCapMicros !== null && availableCashCapMicros < 0n)
    ) return false;
    let finalAmount = calculatedAmountMicros;
    let reason: LegacyBuyAmountPolicyDecision["reason"] = "CALCULATED_AMOUNT_RETAINED";
    if (value.firstEntryEligible && finalAmount < firstEntryMinimumAmountMicros) {
      finalAmount = firstEntryMinimumAmountMicros;
      reason = "FIRST_ENTRY_MINIMUM_APPLIED";
    }
    if (
      value.firstEntryEligible
      && marketMinimumAmountMicros !== null
      && marketMinimumAmountMicros > finalAmount
      && marketMinimumAmountMicros <= marketMinimumAutoLiftCapMicros
    ) {
      finalAmount = marketMinimumAmountMicros;
      reason = "MARKET_MINIMUM_APPLIED";
    }
    if (availableCashCapMicros !== null && finalAmount > availableCashCapMicros) {
      finalAmount = availableCashCapMicros;
      reason = "AVAILABLE_CASH_CAP_APPLIED";
    }
    const payload: Omit<LegacyBuyAmountPolicyDecision, "evidenceHash"> = {
      version: LEGACY_BUY_AMOUNT_POLICY_VERSION,
      result: reason === "AVAILABLE_CASH_CAP_APPLIED"
        ? "CAPPED"
        : finalAmount === calculatedAmountMicros ? "UNCHANGED" : "LIFTED",
      reason,
      calculatedAmountMicros: calculatedAmountMicros.toString(),
      finalAmountMicros: finalAmount.toString(),
      firstEntryEligible: value.firstEntryEligible,
      firstEntryMinimumAmountMicros: firstEntryMinimumAmountMicros.toString(),
      marketMinimumAmountMicros: marketMinimumAmountMicros?.toString() ?? null,
      marketMinimumAutoLiftCapMicros: marketMinimumAutoLiftCapMicros.toString(),
      availableCashCapMicros: availableCashCapMicros?.toString() ?? null,
    };
    return stableJson({
      ...payload,
      evidenceHash: createHash("sha256").update(stableJson(payload)).digest("hex"),
    }) === stableJson(value);
  } catch {
    return false;
  }
}

/** Accepts immutable v3/v2 evidence so an already-open historical amplified
 * position can safely carry its lineage across a core upgrade. */
export function buyAmountPolicyDecisionCarriesAmplifiedLineage(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as BuyAmountPolicyDecision | LegacyBuyAmountPolicyDecision;
  if (candidate.version === BUY_AMOUNT_POLICY_VERSION) return false;
  if (candidate.version === PRIOR_BUY_AMOUNT_POLICY_VERSION) {
    if (!priorDecisionValid(candidate)) return false;
    if (candidate.minimumLiftEligibility === "AMPLIFIED_POSITION") return true;
    return candidate.minimumLiftEligibility === "FIRST_ENTRY"
      && BigInt(candidate.finalAmountMicros) > BigInt(candidate.calculatedAmountMicros);
  }
  return candidate.version === LEGACY_BUY_AMOUNT_POLICY_VERSION
    && legacyDecisionValid(candidate)
    && candidate.firstEntryEligible
    && BigInt(candidate.finalAmountMicros) > BigInt(candidate.calculatedAmountMicros);
}
