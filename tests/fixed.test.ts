import { describe, expect, it } from "vitest";
import { decimalToScaled, PRICE_SCALE_DIGITS, scaledToDecimal } from "../src/domain/fixed.js";
import { feeInclusiveBuyVwapPriceUnits, matchPaperBuy } from "../src/paper/matching.js";
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

  it("uses the charged level notionals when computing the fee-inclusive BUY VWAP", () => {
    const matched = matchPaperBuy({
      asks: [{ price: "0.525", size: "5.000001" }],
      reservationMicros: 3_000_000n,
      lowerPriceUnits: decimalToScaled("0.5", PRICE_SCALE_DIGITS),
      upperPriceUnits: decimalToScaled("0.53", PRICE_SCALE_DIGITS),
      feeRatePpm: 0n,
      feeExponent: 1,
    });
    const expected = (2_625_001n * 10n ** 18n + 5_000_001n - 1n) / 5_000_001n;
    expect(matched.filledNotionalMicros).toBe("2625001");
    expect(feeInclusiveBuyVwapPriceUnits(matched)).toBe(expected);
    expect(expected).toBeGreaterThan(decimalToScaled("0.525", PRICE_SCALE_DIGITS));
  });
});

describe("CLOB fee ceiling", () => {
  it("bounds cash BUY fees at the fee/notional peak and includes fragmented-fill rounding", () => {
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
    })).toBe(1_659_260n);
  });

  it("covers price improvement across every supported exponent", () => {
    const notional = 5_000_000n;
    for (const exponent of [1, 2, 3, 4]) {
      const ceiling = conservativeClobBuyFeeMicros({
        amountMicros: notional, sizeMicros: 6_250_000n,
        upperPriceUnits: 800_000_000_000_000_000n, feeRateBps: 700n, feeExponent: exponent,
      });
      for (let tick = 1n; tick <= 800n; tick += 7n) {
        const price = tick * 1_000_000_000_000_000n;
        const size = (notional * 1_000_000_000_000_000_000n) / price;
        expect(roundedClobPlatformFeeMicros({
          sizeMicros: size, priceUnits: price, feeRateBps: 700n, feeExponent: exponent,
        })).toBeLessThanOrEqual(ceiling);
      }
    }
  });

  it("covers tiny fills which round up separately", () => {
    const fee = roundedClobPlatformFeeMicros({
      sizeMicros: 7_300n, priceUnits: 10_000_000_000_000_000n, feeRateBps: 700n, feeExponent: 1,
    });
    expect(fee).toBe(10n);
    expect(conservativeClobBuyFeeMicros({
      amountMicros: 7_300n, sizeMicros: 14_600n,
      upperPriceUnits: 500_000_000_000_000_000n, feeRateBps: 700n, feeExponent: 1,
    })).toBeGreaterThanOrEqual(100n * fee);
  });
});
