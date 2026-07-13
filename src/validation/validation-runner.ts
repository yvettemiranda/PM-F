import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { resolveSourceVersion, type SourceVersion } from "../infra/source-version.js";
import { pruneCompletedRunSnapshots } from "../infra/run-snapshot-retention.js";
import { prepareValidationDatabaseSnapshot } from "./database-snapshot.js";
import { buildValidationReport, writeValidationReports } from "./report-generator.js";
import { CrashRecoveryValidation } from "./crash-recovery-validation.js";
import { LiveGateValidation } from "./live-gate-validation.js";
import { ObserveOnlyValidation } from "./observe-only-validation.js";
import { PaperConsistencyValidation } from "./paper-consistency-validation.js";
import { PaperReplayValidation } from "./paper-replay-validation.js";
import { ReconciliationValidation } from "./reconciliation-validation.js";
import { ValidationStore } from "./validation-store.js";
import type { ValidationCheckResult, ValidationRunOptions, ValidationRunReport, ValidationType, ValidationValidator } from "./types.js";

export interface ValidationRunnerResult {
  report: ValidationRunReport;
  jsonReportPath: string;
  markdownReportPath: string;
  workingDatabasePath: string;
}

function validators(): ValidationValidator[] {
  return [
    new PaperReplayValidation(),
    new PaperConsistencyValidation(),
    new CrashRecoveryValidation(),
    new ReconciliationValidation(),
    new LiveGateValidation(),
    new ObserveOnlyValidation(),
  ];
}

function selectedValidators(validationType: ValidationType): ValidationValidator[] {
  const all = validators();
  if (validationType === "ALL") return all;
  return all.filter((validator) => validator.type === validationType);
}

export class ValidationRunner {
  constructor(
    private readonly sourceVersion: SourceVersion = resolveSourceVersion(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  async run(options: ValidationRunOptions): Promise<ValidationRunnerResult> {
    const validationType = options.validationType ?? "ALL";
    const useSnapshot = options.useSnapshot ?? true;
    if (!useSnapshot) throw new Error("VALIDATION_SNAPSHOT_REQUIRED");
    const outputDirectory = resolve(options.outputDirectory ?? "data/validation");
    const sessionId = `validation-${randomUUID()}`;
    const startedAt = this.now().toISOString();
    const snapshot = await prepareValidationDatabaseSnapshot({
      sourceDatabasePath: options.sourceDatabasePath,
      outputDirectory,
      sessionId,
      useSnapshot,
      sourceVersion: this.sourceVersion,
    });
    const store = new ValidationStore(snapshot.workingDatabasePath);
    const checks: ValidationCheckResult[] = [];
    try {
      store.startSession({
        sessionId,
        validationType,
        sourceDatabasePath: snapshot.sourceDatabasePath,
        workingDatabasePath: snapshot.workingDatabasePath,
        sourceVersion: this.sourceVersion,
        inputSnapshotHash: snapshot.inputSnapshotHash,
        dbSnapshotHash: snapshot.dbSnapshotHash,
        now: startedAt,
      });
      for (const validator of selectedValidators(validationType)) {
        const validatorChecks = await validator.run({
          databasePath: snapshot.workingDatabasePath,
          sourceVersion: this.sourceVersion,
          now: this.now,
        });
        checks.push(...validatorChecks);
        for (const item of validatorChecks) store.recordCheck(sessionId, item, this.now().toISOString());
      }
      const finishedAt = this.now().toISOString();
      const report = buildValidationReport({
        sessionId,
        validationType,
        startedAt,
        finishedAt,
        sourceVersion: this.sourceVersion,
        inputSnapshotHash: snapshot.inputSnapshotHash,
        dbSnapshotHash: snapshot.dbSnapshotHash,
        checks,
      });
      const written = writeValidationReports({ outputDirectory, sessionId, report });
      for (const artifact of written.artifacts) store.recordArtifact(sessionId, artifact, finishedAt);
      const [jsonArtifact, markdownArtifact] = written.artifacts;
      if (!jsonArtifact || !markdownArtifact) throw new Error("VALIDATION_REPORT_ARTIFACT_MISSING");
      store.recordReport({
        sessionId,
        reportFormat: "JSON",
        reportPath: written.jsonPath,
        reportSha256: jsonArtifact.artifactSha256,
        summary: report.finalResult,
        now: finishedAt,
      });
      store.recordReport({
        sessionId,
        reportFormat: "MARKDOWN",
        reportPath: written.markdownPath,
        reportSha256: markdownArtifact.artifactSha256,
        summary: report.finalResult,
        now: finishedAt,
      });
      store.finishSession({
        sessionId,
        status: report.session.status,
        finalReadinessStatus: report.finalResult.finalReadinessStatus,
        reportHash: report.system.reportHash,
        result: report.finalResult,
        finishedAt,
      });
      if (snapshot.usedSnapshot) {
        pruneCompletedRunSnapshots({
          outputDirectory,
          currentRunId: sessionId,
          currentWorkingDatabasePath: snapshot.workingDatabasePath,
          runPrefix: "validation-",
          reportFileName: "validation-report.json",
        });
      }
      return {
        report,
        jsonReportPath: written.jsonPath,
        markdownReportPath: written.markdownPath,
        workingDatabasePath: snapshot.workingDatabasePath,
      };
    } finally {
      store.close();
    }
  }
}
