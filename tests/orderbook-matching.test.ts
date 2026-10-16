import { describe, expect, it } from "vitest";
import { scaledToDecimal } from "../src/domain/fixed.js";
import {
  matchExecutionBuy,
  quoteExecutionBuySize,
} from "../src/execution/orderbook-matching.js";

describe("budgeted orderbook matching", () => {
  it("matches exhaustive size quotes across fee rounding and depth boundaries", () => {
    const asks = [
      { price: "0.6", size: "0.000019" },
      { price: "0.25", size: "0.000027" },
      { price: "0.4", size: "0.000031" },
    ];
    for (const feeRatePpm of [0n, 100_000n, 1_000_000n]) {
      for (const feeExponent of [1, 2, 3, 4]) {
        for (const reservationMicros of [0n, 1n, 4n, 9n, 10n, 17n, 28n, 40n, 100n]) {
          const input = {
            asks,
            reservationMicros,
            lowerPriceUnits: 100_000_000_000_000_000n,
            upperPriceUnits: 900_000_000_000_000_000n,
            feeRatePpm,
            feeExponent,
          };
          let expected = quoteExecutionBuySize({ ...input, requestedSizeMicros: 0n });
          // Exhaust every possible microshare quantity, independently of the
          // budget matcher's per-level search and prefix accumulators.
          for (let size = 1n; size <= 77n; size += 1n) {
            const quote = quoteExecutionBuySize({ ...input, requestedSizeMicros: size });
            if (BigInt(quote.filledNotionalMicros) + BigInt(quote.feeMicros) <= reservationMicros) {
              expected = quote;
            }
          }
          const consumed = BigInt(expected.filledNotionalMicros) + BigInt(expected.feeMicros);
          expect(matchExecutionBuy(input)).toEqual({
            ...expected,
            complete: consumed >= reservationMicros - 1n,
          });
        }
      }
    }
  });

  it("uses the entire cash budget without crossing the next microshare or price ceiling", () => {
    const asks = Array.from({ length: 160 }, (_, index) => ({
      price: scaledToDecimal(BigInt(index + 100), 3),
      size: scaledToDecimal(BigInt(1_123_457 + index * 97)),
    }));
    const input = {
      asks,
      reservationMicros: 12_345_678n,
      lowerPriceUnits: 100_000_000_000_000_000n,
      upperPriceUnits: 240_000_000_000_000_000n,
      feeRatePpm: 62_500n,
      feeExponent: 2,
    };
    const match = matchExecutionBuy(input);
    const size = BigInt(match.filledSizeMicros);
    expect(match.levels.length).toBeGreaterThan(50);
    expect(match.levels.every((level) => BigInt(level.priceUnits) <= input.upperPriceUnits)).toBe(true);
    expect(BigInt(match.filledNotionalMicros) + BigInt(match.feeMicros)).toBeLessThanOrEqual(input.reservationMicros);
    const next = quoteExecutionBuySize({ ...input, requestedSizeMicros: size + 1n });
    expect(next.complete).toBe(true);
    expect(BigInt(next.filledNotionalMicros) + BigInt(next.feeMicros)).toBeGreaterThan(input.reservationMicros);
  });
});
