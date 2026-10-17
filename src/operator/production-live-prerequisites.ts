import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { stableJson } from "../domain/versioning.js";
import { resolveSourceVersion, type SourceVersion } from "../infra/source-version.js";
import type { GeoblockProvider } from "../live/live-safety-provider.js";
import { buildCurrentCoreCompatibilityManifest, computeCoreCompatibilityHash, computeVerificationSuiteHash } from "../paper-validation/core-compatibility.js";
import { verifyIsolatedVerificationEvidence, type IsolatedVerificationEvidence } from "../paper-validation/operator-evidence.js";
import { missingCoverageScenarios } from "../paper-validation/report.js";
import { PAPER_VALIDATION_FINAL_OBSERVE_MS, PAPER_VALIDATION_REQUIRED_ACTIVE_MS, PAPER_VALIDATION_REQUIRED_CONTINUOUS_MS, type CumulativeCoverage } from "../paper-validation/types.js";
import { resolveLiveProductionRuntimeIdentity } from "./live-production-build.js";

const ARTIFACT_FILE = "data/operator/live-production-validation.json";
const ISOLATED_REPORT_FILE = "data/operator/paper-campaign-isolated-verification.json";
const STATIC_PREREQUISITES = [
  "PHASE_1B_PAPER_VALIDATION",
  "OBSERVE_ONLY_8H_SOAK",
  "PAPER_STABILITY",
  "CRASH_RECOVERY_LONG_RUN",
  "LONG_STATE_CONSISTENCY",
  "SOURCE_COMMIT_RECORDED",
  "WORKTREE_STATUS_KNOWN",
] as const;

