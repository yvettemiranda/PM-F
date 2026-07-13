import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { ApiCapture } from "../src/adapters/polymarket-public.js";
import type { PublicPosition } from "../src/domain/models.js";
import { RULESET_HASH, RULESET_SNAPSHOT_JSON, VERSIONS } from "../src/domain/versioning.js";
import { Phase0Database } from "../src/infra/sqlite/database.js";
import type { SourceVersion } from "../src/infra/source-version.js";
import { ObserveOnlyRunner } from "../src/observe/observe-runner.js";
import { ObserveStore } from "../src/observe/observe-store.js";
import type { ObserveDataSource, ObservePollSnapshot } from "../src/observe/types.js";
import { LiveGateValidation } from "../src/validation/live-gate-validation.js";
import { ObserveOnlyValidation } from "../src/validation/observe-only-validation.js";
import { PaperConsistencyValidation } from "../src/validation/paper-consistency-validation.js";
import { PaperReplayValidation } from "../src/validation/paper-replay-validation.js";
import { prepareValidationDatabaseSnapshot } from "../src/validation/database-snapshot.js";
import { ReconciliationValidation } from "../src/validation/reconciliation-validation.js";
import { buildValidationReport } from "../src/validation/report-generator.js";
import { ValidationRunner } from "../src/validation/validation-runner.js";
import type { ValidationType } from "../src/validation/types.js";
import { buildCaptureManifest, captureIdentity } from "../src/services/capture-manifest.js";
import { buildPositionBaseline } from "../src/services/position-baseline.js";

const directories: string[] = [];
const sourceVersion: SourceVersion = { commit: "validation-test", dirty: false };
const now = () => new Date("2026-07-09T00:00:00.000Z");
const wallet = "0x0000000000000000000000000000000000000001";
const baselineTime = "2026-07-08T00:00:00.000Z";

function setup(prefix = "ni-k-validation-") {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  const databasePath = join(directory, "phase0.sqlite");
  const phase0 = new Phase0Database(databasePath, sourceVersion);
  phase0.initialize();
  phase0.close();
  return { directory, databasePath };
}

function count(databasePath: string, table: string): number {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  const row = database.prepare(`SELECT count(*) count FROM ${table}`).get() as { count: number };
  database.close();
  return row.count;
}

function capture<T>(endpoint: string, data: T, fetchedAt: string): ApiCapture<T> {
  return { url: `https://example.test/${endpoint}`, fetchedAt, latencyMs: 10, status: 200, data };
}

function position(size: string): PublicPosition {
  return {
    proxyWallet: wallet,
    asset: "asset-validation",
    conditionId: "0xcondition-validation",
    size,
    avgPrice: "0.5",
    currentValue: String(Number(size) * 0.5),
    title: "Validation market",
    slug: "validation-market",
    outcome: "Yes",
  };
}

function observeSnapshot(positions: PublicPosition[], fetchedAt: string): ObservePollSnapshot {
  return {
    trades: capture("trades", [], fetchedAt),
    activity: capture("activity", [], fetchedAt),
    positions: capture("positions", positions, fetchedAt),
    pUsdBalance: capture("balance", { jsonrpc: "2.0", id: 2, result: "0x0" }, fetchedAt),
  };
}

class QueueObserveSource implements ObserveDataSource {
  constructor(private readonly queue: ObservePollSnapshot[]) {}

  async poll(): Promise<ObservePollSnapshot> {
    const next = this.queue.shift();
    if (!next) throw new Error("Observe validation queue exhausted");
    return next;
  }
}

