import { createHash } from "node:crypto";
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
import { PaperExecutor } from "../src/paper/paper-executor.js";
import { PublicPaperMarketDataProvider } from "../src/paper/public-market-data.js";
import { LiveGateValidation } from "../src/validation/live-gate-validation.js";
import { ObserveOnlyValidation } from "../src/validation/observe-only-validation.js";
import { PaperConsistencyValidation } from "../src/validation/paper-consistency-validation.js";
import { PaperReplayValidation } from "../src/validation/paper-replay-validation.js";
import { prepareValidationDatabaseSnapshot } from "../src/validation/database-snapshot.js";
import { ReconciliationValidation } from "../src/validation/reconciliation-validation.js";
import { buildValidationReport } from "../src/validation/report-generator.js";
import { ValidationRunner } from "../src/validation/validation-runner.js";
import { scopedObserveRunIds, type ValidationScope } from "../src/validation/scoped-invariants.js";
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
  const baseline = prepareObserveBaseline(databasePath);
  const executor = new PaperExecutor(databasePath, new PublicPaperMarketDataProvider(), { sourceVersion, now });
  const accountId = executor.createAccount("Validation Scope", 1_000_000_000n, baseline.targetId);
  executor.close();
  const scope = createValidationScope(databasePath, accountId, baseline.targetId, baseline.baselineRunId);
  return { directory, databasePath, scope };
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

function prepareObserveBaseline(databasePath: string): { targetId: string; baselineRunId: string } {
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
  const baseline = buildPositionBaseline({
    captureRunId: manifest.captureRunId,
    targetId,
    walletAddress: wallet,
    positionCaptureId: captureIdentity(positionsCapture).captureId,
    fetchedAt: positionsCapture.fetchedAt,
    latencyMs: positionsCapture.latencyMs,
    positions: positionsCapture.data,
  });
  database.savePositionBaseline(baseline);
  database.close();
  return { targetId, baselineRunId: baseline.baselineRunId };
}

function createValidationScope(
  databasePath: string,
  accountId: string,
  targetId: string,
  baselineRunId: string,
): ValidationScope {
  const database = new DatabaseSync(databasePath);
  const campaignId = `campaign-${accountId}`;
  const sessionId = `session-${accountId}`;
  const coreHash = createHash("sha256").update(`validation-core:${accountId}`).digest("hex");
  const account = database.prepare(
    "SELECT initial_balance_micros,target_id FROM paper_accounts WHERE paper_account_id=?",
  ).get(accountId) as { initial_balance_micros: string; target_id: string | null };
  if (account.target_id !== targetId) throw new Error("TEST_SCOPE_ACCOUNT_TARGET_MISMATCH");
  database.prepare(
    `INSERT INTO paper_validation_campaigns(
      campaign_id,target_id,baseline_run_id,paper_account_id,initial_balance_micros,
      required_active_runtime_ms,required_continuous_runtime_ms,qualifying_runtime_ms,
      checkpoint_interval_ms,max_checkpoint_gap_ms,core_compatibility_hash,core_manifest_json,
      schema_version,signal_version,strategy_version,risk_version,paper_version,ruleset_hash,
      config_version,source_code_commit,source_code_dirty,execution_mode,live_gate_state,created_at
    ) VALUES (?,?,?,?,?,259200000,43200000,7200000,60000,90000,?,'{}',?,?,?,?,?,?,?,?,0,
      'PAPER','LIVE_DISABLED',?)`,
  ).run(
    campaignId,
    targetId,
    baselineRunId,
    accountId,
    account.initial_balance_micros,
    coreHash,
    VERSIONS.schemaVersion,
    VERSIONS.signalVersion,
    VERSIONS.strategyVersion,
    VERSIONS.riskVersion,
    VERSIONS.paperVersion,
    RULESET_HASH,
    VERSIONS.configVersion,
    sourceVersion.commit,
    baselineTime,
  );
  database.prepare(
    `INSERT INTO paper_validation_sessions(
      session_id,campaign_id,sequence,session_kind,planned_duration_ms,
      core_compatibility_hash,schema_version,ruleset_hash,config_version,
      source_code_commit,source_code_dirty,live_gate_transition_count_at_start,started_at,created_at
    ) VALUES (?,?,1,'QUALIFYING',7200000,?,?,?,?,?,0,0,?,?)`,
  ).run(
    sessionId,
    campaignId,
    coreHash,
    VERSIONS.schemaVersion,
    RULESET_HASH,
    VERSIONS.configVersion,
    sourceVersion.commit,
    baselineTime,
    baselineTime,
  );
  const insertTransition = database.prepare(
    `INSERT INTO paper_validation_transitions(
      transition_id,entity_type,campaign_id,session_id,from_state,to_state,reason,sequence,
      evidence_json,evidence_hash,core_compatibility_hash,source_code_commit,source_code_dirty,
      config_version,idempotency_key,created_at
    ) VALUES (?,?,?,?,NULL,'RUNNING','TEST_SCOPE_RUNNING',1,'{}',?,?,?,0,?,?,?)`,
  );
  insertTransition.run(
    `transition-campaign-${accountId}`,
    "CAMPAIGN",
    campaignId,
    null,
    `evidence-campaign-${accountId}`,
    coreHash,
    sourceVersion.commit,
    VERSIONS.configVersion,
    `transition-idem-campaign-${accountId}`,
    baselineTime,
  );
  insertTransition.run(
    `transition-session-${accountId}`,
    "SESSION",
    campaignId,
    sessionId,
    `evidence-session-${accountId}`,
    coreHash,
    sourceVersion.commit,
    VERSIONS.configVersion,
    `transition-idem-session-${accountId}`,
    baselineTime,
  );
  database.close();
  return { campaignId, sessionId, accountId, targetId, baselineRunId, coreHash };
}

