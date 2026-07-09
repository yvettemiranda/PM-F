import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { RULESET_HASH, VERSIONS, stableJson } from "../domain/versioning.js";
import type { SourceVersion } from "../infra/source-version.js";
import type { ValidationCheckResult } from "../validation/types.js";
import type {
  OperationalFinalStatus,
  OperationalHealthSnapshot,
  OperationalMode,
  OperationalRunStatus,
  OperationalSeverity,
} from "./types.js";

function hash(parts: unknown[]): string {
  return createHash("sha256").update(stableJson(parts)).digest("hex");
}

export class OperationalStore {
  readonly database: DatabaseSync;

  constructor(readonly databasePath: string) {
    this.database = new DatabaseSync(databasePath);
    this.database.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;");
  }

  startRun(input: {
    operationalRunId: string;
    validationSessionId: string;
    mode: OperationalMode;
    startedAt: string;
    sourceVersion: SourceVersion;
    workingDatabasePath: string;
    sourceDatabasePath: string;
    paperAccountId?: string | null;
    targetWallet?: string | null;
  }): void {
    this.database.prepare(
      `INSERT INTO operational_runs(
        operational_run_id,validation_session_id,mode,status,started_at,stopped_at,
        runtime_duration_ms,source_commit,source_dirty,schema_version,config_version,
        ruleset_hash,operational_version,working_database_path,source_database_path,
        paper_account_id,target_wallet,final_status,result_json,created_at,updated_at
      ) VALUES (?, ?, ?, 'RUNNING', ?, NULL, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        'OPERATIONAL_RUNNING', '{}', ?, ?)`,
    ).run(
      input.operationalRunId,
      input.validationSessionId,
      input.mode,
      input.startedAt,
      input.sourceVersion.commit,
      input.sourceVersion.dirty ? 1 : 0,
      VERSIONS.schemaVersion,
      VERSIONS.configVersion,
      RULESET_HASH,
      VERSIONS.operationalVersion,
      input.workingDatabasePath,
      input.sourceDatabasePath,
      input.paperAccountId ?? null,
      input.targetWallet ?? null,
      input.startedAt,
      input.startedAt,
    );
  }

  finishRun(input: {
    operationalRunId: string;
    status: OperationalRunStatus;
    stoppedAt: string;
    runtimeDurationMs: number;
    finalStatus: OperationalFinalStatus;
    result: Record<string, unknown>;
  }): void {
    this.database.prepare(
      `UPDATE operational_runs
       SET status=?,stopped_at=?,runtime_duration_ms=?,final_status=?,
           result_json=?,updated_at=?
       WHERE operational_run_id=?`,
    ).run(
      input.status,
      input.stoppedAt,
      input.runtimeDurationMs,
      input.finalStatus,
      stableJson(input.result),
      input.stoppedAt,
      input.operationalRunId,
    );
  }

  updatePaperAccount(operationalRunId: string, paperAccountId: string, now: string): void {
    this.database.prepare(
      "UPDATE operational_runs SET paper_account_id=?,updated_at=? WHERE operational_run_id=?",
    ).run(paperAccountId, now, operationalRunId);
  }

  bindPaperAccount(input: {
    operationalRunId: string;
    paperAccountId: string;
    bindingReason: string;
    now: string;
  }): void {
    this.database.prepare(
      `INSERT OR REPLACE INTO operational_paper_bindings(
        operational_run_id,paper_account_id,binding_reason,created_at
      ) VALUES (?, ?, ?, ?)`,
    ).run(input.operationalRunId, input.paperAccountId, input.bindingReason, input.now);
    this.updatePaperAccount(input.operationalRunId, input.paperAccountId, input.now);
  }

