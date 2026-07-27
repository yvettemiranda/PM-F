import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { stableJson } from "../domain/versioning.js";
import type { SourceVersion } from "../infra/source-version.js";
import type {
  CampaignDefinition,
  CampaignState,
  CompatibilityIdentity,
  CoreCompatibilityManifest,
  SessionValidationReport,
  ValidationCheckpoint,
  ValidationCheckpointKind,
  ValidationSessionDefinition,
  ValidationSessionKind,
  ValidationSessionState,
  CheckpointEvidence,
  CampaignValidationReport,
} from "./types.js";

interface CampaignRow {
  campaign_id: string;
  target_id: string;
  baseline_run_id: string;
  paper_account_id: string;
  initial_balance_micros: string;
  required_active_runtime_ms: number;
  required_continuous_runtime_ms: number;
  qualifying_runtime_ms: number;
  checkpoint_interval_ms: number;
  max_checkpoint_gap_ms: number;
  core_compatibility_hash: string;
  core_manifest_json: string;
  source_code_commit: string;
  source_code_dirty: number;
  created_at: string;
}

interface SessionRow {
  session_id: string;
  campaign_id: string;
  sequence: number;
  session_kind: ValidationSessionKind;
  planned_duration_ms: number;
  source_code_commit: string;
  source_code_dirty: number;
  live_gate_transition_count_at_start: number;
  validation_policy_hash: string | null;
  verification_suite_hash: string | null;
  operator_build_hash: string | null;
  artifact_provenance_hash: string | null;
  started_at: string;
}

interface CheckpointRow {
  checkpoint_id: string;
  campaign_id: string;
  session_id: string;
  sequence: number;
  checkpoint_kind: ValidationCheckpointKind;
  observed_at: string;
  elapsed_runtime_ms: number;
  observe_active: number;
  paper_active: number;
  consistency_safe: number;
  execution_mode: "PAPER";
  live_gate_state: "LIVE_DISABLED";
  live_gate_transition_count: number;
  observe_checkpoint_id: string | null;
  paper_consumer_created_at: string | null;
  paper_consumer_signal_id: string | null;
  position_projection_hash: string | null;
  portfolio_projection_hash: string | null;
  replay_state: string | null;
  capital_snapshot_id: string | null;
  last_processed_event_id: string | null;
  evidence_json: string;
  checkpoint_hash: string;
  idempotency_key: string;
}

interface ReportRow {
  report_id: string;
  report_json: string;
}

export interface PaperValidationSafetyState {
  executionMode: "PAPER";
  liveGateState: "LIVE_DISABLED";
  transitionCount: number;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function sourceVersion(commit: string, dirty: number): SourceVersion {
  return { commit, dirty: dirty === 1 };
}

function compatibilityIdentity(row: SessionRow): CompatibilityIdentity | null {
  if (
    row.validation_policy_hash === null
    || row.verification_suite_hash === null
    || row.operator_build_hash === null
    || row.artifact_provenance_hash === null
  ) return null;
  return {
    validationPolicyHash: row.validation_policy_hash,
    verificationSuiteHash: row.verification_suite_hash,
    operatorBuildHash: row.operator_build_hash,
    artifactProvenanceHash: row.artifact_provenance_hash,
  };
}

function parseJson<T>(value: string, label: string): T {
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    throw new Error(`${label}_JSON_INVALID`, { cause: error });
  }
}

export class PaperValidationStore {
  readonly database: DatabaseSync;

  constructor(readonly databasePath: string) {
    this.database = new DatabaseSync(databasePath);
    this.database.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;");
  }

