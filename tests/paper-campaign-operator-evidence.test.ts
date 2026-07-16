import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Phase0Database } from "../src/infra/sqlite/database.js";
import type { SourceVersion } from "../src/infra/source-version.js";
import { PaperAcceptanceSummaryService } from "../src/paper/paper-acceptance-summary.js";
import { PaperExecutor } from "../src/paper/paper-executor.js";
import { PublicPaperMarketDataProvider } from "../src/paper/public-market-data.js";
import {
  evaluateInterruptedSessionRecovery,
  findCampaignRuntimeProcesses,
} from "../src/paper-validation/crash-recovery.js";
import {
  buildIsolatedVerificationEvidence,
  collectCheckpointEvidence,
  deriveSessionCoverage,
  PAPER_CAMPAIGN_ISOLATED_TEST_FILES,
  validateFinalCampaignIntegrity,
  verifyIsolatedVerificationEvidence,
  type ObserveCampaignReport,
  type PaperCampaignReport,
} from "../src/paper-validation/operator-evidence.js";
import type { ValidationCheckpoint } from "../src/paper-validation/types.js";

const directories: string[] = [];
const sourceVersion: SourceVersion = { commit: "operator-evidence-test", dirty: false };
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
  phase0.close();
  const executor = new PaperExecutor(databasePath, new PublicPaperMarketDataProvider(), { sourceVersion });
  const accountId = executor.createAccount("Operator Evidence", 1_000_000_000n, targetId);
  executor.close();
  const acceptance = new PaperAcceptanceSummaryService(databasePath).summarize(accountId);
  return { databasePath, targetId, accountId, acceptance };
}

describe("Paper Campaign operator evidence", () => {
  it("requires a quiescent runtime and consistent database before confirming crash recovery", () => {
    const env = fixture();
    const integrity = validateFinalCampaignIntegrity({
      databasePath: env.databasePath,
      paperAccountId: env.accountId,
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
      paperAccountId: env.accountId,
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

  it("hashes isolated evidence and refuses tampering or a different core", () => {
    const evidence = buildIsolatedVerificationEvidence({
      status: "PASSED",
      coreCompatibilityHash: "a".repeat(64),
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
    expect(verifyIsolatedVerificationEvidence(evidence, "a".repeat(64))).toBe(true);
    expect(verifyIsolatedVerificationEvidence({ ...evidence, coverage: ["BUY"] }, "a".repeat(64))).toBe(false);
    expect(verifyIsolatedVerificationEvidence(evidence, "b".repeat(64))).toBe(false);
    const incompleteTestEvidence = buildIsolatedVerificationEvidence({
      ...evidence,
      testFiles: ["tests/capital-sizing.test.ts"],
    });
    expect(verifyIsolatedVerificationEvidence(incompleteTestEvidence, "a".repeat(64))).toBe(false);
    const prooflessEvidence = buildIsolatedVerificationEvidence({
      ...evidence,
      proofs: { ...evidence.proofs, passedTestFileCount: 0 },
    });
    expect(verifyIsolatedVerificationEvidence(prooflessEvidence, "a".repeat(64))).toBe(false);
    const reasonlessIncomplete = buildIsolatedVerificationEvidence({
      ...evidence,
      replayStatus: "INCOMPLETE_KNOWN_LIMITATIONS",
      proofs: {
        ...evidence.proofs,
        phase0ReplayStatus: "INCOMPLETE_KNOWN_LIMITATIONS",
        acceptedIncompleteReasons: [],
      },
    });
    expect(verifyIsolatedVerificationEvidence(reasonlessIncomplete, "a".repeat(64))).toBe(false);
  });

  it("keeps natural and isolated coverage sources distinct", () => {
    const env = fixture();
    const isolated = buildIsolatedVerificationEvidence({
      status: "PASSED",
      coreCompatibilityHash: "a".repeat(64),
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
