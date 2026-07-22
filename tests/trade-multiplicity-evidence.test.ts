import { describe, expect, it } from "vitest";
import { encodeAbiParameters, pad, toHex } from "viem";
import type { PolygonReceiptLog, PolygonTransactionReceiptResponse } from "../src/adapters/polygon-receipt.js";
import type { ApiCapture } from "../src/adapters/polymarket-public.js";
import { sourceEventKey } from "../src/domain/idempotency.js";
import type { PublicActivity, PublicTrade } from "../src/domain/models.js";
import { ReplayEngine } from "../src/replay/replay-engine.js";
import { validateApiContract } from "../src/services/api-contract.js";
import {
  assertStoredTradeMultiplicityProofDocument,
  collectTradeMultiplicityEvidence,
  verifyTradeMultiplicityEvidence,
} from "../src/services/trade-multiplicity-evidence.js";

const wallet = "0x1f9e15f39bbd5d163b0eacf0fbef647ced9e4f1a";
const exchange = "0xe2222d279d744050d28e00520010520000310f59";
const transactionHash = `0x${"1".repeat(64)}`;
const asset = "45436900738800477237183048615338538651729356615575299107261267814989904889303";
const orderFilledTopic = "0xd543adfd945773f1a62f74f0ee55a5e3b9b1a28262980ba90b1a89f2ea84d8ee";

const trade: PublicTrade = {
  proxyWallet: wallet,
  transactionHash,
  conditionId: `0x${"2".repeat(64)}`,
  asset,
  side: "BUY",
  price: "0.37",
  size: "100",
  timestamp: 1_778_810_284,
};

function orderFilledLog(orderHash: string, overrides: {
  address?: string;
  maker?: string;
  side?: number;
  makerAmountFilled?: bigint;
  takerAmountFilled?: bigint;
  tokenId?: bigint;
} = {}): PolygonReceiptLog {
  return {
    address: overrides.address ?? exchange,
    topics: [
      orderFilledTopic,
      orderHash,
      pad((overrides.maker ?? wallet) as `0x${string}`, { size: 32 }) as `0x${string}`,
      pad("0x0000000000000000000000000000000000000002", { size: 32 }),
    ],
    data: encodeAbiParameters(
      [
        { type: "uint8" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "bytes32" },
        { type: "bytes32" },
      ],
      [
        overrides.side ?? 0,
        overrides.tokenId ?? BigInt(asset),
        overrides.makerAmountFilled ?? 37_000_000n,
        overrides.takerAmountFilled ?? 100_000_000n,
        0n,
        toHex(0n, { size: 32 }),
        toHex(0n, { size: 32 }),
      ],
    ),
  };
}

function receipt(logs: PolygonReceiptLog[]): ApiCapture<PolygonTransactionReceiptResponse> {
  return {
    url: "https://polygon.drpc.org",
    fetchedAt: "2026-07-22T03:15:00.000Z",
    latencyMs: 25,
    status: 200,
    data: {
      jsonrpc: "2.0",
      id: 3,
      result: {
        transactionHash,
        status: "0x1",
        blockNumber: "0x52df340",
        logs,
      },
    },
  };
}

