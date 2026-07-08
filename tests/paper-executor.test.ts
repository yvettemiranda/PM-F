import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { RULESET_HASH, RULESET_SNAPSHOT_JSON, VERSIONS } from "../src/domain/versioning.js";
import { Phase0Database } from "../src/infra/sqlite/database.js";
import type { SourceVersion } from "../src/infra/source-version.js";
import { PaperExecutor } from "../src/paper/paper-executor.js";
import { PaperRunner } from "../src/paper/paper-runner.js";
import type {
  PaperFeeSnapshot,
  PaperMarketDataProvider,
  PaperOrderbookSnapshot,
  PaperResolutionSnapshot,
} from "../src/paper/types.js";
import type { CapitalConfidence, CapitalEstimateStatus } from "../src/services/capital-estimator.js";

const sourceVersion: SourceVersion = { commit: "paper-test", dirty: false };
const wallet = "0x0000000000000000000000000000000000000001";
const conditionId = `0x${"1".repeat(64)}`;
const assetId = "asset-1";
const directories: string[] = [];

class FakeMarketData implements PaperMarketDataProvider {
  book: PaperOrderbookSnapshot;
  feeSnapshot: PaperFeeSnapshot;
  resolutionSnapshot: PaperResolutionSnapshot;

  constructor(private readonly clock: () => Date) {
    this.book = this.makeBook([{ price: "0.5", size: "10000" }], [{ price: "0.5", size: "10000" }]);
    this.feeSnapshot = {
      assetId,
      status: "AVAILABLE",
      baseFee: 0,
      feeRatePpm: "0",
      exponent: 1,
      sourceUrl: "https://clob.test/fee-rate",
      snapshotTime: clock().toISOString(),
    };
    this.resolutionSnapshot = {
      conditionId,
      assetId,
      resolved: false,
      payoutNumerator: null,
      payoutDenominator: null,
      sourceUrl: "https://clob.test/markets/condition",
      snapshotTime: clock().toISOString(),
      raw: { closed: false },
    };
  }

  makeBook(asks: Array<{ price: string; size: string }>, bids: Array<{ price: string; size: string }>, snapshotTime = this.clock().toISOString()): PaperOrderbookSnapshot {
    return {
      assetId,
      conditionId,
      marketSnapshotTime: snapshotTime,
      receivedAt: this.clock().toISOString(),
      sourceUrl: "https://clob.test/book",
      asks,
      bids,
    };
  }

  async orderbook(): Promise<PaperOrderbookSnapshot> {
    return this.book;
  }

  async fee(): Promise<PaperFeeSnapshot> {
    return { ...this.feeSnapshot, snapshotTime: this.clock().toISOString() };
  }

  async resolution(): Promise<PaperResolutionSnapshot> {
    return { ...this.resolutionSnapshot, snapshotTime: this.clock().toISOString() };
  }
}

function setup(now: Date, initialBalanceMicros = 1_000_000_000n) {
  const directory = mkdtempSync(join(tmpdir(), "ni-k-paper-"));
  directories.push(directory);
  const databasePath = join(directory, "phase0.sqlite");
  const phase0 = new Phase0Database(databasePath, sourceVersion);
  phase0.initialize();
  const targetId = phase0.ensureTarget(wallet, "IDENTITY_CONFIRMED");
  phase0.close();
  let clock = now;
  const market = new FakeMarketData(() => clock);
  const executor = new PaperExecutor(databasePath, market, { sourceVersion, now: () => clock });
  const accountId = executor.createAccount("Test Paper", initialBalanceMicros);
  return {
    databasePath,
    targetId,
    market,
    executor,
    accountId,
    setClock(value: Date) { clock = value; },
    getClock() { return clock; },
  };
}

