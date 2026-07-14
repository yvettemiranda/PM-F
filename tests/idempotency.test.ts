import { describe, expect, it } from "vitest";
import {
  resolveSourceEventMultiplicity,
  resolvedSourceEventTradeMap,
  sourceEventKey,
  sourceEventOccurrences,
} from "../src/domain/idempotency.js";
import type { PublicTrade } from "../src/domain/models.js";

const base: PublicTrade = {
  proxyWallet: "0x0000000000000000000000000000000000000001",
  transactionHash: "0xabc",
  conditionId: "0xcondition",
  asset: "asset-1",
  side: "SELL",
  price: "0.12",
  size: "541.37",
  timestamp: 1_783_372_955,
};

describe("source event identity", () => {
  it("collapses an exact repeated API row", () => {
    expect(sourceEventKey(base)).toBe(sourceEventKey({ ...base }));
  });

  it("assigns stable occurrence keys to identical fills without changing the first key", () => {
    const occurrences = sourceEventOccurrences([base, { ...base }]);
    expect(occurrences.map((item) => item.sourceEventKey)).toEqual([
      sourceEventKey(base),
      sourceEventKey(base, 1),
    ]);
    expect(occurrences[0]?.sourceEventKey).not.toBe(occurrences[1]?.sourceEventKey);
    expect(sourceEventOccurrences([{ ...base }, base]).map((item) => item.sourceEventKey))
      .toEqual(occurrences.map((item) => item.sourceEventKey));
  });

  it("confirms repeated occurrences by matching Trades and Activity multiplicity", () => {
    const confirmed = resolveSourceEventMultiplicity(
      [base, { ...base }],
      [{ ...base }, base],
    );
    expect(confirmed.confirmedRepeatedKeys).toEqual([sourceEventKey(base, 1)]);
    expect(confirmed.ambiguousRepeatedKeys).toEqual([]);

    const mismatched = resolveSourceEventMultiplicity([base, { ...base }], [base]);
    expect(mismatched.confirmedRepeatedKeys).toEqual([]);
    expect(mismatched.ambiguousRepeatedKeys).toEqual([sourceEventKey(base, 1)]);
    expect([...resolvedSourceEventTradeMap(
      [base, { ...base }],
      [{ ...base }, base],
    ).keys()]).toEqual([sourceEventKey(base), sourceEventKey(base, 1)]);
  });

  it("preserves separate fills in the same transaction when size differs", () => {
    expect(sourceEventKey(base)).not.toBe(sourceEventKey({ ...base, size: "230.98" }));
  });

  it("preserves same-second trades when price differs", () => {
    expect(sourceEventKey(base)).not.toBe(sourceEventKey({ ...base, price: "0.13" }));
  });
});
