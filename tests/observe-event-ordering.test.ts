import { describe, expect, it } from "vitest";
import type { SourceChainOrder } from "../src/domain/models.js";
import { sourceEventKey } from "../src/domain/idempotency.js";
import { orderObserveEvents, validatedChainOrder } from "../src/observe/event-ordering.js";
import { projectObserveEvents } from "../src/observe/position-projector.js";
import type { ObserveBaseline, ObserveEvent } from "../src/observe/types.js";

const baseline: ObserveBaseline = {
  baselineRunId: "ordering-baseline", targetId: "ordering-target", walletAddress: "0xwallet",
  snapshotTime: "2026-07-08T00:00:00.000Z",
  items: [{ asset: "asset", conditionId: "condition", sizeMicros: "100000000" }],
};
const order = (transactionIndex: string, logIndex = "0x0", lastLogIndex = logIndex): SourceChainOrder => ({
  blockNumber: "0x64", blockHash: `0x${"a".repeat(64)}`, transactionIndex, logIndex, lastLogIndex,
});
function event(key: string, side: "BUY" | "SELL", size: string, timestamp: number, chainOrder?: SourceChainOrder): ObserveEvent {
  return {
    sourceEventKey: key, sourceType: "DATA_API_TRADE", sourceTimestamp: timestamp,
    isGap: false, isCombo: false, activityConfirmed: true, ...(chainOrder ? { chainOrder } : {}),
    trade: { proxyWallet: baseline.walletAddress, transactionHash: key, conditionId: "condition", asset: "asset", side, size, price: "0.5", timestamp },
  };
}

describe("authoritative Observe event order", () => {
  it("uses transaction order for the tracked SELL ratio despite the opposite hash order", () => {
    const projection = projectObserveEvents(baseline, [
      event("prior", "BUY", "10", 1), event("a-buy", "BUY", "20", 2, order("0x1")),
      event("z-sell", "SELL", "20", 2, order("0x0")),
    ]);
    expect(projection.orderingAmbiguities).toEqual([]);
    expect(projection.signals.find((row) => row.signalType === "TARGET_SELL")).toMatchObject({
      sellRatioNumerator: "10000000", sellRatioDenominator: "10000000",
    });
    expect(projection.projection).toEqual([expect.objectContaining({ historicalMicros: "90000000", trackedMicros: "20000000" })]);
  });

  it("withholds affected and later signals when same-second public rows have no proven order", () => {
    const projection = projectObserveEvents(baseline, [event("prior", "BUY", "10", 1),
      event("a-buy", "BUY", "20", 2), event("z-sell", "SELL", "20", 2), event("later", "SELL", "1", 3)]);
    expect(projection.signals.map((row) => row.sourceEventKey)).toEqual(["prior"]);
    expect(projection.orderingAmbiguities).toEqual([{ sourceTimestamp: 2, conditionId: "condition", sourceEventKeys: ["a-buy", "z-sell"] }]);
  });

  it("uses log order for distinct orders in the same transaction", () => {
    const sell = event("z-sell", "SELL", "20", 2, order("0x0", "0x1"));
    const buy = event("a-buy", "BUY", "20", 2, order("0x0", "0x2"));
    const result = orderObserveEvents([buy, sell]);
    expect(result.ordered).toEqual([sell, buy]);
    expect(result.ambiguities).toEqual([]);
  });

  it("does not certify an aggregated order whose fills straddle another economic event", () => {
    const result = projectObserveEvents(baseline, [event("prior", "BUY", "10", 1),
      event("z-sell", "SELL", "20", 2, order("0x0", "0x1", "0x3")),
      event("a-buy", "BUY", "20", 2, order("0x0", "0x2"))]);
    expect(result.orderingAmbiguities).toHaveLength(1);
    expect(result.signals.map((row) => row.sourceEventKey)).toEqual(["prior"]);
  });

  it("keeps confirmed identical multiset executions, whose relative order cannot change ownership", () => {
    const first = event("same", "BUY", "10", 1);
    first.sourceEventKey = sourceEventKey(first.trade!);
    const second = { ...first, sourceEventKey: `${first.sourceEventKey}:occurrence-1` };
    const result = projectObserveEvents(baseline, [second, first]);
    expect(result.orderingAmbiguities).toEqual([]);
    expect(result.signals).toHaveLength(2);
    expect(result.projection[0]?.trackedMicros).toBe("20000000");
  });

  it("does not treat a conversion group id as its source asset's condition id", () => {
    const conversion: ObserveEvent = {
      sourceEventKey: "conversion", sourceType: "DATA_API_ACTIVITY", sourceTimestamp: 2,
      isGap: false, isCombo: false, activityConfirmed: true,
      activity: { proxyWallet: baseline.walletAddress, transactionHash: "conversion", type: "CONVERSION", timestamp: 2 },
      conversion: { transactionHash: "conversion", groupConditionId: "event-group", eventSlug: "event",
        sourceAsset: "asset", destinationAssets: [{ asset: "other", conditionId: "other-condition", amountMicros: "1000000" }],
        amountMicros: "1000000", receiptBlockNumber: "0x64", receiptPayloadHash: "hash", evidenceHash: "hash" },
    };
    expect(orderObserveEvents([conversion, event("buy", "BUY", "10", 2)], new Map([["asset", "condition"]])).ambiguities)
      .toEqual([{ sourceTimestamp: 2, conditionId: "condition", sourceEventKeys: ["buy", "conversion"] }]);
  });

  it("fails closed on competing canonical block hashes", () => {
    expect(() => orderObserveEvents([event("sell", "SELL", "1", 2, order("0x0")),
      event("buy", "BUY", "1", 2, { ...order("0x1"), blockHash: `0x${"b".repeat(64)}` })]))
      .toThrow("OBSERVE_CHAIN_ORDER_BLOCK_CONFLICT");
  });

  it.each([{ ...order("0x0"), transactionIndex: "0x00" }, { ...order("0x0", "0x3"), lastLogIndex: "0x2" }])(
    "rejects noncanonical or reversed chain evidence %j", (value) => {
      expect(() => validatedChainOrder(value)).toThrow("OBSERVE_CHAIN_ORDER_INVALID");
    },
  );
});
