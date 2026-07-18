import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { RULESET, RULESET_HASH, RULESET_SNAPSHOT_JSON, stableJson, VERSIONS } from "../src/domain/versioning.js";
import { EXECUTOR_REQUIRED_CONTEXT_FIELDS } from "../src/execution/types.js";
import { buildExactCapitalRatio, capitalSizingHash } from "../src/execution/capital-sizing.js";
import type { MarketOrderConstraintEvidence } from "../src/execution/market-order-constraints.js";
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
const childProcesses: ChildProcess[] = [];

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("TIMED_OUT_WAITING_FOR_PAPER_CRASH_BARRIER");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
}

async function killPaperWorkerAtBarrier(input: {
  databasePath: string;
  accountId: string;
  signalId: string;
  barrier: "RESERVATION_BEFORE_COMMIT" | "BUY_FILL_BEFORE_COMMIT" | "SETTLEMENT_BEFORE_COMMIT";
  markerPath: string;
  nowIso: string;
}): Promise<void> {
  const fixture = new URL("./fixtures/paper-crash-worker.ts", import.meta.url).pathname;
  const child = spawn(process.execPath, [
    "--import",
    "tsx",
    fixture,
    input.databasePath,
    input.accountId,
    input.barrier,
    input.signalId,
    input.markerPath,
    input.nowIso,
  ], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  childProcesses.push(child);
  let stderr = "";
  child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
  await waitUntil(() => {
    if (existsSync(input.markerPath)) return true;
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`PAPER_CRASH_WORKER_EXITED_EARLY:${stderr}`);
    }
    return false;
  });
  child.kill("SIGKILL");
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(() => rejectPromise(new Error("PAPER_CRASH_WORKER_DID_NOT_EXIT")), 5_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolvePromise();
    });
  });
}

function expectDatabaseSafe(databasePath: string): void {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  expect((database.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check)
    .toBe("ok");
  expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  database.close();
}

interface TestRuleset {
  hash: string;
  snapshotJson: string;
  configVersion: string;
}

function installHistoricalPaperRuleset(databasePath: string): TestRuleset {
  const snapshot = JSON.parse(RULESET_SNAPSHOT_JSON) as {
    versions: Record<string, unknown>;
    rules: Record<string, unknown>;
  };
  snapshot.versions.rulesetVersion = "test-paper-historical-v1";
  snapshot.versions.configVersion = "test-paper-historical-config-v1";
  snapshot.rules.stopTriggerRatioPpm = 600_000;
  snapshot.rules.stopSellMaxSlippagePpm = 200_000;
  const snapshotJson = stableJson(snapshot);
  const hash = createHash("sha256").update(snapshotJson).digest("hex");
  const configVersion = "test-paper-historical-config-v1";
  const db = new DatabaseSync(databasePath);
  db.prepare(
    `INSERT INTO rulesets(
      ruleset_hash,schema_version,signal_version,strategy_version,risk_version,replay_version,
      ruleset_snapshot_json,source_code_commit,source_code_dirty,config_version,created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
  ).run(
    hash,
    VERSIONS.schemaVersion,
    VERSIONS.signalVersion,
    VERSIONS.strategyVersion,
    VERSIONS.riskVersion,
    VERSIONS.replayVersion,
    snapshotJson,
    sourceVersion.commit,
    configVersion,
    "2026-07-08T00:00:00.000Z",
  );
  db.prepare(
    `INSERT INTO ruleset_registry(
      ruleset_hash,ruleset_version,buy_price_lower_ratio_ppm,buy_price_upper_ratio_ppm,
      stop_loss_ratio_ppm,wait_ratio_ppm,max_wait_time_ms,capital_mode,fee_model_version,
      ruleset_snapshot_json,source_code_commit,source_code_dirty,config_version,created_at
    ) VALUES (?, 'test-paper-historical-v1', ?, ?, 600000, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
  ).run(
    hash,
    RULESET.buyPriceMinRatioPpm,
    RULESET.buyPriceMaxRatioPpm,
    RULESET.waitRatioPpm,
    RULESET.maxWaitMs,
    RULESET.capitalMode,
    VERSIONS.feeModelVersion,
    snapshotJson,
    sourceVersion.commit,
    configVersion,
    "2026-07-08T00:00:00.000Z",
  );
  db.close();
  return { hash, snapshotJson, configVersion };
}

class FakeMarketData implements PaperMarketDataProvider {
  book: PaperOrderbookSnapshot;
  feeSnapshot: PaperFeeSnapshot;
  resolutionSnapshot: PaperResolutionSnapshot;
  resolutionError: Error | null = null;
  orderbookError: Error | null = null;
  orderbookCalls = 0;
  feeCalls = 0;
  resolutionCalls = 0;
  beforeOrderbook: (() => void) | null = null;
  beforeFee: (() => void) | null = null;

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
      minOrderSize: "1",
      tickSize: "0.01",
      asks,
      bids,
    };
  }

  async orderbook(_assetId?: string, _conditionId?: string, _signal?: AbortSignal): Promise<PaperOrderbookSnapshot> {
    this.orderbookCalls += 1;
    this.beforeOrderbook?.();
    if (this.orderbookError) throw this.orderbookError;
    return this.book;
  }

  async fee(): Promise<PaperFeeSnapshot> {
    this.feeCalls += 1;
    this.beforeFee?.();
    return { ...this.feeSnapshot, snapshotTime: this.clock().toISOString() };
  }

  async resolution(): Promise<PaperResolutionSnapshot> {
    this.resolutionCalls += 1;
    if (this.resolutionError) throw this.resolutionError;
    return { ...this.resolutionSnapshot, snapshotTime: this.clock().toISOString() };
  }

  resetCallCounts(): void {
    this.orderbookCalls = 0;
    this.feeCalls = 0;
    this.resolutionCalls = 0;
  }
}

