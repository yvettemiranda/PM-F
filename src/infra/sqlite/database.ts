import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { ApiCapture } from "../../adapters/polymarket-public.js";
import { SOURCE_IDENTITY_VERSION, sourceEventKey } from "../../domain/idempotency.js";
import type { PublicTrade, WalletIdentityReport } from "../../domain/models.js";
import { decimalToScaled, PRICE_SCALE_DIGITS, SHARE_SCALE_DIGITS } from "../../domain/fixed.js";
import {
  RULESET_HASH,
  RULESET_SNAPSHOT_JSON,
  VERSIONS,
} from "../../domain/versioning.js";
import type { ReplayReport } from "../../replay/replay-engine.js";

const SOURCE_CODE_COMMIT = process.env.SOURCE_CODE_COMMIT ?? "UNCOMMITTED";

export class Phase0Database {
  private readonly database: DatabaseSync;

  constructor(path: string) {
    this.database = new DatabaseSync(path);
  }

  initialize(): void {
    const sql = readFileSync(new URL("./001_phase0.sql", import.meta.url), "utf8");
    this.database.exec(sql);
    this.database
      .prepare(
        `INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)
         `,
      )
      .run(VERSIONS.schemaVersion, new Date().toISOString());
    this.database
      .prepare(
        `INSERT OR IGNORE INTO rulesets(
          ruleset_hash, schema_version, signal_version, strategy_version, risk_version,
          replay_version, ruleset_snapshot_json, source_code_commit, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        RULESET_HASH,
        VERSIONS.schemaVersion,
        VERSIONS.signalVersion,
        VERSIONS.strategyVersion,
        VERSIONS.riskVersion,
        VERSIONS.replayVersion,
        RULESET_SNAPSHOT_JSON,
        SOURCE_CODE_COMMIT,
        new Date().toISOString(),
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

  saveCapture<T>(endpoint: string, capture: ApiCapture<T>): void {
    const responseJson = JSON.stringify(capture.data);
    const payloadHash = createHash("sha256").update(responseJson).digest("hex");
    const captureId = createHash("sha256").update(`${capture.url}|${capture.fetchedAt}|${payloadHash}`).digest("hex");
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

  saveReplay(targetId: string, trades: PublicTrade[], report: ReplayReport): string {
    const now = new Date().toISOString();
    const replayRunId = randomUUID();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const insertRaw = this.database.prepare(
        `INSERT OR IGNORE INTO raw_events(
          source_event_key, target_id, identity_version, source_type, source_transaction_hash,
          source_timestamp, asset_id, condition_id, side, price_units, size_micros,
          gap_event, is_combo, raw_json, created_at
        ) VALUES (?, ?, ?, 'DATA_API_TRADE', ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`,
      );
      for (const trade of trades) {
        insertRaw.run(
          sourceEventKey(trade),
          targetId,
          SOURCE_IDENTITY_VERSION,
          trade.transactionHash.toLowerCase(),
          trade.timestamp,
          trade.asset,
          trade.conditionId.toLowerCase(),
          trade.side,
          decimalToScaled(trade.price, PRICE_SCALE_DIGITS).toString(),
          decimalToScaled(trade.size, SHARE_SCALE_DIGITS).toString(),
          JSON.stringify(trade),
          now,
        );
      }

      const insertSignal = this.database.prepare(
        `INSERT OR IGNORE INTO signals(
          signal_id, signal_idempotency_key, source_event_key, signal_type, status,
          asset_id, condition_id, target_price_units, target_size_micros,
          sell_ratio_numerator, sell_ratio_denominator, reason,
          schema_version, signal_version, strategy_version, risk_version, replay_version,
          ruleset_snapshot_json, ruleset_hash, source_code_commit, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          SOURCE_CODE_COMMIT,
          now,
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
            ruleset_snapshot_json, ruleset_hash, source_code_commit, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          SOURCE_CODE_COMMIT,
          now,
        );
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
          ruleset_snapshot_json, ruleset_hash, source_code_commit, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        SOURCE_CODE_COMMIT,
        createdAt,
      );
  }

  close(): void {
    this.database.close();
  }
}