  recordHeartbeat(input: {
    operationalRunId: string;
    timestamp: string;
    uptimeMs: number;
    eventLoopLagMs?: number;
    restartCount?: number;
    errorCount?: number;
  }): void {
    const memory = process.memoryUsage();
    this.database.prepare(
      `INSERT INTO operational_heartbeats(
        heartbeat_id,operational_run_id,timestamp,uptime_ms,memory_rss_bytes,
        memory_heap_used_bytes,event_loop_lag_ms,restart_count,error_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      hash(["HEARTBEAT", input.operationalRunId, input.timestamp]),
      input.operationalRunId,
      input.timestamp,
      input.uptimeMs,
      memory.rss,
      memory.heapUsed,
      input.eventLoopLagMs ?? 0,
      input.restartCount ?? 0,
      input.errorCount ?? this.openErrorCount(input.operationalRunId),
    );
  }

  recordCheckpoint(input: {
    operationalRunId: string;
    mode: OperationalMode;
    lastProcessedTimestamp?: number | null;
    lastProcessedEventId?: string | null;
    observeCheckpointId?: string | null;
    paperConsumerCheckpoint?: string | null;
    portfolioProjectionId?: string | null;
    stateHash: string;
    now: string;
  }): string {
    const checkpointId = hash(["CHECKPOINT", input.operationalRunId, input.mode, input.stateHash, input.now]);
    this.database.prepare(
      `INSERT OR IGNORE INTO operational_checkpoints(
        checkpoint_id,operational_run_id,mode,last_processed_timestamp,last_processed_event_id,
        observe_checkpoint_id,paper_consumer_checkpoint,portfolio_projection_id,state_hash,created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      checkpointId,
      input.operationalRunId,
      input.mode,
      input.lastProcessedTimestamp ?? null,
      input.lastProcessedEventId ?? null,
      input.observeCheckpointId ?? null,
      input.paperConsumerCheckpoint ?? null,
      input.portfolioProjectionId ?? null,
      input.stateHash,
      input.now,
    );
    return checkpointId;
  }

  recordAnomaly(input: {
    operationalRunId: string;
    timestamp: string;
    module: string;
    severity: OperationalSeverity;
    errorCode: string;
    entityType?: string | null;
    entityId?: string | null;
    context?: Record<string, unknown>;
    stackTrace?: string | null;
    status?: "OPEN" | "RESOLVED" | "IGNORED";
  }): string {
    const anomalyId = hash([
      "ANOMALY",
      input.operationalRunId,
      input.timestamp,
      input.module,
      input.severity,
      input.errorCode,
      input.entityType ?? "NONE",
      input.entityId ?? "NONE",
    ]);
    this.database.prepare(
      `INSERT OR IGNORE INTO operational_anomalies(
        anomaly_id,operational_run_id,timestamp,module,severity,error_code,
        entity_type,entity_id,context_json,stack_trace,status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      anomalyId,
      input.operationalRunId,
      input.timestamp,
      input.module,
      input.severity,
      input.errorCode,
      input.entityType ?? null,
      input.entityId ?? null,
      stableJson(input.context ?? {}),
      input.stackTrace ?? null,
      input.status ?? "OPEN",
    );
    return anomalyId;
  }

  recordHealthSnapshot(input: {
    operationalRunId: string;
    timestamp: string;
    snapshot: OperationalHealthSnapshot;
  }): string {
    const healthSnapshotId = hash(["HEALTH", input.operationalRunId, input.timestamp, input.snapshot]);
    this.database.prepare(
      `INSERT OR IGNORE INTO operational_health_snapshots(
        health_snapshot_id,operational_run_id,timestamp,uptime_ms,database_size_bytes,
        migration_version,database_integrity_status,api_failure_count,reconnect_count,
        duplicate_event_count,missed_event_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      healthSnapshotId,
      input.operationalRunId,
      input.timestamp,
      input.snapshot.uptimeMs,
      input.snapshot.databaseSizeBytes,
      input.snapshot.migrationVersion,
      input.snapshot.databaseIntegrityStatus,
      input.snapshot.apiFailureCount,
      input.snapshot.reconnectCount,
      input.snapshot.duplicateEventCount,
      input.snapshot.missedEventCount,
    );
    return healthSnapshotId;
  }

  recordConsistencyCheck(operationalRunId: string, check: ValidationCheckResult, now: string): string {
    const checkId = hash([
      "CONSISTENCY",
      operationalRunId,
      check.checkType,
      check.checkName,
      check.status,
      check.reason,
      check.startedAt ?? now,
      check.finishedAt ?? now,
    ]);
    this.database.prepare(
      `INSERT OR IGNORE INTO operational_consistency_checks(
        consistency_check_id,operational_run_id,check_type,status,reason,metrics_json,created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      checkId,
      operationalRunId,
      `${check.checkType}:${check.checkName}`,
      check.status,
      check.reason,
      stableJson(check.metrics ?? {}),
      now,
    );
    return checkId;
  }

  recordShadowRiskObservation(input: {
    operationalRunId: string;
    signalId: string;
    result: "ALLOW" | "REJECT" | "NOT_EXECUTABLE" | "OBSERVED_ONLY";
    reason: string;
    checks: Record<string, unknown>;
    now: string;
  }): string {
    const observationId = hash(["SHADOW_RISK", input.operationalRunId, input.signalId]);
    this.database.prepare(
      `INSERT OR IGNORE INTO shadow_risk_observations(
        shadow_risk_observation_id,operational_run_id,signal_id,result,reason,checks_json,created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      observationId,
      input.operationalRunId,
      input.signalId,
      input.result,
      input.reason,
      stableJson(input.checks),
      input.now,
    );
    return observationId;
  }

  recordReport(input: {
    operationalRunId: string;
    reportFormat: "JSON" | "MARKDOWN";
    reportPath: string;
    reportHash: string;
    summary: Record<string, unknown>;
    now: string;
  }): string {
    const reportId = hash(["REPORT", input.operationalRunId, input.reportFormat, input.reportPath]);
    this.database.prepare(
      `INSERT OR IGNORE INTO operational_reports(
        operational_report_id,operational_run_id,report_format,report_path,
        report_hash,summary_json,created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      reportId,
      input.operationalRunId,
      input.reportFormat,
      input.reportPath,
      input.reportHash,
      stableJson(input.summary),
      input.now,
    );
    return reportId;
  }

  openErrorCount(operationalRunId: string): number {
    const row = this.database.prepare(
      `SELECT count(*) count FROM operational_anomalies
       WHERE operational_run_id=? AND status='OPEN' AND severity IN ('ERROR','CRITICAL')`,
    ).get(operationalRunId) as { count: number };
    return row.count;
  }

  close(): void {
    this.database.close();
  }
}

