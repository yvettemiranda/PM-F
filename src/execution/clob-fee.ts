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
 * Cash BUY fee ceiling, including arbitrary partial-fill fragmentation.
 *
 * The signed maker amount caps notional, while takerAmount is a minimum
 * receive at the limit price. For notional N the raw fee is
 * N * rate * p^(e-1) * (1-p)^e, maximized at (e-1)/(2e-1).
 * Use that exact rational maximum (or the smaller limit when below it).
 * Independently rounded positive fees are at most twice their raw fee:
 * round_q(x) <= 2*x, including x=q/2. Thus this bound also covers many tiny
 * fills, without assuming a maximum number of counterparties or caching fees.
 */
export function conservativeClobBuyFeeMicros(input: {
  sizeMicros: bigint;
  /** Exact signed maker cash; legacy callers derive it at the limit. */
  amountMicros?: bigint;
  upperPriceUnits: bigint;
  feeRateBps: bigint;
  feeExponent: number;
}): bigint {
  if (input.upperPriceUnits <= 0n || input.upperPriceUnits >= PRICE_SCALE) {
    throw new Error("CLOB_ORDER_LIMIT_PRICE_INVALID");
  }
  if (input.sizeMicros <= 0n) throw new Error("CLOB_FEE_SIZE_INVALID");
  if (input.feeRateBps < 0n) throw new Error("CLOB_FEE_RATE_INVALID");
  const amount = input.amountMicros
    ?? (input.sizeMicros * input.upperPriceUnits + PRICE_SCALE - 1n) / PRICE_SCALE;
  if (amount <= 0n) throw new Error("CLOB_FEE_NOTIONAL_INVALID");
  if (input.feeRateBps === 0n) return 0n;
  if (!Number.isSafeInteger(input.feeExponent) || input.feeExponent < 1 || input.feeExponent > 4) {
    throw new Error("CLOB_FEE_EXPONENT_INVALID");
  }
  const e = BigInt(input.feeExponent);
  const peakNumerator = e - 1n;
  const peakDenominator = 2n * e - 1n;
  const belowPeak = input.upperPriceUnits * peakDenominator < peakNumerator * PRICE_SCALE;
  const numerator = belowPeak
    ? input.upperPriceUnits ** (e - 1n) * (PRICE_SCALE - input.upperPriceUnits) ** e
    : peakNumerator ** (e - 1n) * e ** e;
  const denominator = belowPeak
    ? PRICE_SCALE ** (2n * e - 1n)
    : peakDenominator ** (2n * e - 1n);
  const feeNumerator = 2n * amount * input.feeRateBps * numerator;
  const feeDenominator = CLOB_FEE_BPS_SCALE * denominator;
  return (feeNumerator + feeDenominator - 1n) / feeDenominator;
}
