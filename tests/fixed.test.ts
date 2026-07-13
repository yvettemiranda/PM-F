import { describe, expect, it } from "vitest";
import { decimalToScaled, PRICE_SCALE_DIGITS, scaledToDecimal } from "../src/domain/fixed.js";
import { matchPaperBuy } from "../src/paper/matching.js";
import { conservativeClobBuyFeeMicros, roundedClobPlatformFeeMicros } from "../src/execution/clob-fee.js";

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

describe("paper buy fixed-point rounding", () => {
  it("rounds sub-micro buy notional up so a fill is never undercharged", () => {
    const matched = matchPaperBuy({
      asks: [{ price: "0.5", size: "0.000001" }],
      reservationMicros: 1n,
      lowerPriceUnits: decimalToScaled("0.49", PRICE_SCALE_DIGITS),
      upperPriceUnits: decimalToScaled("0.51", PRICE_SCALE_DIGITS),
      feeRatePpm: 0n,
      feeExponent: 1,
    });

    expect(matched.filledSizeMicros).toBe("1");
    expect(matched.filledNotionalMicros).toBe("1");
    expect(matched.levels).toEqual([{
      priceUnits: "500000000000000000",
      sizeMicros: "1",
      notionalMicros: "1",
    }]);
    expect(matched.complete).toBe(true);
  });
});

describe("CLOB fee ceiling", () => {
  it("uses the 0.5 fee-curve peak for exponent two when a BUY limit is 0.8", () => {
    const sizeMicros = 100_000_000n;
    const feeRateBps = 700n;
    const feeExponent = 2;
    const peak = roundedClobPlatformFeeMicros({
      sizeMicros,
      priceUnits: 500_000_000_000_000_000n,
      feeRateBps,
      feeExponent,
    });
    const atLimit = roundedClobPlatformFeeMicros({
      sizeMicros,
      priceUnits: 800_000_000_000_000_000n,
      feeRateBps,
      feeExponent,
    });

    expect(peak).toBeGreaterThan(atLimit);
    expect(conservativeClobBuyFeeMicros({
      sizeMicros,
      upperPriceUnits: 800_000_000_000_000_000n,
      feeRateBps,
      feeExponent,
    })).toBe(peak);
  });
});