export interface LiveProductionValidationArtifact {
  schemaVersion: "live-production-validation-v3";
  status: "PASSED";
  sourceCodeCommit: string;
  sourceCodeDirty: boolean;
  liveRuntimeHash: string;
  runtimeSourceDirty: false;
  generatedAt: string;
  typecheckPassed: true;
  fullTestPassed: true;
  testFileCount: number;
  testCount: number;
  diffCheckPassed: true;
  finalPaperReportPath: string;
  observeReportPath: string;
  isolatedVerificationPath: string;
  coreCompatibilityHash: string;
  verificationSuiteHash: string;
  targetWallet: string;
  finalPaperReportSha256: string;
  observeReportSha256: string;
  isolatedVerificationSha256: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export interface LiveProductionEvidencePaths {
  finalPaperReportPath: string;
  observeReportPath: string;
  isolatedVerificationPath: string;
}

export function liveProductionEvidencePathsFromArguments(args: readonly string[]): LiveProductionEvidencePaths {
  const allowed = new Set(["paper-report", "observe-report", "isolated-verification"]);
  const values = new Map<string, string>();
  for (const argument of args) {
    const match = /^--([^=]+)=(.+)$/.exec(argument);
    if (!match || !allowed.has(match[1]!) || !match[2]!.trim() || values.has(match[1]!)) {
      throw new Error("LIVE_PRODUCTION_VALIDATION_ARGUMENT_INVALID");
    }
    values.set(match[1]!, match[2]!);
  }
  if (!values.has("paper-report") || !values.has("observe-report")) {
    throw new Error("LIVE_PRODUCTION_VALIDATION_EVIDENCE_PATHS_REQUIRED:--paper-report and --observe-report");
  }
  return { finalPaperReportPath: values.get("paper-report")!, observeReportPath: values.get("observe-report")!,
    isolatedVerificationPath: values.get("isolated-verification") ?? ISOLATED_REPORT_FILE };
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function empty(value: unknown): boolean { return Array.isArray(value) && value.length === 0; }
function integer(value: unknown, minimum = 0): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}
function nonempty(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function timestamp(value: unknown): number { return typeof value === "string" ? Date.parse(value) : Number.NaN; }
function readEvidence(projectRoot: string, path: string): { path: string; content: string; value: Record<string, unknown> } {
  if (!nonempty(path) || path.includes("\\")) throw new Error("LIVE_PRODUCTION_EVIDENCE_PATH_INVALID");
  const root = realpathSync(projectRoot);
  const absolute = resolve(root, path);
  const local = relative(root, absolute);
  if (!local || isAbsolute(local) || local === ".." || local.startsWith(`..${sep}`)) throw new Error("LIVE_PRODUCTION_EVIDENCE_PATH_OUTSIDE_PROJECT");
  const actual = relative(root, realpathSync(absolute));
  if (isAbsolute(actual) || actual === ".." || actual.startsWith(`..${sep}`)) throw new Error("LIVE_PRODUCTION_EVIDENCE_PATH_OUTSIDE_PROJECT");
  const content = readFileSync(absolute, "utf8");
  return { path: local.split(sep).join("/"), content, value: object(JSON.parse(content)) };
}

/** Revalidate native campaign, Observe and isolated-proof artifacts; never infer acceptance from report prose. */
export function readLiveProductionValidationEvidence(input: LiveProductionEvidencePaths & {
  projectRoot: string; sourceCodeCommit: string;
}): LiveProductionEvidencePaths & {
  coreCompatibilityHash: string; verificationSuiteHash: string; targetWallet: string;
  finalPaperReportSha256: string; observeReportSha256: string; isolatedVerificationSha256: string;
} {
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(input.sourceCodeCommit)) {
    throw new Error("LIVE_PRODUCTION_EVIDENCE_SOURCE_INVALID");
  }
  const paperFile = readEvidence(input.projectRoot, input.finalPaperReportPath);
  const observeFile = readEvidence(input.projectRoot, input.observeReportPath);
  const isolatedFile = readEvidence(input.projectRoot, input.isolatedVerificationPath);
  const coreCompatibilityHash = computeCoreCompatibilityHash(buildCurrentCoreCompatibilityManifest(input.projectRoot));
  const verificationSuiteHash = computeVerificationSuiteHash(input.projectRoot);
  const paper = paperFile.value;
  const campaign = object(paper.campaign);
  const source = object(campaign.sourceVersion);
  const safety = object(paper.safety);
  const integrity = object(paper.latestIntegrity);
  const scoped = object(integrity.scopedInvariants);
  const integrityCounters = ["foreignKeyIssueCount", "gapExecutionViolationCount", "unfollowedNegativeRiskConversionCount",
    "duplicateConsumptionCount", "duplicateOrderIdempotencyCount", "duplicateFillIdempotencyCount"];
  const scopeCounters = ["scopeBindingViolationCount", "executionRiskDecisionViolationCount", "reusedRiskDecisionCount",
    "stateTransitionMissingCount", "stateTransitionMismatchCount", "stateTransitionChainViolationCount",
    "transitionAuditViolationCount", "riskDecisionAuditViolationCount"];
  let coverageComplete = false;
  try { coverageComplete = missingCoverageScenarios(campaign.coverage as CumulativeCoverage).length === 0; } catch { /* invalid coverage fails closed */ }
  if (campaign.campaignState !== "PASSED" || campaign.qualified !== true || campaign.coverageStatus !== "COMPLETE"
    || !nonempty(campaign.reportId) || !nonempty(campaign.campaignId) || !nonempty(campaign.afterSessionId)
    || paper.reportId !== campaign.reportId || paper.campaignId !== campaign.campaignId
    || paper.latestSessionReportId === undefined || !nonempty(paper.latestSessionReportId)
    || !integer(campaign.completedSessionCount, 1) || !empty(campaign.missingScenarios) || !empty(campaign.blockers) || !coverageComplete
    || !integer(campaign.accumulatedActiveRuntimeMs, PAPER_VALIDATION_REQUIRED_ACTIVE_MS)
    || !integer(campaign.longestContinuousRuntimeMs, PAPER_VALIDATION_REQUIRED_CONTINUOUS_MS)
    || campaign.longestContinuousRuntimeMs > campaign.accumulatedActiveRuntimeMs
    || !Number.isFinite(timestamp(campaign.createdAt))
    || paper.sourceCodeCommit !== input.sourceCodeCommit || source.commit !== input.sourceCodeCommit || source.dirty !== false
    || paper.coreCompatibilityHash !== coreCompatibilityHash || campaign.coreCompatibilityHash !== coreCompatibilityHash
    || safety.executionMode !== "PAPER" || safety.liveGateState !== "LIVE_DISABLED" || safety.liveAllowed !== false
    || integrity.passed !== true || !empty(integrity.blockers) || integrity.integrityCheck !== "ok"
    || integrity.executionMode !== "PAPER" || integrity.liveGateState !== "LIVE_DISABLED"
    || integrityCounters.some(key => integrity[key] !== 0) || scoped.passed !== true || !empty(scoped.blockers)
    || scopeCounters.some(key => scoped[key] !== 0)) throw new Error("LIVE_PRODUCTION_FINAL_PAPER_EVIDENCE_INVALID");
  const observe = observeFile.value;
  const metrics = object(observe.metrics);
  const observeSafety = object(observe.safety);
  const acceptance = object(observe.acceptance);
  const targetWallet = typeof observe.target === "string" ? observe.target.toLowerCase() : "";
  const elapsed = timestamp(metrics.stoppedAt) - timestamp(metrics.startedAt);
  if (observe.mode !== "OBSERVE_ONLY" || observe.sourceCodeCommit !== input.sourceCodeCommit || observe.sourceCodeDirty !== false
    || !/^0x[0-9a-f]{40}$/.test(targetWallet) || !nonempty(metrics.observeRunId) || !nonempty(metrics.baselineRunId)
    || !integer(metrics.activeRuntimeMs, PAPER_VALIDATION_FINAL_OBSERVE_MS) || !integer(metrics.durationMs, metrics.activeRuntimeMs)
    || !Number.isFinite(elapsed) || elapsed < metrics.activeRuntimeMs
    || metrics.schedulingGapCount !== 0 || metrics.gapEvents !== 0 || metrics.majorDesyncCount !== 0
    || metrics.unrecoveredConnectionGap !== false || metrics.checkpointProjectionHashMismatch !== false
    || metrics.stateDriftDetected !== false || metrics.finalSyncStatus !== "SYNCED" || !integer(metrics.successfulPolls, 1)
    || acceptance.observeStatus !== "SHORT_SOAK_PASSED" || acceptance.liveStabilityEligible !== true
    || !empty(acceptance.liveStabilityBlockers)
    || observeSafety.privateKeyLoaded !== false || observeSafety.orderLogicPresent !== false || observeSafety.ordersCreated !== 0
    || observeSafety.executionMode !== null
    || observe.campaignId !== null && observe.campaignId !== campaign.campaignId) throw new Error("LIVE_PRODUCTION_OBSERVE_EVIDENCE_INVALID");
  let isolatedValid = false;
  try {
    isolatedValid = isolatedFile.value.sourceCodeCommit === input.sourceCodeCommit
      && verifyIsolatedVerificationEvidence(isolatedFile.value as unknown as IsolatedVerificationEvidence,
        coreCompatibilityHash, verificationSuiteHash, targetWallet);
  } catch { /* malformed isolated proofs fail closed */ }
  if (!isolatedValid) throw new Error("LIVE_PRODUCTION_ISOLATED_EVIDENCE_INVALID");
  return { finalPaperReportPath: paperFile.path, observeReportPath: observeFile.path,
    isolatedVerificationPath: isolatedFile.path, coreCompatibilityHash, verificationSuiteHash, targetWallet,
    finalPaperReportSha256: sha256(paperFile.content), observeReportSha256: sha256(observeFile.content),
    isolatedVerificationSha256: sha256(isolatedFile.content) };
}

function readValidatedArtifact(
  projectRoot: string,
  sourceVersion: SourceVersion,
): LiveProductionValidationArtifact {
  const runtimeIdentity = resolveLiveProductionRuntimeIdentity(projectRoot, sourceVersion);
  if (runtimeIdentity.runtimeSourceDirty) {
    throw new Error("LIVE_PRODUCTION_RUNTIME_SOURCE_DIRTY");
  }
  const path = resolve(projectRoot, ARTIFACT_FILE);
  if (!existsSync(path)) throw new Error("LIVE_PRODUCTION_VALIDATION_ARTIFACT_MISSING");
  const value = JSON.parse(readFileSync(path, "utf8")) as Partial<LiveProductionValidationArtifact>;
  if (
    value.schemaVersion !== "live-production-validation-v3"
    || value.status !== "PASSED"
    || typeof value.sourceCodeCommit !== "string"
    || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(value.sourceCodeCommit)
    || typeof value.sourceCodeDirty !== "boolean"
    || typeof value.liveRuntimeHash !== "string"
    || !/^[0-9a-f]{64}$/.test(value.liveRuntimeHash)
    || value.runtimeSourceDirty !== false
    || value.typecheckPassed !== true
    || value.fullTestPassed !== true
    || value.diffCheckPassed !== true
    || !Number.isFinite(timestamp(value.generatedAt))
    || !nonempty(value.finalPaperReportPath) || !nonempty(value.observeReportPath) || !nonempty(value.isolatedVerificationPath)
    || !/^[0-9a-f]{64}$/.test(value.finalPaperReportSha256 ?? "")
    || !/^[0-9a-f]{64}$/.test(value.observeReportSha256 ?? "")
    || !/^[0-9a-f]{64}$/.test(value.isolatedVerificationSha256 ?? "")
    || !Number.isSafeInteger(value.testFileCount)
    || Number(value.testFileCount) <= 0
    || !Number.isSafeInteger(value.testCount)
    || Number(value.testCount) <= 0
  ) {
    throw new Error("LIVE_PRODUCTION_VALIDATION_ARTIFACT_INVALID");
  }
  if (value.liveRuntimeHash !== runtimeIdentity.liveRuntimeHash) {
    throw new Error("LIVE_PRODUCTION_RUNTIME_HASH_MISMATCH");
  }
  const evidence = readLiveProductionValidationEvidence({ projectRoot, sourceCodeCommit: value.sourceCodeCommit!,
    finalPaperReportPath: value.finalPaperReportPath!, observeReportPath: value.observeReportPath!,
    isolatedVerificationPath: value.isolatedVerificationPath! });
  for (const key of ["coreCompatibilityHash", "verificationSuiteHash", "targetWallet", "finalPaperReportSha256",
    "observeReportSha256", "isolatedVerificationSha256"] as const) {
    if (value[key] !== evidence[key]) throw new Error("LIVE_PRODUCTION_EVIDENCE_BINDING_MISMATCH");
  }
  return value as LiveProductionValidationArtifact;
}

export function liveProductionValidationArtifactPath(projectRoot: string): string {
  return resolve(projectRoot, ARTIFACT_FILE);
}

/**
 * Returns the exact source identity whose runtime behavior passed validation.
 * A documentation-only commit or pure CSS edit may leave that validated
 * behavior unchanged; executable/runtime changes require a new artifact.
 */
export function validatedLiveProductionSourceVersion(
  projectRoot: string,
  sourceVersion: SourceVersion = resolveSourceVersion(projectRoot),
): SourceVersion {
  const artifact = readValidatedArtifact(projectRoot, sourceVersion);
  return { commit: artifact.sourceCodeCommit, dirty: false };
}

export class ProductionLivePrerequisiteManager {
  constructor(private readonly input: {
    projectRoot: string;
    databasePath: string;
    sourceVersion: SourceVersion;
    geoblockProvider: GeoblockProvider;
    walletAddress: string;
    now?: () => Date;
  }) {}