function insertSignal(input: {
  databasePath: string;
  targetId: string;
  signalId: string;
  createdAt: string;
  signalType?: "TARGET_BUY" | "TARGET_SELL";
  status?: string;
  executionEligible?: boolean;
  confidence?: CapitalConfidence;
  capitalStatus?: CapitalEstimateStatus;
  ratioPpm?: string | null;
  fallbackMicros?: string;
  sellNumerator?: string | null;
  sellDenominator?: string | null;
  targetPriceUnits?: string;
  marketEndTime?: string;
}): void {
  const db = new DatabaseSync(input.databasePath);
  db.exec("PRAGMA foreign_keys=ON");
  const sourceKey = `source-${input.signalId}`;
  const contextId = `context-${input.signalId}`;
  const capitalId = input.signalType === "TARGET_SELL" ? null : `capital-${input.signalId}`;
  db.prepare(
    `INSERT INTO raw_events(
      source_event_key,target_id,identity_version,source_type,source_transaction_hash,
      source_timestamp,asset_id,condition_id,side,price_units,size_micros,gap_event,
      is_combo,raw_json,created_at,event_classification
    ) VALUES (?, ?, 'test', 'DATA_API_TRADE', ?, ?, ?, ?, ?, ?, '10000000', 0, 0, '{}', ?, 'STANDARD_TRADE')`,
  ).run(sourceKey, input.targetId, `tx-${input.signalId}`, Math.floor(Date.parse(input.createdAt) / 1_000), assetId, conditionId, input.signalType === "TARGET_SELL" ? "SELL" : "BUY", input.targetPriceUnits ?? "500000000000000000", input.createdAt);
  if (capitalId) {
    db.prepare(
      `INSERT INTO capital_estimates(
        capital_estimate_id,target_id,source_event_key,position_value_micros,wallet_balance_micros,
        target_visible_capital_micros,target_trade_amount_micros,target_trade_capital_ratio_ppm,
        capital_estimate_status,capital_confidence,capital_estimate_reason,position_snapshot_time,
        wallet_balance_snapshot_time,target_trade_timestamp,fallback_amount_micros,schema_version,
        strategy_version,risk_version,ruleset_snapshot_json,ruleset_hash,source_code_commit,
        source_code_dirty,created_at
      ) VALUES (?, ?, ?, '500000000', '500000000', '1000000000', '100000000', ?, ?, ?, 'TEST', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    ).run(
      capitalId,
      input.targetId,
      sourceKey,
      input.ratioPpm ?? "100000",
      input.capitalStatus ?? "COMPLETE",
      input.confidence ?? "HIGH",
      input.createdAt,
      input.createdAt,
      input.createdAt,
      input.fallbackMicros ?? "10000000",
      VERSIONS.schemaVersion,
      VERSIONS.strategyVersion,
      VERSIONS.riskVersion,
      RULESET_SNAPSHOT_JSON,
      RULESET_HASH,
      sourceVersion.commit,
      input.createdAt,
    );
  }
  db.prepare(
    `INSERT INTO signals(
      signal_id,signal_idempotency_key,source_event_key,signal_type,status,asset_id,
      condition_id,target_price_units,target_size_micros,sell_ratio_numerator,
      sell_ratio_denominator,reason,schema_version,signal_version,strategy_version,
      risk_version,replay_version,ruleset_snapshot_json,ruleset_hash,source_code_commit,
      created_at,execution_eligible,execution_block_reason,event_classification,
      capital_estimate_id,source_code_dirty,producer_mode
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '10000000', ?, ?, 'TEST', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'STANDARD_TRADE', ?, 0, 'OBSERVE_ONLY')`,
  ).run(
    input.signalId,
    `idem-${input.signalId}`,
    sourceKey,
    input.signalType ?? "TARGET_BUY",
    input.status ?? "PUBLISHED",
    assetId,
    conditionId,
    input.targetPriceUnits ?? "500000000000000000",
    input.sellNumerator ?? null,
    input.sellDenominator ?? null,
    VERSIONS.schemaVersion,
    VERSIONS.signalVersion,
    VERSIONS.strategyVersion,
    VERSIONS.riskVersion,
    VERSIONS.replayVersion,
    RULESET_SNAPSHOT_JSON,
    RULESET_HASH,
    sourceVersion.commit,
    input.createdAt,
    (input.executionEligible ?? true) ? 1 : 0,
    (input.executionEligible ?? true) ? null : "GAP_EVENT",
    capitalId,
  );
  db.prepare(
    `INSERT INTO signal_execution_contexts(
      context_id,signal_id,capital_decision_id,target_trade_capital_ratio_ppm,
      target_trade_timestamp,market_end_time,market_metadata_snapshot_json,
      market_metadata_hash,ruleset_hash,schema_version,signal_version,strategy_version,
      source_code_commit,source_code_dirty,created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
  ).run(
    contextId,
    input.signalId,
    capitalId,
    input.signalType === "TARGET_SELL" ? null : input.ratioPpm ?? "100000",
    input.createdAt,
    input.marketEndTime ?? new Date(Date.parse(input.createdAt) + 60 * 60 * 1_000).toISOString(),
    JSON.stringify({ tokens: [{ token_id: assetId, outcome: "Yes" }] }),
    `metadata-${input.signalId}`,
    RULESET_HASH,
    VERSIONS.schemaVersion,
    VERSIONS.signalVersion,
    VERSIONS.strategyVersion,
    sourceVersion.commit,
    input.createdAt,
  );
  db.close();
}

function count(databasePath: string, table: string): number {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  const result = (db.prepare(`SELECT count(*) count FROM ${table}`).get() as { count: number }).count;
  db.close();
  return result;
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("PaperExecutor", () => {
  it("uses HIGH capital ratio and opens a position from a full FAK fill", async () => {
    const env = setup(new Date("2026-07-08T00:00:00.000Z"));
    insertSignal({ databasePath: env.databasePath, targetId: env.targetId, signalId: "buy-high", createdAt: "2026-07-08T00:00:01.000Z" });
    const executionId = await env.executor.consumeSignal(env.accountId, "buy-high");
    expect(env.executor.executionState(executionId)).toBe("EXECUTED");
    expect(count(env.databasePath, "paper_positions")).toBe(1);
    const snapshot = await env.executor.accountSnapshot(env.accountId);
    expect(snapshot.cashBalanceMicros).toBe("900000000");
    expect(snapshot.reservedBalanceMicros).toBe("0");
    env.executor.close();
  });

  it("uses MEDIUM fixed fallback and rejects LOW capital", async () => {
    const env = setup(new Date("2026-07-08T00:00:00.000Z"));
    insertSignal({ databasePath: env.databasePath, targetId: env.targetId, signalId: "medium", createdAt: "2026-07-08T00:00:01.000Z", confidence: "MEDIUM", capitalStatus: "INCOMPLETE" });
    insertSignal({ databasePath: env.databasePath, targetId: env.targetId, signalId: "low", createdAt: "2026-07-08T00:00:02.000Z", confidence: "LOW", capitalStatus: "FAILED" });
    expect(env.executor.executionState(await env.executor.consumeSignal(env.accountId, "medium"))).toBe("EXECUTED");
    expect(env.executor.executionState(await env.executor.consumeSignal(env.accountId, "low"))).toBe("REJECTED");
    expect((await env.executor.accountSnapshot(env.accountId)).cashBalanceMicros).toBe("990000000");
    env.executor.close();
  });

  it("rejects Gap and non-published signals", async () => {
    const env = setup(new Date("2026-07-08T00:00:00.000Z"));
    insertSignal({ databasePath: env.databasePath, targetId: env.targetId, signalId: "gap", createdAt: "2026-07-08T00:00:01.000Z", executionEligible: false });
    insertSignal({ databasePath: env.databasePath, targetId: env.targetId, signalId: "draft", createdAt: "2026-07-08T00:00:02.000Z", status: "READY" });
    expect(env.executor.executionState(await env.executor.consumeSignal(env.accountId, "gap"))).toBe("REJECTED");
    expect(env.executor.executionState(await env.executor.consumeSignal(env.accountId, "draft"))).toBe("REJECTED");
    expect(count(env.databasePath, "paper_positions")).toBe(0);
    env.executor.close();
  });

  it("keeps zero fill waiting, retries, and preserves idempotency", async () => {
    const env = setup(new Date("2026-07-08T00:00:00.000Z"));
    env.market.book = env.market.makeBook([], []);
    insertSignal({ databasePath: env.databasePath, targetId: env.targetId, signalId: "retry", createdAt: "2026-07-08T00:00:01.000Z" });
    const first = await env.executor.consumeSignal(env.accountId, "retry");
    expect(env.executor.executionState(first)).toBe("WAITING_EXECUTION");
    expect(await env.executor.consumeSignal(env.accountId, "retry")).toBe(first);
    expect(count(env.databasePath, "paper_signal_consumptions")).toBe(1);
    env.market.book = env.market.makeBook([{ price: "0.5", size: "200" }], []);
    expect(await env.executor.attemptExecution(first)).toBe("EXECUTED");
    env.executor.close();
  });

  it("keeps a partial fill, releases the remainder, and does not chase", async () => {
    const env = setup(new Date("2026-07-08T00:00:00.000Z"));
    env.market.book = env.market.makeBook([{ price: "0.5", size: "100" }], []);
    insertSignal({ databasePath: env.databasePath, targetId: env.targetId, signalId: "partial", createdAt: "2026-07-08T00:00:01.000Z" });
    const executionId = await env.executor.consumeSignal(env.accountId, "partial");
    expect(env.executor.executionState(executionId)).toBe("PARTIALLY_EXECUTED");
    const snapshot = await env.executor.accountSnapshot(env.accountId);
    expect(snapshot.cashBalanceMicros).toBe("950000000");
    expect(snapshot.reservedBalanceMicros).toBe("0");
    expect(await env.executor.attemptExecution(executionId)).toBe("PARTIALLY_EXECUTED");
    env.executor.close();
  });

  it("waits on out-of-range and stale books without spending cash", async () => {
    const env = setup(new Date("2026-07-08T00:00:00.000Z"));
    env.market.book = env.market.makeBook([{ price: "0.6", size: "1000" }], []);
    insertSignal({ databasePath: env.databasePath, targetId: env.targetId, signalId: "range", createdAt: "2026-07-08T00:00:01.000Z" });
    expect(env.executor.executionState(await env.executor.consumeSignal(env.accountId, "range"))).toBe("WAITING_EXECUTION");
    env.market.book = env.market.makeBook([{ price: "0.5", size: "1000" }], [], "2026-07-07T23:59:00.000Z");
    insertSignal({ databasePath: env.databasePath, targetId: env.targetId, signalId: "stale", createdAt: "2026-07-08T00:00:02.000Z" });
    expect(env.executor.executionState(await env.executor.consumeSignal(env.accountId, "stale"))).toBe("WAITING_EXECUTION");
    expect((await env.executor.accountSnapshot(env.accountId)).cashBalanceMicros).toBe("1000000000");
    env.executor.close();
  });

  it("expires and releases a waiting reservation", async () => {
    const env = setup(new Date("2026-07-08T00:00:00.000Z"));
    env.market.book = env.market.makeBook([], []);
    insertSignal({ databasePath: env.databasePath, targetId: env.targetId, signalId: "timeout", createdAt: "2026-07-08T00:00:01.000Z", marketEndTime: "2026-07-08T00:00:11.000Z" });
    const executionId = await env.executor.consumeSignal(env.accountId, "timeout");
    expect((await env.executor.accountSnapshot(env.accountId)).reservedBalanceMicros).toBe("100000000");
    env.setClock(new Date("2026-07-08T00:00:07.000Z"));
    expect(await env.executor.attemptExecution(executionId)).toBe("EXPIRED");
    expect((await env.executor.accountSnapshot(env.accountId)).reservedBalanceMicros).toBe("0");
    env.executor.close();
  });

  it("serializes reservations using available cash", async () => {
    const env = setup(new Date("2026-07-08T00:00:00.000Z"), 15_000_000n);
    env.market.book = env.market.makeBook([], []);
    insertSignal({ databasePath: env.databasePath, targetId: env.targetId, signalId: "r1", createdAt: "2026-07-08T00:00:01.000Z", confidence: "MEDIUM", capitalStatus: "INCOMPLETE" });
    insertSignal({ databasePath: env.databasePath, targetId: env.targetId, signalId: "r2", createdAt: "2026-07-08T00:00:02.000Z", confidence: "MEDIUM", capitalStatus: "INCOMPLETE" });
    expect(env.executor.executionState(await env.executor.consumeSignal(env.accountId, "r1"))).toBe("WAITING_EXECUTION");
    expect(env.executor.executionState(await env.executor.consumeSignal(env.accountId, "r2"))).toBe("REJECTED");
    expect((await env.executor.accountSnapshot(env.accountId)).reservedBalanceMicros).toBe("10000000");
    env.executor.close();
  });

  it("creates independent positions and applies TARGET_SELL ratio pro rata", async () => {
    const env = setup(new Date("2026-07-08T00:00:00.000Z"));
    insertSignal({ databasePath: env.databasePath, targetId: env.targetId, signalId: "b1", createdAt: "2026-07-08T00:00:01.000Z" });
    insertSignal({ databasePath: env.databasePath, targetId: env.targetId, signalId: "b2", createdAt: "2026-07-08T00:00:02.000Z" });
    await env.executor.consumeSignal(env.accountId, "b1");
    await env.executor.consumeSignal(env.accountId, "b2");
    expect(count(env.databasePath, "paper_positions")).toBe(2);
    insertSignal({ databasePath: env.databasePath, targetId: env.targetId, signalId: "sell-half", createdAt: "2026-07-08T00:00:03.000Z", signalType: "TARGET_SELL", sellNumerator: "1", sellDenominator: "2" });
    expect(env.executor.executionState(await env.executor.consumeSignal(env.accountId, "sell-half"))).toBe("EXECUTED");
    const db = new DatabaseSync(env.databasePath, { readOnly: true });
    const sizes = (db.prepare("SELECT current_size_micros FROM paper_positions ORDER BY created_at,paper_position_id").all() as Array<{ current_size_micros: string }>).map((row) => row.current_size_micros);
    expect(sizes.sort()).toEqual(["100000000", "90000000"].sort());
    db.close();
    env.executor.close();
  });

  it("rejects a historical sell when no Paper position exists", async () => {
    const env = setup(new Date("2026-07-08T00:00:00.000Z"));
    insertSignal({ databasePath: env.databasePath, targetId: env.targetId, signalId: "historical", createdAt: "2026-07-08T00:00:01.000Z", signalType: "TARGET_SELL", sellNumerator: "1", sellDenominator: "2" });
    expect(env.executor.executionState(await env.executor.consumeSignal(env.accountId, "historical"))).toBe("REJECTED");
    env.executor.close();
  });

  it("keeps partial normal sell in EXIT_PENDING and completes on retry", async () => {
    const env = setup(new Date("2026-07-08T00:00:00.000Z"));
    insertSignal({ databasePath: env.databasePath, targetId: env.targetId, signalId: "buy-exit", createdAt: "2026-07-08T00:00:01.000Z" });
    await env.executor.consumeSignal(env.accountId, "buy-exit");
    env.market.book = env.market.makeBook([], [{ price: "0.5", size: "50" }]);
    insertSignal({ databasePath: env.databasePath, targetId: env.targetId, signalId: "exit", createdAt: "2026-07-08T00:00:02.000Z", signalType: "TARGET_SELL", sellNumerator: "1", sellDenominator: "1" });
    const executionId = await env.executor.consumeSignal(env.accountId, "exit");
    expect(env.executor.executionState(executionId)).toBe("EXIT_PENDING");
    env.market.book = env.market.makeBook([], [{ price: "0.5", size: "1000" }]);
    expect(await env.executor.attemptExecution(executionId)).toBe("EXECUTED");
    env.executor.close();
  });

  it("triggers stop loss using full-size VWAP and supports STOP_EXIT_PENDING recovery", async () => {
    const env = setup(new Date("2026-07-08T00:00:00.000Z"));
    insertSignal({ databasePath: env.databasePath, targetId: env.targetId, signalId: "stop-buy", createdAt: "2026-07-08T00:00:01.000Z" });
    await env.executor.consumeSignal(env.accountId, "stop-buy");
    env.market.book = env.market.makeBook([], [{ price: "0.24", size: "50" }, { price: "0.20", size: "150" }]);
    const [executionId] = await env.executor.checkStopLosses(env.accountId);
    expect(executionId).toBeTruthy();
    expect(env.executor.executionState(executionId!)).toBe("STOP_EXIT_PENDING");
    env.market.book = env.market.makeBook([], [{ price: "0.24", size: "1000" }]);
    expect(await env.executor.attemptExecution(executionId!)).toBe("EXECUTED");
    env.executor.close();
  });

  it("gives stop loss priority over an unfilled TARGET_SELL", async () => {
    const env = setup(new Date("2026-07-08T00:00:00.000Z"));
    insertSignal({ databasePath: env.databasePath, targetId: env.targetId, signalId: "priority-buy", createdAt: "2026-07-08T00:00:01.000Z" });
    await env.executor.consumeSignal(env.accountId, "priority-buy");
    env.market.book = env.market.makeBook([], [{ price: "0.20", size: "1000" }]);
    insertSignal({ databasePath: env.databasePath, targetId: env.targetId, signalId: "priority-sell", createdAt: "2026-07-08T00:00:02.000Z", signalType: "TARGET_SELL", sellNumerator: "1", sellDenominator: "1" });
    const targetExecution = await env.executor.consumeSignal(env.accountId, "priority-sell");
    expect(env.executor.executionState(targetExecution)).toBe("EXIT_PENDING");
    env.market.book = env.market.makeBook([], [{ price: "0.24", size: "50" }, { price: "0.20", size: "150" }]);
    const [stopExecution] = await env.executor.checkStopLosses(env.accountId);
    expect(stopExecution).toBeTruthy();
    expect(env.executor.executionState(targetExecution)).toBe("CANCELLED");
    expect(env.executor.executionState(stopExecution!)).toBe("STOP_EXIT_PENDING");
    env.executor.close();
  });

  it("keeps settlement pending until confirmed and then simulates redeem", async () => {
    const env = setup(new Date("2026-07-08T00:00:00.000Z"));
    insertSignal({ databasePath: env.databasePath, targetId: env.targetId, signalId: "settle-buy", createdAt: "2026-07-08T00:00:01.000Z", marketEndTime: "2026-07-08T00:00:02.000Z" });
    await env.executor.consumeSignal(env.accountId, "settle-buy");
    env.setClock(new Date("2026-07-08T00:00:03.000Z"));
    expect(await env.executor.processSettlements(env.accountId)).toEqual([]);
    env.market.resolutionSnapshot = { ...env.market.resolutionSnapshot, resolved: true, payoutNumerator: "1", payoutDenominator: "1", raw: { closed: true, winner: assetId } };
    expect((await env.executor.processSettlements(env.accountId)).length).toBe(1);
    expect(count(env.databasePath, "paper_settlements")).toBe(1);
    const db = new DatabaseSync(env.databasePath, { readOnly: true });
    expect((db.prepare("SELECT status FROM paper_positions").get() as { status: string }).status).toBe("REDEEMED");
    db.close();
    env.executor.close();
  });

  it("rolls back every fill mutation on a simulated crash and recovers after restart", async () => {
    const env = setup(new Date("2026-07-08T00:00:00.000Z"));
    env.market.book = env.market.makeBook([], []);
    insertSignal({ databasePath: env.databasePath, targetId: env.targetId, signalId: "crash", createdAt: "2026-07-08T00:00:01.000Z" });
    const executionId = await env.executor.consumeSignal(env.accountId, "crash");
    const sabotage = new DatabaseSync(env.databasePath);
    sabotage.exec("CREATE TRIGGER fail_paper_position BEFORE INSERT ON paper_positions BEGIN SELECT RAISE(ABORT, 'simulated crash'); END;");
    env.market.book = env.market.makeBook([{ price: "0.5", size: "1000" }], []);
    await expect(env.executor.attemptExecution(executionId)).rejects.toThrow("simulated crash");
    expect(count(env.databasePath, "paper_orders")).toBe(1);
    expect((await env.executor.accountSnapshot(env.accountId)).cashBalanceMicros).toBe("1000000000");
    sabotage.exec("DROP TRIGGER fail_paper_position");
    sabotage.close();
    env.executor.close();
    const restarted = new PaperExecutor(env.databasePath, env.market, { sourceVersion, now: () => env.getClock() });
    expect(await restarted.attemptExecution(executionId)).toBe("EXECUTED");
    expect((await restarted.accountSnapshot(env.accountId)).cashBalanceMicros).toBe("900000000");
    restarted.close();
  });

  it("rejects a buy and releases funds when the fee model is unavailable", async () => {
    const env = setup(new Date("2026-07-08T00:00:00.000Z"));
    env.market.feeSnapshot = { ...env.market.feeSnapshot, status: "UNAVAILABLE", baseFee: null, feeRatePpm: null, exponent: null };
    insertSignal({ databasePath: env.databasePath, targetId: env.targetId, signalId: "fee-missing", createdAt: "2026-07-08T00:00:01.000Z" });
    expect(env.executor.executionState(await env.executor.consumeSignal(env.accountId, "fee-missing"))).toBe("REJECTED");
    expect((await env.executor.accountSnapshot(env.accountId)).reservedBalanceMicros).toBe("0");
    env.executor.close();
  });

  it("applies a public non-zero fee model without spending beyond reservation", async () => {
    const env = setup(new Date("2026-07-08T00:00:00.000Z"));
    env.market.feeSnapshot = { ...env.market.feeSnapshot, baseFee: 30, feeRatePpm: "30000", exponent: 1 };
    insertSignal({ databasePath: env.databasePath, targetId: env.targetId, signalId: "fee", createdAt: "2026-07-08T00:00:01.000Z" });
    expect(env.executor.executionState(await env.executor.consumeSignal(env.accountId, "fee"))).toBe("EXECUTED");
    const db = new DatabaseSync(env.databasePath, { readOnly: true });
    const fee = BigInt((db.prepare("SELECT fee_micros FROM paper_fee_ledger").get() as { fee_micros: string }).fee_micros);
    const size = BigInt((db.prepare("SELECT entry_size_micros FROM paper_positions").get() as { entry_size_micros: string }).entry_size_micros);
    expect(fee).toBeGreaterThan(0n);
    expect(size).toBeLessThan(200_000_000n);
    expect(BigInt((await env.executor.accountSnapshot(env.accountId)).cashBalanceMicros)).toBeGreaterThanOrEqual(900_000_000n);
    db.close();
    env.executor.close();
  });

  it("enforces normal sell slippage and recovers EXIT_PENDING", async () => {
    const env = setup(new Date("2026-07-08T00:00:00.000Z"));
    insertSignal({ databasePath: env.databasePath, targetId: env.targetId, signalId: "slip-buy", createdAt: "2026-07-08T00:00:01.000Z" });
    await env.executor.consumeSignal(env.accountId, "slip-buy");
    env.market.book = env.market.makeBook([], [{ price: "0.44", size: "1000" }]);
    insertSignal({ databasePath: env.databasePath, targetId: env.targetId, signalId: "slip-sell", createdAt: "2026-07-08T00:00:02.000Z", signalType: "TARGET_SELL", sellNumerator: "1", sellDenominator: "1" });
    const executionId = await env.executor.consumeSignal(env.accountId, "slip-sell");
    expect(env.executor.executionState(executionId)).toBe("EXIT_PENDING");
    env.market.book = env.market.makeBook([], [{ price: "0.45", size: "1000" }]);
    expect(await env.executor.attemptExecution(executionId)).toBe("EXECUTED");
    env.executor.close();
  });

  it("does not consume signals created before the Paper cutoff", async () => {
    const env = setup(new Date("2026-07-08T00:00:00.000Z"));
    insertSignal({ databasePath: env.databasePath, targetId: env.targetId, signalId: "old", createdAt: "2026-07-07T23:59:59.000Z" });
    expect(env.executor.executionState(await env.executor.consumeSignal(env.accountId, "old"))).toBe("REJECTED");
    expect(count(env.databasePath, "paper_positions")).toBe(0);
    env.executor.close();
  });

  it("runs the Paper loop from its consumer checkpoint without recounting signals", async () => {
    const env = setup(new Date("2026-07-08T00:00:00.000Z"));
    insertSignal({ databasePath: env.databasePath, targetId: env.targetId, signalId: "runner", createdAt: "2026-07-08T00:00:01.000Z" });
    const report = await new PaperRunner(env.executor, {
      accountId: env.accountId,
      intervalMs: 1_000,
      durationMs: 2_000,
      now: () => env.getClock(),
      wait: async (milliseconds) => env.setClock(new Date(env.getClock().valueOf() + milliseconds)),
    }).run();
    expect(report.cycles).toBe(2);
    expect(report.consumedSignals).toBe(1);
    expect(report.errors).toEqual([]);
    env.executor.close();
  });
});