function prepareObserveBaseline(databasePath: string): void {
  const database = new Phase0Database(databasePath, sourceVersion);
  const targetId = database.ensureTarget(wallet, "IDENTITY_CONFIRMED");
  const positionsCapture = capture("positions", [position("100")], baselineTime);
  database.saveCapture("data-positions", positionsCapture);
  const manifest = buildCaptureManifest({
    walletAddress: wallet,
    sampleRole: "TARGET",
    purpose: "VALIDATION_OBSERVE_BASELINE",
    sourceVersion,
    sources: [{ endpoint: "data-positions", capture: positionsCapture, paginationStatus: "END_OF_DATA" }],
  });
  database.saveCaptureManifest(targetId, manifest);
  database.savePositionBaseline(buildPositionBaseline({
    captureRunId: manifest.captureRunId,
    targetId,
    walletAddress: wallet,
    positionCaptureId: captureIdentity(positionsCapture).captureId,
    fetchedAt: positionsCapture.fetchedAt,
    latencyMs: positionsCapture.latencyMs,
    positions: positionsCapture.data,
  }));
  database.close();
}

function insertPublishedSignal(databasePath: string): void {
  const database = new DatabaseSync(databasePath);
  const timestamp = now().toISOString();
  database.prepare(
    `INSERT INTO monitor_targets(
      target_id,wallet_address,identity_status,baseline_at,runtime_mode,sync_status,created_at,updated_at
    ) VALUES ('target-validation','0x0000000000000000000000000000000000000002',
      'IDENTITY_CONFIRMED', ?, 'OBSERVE_ONLY', 'SYNCED', ?, ?)`,
  ).run(timestamp, timestamp, timestamp);
  database.prepare(
    `INSERT INTO raw_events(
      source_event_key,target_id,identity_version,source_type,source_transaction_hash,
      source_timestamp,asset_id,condition_id,side,price_units,size_micros,gap_event,
      is_combo,raw_json,created_at,event_classification
    ) VALUES ('source-validation','target-validation','identity-v1','DATA_API_TRADE',
      '0xvalidation',1773014400,'asset-validation',?, 'BUY',
      '500000000000000000','10000000',0,0,'{}',?,'STANDARD_TRADE')`,
  ).run(`0x${"7".repeat(64)}`, timestamp);
  database.prepare(
    `INSERT INTO signals(
      signal_id,signal_idempotency_key,source_event_key,signal_type,status,asset_id,
      condition_id,target_price_units,target_size_micros,sell_ratio_numerator,
      sell_ratio_denominator,reason,schema_version,signal_version,strategy_version,
      risk_version,replay_version,ruleset_snapshot_json,ruleset_hash,source_code_commit,
      created_at,execution_eligible,execution_block_reason,event_classification,
      capital_estimate_id,source_code_dirty,producer_mode
    ) VALUES ('signal-validation','idem-validation','source-validation','TARGET_BUY',
      'PUBLISHED','asset-validation',?,'500000000000000000','10000000',NULL,NULL,
      'VALIDATION_TEST',?,?,?,?,?,?,?,?,?,1,NULL,'STANDARD_TRADE',NULL,0,'OBSERVE_ONLY')`,
  ).run(
    `0x${"7".repeat(64)}`,
    VERSIONS.schemaVersion,
    VERSIONS.signalVersion,
    VERSIONS.strategyVersion,
    VERSIONS.riskVersion,
    VERSIONS.replayVersion,
    RULESET_SNAPSHOT_JSON,
    RULESET_HASH,
    sourceVersion.commit,
    timestamp,
  );
  database.close();
}

