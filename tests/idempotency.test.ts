import { describe, expect, it } from "vitest";
import { sourceEventKey } from "../src/domain/idempotency.js";
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

  it("preserves separate fills in the same transaction when size differs", () => {
    expect(sourceEventKey(base)).not.toBe(sourceEventKey({ ...base, size: "230.98" }));
  });

  it("preserves same-second trades when price differs", () => {
    expect(sourceEventKey(base)).not.toBe(sourceEventKey({ ...base, price: "0.13" }));
  });
});
