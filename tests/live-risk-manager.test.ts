import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { RULESET, RULESET_HASH, RULESET_SNAPSHOT_JSON, VERSIONS, stableJson } from "../src/domain/versioning.js";
import { Phase0Database } from "../src/infra/sqlite/database.js";
import type { SourceVersion } from "../src/infra/source-version.js";
import { LiveAccountRegistry } from "../src/live/live-account-registry.js";
import type { PaperSignalEnvelope } from "../src/paper/types.js";
import { RiskManager } from "../src/risk/risk-manager.js";

const directories: string[] = [];
const sourceVersion: SourceVersion = { commit: "live-risk-test", dirty: false };
const walletAddress = "0x0000000000000000000000000000000000000001";
const conditionId = `0x${"7".repeat(64)}`;
const now = "2026-07-10T00:00:00.000Z";

function setup(): { databasePath: string; database: DatabaseSync; targetId: string } {
  const directory = mkdtempSync(join(tmpdir(), "ni-k-live-risk-"));
  directories.push(directory);
  const databasePath = join(directory, "phase0.sqlite");
  const phase0 = new Phase0Database(databasePath, sourceVersion);
  phase0.initialize();
  const targetId = phase0.ensureTarget(walletAddress, "IDENTITY_CONFIRMED");
  phase0.close();
  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA foreign_keys=ON");
  database.prepare(
    `INSERT INTO live_wallets(
      live_wallet_id,wallet_address,wallet_type,network,status,created_at,updated_at
    ) VALUES ('wallet-live-risk', ?, 'EOA', 'POLYGON', 'REGISTERED', ?, ?)`,
  ).run(walletAddress, now, now);
  return { databasePath, database, targetId };
}

interface TestRuleset {
  hash: string;
  snapshotJson: string;
  configVersion: string;
}

const currentRuleset: TestRuleset = {
  hash: RULESET_HASH,
  snapshotJson: RULESET_SNAPSHOT_JSON,
  configVersion: VERSIONS.configVersion,
};

