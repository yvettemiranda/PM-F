import { createHash } from "node:crypto";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { RULESET, RULESET_HASH, RULESET_SNAPSHOT_JSON, VERSIONS } from "../src/domain/versioning.js";
import { Phase0Database } from "../src/infra/sqlite/database.js";
import type { SourceVersion } from "../src/infra/source-version.js";
import { ObserveOnlyRunner } from "../src/observe/observe-runner.js";
import { ObserveStore } from "../src/observe/observe-store.js";
import type { ObserveDataSource, ObservePollSnapshot } from "../src/observe/types.js";
import { PaperExecutor, PAPER_CONSUMER_CUTOFF_SIGNAL_SENTINEL } from "../src/paper/paper-executor.js";
import { PublicPaperMarketDataProvider } from "../src/paper/public-market-data.js";
import { computeCoreCompatibilityHash } from "../src/paper-validation/core-compatibility.js";
import {
  findCampaignRuntimeProcesses,
  inspectInterruptedDatabaseContinuity,
  validationCheckpointChainBlockers,
} from "../src/paper-validation/crash-recovery.js";
import { collectCheckpointEvidence } from "../src/paper-validation/operator-evidence.js";
import {
  assertPaperCampaignPreMigrationCompatible,
  freezePaperCampaignPreMigrationMismatch,
} from "../src/paper-validation/preflight.js";
import { prepareInterruptedRuntimeRecovery } from "../src/paper-validation/runtime-recovery.js";
import { PaperValidationCampaignService } from "../src/paper-validation/service.js";
import {
  PAPER_VALIDATION_SCENARIOS,
  type CampaignSnapshot,
  type CoreCompatibilityManifest,
  type ObserveOperationalMetrics,
  type ScenarioEvidence,
  type SessionCoverage,
  type ValidationSessionDefinition,
} from "../src/paper-validation/types.js";

const directories: string[] = [];
const runtimeChildren = new Set<ChildProcess>();
const sourceVersion: SourceVersion = { commit: "campaign-test-commit", dirty: false };
const wallet = "0x0000000000000000000000000000000000000001";

interface Fixture {
  databasePath: string;
  targetId: string;
  baselineRunId: string;
  accountId: string;
  manifest: CoreCompatibilityManifest;
  service: PaperValidationCampaignService;
}

function componentHash(name: string): string {
  return createHash("sha256").update(name).digest("hex");
}

function manifest(): CoreCompatibilityManifest {
  return {
    schemaVersion: VERSIONS.schemaVersion,
    signalVersion: VERSIONS.signalVersion,
    strategyVersion: VERSIONS.strategyVersion,
    riskVersion: VERSIONS.riskVersion,
    paperVersion: VERSIONS.paperVersion,
    rulesetHash: RULESET_HASH,
    configVersion: VERSIONS.configVersion,
    components: {
      amountCalculation: componentHash("amountCalculation"),
      signalContext: componentHash("signalContext"),
      risk: componentHash("risk"),
      paperExecution: componentHash("paperExecution"),
      observeRecovery: componentHash("observeRecovery"),
      settlementPnl: componentHash("settlementPnl"),
      schema: componentHash("schema"),
      runtimeEnvironment: componentHash("runtimeEnvironment"),
    },
  };
}

