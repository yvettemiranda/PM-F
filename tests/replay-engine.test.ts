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

  it("uses Activity as a second source to confirm a duplicated Trades row", () => {
    const first = trade({});
    const report = new ReplayEngine().run({
      walletAddress: wallet,
      identityStatus: "IDENTITY_CONFIRMED",
      trades: [first, { ...first }],
      activity: [{ ...first, type: "TRADE" }],
      hasCapitalSnapshots: true,
      hasGoldenExpectations: true,
    });

    expect(report.status).toBe("PASSED");
    expect(report.metrics.duplicateRows).toBe(1);
    expect(report.metrics.confirmedDuplicateRows).toBe(1);
    expect(report.metrics.ambiguousEvents).toBe(0);
  });

  it("computes sell ratio before applying the sell", () => {
    const report = new ReplayEngine().run({
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

  it("records gap trades without publishing signals", () => {
    const report = new ReplayEngine().run({
      walletAddress: wallet,
      identityStatus: "IDENTITY_CONFIRMED",
      trades: [trade({ timestamp: 100 })],
      activity: [],
      gaps: [{ fromTimestamp: 99, toTimestamp: 101 }],
      hasCapitalSnapshots: true,
      hasGoldenExpectations: true,
    });
    expect(report.metrics.gapEvents).toBe(1);
    expect(report.signals).toHaveLength(0);
    expect(report.metrics.finalRecognizedPositions["asset-1"]).toBe("100000000");
  });

  it("is deterministic", () => {
    const input = {
      walletAddress: wallet,
      identityStatus: "IDENTITY_CONFIRMED" as const,
      trades: [trade({ transactionHash: "0xb", timestamp: 101 }), trade({ transactionHash: "0xa", timestamp: 100 })],
      activity: [],
      hasCapitalSnapshots: true,
      hasGoldenExpectations: true,
    };
    expect(new ReplayEngine().run(input).reportHash).toBe(new ReplayEngine().run(input).reportHash);
  });

  it("blocks replay signal generation when identity is unknown", () => {
    const report = new ReplayEngine().run({
      walletAddress: wallet,
      identityStatus: "IDENTITY_UNKNOWN",
      trades: [trade({})],
      activity: [],
    });
    expect(report.status).toBe("FAILED");
    expect(report.signals).toHaveLength(0);
  });
});
