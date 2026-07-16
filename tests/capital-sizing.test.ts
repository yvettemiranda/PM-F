import { describe, expect, it } from "vitest";
import {
  buildExactCapitalRatio,
  calculateBuyCapitalSizing,
  capitalSizingHash,
} from "../src/execution/capital-sizing.js";

const high = {
  status: "COMPLETE" as const,
  confidence: "HIGH" as const,
  ratioPpm: "0",
  fallbackAmountMicros: "10000000",
};

describe("exact capital sizing", () => {
  it("preserves a valid sub-1-ppm ratio until the final pUSD-micro floor", () => {
    const ratio = buildExactCapitalRatio({
      targetPriceUnits: "500000000000000000",
      targetSizeMicros: "2460160",
      targetVisibleCapitalMicros: "1261997070000",
    });
    expect(ratio.targetTradeAmountMicros).toBe("1230080");
    expect(ratio.legacyRatioPpm).toBe("0");
    expect(ratio.ratioDecimal).toMatch(/^0\.000000974/);
    expect(ratio.ratioPpmDecimal).toMatch(/^0\.974/);

    const decision = calculateBuyCapitalSizing({
      accountCapitalMicros: 1_000_000_000n,
      capitalDecision: high,
      exactRatio: ratio,
      exactRatioHash: capitalSizingHash(ratio),
    });
    expect(decision.result).toBe("CALCULATED");
    expect(decision.calculatedAmountMicros).toBe("974");
    expect(decision.ratioPpmDecimal).toBe(ratio.ratioPpmDecimal);
    expect(decision.roundingMode).toBe("FLOOR_ONCE_AT_PUSD_MICRO");
    expect(BigInt(decision.remainderNumerator!)).toBeGreaterThan(0n);
  });

  it("rejects rather than amplifying a positive ratio below account precision", () => {
    const ratio = buildExactCapitalRatio({
      targetPriceUnits: "100000000000000000",
      targetSizeMicros: "1",
      targetVisibleCapitalMicros: "999999999999999999",
    });
    const decision = calculateBuyCapitalSizing({
      accountCapitalMicros: 1_000_000_000n,
      capitalDecision: high,
      exactRatio: ratio,
      exactRatioHash: capitalSizingHash(ratio),
    });
    expect(decision.result).toBe("REJECTED");
    expect(decision.calculatedAmountMicros).toBe("0");
    expect(decision.reason).toBe("PROPORTIONAL_AMOUNT_BELOW_ACCOUNT_PRECISION");
  });

  it("fails closed when immutable exact-ratio evidence is changed", () => {
    const ratio = buildExactCapitalRatio({
      targetPriceUnits: "500000000000000000",
      targetSizeMicros: "10000000",
      targetVisibleCapitalMicros: "1000000000",
    });
    const decision = calculateBuyCapitalSizing({
      accountCapitalMicros: 1_000_000_000n,
      capitalDecision: high,
      exactRatio: { ...ratio, targetSizeMicros: "10000001" },
      exactRatioHash: capitalSizingHash(ratio),
    });
    expect(decision.result).toBe("REJECTED");
    expect(decision.reason).toBe("CAPITAL_SIZING_HASH_MISMATCH");
  });

  it("keeps deterministic legacy ppm semantics for historical contexts only", () => {
    const decision = calculateBuyCapitalSizing({
      accountCapitalMicros: 1_000_000_000n,
      capitalDecision: { ...high, ratioPpm: "100000" },
      exactRatio: null,
      exactRatioHash: null,
    });
    expect(decision.calculationVersion).toBe("LEGACY_PPM_V1");
    expect(decision.calculatedAmountMicros).toBe("100000000");
  });
});