function installHistoricalRuleset(database: DatabaseSync): TestRuleset {
  const versions = {
    ...VERSIONS,
    rulesetVersion: "live-risk-historical-v1",
    configVersion: "live-risk-historical-config-v1",
  };
  const snapshotJson = stableJson({ versions, rules: RULESET });
  const hash = createHash("sha256").update(snapshotJson).digest("hex");
  database.prepare(
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
    versions.configVersion,
    now,
  );
  database.prepare(
    `INSERT INTO ruleset_registry(
      ruleset_hash,ruleset_version,buy_price_lower_ratio_ppm,buy_price_upper_ratio_ppm,
      stop_loss_ratio_ppm,wait_ratio_ppm,max_wait_time_ms,capital_mode,
      fee_model_version,ruleset_snapshot_json,source_code_commit,source_code_dirty,
      config_version,created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
  ).run(
    hash,
    versions.rulesetVersion,
    RULESET.buyPriceMinRatioPpm,
    RULESET.buyPriceMaxRatioPpm,
    RULESET.stopTriggerRatioPpm,
    RULESET.waitRatioPpm,
    RULESET.maxWaitMs,
    RULESET.capitalMode,
    VERSIONS.feeModelVersion,
    snapshotJson,
    sourceVersion.commit,
    versions.configVersion,
    now,
  );
  return { hash, snapshotJson, configVersion: versions.configVersion };
}

function insertSignal(
  database: DatabaseSync,
  targetId: string,
  signalId: string,
  createdAt = now,
  ruleset: TestRuleset = currentRuleset,
): PaperSignalEnvelope {
  const sourceEventKey = `event-${signalId}`;
  const assetId = `asset-${signalId}`;
  const contextId = `context-${signalId}`;
  const capitalId = `capital-${signalId}`;
  const metadataHash = createHash("sha256").update(stableJson({})).digest("hex");
  database.prepare(
    `INSERT INTO raw_events(
      source_event_key,target_id,identity_version,source_type,source_transaction_hash,
      source_timestamp,asset_id,condition_id,side,price_units,size_micros,gap_event,
      is_combo,raw_json,created_at,event_classification
    ) VALUES (?, ?, 'test', 'DATA_API_TRADE', ?, 1783641600, ?, ?, 'BUY',
      '500000000000000000', '10000000', 0, 0, '{}', ?, 'STANDARD_TRADE')`,
  ).run(sourceEventKey, targetId, `tx-${signalId}`, assetId, conditionId, createdAt);
  database.prepare(
    `INSERT INTO capital_estimates(
      capital_estimate_id,target_id,source_event_key,position_value_micros,wallet_balance_micros,
      target_visible_capital_micros,target_trade_amount_micros,target_trade_capital_ratio_ppm,
      capital_estimate_status,capital_confidence,capital_estimate_reason,position_snapshot_time,
      wallet_balance_snapshot_time,target_trade_timestamp,fallback_amount_micros,schema_version,
      strategy_version,risk_version,ruleset_snapshot_json,ruleset_hash,source_code_commit,
      source_code_dirty,created_at
    ) VALUES (?, ?, ?, '500000000', '500000000', '1000000000', '100000000', '100000',
      'COMPLETE', 'HIGH', 'TEST_COMPLETE', ?, ?, ?, '10000000', ?, ?, ?, ?, ?, ?, 0, ?)`,
  ).run(
    capitalId,
    targetId,
    sourceEventKey,
    createdAt,
    createdAt,
    createdAt,
    VERSIONS.schemaVersion,
    VERSIONS.strategyVersion,
    VERSIONS.riskVersion,
    ruleset.snapshotJson,
    ruleset.hash,
    sourceVersion.commit,
    createdAt,
  );
  database.prepare(
    `INSERT INTO signals(
      signal_id,target_id,signal_idempotency_key,source_event_key,signal_type,status,asset_id,
      condition_id,target_price_units,target_size_micros,sell_ratio_numerator,
      sell_ratio_denominator,reason,schema_version,signal_version,strategy_version,
      risk_version,replay_version,ruleset_snapshot_json,ruleset_hash,source_code_commit,
      created_at,execution_eligible,execution_block_reason,event_classification,
      capital_estimate_id,source_code_dirty,producer_mode
    ) VALUES (?, ?, ?, ?, 'TARGET_BUY', 'PUBLISHED', ?, ?, '500000000000000000',
      '10000000', NULL, NULL, 'TEST', ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL,
      'STANDARD_TRADE', ?, 0, 'OBSERVE_ONLY')`,
  ).run(
    signalId,
    targetId,
    `idem-${signalId}`,
    sourceEventKey,
    assetId,
    conditionId,
    VERSIONS.schemaVersion,
    VERSIONS.signalVersion,
    VERSIONS.strategyVersion,
    VERSIONS.riskVersion,
    VERSIONS.replayVersion,
    ruleset.snapshotJson,
    ruleset.hash,
    sourceVersion.commit,
    createdAt,
    capitalId,
  );
  database.prepare(
    `INSERT INTO signal_execution_contexts(
      context_id,target_id,signal_id,capital_decision_id,target_trade_capital_ratio_ppm,
      target_trade_timestamp,market_end_time,market_metadata_snapshot_json,
      market_metadata_hash,ruleset_hash,schema_version,signal_version,strategy_version,
      source_code_commit,source_code_dirty,config_version,created_at
    ) VALUES (?, ?, ?, ?, '100000', ?, '2026-07-11T00:00:00.000Z', '{}', ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
  ).run(
    contextId,
    targetId,
    signalId,
    capitalId,
    createdAt,
    metadataHash,
    ruleset.hash,
    VERSIONS.schemaVersion,
    VERSIONS.signalVersion,
    VERSIONS.strategyVersion,
    sourceVersion.commit,
    ruleset.configVersion,
    createdAt,
  );
  return {
    signalId,
    targetId,
    signalType: "TARGET_BUY",
    eventClassification: "STANDARD_TRADE",
    status: "PUBLISHED",
    executionEligible: true,
    executionBlockReason: null,
    assetId,
    conditionId,
    targetPriceUnits: "500000000000000000",
    targetSizeMicros: "10000000",
    sellRatioNumerator: null,
    sellRatioDenominator: null,
    createdAt,
    context: {
      contextId,
      targetId,
      signalId,
      capitalDecisionId: capitalId,
      targetTradeCapitalRatioPpm: "100000",
      targetTradeTimestamp: createdAt,
      marketEndTime: "2026-07-11T00:00:00.000Z",
      marketMetadataSnapshot: {},
      marketMetadataHash: metadataHash,
      rulesetHash: ruleset.hash,
      sourceCodeCommit: sourceVersion.commit,
      sourceCodeDirty: false,
      configVersion: ruleset.configVersion,
      createdAt,
    },
    capitalDecision: {
      status: "COMPLETE",
      confidence: "HIGH",
      ratioPpm: "100000",
      fallbackAmountMicros: "10000000",
    },
  };
}

function registerActiveAccount(
  database: DatabaseSync,
  liveAccountId: string,
  initialBankrollMicros: bigint,
  riskBudgetMicros = initialBankrollMicros,
): LiveAccountRegistry {
  const registry = new LiveAccountRegistry(database, sourceVersion, () => new Date(now));
  registry.register({
    liveAccountId,
    liveWalletId: "wallet-live-risk",
    name: "Isolated Live Account",
    initialBankrollMicros,
    riskBudgetMicros,
    signalCutoffAt: "2026-07-09T00:00:00.000Z",
    actor: "TEST",
    reason: "TEST_REGISTRATION",
  });
  database.prepare("UPDATE live_wallets SET status='ACTIVE',updated_at=? WHERE live_wallet_id='wallet-live-risk'").run(now);
  registry.activate({ liveAccountId, actor: "TEST", reason: "TEST_ACTIVATION" });
  return registry;
}

function insertRealizedPnl(
  database: DatabaseSync,
  accountId: string,
  sequence: number,
  pnlMicros: bigint,
  createdAt = `2026-07-10T00:00:${String(sequence).padStart(2, "0")}.000Z`,
): void {
  const executionId = `loss-execution-${sequence}`;
  const positionId = `loss-position-${sequence}`;
  const risk = new RiskManager(database, sourceVersion).recordSystemDecision({
    mode: "LIVE",
    accountId,
    signalId: null,
    contextId: null,
    entityId: positionId,
    executionType: "STOP_LOSS",
    decision: "ALLOW",
    reason: "STOP_LOSS_TRIGGERED",
    requestedAmountMicros: null,
    requestedSizeMicros: 1n,
    now: createdAt,
  });
  database.prepare(
    `INSERT INTO live_executions(
      live_execution_id,live_account_id,signal_id,context_id,risk_decision_id,live_gate_run_id,
      execution_idempotency_key,execution_type,state,asset_id,condition_id,requested_amount_micros,
      requested_size_micros,filled_size_micros,filled_notional_micros,fee_micros,target_price_units,
      reason,schema_version,strategy_version,risk_version,live_version,ruleset_hash,source_code_commit,
      source_code_dirty,config_version,created_at,updated_at
    ) VALUES (?, ?, NULL, NULL, ?, NULL, ?, 'STOP_LOSS', 'EXECUTED', ?, ?, NULL,
      '1', '1', '1', '0', '1', 'TEST_LOSS', ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
  ).run(
    executionId,
    accountId,
    risk.riskDecisionId,
    `loss-idempotency-${sequence}`,
    `loss-asset-${sequence}`,
    conditionId,
    VERSIONS.schemaVersion,
    VERSIONS.strategyVersion,
    VERSIONS.riskVersion,
    VERSIONS.liveVersion,
    RULESET_HASH,
    sourceVersion.commit,
    VERSIONS.configVersion,
    createdAt,
    createdAt,
  );
  database.prepare(
    `INSERT INTO live_positions(
      live_position_id,live_account_id,opening_execution_id,signal_id,asset_id,condition_id,outcome,
      entry_price_units,entry_size_micros,entry_notional_micros,entry_fee_micros,current_size_micros,
      remaining_cost_micros,status,frozen_from_status,frozen_reason,frozen_at,realized_pnl_micros,
      ruleset_hash,source_code_commit,source_code_dirty,config_version,created_at,updated_at
    ) VALUES (?, ?, ?, NULL, ?, ?, NULL, '1', '1', '1', '0', '0', '0', 'CLOSED',
      NULL, NULL, NULL, ?, ?, ?, 0, ?, ?, ?)`,
  ).run(
    positionId,
    accountId,
    executionId,
    `loss-asset-${sequence}`,
    conditionId,
    pnlMicros.toString(),
    RULESET_HASH,
    sourceVersion.commit,
    VERSIONS.configVersion,
    createdAt,
    createdAt,
  );
  database.prepare(
    `INSERT INTO live_pnl_ledger(
      pnl_ledger_id,live_account_id,live_position_id,live_execution_id,pnl_type,proceeds_micros,
      cost_basis_micros,fee_micros,pnl_micros,price_source,price_timestamp,ruleset_hash,
      source_code_commit,source_code_dirty,config_version,idempotency_key,created_at
    ) VALUES (?, ?, ?, ?, 'REALIZED', '0', '0', '0', ?, 'TEST', ?, ?, ?, 0, ?, ?, ?)`,
  ).run(
    `loss-pnl-${sequence}`,
    accountId,
    positionId,
    executionId,
    pnlMicros.toString(),
    createdAt,
    RULESET_HASH,
    sourceVersion.commit,
    VERSIONS.configVersion,
    `loss-pnl-idempotency-${sequence}`,
    createdAt,
  );
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Live account and risk isolation", () => {
  it("hands a disabled Live account to a new runtime without replacing the durable account", () => {
    const { database } = setup();
    const original = new LiveAccountRegistry(database, sourceVersion, () => new Date(now));
    const account = original.register({
      liveAccountId: "live-account-handoff",
      liveWalletId: "wallet-live-risk",
      name: "Durable Live account",
      initialBankrollMicros: 1_000_000_000n,
      riskBudgetMicros: 500_000_000n,
      signalCutoffAt: now,
      actor: "TEST",
      reason: "REGISTER",
    });
    const nextSourceVersion: SourceVersion = { commit: "live-risk-next-core", dirty: false };
    const next = new LiveAccountRegistry(
      database,
      nextSourceVersion,
      () => new Date("2026-07-10T00:01:00.000Z"),
    );

    expect(next.handoffRuntime({
      liveAccountId: account.liveAccountId,
      actor: "TEST",
      reason: "CORE_VERSION_REPLACEMENT",
    })).toMatchObject({
      liveAccountId: account.liveAccountId,
      status: "DISABLED",
    });
    expect(database.prepare(
      `SELECT source_code_commit,source_code_dirty,schema_version,live_version,ruleset_hash
       FROM live_accounts WHERE live_account_id=?`,
    ).get(account.liveAccountId)).toEqual({
      source_code_commit: nextSourceVersion.commit,
      source_code_dirty: 0,
      schema_version: VERSIONS.schemaVersion,
      live_version: VERSIONS.liveVersion,
      ruleset_hash: RULESET_HASH,
    });
    const audit = database.prepare(
      `SELECT reason,metadata_json FROM audit_log
       WHERE entity_type='LIVE_ACCOUNT' AND entity_id=? AND action='runtime_handoff'`,
    ).get(account.liveAccountId) as { reason: string; metadata_json: string };
    expect(audit.reason).toBe("CORE_VERSION_REPLACEMENT");
    expect(JSON.parse(audit.metadata_json)).toMatchObject({
      previousSourceCodeCommit: sourceVersion.commit,
      currentSourceCodeCommit: nextSourceVersion.commit,
      previousRulesetHash: RULESET_HASH,
      currentRulesetHash: RULESET_HASH,
      liveGateState: "LIVE_DISABLED",
    });
    database.close();
  });

  it("registers disabled metadata with an immutable EOA signer identity and requires an active wallet", () => {
    const { database } = setup();
    const registry = new LiveAccountRegistry(database, sourceVersion, () => new Date(now));
    const account = registry.register({
      liveAccountId: "live-account-disabled",
      liveWalletId: "wallet-live-risk",
      name: "Disabled by default",
      initialBankrollMicros: 1_000_000_000n,
      riskBudgetMicros: 500_000_000n,
      signalCutoffAt: now,
      actor: "TEST",
      reason: "REGISTER",
    });

    expect(account.status).toBe("DISABLED");
    expect(account.authorizedSignerAddress).toBe(walletAddress);
    expect(() => registry.activate({ liveAccountId: account.liveAccountId, actor: "TEST", reason: "ACTIVATE" }))
      .toThrow("LIVE_WALLET_NOT_ACTIVE");
    const columns = (database.prepare("PRAGMA table_info(live_accounts)").all() as Array<{ name: string }>).map((row) => row.name);
    expect(columns).toContain("authorized_signer_address");
    expect(columns.some((column) => /private|seed|secret|credential/i.test(column))).toBe(false);
    expect(() => database.prepare(
      "UPDATE live_accounts SET authorized_signer_address=? WHERE live_account_id=?",
    ).run("0x0000000000000000000000000000000000000002", account.liveAccountId))
      .toThrow("live_account authorized signer is immutable");
    expect((database.prepare("SELECT count(*) count FROM live_account_state_transitions").get() as { count: number }).count).toBe(1);
    database.close();
  });

  it("requires an explicit valid signer identity for non-EOA wallets", () => {
    const { database } = setup();
    database.prepare(
      `INSERT INTO live_wallets(
        live_wallet_id,wallet_address,wallet_type,network,status,created_at,updated_at
      ) VALUES ('wallet-safe', '0x0000000000000000000000000000000000000002', 'SAFE', 'POLYGON',
        'REGISTERED', ?, ?)`,
    ).run(now, now);
    const registry = new LiveAccountRegistry(database, sourceVersion, () => new Date(now));
    const base = {
      liveWalletId: "wallet-safe",
      name: "Safe account",
      initialBankrollMicros: 1_000_000_000n,
      riskBudgetMicros: 500_000_000n,
      signalCutoffAt: now,
      actor: "TEST",
      reason: "REGISTER",
    };
    expect(() => registry.register({ ...base, liveAccountId: "safe-missing" }))
      .toThrow("LIVE_ACCOUNT_AUTHORIZED_SIGNER_REQUIRED");
    expect(() => registry.register({
      ...base,
      liveAccountId: "safe-invalid",
      authorizedSignerAddress: "invalid",
    })).toThrow("LIVE_ACCOUNT_AUTHORIZED_SIGNER_INVALID");

    const safeSigner = "0x0000000000000000000000000000000000000003";
    const account = registry.register({
      ...base,
      liveAccountId: "safe-valid",
      authorizedSignerAddress: safeSigner.toUpperCase().replace("0X", "0x"),
    });
    expect(account.authorizedSignerAddress).toBe(safeSigner);
    database.close();
  });

  it("uses live account funds and writes generic account_id without a paper-account anchor", () => {
    const { database, targetId } = setup();
    const accountId = "shared-account-id";
    registerActiveAccount(database, accountId, 10_000_000n);
    database.prepare(
      `INSERT INTO paper_accounts(
        paper_account_id,name,status,initial_balance_micros,cash_balance_micros,
        reserved_balance_micros,realized_pnl_micros,signal_cutoff_at,schema_version,
        strategy_version,risk_version,paper_version,ruleset_snapshot_json,ruleset_hash,
        source_code_commit,source_code_dirty,created_at,updated_at
      ) VALUES (?, 'Paper must not leak', 'ACTIVE', '1000000000', '1000000000', '0', '0',
        ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    ).run(
      accountId,
      "2026-07-09T00:00:00.000Z",
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
    const signal = insertSignal(database, targetId, "live-insufficient");

    const decision = new RiskManager(database, sourceVersion).evaluate({
      mode: "LIVE",
      accountId,
      signal,
      requestedAmountMicros: 11_000_000n,
      requestedSizeMicros: null,
      now,
    });

    expect(decision.decision).toBe("REJECT");
    expect(decision.riskRejectReason).toBe("INSUFFICIENT_AVAILABLE_CASH");
    const row = database.prepare(
      "SELECT account_id,paper_account_id,executor_mode FROM risk_decisions WHERE risk_decision_id=?",
    ).get(decision.riskDecisionId) as { account_id: string; paper_account_id: string | null; executor_mode: string };
    expect(row).toEqual({ account_id: accountId, paper_account_id: null, executor_mode: "LIVE" });
    expect(() => database.prepare("UPDATE risk_decisions SET risk_reason='MUTATED' WHERE risk_decision_id=?")
      .run(decision.riskDecisionId)).toThrow("risk_decision is immutable");
    expect(() => database.prepare("DELETE FROM risk_decisions WHERE risk_decision_id=?")
      .run(decision.riskDecisionId)).toThrow("risk_decision is immutable");
    expect(() => database.prepare(
      `INSERT INTO risk_decisions(
        risk_decision_id,executor_mode,paper_account_id,account_id,signal_id,context_id,decision,
        risk_reject_reason,requested_amount_micros,requested_size_micros,checks_json,schema_version,
        strategy_version,risk_version,ruleset_hash,source_code_commit,source_code_dirty,config_version,
        created_at,risk_reason
      )
      SELECT 'invalid-live-paper-anchor',executor_mode,?,account_id,signal_id,context_id,decision,
        risk_reject_reason,requested_amount_micros,requested_size_micros,checks_json,schema_version,
        strategy_version,risk_version,ruleset_hash,source_code_commit,source_code_dirty,config_version,
        created_at,risk_reason
      FROM risk_decisions WHERE risk_decision_id=?`,
    ).run(accountId, decision.riskDecisionId)).toThrow("risk_decision account/mode mismatch");
    database.close();
  });

  it("sums live cash ledger as BigInt without SQLite numeric coercion", () => {
    const { database, targetId } = setup();
    const accountId = "large-integer-live";
    registerActiveAccount(database, accountId, 9_007_199_254_740_993n, 500_000_000n);
    database.prepare(
      `INSERT INTO live_cash_ledger(
        cash_ledger_id,live_account_id,live_execution_id,entry_type,cash_delta_micros,
        reserved_delta_micros,cash_after_micros,reserved_after_micros,idempotency_key,created_at
      ) VALUES ('large-cash-delta', ?, NULL, 'TEST_ADJUSTMENT', '-9007199254740992', '0', NULL, NULL, 'large-cash-delta', ?)`,
    ).run(accountId, now);
    const signal = insertSignal(database, targetId, "live-bigint");

    const decision = new RiskManager(database, sourceVersion).evaluate({
      mode: "LIVE",
      accountId,
      signal,
      requestedAmountMicros: 2n,
      requestedSizeMicros: null,
      now,
    });

    expect(decision.decision).toBe("REJECT");
    expect(decision.riskRejectReason).toBe("INSUFFICIENT_AVAILABLE_CASH");
    database.close();
  });

  it("allows an active isolated Live account inside its bankroll and risk budget", () => {
    const { database, targetId } = setup();
    const accountId = "active-live";
    registerActiveAccount(database, accountId, 1_000_000_000n, 500_000_000n);
    const signal = insertSignal(database, targetId, "live-allow");

    const decision = new RiskManager(database, sourceVersion).evaluate({
      mode: "LIVE",
      accountId,
      signal,
      requestedAmountMicros: 10_000_000n,
      requestedSizeMicros: null,
      now,
    });

    expect(decision.decision).toBe("ALLOW");
    expect(decision.checks.find((check) => check.name === "live_total_exposure")?.result).toBe("PASS");
    database.close();
  });

  it("allows a Signal whose historical ruleset is immutable, registered, and internally consistent", () => {
    const { database, targetId } = setup();
    const accountId = "historical-rules-live";
    registerActiveAccount(database, accountId, 1_000_000_000n, 500_000_000n);
    const historical = installHistoricalRuleset(database);
    const signal = insertSignal(database, targetId, "historical-rules", now, historical);

    const decision = new RiskManager(database, sourceVersion).evaluate({
      mode: "LIVE",
      accountId,
      signal,
      requestedAmountMicros: 10_000_000n,
      requestedSizeMicros: null,
      now,
    });

    expect(decision.decision).toBe("ALLOW");
    expect(decision.checks.find((check) => check.name === "ruleset_hash")).toEqual({
      name: "ruleset_hash",
      result: "PASS",
      detail: historical.hash,
    });
    expect(database.prepare(
      "SELECT ruleset_hash,config_version FROM risk_decisions WHERE risk_decision_id=?",
    ).get(decision.riskDecisionId)).toEqual({
      ruleset_hash: historical.hash,
      config_version: historical.configVersion,
    });
    database.close();
  });

  it("applies percentage exposure limits to a non-default bankroll", () => {
    const { database, targetId } = setup();
    const accountId = "small-bankroll-live";
    registerActiveAccount(database, accountId, 10_000_000n);
    const signal = insertSignal(database, targetId, "live-percentage-limit");

    const decision = new RiskManager(database, sourceVersion).evaluate({
      mode: "LIVE",
      accountId,
      signal,
      requestedAmountMicros: 2_000_001n,
      requestedSizeMicros: null,
      now,
    });

    expect(decision.decision).toBe("REJECT");
    expect(decision.riskRejectReason).toBe("LIVE_SINGLE_TRADE_LIMIT_EXCEEDED");
    database.close();
  });

  it("blocks new Live buys when the UTC daily loss reaches five percent", () => {
    const { database, targetId } = setup();
    const accountId = "daily-loss-live";
    registerActiveAccount(database, accountId, 1_000_000_000n);
    insertRealizedPnl(database, accountId, 1, -50_000_000n);
    const signal = insertSignal(database, targetId, "live-daily-loss");

    const decision = new RiskManager(database, sourceVersion).evaluate({
      mode: "LIVE",
      accountId,
      signal,
      requestedAmountMicros: 1_000_000n,
      requestedSizeMicros: null,
      now,
    });

    expect(decision.decision).toBe("REJECT");
    expect(decision.riskRejectReason).toBe("LIVE_DAILY_LOSS_LIMIT_REACHED");
    database.close();
  });

  it("blocks new Live buys after five consecutive losing executions", () => {
    const { database, targetId } = setup();
    const accountId = "consecutive-loss-live";
    registerActiveAccount(database, accountId, 1_000_000_000n);
    for (let sequence = 1; sequence <= 5; sequence += 1) {
      insertRealizedPnl(database, accountId, sequence, -1n);
    }
    const signal = insertSignal(database, targetId, "live-consecutive-loss");

    const decision = new RiskManager(database, sourceVersion).evaluate({
      mode: "LIVE",
      accountId,
      signal,
      requestedAmountMicros: 1_000_000n,
      requestedSizeMicros: null,
      now,
    });

    expect(decision.decision).toBe("REJECT");
    expect(decision.riskRejectReason).toBe("LIVE_CONSECUTIVE_LOSS_LIMIT_REACHED");
    database.close();
  });
});