function insertPublishedSignal(
  databasePath: string,
  targetId: string,
  scope?: ValidationScope,
  identity: { signalId: string; sourceEventKey: string; observeRunId: string } = {
    signalId: "signal-validation",
    sourceEventKey: "source-validation",
    observeRunId: "observe-validation-signal",
  },
): void {
  const database = new DatabaseSync(databasePath);
  const timestamp = now().toISOString();
  const observeRunId = scope ? identity.observeRunId : null;
  if (scope) {
    database.prepare(
      `INSERT INTO observe_runs(
        observe_run_id,target_id,baseline_run_id,state,recovered_from_checkpoint,
        poll_interval_ms,started_at,last_heartbeat_at,stopped_at,stop_reason,
        schema_version,signal_version,strategy_version,risk_version,ruleset_hash,
        source_code_commit,source_code_dirty,created_at,campaign_id,campaign_session_id
      ) VALUES (?,?,?,'COMPLETED',0,15000,?,?,?,'TEST',?,?,?,?,?,?,0,?,?,?)`,
    ).run(
      observeRunId,
      targetId,
      scope.baselineRunId,
      timestamp,
      timestamp,
      timestamp,
      VERSIONS.schemaVersion,
      VERSIONS.signalVersion,
      VERSIONS.strategyVersion,
      VERSIONS.riskVersion,
      RULESET_HASH,
      sourceVersion.commit,
      timestamp,
      scope.campaignId,
      scope.sessionId,
    );
  }
  database.prepare(
    `INSERT INTO raw_events(
      source_event_key,target_id,identity_version,source_type,source_transaction_hash,
      source_timestamp,asset_id,condition_id,side,price_units,size_micros,gap_event,
      is_combo,raw_json,created_at,event_classification
    ) VALUES (?,?,'identity-v1','DATA_API_TRADE',
      ?,1773014400,'asset-validation',?, 'BUY',
      '500000000000000000','10000000',0,0,'{}',?,'STANDARD_TRADE')`,
  ).run(identity.sourceEventKey, targetId, `0x${identity.signalId}`, `0x${"7".repeat(64)}`, timestamp);
  database.prepare(
    `INSERT INTO signals(
      signal_id,target_id,signal_idempotency_key,source_event_key,signal_type,status,asset_id,
      condition_id,target_price_units,target_size_micros,sell_ratio_numerator,
      sell_ratio_denominator,reason,schema_version,signal_version,strategy_version,
      risk_version,replay_version,ruleset_snapshot_json,ruleset_hash,source_code_commit,
      created_at,execution_eligible,execution_block_reason,event_classification,
      capital_estimate_id,source_code_dirty,producer_mode,baseline_run_id,observe_run_id
    ) VALUES (?,?,?,?,'TARGET_BUY',
      'PUBLISHED','asset-validation',?,'500000000000000000','10000000',NULL,NULL,
      'VALIDATION_TEST',?,?,?,?,?,?,?,?,?,1,NULL,'STANDARD_TRADE',NULL,0,'OBSERVE_ONLY',?,?)`,
  ).run(
    identity.signalId,
    targetId,
    `idem-${identity.signalId}`,
    identity.sourceEventKey,
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
    scope?.baselineRunId ?? null,
    observeRunId,
  );
  database.close();
}

