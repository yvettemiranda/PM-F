import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { RULESET_HASH, RULESET_SNAPSHOT_JSON, VERSIONS } from "../src/domain/versioning.js";
import { Phase0Database } from "../src/infra/sqlite/database.js";
import type { SourceVersion } from "../src/infra/source-version.js";
import { LiveExecutor } from "../src/live/live-executor.js";
import { FakeOrderAdapter } from "../src/live/fake-order-adapter.js";
import { FakeSigner } from "../src/live/fake-signer.js";
import { FakeWalletProvider } from "../src/live/fake-wallet-provider.js";
import { FakeRedeemAdapter } from "../src/live/fake-redeem-adapter.js";
import { LiveGateService, defaultLiveGateConfig } from "../src/live/live-gate-service.js";
import { MockBalanceProvider } from "../src/live/mock-balance-provider.js";
import type { LiveExecutionGate } from "../src/live/live-types.js";
import type { PaperSignalEnvelope, SignalExecutionContext } from "../src/paper/types.js";

const directories: string[] = [];
const sourceVersion: SourceVersion = { commit: "phase3-live-test", dirty: false };
const wallet = "0x0000000000000000000000000000000000000001";
const conditionId = `0x${"3".repeat(64)}`;
const assetId = "asset-live-executor";
const accountId = "live-account-test";
const now = "2026-07-09T00:00:00.000Z";

class FakeGate implements LiveExecutionGate {
  constructor(private readonly allowed = true, private readonly reason = "FAKE_GATE_BLOCKED") {}

  async checkExecution(): Promise<{ allowed: boolean; checks: []; blockedReasons: string[]; runId: string }> {
    return { allowed: this.allowed, checks: [], blockedReasons: this.allowed ? [] : [this.reason], runId: "fake-live-gate-run" };
  }
}

function setup() {
  const directory = mkdtempSync(join(tmpdir(), "ni-k-live-executor-"));
  directories.push(directory);
  const databasePath = join(directory, "phase0.sqlite");
  const phase0 = new Phase0Database(databasePath, sourceVersion);
  phase0.initialize();
  const targetId = phase0.ensureTarget(wallet, "IDENTITY_CONFIRMED");
  phase0.close();
  insertAccount(databasePath);
  const inserted = insertSignalAndRisk(databasePath, targetId, { signalId: "live-buy", riskDecisionId: "risk-live-buy", decision: "ALLOW" });
  return { databasePath, targetId, ...inserted };
}

