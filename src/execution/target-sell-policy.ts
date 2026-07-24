import type { EventClassification } from "../domain/models.js";

const PPM = 1_000_000n;

export function fullExitThresholdForTargetSell(
  eventClassification: EventClassification,
  configuredThresholdPpm: number,
): number {
  return eventClassification === "STANDARD_TRADE" ? configuredThresholdPpm : Number(PPM);
}

export interface EffectiveTargetSellRatio {
  numerator: bigint;
  denominator: bigint;
  fullExit: boolean;
}

export function effectiveTargetSellRatio(input: {
  numerator: bigint;
  denominator: bigint;
  fullExitThresholdPpm: number;
}): EffectiveTargetSellRatio {
  if (
    input.numerator <= 0n
    || input.denominator <= 0n
    || input.numerator > input.denominator
  ) throw new Error("TARGET_SELL_RATIO_INVALID");
  if (
    !Number.isSafeInteger(input.fullExitThresholdPpm)
    || input.fullExitThresholdPpm <= 0
    || input.fullExitThresholdPpm > Number(PPM)
  ) throw new Error("FOLLOW_SELL_FULL_EXIT_THRESHOLD_INVALID");
  const fullExit = input.numerator * PPM
    >= input.denominator * BigInt(input.fullExitThresholdPpm);
  return {
    numerator: fullExit ? input.denominator : input.numerator,
    denominator: input.denominator,
    fullExit,
  };
}

export function parseEffectiveTargetSellRatio(input: {
  numerator: string | null;
  denominator: string | null;
  fullExitThresholdPpm: number;
}): EffectiveTargetSellRatio | null {
  if (
    input.numerator === null
    || input.denominator === null
    || !/^\d+$/.test(input.numerator)
    || !/^\d+$/.test(input.denominator)
  ) return null;
  try {
    return effectiveTargetSellRatio({
      numerator: BigInt(input.numerator),
      denominator: BigInt(input.denominator),
      fullExitThresholdPpm: input.fullExitThresholdPpm,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "TARGET_SELL_RATIO_INVALID") return null;
    throw error;
  }
}
