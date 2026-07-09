import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { ApiCapture } from "../../adapters/polymarket-public.js";
import { activityEventKey, SOURCE_IDENTITY_VERSION, sourceEventKey } from "../../domain/idempotency.js";
import type { PublicActivity, PublicTrade, WalletIdentityReport } from "../../domain/models.js";
import { decimalToScaled, PRICE_SCALE_DIGITS, SHARE_SCALE_DIGITS } from "../../domain/fixed.js";
import {
  RULESET,
  RULESET_HASH,
  RULESET_SNAPSHOT_JSON,
  VERSIONS,
} from "../../domain/versioning.js";
import type { ReplayReport } from "../../replay/replay-engine.js";
import { resolveSourceVersion, type SourceVersion } from "../source-version.js";
import { captureIdentity, type CaptureManifest } from "../../services/capture-manifest.js";
import type { PositionBaseline } from "../../services/position-baseline.js";
import type { CapitalEstimate } from "../../services/capital-estimator.js";
import type { GoldenExpectation, GoldenResult } from "../../services/golden-expectations.js";

export class Phase0Database {
  private readonly database: DatabaseSync;
  private readonly sourceVersion: SourceVersion;

  constructor(path: string, sourceVersion = resolveSourceVersion()) {
    this.database = new DatabaseSync(path);
    this.sourceVersion = sourceVersion;
  }

