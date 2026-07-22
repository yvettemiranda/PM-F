import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { RULESET_HASH, VERSIONS } from "../src/domain/versioning.js";
import { Phase0Database } from "../src/infra/sqlite/database.js";
import type { SourceVersion } from "../src/infra/source-version.js";
import { PaperAcceptanceSummaryService } from "../src/paper/paper-acceptance-summary.js";
import { PaperExecutor } from "../src/paper/paper-executor.js";
import { PublicPaperMarketDataProvider } from "../src/paper/public-market-data.js";
import { buildCaptureManifest, captureIdentity } from "../src/services/capture-manifest.js";
import { buildPositionBaseline } from "../src/services/position-baseline.js";
import type { ValidationScope } from "../src/validation/scoped-invariants.js";
import {
  evaluateInterruptedSessionRecovery,
  findCampaignRuntimeProcesses,
} from "../src/paper-validation/crash-recovery.js";
import {
  buildIsolatedVerificationEvidence,
  deriveSessionCoverage,
  PAPER_CAMPAIGN_ISOLATED_TEST_FILES,
  verifyIsolatedVerificationEvidence,
  type ObserveCampaignReport,
  type PaperCampaignReport,
} from "../src/paper-validation/operator-evidence.js";
import { collectCheckpointEvidence } from "../src/paper-validation/checkpoint-evidence.js";
import { validateFinalCampaignIntegrity } from "../src/paper-validation/final-integrity.js";
import type { ValidationCheckpoint } from "../src/paper-validation/types.js";

const directories: string[] = [];
const sourceVersion: SourceVersion = { commit: "operator-evidence-test", dirty: false };
const verificationSuiteHash = "d".repeat(64);
const compatibilityIdentity = {
  validationPolicyHash: "a".repeat(64),
  verificationSuiteHash,
  operatorBuildHash: "b".repeat(64),
  artifactProvenanceHash: "c".repeat(64),
};
const proofHashes = (passedTestFileCount: number) => ({
  vitestResultSha256: "1".repeat(64),
  phase0ResultSha256: "2".repeat(64),
  replayResultSha256: "3".repeat(64),
  captureRunId: "4".repeat(64),
  replayHash: "5".repeat(64),
  phase0ReplayStatus: "PASSED" as const,
  acceptedIncompleteReasons: [],
  passedTestFileCount,
  passedTestCount: 1,
});

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "ni-k-campaign-operator-evidence-"));
  directories.push(directory);
  const databasePath = join(directory, "phase0.sqlite");
  const phase0 = new Phase0Database(databasePath, sourceVersion);
  phase0.initialize();
  const targetId = phase0.ensureTarget(
    "0x0000000000000000000000000000000000000001",
    "IDENTITY_CONFIRMED",
  );
  const capture = {
    url: "https://example.test/positions",
    fetchedAt: "2026-07-16T00:00:00.000Z",
    latencyMs: 1,
    status: 200,
    data: [],
  };
  phase0.saveCapture("data-positions", capture);
  const manifest = buildCaptureManifest({
    walletAddress: "0x0000000000000000000000000000000000000001",
    sampleRole: "TARGET",
    purpose: "OPERATOR_EVIDENCE_TEST",
    sourceVersion,
    sources: [{ endpoint: "data-positions", capture, paginationStatus: "END_OF_DATA" }],
  });
  phase0.saveCaptureManifest(targetId, manifest);
  const baseline = buildPositionBaseline({
    captureRunId: manifest.captureRunId,
    targetId,
    walletAddress: "0x0000000000000000000000000000000000000001",
    positionCaptureId: captureIdentity(capture).captureId,
    fetchedAt: capture.fetchedAt,
    latencyMs: capture.latencyMs,
    positions: [],
  });
  phase0.savePositionBaseline(baseline);
  phase0.close();
  const executor = new PaperExecutor(databasePath, new PublicPaperMarketDataProvider(), { sourceVersion });
  const accountId = executor.createAccount("Operator Evidence", 1_000_000_000n, targetId);
  executor.close();
  const scope = insertScope(databasePath, targetId, baseline.baselineRunId, accountId);
  const acceptance = new PaperAcceptanceSummaryService(databasePath).summarize(accountId);
  return { databasePath, targetId, accountId, scope, acceptance };
}

