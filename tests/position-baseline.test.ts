import { describe, expect, it } from "vitest";
import { buildPositionBaseline } from "../src/services/position-baseline.js";

const position = {
  proxyWallet: "0x0000000000000000000000000000000000000001",
  asset: "asset-1",
  conditionId: "0xcondition",
  size: "12.5",
  avgPrice: "0.42",
  currentValue: "5.25",
  title: "Market",
  slug: "market",
  outcome: "Yes",
};

describe("position baseline", () => {
  it("stores canonical market, asset, outcome, size, average price, and snapshot window", () => {
    const baseline = buildPositionBaseline({
      captureRunId: "capture",
      targetId: "target",
      walletAddress: position.proxyWallet,
      positionCaptureId: "positions",
      fetchedAt: "2026-07-07T00:00:01.000Z",
      latencyMs: 250,
      positions: [position],
    });
    expect(baseline.cutoffFrom).toBe("2026-07-07T00:00:00.750Z");
    expect(baseline.items[0]).toMatchObject({
      conditionId: "0xcondition",
      asset: "asset-1",
      outcome: "Yes",
      sizeMicros: "12500000",
      averagePriceUnits: "420000000000000000",
    });
  });

  it("rejects duplicate asset rows", () => {
    expect(() => buildPositionBaseline({
      captureRunId: "capture",
      targetId: "target",
      walletAddress: position.proxyWallet,
      positionCaptureId: "positions",
      fetchedAt: "2026-07-07T00:00:01.000Z",
      latencyMs: 250,
      positions: [position, { ...position }],
    })).toThrow(/Duplicate baseline assets/);
  });
});
