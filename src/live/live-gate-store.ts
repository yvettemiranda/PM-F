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
  execution_mode: ExecutionMode | null;
  live_gate_state: LiveGateState | null;
  source_code_commit: string;
  source_code_dirty: number;
  created_at: string;
}

export interface LiveGateStateGuard {
  state: LiveGateStateRow;
  transitionCount: number;
  dataVersion: number;
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

  stateGuard(): LiveGateStateGuard {
    const count = this.database.prepare("SELECT count(*) count FROM live_gate_state_transitions")
      .get() as { count: number };
    const dataVersion = this.database.prepare("PRAGMA data_version").get() as { data_version: number };
    return { state: this.state(), transitionCount: count.count, dataVersion: dataVersion.data_version };
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
    this.writeState(input, null);
  }

  /**
   * Atomically moves the gate only if no state transition (including a
   * same-value emergency disable) occurred since the caller captured guard.
   */
  setStateIfUnchanged(input: {
    executionMode: ExecutionMode;
    liveGateState: LiveGateState;
    requestedExecutionMode: RequestedExecutionMode | null;
    lastPreflightId: string | null;
    reason: string;
    actor: string;
    metadata: Record<string, unknown>;
    now: string;
  }, guard: LiveGateStateGuard): boolean {
    return this.writeState(input, guard);
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
    rulesetHash?: string;
  }): void {
    const rulesetHash = input.rulesetHash ?? RULESET_HASH;
    const registered = this.database.prepare(
      "SELECT config_version FROM ruleset_registry WHERE ruleset_hash=?",
    ).get(rulesetHash) as { config_version: string } | undefined;
    if (!registered) throw new Error(`LIVE_GATE_AUDIT_RULESET_NOT_REGISTERED:${rulesetHash}`);
    this.database.prepare(
      `INSERT INTO audit_log(
        audit_id,timestamp,entity_type,entity_id,action,reason,ruleset_hash,
        source_code_commit,source_code_dirty,config_version,metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      hash(["AUDIT", input.entityType, input.entityId, input.action, input.reason ?? "NONE", input.now, randomUUID()]),
      input.now,
      input.entityType,
      input.entityId,
      input.action,
      input.reason,
      rulesetHash,
      this.sourceVersion.commit,
      this.sourceVersion.dirty ? 1 : 0,
      registered.config_version,
      stableJson(input.metadata),
    );
  }

  latestAllowedPreflight(): LiveGateRunRecord | null {
    const row = this.database.prepare(
      `SELECT live_gate_run_id,run_type,allowed,execution_mode,live_gate_state,
              source_code_commit,source_code_dirty,created_at
       FROM live_gate_runs
       WHERE run_type='PREFLIGHT' AND allowed=1
       ORDER BY created_at DESC,rowid DESC LIMIT 1`,
    ).get() as LiveGateRunRecord | undefined;
    return row ?? null;
  }

  run(runId: string): LiveGateRunRecord | null {
    const row = this.database.prepare(
      `SELECT live_gate_run_id,run_type,allowed,execution_mode,live_gate_state,
              source_code_commit,source_code_dirty,created_at
       FROM live_gate_runs WHERE live_gate_run_id=?`,
    ).get(runId) as LiveGateRunRecord | undefined;
    return row ?? null;
  }

  prerequisites(): Array<{ prerequisite_key: string; status: string; evidence_json: string; updated_at: string }> {
    return this.database.prepare(
      "SELECT prerequisite_key,status,evidence_json,updated_at FROM live_gate_prerequisites ORDER BY prerequisite_key",
    ).all() as unknown as Array<{ prerequisite_key: string; status: string; evidence_json: string; updated_at: string }>;
  }

  private writeState(input: {
    executionMode: ExecutionMode;
    liveGateState: LiveGateState;
    requestedExecutionMode: RequestedExecutionMode | null;
    lastPreflightId: string | null;
    reason: string;
    actor: string;
    metadata: Record<string, unknown>;
    now: string;
  }, guard: LiveGateStateGuard | null): boolean {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const previous = this.state();
      const transitionCount = (this.database.prepare("SELECT count(*) count FROM live_gate_state_transitions")
        .get() as { count: number }).count;
      const dataVersion = (this.database.prepare("PRAGMA data_version").get() as { data_version: number }).data_version;
      if (guard && (
        !this.sameState(previous, guard.state)
        || transitionCount !== guard.transitionCount
        || dataVersion !== guard.dataVersion
      )) {
        this.database.exec("ROLLBACK");
        return false;
      }
      // Capture the exact local Signal-ingest boundary in the same transaction
      // that activates Live. The Runner must never substitute its later poll
      // timestamp, otherwise signals created after activation but before the
      // next poll can be skipped permanently.
      const signalBoundarySequence = input.executionMode === "LIVE" && input.liveGateState === "LIVE_ACTIVE"
        ? (this.database.prepare(
          "SELECT COALESCE(MAX(signal_sequence),0) value FROM signal_ingest_sequences",
        ).get() as { value: number }).value
        : null;
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
          reason,actor,metadata_json,source_code_commit,source_code_dirty,config_version,created_at,
          signal_boundary_sequence
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        hash([
          "LIVE_GATE_TRANSITION",
          transitionCount,
          input.now,
          previous.execution_mode,
          input.executionMode,
          previous.live_gate_state,
          input.liveGateState,
          input.reason,
          signalBoundarySequence ?? "NO_SIGNAL_BOUNDARY",
        ]),
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
        signalBoundarySequence,
      );
      this.database.exec("COMMIT");
      return true;
    } catch (error) {
      if (this.database.isTransaction) this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private sameState(left: LiveGateStateRow, right: LiveGateStateRow): boolean {
    return left.state_id === right.state_id
      && left.execution_mode === right.execution_mode
      && left.live_gate_state === right.live_gate_state
      && left.requested_execution_mode === right.requested_execution_mode
      && left.last_preflight_id === right.last_preflight_id
      && left.state_reason === right.state_reason
      && left.source_code_commit === right.source_code_commit
      && left.source_code_dirty === right.source_code_dirty
      && left.config_version === right.config_version
      && left.created_at === right.created_at
      && left.updated_at === right.updated_at;
  }
}
