import { mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { RULESET, RULESET_HASH, RULESET_SNAPSHOT_JSON, stableJson, VERSIONS } from "../src/domain/versioning.js";
import { Phase0Database } from "../src/infra/sqlite/database.js";
import type { SourceVersion } from "../src/infra/source-version.js";
import { LiveGateService, defaultLiveGateConfig } from "../src/live/live-gate-service.js";
import { LiveAccountRegistry } from "../src/live/live-account-registry.js";
import { LiveGateReconciliation } from "../src/live/live-gate-reconciliation.js";
import { ClobClockSafetyProvider } from "../src/live/clob-clock-safety-provider.js";
import {
  ConfiguredComplianceProvider,
  FakeClockSafetyProvider,
  FakeComplianceProvider,
  FakeGeoblockProvider,
} from "../src/live/live-safety-provider.js";
import { MockBalanceProvider } from "../src/live/mock-balance-provider.js";
import { OfficialGeoblockProvider } from "../src/live/official-geoblock-provider.js";
import { RiskManager } from "../src/risk/risk-manager.js";

const directories: string[] = [];
const sourceVersion: SourceVersion = { commit: "live-gate-test", dirty: false };
const wallet = "0x0000000000000000000000000000000000000001";
const conditionId = `0x${"2".repeat(64)}`;
const assetId = "asset-live";
const liveAccountId = "live-account-gate-test";
const now = "2026-07-09T00:00:00.000Z";
const confirmationText = "ENABLE LIVE TRADING";

interface TestRuleset {
  hash: string;
  snapshotJson: string;
  configVersion: string;
}

function installHistoricalStopRuleset(databasePath: string): TestRuleset {
  const snapshot = JSON.parse(RULESET_SNAPSHOT_JSON) as {
    versions: Record<string, unknown>;
    rules: Record<string, unknown>;
  };
  snapshot.versions.rulesetVersion = "test-gate-historical-stop-v1";
  snapshot.versions.configVersion = "test-gate-historical-config-v1";
  snapshot.rules.stopTriggerRatioPpm = 600_000;
  snapshot.rules.liveStopLossRatioPpm = 600_000;
  snapshot.rules.stopSellMaxSlippagePpm = 200_000;
  const snapshotJson = stableJson(snapshot);
  const hash = createHash("sha256").update(snapshotJson).digest("hex");
  const configVersion = "test-gate-historical-config-v1";
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
    now,
  );
  db.prepare(
    `INSERT INTO ruleset_registry(
      ruleset_hash,ruleset_version,buy_price_lower_ratio_ppm,buy_price_upper_ratio_ppm,
      stop_loss_ratio_ppm,wait_ratio_ppm,max_wait_time_ms,capital_mode,fee_model_version,
      ruleset_snapshot_json,source_code_commit,source_code_dirty,config_version,created_at
    ) VALUES (?, 'test-gate-historical-stop-v1', ?, ?, 600000, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
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
    now,
  );
  db.close();
  return { hash, snapshotJson, configVersion };
}

function setup() {
  const directory = mkdtempSync(join(tmpdir(), "ni-k-live-gate-"));
  directories.push(directory);
  const databasePath = join(directory, "phase0.sqlite");
  const phase0 = new Phase0Database(databasePath, sourceVersion);
  phase0.initialize();
  const targetId = phase0.ensureTarget(wallet, "IDENTITY_CONFIRMED");
  phase0.close();
  return { databasePath, targetId };
}

function service(databasePath: string, balanceMicros = "1000000000", config = defaultLiveGateConfig()) {
  return new LiveGateService(
    databasePath,
    new MockBalanceProvider({ status: "AVAILABLE", balanceMicros, reason: null, checkedAt: now, source: "TEST_FIXTURE" }),
    { ...config, runtimeEnvironment: "TEST" },
    {
      sourceVersion,
      now: () => new Date(now),
      geoblockProvider: new FakeGeoblockProvider({
        status: "ALLOWED",
        checkedAt: now,
        source: "TEST_FIXTURE",
        reason: null,
      }),
      clockProvider: new FakeClockSafetyProvider({
        status: "SAFE",
        offsetMs: 0,
        checkedAt: now,
        source: "TEST_FIXTURE",
        reason: null,
      }),
    },
  );
}

function passPrerequisites(databasePath: string, options: {
  environment?: "TEST" | "PRODUCTION";
  checkedAt?: string;
  commit?: string;
  testOnly?: boolean;
} = {}): void {
  const db = new DatabaseSync(databasePath);
  const environment = options.environment ?? "TEST";
  const evidence = JSON.stringify({
    evidenceType: environment === "TEST" ? "TEST_FIXTURE" : "VALIDATION_REPORT",
    checkedAt: options.checkedAt ?? now,
    sourceCodeCommit: options.commit ?? sourceVersion.commit,
    environment,
    testOnly: options.testOnly ?? environment === "TEST",
  });
  db.prepare("UPDATE live_gate_prerequisites SET status='PASSED',evidence_json=?,updated_at=?")
    .run(evidence, now);
  db.close();
}

function insertWallet(databasePath: string, address = wallet): void {
  const db = new DatabaseSync(databasePath);
  db.prepare(
    `INSERT OR IGNORE INTO live_wallets(
      live_wallet_id,wallet_address,wallet_type,network,status,created_at,updated_at
    ) VALUES ('wallet-live', ?, 'EOA', 'POLYGON', 'ACTIVE', ?, ?)`,
  ).run(address, "2026-07-09T00:00:00.000Z", "2026-07-09T00:00:00.000Z");
  db.close();
}

function ensureLiveAccount(
  db: DatabaseSync,
  accountId = liveAccountId,
  walletId = "wallet-live",
  walletAddress = wallet,
  authorizedSignerAddress: string | null = walletAddress,
): void {
  db.prepare(
    `INSERT OR IGNORE INTO live_wallets(
      live_wallet_id,wallet_address,wallet_type,network,status,created_at,updated_at
    ) VALUES (?, ?, 'EOA', 'POLYGON', 'ACTIVE', ?, ?)`,
  ).run(walletId, walletAddress, now, now);
  db.prepare(
    `INSERT OR IGNORE INTO live_accounts(
      live_account_id,live_wallet_id,name,status,initial_bankroll_micros,risk_budget_micros,
      signal_cutoff_at,schema_version,strategy_version,risk_version,live_version,ruleset_hash,
      source_code_commit,source_code_dirty,config_version,activated_at,created_at,updated_at,
      authorized_signer_address
    ) VALUES (?, ?, 'Live Gate Test Account', 'ACTIVE', '1000000000', '500000000',
      ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
  ).run(
    accountId,
    walletId,
    now,
    VERSIONS.schemaVersion,
    VERSIONS.strategyVersion,
    VERSIONS.riskVersion,
    VERSIONS.liveVersion,
    RULESET_HASH,
    sourceVersion.commit,
    VERSIONS.configVersion,
    now,
    now,
    now,
    authorizedSignerAddress,
  );
}

function insertLiveAccount(databasePath: string): void {
  const db = new DatabaseSync(databasePath);
  ensureLiveAccount(db);
  db.close();
}

function setLiveActive(databasePath: string): void {
  const db = new DatabaseSync(databasePath);
  db.prepare(
    "UPDATE live_gate_state SET execution_mode='LIVE',live_gate_state='LIVE_ACTIVE',requested_execution_mode='LIVE',state_reason='TEST',updated_at=? WHERE state_id='default'",
  ).run("2026-07-09T00:00:00.000Z");
  db.close();
}

function state(databasePath: string): { execution_mode: string; live_gate_state: string } {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  const row = db.prepare("SELECT execution_mode,live_gate_state FROM live_gate_state WHERE state_id='default'")
    .get() as { execution_mode: string; live_gate_state: string };
  db.close();
  return row;
}

function insertSignalAndRisk(databasePath: string, targetId: string, input: {
  signalId: string;
  riskDecisionId: string;
  decision: "ALLOW" | "REJECT";
  signalType?: "TARGET_BUY" | "TARGET_SELL";
  marketEndTime?: string;
  marketEndTimeStatus?: "VERIFIED" | "UNAVAILABLE";
  executionDeadlineAt?: string | null;
  requestedAmountMicros?: string | null;
  requestedSizeMicros?: string | null;
  ruleset?: TestRuleset;
}) {
  const db = new DatabaseSync(databasePath);
  db.exec("PRAGMA foreign_keys=ON");
  ensureLiveAccount(db);
  const sourceKey = `source-${input.signalId}`;
  const createdAt = "2026-07-09T00:00:00.000Z";
  const rulesetHash = input.ruleset?.hash ?? RULESET_HASH;
  const rulesetSnapshotJson = input.ruleset?.snapshotJson ?? RULESET_SNAPSHOT_JSON;
  const configVersion = input.ruleset?.configVersion ?? VERSIONS.configVersion;
  db.prepare(
    `INSERT INTO raw_events(
      source_event_key,target_id,identity_version,source_type,source_transaction_hash,
      source_timestamp,asset_id,condition_id,side,price_units,size_micros,gap_event,
      is_combo,raw_json,created_at,event_classification
    ) VALUES (?, ?, 'test', 'DATA_API_TRADE', ?, 1773014400, ?, ?, 'BUY',
      '500000000000000000', '10000000', 0, 0, '{}', ?, 'STANDARD_TRADE')`,
  ).run(sourceKey, targetId, `tx-${input.signalId}`, assetId, conditionId, createdAt);
  db.prepare(
    `INSERT INTO signals(
      signal_id,target_id,signal_idempotency_key,source_event_key,signal_type,status,asset_id,
      condition_id,target_price_units,target_size_micros,sell_ratio_numerator,
      sell_ratio_denominator,reason,schema_version,signal_version,strategy_version,
      risk_version,replay_version,ruleset_snapshot_json,ruleset_hash,source_code_commit,
      created_at,execution_eligible,execution_block_reason,event_classification,
      capital_estimate_id,source_code_dirty,producer_mode
    ) VALUES (?, ?, ?, ?, ?, 'PUBLISHED', ?, ?, '500000000000000000',
      '10000000', NULL, NULL, 'TEST', ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL,
      'STANDARD_TRADE', NULL, 0, 'OBSERVE_ONLY')`,
  ).run(
    input.signalId,
    targetId,
    `idem-${input.signalId}`,
    sourceKey,
    input.signalType ?? "TARGET_BUY",
    assetId,
    conditionId,
    VERSIONS.schemaVersion,
    VERSIONS.signalVersion,
    VERSIONS.strategyVersion,
    VERSIONS.riskVersion,
    VERSIONS.replayVersion,
    rulesetSnapshotJson,
    rulesetHash,
    sourceVersion.commit,
    createdAt,
  );
  const contextId = `context-${input.signalId}`;
  db.prepare(
    `INSERT INTO signal_execution_contexts(
      context_id,target_id,signal_id,capital_decision_id,target_trade_capital_ratio_ppm,
      target_trade_timestamp,market_end_time,market_end_time_status,execution_deadline_at,
      market_metadata_snapshot_json,
      market_metadata_hash,ruleset_hash,schema_version,signal_version,strategy_version,
      source_code_commit,source_code_dirty,config_version,created_at
    ) VALUES (?, ?, ?, NULL, '100000', ?, ?, ?, ?, '{}', ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
  ).run(
    contextId,
    targetId,
    input.signalId,
    createdAt,
    input.marketEndTime ?? "2026-07-10T00:00:00.000Z",
    input.marketEndTimeStatus ?? "VERIFIED",
    input.executionDeadlineAt ?? null,
    `metadata-${input.signalId}`,
    rulesetHash,
    VERSIONS.schemaVersion,
    VERSIONS.signalVersion,
    VERSIONS.strategyVersion,
    sourceVersion.commit,
    configVersion,
    createdAt,
  );
  db.prepare(
    `INSERT INTO risk_decisions(
      risk_decision_id,executor_mode,paper_account_id,account_id,signal_id,context_id,decision,
      risk_reject_reason,requested_amount_micros,requested_size_micros,checks_json,
      schema_version,strategy_version,risk_version,ruleset_hash,source_code_commit,
      source_code_dirty,config_version,created_at,risk_reason
    ) VALUES (?, 'LIVE', NULL, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
  ).run(
    input.riskDecisionId,
    liveAccountId,
    input.signalId,
    contextId,
    input.decision,
    input.decision === "REJECT" ? "TEST_REJECT" : null,
    input.requestedAmountMicros === undefined ? "5000000" : input.requestedAmountMicros,
    input.requestedSizeMicros === undefined ? null : input.requestedSizeMicros,
    VERSIONS.schemaVersion,
    VERSIONS.strategyVersion,
    VERSIONS.riskVersion,
    rulesetHash,
    sourceVersion.commit,
    configVersion,
    createdAt,
    input.decision,
  );
  db.close();
  return { contextId };
}

function insertPaperRiskDecision(
  databasePath: string,
  signalId: string,
  riskDecisionId: string,
  contextId: string,
): void {
  const db = new DatabaseSync(databasePath);
  const paperAccountId = `paper-${riskDecisionId}`;
  db.prepare(
    `INSERT INTO paper_accounts(
      paper_account_id,name,status,initial_balance_micros,cash_balance_micros,
      reserved_balance_micros,realized_pnl_micros,signal_cutoff_at,schema_version,
      strategy_version,risk_version,paper_version,ruleset_snapshot_json,ruleset_hash,
      source_code_commit,source_code_dirty,created_at,updated_at
    ) VALUES (?, 'Risk Mode Fixture', 'ACTIVE', '0', '0', '0', '0', ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
  ).run(
    paperAccountId,
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
    paperAccountId,
    paperAccountId,
    signalId,
    contextId,
    VERSIONS.schemaVersion,
    VERSIONS.strategyVersion,
    VERSIONS.riskVersion,
    RULESET_HASH,
    sourceVersion.commit,
    VERSIONS.configVersion,
    now,
  );
  db.close();
}

function executionInput(signalId: string, riskDecisionId: string, overrides: Partial<{
  rulesetHash: string;
  accountId: string;
  contextId: string;
  side: "BUY" | "SELL";
  assetId: string;
  conditionId: string;
  targetPriceUnits: string;
  targetSizeMicros: string;
}> = {}) {
  return {
    signalId,
    riskDecisionId,
    rulesetHash: RULESET_HASH,
    accountId: liveAccountId,
    contextId: `context-${signalId}`,
    side: "BUY" as const,
    assetId,
    conditionId,
    targetPriceUnits: "500000000000000000",
    targetSizeMicros: "10000000",
    ...overrides,
  };
}

function insertLivePosition(databasePath: string, input: {
  signalId: string;
  riskDecisionId: string;
  remainingCostMicros: string;
  realizedPnlMicros?: string;
}): { executionId: string; positionId: string } {
  const db = new DatabaseSync(databasePath);
  db.exec("PRAGMA foreign_keys=ON");
  const createdAt = "2026-07-09T00:00:00.000Z";
  const version = db.prepare(
    `SELECT c.ruleset_hash,r.config_version
     FROM signal_execution_contexts c
     JOIN ruleset_registry r ON r.ruleset_hash=c.ruleset_hash
     WHERE c.signal_id=?`,
  ).get(input.signalId) as { ruleset_hash: string; config_version: string };
  const executionId = `execution-${input.signalId}`;
  const positionId = `position-${input.signalId}`;
  db.prepare(
    `INSERT INTO live_executions(
      live_execution_id,live_account_id,signal_id,context_id,risk_decision_id,live_gate_run_id,
      execution_idempotency_key,execution_type,state,asset_id,condition_id,requested_amount_micros,
      requested_size_micros,filled_size_micros,filled_notional_micros,fee_micros,target_price_units,
      reason,schema_version,strategy_version,risk_version,live_version,ruleset_hash,source_code_commit,
      source_code_dirty,config_version,created_at,updated_at
    ) VALUES (?, ?, ?, ?, ?, NULL, ?, 'TARGET_BUY', 'EXECUTED', ?, ?, '1', NULL,
      '1', '1', '0', '500000000000000000', 'TEST', ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
  ).run(
    executionId,
    liveAccountId,
    input.signalId,
    `context-${input.signalId}`,
    input.riskDecisionId,
    `execution-key-${input.signalId}`,
    assetId,
    conditionId,
    VERSIONS.schemaVersion,
    VERSIONS.strategyVersion,
    VERSIONS.riskVersion,
    VERSIONS.liveVersion,
    version.ruleset_hash,
    sourceVersion.commit,
    version.config_version,
    createdAt,
    createdAt,
  );
  db.prepare(
    `INSERT INTO live_positions(
      live_position_id,live_account_id,opening_execution_id,signal_id,asset_id,condition_id,outcome,
      entry_price_units,entry_size_micros,entry_notional_micros,entry_fee_micros,current_size_micros,
      remaining_cost_micros,status,frozen_from_status,frozen_reason,frozen_at,realized_pnl_micros,
      ruleset_hash,source_code_commit,source_code_dirty,config_version,created_at,updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, NULL, '500000000000000000', '1', ?, '0', '1', ?, 'OPEN',
      NULL, NULL, NULL, ?, ?, ?, 0, ?, ?, ?)`,
  ).run(
    positionId,
    liveAccountId,
    executionId,
    input.signalId,
    assetId,
    conditionId,
    input.remainingCostMicros,
    input.remainingCostMicros,
    input.realizedPnlMicros ?? "0",
    version.ruleset_hash,
    sourceVersion.commit,
    version.config_version,
    createdAt,
    createdAt,
  );
  db.close();
  return { executionId, positionId };
}

function seedConsecutiveLiveLosses(databasePath: string, targetId: string, prefix: string): void {
  for (let sequence = 1; sequence <= RULESET.liveMaxConsecutiveLosses; sequence += 1) {
    const signalId = `${prefix}-loss-${sequence}`;
    const riskDecisionId = `${prefix}-risk-loss-${sequence}`;
    insertSignalAndRisk(databasePath, targetId, { signalId, riskDecisionId, decision: "ALLOW" });
    const seeded = insertLivePosition(databasePath, {
      signalId,
      riskDecisionId,
      remainingCostMicros: "1",
      realizedPnlMicros: "-10000000",
    });
    const timestamp = `2026-07-09T00:00:0${sequence}.000Z`;
    const db = new DatabaseSync(databasePath);
    db.prepare(
      `INSERT INTO live_pnl_ledger(
        pnl_ledger_id,live_account_id,live_position_id,live_execution_id,pnl_type,proceeds_micros,
        cost_basis_micros,fee_micros,pnl_micros,price_source,price_timestamp,ruleset_hash,
        source_code_commit,source_code_dirty,config_version,idempotency_key,created_at
      ) VALUES (?, ?, ?, ?, 'REALIZED', '0', '10000000', '0', '-10000000', 'CLOB_FILL',
        ?, ?, ?, 0, ?, ?, ?)`,
    ).run(
      `${prefix}-pnl-${sequence}`,
      liveAccountId,
      seeded.positionId,
      seeded.executionId,
      timestamp,
      RULESET_HASH,
      sourceVersion.commit,
      VERSIONS.configVersion,
      `${prefix}-pnl-idem-${sequence}`,
      timestamp,
    );
    db.close();
  }
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("LiveGateService", () => {
  it("rejects MOCK and PAPER balance providers in the default PRODUCTION environment", async () => {
    for (const providerType of ["MOCK", "PAPER"] as const) {
      const env = setup();
      passPrerequisites(env.databasePath, { environment: "PRODUCTION" });
      insertWallet(env.databasePath);
      const gate = new LiveGateService(
        env.databasePath,
        {
          providerType,
          async getBalance() {
            return { status: "AVAILABLE" as const, balanceMicros: "1000000000", reason: null, checkedAt: now, source: "TEST" };
          },
        },
        defaultLiveGateConfig(),
        { sourceVersion, now: () => new Date(now) },
      );
      const result = await gate.preflight({ requestedExecutionMode: "LIVE" });
      expect(result.blockedReasons).toContain(`BALANCE_PROVIDER_FORBIDDEN_IN_PRODUCTION:${providerType}`);
      gate.close();
    }
  });

  it("rejects a dirty production source tree", async () => {
    const env = setup();
    passPrerequisites(env.databasePath, { environment: "PRODUCTION", commit: "dirty-source" });
    insertWallet(env.databasePath);
    const gate = new LiveGateService(
      env.databasePath,
      {
        providerType: "LIVE_READONLY",
        async getBalance() {
          return { status: "AVAILABLE", balanceMicros: "1000000000", reason: null, checkedAt: now, source: "LIVE_READONLY_TEST" };
        },
      },
      defaultLiveGateConfig(),
      {
        sourceVersion: { commit: "dirty-source", dirty: true },
        now: () => new Date(now),
        geoblockProvider: {
          providerType: "LIVE_READONLY",
          async check() { return { status: "ALLOWED", checkedAt: now, source: "LIVE_READONLY_TEST", reason: null }; },
        },
        clockProvider: {
          providerType: "LIVE_READONLY",
          async check() { return { status: "SAFE", offsetMs: 0, checkedAt: now, source: "LIVE_READONLY_TEST", reason: null }; },
        },
      },
    );
    const result = await gate.preflight({ requestedExecutionMode: "LIVE" });
    expect(result.blockedReasons).toContain("SOURCE_WORKTREE_DIRTY");
    gate.close();
  });

  it("requires parseable, non-empty, fresh prerequisite evidence bound to the source commit", async () => {
    const env = setup();
    insertWallet(env.databasePath);
    const db = new DatabaseSync(env.databasePath);
    db.prepare("UPDATE live_gate_prerequisites SET status='PASSED',evidence_json='{}',updated_at=?").run(now);
    db.close();
    const gate = service(env.databasePath);
    const empty = await gate.preflight({ requestedExecutionMode: "LIVE" });
    expect(empty.blockedReasons).toContain("PREREQUISITE_EVIDENCE_EMPTY:CRASH_RECOVERY_LONG_RUN");

    passPrerequisites(env.databasePath, { checkedAt: "2025-01-01T00:00:00.000Z" });
    const stale = await gate.preflight({ requestedExecutionMode: "LIVE" });
    expect(stale.blockedReasons).toContain("PREREQUISITE_EVIDENCE_STALE:CRASH_RECOVERY_LONG_RUN");

    passPrerequisites(env.databasePath, { commit: "different-commit" });
    const mismatched = await gate.preflight({ requestedExecutionMode: "LIVE" });
    expect(mismatched.blockedReasons).toContain("PREREQUISITE_SOURCE_COMMIT_MISMATCH:CRASH_RECOVERY_LONG_RUN");
    gate.close();
  });

  it("requires explicit test-only evidence for TEST prerequisites", async () => {
    const env = setup();
    passPrerequisites(env.databasePath, { testOnly: false });
    insertWallet(env.databasePath);
    const gate = service(env.databasePath);
    const result = await gate.preflight({ requestedExecutionMode: "LIVE" });
    expect(result.blockedReasons).toContain("PREREQUISITE_TEST_EVIDENCE_NOT_MARKED:CRASH_RECOVERY_LONG_RUN");
    gate.close();
  });

  it("fails closed when a required prerequisite row is missing", async () => {
    const env = setup();
    passPrerequisites(env.databasePath);
    insertWallet(env.databasePath);
    const db = new DatabaseSync(env.databasePath);
    db.prepare("DELETE FROM live_gate_prerequisites WHERE prerequisite_key='USER_EXPLICIT_AUTHORIZATION'").run();
    db.close();
    const gate = service(env.databasePath);
    const result = await gate.preflight({ requestedExecutionMode: "LIVE" });
    expect(result.blockedReasons).toContain("PREREQUISITE_MISSING:USER_EXPLICIT_AUTHORIZATION");
    gate.close();
  });

  it("fails closed instead of throwing when readonly safety providers fail", async () => {
    const env = setup();
    passPrerequisites(env.databasePath);
    insertWallet(env.databasePath);
    const gate = new LiveGateService(
      env.databasePath,
      {
        providerType: "MOCK",
        async getBalance() { throw new Error("balance network down"); },
      },
      { ...defaultLiveGateConfig(), runtimeEnvironment: "TEST" },
      {
        sourceVersion,
        now: () => new Date(now),
        geoblockProvider: {
          providerType: "FAKE",
          async check() { throw new Error("geoblock network down"); },
        },
        clockProvider: {
          providerType: "FAKE",
          async check() { throw new Error("clock network down"); },
        },
      },
    );
    const result = await gate.preflight({ requestedExecutionMode: "LIVE" });
    expect(result.blockedReasons).toContain("BALANCE_PROVIDER_ERROR");
    expect(result.blockedReasons).toContain("GEOBLOCK_PROVIDER_ERROR");
    expect(result.blockedReasons).toContain("CLOCK_PROVIDER_ERROR");
    gate.close();
  });

  it("does not allow direct LIVE activation from default PAPER state", async () => {
    const env = setup();
    passPrerequisites(env.databasePath);
    insertWallet(env.databasePath);
    const gate = service(env.databasePath);
    const result = await gate.confirmLiveActivation({ actor: "test", confirmationText: "confirm" });
    expect(result.allowed).toBe(false);
    expect(result.blockedReasons).toContain("NOT_ARMING:LIVE_DISABLED");
    expect(state(env.databasePath)).toEqual({ execution_mode: "PAPER", live_gate_state: "LIVE_DISABLED" });
    gate.close();
  });

  it("rejects preflight when wallet metadata is missing", async () => {
    const env = setup();
    passPrerequisites(env.databasePath);
    const gate = service(env.databasePath);
    const result = await gate.preflight({ requestedExecutionMode: "LIVE" });
    expect(result.allowed).toBe(false);
    expect(result.blockedReasons).toContain("WALLET_METADATA_MISSING");
    gate.close();
  });

  it("observes a non-negative wallet balance without treating the risk cap as a minimum", async () => {
    const env = setup();
    passPrerequisites(env.databasePath);
    insertWallet(env.databasePath);
    const db = new DatabaseSync(env.databasePath);
    ensureLiveAccount(db);
    db.close();
    const gate = service(env.databasePath, "999");
    const result = await gate.preflight({ requestedExecutionMode: "LIVE" });
    expect(result.allowed).toBe(true);
    expect(result.blockedReasons).not.toContain("BALANCE_BELOW_BANKROLL");
    expect(result.blockedReasons).not.toContain("LIVE_ACCOUNT_CASH_MISMATCH");
    gate.close();
  });

  it("rejects preflight until an active Live account is bound to the active wallet", async () => {
    const env = setup();
    passPrerequisites(env.databasePath);
    insertWallet(env.databasePath);
    const gate = service(env.databasePath);
    const result = await gate.preflight({ requestedExecutionMode: "LIVE" });
    expect(result.blockedReasons).toContain("ACTIVE_LIVE_ACCOUNT_MISSING");
    gate.close();
  });

  it("rejects an active Live account whose authorized signer identity is missing or invalid", async () => {
    const missing = setup();
    passPrerequisites(missing.databasePath);
    insertWallet(missing.databasePath);
    const missingDb = new DatabaseSync(missing.databasePath);
    ensureLiveAccount(missingDb, liveAccountId, "wallet-live", wallet, null);
    missingDb.close();
    const missingGate = service(missing.databasePath);
    const missingResult = await missingGate.preflight({ requestedExecutionMode: "LIVE" });
    expect(missingResult.allowed).toBe(false);
    expect(missingResult.blockedReasons).toContain("LIVE_ACCOUNT_AUTHORIZED_SIGNER_MISSING");
    missingGate.close();

    const invalid = setup();
    passPrerequisites(invalid.databasePath);
    insertWallet(invalid.databasePath);
    const invalidDb = new DatabaseSync(invalid.databasePath);
    invalidDb.exec("PRAGMA ignore_check_constraints=ON");
    ensureLiveAccount(invalidDb, liveAccountId, "wallet-live", wallet, "not-an-address");
    invalidDb.exec("PRAGMA ignore_check_constraints=OFF");
    invalidDb.close();
    const invalidGate = service(invalid.databasePath);
    const invalidResult = await invalidGate.preflight({ requestedExecutionMode: "LIVE" });
    expect(invalidResult.allowed).toBe(false);
    expect(invalidResult.blockedReasons).toContain("LIVE_ACCOUNT_AUTHORIZED_SIGNER_INVALID");
    invalidGate.close();

    const mismatch = setup();
    passPrerequisites(mismatch.databasePath);
    insertWallet(mismatch.databasePath);
    const mismatchDb = new DatabaseSync(mismatch.databasePath);
    ensureLiveAccount(
      mismatchDb,
      liveAccountId,
      "wallet-live",
      wallet,
      "0x0000000000000000000000000000000000000002",
    );
    mismatchDb.close();
    const mismatchGate = service(mismatch.databasePath);
    const mismatchResult = await mismatchGate.preflight({ requestedExecutionMode: "LIVE" });
    expect(mismatchResult.allowed).toBe(false);
    expect(mismatchResult.blockedReasons).toContain("LIVE_ACCOUNT_EOA_SIGNER_MISMATCH");
    mismatchGate.close();
  });

  it("binds the active Live account bankroll and risk budget to the Gate configuration", async () => {
    const env = setup();
    passPrerequisites(env.databasePath);
    insertWallet(env.databasePath);
    const db = new DatabaseSync(env.databasePath);
    ensureLiveAccount(db);
    db.prepare("UPDATE live_accounts SET initial_bankroll_micros='2000000000' WHERE live_account_id=?")
      .run(liveAccountId);
    db.close();
    const gate = service(env.databasePath, "2000000000");
    const result = await gate.preflight({ requestedExecutionMode: "LIVE" });
    expect(result.blockedReasons).toContain("LIVE_ACCOUNT_BANKROLL_CONFIG_MISMATCH");
    gate.close();

    const restored = new DatabaseSync(env.databasePath);
    restored.prepare(
      "UPDATE live_accounts SET initial_bankroll_micros='1000000000',risk_budget_micros='600000000' WHERE live_account_id=?",
    ).run(liveAccountId);
    restored.close();
    const budgetGate = service(env.databasePath);
    const budgetResult = await budgetGate.preflight({ requestedExecutionMode: "LIVE" });
    expect(budgetResult.blockedReasons).toContain("LIVE_ACCOUNT_RISK_BUDGET_INVALID");
    budgetGate.close();
  });

  it("allows a zero wallet balance at activation while preserving configured risk caps", async () => {
    const env = setup();
    passPrerequisites(env.databasePath);
    insertWallet(env.databasePath);
    const db = new DatabaseSync(env.databasePath);
    ensureLiveAccount(db);
    db.close();
    const gate = service(env.databasePath, "0");
    const result = await gate.preflight({ requestedExecutionMode: "LIVE" });
    expect(result.allowed).toBe(true);
    expect(result.blockedReasons).not.toContain("LIVE_ACCOUNT_CASH_MISMATCH");
    gate.close();
  });

  it("accepts wallet funds above the allocated Live bankroll without expanding risk limits", async () => {
    const env = setup();
    passPrerequisites(env.databasePath);
    insertWallet(env.databasePath);
    const db = new DatabaseSync(env.databasePath);
    ensureLiveAccount(db);
    db.close();
    const gate = service(env.databasePath, "1000020001");
    const result = await gate.preflight({ requestedExecutionMode: "LIVE" });
    expect(result.blockedReasons).not.toContain("LIVE_ACCOUNT_CASH_MISMATCH");
    gate.close();
  });

  it("rejects invalid risk parameters", async () => {
    const env = setup();
    passPrerequisites(env.databasePath);
    insertWallet(env.databasePath);
    const config = { ...defaultLiveGateConfig(), maxExposureMicros: "2000000000" };
    const gate = service(env.databasePath, "3000000000", config);
    const result = await gate.preflight({ requestedExecutionMode: "LIVE" });
    expect(result.allowed).toBe(false);
    expect(result.blockedReasons).toContain("MAX_EXPOSURE_EXCEEDS_BANKROLL");
    gate.close();
  });

  it("fails closed without throwing on malformed numeric risk configuration", async () => {
    const env = setup();
    passPrerequisites(env.databasePath);
    insertWallet(env.databasePath);
    const gate = service(env.databasePath, "1000000000", {
      ...defaultLiveGateConfig(),
      maxExposureMicros: "not-a-number",
    });
    const result = await gate.preflight({ requestedExecutionMode: "LIVE" });
    expect(result.blockedReasons).toContain("CONFIG_MAX_EXPOSURE_MISSING_OR_INVALID");
    expect(result.blockedReasons).toContain("MAX_EXPOSURE_INVALID");
    gate.close();
  });

  it("rejects database schema mismatch", async () => {
    const env = setup();
    passPrerequisites(env.databasePath);
    insertWallet(env.databasePath);
    const gate = service(env.databasePath, "1000000000", { ...defaultLiveGateConfig(), expectedSchemaVersion: "9.9.9" });
    const result = await gate.preflight({ requestedExecutionMode: "LIVE" });
    expect(result.allowed).toBe(false);
    expect(result.blockedReasons.some((reason) => reason.startsWith("SCHEMA_VERSION_MISMATCH"))).toBe(true);
    gate.close();
  });

  it("accepts the expected migration when an unrelated later migration row also exists", async () => {
    const env = setup();
    passPrerequisites(env.databasePath);
    insertWallet(env.databasePath);
    const db = new DatabaseSync(env.databasePath);
    db.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES ('99.0.0',?)").run("2026-07-09T00:00:01.000Z");
    db.close();
    const gate = service(env.databasePath);
    const result = await gate.preflight({ requestedExecutionMode: "LIVE" });
    expect(result.blockedReasons.some((reason) => reason.startsWith("SCHEMA_VERSION_MISMATCH"))).toBe(false);
    gate.close();
  });

  it("rejects reconciliation mismatch", async () => {
    const env = setup();
    passPrerequisites(env.databasePath);
    insertWallet(env.databasePath);
    const db = new DatabaseSync(env.databasePath);
    db.prepare(
      `INSERT INTO paper_accounts(
        paper_account_id,name,status,initial_balance_micros,cash_balance_micros,
        reserved_balance_micros,realized_pnl_micros,signal_cutoff_at,schema_version,
        strategy_version,risk_version,paper_version,ruleset_snapshot_json,ruleset_hash,
        source_code_commit,source_code_dirty,created_at,updated_at
      ) VALUES ('bad-account','Bad','ACTIVE','1000','1000','0','0',?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    ).run(
      "2026-07-09T00:00:00.000Z",
      VERSIONS.schemaVersion,
      VERSIONS.strategyVersion,
      VERSIONS.riskVersion,
      VERSIONS.paperVersion,
      RULESET_SNAPSHOT_JSON,
      RULESET_HASH,
      sourceVersion.commit,
      "2026-07-09T00:00:00.000Z",
      "2026-07-09T00:00:00.000Z",
    );
    db.close();
    const gate = service(env.databasePath);
    const result = await gate.preflight({ requestedExecutionMode: "LIVE" });
    expect(result.allowed).toBe(false);
    expect(result.blockedReasons).toContain("CASH_LEDGER_MISMATCH:bad-account");
    gate.close();
  });

  it("scopes production activation reconciliation to Live ledgers instead of historical Paper portfolios", async () => {
    const env = setup();
    passPrerequisites(env.databasePath, { environment: "PRODUCTION" });
    insertWallet(env.databasePath);
    const db = new DatabaseSync(env.databasePath);
    ensureLiveAccount(db);
    db.prepare(
      `INSERT INTO paper_accounts(
        paper_account_id,name,status,initial_balance_micros,cash_balance_micros,
        reserved_balance_micros,realized_pnl_micros,signal_cutoff_at,schema_version,
        strategy_version,risk_version,paper_version,ruleset_snapshot_json,ruleset_hash,
        source_code_commit,source_code_dirty,created_at,updated_at
      ) VALUES ('historical-paper','Historical','ACTIVE','1000','1000','0','0',?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    ).run(
      "2026-07-01T00:00:00.000Z",
      VERSIONS.schemaVersion,
      VERSIONS.strategyVersion,
      VERSIONS.riskVersion,
      VERSIONS.paperVersion,
      RULESET_SNAPSHOT_JSON,
      RULESET_HASH,
      sourceVersion.commit,
      "2026-07-01T00:00:00.000Z",
      "2026-07-01T00:00:00.000Z",
    );
    db.close();
    const gate = new LiveGateService(
      env.databasePath,
      {
        providerType: "LIVE_READONLY",
        async getBalance() {
          return {
            status: "AVAILABLE",
            balanceMicros: "1000000000",
            reason: null,
            checkedAt: now,
            source: "PRODUCTION_FIXTURE",
          };
        },
      },
      { ...defaultLiveGateConfig(), runtimeEnvironment: "PRODUCTION" },
      {
        sourceVersion,
        now: () => new Date(now),
        geoblockProvider: {
          providerType: "LIVE_READONLY",
          async check() {
            return { status: "ALLOWED", checkedAt: now, source: "PRODUCTION_FIXTURE", reason: null };
          },
        },
        complianceProvider: {
          providerType: "LIVE_READONLY",
          async check() {
            return {
              status: "ALLOWED",
              checkedAt: now,
              source: "PRODUCTION_FIXTURE",
              policyVersion: "fixture-v1",
              reason: null,
            };
          },
        },
        clockProvider: {
          providerType: "LIVE_READONLY",
          async check() {
            return {
              status: "SAFE",
              offsetMs: 0,
              checkedAt: now,
              source: "PRODUCTION_FIXTURE",
              reason: null,
            };
          },
        },
      },
    );
    const result = await gate.preflight({ requestedExecutionMode: "LIVE" });
    expect(result.blockedReasons).not.toContain("CASH_LEDGER_MISMATCH:historical-paper");
    gate.close();
  });

  it("evaluates fresh external evidence against preflight completion time", async () => {
    const env = setup();
    passPrerequisites(env.databasePath, { environment: "PRODUCTION" });
    insertWallet(env.databasePath);
    insertLiveAccount(env.databasePath);
    let current = new Date(now);
    const completedAt = "2026-07-09T00:00:01.000Z";
    const finishNetworkRead = () => {
      current = new Date(completedAt);
      return completedAt;
    };
    const gate = new LiveGateService(
      env.databasePath,
      {
        providerType: "LIVE_READONLY",
        async getBalance() {
          return {
            status: "AVAILABLE",
            balanceMicros: "1000000000",
            reason: null,
            checkedAt: finishNetworkRead(),
            source: "PRODUCTION_FIXTURE",
          };
        },
      },
      { ...defaultLiveGateConfig(), runtimeEnvironment: "PRODUCTION" },
      {
        sourceVersion,
        now: () => current,
        geoblockProvider: {
          providerType: "LIVE_READONLY",
          async check() {
            return {
              status: "ALLOWED",
              checkedAt: finishNetworkRead(),
              source: "PRODUCTION_FIXTURE",
              reason: null,
            };
          },
        },
        complianceProvider: {
          providerType: "LIVE_READONLY",
          async check() {
            return {
              status: "ALLOWED",
              checkedAt: finishNetworkRead(),
              source: "PRODUCTION_FIXTURE",
              policyVersion: "fixture-v1",
              reason: null,
            };
          },
        },
        clockProvider: {
          providerType: "LIVE_READONLY",
          async check() {
            return {
              status: "SAFE",
              offsetMs: 0,
              checkedAt: finishNetworkRead(),
              source: "PRODUCTION_FIXTURE",
              reason: null,
            };
          },
        },
      },
    );
    const result = await gate.preflight({ requestedExecutionMode: "LIVE" });
    expect(result.blockedReasons).not.toContain("BALANCE_EVIDENCE_STALE_OR_INVALID");
    expect(result.blockedReasons).not.toContain("GEOBLOCK_EVIDENCE_STALE_OR_INVALID");
    expect(result.blockedReasons).not.toContain("COMPLIANCE_EVIDENCE_STALE_OR_INVALID");
    expect(result.blockedReasons).not.toContain("CLOCK_EVIDENCE_STALE_OR_INVALID");
    gate.close();
  });

  it("blocks execution when Risk Decision is REJECT", async () => {
    const env = setup();
    passPrerequisites(env.databasePath);
    insertWallet(env.databasePath);
    insertSignalAndRisk(env.databasePath, env.targetId, { signalId: "reject-signal", riskDecisionId: "risk-reject", decision: "REJECT" });
    setLiveActive(env.databasePath);
    const gate = service(env.databasePath);
    const result = await gate.checkExecution(executionInput("reject-signal", "risk-reject"));
    expect(result.allowed).toBe(false);
    expect(result.blockedReasons).toContain("RISK_DECISION_NOT_ALLOW:REJECT");
    gate.close();
  });

  it("allows execution gate when Risk Decision is ALLOW and Live is active", async () => {
    const env = setup();
    passPrerequisites(env.databasePath);
    insertWallet(env.databasePath);
    insertSignalAndRisk(env.databasePath, env.targetId, { signalId: "allow-signal", riskDecisionId: "risk-allow", decision: "ALLOW" });
    setLiveActive(env.databasePath);
    const gate = service(env.databasePath);
    const result = await gate.checkExecution(executionInput("allow-signal", "risk-allow"));
    expect(result.allowed).toBe(true);
    gate.close();
  });

  it("blocks Live execution when the market end time is unavailable", async () => {
    const env = setup();
    passPrerequisites(env.databasePath);
    insertWallet(env.databasePath);
    insertSignalAndRisk(env.databasePath, env.targetId, {
      signalId: "unknown-market-end",
      riskDecisionId: "risk-unknown-market-end",
      decision: "ALLOW",
      marketEndTime: "",
      marketEndTimeStatus: "UNAVAILABLE",
      executionDeadlineAt: "2026-07-09T00:30:00.000Z",
    });
    setLiveActive(env.databasePath);
    const gate = service(env.databasePath);
    const result = await gate.checkExecution(executionInput("unknown-market-end", "risk-unknown-market-end"));
    expect(result.allowed).toBe(false);
    expect(result.blockedReasons).toContain("MARKET_END_TIME_UNAVAILABLE");
    gate.close();
  });

  it("rechecks the configured per-trade capital cap for every Live BUY", async () => {
    const env = setup();
    passPrerequisites(env.databasePath);
    insertWallet(env.databasePath);
    insertSignalAndRisk(env.databasePath, env.targetId, {
      signalId: "configured-trade-limit",
      riskDecisionId: "risk-configured-trade-limit",
      decision: "ALLOW",
    });
    setLiveActive(env.databasePath);
    const gate = service(env.databasePath, "1000000000", {
      ...defaultLiveGateConfig(),
      maxTradeSizeMicros: "1000000",
    });
    const result = await gate.checkExecution(executionInput("configured-trade-limit", "risk-configured-trade-limit"));
    expect(result.blockedReasons).toContain("LIVE_BUY_LIMIT_EXCEEDED");
    gate.close();
  });

  it("allows only a position-bound STOP_LOSS Risk Decision and does not block the exit on new-open risk limits", async () => {
    const env = setup();
    passPrerequisites(env.databasePath);
    insertWallet(env.databasePath);
    insertSignalAndRisk(env.databasePath, env.targetId, {
      signalId: "stop-loss-opening-signal",
      riskDecisionId: "risk-stop-loss-opening-buy",
      decision: "ALLOW",
    });
    const position = insertLivePosition(env.databasePath, {
      signalId: "stop-loss-opening-signal",
      riskDecisionId: "risk-stop-loss-opening-buy",
      remainingCostMicros: "600000000",
    });
    seedConsecutiveLiveLosses(env.databasePath, env.targetId, "stop-loss-risk-limit");
    const db = new DatabaseSync(env.databasePath);
    const risk = new RiskManager(db, sourceVersion).recordSystemDecision({
      mode: "LIVE",
      accountId: liveAccountId,
      signalId: "stop-loss-opening-signal",
      contextId: "context-stop-loss-opening-signal",
      entityId: position.positionId,
      executionType: "STOP_LOSS",
      decision: "ALLOW",
      reason: "STOP_LOSS_TRIGGERED",
      requestedAmountMicros: null,
      requestedSizeMicros: 1n,
      now,
    });
    db.close();
    setLiveActive(env.databasePath);
    const gate = service(env.databasePath);
    const input = {
      signalId: "stop-loss-opening-signal",
      riskDecisionId: risk.riskDecisionId,
      rulesetHash: RULESET_HASH,
      accountId: liveAccountId,
      contextId: "context-stop-loss-opening-signal",
      side: "SELL" as const,
      assetId,
      conditionId,
      targetPriceUnits: "250000000000000000",
      targetSizeMicros: "1",
      executionType: "STOP_LOSS" as const,
      positionId: position.positionId,
    };
    expect((await gate.checkExecution(input)).allowed).toBe(true);
    expect((await gate.checkExecution({ ...input, targetPriceUnits: "240000000000000000" })).blockedReasons)
      .toContain("SIGNAL_PRICE_MISMATCH");
    expect((await gate.checkExecution({ ...input, targetSizeMicros: "not-an-integer" })).blockedReasons)
      .toContain("SIGNAL_SIZE_MISMATCH");
    expect((await gate.checkExecution({ ...input, positionId: "missing-position" })).blockedReasons)
      .toContain("STOP_LOSS_SCOPE_MISMATCH");
    gate.close();
  });

  it("keeps TARGET_SELL available after exposure, daily-loss, and consecutive-loss limits are reached", async () => {
    const env = setup();
    passPrerequisites(env.databasePath);
    insertWallet(env.databasePath);
    insertSignalAndRisk(env.databasePath, env.targetId, {
      signalId: "risk-limited-exit",
      riskDecisionId: "risk-limited-exit-decision",
      decision: "ALLOW",
      signalType: "TARGET_SELL",
      requestedAmountMicros: null,
      requestedSizeMicros: "10000000",
    });
    insertSignalAndRisk(env.databasePath, env.targetId, {
      signalId: "risk-limited-exposure-seed",
      riskDecisionId: "risk-limited-exposure-risk",
      decision: "ALLOW",
    });
    insertLivePosition(env.databasePath, {
      signalId: "risk-limited-exposure-seed",
      riskDecisionId: "risk-limited-exposure-risk",
      remainingCostMicros: "600000000",
    });
    seedConsecutiveLiveLosses(env.databasePath, env.targetId, "target-sell-risk-limit");
    setLiveActive(env.databasePath);
    const gate = service(env.databasePath);
    const result = await gate.checkExecution(executionInput(
      "risk-limited-exit",
      "risk-limited-exit-decision",
      { side: "SELL" },
    ));

    expect(result.allowed).toBe(true);
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "live_exposure_limit", passed: true, reason: "EXIT_NOT_EXPOSURE_LIMITED" }),
      expect.objectContaining({ name: "live_daily_loss_limit", passed: true, reason: "EXIT_NOT_DAILY_LOSS_LIMITED" }),
      expect.objectContaining({ name: "live_consecutive_loss_limit", passed: true, reason: "EXIT_NOT_CONSECUTIVE_LOSS_LIMITED" }),
    ]));
    gate.close();
  });

  it("validates STOP_LOSS price against the Position's historical ruleset instead of current constants", async () => {
    const env = setup();
    passPrerequisites(env.databasePath);
    insertWallet(env.databasePath);
    const historical = installHistoricalStopRuleset(env.databasePath);
    insertSignalAndRisk(env.databasePath, env.targetId, {
      signalId: "historical-stop-opening-signal",
      riskDecisionId: "risk-historical-stop-opening-buy",
      decision: "ALLOW",
      ruleset: historical,
    });
    const position = insertLivePosition(env.databasePath, {
      signalId: "historical-stop-opening-signal",
      riskDecisionId: "risk-historical-stop-opening-buy",
      remainingCostMicros: "1",
    });
    const db = new DatabaseSync(env.databasePath);
    const risk = new RiskManager(db, sourceVersion).recordSystemDecision({
      mode: "LIVE",
      accountId: liveAccountId,
      signalId: "historical-stop-opening-signal",
      contextId: "context-historical-stop-opening-signal",
      entityId: position.positionId,
      executionType: "STOP_LOSS",
      decision: "ALLOW",
      reason: "STOP_LOSS_TRIGGERED",
      requestedAmountMicros: null,
      requestedSizeMicros: 1n,
      rulesetHash: historical.hash,
      now,
    });
    db.close();
    setLiveActive(env.databasePath);
    const gate = service(env.databasePath);
    const input = executionInput(
      "historical-stop-opening-signal",
      risk.riskDecisionId,
      {
        rulesetHash: historical.hash,
        contextId: "context-historical-stop-opening-signal",
        side: "SELL",
        targetPriceUnits: "300000000000000000",
        targetSizeMicros: "1",
      },
    );
    const scoped = {
      ...input,
      executionType: "STOP_LOSS" as const,
      positionId: position.positionId,
    };

    expect((await gate.checkExecution(scoped)).allowed).toBe(true);
    expect((await gate.checkExecution({ ...scoped, targetPriceUnits: "250000000000000000" })).blockedReasons)
      .toContain("SIGNAL_PRICE_MISMATCH");
    gate.close();
  });

  it("rechecks the complete Live Gate for a redeem account action", async () => {
    const env = setup();
    passPrerequisites(env.databasePath);
    insertWallet(env.databasePath);
    const db = new DatabaseSync(env.databasePath);
    ensureLiveAccount(db);
    const risk = new RiskManager(db, sourceVersion).recordSystemDecision({
      mode: "LIVE",
      accountId: liveAccountId,
      signalId: null,
      contextId: null,
      entityId: "live-position-redeem-gate",
      executionType: "REDEEM",
      decision: "ALLOW",
      reason: "REDEEM_CONFIRMED",
      requestedAmountMicros: 10_000_000n,
      requestedSizeMicros: 10_000_000n,
      now,
    });
    db.close();
    setLiveActive(env.databasePath);
    const gate = service(env.databasePath);
    const input = {
      action: "REDEEM" as const,
      accountId: liveAccountId,
      riskDecisionId: risk.riskDecisionId,
      rulesetHash: RULESET_HASH,
      assetId,
      conditionId,
      requestedAmountMicros: "10000000",
      requestedSizeMicros: "10000000",
    };

    expect((await gate.checkAccountAction(input)).allowed).toBe(true);
    const changed = new DatabaseSync(env.databasePath);
    changed.prepare("UPDATE live_gate_prerequisites SET status='FAILED' WHERE prerequisite_key='GEOBLOCK_COMPLIANCE'").run();
    changed.close();
    expect((await gate.checkAccountAction(input)).blockedReasons)
      .toContain("PREREQUISITE_FAILED:GEOBLOCK_COMPLIANCE");
    gate.close();
  });

  it("rechecks prerequisites, geoblock and clock safety for every execution", async () => {
    const env = setup();
    passPrerequisites(env.databasePath);
    insertWallet(env.databasePath);
    insertSignalAndRisk(env.databasePath, env.targetId, { signalId: "fresh-safety", riskDecisionId: "risk-fresh-safety", decision: "ALLOW" });
    setLiveActive(env.databasePath);
    let geoblockStatus: "ALLOWED" | "BLOCKED" = "ALLOWED";
    let clockStatus: "SAFE" | "UNSAFE" = "SAFE";
    const gate = new LiveGateService(
      env.databasePath,
      new MockBalanceProvider({ status: "AVAILABLE", balanceMicros: "1000000000", reason: null, checkedAt: now, source: "TEST_FIXTURE" }),
      { ...defaultLiveGateConfig(), runtimeEnvironment: "TEST" },
      {
        sourceVersion,
        now: () => new Date(now),
        geoblockProvider: {
          providerType: "FAKE",
          async check() { return { status: geoblockStatus, checkedAt: now, source: "TEST_FIXTURE", reason: geoblockStatus === "BLOCKED" ? "REGION_BLOCKED" : null }; },
        },
        clockProvider: {
          providerType: "FAKE",
          async check() { return { status: clockStatus, offsetMs: clockStatus === "SAFE" ? 0 : 10_000, checkedAt: now, source: "TEST_FIXTURE", reason: clockStatus === "UNSAFE" ? "CLOCK_OFFSET_EXCEEDED" : null }; },
        },
      },
    );

    expect((await gate.checkExecution(executionInput("fresh-safety", "risk-fresh-safety"))).allowed).toBe(true);
    const db = new DatabaseSync(env.databasePath);
    db.prepare("UPDATE live_gate_prerequisites SET status='FAILED' WHERE prerequisite_key='GEOBLOCK_COMPLIANCE'").run();
    expect((await gate.checkExecution(executionInput("fresh-safety", "risk-fresh-safety"))).blockedReasons)
      .toContain("PREREQUISITE_FAILED:GEOBLOCK_COMPLIANCE");
    db.prepare("UPDATE live_gate_prerequisites SET status='PASSED' WHERE prerequisite_key='GEOBLOCK_COMPLIANCE'").run();
    db.close();

    geoblockStatus = "BLOCKED";
    expect((await gate.checkExecution(executionInput("fresh-safety", "risk-fresh-safety"))).blockedReasons)
      .toContain("REGION_BLOCKED");
    geoblockStatus = "ALLOWED";
    clockStatus = "UNSAFE";
    expect((await gate.checkExecution(executionInput("fresh-safety", "risk-fresh-safety"))).blockedReasons)
      .toContain("CLOCK_OFFSET_EXCEEDED");
    gate.close();
  });

  it("does not turn an observed local offset into a Gate blocker when CLOB server time is in use", async () => {
    const env = setup();
    passPrerequisites(env.databasePath);
    insertWallet(env.databasePath);
    const db = new DatabaseSync(env.databasePath);
    ensureLiveAccount(db);
    db.close();
    const gate = new LiveGateService(
      env.databasePath,
      new MockBalanceProvider({
        status: "AVAILABLE",
        balanceMicros: "0",
        reason: null,
        checkedAt: now,
        source: "TEST_FIXTURE",
      }),
      { ...defaultLiveGateConfig(), runtimeEnvironment: "TEST" },
      {
        sourceVersion,
        now: () => new Date(now),
        geoblockProvider: new FakeGeoblockProvider({
          status: "ALLOWED",
          checkedAt: now,
          source: "TEST_FIXTURE",
          reason: null,
        }),
        clockProvider: new FakeClockSafetyProvider({
          status: "SAFE",
          offsetMs: 10_000,
          checkedAt: now,
          source: "TEST_FIXTURE",
          reason: "CLOCK_OFFSET_OBSERVED_USING_SERVER_TIME",
        }),
      },
    );

    const result = await gate.preflight({ requestedExecutionMode: "LIVE" });
    expect(result.allowed).toBe(true);
    expect(result.blockedReasons).not.toContain("CLOCK_OFFSET_EXCEEDED");
    gate.close();
  });

  it("rechecks production source cleanliness for every execution", async () => {
    const env = setup();
    passPrerequisites(env.databasePath, { environment: "PRODUCTION", commit: "dirty-execution" });
    insertWallet(env.databasePath);
    insertSignalAndRisk(env.databasePath, env.targetId, { signalId: "dirty-execution", riskDecisionId: "risk-dirty-execution", decision: "ALLOW" });
    setLiveActive(env.databasePath);
    const gate = new LiveGateService(
      env.databasePath,
      {
        providerType: "LIVE_READONLY",
        async getBalance() { return { status: "AVAILABLE", balanceMicros: "1000000000", reason: null, checkedAt: now, source: "READONLY_BALANCE" }; },
      },
      defaultLiveGateConfig(),
      {
        sourceVersion: { commit: "dirty-execution", dirty: true },
        now: () => new Date(now),
        geoblockProvider: {
          providerType: "LIVE_READONLY",
          async check() { return { status: "ALLOWED", checkedAt: now, source: "OFFICIAL_GEOBLOCK", reason: null }; },
        },
        clockProvider: {
          providerType: "LIVE_READONLY",
          async check() { return { status: "SAFE", offsetMs: 0, checkedAt: now, source: "SERVER_TIME", reason: null }; },
        },
      },
    );
    const result = await gate.checkExecution(executionInput("dirty-execution", "risk-dirty-execution"));
    expect(result.blockedReasons).toContain("SOURCE_WORKTREE_DIRTY");
    gate.close();
  });

  it("observes an emergency disable that happens while execution safety checks are in flight", async () => {
    const env = setup();
    passPrerequisites(env.databasePath);
    insertWallet(env.databasePath);
    insertSignalAndRisk(env.databasePath, env.targetId, { signalId: "concurrent-disable", riskDecisionId: "risk-concurrent-disable", decision: "ALLOW" });
    setLiveActive(env.databasePath);
    let releaseGeoblock!: () => void;
    const waitForRelease = new Promise<void>((resolve) => { releaseGeoblock = resolve; });
    const gate = new LiveGateService(
      env.databasePath,
      new MockBalanceProvider({ status: "AVAILABLE", balanceMicros: "1000000000", reason: null, checkedAt: now, source: "TEST_FIXTURE" }),
      { ...defaultLiveGateConfig(), runtimeEnvironment: "TEST" },
      {
        sourceVersion,
        now: () => new Date(now),
        geoblockProvider: {
          providerType: "FAKE",
          async check() {
            await waitForRelease;
            return { status: "ALLOWED", checkedAt: now, source: "TEST_FIXTURE", reason: null };
          },
        },
        clockProvider: new FakeClockSafetyProvider({ status: "SAFE", offsetMs: 0, checkedAt: now, source: "TEST_FIXTURE", reason: null }),
      },
    );
    const pending = gate.checkExecution(executionInput("concurrent-disable", "risk-concurrent-disable"));
    await gate.emergencyDisable({ actor: "operator", reason: "concurrent emergency" });
    releaseGeoblock();
    const result = await pending;
    expect(result.allowed).toBe(false);
    expect(result.blockedReasons).toContain("NOT_LIVE_ACTIVE:PAPER:LIVE_DISABLED");
    gate.close();
  });

  it("validates Risk Decision mode, account, context and approved BUY amount", async () => {
    const env = setup();
    const inserted = insertSignalAndRisk(env.databasePath, env.targetId, {
      signalId: "risk-metadata",
      riskDecisionId: "risk-metadata",
      decision: "ALLOW",
    });
    insertPaperRiskDecision(env.databasePath, "risk-metadata", "risk-metadata-paper", inserted.contextId);
    insertSignalAndRisk(env.databasePath, env.targetId, {
      signalId: "risk-no-amount",
      riskDecisionId: "risk-no-amount",
      decision: "ALLOW",
      requestedAmountMicros: null,
    });
    setLiveActive(env.databasePath);
    const gate = service(env.databasePath);

    expect((await gate.checkExecution(executionInput("risk-metadata", "risk-metadata-paper"))).blockedReasons)
      .toContain("RISK_EXECUTOR_MODE_MISMATCH");

    expect((await gate.checkExecution(executionInput("risk-metadata", "risk-metadata", { accountId: "wrong-live-account" }))).blockedReasons)
      .toContain("RISK_ACCOUNT_MISMATCH");

    expect((await gate.checkExecution(executionInput("risk-metadata", "risk-metadata", { contextId: "wrong-context" }))).blockedReasons)
      .toContain("RISK_CONTEXT_MISMATCH");

    expect((await gate.checkExecution(executionInput("risk-no-amount", "risk-no-amount"))).blockedReasons)
      .toContain("RISK_APPROVED_BUY_AMOUNT_INVALID");
    gate.close();
  });

  it("requires a positive approved size for SELL", async () => {
    const env = setup();
    insertSignalAndRisk(env.databasePath, env.targetId, {
      signalId: "risk-sell-size",
      riskDecisionId: "risk-sell-size",
      decision: "ALLOW",
      signalType: "TARGET_SELL",
      requestedAmountMicros: null,
      requestedSizeMicros: null,
    });
    setLiveActive(env.databasePath);
    const gate = service(env.databasePath);
    const result = await gate.checkExecution(executionInput("risk-sell-size", "risk-sell-size", { side: "SELL" }));
    expect(result.blockedReasons).toContain("RISK_APPROVED_SELL_SIZE_INVALID");
    gate.close();
  });

  it("rejects caller Signal fields that differ from the database canonical Signal", async () => {
    const env = setup();
    insertSignalAndRisk(env.databasePath, env.targetId, { signalId: "canonical-signal", riskDecisionId: "risk-canonical", decision: "ALLOW" });
    setLiveActive(env.databasePath);
    const gate = service(env.databasePath);
    const cases: Array<{ override: Record<string, string>; reason: string }> = [
      { override: { side: "SELL" }, reason: "SIGNAL_SIDE_MISMATCH" },
      { override: { assetId: "tampered-asset" }, reason: "SIGNAL_ASSET_MISMATCH" },
      { override: { conditionId: "tampered-condition" }, reason: "SIGNAL_CONDITION_MISMATCH" },
      { override: { targetPriceUnits: "1" }, reason: "SIGNAL_PRICE_MISMATCH" },
      { override: { targetSizeMicros: "1" }, reason: "SIGNAL_SIZE_MISMATCH" },
    ];
    for (const testCase of cases) {
      const result = await gate.checkExecution(executionInput(
        "canonical-signal",
        "risk-canonical",
        testCase.override,
      ));
      expect(result.blockedReasons).toContain(testCase.reason);
    }
    gate.close();
  });

  it("blocks on exposure recorded in live_positions", async () => {
    const env = setup();
    insertSignalAndRisk(env.databasePath, env.targetId, { signalId: "live-exposure", riskDecisionId: "risk-live-exposure", decision: "ALLOW" });
    insertLivePosition(env.databasePath, {
      signalId: "live-exposure",
      riskDecisionId: "risk-live-exposure",
      remainingCostMicros: "600000000",
    });
    setLiveActive(env.databasePath);
    const gate = service(env.databasePath);
    const result = await gate.checkExecution(executionInput("live-exposure", "risk-live-exposure"));
    expect(result.blockedReasons).toContain("LIVE_EXPOSURE_LIMIT_EXCEEDED");
    gate.close();
  });

  it("blocks on daily loss recorded in live_pnl_ledger", async () => {
    const env = setup();
    insertSignalAndRisk(env.databasePath, env.targetId, { signalId: "live-loss", riskDecisionId: "risk-live-loss", decision: "ALLOW" });
    const seeded = insertLivePosition(env.databasePath, {
      signalId: "live-loss",
      riskDecisionId: "risk-live-loss",
      remainingCostMicros: "1",
      realizedPnlMicros: "-60000000",
    });
    const db = new DatabaseSync(env.databasePath);
    db.prepare(
      `INSERT INTO live_pnl_ledger(
        pnl_ledger_id,live_account_id,live_position_id,live_execution_id,pnl_type,proceeds_micros,
        cost_basis_micros,fee_micros,pnl_micros,price_source,price_timestamp,ruleset_hash,
        source_code_commit,source_code_dirty,config_version,idempotency_key,created_at
      ) VALUES ('pnl-live-loss', ?, ?, ?, 'REALIZED', '0', '50000000', '0', '-50000000',
        'CLOB_FILL', ?, ?, ?, 0, ?, 'pnl-idem-live-loss', ?)`,
    ).run(
      liveAccountId,
      seeded.positionId,
      seeded.executionId,
      "2026-07-09T00:00:00.000Z",
      RULESET_HASH,
      sourceVersion.commit,
      VERSIONS.configVersion,
      "2026-07-09T00:00:00.000Z",
    );
    db.close();
    setLiveActive(env.databasePath);
    const gate = service(env.databasePath);
    const result = await gate.checkExecution(executionInput("live-loss", "risk-live-loss"));
    expect(result.blockedReasons).toContain("LIVE_DAILY_LOSS_LIMIT_EXCEEDED");
    gate.close();
  });

  it("blocks after five consecutive losing Live executions", async () => {
    const env = setup();
    insertSignalAndRisk(env.databasePath, env.targetId, {
      signalId: "live-consecutive-gate",
      riskDecisionId: "risk-live-consecutive-gate",
      decision: "ALLOW",
    });
    for (let sequence = 1; sequence <= 5; sequence += 1) {
      const signalId = `loss-history-${sequence}`;
      const riskDecisionId = `risk-loss-history-${sequence}`;
      insertSignalAndRisk(env.databasePath, env.targetId, { signalId, riskDecisionId, decision: "ALLOW" });
      const seeded = insertLivePosition(env.databasePath, {
        signalId,
        riskDecisionId,
        remainingCostMicros: "1",
        realizedPnlMicros: "-1",
      });
      const writer = new DatabaseSync(env.databasePath);
      const timestamp = `2026-07-09T00:00:0${sequence}.000Z`;
      writer.prepare(
        `INSERT INTO live_pnl_ledger(
          pnl_ledger_id,live_account_id,live_position_id,live_execution_id,pnl_type,proceeds_micros,
          cost_basis_micros,fee_micros,pnl_micros,price_source,price_timestamp,ruleset_hash,
          source_code_commit,source_code_dirty,config_version,idempotency_key,created_at
        ) VALUES (?, ?, ?, ?, 'REALIZED', '0', '1', '0', '-1', 'CLOB_FILL', ?, ?, ?, 0, ?, ?, ?)`,
      ).run(
        `pnl-loss-history-${sequence}`,
        liveAccountId,
        seeded.positionId,
        seeded.executionId,
        timestamp,
        RULESET_HASH,
        sourceVersion.commit,
        VERSIONS.configVersion,
        `pnl-loss-history-idem-${sequence}`,
        timestamp,
      );
      writer.close();
    }
    setLiveActive(env.databasePath);
    const gate = service(env.databasePath);
    const result = await gate.checkExecution(executionInput("live-consecutive-gate", "risk-live-consecutive-gate"));
    expect(result.blockedReasons).toContain("LIVE_CONSECUTIVE_LOSS_LIMIT_EXCEEDED");
    gate.close();
  });

  it("downgrades LIVE_ACTIVE to LIVE_ARMING on startup recovery", async () => {
    const env = setup();
    passPrerequisites(env.databasePath);
    insertWallet(env.databasePath);
    setLiveActive(env.databasePath);
    const gate = service(env.databasePath);
    await gate.recoverOnStartup();
    expect(state(env.databasePath)).toEqual({ execution_mode: "PAPER", live_gate_state: "LIVE_ARMING" });
    gate.close();
  });

  it("moves to ARMING after successful preflight and only ACTIVE after confirmation", async () => {
    const env = setup();
    passPrerequisites(env.databasePath);
    insertWallet(env.databasePath);
    insertSignalAndRisk(env.databasePath, env.targetId, {
      signalId: "pre-activation-boundary",
      riskDecisionId: "risk-pre-activation-boundary",
      decision: "ALLOW",
    });
    const gate = service(env.databasePath);
    const request = await gate.requestLiveActivation({ actor: "operator", reason: "test" });
    expect(request.allowed).toBe(true);
    expect(state(env.databasePath)).toEqual({ execution_mode: "PAPER", live_gate_state: "LIVE_ARMING" });
    const confirm = await gate.confirmLiveActivation({ actor: "operator", confirmationText });
    expect(confirm.allowed).toBe(true);
    expect(state(env.databasePath)).toEqual({ execution_mode: "LIVE", live_gate_state: "LIVE_ACTIVE" });
    const db = new DatabaseSync(env.databasePath);
    const activation = db.prepare(
      `SELECT signal_boundary_sequence FROM live_gate_state_transitions
       WHERE to_execution_mode='LIVE' AND to_live_gate_state='LIVE_ACTIVE'
       ORDER BY rowid DESC LIMIT 1`,
    ).get() as { signal_boundary_sequence: number };
    const before = db.prepare(
      "SELECT signal_sequence FROM signal_ingest_sequences WHERE signal_id='pre-activation-boundary'",
    ).get() as { signal_sequence: number };
    expect(activation.signal_boundary_sequence).toBe(before.signal_sequence);
    db.close();
    gate.close();
  });

  it("requires the exact activation phrase and reruns full preflight at confirmation", async () => {
    const env = setup();
    passPrerequisites(env.databasePath);
    insertWallet(env.databasePath);
    insertLiveAccount(env.databasePath);
    const gate = service(env.databasePath);
    expect((await gate.requestLiveActivation({ actor: "operator", reason: "test" })).allowed).toBe(true);

    const wrongPhrase = await gate.confirmLiveActivation({ actor: "operator", confirmationText: ` ${confirmationText} ` });
    expect(wrongPhrase.allowed).toBe(false);
    expect(wrongPhrase.blockedReasons).toContain("CONFIRMATION_TEXT_MISMATCH");
    expect(state(env.databasePath)).toEqual({ execution_mode: "PAPER", live_gate_state: "LIVE_ARMING" });

    const db = new DatabaseSync(env.databasePath);
    db.prepare("UPDATE live_gate_prerequisites SET status='FAILED' WHERE prerequisite_key='PAPER_STABILITY'").run();
    db.close();
    const changedPrerequisite = await gate.confirmLiveActivation({ actor: "operator", confirmationText });
    expect(changedPrerequisite.allowed).toBe(false);
    expect(changedPrerequisite.blockedReasons).toContain("PREREQUISITE_FAILED:PAPER_STABILITY");
    expect(state(env.databasePath)).toEqual({ execution_mode: "PAPER", live_gate_state: "LIVE_ARMING" });
    gate.close();
  });

  it("does not overwrite an emergency disable that occurs while activation preflight is in flight", async () => {
    const env = setup();
    passPrerequisites(env.databasePath);
    insertWallet(env.databasePath);
    insertLiveAccount(env.databasePath);
    let releaseGeoblock!: () => void;
    const waitForRelease = new Promise<void>((resolve) => { releaseGeoblock = resolve; });
    const gate = new LiveGateService(
      env.databasePath,
      new MockBalanceProvider({ status: "AVAILABLE", balanceMicros: "1000000000", reason: null, checkedAt: now, source: "TEST_FIXTURE" }),
      { ...defaultLiveGateConfig(), runtimeEnvironment: "TEST" },
      {
        sourceVersion,
        now: () => new Date(now),
        geoblockProvider: {
          providerType: "FAKE",
          async check() {
            await waitForRelease;
            return { status: "ALLOWED", checkedAt: now, source: "TEST_FIXTURE", reason: null };
          },
        },
        clockProvider: new FakeClockSafetyProvider({ status: "SAFE", offsetMs: 0, checkedAt: now, source: "TEST_FIXTURE", reason: null }),
      },
    );
    const pending = gate.requestLiveActivation({ actor: "operator", reason: "test" });
    await gate.emergencyDisable({ actor: "operator", reason: "concurrent emergency" });
    releaseGeoblock();
    const result = await pending;
    expect(result.allowed).toBe(false);
    expect(result.blockedReasons).toContain("ACTIVATION_STATE_CHANGED_DURING_PREFLIGHT");
    expect(state(env.databasePath)).toEqual({ execution_mode: "PAPER", live_gate_state: "LIVE_DISABLED" });
    gate.close();
  });

  it("does not overwrite an emergency disable that occurs while confirmation checks are in flight", async () => {
    const env = setup();
    passPrerequisites(env.databasePath);
    insertWallet(env.databasePath);
    insertLiveAccount(env.databasePath);
    let geoblockCalls = 0;
    let releaseConfirmation!: () => void;
    const waitForConfirmationRelease = new Promise<void>((resolve) => { releaseConfirmation = resolve; });
    const gate = new LiveGateService(
      env.databasePath,
      new MockBalanceProvider({ status: "AVAILABLE", balanceMicros: "1000000000", reason: null, checkedAt: now, source: "TEST_FIXTURE" }),
      { ...defaultLiveGateConfig(), runtimeEnvironment: "TEST" },
      {
        sourceVersion,
        now: () => new Date(now),
        geoblockProvider: {
          providerType: "FAKE",
          async check() {
            geoblockCalls += 1;
            if (geoblockCalls === 2) await waitForConfirmationRelease;
            return { status: "ALLOWED", checkedAt: now, source: "TEST_FIXTURE", reason: null };
          },
        },
        clockProvider: new FakeClockSafetyProvider({ status: "SAFE", offsetMs: 0, checkedAt: now, source: "TEST_FIXTURE", reason: null }),
      },
    );
    expect((await gate.requestLiveActivation({ actor: "operator", reason: "test" })).allowed).toBe(true);
    const pending = gate.confirmLiveActivation({ actor: "operator", confirmationText });
    await gate.emergencyDisable({ actor: "operator", reason: "concurrent emergency" });
    releaseConfirmation();
    const result = await pending;
    expect(result.allowed).toBe(false);
    expect(result.blockedReasons).toContain("CONFIRMATION_STATE_CHANGED_DURING_PREFLIGHT");
    expect(state(env.databasePath)).toEqual({ execution_mode: "PAPER", live_gate_state: "LIVE_DISABLED" });
    gate.close();
  });

  it("binds confirmation to the arming preflight and rejects stale or superseded runs", async () => {
    const env = setup();
    passPrerequisites(env.databasePath);
    insertWallet(env.databasePath);
    insertLiveAccount(env.databasePath);
    const gate = service(env.databasePath);
    expect((await gate.requestLiveActivation({ actor: "operator", reason: "test" })).allowed).toBe(true);

    const db = new DatabaseSync(env.databasePath);
    db.prepare("UPDATE live_gate_runs SET created_at='2026-07-08T00:00:00.000Z' WHERE live_gate_run_id=(SELECT last_preflight_id FROM live_gate_state WHERE state_id='default')").run();
    db.close();
    const stale = await gate.confirmLiveActivation({ actor: "operator", confirmationText });
    expect(stale.blockedReasons).toContain("ARMING_PREFLIGHT_STALE");
    gate.close();
  });

  it("rejects confirmation when a newer allowed preflight supersedes the arming run", async () => {
    const env = setup();
    passPrerequisites(env.databasePath);
    insertWallet(env.databasePath);
    insertLiveAccount(env.databasePath);
    const gate = service(env.databasePath);
    expect((await gate.requestLiveActivation({ actor: "operator", reason: "test" })).allowed).toBe(true);
    expect((await gate.preflight({ requestedExecutionMode: "LIVE" })).allowed).toBe(true);
    const result = await gate.confirmLiveActivation({ actor: "operator", confirmationText });
    expect(result.blockedReasons).toContain("ARMING_PREFLIGHT_SUPERSEDED");
    expect(state(env.databasePath)).toEqual({ execution_mode: "PAPER", live_gate_state: "LIVE_ARMING" });
    gate.close();
  });

  it("emergency disables Live Gate and writes audit actions", async () => {
    const env = setup();
    passPrerequisites(env.databasePath);
    insertWallet(env.databasePath);
    setLiveActive(env.databasePath);
    const gate = service(env.databasePath);
    await gate.emergencyDisable({ actor: "operator", reason: "test emergency" });
    expect(state(env.databasePath)).toEqual({ execution_mode: "PAPER", live_gate_state: "LIVE_DISABLED" });
    const db = new DatabaseSync(env.databasePath, { readOnly: true });
    const actions = (db.prepare("SELECT action FROM audit_log WHERE entity_type='LIVE_GATE'").all() as Array<{ action: string }>)
      .map((row) => row.action);
    expect(actions).toContain("emergency_disable");
    db.close();
    gate.close();
  });

  it("creates risk snapshots and keeps live_wallets metadata-only", async () => {
    const env = setup();
    passPrerequisites(env.databasePath);
    insertWallet(env.databasePath);
    const gate = service(env.databasePath);
    await gate.preflight({ requestedExecutionMode: "LIVE" });
    const db = new DatabaseSync(env.databasePath, { readOnly: true });
    expect((db.prepare("SELECT count(*) count FROM risk_snapshots").get() as { count: number }).count).toBe(1);
    const columns = (db.prepare("PRAGMA table_info(live_wallets)").all() as Array<{ name: string }>).map((row) => row.name);
    expect(columns).not.toContain("private_key");
    expect(columns).not.toContain("seed_phrase");
    expect(columns).not.toContain("signer");
    expect(columns).not.toContain("transaction_capability");
    db.close();
    gate.close();
  });
});

