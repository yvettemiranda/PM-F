import { describe, expect, it } from "vitest";
import { decimalToScaled, PRICE_SCALE_DIGITS, scaledToDecimal } from "../src/domain/fixed.js";

describe("fixed-point decimals", () => {
  it("converts prices and sizes without floating-point arithmetic", () => {
    expect(decimalToScaled("0.006")).toBe(6_000n);
    expect(decimalToScaled("64815.39")).toBe(64_815_390_000n);
    expect(scaledToDecimal(64_815_390_000n)).toBe("64815.39");
  });

  it("rejects precision that cannot be represented", () => {
    expect(() => decimalToScaled("0.1234567")).toThrow(/Precision exceeds/);
  });

  it("preserves observed high-precision target prices at 18 decimals", () => {
    expect(decimalToScaled("0.9979640859884049", PRICE_SCALE_DIGITS)).toBe(997_964_085_988_404_900n);
    expect(() => decimalToScaled("0.1234567890123456789", PRICE_SCALE_DIGITS)).toThrow(/Precision exceeds/);
  });
});
