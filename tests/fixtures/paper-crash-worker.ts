import { writeFileSync } from "node:fs";
import { PaperExecutor, type PaperTransactionBarrier } from "../../src/paper/paper-executor.js";
import type {
  PaperFeeSnapshot,
  PaperMarketDataProvider,
  PaperOrderbookSnapshot,
  PaperResolutionSnapshot,
} from "../../src/paper/types.js";

const [databasePath, accountId, action, signalId, markerPath, nowIso] = process.argv.slice(2);
if (!databasePath || !accountId || !action || !signalId || !markerPath || !nowIso) {
  throw new Error("PAPER_CRASH_WORKER_ARGUMENTS_REQUIRED");
}

const now = () => new Date(nowIso);
const marketData: PaperMarketDataProvider = {
  orderbook: async (assetId, conditionId): Promise<PaperOrderbookSnapshot> => ({
    assetId,
    conditionId,
    marketSnapshotTime: nowIso,
    receivedAt: nowIso,
    sourceUrl: "fake://paper-process-crash/orderbook",
    minOrderSize: "1",
    tickSize: "0.01",
    asks: [{ price: "0.5", size: "10000" }],
    bids: [{ price: "0.5", size: "10000" }],
  }),
  fee: async (assetId): Promise<PaperFeeSnapshot> => ({
    assetId,
    status: "AVAILABLE",
    baseFee: 0,
    feeRatePpm: "0",
    exponent: 1,
    sourceUrl: "fake://paper-process-crash/fee",
    snapshotTime: nowIso,
  }),
  resolution: async (conditionId, assetId): Promise<PaperResolutionSnapshot> => ({
    conditionId,
    assetId,
    resolved: true,
    payoutNumerator: "1",
    payoutDenominator: "1",
    sourceUrl: "fake://paper-process-crash/resolution",
    snapshotTime: nowIso,
    raw: { closed: true, winner: assetId },
  }),
};

const expectedBarrier = action as PaperTransactionBarrier;
const executor = new PaperExecutor(databasePath, marketData, {
  sourceVersion: { commit: "paper-test", dirty: false },
  now,
  transactionBarrier: (barrier) => {
    if (barrier !== expectedBarrier) return;
    writeFileSync(markerPath, JSON.stringify({ pid: process.pid, barrier }), { mode: 0o600 });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  },
});

try {
  if (action === "RESERVATION_BEFORE_COMMIT") {
    await executor.consumeSignal(accountId, signalId);
  } else if (action === "BUY_FILL_BEFORE_COMMIT") {
    await executor.retryPending(accountId);
  } else if (action === "SETTLEMENT_BEFORE_COMMIT") {
    await executor.processSettlements(accountId);
  } else {
    throw new Error(`UNKNOWN_PAPER_CRASH_ACTION:${action}`);
  }
} finally {
  executor.close();
}