  refreshStaticEvidence(): void {
    const artifact = readValidatedArtifact(this.input.projectRoot, this.input.sourceVersion);
    const database = this.database();
    try {
      const common = {
        evidenceType: "CURRENT_CODE_AND_VERIFIED_PAPER_VALIDATION",
        checkedAt: artifact.generatedAt,
        sourceCodeCommit: artifact.sourceCodeCommit,
        liveRuntimeHash: artifact.liveRuntimeHash,
        environment: "PRODUCTION",
        testOnly: false,
        validationMode: "NO_WALLET_NO_REAL_ORDERS",
        testFileCount: artifact.testFileCount,
        testCount: artifact.testCount,
        finalPaperReportSha256: artifact.finalPaperReportSha256,
        isolatedVerificationSha256: artifact.isolatedVerificationSha256,
        observeReportSha256: artifact.observeReportSha256,
        coreCompatibilityHash: artifact.coreCompatibilityHash,
        verificationSuiteHash: artifact.verificationSuiteHash,
        targetWallet: artifact.targetWallet,
        evidencePaths: { paper: artifact.finalPaperReportPath, observe: artifact.observeReportPath, isolated: artifact.isolatedVerificationPath },
      };
      database.exec("BEGIN IMMEDIATE");
      for (const key of STATIC_PREREQUISITES) {
        this.pass(database, key, { ...common, prerequisite: key }, artifact.generatedAt);
      }
      database.exec("COMMIT");
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // Keep the original evidence error.
      }
      throw error;
    } finally {
      database.close();
    }
  }