function insertScope(
  databasePath: string,
  targetId: string,
  baselineRunId: string,
  accountId: string,
): ValidationScope {
  const database = new DatabaseSync(databasePath);
  const campaignId = "PC-operator-evidence";
  const sessionId = "PS-operator-evidence";
  const coreHash = "core-operator-evidence";
  database.prepare(
    `INSERT INTO paper_validation_campaigns(
      campaign_id,target_id,baseline_run_id,paper_account_id,initial_balance_micros,
      required_active_runtime_ms,required_continuous_runtime_ms,qualifying_runtime_ms,
      checkpoint_interval_ms,max_checkpoint_gap_ms,core_compatibility_hash,core_manifest_json,
      schema_version,signal_version,strategy_version,risk_version,paper_version,ruleset_hash,
      config_version,source_code_commit,source_code_dirty,execution_mode,live_gate_state,created_at
    ) VALUES (?,?,?,?,'1000000000',259200000,43200000,7200000,60000,90000,?,'{}',
      ?,?,?,?,?,?,?,?,0,'PAPER','LIVE_DISABLED','2026-07-16T00:00:00.000Z')`,
  ).run(
    campaignId,
    targetId,
    baselineRunId,
    accountId,
    coreHash,
    VERSIONS.schemaVersion,
    VERSIONS.signalVersion,
    VERSIONS.strategyVersion,
    VERSIONS.riskVersion,
    VERSIONS.paperVersion,
    RULESET_HASH,
    VERSIONS.configVersion,
    sourceVersion.commit,
  );
  database.prepare(
    `INSERT INTO paper_validation_sessions(
      session_id,campaign_id,sequence,session_kind,planned_duration_ms,core_compatibility_hash,
      schema_version,ruleset_hash,config_version,source_code_commit,source_code_dirty,
      validation_policy_hash,verification_suite_hash,operator_build_hash,artifact_provenance_hash,
      live_gate_transition_count_at_start,started_at,created_at
    ) VALUES (?,?,1,'QUALIFYING',7200000,?,?,?,?,?,0,?,?,?,?,0,
      '2026-07-16T00:00:00.000Z','2026-07-16T00:00:00.000Z')`,
  ).run(
    sessionId,
    campaignId,
    coreHash,
    VERSIONS.schemaVersion,
    RULESET_HASH,
    VERSIONS.configVersion,
    sourceVersion.commit,
    compatibilityIdentity.validationPolicyHash,
    compatibilityIdentity.verificationSuiteHash,
    compatibilityIdentity.operatorBuildHash,
    compatibilityIdentity.artifactProvenanceHash,
  );
  database.close();
  return { campaignId, sessionId, accountId, targetId, baselineRunId, coreHash };
}

