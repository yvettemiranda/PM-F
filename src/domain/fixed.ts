const TEN = 10n;

export const PRICE_SCALE_DIGITS = 18;
export const SHARE_SCALE_DIGITS = 6;

export function decimalToScaled(value: string | number, scaleDigits = 6): bigint {
  const input = String(value).trim();
  if (!/^-?\d+(?:\.\d+)?$/.test(input)) {
    throw new Error(`Unsupported decimal: ${input}`);
  }
  const negative = input.startsWith("-");
  const unsigned = negative ? input.slice(1) : input;
  const [whole = "0", fraction = ""] = unsigned.split(".");
  if (fraction.length > scaleDigits) {
    const discarded = fraction.slice(scaleDigits);
    if (!/^0*$/.test(discarded)) throw new Error(`Precision exceeds ${scaleDigits}: ${input}`);
  }
  const padded = fraction.slice(0, scaleDigits).padEnd(scaleDigits, "0");
  const result = BigInt(whole) * TEN ** BigInt(scaleDigits) + BigInt(padded || "0");
  return negative ? -result : result;
}

export function scaledToDecimal(value: bigint, scaleDigits = 6): string {
  const negative = value < 0n;
  const unsigned = negative ? -value : value;
  const scale = TEN ** BigInt(scaleDigits);
  const whole = unsigned / scale;
  const fraction = (unsigned % scale).toString().padStart(scaleDigits, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}