function fixture(): Fixture {
  const directory = mkdtempSync(join(tmpdir(), "ni-k-paper-campaign-"));
  directories.push(directory);
  const databasePath = join(directory, "campaign.sqlite");
  const phase0 = new Phase0Database(databasePath, sourceVersion);
  phase0.initialize();
  const targetId = phase0.ensureTarget(wallet, "IDENTITY_CONFIRMED");
  phase0.close();

  const database = new DatabaseSync(databasePath);
  const now = "2026-07-16T00:00:00.000Z";
  const captureId = "campaign-position-capture";
  const captureRunId = "campaign-capture-run";
  const baselineRunId = "campaign-baseline";
  const accountId = "campaign-paper-account";
  database.prepare(
    `INSERT INTO api_captures(
      capture_id,endpoint,request_url,fetched_at,latency_ms,http_status,payload_sha256,
      response_json,schema_version
    ) VALUES (?, 'positions', 'https://example.invalid', ?, 1, 200, ?, '[]', ?)`,
  ).run(captureId, now, componentHash("payload"), VERSIONS.schemaVersion);
  database.prepare(
    `INSERT INTO capture_runs(
      capture_run_id,target_id,wallet_address,sample_role,purpose,status,started_at,
      completed_at,manifest_hash,item_count,schema_version,signal_version,strategy_version,
      risk_version,replay_version,ruleset_snapshot_json,ruleset_hash,source_code_commit,
      source_code_dirty,error_detail,created_at
    ) VALUES (?, ?, ?, 'TARGET', 'PAPER_CAMPAIGN_TEST', 'COMPLETE', ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?)`,
  ).run(
    captureRunId,
    targetId,
    wallet,
    now,
    now,
    componentHash("manifest"),
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
  database.prepare(
    `INSERT INTO position_baseline_runs(
      baseline_run_id,capture_run_id,target_id,wallet_address,status,cutoff_from,cutoff_to,
      snapshot_time,position_capture_id,item_count,schema_version,strategy_version,
      ruleset_hash,source_code_commit,source_code_dirty,created_at
    ) VALUES (?, ?, ?, ?, 'READY', ?, ?, ?, ?, 0, ?, ?, ?, ?, 0, ?)`,
  ).run(
    baselineRunId,
    captureRunId,
    targetId,
    wallet,
    now,
    now,
    now,
    captureId,
    VERSIONS.schemaVersion,
    VERSIONS.strategyVersion,
    RULESET_HASH,
    sourceVersion.commit,
    now,
  );
  const initialBalance = String(RULESET.paperInitialBalanceMicros);
  database.prepare(
    `INSERT INTO paper_accounts(
      paper_account_id,name,target_id,status,initial_balance_micros,cash_balance_micros,
      reserved_balance_micros,realized_pnl_micros,signal_cutoff_at,schema_version,
      strategy_version,risk_version,paper_version,ruleset_snapshot_json,ruleset_hash,
      source_code_commit,source_code_dirty,created_at,updated_at
    ) VALUES (?, 'Campaign Test', ?, 'ACTIVE', ?, ?, '0', '0', ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
  ).run(
    accountId,
    targetId,
    initialBalance,
    initialBalance,
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
  database.prepare(
    `INSERT INTO paper_cash_ledger(
      cash_ledger_id,paper_account_id,paper_execution_id,entry_type,cash_delta_micros,
      reserved_delta_micros,cash_after_micros,reserved_after_micros,idempotency_key,created_at
    ) VALUES ('campaign-deposit', ?, NULL, 'INITIAL_DEPOSIT', ?, '0', ?, '0', 'campaign-deposit', ?)`,
  ).run(accountId, initialBalance, initialBalance, now);
  database.prepare(
    "INSERT INTO paper_consumer_checkpoints(paper_account_id,last_signal_created_at,last_signal_id,updated_at) VALUES (?,NULL,NULL,?)",
  ).run(accountId, now);
  database.close();
  const service = new PaperValidationCampaignService(databasePath);
  // Thousands of one-minute heartbeat transactions are intentional here. The
  // production store remains synchronous=FULL; this temp-only database avoids
  // paying an fsync for every simulated minute.
  service.store.database.exec("PRAGMA synchronous=OFF;");
  return {
    databasePath,
    targetId,
    baselineRunId,
    accountId,
    manifest: manifest(),
    service,
  };
}

function at(hours: number, minutes = 0): string {
  return new Date(Date.UTC(2026, 6, 16, hours, minutes)).toISOString();
}

function atMinute(totalMinutes: number): string {
  return new Date(Date.UTC(2026, 6, 16, 0, totalMinutes)).toISOString();
}

function createCampaign(input: Fixture, overrides: { requiredActiveRuntimeMs?: number } = {}): CampaignSnapshot {
  return input.service.createCampaign({
    targetId: input.targetId,
    baselineRunId: input.baselineRunId,
    paperAccountId: input.accountId,
    coreManifest: input.manifest,
    sourceVersion,
    now: at(0),
    campaignId: "PC-TESTCAMPAIGN",
    ...overrides,
  });
}

function recordHealthySession(
  input: Fixture,
  session: ValidationSessionDefinition,
  startHour: number,
  durationHours: number,
): void {
  const startMinute = startHour * 60;
  const durationMinutes = durationHours * 60;
  input.service.recordCheckpoint({
    sessionId: session.sessionId,
    checkpointKind: "START",
    observedAt: atMinute(startMinute),
    idempotencyKey: `${session.sessionId}:start`,
    evidence: { observeActive: true, paperActive: true, consistencySafe: true },
  });
  for (let minute = 1; minute < durationMinutes; minute += 1) {
    input.service.recordCheckpoint({
      sessionId: session.sessionId,
      checkpointKind: "HEARTBEAT",
      observedAt: atMinute(startMinute + minute),
      idempotencyKey: `${session.sessionId}:heartbeat:${minute}`,
      evidence: { observeActive: true, paperActive: true, consistencySafe: true },
    });
  }
  input.service.recordCheckpoint({
    sessionId: session.sessionId,
    checkpointKind: "SAFE_STOP",
    observedAt: atMinute(startMinute + durationMinutes),
    idempotencyKey: `${session.sessionId}:stop`,
    evidence: { observeActive: true, paperActive: true, consistencySafe: true },
  });
}

function evidence(source: ScenarioEvidence["source"], id: string): ScenarioEvidence {
  return { covered: true, source, evidenceId: id, reason: "TEST_EVIDENCE" };
}

function completeCoverage(): SessionCoverage {
  return Object.fromEntries(PAPER_VALIDATION_SCENARIOS.map((scenario) => [
    scenario,
    evidence(
      ["ORDER", "FILL", "POSITION_UPDATE", "FEE", "REALIZED_PNL", "UNREALIZED_PNL"].includes(scenario)
        ? "REAL_EXECUTION_REPLAY"
        : "ISOLATED_CONTROLLED",
      `evidence-${scenario}`,
    ),
  ])) as SessionCoverage;
}

function cycleLiveGateDuringSession(input: Fixture, observedAt: string): void {
  const database = input.service.store.database;
  database.exec("BEGIN IMMEDIATE");
  try {
    database.prepare(
      `UPDATE live_gate_state SET execution_mode='LIVE',live_gate_state='LIVE_ACTIVE',
       requested_execution_mode='LIVE',state_reason='TEST_TRANSIENT_LIVE',updated_at=?
       WHERE state_id='default'`,
    ).run(observedAt);
    database.prepare(
      `INSERT INTO live_gate_state_transitions(
        transition_id,from_execution_mode,to_execution_mode,from_live_gate_state,
        to_live_gate_state,reason,actor,metadata_json,source_code_commit,
        source_code_dirty,config_version,created_at,signal_boundary_sequence
      ) VALUES (
        'paper-validation-live-cycle-on','PAPER','LIVE','LIVE_DISABLED','LIVE_ACTIVE',
        'TEST_TRANSIENT_LIVE','TEST','{}',?,0,?,?,0
      )`,
    ).run(sourceVersion.commit, VERSIONS.configVersion, observedAt);
    database.prepare(
      `UPDATE live_gate_state SET execution_mode='PAPER',live_gate_state='LIVE_DISABLED',
       requested_execution_mode=NULL,state_reason='TEST_RETURN_TO_SAFE',updated_at=?
       WHERE state_id='default'`,
    ).run(observedAt);
    database.prepare(
      `INSERT INTO live_gate_state_transitions(
        transition_id,from_execution_mode,to_execution_mode,from_live_gate_state,
        to_live_gate_state,reason,actor,metadata_json,source_code_commit,
        source_code_dirty,config_version,created_at,signal_boundary_sequence
      ) VALUES (
        'paper-validation-live-cycle-off','LIVE','PAPER','LIVE_ACTIVE','LIVE_DISABLED',
        'TEST_RETURN_TO_SAFE','TEST','{}',?,0,?,?,0
      )`,
    ).run(sourceVersion.commit, VERSIONS.configVersion, observedAt);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function startSession(input: Fixture, campaignId: string, hour: number, sessionId: string): ValidationSessionDefinition {
  return input.service.startSession({
    campaignId,
    coreManifest: input.manifest,
    sourceVersion,
    now: at(hour),
    sessionId,
  });
}

function finalizeHealthy(
  input: Fixture,
  session: ValidationSessionDefinition,
  stoppedAt: string,
  coverage: SessionCoverage = {},
  observeMetrics?: ObserveOperationalMetrics,
) {
  return input.service.finalizeSession({
    sessionId: session.sessionId,
    outcome: "SAFE_STOP",
    acceptanceStatus: session.sessionKind === "QUALIFYING" ? "PASSED_NATURAL" : "INCOMPLETE_COVERAGE",
    consistencyPassed: true,
    recoveryConfirmed: true,
    stopReason: "TEST_SAFE_STOP",
    blockers: [],
    coverage,
    ...(observeMetrics ? { observeMetrics } : {}),
    stoppedAt,
  });
}

function observeMetrics(successfulPolls: number, failedPolls: number): ObserveOperationalMetrics {
  return {
    successfulPolls,
    failedPolls,
    processedEvents: successfulPolls,
    emittedSignals: successfulPolls,
    duplicateEvents: successfulPolls * 2,
    gapEvents: 0,
    reconciliationCount: successfulPolls,
    minorDiffCount: 0,
    majorDesyncCount: 0,
    schedulingGapCount: 0,
    recoveredApiFailureSessions: failedPolls > 0 ? 1 : 0,
    checkpointRecoveredSessions: 1,
    unrecoveredConnectionGapSessions: 0,
  };
}

async function spawnCampaignRuntimeWorker(campaignId: string, sessionId: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, [
    "--import",
    "tsx",
    join(process.cwd(), "tests/fixtures/paper-campaign-runtime-worker.ts"),
    `--campaign-id=${campaignId}`,
    `--session-id=${sessionId}`,
    // Marker used by the production process classifier to identify the Paper role.
    "src/cli/paper-run.ts",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  runtimeChildren.add(child);
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("CAMPAIGN_RUNTIME_WORKER_READY_TIMEOUT")), 5_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.stdout!.once("data", (chunk: Buffer) => {
      clearTimeout(timeout);
      if (!chunk.toString().includes("READY")) reject(new Error("CAMPAIGN_RUNTIME_WORKER_NOT_READY"));
      else resolve();
    });
  });
  return child;
}

function processListing(): string {
  return execFileSync("/bin/ps", ["-axo", "pid=,command="], { encoding: "utf8" });
}

async function seedInterruptedRuntimeState(input: Fixture, observedAt: string): Promise<{
  observeRunId: string;
  waitingExecutionId: string;
  pendingExitExecutionId: string;
}> {
  const observeStore = new ObserveStore(input.databasePath, sourceVersion);
  const observeRunId = observeStore.startRun(wallet, 15_000, observedAt, 60_000, input.baselineRunId).observeRunId;
  observeStore.close();

  // Persist a pre-reservation projection. The simulated crash below leaves it
  // stale on purpose; production recovery must release the Reservation and
  // replace this with a current snapshot before confirming anything.
  const preCrashExecutor = new PaperExecutor(input.databasePath, new PublicPaperMarketDataProvider(), {
    sourceVersion,
    now: () => new Date(observedAt),
  });
  await preCrashExecutor.accountSnapshot(input.accountId);
  preCrashExecutor.close();

  const waitingExecutionId = "PE-CRASH-WAITING-BUY";
  const pendingExitExecutionId = "PE-CRASH-PENDING-EXIT";
  const database = new DatabaseSync(input.databasePath);
  database.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE;");
  try {
    const insertExecution = database.prepare(
      `INSERT INTO paper_executions(
        paper_execution_id,paper_account_id,signal_id,execution_idempotency_key,
        execution_type,state,asset_id,condition_id,requested_amount_micros,
        requested_size_micros,filled_size_micros,filled_notional_micros,fee_micros,
        target_price_units,price_limit_lower_units,price_limit_upper_units,capital_mode,
        deadline_at,attempt_count,reason,context_id,schema_version,strategy_version,
        risk_version,paper_version,ruleset_hash,created_at,updated_at,risk_decision_id,
        risk_reject_reason,source_code_commit,source_code_dirty,config_version
      ) VALUES (
        ?,?,NULL,?,?,?,'recovery-asset','recovery-condition',?,?,'0','0','0',
        NULL,NULL,NULL,NULL,NULL,0,'CRASH_RECOVERY_TEST',NULL,?,?,?,?,?,?,?,
        NULL,NULL,?,0,?
      )`,
    );
    insertExecution.run(
      waitingExecutionId,
      input.accountId,
      "crash-waiting-buy",
      "TARGET_BUY",
      "WAITING_EXECUTION",
      "100",
      null,
      VERSIONS.schemaVersion,
      VERSIONS.strategyVersion,
      VERSIONS.riskVersion,
      VERSIONS.paperVersion,
      RULESET_HASH,
      observedAt,
      observedAt,
      sourceVersion.commit,
      VERSIONS.configVersion,
    );
    insertExecution.run(
      pendingExitExecutionId,
      input.accountId,
      "crash-pending-exit",
      "TARGET_SELL",
      "EXIT_PENDING",
      null,
      "50",
      VERSIONS.schemaVersion,
      VERSIONS.strategyVersion,
      VERSIONS.riskVersion,
      VERSIONS.paperVersion,
      RULESET_HASH,
      observedAt,
      observedAt,
      sourceVersion.commit,
      VERSIONS.configVersion,
    );
    database.prepare(
      `INSERT INTO paper_reservations(
        reservation_id,paper_account_id,paper_execution_id,original_amount_micros,
        remaining_amount_micros,status,created_at,updated_at
      ) VALUES ('PRSV-CRASH',?,?, '100','100','ACTIVE',?,?)`,
    ).run(input.accountId, waitingExecutionId, observedAt, observedAt);
    database.prepare(
      `INSERT INTO paper_reservation_ledger(
        reservation_ledger_id,reservation_id,paper_execution_id,entry_type,delta_micros,
        remaining_after_micros,idempotency_key,created_at
      ) VALUES ('PRL-CRASH','PRSV-CRASH',?,'RESERVE','100','100','crash-reserve',?)`,
    ).run(waitingExecutionId, observedAt);
    database.prepare(
      `INSERT INTO paper_cash_ledger(
        cash_ledger_id,paper_account_id,paper_execution_id,entry_type,cash_delta_micros,
        reserved_delta_micros,cash_after_micros,reserved_after_micros,idempotency_key,created_at
      ) VALUES ('PCL-CRASH',?,?,'RESERVATION_CREATED','0','100','1000000000','100','crash-cash-reserve',?)`,
    ).run(input.accountId, waitingExecutionId, observedAt);
    database.prepare(
      "UPDATE paper_accounts SET reserved_balance_micros='100',updated_at=? WHERE paper_account_id=?",
    ).run(observedAt, input.accountId);
    database.prepare(
      `INSERT INTO paper_market_data_health(
        paper_account_id,asset_id,condition_id,state,consecutive_failures,
        consecutive_successes,next_retry_at,last_error_code,last_error_message,
        last_failure_at,last_success_at,frozen_at,ruleset_hash,source_code_commit,
        source_code_dirty,config_version,created_at,updated_at
      ) VALUES (?, 'recovery-asset','recovery-condition','FROZEN',1,0,NULL,
        'NO_ORDERBOOK_EXISTS','No orderbook exists',?,NULL,?,?,?,0,?,?,?)`,
    ).run(
      input.accountId,
      observedAt,
      observedAt,
      RULESET_HASH,
      sourceVersion.commit,
      VERSIONS.configVersion,
      observedAt,
      observedAt,
    );
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
  return { observeRunId, waitingExecutionId, pendingExitExecutionId };
}

afterEach(async () => {
  for (const child of runtimeChildren) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await once(child, "exit").catch(() => undefined);
    }
  }
  runtimeChildren.clear();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("PaperValidationCampaignService", () => {
  it("proves Observe and Paper cursors continue monotonically from the last heartbeat", async () => {
    const input = fixture();
    const campaign = createCampaign(input);
    const session = startSession(input, campaign.campaignId, 0, "PS-CONTINUITY-PROOF");
    input.service.recordCheckpoint({
      sessionId: session.sessionId,
      checkpointKind: "START",
      observedAt: at(0),
      idempotencyKey: "continuity-start",
      evidence: collectCheckpointEvidence({
        databasePath: input.databasePath,
        targetId: input.targetId,
        paperAccountId: input.accountId,
        observeActive: false,
        paperActive: false,
      }),
    });
    const fetchedAt = "2026-07-16T00:00:01.000Z";
    const capture = <T>(name: string, data: T) => ({
      url: `https://example.test/${name}`,
      fetchedAt,
      latencyMs: 1,
      status: 200,
      data,
    });
    const snapshot: ObservePollSnapshot = {
      trades: capture("trades", []),
      activity: capture("activity", []),
      positions: capture("positions", []),
      pUsdBalance: capture("balance", { jsonrpc: "2.0", id: 1, result: "0x0" }),
    };
    const source: ObserveDataSource = { poll: async () => snapshot };
    const observeStore = new ObserveStore(input.databasePath, sourceVersion);
    const observe = new ObserveOnlyRunner(observeStore, source, {
      walletAddress: wallet,
      baselineRunId: input.baselineRunId,
      pollIntervalMs: 15_000,
      now: () => new Date(fetchedAt),
      wait: async () => undefined,
    });
    await observe.pollOnce();
    const executor = new PaperExecutor(input.databasePath, new PublicPaperMarketDataProvider(), { sourceVersion });
    executor.advanceConsumerCutoff(
      input.accountId,
      "2026-07-16T00:00:00.500Z",
      "CONTINUITY_TEST_SESSION_START",
    );
    executor.close();
    const heartbeatEvidence = collectCheckpointEvidence({
      databasePath: input.databasePath,
      targetId: input.targetId,
      paperAccountId: input.accountId,
      observeActive: true,
      paperActive: true,
    });
    input.service.recordCheckpoint({
      sessionId: session.sessionId,
      checkpointKind: "HEARTBEAT",
      observedAt: fetchedAt,
      idempotencyKey: "continuity-heartbeat",
      evidence: heartbeatEvidence,
    });
    const latest = input.service.store.latestCheckpoint(session.sessionId);
    const continuityInput = {
      databasePath: input.databasePath,
      campaignId: campaign.campaignId,
      sessionId: session.sessionId,
      sessionStartedAt: session.startedAt,
      targetId: input.targetId,
      baselineRunId: input.baselineRunId,
      paperAccountId: input.accountId,
      latestCheckpoint: latest,
      currentEvidence: collectCheckpointEvidence({
        databasePath: input.databasePath,
        targetId: input.targetId,
        paperAccountId: input.accountId,
        observeActive: false,
        paperActive: false,
      }),
    };
    const continuity = inspectInterruptedDatabaseContinuity(continuityInput);
    expect(continuity.blockers).toEqual([]);
    expect(continuity.abandonedObserveRunIds).toEqual([observe.start().observeRunId]);

    input.service.store.database.prepare(
      "UPDATE monitor_checkpoints SET position_projection_hash='tampered' WHERE target_id=?",
    ).run(input.targetId);
    expect(inspectInterruptedDatabaseContinuity({
      ...continuityInput,
      currentEvidence: collectCheckpointEvidence({
        databasePath: input.databasePath,
        targetId: input.targetId,
        paperAccountId: input.accountId,
        observeActive: false,
        paperActive: false,
      }),
    }).blockers).toContain("RECOVERY_MONITOR_CHECKPOINT_MISMATCH");
    const heartbeatProjectionHash = heartbeatEvidence.positionProjectionHash;
    if (!heartbeatProjectionHash) throw new Error("TEST_HEARTBEAT_PROJECTION_HASH_MISSING");
    input.service.store.database.prepare(
      "UPDATE monitor_checkpoints SET position_projection_hash=? WHERE target_id=?",
    ).run(heartbeatProjectionHash, input.targetId);
    input.service.store.database.prepare(
      `UPDATE paper_consumer_checkpoints
       SET last_signal_created_at='2026-07-16T00:10:00.000Z',last_signal_id=?
       WHERE paper_account_id=?`,
    ).run(PAPER_CONSUMER_CUTOFF_SIGNAL_SENTINEL, input.accountId);
    expect(inspectInterruptedDatabaseContinuity({
      ...continuityInput,
      currentEvidence: collectCheckpointEvidence({
        databasePath: input.databasePath,
        targetId: input.targetId,
        paperAccountId: input.accountId,
        observeActive: false,
        paperActive: false,
      }),
    }).blockers).toContain("RECOVERY_PAPER_CONSUMER_CURSOR_UNBOUND");
    observeStore.close();
    input.service.close();
  });

  it("recomputes immutable checkpoint hashes and rejects a broken sequence", () => {
    const input = fixture();
    const campaign = createCampaign(input);
    const session = startSession(input, campaign.campaignId, 0, "PS-CHECKPOINT-PROOF");
    input.service.recordCheckpoint({
      sessionId: session.sessionId,
      checkpointKind: "START",
      observedAt: at(0),
      idempotencyKey: "checkpoint-proof-start",
      evidence: { observeActive: false, paperActive: false, consistencySafe: true },
    });
    input.service.recordCheckpoint({
      sessionId: session.sessionId,
      checkpointKind: "HEARTBEAT",
      observedAt: atMinute(1),
      idempotencyKey: "checkpoint-proof-heartbeat",
      evidence: { observeActive: true, paperActive: true, consistencySafe: true },
    });
    const checkpoints = input.service.store.checkpoints(session.sessionId);
    const proofInput = {
      checkpoints,
      campaignId: campaign.campaignId,
      sessionId: session.sessionId,
      sessionStartedAt: session.startedAt,
      expectedLiveGateTransitionCount: session.liveGateTransitionCountAtStart,
    };
    expect(validationCheckpointChainBlockers(proofInput)).toEqual([]);
    expect(validationCheckpointChainBlockers({
      ...proofInput,
      checkpoints: [checkpoints[0]!, { ...checkpoints[1]!, checkpointHash: "f".repeat(64) }],
    })).toContain(`RECOVERY_CHECKPOINT_HASH_MISMATCH:${checkpoints[1]!.checkpointId}`);
    expect(validationCheckpointChainBlockers({
      ...proofInput,
      checkpoints: [checkpoints[0]!, { ...checkpoints[1]!, sequence: 3 }],
    })).toContain("RECOVERY_CHECKPOINT_SEQUENCE_INVALID:3");
    input.service.close();
  });

  it("computes a stable core hash and changes it when a core component changes", () => {
    const original = manifest();
    expect(computeCoreCompatibilityHash(original)).toHaveLength(64);
    expect(computeCoreCompatibilityHash(original)).toBe(computeCoreCompatibilityHash({ ...original }));
    expect(computeCoreCompatibilityHash({
      ...original,
      components: { ...original.components, paperExecution: componentHash("changed") },
    })).not.toBe(computeCoreCompatibilityHash(original));
  });

  it("blocks then idempotently freezes an active Campaign core mismatch before migration", () => {
    const input = fixture();
    const campaign = createCampaign(input);
    const incompatible: CoreCompatibilityManifest = {
      ...input.manifest,
      components: {
        ...input.manifest.components,
        paperExecution: componentHash("pre-migration-incompatible"),
      },
    };

    expect(() => assertPaperCampaignPreMigrationCompatible({
      databasePath: input.databasePath,
      manifest: incompatible,
    })).toThrow(`ACTIVE_CAMPAIGN_CORE_MISMATCH_BEFORE_MIGRATION:${campaign.campaignId}`);
    expect(input.service.campaignSnapshot(campaign.campaignId).state).toBe("QUALIFYING");
    input.service.close();

    expect(freezePaperCampaignPreMigrationMismatch({
      databasePath: input.databasePath,
      manifest: incompatible,
      sourceVersion: { commit: "new-core-commit", dirty: false },
      now: at(1),
    })).toEqual({ campaignId: campaign.campaignId, campaignState: "FROZEN", frozen: true });
    expect(freezePaperCampaignPreMigrationMismatch({
      databasePath: input.databasePath,
      manifest: incompatible,
      sourceVersion: { commit: "another-display-only-commit", dirty: false },
      now: at(2),
    })).toEqual({ campaignId: campaign.campaignId, campaignState: "FROZEN", frozen: false });
    expect(assertPaperCampaignPreMigrationCompatible({
      databasePath: input.databasePath,
      manifest: incompatible,
    })).toEqual({
      campaignId: campaign.campaignId,
      campaignState: "FROZEN",
      campaignCoreCompatibilityHash: computeCoreCompatibilityHash(input.manifest),
      campaignBlockers: [],
    });
    const database = new DatabaseSync(input.databasePath);
    const transitions = database.prepare(
      "SELECT count(*) count FROM paper_validation_transitions WHERE campaign_id=? AND to_state='FROZEN'",
    ).get(campaign.campaignId) as { count: number };
    expect(transitions.count).toBe(1);
    database.close();
  });

  it("pre-migration freeze also blocks the single running Session atomically", () => {
    const input = fixture();
    const campaign = createCampaign(input);
    const session = startSession(input, campaign.campaignId, 0, "PS-PREFLIGHT-RUNNING");
    const incompatible: CoreCompatibilityManifest = {
      ...input.manifest,
      components: {
        ...input.manifest.components,
        paperExecution: componentHash("running-pre-migration-incompatible"),
      },
    };
    input.service.close();

    expect(freezePaperCampaignPreMigrationMismatch({
      databasePath: input.databasePath,
      manifest: incompatible,
      sourceVersion: { commit: "new-running-core-commit", dirty: false },
      now: at(1),
    })).toEqual({ campaignId: campaign.campaignId, campaignState: "FROZEN", frozen: true });
    const database = new DatabaseSync(input.databasePath);
    const campaignState = database.prepare(
      `SELECT to_state FROM paper_validation_transitions
       WHERE entity_type='CAMPAIGN' AND campaign_id=? ORDER BY sequence DESC LIMIT 1`,
    ).get(campaign.campaignId) as { to_state: string };
    const sessionState = database.prepare(
      `SELECT to_state FROM paper_validation_transitions
       WHERE entity_type='SESSION' AND session_id=? ORDER BY sequence DESC LIMIT 1`,
    ).get(session.sessionId) as { to_state: string };
    expect(campaignState.to_state).toBe("FROZEN");
    expect(sessionState.to_state).toBe("BLOCKED");
    database.close();
  });

  it("enforces hard runtime minima and the fixed checkpoint policy", () => {
    const input = fixture();
    expect(() => createCampaign(input, { requiredActiveRuntimeMs: 1 }))
      .toThrow("PAPER_VALIDATION_ACTIVE_RUNTIME_BELOW_HARD_MINIMUM");
    expect(() => input.service.createCampaign({
      targetId: input.targetId,
      baselineRunId: input.baselineRunId,
      paperAccountId: input.accountId,
      coreManifest: input.manifest,
      sourceVersion,
      now: at(0),
      requiredContinuousRuntimeMs: 1,
    })).toThrow("PAPER_VALIDATION_CONTINUOUS_RUNTIME_BELOW_HARD_MINIMUM");
    expect(() => input.service.createCampaign({
      targetId: input.targetId,
      baselineRunId: input.baselineRunId,
      paperAccountId: input.accountId,
      coreManifest: input.manifest,
      sourceVersion,
      now: at(0),
      qualifyingRuntimeMs: 1,
    })).toThrow("PAPER_VALIDATION_QUALIFYING_RUNTIME_BELOW_HARD_MINIMUM");
    expect(() => input.service.createCampaign({
      targetId: input.targetId,
      baselineRunId: input.baselineRunId,
      paperAccountId: input.accountId,
      coreManifest: input.manifest,
      sourceVersion,
      now: at(0),
      checkpointIntervalMs: 1,
      maxCheckpointGapMs: 90_000,
    })).toThrow("PAPER_VALIDATION_CHECKPOINT_POLICY_MISMATCH");
    input.service.close();
  });

  it("uses core compatibility rather than source commit identity when continuing", () => {
    const input = fixture();
    const campaign = createCampaign(input);
    const session = input.service.startSession({
      campaignId: campaign.campaignId,
      coreManifest: input.manifest,
      sourceVersion: { commit: "ui-and-docs-only-commit", dirty: false },
      now: at(1),
      sessionId: "PS-DISPLAY-COMMIT",
    });
    expect(session.sourceVersion.commit).toBe("ui-and-docs-only-commit");
    expect(input.service.campaignSnapshot(campaign.campaignId).state).toBe("RUNNING");
    input.service.close();
  });

  it("requires and immutably audits an authorized replacement Campaign", () => {
    const input = fixture();
    const original = createCampaign(input);
    const repairedManifest: CoreCompatibilityManifest = {
      ...input.manifest,
      components: {
        ...input.manifest.components,
        paperExecution: componentHash("market-data-repaired-paper-execution"),
      },
    };
    expect(() => input.service.startSession({
      campaignId: original.campaignId,
      coreManifest: repairedManifest,
      sourceVersion,
      now: at(1),
      sessionId: "PS-FREEZE-OLD-CORE",
    })).toThrow(`PAPER_VALIDATION_CAMPAIGN_FROZEN:CORE_COMPATIBILITY_MISMATCH:${original.campaignId}`);

    const executor = new PaperExecutor(
      input.databasePath,
      new PublicPaperMarketDataProvider(),
      { sourceVersion },
    );
    const replacementAccountId = executor.createAccount(
      "Replacement Campaign Account",
      BigInt(RULESET.paperInitialBalanceMicros),
      input.targetId,
    );
    executor.close();

    const replacementInput = {
      targetId: input.targetId,
      baselineRunId: input.baselineRunId,
      paperAccountId: replacementAccountId,
      coreManifest: repairedManifest,
      sourceVersion,
      now: at(2),
      campaignId: "PC-REPLACEMENT",
    } as const;
    expect(() => input.service.createCampaign(replacementInput))
      .toThrow(`PAPER_VALIDATION_REPLACEMENT_LINK_REQUIRED:${original.campaignId}`);
    expect(() => input.service.createCampaign({
      ...replacementInput,
      supersedesCampaignId: original.campaignId,
      replacementReason: "CORE_REPAIR_MARKET_DATA",
    })).toThrow(`PAPER_VALIDATION_REPLACEMENT_NOT_AUTHORIZED:${original.campaignId}`);

    const replacement = input.service.createCampaign({
      ...replacementInput,
      supersedesCampaignId: original.campaignId,
      replacementReason: "CORE_VERSION_REPLACEMENT",
    });
    expect(replacement.state).toBe("QUALIFYING");
    expect(replacement.accumulatedActiveRuntimeMs).toBe(0);
    expect(replacement.paperAccountId).toBe(replacementAccountId);

    const transition = input.service.store.database.prepare(
      `SELECT reason,evidence_json FROM paper_validation_transitions
       WHERE entity_type='CAMPAIGN' AND campaign_id=? ORDER BY sequence DESC LIMIT 1`,
    ).get(replacement.campaignId) as { reason: string; evidence_json: string };
    expect(transition.reason).toBe("CAMPAIGN_CREATED_AFTER_CORE_REPAIR");
    expect(JSON.parse(transition.evidence_json)).toMatchObject({
      supersedesCampaignId: original.campaignId,
      supersededCampaignState: "FROZEN",
      supersededCoreCompatibilityHash: original.coreCompatibilityHash,
      replacementReason: "CORE_VERSION_REPLACEMENT",
      executionMode: "PAPER",
      liveGateState: "LIVE_DISABLED",
    });
    input.service.close();
  });

  it("rejects an unclean fixed account and an unsafe runtime state", () => {
    const accountInput = fixture();
    accountInput.service.store.database.prepare(
      "UPDATE paper_accounts SET realized_pnl_micros='1' WHERE paper_account_id=?",
    ).run(accountInput.accountId);
    expect(() => createCampaign(accountInput)).toThrow(
      `PAPER_VALIDATION_ACCOUNT_NOT_CLEAN:${accountInput.accountId}`,
    );
    accountInput.service.close();

    const safetyInput = fixture();
    safetyInput.service.store.database.prepare(
      `UPDATE live_gate_state SET execution_mode='LIVE',live_gate_state='LIVE_ACTIVE',
       requested_execution_mode='LIVE',state_reason='TEST_UNSAFE',updated_at=?
       WHERE state_id='default'`,
    ).run(at(1));
    expect(() => createCampaign(safetyInput)).toThrow(
      "PAPER_VALIDATION_UNSAFE_MODE:LIVE:LIVE_ACTIVE",
    );
    safetyInput.service.close();
  });

  it("rejects semantic transition idempotency conflicts and illegal state jumps", () => {
    const input = fixture();
    const campaign = createCampaign(input);
    const coreCompatibilityHash = computeCoreCompatibilityHash(input.manifest);
    const creationEvidence = {
      targetId: input.targetId,
      baselineRunId: input.baselineRunId,
      paperAccountId: input.accountId,
      executionMode: "PAPER",
      liveGateState: "LIVE_DISABLED",
    };
    expect(() => input.service.store.insertTransition({
      entityType: "CAMPAIGN",
      campaignId: campaign.campaignId,
      fromState: null,
      toState: "QUALIFYING",
      reason: "TAMPERED_CREATE_REASON",
      evidence: creationEvidence,
      coreCompatibilityHash,
      sourceVersion,
      configVersion: input.manifest.configVersion,
      idempotencyKey: `CAMPAIGN:${campaign.campaignId}:CREATE`,
      now: at(0),
    })).toThrow("PAPER_VALIDATION_TRANSITION_IDEMPOTENCY_CONFLICT");
    expect(() => input.service.store.insertTransition({
      entityType: "CAMPAIGN",
      campaignId: campaign.campaignId,
      fromState: "QUALIFYING",
      toState: "PASSED",
      reason: "ILLEGAL_SKIP",
      evidence: {},
      coreCompatibilityHash,
      sourceVersion,
      configVersion: input.manifest.configVersion,
      idempotencyKey: `CAMPAIGN:${campaign.campaignId}:ILLEGAL_SKIP`,
      now: at(1),
    })).toThrow("paper validation campaign transition is illegal");
    input.service.close();
  });

  it("blocks runtime credit when Live Gate changed and returned to disabled", () => {
    const input = fixture();
    const campaign = createCampaign(input);
    const session = startSession(input, campaign.campaignId, 0, "PS-GATE-CHANGED");
    input.service.recordCheckpoint({
      sessionId: session.sessionId,
      checkpointKind: "START",
      observedAt: atMinute(0),
      idempotencyKey: "gate-changed-start",
      evidence: { observeActive: true, paperActive: true, consistencySafe: true },
    });
    cycleLiveGateDuringSession(input, atMinute(1));
    const heartbeat = input.service.recordCheckpoint({
      sessionId: session.sessionId,
      checkpointKind: "HEARTBEAT",
      observedAt: atMinute(1),
      idempotencyKey: "gate-changed-heartbeat",
      evidence: { observeActive: true, paperActive: true, consistencySafe: true },
    });
    expect(heartbeat.consistencySafe).toBe(false);
    expect(heartbeat.liveGateTransitionCount).toBe(session.liveGateTransitionCountAtStart + 2);
    input.service.recordCheckpoint({
      sessionId: session.sessionId,
      checkpointKind: "SAFE_STOP",
      observedAt: atMinute(2),
      idempotencyKey: "gate-changed-stop",
      evidence: { observeActive: true, paperActive: true, consistencySafe: true },
    });
    const finalized = input.service.finalizeSession({
      sessionId: session.sessionId,
      outcome: "SAFE_STOP",
      acceptanceStatus: "PASSED_NATURAL",
      consistencyPassed: true,
      recoveryConfirmed: true,
      stopReason: "TEST_SAFE_STOP",
      blockers: [],
      coverage: {},
      stoppedAt: atMinute(2),
    });
    expect(finalized.session).toMatchObject({
      sessionState: "BLOCKED",
      consistencyPassed: false,
      countsTowardCampaign: false,
      blockers: ["LIVE_GATE_TRANSITION_DURING_SESSION"],
    });
    expect(finalized.campaign.campaignState).toBe("BLOCKED");
    input.service.close();
  });

  it("resumes crash finalization from the already committed recovery checkpoint", () => {
    const input = fixture();
    const campaign = createCampaign(input);
    const session = startSession(input, campaign.campaignId, 0, "PS-SECOND-CRASH");
    input.service.recordCheckpoint({
      sessionId: session.sessionId,
      checkpointKind: "START",
      observedAt: at(0),
      idempotencyKey: "second-crash-start",
      evidence: { observeActive: true, paperActive: true, consistencySafe: true },
    });
    const originalFinalize = input.service.finalizeSession.bind(input.service);
    input.service.finalizeSession = (() => {
      throw new Error("SIMULATED_SECOND_CRASH_AFTER_CHECKPOINT");
    }) as typeof input.service.finalizeSession;
    expect(() => input.service.recoverInterruptedSession({
      campaignId: campaign.campaignId,
      coreManifest: input.manifest,
      sourceVersion,
      observedAt: at(1),
      recoveryConfirmed: true,
      consistencyPassed: true,
      blockers: [],
      checkpointEvidence: { observeActive: false, paperActive: false, consistencySafe: true },
    })).toThrow("SIMULATED_SECOND_CRASH_AFTER_CHECKPOINT");
    input.service.finalizeSession = originalFinalize;

    const recovered = input.service.recoverInterruptedSession({
      campaignId: campaign.campaignId,
      coreManifest: input.manifest,
      sourceVersion,
      observedAt: at(2),
      recoveryConfirmed: false,
      consistencyPassed: false,
      blockers: ["NEW_INPUT_MUST_NOT_OVERRIDE_FROZEN_EVIDENCE"],
      checkpointEvidence: { observeActive: false, paperActive: false, consistencySafe: false },
    });
    expect(recovered?.session).toMatchObject({
      outcome: "CRASH_RECOVERED",
      recoveryConfirmed: true,
      stoppedAt: at(1),
      blockers: [],
    });
    expect(input.service.store.checkpoints(session.sessionId).filter(
      (checkpoint) => checkpoint.checkpointKind === "CRASH_RECOVERY",
    )).toHaveLength(1);
    input.service.close();
  });

  it("qualifies a two-hour session, counts a healthy early pause, and keeps finalize idempotent", () => {
    const input = fixture();
    const campaign = createCampaign(input);
    expect(campaign).toMatchObject({
      state: "QUALIFYING",
      accumulatedActiveRuntimeMs: 0,
      qualified: false,
    });
    const qualifying = startSession(input, campaign.campaignId, 0, "PS-QUALIFYING");
    recordHealthySession(input, qualifying, 0, 2);
    const qualifyingObserveMetrics = observeMetrics(2, 0);
    const finalized = finalizeHealthy(input, qualifying, at(2), {}, qualifyingObserveMetrics);
    expect(finalized.campaign).toMatchObject({
      campaignState: "PAUSED",
      qualified: true,
      accumulatedActiveRuntimeMs: 2 * 60 * 60 * 1_000,
      longestContinuousRuntimeMs: 2 * 60 * 60 * 1_000,
    });
    expect(finalizeHealthy(input, qualifying, at(2), {}, qualifyingObserveMetrics)).toEqual(finalized);

    const earlyPause = startSession(input, campaign.campaignId, 3, "PS-EARLYPAUSE");
    recordHealthySession(input, earlyPause, 3, 1);
    const afterPause = finalizeHealthy(input, earlyPause, at(4), {}, observeMetrics(3, 1));
    expect(afterPause.session.countsTowardCampaign).toBe(true);
    expect(afterPause.campaign.accumulatedActiveRuntimeMs).toBe(3 * 60 * 60 * 1_000);
    expect(afterPause.campaign.operationalMetrics.observe).toMatchObject({
      successfulPolls: 5,
      failedPolls: 1,
      processedEvents: 5,
      emittedSignals: 5,
      duplicateEvents: 10,
      reconciliationCount: 5,
      recoveredApiFailureSessions: 1,
      checkpointRecoveredSessions: 2,
    });
    expect(afterPause.campaign.operationalMetrics.integrity).toMatchObject({
      finalizedSessionCount: 2,
      consistencyPassedSessionCount: 2,
      consistencyFailedSessionCount: 0,
    });
    input.service.close();
  });

  it("counts a safe early qualifying pause without treating it as qualification", () => {
    const input = fixture();
    const campaign = createCampaign(input);
    const qualifying = startSession(input, campaign.campaignId, 0, "PS-Q-EARLY-SAFE");
    recordHealthySession(input, qualifying, 0, 1);
    const paused = input.service.finalizeSession({
      sessionId: qualifying.sessionId,
      outcome: "SAFE_STOP",
      acceptanceStatus: "INCOMPLETE_COVERAGE",
      consistencyPassed: true,
      recoveryConfirmed: true,
      stopReason: "USER_SAFE_PAUSE_SIGTERM",
      blockers: [],
      coverage: {},
      stoppedAt: at(1),
    });
    expect(paused.session).toMatchObject({
      sessionState: "COMPLETED",
      countsTowardCampaign: true,
      acceptanceStatus: "INCOMPLETE_COVERAGE",
    });
    expect(paused.campaign).toMatchObject({
      campaignState: "PAUSED",
      qualified: false,
      accumulatedActiveRuntimeMs: 60 * 60 * 1_000,
      canContinue: true,
    });
    const retry = startSession(input, campaign.campaignId, 2, "PS-Q-EARLY-RETRY");
    expect(retry.sessionKind).toBe("QUALIFYING");
    expect(retry.plannedDurationMs).toBe(2 * 60 * 60 * 1_000);
    input.service.close();
  });

  it("requires one 12-hour session and reaches 72 hours without mixing paused time", () => {
    const input = fixture();
    const campaign = createCampaign(input);
    const qualifying = startSession(input, campaign.campaignId, 0, "PS-Q72");
    recordHealthySession(input, qualifying, 0, 2);
    finalizeHealthy(input, qualifying, at(2));

    let startHour = 3;
    for (let sequence = 1; sequence <= 5; sequence += 1) {
      const session = startSession(input, campaign.campaignId, startHour, `PS-LONG-${sequence}`);
      recordHealthySession(input, session, startHour, 12);
      finalizeHealthy(input, session, at(startHour + 12));
      startHour += 13;
    }
    const finalSession = startSession(input, campaign.campaignId, startHour, "PS-LONG-FINAL");
    expect(finalSession.plannedDurationMs).toBe(10 * 60 * 60 * 1_000);
    recordHealthySession(input, finalSession, startHour, 10);
    const result = finalizeHealthy(input, finalSession, at(startHour + 10), completeCoverage());
    expect(result.campaign).toMatchObject({
      campaignState: "PASSED",
      accumulatedActiveRuntimeMs: 72 * 60 * 60 * 1_000,
      longestContinuousRuntimeMs: 12 * 60 * 60 * 1_000,
      coverageStatus: "COMPLETE",
      canContinue: false,
    });
    input.service.close();
  });

  it("counts only verified pre-crash runtime and never uses it for the 12-hour continuous gate", () => {
    const input = fixture();
    const campaign = createCampaign(input);
    const qualifying = startSession(input, campaign.campaignId, 0, "PS-QCRASH");
    recordHealthySession(input, qualifying, 0, 2);
    finalizeHealthy(input, qualifying, at(2));
    const crashed = startSession(input, campaign.campaignId, 3, "PS-CRASHED");
    input.service.recordCheckpoint({
      sessionId: crashed.sessionId,
      checkpointKind: "START",
      observedAt: at(3),
      idempotencyKey: "crash-start",
      evidence: { observeActive: true, paperActive: true, consistencySafe: true },
    });
    for (let minute = 1; minute <= 120; minute += 1) {
      input.service.recordCheckpoint({
        sessionId: crashed.sessionId,
        checkpointKind: "HEARTBEAT",
        observedAt: atMinute((3 * 60) + minute),
        idempotencyKey: `crash-heartbeat-${minute}`,
        evidence: { observeActive: true, paperActive: true, consistencySafe: true },
      });
    }
    const recovered = input.service.recoverInterruptedSession({
      campaignId: campaign.campaignId,
      coreManifest: input.manifest,
      sourceVersion,
      observedAt: at(8),
      recoveryConfirmed: true,
      consistencyPassed: true,
      blockers: [],
      checkpointEvidence: { observeActive: false, paperActive: false, consistencySafe: true },
    });
    expect(recovered?.session.runtime).toMatchObject({
      effectiveActiveRuntimeMs: 2 * 60 * 60 * 1_000,
      longestHealthySegmentMs: 2 * 60 * 60 * 1_000,
      qualifyingContinuousRuntimeMs: 0,
    });
    expect(recovered?.campaign).toMatchObject({
      campaignState: "PAUSED",
      accumulatedActiveRuntimeMs: 4 * 60 * 60 * 1_000,
      longestContinuousRuntimeMs: 2 * 60 * 60 * 1_000,
    });
    input.service.close();
  });

  it("integrates real process SIGKILL detection with idempotent Campaign service recovery", async () => {
    const input = fixture();
    const campaign = createCampaign(input);
    const qualifying = startSession(input, campaign.campaignId, 0, "PS-SIGKILL-QUALIFYING");
    recordHealthySession(input, qualifying, 0, 2);
    finalizeHealthy(input, qualifying, at(2));

    const crashed = startSession(input, campaign.campaignId, 3, "PS-SIGKILL-RUNTIME");
    input.service.recordCheckpoint({
      sessionId: crashed.sessionId,
      checkpointKind: "START",
      observedAt: atMinute(180),
      idempotencyKey: "sigkill-start",
      evidence: { observeActive: true, paperActive: true, consistencySafe: true },
    });
    input.service.recordCheckpoint({
      sessionId: crashed.sessionId,
      checkpointKind: "HEARTBEAT",
      observedAt: atMinute(181),
      idempotencyKey: "sigkill-heartbeat",
      evidence: { observeActive: true, paperActive: true, consistencySafe: true },
    });

    const child = await spawnCampaignRuntimeWorker(campaign.campaignId, crashed.sessionId);
    expect(child.pid).toBeTypeOf("number");
    expect(findCampaignRuntimeProcesses({
      psOutput: processListing(),
      campaignId: campaign.campaignId,
      sessionId: crashed.sessionId,
      currentPid: process.pid,
    })).toEqual(expect.arrayContaining([
      expect.objectContaining({ pid: child.pid, role: "PAPER" }),
    ]));
    child.kill("SIGKILL");
    await once(child, "exit");
    runtimeChildren.delete(child);

    const checkpoints = input.service.store.checkpoints(crashed.sessionId);
    const prepared = await prepareInterruptedRuntimeRecovery({
      databasePath: input.databasePath,
      snapshot: input.service.campaignSnapshot(campaign.campaignId),
      session: crashed,
      checkpoints,
      sourceVersion,
      observedAt: atMinute(185),
    });
    expect(prepared.decision).toMatchObject({ confirmed: true, blockers: [], lingeringProcesses: [] });
    expect(prepared.cleanup).toMatchObject({
      permitted: true,
      cancelledWaitingBuyCount: 0,
      interruptedObserveRunIds: [],
      blockers: [],
    });

    const recovered = input.service.recoverInterruptedSession({
      campaignId: campaign.campaignId,
      coreManifest: input.manifest,
      sourceVersion,
      observedAt: atMinute(185),
      recoveryConfirmed: prepared.decision.confirmed,
      consistencyPassed: prepared.integrity.passed
        && prepared.acceptance.consistency.passed
        && prepared.checkpointEvidence.consistencySafe,
      blockers: prepared.decision.blockers,
      checkpointEvidence: prepared.checkpointEvidence,
    });
    expect(recovered?.session).toMatchObject({
      sessionState: "CRASH_RECOVERED",
      outcome: "CRASH_RECOVERED",
      recoveryConfirmed: true,
      countsTowardCampaign: true,
      runtime: {
        effectiveActiveRuntimeMs: 60_000,
        longestHealthySegmentMs: 60_000,
        qualifyingContinuousRuntimeMs: 0,
      },
    });
    expect(recovered?.campaign).toMatchObject({
      campaignState: "PAUSED",
      accumulatedActiveRuntimeMs: (2 * 60 * 60 * 1_000) + 60_000,
      longestContinuousRuntimeMs: 2 * 60 * 60 * 1_000,
    });
    expect(input.service.recoverInterruptedSession({
      campaignId: campaign.campaignId,
      coreManifest: input.manifest,
      sourceVersion,
      observedAt: atMinute(186),
      recoveryConfirmed: true,
      consistencyPassed: true,
      blockers: [],
      checkpointEvidence: prepared.checkpointEvidence,
    })).toBeNull();
    expect(input.service.store.sessionReports(campaign.campaignId).filter(
      (report) => report.sessionId === crashed.sessionId,
    )).toHaveLength(1);
    expect(input.service.store.checkpoints(crashed.sessionId).filter(
      (checkpoint) => checkpoint.checkpointKind === "CRASH_RECOVERY",
    )).toHaveLength(1);
    const consumption = input.service.store.database.prepare(
      `SELECT count(*) total,count(DISTINCT signal_id) unique_signals
       FROM paper_signal_consumptions WHERE paper_account_id=?`,
    ).get(input.accountId) as { total: number; unique_signals: number };
    expect(consumption).toEqual({ total: 0, unique_signals: 0 });

    const resumed = input.service.startSession({
      campaignId: campaign.campaignId,
      coreManifest: input.manifest,
      sourceVersion,
      now: atMinute(186),
      sessionId: "PS-AFTER-SIGKILL",
    });
    expect(resumed).toMatchObject({ campaignId: campaign.campaignId, sessionKind: "LONG_RUNNING" });
    input.service.close();
  });

  it("runs production recovery cleanup before conservatively blocking a frozen market", async () => {
    const input = fixture();
    const campaign = createCampaign(input);
    const session = startSession(input, campaign.campaignId, 0, "PS-FROZEN-CLEANUP");
    const seeded = await seedInterruptedRuntimeState(input, atMinute(0));
    input.service.recordCheckpoint({
      sessionId: session.sessionId,
      checkpointKind: "START",
      observedAt: atMinute(0),
      idempotencyKey: "frozen-cleanup-start",
      evidence: collectCheckpointEvidence({
        databasePath: input.databasePath,
        targetId: input.targetId,
        paperAccountId: input.accountId,
        observeActive: true,
        paperActive: true,
      }),
    });
    input.service.recordCheckpoint({
      sessionId: session.sessionId,
      checkpointKind: "HEARTBEAT",
      observedAt: atMinute(1),
      idempotencyKey: "frozen-cleanup-heartbeat",
      evidence: collectCheckpointEvidence({
        databasePath: input.databasePath,
        targetId: input.targetId,
        paperAccountId: input.accountId,
        observeActive: true,
        paperActive: true,
      }),
    });
    const staleBeforeRecovery = input.service.store.database.prepare(
      `SELECT a.reserved_balance_micros account_reserved,
              p.reserved_balance_micros snapshot_reserved
       FROM paper_accounts a
       JOIN paper_portfolio_snapshots p ON p.paper_account_id=a.paper_account_id
       WHERE a.paper_account_id=?
       ORDER BY p.created_at DESC,p.portfolio_snapshot_id DESC LIMIT 1`,
    ).get(input.accountId);
    expect(staleBeforeRecovery).toEqual({ account_reserved: "100", snapshot_reserved: "0" });
    const prepared = await prepareInterruptedRuntimeRecovery({
      databasePath: input.databasePath,
      snapshot: input.service.campaignSnapshot(campaign.campaignId),
      session,
      checkpoints: input.service.store.checkpoints(session.sessionId),
      sourceVersion,
      observedAt: atMinute(2),
      processListing: "",
    });
    expect(prepared.cleanup).toMatchObject({
      permitted: true,
      cancelledWaitingBuyCount: 1,
      interruptedObserveRunIds: [seeded.observeRunId],
      blockers: [],
    });
    expect(prepared.continuity).toMatchObject({ waitingBuyCount: 0, pendingExitCount: 1 });
    expect(prepared.decision.confirmed).toBe(false);
    expect(prepared.decision.blockers).toContain("UNRECOVERED_MARKET_DATA_BLOCKER");
    expect(prepared.decision.blockers).not.toContain("RECOVERY_CURRENT_PORTFOLIO_ACCOUNT_MISMATCH");

    const database = new DatabaseSync(input.databasePath, { readOnly: true });
    expect(database.prepare(
      "SELECT state FROM paper_executions WHERE paper_execution_id=?",
    ).get(seeded.waitingExecutionId)).toEqual({ state: "CANCELLED" });
    expect(database.prepare(
      "SELECT state FROM paper_executions WHERE paper_execution_id=?",
    ).get(seeded.pendingExitExecutionId)).toEqual({ state: "EXIT_PENDING" });
    expect(database.prepare(
      "SELECT status,remaining_amount_micros FROM paper_reservations WHERE reservation_id='PRSV-CRASH'",
    ).get()).toEqual({ status: "RELEASED", remaining_amount_micros: "0" });
    expect(database.prepare(
      "SELECT reserved_balance_micros FROM paper_accounts WHERE paper_account_id=?",
    ).get(input.accountId)).toEqual({ reserved_balance_micros: "0" });
    expect(database.prepare(
      `SELECT reserved_balance_micros FROM paper_portfolio_snapshots
       WHERE paper_account_id=? ORDER BY created_at DESC,portfolio_snapshot_id DESC LIMIT 1`,
    ).get(input.accountId)).toEqual({ reserved_balance_micros: "0" });
    expect(database.prepare(
      "SELECT state,stop_reason FROM observe_runs WHERE observe_run_id=?",
    ).get(seeded.observeRunId)).toEqual({
      state: "INTERRUPTED",
      stop_reason: "PAPER_CAMPAIGN_CRASH_RECOVERY",
    });
    database.close();
    expect(prepared.checkpointEvidence.portfolioProjectionHash)
      .toBe(prepared.continuity.currentPortfolioProjectionHash);

    const blocked = input.service.recoverInterruptedSession({
      campaignId: campaign.campaignId,
      coreManifest: input.manifest,
      sourceVersion,
      observedAt: atMinute(2),
      recoveryConfirmed: prepared.decision.confirmed,
      consistencyPassed: prepared.integrity.passed
        && prepared.acceptance.consistency.passed
        && prepared.checkpointEvidence.consistencySafe,
      blockers: prepared.decision.blockers,
      checkpointEvidence: prepared.checkpointEvidence,
    });
    expect(blocked?.campaign.campaignState).toBe("BLOCKED");
    input.service.close();
  });

  it("never erases a multiple-running-Observe continuity blocker during cleanup", async () => {
    const input = fixture();
    const campaign = createCampaign(input);
    const session = startSession(input, campaign.campaignId, 0, "PS-MULTIPLE-OBSERVE");
    const observeStore = new ObserveStore(input.databasePath, sourceVersion);
    const firstRunId = observeStore.startRun(
      wallet,
      15_000,
      atMinute(0),
      60_000,
      input.baselineRunId,
    ).observeRunId;
    observeStore.close();
    const secondRunId = "OBSERVE-RUN-SECOND";
    input.service.store.database.prepare(
      `INSERT INTO observe_runs(
        observe_run_id,target_id,baseline_run_id,state,recovered_from_checkpoint,
        poll_interval_ms,started_at,last_heartbeat_at,stopped_at,stop_reason,
        successful_polls,failed_polls,processed_events,emitted_signals,duplicate_events,
        gap_events,reconciliation_count,schema_version,signal_version,strategy_version,
        risk_version,ruleset_hash,source_code_commit,source_code_dirty,created_at
      )
      SELECT ?,target_id,baseline_run_id,state,recovered_from_checkpoint,poll_interval_ms,
        started_at,last_heartbeat_at,stopped_at,stop_reason,successful_polls,failed_polls,
        processed_events,emitted_signals,duplicate_events,gap_events,reconciliation_count,
        schema_version,signal_version,strategy_version,risk_version,ruleset_hash,
        source_code_commit,source_code_dirty,created_at
      FROM observe_runs WHERE observe_run_id=?`,
    ).run(secondRunId, firstRunId);
    input.service.recordCheckpoint({
      sessionId: session.sessionId,
      checkpointKind: "START",
      observedAt: atMinute(0),
      idempotencyKey: "multiple-observe-start",
      evidence: collectCheckpointEvidence({
        databasePath: input.databasePath,
        targetId: input.targetId,
        paperAccountId: input.accountId,
        observeActive: true,
        paperActive: true,
      }),
    });
    input.service.recordCheckpoint({
      sessionId: session.sessionId,
      checkpointKind: "HEARTBEAT",
      observedAt: atMinute(1),
      idempotencyKey: "multiple-observe-heartbeat",
      evidence: collectCheckpointEvidence({
        databasePath: input.databasePath,
        targetId: input.targetId,
        paperAccountId: input.accountId,
        observeActive: true,
        paperActive: true,
      }),
    });
    const prepared = await prepareInterruptedRuntimeRecovery({
      databasePath: input.databasePath,
      snapshot: input.service.campaignSnapshot(campaign.campaignId),
      session,
      checkpoints: input.service.store.checkpoints(session.sessionId),
      sourceVersion,
      observedAt: atMinute(2),
      processListing: "",
    });
    expect(prepared.cleanup.interruptedObserveRunIds).toEqual(expect.arrayContaining([firstRunId, secondRunId]));
    expect(prepared.cleanup.interruptedObserveRunIds).toHaveLength(2);
    expect(prepared.decision.confirmed).toBe(false);
    expect(prepared.decision.blockers).toContain("RECOVERY_MULTIPLE_RUNNING_OBSERVE_RUNS");
    input.service.close();
  });

  it("never erases a heartbeat-to-Observe binding mismatch during cleanup", async () => {
    const input = fixture();
    const campaign = createCampaign(input);
    const session = startSession(input, campaign.campaignId, 0, "PS-OBSERVE-BINDING");
    input.service.recordCheckpoint({
      sessionId: session.sessionId,
      checkpointKind: "START",
      observedAt: atMinute(0),
      idempotencyKey: "observe-binding-start",
      evidence: collectCheckpointEvidence({
        databasePath: input.databasePath,
        targetId: input.targetId,
        paperAccountId: input.accountId,
        observeActive: false,
        paperActive: false,
      }),
    });
    const fetchedAt = atMinute(1);
    const capture = <T>(name: string, data: T) => ({
      url: `https://example.test/${name}`,
      fetchedAt,
      latencyMs: 1,
      status: 200,
      data,
    });
    const source: ObserveDataSource = {
      poll: async () => ({
        trades: capture("trades", []),
        activity: capture("activity", []),
        positions: capture("positions", []),
        pUsdBalance: capture("balance", { jsonrpc: "2.0", id: 1, result: "0x0" }),
      }),
    };
    const observeStore = new ObserveStore(input.databasePath, sourceVersion);
    const observe = new ObserveOnlyRunner(observeStore, source, {
      walletAddress: wallet,
      baselineRunId: input.baselineRunId,
      pollIntervalMs: 15_000,
      now: () => new Date(fetchedAt),
      wait: async () => undefined,
    });
    await observe.pollOnce();
    const checkpointRunId = observe.start().observeRunId;
    observeStore.stopRun(checkpointRunId, atMinute(2), "TEST_CHECKPOINT_RUN_COMPLETE");
    const runningRunId = observeStore.startRun(
      wallet,
      15_000,
      atMinute(2),
      60_000,
      input.baselineRunId,
    ).observeRunId;
    observeStore.close();
    input.service.recordCheckpoint({
      sessionId: session.sessionId,
      checkpointKind: "HEARTBEAT",
      observedAt: atMinute(2),
      idempotencyKey: "observe-binding-heartbeat",
      evidence: collectCheckpointEvidence({
        databasePath: input.databasePath,
        targetId: input.targetId,
        paperAccountId: input.accountId,
        observeActive: true,
        paperActive: true,
      }),
    });
    const prepared = await prepareInterruptedRuntimeRecovery({
      databasePath: input.databasePath,
      snapshot: input.service.campaignSnapshot(campaign.campaignId),
      session,
      checkpoints: input.service.store.checkpoints(session.sessionId),
      sourceVersion,
      observedAt: atMinute(3),
      processListing: "",
    });
    expect(prepared.cleanup.interruptedObserveRunIds).toEqual([runningRunId]);
    expect(prepared.decision.confirmed).toBe(false);
    expect(prepared.decision.blockers).toContain("RECOVERY_RUNNING_OBSERVE_BINDING_MISMATCH");
    input.service.close();
  });

  it("blocks an unverified crash and freezes a campaign on core incompatibility", () => {
    const crashInput = fixture();
    const crashCampaign = createCampaign(crashInput);
    const crashed = startSession(crashInput, crashCampaign.campaignId, 0, "PS-UNVERIFIED");
    crashInput.service.recordCheckpoint({
      sessionId: crashed.sessionId,
      checkpointKind: "START",
      observedAt: at(0),
      idempotencyKey: "unverified-start",
      evidence: { observeActive: true, paperActive: true, consistencySafe: true },
    });
    const blocked = crashInput.service.recoverInterruptedSession({
      campaignId: crashCampaign.campaignId,
      coreManifest: crashInput.manifest,
      sourceVersion,
      observedAt: at(1),
      recoveryConfirmed: false,
      consistencyPassed: false,
      blockers: ["RECOVERY_STATE_UNCERTAIN"],
      checkpointEvidence: { observeActive: false, paperActive: false, consistencySafe: false },
    });
    expect(blocked?.campaign.campaignState).toBe("BLOCKED");
    expect(blocked?.session.runtime.effectiveActiveRuntimeMs).toBe(0);
    crashInput.service.close();

    const versionInput = fixture();
    const versionCampaign = createCampaign(versionInput);
    const changedManifest: CoreCompatibilityManifest = {
      ...versionInput.manifest,
      components: { ...versionInput.manifest.components, paperExecution: componentHash("new-paper-core") },
    };
    expect(() => versionInput.service.startSession({
      campaignId: versionCampaign.campaignId,
      coreManifest: changedManifest,
      sourceVersion: { commit: "display-only-new-commit", dirty: false },
      now: at(1),
    })).toThrow("PAPER_VALIDATION_CAMPAIGN_FROZEN");
    expect(versionInput.service.campaignSnapshot(versionCampaign.campaignId).state).toBe("FROZEN");
    versionInput.service.close();
  });

  it("keeps every campaign evidence table immutable", () => {
    const input = fixture();
    const campaign = createCampaign(input);
    const session = startSession(input, campaign.campaignId, 0, "PS-IMMUTABLE");
    recordHealthySession(input, session, 0, 2);
    const finalized = finalizeHealthy(input, session, at(2));
    const checkpointId = input.service.store.latestCheckpoint(session.sessionId)!.checkpointId;
    input.service.close();
    const database = new DatabaseSync(input.databasePath);
    database.exec("PRAGMA foreign_keys=ON");
    database.prepare(
      `INSERT INTO paper_accounts(
        paper_account_id,name,status,initial_balance_micros,cash_balance_micros,
        reserved_balance_micros,realized_pnl_micros,signal_cutoff_at,schema_version,
        strategy_version,risk_version,paper_version,ruleset_snapshot_json,ruleset_hash,
        source_code_commit,source_code_dirty,created_at,updated_at,target_id
      ) SELECT 'campaign-paper-account-2','Second Campaign',status,initial_balance_micros,
        cash_balance_micros,reserved_balance_micros,realized_pnl_micros,signal_cutoff_at,
        schema_version,strategy_version,risk_version,paper_version,ruleset_snapshot_json,
        ruleset_hash,source_code_commit,source_code_dirty,created_at,updated_at,target_id
        FROM paper_accounts WHERE paper_account_id=?`,
    ).run(input.accountId);
    database.prepare(
      `INSERT INTO paper_validation_campaigns(
        campaign_id,target_id,baseline_run_id,paper_account_id,initial_balance_micros,
        required_active_runtime_ms,required_continuous_runtime_ms,qualifying_runtime_ms,
        checkpoint_interval_ms,max_checkpoint_gap_ms,core_compatibility_hash,
        core_manifest_json,schema_version,signal_version,strategy_version,risk_version,
        paper_version,ruleset_hash,config_version,source_code_commit,source_code_dirty,
        execution_mode,live_gate_state,created_at
      ) SELECT 'PC-SECOND',target_id,baseline_run_id,'campaign-paper-account-2',
        initial_balance_micros,required_active_runtime_ms,required_continuous_runtime_ms,
        qualifying_runtime_ms,checkpoint_interval_ms,max_checkpoint_gap_ms,
        core_compatibility_hash,core_manifest_json,schema_version,signal_version,
        strategy_version,risk_version,paper_version,ruleset_hash,config_version,
        source_code_commit,source_code_dirty,execution_mode,live_gate_state,created_at
        FROM paper_validation_campaigns WHERE campaign_id=?`,
    ).run(campaign.campaignId);
    expect(() => database.prepare(
      `INSERT INTO paper_validation_checkpoints(
        checkpoint_id,campaign_id,session_id,sequence,checkpoint_kind,observed_at,
        elapsed_runtime_ms,observe_active,paper_active,consistency_safe,execution_mode,
        live_gate_state,live_gate_transition_count,observe_checkpoint_id,paper_consumer_created_at,
        paper_consumer_signal_id,position_projection_hash,portfolio_projection_hash,
        replay_state,capital_snapshot_id,last_processed_event_id,evidence_json,
        checkpoint_hash,idempotency_key,created_at
      ) SELECT 'cross-campaign-checkpoint','PC-SECOND',session_id,999,checkpoint_kind,
        observed_at,elapsed_runtime_ms,observe_active,paper_active,consistency_safe,
        execution_mode,live_gate_state,live_gate_transition_count,observe_checkpoint_id,
        paper_consumer_created_at,paper_consumer_signal_id,position_projection_hash,
        portfolio_projection_hash,replay_state,capital_snapshot_id,last_processed_event_id,
        evidence_json,checkpoint_hash,'cross-campaign-checkpoint',created_at
        FROM paper_validation_checkpoints WHERE checkpoint_id=?`,
    ).run(checkpointId)).toThrow("FOREIGN KEY constraint failed");
    expect(() => database.prepare(
      `INSERT INTO paper_validation_reports(
        report_id,campaign_id,session_id,report_scope,status,effective_active_runtime_ms,
        longest_continuous_runtime_ms,counts_toward_campaign,coverage_status,report_json,
        report_hash,core_compatibility_hash,source_code_commit,source_code_dirty,
        config_version,idempotency_key,created_at
      ) SELECT 'invalid-campaign-report',campaign_id,session_id,'CAMPAIGN',status,
        effective_active_runtime_ms,longest_continuous_runtime_ms,0,coverage_status,
        report_json,report_hash,core_compatibility_hash,source_code_commit,
        source_code_dirty,config_version,'invalid-campaign-report',created_at
        FROM paper_validation_reports WHERE report_id=?`,
    ).run(finalized.session.reportId)).toThrow();
    for (const [table, idColumn, id] of [
      ["paper_validation_campaigns", "campaign_id", campaign.campaignId],
      ["paper_validation_sessions", "session_id", session.sessionId],
      ["paper_validation_checkpoints", "checkpoint_id", checkpointId],
      ["paper_validation_transitions", "campaign_id", campaign.campaignId],
      ["paper_validation_reports", "report_id", finalized.session.reportId],
    ] satisfies Array<[string, string, string]>) {
      expect(() => database.prepare(`DELETE FROM ${table} WHERE ${idColumn}=?`).run(id))
        .toThrow(`${table} is immutable`);
    }
    database.close();
  });
});
