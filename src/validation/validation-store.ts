import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { RULESET_HASH, VERSIONS, stableJson } from "../domain/versioning.js";
import type { SourceVersion } from "../infra/source-version.js";
import type {
  FinalReadinessStatus,
  ValidationArtifact,
  ValidationCheckResult,
  ValidationSessionStatus,
  ValidationType,
} from "./types.js";

function hash(parts: unknown[]): string {
  return createHash("sha256").update(stableJson(parts)).digest("hex");
}

export class ValidationStore {
  private readonly database: DatabaseSync;

  constructor(databasePath: string) {
    this.database = new DatabaseSync(databasePath);
    this.database.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;");
  }

  startSession(input: {
    sessionId: string;
    validationType: ValidationType;
    sourceDatabasePath: string;
    workingDatabasePath: string;
    sourceVersion: SourceVersion;
    inputSnapshotHash: string;
    dbSnapshotHash: string;
    now: string;
  }): void {
    this.database.prepare(
      `INSERT INTO validation_sessions(
        validation_session_id,validation_type,status,started_at,finished_at,
        source_database_path,working_database_path,source_commit,source_dirty,
        schema_version,config_version,ruleset_hash,validation_version,
        input_snapshot_hash,db_snapshot_hash,report_hash,final_readiness_status,
        result_json,created_at,updated_at
      ) VALUES (?, ?, 'RUNNING', ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL,
        'VALIDATION_RUNNING', '{}', ?, ?)`,
    ).run(
      input.sessionId,
      input.validationType,
      input.now,
      input.sourceDatabasePath,
      input.workingDatabasePath,
      input.sourceVersion.commit,
      input.sourceVersion.dirty ? 1 : 0,
      VERSIONS.schemaVersion,
      VERSIONS.configVersion,
      RULESET_HASH,
      VERSIONS.validationVersion,
      input.inputSnapshotHash,
      input.dbSnapshotHash,
      input.now,
      input.now,
    );
  }

  recordCheck(sessionId: string, check: ValidationCheckResult, fallbackNow: string): void {
    const startedAt = check.startedAt ?? fallbackNow;
    const finishedAt = check.finishedAt ?? fallbackNow;
    const checkId = hash([sessionId, check.checkType, check.checkName, startedAt, finishedAt, check.status, check.reason]);
    this.database.prepare(
      `INSERT OR IGNORE INTO validation_checks(
        validation_check_id,validation_session_id,check_type,check_name,status,
        blocking,reason,metrics_json,error_json,started_at,finished_at,created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      checkId,
      sessionId,
      check.checkType,
      check.checkName,
      check.status,
      check.blocking ? 1 : 0,
      check.reason,
      stableJson(check.metrics ?? {}),
      stableJson(check.error ?? {}),
      startedAt,
      finishedAt,
      fallbackNow,
    );
  }

  recordArtifact(sessionId: string, artifact: ValidationArtifact, now: string): void {
    this.database.prepare(
      `INSERT OR IGNORE INTO validation_artifacts(
        artifact_id,validation_session_id,artifact_type,artifact_path,
        artifact_sha256,content_type,created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      hash([sessionId, artifact.artifactType, artifact.artifactPath, artifact.artifactSha256]),
      sessionId,
      artifact.artifactType,
      artifact.artifactPath,
      artifact.artifactSha256,
      artifact.contentType,
      now,
    );
  }

  recordReport(input: {
    sessionId: string;
    reportFormat: "JSON" | "MARKDOWN";
    reportPath: string;
    reportSha256: string;
    summary: Record<string, unknown>;
    now: string;
  }): void {
    this.database.prepare(
      `INSERT OR IGNORE INTO validation_reports(
        report_id,validation_session_id,report_format,report_path,report_sha256,
        summary_json,created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      hash([input.sessionId, input.reportFormat, input.reportPath, input.reportSha256]),
      input.sessionId,
      input.reportFormat,
      input.reportPath,
      input.reportSha256,
      stableJson(input.summary),
      input.now,
    );
  }

  finishSession(input: {
    sessionId: string;
    status: ValidationSessionStatus;
    finalReadinessStatus: FinalReadinessStatus;
    reportHash: string;
    result: Record<string, unknown>;
    finishedAt: string;
  }): void {
    this.database.prepare(
      `UPDATE validation_sessions
       SET status=?,finished_at=?,report_hash=?,final_readiness_status=?,
           result_json=?,updated_at=?
       WHERE validation_session_id=?`,
    ).run(
      input.status,
      input.finishedAt,
      input.reportHash,
      input.finalReadinessStatus,
      stableJson(input.result),
      input.finishedAt,
      input.sessionId,
    );
  }

  sessionId(prefix = "validation"): string {
    return `${prefix}-${randomUUID()}`;
  }

  close(): void {
    this.database.close();
  }
}