describe("trade multiplicity evidence", () => {
  it("confirms two identical Data API BUYs from distinct official V2 OrderFilled events", () => {
    const evidence = verifyTradeMultiplicityEvidence({
      walletAddress: wallet,
      trades: [trade, { ...trade }],
      activity: [],
      receipts: [receipt([
        orderFilledLog(`0x${"3".repeat(64)}`),
        orderFilledLog(`0x${"4".repeat(64)}`),
      ])],
    });

    expect(evidence.confirmedOccurrenceCounts).toEqual({
      [sourceEventKey(trade)]: 2,
    });
    expect(evidence.proofs).toEqual([
      expect.objectContaining({
        sourceEventKey: sourceEventKey(trade),
        transactionHash,
        occurrenceCount: 2,
        exchangeAddress: exchange,
        orderHashes: [`0x${"3".repeat(64)}`, `0x${"4".repeat(64)}`],
        evidenceHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    ]);

    const replay = new ReplayEngine().run({
      targetId: "target-1",
      walletAddress: wallet,
      identityStatus: "IDENTITY_CONFIRMED",
      trades: [trade, { ...trade }],
      activity: [],
      confirmedTradeOccurrenceCounts: evidence.confirmedOccurrenceCounts,
      hasCapitalSnapshots: true,
      hasGoldenExpectations: true,
    });
    expect(replay.status).toBe("PASSED");
    expect(replay.metrics).toMatchObject({
      uniqueEvents: 2,
      confirmedDuplicateRows: 1,
      ambiguousEvents: 0,
      buySignals: 2,
    });
  });

  it("confirms two identical Data API SELLs using exact taker collateral", () => {
    const sellTrade: PublicTrade = { ...trade, side: "SELL" };
    const evidence = verifyTradeMultiplicityEvidence({
      walletAddress: wallet,
      trades: [sellTrade, { ...sellTrade }],
      activity: [],
      receipts: [receipt([
        orderFilledLog(`0x${"5".repeat(64)}`, {
          side: 1,
          makerAmountFilled: 100_000_000n,
          takerAmountFilled: 37_000_000n,
        }),
        orderFilledLog(`0x${"6".repeat(64)}`, {
          side: 1,
          makerAmountFilled: 100_000_000n,
          takerAmountFilled: 37_000_000n,
        }),
      ])],
    });

    expect(evidence.confirmedOccurrenceCounts).toEqual({
      [sourceEventKey(sellTrade)]: 2,
    });
    expect(evidence.proofs[0]).toMatchObject({
      side: "SELL",
      notionalMicros: "37000000",
      occurrenceCount: 2,
    });
  });

  it("removes the duplicate API warning only after the chain occurrence count is confirmed", () => {
    const receiptCapture = receipt([
      orderFilledLog(`0x${"3".repeat(64)}`),
      orderFilledLog(`0x${"4".repeat(64)}`),
    ]);
    const evidence = verifyTradeMultiplicityEvidence({
      walletAddress: wallet,
      trades: [trade, { ...trade }],
      activity: [],
      receipts: [receiptCapture],
    });
    const report = validateApiContract({
      trades: [trade, { ...trade }],
      activity: [],
      positions: [],
      tradeHistoryComplete: true,
      activityHistoryComplete: true,
      confirmedTradeOccurrenceCounts: evidence.confirmedOccurrenceCounts,
      clobTime: {
        url: "https://clob.polymarket.com/time",
        fetchedAt: "2026-07-22T03:15:00.000Z",
        latencyMs: 10,
        status: 200,
        data: 1_774_150_900,
      },
      captures: [receiptCapture],
    });

    expect(report.warnings).not.toContain("EXACT_DUPLICATE_TRADE_ROWS_REQUIRE_RECONCILIATION");
    expect(report.observations).toMatchObject({
      exactDuplicateRows: 1,
      confirmedDuplicateRows: 1,
      ambiguousDuplicateRows: 0,
    });
  });

  it("collects only ambiguous transaction receipts and binds the derived proof capture", async () => {
    const requested: string[] = [];
    const result = await collectTradeMultiplicityEvidence({
      walletAddress: wallet,
      trades: [trade, { ...trade }],
      activity: [],
      receiptProvider: {
        async transactionReceipt(hash) {
          requested.push(hash);
          return receipt([
            orderFilledLog(`0x${"3".repeat(64)}`),
            orderFilledLog(`0x${"4".repeat(64)}`),
          ]);
        },
      },
    });

    expect(requested).toEqual([transactionHash]);
    expect(result.receiptCaptures).toHaveLength(1);
    expect(result.proofCapture).toMatchObject({
      url: `ni-k://phase0/trade-multiplicity-evidence/${wallet}`,
      status: 200,
      data: {
        evidenceVersion: "v1.0.0",
        walletAddress: wallet,
        confirmedOccurrenceCounts: { [sourceEventKey(trade)]: 2 },
        proofs: [expect.objectContaining({ occurrenceCount: 2 })],
      },
    });
    expect(() => assertStoredTradeMultiplicityProofDocument(
      wallet,
      result,
      [result.proofCapture!.data],
    )).not.toThrow();
    expect(() => assertStoredTradeMultiplicityProofDocument(
      wallet,
      result,
      [{ ...result.proofCapture!.data, confirmedOccurrenceCounts: {} }],
    )).toThrow("TRADE_MULTIPLICITY_PROOF_MISMATCH");
  });

  it.each([
    ["an untrusted event contract", [
      orderFilledLog(`0x${"3".repeat(64)}`, { address: "0x0000000000000000000000000000000000000009" }),
      orderFilledLog(`0x${"4".repeat(64)}`, { address: "0x0000000000000000000000000000000000000009" }),
    ]],
    ["a repeated order hash", [
      orderFilledLog(`0x${"3".repeat(64)}`),
      orderFilledLog(`0x${"3".repeat(64)}`),
    ]],
    ["a collateral amount mismatch", [
      orderFilledLog(`0x${"3".repeat(64)}`, { makerAmountFilled: 36_999_999n }),
      orderFilledLog(`0x${"4".repeat(64)}`, { makerAmountFilled: 36_999_999n }),
    ]],
    ["a maker mismatch", [
      orderFilledLog(`0x${"3".repeat(64)}`, { maker: "0x0000000000000000000000000000000000000009" }),
      orderFilledLog(`0x${"4".repeat(64)}`, { maker: "0x0000000000000000000000000000000000000009" }),
    ]],
  ])("fails closed for %s", (_label, logs) => {
    const evidence = verifyTradeMultiplicityEvidence({
      walletAddress: wallet,
      trades: [trade, { ...trade }],
      activity: [],
      receipts: [receipt(logs as PolygonReceiptLog[])],
    });
    expect(evidence).toEqual({ confirmedOccurrenceCounts: {}, proofs: [] });
  });

  it("fails closed when SELL side or taker collateral does not match", () => {
    const sellTrade: PublicTrade = { ...trade, side: "SELL" };
    const evidence = verifyTradeMultiplicityEvidence({
      walletAddress: wallet,
      trades: [sellTrade, { ...sellTrade }],
      activity: [],
      receipts: [receipt([
        orderFilledLog(`0x${"5".repeat(64)}`, {
          side: 1,
          makerAmountFilled: 100_000_000n,
          takerAmountFilled: 36_999_999n,
        }),
        orderFilledLog(`0x${"6".repeat(64)}`, {
          side: 0,
          makerAmountFilled: 37_000_000n,
          takerAmountFilled: 100_000_000n,
        }),
      ])],
    });

    expect(evidence).toEqual({ confirmedOccurrenceCounts: {}, proofs: [] });
  });

  it("does not fetch a receipt when duplicate Trade rows belong to another wallet", async () => {
    const requested: string[] = [];
    const wrongWalletTrade = {
      ...trade,
      proxyWallet: "0x0000000000000000000000000000000000000009",
    };
    const evidence = await collectTradeMultiplicityEvidence({
      walletAddress: wallet,
      trades: [wrongWalletTrade, { ...wrongWalletTrade }],
      activity: [],
      receiptProvider: {
        async transactionReceipt(hash) {
          requested.push(hash);
          return receipt([]);
        },
      },
    });

    expect(requested).toEqual([]);
    expect(evidence).toMatchObject({ confirmedOccurrenceCounts: {}, proofs: [], receiptCaptures: [] });
  });

  it("fails closed when a matching Activity row belongs to another wallet", () => {
    const mismatchedActivity: PublicActivity = {
      ...trade,
      proxyWallet: "0x0000000000000000000000000000000000000009",
      type: "TRADE",
    };
    const evidence = verifyTradeMultiplicityEvidence({
      walletAddress: wallet,
      trades: [trade, { ...trade }],
      activity: [mismatchedActivity],
      receipts: [receipt([
        orderFilledLog(`0x${"3".repeat(64)}`),
        orderFilledLog(`0x${"4".repeat(64)}`),
      ])],
    });

    expect(evidence).toEqual({ confirmedOccurrenceCounts: {}, proofs: [] });
  });

  it("matches V2 normalized Data API size by exact collateral notional", () => {
    const normalizedTrade: PublicTrade = {
      ...trade,
      asset: "38783367488358323275556099433395002877010964847263918966121422862376389877278",
      price: "0.34",
      size: "99.99",
    };
    const normalizedLog = (orderHash: string): PolygonReceiptLog => ({
      ...orderFilledLog(orderHash),
      data: encodeAbiParameters(
        [
          { type: "uint8" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" },
          { type: "uint256" }, { type: "bytes32" }, { type: "bytes32" },
        ],
        [
          0, BigInt(normalizedTrade.asset), 33_996_600n, 6_249_375n, 0n,
          toHex(0n, { size: 32 }), toHex(0n, { size: 32 }),
        ],
      ),
    });
    const evidence = verifyTradeMultiplicityEvidence({
      walletAddress: wallet,
      trades: [normalizedTrade, { ...normalizedTrade }],
      activity: [],
      receipts: [receipt([
        normalizedLog(`0x${"5".repeat(64)}`),
        normalizedLog(`0x${"6".repeat(64)}`),
      ])],
    });
    expect(evidence.confirmedOccurrenceCounts).toEqual({
      [sourceEventKey(normalizedTrade)]: 2,
    });
  });
});