describe("phase 3 Live handoff and reconciliation", () => {
  it("hands off only a disabled, quiescent Live account", () => {
    const env = setup();
    insertLiveAccount(env.databasePath);
    const database = new DatabaseSync(env.databasePath);
    database.prepare(
      "UPDATE live_accounts SET status='DISABLED',updated_at=? WHERE live_account_id=?",
    ).run(now, liveAccountId);
    const registry = new LiveAccountRegistry(database, sourceVersion, () => new Date(now));
    expect(registry.handoffRuntime({
      liveAccountId,
      actor: "TEST",
      reason: "RUNTIME_REPLACEMENT",
    }).status).toBe("DISABLED");
    expect(database.prepare(
      `SELECT action FROM audit_log
       WHERE entity_type='LIVE_ACCOUNT' AND entity_id=? AND action='runtime_handoff'`,
    ).get(liveAccountId)).toEqual({ action: "runtime_handoff" });
    database.close();
  });

  it("fails the Gate reconciliation projection on negative Live expected cash", () => {
    const env = setup();
    insertLiveAccount(env.databasePath);
    const database = new DatabaseSync(env.databasePath);
    database.prepare(
      `INSERT INTO live_cash_ledger(
        cash_ledger_id,live_account_id,live_execution_id,entry_type,cash_delta_micros,
        reserved_delta_micros,cash_after_micros,reserved_after_micros,idempotency_key,created_at
      ) VALUES ('live-gate-cash',?,?, 'TEST','-1000000001','0',NULL,NULL,'live-gate-cash-key',?)`,
    ).run(liveAccountId, null, now);
    expect(new LiveGateReconciliation(database).check()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "live_reconciliation_cash_ledger", passed: false }),
    ]));
    database.close();
  });

  it("fails closed when compliance evidence is blocked or unavailable", async () => {
    const env = setup();
    insertLiveAccount(env.databasePath);
    const gate = new LiveGateService(
      env.databasePath,
      new MockBalanceProvider({
        status: "AVAILABLE",
        balanceMicros: "1000000000",
        reason: null,
        checkedAt: now,
        source: "TEST_FIXTURE",
      }),
      { ...defaultLiveGateConfig(), runtimeEnvironment: "TEST" },
      {
        sourceVersion,
        now: () => new Date(now),
        geoblockProvider: new FakeGeoblockProvider({
          status: "ALLOWED",
          checkedAt: now,
          source: "TEST_FIXTURE",
          reason: null,
        }),
        complianceProvider: new FakeComplianceProvider({
          status: "BLOCKED",
          checkedAt: now,
          source: "TEST_COMPLIANCE",
          policyVersion: "policy-1",
          reason: "JURISDICTION_BLOCKED",
        }),
        clockProvider: new FakeClockSafetyProvider({
          status: "SAFE",
          offsetMs: 0,
          checkedAt: now,
          source: "TEST_FIXTURE",
          reason: null,
        }),
      },
    );
    const result = await gate.preflight({ requestedExecutionMode: "LIVE" });
    expect(result.blockedReasons).toContain("JURISDICTION_BLOCKED");
    gate.close();
  });

  it("evaluates a configured read-only compliance policy without credentials", async () => {
    const provider = new ConfiguredComplianceProvider({
      policyVersion: "policy-1",
      source: "LOCAL_POLICY",
      checkedAt: now,
      allowedNetworks: ["POLYGON"],
      allowedWalletTypes: ["EOA"],
      allowedWalletAddresses: [wallet],
    });
    await expect(provider.check({
      walletAddress: wallet,
      walletType: "EOA",
      network: "POLYGON",
      authorizedSignerAddress: wallet,
    })).resolves.toMatchObject({ status: "ALLOWED", policyVersion: "policy-1" });
    await expect(provider.check({
      walletAddress: "0x0000000000000000000000000000000000000002",
      walletType: "EOA",
      network: "POLYGON",
      authorizedSignerAddress: "0x0000000000000000000000000000000000000002",
    })).resolves.toMatchObject({ status: "BLOCKED", reason: "COMPLIANCE_POLICY_REJECTED" });
  });
});

