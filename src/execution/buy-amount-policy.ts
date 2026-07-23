import { createHash } from "node:crypto";
import { stableJson } from "../domain/versioning.js";

export const BUY_AMOUNT_POLICY_VERSION = "BUY_AMOUNT_POLICY_V2";

export interface BuyAmountPolicyDecision {
  version: typeof BUY_AMOUNT_POLICY_VERSION;
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

function finish(value: Omit<BuyAmountPolicyDecision, "evidenceHash">): BuyAmountPolicyDecision {
  return {
    ...value,
    evidenceHash: createHash("sha256").update(stableJson(value)).digest("hex"),
  };
}

export function applyBuyAmountPolicy(input: {
  calculatedAmountMicros: bigint;
  firstEntryEligible: boolean;
  firstEntryMinimumAmountMicros: bigint;
  marketMinimumAmountMicros?: bigint | null;
  marketMinimumAutoLiftCapMicros: bigint;
  availableCashCapMicros?: bigint | null;
}): BuyAmountPolicyDecision {
  if (
    input.calculatedAmountMicros < 0n
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
  if (input.firstEntryEligible && finalAmount < input.firstEntryMinimumAmountMicros) {
    finalAmount = input.firstEntryMinimumAmountMicros;
    reason = "FIRST_ENTRY_MINIMUM_APPLIED";
  }
  const marketMinimum = input.marketMinimumAmountMicros ?? null;
  if (
    input.firstEntryEligible
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
    firstEntryEligible: input.firstEntryEligible,
    firstEntryMinimumAmountMicros: input.firstEntryMinimumAmountMicros.toString(),
    marketMinimumAmountMicros: marketMinimum?.toString() ?? null,
    marketMinimumAutoLiftCapMicros: input.marketMinimumAutoLiftCapMicros.toString(),
    availableCashCapMicros: availableCashCap?.toString() ?? null,
  });
}

export function isBuyAmountPolicyDecisionValid(value: BuyAmountPolicyDecision): boolean {
  try {
    const expected = applyBuyAmountPolicy({
      calculatedAmountMicros: BigInt(value.calculatedAmountMicros),
      firstEntryEligible: value.firstEntryEligible,
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
