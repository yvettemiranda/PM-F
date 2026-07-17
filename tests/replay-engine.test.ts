import { describe, expect, it } from "vitest";
import type { PublicTrade } from "../src/domain/models.js";
import { ReplayEngine } from "../src/replay/replay-engine.js";

const wallet = "0x0000000000000000000000000000000000000001";
const trade = (overrides: Partial<PublicTrade>): PublicTrade => ({
  proxyWallet: wallet,
  transactionHash: "0x1",
  conditionId: "0xcondition",
  asset: "asset-1",
  side: "BUY",
  price: "0.5",
  size: "100",
  timestamp: 100,
  ...overrides,
});

describe("ReplayEngine", () => {
  it("deduplicates exact rows but preserves distinct fills", () => {
    const first = trade({});
    const report = new ReplayEngine().run({
      targetId: "target-1",
      walletAddress: wallet,
      identityStatus: "IDENTITY_CONFIRMED",
      trades: [first, { ...first }, trade({ size: "20" })],
      activity: [],
      hasCapitalSnapshots: true,
      hasGoldenExpectations: true,
    });
    expect(report.metrics.inputRows).toBe(3);
    expect(report.metrics.uniqueEvents).toBe(2);
    expect(report.metrics.duplicateRows).toBe(1);
    expect(report.metrics.buySignals).toBe(2);
    expect(report.status).toBe("INCOMPLETE");
    expect(report.incompleteReasons).toContain("AMBIGUOUS_DUPLICATE_EVENTS");
  });

  it("does not let one Activity row confirm a second identical Trades occurrence", () => {
    const first = trade({});
    const report = new ReplayEngine().run({
      targetId: "target-1",
      walletAddress: wallet,
      identityStatus: "IDENTITY_CONFIRMED",
      trades: [first, { ...first }],
      activity: [{ ...first, type: "TRADE" }],
      hasCapitalSnapshots: true,
      hasGoldenExpectations: true,
    });

    expect(report.status).toBe("INCOMPLETE");
    expect(report.metrics.duplicateRows).toBe(1);
    expect(report.metrics.confirmedDuplicateRows).toBe(0);
    expect(report.metrics.ambiguousEvents).toBe(1);
    expect(report.metrics.uniqueEvents).toBe(1);
    expect(report.incompleteReasons).toContain("AMBIGUOUS_DUPLICATE_EVENTS");
  });

  it("preserves a repeated fill when Trades and Activity confirm the same multiplicity", () => {
    const first = trade({});
    const activityTrade = { ...first, type: "TRADE" };
    const report = new ReplayEngine().run({
      targetId: "target-1",
      walletAddress: wallet,
      identityStatus: "IDENTITY_CONFIRMED",
      trades: [first, { ...first }],
      activity: [activityTrade, { ...activityTrade }],
      hasCapitalSnapshots: true,
      hasGoldenExpectations: true,
    });

    expect(report.status).toBe("PASSED");
    expect(report.metrics.duplicateRows).toBe(2);
    expect(report.metrics.confirmedDuplicateRows).toBe(1);
    expect(report.metrics.ambiguousEvents).toBe(0);
    expect(report.metrics.uniqueEvents).toBe(2);
    expect(report.metrics.buySignals).toBe(2);
    expect(new Set(report.signals.map((signal) => signal.sourceEventKey)).size).toBe(2);
  });

  it("replays an Activity-only TRADE instead of silently dropping it", () => {
    const activityTrade = { ...trade({ transactionHash: "0xactivity-only" }), type: "TRADE" };
    const report = new ReplayEngine().run({
      targetId: "target-1",
      walletAddress: wallet,
      identityStatus: "IDENTITY_CONFIRMED",
      trades: [],
      activity: [activityTrade],
      hasCapitalSnapshots: true,
      hasGoldenExpectations: true,
    });

    expect(report.status).toBe("PASSED");
    expect(report.metrics.inputRows).toBe(1);
    expect(report.metrics.uniqueEvents).toBe(1);
    expect(report.metrics.buySignals).toBe(1);
    expect(report.signals[0]).toMatchObject({
      sourceEventKey: expect.any(String),
      executionEligible: true,
      signalType: "TARGET_BUY",
    });
  });

  it("marks an Activity-only duplicate as ambiguous instead of silently hiding it", () => {
    const activityTrade = { ...trade({ transactionHash: "0xactivity-duplicate" }), type: "TRADE" };
    const report = new ReplayEngine().run({
      targetId: "target-1",
      walletAddress: wallet,
      identityStatus: "IDENTITY_CONFIRMED",
      trades: [],
      activity: [activityTrade, { ...activityTrade }],
      hasCapitalSnapshots: true,
      hasGoldenExpectations: true,
    });

    expect(report.metrics.inputRows).toBe(2);
    expect(report.metrics.uniqueEvents).toBe(1);
    expect(report.metrics.duplicateRows).toBe(1);
    expect(report.metrics.confirmedDuplicateRows).toBe(0);
    expect(report.metrics.ambiguousEvents).toBe(1);
    expect(report.status).toBe("INCOMPLETE");
    expect(report.incompleteReasons).toContain("AMBIGUOUS_DUPLICATE_EVENTS");
  });

  it("does not let one Trades row confirm a second identical Activity occurrence", () => {
    const first = trade({ transactionHash: "0xactivity-confirmed-duplicate" });
    const activityTrade = { ...first, type: "TRADE" };
    const report = new ReplayEngine().run({
      targetId: "target-1",
      walletAddress: wallet,
      identityStatus: "IDENTITY_CONFIRMED",
      trades: [first],
      activity: [activityTrade, { ...activityTrade }],
      hasCapitalSnapshots: true,
      hasGoldenExpectations: true,
    });

    expect(report.metrics.duplicateRows).toBe(1);
    expect(report.metrics.confirmedDuplicateRows).toBe(0);
    expect(report.metrics.ambiguousEvents).toBe(1);
    expect(report.metrics.uniqueEvents).toBe(1);
    expect(report.status).toBe("INCOMPLETE");
  });

  it("replays the confirmed repeated fills that caused the 24-hour Observe desync", () => {
    const repeatedSell = trade({
      transactionHash: "0x31add6643877a7ed3aea1d8507e377ebc1efbd663cfdb6dc3c57837c3301affc",
      side: "SELL",
      price: "0.997",
      size: "15712.79",
      timestamp: 1783902581,
    });
    const aggregateSell = trade({
      ...repeatedSell,
      size: "31425.58",
    });
    const trades = [repeatedSell, { ...repeatedSell }, aggregateSell];
    const activity = trades.map((item) => ({ ...item, type: "TRADE" }));
    const input = {
      targetId: "target-1",
      walletAddress: wallet,
      identityStatus: "IDENTITY_CONFIRMED" as const,
      positionBaseline: [{ asset: "asset-1", size: "62851.16" }],
      hasPositionBaseline: true,
      hasCapitalSnapshots: true,
      hasGoldenExpectations: true,
    };
    const report = new ReplayEngine().run({ ...input, trades, activity });
    const reordered = new ReplayEngine().run({
      ...input,
      trades: [aggregateSell, ...trades.slice(0, 2).reverse()],
      activity: [...activity].reverse(),
    });

    expect(report.status).toBe("PASSED");
    expect(report.metrics).toMatchObject({
      uniqueEvents: 3,
      duplicateRows: 2,
      confirmedDuplicateRows: 1,
      ambiguousEvents: 0,
      historicalSells: 3,
      finalHistoricalPositions: {},
    });
    expect(report.positionLedger).toHaveLength(3);
    expect(reordered.reportHash).toBe(report.reportHash);
  });

  it("computes sell ratio before applying the sell", () => {
    const report = new ReplayEngine().run({
      targetId: "target-1",
      walletAddress: wallet,
      identityStatus: "IDENTITY_CONFIRMED",
      trades: [
        trade({ transactionHash: "0xbuy", size: "100", timestamp: 100 }),
        trade({ transactionHash: "0xsell", side: "SELL", size: "30", timestamp: 101 }),
      ],
      activity: [],
      hasCapitalSnapshots: true,
      hasGoldenExpectations: true,
    });
    const sell = report.signals.find((signal) => signal.signalType === "TARGET_SELL");
    expect(sell?.sellRatioNumerator).toBe("30000000");
    expect(sell?.sellRatioDenominator).toBe("100000000");
    expect(report.metrics.finalRecognizedPositions["asset-1"]).toBe("70000000");
  });

  it("records a gap behavior signal that is never execution eligible", () => {
    const report = new ReplayEngine().run({
      targetId: "target-1",
      walletAddress: wallet,
      identityStatus: "IDENTITY_CONFIRMED",
      trades: [trade({ timestamp: 100 })],
      activity: [],
      gaps: [{ fromTimestamp: 99, toTimestamp: 101 }],
      hasCapitalSnapshots: true,
      hasGoldenExpectations: true,
    });
    expect(report.metrics.gapEvents).toBe(1);
    expect(report.signals).toHaveLength(1);
    expect(report.signals[0]?.executionEligible).toBe(false);
    expect(report.signals[0]?.executionBlockReason).toBe("GAP_EVENT");
    expect(report.metrics.finalRecognizedPositions["asset-1"]).toBeUndefined();
    expect(report.metrics.finalHistoricalPositions["asset-1"]).toBe("100000000");
  });

  it("consumes post-baseline tracked shares before historical baseline shares", () => {
    const report = new ReplayEngine().run({
      targetId: "target-1",
      walletAddress: wallet,
      identityStatus: "IDENTITY_CONFIRMED",
      positionBaseline: [{ asset: "asset-1", size: "100" }],
      trades: [
        trade({ transactionHash: "0xbuy", size: "10", timestamp: 100 }),
        trade({ transactionHash: "0xsell", side: "SELL", size: "50", timestamp: 101 }),
      ],
      activity: [],
      hasCapitalSnapshots: true,
      hasGoldenExpectations: true,
      hasPositionBaseline: true,
    });
    const sell = report.signals.find((signal) => signal.signalType === "TARGET_SELL");
    expect(sell?.sellRatioNumerator).toBe("10000000");
    expect(sell?.sellRatioDenominator).toBe("10000000");
    expect(report.metrics.finalRecognizedPositions["asset-1"]).toBeUndefined();
    expect(report.metrics.finalHistoricalPositions["asset-1"]).toBe("60000000");
  });

  it("does not turn a gap buy into a later executable tracked position", () => {
    const report = new ReplayEngine().run({
      targetId: "target-1",
      walletAddress: wallet,
      identityStatus: "IDENTITY_CONFIRMED",
      trades: [
        trade({ transactionHash: "0xgap", size: "10", timestamp: 100 }),
        trade({ transactionHash: "0xsell", side: "SELL", size: "5", timestamp: 102 }),
      ],
      activity: [],
      gaps: [{ fromTimestamp: 99, toTimestamp: 101 }],
      hasCapitalSnapshots: true,
      hasGoldenExpectations: true,
    });
    expect(report.signals).toHaveLength(1);
    expect(report.signals[0]?.executionEligible).toBe(false);
    expect(report.metrics.historicalSells).toBe(1);
    expect(report.metrics.finalHistoricalPositions["asset-1"]).toBe("5000000");
  });

  it("is deterministic", () => {
    const input = {
      targetId: "target-1",
      walletAddress: wallet,
      identityStatus: "IDENTITY_CONFIRMED" as const,
      trades: [trade({ transactionHash: "0xb", timestamp: 101 }), trade({ transactionHash: "0xa", timestamp: 100 })],
      activity: [],
      hasCapitalSnapshots: true,
      hasGoldenExpectations: true,
    };
    expect(new ReplayEngine().run(input).reportHash).toBe(new ReplayEngine().run(input).reportHash);
  });

  it("sorts out-of-order 3-1-2 input before projecting positions", () => {
    const report = new ReplayEngine().run({
      targetId: "target-1",
      walletAddress: wallet,
      identityStatus: "IDENTITY_CONFIRMED",
      trades: [
        trade({ transactionHash: "0x3", side: "SELL", size: "30", timestamp: 3 }),
        trade({ transactionHash: "0x1", size: "100", timestamp: 1 }),
        trade({ transactionHash: "0x2", size: "20", timestamp: 2 }),
      ],
      activity: [],
      hasCapitalSnapshots: true,
      hasGoldenExpectations: true,
    });
    const sell = report.signals.find((signal) => signal.signalType === "TARGET_SELL");
    expect(sell?.sellRatioNumerator).toBe("30000000");
    expect(sell?.sellRatioDenominator).toBe("120000000");
    expect(report.metrics.finalRecognizedPositions["asset-1"]).toBe("90000000");
  });

  it("blocks replay signal generation when identity is unknown", () => {
    const report = new ReplayEngine().run({
      targetId: "target-1",
      walletAddress: wallet,
      identityStatus: "IDENTITY_UNKNOWN",
      trades: [trade({})],
      activity: [],
    });
    expect(report.status).toBe("FAILED");
    expect(report.signals).toHaveLength(0);
  });
});