describe("official readonly Live safety providers", () => {
  it("validates the official geoblock response and sends no authentication", async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const provider = new OfficialGeoblockProvider({
      now: () => new Date(now),
      fetchImpl: async (input, init) => {
        requests.push({ url: String(input), init });
        return new Response(JSON.stringify({ blocked: false, ip: "203.0.113.42", country: "IE", region: "D" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    const result = await provider.check({ walletAddress: wallet, network: "POLYGON" });
    expect(result).toMatchObject({
      status: "ALLOWED",
      checkedAt: now,
      ip: "203.0.113.42",
      country: "IE",
      region: "D",
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://polymarket.com/api/geoblock");
    expect(requests[0]?.init?.method).toBe("GET");
    expect(JSON.stringify(requests[0]?.init?.headers).toLowerCase()).not.toContain("authorization");
  });

  it("fails geoblock closed for blocked, malformed, HTTP and network responses", async () => {
    const blocked = new OfficialGeoblockProvider({
      fetchImpl: async () => new Response(JSON.stringify({ blocked: true, ip: "203.0.113.42", country: "US", region: "NY" })),
    });
    expect(await blocked.check({ walletAddress: wallet, network: "POLYGON" })).toMatchObject({
      status: "BLOCKED",
      reason: "GEOBLOCK_BLOCKED:US:NY",
    });

    const malformed = new OfficialGeoblockProvider({
      fetchImpl: async () => new Response(JSON.stringify({ blocked: false, ip: "not-an-ip", country: "ireland", region: 1 })),
    });
    expect((await malformed.check({ walletAddress: wallet, network: "POLYGON" })).reason).toBe("GEOBLOCK_RESPONSE_INVALID");

    const httpFailure = new OfficialGeoblockProvider({ fetchImpl: async () => new Response("down", { status: 503 }) });
    expect((await httpFailure.check({ walletAddress: wallet, network: "POLYGON" })).reason).toBe("GEOBLOCK_HTTP_503");

    const networkFailure = new OfficialGeoblockProvider({ fetchImpl: async () => { throw new Error("offline"); } });
    expect((await networkFailure.check({ walletAddress: wallet, network: "POLYGON" })).reason).toBe("GEOBLOCK_REQUEST_FAILED");
  });

  it("retries a transient official geoblock request failure before failing closed", async () => {
    let attempts = 0;
    const provider = new OfficialGeoblockProvider({
      fetchImpl: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("temporary network failure");
        return new Response(JSON.stringify({
          blocked: false,
          ip: "203.0.113.42",
          country: "IE",
          region: "D",
        }));
      },
    });
    await expect(provider.check({ walletAddress: wallet, network: "POLYGON" })).resolves.toMatchObject({
      status: "ALLOWED",
      country: "IE",
    });
    expect(attempts).toBe(2);
  });

  it("computes CLOB clock offset from the RTT midpoint without authentication", async () => {
    const times = [1_000_000, 1_000_200];
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const provider = new ClobClockSafetyProvider({
      nowMs: () => times.shift() as number,
      fetchImpl: async (input, init) => {
        requests.push({ url: String(input), init });
        return new Response("1000", { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    const result = await provider.check();
    expect(result).toMatchObject({ status: "SAFE", offsetMs: -100, source: "https://clob.polymarket.com/time" });
    expect(requests[0]?.url).toBe("https://clob.polymarket.com/time");
    expect(requests[0]?.init?.method).toBe("GET");
    expect(JSON.stringify(requests[0]?.init?.headers).toLowerCase()).not.toContain("authorization");
  });

  it("retries a transient CLOB clock request failure", async () => {
    let attempts = 0;
    const provider = new ClobClockSafetyProvider({
      nowMs: () => 1_000_000,
      fetchImpl: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("temporary network failure");
        return new Response("1000");
      },
    });
    await expect(provider.check()).resolves.toMatchObject({ status: "SAFE" });
    expect(attempts).toBe(2);
  });

  it("records local clock offset but only fails closed when official CLOB time is not trustworthy", async () => {
    const unsafeTimes = [1_000_000, 1_000_100];
    const unsafe = new ClobClockSafetyProvider({
      nowMs: () => unsafeTimes.shift() as number,
      fetchImpl: async () => new Response("1010"),
    });
    expect(await unsafe.check()).toMatchObject({
      status: "SAFE",
      reason: "CLOCK_OFFSET_OBSERVED_USING_SERVER_TIME",
    });

    const slowTimes = [1_000_000, 1_003_000];
    const slow = new ClobClockSafetyProvider({
      nowMs: () => slowTimes.shift() as number,
      maxRttMs: 2_000,
      fetchImpl: async () => new Response("1000"),
    });
    expect((await slow.check()).reason).toBe("CLOCK_RTT_UNSAFE");

    const malformedTimes = [1_000_000, 1_000_100];
    const malformed = new ClobClockSafetyProvider({
      nowMs: () => malformedTimes.shift() as number,
      fetchImpl: async () => new Response("not-a-timestamp"),
    });
    expect((await malformed.check()).reason).toBe("CLOCK_RESPONSE_INVALID");

    const network = new ClobClockSafetyProvider({
      nowMs: () => 1_000_000,
      fetchImpl: async () => { throw new Error("offline"); },
    });
    expect((await network.check()).reason).toBe("CLOCK_REQUEST_FAILED");
  });

  it("accepts a valid official CLOB time response that completes within the request timeout", async () => {
    const times = [1_000_000, 1_008_000];
    const provider = new ClobClockSafetyProvider({
      nowMs: () => times.shift() as number,
      maxAttempts: 1,
      timeoutMs: 10_000,
      fetchImpl: async () => new Response("1004"),
    });

    await expect(provider.check()).resolves.toMatchObject({
      status: "SAFE",
      offsetMs: 0,
      reason: null,
    });
  });
});