  async authorizeActivation(input: { actor: string; reason: string }): Promise<void> {
    this.refreshStaticEvidence();
    const actor = input.actor.trim();
    const reason = input.reason.trim();
    if (!actor || !reason) throw new Error("LIVE_USER_AUTHORIZATION_EVIDENCE_INVALID");
    const geoblock = await this.input.geoblockProvider.check({
      walletAddress: this.input.walletAddress,
      network: "POLYGON",
    });
    if (
      geoblock.status !== "ALLOWED"
      || geoblock.checkedAt === null
      || geoblock.source === null
    ) {
      throw new Error(geoblock.reason ?? "LIVE_GEOBLOCK_EVIDENCE_UNAVAILABLE");
    }
    const checkedAt = (this.input.now ?? (() => new Date()))().toISOString();
    const database = this.database();
    try {
      database.exec("BEGIN IMMEDIATE");
      this.pass(database, "GEOBLOCK_COMPLIANCE", {
        evidenceType: "OFFICIAL_POLYMARKET_GEOBLOCK",
        checkedAt: geoblock.checkedAt,
        sourceCodeCommit: this.input.sourceVersion.commit,
        environment: "PRODUCTION",
        testOnly: false,
        source: geoblock.source,
        ip: geoblock.ip ?? null,
        country: geoblock.country ?? null,
        region: geoblock.region ?? null,
      }, checkedAt);
      this.pass(database, "USER_EXPLICIT_AUTHORIZATION", {
        evidenceType: "OPERATOR_LIVE_ACTIVATION_REQUEST",
        checkedAt,
        sourceCodeCommit: this.input.sourceVersion.commit,
        environment: "PRODUCTION",
        testOnly: false,
        actor,
        reason,
        walletAddress: this.input.walletAddress,
      }, checkedAt);
      database.exec("COMMIT");
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // Keep the original authorization error.
      }
      throw error;
    } finally {
      database.close();
    }
  }

  private database(): DatabaseSync {
    const database = new DatabaseSync(this.input.databasePath);
    database.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;");
    return database;
  }

  private pass(
    database: DatabaseSync,
    key: string,
    evidence: Record<string, unknown>,
    updatedAt: string,
  ): void {
    const changed = database.prepare(
      `UPDATE live_gate_prerequisites
       SET status='PASSED',evidence_json=?,updated_at=?
       WHERE prerequisite_key=?`,
    ).run(stableJson(evidence), updatedAt, key);
    if (changed.changes !== 1) throw new Error(`LIVE_PREREQUISITE_NOT_FOUND:${key}`);
  }
}
