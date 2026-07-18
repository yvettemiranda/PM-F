import { describe, expect, it, vi } from "vitest";
import type {
  PaperFeeSnapshot,
  PaperMarketDataProvider,
  PaperOrderbookSnapshot,
  PaperResolutionSnapshot,
} from "../src/paper/types.js";
import {
  SettlementService,
  type SettlementCandidate,
  type SettlementStore,
} from "../src/settlement/settlement-service.js";

const conditionId = `0x${"a".repeat(64)}`;
const endedAt = "2026-07-14T00:00:00.000Z";
const now = () => new Date("2026-07-15T00:00:00.000Z");

function candidate(positionId: string, assetId: string): SettlementCandidate {
  return {
    positionId,
    accountId: "paper",
    status: "OPEN",
    conditionId,
    assetId,
    marketEndTime: endedAt,
  };
}

function marketData(
  resolution: (condition: string, asset: string) => Promise<PaperResolutionSnapshot>,
): PaperMarketDataProvider {
  return {
    orderbook: async () => ({} as PaperOrderbookSnapshot),
    fee: async () => ({} as PaperFeeSnapshot),
    resolution,
  };
}

function store(candidates: SettlementCandidate[]) {
  const redeemed: Array<{ positionId: string; assetId: string; payoutNumerator: string | null }> = [];
  const implementation: SettlementStore = {
    settlementCandidates: () => candidates,
    markSettlementPending: vi.fn(),
    redeemSettledPosition: (positionId, resolution) => {
      redeemed.push({ positionId, assetId: resolution.assetId, payoutNumerator: resolution.payoutNumerator });
      return `settlement-${positionId}`;
    },
  };
  return { implementation, redeemed };
}

function resolved(assetId: string, payoutNumerator: string): PaperResolutionSnapshot {
  return {
    conditionId,
    resolved: true,
    assetId,
    payoutNumerator,
    payoutDenominator: "1",
    sourceUrl: "https://clob.test/market",
    snapshotTime: now().toISOString(),
    raw: {},
  };
}

describe("SettlementService", () => {
  it("reuses one resolution for positions with the same condition and asset", async () => {
    const resolution = vi.fn(async (_condition: string, asset: string) => resolved(asset, "1"));
    const state = store([candidate("position-a", "asset-yes"), candidate("position-b", "asset-yes")]);

    const completed = await new SettlementService(
      marketData(resolution),
      state.implementation,
      now,
    ).process("paper");

    expect(resolution).toHaveBeenCalledTimes(1);
    expect(completed).toEqual(["settlement-position-a", "settlement-position-b"]);
  });

  it("keeps opposite assets isolated even when they share a condition", async () => {
    const resolution = vi.fn(async (_condition: string, asset: string) => resolved(asset, asset === "asset-yes" ? "1" : "0"));
    const state = store([candidate("position-yes", "asset-yes"), candidate("position-no", "asset-no")]);

    await new SettlementService(marketData(resolution), state.implementation, now).process("paper");

    expect(resolution).toHaveBeenCalledTimes(2);
    expect(state.redeemed).toEqual([
      { positionId: "position-yes", assetId: "asset-yes", payoutNumerator: "1" },
      { positionId: "position-no", assetId: "asset-no", payoutNumerator: "0" },
    ]);
  });

  it("does not reuse an unresolved result across process calls", async () => {
    const resolution = vi.fn(async (_condition: string, asset: string): Promise<PaperResolutionSnapshot> => ({
      ...resolved(asset, "0"),
      resolved: false,
      payoutNumerator: null,
      payoutDenominator: null,
    }));
    const state = store([candidate("position-a", "asset-yes")]);
    const service = new SettlementService(marketData(resolution), state.implementation, now);

    await service.process("paper");
    await service.process("paper");

    expect(resolution).toHaveBeenCalledTimes(2);
    expect(state.redeemed).toEqual([]);
  });

  it("skips a persisted settlement probe until its retry deadline is due", async () => {
    const resolution = vi.fn(async (_condition: string, asset: string) => resolved(asset, "1"));
    const state = store([candidate("position-a", "asset-yes")]);
    state.implementation.settlementRetryDue = vi.fn(() => false);

    await new SettlementService(marketData(resolution), state.implementation, now).process("paper");

    expect(resolution).not.toHaveBeenCalled();
    expect(state.implementation.markSettlementPending).not.toHaveBeenCalled();
  });

  it("records an unresolved result so the next probe can be persisted and delayed", async () => {
    const unresolved = {
      ...resolved("asset-yes", "0"),
      resolved: false,
      payoutNumerator: null,
      payoutDenominator: null,
    };
    const state = store([candidate("position-a", "asset-yes")]);
    state.implementation.recordSettlementUnresolved = vi.fn();

    await new SettlementService(
      marketData(vi.fn(async () => unresolved)),
      state.implementation,
      now,
    ).process("paper");

    expect(state.implementation.recordSettlementUnresolved).toHaveBeenCalledWith(
      expect.objectContaining({ positionId: "position-a" }),
      unresolved,
    );
  });

  it("records a failed resolution request and then the later unresolved result", async () => {
    const resolution = vi.fn()
      .mockRejectedValueOnce(new Error("RESOLUTION_API_DOWN"))
      .mockResolvedValueOnce({
        ...resolved("asset-yes", "0"),
        resolved: false,
        payoutNumerator: null,
        payoutDenominator: null,
      });
    const state = store([candidate("position-a", "asset-yes")]);
    state.implementation.recordSettlementError = vi.fn();
    state.implementation.recordSettlementUnresolved = vi.fn();
    state.implementation.recordSettlementSuccess = vi.fn();
    const service = new SettlementService(marketData(resolution), state.implementation, now);

    await service.process("paper");
    await service.process("paper");

    expect(state.implementation.recordSettlementError).toHaveBeenCalledTimes(1);
    expect(state.implementation.recordSettlementUnresolved).toHaveBeenCalledTimes(1);
    expect(state.implementation.recordSettlementSuccess).not.toHaveBeenCalled();
    expect(state.redeemed).toEqual([]);
  });
});