function insertConsistentPaperAuditFixture(databasePath: string): void {
  insertPublishedSignal(databasePath);
  const database = new DatabaseSync(databasePath);
  const timestamp = now().toISOString();
  database.prepare(
    `INSERT INTO paper_accounts(
      paper_account_id,name,status,initial_balance_micros,cash_balance_micros,
      reserved_balance_micros,realized_pnl_micros,signal_cutoff_at,schema_version,
      strategy_version,risk_version,paper_version,ruleset_snapshot_json,ruleset_hash,
      source_code_commit,source_code_dirty,created_at,updated_at
    ) VALUES ('audit-paper','Audit','ACTIVE','1000','900','100','0',?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
  ).run(
    timestamp,
    VERSIONS.schemaVersion,
    VERSIONS.strategyVersion,
    VERSIONS.riskVersion,
    VERSIONS.paperVersion,
    RULESET_SNAPSHOT_JSON,
    RULESET_HASH,
    sourceVersion.commit,
    timestamp,
    timestamp,
  );
  const insertExecution = database.prepare(
    `INSERT INTO paper_executions(
      paper_execution_id,paper_account_id,signal_id,execution_idempotency_key,
      execution_type,state,asset_id,condition_id,requested_amount_micros,
      requested_size_micros,filled_size_micros,filled_notional_micros,fee_micros,
      target_price_units,price_limit_lower_units,price_limit_upper_units,capital_mode,
      deadline_at,attempt_count,reason,context_id,schema_version,strategy_version,
      risk_version,paper_version,ruleset_hash,created_at,updated_at
    ) VALUES (?, 'audit-paper', 'signal-validation', ?, 'TARGET_BUY', ?, 'asset-audit',
      'condition-audit', ?, ?, ?, ?, ?, NULL, NULL, NULL, 'FIXED_FALLBACK',
      NULL, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insertExecution.run(
    "execution-filled",
    "execution-idem-filled",
    "EXECUTED",
    "100",
    null,
    "200",
    "95",
    "5",
    1,
    "FILLED",
    VERSIONS.schemaVersion,
    VERSIONS.strategyVersion,
    VERSIONS.riskVersion,
    VERSIONS.paperVersion,
    RULESET_HASH,
    timestamp,
    timestamp,
  );
  database.prepare(
    `INSERT INTO paper_positions(
      paper_position_id,paper_account_id,opening_execution_id,signal_id,asset_id,
      condition_id,outcome,entry_price_units,entry_size_micros,entry_notional_micros,
      entry_fee_micros,current_size_micros,remaining_cost_micros,stop_loss_price_units,
      status,frozen_from_status,frozen_reason,frozen_at,realized_pnl_micros,ruleset_hash,
      source_code_commit,source_code_dirty,config_version,created_at,updated_at
    ) VALUES ('position-audit','audit-paper','execution-filled','signal-validation','asset-audit',
      'condition-audit','Yes','475000000000000000','200','95','5','200','100',
      '237500000000000000','OPEN',NULL,NULL,NULL,'0',?,?,0,?,?,?)`,
  ).run(RULESET_HASH, sourceVersion.commit, VERSIONS.configVersion, timestamp, timestamp);
  insertExecution.run(
    "execution-reserved",
    "execution-idem-reserved",
    "WAITING_EXECUTION",
    "100",
    null,
    "0",
    "0",
    "0",
    0,
    "BUY_RESERVED",
    VERSIONS.schemaVersion,
    VERSIONS.strategyVersion,
    VERSIONS.riskVersion,
    VERSIONS.paperVersion,
    RULESET_HASH,
    timestamp,
    timestamp,
  );
  database.prepare(
    `INSERT INTO paper_reservations(
      reservation_id,paper_account_id,paper_execution_id,original_amount_micros,
      remaining_amount_micros,status,created_at,updated_at
    ) VALUES ('reservation-audit','audit-paper','execution-reserved','100','100','ACTIVE',?,?)`,
  ).run(timestamp, timestamp);
  database.prepare(
    `INSERT INTO paper_reservation_ledger(
      reservation_ledger_id,reservation_id,paper_execution_id,entry_type,delta_micros,
      remaining_after_micros,idempotency_key,created_at
    ) VALUES ('reservation-ledger-audit','reservation-audit','execution-reserved',
      'RESERVE','100','100','reservation-ledger-idem',?)`,
  ).run(timestamp);
  const insertCash = database.prepare(
    `INSERT INTO paper_cash_ledger(
      cash_ledger_id,paper_account_id,paper_execution_id,entry_type,cash_delta_micros,
      reserved_delta_micros,cash_after_micros,reserved_after_micros,idempotency_key,created_at
    ) VALUES (?, 'audit-paper', ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insertCash.run("cash-initial", null, "INITIAL_DEPOSIT", "1000", "0", "1000", "0", "cash-idem-initial", timestamp);
  insertCash.run("cash-fill", "execution-filled", "BUY_FILL", "-100", "0", "900", "0", "cash-idem-fill", timestamp);
  insertCash.run("cash-reserve", "execution-reserved", "RESERVE", "0", "100", "900", "100", "cash-idem-reserve", timestamp);
  database.prepare(
    `INSERT INTO paper_orderbook_snapshots(
      orderbook_snapshot_id,asset_id,condition_id,market_snapshot_time,received_at,
      data_age_ms,payload_hash,bids_json,asks_json,source_url,created_at
    ) VALUES ('book-audit','asset-audit','condition-audit',?,?,0,'book-hash','[]','[]','fake://book',?)`,
  ).run(timestamp, timestamp, timestamp);
  database.prepare(
    `INSERT INTO paper_fee_snapshots(
      fee_snapshot_id,asset_id,fee_rate_ppm,base_fee,fee_exponent,status,
      source_url,snapshot_time,created_at
    ) VALUES ('fee-audit','asset-audit','1000',1,1,'AVAILABLE','fake://fee',?,?)`,
  ).run(timestamp, timestamp);
  database.prepare(
    `INSERT INTO paper_orders(
      paper_order_id,paper_execution_id,attempt_sequence,side,order_type,state,
      requested_size_micros,requested_amount_micros,filled_size_micros,
      filled_notional_micros,vwap_price_units,fee_micros,reject_reason,
      orderbook_snapshot_id,fee_snapshot_id,created_at
    ) VALUES ('order-audit','execution-filled',1,'BUY','FAK','FILLED','200','100',
      '200','95','475000000000000000','5',NULL,'book-audit','fee-audit',?)`,
  ).run(timestamp);
  const insertFill = database.prepare(
    `INSERT INTO paper_fill_ledger(
      fill_id,paper_order_id,paper_execution_id,paper_position_id,side,price_units,
      size_micros,notional_micros,fee_micros,level_sequence,created_at
    ) VALUES (?, 'order-audit','execution-filled','position-audit','BUY',?,?,?,?,?,?)`,
  );
  insertFill.run("fill-audit-1", "500000000000000000", "100", "50", "3", 1, timestamp);
  insertFill.run("fill-audit-2", "450000000000000000", "100", "45", "2", 2, timestamp);
  database.prepare(
    `INSERT INTO paper_fee_ledger(
      fee_ledger_id,paper_execution_id,paper_order_id,fee_snapshot_id,fee_micros,created_at
    ) VALUES ('fee-ledger-audit','execution-filled','order-audit','fee-audit','5',?)`,
  ).run(timestamp);
  database.close();
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Final validation framework", () => {
  it("captures committed WAL data in an isolated validation snapshot", async () => {
    const env = setup();
    const writer = new DatabaseSync(env.databasePath);
    writer.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;");
    writer.exec("CREATE TABLE wal_snapshot_probe(value TEXT NOT NULL); INSERT INTO wal_snapshot_probe VALUES ('committed-in-wal');");

    try {
      const snapshot = await prepareValidationDatabaseSnapshot({
        sourceDatabasePath: env.databasePath,
        outputDirectory: join(env.directory, "validation"),
        sessionId: "wal-snapshot",
        useSnapshot: true,
        sourceVersion,
      });
      const copied = new DatabaseSync(snapshot.workingDatabasePath, { readOnly: true });
      try {
        expect(copied.prepare("SELECT value FROM wal_snapshot_probe").get()).toEqual({ value: "committed-in-wal" });
      } finally {
        copied.close();
      }
    } finally {
      writer.close();
    }
  });

  it("refuses to validate a missing source database instead of creating an empty one", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ni-k-validation-missing-source-"));
    directories.push(directory);
    const missing = join(directory, "missing.sqlite");

    await expect(prepareValidationDatabaseSnapshot({
      sourceDatabasePath: missing,
      outputDirectory: join(directory, "validation"),
      sessionId: "missing-source",
      useSnapshot: true,
      sourceVersion,
    })).rejects.toThrow("SOURCE_DATABASE_NOT_FOUND");
    expect(existsSync(missing)).toBe(false);
  });

  it("rejects no-snapshot execution for every validation type before touching the source database", async () => {
    const env = setup();
    const validationTypes: ValidationType[] = [
      "ALL",
      "PAPER_REPLAY",
      "PAPER_CONSISTENCY",
      "CRASH_RECOVERY",
      "RECONCILIATION",
      "LIVE_GATE",
      "OBSERVE_ONLY",
    ];

    for (const validationType of validationTypes) {
      await expect(new ValidationRunner(sourceVersion, now).run({
        sourceDatabasePath: env.databasePath,
        outputDirectory: join(env.directory, "validation"),
        validationType,
        useSnapshot: false,
      })).rejects.toThrow("VALIDATION_SNAPSHOT_REQUIRED");
    }

    expect(count(env.databasePath, "validation_sessions")).toBe(0);
  });

  it("runs all validators on a snapshot and leaves the source database business data unchanged", async () => {
    const env = setup();
    const outputDirectory = join(env.directory, "validation");
    const result = await new ValidationRunner(sourceVersion, now).run({
      sourceDatabasePath: env.databasePath,
      outputDirectory,
      validationType: "ALL",
      useSnapshot: true,
    });
    expect(result.report.finalResult.liveAllowed).toBe(false);
    expect(result.report.finalResult.finalReadinessStatus).toBe("VALIDATION_FRAMEWORK_READY");
    expect(result.report.finalResult.status).toBe("INCOMPLETE");
    expect(existsSync(result.jsonReportPath)).toBe(true);
    expect(existsSync(result.markdownReportPath)).toBe(true);
    expect(result.workingDatabasePath).not.toBe(env.databasePath);
    expect(count(env.databasePath, "validation_sessions")).toBe(0);
    expect(count(result.workingDatabasePath, "validation_sessions")).toBe(1);
    const sourceState = new DatabaseSync(env.databasePath, { readOnly: true });
    const state = sourceState.prepare("SELECT execution_mode,live_gate_state FROM live_gate_state WHERE state_id='default'")
      .get() as { execution_mode: string; live_gate_state: string };
    sourceState.close();
    expect(state).toEqual({ execution_mode: "PAPER", live_gate_state: "LIVE_DISABLED" });
  });

  it("detects paper ledger mismatches as blocking consistency failures", async () => {
    const env = setup();
    const database = new DatabaseSync(env.databasePath);
    database.prepare(
      `INSERT INTO paper_accounts(
        paper_account_id,name,status,initial_balance_micros,cash_balance_micros,
        reserved_balance_micros,realized_pnl_micros,signal_cutoff_at,schema_version,
        strategy_version,risk_version,paper_version,ruleset_snapshot_json,ruleset_hash,
        source_code_commit,source_code_dirty,created_at,updated_at
      ) VALUES ('bad-paper','Bad','ACTIVE','1000','1000','0','0',?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    ).run(
      now().toISOString(),
      VERSIONS.schemaVersion,
      VERSIONS.strategyVersion,
      VERSIONS.riskVersion,
      VERSIONS.paperVersion,
      RULESET_SNAPSHOT_JSON,
      RULESET_HASH,
      sourceVersion.commit,
      now().toISOString(),
      now().toISOString(),
    );
    database.close();
    const checks = await new PaperConsistencyValidation().run({ databasePath: env.databasePath, sourceVersion, now });
    expect(checks.some((item) => item.checkName === "paper_ledger_consistency" && item.status === "FAIL" && item.blocking)).toBe(true);
  });

  it("detects a one-row reservation table mismatch against reservation and cash ledgers", async () => {
    const env = setup();
    insertConsistentPaperAuditFixture(env.databasePath);
    const database = new DatabaseSync(env.databasePath);
    database.prepare("UPDATE paper_reservations SET remaining_amount_micros='99' WHERE reservation_id='reservation-audit'").run();
    database.close();

    const checks = await new PaperConsistencyValidation().run({ databasePath: env.databasePath, sourceVersion, now });
    expect(checks.find((item) => item.checkName === "paper_reservation_consistency")).toMatchObject({
      status: "FAIL",
      blocking: true,
      reason: "RESERVATION_LEDGER_MISMATCH",
    });
  });

  it("detects a one-row fill mismatch against Paper execution totals", async () => {
    const env = setup();
    insertConsistentPaperAuditFixture(env.databasePath);
    const database = new DatabaseSync(env.databasePath);
    // Simulate out-of-band database tampering after explicitly removing the
    // production immutability guard in this isolated corruption fixture.
    database.exec("DROP TRIGGER paper_fill_ledger_no_update");
    database.prepare("UPDATE paper_fill_ledger SET size_micros='101' WHERE fill_id='fill-audit-1'").run();
    database.close();

    const checks = await new PaperConsistencyValidation().run({ databasePath: env.databasePath, sourceVersion, now });
    expect(checks.find((item) => item.checkName === "paper_execution_fill_consistency")).toMatchObject({
      status: "FAIL",
      blocking: true,
      reason: "EXECUTION_FILL_TOTAL_MISMATCH",
    });
  });

  it("detects a one-row fee ledger mismatch against fill fees", async () => {
    const env = setup();
    insertConsistentPaperAuditFixture(env.databasePath);
    const database = new DatabaseSync(env.databasePath);
    database.exec("DROP TRIGGER paper_fee_ledger_no_update");
    database.prepare("UPDATE paper_fee_ledger SET fee_micros='4' WHERE fee_ledger_id='fee-ledger-audit'").run();
    database.close();

    const checks = await new PaperConsistencyValidation().run({ databasePath: env.databasePath, sourceVersion, now });
    expect(checks.find((item) => item.checkName === "paper_fee_fill_consistency")).toMatchObject({
      status: "FAIL",
      blocking: true,
      reason: "FEE_LEDGER_FILL_MISMATCH",
    });
  });

  it("detects a non-negative Paper Position drift against immutable fills and PnL ledger", async () => {
    const env = setup();
    insertConsistentPaperAuditFixture(env.databasePath);
    const database = new DatabaseSync(env.databasePath);
    database.prepare("UPDATE paper_positions SET current_size_micros='199' WHERE paper_position_id='position-audit'").run();
    database.close();

    const checks = await new PaperConsistencyValidation().run({ databasePath: env.databasePath, sourceVersion, now });
    expect(checks.find((item) => item.checkName === "paper_position_ledger_consistency")).toMatchObject({
      status: "FAIL",
      blocking: true,
      reason: "POSITION_LEDGER_MISMATCH",
    });
  });

  it("does not report Paper replay as passed when signals exist but Paper execution never ran", async () => {
    const env = setup();
    insertPublishedSignal(env.databasePath);

    const checks = await new PaperReplayValidation().run({ databasePath: env.databasePath, sourceVersion, now });
    const summary = checks.find((item) => item.checkName === "paper_execution_summary");

    expect(summary).toMatchObject({ status: "NOT_RUN", blocking: false, reason: "PAPER_EXECUTION_NOT_RUN" });
    expect(summary?.metrics).toMatchObject({ signals: "1", executionAttempts: "0", fills: "0" });
  });

  it("requires a completed, polled, fully synced Observe run and preserves historical major desync", async () => {
    const env = setup();
    prepareObserveBaseline(env.databasePath);
    let clock = new Date("2026-07-08T00:01:00.000Z");
    const store = new ObserveStore(env.databasePath, sourceVersion);
    const runner = new ObserveOnlyRunner(
      store,
      new QueueObserveSource([
        observeSnapshot([position("200")], "2026-07-08T00:01:00.000Z"),
        observeSnapshot([position("200")], "2026-07-08T00:01:10.000Z"),
        observeSnapshot([position("200")], "2026-07-08T00:01:20.000Z"),
        observeSnapshot([position("100")], "2026-07-08T00:01:30.000Z"),
      ]),
      { walletAddress: wallet, pollIntervalMs: 1_000, now: () => clock },
    );
    for (let poll = 0; poll < 4; poll += 1) {
      clock = new Date(`2026-07-08T00:01:${String(poll * 10).padStart(2, "0")}.000Z`);
      expect(await runner.pollOnce()).toBe(true);
    }
    store.stopRun(runner.start().observeRunId, clock.toISOString(), "TEST_COMPLETE");
    store.close();

    const observeChecks = await new ObserveOnlyValidation().run({ databasePath: env.databasePath, sourceVersion, now });
    expect(observeChecks.find((item) => item.checkName === "observe_run_completed")).toMatchObject({ status: "PASS" });
    expect(observeChecks.find((item) => item.checkName === "observe_successful_poll")).toMatchObject({ status: "PASS" });
    expect(observeChecks.find((item) => item.checkName === "observe_final_sync")).toMatchObject({ status: "PASS" });
    expect(observeChecks.find((item) => item.checkName === "observe_checkpoint")).toMatchObject({ status: "PASS" });
    expect(observeChecks.find((item) => item.checkName === "observe_connection_gap")).toMatchObject({ status: "PASS" });
    expect(observeChecks.find((item) => item.checkName === "observe_historical_major_desync")).toMatchObject({
      status: "FAIL",
      blocking: true,
      reason: "OBSERVE_MAJOR_DESYNC_DETECTED:1",
    });

    const reconciliationChecks = await new ReconciliationValidation().run({ databasePath: env.databasePath, sourceVersion, now });
    const reportCheck = reconciliationChecks.find((item) => item.checkName === "observe_reconciliation_reports");
    expect(reportCheck).toMatchObject({ status: "PASS", reason: "OK" });
    expect(reportCheck?.metrics).toMatchObject({ latestSyncStatus: "SYNCED", historicalMajorDesyncCount: 1 });
  });

  it("validates Live Gate fake path and restores validation database to PAPER + LIVE_DISABLED", async () => {
    const env = setup();
    const checks = await new LiveGateValidation().run({ databasePath: env.databasePath, sourceVersion, now });
    expect(checks.every((item) => item.status === "PASS")).toBe(true);
    const database = new DatabaseSync(env.databasePath, { readOnly: true });
    const state = database.prepare("SELECT execution_mode,live_gate_state FROM live_gate_state WHERE state_id='default'")
      .get() as { execution_mode: string; live_gate_state: string };
    expect(state).toEqual({ execution_mode: "PAPER", live_gate_state: "LIVE_DISABLED" });
    expect((database.prepare("SELECT count(*) count FROM live_orders").get() as { count: number }).count).toBe(0);
    const liveRisk = database.prepare(
      "SELECT executor_mode,account_id,paper_account_id FROM risk_decisions WHERE risk_decision_id='validation-risk-allow'",
    ).get() as { executor_mode: string; account_id: string | null; paper_account_id: string | null };
    expect(liveRisk).toEqual({
      executor_mode: "LIVE",
      account_id: "validation-live-account",
      paper_account_id: null,
    });
    database.close();
  });

  it("builds stable report hashes and never marks Live as allowed", () => {
    const base = {
      sessionId: "validation-stable",
      validationType: "ALL" as const,
      startedAt: now().toISOString(),
      finishedAt: now().toISOString(),
      sourceVersion,
      inputSnapshotHash: "input",
      dbSnapshotHash: "db",
      checks: [{
        checkType: "PAPER_CONSISTENCY" as const,
        checkName: "paper_ledger_consistency",
        status: "PASS" as const,
        blocking: true,
        reason: "OK",
        startedAt: now().toISOString(),
        finishedAt: now().toISOString(),
      }],
    };
    const first = buildValidationReport(base);
    const second = buildValidationReport(base);
    expect(first.system.reportHash).toBe(second.system.reportHash);
    expect(first.finalResult.liveAllowed).toBe(false);
    expect(first.finalResult.status).toBe("PASS");
  });
});
