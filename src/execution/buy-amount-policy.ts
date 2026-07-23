import { createHash } from "node:crypto";
import { stableJson } from "../domain/versioning.js";

export const BUY_AMOUNT_POLICY_VERSION = "BUY_AMOUNT_POLICY_V3";
const LEGACY_BUY_AMOUNT_POLICY_VERSION = "BUY_AMOUNT_POLICY_V2";

export type BuyMinimumLiftEligibility = "FIRST_ENTRY" | "AMPLIFIED_POSITION" | "NONE";

export interface BuyAmountPolicyDecision {
  version: typeof BUY_AMOUNT_POLICY_VERSION;
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

function finish(value: Omit<BuyAmountPolicyDecision, "evidenceHash">): BuyAmountPolicyDecision {
  return {
    ...value,
    evidenceHash: createHash("sha256").update(stableJson(value)).digest("hex"),
  };
}

export function applyBuyAmountPolicy(input: {
  calculatedAmountMicros: bigint;
  minimumLiftEligibility: BuyMinimumLiftEligibility;
  firstEntryMinimumAmountMicros: bigint;
  marketMinimumAmountMicros?: bigint | null;
  marketMinimumAutoLiftCapMicros: bigint;
  availableCashCapMicros?: bigint | null;
}): BuyAmountPolicyDecision {
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
  let reason: BuyAmountPolicyDecision["reason"] = "CALCULATED_AMOUNT_RETAINED";
  const minimumLiftEligible = input.minimumLiftEligibility !== "NONE";
  if (minimumLiftEligible && finalAmount < input.firstEntryMinimumAmountMicros) {
    finalAmount = input.firstEntryMinimumAmountMicros;
    reason = input.minimumLiftEligibility === "FIRST_ENTRY"
      ? "FIRST_ENTRY_MINIMUM_APPLIED"
      : "AMPLIFIED_POSITION_MINIMUM_APPLIED";
  }
  const marketMinimum = input.marketMinimumAmountMicros ?? null;
  if (
    minimumLiftEligible
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
  return finish({
    version: BUY_AMOUNT_POLICY_VERSION,
    result: reason === "AVAILABLE_CASH_CAP_APPLIED"
      ? "CAPPED"
      : finalAmount === input.calculatedAmountMicros
        ? "UNCHANGED"
        : "LIFTED",
    reason,
    calculatedAmountMicros: input.calculatedAmountMicros.toString(),
    finalAmountMicros: finalAmount.toString(),
    minimumLiftEligibility: input.minimumLiftEligibility,
    firstEntryMinimumAmountMicros: input.firstEntryMinimumAmountMicros.toString(),
    marketMinimumAmountMicros: marketMinimum?.toString() ?? null,
    marketMinimumAutoLiftCapMicros: input.marketMinimumAutoLiftCapMicros.toString(),
    availableCashCapMicros: availableCashCap?.toString() ?? null,
  });
}

export function isBuyAmountPolicyDecisionValid(value: BuyAmountPolicyDecision): boolean {
  try {
    if (value.version !== BUY_AMOUNT_POLICY_VERSION) return false;
    const expected = applyBuyAmountPolicy({
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

interface LegacyBuyAmountPolicyDecision {
  version: typeof LEGACY_BUY_AMOUNT_POLICY_VERSION;
  result: "UNCHANGED" | "LIFTED" | "CAPPED";
  reason: BuyAmountPolicyDecision["reason"];
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

/** Accepts current and immutable v2 evidence so an already-open amplified
 * position can safely carry its lineage across a core upgrade. */
export function buyAmountPolicyDecisionCarriesAmplifiedLineage(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as BuyAmountPolicyDecision | LegacyBuyAmountPolicyDecision;
  if (candidate.version === BUY_AMOUNT_POLICY_VERSION) {
    if (!isBuyAmountPolicyDecisionValid(candidate)) return false;
    if (candidate.minimumLiftEligibility === "AMPLIFIED_POSITION") return true;
    return candidate.minimumLiftEligibility === "FIRST_ENTRY"
      && BigInt(candidate.finalAmountMicros) > BigInt(candidate.calculatedAmountMicros);
  }
  return candidate.version === LEGACY_BUY_AMOUNT_POLICY_VERSION
    && legacyDecisionValid(candidate)
    && candidate.firstEntryEligible
    && BigInt(candidate.finalAmountMicros) > BigInt(candidate.calculatedAmountMicros);
}
