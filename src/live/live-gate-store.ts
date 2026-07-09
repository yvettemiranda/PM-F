import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { RULESET_HASH, stableJson, VERSIONS } from "../domain/versioning.js";
import type { SourceVersion } from "../infra/source-version.js";
import type {
  ExecutionMode,
  LiveGateCheck,
  LiveGateRunType,
  LiveGateState,
  LiveGateStateRow,
  LiveWalletMetadata,
  RequestedExecutionMode,
} from "./live-gate-types.js";

export interface SavedLiveGateRun {
  runId: string;
}

export interface LiveGateRunRecord {
  live_gate_run_id: string;
  run_type: LiveGateRunType;
  allowed: number;
  created_at: string;
}

export interface RiskSnapshotInput {
  mode: ExecutionMode;
  walletAddress: string | null;
  balanceMicros: string | null;
  exposureMicros: string;
  dailyLossMicros: string;
  riskStatus: "SAFE" | "BLOCKED" | "UNKNOWN";
  checks: LiveGateCheck[];
  liveGateRunId: string;
  now: string;
}

function hash(parts: Array<string | number>): string {
  return createHash("sha256").update(parts.join("|")).digest("hex");
}

export class LiveGateStore {
  constructor(
    private readonly database: DatabaseSync,
    private readonly sourceVersion: SourceVersion,
    private readonly now: () => Date,
  ) {}

  ensureDefaultState(): LiveGateStateRow {
    const now = this.now().toISOString();
    this.database.prepare(
      `INSERT OR IGNORE INTO live_gate_state(
        state_id,execution_mode,live_gate_state,requested_execution_mode,last_preflight_id,
        state_reason,source_code_commit,source_code_dirty,config_version,created_at,updated_at
      ) VALUES ('default','PAPER','LIVE_DISABLED',NULL,NULL,'DEFAULT_DISABLED',?,?,?,?,?)`,
    ).run(this.sourceVersion.commit, this.sourceVersion.dirty ? 1 : 0, VERSIONS.configVersion, now, now);
    return this.state();
  }

  state(): LiveGateStateRow {
    const row = this.database.prepare("SELECT * FROM live_gate_state WHERE state_id='default'")
      .get() as LiveGateStateRow | undefined;
    if (!row) throw new Error("LIVE_GATE_STATE_NOT_INITIALIZED");
    return row;
  }

