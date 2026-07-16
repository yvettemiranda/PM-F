import { describe, expect, it } from "vitest";
import {
  evaluateBuyMarketConstraint,
  evaluateSellMarketConstraint,
  orderbookConstraintAvailability,
} from "../src/execution/market-order-constraints.js";

describe("market order constraints", () => {
  it("floors a 974-micro BUY to the SDK two-decimal precision and rejects without amplification", () => {
    const evidence = evaluateBuyMarketConstraint({
      minOrderSize: "5",
      tickSize: "0.01",
      requestedAmountMicros: 974n,
      upperPriceUnits: 510_000_000_000_000_000n,
    });
    expect(evidence.result).toBe("REJECT");
    expect(evidence.reason).toBe("ORDER_AMOUNT_BELOW_EXECUTOR_PRECISION");
    expect(evidence.proposedAmountMicros).toBe("974");
    expect(evidence.normalizedOrderAmountMicros).toBe("0");
  });

  it("checks min_order_size in shares after amount and tick normalization", () => {
    const rejected = evaluateBuyMarketConstraint({
      minOrderSize: "5",
      tickSize: "0.01",
      requestedAmountMicros: 1_000_000n,
      upperPriceUnits: 515_000_000_000_000_000n,
    });
    expect(rejected.effectivePriceUnits).toBe("510000000000000000");
    expect(rejected.result).toBe("REJECT");
    expect(rejected.reason).toBe("BELOW_MARKET_MIN_ORDER_SIZE");
    expect(rejected.derivedMinNotionalMicros).toBe("2550000");
    expect(rejected.normalizedOrderSizeMicros).toBe("1960700");

    const allowed = evaluateBuyMarketConstraint({
      minOrderSize: "5",
      tickSize: "0.01",
      requestedAmountMicros: 3_000_000n,
      upperPriceUnits: 515_000_000_000_000_000n,
    });
    expect(allowed.result).toBe("PASS");
  });

  it("keeps undersized normal and stop exits pending by rejecting the order precondition", () => {
    const evidence = evaluateSellMarketConstraint({
      minOrderSize: "5",
      tickSize: "0.01",
      requestedSizeMicros: 4_999_999n,
      minimumPriceUnits: 451_000_000_000_000_000n,
    });
    expect(evidence.result).toBe("REJECT");
    expect(evidence.reason).toBe("BELOW_MARKET_MIN_ORDER_SIZE");
    expect(evidence.effectivePriceUnits).toBe("460000000000000000");
    expect(evidence.normalizedOrderSizeMicros).toBe("4990000");
  });

  it("fails closed when public order constraints are absent or invalid", () => {
    expect(orderbookConstraintAvailability({ minOrderSize: undefined, tickSize: "0.01" }))
      .toBe("MIN_ORDER_SIZE_UNAVAILABLE");
    expect(orderbookConstraintAvailability({ minOrderSize: "5", tickSize: "0.003" }))
      .toBe("TICK_SIZE_INVALID");
    expect(orderbookConstraintAvailability({ minOrderSize: "5", tickSize: "0.000000000000000001" }))
      .toBe("TICK_SIZE_UNSUPPORTED_BY_CLOB_SDK");
  });
});
