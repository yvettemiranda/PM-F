import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiCapture } from "../src/adapters/polymarket-public.js";
import { RULESET_HASH, RULESET_SNAPSHOT_JSON, VERSIONS } from "../src/domain/versioning.js";
import { Phase0Database } from "../src/infra/sqlite/database.js";
import type { SourceVersion } from "../src/infra/source-version.js";
import { OperationalLock } from "../src/operational/operational-lock.js";
import { OperationalConsistencyMonitor } from "../src/operational/consistency-monitor.js";
import { OperationalRunner } from "../src/operational/operational-runner.js";
import { OperationalStore } from "../src/operational/operational-store.js";
import {
  buildCurrentCompatibilityEvidence,
  buildCurrentCoreCompatibilityManifest,
  computeCoreCompatibilityHash,
} from "../src/paper-validation/core-compatibility.js";
import { PaperValidationCampaignService } from "../src/paper-validation/service.js";
import { PaperExecutor } from "../src/paper/paper-executor.js";
import { PublicPaperMarketDataProvider } from "../src/paper/public-market-data.js";
import { buildCaptureManifest, captureIdentity } from "../src/services/capture-manifest.js";
import { buildPositionBaseline } from "../src/services/position-baseline.js";
import type { OperationalMode } from "../src/operational/types.js";
import type { ValidationScope } from "../src/validation/scoped-invariants.js";

const directories: string[] = [];
const sourceVersion: SourceVersion = { commit: "operational-test", dirty: false };
const now = () => new Date("2026-07-09T00:00:00.000Z");

function setup(prefix = "ni-k-operational-") {
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
  try {
    return (database.prepare(`SELECT count(*) count FROM ${table}`).get() as { count: number }).count;
  } finally {
    database.close();
  }
}

function scalar<T>(databasePath: string, sql: string): T {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return database.prepare(sql).get() as T;
  } finally {
    database.close();
  }
}