  setState(input: {
    executionMode: ExecutionMode;
    liveGateState: LiveGateState;
    requestedExecutionMode: RequestedExecutionMode | null;
    lastPreflightId: string | null;
    reason: string;
    actor: string;
    metadata: Record<string, unknown>;
    now: string;
  }): void {
    const previous = this.state();
    this.database.prepare(
      `UPDATE live_gate_state
       SET execution_mode=?,live_gate_state=?,requested_execution_mode=?,last_preflight_id=?,
           state_reason=?,source_code_commit=?,source_code_dirty=?,config_version=?,updated_at=?
       WHERE state_id='default'`,
    ).run(
      input.executionMode,
      input.liveGateState,
      input.requestedExecutionMode,
      input.lastPreflightId,
      input.reason,
      this.sourceVersion.commit,
      this.sourceVersion.dirty ? 1 : 0,
      VERSIONS.configVersion,
      input.now,
    );
    this.database.prepare(
      `INSERT INTO live_gate_state_transitions(
        transition_id,from_execution_mode,to_execution_mode,from_live_gate_state,to_live_gate_state,
        reason,actor,metadata_json,source_code_commit,source_code_dirty,config_version,created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      hash(["LIVE_GATE_TRANSITION", input.now, previous.execution_mode, input.executionMode, previous.live_gate_state, input.liveGateState, input.reason]),
      previous.execution_mode,
      input.executionMode,
      previous.live_gate_state,
      input.liveGateState,
      input.reason,
      input.actor,
      stableJson(input.metadata),
      this.sourceVersion.commit,
      this.sourceVersion.dirty ? 1 : 0,
      VERSIONS.configVersion,
      input.now,
    );
  }

  activeWallet(): LiveWalletMetadata | null {
    const row = this.database.prepare(
      `SELECT live_wallet_id,wallet_address,wallet_type,network,status
       FROM live_wallets
       WHERE status IN ('ACTIVE','REGISTERED')
       ORDER BY status='ACTIVE' DESC, created_at DESC LIMIT 1`,
    ).get() as {
      live_wallet_id: string;
      wallet_address: string;
      wallet_type: string;
      network: string;
      status: "REGISTERED" | "ACTIVE" | "DISABLED";
    } | undefined;
    return row ? {
      liveWalletId: row.live_wallet_id,
      walletAddress: row.wallet_address,
      walletType: row.wallet_type,
      network: row.network,
      status: row.status,
    } : null;
  }

  saveRun(input: {
    runType: LiveGateRunType;
    allowed: boolean;
    checks: LiveGateCheck[];
    blockedReasons: string[];
    requestedExecutionMode: RequestedExecutionMode | null;
    executionMode: ExecutionMode | null;
    liveGateState: LiveGateState | null;
    signalId: string | null;
    riskDecisionId: string | null;
    rulesetHash: string | null;
    now: string;
  }): SavedLiveGateRun {
    const runId = randomUUID();
    this.database.prepare(
      `INSERT INTO live_gate_runs(
        live_gate_run_id,run_type,allowed,blocked_reasons_json,checks_json,
        requested_execution_mode,execution_mode,live_gate_state,risk_decision_id,
        signal_id,ruleset_hash,source_code_commit,source_code_dirty,config_version,created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      runId,
      input.runType,
      input.allowed ? 1 : 0,
      stableJson(input.blockedReasons),
      stableJson(input.checks),
      input.requestedExecutionMode,
      input.executionMode,
      input.liveGateState,
      input.riskDecisionId,
      input.signalId,
      input.rulesetHash,
      this.sourceVersion.commit,
      this.sourceVersion.dirty ? 1 : 0,
      VERSIONS.configVersion,
      input.now,
    );
    return { runId };
  }

  saveRiskSnapshot(input: RiskSnapshotInput): void {
    this.database.prepare(
      `INSERT INTO risk_snapshots(
        risk_snapshot_id,mode,wallet_address,balance_micros,exposure_micros,daily_loss_micros,
        risk_status,checks_json,live_gate_run_id,source_code_commit,source_code_dirty,
        config_version,created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      hash(["RISK_SNAPSHOT", input.liveGateRunId]),
      input.mode,
      input.walletAddress,
      input.balanceMicros,
      input.exposureMicros,
      input.dailyLossMicros,
      input.riskStatus,
      stableJson(input.checks),
      input.liveGateRunId,
      this.sourceVersion.commit,
      this.sourceVersion.dirty ? 1 : 0,
      VERSIONS.configVersion,
      input.now,
    );
  }

  audit(input: {
    entityType: string;
    entityId: string;
    action: string;
    reason: string | null;
    metadata: Record<string, unknown>;
    now: string;
  }): void {
    this.database.prepare(
      `INSERT OR IGNORE INTO audit_log(
        audit_id,timestamp,entity_type,entity_id,action,reason,ruleset_hash,
        source_code_commit,source_code_dirty,config_version,metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      hash(["AUDIT", input.entityType, input.entityId, input.action, input.reason ?? "NONE", input.now]),
      input.now,
      input.entityType,
      input.entityId,
      input.action,
      input.reason,
      RULESET_HASH,
      this.sourceVersion.commit,
      this.sourceVersion.dirty ? 1 : 0,
      VERSIONS.configVersion,
      stableJson(input.metadata),
    );
  }

  latestAllowedPreflight(): LiveGateRunRecord | null {
    const row = this.database.prepare(
      `SELECT live_gate_run_id,run_type,allowed,created_at
       FROM live_gate_runs
       WHERE run_type='PREFLIGHT' AND allowed=1
       ORDER BY created_at DESC LIMIT 1`,
    ).get() as LiveGateRunRecord | undefined;
    return row ?? null;
  }

  prerequisites(): Array<{ prerequisite_key: string; status: string; evidence_json: string }> {
    return this.database.prepare(
      "SELECT prerequisite_key,status,evidence_json FROM live_gate_prerequisites ORDER BY prerequisite_key",
    ).all() as unknown as Array<{ prerequisite_key: string; status: string; evidence_json: string }>;
  }
}