function setup(
  now: Date,
  initialBalanceMicros = 1_000_000_000n,
  marketClockOffsetMs = 0,
) {
  const directory = mkdtempSync(join(tmpdir(), "ni-k-paper-"));
  directories.push(directory);
  const databasePath = join(directory, "phase0.sqlite");
  const phase0 = new Phase0Database(databasePath, sourceVersion);
  phase0.initialize();
  const targetId = phase0.ensureTarget(wallet, "IDENTITY_CONFIRMED");
  phase0.close();
  let clock = now;
  const market = new FakeMarketData(() => clock);
  const executor = new PaperExecutor(databasePath, market, {
    sourceVersion,
    now: () => clock,
    marketClockOffsetMs,
  });
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
  ruleset?: TestRuleset;
  exactSizing?: {
    targetPriceUnits: string;
    targetSizeMicros: string;
    targetVisibleCapitalMicros: string;
  };
}): void {
  const db = new DatabaseSync(input.databasePath);
  db.exec("PRAGMA foreign_keys=ON");
  const sourceKey = `source-${input.signalId}`;
  const contextId = `context-${input.signalId}`;
  const capitalId = input.signalType === "TARGET_SELL" ? null : `capital-${input.signalId}`;
  const rulesetHash = input.ruleset?.hash ?? RULESET_HASH;
  const rulesetSnapshotJson = input.ruleset?.snapshotJson ?? RULESET_SNAPSHOT_JSON;
  const configVersion = input.ruleset?.configVersion ?? VERSIONS.configVersion;
  const metadataJson = stableJson({ tokens: [{ token_id: assetId, outcome: "Yes" }] });
  const metadataHash = createHash("sha256").update(metadataJson).digest("hex");
  const exactRatio = input.exactSizing ? buildExactCapitalRatio(input.exactSizing) : null;
  const exactRatioJson = exactRatio ? stableJson(exactRatio) : null;
  const exactRatioHash = exactRatio ? capitalSizingHash(exactRatio) : null;
  const targetPriceUnits = input.exactSizing?.targetPriceUnits ?? input.targetPriceUnits ?? "500000000000000000";
  const targetSizeMicros = input.exactSizing?.targetSizeMicros ?? "10000000";
  db.prepare(
    `INSERT INTO raw_events(
      source_event_key,target_id,identity_version,source_type,source_transaction_hash,
      source_timestamp,asset_id,condition_id,side,price_units,size_micros,gap_event,
      is_combo,raw_json,created_at,event_classification
    ) VALUES (?, ?, 'test', 'DATA_API_TRADE', ?, ?, ?, ?, ?, ?, ?, 0, 0, '{}', ?, 'STANDARD_TRADE')`,
  ).run(sourceKey, input.targetId, `tx-${input.signalId}`, Math.floor(Date.parse(input.createdAt) / 1_000), assetId, conditionId, input.signalType === "TARGET_SELL" ? "SELL" : "BUY", targetPriceUnits, targetSizeMicros, input.createdAt);
  if (capitalId) {
    db.prepare(
      `INSERT INTO capital_estimates(
        capital_estimate_id,target_id,source_event_key,position_value_micros,wallet_balance_micros,
        target_visible_capital_micros,target_trade_amount_micros,target_trade_capital_ratio_ppm,
        capital_sizing_ratio_json,capital_sizing_ratio_hash,
        capital_estimate_status,capital_confidence,capital_estimate_reason,position_snapshot_time,
        wallet_balance_snapshot_time,target_trade_timestamp,fallback_amount_micros,schema_version,
        strategy_version,risk_version,ruleset_snapshot_json,ruleset_hash,source_code_commit,
        source_code_dirty,created_at
      ) VALUES (?, ?, ?, '500000000', '500000000', ?, ?, ?, ?, ?, ?, ?, 'TEST', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    ).run(
      capitalId,
      input.targetId,
      sourceKey,
      input.exactSizing?.targetVisibleCapitalMicros ?? "1000000000",
      exactRatio?.targetTradeAmountMicros ?? "100000000",
      exactRatio?.legacyRatioPpm ?? input.ratioPpm ?? "100000",
      exactRatioJson,
      exactRatioHash,
      input.capitalStatus ?? "COMPLETE",
      input.confidence ?? "HIGH",
      input.createdAt,
      input.createdAt,
      input.createdAt,
      input.fallbackMicros ?? "10000000",
      VERSIONS.schemaVersion,
      VERSIONS.strategyVersion,
      VERSIONS.riskVersion,
      rulesetSnapshotJson,
      rulesetHash,
      sourceVersion.commit,
      input.createdAt,
    );
  }
  db.prepare(
    `INSERT INTO signals(
      signal_id,target_id,signal_idempotency_key,source_event_key,signal_type,status,asset_id,
      condition_id,target_price_units,target_size_micros,sell_ratio_numerator,
      sell_ratio_denominator,reason,schema_version,signal_version,strategy_version,
      risk_version,replay_version,ruleset_snapshot_json,ruleset_hash,source_code_commit,
      created_at,execution_eligible,execution_block_reason,event_classification,
      capital_estimate_id,source_code_dirty,producer_mode
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'TEST', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'STANDARD_TRADE', ?, 0, 'OBSERVE_ONLY')`,
  ).run(
    input.signalId,
    input.targetId,
    `idem-${input.signalId}`,
    sourceKey,
    input.signalType ?? "TARGET_BUY",
    input.status ?? "PUBLISHED",
    assetId,
    conditionId,
    targetPriceUnits,
    targetSizeMicros,
    input.sellNumerator ?? null,
    input.sellDenominator ?? null,
    VERSIONS.schemaVersion,
    VERSIONS.signalVersion,
    VERSIONS.strategyVersion,
    VERSIONS.riskVersion,
    VERSIONS.replayVersion,
    rulesetSnapshotJson,
    rulesetHash,
    sourceVersion.commit,
    input.createdAt,
    (input.executionEligible ?? true) ? 1 : 0,
    (input.executionEligible ?? true) ? null : "GAP_EVENT",
    capitalId,
  );
  db.prepare(
    `INSERT INTO signal_execution_contexts(
      context_id,target_id,signal_id,capital_decision_id,target_trade_capital_ratio_ppm,
      capital_sizing_ratio_json,capital_sizing_ratio_hash,
      target_trade_timestamp,market_end_time,market_metadata_snapshot_json,
      market_metadata_hash,ruleset_hash,schema_version,signal_version,strategy_version,
      source_code_commit,source_code_dirty,config_version,created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
  ).run(
    contextId,
    input.targetId,
    input.signalId,
    capitalId,
    input.signalType === "TARGET_SELL" ? null : exactRatio?.legacyRatioPpm ?? input.ratioPpm ?? "100000",
    input.signalType === "TARGET_SELL" ? null : exactRatioJson,
    input.signalType === "TARGET_SELL" ? null : exactRatioHash,
    input.createdAt,
    input.marketEndTime ?? new Date(Date.parse(input.createdAt) + 60 * 60 * 1_000).toISOString(),
    metadataJson,
    metadataHash,
    rulesetHash,
    VERSIONS.schemaVersion,
    VERSIONS.signalVersion,
    VERSIONS.strategyVersion,
    sourceVersion.commit,
    configVersion,
    input.createdAt,
  );
  db.close();
}

function seedHistoricalPaperPosition(input: {
  databasePath: string;
  accountId: string;
  signalId: string;
  ruleset: TestRuleset;
}): string {
  const db = new DatabaseSync(input.databasePath);
  db.exec("PRAGMA foreign_keys=ON");
  const executionId = `historical-opening-${input.signalId}`;
  const positionId = `historical-position-${input.signalId}`;
  const riskDecisionId = `historical-risk-${input.signalId}`;
  const createdAt = "2026-07-08T00:00:01.000Z";
  db.prepare(
    `INSERT INTO risk_decisions(
      risk_decision_id,executor_mode,paper_account_id,account_id,signal_id,context_id,decision,
      risk_reject_reason,requested_amount_micros,requested_size_micros,checks_json,
      schema_version,strategy_version,risk_version,ruleset_hash,source_code_commit,
      source_code_dirty,config_version,created_at,risk_reason
    ) VALUES (?, 'PAPER', ?, ?, ?, ?, 'ALLOW', NULL, '5000000', NULL, '[]',
      ?, ?, ?, ?, ?, 0, ?, ?, 'ALLOW')`,
  ).run(
    riskDecisionId,
    input.accountId,
    input.accountId,
    input.signalId,
    `context-${input.signalId}`,
    VERSIONS.schemaVersion,
    VERSIONS.strategyVersion,
    VERSIONS.riskVersion,
    input.ruleset.hash,
    sourceVersion.commit,
    input.ruleset.configVersion,
    createdAt,
  );
  db.prepare(
    `INSERT INTO paper_executions(
      paper_execution_id,paper_account_id,signal_id,execution_idempotency_key,
      execution_type,state,asset_id,condition_id,requested_amount_micros,
      requested_size_micros,filled_size_micros,filled_notional_micros,fee_micros,
      target_price_units,price_limit_lower_units,price_limit_upper_units,capital_mode,
      deadline_at,attempt_count,reason,context_id,schema_version,strategy_version,
      risk_version,paper_version,ruleset_hash,risk_decision_id,risk_reject_reason,
      source_code_commit,source_code_dirty,config_version,created_at,updated_at
    ) VALUES (?, ?, ?, ?, 'TARGET_BUY', 'EXECUTED', ?, ?, '5000000', NULL,
      '10000000', '5000000', '0', '500000000000000000', '490000000000000000',
      '510000000000000000', 'PROPORTIONAL', NULL, 1, 'HISTORICAL_FIXTURE', ?,
      ?, ?, ?, ?, ?, ?, NULL, ?, 0, ?, ?, ?)`,
  ).run(
    executionId,
    input.accountId,
    input.signalId,
    `historical-execution-key-${input.signalId}`,
    assetId,
    conditionId,
    `context-${input.signalId}`,
    VERSIONS.schemaVersion,
    VERSIONS.strategyVersion,
    VERSIONS.riskVersion,
    VERSIONS.paperVersion,
    input.ruleset.hash,
    riskDecisionId,
    sourceVersion.commit,
    input.ruleset.configVersion,
    createdAt,
    createdAt,
  );
  db.prepare(
    `INSERT INTO paper_positions(
      paper_position_id,paper_account_id,opening_execution_id,signal_id,asset_id,
      condition_id,outcome,entry_price_units,entry_size_micros,entry_notional_micros,
      entry_fee_micros,current_size_micros,remaining_cost_micros,stop_loss_price_units,
      status,frozen_from_status,frozen_reason,frozen_at,realized_pnl_micros,
      ruleset_hash,source_code_commit,source_code_dirty,config_version,created_at,updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'Yes', '500000000000000000', '10000000',
      '5000000', '0', '10000000', '5000000', '300000000000000000', 'OPEN',
      NULL, NULL, NULL, '0', ?, ?, 0, ?, ?, ?)`,
  ).run(
    positionId,
    input.accountId,
    executionId,
    input.signalId,
    assetId,
    conditionId,
    input.ruleset.hash,
    sourceVersion.commit,
    input.ruleset.configVersion,
    createdAt,
    createdAt,
  );
  db.close();
  return positionId;
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
            s.target_id,s.asset_id,s.condition_id,s.target_price_units,s.target_size_micros,
            s.sell_ratio_numerator,s.sell_ratio_denominator,s.created_at,
            c.context_id,c.target_id context_target_id,c.capital_decision_id,c.target_trade_capital_ratio_ppm,
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
    targetId: row.context_target_id as string,
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
    targetId: row.target_id as string,
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
  for (const child of childProcesses.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("PaperExecutor", () => {
  it("preserves the real sub-1-ppm amount, then rejects it at CLOB amount precision without an order or fill", async () => {
    const env = setup(new Date("2026-07-08T00:00:00.000Z"));
    env.market.book = {
      ...env.market.book,
      minOrderSize: "5",
      tickSize: "0.01",
    };
    insertSignal({
      databasePath: env.databasePath,
      targetId: env.targetId,
      signalId: "buy-sub-ppm",
      createdAt: "2026-07-08T00:00:01.000Z",
      exactSizing: {
        targetPriceUnits: "500000000000000000",
        targetSizeMicros: "2460160",
        targetVisibleCapitalMicros: "1261997070000",
      },
    });
    const executionId = await env.executor.consumeSignal(env.accountId, "buy-sub-ppm");
    expect(env.executor.executionState(executionId)).toBe("REJECTED");

    const db = new DatabaseSync(env.databasePath, { readOnly: true });
    const execution = db.prepare(
      "SELECT requested_amount_micros,reason FROM paper_executions WHERE paper_execution_id=?",
    ).get(executionId) as { requested_amount_micros: string; reason: string };
    const reservation = db.prepare(
      "SELECT status,remaining_amount_micros FROM paper_reservations WHERE paper_execution_id=?",
    ).get(executionId) as { status: string; remaining_amount_micros: string };
    const constraint = db.prepare(
      `SELECT check_result,reason,proposed_amount_micros,normalized_order_amount_micros
       FROM paper_market_constraint_evidence WHERE paper_execution_id=?`,
    ).get(executionId) as Record<string, string>;
    const risk = db.prepare(
      `SELECT capital_sizing_decision_json FROM risk_decisions
       WHERE risk_decision_id=(SELECT risk_decision_id FROM paper_executions WHERE paper_execution_id=?)`,
    ).get(executionId) as { capital_sizing_decision_json: string };
    expect(execution).toEqual({
      requested_amount_micros: "974",
      reason: "ORDER_AMOUNT_BELOW_EXECUTOR_PRECISION",
    });
    expect(reservation).toEqual({ status: "RELEASED", remaining_amount_micros: "0" });
    expect(constraint).toMatchObject({
      check_result: "REJECT",
      reason: "ORDER_AMOUNT_BELOW_EXECUTOR_PRECISION",
      proposed_amount_micros: "974",
      normalized_order_amount_micros: "0",
    });
    expect(JSON.parse(risk.capital_sizing_decision_json).calculatedAmountMicros).toBe("974");
    expect(db.prepare("SELECT count(*) count FROM paper_orders").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT count(*) count FROM paper_fill_ledger").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT count(*) count FROM paper_positions").get()).toEqual({ count: 0 });
    db.close();
    const snapshot = await env.executor.accountSnapshot(env.accountId);
    expect(snapshot.cashBalanceMicros).toBe("1000000000");
    expect(snapshot.reservedBalanceMicros).toBe("0");
    env.executor.close();
  });

  it("rejects a BUY below min_order_size and releases its reservation without fabricating an order", async () => {
    const env = setup(new Date("2026-07-08T00:00:00.000Z"));
    env.market.book = { ...env.market.book, minOrderSize: "5", tickSize: "0.01" };
    insertSignal({
      databasePath: env.databasePath,
      targetId: env.targetId,
      signalId: "buy-below-market-min",
      createdAt: "2026-07-08T00:00:01.000Z",
      ratioPpm: "1000",
    });
    const executionId = await env.executor.consumeSignal(env.accountId, "buy-below-market-min");
    expect(env.executor.executionState(executionId)).toBe("REJECTED");
    const db = new DatabaseSync(env.databasePath, { readOnly: true });
    const evidence = db.prepare(
      "SELECT reason,derived_min_notional_micros FROM paper_market_constraint_evidence WHERE paper_execution_id=?",
    ).get(executionId) as { reason: string; derived_min_notional_micros: string };
    expect(evidence).toEqual({ reason: "BELOW_MARKET_MIN_ORDER_SIZE", derived_min_notional_micros: "2550000" });
    expect(db.prepare("SELECT count(*) count FROM paper_orders").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT status FROM paper_reservations WHERE paper_execution_id=?").get(executionId))
      .toEqual({ status: "RELEASED" });
    db.close();
    env.executor.close();
  });

  it("fails closed instead of silently ignoring conflicting market-constraint evidence", async () => {
    const env = setup(new Date("2026-07-08T00:00:00.000Z"));
    insertSignal({
      databasePath: env.databasePath,
      targetId: env.targetId,
      signalId: "constraint-evidence-conflict",
      createdAt: "2026-07-08T00:00:01.000Z",
    });
    const executionId = await env.executor.consumeSignal(env.accountId, "constraint-evidence-conflict");
    const database = new DatabaseSync(env.databasePath, { readOnly: true });
    const stored = database.prepare(
      `SELECT evidence_json FROM paper_market_constraint_evidence
       WHERE paper_execution_id=?`,
    ).get(executionId) as { evidence_json: string };
    database.close();
    const evidence = JSON.parse(stored.evidence_json) as MarketOrderConstraintEvidence;
    const { evidenceHash: _priorHash, ...payload } = evidence;
    const changedPayload = { ...payload, reason: "CONFLICTING_EVIDENCE" };
    const conflicting = {
      ...changedPayload,
      evidenceHash: createHash("sha256").update(stableJson(changedPayload)).digest("hex"),
    } as MarketOrderConstraintEvidence;
    const internal = env.executor as unknown as {
      insertMarketConstraintEvidence(
        execution: {
          paper_execution_id: string;
          attempt_count: number;
          ruleset_hash: string;
          config_version: string;
        },
        book: PaperOrderbookSnapshot,
        value: MarketOrderConstraintEvidence,
        now: string,
      ): void;
    };
    expect(() => internal.insertMarketConstraintEvidence({
      paper_execution_id: executionId,
      attempt_count: 0,
      ruleset_hash: RULESET_HASH,
      config_version: VERSIONS.configVersion,
    }, env.market.book, conflicting, env.getClock().toISOString()))
      .toThrow(`PAPER_MARKET_CONSTRAINT_EVIDENCE_CONFLICT:${executionId}`);
    env.executor.close();
  });

  it("keeps an undersized SELL in EXIT_PENDING without an order or position mutation", async () => {
    const env = setup(new Date("2026-07-08T00:00:00.000Z"));
    insertSignal({
      databasePath: env.databasePath,
      targetId: env.targetId,
      signalId: "buy-before-small-sell",
      createdAt: "2026-07-08T00:00:01.000Z",
    });
    await env.executor.consumeSignal(env.accountId, "buy-before-small-sell");
    env.market.book = { ...env.market.book, minOrderSize: "5", tickSize: "0.01" };
    insertSignal({
      databasePath: env.databasePath,
      targetId: env.targetId,
      signalId: "sell-below-market-min",
      signalType: "TARGET_SELL",
      sellNumerator: "1",
      sellDenominator: "100",
      createdAt: "2026-07-08T00:00:02.000Z",
    });
    const executionId = await env.executor.consumeSignal(env.accountId, "sell-below-market-min");
    expect(env.executor.executionState(executionId)).toBe("EXIT_PENDING");
    const db = new DatabaseSync(env.databasePath, { readOnly: true });
    expect(db.prepare("SELECT count(*) count FROM paper_orders").get()).toEqual({ count: 1 });
    expect(db.prepare(
      "SELECT reason,proposed_size_micros,min_order_size_micros FROM paper_market_constraint_evidence WHERE paper_execution_id=?",
    ).get(executionId)).toEqual({
      reason: "BELOW_MARKET_MIN_ORDER_SIZE",
      proposed_size_micros: "2000000",
      min_order_size_micros: "5000000",
    });
    expect(db.prepare("SELECT current_size_micros,status FROM paper_positions").get())
      .toEqual({ current_size_micros: "200000000", status: "OPEN" });
    db.close();
    env.executor.close();
  });

  it("freezes safely when min_order_size is unavailable and resumes only after healthy recovery probes", async () => {
    const env = setup(new Date("2026-07-08T00:00:00.000Z"));
    const { minOrderSize: _missing, ...bookWithoutMinimum } = env.market.book;
    env.market.book = bookWithoutMinimum;
    insertSignal({
      databasePath: env.databasePath,
      targetId: env.targetId,
      signalId: "buy-minimum-unavailable",
      createdAt: "2026-07-08T00:00:01.000Z",
    });
    const executionId = await env.executor.consumeSignal(env.accountId, "buy-minimum-unavailable");
    expect(env.executor.executionState(executionId)).toBe("WAITING_EXECUTION");
    expect(env.executor.getMarketDataHealth(env.accountId, assetId, conditionId)).toMatchObject({
      state: "FROZEN",
      lastErrorCode: "MIN_ORDER_SIZE_UNAVAILABLE",
    });
    expect(count(env.databasePath, "paper_orders")).toBe(0);
    const unavailableEvidence = new DatabaseSync(env.databasePath, { readOnly: true });
    expect(unavailableEvidence.prepare(
      `SELECT check_result,reason,proposed_amount_micros
       FROM paper_market_constraint_evidence WHERE paper_execution_id=?`,
    ).get(executionId)).toEqual({
      check_result: "UNAVAILABLE",
      reason: "MIN_ORDER_SIZE_UNAVAILABLE",
      proposed_amount_micros: "100000000",
    });
    unavailableEvidence.close();

    env.setClock(new Date("2026-07-08T00:00:05.000Z"));
    env.market.book = env.market.makeBook(
      [{ price: "0.5", size: "10000" }],
      [{ price: "0.5", size: "10000" }],
    );
    await env.executor.recoverMarketData(env.accountId);
    expect(env.executor.getMarketDataHealth(env.accountId, assetId, conditionId).state).toBe("FROZEN");

    env.setClock(new Date("2026-07-08T00:00:10.000Z"));
    env.market.book = env.market.makeBook(
      [{ price: "0.5", size: "10000" }],
      [{ price: "0.5", size: "10000" }],
    );
    await env.executor.recoverMarketData(env.accountId);
    expect(env.executor.getMarketDataHealth(env.accountId, assetId, conditionId).state).toBe("HEALTHY");
    await env.executor.retryPending(env.accountId);
    expect(env.executor.executionState(executionId)).toBe("EXECUTED");
    env.executor.close();
  });

  it("uses HIGH capital ratio and opens a position from a full FAK fill", async () => {
    const env = setup(new Date("2026-07-08T00:00:00.000Z"));
    env.market.book.sourceUrl = `https://clob.polymarket.com/book?token_id=${assetId}`;
    env.market.book.publicCapture = {
      endpoint: "clob-orderbook",
      requestUrl: env.market.book.sourceUrl,
      fetchedAt: env.market.book.receivedAt,
      latencyMs: 10,
      httpStatus: 200,
      payload: {
        market: conditionId,
        asset_id: assetId,
        timestamp: String(Date.parse(env.market.book.marketSnapshotTime)),
        hash: "public-capture-test",
        bids: env.market.book.bids,
        asks: env.market.book.asks,
        min_order_size: env.market.book.minOrderSize,
        tick_size: env.market.book.tickSize,
      },
    };
    env.market.feeSnapshot.sourceUrl = `https://clob.polymarket.com/fee-rate?token_id=${assetId}`;
    env.market.feeSnapshot.publicCapture = {
      endpoint: "clob-fee-rate",
      requestUrl: env.market.feeSnapshot.sourceUrl,
      fetchedAt: env.market.feeSnapshot.snapshotTime,
      latencyMs: 10,
      httpStatus: 200,
      payload: { base_fee: 0 },
    };
    insertSignal({ databasePath: env.databasePath, targetId: env.targetId, signalId: "buy-high", createdAt: "2026-07-08T00:00:01.000Z" });
    const executionId = await env.executor.consumeSignal(env.accountId, "buy-high");
    expect(env.executor.executionState(executionId)).toBe("EXECUTED");
    expect(count(env.databasePath, "paper_positions")).toBe(1);
    const snapshot = await env.executor.accountSnapshot(env.accountId);
    expect(snapshot.cashBalanceMicros).toBe("900000000");
    expect(snapshot.reservedBalanceMicros).toBe("0");
    const captureDatabase = new DatabaseSync(env.databasePath, { readOnly: true });
    expect((captureDatabase.prepare(
      "SELECT count(*) count FROM api_captures WHERE endpoint IN ('clob-orderbook','clob-fee-rate')",
    ).get() as { count: number }).count).toBe(2);
    expect(captureDatabase.prepare(
      `SELECT c.endpoint FROM paper_fee_snapshots f
       JOIN api_captures c ON c.capture_id=f.source_capture_id
       WHERE f.asset_id=? ORDER BY f.created_at DESC LIMIT 1`,
    ).get(assetId)).toEqual({ endpoint: "clob-fee-rate" });
    captureDatabase.close();
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

  it("keeps Gap and non-published signals outside the Paper execution layer", async () => {
    const env = setup(new Date("2026-07-08T00:00:00.000Z"));
    insertSignal({ databasePath: env.databasePath, targetId: env.targetId, signalId: "gap", createdAt: "2026-07-08T00:00:01.000Z", executionEligible: false });
    insertSignal({ databasePath: env.databasePath, targetId: env.targetId, signalId: "draft", createdAt: "2026-07-08T00:00:02.000Z", status: "READY" });
    await expect(env.executor.consumeSignal(env.accountId, "gap")).rejects.toThrow("GAP_EVENT");
    await expect(env.executor.consumeSignal(env.accountId, "draft")).rejects.toThrow("SIGNAL_NOT_PUBLISHED");
    expect(count(env.databasePath, "risk_decisions")).toBe(0);
    expect(count(env.databasePath, "paper_executions")).toBe(0);
    expect(count(env.databasePath, "paper_signal_consumptions")).toBe(0);
    expect(count(env.databasePath, "paper_positions")).toBe(0);
    env.executor.close();
  });

  it("batch consumption ignores Gap Signals without blocking later eligible Signals", async () => {
    const env = setup(new Date("2026-07-08T00:00:00.000Z"));
    insertSignal({ databasePath: env.databasePath, targetId: env.targetId, signalId: "gap-batch", createdAt: "2026-07-08T00:00:01.000Z", executionEligible: false });
    insertSignal({ databasePath: env.databasePath, targetId: env.targetId, signalId: "eligible-after-gap", createdAt: "2026-07-08T00:00:02.000Z" });
    env.setClock(new Date("2026-07-08T00:00:03.000Z"));

    const executions = await env.executor.consumeAvailableSignals(env.accountId);

    expect(executions).toHaveLength(1);
    expect(env.executor.executionState(executions[0]!)).toBe("WAITING_EXECUTION");
    const database = new DatabaseSync(env.databasePath, { readOnly: true });
    expect((database.prepare(
      "SELECT count(*) count FROM paper_signal_consumptions WHERE paper_account_id=? AND signal_id='gap-batch'",
    ).get(env.accountId) as { count: number }).count).toBe(0);
    database.close();
    env.executor.close();
  });

  it("consumes only Signals from the target bound to the Paper account", async () => {
    const env = setup(new Date("2026-07-08T00:00:00.000Z"));
    const secondWallet = "0x0000000000000000000000000000000000000002";
    const phase0 = new Phase0Database(env.databasePath, sourceVersion);
    phase0.initialize();
    const secondTargetId = phase0.ensureTarget(secondWallet, "IDENTITY_CONFIRMED");
    phase0.close();
    insertSignal({ databasePath: env.databasePath, targetId: env.targetId, signalId: "bound-target", createdAt: "2026-07-08T00:00:01.000Z" });
    insertSignal({ databasePath: env.databasePath, targetId: secondTargetId, signalId: "golden-only-target", createdAt: "2026-07-08T00:00:02.000Z" });
    env.setClock(new Date("2026-07-08T00:00:03.000Z"));

    const executions = await env.executor.consumeAvailableSignals(env.accountId);

    expect(executions).toHaveLength(1);
    const db = new DatabaseSync(env.databasePath, { readOnly: true });
    expect((db.prepare(
      "SELECT count(*) count FROM paper_signal_consumptions WHERE paper_account_id=? AND signal_id='golden-only-target'",
    ).get(env.accountId) as { count: number }).count).toBe(0);
    db.close();
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
    const database = new DatabaseSync(env.databasePath, { readOnly: true });
    const reservationEntries = database.prepare(
      `SELECT entry_type,delta_micros,remaining_after_micros
       FROM paper_reservation_ledger
       WHERE paper_execution_id=? ORDER BY rowid`,
    ).all(executionId);
    expect(reservationEntries).toEqual([
      { entry_type: "RESERVE", delta_micros: "100000000", remaining_after_micros: "100000000" },
      { entry_type: "CONSUME", delta_micros: "-50000000", remaining_after_micros: "50000000" },
      { entry_type: "RELEASE", delta_micros: "-50000000", remaining_after_micros: "0" },
    ]);
    database.close();
    expect(await env.executor.attemptExecution(executionId)).toBe("PARTIALLY_EXECUTED");
    env.executor.close();
  });

  it("waits on out-of-range and stale books without spending cash", async () => {
    const env = setup(new Date("2026-07-08T00:00:00.000Z"));
    env.market.book = env.market.makeBook([{ price: "0.6", size: "1000" }], []);
    insertSignal({ databasePath: env.databasePath, targetId: env.targetId, signalId: "range", createdAt: "2026-07-08T00:00:01.000Z" });
    expect(env.executor.executionState(await env.executor.consumeSignal(env.accountId, "range"))).toBe("WAITING_EXECUTION");
    env.market.book = {
      ...env.market.makeBook([{ price: "0.5", size: "1000" }], [], "2026-07-07T23:59:00.000Z"),
      receivedAt: "2026-07-07T23:59:00.000Z",
    };
    insertSignal({ databasePath: env.databasePath, targetId: env.targetId, signalId: "stale", createdAt: "2026-07-08T00:00:02.000Z" });
    expect(env.executor.executionState(await env.executor.consumeSignal(env.accountId, "stale"))).toBe("WAITING_EXECUTION");
    expect(env.executor.getMarketDataHealth(env.accountId, assetId, conditionId)).toMatchObject({
      state: "FROZEN",
      lastErrorCode: "ORDERBOOK_STALE",
    });
    expect((await env.executor.accountSnapshot(env.accountId)).cashBalanceMicros).toBe("1000000000");
    env.executor.close();
  });

  it("reports an unsafe source clock explicitly instead of calling it a stale book", async () => {
    const now = new Date("2026-07-08T00:00:00.000Z");
    const env = setup(now);
    env.market.book = {
      ...env.market.makeBook(
        [{ price: "0.5", size: "1000" }],
        [],
        new Date(now.valueOf() + RULESET.clockUnsafeThresholdMs + 1).toISOString(),
      ),
      receivedAt: now.toISOString(),
    };
    insertSignal({
      databasePath: env.databasePath,
      targetId: env.targetId,
      signalId: "clock-unsafe",
      createdAt: "2026-07-08T00:00:01.000Z",
    });

    const executionId = await env.executor.consumeSignal(env.accountId, "clock-unsafe");

    expect(env.executor.executionState(executionId)).toBe("WAITING_EXECUTION");
    expect(env.executor.getMarketDataHealth(env.accountId, assetId, conditionId)).toMatchObject({
      state: "FROZEN",
      lastErrorCode: "ORDERBOOK_CLOCK_UNSAFE",
      lastErrorMessage: `Orderbook source clock offset ${RULESET.clockUnsafeThresholdMs + 1}ms exceeds ${RULESET.clockUnsafeThresholdMs}ms`,
    });
    expect((await env.executor.accountSnapshot(env.accountId)).cashBalanceMicros).toBe("1000000000");
    env.executor.close();
  });

  it("uses the startup market-clock calibration across Paper execution", async () => {
    const now = new Date("2026-07-08T00:00:00.000Z");
    const env = setup(now, undefined, 1_700);
    env.market.book = {
      ...env.market.makeBook(
        [{ price: "0.5", size: "1000" }],
        [],
        new Date(now.valueOf() + 2_050).toISOString(),
      ),
      receivedAt: now.toISOString(),
    };
    insertSignal({
      databasePath: env.databasePath,
      targetId: env.targetId,
      signalId: "clock-calibrated",
      createdAt: "2026-07-08T00:00:01.000Z",
    });

    const executionId = await env.executor.consumeSignal(env.accountId, "clock-calibrated");

    expect(env.executor.executionState(executionId)).toBe("EXECUTED");
    expect(env.executor.getMarketDataHealth(env.accountId, assetId, conditionId)).toMatchObject({
      state: "HEALTHY",
      lastErrorCode: null,
    });
    env.executor.close();
  });

  it("fetches fee before the book so a slow fee lookup cannot age a newly fetched snapshot", async () => {
    const env = setup(new Date("2026-07-08T00:00:00.000Z"));
    const calls: string[] = [];
    env.market.beforeFee = () => {
      calls.push("fee");
      env.setClock(new Date("2026-07-08T00:00:02.500Z"));
    };
    env.market.beforeOrderbook = () => {
      calls.push("book");
      env.market.book = env.market.makeBook(
        [{ price: "0.5", size: "1000" }],
        [{ price: "0.5", size: "1000" }],
        "2026-07-07T23:00:00.000Z",
      );
    };
    insertSignal({
      databasePath: env.databasePath,
      targetId: env.targetId,
      signalId: "fee-before-fresh-book",
      createdAt: "2026-07-08T00:00:01.000Z",
    });

    const executionId = await env.executor.consumeSignal(env.accountId, "fee-before-fresh-book");

    expect(calls.slice(0, 2)).toEqual(["fee", "book"]);
    expect(env.executor.executionState(executionId)).toBe("EXECUTED");
    expect(env.executor.getMarketDataHealth(env.accountId, assetId, conditionId).state).toBe("HEALTHY");
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

  it("uses the calibrated market clock for a waiting BUY deadline", async () => {
    const env = setup(new Date("2026-07-08T00:00:00.000Z"), 1_000_000_000n, 1_700);
    env.market.book = env.market.makeBook([], []);
    insertSignal({
      databasePath: env.databasePath,
      targetId: env.targetId,
      signalId: "calibrated-timeout",
      createdAt: "2026-07-08T00:00:01.000Z",
      marketEndTime: "2026-07-08T00:00:11.000Z",
    });
    const executionId = await env.executor.consumeSignal(env.accountId, "calibrated-timeout");
    env.setClock(new Date("2026-07-08T00:00:04.500Z"));

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

  it("allocates a partial multi-Position SELL pro rata with deterministic remainder handling", async () => {
    const env = setup(new Date("2026-07-08T00:00:00.000Z"));
    insertSignal({ databasePath: env.databasePath, targetId: env.targetId, signalId: "partial-pro-rata-a", createdAt: "2026-07-08T00:00:01.000Z" });
    insertSignal({ databasePath: env.databasePath, targetId: env.targetId, signalId: "partial-pro-rata-b", createdAt: "2026-07-08T00:00:02.000Z" });
    await env.executor.consumeSignal(env.accountId, "partial-pro-rata-a");
    await env.executor.consumeSignal(env.accountId, "partial-pro-rata-b");
    env.market.book = env.market.makeBook([], [{ price: "0.5", size: "95" }]);
    insertSignal({ databasePath: env.databasePath, targetId: env.targetId, signalId: "partial-pro-rata-sell", createdAt: "2026-07-08T00:00:03.000Z", signalType: "TARGET_SELL", sellNumerator: "1", sellDenominator: "2" });

    const executionId = await env.executor.consumeSignal(env.accountId, "partial-pro-rata-sell");

    expect(env.executor.executionState(executionId)).toBe("EXIT_PENDING");
    const db = new DatabaseSync(env.databasePath, { readOnly: true });
    const sizes = (db.prepare(
      "SELECT current_size_micros FROM paper_positions ORDER BY created_at,paper_position_id",
    ).all() as Array<{ current_size_micros: string }>).map((row) => row.current_size_micros);
    expect(sizes.sort()).toEqual(["135000000", "150000000"]);
    const allocations = (db.prepare(
      `SELECT filled_size_micros FROM paper_execution_positions
       WHERE paper_execution_id=? ORDER BY paper_position_id`,
    ).all(executionId) as Array<{ filled_size_micros: string }>).map((row) => row.filled_size_micros);
    expect(allocations.map(BigInt).reduce((total, value) => total + value, 0n)).toBe(95_000_000n);
    db.close();
    env.executor.close();
  });

  it("reuses one market snapshot when valuing multiple positions in the same asset", async () => {
    const env = setup(new Date("2026-07-08T00:00:00.000Z"));
    insertSignal({ databasePath: env.databasePath, targetId: env.targetId, signalId: "value-a", createdAt: "2026-07-08T00:00:01.000Z" });
    insertSignal({ databasePath: env.databasePath, targetId: env.targetId, signalId: "value-b", createdAt: "2026-07-08T00:00:02.000Z" });
    await env.executor.consumeSignal(env.accountId, "value-a");
    await env.executor.consumeSignal(env.accountId, "value-b");
    env.market.resetCallCounts();

    await env.executor.accountSnapshot(env.accountId);

    expect(env.market.orderbookCalls).toBe(1);
    expect(env.market.feeCalls).toBe(1);
    env.executor.close();
  });

  it("values same-asset positions against shared orderbook depth only once", async () => {
    const env = setup(new Date("2026-07-08T00:00:00.000Z"));
    insertSignal({ databasePath: env.databasePath, targetId: env.targetId, signalId: "depth-a", createdAt: "2026-07-08T00:00:01.000Z" });
    insertSignal({ databasePath: env.databasePath, targetId: env.targetId, signalId: "depth-b", createdAt: "2026-07-08T00:00:02.000Z" });
    await env.executor.consumeSignal(env.accountId, "depth-a");
    await env.executor.consumeSignal(env.accountId, "depth-b");
    env.market.book = env.market.makeBook([], [
      { price: "0.5", size: "200" },
      { price: "0.25", size: "200" },
    ]);

    const snapshot = await env.executor.accountSnapshot(env.accountId);

    expect(snapshot.positionValueMicros).toBe("145000000");
    expect(snapshot.unrealizedPnlMicros).toBe("-45000000");
    env.executor.close();
  });

  it("keeps frozen non-zero positions in the portfolio projection", async () => {
    const env = setup(new Date("2026-07-08T00:00:00.000Z"));
    insertSignal({ databasePath: env.databasePath, targetId: env.targetId, signalId: "frozen-value", createdAt: "2026-07-08T00:00:01.000Z" });
    await env.executor.consumeSignal(env.accountId, "frozen-value");
    await env.executor.reconcile({ accountId: env.accountId, reason: "RECONCILIATION_MAJOR_DESYNC" });

    const snapshot = await env.executor.accountSnapshot(env.accountId);

    expect(snapshot.positionValueMicros).toBe("100000000");
    expect(snapshot.unpricedPositionCount).toBe(0);
    expect(snapshot.valuationStatus).toBe("COMPLETE");
    env.executor.close();
  });

  it("reuses one orderbook when checking stop loss for multiple positions in the same asset", async () => {
    const env = setup(new Date("2026-07-08T00:00:00.000Z"));
    insertSignal({ databasePath: env.databasePath, targetId: env.targetId, signalId: "stop-a", createdAt: "2026-07-08T00:00:01.000Z" });
    insertSignal({ databasePath: env.databasePath, targetId: env.targetId, signalId: "stop-b", createdAt: "2026-07-08T00:00:02.000Z" });
    await env.executor.consumeSignal(env.accountId, "stop-a");
    await env.executor.consumeSignal(env.accountId, "stop-b");
    env.market.resetCallCounts();

    expect(await env.executor.checkStopLosses(env.accountId)).toEqual([]);

    expect(env.market.orderbookCalls).toBe(1);
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

  it("does not let concurrent pending sells reserve more than the current Position size", async () => {
    const env = setup(new Date("2026-07-08T00:00:00.000Z"));
    insertSignal({ databasePath: env.databasePath, targetId: env.targetId, signalId: "pending-sell-buy", createdAt: "2026-07-08T00:00:01.000Z" });
    await env.executor.consumeSignal(env.accountId, "pending-sell-buy");
    env.market.book = env.market.makeBook([], []);
    insertSignal({ databasePath: env.databasePath, targetId: env.targetId, signalId: "pending-sell-one", createdAt: "2026-07-08T00:00:02.000Z", signalType: "TARGET_SELL", sellNumerator: "3", sellDenominator: "4" });
    insertSignal({ databasePath: env.databasePath, targetId: env.targetId, signalId: "pending-sell-two", createdAt: "2026-07-08T00:00:03.000Z", signalType: "TARGET_SELL", sellNumerator: "1", sellDenominator: "2" });
    const first = await env.executor.consumeSignal(env.accountId, "pending-sell-one");
    const second = await env.executor.consumeSignal(env.accountId, "pending-sell-two");
    expect(env.executor.executionState(first)).toBe("EXIT_PENDING");
    expect(env.executor.executionState(second)).toBe("EXIT_PENDING");
    const db = new DatabaseSync(env.databasePath, { readOnly: true });
    const pending = db.prepare(
      `SELECT sum(CAST(ep.requested_size_micros AS INTEGER)-CAST(ep.filled_size_micros AS INTEGER)) pending
       FROM paper_execution_positions ep
       JOIN paper_executions e ON e.paper_execution_id=ep.paper_execution_id
       WHERE e.state IN ('EXIT_PENDING','STOP_EXIT_PENDING')`,
    ).get() as { pending: number };
    expect(pending.pending).toBe(200_000_000);
    db.close();
    env.market.book = env.market.makeBook([], [{ price: "0.5", size: "1000" }]);
    await env.executor.retryPending(env.accountId);
    const finalDb = new DatabaseSync(env.databasePath, { readOnly: true });
    expect((finalDb.prepare("SELECT current_size_micros FROM paper_positions").get() as { current_size_micros: string }).current_size_micros).toBe("0");
    finalDb.close();
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

  it("keeps historical Paper Position stop and slippage rules after the process ruleset changes", async () => {
    const env = setup(new Date("2026-07-08T00:00:03.000Z"));
    const historical = installHistoricalPaperRuleset(env.databasePath);
    insertSignal({
      databasePath: env.databasePath,
      targetId: env.targetId,
      signalId: "paper-historical-stop",
      createdAt: "2026-07-08T00:00:01.000Z",
      ruleset: historical,
    });
    const positionId = seedHistoricalPaperPosition({
      databasePath: env.databasePath,
      accountId: env.accountId,
      signalId: "paper-historical-stop",
      ruleset: historical,
    });
    env.market.book = env.market.makeBook([], [{ price: "0.29", size: "100" }]);

    const executions = await env.executor.checkStopLosses(env.accountId);

    expect(executions).toHaveLength(1);
    const db = new DatabaseSync(env.databasePath, { readOnly: true });
    const execution = db.prepare(
      `SELECT e.state,e.target_price_units,e.ruleset_hash,e.config_version,
              r.ruleset_hash risk_ruleset,r.config_version risk_config
       FROM paper_executions e
       JOIN risk_decisions r ON r.risk_decision_id=e.risk_decision_id
       WHERE e.paper_execution_id=?`,
    ).get(executions[0]!) as Record<string, string>;
    expect(execution).toMatchObject({
      state: "EXECUTED",
      target_price_units: "300000000000000000",
      ruleset_hash: historical.hash,
      config_version: historical.configVersion,
      risk_ruleset: historical.hash,
      risk_config: historical.configVersion,
    });
    expect((db.prepare(
      "SELECT status FROM paper_positions WHERE paper_position_id=?",
    ).get(positionId) as { status: string }).status).toBe("CLOSED");
    const audit = db.prepare(
      `SELECT ruleset_hash,config_version FROM audit_log
       WHERE entity_type='PAPER_EXECUTION' AND entity_id=?
       ORDER BY timestamp DESC LIMIT 1`,
    ).get(executions[0]!) as Record<string, string>;
    expect(audit).toEqual({ ruleset_hash: historical.hash, config_version: historical.configVersion });
    expect((db.prepare(
      "SELECT ruleset_hash,config_version FROM paper_pnl_ledger WHERE paper_position_id=?",
    ).get(positionId) as Record<string, string>)).toEqual({
      ruleset_hash: historical.hash,
      config_version: historical.configVersion,
    });
    db.close();
    env.executor.close();
  });

  it("derives a historical Position settlement execution from that Position ruleset", async () => {
    const env = setup(new Date("2026-07-08T00:00:03.000Z"));
    const historical = installHistoricalPaperRuleset(env.databasePath);
    insertSignal({
      databasePath: env.databasePath,
      targetId: env.targetId,
      signalId: "paper-historical-settlement",
      createdAt: "2026-07-08T00:00:01.000Z",
      marketEndTime: "2026-07-08T00:00:02.000Z",
      ruleset: historical,
    });
    const positionId = seedHistoricalPaperPosition({
      databasePath: env.databasePath,
      accountId: env.accountId,
      signalId: "paper-historical-settlement",
      ruleset: historical,
    });
    env.market.resolutionSnapshot = {
      ...env.market.resolutionSnapshot,
      resolved: true,
      payoutNumerator: "1",
      payoutDenominator: "1",
      raw: { closed: true, winner: assetId },
    };

    const idempotency = createHash("sha256")
      .update(["PAPER", env.accountId, "SETTLEMENT", positionId].join("|"))
      .digest("hex");
    const expectedExecutionId = createHash("sha256")
      .update([idempotency, historical.hash].join("|"))
      .digest("hex");

    expect(await env.executor.processSettlements(env.accountId)).toEqual([expectedExecutionId]);
    const db = new DatabaseSync(env.databasePath, { readOnly: true });
    expect(db.prepare(
      "SELECT ruleset_hash,config_version FROM paper_executions WHERE paper_execution_id=?",
    ).get(expectedExecutionId)).toEqual({
      ruleset_hash: historical.hash,
      config_version: historical.configVersion,
    });
    db.close();
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
    env.setClock(new Date("2026-07-08T00:00:08.000Z"));
    expect((await env.executor.processSettlements(env.accountId)).length).toBe(1);
    expect(count(env.databasePath, "paper_settlements")).toBe(1);
    const db = new DatabaseSync(env.databasePath, { readOnly: true });
    expect((db.prepare("SELECT status FROM paper_positions").get() as { status: string }).status).toBe("REDEEMED");
    db.close();
    env.executor.close();
  });

  it("persists unresolved settlement backoff across executor restarts", async () => {
    const env = setup(new Date("2026-07-08T00:00:00.000Z"));
    insertSignal({
      databasePath: env.databasePath,
      targetId: env.targetId,
      signalId: "settlement-backoff",
      createdAt: "2026-07-08T00:00:01.000Z",
      marketEndTime: "2026-07-08T00:00:02.000Z",
    });
    await env.executor.consumeSignal(env.accountId, "settlement-backoff");
    env.setClock(new Date("2026-07-08T00:00:03.000Z"));

    await env.executor.processSettlements(env.accountId);
    await env.executor.processSettlements(env.accountId);
    expect(env.market.resolutionCalls).toBe(1);
    env.executor.close();

    const restarted = new PaperExecutor(env.databasePath, env.market, {
      sourceVersion,
      now: () => env.getClock(),
    });
    env.setClock(new Date("2026-07-08T00:00:07.999Z"));
    await restarted.processSettlements(env.accountId);
    expect(env.market.resolutionCalls).toBe(1);
    env.setClock(new Date("2026-07-08T00:00:08.000Z"));
    await restarted.processSettlements(env.accountId);
    expect(env.market.resolutionCalls).toBe(2);

    const database = new DatabaseSync(env.databasePath, { readOnly: true });
    expect(database.prepare(
      `SELECT state,consecutive_attempts,next_retry_at
       FROM paper_settlement_retry_state`,
    ).get()).toEqual({
      state: "UNRESOLVED",
      consecutive_attempts: 2,
      next_retry_at: "2026-07-08T00:00:18.000Z",
    });
    database.close();
    restarted.close();
  });

  it("audits a repeated settlement error only when its code changes and records one recovery", async () => {
    const env = setup(new Date("2026-07-08T00:00:00.000Z"));
    insertSignal({
      databasePath: env.databasePath,
      targetId: env.targetId,
      signalId: "settlement-error-dedup",
      createdAt: "2026-07-08T00:00:01.000Z",
      marketEndTime: "2026-07-08T00:00:02.000Z",
    });
    await env.executor.consumeSignal(env.accountId, "settlement-error-dedup");
    env.market.resolutionError = new Error("RESOLUTION_API_DOWN");
    env.setClock(new Date("2026-07-08T00:00:03.000Z"));
    await env.executor.processSettlements(env.accountId);
    env.setClock(new Date("2026-07-08T00:00:08.000Z"));
    await env.executor.processSettlements(env.accountId);
    env.market.resolutionError = new Error("RESOLUTION_SCHEMA_INVALID");
    env.setClock(new Date("2026-07-08T00:00:18.000Z"));
    await env.executor.processSettlements(env.accountId);
    env.market.resolutionError = null;
    env.setClock(new Date("2026-07-08T00:00:38.000Z"));
    await env.executor.processSettlements(env.accountId);

    const database = new DatabaseSync(env.databasePath, { readOnly: true });
    expect((database.prepare(
      "SELECT count(*) count FROM audit_log WHERE action='SETTLEMENT_DEFERRED'",
    ).get() as { count: number }).count).toBe(2);
    expect((database.prepare(
      "SELECT count(*) count FROM audit_log WHERE action='SETTLEMENT_RECOVERED'",
    ).get() as { count: number }).count).toBe(1);
    expect(database.prepare(
      "SELECT state,last_error_code FROM paper_settlement_retry_state",
    ).get()).toEqual({ state: "UNRESOLVED", last_error_code: null });
    database.close();
    env.executor.close();
  });

  it("uses the calibrated market clock for the settlement market-end boundary", async () => {
    const env = setup(new Date("2026-07-08T00:00:00.000Z"), 1_000_000_000n, 1_700);
    insertSignal({
      databasePath: env.databasePath,
      targetId: env.targetId,
      signalId: "calibrated-settlement",
      createdAt: "2026-07-08T00:00:01.000Z",
      marketEndTime: "2026-07-08T00:00:10.000Z",
    });
    await env.executor.consumeSignal(env.accountId, "calibrated-settlement");
    env.setClock(new Date("2026-07-08T00:00:08.500Z"));

    await env.executor.processSettlements(env.accountId);

    expect(env.market.resolutionCalls).toBe(1);
    env.executor.close();
  });

  it("fails closed when a confirmed settlement does not match the Position identity", async () => {
    const env = setup(new Date("2026-07-08T00:00:00.000Z"));
    insertSignal({ databasePath: env.databasePath, targetId: env.targetId, signalId: "settle-identity", createdAt: "2026-07-08T00:00:01.000Z", marketEndTime: "2026-07-08T00:00:02.000Z" });
    await env.executor.consumeSignal(env.accountId, "settle-identity");
    env.setClock(new Date("2026-07-08T00:00:03.000Z"));
    env.market.resolutionSnapshot = {
      ...env.market.resolutionSnapshot,
      assetId: "wrong-asset",
      resolved: true,
      payoutNumerator: "1",
      payoutDenominator: "1",
      raw: { closed: true },
    };

    await expect(env.executor.processSettlements(env.accountId)).resolves.toEqual([]);

    const db = new DatabaseSync(env.databasePath, { readOnly: true });
    expect((db.prepare("SELECT status FROM paper_positions").get() as { status: string }).status).toBe("SETTLEMENT_PENDING");
    expect((db.prepare("SELECT cash_balance_micros FROM paper_accounts WHERE paper_account_id=?").get(env.accountId) as { cash_balance_micros: string }).cash_balance_micros).toBe("900000000");
    expect(count(env.databasePath, "paper_settlements")).toBe(0);
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

  it("rolls back a crashed reservation atomically and consumes the Signal once after restart", async () => {
    const env = setup(new Date("2026-07-08T00:00:00.000Z"));
    insertSignal({ databasePath: env.databasePath, targetId: env.targetId, signalId: "crash-reserve", createdAt: "2026-07-08T00:00:01.000Z" });
    const sabotage = new DatabaseSync(env.databasePath);
    sabotage.exec("CREATE TRIGGER fail_paper_reserve BEFORE INSERT ON paper_reservation_ledger BEGIN SELECT RAISE(ABORT, 'simulated reserve crash'); END;");

    await expect(env.executor.consumeSignal(env.accountId, "crash-reserve")).rejects.toThrow("simulated reserve crash");

    expect(count(env.databasePath, "paper_executions")).toBe(0);
    expect(count(env.databasePath, "paper_signal_consumptions")).toBe(0);
    expect(count(env.databasePath, "paper_reservations")).toBe(0);
    expect((await env.executor.accountSnapshot(env.accountId)).reservedBalanceMicros).toBe("0");
    sabotage.exec("DROP TRIGGER fail_paper_reserve");
    sabotage.close();
    env.executor.close();
    const restarted = new PaperExecutor(env.databasePath, env.market, { sourceVersion, now: () => env.getClock() });
    expect(restarted.executionState(await restarted.consumeSignal(env.accountId, "crash-reserve"))).toBe("EXECUTED");
    expect(count(env.databasePath, "paper_signal_consumptions")).toBe(1);
    restarted.close();
  });

  it("rolls back a crashed SELL ledger mutation and completes it after restart", async () => {
    const env = setup(new Date("2026-07-08T00:00:00.000Z"));
    insertSignal({ databasePath: env.databasePath, targetId: env.targetId, signalId: "crash-sell-buy", createdAt: "2026-07-08T00:00:01.000Z" });
    await env.executor.consumeSignal(env.accountId, "crash-sell-buy");
    env.market.book = env.market.makeBook([], [{ price: "0.5", size: "1000" }]);
    insertSignal({ databasePath: env.databasePath, targetId: env.targetId, signalId: "crash-sell", createdAt: "2026-07-08T00:00:02.000Z", signalType: "TARGET_SELL", sellNumerator: "1", sellDenominator: "1" });
    const sabotage = new DatabaseSync(env.databasePath);
    sabotage.exec("CREATE TRIGGER fail_paper_sell_pnl BEFORE INSERT ON paper_pnl_ledger BEGIN SELECT RAISE(ABORT, 'simulated sell crash'); END;");

    await expect(env.executor.consumeSignal(env.accountId, "crash-sell")).rejects.toThrow("simulated sell crash");

    const before = new DatabaseSync(env.databasePath, { readOnly: true });
    const sellExecutionId = (before.prepare(
      "SELECT paper_execution_id FROM paper_executions WHERE signal_id='crash-sell'",
    ).get() as { paper_execution_id: string }).paper_execution_id;
    expect((before.prepare("SELECT current_size_micros FROM paper_positions").get() as { current_size_micros: string }).current_size_micros).toBe("200000000");
    expect((before.prepare("SELECT cash_balance_micros FROM paper_accounts WHERE paper_account_id=?").get(env.accountId) as { cash_balance_micros: string }).cash_balance_micros).toBe("900000000");
    expect((before.prepare("SELECT count(*) count FROM paper_orders WHERE paper_execution_id=?").get(sellExecutionId) as { count: number }).count).toBe(0);
    before.close();
    sabotage.exec("DROP TRIGGER fail_paper_sell_pnl");
    sabotage.close();
    env.executor.close();
    const restarted = new PaperExecutor(env.databasePath, env.market, { sourceVersion, now: () => env.getClock() });
    expect(await restarted.attemptExecution(sellExecutionId)).toBe("EXECUTED");
    expect((await restarted.accountSnapshot(env.accountId)).cashBalanceMicros).toBe("1000000000");
    restarted.close();
  });

  it("rolls back a crashed Settlement and redeems exactly once after restart", async () => {
    const env = setup(new Date("2026-07-08T00:00:00.000Z"));
    insertSignal({ databasePath: env.databasePath, targetId: env.targetId, signalId: "crash-settlement", createdAt: "2026-07-08T00:00:01.000Z", marketEndTime: "2026-07-08T00:00:02.000Z" });
    await env.executor.consumeSignal(env.accountId, "crash-settlement");
    env.setClock(new Date("2026-07-08T00:00:03.000Z"));
    env.market.resolutionSnapshot = { ...env.market.resolutionSnapshot, resolved: true, payoutNumerator: "1", payoutDenominator: "1", raw: { closed: true, winner: assetId } };
    const sabotage = new DatabaseSync(env.databasePath);
    sabotage.exec("CREATE TRIGGER fail_paper_settlement BEFORE INSERT ON paper_settlements BEGIN SELECT RAISE(ABORT, 'simulated settlement crash'); END;");

    expect(await env.executor.processSettlements(env.accountId)).toEqual([]);

    const before = new DatabaseSync(env.databasePath, { readOnly: true });
    expect((before.prepare("SELECT status FROM paper_positions").get() as { status: string }).status).toBe("SETTLEMENT_PENDING");
    expect((before.prepare("SELECT cash_balance_micros FROM paper_accounts WHERE paper_account_id=?").get(env.accountId) as { cash_balance_micros: string }).cash_balance_micros).toBe("900000000");
    expect(count(env.databasePath, "paper_settlements")).toBe(0);
    before.close();
    sabotage.exec("DROP TRIGGER fail_paper_settlement");
    sabotage.close();
    env.executor.close();
    const restarted = new PaperExecutor(env.databasePath, env.market, { sourceVersion, now: () => env.getClock() });
    env.setClock(new Date("2026-07-08T00:00:08.000Z"));
    expect(await restarted.processSettlements(env.accountId)).toHaveLength(1);
    expect(await restarted.processSettlements(env.accountId)).toEqual([]);
    expect(count(env.databasePath, "paper_settlements")).toBe(1);
    restarted.close();
  });

  it("recovers exactly once after real SIGKILL at reservation, fill, and settlement barriers", async () => {
    const reservationEnv = setup(new Date("2026-07-08T00:00:00.000Z"));
    insertSignal({
      databasePath: reservationEnv.databasePath,
      targetId: reservationEnv.targetId,
      signalId: "process-crash-reservation",
      createdAt: "2026-07-08T00:00:01.000Z",
    });
    reservationEnv.executor.close();
    await killPaperWorkerAtBarrier({
      databasePath: reservationEnv.databasePath,
      accountId: reservationEnv.accountId,
      signalId: "process-crash-reservation",
      barrier: "RESERVATION_BEFORE_COMMIT",
      markerPath: join(directories.at(-1)!, "reservation.marker"),
      nowIso: "2026-07-08T00:00:00.000Z",
    });
    expectDatabaseSafe(reservationEnv.databasePath);
    expect(count(reservationEnv.databasePath, "paper_executions")).toBe(0);
    expect(count(reservationEnv.databasePath, "paper_reservations")).toBe(0);
    const reservationRestarted = new PaperExecutor(
      reservationEnv.databasePath,
      reservationEnv.market,
      { sourceVersion, now: () => reservationEnv.getClock() },
    );
    expect(reservationRestarted.executionState(
      await reservationRestarted.consumeSignal(reservationEnv.accountId, "process-crash-reservation"),
    )).toBe("EXECUTED");
    const reservationAcceptance = reservationRestarted.acceptanceSummary(reservationEnv.accountId);
    expect(reservationAcceptance.consistency.passed, JSON.stringify(reservationAcceptance.consistency)).toBe(true);
    reservationRestarted.close();

    const fillEnv = setup(new Date("2026-07-08T00:00:00.000Z"));
    fillEnv.market.book = fillEnv.market.makeBook([], []);
    insertSignal({
      databasePath: fillEnv.databasePath,
      targetId: fillEnv.targetId,
      signalId: "process-crash-fill",
      createdAt: "2026-07-08T00:00:01.000Z",
    });
    const fillExecutionId = await fillEnv.executor.consumeSignal(fillEnv.accountId, "process-crash-fill");
    expect(fillEnv.executor.executionState(fillExecutionId)).toBe("WAITING_EXECUTION");
    fillEnv.executor.close();
    await killPaperWorkerAtBarrier({
      databasePath: fillEnv.databasePath,
      accountId: fillEnv.accountId,
      signalId: "process-crash-fill",
      barrier: "BUY_FILL_BEFORE_COMMIT",
      markerPath: join(directories.at(-1)!, "fill.marker"),
      nowIso: "2026-07-08T00:00:00.000Z",
    });
    expectDatabaseSafe(fillEnv.databasePath);
    expect(count(fillEnv.databasePath, "paper_fill_ledger")).toBe(0);
    const fillRestarted = new PaperExecutor(fillEnv.databasePath, fillEnv.market, {
      sourceVersion,
      now: () => fillEnv.getClock(),
    });
    fillEnv.market.book = fillEnv.market.makeBook([{ price: "0.5", size: "10000" }], []);
    await fillRestarted.retryPending(fillEnv.accountId);
    expect(fillRestarted.executionState(fillExecutionId)).toBe("EXECUTED");
    expect(count(fillEnv.databasePath, "paper_signal_consumptions")).toBe(1);
    expect(fillRestarted.acceptanceSummary(fillEnv.accountId).consistency.passed).toBe(true);
    fillRestarted.close();

    const settlementEnv = setup(new Date("2026-07-08T00:00:00.000Z"));
    insertSignal({
      databasePath: settlementEnv.databasePath,
      targetId: settlementEnv.targetId,
      signalId: "process-crash-settlement",
      createdAt: "2026-07-08T00:00:01.000Z",
      marketEndTime: "2026-07-08T00:00:02.000Z",
    });
    await settlementEnv.executor.consumeSignal(settlementEnv.accountId, "process-crash-settlement");
    settlementEnv.executor.close();
    await killPaperWorkerAtBarrier({
      databasePath: settlementEnv.databasePath,
      accountId: settlementEnv.accountId,
      signalId: "process-crash-settlement",
      barrier: "SETTLEMENT_BEFORE_COMMIT",
      markerPath: join(directories.at(-1)!, "settlement.marker"),
      nowIso: "2026-07-08T00:00:03.000Z",
    });
    expectDatabaseSafe(settlementEnv.databasePath);
    expect(count(settlementEnv.databasePath, "paper_settlements")).toBe(0);
    const settlementBefore = new DatabaseSync(settlementEnv.databasePath, { readOnly: true });
    expect((settlementBefore.prepare("SELECT status FROM paper_positions").get() as { status: string }).status)
      .toBe("SETTLEMENT_PENDING");
    settlementBefore.close();
    settlementEnv.setClock(new Date("2026-07-08T00:00:03.000Z"));
    settlementEnv.market.resolutionSnapshot = {
      ...settlementEnv.market.resolutionSnapshot,
      resolved: true,
      payoutNumerator: "1",
      payoutDenominator: "1",
      raw: { closed: true, winner: assetId },
    };
    const settlementRestarted = new PaperExecutor(settlementEnv.databasePath, settlementEnv.market, {
      sourceVersion,
      now: () => settlementEnv.getClock(),
    });
    expect(await settlementRestarted.processSettlements(settlementEnv.accountId)).toHaveLength(1);
    expect(await settlementRestarted.processSettlements(settlementEnv.accountId)).toEqual([]);
    expect(count(settlementEnv.databasePath, "paper_settlements")).toBe(1);
    expect(settlementRestarted.acceptanceSummary(settlementEnv.accountId).consistency.passed).toBe(true);
    settlementRestarted.close();
  }, 30_000);

  it("rejects a buy and releases funds when the fee model is unavailable", async () => {
    const env = setup(new Date("2026-07-08T00:00:00.000Z"));
    env.market.feeSnapshot = { ...env.market.feeSnapshot, status: "UNAVAILABLE", baseFee: null, feeRatePpm: null, exponent: null };
    insertSignal({ databasePath: env.databasePath, targetId: env.targetId, signalId: "fee-missing", createdAt: "2026-07-08T00:00:01.000Z" });
    expect(env.executor.executionState(await env.executor.consumeSignal(env.accountId, "fee-missing"))).toBe("REJECTED");
    expect((await env.executor.accountSnapshot(env.accountId)).reservedBalanceMicros).toBe("0");
    expect(env.executor.getMarketDataHealth(env.accountId, assetId, conditionId)).toMatchObject({
      state: "FROZEN",
      lastErrorCode: "FEE_MODEL_UNAVAILABLE",
    });
    env.executor.close();
  });

  it("freezes a market when stop-loss evidence is stale instead of retrying every second", async () => {
    const env = setup(new Date("2026-07-08T00:00:00.000Z"));
    insertSignal({ databasePath: env.databasePath, targetId: env.targetId, signalId: "stale-stop-buy", createdAt: "2026-07-08T00:00:01.000Z" });
    await env.executor.consumeSignal(env.accountId, "stale-stop-buy");
    env.market.book = env.market.makeBook(
      [],
      [{ price: "0.2", size: "1000" }],
      "2026-07-07T23:59:55.000Z",
    );
    env.market.book = { ...env.market.book, receivedAt: "2026-07-07T23:59:55.000Z" };

    await expect(env.executor.checkStopLosses(env.accountId)).resolves.toEqual([]);

    expect(env.executor.getMarketDataHealth(env.accountId, assetId, conditionId)).toMatchObject({
      state: "FROZEN",
      lastErrorCode: "ORDERBOOK_STALE",
    });
    const database = new DatabaseSync(env.databasePath, { readOnly: true });
    expect((database.prepare("SELECT status FROM paper_positions").get() as { status: string }).status)
      .toBe("FROZEN");
    database.close();
    expect(env.executor.acceptanceSummary(env.accountId).marketData).toMatchObject({
      blockerCount: 1,
      quarantineCount: 0,
    });
    env.executor.close();
  });

  it("lets settlement win over an unfinished sell allocation", async () => {
    const env = setup(new Date("2026-07-08T00:00:00.000Z"));
    insertSignal({
      databasePath: env.databasePath,
      targetId: env.targetId,
      signalId: "settlement-wins-buy",
      createdAt: "2026-07-08T00:00:01.000Z",
      marketEndTime: "2026-07-08T00:00:03.000Z",
    });
    await env.executor.consumeSignal(env.accountId, "settlement-wins-buy");
    env.market.book = env.market.makeBook([], []);
    insertSignal({
      databasePath: env.databasePath,
      targetId: env.targetId,
      signalId: "settlement-wins-sell",
      signalType: "TARGET_SELL",
      createdAt: "2026-07-08T00:00:02.000Z",
      sellNumerator: "1",
      sellDenominator: "1",
    });
    const sellExecutionId = await env.executor.consumeSignal(env.accountId, "settlement-wins-sell");
    expect(env.executor.executionState(sellExecutionId)).toBe("EXIT_PENDING");

    env.setClock(new Date("2026-07-08T00:00:04.000Z"));
    await env.executor.processSettlements(env.accountId);

    expect(env.executor.executionState(sellExecutionId)).toBe("CANCELLED");
    const database = new DatabaseSync(env.databasePath, { readOnly: true });
    expect((database.prepare("SELECT status FROM paper_positions").get() as { status: string }).status)
      .toBe("SETTLEMENT_PENDING");
    expect((database.prepare(
      "SELECT requested_size_micros,filled_size_micros FROM paper_execution_positions WHERE paper_execution_id=?",
    ).get(sellExecutionId) as { requested_size_micros: string; filled_size_micros: string }))
      .toEqual({ requested_size_micros: "0", filled_size_micros: "0" });
    database.close();
    env.executor.close();
  });

  it("keeps a buy waiting without a simulated fill when the orderbook does not exist", async () => {
    const env = setup(new Date("2026-07-08T00:00:00.000Z"));
    env.market.orderbookError = Object.assign(new Error("No orderbook exists"), {
      code: "NO_ORDERBOOK_EXISTS",
    });
    insertSignal({
      databasePath: env.databasePath,
      targetId: env.targetId,
      signalId: "no-orderbook-buy",
      createdAt: "2026-07-08T00:00:01.000Z",
    });

    const executionId = await env.executor.consumeSignal(env.accountId, "no-orderbook-buy");

    expect(env.executor.executionState(executionId)).toBe("WAITING_EXECUTION");
    expect((await env.executor.accountSnapshot(env.accountId)).reservedBalanceMicros).toBe("100000000");
    expect(count(env.databasePath, "paper_orders")).toBe(0);
    expect(count(env.databasePath, "paper_fill_ledger")).toBe(0);
    expect(count(env.databasePath, "paper_positions")).toBe(0);
    expect(await env.executor.cancelWaitingBuys(env.accountId, "PAPER_CAMPAIGN_SESSION_END")).toBe(1);
    expect(env.executor.executionState(executionId)).toBe("CANCELLED");
    expect((await env.executor.accountSnapshot(env.accountId)).reservedBalanceMicros).toBe("0");
    expect(await env.executor.cancelWaitingBuys(env.accountId, "PAPER_CAMPAIGN_SESSION_END")).toBe(0);
    env.executor.close();
  });

  it("persists orderbook backoff and requires two fresh probes before recovery", async () => {
    const env = setup(new Date("2026-07-08T00:00:00.000Z"));
    env.market.orderbookError = Object.assign(new Error("No orderbook exists"), {
      code: "NO_ORDERBOOK_EXISTS",
    });
    insertSignal({
      databasePath: env.databasePath,
      targetId: env.targetId,
      signalId: "no-orderbook-recovery",
      createdAt: "2026-07-08T00:00:01.000Z",
    });
    const executionId = await env.executor.consumeSignal(env.accountId, "no-orderbook-recovery");
    expect(env.executor.getMarketDataHealth(env.accountId, assetId, conditionId).state).toBe("FROZEN");
    const callsAfterFailure = env.market.orderbookCalls;

    await env.executor.attemptExecution(executionId);
    expect(env.market.orderbookCalls).toBe(callsAfterFailure);

    env.market.orderbookError = null;
    env.setClock(new Date("2026-07-08T00:00:05.000Z"));
    env.market.book = env.market.makeBook([{ price: "0.5", size: "1000" }], []);
    await env.executor.attemptExecution(executionId);
    expect(env.executor.executionState(executionId)).toBe("WAITING_EXECUTION");
    expect(env.executor.getMarketDataHealth(env.accountId, assetId, conditionId).consecutiveSuccesses).toBe(1);

    env.setClock(new Date("2026-07-08T00:00:10.000Z"));
    env.market.book = env.market.makeBook([{ price: "0.5", size: "1000" }], []);
    expect(await env.executor.attemptExecution(executionId)).toBe("EXECUTED");
    expect(env.executor.getMarketDataHealth(env.accountId, assetId, conditionId).state).toBe("HEALTHY");
    env.executor.close();
  });

  it("rejects a new buy without reserving more money while its market data is frozen", async () => {
    const env = setup(new Date("2026-07-08T00:00:00.000Z"));
    env.market.orderbookError = Object.assign(new Error("No orderbook exists"), {
      code: "NO_ORDERBOOK_EXISTS",
    });
    insertSignal({ databasePath: env.databasePath, targetId: env.targetId, signalId: "frozen-first", createdAt: "2026-07-08T00:00:01.000Z" });
    await env.executor.consumeSignal(env.accountId, "frozen-first");
    insertSignal({ databasePath: env.databasePath, targetId: env.targetId, signalId: "frozen-second", createdAt: "2026-07-08T00:00:02.000Z" });

    const secondExecutionId = await env.executor.consumeSignal(env.accountId, "frozen-second");

    expect(env.executor.executionState(secondExecutionId)).toBe("REJECTED");
    expect((await env.executor.accountSnapshot(env.accountId)).reservedBalanceMicros).toBe("100000000");
    env.executor.close();
  });

  it("routes a closed market without an orderbook to settlement-only and releases a waiting buy", async () => {
    const env = setup(new Date("2026-07-08T00:00:00.000Z"));
    env.market.orderbookError = Object.assign(new Error("No orderbook exists"), {
      code: "NO_ORDERBOOK_EXISTS",
    });
    env.market.resolutionSnapshot = {
      ...env.market.resolutionSnapshot,
      resolved: true,
      payoutNumerator: "1",
      payoutDenominator: "1",
      raw: { closed: true, winner: assetId },
    };
    insertSignal({ databasePath: env.databasePath, targetId: env.targetId, signalId: "closed-no-book", createdAt: "2026-07-08T00:00:01.000Z" });

    const executionId = await env.executor.consumeSignal(env.accountId, "closed-no-book");

    expect(env.executor.executionState(executionId)).toBe("REJECTED");
    expect(env.executor.getMarketDataHealth(env.accountId, assetId, conditionId).state).toBe("SETTLEMENT_ONLY");
    expect((await env.executor.accountSnapshot(env.accountId)).reservedBalanceMicros).toBe("0");
    expect(count(env.databasePath, "paper_orders")).toBe(0);
    env.executor.close();
  });

  it("defers stop-loss checks without throwing or fabricating an exit when the orderbook is missing", async () => {
    const env = setup(new Date("2026-07-08T00:00:00.000Z"));
    insertSignal({ databasePath: env.databasePath, targetId: env.targetId, signalId: "stop-no-book", createdAt: "2026-07-08T00:00:01.000Z" });
    expect(env.executor.executionState(await env.executor.consumeSignal(env.accountId, "stop-no-book"))).toBe("EXECUTED");
    env.market.orderbookError = Object.assign(new Error("No orderbook exists"), {
      code: "NO_ORDERBOOK_EXISTS",
    });

    await expect(env.executor.checkStopLosses(env.accountId)).resolves.toEqual([]);

    expect(env.executor.getMarketDataHealth(env.accountId, assetId, conditionId).state).toBe("FROZEN");
    expect(count(env.databasePath, "paper_orders")).toBe(1);
    expect(count(env.databasePath, "paper_positions")).toBe(1);
    env.executor.close();
  });

  it("marks valuation incomplete and respects persisted backoff for a missing position orderbook", async () => {
    const env = setup(new Date("2026-07-08T00:00:00.000Z"));
    insertSignal({ databasePath: env.databasePath, targetId: env.targetId, signalId: "valuation-no-book", createdAt: "2026-07-08T00:00:01.000Z" });
    expect(env.executor.executionState(await env.executor.consumeSignal(env.accountId, "valuation-no-book"))).toBe("EXECUTED");
    env.market.orderbookError = Object.assign(new Error("No orderbook exists"), {
      code: "NO_ORDERBOOK_EXISTS",
    });
    env.market.resetCallCounts();

    const first = await env.executor.accountSnapshot(env.accountId);
    const callsAfterFailure = env.market.orderbookCalls;
    const second = await env.executor.accountSnapshot(env.accountId);

    expect(first.valuationStatus).toBe("INCOMPLETE");
    expect(second.valuationStatus).toBe("INCOMPLETE");
    expect(env.executor.getMarketDataHealth(env.accountId, assetId, conditionId).state).toBe("FROZEN");
    expect(env.market.orderbookCalls).toBe(callsAfterFailure);
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

  it("writes an incomplete ledger-only report without market requests after shutdown is requested", async () => {
    const env = setup(new Date("2026-07-08T00:00:00.000Z"));
    insertSignal({ databasePath: env.databasePath, targetId: env.targetId, signalId: "shutdown-a", createdAt: "2026-07-08T00:00:01.000Z" });
    insertSignal({ databasePath: env.databasePath, targetId: env.targetId, signalId: "shutdown-b", createdAt: "2026-07-08T00:00:02.000Z" });
    await env.executor.consumeSignal(env.accountId, "shutdown-a");
    await env.executor.consumeSignal(env.accountId, "shutdown-b");
    env.market.resetCallCounts();
    const controller = new AbortController();
    controller.abort();

    const report = await new PaperRunner(env.executor, {
      accountId: env.accountId,
      intervalMs: 1_000,
    }).run(controller.signal);

    expect(report.cycles).toBe(0);
    expect(report.account.valuationStatus).toBe("INCOMPLETE");
    expect(report.account.unpricedPositionCount).toBe(2);
    expect(report.account.priceSource).toBe("UNAVAILABLE");
    expect(env.market.orderbookCalls).toBe(0);
    expect(env.market.feeCalls).toBe(0);
    env.executor.close();
  });

  it("cancels an in-flight portfolio valuation when shutdown is requested", async () => {
    const env = setup(new Date("2026-07-08T00:00:00.000Z"));
    insertSignal({ databasePath: env.databasePath, targetId: env.targetId, signalId: "cancel-value", createdAt: "2026-07-08T00:00:01.000Z" });
    await env.executor.consumeSignal(env.accountId, "cancel-value");
    let requestStarted!: () => void;
    const started = new Promise<void>((resolvePromise) => { requestStarted = resolvePromise; });
    env.market.orderbook = async (_asset, _condition, signal) => {
      requestStarted();
      return await new Promise<PaperOrderbookSnapshot>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    };
    const controller = new AbortController();
    const snapshotPromise = env.executor.accountSnapshot(env.accountId, controller.signal);

    await started;
    controller.abort(new Error("FINAL_VALUATION_TIMEOUT"));
    const result = await Promise.race([
      snapshotPromise,
      new Promise<"TIMEOUT">((resolvePromise) => setTimeout(() => resolvePromise("TIMEOUT"), 100)),
    ]);

    env.executor.close();
    expect(result).not.toBe("TIMEOUT");
    if (result === "TIMEOUT") return;
    expect(result.valuationStatus).toBe("INCOMPLETE");
    expect(result.priceSource).toBe("UNAVAILABLE");
  });

  it("advances a reused account cutoff before Observe starts without backfilling downtime signals", async () => {
    const env = setup(new Date("2026-07-08T00:00:00.000Z"));
    env.market.book = env.market.makeBook([], []);
    insertSignal({
      databasePath: env.databasePath,
      targetId: env.targetId,
      signalId: "pending-before-restart",
      createdAt: "2026-07-08T00:00:30.000Z",
    });
    env.setClock(new Date("2026-07-08T00:00:30.000Z"));
    const pendingExecutionId = await env.executor.consumeSignal(env.accountId, "pending-before-restart");
    expect(env.executor.executionState(pendingExecutionId)).toBe("WAITING_EXECUTION");

    insertSignal({
      databasePath: env.databasePath,
      targetId: env.targetId,
      signalId: "paper-was-offline",
      createdAt: "2026-07-08T00:01:00.000Z",
    });

    env.setClock(new Date("2026-07-08T00:02:00.000Z"));
    const advanced = env.executor.advanceConsumerCutoff(
      env.accountId,
      "2026-07-08T00:02:00.000Z",
      "PAPER_SESSION_START",
    );
    expect(advanced).toMatchObject({
      advanced: true,
      previousCreatedAt: "2026-07-08T00:00:30.000Z",
      cutoffAt: "2026-07-08T00:02:00.000Z",
      skippedSignalCount: 1,
    });
    expect(env.executor.executionState(pendingExecutionId)).toBe("WAITING_EXECUTION");

    env.setClock(new Date("2026-07-08T00:03:00.000Z"));
    expect(await env.executor.consumeAvailableSignals(env.accountId)).toEqual([]);

    insertSignal({
      databasePath: env.databasePath,
      targetId: env.targetId,
      signalId: "after-paper-ready",
      createdAt: "2026-07-08T00:02:01.000Z",
    });
    expect(await env.executor.consumeAvailableSignals(env.accountId)).toHaveLength(1);

    const retained = env.executor.advanceConsumerCutoff(
      env.accountId,
      "2026-07-08T00:01:30.000Z",
      "PAPER_SESSION_RETRY",
    );
    expect(retained.advanced).toBe(false);
    const database = new DatabaseSync(env.databasePath, { readOnly: true });
    const checkpoint = database.prepare(
      "SELECT last_signal_created_at FROM paper_consumer_checkpoints WHERE paper_account_id=?",
    ).get(env.accountId) as { last_signal_created_at: string };
    const audit = database.prepare(
      `SELECT action,reason FROM audit_log
       WHERE entity_type='PAPER_CONSUMER_CHECKPOINT' AND entity_id=?
       ORDER BY timestamp,audit_id`,
    ).all(env.accountId) as Array<{ action: string; reason: string }>;
    expect(checkpoint.last_signal_created_at).toBe("2026-07-08T00:02:01.000Z");
    expect(audit.map((row) => row.action)).toEqual(["CHECKPOINT_ADVANCED", "CHECKPOINT_RETAINED"]);
    database.close();
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
      capitalSizingRatio: "capital_sizing_ratio_json",
      capitalSizingRatioHash: "capital_sizing_ratio_hash",
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
        targetId: env.targetId,
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
          targetId: context.target_id as string,
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
        targetId: context.target_id as string,
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

  it("does not let an in-memory Signal mutation reuse a pre-approved Paper Risk Decision", async () => {
    const env = setup(new Date("2026-07-08T00:00:00.000Z"));
    insertSignal({
      databasePath: env.databasePath,
      targetId: env.targetId,
      signalId: "interface-risk-mutation",
      createdAt: "2026-07-08T00:00:01.000Z",
    });
    const signal = loadPaperSignal(env.databasePath, "interface-risk-mutation");
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
    await expect(env.executor.executeBuy({
      accountId: env.accountId,
      signal: { ...signal, targetPriceUnits: "490000000000000000" },
      context: signal.context!,
      riskDecisionId: risk.riskDecisionId,
    })).rejects.toThrow("SIGNAL_IMMUTABLE_FIELDS_MISMATCH");
    expect(count(env.databasePath, "paper_executions")).toBe(0);
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

  it("marks portfolio valuation incomplete when the exit orderbook is stale", async () => {
    const env = setup(new Date("2026-07-08T00:00:00.000Z"));
    insertSignal({ databasePath: env.databasePath, targetId: env.targetId, signalId: "stale-pnl-buy", createdAt: "2026-07-08T00:00:01.000Z" });
    await env.executor.consumeSignal(env.accountId, "stale-pnl-buy");
    env.market.book = env.market.makeBook(
      [],
      [{ price: "0.4", size: "1000" }],
      "2026-07-07T23:59:55.000Z",
    );
    env.market.book = { ...env.market.book, receivedAt: "2026-07-07T23:59:55.000Z" };

    const snapshot = await env.executor.accountSnapshot(env.accountId);

    expect(snapshot.valuationStatus).toBe("INCOMPLETE");
    expect(snapshot.unpricedPositionCount).toBe(1);
    expect(snapshot.positionValueMicros).toBe("0");
    expect(snapshot.unrealizedPnlMicros).toBe("0");
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

  it("keeps Paper isolated from live signer or order dependencies", () => {
    const paperSource = readFileSync(new URL("../src/paper/paper-executor.ts", import.meta.url), "utf8");
    const liveSource = readFileSync(new URL("../src/live/live-executor.ts", import.meta.url), "utf8");
    for (const forbidden of ["privateKey", "secret", "apiKey", "createOrder", "postOrder", "submitOrder", "signOrder"]) {
      expect(paperSource).not.toContain(forbidden);
    }
    expect(liveSource).toContain("LIVE_EXECUTOR_NOT_IMPLEMENTED");
    expect(liveSource).not.toContain("privateKey");
    expect(liveSource).not.toContain("ClobClient");
    expect(liveSource).not.toContain("postOrder");
    expect(liveSource).toContain("checkExecution");
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