  initialize(): void {
    const sql = readFileSync(new URL("./001_phase0.sql", import.meta.url), "utf8");
    this.database.exec(sql);
    this.database
      .prepare(
        `INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)
         `,
      )
      .run("1.2.0", new Date().toISOString());
    const phase05Applied = this.database
      .prepare("SELECT 1 applied FROM schema_migrations WHERE version = ?")
      .get("1.3.0");
    if (!phase05Applied) {
      const phase05Sql = readFileSync(new URL("./002_phase05.sql", import.meta.url), "utf8");
      this.database.exec("BEGIN IMMEDIATE");
      try {
        this.database.exec(phase05Sql);
        this.database
          .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
          .run("1.3.0", new Date().toISOString());
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    }
    const classificationProjectionApplied = this.database
      .prepare("SELECT 1 applied FROM schema_migrations WHERE version = ?")
      .get("1.4.0");
    if (!classificationProjectionApplied) {
      const projectionSql = readFileSync(new URL("./003_replay_event_classifications.sql", import.meta.url), "utf8");
      this.database.exec("BEGIN IMMEDIATE");
      try {
        this.database.exec(projectionSql);
        this.database
          .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
          .run("1.4.0", new Date().toISOString());
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    }
    const observeOnlyApplied = this.database
      .prepare("SELECT 1 applied FROM schema_migrations WHERE version = ?")
      .get("1.5.0");
    if (!observeOnlyApplied) {
      const observeSql = readFileSync(new URL("./004_observe_only.sql", import.meta.url), "utf8");
      this.database.exec("BEGIN IMMEDIATE");
      try {
        this.database.exec(observeSql);
        this.database
          .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
          .run("1.5.0", new Date().toISOString());
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    }
    const paperApplied = this.database
      .prepare("SELECT 1 applied FROM schema_migrations WHERE version = ?")
      .get("2.0.0");
    if (!paperApplied) {
      const paperSql = readFileSync(new URL("./005_paper_executor.sql", import.meta.url), "utf8");
      this.database.exec("BEGIN IMMEDIATE");
      try {
        this.database.exec(paperSql);
        this.database
          .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
          .run("2.0.0", new Date().toISOString());
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    }
    const phase1ArchitectureApplied = this.database
      .prepare("SELECT 1 applied FROM schema_migrations WHERE version = ?")
      .get("2.1.0");
    if (!phase1ArchitectureApplied) {
      const phase1ArchitectureSql = readFileSync(new URL("./006_phase1a_architecture.sql", import.meta.url), "utf8");
      this.database.exec("BEGIN IMMEDIATE");
      try {
        this.database.exec(phase1ArchitectureSql);
        this.database
          .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
          .run("2.1.0", new Date().toISOString());
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    }
    const rulesetProjectionApplied = this.database
      .prepare("SELECT 1 applied FROM schema_migrations WHERE version = ?")
      .get("2.2.0");
    if (!rulesetProjectionApplied) {
      const rulesetProjectionSql = readFileSync(new URL("./007_ruleset_portfolio_projection.sql", import.meta.url), "utf8");
      this.database.exec("BEGIN IMMEDIATE");
      try {
        this.database.exec(rulesetProjectionSql);
        this.database
          .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
          .run("2.2.0", new Date().toISOString());
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    }
    const liveGateApplied = this.database
      .prepare("SELECT 1 applied FROM schema_migrations WHERE version = ?")
      .get("2.3.0");
    if (!liveGateApplied) {
      const liveGateSql = readFileSync(new URL("./008_live_gate_safety.sql", import.meta.url), "utf8");
      this.database.exec("BEGIN IMMEDIATE");
      try {
        this.database.exec(liveGateSql);
        this.database
          .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
          .run("2.3.0", new Date().toISOString());
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    }
    const liveExecutorApplied = this.database
      .prepare("SELECT 1 applied FROM schema_migrations WHERE version = ?")
      .get("2.4.0");
    if (!liveExecutorApplied) {
      const liveExecutorSql = readFileSync(new URL("./009_live_executor.sql", import.meta.url), "utf8");
      this.database.exec("BEGIN IMMEDIATE");
      try {
        this.database.exec(liveExecutorSql);
        this.database
          .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
          .run("2.4.0", new Date().toISOString());
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    }
    this.database
      .prepare(
        `INSERT OR IGNORE INTO rulesets(
          ruleset_hash, schema_version, signal_version, strategy_version, risk_version,
          replay_version, ruleset_snapshot_json, source_code_commit, source_code_dirty, config_version, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        RULESET_HASH,
        VERSIONS.schemaVersion,
        VERSIONS.signalVersion,
        VERSIONS.strategyVersion,
        VERSIONS.riskVersion,
        VERSIONS.replayVersion,
        RULESET_SNAPSHOT_JSON,
        this.sourceVersion.commit,
        this.sourceVersion.dirty ? 1 : 0,
        VERSIONS.configVersion,
        new Date().toISOString(),
      );
    const now = new Date().toISOString();
    this.database
      .prepare(
        `INSERT OR IGNORE INTO ruleset_registry(
          ruleset_hash, ruleset_version, buy_price_lower_ratio_ppm, buy_price_upper_ratio_ppm,
          stop_loss_ratio_ppm, wait_ratio_ppm, max_wait_time_ms, capital_mode,
          fee_model_version, ruleset_snapshot_json, source_code_commit, source_code_dirty,
          config_version, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        RULESET_HASH,
        VERSIONS.rulesetVersion,
        RULESET.buyPriceMinRatioPpm,
        RULESET.buyPriceMaxRatioPpm,
        RULESET.stopTriggerRatioPpm,
        RULESET.waitRatioPpm,
        RULESET.maxWaitMs,
        RULESET.capitalMode,
        VERSIONS.feeModelVersion,
        RULESET_SNAPSHOT_JSON,
        this.sourceVersion.commit,
        this.sourceVersion.dirty ? 1 : 0,
        VERSIONS.configVersion,
        now,
      );
    this.database
      .prepare(
        `INSERT OR IGNORE INTO live_gate_state(
          state_id, execution_mode, live_gate_state, requested_execution_mode, last_preflight_id,
          state_reason, source_code_commit, source_code_dirty, config_version, created_at, updated_at
        ) VALUES ('default', 'PAPER', 'LIVE_DISABLED', NULL, NULL, 'DEFAULT_DISABLED', ?, ?, ?, ?, ?)`,
      )
      .run(
        this.sourceVersion.commit,
        this.sourceVersion.dirty ? 1 : 0,
        VERSIONS.configVersion,
        now,
        now,
      );
  }

  saveIdentity(report: WalletIdentityReport): string {
    const reportId = createHash("sha256")
      .update(`${report.walletAddress}|${report.positionSnapshotTime}|${RULESET_HASH}`)
      .digest("hex");
    this.database
      .prepare(
        `INSERT OR REPLACE INTO wallet_identity_reports(
          report_id, wallet_address, wallet_type, proxy_wallet, chain, first_seen_time,
          last_activity_time, trade_count, trade_count_scope, position_count, status,
          confidence, implementation_address, evidence_json, ruleset_hash, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        reportId,
        report.walletAddress,
        report.walletType,
        report.proxyWallet,
        report.chain,
        report.firstSeenTime,
        report.lastActivityTime,
        report.tradeCount,
        report.tradeCountScope,
        report.positionCount,
        report.status,
        report.confidence,
        report.implementationAddress,
        JSON.stringify(report.evidence),
        RULESET_HASH,
        new Date().toISOString(),
      );
    return reportId;
  }

  saveCapture<T>(endpoint: string, capture: ApiCapture<T>): string {
    const responseJson = JSON.stringify(capture.data);
    const { captureId, payloadSha256: payloadHash } = captureIdentity(capture as ApiCapture<unknown>);
    this.database
      .prepare(
        `INSERT OR IGNORE INTO api_captures(
          capture_id, endpoint, request_url, fetched_at, latency_ms, http_status,
          payload_sha256, response_json, schema_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        captureId,
        endpoint,
        capture.url,
        capture.fetchedAt,
        capture.latencyMs,
        capture.status,
        payloadHash,
        responseJson,
        VERSIONS.schemaVersion,
      );
    const serverTimestamp = endpoint === "clob-time" && typeof capture.data === "number"
      ? new Date(capture.data * 1_000).toISOString()
      : null;
    const clockOffsetMs = serverTimestamp
      ? Math.round(Date.parse(serverTimestamp) - (Date.parse(capture.fetchedAt) - capture.latencyMs / 2))
      : null;
    this.database
      .prepare(
        `INSERT OR IGNORE INTO latency_metrics(
          metric_id, component, operation, duration_ms, local_timestamp,
          server_timestamp, clock_offset_ms, success, detail_json
        ) VALUES (?, 'PUBLIC_API', ?, ?, ?, ?, ?, 1, ?)`,
      )
      .run(
        createHash("sha256").update(`latency|${captureId}`).digest("hex"),
        endpoint,
        capture.latencyMs,
        capture.fetchedAt,
        serverTimestamp,
        clockOffsetMs,
        JSON.stringify({ url: capture.url, httpStatus: capture.status }),
      );
    return captureId;
  }

  saveCaptureManifest(targetId: string | null, manifest: CaptureManifest): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database
        .prepare(
          `INSERT OR REPLACE INTO capture_runs(
            capture_run_id, target_id, wallet_address, sample_role, purpose, status,
            started_at, completed_at, manifest_hash, item_count,
            schema_version, signal_version, strategy_version, risk_version, replay_version,
            ruleset_snapshot_json, ruleset_hash, source_code_commit, source_code_dirty, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          manifest.captureRunId,
          targetId,
          manifest.walletAddress,
          manifest.sampleRole,
          manifest.purpose,
          manifest.status,
          manifest.startedAt,
          manifest.completedAt,
          manifest.manifestHash,
          manifest.items.length,
          VERSIONS.schemaVersion,
          VERSIONS.signalVersion,
          VERSIONS.strategyVersion,
          VERSIONS.riskVersion,
          VERSIONS.replayVersion,
          RULESET_SNAPSHOT_JSON,
          RULESET_HASH,
          manifest.sourceCodeCommit,
          manifest.sourceCodeDirty ? 1 : 0,
          manifest.completedAt,
        );
      const insertItem = this.database.prepare(
        `INSERT OR REPLACE INTO capture_manifest_items(
          manifest_item_id, capture_run_id, capture_id, source_endpoint, request_url,
          page_index, fetched_at, source_time_from, source_time_to, row_count,
          pagination_status, payload_sha256, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const item of manifest.items) {
        insertItem.run(
          item.manifestItemId,
          manifest.captureRunId,
          item.captureId,
          item.endpoint,
          item.requestUrl,
          item.pageIndex,
          item.fetchedAt,
          item.sourceTimeFrom,
          item.sourceTimeTo,
          item.rowCount,
          item.paginationStatus,
          item.payloadSha256,
          manifest.completedAt,
        );
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  ensureTarget(walletAddress: string, identityStatus: string): string {
    const targetId = createHash("sha256").update(walletAddress.toLowerCase()).digest("hex");
    const now = new Date().toISOString();
    this.database
      .prepare(
        `INSERT INTO monitor_targets(
          target_id, wallet_address, identity_status, runtime_mode, sync_status, created_at, updated_at
        ) VALUES (?, ?, ?, 'OBSERVE_ONLY', 'SYNCED', ?, ?)
        ON CONFLICT(wallet_address) DO UPDATE SET identity_status=excluded.identity_status, updated_at=excluded.updated_at`,
      )
      .run(targetId, walletAddress.toLowerCase(), identityStatus, now, now);
    return targetId;
  }

  savePositionBaseline(baseline: PositionBaseline): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database
        .prepare(
          `INSERT OR REPLACE INTO position_baseline_runs(
            baseline_run_id, capture_run_id, target_id, wallet_address, status,
            cutoff_from, cutoff_to, snapshot_time, position_capture_id, item_count,
            schema_version, strategy_version, ruleset_hash, source_code_commit,
            source_code_dirty, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          baseline.baselineRunId,
          baseline.captureRunId,
          baseline.targetId,
          baseline.walletAddress,
          baseline.status,
          baseline.cutoffFrom,
          baseline.cutoffTo,
          baseline.snapshotTime,
          baseline.positionCaptureId,
          baseline.items.length,
          VERSIONS.schemaVersion,
          VERSIONS.strategyVersion,
          RULESET_HASH,
          this.sourceVersion.commit,
          this.sourceVersion.dirty ? 1 : 0,
          baseline.snapshotTime,
        );
      const insertItem = this.database.prepare(
        `INSERT OR REPLACE INTO position_baseline_items(
          baseline_item_id, baseline_run_id, condition_id, asset_id, market_slug,
          market_title, outcome, size_micros, average_price_units, snapshot_time
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const item of baseline.items) {
        insertItem.run(
          item.baselineItemId,
          baseline.baselineRunId,
          item.conditionId,
          item.asset,
          item.marketSlug,
          item.marketTitle,
          item.outcome,
          item.sizeMicros,
          item.averagePriceUnits,
          item.snapshotTime,
        );
      }
      this.database
        .prepare("UPDATE monitor_targets SET baseline_at=?, updated_at=? WHERE target_id=?")
        .run(baseline.snapshotTime, baseline.snapshotTime, baseline.targetId);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  saveCapitalEstimate(targetId: string, sourceEventKeyValue: string | null, estimate: CapitalEstimate): void {
    this.database
      .prepare(
        `INSERT OR REPLACE INTO capital_estimates(
          capital_estimate_id, target_id, source_event_key, position_value_micros,
          wallet_balance_micros, target_visible_capital_micros, target_trade_amount_micros,
          target_trade_capital_ratio_ppm, capital_estimate_status, capital_confidence,
          capital_estimate_reason, position_snapshot_time, wallet_balance_snapshot_time,
          target_trade_timestamp, fallback_amount_micros, schema_version, strategy_version,
          risk_version, ruleset_snapshot_json, ruleset_hash, source_code_commit,
          source_code_dirty, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        estimate.capitalEstimateId,
        targetId,
        sourceEventKeyValue,
        estimate.positionValueMicros,
        estimate.walletBalanceMicros,
        estimate.targetVisibleCapitalMicros,
        estimate.targetTradeAmountMicros,
        estimate.targetTradeCapitalRatioPpm,
        estimate.capitalEstimateStatus,
        estimate.capitalConfidence,
        estimate.capitalEstimateReason,
        estimate.positionSnapshotTime,
        estimate.walletBalanceSnapshotTime,
        estimate.targetTradeTimestamp,
        estimate.fallbackAmountMicros,
        VERSIONS.schemaVersion,
        VERSIONS.strategyVersion,
        VERSIONS.riskVersion,
        RULESET_SNAPSHOT_JSON,
        RULESET_HASH,
        this.sourceVersion.commit,
        this.sourceVersion.dirty ? 1 : 0,
        new Date().toISOString(),
      );
  }

  saveGoldenCandidates(candidates: GoldenExpectation[]): void {
    const insert = this.database.prepare(
      `INSERT OR IGNORE INTO golden_expectations(
        golden_case_id, capture_run_id, sample_wallet, sample_role, case_type,
        source_event_key, source_transaction_hash, expected_signal_type,
        expected_signal_present, expected_execution_eligible, expected_event_classification,
        expected_reason, evidence_json, status, schema_version, signal_version,
        replay_version, ruleset_hash, source_code_commit, source_code_dirty, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const now = new Date().toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      for (const item of candidates) {
        insert.run(
          item.goldenCaseId,
          item.captureRunId,
          item.sampleWallet,
          item.sampleRole,
          item.caseType,
          item.sourceEventKey,
          item.sourceTransactionHash,
          item.expectedSignalType,
          item.expectedSignalPresent ? 1 : 0,
          item.expectedExecutionEligible === null ? null : item.expectedExecutionEligible ? 1 : 0,
          item.expectedEventClassification,
          item.expectedReason,
          JSON.stringify(item.evidence),
          item.status,
          VERSIONS.schemaVersion,
          VERSIONS.signalVersion,
          VERSIONS.replayVersion,
          RULESET_HASH,
          this.sourceVersion.commit,
          this.sourceVersion.dirty ? 1 : 0,
          now,
        );
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  saveGoldenResults(replayRunId: string, results: GoldenResult[]): void {
    const insert = this.database.prepare(
      `INSERT OR REPLACE INTO golden_results(
        golden_result_id, replay_run_id, golden_case_id, result_status,
        actual_signal_type, actual_signal_present, actual_execution_eligible,
        actual_event_classification, diff_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const now = new Date().toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      for (const item of results) {
        const resultId = createHash("sha256").update(`${replayRunId}|${item.goldenCaseId}`).digest("hex");
        insert.run(
          resultId,
          replayRunId,
          item.goldenCaseId,
          item.resultStatus,
          item.actualSignalType,
          item.actualSignalPresent ? 1 : 0,
          item.actualExecutionEligible === null ? null : item.actualExecutionEligible ? 1 : 0,
          item.actualEventClassification,
          JSON.stringify(item.diff),
          now,
        );
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  beginReplayJob(captureRunId: string | null, replacesJobId: string | null = null): string {
    const replayJobId = randomUUID();
    const now = new Date().toISOString();
    this.database
      .prepare(
        `INSERT INTO replay_jobs(
          replay_job_id, capture_run_id, state, replaces_job_id, started_at,
          heartbeat_at, source_code_commit, source_code_dirty, created_at
        ) VALUES (?, ?, 'RUNNING', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        replayJobId,
        captureRunId,
        replacesJobId,
        now,
        now,
        this.sourceVersion.commit,
        this.sourceVersion.dirty ? 1 : 0,
        now,
      );
    return replayJobId;
  }

  completeReplayJob(replayJobId: string, replayRunId: string): void {
    const now = new Date().toISOString();
    const result = this.database
      .prepare(
        `UPDATE replay_jobs
         SET state='COMPLETED', replay_run_id=?, heartbeat_at=?, finished_at=?
         WHERE replay_job_id=? AND state='RUNNING'`,
      )
      .run(replayRunId, now, now, replayJobId);
    if (result.changes !== 1) throw new Error(`Replay job is not RUNNING: ${replayJobId}`);
  }

  failReplayJob(replayJobId: string, error: unknown): void {
    const now = new Date().toISOString();
    this.database
      .prepare(
        `UPDATE replay_jobs
         SET state='FAILED', heartbeat_at=?, finished_at=?, error_detail=?
         WHERE replay_job_id=? AND state='RUNNING'`,
      )
      .run(now, now, error instanceof Error ? error.message : String(error), replayJobId);
  }

  recoverInterruptedReplayJobs(staleBefore: string): string[] {
    const rows = this.database
      .prepare(
        `SELECT replay_job_id FROM replay_jobs
         WHERE state='RUNNING' AND heartbeat_at < ?
         ORDER BY created_at`,
      )
      .all(staleBefore) as Array<{ replay_job_id: string }>;
    if (rows.length === 0) return [];
    const now = new Date().toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const update = this.database.prepare(
        `UPDATE replay_jobs
         SET state='INTERRUPTED', finished_at=?, error_detail='STALE_RUNNING_JOB_RECOVERED'
         WHERE replay_job_id=? AND state='RUNNING'`,
      );
      for (const row of rows) update.run(now, row.replay_job_id);
      this.database.exec("COMMIT");
      return rows.map((row) => row.replay_job_id);
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  loadCaptureRun(captureRunId: string): {
    captureRunId: string;
    walletAddress: string;
    manifestHash: string;
    sourceCodeCommit: string;
    sourceCodeDirty: boolean;
  } {
    const row = this.database
      .prepare(
        `SELECT capture_run_id, wallet_address, manifest_hash, source_code_commit, source_code_dirty
         FROM capture_runs WHERE capture_run_id=? AND status='COMPLETE'`,
      )
      .get(captureRunId) as {
        capture_run_id: string;
        wallet_address: string;
        manifest_hash: string;
        source_code_commit: string;
        source_code_dirty: number;
      } | undefined;
    if (!row) throw new Error(`Complete capture run not found: ${captureRunId}`);
    return {
      captureRunId: row.capture_run_id,
      walletAddress: row.wallet_address,
      manifestHash: row.manifest_hash,
      sourceCodeCommit: row.source_code_commit,
      sourceCodeDirty: row.source_code_dirty !== 0,
    };
  }

  loadCapturePayloads(captureRunId: string, endpoint: string): unknown[] {
    const rows = this.database
      .prepare(
        `SELECT c.response_json
         FROM capture_manifest_items i
         JOIN api_captures c ON c.capture_id=i.capture_id
         WHERE i.capture_run_id=? AND i.source_endpoint=?
         ORDER BY COALESCE(i.page_index, 0), i.fetched_at`,
      )
      .all(captureRunId, endpoint) as Array<{ response_json: string }>;
    return rows.map((row) => JSON.parse(row.response_json) as unknown);
  }

  captureEndpointWasComplete(captureRunId: string, endpoint: string): boolean {
    const rows = this.database
      .prepare(
        `SELECT pagination_status FROM capture_manifest_items
         WHERE capture_run_id=? AND source_endpoint=?`,
      )
      .all(captureRunId, endpoint) as Array<{ pagination_status: string }>;
    return rows.some((row) => row.pagination_status === "END_OF_DATA");
  }

  loadReplayHashes(captureRunId: string): string[] {
    const rows = this.database
      .prepare("SELECT DISTINCT report_hash FROM replay_runs WHERE capture_run_id=? ORDER BY report_hash")
      .all(captureRunId) as Array<{ report_hash: string }>;
    return rows.map((row) => row.report_hash);
  }

  saveReplay(
    targetId: string,
    trades: PublicTrade[],
    activity: PublicActivity[],
    report: ReplayReport,
    options: {
      captureRunId?: string | null;
      goldenEvaluationStatus?: string;
      capitalEstimatesBySourceEventKey?: Record<string, CapitalEstimate>;
    } = {},
  ): string {
    const now = new Date().toISOString();
    const replayRunId = randomUUID();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const insertRaw = this.database.prepare(
        `INSERT OR IGNORE INTO raw_events(
          source_event_key, target_id, identity_version, source_type, source_transaction_hash,
          source_timestamp, asset_id, condition_id, side, price_units, size_micros,
          gap_event, is_combo, raw_json, created_at, capture_run_id, event_classification
        ) VALUES (?, ?, ?, 'DATA_API_TRADE', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const trade of trades) {
        const eventKey = sourceEventKey(trade);
        const outcome = report.eventOutcomes[eventKey];
        insertRaw.run(
          eventKey,
          targetId,
          SOURCE_IDENTITY_VERSION,
          trade.transactionHash.toLowerCase(),
          trade.timestamp,
          trade.asset,
          trade.conditionId.toLowerCase(),
          trade.side,
          decimalToScaled(trade.price, PRICE_SCALE_DIGITS).toString(),
          decimalToScaled(trade.size, SHARE_SCALE_DIGITS).toString(),
          outcome?.eventClassification === "GAP_TRADE" ? 1 : 0,
          outcome?.eventClassification === "COMBO_ACTIVITY" ? 1 : 0,
          JSON.stringify(trade),
          now,
          options.captureRunId ?? null,
          outcome?.eventClassification ?? "UNRECOGNIZED",
        );
      }

      const insertActivity = this.database.prepare(
        `INSERT OR IGNORE INTO raw_events(
          source_event_key, target_id, identity_version, source_type, source_transaction_hash,
          source_timestamp, asset_id, condition_id, side, price_units, size_micros,
          gap_event, is_combo, raw_json, created_at, capture_run_id, event_classification
        ) VALUES (?, ?, ?, 'DATA_API_ACTIVITY', ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
      );
      for (const item of activity) {
        if (item.type === "TRADE") continue;
        const eventKey = activityEventKey(item);
        const outcome = report.eventOutcomes[eventKey];
        insertActivity.run(
          eventKey,
          targetId,
          SOURCE_IDENTITY_VERSION,
          item.transactionHash.toLowerCase(),
          item.timestamp,
          item.asset ?? "",
          item.conditionId?.toLowerCase() ?? "",
          item.side ?? "NONE",
          "0",
          "0",
          outcome?.eventClassification === "COMBO_ACTIVITY" ? 1 : 0,
          JSON.stringify(item),
          now,
          options.captureRunId ?? null,
          outcome?.eventClassification ?? "UNRECOGNIZED",
        );
      }

      for (const [eventKey, estimate] of Object.entries(options.capitalEstimatesBySourceEventKey ?? {})) {
        this.saveCapitalEstimate(targetId, eventKey, estimate);
      }

      const insertSignal = this.database.prepare(
        `INSERT OR IGNORE INTO signals(
          signal_id, signal_idempotency_key, source_event_key, signal_type, status,
          asset_id, condition_id, target_price_units, target_size_micros,
          sell_ratio_numerator, sell_ratio_denominator, reason,
          schema_version, signal_version, strategy_version, risk_version, replay_version,
          ruleset_snapshot_json, ruleset_hash, source_code_commit, created_at,
          execution_eligible, execution_block_reason, event_classification,
          capture_run_id, source_code_dirty, capital_estimate_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const signal of report.signals) {
        insertSignal.run(
          signal.signalId,
          signal.signalIdempotencyKey,
          signal.sourceEventKey,
          signal.signalType,
          signal.status,
          signal.asset,
          signal.conditionId,
          signal.targetPriceUnits,
          signal.targetSizeMicros,
          signal.sellRatioNumerator ?? null,
          signal.sellRatioDenominator ?? null,
          signal.reason,
          VERSIONS.schemaVersion,
          VERSIONS.signalVersion,
          VERSIONS.strategyVersion,
          VERSIONS.riskVersion,
          VERSIONS.replayVersion,
          RULESET_SNAPSHOT_JSON,
          RULESET_HASH,
          this.sourceVersion.commit,
          now,
          signal.executionEligible ? 1 : 0,
          signal.executionBlockReason ?? null,
          signal.eventClassification,
          options.captureRunId ?? null,
          this.sourceVersion.dirty ? 1 : 0,
          options.capitalEstimatesBySourceEventKey?.[signal.sourceEventKey]?.capitalEstimateId ?? null,
        );
        this.saveTransition("SIGNAL", signal.signalId, null, "CREATED", "SOURCE_EVENT_ACCEPTED", now, 0);
        this.saveTransition("SIGNAL", signal.signalId, "CREATED", "VALIDATING", "IDENTITY_AND_SCHEMA_VALIDATION", now, 1);
        this.saveTransition("SIGNAL", signal.signalId, "VALIDATING", "READY", "SIGNAL_VALID", now, 2);
        this.saveTransition("SIGNAL", signal.signalId, "READY", "PUBLISHED", "REPLAY_PUBLISHED", now, 3);
      }

      this.database
        .prepare(
          `INSERT INTO replay_runs(
            replay_run_id, target_id, status, input_rows, unique_events, duplicate_rows,
            report_hash, metrics_json, incomplete_reasons_json, schema_version,
            signal_version, strategy_version, risk_version, replay_version,
            ruleset_snapshot_json, ruleset_hash, source_code_commit, created_at,
            capture_run_id, golden_evaluation_status, source_code_dirty
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          replayRunId,
          targetId,
          report.status,
          report.metrics.inputRows,
          report.metrics.uniqueEvents,
          report.metrics.duplicateRows,
          report.reportHash,
          JSON.stringify(report.metrics),
          JSON.stringify(report.incompleteReasons),
          VERSIONS.schemaVersion,
          VERSIONS.signalVersion,
          VERSIONS.strategyVersion,
          VERSIONS.riskVersion,
          VERSIONS.replayVersion,
          RULESET_SNAPSHOT_JSON,
          RULESET_HASH,
          this.sourceVersion.commit,
          now,
          options.captureRunId ?? null,
          options.goldenEvaluationStatus ?? "NOT_EVALUATED",
          this.sourceVersion.dirty ? 1 : 0,
        );
      const insertBucketLedger = this.database.prepare(
        `INSERT OR IGNORE INTO position_bucket_ledger(
          bucket_ledger_id, replay_run_id, source_event_key, asset_id,
          historical_before_micros, historical_after_micros,
          tracked_before_micros, tracked_after_micros, recognized_sell_micros,
          reason, ruleset_hash, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const entry of report.positionLedger) {
        insertBucketLedger.run(
          createHash("sha256").update(`${replayRunId}|${entry.sourceEventKey}`).digest("hex"),
          replayRunId,
          entry.sourceEventKey,
          entry.asset,
          entry.historicalBeforeMicros,
          entry.historicalAfterMicros,
          entry.trackedBeforeMicros,
          entry.trackedAfterMicros,
          entry.recognizedSellMicros,
          entry.reason,
          RULESET_HASH,
          now,
        );
      }
      const insertClassification = this.database.prepare(
        `INSERT OR IGNORE INTO replay_event_classifications(
          replay_classification_id, replay_run_id, source_event_key, event_classification,
          signal_id, signal_type, execution_eligible, reason, schema_version,
          signal_version, replay_version, ruleset_hash, source_code_commit,
          source_code_dirty, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const [eventKey, outcome] of Object.entries(report.eventOutcomes)) {
        insertClassification.run(
          createHash("sha256").update(`${replayRunId}|${eventKey}`).digest("hex"),
          replayRunId,
          eventKey,
          outcome.eventClassification,
          outcome.signalId ?? null,
          outcome.signalType ?? null,
          outcome.executionEligible === undefined ? null : outcome.executionEligible ? 1 : 0,
          outcome.reason,
          VERSIONS.schemaVersion,
          VERSIONS.signalVersion,
          VERSIONS.replayVersion,
          RULESET_HASH,
          this.sourceVersion.commit,
          this.sourceVersion.dirty ? 1 : 0,
          now,
        );
      }
      this.saveTransition("REPLAY", replayRunId, null, "CREATED", "REPLAY_REQUESTED", now, 0);
      this.saveTransition("REPLAY", replayRunId, "CREATED", "INPUT_VALIDATING", "INPUT_RECEIVED", now, 1);
      if (report.status === "FAILED") {
        this.saveTransition("REPLAY", replayRunId, "INPUT_VALIDATING", "FAILED", "INPUT_OR_IDENTITY_INVALID", now, 2);
      } else {
        this.saveTransition("REPLAY", replayRunId, "INPUT_VALIDATING", "RUNNING", "INPUT_VALID", now, 2);
        this.saveTransition("REPLAY", replayRunId, "RUNNING", "COMPARING", "PROJECTION_COMPLETE", now, 3);
        this.saveTransition(
          "REPLAY",
          replayRunId,
          "COMPARING",
          report.status,
          report.status === "PASSED" ? "ALL_ACCEPTANCE_CHECKS_PASSED" : "ACCEPTANCE_EVIDENCE_INCOMPLETE",
          now,
          4,
        );
      }
      this.database.exec("COMMIT");
      return replayRunId;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private saveTransition(
    entityType: string,
    entityId: string,
    fromState: string | null,
    toState: string,
    reason: string,
    createdAt: string,
    sequence: number,
  ): void {
    const transitionId = createHash("sha256")
      .update([entityType, entityId, String(sequence), fromState ?? "NONE", toState, RULESET_HASH].join("|"))
      .digest("hex");
    this.database
      .prepare(
        `INSERT OR IGNORE INTO state_transitions(
          transition_id, entity_type, entity_id, from_state, to_state, reason,
          schema_version, signal_version, strategy_version, risk_version, replay_version,
          ruleset_snapshot_json, ruleset_hash, source_code_commit, created_at, source_code_dirty
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        transitionId,
        entityType,
        entityId,
        fromState,
        toState,
        reason,
        VERSIONS.schemaVersion,
        VERSIONS.signalVersion,
        VERSIONS.strategyVersion,
        VERSIONS.riskVersion,
        VERSIONS.replayVersion,
        RULESET_SNAPSHOT_JSON,
        RULESET_HASH,
        this.sourceVersion.commit,
        createdAt,
        this.sourceVersion.dirty ? 1 : 0,
      );
  }

  close(): void {
    this.database.close();
  }
}