function insertConsistentPaperAuditFixture(databasePath: string): ValidationScope {
  const database = new DatabaseSync(databasePath);
  const target = database.prepare(
    "SELECT target_id FROM monitor_targets ORDER BY created_at LIMIT 1",
  ).get() as { target_id: string };
  const baseline = database.prepare(
    "SELECT baseline_run_id FROM position_baseline_runs WHERE target_id=? ORDER BY snapshot_time LIMIT 1",
  ).get(target.target_id) as { baseline_run_id: string };
  database.close();
  insertPublishedSignal(databasePath, target.target_id);
  const writable = new DatabaseSync(databasePath);
  const timestamp = now().toISOString();
  writable.prepare(
    `INSERT INTO paper_accounts(
      paper_account_id,name,target_id,status,initial_balance_micros,cash_balance_micros,
      reserved_balance_micros,realized_pnl_micros,signal_cutoff_at,schema_version,
      strategy_version,risk_version,paper_version,ruleset_snapshot_json,ruleset_hash,
      source_code_commit,source_code_dirty,created_at,updated_at
    ) VALUES ('audit-paper','Audit',?,'ACTIVE','1000','900','100','0',?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
  ).run(
    target.target_id,
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
  const insertExecution = writable.prepare(
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
  writable.prepare(
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
  writable.prepare(
    `INSERT INTO paper_reservations(
      reservation_id,paper_account_id,paper_execution_id,original_amount_micros,
      remaining_amount_micros,status,created_at,updated_at
    ) VALUES ('reservation-audit','audit-paper','execution-reserved','100','100','ACTIVE',?,?)`,
  ).run(timestamp, timestamp);
  writable.prepare(
    `INSERT INTO paper_reservation_ledger(
      reservation_ledger_id,reservation_id,paper_execution_id,entry_type,delta_micros,
      remaining_after_micros,idempotency_key,created_at
    ) VALUES ('reservation-ledger-audit','reservation-audit','execution-reserved',
      'RESERVE','100','100','reservation-ledger-idem',?)`,
  ).run(timestamp);
  const insertCash = writable.prepare(
    `INSERT INTO paper_cash_ledger(
      cash_ledger_id,paper_account_id,paper_execution_id,entry_type,cash_delta_micros,
      reserved_delta_micros,cash_after_micros,reserved_after_micros,idempotency_key,created_at
    ) VALUES (?, 'audit-paper', ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insertCash.run("cash-initial", null, "INITIAL_DEPOSIT", "1000", "0", "1000", "0", "cash-idem-initial", timestamp);
  insertCash.run("cash-fill", "execution-filled", "BUY_FILL", "-100", "0", "900", "0", "cash-idem-fill", timestamp);
  insertCash.run("cash-reserve", "execution-reserved", "RESERVE", "0", "100", "900", "100", "cash-idem-reserve", timestamp);
  writable.prepare(
    `INSERT INTO paper_orderbook_snapshots(
      orderbook_snapshot_id,asset_id,condition_id,market_snapshot_time,received_at,
      data_age_ms,payload_hash,bids_json,asks_json,source_url,created_at
    ) VALUES ('book-audit','asset-audit','condition-audit',?,?,0,'book-hash','[]','[]','fake://book',?)`,
  ).run(timestamp, timestamp, timestamp);
  writable.prepare(
    `INSERT INTO paper_fee_snapshots(
      fee_snapshot_id,asset_id,fee_rate_ppm,base_fee,fee_exponent,status,
      source_url,snapshot_time,created_at
    ) VALUES ('fee-audit','asset-audit','1000',1,1,'AVAILABLE','fake://fee',?,?)`,
  ).run(timestamp, timestamp);
  writable.prepare(
    `INSERT INTO paper_orders(
      paper_order_id,paper_execution_id,attempt_sequence,side,order_type,state,
      requested_size_micros,requested_amount_micros,filled_size_micros,
      filled_notional_micros,vwap_price_units,fee_micros,reject_reason,
      orderbook_snapshot_id,fee_snapshot_id,created_at
    ) VALUES ('order-audit','execution-filled',1,'BUY','FAK','FILLED','200','100',
      '200','95','475000000000000000','5',NULL,'book-audit','fee-audit',?)`,
  ).run(timestamp);
  const insertFill = writable.prepare(
    `INSERT INTO paper_fill_ledger(
      fill_id,paper_order_id,paper_execution_id,paper_position_id,side,price_units,
      size_micros,notional_micros,fee_micros,level_sequence,created_at
    ) VALUES (?, 'order-audit','execution-filled','position-audit','BUY',?,?,?,?,?,?)`,
  );
  insertFill.run("fill-audit-1", "500000000000000000", "100", "50", "3", 1, timestamp);
  insertFill.run("fill-audit-2", "450000000000000000", "100", "45", "2", 2, timestamp);
  writable.prepare(
    `INSERT INTO paper_fee_ledger(
      fee_ledger_id,paper_execution_id,paper_order_id,fee_snapshot_id,fee_micros,created_at
    ) VALUES ('fee-ledger-audit','execution-filled','order-audit','fee-audit','5',?)`,
  ).run(timestamp);
  writable.close();
  return createValidationScope(databasePath, "audit-paper", target.target_id, baseline.baseline_run_id);
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Final validation framework", () => {
  it("uses an explicit Campaign/Session binding for scoped Observe runs", () => {
    const env = setup();
    const database = new DatabaseSync(env.databasePath);
    const nextStartedAt = "2026-07-08T01:00:00.000Z";
    database.prepare(
      `INSERT INTO paper_validation_sessions(
        session_id,campaign_id,sequence,session_kind,planned_duration_ms,
        core_compatibility_hash,schema_version,ruleset_hash,config_version,
        source_code_commit,source_code_dirty,live_gate_transition_count_at_start,started_at,created_at
      ) VALUES ('session-next',?,2,'LONG_RUNNING',43200000,?,?,?,?,?,0,0,?,?)`,
    ).run(
      env.scope.campaignId,
      env.scope.coreHash,
      VERSIONS.schemaVersion,
      RULESET_HASH,
      VERSIONS.configVersion,
      sourceVersion.commit,
      nextStartedAt,
      nextStartedAt,
    );
    const insertRun = database.prepare(
      `INSERT INTO observe_runs(
        observe_run_id,target_id,baseline_run_id,state,recovered_from_checkpoint,
        poll_interval_ms,started_at,last_heartbeat_at,stopped_at,stop_reason,
        schema_version,signal_version,strategy_version,risk_version,ruleset_hash,
        source_code_commit,source_code_dirty,created_at,campaign_id,campaign_session_id
      ) VALUES (?,?,?,'COMPLETED',0,15000,?,?,?,'TEST',?,?,?,?,?,?,0,?,?,?)`,
    );
    insertRun.run(
      "observe-current-session",
      env.scope.targetId,
      env.scope.baselineRunId,
      "2026-07-08T00:30:00.000Z",
      "2026-07-08T00:45:00.000Z",
      "2026-07-08T00:45:00.000Z",
      VERSIONS.schemaVersion,
      VERSIONS.signalVersion,
      VERSIONS.strategyVersion,
      VERSIONS.riskVersion,
      RULESET_HASH,
      sourceVersion.commit,
      "2026-07-08T00:30:00.000Z",
      env.scope.campaignId,
      env.scope.sessionId,
    );
    insertRun.run(
      "observe-next-session",
      env.scope.targetId,
      env.scope.baselineRunId,
      nextStartedAt,
      nextStartedAt,
      nextStartedAt,
      VERSIONS.schemaVersion,
      VERSIONS.signalVersion,
      VERSIONS.strategyVersion,
      VERSIONS.riskVersion,
      RULESET_HASH,
      sourceVersion.commit,
      nextStartedAt,
      env.scope.campaignId,
      "session-next",
    );
    insertRun.run(
      "observe-standalone-same-window",
      env.scope.targetId,
      env.scope.baselineRunId,
      "2026-07-08T00:30:00.000Z",
      "2026-07-08T00:45:00.000Z",
      "2026-07-08T00:45:00.000Z",
      VERSIONS.schemaVersion,
      VERSIONS.signalVersion,
      VERSIONS.strategyVersion,
      VERSIONS.riskVersion,
      RULESET_HASH,
      sourceVersion.commit,
      "2026-07-08T00:30:00.000Z",
      null,
      null,
    );
    expect(() => insertRun.run(
      "observe-wrong-provenance",
      env.scope.targetId,
      env.scope.baselineRunId,
      "2026-07-08T00:31:00.000Z",
      "2026-07-08T00:31:00.000Z",
      "2026-07-08T00:31:00.000Z",
      VERSIONS.schemaVersion,
      VERSIONS.signalVersion,
      VERSIONS.strategyVersion,
      VERSIONS.riskVersion,
      RULESET_HASH,
      "different-source-commit",
      "2026-07-08T00:31:00.000Z",
      env.scope.campaignId,
      env.scope.sessionId,
    )).toThrow("observe campaign session binding is invalid");

    expect(scopedObserveRunIds(database, env.scope)).toEqual(["observe-current-session"]);
    expect(() => database.prepare(
      "UPDATE observe_runs SET source_code_commit='tampered' WHERE observe_run_id='observe-current-session'",
    ).run()).toThrow("observe campaign binding is immutable");
    database.close();
  });

  it("lets the Paper consumer consume only Signals from its exact Campaign Session", async () => {
    const env = setup();
    const nextStartedAt = "2026-07-09T00:30:00.000Z";
    const database = new DatabaseSync(env.databasePath);
    database.prepare(
      `INSERT INTO paper_validation_sessions(
        session_id,campaign_id,sequence,session_kind,planned_duration_ms,
        core_compatibility_hash,schema_version,ruleset_hash,config_version,
        source_code_commit,source_code_dirty,live_gate_transition_count_at_start,started_at,created_at
      ) VALUES ('session-other',?,2,'LONG_RUNNING',43200000,?,?,?,?,?,0,0,?,?)`,
    ).run(
      env.scope.campaignId,
      env.scope.coreHash,
      VERSIONS.schemaVersion,
      RULESET_HASH,
      VERSIONS.configVersion,
      sourceVersion.commit,
      nextStartedAt,
      nextStartedAt,
    );
    database.close();
    const otherScope: ValidationScope = { ...env.scope, sessionId: "session-other" };
    insertPublishedSignal(env.databasePath, env.scope.targetId, env.scope);
    insertPublishedSignal(env.databasePath, env.scope.targetId, otherScope, {
      signalId: "signal-other-session",
      sourceEventKey: "source-other-session",
      observeRunId: "observe-other-session",
    });
    const executor = new PaperExecutor(env.databasePath, new PublicPaperMarketDataProvider(), { sourceVersion, now });
    const probe = new DatabaseSync(env.databasePath, { readOnly: true });
    expect(probe.prepare(
      `SELECT s.signal_id,s.created_at,a.signal_cutoff_at,o.campaign_id,o.campaign_session_id
       FROM signals s JOIN observe_runs o ON o.observe_run_id=s.observe_run_id
       JOIN paper_accounts a ON a.paper_account_id=?
       WHERE o.campaign_id=? AND o.campaign_session_id=?`,
    ).all(env.scope.accountId, env.scope.campaignId, env.scope.sessionId)).toHaveLength(1);
    const accountWindow = probe.prepare(
      `SELECT a.signal_cutoff_at,c.last_signal_created_at,c.last_signal_id
       FROM paper_accounts a JOIN paper_consumer_checkpoints c USING(paper_account_id)
       WHERE a.paper_account_id=?`,
    ).get(env.scope.accountId) as {
      signal_cutoff_at: string;
      last_signal_created_at: string | null;
      last_signal_id: string | null;
    };
    expect(probe.prepare(
      `SELECT s.signal_id FROM signals s
       WHERE s.target_id=? AND s.created_at>=? AND s.status='PUBLISHED'
         AND s.execution_eligible=1
         AND EXISTS (SELECT 1 FROM observe_runs o WHERE o.observe_run_id=s.observe_run_id
           AND o.campaign_id=? AND o.campaign_session_id=?)
         AND s.created_at<=?
         AND (? IS NULL OR s.created_at>? OR (s.created_at=? AND s.signal_id>?))`,
    ).all(
      env.scope.targetId,
      accountWindow.signal_cutoff_at,
      env.scope.campaignId,
      env.scope.sessionId,
      now().toISOString(),
      accountWindow.last_signal_created_at,
      accountWindow.last_signal_created_at,
      accountWindow.last_signal_created_at,
      accountWindow.last_signal_id,
    )).toHaveLength(1);
    probe.close();
    await expect(executor.consumeAvailableSignals(env.scope.accountId, undefined, {
      campaignId: env.scope.campaignId,
      sessionId: env.scope.sessionId,
      coreCompatibilityHash: "0".repeat(64),
    })).rejects.toThrow("PAPER_SIGNAL_CONSUMPTION_SCOPE_INVALID");
    const consumed = await executor.consumeAvailableSignals(env.scope.accountId, undefined, {
      campaignId: env.scope.campaignId,
      sessionId: env.scope.sessionId,
      coreCompatibilityHash: env.scope.coreHash,
    });
    executor.close();

    expect(consumed).toHaveLength(1);
    const readOnly = new DatabaseSync(env.databasePath, { readOnly: true });
    expect(readOnly.prepare(
      "SELECT signal_id FROM paper_signal_consumptions WHERE paper_account_id=?",
    ).all(env.scope.accountId)).toEqual([{ signal_id: "signal-validation" }]);
    readOnly.close();
  });

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
        scope: env.scope,
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
      scope: env.scope,
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
        paper_account_id,name,target_id,status,initial_balance_micros,cash_balance_micros,
        reserved_balance_micros,realized_pnl_micros,signal_cutoff_at,schema_version,
        strategy_version,risk_version,paper_version,ruleset_snapshot_json,ruleset_hash,
        source_code_commit,source_code_dirty,created_at,updated_at
      ) VALUES ('bad-paper','Bad',?,'ACTIVE','1000','1000','0','0',?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    ).run(
      env.scope.targetId,
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
    const scope = createValidationScope(
      env.databasePath,
      "bad-paper",
      env.scope.targetId,
      env.scope.baselineRunId,
    );
    const checks = await new PaperConsistencyValidation().run({ databasePath: env.databasePath, sourceVersion, now, scope });
    expect(checks.some((item) => item.checkName === "paper_ledger_consistency" && item.status === "FAIL" && item.blocking)).toBe(true);
  });

  it("does not let an unrelated legacy account contaminate an explicitly scoped validation", async () => {
    const env = setup();
    const database = new DatabaseSync(env.databasePath);
    database.prepare(
      `INSERT INTO paper_accounts(
        paper_account_id,name,target_id,status,initial_balance_micros,cash_balance_micros,
        reserved_balance_micros,realized_pnl_micros,signal_cutoff_at,schema_version,
        strategy_version,risk_version,paper_version,ruleset_snapshot_json,ruleset_hash,
        source_code_commit,source_code_dirty,created_at,updated_at
      ) VALUES ('unrelated-broken','Legacy',?,'ACTIVE','1000','999','0','0',?,?,?,?,?,?,?,?,0,?,?)`,
    ).run(
      env.scope.targetId,
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

    const checks = await new PaperConsistencyValidation().run({
      databasePath: env.databasePath,
      sourceVersion,
      now,
      scope: env.scope,
    });
    expect(checks.find((item) => item.checkName === "paper_ledger_consistency")).toMatchObject({
      status: "PASS",
      reason: "OK",
    });
  });

  it("detects an entity current state that no longer matches its last transition", async () => {
    const env = setup();
    const database = new DatabaseSync(env.databasePath);
    database.prepare("UPDATE paper_accounts SET status='PAUSED' WHERE paper_account_id=?").run(env.scope.accountId);
    database.close();

    const checks = await new PaperConsistencyValidation().run({
      databasePath: env.databasePath,
      sourceVersion,
      now,
      scope: env.scope,
    });
    const evidence = checks.find((item) => item.checkName === "scoped_evidence_chain_invariants");
    expect(evidence).toMatchObject({ status: "FAIL", reason: "SCOPED_EVIDENCE_CHAIN_INVARIANT_FAILED" });
    expect(evidence?.metrics).toMatchObject({ stateTransitionMismatchCount: 1 });
  });

  it("detects an audit record whose immutable transition evidence was tampered", async () => {
    const env = setup();
    const database = new DatabaseSync(env.databasePath);
    database.exec("DROP TRIGGER audit_log_no_update");
    database.prepare(
      "UPDATE audit_log SET reason='TAMPERED' WHERE entity_type='PAPER_ACCOUNT' AND entity_id=?",
    ).run(env.scope.accountId);
    database.close();

    const checks = await new PaperConsistencyValidation().run({
      databasePath: env.databasePath,
      sourceVersion,
      now,
      scope: env.scope,
    });
    const evidence = checks.find((item) => item.checkName === "scoped_evidence_chain_invariants");
    expect(evidence).toMatchObject({ status: "FAIL", reason: "SCOPED_EVIDENCE_CHAIN_INVARIANT_FAILED" });
    expect(evidence?.metrics).toMatchObject({ transitionAuditViolationCount: 1 });
  });

  it("detects a scoped Campaign/Session provenance mismatch", async () => {
    const env = setup();
    const database = new DatabaseSync(env.databasePath);
    database.exec("DROP TRIGGER paper_validation_sessions_no_update");
    database.prepare(
      "UPDATE paper_validation_sessions SET source_code_dirty=1 WHERE session_id=?",
    ).run(env.scope.sessionId);
    database.close();

    const checks = await new PaperConsistencyValidation().run({
      databasePath: env.databasePath,
      sourceVersion,
      now,
      scope: env.scope,
    });
    const evidence = checks.find((item) => item.checkName === "scoped_evidence_chain_invariants");
    expect(evidence).toMatchObject({ status: "FAIL", reason: "SCOPED_EVIDENCE_CHAIN_INVARIANT_FAILED" });
    expect(evidence?.metrics).toMatchObject({ scopeBindingViolationCount: 1 });
  });

  it("detects corrupted provenance on a scoped Observe run", async () => {
    const env = setup();
    insertPublishedSignal(env.databasePath, env.scope.targetId, env.scope);
    const database = new DatabaseSync(env.databasePath);
    database.exec("DROP TRIGGER observe_runs_campaign_binding_immutable");
    database.prepare(
      "UPDATE observe_runs SET source_code_commit='tampered' WHERE observe_run_id='observe-validation-signal'",
    ).run();
    database.close();

    const checks = await new PaperConsistencyValidation().run({
      databasePath: env.databasePath,
      sourceVersion,
      now,
      scope: env.scope,
    });
    const evidence = checks.find((item) => item.checkName === "scoped_evidence_chain_invariants");
    expect(evidence).toMatchObject({ status: "FAIL", reason: "SCOPED_EVIDENCE_CHAIN_INVARIANT_FAILED" });
    expect(evidence?.metrics).toMatchObject({ scopeBindingViolationCount: 1 });
    expect(String(evidence?.metrics?.sampledViolations)).toContain("OBSERVE_RUN_PROVENANCE_MISMATCH");
  });

  it("detects a Paper market-data state that drifts from its transition ledger", async () => {
    const env = setup();
    const database = new DatabaseSync(env.databasePath);
    const timestamp = now().toISOString();
    const entityId = createHash("sha256")
      .update(["PAPER_MARKET_DATA", env.scope.accountId, "asset-market-health", "condition-market-health"].join("|"))
      .digest("hex");
    database.prepare(
      `INSERT INTO paper_market_data_health(
        paper_account_id,asset_id,condition_id,state,consecutive_failures,consecutive_successes,
        next_retry_at,last_error_code,last_error_message,last_failure_at,last_success_at,frozen_at,
        ruleset_hash,source_code_commit,source_code_dirty,config_version,created_at,updated_at
      ) VALUES (?, 'asset-market-health','condition-market-health','FROZEN',1,0,NULL,'NO_ORDERBOOK',
        'missing',?,NULL,?, ?,?,0,?,?,?)`,
    ).run(env.scope.accountId, timestamp, timestamp, RULESET_HASH, sourceVersion.commit, VERSIONS.configVersion, timestamp, timestamp);
    database.prepare(
      `INSERT INTO paper_state_transitions(
        transition_id,entity_type,entity_id,from_state,to_state,reason,sequence,ruleset_hash,
        source_code_commit,source_code_dirty,config_version,created_at
      ) VALUES ('market-health-transition','PAPER_MARKET_DATA',?,NULL,'FROZEN','NO_ORDERBOOK',0,?,?,0,?,?)`,
    ).run(entityId, RULESET_HASH, sourceVersion.commit, VERSIONS.configVersion, timestamp);
    database.prepare(
      `INSERT INTO audit_log(
        audit_id,timestamp,entity_type,entity_id,action,reason,ruleset_hash,
        source_code_commit,source_code_dirty,config_version,metadata_json
      ) VALUES ('market-health-audit',?,'PAPER_MARKET_DATA',?,'STATE_CHANGED','NO_ORDERBOOK',?,?,0,?,?)`,
    ).run(
      timestamp,
      entityId,
      RULESET_HASH,
      sourceVersion.commit,
      VERSIONS.configVersion,
      JSON.stringify({ from: null, sequence: 0, to: "FROZEN" }),
    );
    database.prepare(
      "UPDATE paper_market_data_health SET state='HEALTHY' WHERE paper_account_id=? AND asset_id='asset-market-health'",
    ).run(env.scope.accountId);
    database.close();

    const checks = await new PaperConsistencyValidation().run({
      databasePath: env.databasePath,
      sourceVersion,
      now,
      scope: env.scope,
    });
    const evidence = checks.find((item) => item.checkName === "scoped_evidence_chain_invariants");
    expect(evidence).toMatchObject({ status: "FAIL", reason: "SCOPED_EVIDENCE_CHAIN_INVARIANT_FAILED" });
    expect(evidence?.metrics).toMatchObject({ stateTransitionMismatchCount: 1 });
  });

  it("detects a rejected Risk Decision attached to a non-rejected execution", async () => {
    const env = setup();
    insertPublishedSignal(env.databasePath, env.scope.targetId, env.scope);
    const executor = new PaperExecutor(env.databasePath, new PublicPaperMarketDataProvider(), { sourceVersion, now });
    const executionId = await executor.consumeSignal(env.scope.accountId, "signal-validation");
    expect(executor.executionState(executionId)).toBe("REJECTED");
    executor.close();
    const database = new DatabaseSync(env.databasePath);
    database.prepare("UPDATE paper_executions SET state='WAITING_EXECUTION' WHERE paper_execution_id=?").run(executionId);
    database.close();

    const checks = await new PaperConsistencyValidation().run({
      databasePath: env.databasePath,
      sourceVersion,
      now,
      scope: env.scope,
    });
    const evidence = checks.find((item) => item.checkName === "scoped_evidence_chain_invariants");
    expect(evidence).toMatchObject({ status: "FAIL", reason: "SCOPED_EVIDENCE_CHAIN_INVARIANT_FAILED" });
    expect(evidence?.metrics).toMatchObject({ executionRiskDecisionViolationCount: 1 });
    expect(String(evidence?.metrics?.sampledViolations)).toContain("REJECT_DECISION_EXECUTED");
  });

  it("detects a one-row reservation table mismatch against reservation and cash ledgers", async () => {
    const env = setup();
    const scope = insertConsistentPaperAuditFixture(env.databasePath);
    const database = new DatabaseSync(env.databasePath);
    database.prepare("UPDATE paper_reservations SET remaining_amount_micros='99' WHERE reservation_id='reservation-audit'").run();
    database.close();

    const checks = await new PaperConsistencyValidation().run({ databasePath: env.databasePath, sourceVersion, now, scope });
    expect(checks.find((item) => item.checkName === "paper_reservation_consistency")).toMatchObject({
      status: "FAIL",
      blocking: true,
      reason: "RESERVATION_LEDGER_MISMATCH",
    });
  });

  it("reports a dangling Paper Order instead of hiding it behind scoped joins", async () => {
    const env = setup();
    const database = new DatabaseSync(env.databasePath);
    database.exec("PRAGMA foreign_keys=OFF");
    database.prepare(
      `INSERT INTO paper_orders(
        paper_order_id,paper_execution_id,attempt_sequence,side,order_type,state,
        requested_size_micros,requested_amount_micros,filled_size_micros,
        filled_notional_micros,vwap_price_units,fee_micros,reject_reason,
        orderbook_snapshot_id,fee_snapshot_id,created_at
      ) VALUES ('orphan-order','missing-execution',1,'BUY','FAK','NO_FILL',
        NULL,'1','0','0',NULL,'0','TEST_ORPHAN','missing-book','missing-fee',?)`,
    ).run(now().toISOString());
    database.close();

    const checks = await new PaperConsistencyValidation().run({
      databasePath: env.databasePath,
      sourceVersion,
      now,
      scope: env.scope,
    });
    expect(checks.find((item) => item.checkName === "orphan_records")).toMatchObject({
      status: "FAIL",
      reason: "ORPHAN_RECORDS_FOUND",
      metrics: { globalPaperOrdersWithoutExecution: 1 },
    });
  });

  it("detects Paper executions that do not have one matching scoped Risk Decision", async () => {
    const env = setup();
    const scope = insertConsistentPaperAuditFixture(env.databasePath);

    const checks = await new PaperConsistencyValidation().run({
      databasePath: env.databasePath,
      sourceVersion,
      now,
      scope,
    });
    const evidence = checks.find((item) => item.checkName === "scoped_evidence_chain_invariants");
    expect(evidence).toMatchObject({ status: "FAIL", reason: "SCOPED_EVIDENCE_CHAIN_INVARIANT_FAILED" });
    expect(Number(evidence?.metrics?.executionRiskDecisionViolationCount)).toBeGreaterThan(0);
  });

  it("detects a one-row fill mismatch against Paper execution totals", async () => {
    const env = setup();
    const scope = insertConsistentPaperAuditFixture(env.databasePath);
    const database = new DatabaseSync(env.databasePath);
    // Simulate out-of-band database tampering after explicitly removing the
    // production immutability guard in this isolated corruption fixture.
    database.exec("DROP TRIGGER paper_fill_ledger_no_update");
    database.prepare("UPDATE paper_fill_ledger SET size_micros='101' WHERE fill_id='fill-audit-1'").run();
    database.close();

    const checks = await new PaperConsistencyValidation().run({ databasePath: env.databasePath, sourceVersion, now, scope });
    expect(checks.find((item) => item.checkName === "paper_execution_fill_consistency")).toMatchObject({
      status: "FAIL",
      blocking: true,
      reason: "EXECUTION_FILL_TOTAL_MISMATCH",
    });
  });

  it("detects a one-row fee ledger mismatch against fill fees", async () => {
    const env = setup();
    const scope = insertConsistentPaperAuditFixture(env.databasePath);
    const database = new DatabaseSync(env.databasePath);
    database.exec("DROP TRIGGER paper_fee_ledger_no_update");
    database.prepare("UPDATE paper_fee_ledger SET fee_micros='4' WHERE fee_ledger_id='fee-ledger-audit'").run();
    database.close();

    const checks = await new PaperConsistencyValidation().run({ databasePath: env.databasePath, sourceVersion, now, scope });
    expect(checks.find((item) => item.checkName === "paper_fee_fill_consistency")).toMatchObject({
      status: "FAIL",
      blocking: true,
      reason: "FEE_LEDGER_FILL_MISMATCH",
    });
  });

  it("detects a non-negative Paper Position drift against immutable fills and PnL ledger", async () => {
    const env = setup();
    const scope = insertConsistentPaperAuditFixture(env.databasePath);
    const database = new DatabaseSync(env.databasePath);
    database.prepare("UPDATE paper_positions SET current_size_micros='199' WHERE paper_position_id='position-audit'").run();
    database.close();

    const checks = await new PaperConsistencyValidation().run({ databasePath: env.databasePath, sourceVersion, now, scope });
    expect(checks.find((item) => item.checkName === "paper_position_ledger_consistency")).toMatchObject({
      status: "FAIL",
      blocking: true,
      reason: "POSITION_LEDGER_MISMATCH",
    });
  });

  it("does not report Paper replay as passed when signals exist but Paper execution never ran", async () => {
    const env = setup();
    insertPublishedSignal(env.databasePath, env.scope.targetId, env.scope);

    const checks = await new PaperReplayValidation().run({ databasePath: env.databasePath, sourceVersion, now, scope: env.scope });
    const summary = checks.find((item) => item.checkName === "scoped_paper_execution_observation");

    expect(summary).toMatchObject({ status: "NOT_RUN", blocking: false, reason: "PAPER_EXECUTION_NOT_RUN" });
    expect(summary?.metrics).toMatchObject({ signals: "1", executionAttempts: "0", fills: "0" });
  });

  it("does not let an earlier Session execution satisfy a later empty Session", async () => {
    const env = setup();
    insertPublishedSignal(env.databasePath, env.scope.targetId, env.scope);
    const executor = new PaperExecutor(env.databasePath, new PublicPaperMarketDataProvider(), { sourceVersion, now });
    await executor.consumeSignal(env.scope.accountId, "signal-validation");
    executor.close();
    const database = new DatabaseSync(env.databasePath);
    const nextStartedAt = "2026-07-09T01:00:00.000Z";
    database.prepare(
      `INSERT INTO paper_validation_sessions(
        session_id,campaign_id,sequence,session_kind,planned_duration_ms,
        core_compatibility_hash,schema_version,ruleset_hash,config_version,
        source_code_commit,source_code_dirty,live_gate_transition_count_at_start,started_at,created_at
      ) VALUES ('session-empty-next',?,2,'LONG_RUNNING',43200000,?,?,?,?,?,0,0,?,?)`,
    ).run(
      env.scope.campaignId,
      env.scope.coreHash,
      VERSIONS.schemaVersion,
      RULESET_HASH,
      VERSIONS.configVersion,
      sourceVersion.commit,
      nextStartedAt,
      nextStartedAt,
    );
    database.close();
    const nextScope: ValidationScope = { ...env.scope, sessionId: "session-empty-next" };

    const checks = await new PaperReplayValidation().run({
      databasePath: env.databasePath,
      sourceVersion,
      now,
      scope: nextScope,
    });
    const summary = checks.find((item) => item.checkName === "scoped_paper_execution_observation");
    expect(summary).toMatchObject({ status: "NOT_RUN", reason: "PAPER_REPLAY_NOT_RUN" });
    expect(summary?.metrics).toMatchObject({ signals: "0", executionAttempts: "0", fills: "0" });
    expect(summary?.metrics?.accountLifetime).toMatchObject({ executionAttempts: "1" });
  });

  it("requires a completed, polled, fully synced Observe run and preserves historical major desync", async () => {
    const env = setup();
    let clock = new Date("2026-07-08T00:01:00.000Z");
    const store = new ObserveStore(env.databasePath, sourceVersion);
    const runner = new ObserveOnlyRunner(
      store,
      new QueueObserveSource([
        observeSnapshot([position("200")], "2026-07-08T00:01:00.000Z"),
        observeSnapshot([position("200")], "2026-07-08T00:02:00.000Z"),
        observeSnapshot([position("200")], "2026-07-08T00:03:00.000Z"),
        observeSnapshot([position("100")], "2026-07-08T00:03:10.000Z"),
      ]),
      {
        walletAddress: wallet,
        pollIntervalMs: 60_000,
        now: () => clock,
        campaignId: env.scope.campaignId,
        campaignSessionId: env.scope.sessionId,
      },
    );
    for (const pollAt of [
      "2026-07-08T00:01:00.000Z",
      "2026-07-08T00:02:00.000Z",
      "2026-07-08T00:03:00.000Z",
      "2026-07-08T00:03:10.000Z",
    ]) {
      clock = new Date(pollAt);
      expect(await runner.pollOnce()).toBe(true);
    }
    store.stopRun(runner.start().observeRunId, clock.toISOString(), "TEST_COMPLETE");
    store.close();

    const observeChecks = await new ObserveOnlyValidation().run({ databasePath: env.databasePath, sourceVersion, now, scope: env.scope });
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

    const reconciliationChecks = await new ReconciliationValidation().run({ databasePath: env.databasePath, sourceVersion, now, scope: env.scope });
    const reportCheck = reconciliationChecks.find((item) => item.checkName === "scoped_observe_reconciliation_reports");
    expect(reportCheck).toMatchObject({ status: "PASS", reason: "OK" });
    expect(reportCheck?.metrics).toMatchObject({ latestSyncStatus: "SYNCED", historicalMajorDesyncCount: 1 });
  });

  it("validates Live Gate fake path and restores validation database to PAPER + LIVE_DISABLED", async () => {
    const env = setup();
    const checks = await new LiveGateValidation().run({ databasePath: env.databasePath, sourceVersion, now, scope: env.scope });
    expect(checks.every((item) => item.status === "PASS")).toBe(true);
    const database = new DatabaseSync(env.databasePath, { readOnly: true });
    const state = database.prepare("SELECT execution_mode,live_gate_state FROM live_gate_state WHERE state_id='default'")
      .get() as { execution_mode: string; live_gate_state: string };
    expect(state).toEqual({ execution_mode: "PAPER", live_gate_state: "LIVE_DISABLED" });
    expect((database.prepare("SELECT count(*) count FROM live_orders").get() as { count: number }).count).toBe(0);
    const liveRiskCount = (database.prepare(
      "SELECT count(*) count FROM risk_decisions WHERE risk_decision_id='validation-risk-allow'",
    ).get() as { count: number }).count;
    expect(liveRiskCount).toBe(0);
    expect(checks.every((item) => item.metrics?.evidenceLevel === "CONTROLLED_ISOLATED_FAKE_LIVE")).toBe(true);
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
      scope: setup("ni-k-report-scope-").scope,
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
