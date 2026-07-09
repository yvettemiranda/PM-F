import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { RULESET_HASH, RULESET_SNAPSHOT_JSON, VERSIONS } from "../src/domain/versioning.js";
import { EXECUTOR_REQUIRED_CONTEXT_FIELDS } from "../src/execution/types.js";
import { Phase0Database } from "../src/infra/sqlite/database.js";
import type { SourceVersion } from "../src/infra/source-version.js";
import { LiveExecutorPlaceholder } from "../src/live/live-executor.js";
import { PaperExecutor } from "../src/paper/paper-executor.js";
import { PaperRunner } from "../src/paper/paper-runner.js";
import type {
  PaperFeeSnapshot,
  PaperMarketDataProvider,
  PaperOrderbookSnapshot,
  PaperResolutionSnapshot,
} from "../src/paper/types.js";
import { calculateUnrealizedPnl } from "../src/pnl/pnl-model.js";
import { RiskManager } from "../src/risk/risk-manager.js";
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

function loadPaperSignal(databasePath: string, signalId: string) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  const row = db.prepare(
    `SELECT s.signal_id,s.signal_type,s.status,s.execution_eligible,s.execution_block_reason,
            s.asset_id,s.condition_id,s.target_price_units,s.target_size_micros,
            s.sell_ratio_numerator,s.sell_ratio_denominator,s.created_at,
            c.context_id,c.capital_decision_id,c.target_trade_capital_ratio_ppm,
            c.target_trade_timestamp,c.market_end_time,c.market_metadata_snapshot_json,
            c.market_metadata_hash,c.ruleset_hash,c.source_code_commit,
            c.source_code_dirty,c.config_version,c.created_at context_created_at,
            ce.capital_estimate_status,ce.capital_confidence,
            ce.target_trade_capital_ratio_ppm capital_ratio_ppm,ce.fallback_amount_micros
     FROM signals s
     JOIN signal_execution_contexts c ON c.signal_id=s.signal_id
     LEFT JOIN capital_estimates ce ON ce.capital_estimate_id=c.capital_decision_id
     WHERE s.signal_id=?`,
  ).get(signalId) as Record<string, unknown>;
  db.close();
  const context = {
    contextId: row.context_id as string,
    signalId: row.signal_id as string,
    capitalDecisionId: row.capital_decision_id as string | null,
    targetTradeCapitalRatioPpm: row.target_trade_capital_ratio_ppm as string | null,
    targetTradeTimestamp: row.target_trade_timestamp as string,
    marketEndTime: row.market_end_time as string,
    marketMetadataSnapshot: JSON.parse(row.market_metadata_snapshot_json as string),
    marketMetadataHash: row.market_metadata_hash as string,
    rulesetHash: row.ruleset_hash as string,
    sourceCodeCommit: row.source_code_commit as string,
    sourceCodeDirty: (row.source_code_dirty as number) !== 0,
    configVersion: row.config_version as string,
    createdAt: row.context_created_at as string,
  };
  return {
    signalId: row.signal_id as string,
    signalType: row.signal_type as "TARGET_BUY" | "TARGET_SELL",
    status: row.status as string,
    executionEligible: (row.execution_eligible as number) !== 0,
    executionBlockReason: row.execution_block_reason as string | null,
    assetId: row.asset_id as string,
    conditionId: row.condition_id as string,
    targetPriceUnits: row.target_price_units as string,
    targetSizeMicros: row.target_size_micros as string,
    sellRatioNumerator: row.sell_ratio_numerator as string | null,
    sellRatioDenominator: row.sell_ratio_denominator as string | null,
    createdAt: row.created_at as string,
    context,
    capitalDecision: row.capital_estimate_status ? {
      status: row.capital_estimate_status as CapitalEstimateStatus,
      confidence: row.capital_confidence as CapitalConfidence,
      ratioPpm: row.capital_ratio_ppm as string | null,
      fallbackAmountMicros: row.fallback_amount_micros as string,
    } : null,
  };
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

  it("uses one executor input contract for Paper and the Live placeholder", async () => {
    const env = setup(new Date("2026-07-08T00:00:00.000Z"));
    insertSignal({ databasePath: env.databasePath, targetId: env.targetId, signalId: "contract", createdAt: "2026-07-08T00:00:01.000Z" });
    const db = new DatabaseSync(env.databasePath, { readOnly: true });
    const context = db.prepare("SELECT * FROM signal_execution_contexts WHERE signal_id='contract'").get() as Record<string, unknown>;
    const contextColumnByField: Record<string, string> = {
      capitalDecisionId: "capital_decision_id",
      targetTradeCapitalRatioPpm: "target_trade_capital_ratio_ppm",
      targetTradeTimestamp: "target_trade_timestamp",
      marketEndTime: "market_end_time",
      marketMetadataSnapshot: "market_metadata_snapshot_json",
      rulesetHash: "ruleset_hash",
      sourceCodeCommit: "source_code_commit",
      configVersion: "config_version",
    };
    for (const field of EXECUTOR_REQUIRED_CONTEXT_FIELDS) {
      const column = contextColumnByField[field];
      if (!column) throw new Error(`Missing test mapping for ${field}`);
      expect(context[column]).not.toBeUndefined();
    }
    db.close();
    expect(env.executor.mode).toBe("PAPER");
    const live = new LiveExecutorPlaceholder();
    expect(live.mode).toBe("LIVE");
    await expect(live.executeBuy({
      accountId: env.accountId,
      signal: {
        signalId: "contract",
        signalType: "TARGET_BUY",
        status: "PUBLISHED",
        executionEligible: true,
        executionBlockReason: null,
        assetId,
        conditionId,
        targetPriceUnits: "500000000000000000",
        targetSizeMicros: "10000000",
        sellRatioNumerator: null,
        sellRatioDenominator: null,
        createdAt: "2026-07-08T00:00:01.000Z",
        context: {
          contextId: context.context_id as string,
          signalId: "contract",
          capitalDecisionId: context.capital_decision_id as string | null,
          targetTradeCapitalRatioPpm: context.target_trade_capital_ratio_ppm as string | null,
          targetTradeTimestamp: context.target_trade_timestamp as string,
          marketEndTime: context.market_end_time as string,
          marketMetadataSnapshot: JSON.parse(context.market_metadata_snapshot_json as string),
          marketMetadataHash: context.market_metadata_hash as string,
          rulesetHash: context.ruleset_hash as string,
          sourceCodeCommit: context.source_code_commit as string,
          sourceCodeDirty: (context.source_code_dirty as number) !== 0,
          configVersion: context.config_version as string,
          createdAt: context.created_at as string,
        },
        capitalDecision: { status: "COMPLETE", confidence: "HIGH", ratioPpm: "100000", fallbackAmountMicros: "10000000" },
      },
      context: {
        contextId: context.context_id as string,
        signalId: "contract",
        capitalDecisionId: context.capital_decision_id as string | null,
        targetTradeCapitalRatioPpm: context.target_trade_capital_ratio_ppm as string | null,
        targetTradeTimestamp: context.target_trade_timestamp as string,
        marketEndTime: context.market_end_time as string,
        marketMetadataSnapshot: JSON.parse(context.market_metadata_snapshot_json as string),
        marketMetadataHash: context.market_metadata_hash as string,
        rulesetHash: context.ruleset_hash as string,
        sourceCodeCommit: context.source_code_commit as string,
        sourceCodeDirty: (context.source_code_dirty as number) !== 0,
        configVersion: context.config_version as string,
        createdAt: context.created_at as string,
      },
      riskDecisionId: "risk-contract",
    })).rejects.toThrow("LIVE_EXECUTOR_NOT_IMPLEMENTED");
    env.executor.close();
  });

  it("uses the pre-approved Risk Decision passed through Executor Interface", async () => {
    const env = setup(new Date("2026-07-08T00:00:00.000Z"));
    insertSignal({ databasePath: env.databasePath, targetId: env.targetId, signalId: "interface-risk", createdAt: "2026-07-08T00:00:01.000Z" });
    const signal = loadPaperSignal(env.databasePath, "interface-risk");
    const riskDb = new DatabaseSync(env.databasePath);
    const risk = new RiskManager(riskDb, sourceVersion).evaluate({
      mode: "PAPER",
      accountId: env.accountId,
      signal,
      requestedAmountMicros: 100_000_000n,
      requestedSizeMicros: null,
      now: "2026-07-08T00:00:00.000Z",
    });
    riskDb.close();
    const result = await env.executor.executeBuy({
      accountId: env.accountId,
      signal,
      context: signal.context!,
      riskDecisionId: risk.riskDecisionId,
    });
    expect(result.state).toBe("WAITING_EXECUTION");
    const db = new DatabaseSync(env.databasePath, { readOnly: true });
    const row = db.prepare(
      "SELECT risk_decision_id FROM paper_executions WHERE paper_execution_id=?",
    ).get(result.executionId) as { risk_decision_id: string };
    expect(row.risk_decision_id).toBe(risk.riskDecisionId);
    expect(count(env.databasePath, "risk_decisions")).toBe(1);
    db.close();
    env.executor.close();
  });

  it("records Risk Manager ALLOW decisions before execution", async () => {
    const env = setup(new Date("2026-07-08T00:00:00.000Z"));
    insertSignal({ databasePath: env.databasePath, targetId: env.targetId, signalId: "risk-allow", createdAt: "2026-07-08T00:00:01.000Z" });
    const executionId = await env.executor.consumeSignal(env.accountId, "risk-allow");
    const db = new DatabaseSync(env.databasePath, { readOnly: true });
    const decision = db.prepare(
      `SELECT d.decision,d.risk_reject_reason,e.risk_decision_id
       FROM risk_decisions d JOIN paper_executions e ON e.risk_decision_id=d.risk_decision_id
       WHERE e.paper_execution_id=?`,
    ).get(executionId) as { decision: string; risk_reject_reason: string | null; risk_decision_id: string };
    expect(decision.decision).toBe("ALLOW");
    expect(decision.risk_reject_reason).toBeNull();
    expect(decision.risk_decision_id).toBeTruthy();
    db.close();
    env.executor.close();
  });

  it("records Risk Manager REJECT decisions and riskRejectReason", async () => {
    const env = setup(new Date("2026-07-08T00:00:00.000Z"));
    insertSignal({ databasePath: env.databasePath, targetId: env.targetId, signalId: "risk-reject", createdAt: "2026-07-08T00:00:01.000Z", confidence: "LOW", capitalStatus: "FAILED" });
    const executionId = await env.executor.consumeSignal(env.accountId, "risk-reject");
    expect(env.executor.executionState(executionId)).toBe("REJECTED");
    const db = new DatabaseSync(env.databasePath, { readOnly: true });
    const row = db.prepare(
      `SELECT d.decision,d.risk_reject_reason,e.risk_reject_reason execution_reason
       FROM risk_decisions d JOIN paper_executions e ON e.risk_decision_id=d.risk_decision_id
       WHERE e.paper_execution_id=?`,
    ).get(executionId) as { decision: string; risk_reject_reason: string; execution_reason: string };
    expect(row).toEqual({ decision: "REJECT", risk_reject_reason: "CAPITAL_CONFIDENCE_LOW", execution_reason: "CAPITAL_CONFIDENCE_LOW" });
    db.close();
    env.executor.close();
  });

  it("freezes positions during reconciliation protection and unfreezes after success", async () => {
    const env = setup(new Date("2026-07-08T00:00:00.000Z"));
    insertSignal({ databasePath: env.databasePath, targetId: env.targetId, signalId: "freeze-buy", createdAt: "2026-07-08T00:00:01.000Z" });
    await env.executor.consumeSignal(env.accountId, "freeze-buy");
    expect((await env.executor.reconcile({ accountId: env.accountId, reason: "RECONCILIATION_MAJOR_DESYNC" })).frozenPositionCount).toBe(1);
    const db = new DatabaseSync(env.databasePath, { readOnly: true });
    expect((db.prepare("SELECT status FROM paper_positions").get() as { status: string }).status).toBe("FROZEN");
    db.close();
    insertSignal({ databasePath: env.databasePath, targetId: env.targetId, signalId: "freeze-sell", createdAt: "2026-07-08T00:00:02.000Z", signalType: "TARGET_SELL", sellNumerator: "1", sellDenominator: "1" });
    const sellExecution = await env.executor.consumeSignal(env.accountId, "freeze-sell");
    expect(env.executor.executionState(sellExecution)).toBe("REJECTED");
    expect(await env.executor.checkStopLosses(env.accountId)).toEqual([]);
    expect((await env.executor.reconcile({ accountId: env.accountId, reason: "RECONCILIATION_SUCCESS" })).frozenPositionCount).toBe(1);
    const after = new DatabaseSync(env.databasePath, { readOnly: true });
    expect((after.prepare("SELECT status FROM paper_positions").get() as { status: string }).status).toBe("OPEN");
    after.close();
    env.executor.close();
  });

  it("rejects execution when an unresolved MAJOR_DESYNC reconciliation issue exists", async () => {
    const env = setup(new Date("2026-07-08T00:00:00.000Z"));
    const db = new DatabaseSync(env.databasePath);
    db.prepare(
      `INSERT INTO reconciliation_issues(
        issue_id,target_id,asset_id,issue_type,expected_value,observed_value,sync_status,status,detail_json,created_at
      ) VALUES ('issue-major', ?, ?, 'POSITION_DIFF', '1', '2', 'MAJOR_DESYNC', 'OPEN', '{}', ?)`,
    ).run(env.targetId, assetId, "2026-07-08T00:00:00.000Z");
    db.close();
    insertSignal({ databasePath: env.databasePath, targetId: env.targetId, signalId: "major-reject", createdAt: "2026-07-08T00:00:01.000Z" });
    const executionId = await env.executor.consumeSignal(env.accountId, "major-reject");
    expect(env.executor.executionState(executionId)).toBe("REJECTED");
    const check = new DatabaseSync(env.databasePath, { readOnly: true });
    expect((check.prepare("SELECT risk_reject_reason FROM paper_executions WHERE paper_execution_id=?").get(executionId) as { risk_reject_reason: string }).risk_reject_reason)
      .toContain("MAJOR_DESYNC_RECONCILIATION");
    check.close();
    env.executor.close();
  });

  it("keeps Settlement Service pending until public resolution is confirmed", async () => {
    const env = setup(new Date("2026-07-08T00:00:00.000Z"));
    insertSignal({ databasePath: env.databasePath, targetId: env.targetId, signalId: "service-settle", createdAt: "2026-07-08T00:00:01.000Z", marketEndTime: "2026-07-08T00:00:02.000Z" });
    await env.executor.consumeSignal(env.accountId, "service-settle");
    env.setClock(new Date("2026-07-08T00:00:03.000Z"));
    expect(await env.executor.processSettlements(env.accountId)).toEqual([]);
    const db = new DatabaseSync(env.databasePath, { readOnly: true });
    expect((db.prepare("SELECT status FROM paper_positions").get() as { status: string }).status).toBe("SETTLEMENT_PENDING");
    expect(count(env.databasePath, "paper_settlements")).toBe(0);
    db.close();
    env.executor.close();
  });

  it("calculates unrealized PnL from full-depth exit VWAP and records the source", async () => {
    const env = setup(new Date("2026-07-08T00:00:00.000Z"));
    insertSignal({ databasePath: env.databasePath, targetId: env.targetId, signalId: "pnl-buy", createdAt: "2026-07-08T00:00:01.000Z" });
    await env.executor.consumeSignal(env.accountId, "pnl-buy");
    env.market.book = env.market.makeBook([], [{ price: "0.4", size: "100" }, { price: "0.3", size: "100" }]);
    const snapshot = await env.executor.accountSnapshot(env.accountId);
    expect(snapshot.positionValueMicros).toBe("70000000");
    expect(snapshot.unrealizedPnlMicros).toBe(calculateUnrealizedPnl({
      exitValueMicros: 70_000_000n,
      estimatedExitFeeMicros: 0n,
      remainingCostMicros: 100_000_000n,
    }).toString());
    const db = new DatabaseSync(env.databasePath, { readOnly: true });
    const row = db.prepare("SELECT price_source,price_timestamp,unrealized_pnl_micros FROM paper_unrealized_pnl_snapshots LIMIT 1")
      .get() as { price_source: string; price_timestamp: string; unrealized_pnl_micros: string };
    expect(row.price_source).toBe("ORDERBOOK_EXIT_VWAP");
    expect(row.price_timestamp).toBe("2026-07-08T00:00:00.000Z");
    expect(row.unrealized_pnl_micros).toBe("-30000000");
    db.close();
    env.executor.close();
  });

  it("writes immutable Audit Log entries for signal, risk, execution, and position actions", async () => {
    const env = setup(new Date("2026-07-08T00:00:00.000Z"));
    insertSignal({ databasePath: env.databasePath, targetId: env.targetId, signalId: "audit-buy", createdAt: "2026-07-08T00:00:01.000Z" });
    await env.executor.consumeSignal(env.accountId, "audit-buy");
    const db = new DatabaseSync(env.databasePath);
    const actions = (db.prepare("SELECT entity_type,action FROM audit_log ORDER BY timestamp,entity_type,action").all() as Array<{ entity_type: string; action: string }>)
      .map((row) => `${row.entity_type}:${row.action}`);
    expect(actions).toContain("SIGNAL:RECEIVED");
    expect(actions).toContain("SIGNAL:ACCEPTED");
    expect(actions).toContain("RISK_DECISION:ALLOW");
    expect(actions).toContain("EXECUTION:CREATED");
    expect(actions).toContain("PAPER_EXECUTION:FILLED");
    expect(actions).toContain("PAPER_POSITION:OPENED");
    expect(() => db.prepare("UPDATE audit_log SET action='MUTATED'").run()).toThrow("audit_log is immutable");
    db.close();
    env.executor.close();
  });

  it("persists ruleset, source commit, and config version on core Paper objects", async () => {
    const env = setup(new Date("2026-07-08T00:00:00.000Z"));
    insertSignal({ databasePath: env.databasePath, targetId: env.targetId, signalId: "versioned", createdAt: "2026-07-08T00:00:01.000Z", marketEndTime: "2026-07-08T00:00:02.000Z" });
    await env.executor.consumeSignal(env.accountId, "versioned");
    env.setClock(new Date("2026-07-08T00:00:03.000Z"));
    env.market.resolutionSnapshot = { ...env.market.resolutionSnapshot, resolved: true, payoutNumerator: "1", payoutDenominator: "1", raw: { closed: true } };
    await env.executor.processSettlements(env.accountId);
    const db = new DatabaseSync(env.databasePath, { readOnly: true });
    for (const table of ["signal_execution_contexts", "paper_executions", "paper_positions", "paper_settlements"]) {
      const row = db.prepare(`SELECT ruleset_hash,source_code_commit,config_version FROM ${table} LIMIT 1`).get() as {
        ruleset_hash: string;
        source_code_commit: string;
        config_version: string;
      };
      expect(row.ruleset_hash).toBe(RULESET_HASH);
      expect(row.source_code_commit).toBe(sourceVersion.commit);
      expect(row.config_version).toBe(VERSIONS.configVersion);
    }
    db.close();
    env.executor.close();
  });

  it("registers the active ruleset and links executions, positions, and settlements to it", async () => {
    const env = setup(new Date("2026-07-08T00:00:00.000Z"));
    insertSignal({ databasePath: env.databasePath, targetId: env.targetId, signalId: "registry", createdAt: "2026-07-08T00:00:01.000Z", marketEndTime: "2026-07-08T00:00:02.000Z" });
    await env.executor.consumeSignal(env.accountId, "registry");
    env.setClock(new Date("2026-07-08T00:00:03.000Z"));
    env.market.resolutionSnapshot = { ...env.market.resolutionSnapshot, resolved: true, payoutNumerator: "1", payoutDenominator: "1", raw: { closed: true } };
    await env.executor.processSettlements(env.accountId);
    const db = new DatabaseSync(env.databasePath, { readOnly: true });
    const registry = db.prepare(
      `SELECT ruleset_version,buy_price_lower_ratio_ppm,buy_price_upper_ratio_ppm,
              stop_loss_ratio_ppm,wait_ratio_ppm,max_wait_time_ms,capital_mode,
              fee_model_version,source_code_commit,config_version
       FROM ruleset_registry WHERE ruleset_hash=?`,
    ).get(RULESET_HASH) as {
      ruleset_version: string;
      buy_price_lower_ratio_ppm: number;
      buy_price_upper_ratio_ppm: number;
      stop_loss_ratio_ppm: number;
      wait_ratio_ppm: number;
      max_wait_time_ms: number;
      capital_mode: string;
      fee_model_version: string;
      source_code_commit: string;
      config_version: string;
    };
    expect(registry).toMatchObject({
      ruleset_version: VERSIONS.rulesetVersion,
      buy_price_lower_ratio_ppm: 980_000,
      buy_price_upper_ratio_ppm: 1_020_000,
      stop_loss_ratio_ppm: 500_000,
      wait_ratio_ppm: 500_000,
      max_wait_time_ms: 1_800_000,
      capital_mode: "PROPORTIONAL_WITH_FIXED_FALLBACK",
      fee_model_version: VERSIONS.feeModelVersion,
      source_code_commit: sourceVersion.commit,
      config_version: VERSIONS.configVersion,
    });
    for (const table of ["paper_executions", "paper_positions", "paper_settlements"]) {
      const missing = db.prepare(
        `SELECT count(*) count
         FROM ${table} object
         LEFT JOIN ruleset_registry registry ON registry.ruleset_hash=object.ruleset_hash
         WHERE registry.ruleset_hash IS NULL`,
      ).get() as { count: number };
      expect(missing.count).toBe(0);
    }
    db.close();
    env.executor.close();
  });

  it("links every Paper execution, including system stop loss and settlement, to a Risk Decision", async () => {
    const stopEnv = setup(new Date("2026-07-08T00:00:00.000Z"));
    insertSignal({ databasePath: stopEnv.databasePath, targetId: stopEnv.targetId, signalId: "risk-stop", createdAt: "2026-07-08T00:00:01.000Z" });
    await stopEnv.executor.consumeSignal(stopEnv.accountId, "risk-stop");
    stopEnv.market.book = stopEnv.market.makeBook([], [{ price: "0.24", size: "1000" }]);
    await stopEnv.executor.checkStopLosses(stopEnv.accountId);
    const stopDb = new DatabaseSync(stopEnv.databasePath, { readOnly: true });
    const stopMissing = stopDb.prepare(
      `SELECT count(*) count
       FROM paper_executions e
       LEFT JOIN risk_decisions d ON d.risk_decision_id=e.risk_decision_id
       WHERE d.risk_decision_id IS NULL`,
    ).get() as { count: number };
    expect(stopMissing.count).toBe(0);
    expect((stopDb.prepare(
      `SELECT d.risk_reason
       FROM paper_executions e JOIN risk_decisions d ON d.risk_decision_id=e.risk_decision_id
       WHERE e.execution_type='STOP_LOSS'`,
    ).get() as { risk_reason: string }).risk_reason).toBe("STOP_LOSS_TRIGGERED");
    stopDb.close();
    stopEnv.executor.close();

    const settlementEnv = setup(new Date("2026-07-08T00:00:00.000Z"));
    insertSignal({ databasePath: settlementEnv.databasePath, targetId: settlementEnv.targetId, signalId: "risk-settle", createdAt: "2026-07-08T00:00:01.000Z", marketEndTime: "2026-07-08T00:00:02.000Z" });
    await settlementEnv.executor.consumeSignal(settlementEnv.accountId, "risk-settle");
    settlementEnv.setClock(new Date("2026-07-08T00:00:03.000Z"));
    settlementEnv.market.resolutionSnapshot = { ...settlementEnv.market.resolutionSnapshot, resolved: true, payoutNumerator: "1", payoutDenominator: "1", raw: { closed: true } };
    await settlementEnv.executor.processSettlements(settlementEnv.accountId);
    const settlementDb = new DatabaseSync(settlementEnv.databasePath, { readOnly: true });
    const settlementMissing = settlementDb.prepare(
      `SELECT count(*) count
       FROM paper_executions e
       LEFT JOIN risk_decisions d ON d.risk_decision_id=e.risk_decision_id
       WHERE d.risk_decision_id IS NULL`,
    ).get() as { count: number };
    expect(settlementMissing.count).toBe(0);
    expect((settlementDb.prepare(
      `SELECT d.risk_reason
       FROM paper_executions e JOIN risk_decisions d ON d.risk_decision_id=e.risk_decision_id
       WHERE e.execution_type='SETTLEMENT'`,
    ).get() as { risk_reason: string }).risk_reason).toBe("SETTLEMENT_CONFIRMED");
    settlementDb.close();
    settlementEnv.executor.close();
  });

  it("projects account state through Portfolio Projection and persists the projection run", async () => {
    const env = setup(new Date("2026-07-08T00:00:00.000Z"));
    insertSignal({ databasePath: env.databasePath, targetId: env.targetId, signalId: "portfolio", createdAt: "2026-07-08T00:00:01.000Z" });
    await env.executor.consumeSignal(env.accountId, "portfolio");
    env.market.book = env.market.makeBook([], [{ price: "0.4", size: "1000" }]);
    const snapshot = await env.executor.accountSnapshot(env.accountId);
    const db = new DatabaseSync(env.databasePath, { readOnly: true });
    const projection = db.prepare(
      `SELECT cash_balance_micros,reserved_balance_micros,position_value_micros,
              realized_pnl_micros,unrealized_pnl_micros,total_equity_micros,
              valuation_status,price_source,ruleset_hash
       FROM portfolio_projection_runs WHERE paper_account_id=? ORDER BY created_at DESC LIMIT 1`,
    ).get(env.accountId) as {
      cash_balance_micros: string;
      reserved_balance_micros: string;
      position_value_micros: string;
      realized_pnl_micros: string;
      unrealized_pnl_micros: string;
      total_equity_micros: string;
      valuation_status: string;
      price_source: string;
      ruleset_hash: string;
    };
    expect(projection).toMatchObject({
      cash_balance_micros: snapshot.cashBalanceMicros,
      reserved_balance_micros: snapshot.reservedBalanceMicros,
      position_value_micros: snapshot.positionValueMicros,
      realized_pnl_micros: snapshot.realizedPnlMicros,
      unrealized_pnl_micros: snapshot.unrealizedPnlMicros,
      total_equity_micros: snapshot.totalEquityMicros,
      valuation_status: snapshot.valuationStatus,
      price_source: "ORDERBOOK_EXIT_VWAP",
      ruleset_hash: RULESET_HASH,
    });
    expect(count(env.databasePath, "paper_portfolio_snapshots")).toBe(1);
    db.close();
    env.executor.close();
  });

  it("keeps execution audit coverage for ledgers, state transitions, idempotency, and audit log", async () => {
    const env = setup(new Date("2026-07-08T00:00:00.000Z"));
    insertSignal({ databasePath: env.databasePath, targetId: env.targetId, signalId: "audit-integrity", createdAt: "2026-07-08T00:00:01.000Z" });
    const executionId = await env.executor.consumeSignal(env.accountId, "audit-integrity");
    const db = new DatabaseSync(env.databasePath, { readOnly: true });
    const execution = db.prepare(
      "SELECT execution_idempotency_key,risk_decision_id FROM paper_executions WHERE paper_execution_id=?",
    ).get(executionId) as { execution_idempotency_key: string; risk_decision_id: string };
    expect(execution.execution_idempotency_key).toBeTruthy();
    expect(execution.risk_decision_id).toBeTruthy();
    expect((db.prepare("SELECT count(*) count FROM paper_cash_ledger WHERE paper_execution_id=?").get(executionId) as { count: number }).count).toBeGreaterThan(0);
    expect((db.prepare("SELECT count(*) count FROM paper_fill_ledger WHERE paper_execution_id=?").get(executionId) as { count: number }).count).toBeGreaterThan(0);
    expect((db.prepare("SELECT count(*) count FROM paper_state_transitions WHERE entity_id=?").get(executionId) as { count: number }).count).toBeGreaterThan(0);
    expect((db.prepare("SELECT count(*) count FROM audit_log WHERE entity_id=?").get(executionId) as { count: number }).count).toBeGreaterThan(0);
    db.close();
    env.executor.close();
  });

  it("keeps Paper and Live isolated from private key or real order dependencies", () => {
    const paperSource = readFileSync(new URL("../src/paper/paper-executor.ts", import.meta.url), "utf8");
    const liveSource = readFileSync(new URL("../src/live/live-executor.ts", import.meta.url), "utf8");
    for (const forbidden of ["privateKey", "secret", "apiKey", "createOrder", "postOrder", "submitOrder", "signOrder"]) {
      expect(paperSource).not.toContain(forbidden);
    }
    expect(liveSource).toContain("LIVE_EXECUTOR_NOT_IMPLEMENTED");
    expect(liveSource).not.toContain("privateKey");
    expect(liveSource).not.toContain("createOrder");
  });

  it("recovers idempotently after restart without duplicating risk decisions", async () => {
    const env = setup(new Date("2026-07-08T00:00:00.000Z"));
    insertSignal({ databasePath: env.databasePath, targetId: env.targetId, signalId: "restart-idem", createdAt: "2026-07-08T00:00:01.000Z" });
    const first = await env.executor.consumeSignal(env.accountId, "restart-idem");
    env.executor.close();
    const restarted = new PaperExecutor(env.databasePath, env.market, { sourceVersion, now: () => env.getClock() });
    expect(await restarted.consumeSignal(env.accountId, "restart-idem")).toBe(first);
    expect(count(env.databasePath, "risk_decisions")).toBe(1);
    expect(count(env.databasePath, "paper_signal_consumptions")).toBe(1);
    restarted.close();
  });
});