function insertPublishedSignal(databasePath: string): void {
  const database = new DatabaseSync(databasePath);
  const timestamp = now().toISOString();
  database.prepare(
    `INSERT INTO monitor_targets(
      target_id,wallet_address,identity_status,baseline_at,runtime_mode,sync_status,created_at,updated_at
    ) VALUES ('target-operational','0x0000000000000000000000000000000000000001',
      'IDENTITY_CONFIRMED', ?, 'OBSERVE_ONLY', 'SYNCED', ?, ?)`,
  ).run(timestamp, timestamp, timestamp);
  database.prepare(
    `INSERT INTO raw_events(
      source_event_key,target_id,identity_version,source_type,source_transaction_hash,
      source_timestamp,asset_id,condition_id,side,price_units,size_micros,gap_event,
      is_combo,raw_json,created_at,event_classification
    ) VALUES ('source-operational','target-operational','identity-v1','DATA_API_TRADE',
      '0xoperational',1773014400,'asset-operational',?, 'BUY',
      '500000000000000000','10000000',0,0,'{}',?,'STANDARD_TRADE')`,
  ).run(`0x${"7".repeat(64)}`, timestamp);
  database.prepare(
    `INSERT INTO signals(
      signal_id,target_id,signal_idempotency_key,source_event_key,signal_type,status,asset_id,
      condition_id,target_price_units,target_size_micros,sell_ratio_numerator,
      sell_ratio_denominator,reason,schema_version,signal_version,strategy_version,
      risk_version,replay_version,ruleset_snapshot_json,ruleset_hash,source_code_commit,
      created_at,execution_eligible,execution_block_reason,event_classification,
      capital_estimate_id,source_code_dirty,producer_mode
    ) VALUES ('signal-operational','target-operational','idem-operational','source-operational','TARGET_BUY',
      'PUBLISHED','asset-operational',?,'500000000000000000','10000000',NULL,NULL,
      'OPERATIONAL_TEST',?,?,?,?,?,?,?,?,?,1,NULL,'STANDARD_TRADE',NULL,0,'OBSERVE_ONLY')`,
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

function createOperationalValidationScope(databasePath: string): ValidationScope {
  const timestamp = now().toISOString();
  const walletAddress = "0x0000000000000000000000000000000000000002";
  const positionsCapture: ApiCapture<[]> = {
    url: "https://example.test/positions",
    fetchedAt: timestamp,
    latencyMs: 1,
    status: 200,
    data: [],
  };
  const phase0 = new Phase0Database(databasePath, sourceVersion);
  const targetId = phase0.ensureTarget(walletAddress, "IDENTITY_CONFIRMED");
  phase0.saveCapture("data-positions", positionsCapture);
  const captureManifest = buildCaptureManifest({
    walletAddress,
    sampleRole: "TARGET",
    purpose: "OPERATIONAL_SCOPE_TEST",
    sourceVersion,
    sources: [{ endpoint: "data-positions", capture: positionsCapture, paginationStatus: "END_OF_DATA" }],
  });
  phase0.saveCaptureManifest(targetId, captureManifest);
  const baseline = buildPositionBaseline({
    captureRunId: captureManifest.captureRunId,
    targetId,
    walletAddress,
    positionCaptureId: captureIdentity(positionsCapture).captureId,
    fetchedAt: timestamp,
    latencyMs: positionsCapture.latencyMs,
    positions: [],
  });
  phase0.savePositionBaseline(baseline);
  phase0.close();

  const executor = new PaperExecutor(databasePath, new PublicPaperMarketDataProvider(), { sourceVersion, now });
  const accountId = executor.createAccount("Operational Scoped Account", 1_000_000_000n, targetId);
  executor.close();
  const coreManifest = buildCurrentCoreCompatibilityManifest(process.cwd());
  const compatibilityEvidence = buildCurrentCompatibilityEvidence(process.cwd());
  const campaignId = "campaign-explicit";
  const sessionId = "session-explicit";
  const service = new PaperValidationCampaignService(databasePath);
  service.createCampaign({
    campaignId,
    targetId,
    baselineRunId: baseline.baselineRunId,
    paperAccountId: accountId,
    coreManifest,
    compatibilityEvidence,
    sourceVersion,
    now: timestamp,
  });
  service.startSession({
    campaignId,
    sessionId,
    coreManifest,
    compatibilityEvidence,
    sourceVersion,
    now: timestamp,
  });
  service.close();
  return {
    campaignId,
    sessionId,
    accountId,
    targetId,
    baselineRunId: baseline.baselineRunId,
    coreHash: computeCoreCompatibilityHash(coreManifest),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Operational validation framework", () => {
  it("runs health validation on a snapshot and leaves source operational tables unchanged", async () => {
    const env = setup();
    const result = await new OperationalRunner(sourceVersion, now).run({
      sourceDatabasePath: env.databasePath,
      outputDirectory: join(env.directory, "operational"),
      mode: "HEALTH_MONITOR_ONLY",
      durationMs: 0,
      useSnapshot: true,
      wait: async () => {},
    });

    expect(result.liveAllowed).toBe(false);
    expect(result.finalStatus).toBe("OPERATIONAL_FRAMEWORK_READY");
    expect(result.resultStatus).toBe("INCOMPLETE");
    expect(existsSync(result.jsonReportPath)).toBe(true);
    expect(existsSync(result.markdownReportPath)).toBe(true);
    expect(result.workingDatabasePath).not.toBe(env.databasePath);
    expect(count(env.databasePath, "operational_runs")).toBe(0);
    expect(count(result.workingDatabasePath, "operational_runs")).toBe(1);
    expect(count(result.workingDatabasePath, "operational_heartbeats")).toBe(1);
  });

  it("observe operational mode records shadow risk observations without formal risk decisions", async () => {
    const env = setup();
    insertPublishedSignal(env.databasePath);

    const result = await new OperationalRunner(sourceVersion, now).run({
      sourceDatabasePath: env.databasePath,
      outputDirectory: join(env.directory, "operational"),
      mode: "OBSERVE_ONLY_OPERATIONAL",
      durationMs: 0,
      useSnapshot: true,
      wait: async () => {},
    });

    expect(result.finalStatus).toBe("OPERATIONAL_FRAMEWORK_READY");
    expect(result.resultStatus).toBe("INCOMPLETE");
    expect(count(result.workingDatabasePath, "shadow_risk_observations")).toBe(1);
    expect(count(result.workingDatabasePath, "risk_decisions")).toBe(0);
    const observation = scalar<{ result: string; reason: string }>(
      result.workingDatabasePath,
      "SELECT result,reason FROM shadow_risk_observations",
    );
    expect(observation).toEqual({ result: "OBSERVED_ONLY", reason: "OBSERVE_ONLY_NO_EXECUTION" });
  });

  it("paper operational mode uses a dedicated paper account in the snapshot only", async () => {
    const env = setup();
    const result = await new OperationalRunner(sourceVersion, now).run({
      sourceDatabasePath: env.databasePath,
      outputDirectory: join(env.directory, "operational"),
      mode: "PAPER_VALIDATION_OPERATIONAL",
      durationMs: 0,
      useSnapshot: true,
      wait: async () => {},
    });

    expect(result.paperAccountId).toBeTruthy();
    expect(result.finalStatus).toBe("OPERATIONAL_FRAMEWORK_READY");
    expect(result.resultStatus).toBe("INCOMPLETE");
    expect(result.warnings.some((warning) => warning.includes("NO_NEW_PAPER_SIGNAL_CONSUMED"))).toBe(true);
    expect(count(env.databasePath, "paper_accounts")).toBe(0);
    expect(count(result.workingDatabasePath, "paper_accounts")).toBe(1);
    expect(count(result.workingDatabasePath, "operational_paper_bindings")).toBe(1);
    expect(count(result.workingDatabasePath, "paper_cash_ledger")).toBe(1);
    expect(scalar<{ target_id: string | null }>(
      result.workingDatabasePath,
      "SELECT target_id FROM paper_accounts LIMIT 1",
    ).target_id).toMatch(/^operational-paper-target-/);
  });

  it("does not claim crash recovery checks without an explicit Campaign scope", async () => {
    const env = setup();
    const result = await new OperationalRunner(sourceVersion, now).run({
      sourceDatabasePath: env.databasePath,
      outputDirectory: join(env.directory, "operational"),
      mode: "CRASH_RECOVERY_OPERATIONAL",
      durationMs: 0,
      useSnapshot: true,
      wait: async () => {},
    });

    expect(result.finalStatus).toBe("OPERATIONAL_FRAMEWORK_READY");
    expect(count(env.databasePath, "operational_runs")).toBe(0);
    const recoveryChecks = scalar<{ count: number }>(
      result.workingDatabasePath,
      "SELECT count(*) count FROM operational_consistency_checks WHERE check_type LIKE 'CRASH_RECOVERY:%'",
    );
    expect(recoveryChecks.count).toBe(0);
    const scopeChecks = scalar<{ count: number }>(
      result.workingDatabasePath,
      `SELECT count(*) count FROM operational_consistency_checks
       WHERE check_type='PAPER_CONSISTENCY:operational_campaign_scope'
         AND status='SKIPPED' AND reason='EXPLICIT_CAMPAIGN_SCOPE_REQUIRED'`,
    );
    expect(scopeChecks.count).toBe(1);
  });

  it("forwards an explicit Campaign scope to operational consistency validation", async () => {
    const env = setup();
    const scope = createOperationalValidationScope(env.databasePath);
    const monitor = vi.spyOn(OperationalConsistencyMonitor.prototype, "run").mockResolvedValue([]);

    await new OperationalRunner(sourceVersion, now).run({
      sourceDatabasePath: env.databasePath,
      outputDirectory: join(env.directory, "operational"),
      mode: "CRASH_RECOVERY_OPERATIONAL",
      durationMs: 0,
      useSnapshot: true,
      validationScope: scope,
      wait: async () => {},
    });

    expect(monitor).toHaveBeenCalledWith(expect.objectContaining({ scope }));
  });

  it("rejects an Operational Paper account that differs from the validation scope", async () => {
    const env = setup();
    const scope: ValidationScope = {
      campaignId: "campaign-explicit",
      sessionId: "session-explicit",
      accountId: "account-scoped",
      targetId: "target-explicit",
      baselineRunId: "baseline-explicit",
      coreHash: "core-explicit",
    };
    await expect(new OperationalRunner(sourceVersion, now).run({
      sourceDatabasePath: env.databasePath,
      mode: "PAPER_VALIDATION_OPERATIONAL",
      paperAccountId: "account-other",
      validationScope: scope,
      useSnapshot: true,
    })).rejects.toThrow("OPERATIONAL_SCOPE_PAPER_ACCOUNT_MISMATCH");
  });

  it("fails with the original scope error before creating an Operational run", async () => {
    const env = setup();
    const missingScope: ValidationScope = {
      campaignId: "campaign-missing",
      sessionId: "session-missing",
      accountId: "account-missing",
      targetId: "target-missing",
      baselineRunId: "baseline-missing",
      coreHash: "core-missing",
    };
    await expect(new OperationalRunner(sourceVersion, now).run({
      sourceDatabasePath: env.databasePath,
      outputDirectory: join(env.directory, "operational"),
      mode: "CRASH_RECOVERY_OPERATIONAL",
      durationMs: 0,
      useSnapshot: true,
      validationScope: missingScope,
      wait: async () => {},
    })).rejects.toThrow("VALIDATION_SCOPE_NOT_FOUND:campaign-missing:session-missing");
    expect(count(env.databasePath, "operational_runs")).toBe(0);
  });

  it("prevents concurrent operational runners with the same lock key", () => {
    const env = setup();
    const store = new OperationalStore(env.databasePath);
    store.startRun({
      operationalRunId: "run-one",
      validationSessionId: "session-one",
      mode: "HEALTH_MONITOR_ONLY",
      startedAt: now().toISOString(),
      sourceVersion,
      workingDatabasePath: env.databasePath,
      sourceDatabasePath: env.databasePath,
    });
    const lock = new OperationalLock(store, now);
    lock.acquire("operational:HEALTH_MONITOR_ONLY", "run-one");
    expect(() => lock.acquire("operational:HEALTH_MONITOR_ONLY", "run-two")).toThrow(/OPERATIONAL_INSTANCE_ACTIVE/);
    lock.release("operational:HEALTH_MONITOR_ONLY", "run-one");
    store.close();
  });

  it("blocks every operational mode when snapshot isolation is disabled", async () => {
    const env = setup();
    const modes: OperationalMode[] = [
      "OBSERVE_ONLY_OPERATIONAL",
      "PAPER_VALIDATION_OPERATIONAL",
      "HEALTH_MONITOR_ONLY",
      "CONSISTENCY_MONITOR_ONLY",
      "CRASH_RECOVERY_OPERATIONAL",
    ];
    for (const mode of modes) {
      await expect(new OperationalRunner(sourceVersion, now).run({
        sourceDatabasePath: env.databasePath,
        outputDirectory: join(env.directory, "operational"),
        mode,
        durationMs: 0,
        useSnapshot: false,
        wait: async () => {},
      })).rejects.toThrow("OPERATIONAL_SNAPSHOT_REQUIRED");
    }

    expect(count(env.databasePath, "operational_runs")).toBe(0);
    expect(count(env.databasePath, "paper_accounts")).toBe(0);
  });

  it("keeps only the latest consistency cycle in memory while preserving persisted history", async () => {
    const env = setup();
    let tick = 0;
    const advancingNow = () => new Date(Date.parse("2026-07-09T00:00:00.000Z") + tick++);
    const result = await new OperationalRunner(sourceVersion, advancingNow).run({
      sourceDatabasePath: env.databasePath,
      outputDirectory: join(env.directory, "operational"),
      mode: "CONSISTENCY_MONITOR_ONLY",
      durationMs: 100,
      pollIntervalMs: 0,
      useSnapshot: true,
      wait: async () => {},
    });

    const report = JSON.parse(readFileSync(result.jsonReportPath, "utf8")) as {
      consistency: { checks: unknown[] };
    };
    const persistedChecks = count(result.workingDatabasePath, "operational_consistency_checks");
    expect(persistedChecks).toBeGreaterThan(report.consistency.checks.length);
    expect(report.consistency.checks).toEqual([
      expect.objectContaining({
        checkName: "operational_campaign_scope",
        status: "SKIPPED",
        reason: "EXPLICIT_CAMPAIGN_SCOPE_REQUIRED",
      }),
    ]);
  });

  it("closes the operational store when execution fails after the store is opened", async () => {
    const env = setup();
    const close = vi.spyOn(OperationalStore.prototype, "close");

    await expect(new OperationalRunner(sourceVersion, now).run({
      sourceDatabasePath: env.databasePath,
      outputDirectory: join(env.directory, "operational"),
      mode: "INVALID_MODE" as never,
      durationMs: 0,
      useSnapshot: true,
      wait: async () => {},
    })).rejects.toThrow();

    expect(close).toHaveBeenCalledTimes(1);
  });
});
