import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { RULESET_HASH, VERSIONS, stableJson } from "../domain/versioning.js";
import type { SourceVersion } from "../infra/source-version.js";
import type {
  FinalReadinessStatus,
  ValidationArtifact,
  ValidationCheckResult,
  ValidationRunReport,
  ValidationSessionStatus,
  ValidationType,
} from "./types.js";
import type { ValidationScope } from "./scoped-invariants.js";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function statusFor(checks: ValidationCheckResult[]): { status: ValidationSessionStatus; finalReadinessStatus: FinalReadinessStatus } {
  const hasBlockingFailure = checks.some((check) => check.blocking && check.status === "FAIL");
  if (hasBlockingFailure) return { status: "FAILED", finalReadinessStatus: "VALIDATION_FAILED" };
  return { status: "PASSED", finalReadinessStatus: "VALIDATION_FRAMEWORK_READY" };
}

function counts(checks: ValidationCheckResult[]): Record<string, number> {
  return checks.reduce<Record<string, number>>((accumulator, check) => {
    accumulator[check.status] = (accumulator[check.status] ?? 0) + 1;
    return accumulator;
  }, {});
}

export function buildValidationReport(input: {
  sessionId: string;
  validationType: ValidationType;
  startedAt: string;
  finishedAt: string;
  sourceVersion: SourceVersion;
  inputSnapshotHash: string;
  dbSnapshotHash: string;
  checks: ValidationCheckResult[];
  scope: ValidationScope;
}): ValidationRunReport {
  const state = statusFor(input.checks);
  const blockingFailures = input.checks
    .filter((check) => check.blocking && check.status === "FAIL")
    .map((check) => `${check.checkType}:${check.checkName}:${check.reason}`);
  const warnings = input.checks
    .filter((check) => check.status === "WARN" || check.status === "SKIPPED" || check.status === "NOT_RUN")
    .map((check) => `${check.checkType}:${check.checkName}:${check.reason}`);
  const resultStatus = state.status === "FAILED" ? "FAIL" : warnings.length > 0 ? "INCOMPLETE" : "PASS";
  const reportWithoutHash = {
    scope: input.scope,
    session: {
      id: input.sessionId,
      validationType: input.validationType,
      status: state.status,
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
    },
    system: {
      sourceCommit: input.sourceVersion.commit,
      sourceDirty: input.sourceVersion.dirty,
      schemaVersion: VERSIONS.schemaVersion,
      configVersion: VERSIONS.configVersion,
      rulesetHash: RULESET_HASH,
      validationVersion: VERSIONS.validationVersion,
      inputSnapshotHash: input.inputSnapshotHash,
      dbSnapshotHash: input.dbSnapshotHash,
      reportHash: "",
    },
    checks: input.checks,
    monitoring: counts(input.checks.filter((check) => check.checkType === "OBSERVE_ONLY")),
    execution: counts(input.checks.filter((check) => check.checkType === "PAPER_REPLAY" || check.checkType === "LIVE_GATE")),
    risk: counts(input.checks.filter((check) => check.checkName.toLowerCase().includes("risk"))),
    consistency: counts(input.checks.filter((check) => check.checkType === "PAPER_CONSISTENCY" || check.checkType === "RECONCILIATION")),
    recovery: counts(input.checks.filter((check) => check.checkType === "CRASH_RECOVERY")),
    liveGate: counts(input.checks.filter((check) => check.checkType === "LIVE_GATE")),
    finalResult: {
      status: resultStatus,
      finalReadinessStatus: state.finalReadinessStatus,
      liveAllowed: false,
      blockingFailures,
      warnings,
    },
  } satisfies ValidationRunReport;
  const reportHash = sha256(stableJson({ ...reportWithoutHash, system: { ...reportWithoutHash.system, reportHash: "" } }));
  return {
    ...reportWithoutHash,
    system: {
      ...reportWithoutHash.system,
      reportHash,
    },
  };
}

export function writeValidationReports(input: {
  outputDirectory: string;
  sessionId: string;
  report: ValidationRunReport;
}): { artifacts: ValidationArtifact[]; jsonPath: string; markdownPath: string } {
  const sessionDirectory = resolve(input.outputDirectory, input.sessionId);
  mkdirSync(sessionDirectory, { recursive: true });
  const jsonPath = join(sessionDirectory, "validation-report.json");
  const markdownPath = join(sessionDirectory, "validation-report.md");
  writeFileSync(jsonPath, `${JSON.stringify(input.report, null, 2)}\n`);
  writeFileSync(markdownPath, markdownReport(input.report));
  return {
    jsonPath,
    markdownPath,
    artifacts: [
      {
        artifactType: "VALIDATION_REPORT_JSON",
        artifactPath: jsonPath,
        artifactSha256: sha256File(jsonPath),
        contentType: "application/json",
      },
      {
        artifactType: "VALIDATION_REPORT_MARKDOWN",
        artifactPath: markdownPath,
        artifactSha256: sha256File(markdownPath),
        contentType: "text/markdown",
      },
    ],
  };
}

function markdownReport(report: ValidationRunReport): string {
  const failures = report.finalResult.blockingFailures.length === 0
    ? "- None"
    : report.finalResult.blockingFailures.map((item) => `- ${item}`).join("\n");
  const warnings = report.finalResult.warnings.length === 0
    ? "- None"
    : report.finalResult.warnings.map((item) => `- ${item}`).join("\n");
  const checks = report.checks
    .map((check) => `| ${check.checkType} | ${check.checkName} | ${check.status} | ${check.blocking ? "yes" : "no"} | ${check.reason} |`)
    .join("\n");
  return `# Validation Report

## System

- Session: ${report.session.id}
- Type: ${report.session.validationType}
- Status: ${report.session.status}
- Commit: ${report.system.sourceCommit}
- Dirty: ${report.system.sourceDirty}
- Schema: ${report.system.schemaVersion}
- Config: ${report.system.configVersion}
- Ruleset: ${report.system.rulesetHash}
- Validation: ${report.system.validationVersion}
- Report Hash: ${report.system.reportHash}

## Campaign Scope

- Campaign: ${report.scope.campaignId}
- Campaign Session: ${report.scope.sessionId}
- Paper Account: ${report.scope.accountId}
- Target: ${report.scope.targetId}
- Baseline: ${report.scope.baselineRunId}
- Core Compatibility Hash: ${report.scope.coreHash}

## Final Result

- Status: ${report.finalResult.status}
- Readiness: ${report.finalResult.finalReadinessStatus}
- Live Allowed: ${report.finalResult.liveAllowed}

## Blocking Failures

${failures}

## Warnings

${warnings}

## Checks

| Type | Name | Status | Blocking | Reason |
| --- | --- | --- | --- | --- |
${checks}
`;
}
