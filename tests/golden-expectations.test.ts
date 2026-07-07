import { describe, expect, it } from "vitest";
import type { PublicTrade } from "../src/domain/models.js";
import { ReplayEngine } from "../src/replay/replay-engine.js";
import { buildCaptureManifest } from "../src/services/capture-manifest.js";
import { evaluateGoldenExpectations, generateGoldenCandidates, renderGoldenCandidatesMarkdown } from "../src/services/golden-expectations.js";

const wallet = "0x0000000000000000000000000000000000000001";
const trade = (overrides: Partial<PublicTrade>): PublicTrade => ({
  proxyWallet: wallet,
  transactionHash: "0x1",
  conditionId: "0xcondition",
  asset: "asset-1",
  side: "BUY",
  price: "0.5",
  size: "10",
  timestamp: 100,
  ...overrides,
});

describe("Golden Expectations", () => {
  it("screens five real-schema candidate types but does not self-approve them", () => {
    const trades = [
      trade({ transactionHash: "0xhistorical", side: "SELL", timestamp: 99 }),
      trade({ transactionHash: "0xbuy", asset: "asset-2", timestamp: 100 }),
      trade({ transactionHash: "0xsell", asset: "asset-2", side: "SELL", size: "5", timestamp: 101 }),
    ];
    const activity = [
      { proxyWallet: wallet, transactionHash: "0xmerge", timestamp: 102, type: "MERGE" },
      { proxyWallet: wallet, transactionHash: "0xyield", timestamp: 103, type: "YIELD" },
    ];
    const replay = new ReplayEngine().run({
      walletAddress: wallet,
      identityStatus: "IDENTITY_CONFIRMED",
      trades,
      activity,
      hasCapitalSnapshots: true,
      hasGoldenExpectations: true,
    });
    const manifest = buildCaptureManifest({
      walletAddress: wallet,
      sampleRole: "TARGET",
      purpose: "TEST",
      sourceVersion: { commit: "abc", dirty: false },
      sources: [{
        endpoint: "data-trades",
        paginationStatus: "END_OF_DATA",
        capture: { url: "test", fetchedAt: "2026-07-07T00:00:00Z", latencyMs: 1, status: 200, data: trades },
      }],
    });
    const candidates = generateGoldenCandidates({ manifest, sampleRole: "TARGET", trades, activity, replay });
    expect(new Set(candidates.map((item) => item.caseType))).toEqual(
      new Set(["NORMAL_BUY", "NORMAL_SELL", "HISTORICAL_SELL", "COMBO", "UNRECOGNIZED"]),
    );
    expect(candidates.every((item) => item.status === "CANDIDATE")).toBe(true);
    expect(evaluateGoldenExpectations(candidates, replay).every((item) => item.resultStatus === "NOT_EVALUATED")).toBe(true);
    expect(renderGoldenCandidatesMarkdown(candidates)).toContain("用户确认方式");
    const approved = candidates.map((item) => ({ ...item, status: "APPROVED" as const }));
    expect(evaluateGoldenExpectations(approved, replay).every((item) => item.resultStatus === "MATCH")).toBe(true);
  });
});