describe("Paper Campaign operator evidence", () => {
  it("requires a quiescent runtime and consistent database before confirming crash recovery", () => {
    const env = fixture();
    const integrity = validateFinalCampaignIntegrity({
      databasePath: env.databasePath,
      scope: env.scope,
      acceptance: env.acceptance,
    });
    const checkpoint = {
      checkpointId: "checkpoint",
      campaignId: "PC-1",
      sessionId: "PS-1",
      sequence: 1,
      checkpointKind: "HEARTBEAT",
      observedAt: "2026-07-16T00:01:00.000Z",
      elapsedRuntimeMs: 60_000,
      observeActive: true,
      paperActive: true,
      consistencySafe: true,
      executionMode: "PAPER",
      liveGateState: "LIVE_DISABLED",
      liveGateTransitionCount: 0,
      checkpointHash: "a".repeat(64),
      idempotencyKey: "checkpoint",
      evidence: { observeActive: true, paperActive: true, consistencySafe: true },
    } satisfies ValidationCheckpoint;
    const currentEvidence = collectCheckpointEvidence({
      databasePath: env.databasePath,
      targetId: env.targetId,
      paperAccountId: env.accountId,
      observeActive: false,
      paperActive: false,
    });
    expect(evaluateInterruptedSessionRecovery({
      checkpoints: [checkpoint],
      currentEvidence,
      integrity,
      acceptance: env.acceptance,
      lingeringProcesses: [],
    })).toMatchObject({ confirmed: true, blockers: [] });

    const processes = findCampaignRuntimeProcesses({
      psOutput: [
        " 100 node /repo/src/cli/paper-campaign-run.ts --operator-owner-token=old",
        " 101 node /repo/src/cli/paper-run.ts --campaign-id=PC-1 --session-id=PS-1",
        " 102 node /repo/src/cli/observe-only.ts --campaign-id=OTHER --session-id=OTHER",
      ].join("\n"),
      campaignId: "PC-1",
      sessionId: "PS-1",
      currentPid: 999,
    });
    expect(processes.map((process) => process.role)).toEqual(["SUPERVISOR", "PAPER"]);
    expect(evaluateInterruptedSessionRecovery({
      checkpoints: [checkpoint],
      currentEvidence,
      integrity,
      acceptance: env.acceptance,
      lingeringProcesses: processes,
    })).toMatchObject({ confirmed: false });
  });

  it("collects a fail-closed checkpoint and validates a clean Paper database", () => {
    const env = fixture();
    const checkpoint = collectCheckpointEvidence({
      databasePath: env.databasePath,
      targetId: env.targetId,
      paperAccountId: env.accountId,
      observeActive: true,
      paperActive: true,
    });
    expect(checkpoint).toMatchObject({
      observeActive: true,
      paperActive: true,
      consistencySafe: true,
      observeCheckpointId: null,
    });
    const integrity = validateFinalCampaignIntegrity({
      databasePath: env.databasePath,
      scope: env.scope,
      acceptance: env.acceptance,
    });
    expect(integrity).toMatchObject({
      passed: true,
      blockers: [],
      integrityCheck: "ok",
      foreignKeyIssueCount: 0,
      gapExecutionViolationCount: 0,
      executionMode: "PAPER",
      liveGateState: "LIVE_DISABLED",
    });
  });

  it("blocks Campaign completion when a tracked negative-risk conversion cannot be executed", () => {
    const env = fixture();
    const database = new DatabaseSync(env.databasePath);
    database.prepare(
      `INSERT INTO observe_runs(
        observe_run_id,target_id,baseline_run_id,state,recovered_from_checkpoint,
        poll_interval_ms,started_at,last_heartbeat_at,stopped_at,stop_reason,
        schema_version,signal_version,strategy_version,risk_version,ruleset_hash,
        source_code_commit,source_code_dirty,created_at,campaign_id,campaign_session_id
      ) VALUES ('observe-conversion',?,?, 'COMPLETED',0,15000,?,?,?,'TEST_COMPLETE',
        ?,?,?,?,?,?,0,?,?,?)`,
    ).run(
      env.targetId,
      env.scope.baselineRunId,
      "2026-07-16T00:01:00.000Z",
      "2026-07-16T00:01:00.000Z",
      "2026-07-16T00:02:00.000Z",
      VERSIONS.schemaVersion,
      "observe-v1.1.0",
      VERSIONS.strategyVersion,
      VERSIONS.riskVersion,
      RULESET_HASH,
      sourceVersion.commit,
      "2026-07-16T00:01:00.000Z",
      env.scope.campaignId,
      env.scope.sessionId,
    );
    database.prepare(
      `INSERT INTO raw_events(
        source_event_key,target_id,identity_version,source_type,source_transaction_hash,
        source_timestamp,asset_id,condition_id,side,price_units,size_micros,
        gap_event,is_combo,raw_json,created_at,event_classification
      ) VALUES ('conversion-event',?,'activity-v1','DATA_API_ACTIVITY',?,1,'100',?,
        'NONE','0','0',0,1,'{}',?,'COMBO_ACTIVITY')`,
    ).run(
      env.targetId,
      `0x${"3".repeat(64)}`,
      `0x${"4".repeat(64)}`,
      "2026-07-16T00:01:00.000Z",
    );
    database.prepare(
      `INSERT INTO signals(
        signal_id,target_id,signal_idempotency_key,source_event_key,signal_type,status,
        asset_id,condition_id,target_price_units,target_size_micros,
        sell_ratio_numerator,sell_ratio_denominator,reason,schema_version,
        signal_version,strategy_version,risk_version,replay_version,
        ruleset_snapshot_json,ruleset_hash,source_code_commit,created_at,
        execution_eligible,execution_block_reason,event_classification,
        source_code_dirty,producer_mode,baseline_run_id,observe_run_id
      ) VALUES ('signal-conversion',?,'signal-conversion','conversion-event',
        'TARGET_CONVERSION','PUBLISHED','100',?,'0','10000000','6000000','6000000',
        'TRACKED_NEGATIVE_RISK_CONVERSION_RECORDED',?,?,?,?,?,'{}',?,?,?,0,
        'NEGATIVE_RISK_CONVERSION_EXECUTION_UNAVAILABLE','NEGATIVE_RISK_CONVERSION',
        0,'OBSERVE_ONLY',?,'observe-conversion')`,
    ).run(
      env.targetId,
      `0x${"4".repeat(64)}`,
      VERSIONS.schemaVersion,
      VERSIONS.signalVersion,
      VERSIONS.strategyVersion,
      VERSIONS.riskVersion,
      VERSIONS.replayVersion,
      RULESET_HASH,
      sourceVersion.commit,
      "2026-07-16T00:01:00.000Z",
      env.scope.baselineRunId,
    );
    database.close();

    const integrity = validateFinalCampaignIntegrity({
      databasePath: env.databasePath,
      scope: env.scope,
      acceptance: env.acceptance,
    });
    expect(integrity).toMatchObject({
      passed: false,
      unfollowedNegativeRiskConversionCount: 1,
    });
    expect(integrity.blockers).toContain("UNFOLLOWED_NEGATIVE_RISK_CONVERSION:1");
  });

  it("hashes isolated evidence and refuses tampering or a different core", () => {
    const evidence = buildIsolatedVerificationEvidence({
      status: "PASSED",
      coreCompatibilityHash: "a".repeat(64),
      verificationSuiteHash,
      sourceCodeCommit: "commit",
      generatedAt: "2026-07-16T00:00:00.000Z",
      coverage: ["MIN_ORDER_REJECT", "CRASH_RECOVERY"],
      testFiles: [...PAPER_CAMPAIGN_ISOLATED_TEST_FILES],
      replayStatus: "PASSED",
      proofs: proofHashes(PAPER_CAMPAIGN_ISOLATED_TEST_FILES.length),
      safety: {
        executionMode: "PAPER",
        liveGateState: "LIVE_DISABLED",
        privateKeyLoaded: false,
        authenticatedTradingClientPresent: false,
        realOrdersCreated: 0,
        chainWrites: 0,
      },
    });
    expect(verifyIsolatedVerificationEvidence(evidence, "a".repeat(64), verificationSuiteHash)).toBe(true);
    expect(verifyIsolatedVerificationEvidence(
      { ...evidence, coverage: ["BUY"] },
      "a".repeat(64),
      verificationSuiteHash,
    )).toBe(false);
    expect(verifyIsolatedVerificationEvidence(evidence, "b".repeat(64), verificationSuiteHash)).toBe(false);
    expect(verifyIsolatedVerificationEvidence(
      evidence,
      "a".repeat(64),
      "e".repeat(64),
    )).toBe(false);
    const incompleteTestEvidence = buildIsolatedVerificationEvidence({
      ...evidence,
      testFiles: ["tests/capital-sizing.test.ts"],
    });
    expect(verifyIsolatedVerificationEvidence(
      incompleteTestEvidence,
      "a".repeat(64),
      verificationSuiteHash,
    )).toBe(false);
    const prooflessEvidence = buildIsolatedVerificationEvidence({
      ...evidence,
      proofs: { ...evidence.proofs, passedTestFileCount: 0 },
    });
    expect(verifyIsolatedVerificationEvidence(
      prooflessEvidence,
      "a".repeat(64),
      verificationSuiteHash,
    )).toBe(false);
    const reasonlessIncomplete = buildIsolatedVerificationEvidence({
      ...evidence,
      replayStatus: "INCOMPLETE_KNOWN_LIMITATIONS",
      proofs: {
        ...evidence.proofs,
        phase0ReplayStatus: "INCOMPLETE_KNOWN_LIMITATIONS",
        acceptedIncompleteReasons: [],
      },
    });
    expect(verifyIsolatedVerificationEvidence(
      reasonlessIncomplete,
      "a".repeat(64),
      verificationSuiteHash,
    )).toBe(false);
  });

  it("keeps natural and isolated coverage sources distinct", () => {
    const env = fixture();
    const isolated = buildIsolatedVerificationEvidence({
      status: "PASSED",
      coreCompatibilityHash: "a".repeat(64),
      verificationSuiteHash,
      sourceCodeCommit: "commit",
      generatedAt: "2026-07-16T00:00:00.000Z",
      coverage: ["MIN_ORDER_REJECT", "CRASH_RECOVERY"],
      testFiles: ["tests/market-order-constraints.test.ts"],
      replayStatus: "PASSED",
      proofs: proofHashes(1),
      safety: {
        executionMode: "PAPER",
        liveGateState: "LIVE_DISABLED",
        privateKeyLoaded: false,
        authenticatedTradingClientPresent: false,
        realOrdersCreated: 0,
        chainWrites: 0,
      },
    });
    const paper = {
      mode: "PAPER",
      status: "COMPLETED",
      shutdownMode: "FINAL_VALUATION",
      sourceCodeCommit: "commit",
      sourceCodeDirty: false,
      campaignId: "PC-1",
      sessionId: "PS-1",
      marketClockOffsetMs: 1_700,
      finalDrainConsumedSignals: 0,
      report: {
        startedAt: "2026-07-16T00:00:00.000Z",
        stoppedAt: "2026-07-16T02:00:00.000Z",
        errorCount: 0,
        account: { valuationStatus: "COMPLETE", unpricedPositionCount: 0 },
        acceptance: env.acceptance,
      },
      safety: {
        privateKeyLoaded: false,
        authenticatedTradingClientPresent: false,
        realOrdersCreated: 0,
        chainWrites: 0,
        liveExecutorPresent: false,
      },
    } satisfies PaperCampaignReport;
    const observe = {
      mode: "OBSERVE_ONLY",
      sourceCodeCommit: "commit",
      sourceCodeDirty: false,
      campaignId: "PC-1",
      sessionId: "PS-1",
      marketClockOffsetMs: 1_700,
      baselineRunId: "baseline-1",
      metrics: {
        observeRunId: "internal",
        baselineRunId: "baseline-1",
        activeRuntimeMs: 7_200_000,
        processedEvents: 1,
        emittedSignals: 1,
        successfulPolls: 10,
        failedPolls: 0,
        gapEvents: 0,
        duplicateEvents: 0,
        reconciliationCount: 10,
        majorDesyncCount: 0,
        minorDiffCount: 0,
        schedulingGapCount: 0,
        finalSyncStatus: "SYNCED",
        unrecoveredConnectionGap: false,
        checkpointProjectionHashMismatch: false,
        checkpointRecovered: true,
      },
      acceptance: { observeStatus: "SHORT_SOAK_PASSED" },
      safety: { privateKeyLoaded: false, ordersCreated: 0 },
    } satisfies ObserveCampaignReport;
    const coverage = deriveSessionCoverage({
      sessionId: "PS-1",
      sequence: 1,
      paper,
      observe,
      isolated,
    });
    expect(coverage.SAFE_STOP?.source).toBe("NATURAL");
    expect(coverage.RECONCILIATION?.source).toBe("NATURAL");
    expect(coverage.MIN_ORDER_REJECT?.source).toBe("ISOLATED_CONTROLLED");
    expect(coverage.CRASH_RECOVERY?.source).toBe("ISOLATED_CONTROLLED");
    expect(coverage.ORDER).toBeUndefined();

    const withoutCheckpointRecovery = deriveSessionCoverage({
      sessionId: "PS-2",
      sequence: 2,
      paper,
      observe: {
        ...observe,
        sessionId: "PS-2",
        metrics: { ...observe.metrics, checkpointRecovered: false },
      },
      isolated,
    });
    expect(withoutCheckpointRecovery.RESTART_RECOVERY).toBeUndefined();
    const withCheckpointRecovery = deriveSessionCoverage({
      sessionId: "PS-2",
      sequence: 2,
      paper,
      observe: { ...observe, sessionId: "PS-2" },
      isolated,
    });
    expect(withCheckpointRecovery.RESTART_RECOVERY).toMatchObject({
      source: "NATURAL",
      reason: "CAMPAIGN_RESUMED_WITH_OBSERVE_CHECKPOINT",
    });
  });
});