function insertAccount(databasePath: string): void {
  const db = new DatabaseSync(databasePath);
  db.prepare(
    `INSERT INTO paper_accounts(
      paper_account_id,name,status,initial_balance_micros,cash_balance_micros,
      reserved_balance_micros,realized_pnl_micros,signal_cutoff_at,schema_version,
      strategy_version,risk_version,paper_version,ruleset_snapshot_json,ruleset_hash,
      source_code_commit,source_code_dirty,created_at,updated_at
    ) VALUES (?, 'Live Risk Anchor', 'ACTIVE', '1000000000', '1000000000', '0', '0', ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
  ).run(
    accountId,
    now,
    VERSIONS.schemaVersion,
    VERSIONS.strategyVersion,
    VERSIONS.riskVersion,
    VERSIONS.paperVersion,
    RULESET_SNAPSHOT_JSON,
    RULESET_HASH,
    sourceVersion.commit,
    now,
    now,
  );
  db.close();
}

function insertSignalAndRisk(databasePath: string, targetId: string, input: {
  signalId: string;
  riskDecisionId: string;
  decision: "ALLOW" | "REJECT";
  signalType?: "TARGET_BUY" | "TARGET_SELL";
  sellRatioNumerator?: string | null;
  sellRatioDenominator?: string | null;
}): { signal: PaperSignalEnvelope; context: SignalExecutionContext } {
  const db = new DatabaseSync(databasePath);
  db.exec("PRAGMA foreign_keys=ON");
  const sourceKey = `source-${input.signalId}`;
  db.prepare(
    `INSERT INTO raw_events(
      source_event_key,target_id,identity_version,source_type,source_transaction_hash,
      source_timestamp,asset_id,condition_id,side,price_units,size_micros,gap_event,
      is_combo,raw_json,created_at,event_classification
    ) VALUES (?, ?, 'test', 'DATA_API_TRADE', ?, 1773014400, ?, ?, 'BUY',
      '500000000000000000', '10000000', 0, 0, '{}', ?, 'STANDARD_TRADE')`,
  ).run(sourceKey, targetId, `tx-${input.signalId}`, assetId, conditionId, now);
  db.prepare(
    `INSERT INTO signals(
      signal_id,signal_idempotency_key,source_event_key,signal_type,status,asset_id,
      condition_id,target_price_units,target_size_micros,sell_ratio_numerator,
      sell_ratio_denominator,reason,schema_version,signal_version,strategy_version,
      risk_version,replay_version,ruleset_snapshot_json,ruleset_hash,source_code_commit,
      created_at,execution_eligible,execution_block_reason,event_classification,
      capital_estimate_id,source_code_dirty,producer_mode
    ) VALUES (?, ?, ?, ?, 'PUBLISHED', ?, ?, '500000000000000000',
      '10000000', ?, ?, 'TEST', ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL,
      'STANDARD_TRADE', NULL, 0, 'OBSERVE_ONLY')`,
  ).run(
    input.signalId,
    `idem-${input.signalId}`,
    sourceKey,
    input.signalType ?? "TARGET_BUY",
    assetId,
    conditionId,
    input.sellRatioNumerator ?? null,
    input.sellRatioDenominator ?? null,
    VERSIONS.schemaVersion,
    VERSIONS.signalVersion,
    VERSIONS.strategyVersion,
    VERSIONS.riskVersion,
    VERSIONS.replayVersion,
    RULESET_SNAPSHOT_JSON,
    RULESET_HASH,
    sourceVersion.commit,
    now,
  );
  const contextId = `context-${input.signalId}`;
  db.prepare(
    `INSERT INTO signal_execution_contexts(
      context_id,signal_id,capital_decision_id,target_trade_capital_ratio_ppm,
      target_trade_timestamp,market_end_time,market_metadata_snapshot_json,
      market_metadata_hash,ruleset_hash,schema_version,signal_version,strategy_version,
      source_code_commit,source_code_dirty,config_version,created_at
    ) VALUES (?, ?, NULL, '100000', ?, ?, '{}', ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
  ).run(
    contextId,
    input.signalId,
    now,
    "2026-07-10T00:00:00.000Z",
    `metadata-${input.signalId}`,
    RULESET_HASH,
    VERSIONS.schemaVersion,
    VERSIONS.signalVersion,
    VERSIONS.strategyVersion,
    sourceVersion.commit,
    VERSIONS.configVersion,
    now,
  );
  db.prepare(
    `INSERT INTO risk_decisions(
      risk_decision_id,executor_mode,paper_account_id,signal_id,context_id,decision,
      risk_reject_reason,requested_amount_micros,requested_size_micros,checks_json,
      schema_version,strategy_version,risk_version,ruleset_hash,source_code_commit,
      source_code_dirty,config_version,created_at,risk_reason
    ) VALUES (?, 'LIVE', ?, ?, ?, ?, ?, '5000000', '10000000', '[]', ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
  ).run(
    input.riskDecisionId,
    accountId,
    input.signalId,
    contextId,
    input.decision,
    input.decision === "REJECT" ? "TEST_REJECT" : null,
    VERSIONS.schemaVersion,
    VERSIONS.strategyVersion,
    VERSIONS.riskVersion,
    RULESET_HASH,
    sourceVersion.commit,
    VERSIONS.configVersion,
    now,
    input.decision,
  );
  db.close();
  const context: SignalExecutionContext = {
    contextId,
    signalId: input.signalId,
    capitalDecisionId: null,
    targetTradeCapitalRatioPpm: "100000",
    targetTradeTimestamp: now,
    marketEndTime: "2026-07-10T00:00:00.000Z",
    marketMetadataSnapshot: {},
    marketMetadataHash: `metadata-${input.signalId}`,
    rulesetHash: RULESET_HASH,
    sourceCodeCommit: sourceVersion.commit,
    sourceCodeDirty: false,
    configVersion: VERSIONS.configVersion,
    createdAt: now,
  };
  const signal: PaperSignalEnvelope = {
    signalId: input.signalId,
    signalType: input.signalType ?? "TARGET_BUY",
    status: "PUBLISHED",
    executionEligible: true,
    executionBlockReason: null,
    assetId,
    conditionId,
    targetPriceUnits: "500000000000000000",
    targetSizeMicros: "10000000",
    sellRatioNumerator: input.sellRatioNumerator ?? null,
    sellRatioDenominator: input.sellRatioDenominator ?? null,
    createdAt: now,
    context,
    capitalDecision: { status: "COMPLETE", confidence: "HIGH", ratioPpm: "100000", fallbackAmountMicros: "10000000" },
  };
  return { signal, context };
}

function liveExecutor(databasePath: string, overrides: Partial<ConstructorParameters<typeof LiveExecutor>[0]> = {}) {
  return new LiveExecutor({
    databasePath,
    liveGate: new FakeGate(),
    orderAdapter: new FakeOrderAdapter(),
    walletProvider: new FakeWalletProvider(),
    signer: new FakeSigner(),
    sourceVersion,
    now: () => new Date(now),
    ...overrides,
  });
}

function count(databasePath: string, table: string): number {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  const row = db.prepare(`SELECT count(*) count FROM ${table}`).get() as { count: number };
  db.close();
  return row.count;
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("LiveExecutor", () => {
  it("rejects by default through the real Live Gate when execution mode is PAPER", async () => {
    const env = setup();
    const gate = new LiveGateService(
      env.databasePath,
      new MockBalanceProvider({ status: "AVAILABLE", balanceMicros: "1000000000", reason: null }),
      defaultLiveGateConfig(),
      { sourceVersion, now: () => new Date(now) },
    );
    const executor = liveExecutor(env.databasePath, { liveGate: gate });
    const result = await executor.executeBuy({ accountId, signal: env.signal, context: env.context, riskDecisionId: "risk-live-buy" });
    expect(result.state).toBe("REJECTED");
    const db = new DatabaseSync(env.databasePath, { readOnly: true });
    const reason = (db.prepare("SELECT reason FROM live_executions WHERE live_execution_id=?").get(result.executionId) as { reason: string }).reason;
    expect(reason).toContain("NOT_LIVE_ACTIVE:PAPER:LIVE_DISABLED");
    db.close();
    executor.close();
    gate.close();
  });

  it("rejects when the Live Gate blocks execution", async () => {
    const env = setup();
    const executor = liveExecutor(env.databasePath, { liveGate: new FakeGate(false, "FAKE_BLOCK") });
    const result = await executor.executeBuy({ accountId, signal: env.signal, context: env.context, riskDecisionId: "risk-live-buy" });
    expect(result.state).toBe("REJECTED");
    expect(count(env.databasePath, "live_orders")).toBe(0);
    executor.close();
  });

  it("rejects Risk Decision REJECT through the real Live Gate", async () => {
    const env = setup();
    const rejected = insertSignalAndRisk(env.databasePath, env.targetId, { signalId: "live-reject", riskDecisionId: "risk-live-reject", decision: "REJECT" });
    const db = new DatabaseSync(env.databasePath);
    db.prepare("UPDATE live_gate_state SET execution_mode='LIVE',live_gate_state='LIVE_ACTIVE',requested_execution_mode='LIVE' WHERE state_id='default'").run();
    db.close();
    const gate = new LiveGateService(
      env.databasePath,
      new MockBalanceProvider({ status: "AVAILABLE", balanceMicros: "1000000000", reason: null }),
      defaultLiveGateConfig(),
      { sourceVersion, now: () => new Date(now) },
    );
    const executor = liveExecutor(env.databasePath, { liveGate: gate });
    const result = await executor.executeBuy({ accountId, signal: rejected.signal, context: rejected.context, riskDecisionId: "risk-live-reject" });
    expect(result.state).toBe("REJECTED");
    executor.close();
    gate.close();
  });

  it("executes a BUY through fake signer/order adapter and writes order, fill, position, ledger and audit records", async () => {
    const env = setup();
    const executor = liveExecutor(env.databasePath);
    const result = await executor.executeBuy({ accountId, signal: env.signal, context: env.context, riskDecisionId: "risk-live-buy" });
    expect(result.state).toBe("EXECUTED");
    expect(count(env.databasePath, "live_orders")).toBe(1);
    expect(count(env.databasePath, "live_fills")).toBe(1);
    expect(count(env.databasePath, "live_positions")).toBe(1);
    expect(count(env.databasePath, "live_cash_ledger")).toBeGreaterThan(0);
    expect(count(env.databasePath, "live_reservation_ledger")).toBeGreaterThan(0);
    expect(count(env.databasePath, "live_fill_ledger")).toBe(1);
    expect(count(env.databasePath, "live_fee_ledger")).toBe(1);
    expect(count(env.databasePath, "live_state_transitions")).toBeGreaterThan(0);
    expect(count(env.databasePath, "audit_log")).toBeGreaterThan(0);
    executor.close();
  });

  it("supports partial fills", async () => {
    const env = setup();
    const executor = liveExecutor(env.databasePath, { orderAdapter: new FakeOrderAdapter({ fillRatioPpm: 500_000 }) });
    const result = await executor.executeBuy({ accountId, signal: env.signal, context: env.context, riskDecisionId: "risk-live-buy" });
    expect(result.state).toBe("PARTIALLY_EXECUTED");
    const db = new DatabaseSync(env.databasePath, { readOnly: true });
    const position = db.prepare("SELECT current_size_micros FROM live_positions").get() as { current_size_micros: string };
    expect(position.current_size_micros).toBe("5000000");
    db.close();
    executor.close();
  });

  it("does not duplicate execution or fills for the same signal and risk decision", async () => {
    const env = setup();
    const executor = liveExecutor(env.databasePath);
    const input = { accountId, signal: env.signal, context: env.context, riskDecisionId: "risk-live-buy" };
    const first = await executor.executeBuy(input);
    const second = await executor.executeBuy(input);
    expect(second.executionId).toBe(first.executionId);
    expect(count(env.databasePath, "live_fills")).toBe(1);
    expect(count(env.databasePath, "live_positions")).toBe(1);
    executor.close();
  });

  it("blocks when allowance is insufficient and does not approve", async () => {
    const env = setup();
    const executor = liveExecutor(env.databasePath, {
      walletProvider: new FakeWalletProvider({ balanceMicros: "1000000000", allowanceMicros: "1" }),
    });
    const result = await executor.executeBuy({ accountId, signal: env.signal, context: env.context, riskDecisionId: "risk-live-buy" });
    expect(result.state).toBe("REJECTED");
    const db = new DatabaseSync(env.databasePath, { readOnly: true });
    const reason = (db.prepare("SELECT reason FROM live_executions WHERE live_execution_id=?").get(result.executionId) as { reason: string }).reason;
    expect(reason).toBe("ALLOWANCE_INSUFFICIENT");
    expect(count(env.databasePath, "live_orders")).toBe(0);
    db.close();
    executor.close();
  });

  it("blocks execution when live reconciliation fails", async () => {
    const env = setup();
    const db = new DatabaseSync(env.databasePath);
    db.prepare(
      `INSERT INTO live_executions(
        live_execution_id,live_account_id,signal_id,context_id,risk_decision_id,live_gate_run_id,
        execution_idempotency_key,execution_type,state,asset_id,condition_id,requested_amount_micros,
        requested_size_micros,filled_size_micros,filled_notional_micros,fee_micros,target_price_units,
        reason,schema_version,strategy_version,risk_version,live_version,ruleset_hash,source_code_commit,
        source_code_dirty,config_version,created_at,updated_at
      ) VALUES ('bad-live-exec', ?, NULL, NULL, 'risk-live-buy', NULL, 'bad-key', 'TARGET_BUY', 'EXECUTED',
        ?, ?, '1', '1', '0', '0', '0', '1', 'BAD', ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    ).run(accountId, assetId, conditionId, VERSIONS.schemaVersion, VERSIONS.strategyVersion, VERSIONS.riskVersion, VERSIONS.liveVersion, RULESET_HASH, sourceVersion.commit, VERSIONS.configVersion, now, now);
    db.prepare(
      `INSERT INTO live_orders(
        live_order_id,live_execution_id,live_order_idempotency_key,external_order_id,market_id,asset_id,
        condition_id,side,order_type,price_units,size_micros,filled_size_micros,filled_notional_micros,
        fee_micros,status,adapter_type,raw_response_json,created_at,updated_at
      ) VALUES ('bad-order','bad-live-exec','bad-order-key','external-bad',?, ?, ?, 'BUY','FAK','1','1','1','0','0','FILLED','FAKE','{}',?, ?)`,
    ).run(conditionId, assetId, conditionId, now, now);
    db.close();
    const executor = liveExecutor(env.databasePath);
    const result = await executor.executeBuy({ accountId, signal: env.signal, context: env.context, riskDecisionId: "risk-live-buy" });
    expect(result.state).toBe("REJECTED");
    const check = new DatabaseSync(env.databasePath, { readOnly: true });
    const reason = (check.prepare("SELECT reason FROM live_executions WHERE live_execution_id=?").get(result.executionId) as { reason: string }).reason;
    expect(reason).toBe("LIVE_RECONCILIATION_FAILED");
    check.close();
    executor.close();
  });

  it("recovers on restart through fake adapter and records recovery state", async () => {
    const env = setup();
    const executor = liveExecutor(env.databasePath);
    const recovery = await executor.recoverOnStartup(accountId);
    expect(recovery.passed).toBe(true);
    expect(count(env.databasePath, "live_recovery_runs")).toBe(1);
    executor.close();
  });

  it("emergency stop cancels pending orders and freezes open positions", async () => {
    const env = setup();
    const executor = liveExecutor(env.databasePath, { orderAdapter: new FakeOrderAdapter({ fillRatioPpm: 500_000 }) });
    await executor.executeBuy({ accountId, signal: env.signal, context: env.context, riskDecisionId: "risk-live-buy" });
    await executor.emergencyStop(accountId, "test");
    const db = new DatabaseSync(env.databasePath, { readOnly: true });
    const position = db.prepare("SELECT status FROM live_positions").get() as { status: string };
    expect(position.status).toBe("FROZEN");
    db.close();
    executor.close();
  });

  it("keeps real redeem disabled by default and supports fake redeem adapter", async () => {
    const env = setup();
    const executor = liveExecutor(env.databasePath);
    await executor.executeBuy({ accountId, signal: env.signal, context: env.context, riskDecisionId: "risk-live-buy" });
    const db = new DatabaseSync(env.databasePath, { readOnly: true });
    const position = db.prepare("SELECT live_position_id FROM live_positions").get() as { live_position_id: string };
    db.close();
    const disabledExecutor = new LiveExecutor({
      databasePath: env.databasePath,
      liveGate: new FakeGate(),
      orderAdapter: new FakeOrderAdapter(),
      walletProvider: new FakeWalletProvider(),
      signer: new FakeSigner(),
      sourceVersion,
      now: () => new Date(now),
    });
    expect((await disabledExecutor.redeemPosition(position.live_position_id)).status).toBe("DISABLED");
    disabledExecutor.close();
    const fakeRedeemExecutor = liveExecutor(env.databasePath, { redeemAdapter: new FakeRedeemAdapter() });
    expect((await fakeRedeemExecutor.redeemPosition(position.live_position_id)).status).toBe("CONFIRMED");
    fakeRedeemExecutor.close();
    executor.close();
  });
});
