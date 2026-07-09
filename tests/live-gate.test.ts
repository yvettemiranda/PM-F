import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { RULESET_HASH, RULESET_SNAPSHOT_JSON, VERSIONS } from "../src/domain/versioning.js";
import { Phase0Database } from "../src/infra/sqlite/database.js";
import type { SourceVersion } from "../src/infra/source-version.js";
import { LiveGateService, defaultLiveGateConfig } from "../src/live/live-gate-service.js";
import { MockBalanceProvider } from "../src/live/mock-balance-provider.js";

const directories: string[] = [];
const sourceVersion: SourceVersion = { commit: "live-gate-test", dirty: false };
const wallet = "0x0000000000000000000000000000000000000001";
const conditionId = `0x${"2".repeat(64)}`;
const assetId = "asset-live";

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
    new MockBalanceProvider({ status: "AVAILABLE", balanceMicros, reason: null }),
    config,
    { sourceVersion, now: () => new Date("2026-07-09T00:00:00.000Z") },
  );
}

function passPrerequisites(databasePath: string): void {
  const db = new DatabaseSync(databasePath);
  db.prepare("UPDATE live_gate_prerequisites SET status='PASSED',evidence_json='{}',updated_at=?")
    .run("2026-07-09T00:00:00.000Z");
  db.close();
}

function insertWallet(databasePath: string, address = wallet): void {
  const db = new DatabaseSync(databasePath);
  db.prepare(
    `INSERT INTO live_wallets(
      live_wallet_id,wallet_address,wallet_type,network,status,created_at,updated_at
    ) VALUES ('wallet-live', ?, 'EOA', 'POLYGON', 'ACTIVE', ?, ?)`,
  ).run(address, "2026-07-09T00:00:00.000Z", "2026-07-09T00:00:00.000Z");
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
  marketEndTime?: string;
}) {
  const db = new DatabaseSync(databasePath);
  db.exec("PRAGMA foreign_keys=ON");
  const sourceKey = `source-${input.signalId}`;
  const createdAt = "2026-07-09T00:00:00.000Z";
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
      signal_id,signal_idempotency_key,source_event_key,signal_type,status,asset_id,
      condition_id,target_price_units,target_size_micros,sell_ratio_numerator,
      sell_ratio_denominator,reason,schema_version,signal_version,strategy_version,
      risk_version,replay_version,ruleset_snapshot_json,ruleset_hash,source_code_commit,
      created_at,execution_eligible,execution_block_reason,event_classification,
      capital_estimate_id,source_code_dirty,producer_mode
    ) VALUES (?, ?, ?, 'TARGET_BUY', 'PUBLISHED', ?, ?, '500000000000000000',
      '10000000', NULL, NULL, 'TEST', ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL,
      'STANDARD_TRADE', NULL, 0, 'OBSERVE_ONLY')`,
  ).run(
    input.signalId,
    `idem-${input.signalId}`,
    sourceKey,
    assetId,
    conditionId,
    VERSIONS.schemaVersion,
    VERSIONS.signalVersion,
    VERSIONS.strategyVersion,
    VERSIONS.riskVersion,
    VERSIONS.replayVersion,
    RULESET_SNAPSHOT_JSON,
    RULESET_HASH,
    sourceVersion.commit,
    createdAt,
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
    createdAt,
    input.marketEndTime ?? "2026-07-10T00:00:00.000Z",
    `metadata-${input.signalId}`,
    RULESET_HASH,
    VERSIONS.schemaVersion,
    VERSIONS.signalVersion,
    VERSIONS.strategyVersion,
    sourceVersion.commit,
    VERSIONS.configVersion,
    createdAt,
  );
  db.prepare(
    `INSERT INTO risk_decisions(
      risk_decision_id,executor_mode,paper_account_id,signal_id,context_id,decision,
      risk_reject_reason,requested_amount_micros,requested_size_micros,checks_json,
      schema_version,strategy_version,risk_version,ruleset_hash,source_code_commit,
      source_code_dirty,config_version,created_at,risk_reason
    ) VALUES (?, 'LIVE', NULL, ?, ?, ?, ?, NULL, NULL, '[]', ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
  ).run(
    input.riskDecisionId,
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
    createdAt,
    input.decision,
  );
  db.close();
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("LiveGateService", () => {
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

  it("rejects preflight when balance is below bankroll", async () => {
    const env = setup();
    passPrerequisites(env.databasePath);
    insertWallet(env.databasePath);
    const gate = service(env.databasePath, "999");
    const result = await gate.preflight({ requestedExecutionMode: "LIVE" });
    expect(result.allowed).toBe(false);
    expect(result.blockedReasons).toContain("BALANCE_BELOW_BANKROLL");
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

  it("blocks execution when Risk Decision is REJECT", async () => {
    const env = setup();
    passPrerequisites(env.databasePath);
    insertWallet(env.databasePath);
    insertSignalAndRisk(env.databasePath, env.targetId, { signalId: "reject-signal", riskDecisionId: "risk-reject", decision: "REJECT" });
    setLiveActive(env.databasePath);
    const gate = service(env.databasePath);
    const result = await gate.checkExecution({ signalId: "reject-signal", riskDecisionId: "risk-reject", rulesetHash: RULESET_HASH });
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
    const result = await gate.checkExecution({ signalId: "allow-signal", riskDecisionId: "risk-allow", rulesetHash: RULESET_HASH });
    expect(result.allowed).toBe(true);
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
    const gate = service(env.databasePath);
    const request = await gate.requestLiveActivation({ actor: "operator", reason: "test" });
    expect(request.allowed).toBe(true);
    expect(state(env.databasePath)).toEqual({ execution_mode: "PAPER", live_gate_state: "LIVE_ARMING" });
    const confirm = await gate.confirmLiveActivation({ actor: "operator", confirmationText: "I confirm live arming" });
    expect(confirm.allowed).toBe(true);
    expect(state(env.databasePath)).toEqual({ execution_mode: "LIVE", live_gate_state: "LIVE_ACTIVE" });
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
