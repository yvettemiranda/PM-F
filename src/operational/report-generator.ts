import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { RULESET_HASH, VERSIONS, stableJson } from "../domain/versioning.js";
import type { SourceVersion } from "../infra/source-version.js";
import type { ValidationCheckResult } from "../validation/types.js";
import { PAPER_VALIDATION_FINAL_OBSERVE_MS } from "../paper-validation/types.js";
import type { OperationalReport, OperationalRunStatus, OperationalMode } from "./types.js";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function countRows(database: DatabaseSync, sql: string, ...params: SQLInputValue[]): number {
  return (database.prepare(sql).get(...params) as { count: number }).count;
}

function counts(checks: ValidationCheckResult[]): Record<string, number> {
  return checks.reduce<Record<string, number>>((accumulator, check) => {
    accumulator[check.status] = (accumulator[check.status] ?? 0) + 1;
    return accumulator;
  }, {});
}

export function buildOperationalReport(input: {
  databasePath: string;
  operationalRunId: string;
  validationSessionId: string;
  mode: OperationalMode;
  status: OperationalRunStatus;
  startedAt: string;
  stoppedAt: string;
  runtimeDurationMs: number;
  sourceVersion: SourceVersion;
  sourceDatabasePath: string;
  workingDatabasePath: string;
  checks: ValidationCheckResult[];
}): OperationalReport {
  const database = new DatabaseSync(input.databasePath, { readOnly: true });
  try {
    const criticalAnomalyCount = countRows(database, "SELECT count(*) count FROM operational_anomalies WHERE operational_run_id=? AND severity='CRITICAL' AND status='OPEN'", input.operationalRunId);
    const errorAnomalyCount = countRows(database, "SELECT count(*) count FROM operational_anomalies WHERE operational_run_id=? AND severity='ERROR' AND status='OPEN'", input.operationalRunId);
    const anomalyCount = countRows(database, "SELECT count(*) count FROM operational_anomalies WHERE operational_run_id=?", input.operationalRunId);
    const heartbeatCount = countRows(database, "SELECT count(*) count FROM operational_heartbeats WHERE operational_run_id=?", input.operationalRunId);
    const checkpointCount = countRows(database, "SELECT count(*) count FROM operational_checkpoints WHERE operational_run_id=?", input.operationalRunId);
    const shadowRiskCount = countRows(database, "SELECT count(*) count FROM shadow_risk_observations WHERE operational_run_id=?", input.operationalRunId);
    const paperBindings = database.prepare("SELECT paper_account_id,binding_reason FROM operational_paper_bindings WHERE operational_run_id=?")
      .all(input.operationalRunId) as unknown[];
    const paperConsumptionCount = countRows(
      database,
      "SELECT count(*) count FROM paper_signal_consumptions WHERE consumed_at>=? AND consumed_at<=?",
      input.startedAt,
      input.stoppedAt,
    );
    const paperOrderCount = countRows(
      database,
      "SELECT count(*) count FROM paper_orders WHERE created_at>=? AND created_at<=?",
      input.startedAt,
      input.stoppedAt,
    );
    const paperFillCount = countRows(
      database,
      "SELECT count(*) count FROM paper_fill_ledger WHERE created_at>=? AND created_at<=?",
      input.startedAt,
      input.stoppedAt,
    );
    const formalRiskDecisionCount = countRows(
      database,
      "SELECT count(*) count FROM risk_decisions WHERE created_at>=? AND created_at<=?",
      input.startedAt,
      input.stoppedAt,
    );
    const blockingFailures = input.checks
      .filter((check) => check.status === "FAIL" && check.blocking)
      .map((check) => `${check.checkType}:${check.checkName}:${check.reason}`);
    if (criticalAnomalyCount > 0) blockingFailures.push(`OPERATIONAL:CRITICAL_ANOMALY:${criticalAnomalyCount}`);
    if (errorAnomalyCount > 0) blockingFailures.push(`OPERATIONAL:ERROR_ANOMALY:${errorAnomalyCount}`);
    const warnings = input.checks
      .filter((check) => check.status === "WARN" || check.status === "SKIPPED" || check.status === "NOT_RUN")
      .map((check) => `${check.checkType}:${check.checkName}:${check.reason}`);
    if (input.runtimeDurationMs < PAPER_VALIDATION_FINAL_OBSERVE_MS) warnings.push("OPERATIONAL:LONG_SOAK_NOT_RUN");
    const finalStatus = blockingFailures.length === 0 ? "OPERATIONAL_FRAMEWORK_READY" : "OPERATIONAL_FAILED";
    const resultStatus = blockingFailures.length > 0 ? "FAIL" : warnings.length > 0 ? "INCOMPLETE" : "PASS";
    const reportWithoutHash = {
      run: {
        id: input.operationalRunId,
        validationSessionId: input.validationSessionId,
        mode: input.mode,
        status: input.status,
        startedAt: input.startedAt,
        stoppedAt: input.stoppedAt,
        runtimeDurationMs: input.runtimeDurationMs,
      },
      system: {
        sourceCommit: input.sourceVersion.commit,
        sourceDirty: input.sourceVersion.dirty,
        schemaVersion: VERSIONS.schemaVersion,
        configVersion: VERSIONS.configVersion,
        rulesetHash: RULESET_HASH,
        operationalVersion: VERSIONS.operationalVersion,
        sourceDatabasePath: input.sourceDatabasePath,
        workingDatabasePath: input.workingDatabasePath,
        reportHash: "",
      },
      runtime: {
        heartbeatCount,
        anomalyCount,
        criticalAnomalyCount,
        errorAnomalyCount,
        checkpointCount,
      },
      monitoring: {
        shadowRiskObservationCount: shadowRiskCount,
      },
      execution: {
        paperBindings,
        paperConsumptionCount,
        paperOrderCount,
        paperFillCount,
      },
      risk: {
        shadowRiskObservationCount: shadowRiskCount,
        formalRiskDecisionCount,
      },
      consistency: {
        checks: input.checks,
        counts: counts(input.checks),
      },
      recovery: {
        crashRecoveryChecks: input.checks.filter((check) => check.checkType === "CRASH_RECOVERY").length,
      },
      finalResult: {
        status: resultStatus,
        finalStatus,
        liveAllowed: false,
        blockingFailures,
        warnings,
      },
    } satisfies OperationalReport;
    const reportHash = sha256(stableJson({ ...reportWithoutHash, system: { ...reportWithoutHash.system, reportHash: "" } }));
    return {
      ...reportWithoutHash,
      system: {
        ...reportWithoutHash.system,
        reportHash,
      },
    };
  } finally {
    database.close();
  }
}

