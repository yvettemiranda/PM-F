import { describe, expect, it } from "vitest";
import { RULESET } from "../src/domain/versioning.js";
import { projectObserveEvents } from "../src/observe/position-projector.js";
import type { ObserveBaseline, ObserveEvent } from "../src/observe/types.js";

const baseline: ObserveBaseline = {
  baselineRunId: "baseline-sell-threshold",
  targetId: "target-sell-threshold",
  walletAddress: "0x0000000000000000000000000000000000000001",
  snapshotTime: "2026-07-08T00:00:00.000Z",
  items: [],
};

function tradeEvent(
  sourceEventKey: string,
  side: "BUY" | "SELL",
  size: string,
  sourceTimestamp: number,
): ObserveEvent {
  return {
    sourceEventKey,
    sourceType: "DATA_API_TRADE",
    sourceTimestamp,
    isGap: false,
    isCombo: false,
    activityConfirmed: true,
    trade: {
      proxyWallet: baseline.walletAddress,
      transactionHash: `0x${sourceTimestamp.toString(16).padStart(64, "0")}`,
      conditionId: "0xcondition",
      asset: "asset-sell-threshold",
      side,
      price: "0.5",
      size,
      timestamp: sourceTimestamp,
    },
  };
}

describe("projectObserveEvents SELL full-exit threshold", () => {
  it("keeps 94.9999% proportional but treats 95% as a complete followed-position exit", () => {
    const buy = tradeEvent("buy-100", "BUY", "100", 1);
    const below = projectObserveEvents(baseline, [
      buy,
      tradeEvent("sell-below-95", "SELL", "94.9999", 2),
    ], { followSellFullExitThresholdPpm: RULESET.followSellFullExitThresholdPpm });

    expect(below.signals.at(-1)).toMatchObject({
      signalType: "TARGET_SELL",
      sellRatioNumerator: "94999900",
      sellRatioDenominator: "100000000",
    });
    expect(below.projection).toEqual([expect.objectContaining({
      historicalMicros: "0",
      trackedMicros: "5000100",
      expectedTotalMicros: "5000100",
    })]);

    const atThreshold = projectObserveEvents(baseline, [
      buy,
      tradeEvent("sell-at-95", "SELL", "95", 2),
    ], { followSellFullExitThresholdPpm: RULESET.followSellFullExitThresholdPpm });

    expect(atThreshold.signals.at(-1)).toMatchObject({
      signalType: "TARGET_SELL",
      sellRatioNumerator: "100000000",
      sellRatioDenominator: "100000000",
    });
    expect(atThreshold.projection).toEqual([expect.objectContaining({
      historicalMicros: "5000000",
      trackedMicros: "0",
      expectedTotalMicros: "5000000",
    })]);
  });
});
