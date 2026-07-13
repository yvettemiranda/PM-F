export const CLOB_FEE_BPS_SCALE = 10_000n;
export const CLOB_FEE_LEDGER_QUANTUM_MICROS = 10n;
const PRICE_SCALE = 1_000_000_000_000_000_000n;

/** Exact integer implementation of the official CLOB platform-fee curve. */
export function roundedClobPlatformFeeMicros(input: {
  sizeMicros: bigint;
  priceUnits: bigint;
  feeRateBps: bigint;
  feeExponent: number;
}): bigint {
  if (input.sizeMicros <= 0n) throw new Error("CLOB_FEE_SIZE_INVALID");
  if (input.feeRateBps < 0n) throw new Error("CLOB_FEE_RATE_INVALID");
  if (input.feeRateBps === 0n) return 0n;
  if (!Number.isSafeInteger(input.feeExponent) || input.feeExponent < 1 || input.feeExponent > 4) {
    throw new Error("CLOB_FEE_EXPONENT_INVALID");
  }
  if (input.priceUnits <= 0n || input.priceUnits >= PRICE_SCALE) {
    throw new Error("CLOB_FILL_PRICE_INVALID");
  }
  const curve = input.priceUnits * (PRICE_SCALE - input.priceUnits);
  const numerator = input.sizeMicros * input.feeRateBps * curve ** BigInt(input.feeExponent);
  const denominatorPerQuantum = CLOB_FEE_BPS_SCALE
    * PRICE_SCALE ** BigInt(2 * input.feeExponent)
    * CLOB_FEE_LEDGER_QUANTUM_MICROS;
  return ((numerator + denominatorPerQuantum / 2n) / denominatorPerQuantum)
    * CLOB_FEE_LEDGER_QUANTUM_MICROS;
}

/**
 * Conservative BUY fee ceiling for a signed limit order. A BUY can receive
 * price improvement below its signed limit, so checking only the limit-price
 * fee is not conservative: [p*(1-p)]^e peaks at p=0.5 for every supported
 * exponent. Evaluate both integer points around that peak when executable.
 */
export function conservativeClobBuyFeeMicros(input: {
  sizeMicros: bigint;
  upperPriceUnits: bigint;
  feeRateBps: bigint;
  feeExponent: number;
}): bigint {
  if (input.upperPriceUnits <= 0n || input.upperPriceUnits >= PRICE_SCALE) {
    throw new Error("CLOB_ORDER_LIMIT_PRICE_INVALID");
  }
  const peakFloor = PRICE_SCALE / 2n;
  const candidates = new Set<bigint>([input.upperPriceUnits]);
  for (const candidate of [peakFloor, peakFloor + 1n]) {
    if (candidate > 0n && candidate <= input.upperPriceUnits && candidate < PRICE_SCALE) {
      candidates.add(candidate);
    }
  }
  let maximum = 0n;
  for (const priceUnits of candidates) {
    const fee = roundedClobPlatformFeeMicros({
      sizeMicros: input.sizeMicros,
      priceUnits,
      feeRateBps: input.feeRateBps,
      feeExponent: input.feeExponent,
    });
    if (fee > maximum) maximum = fee;
  }
  return maximum;
}
