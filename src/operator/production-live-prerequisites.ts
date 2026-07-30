import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { stableJson } from "../domain/versioning.js";
import { resolveSourceVersion, type SourceVersion } from "../infra/source-version.js";
import type { GeoblockProvider } from "../live/live-safety-provider.js";
import { resolveLiveProductionRuntimeIdentity } from "./live-production-build.js";

const ARTIFACT_FILE = "data/operator/live-production-validation.json";
const FINAL_REPORT_FILE = "data/operator/final-reports/ni-k-paper-mixed-core-24h-final-20260727-0300.md";
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
  schemaVersion: "live-production-validation-v2";
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
  finalPaperReportSha256: string;
  isolatedVerificationSha256: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
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
    value.schemaVersion !== "live-production-validation-v2"
    || value.status !== "PASSED"
    || typeof value.sourceCodeCommit !== "string"
    || value.sourceCodeCommit.trim().length === 0
    || typeof value.sourceCodeDirty !== "boolean"
    || typeof value.liveRuntimeHash !== "string"
    || !/^[0-9a-f]{64}$/.test(value.liveRuntimeHash)
    || value.runtimeSourceDirty !== false
    || value.typecheckPassed !== true
    || value.fullTestPassed !== true
    || value.diffCheckPassed !== true
    || typeof value.generatedAt !== "string"
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
  const finalReport = readFileSync(resolve(projectRoot, FINAL_REPORT_FILE), "utf8");
  if (
    !finalReport.includes("OWNER_AUTHORIZED_MIXED_CORE_AGGREGATION")
    || !finalReport.includes("86,400,012 ms")
    || !finalReport.includes("live_gate_state=LIVE_DISABLED")
  ) {
    throw new Error("LIVE_PRODUCTION_FINAL_PAPER_EVIDENCE_INVALID");
  }
  const isolatedReport = readFileSync(resolve(projectRoot, ISOLATED_REPORT_FILE), "utf8");
  const isolated = JSON.parse(isolatedReport) as {
    status?: unknown;
    safety?: { realOrdersCreated?: unknown; chainWrites?: unknown };
  };
  if (
    isolated.status !== "PASSED"
    || isolated.safety?.realOrdersCreated !== 0
    || isolated.safety?.chainWrites !== 0
    || sha256(finalReport) !== value.finalPaperReportSha256
    || sha256(isolatedReport) !== value.isolatedVerificationSha256
  ) {
    throw new Error("LIVE_PRODUCTION_ISOLATED_EVIDENCE_INVALID");
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
        evidenceType: "CURRENT_CODE_AND_OWNER_ACCEPTED_PAPER_VALIDATION",
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
