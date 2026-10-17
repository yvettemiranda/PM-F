/** Allocate the next lot from the cumulative asset claim, retaining sub-micro dust. */
export function settlementClaimAmount(input: {
  sizeMicros: bigint;
  numerator: bigint;
  denominator: bigint;
  previouslySettledSizeMicros: bigint;
  previouslyPaidMicros: bigint;
}): { redeemMicros: bigint; aggregateRedeemMicros: bigint } {
  const { sizeMicros, numerator, denominator, previouslySettledSizeMicros, previouslyPaidMicros } = input;
  if (denominator <= 0n || numerator < 0n || numerator > denominator
    || sizeMicros < 0n || previouslySettledSizeMicros < 0n || previouslyPaidMicros < 0n) {
    throw new Error("INVALID_SETTLEMENT_ALLOCATION");
  }
  const priorEntitlement = (previouslySettledSizeMicros * numerator) / denominator;
  if (previouslyPaidMicros > priorEntitlement) throw new Error("SETTLEMENT_PRIOR_PAYOUT_EXCEEDS_ENTITLEMENT");
  const aggregateRedeemMicros = ((previouslySettledSizeMicros + sizeMicros) * numerator) / denominator;
  return { redeemMicros: aggregateRedeemMicros - previouslyPaidMicros, aggregateRedeemMicros };
}