  transaction<T>(action: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  assertPaperSafetyState(): PaperValidationSafetyState {
    const row = this.database.prepare(
      "SELECT execution_mode,live_gate_state FROM live_gate_state WHERE state_id='default'",
    ).get() as { execution_mode: string; live_gate_state: string } | undefined;
    if (!row || row.execution_mode !== "PAPER" || row.live_gate_state !== "LIVE_DISABLED") {
      throw new Error(
        `PAPER_VALIDATION_UNSAFE_MODE:${row?.execution_mode ?? "MISSING"}:${row?.live_gate_state ?? "MISSING"}`,
      );
    }
    const transition = this.database.prepare(
      "SELECT count(*) count FROM live_gate_state_transitions",
    ).get() as { count: number | bigint };
    const transitionCount = Number(transition.count);
    if (!Number.isSafeInteger(transitionCount) || transitionCount < 0) {
      throw new Error("PAPER_VALIDATION_LIVE_GATE_TRANSITION_COUNT_INVALID");
    }
    return {
      executionMode: "PAPER",
      liveGateState: "LIVE_DISABLED",
      transitionCount,
    };
  }

  assertCampaignBindings(input: {
    targetId: string;
    baselineRunId: string;
    paperAccountId: string;
    initialBalanceMicros: string;
    sourceVersion: SourceVersion;
    schemaVersion: string;
    strategyVersion: string;
    riskVersion: string;
    paperVersion: string;
    rulesetHash: string;
    now: string;
    handoff?: {
      fromCampaignId: string;
      toCampaignId: string;
    };
  }): {
    mode: "PAPER";
    accountId: string;
    baselineRunId: string;
    fromCampaignId: string;
    toCampaignId: string;
    terminalExecutionCount: number;
    openPositionCount: number;
  } | null {
    const target = this.database.prepare(
      "SELECT identity_status FROM monitor_targets WHERE target_id=?",
    ).get(input.targetId) as { identity_status: string } | undefined;
    if (!target || target.identity_status !== "IDENTITY_CONFIRMED") {
      throw new Error(`PAPER_VALIDATION_TARGET_NOT_CONFIRMED:${input.targetId}`);
    }
    const baseline = this.database.prepare(
      "SELECT target_id,status FROM position_baseline_runs WHERE baseline_run_id=?",
    ).get(input.baselineRunId) as { target_id: string; status: string } | undefined;
    if (!baseline || baseline.target_id !== input.targetId || baseline.status !== "READY") {
      throw new Error(`PAPER_VALIDATION_BASELINE_NOT_READY:${input.baselineRunId}`);
    }
    const account = this.database.prepare(
      `SELECT target_id,status,initial_balance_micros,cash_balance_micros,
              reserved_balance_micros,realized_pnl_micros,schema_version,
              strategy_version,risk_version,paper_version,ruleset_hash,
              source_code_commit,source_code_dirty
       FROM paper_accounts WHERE paper_account_id=?`,
    ).get(input.paperAccountId) as {
      target_id: string | null;
      status: string;
      initial_balance_micros: string;
      cash_balance_micros: string;
      reserved_balance_micros: string;
      realized_pnl_micros: string;
      schema_version: string;
      strategy_version: string;
      risk_version: string;
      paper_version: string;
      ruleset_hash: string;
      source_code_commit: string;
      source_code_dirty: number;
    } | undefined;
    if (!account || account.target_id !== input.targetId || account.status !== "ACTIVE") {
      throw new Error(`PAPER_VALIDATION_ACCOUNT_NOT_ACTIVE:${input.paperAccountId}`);
    }
    if (input.handoff) {
      if (account.initial_balance_micros !== input.initialBalanceMicros) {
        throw new Error(`PAPER_VALIDATION_ACCOUNT_INITIAL_BALANCE_MISMATCH:${input.paperAccountId}`);
      }
      const previous = this.database.prepare(
        `SELECT paper_account_id,target_id,baseline_run_id
         FROM paper_validation_campaigns WHERE campaign_id=?`,
      ).get(input.handoff.fromCampaignId) as {
        paper_account_id: string;
        target_id: string;
        baseline_run_id: string;
      } | undefined;
      if (
        !previous
        || previous.paper_account_id !== input.paperAccountId
        || previous.target_id !== input.targetId
        || previous.baseline_run_id !== input.baselineRunId
      ) {
        throw new Error(`PAPER_VALIDATION_ACCOUNT_HANDOFF_BINDING_MISMATCH:${input.paperAccountId}`);
      }
      const unsafe = this.database.prepare(
        `SELECT
          (SELECT count(*) FROM paper_executions
           WHERE paper_account_id=?
             AND execution_type='TARGET_BUY'
             AND state IN ('WAITING_EXECUTION','PARTIALLY_EXECUTED')) pending_buys,
          (SELECT count(*) FROM paper_reservations
           WHERE paper_account_id=? AND status='ACTIVE') active_reservations`,
      ).get(input.paperAccountId, input.paperAccountId) as {
        pending_buys: number;
        active_reservations: number;
      };
      if (unsafe.pending_buys !== 0 || unsafe.active_reservations !== 0) {
        throw new Error(`PAPER_VALIDATION_ACCOUNT_HANDOFF_PENDING_BUY:${input.paperAccountId}`);
      }
      const latestLedger = this.database.prepare(
        `SELECT cash_after_micros,reserved_after_micros
         FROM paper_cash_ledger WHERE paper_account_id=?
         ORDER BY created_at DESC,cash_ledger_id DESC LIMIT 1`,
      ).get(input.paperAccountId) as {
        cash_after_micros: string;
        reserved_after_micros: string;
      } | undefined;
      if (
        !latestLedger
        || latestLedger.cash_after_micros !== account.cash_balance_micros
        || latestLedger.reserved_after_micros !== account.reserved_balance_micros
      ) {
        throw new Error(`PAPER_VALIDATION_ACCOUNT_HANDOFF_LEDGER_MISMATCH:${input.paperAccountId}`);
      }
      const ruleset = this.database.prepare(
        "SELECT ruleset_snapshot_json FROM rulesets WHERE ruleset_hash=?",
      ).get(input.rulesetHash) as { ruleset_snapshot_json: string } | undefined;
      if (!ruleset) throw new Error(`PAPER_VALIDATION_RULESET_NOT_FOUND:${input.rulesetHash}`);
      this.database.prepare(
        `UPDATE paper_accounts
         SET schema_version=?,strategy_version=?,risk_version=?,paper_version=?,
             ruleset_snapshot_json=?,ruleset_hash=?,source_code_commit=?,
             source_code_dirty=?,updated_at=?
         WHERE paper_account_id=? AND status='ACTIVE'`,
      ).run(
        input.schemaVersion,
        input.strategyVersion,
        input.riskVersion,
        input.paperVersion,
        ruleset.ruleset_snapshot_json,
        input.rulesetHash,
        input.sourceVersion.commit,
        input.sourceVersion.dirty ? 1 : 0,
        input.now,
        input.paperAccountId,
      );
      const activity = this.database.prepare(
        `SELECT
          (SELECT count(*) FROM paper_executions
           WHERE paper_account_id=?
             AND state IN ('EXECUTED','EXPIRED','REJECTED','CANCELLED')) terminal_executions,
          (SELECT count(*) FROM paper_positions
           WHERE paper_account_id=?
             AND status IN ('OPEN','PARTIALLY_CLOSED','SETTLEMENT_PENDING','FROZEN')) open_positions`,
      ).get(input.paperAccountId, input.paperAccountId) as {
        terminal_executions: number;
        open_positions: number;
      };
      return {
        mode: "PAPER",
        accountId: input.paperAccountId,
        baselineRunId: input.baselineRunId,
        fromCampaignId: input.handoff.fromCampaignId,
        toCampaignId: input.handoff.toCampaignId,
        terminalExecutionCount: activity.terminal_executions,
        openPositionCount: activity.open_positions,
      };
    }
    if (
      account.initial_balance_micros !== input.initialBalanceMicros
      || account.cash_balance_micros !== input.initialBalanceMicros
      || account.reserved_balance_micros !== "0"
      || account.realized_pnl_micros !== "0"
    ) {
      throw new Error(`PAPER_VALIDATION_ACCOUNT_NOT_CLEAN:${input.paperAccountId}`);
    }
    if (account.source_code_commit !== input.sourceVersion.commit || account.source_code_dirty !== 0) {
      throw new Error(`PAPER_VALIDATION_ACCOUNT_VERSION_MISMATCH:${input.paperAccountId}`);
    }
    if (
      account.schema_version !== input.schemaVersion
      || account.strategy_version !== input.strategyVersion
      || account.risk_version !== input.riskVersion
      || account.paper_version !== input.paperVersion
      || account.ruleset_hash !== input.rulesetHash
    ) {
      throw new Error(`PAPER_VALIDATION_ACCOUNT_RULESET_MISMATCH:${input.paperAccountId}`);
    }
    const activity = this.database.prepare(
      `SELECT
        (SELECT count(*) FROM paper_executions WHERE paper_account_id=?) executions,
        (SELECT count(*) FROM paper_positions WHERE paper_account_id=?) positions,
        (SELECT count(*) FROM paper_signal_consumptions WHERE paper_account_id=?) consumptions`,
    ).get(input.paperAccountId, input.paperAccountId, input.paperAccountId) as {
      executions: number;
      positions: number;
      consumptions: number;
    };
    if (activity.executions !== 0 || activity.positions !== 0 || activity.consumptions !== 0) {
      throw new Error(`PAPER_VALIDATION_ACCOUNT_HAS_ACTIVITY:${input.paperAccountId}`);
    }
    const cashRows = this.database.prepare(
      `SELECT paper_execution_id,entry_type,cash_delta_micros,reserved_delta_micros,
              cash_after_micros,reserved_after_micros
       FROM paper_cash_ledger WHERE paper_account_id=?
       ORDER BY created_at,cash_ledger_id`,
    ).all(input.paperAccountId) as Array<{
      paper_execution_id: string | null;
      entry_type: string;
      cash_delta_micros: string;
      reserved_delta_micros: string;
      cash_after_micros: string;
      reserved_after_micros: string;
    }>;
    const initialDeposit = cashRows[0];
    if (
      cashRows.length !== 1
      || !initialDeposit
      || initialDeposit.paper_execution_id !== null
      || initialDeposit.entry_type !== "INITIAL_DEPOSIT"
      || initialDeposit.cash_delta_micros !== input.initialBalanceMicros
      || initialDeposit.reserved_delta_micros !== "0"
      || initialDeposit.cash_after_micros !== input.initialBalanceMicros
      || initialDeposit.reserved_after_micros !== "0"
    ) {
      throw new Error(`PAPER_VALIDATION_ACCOUNT_LEDGER_NOT_CLEAN:${input.paperAccountId}`);
    }
    const checkpoint = this.database.prepare(
      `SELECT last_signal_created_at,last_signal_id
       FROM paper_consumer_checkpoints WHERE paper_account_id=?`,
    ).get(input.paperAccountId) as {
      last_signal_created_at: string | null;
      last_signal_id: string | null;
    } | undefined;
    if (!checkpoint || checkpoint.last_signal_created_at !== null || checkpoint.last_signal_id !== null) {
      throw new Error(`PAPER_VALIDATION_CONSUMER_CHECKPOINT_NOT_CLEAN:${input.paperAccountId}`);
    }
    return null;
  }

  insertCampaign(input: CampaignDefinition & {
    schemaVersion: string;
    signalVersion: string;
    strategyVersion: string;
    riskVersion: string;
    paperVersion: string;
    rulesetHash: string;
    configVersion: string;
  }): void {
    this.database.prepare(
      `INSERT INTO paper_validation_campaigns(
        campaign_id,target_id,baseline_run_id,paper_account_id,initial_balance_micros,
        required_active_runtime_ms,required_continuous_runtime_ms,qualifying_runtime_ms,
        checkpoint_interval_ms,max_checkpoint_gap_ms,core_compatibility_hash,
        core_manifest_json,schema_version,signal_version,strategy_version,risk_version,
        paper_version,ruleset_hash,config_version,source_code_commit,source_code_dirty,
        execution_mode,live_gate_state,created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        'PAPER', 'LIVE_DISABLED', ?)`,
    ).run(
      input.campaignId,
      input.targetId,
      input.baselineRunId,
      input.paperAccountId,
      input.initialBalanceMicros,
      input.requiredActiveRuntimeMs,
      input.requiredContinuousRuntimeMs,
      input.qualifyingRuntimeMs,
      input.checkpointIntervalMs,
      input.maxCheckpointGapMs,
      input.coreCompatibilityHash,
      stableJson(input.coreManifest),
      input.schemaVersion,
      input.signalVersion,
      input.strategyVersion,
      input.riskVersion,
      input.paperVersion,
      input.rulesetHash,
      input.configVersion,
      input.sourceVersion.commit,
      input.sourceVersion.dirty ? 1 : 0,
      input.createdAt,
    );
  }

  campaign(campaignId: string): CampaignDefinition {
    const row = this.database.prepare(
      "SELECT * FROM paper_validation_campaigns WHERE campaign_id=?",
    ).get(campaignId) as unknown as CampaignRow | undefined;
    if (!row) throw new Error(`PAPER_VALIDATION_CAMPAIGN_NOT_FOUND:${campaignId}`);
    return {
      campaignId: row.campaign_id,
      targetId: row.target_id,
      baselineRunId: row.baseline_run_id,
      paperAccountId: row.paper_account_id,
      initialBalanceMicros: row.initial_balance_micros,
      requiredActiveRuntimeMs: row.required_active_runtime_ms,
      requiredContinuousRuntimeMs: row.required_continuous_runtime_ms,
      qualifyingRuntimeMs: row.qualifying_runtime_ms,
      checkpointIntervalMs: row.checkpoint_interval_ms,
      maxCheckpointGapMs: row.max_checkpoint_gap_ms,
      coreCompatibilityHash: row.core_compatibility_hash,
      coreManifest: parseJson<CoreCompatibilityManifest>(row.core_manifest_json, "CORE_MANIFEST"),
      sourceVersion: sourceVersion(row.source_code_commit, row.source_code_dirty),
      createdAt: row.created_at,
    };
  }

  campaignState(campaignId: string): CampaignState {
    const row = this.database.prepare(
      `SELECT to_state FROM paper_validation_transitions
       WHERE entity_type='CAMPAIGN' AND campaign_id=?
       ORDER BY sequence DESC LIMIT 1`,
    ).get(campaignId) as { to_state: CampaignState } | undefined;
    if (!row) throw new Error(`PAPER_VALIDATION_CAMPAIGN_STATE_MISSING:${campaignId}`);
    return row.to_state;
  }

  campaignIdsForTarget(targetId: string): string[] {
    return (this.database.prepare(
      "SELECT campaign_id FROM paper_validation_campaigns WHERE target_id=? ORDER BY created_at,campaign_id",
    ).all(targetId) as unknown as Array<{ campaign_id: string }>).map((row) => row.campaign_id);
  }

  insertSession(input: {
    sessionId: string;
    campaignId: string;
    sequence: number;
    sessionKind: ValidationSessionKind;
    plannedDurationMs: number;
    coreCompatibilityHash: string;
    schemaVersion: string;
    rulesetHash: string;
    configVersion: string;
    sourceVersion: SourceVersion;
    compatibilityIdentity: CompatibilityIdentity;
    liveGateTransitionCountAtStart: number;
    startedAt: string;
  }): void {
    this.database.prepare(
      `INSERT INTO paper_validation_sessions(
        session_id,campaign_id,sequence,session_kind,planned_duration_ms,
        core_compatibility_hash,schema_version,ruleset_hash,config_version,
        source_code_commit,source_code_dirty,validation_policy_hash,
        verification_suite_hash,operator_build_hash,artifact_provenance_hash,
        live_gate_transition_count_at_start,started_at,created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.sessionId,
      input.campaignId,
      input.sequence,
      input.sessionKind,
      input.plannedDurationMs,
      input.coreCompatibilityHash,
      input.schemaVersion,
      input.rulesetHash,
      input.configVersion,
      input.sourceVersion.commit,
      input.sourceVersion.dirty ? 1 : 0,
      input.compatibilityIdentity.validationPolicyHash,
      input.compatibilityIdentity.verificationSuiteHash,
      input.compatibilityIdentity.operatorBuildHash,
      input.compatibilityIdentity.artifactProvenanceHash,
      input.liveGateTransitionCountAtStart,
      input.startedAt,
      input.startedAt,
    );
  }

  session(sessionId: string): ValidationSessionDefinition {
    const row = this.database.prepare(
      "SELECT * FROM paper_validation_sessions WHERE session_id=?",
    ).get(sessionId) as unknown as SessionRow | undefined;
    if (!row) throw new Error(`PAPER_VALIDATION_SESSION_NOT_FOUND:${sessionId}`);
    return {
      sessionId: row.session_id,
      campaignId: row.campaign_id,
      sequence: row.sequence,
      sessionKind: row.session_kind,
      plannedDurationMs: row.planned_duration_ms,
      state: this.sessionState(sessionId),
      sourceVersion: sourceVersion(row.source_code_commit, row.source_code_dirty),
      compatibilityIdentity: compatibilityIdentity(row),
      liveGateTransitionCountAtStart: row.live_gate_transition_count_at_start,
      startedAt: row.started_at,
    };
  }

  sessionState(sessionId: string): ValidationSessionState {
    const row = this.database.prepare(
      `SELECT to_state FROM paper_validation_transitions
       WHERE entity_type='SESSION' AND session_id=?
       ORDER BY sequence DESC LIMIT 1`,
    ).get(sessionId) as { to_state: ValidationSessionState } | undefined;
    if (!row) throw new Error(`PAPER_VALIDATION_SESSION_STATE_MISSING:${sessionId}`);
    return row.to_state;
  }

  nextSessionSequence(campaignId: string): number {
    const row = this.database.prepare(
      "SELECT coalesce(max(sequence), 0) + 1 next_sequence FROM paper_validation_sessions WHERE campaign_id=?",
    ).get(campaignId) as { next_sequence: number };
    return row.next_sequence;
  }

  runningSession(campaignId: string): ValidationSessionDefinition | null {
    const rows = this.database.prepare(
      `SELECT s.session_id FROM paper_validation_sessions s
       WHERE s.campaign_id=? AND (
         SELECT t.to_state FROM paper_validation_transitions t
         WHERE t.entity_type='SESSION' AND t.session_id=s.session_id
         ORDER BY t.sequence DESC LIMIT 1
       )='RUNNING'`,
    ).all(campaignId) as unknown as Array<{ session_id: string }>;
    if (rows.length > 1) throw new Error(`MULTIPLE_RUNNING_PAPER_VALIDATION_SESSIONS:${campaignId}`);
    return rows[0] ? this.session(rows[0].session_id) : null;
  }

  insertTransition(input: {
    entityType: "CAMPAIGN" | "SESSION";
    campaignId: string;
    sessionId?: string | null;
    fromState: string | null;
    toState: string;
    reason: string;
    evidence: Record<string, unknown>;
    coreCompatibilityHash: string;
    sourceVersion: SourceVersion;
    configVersion: string;
    idempotencyKey: string;
    now: string;
  }): string {
    const sessionId = input.sessionId ?? null;
    const evidenceJson = stableJson(input.evidence);
    const evidenceHash = sha256(input.evidence);
    const transitionPayload = {
      entityType: input.entityType,
      campaignId: input.campaignId,
      sessionId,
      fromState: input.fromState,
      toState: input.toState,
      reason: input.reason,
      evidenceJson,
      evidenceHash,
      coreCompatibilityHash: input.coreCompatibilityHash,
      sourceCodeCommit: input.sourceVersion.commit,
      sourceCodeDirty: input.sourceVersion.dirty,
      configVersion: input.configVersion,
      createdAt: input.now,
    };
    const existing = this.database.prepare(
      `SELECT transition_id,entity_type,campaign_id,session_id,from_state,to_state,reason,
              evidence_json,evidence_hash,core_compatibility_hash,source_code_commit,
              source_code_dirty,config_version,created_at
       FROM paper_validation_transitions WHERE idempotency_key=?`,
    ).get(input.idempotencyKey) as {
      transition_id: string;
      entity_type: string;
      campaign_id: string;
      session_id: string | null;
      from_state: string | null;
      to_state: string;
      reason: string;
      evidence_json: string;
      evidence_hash: string;
      core_compatibility_hash: string;
      source_code_commit: string;
      source_code_dirty: number;
      config_version: string;
      created_at: string;
    } | undefined;
    if (existing) {
      const existingPayload = {
        entityType: existing.entity_type,
        campaignId: existing.campaign_id,
        sessionId: existing.session_id,
        fromState: existing.from_state,
        toState: existing.to_state,
        reason: existing.reason,
        evidenceJson: existing.evidence_json,
        evidenceHash: existing.evidence_hash,
        coreCompatibilityHash: existing.core_compatibility_hash,
        sourceCodeCommit: existing.source_code_commit,
        sourceCodeDirty: existing.source_code_dirty === 1,
        configVersion: existing.config_version,
        createdAt: existing.created_at,
      };
      if (stableJson(existingPayload) !== stableJson(transitionPayload)) {
        throw new Error("PAPER_VALIDATION_TRANSITION_IDEMPOTENCY_CONFLICT");
      }
      return existing.transition_id;
    }
    const next = input.entityType === "CAMPAIGN"
      ? this.database.prepare(
        "SELECT coalesce(max(sequence),0)+1 next FROM paper_validation_transitions WHERE entity_type='CAMPAIGN' AND campaign_id=?",
      ).get(input.campaignId) as { next: number }
      : this.database.prepare(
        "SELECT coalesce(max(sequence),0)+1 next FROM paper_validation_transitions WHERE entity_type='SESSION' AND session_id=?",
      ).get(sessionId) as { next: number };
    const transitionId = `pvt-${sha256([input.idempotencyKey, sha256(transitionPayload)]).slice(0, 32)}`;
    this.database.prepare(
      `INSERT INTO paper_validation_transitions(
        transition_id,entity_type,campaign_id,session_id,from_state,to_state,reason,
        sequence,evidence_json,evidence_hash,core_compatibility_hash,source_code_commit,
        source_code_dirty,config_version,idempotency_key,created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      transitionId,
      input.entityType,
      input.campaignId,
      sessionId,
      input.fromState,
      input.toState,
      input.reason,
      next.next,
      evidenceJson,
      evidenceHash,
      input.coreCompatibilityHash,
      input.sourceVersion.commit,
      input.sourceVersion.dirty ? 1 : 0,
      input.configVersion,
      input.idempotencyKey,
      input.now,
    );
    return transitionId;
  }

  insertCheckpoint(input: {
    checkpointId: string;
    campaignId: string;
    sessionId: string;
    sequence: number;
    checkpointKind: ValidationCheckpointKind;
    observedAt: string;
    elapsedRuntimeMs: number;
    liveGateTransitionCount: number;
    evidence: CheckpointEvidence;
    checkpointHash: string;
    idempotencyKey: string;
  }): void {
    this.database.prepare(
      `INSERT INTO paper_validation_checkpoints(
        checkpoint_id,campaign_id,session_id,sequence,checkpoint_kind,observed_at,
        elapsed_runtime_ms,observe_active,paper_active,consistency_safe,execution_mode,
        live_gate_state,live_gate_transition_count,observe_checkpoint_id,paper_consumer_created_at,
        paper_consumer_signal_id,position_projection_hash,portfolio_projection_hash,
        replay_state,capital_snapshot_id,last_processed_event_id,evidence_json,
        checkpoint_hash,idempotency_key,created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PAPER', 'LIVE_DISABLED', ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.checkpointId,
      input.campaignId,
      input.sessionId,
      input.sequence,
      input.checkpointKind,
      input.observedAt,
      input.elapsedRuntimeMs,
      input.evidence.observeActive ? 1 : 0,
      input.evidence.paperActive ? 1 : 0,
      input.evidence.consistencySafe ? 1 : 0,
      input.liveGateTransitionCount,
      input.evidence.observeCheckpointId ?? null,
      input.evidence.paperConsumerCreatedAt ?? null,
      input.evidence.paperConsumerSignalId ?? null,
      input.evidence.positionProjectionHash ?? null,
      input.evidence.portfolioProjectionHash ?? null,
      input.evidence.replayState ?? null,
      input.evidence.capitalSnapshotId ?? null,
      input.evidence.lastProcessedEventId ?? null,
      stableJson(input.evidence),
      input.checkpointHash,
      input.idempotencyKey,
      input.observedAt,
    );
  }

  checkpointByIdempotencyKey(idempotencyKey: string): ValidationCheckpoint | null {
    const row = this.database.prepare(
      "SELECT * FROM paper_validation_checkpoints WHERE idempotency_key=?",
    ).get(idempotencyKey) as unknown as CheckpointRow | undefined;
    return row ? this.mapCheckpoint(row) : null;
  }

  checkpoints(sessionId: string): ValidationCheckpoint[] {
    const rows = this.database.prepare(
      "SELECT * FROM paper_validation_checkpoints WHERE session_id=? ORDER BY sequence",
    ).all(sessionId) as unknown as CheckpointRow[];
    return rows.map((row) => this.mapCheckpoint(row));
  }

  latestCheckpoint(sessionId: string): ValidationCheckpoint | null {
    const row = this.database.prepare(
      "SELECT * FROM paper_validation_checkpoints WHERE session_id=? ORDER BY sequence DESC LIMIT 1",
    ).get(sessionId) as unknown as CheckpointRow | undefined;
    return row ? this.mapCheckpoint(row) : null;
  }

  nextCheckpointSequence(sessionId: string): number {
    const row = this.database.prepare(
      "SELECT coalesce(max(sequence),0)+1 next FROM paper_validation_checkpoints WHERE session_id=?",
    ).get(sessionId) as { next: number };
    return row.next;
  }

  insertSessionReport(input: {
    report: SessionValidationReport;
    reportHash: string;
    coverageStatus: "COMPLETE" | "INCOMPLETE";
    idempotencyKey: string;
    configVersion: string;
  }): void {
    this.database.prepare(
      `INSERT INTO paper_validation_reports(
        report_id,campaign_id,session_id,report_scope,status,effective_active_runtime_ms,
        longest_continuous_runtime_ms,counts_toward_campaign,coverage_status,report_json,
        report_hash,core_compatibility_hash,source_code_commit,source_code_dirty,
        config_version,idempotency_key,created_at
      ) VALUES (?, ?, ?, 'SESSION', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.report.reportId,
      input.report.campaignId,
      input.report.sessionId,
      input.report.sessionState,
      input.report.runtime.effectiveActiveRuntimeMs,
      input.report.runtime.qualifyingContinuousRuntimeMs,
      input.report.countsTowardCampaign ? 1 : 0,
      input.coverageStatus,
      stableJson(input.report),
      input.reportHash,
      input.report.coreCompatibilityHash,
      input.report.sourceVersion.commit,
      input.report.sourceVersion.dirty ? 1 : 0,
      input.configVersion,
      input.idempotencyKey,
      input.report.createdAt,
    );
  }

  insertCampaignReport(input: {
    report: CampaignValidationReport;
    reportHash: string;
    idempotencyKey: string;
    configVersion: string;
  }): void {
    this.database.prepare(
      `INSERT INTO paper_validation_reports(
        report_id,campaign_id,session_id,report_scope,status,effective_active_runtime_ms,
        longest_continuous_runtime_ms,counts_toward_campaign,coverage_status,report_json,
        report_hash,core_compatibility_hash,source_code_commit,source_code_dirty,
        config_version,idempotency_key,created_at
      ) VALUES (?, ?, NULL, 'CAMPAIGN', ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.report.reportId,
      input.report.campaignId,
      input.report.campaignState,
      input.report.accumulatedActiveRuntimeMs,
      input.report.longestContinuousRuntimeMs,
      input.report.coverageStatus,
      stableJson(input.report),
      input.reportHash,
      input.report.coreCompatibilityHash,
      input.report.sourceVersion.commit,
      input.report.sourceVersion.dirty ? 1 : 0,
      input.configVersion,
      input.idempotencyKey,
      input.report.createdAt,
    );
  }

  reportByIdempotencyKey<T extends SessionValidationReport | CampaignValidationReport>(
    idempotencyKey: string,
  ): T | null {
    const row = this.database.prepare(
      "SELECT report_id,report_json FROM paper_validation_reports WHERE idempotency_key=?",
    ).get(idempotencyKey) as ReportRow | undefined;
    return row ? parseJson<T>(row.report_json, `PAPER_VALIDATION_REPORT:${row.report_id}`) : null;
  }

  sessionReports(campaignId: string, countedOnly = false): SessionValidationReport[] {
    const rows = this.database.prepare(
      `SELECT report_id,report_json FROM paper_validation_reports
       WHERE campaign_id=? AND report_scope='SESSION'
       ${countedOnly ? "AND counts_toward_campaign=1" : ""}
       ORDER BY created_at,report_id`,
    ).all(campaignId) as unknown as ReportRow[];
    return rows.map((row) => parseJson<SessionValidationReport>(row.report_json, `PAPER_VALIDATION_REPORT:${row.report_id}`));
  }

  insertEvidenceAdjudication(input: {
    campaignId: string;
    sessionId: string;
    decision: "KEEP_ALL" | "KEEP_RUNTIME_REFRESH_ISOLATED" | "KEEP_RUNTIME_REJUDGE_COVERAGE";
    previousIdentity: CompatibilityIdentity | null;
    currentIdentity: CompatibilityIdentity;
    evidence: Record<string, unknown>;
    sourceVersion: SourceVersion;
    idempotencyKey: string;
    now: string;
  }): void {
    const evidenceJson = stableJson(input.evidence);
    const evidenceHash = sha256(input.evidence);
    const existing = this.database.prepare(
      `SELECT evidence_hash FROM paper_validation_evidence_adjudications
       WHERE idempotency_key=?`,
    ).get(input.idempotencyKey) as { evidence_hash: string } | undefined;
    if (existing) {
      if (existing.evidence_hash !== evidenceHash) {
        throw new Error("PAPER_VALIDATION_ADJUDICATION_IDEMPOTENCY_CONFLICT");
      }
      return;
    }
    const adjudicationId = `pva-${sha256([input.idempotencyKey, evidenceHash]).slice(0, 32)}`;
    this.database.prepare(
      `INSERT INTO paper_validation_evidence_adjudications(
        adjudication_id,campaign_id,session_id,decision,
        previous_validation_policy_hash,current_validation_policy_hash,
        previous_verification_suite_hash,current_verification_suite_hash,
        evidence_json,evidence_hash,source_code_commit,source_code_dirty,
        idempotency_key,created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      adjudicationId,
      input.campaignId,
      input.sessionId,
      input.decision,
      input.previousIdentity?.validationPolicyHash ?? null,
      input.currentIdentity.validationPolicyHash,
      input.previousIdentity?.verificationSuiteHash ?? null,
      input.currentIdentity.verificationSuiteHash,
      evidenceJson,
      evidenceHash,
      input.sourceVersion.commit,
      input.sourceVersion.dirty ? 1 : 0,
      input.idempotencyKey,
      input.now,
    );
  }

  latestCampaignReport(campaignId: string): CampaignValidationReport | null {
    const row = this.database.prepare(
      `SELECT report_id,report_json FROM paper_validation_reports
       WHERE campaign_id=? AND report_scope='CAMPAIGN'
       ORDER BY created_at DESC,report_id DESC LIMIT 1`,
    ).get(campaignId) as ReportRow | undefined;
    return row ? parseJson<CampaignValidationReport>(row.report_json, `PAPER_VALIDATION_REPORT:${row.report_id}`) : null;
  }

  close(): void {
    this.database.close();
  }

  private mapCheckpoint(row: CheckpointRow): ValidationCheckpoint {
    const evidence = parseJson<CheckpointEvidence>(row.evidence_json, `CHECKPOINT:${row.checkpoint_id}`);
    const columnEvidence: CheckpointEvidence = {
      observeActive: row.observe_active === 1,
      paperActive: row.paper_active === 1,
      consistencySafe: row.consistency_safe === 1,
      observeCheckpointId: row.observe_checkpoint_id,
      paperConsumerCreatedAt: row.paper_consumer_created_at,
      paperConsumerSignalId: row.paper_consumer_signal_id,
      positionProjectionHash: row.position_projection_hash,
      portfolioProjectionHash: row.portfolio_projection_hash,
      replayState: row.replay_state,
      capitalSnapshotId: row.capital_snapshot_id,
      lastProcessedEventId: row.last_processed_event_id,
    };
    for (const key of Object.keys(columnEvidence) as Array<keyof CheckpointEvidence>) {
      if (key === "detail") continue;
      if ((evidence[key] ?? null) !== (columnEvidence[key] ?? null)) {
        throw new Error(`PAPER_VALIDATION_CHECKPOINT_EVIDENCE_COLUMN_MISMATCH:${row.checkpoint_id}:${key}`);
      }
    }
    return {
      checkpointId: row.checkpoint_id,
      campaignId: row.campaign_id,
      sessionId: row.session_id,
      sequence: row.sequence,
      checkpointKind: row.checkpoint_kind,
      observedAt: row.observed_at,
      elapsedRuntimeMs: row.elapsed_runtime_ms,
      observeActive: row.observe_active === 1,
      paperActive: row.paper_active === 1,
      consistencySafe: row.consistency_safe === 1,
      executionMode: row.execution_mode,
      liveGateState: row.live_gate_state,
      liveGateTransitionCount: row.live_gate_transition_count,
      checkpointHash: row.checkpoint_hash,
      idempotencyKey: row.idempotency_key,
      evidence,
    };
  }
}
