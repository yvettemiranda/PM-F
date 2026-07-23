import { describe, expect, it } from "vitest";
import { estimateTargetCapital } from "../src/services/capital-estimator.js";

const wallet = "0x0000000000000000000000000000000000000001";
const positions = [{
  proxyWallet: wallet,
  asset: "asset-1",
  conditionId: "0xcondition",
  size: "100",
  avgPrice: "0.4",
  currentValue: "50",
}];

describe("capital estimator", () => {
  it("returns HIGH and a pre-trade BUY capital ratio only when both components are fresh", () => {
    const estimate = estimateTargetCapital({
      walletAddress: wallet,
      identityStatus: "IDENTITY_CONFIRMED",
      syncStatus: "SYNCED",
      positions,
      positionSnapshotTime: "2026-07-07T00:00:00.000Z",
      walletBalanceMicros: 50_000_000n,
      walletBalanceSnapshotTime: "2026-07-07T00:00:00.000Z",
      targetTrade: { price: "0.5", size: "10", timestamp: Date.parse("2026-07-07T00:00:00.000Z") / 1_000 },
    });
    expect(estimate.capitalEstimateStatus).toBe("COMPLETE");
    expect(estimate.capitalConfidence).toBe("HIGH");
    expect(estimate.targetVisibleCapitalMicros).toBe("100000000");
    expect(estimate.targetTradeAmountMicros).toBe("5000000");
    expect(estimate.targetTradeCapitalRatioPpm).toBe("50000");
  });

  it("limits a MEDIUM-confidence fallback to the one-pUSD test amount", () => {
    const estimate = estimateTargetCapital({
      walletAddress: wallet,
      identityStatus: "IDENTITY_CONFIRMED",
      syncStatus: "SYNCED",
      positions,
      positionSnapshotTime: "2026-07-07T00:00:00.000Z",
      walletBalanceMicros: null,
      walletBalanceSnapshotTime: null,
    });
    expect(estimate.capitalEstimateStatus).toBe("INCOMPLETE");
    expect(estimate.capitalConfidence).toBe("MEDIUM");
    expect(estimate.fallbackAmountMicros).toBe("1000000");
  });

  it("returns LOW for MAJOR_DESYNC", () => {
    const estimate = estimateTargetCapital({
      walletAddress: wallet,
      identityStatus: "IDENTITY_CONFIRMED",
      syncStatus: "MAJOR_DESYNC",
      positions,
      positionSnapshotTime: "2026-07-07T00:00:00.000Z",
      walletBalanceMicros: 1n,
      walletBalanceSnapshotTime: "2026-07-07T00:00:00.000Z",
    });
    expect(estimate.capitalEstimateStatus).toBe("FAILED");
    expect(estimate.capitalConfidence).toBe("LOW");
  });

  it("uses the complete calculation content in the estimate identity", () => {
    const input = {
      walletAddress: wallet,
      identityStatus: "IDENTITY_CONFIRMED" as const,
      syncStatus: "SYNCED" as const,
      positions,
      positionSnapshotTime: "2026-07-07T00:00:00.000Z",
      walletBalanceMicros: 50_000_000n,
      walletBalanceSnapshotTime: "2026-07-07T00:00:00.000Z",
    };
    const first = estimateTargetCapital(input);
    const repeated = estimateTargetCapital(input);
    const changed = estimateTargetCapital({
      ...input,
      positions: [{ ...positions[0]!, currentValue: "51" }],
    });

    expect(repeated.capitalEstimateId).toBe(first.capitalEstimateId);
    expect(changed.capitalEstimateId).not.toBe(first.capitalEstimateId);
    expect(changed.targetVisibleCapitalMicros).not.toBe(first.targetVisibleCapitalMicros);
  });
});
