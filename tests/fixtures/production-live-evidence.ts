/** Synthetic acceptance artifacts for isolated tests only. Always write beneath a test-owned temporary root. */
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCurrentCoreCompatibilityManifest, computeCoreCompatibilityHash, computeVerificationSuiteHash } from "../../src/paper-validation/core-compatibility.js";
import { buildIsolatedVerificationEvidence, PAPER_CAMPAIGN_ISOLATED_TEST_FILES } from "../../src/paper-validation/operator-evidence.js";
import { PAPER_VALIDATION_SCENARIOS } from "../../src/paper-validation/types.js";
import { readLiveProductionValidationEvidence } from "../../src/operator/production-live-prerequisites.js";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const wallet = "0x0000000000000000000000000000000000000001";

export function copyProductionEvidenceTestSources(root: string): void {
  for (const path of ["src", "tests", "package.json", "pnpm-lock.yaml", "tsconfig.json"]) {
    cpSync(join(project, path), join(root, path), { recursive: true });
  }
}

export function writeProductionEvidenceTestArtifacts(root: string, sourceCodeCommit: string) {
  const coreCompatibilityHash = computeCoreCompatibilityHash(buildCurrentCoreCompatibilityManifest(root));
  const verificationSuiteHash = computeVerificationSuiteHash(root);
  const zeroScope = Object.fromEntries(["scopeBindingViolationCount", "executionRiskDecisionViolationCount", "reusedRiskDecisionCount",
    "stateTransitionMissingCount", "stateTransitionMismatchCount", "stateTransitionChainViolationCount",
    "transitionAuditViolationCount", "riskDecisionAuditViolationCount"].map((key) => [key, 0]));
  const campaign = {
    reportId: "test-campaign-report", campaignId: "test-campaign", afterSessionId: "test-final-session",
    campaignState: "PASSED", qualified: true, accumulatedActiveRuntimeMs: 86_401_000,
    longestContinuousRuntimeMs: 28_801_000, completedSessionCount: 3, coverageStatus: "COMPLETE",
    coverage: Object.fromEntries(PAPER_VALIDATION_SCENARIOS.map((name) => [name, {
      covered: true, source: "NATURAL", evidenceId: `test:${name}`, reason: "ISOLATED_TEST_FIXTURE",
    }])), missingScenarios: [] as string[], blockers: [] as string[], sourceVersion: { commit: sourceCodeCommit, dirty: false },
    coreCompatibilityHash, createdAt: "2026-07-28T04:00:00.000Z",
  };
  const paper = { reportId: campaign.reportId, campaignId: campaign.campaignId, sourceCodeCommit,
    coreCompatibilityHash, latestSessionReportId: "test-final-report", campaign,
    latestIntegrity: { passed: true, blockers: [], integrityCheck: "ok", foreignKeyIssueCount: 0,
      gapExecutionViolationCount: 0, unfollowedNegativeRiskConversionCount: 0, duplicateConsumptionCount: 0,
      duplicateOrderIdempotencyCount: 0, duplicateFillIdempotencyCount: 0, executionMode: "PAPER", liveGateState: "LIVE_DISABLED",
      scopedInvariants: { passed: true, blockers: [], ...zeroScope } },
    safety: { executionMode: "PAPER", liveGateState: "LIVE_DISABLED", liveAllowed: false } };
  const observe = { mode: "OBSERVE_ONLY", target: wallet, sourceCodeCommit, sourceCodeDirty: false,
    campaignId: null, sessionId: null, generatedAt: "2026-07-28T04:00:00.000Z",
    metrics: { observeRunId: "test-observe", baselineRunId: "test-baseline", startedAt: "2026-07-27T19:59:59.000Z",
      stoppedAt: "2026-07-28T04:00:00.000Z", durationMs: 28_801_000, activeRuntimeMs: 28_801_000,
      schedulingGapCount: 0, gapEvents: 0, majorDesyncCount: 0, successfulPolls: 28_800,
      unrecoveredConnectionGap: false, checkpointProjectionHashMismatch: false, stateDriftDetected: false, finalSyncStatus: "SYNCED" },
    acceptance: { observeStatus: "SHORT_SOAK_PASSED", liveStabilityEligible: true, liveStabilityBlockers: [] },
    safety: { privateKeyLoaded: false, orderLogicPresent: false, ordersCreated: 0, executionMode: null } };
  const isolated = buildIsolatedVerificationEvidence({ status: "PASSED", targetWallet: wallet,
    coreCompatibilityHash, verificationSuiteHash, sourceCodeCommit, generatedAt: "2026-07-28T04:00:00.000Z",
    coverage: [...PAPER_VALIDATION_SCENARIOS], testFiles: [...PAPER_CAMPAIGN_ISOLATED_TEST_FILES], replayStatus: "PASSED",
    proofs: { vitestResultSha256: "1".repeat(64), phase0ResultSha256: "2".repeat(64), replayResultSha256: "3".repeat(64),
      captureRunId: "4".repeat(64), replayHash: "5".repeat(64), targetWallet: wallet, phase0ReplayStatus: "PASSED",
      acceptedIncompleteReasons: [], passedTestFileCount: PAPER_CAMPAIGN_ISOLATED_TEST_FILES.length, passedTestCount: 900 },
    safety: { executionMode: "PAPER", liveGateState: "LIVE_DISABLED", privateKeyLoaded: false,
      authenticatedTradingClientPresent: false, realOrdersCreated: 0, chainWrites: 0 } });
  const paths = { finalPaperReportPath: "data/operator/campaigns/current/campaign-report.json",
    observeReportPath: "data/observe/current-eight-hour-report.json",
    isolatedVerificationPath: "data/operator/paper-campaign-isolated-verification.json" };
  for (const [path, value] of [[paths.finalPaperReportPath, paper], [paths.observeReportPath, observe], [paths.isolatedVerificationPath, isolated]] as const) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), JSON.stringify(value));
  }
  const evidence = readLiveProductionValidationEvidence({ projectRoot: root, sourceCodeCommit, ...paths });
  return { paths, evidence, paper, observe, isolated,
    read(path: string) { return JSON.parse(readFileSync(join(root, path), "utf8")) as Record<string, unknown>; } };
}