export function writeOperationalReports(input: {
  outputDirectory: string;
  operationalRunId: string;
  report: OperationalReport;
}): { jsonPath: string; markdownPath: string; jsonHash: string; markdownHash: string } {
  const runDirectory = resolve(input.outputDirectory, input.operationalRunId);
  mkdirSync(runDirectory, { recursive: true });
  const jsonPath = join(runDirectory, "operational-report.json");
  const markdownPath = join(runDirectory, "operational-report.md");
  writeFileSync(jsonPath, `${JSON.stringify(input.report, null, 2)}\n`);
  writeFileSync(markdownPath, markdownReport(input.report));
  return {
    jsonPath,
    markdownPath,
    jsonHash: sha256File(jsonPath),
    markdownHash: sha256File(markdownPath),
  };
}

function markdownReport(report: OperationalReport): string {
  const failures = report.finalResult.blockingFailures.length === 0
    ? "- None"
    : report.finalResult.blockingFailures.map((item) => `- ${item}`).join("\n");
  const warnings = report.finalResult.warnings.length === 0
    ? "- None"
    : report.finalResult.warnings.map((item) => `- ${item}`).join("\n");
  const checks = report.consistency.checks
    .map((check) => `| ${check.checkType} | ${check.checkName} | ${check.status} | ${check.blocking ? "yes" : "no"} | ${check.reason} |`)
    .join("\n");
  return `# Operational Validation Report

## System

- Run: ${report.run.id}
- Mode: ${report.run.mode}
- Status: ${report.run.status}
- Commit: ${report.system.sourceCommit}
- Dirty: ${report.system.sourceDirty}
- Schema: ${report.system.schemaVersion}
- Config: ${report.system.configVersion}
- Ruleset: ${report.system.rulesetHash}
- Operational Version: ${report.system.operationalVersion}
- Report Hash: ${report.system.reportHash}

## Final Result

- Status: ${report.finalResult.status}
- Operational Status: ${report.finalResult.finalStatus}
- Live Allowed: ${report.finalResult.liveAllowed}

## Blocking Failures

${failures}

## Warnings

${warnings}

## Runtime

- Heartbeats: ${report.runtime.heartbeatCount}
- Checkpoints: ${report.runtime.checkpointCount}
- Anomalies: ${report.runtime.anomalyCount}
- Errors: ${report.runtime.errorAnomalyCount}
- Critical: ${report.runtime.criticalAnomalyCount}

## Checks

| Type | Name | Status | Blocking | Reason |
| --- | --- | --- | --- | --- |
${checks}
`;
}
