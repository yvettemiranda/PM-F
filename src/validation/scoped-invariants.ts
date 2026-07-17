import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export interface ValidationScope {
  campaignId: string;
  sessionId: string;
  accountId: string;
  targetId: string;
  baselineRunId: string;
  coreHash: string;
}

interface ScopeRow {
  campaign_id: string;
  session_id: string;
  paper_account_id: string;
  target_id: string;
  baseline_run_id: string;
  campaign_core_hash: string;
  session_core_hash: string;
  account_target_id: string | null;
  baseline_target_id: string;
  baseline_status: string;
  campaign_schema_version: string;
  session_schema_version: string;
  account_schema_version: string;
  campaign_ruleset_hash: string;
  session_ruleset_hash: string;
  account_ruleset_hash: string;
  campaign_config_version: string;
  session_config_version: string;
  campaign_source_commit: string;
  session_source_commit: string;
  account_source_commit: string;
  campaign_source_dirty: number;
  session_source_dirty: number;
  account_source_dirty: number;
}

interface EntityStateRow {
  entity_type: "PAPER_ACCOUNT" | "PAPER_EXECUTION" | "PAPER_POSITION" | "PAPER_MARKET_DATA";
  entity_id: string;
  current_state: string;
}

interface ExecutionRiskLinkRow {
  paper_execution_id: string;
  execution_state: string;
  execution_signal_id: string | null;
  execution_context_id: string | null;
  execution_account_id: string;
  execution_requested_amount_micros: string | null;
  execution_requested_size_micros: string | null;
  execution_risk_reject_reason: string | null;
  execution_schema_version: string;
  execution_strategy_version: string;
  execution_risk_version: string;
  execution_ruleset_hash: string;
  execution_source_commit: string;
  execution_source_dirty: number;
  execution_config_version: string;
  risk_decision_id: string | null;
  risk_executor_mode: string | null;
  risk_account_id: string | null;
  risk_signal_id: string | null;
  risk_context_id: string | null;
  risk_decision: string | null;
  risk_reject_reason: string | null;
  risk_requested_amount_micros: string | null;
  risk_requested_size_micros: string | null;
  risk_schema_version: string | null;
  risk_strategy_version: string | null;
  risk_risk_version: string | null;
  risk_ruleset_hash: string | null;
  risk_source_commit: string | null;
  risk_source_dirty: number | null;
  risk_config_version: string | null;
}

interface TransitionRow {
  transition_id: string;
  entity_type: string;
  entity_id: string;
  from_state: string | null;
  to_state: string;
  sequence: number;
  reason: string;
  ruleset_hash: string;
  source_code_commit: string;
  source_code_dirty: number;
  config_version: string;
  created_at: string;
}

export interface ScopedInvariantEvidence {
  [key: string]: unknown;
  passed: boolean;
  blockers: string[];
  scopeBindingViolationCount: number;
  executionRiskDecisionViolationCount: number;
  reusedRiskDecisionCount: number;
  stateTransitionMissingCount: number;
  stateTransitionMismatchCount: number;
  stateTransitionChainViolationCount: number;
  transitionAuditViolationCount: number;
  riskDecisionAuditViolationCount: number;
  sampledViolations: string[];
}

function readScopeRow(database: DatabaseSync, campaignId: string, sessionId: string): ScopeRow | undefined {
  return database.prepare(
    `SELECT c.campaign_id,s.session_id,c.paper_account_id,c.target_id,c.baseline_run_id,
            c.core_compatibility_hash campaign_core_hash,
            s.core_compatibility_hash session_core_hash,
            a.target_id account_target_id,
            b.target_id baseline_target_id,b.status baseline_status,
            c.schema_version campaign_schema_version,s.schema_version session_schema_version,
            a.schema_version account_schema_version,
            c.ruleset_hash campaign_ruleset_hash,s.ruleset_hash session_ruleset_hash,
            a.ruleset_hash account_ruleset_hash,
            c.config_version campaign_config_version,s.config_version session_config_version,
            c.source_code_commit campaign_source_commit,s.source_code_commit session_source_commit,
            a.source_code_commit account_source_commit,
            c.source_code_dirty campaign_source_dirty,s.source_code_dirty session_source_dirty,
            a.source_code_dirty account_source_dirty
     FROM paper_validation_campaigns c
     JOIN paper_validation_sessions s ON s.campaign_id=c.campaign_id
     JOIN paper_accounts a ON a.paper_account_id=c.paper_account_id
     JOIN position_baseline_runs b ON b.baseline_run_id=c.baseline_run_id
     WHERE c.campaign_id=? AND s.session_id=?`,
  ).get(campaignId, sessionId) as ScopeRow | undefined;
}

export function resolveValidationScope(
  database: DatabaseSync,
  campaignId: string,
  sessionId: string,
): ValidationScope {
  const row = readScopeRow(database, campaignId, sessionId);
  if (!row) throw new Error(`VALIDATION_SCOPE_NOT_FOUND:${campaignId}:${sessionId}`);
  if (row.campaign_core_hash !== row.session_core_hash) {
    throw new Error(`VALIDATION_SCOPE_CORE_HASH_MISMATCH:${campaignId}:${sessionId}`);
  }
  if (row.account_target_id !== row.target_id) {
    throw new Error(`VALIDATION_SCOPE_ACCOUNT_TARGET_MISMATCH:${campaignId}:${sessionId}`);
  }
  if (row.baseline_target_id !== row.target_id || row.baseline_status !== "READY") {
    throw new Error(`VALIDATION_SCOPE_BASELINE_MISMATCH:${campaignId}:${sessionId}`);
  }
  if (
    !row.campaign_source_commit.trim()
    || !row.session_source_commit.trim()
    || row.campaign_source_dirty !== 0
    || row.session_source_dirty !== 0
  ) {
    throw new Error(`VALIDATION_SCOPE_PROVENANCE_MISMATCH:${campaignId}:${sessionId}`);
  }
  if (
    row.account_schema_version !== row.campaign_schema_version
    || row.account_ruleset_hash !== row.campaign_ruleset_hash
    || row.account_source_commit !== row.campaign_source_commit
    || row.account_source_dirty !== row.campaign_source_dirty
  ) {
    throw new Error(`VALIDATION_SCOPE_ACCOUNT_PROVENANCE_MISMATCH:${campaignId}:${sessionId}`);
  }
  return {
    campaignId: row.campaign_id,
    sessionId: row.session_id,
    accountId: row.paper_account_id,
    targetId: row.target_id,
    baselineRunId: row.baseline_run_id,
    coreHash: row.campaign_core_hash,
  };
}

export function resolveValidationScopeFromDatabase(
  databasePath: string,
  campaignId: string,
  sessionId: string,
): ValidationScope {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  database.exec("PRAGMA query_only=ON; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
  try {
    return resolveValidationScope(database, campaignId, sessionId);
  } finally {
    database.close();
  }
}

function scopeBindingViolations(database: DatabaseSync, scope: ValidationScope): string[] {
  const row = readScopeRow(database, scope.campaignId, scope.sessionId);
  if (!row) return ["SCOPE_NOT_FOUND"];
  const violations: string[] = [];
  if (row.paper_account_id !== scope.accountId) violations.push("ACCOUNT_ID_MISMATCH");
  if (row.target_id !== scope.targetId) violations.push("TARGET_ID_MISMATCH");
  if (row.baseline_run_id !== scope.baselineRunId) violations.push("BASELINE_RUN_ID_MISMATCH");
  if (row.campaign_core_hash !== scope.coreHash) violations.push("CAMPAIGN_CORE_HASH_MISMATCH");
  if (row.session_core_hash !== scope.coreHash) violations.push("SESSION_CORE_HASH_MISMATCH");
  if (row.account_target_id !== scope.targetId) violations.push("ACCOUNT_TARGET_MISMATCH");
  if (row.baseline_target_id !== scope.targetId || row.baseline_status !== "READY") {
    violations.push("BASELINE_TARGET_OR_STATUS_MISMATCH");
  }
  if (
    !row.campaign_source_commit.trim()
    || !row.session_source_commit.trim()
    || row.campaign_source_dirty !== 0
    || row.session_source_dirty !== 0
  ) violations.push("CAMPAIGN_SESSION_PROVENANCE_MISMATCH");
  if (
    row.account_schema_version !== row.campaign_schema_version
    || row.account_ruleset_hash !== row.campaign_ruleset_hash
    || row.account_source_commit !== row.campaign_source_commit
    || row.account_source_dirty !== row.campaign_source_dirty
  ) violations.push("ACCOUNT_CAMPAIGN_PROVENANCE_MISMATCH");
  const observeRunViolations = database.prepare(
    `SELECT o.observe_run_id
     FROM observe_runs o
     JOIN paper_validation_sessions s
       ON s.campaign_id=o.campaign_id AND s.session_id=o.campaign_session_id
     WHERE o.campaign_id=? AND o.campaign_session_id=? AND (
       o.target_id IS NOT ? OR o.baseline_run_id IS NOT ?
       OR o.schema_version IS NOT s.schema_version
       OR o.ruleset_hash IS NOT s.ruleset_hash
       OR o.source_code_commit IS NOT s.source_code_commit
       OR o.source_code_dirty IS NOT s.source_code_dirty
     )`,
  ).all(
    scope.campaignId,
    scope.sessionId,
    scope.targetId,
    scope.baselineRunId,
  ) as unknown as Array<{ observe_run_id: string }>;
  for (const observeRun of observeRunViolations) {
    violations.push(`OBSERVE_RUN_PROVENANCE_MISMATCH:${observeRun.observe_run_id}`);
  }
  return violations;
}

function scopedEntityStates(database: DatabaseSync, accountId: string): EntityStateRow[] {
  const direct = database.prepare(
    `SELECT 'PAPER_ACCOUNT' entity_type,paper_account_id entity_id,status current_state
     FROM paper_accounts WHERE paper_account_id=?
     UNION ALL
     SELECT 'PAPER_EXECUTION',paper_execution_id,state
     FROM paper_executions WHERE paper_account_id=?
     UNION ALL
     SELECT 'PAPER_POSITION',paper_position_id,status
     FROM paper_positions WHERE paper_account_id=?`,
  ).all(accountId, accountId, accountId) as unknown as EntityStateRow[];
  const marketData = database.prepare(
    `SELECT asset_id,condition_id,state
     FROM paper_market_data_health WHERE paper_account_id=?`,
  ).all(accountId) as unknown as Array<{ asset_id: string; condition_id: string; state: string }>;
  return [
    ...direct,
    ...marketData.map((row): EntityStateRow => ({
      entity_type: "PAPER_MARKET_DATA",
      entity_id: createHash("sha256")
        .update(["PAPER_MARKET_DATA", accountId, row.asset_id, row.condition_id.toLowerCase()].join("|"))
        .digest("hex"),
      current_state: row.state,
    })),
  ];
}

function executionRiskLinkViolations(database: DatabaseSync, accountId: string): Array<{
  paperExecutionId: string;
  reasons: string[];
}> {
  const rows = database.prepare(
    `SELECT
       e.paper_execution_id,e.state execution_state,e.signal_id execution_signal_id,
       e.context_id execution_context_id,e.paper_account_id execution_account_id,
       e.requested_amount_micros execution_requested_amount_micros,
       e.requested_size_micros execution_requested_size_micros,
       e.risk_reject_reason execution_risk_reject_reason,
       e.schema_version execution_schema_version,e.strategy_version execution_strategy_version,
       e.risk_version execution_risk_version,e.ruleset_hash execution_ruleset_hash,
       e.source_code_commit execution_source_commit,e.source_code_dirty execution_source_dirty,
       e.config_version execution_config_version,
       r.risk_decision_id,r.executor_mode risk_executor_mode,r.paper_account_id risk_account_id,
       r.signal_id risk_signal_id,r.context_id risk_context_id,r.decision risk_decision,
       r.risk_reject_reason,r.requested_amount_micros risk_requested_amount_micros,
       r.requested_size_micros risk_requested_size_micros,
       r.schema_version risk_schema_version,r.strategy_version risk_strategy_version,
       r.risk_version risk_risk_version,r.ruleset_hash risk_ruleset_hash,
       r.source_code_commit risk_source_commit,r.source_code_dirty risk_source_dirty,
       r.config_version risk_config_version
     FROM paper_executions e
     LEFT JOIN risk_decisions r ON r.risk_decision_id=e.risk_decision_id
     WHERE e.paper_account_id=?`,
  ).all(accountId) as unknown as ExecutionRiskLinkRow[];

  const requestedSizeCompatible = (executionValue: string | null, riskValue: string | null): boolean => {
    if (executionValue === null || riskValue === null) return executionValue === riskValue;
    try {
      // Pending exits may be reduced after settlement/stop-loss supersedes part
      // of the request, but the execution may never exceed the approved size.
      return BigInt(executionValue) <= BigInt(riskValue);
    } catch {
      return false;
    }
  };

  return rows.flatMap((row) => {
    const reasons: string[] = [];
    if (!row.risk_decision_id) reasons.push("MISSING_RISK_DECISION");
    if (row.risk_executor_mode !== "PAPER") reasons.push("RISK_MODE_MISMATCH");
    if (row.risk_account_id !== row.execution_account_id) reasons.push("RISK_ACCOUNT_MISMATCH");
    if (row.risk_signal_id !== row.execution_signal_id) reasons.push("RISK_SIGNAL_MISMATCH");
    if (row.risk_context_id !== row.execution_context_id) reasons.push("RISK_CONTEXT_MISMATCH");
    if (row.risk_decision === "REJECT" && row.execution_state !== "REJECTED") {
      reasons.push("REJECT_DECISION_EXECUTED");
    }
    if (row.risk_decision === "REJECT" && row.execution_risk_reject_reason !== row.risk_reject_reason) {
      reasons.push("RISK_REJECT_REASON_MISMATCH");
    }
    if (row.risk_decision === "ALLOW" && row.execution_risk_reject_reason !== null) {
      reasons.push("ALLOW_DECISION_HAS_RISK_REJECT_REASON");
    }
    if (row.risk_decision === "ALLOW") {
      if (row.execution_requested_amount_micros !== row.risk_requested_amount_micros) {
        reasons.push("RISK_REQUESTED_AMOUNT_MISMATCH");
      }
      if (!requestedSizeCompatible(row.execution_requested_size_micros, row.risk_requested_size_micros)) {
        reasons.push("RISK_REQUESTED_SIZE_MISMATCH");
      }
    }
    if (
      row.execution_schema_version !== row.risk_schema_version
      || row.execution_strategy_version !== row.risk_strategy_version
      || row.execution_risk_version !== row.risk_risk_version
      || row.execution_ruleset_hash !== row.risk_ruleset_hash
      || row.execution_source_commit !== row.risk_source_commit
      || row.execution_source_dirty !== row.risk_source_dirty
      || row.execution_config_version !== row.risk_config_version
    ) reasons.push("RISK_PROVENANCE_MISMATCH");
    return reasons.length === 0 ? [] : [{ paperExecutionId: row.paper_execution_id, reasons }];
  });
}

function scopedTransitions(database: DatabaseSync, accountId: string): TransitionRow[] {
  const entityIds = scopedEntityStates(database, accountId);
  const marketDataIds = new Set(
    entityIds.filter((row) => row.entity_type === "PAPER_MARKET_DATA").map((row) => row.entity_id),
  );
  const rows = database.prepare(
    `SELECT transition_id,entity_type,entity_id,from_state,to_state,sequence,reason,
            ruleset_hash,source_code_commit,source_code_dirty,config_version,created_at
     FROM paper_state_transitions
     WHERE (entity_type='PAPER_ACCOUNT' AND entity_id=?)
        OR (entity_type='PAPER_EXECUTION' AND entity_id IN (
          SELECT paper_execution_id FROM paper_executions WHERE paper_account_id=?
        ))
        OR (entity_type='PAPER_POSITION' AND entity_id IN (
          SELECT paper_position_id FROM paper_positions WHERE paper_account_id=?
        ))
     ORDER BY entity_type,entity_id,sequence`,
  ).all(accountId, accountId, accountId) as unknown as TransitionRow[];
  if (marketDataIds.size === 0) return rows;
  const marketDataRows = database.prepare(
    `SELECT transition_id,entity_type,entity_id,from_state,to_state,sequence,reason,
            ruleset_hash,source_code_commit,source_code_dirty,config_version,created_at
     FROM paper_state_transitions
     WHERE entity_type='PAPER_MARKET_DATA'
     ORDER BY entity_id,sequence`,
  ).all() as unknown as TransitionRow[];
  return [...rows, ...marketDataRows.filter((row) => marketDataIds.has(row.entity_id))]
    .sort((left, right) => left.entity_type.localeCompare(right.entity_type)
      || left.entity_id.localeCompare(right.entity_id)
      || left.sequence - right.sequence);
}

function expectedTransitionAuditAction(transition: TransitionRow): string {
  if (transition.entity_type === "PAPER_EXECUTION") {
    if (transition.from_state === null) return "CREATED";
    if (["EXECUTED", "PARTIALLY_EXECUTED"].includes(transition.to_state)) return "FILLED";
    if (transition.to_state === "CANCELLED") return "CANCELLED";
    if (transition.to_state === "EXPIRED") return "EXPIRED";
    if (transition.to_state === "REJECTED") return "REJECTED";
  }
  if (transition.entity_type === "PAPER_POSITION") {
    if (transition.from_state === null && transition.to_state === "OPEN") return "OPENED";
    if (transition.to_state === "FROZEN") return "FROZEN";
    if (transition.to_state === "CLOSED") return "CLOSED";
    if (transition.to_state === "SETTLEMENT_PENDING") return "SETTLEMENT_PENDING";
    if (transition.to_state === "REDEEMED") return "REDEEMED";
  }
  if (transition.entity_type === "PAPER_ACCOUNT" && transition.to_state === "ACTIVE") return "CREATED";
  return "STATE_CHANGED";
}

function hasTransitionAudit(database: DatabaseSync, transition: TransitionRow): boolean {
  const row = database.prepare(
    `SELECT 1 present
     FROM audit_log
     WHERE entity_type=? AND entity_id=? AND timestamp=?
       AND action=? AND reason IS ?
       AND ruleset_hash=? AND source_code_commit=? AND source_code_dirty=? AND config_version=?
       AND json_extract(metadata_json,'$.sequence')=?
       AND json_extract(metadata_json,'$.from') IS ?
       AND json_extract(metadata_json,'$.to')=?
     LIMIT 1`,
  ).get(
    transition.entity_type,
    transition.entity_id,
    transition.created_at,
    expectedTransitionAuditAction(transition),
    transition.reason,
    transition.ruleset_hash,
    transition.source_code_commit,
    transition.source_code_dirty,
    transition.config_version,
    transition.sequence,
    transition.from_state,
    transition.to_state,
  ) as { present: number } | undefined;
  return row !== undefined;
}

export function checkScopedInvariants(database: DatabaseSync, scope: ValidationScope): ScopedInvariantEvidence {
  const sampledViolations: string[] = [];
  const sample = (value: string): void => {
    if (sampledViolations.length < 25) sampledViolations.push(value);
  };

  const bindingViolations = scopeBindingViolations(database, scope);
  bindingViolations.forEach((violation) => sample(`SCOPE:${violation}`));

  const riskViolations = executionRiskLinkViolations(database, scope.accountId);
  riskViolations.forEach((row) => sample(`EXECUTION_RISK:${row.paperExecutionId}:${row.reasons.join(",")}`));

  const reusedRisk = database.prepare(
    `SELECT risk_decision_id
     FROM paper_executions
     WHERE risk_decision_id IN (
       SELECT risk_decision_id FROM paper_executions
       WHERE paper_account_id=? AND risk_decision_id IS NOT NULL
     )
     GROUP BY risk_decision_id HAVING count(*)<>1`,
  ).all(scope.accountId) as unknown as Array<{ risk_decision_id: string }>;
  reusedRisk.forEach((row) => sample(`RISK_DECISION_REUSED:${row.risk_decision_id}`));

  const entityStates = scopedEntityStates(database, scope.accountId);
  const transitions = scopedTransitions(database, scope.accountId);
  const transitionsByEntity = new Map<string, TransitionRow[]>();
  for (const transition of transitions) {
    const key = `${transition.entity_type}:${transition.entity_id}`;
    const rows = transitionsByEntity.get(key) ?? [];
    rows.push(transition);
    transitionsByEntity.set(key, rows);
  }

  let stateTransitionMissingCount = 0;
  let stateTransitionMismatchCount = 0;
  let stateTransitionChainViolationCount = 0;
  for (const entity of entityStates) {
    const key = `${entity.entity_type}:${entity.entity_id}`;
    const rows = transitionsByEntity.get(key) ?? [];
    if (rows.length === 0) {
      stateTransitionMissingCount += 1;
      sample(`STATE_TRANSITION_MISSING:${key}`);
      continue;
    }
    const latest = rows.at(-1)!;
    if (latest.to_state !== entity.current_state) {
      stateTransitionMismatchCount += 1;
      sample(`STATE_TRANSITION_MISMATCH:${key}:${latest.to_state}:${entity.current_state}`);
    }
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index]!;
      const previous = rows[index - 1];
      const expectedFrom = previous?.to_state ?? null;
      if (row.sequence !== index || row.from_state !== expectedFrom) {
        stateTransitionChainViolationCount += 1;
        sample(`STATE_TRANSITION_CHAIN:${key}:${row.sequence}`);
      }
    }
  }

  let transitionAuditViolationCount = 0;
  for (const transition of transitions) {
    if (!hasTransitionAudit(database, transition)) {
      transitionAuditViolationCount += 1;
      sample(`TRANSITION_AUDIT_MISSING:${transition.transition_id}`);
    }
  }

  const riskDecisionAuditViolations = database.prepare(
    `SELECT r.risk_decision_id
     FROM risk_decisions r
     LEFT JOIN audit_log a
       ON a.entity_type='RISK_DECISION'
      AND a.entity_id=r.risk_decision_id
      AND a.action=CASE r.decision WHEN 'ALLOW' THEN 'ALLOW' ELSE 'REJECT' END
      AND a.timestamp=r.created_at
      AND a.reason IS r.risk_reason
      AND a.ruleset_hash=r.ruleset_hash
      AND a.source_code_commit=r.source_code_commit
      AND a.source_code_dirty=r.source_code_dirty
      AND a.config_version=r.config_version
      AND json_extract(a.metadata_json,'$.mode')=r.executor_mode
      AND json_extract(a.metadata_json,'$.accountId')=r.account_id
      AND json_extract(a.metadata_json,'$.signalId') IS r.signal_id
      AND json_extract(a.metadata_json,'$.contextId') IS r.context_id
      AND json_extract(a.metadata_json,'$.capitalSizingDecisionHash') IS r.capital_sizing_decision_hash
     WHERE r.executor_mode='PAPER' AND r.paper_account_id=?
     GROUP BY r.risk_decision_id
     HAVING count(a.audit_id)=0`,
  ).all(scope.accountId) as unknown as Array<{ risk_decision_id: string }>;
  riskDecisionAuditViolations.forEach((row) => sample(`RISK_DECISION_AUDIT_MISSING:${row.risk_decision_id}`));

  const blockers = [
    ...(bindingViolations.length === 0 ? [] : [`VALIDATION_SCOPE_BINDING:${bindingViolations.length}`]),
    ...(riskViolations.length === 0 ? [] : [`EXECUTION_RISK_DECISION_LINK:${riskViolations.length}`]),
    ...(reusedRisk.length === 0 ? [] : [`RISK_DECISION_REUSED:${reusedRisk.length}`]),
    ...(stateTransitionMissingCount === 0 ? [] : [`STATE_TRANSITION_MISSING:${stateTransitionMissingCount}`]),
    ...(stateTransitionMismatchCount === 0 ? [] : [`STATE_TRANSITION_CURRENT_MISMATCH:${stateTransitionMismatchCount}`]),
    ...(stateTransitionChainViolationCount === 0 ? [] : [`STATE_TRANSITION_CHAIN:${stateTransitionChainViolationCount}`]),
    ...(transitionAuditViolationCount === 0 ? [] : [`STATE_TRANSITION_AUDIT_MISSING:${transitionAuditViolationCount}`]),
    ...(riskDecisionAuditViolations.length === 0 ? [] : [`RISK_DECISION_AUDIT_MISSING:${riskDecisionAuditViolations.length}`]),
  ];
  return {
    passed: blockers.length === 0,
    blockers,
    scopeBindingViolationCount: bindingViolations.length,
    executionRiskDecisionViolationCount: riskViolations.length,
    reusedRiskDecisionCount: reusedRisk.length,
    stateTransitionMissingCount,
    stateTransitionMismatchCount,
    stateTransitionChainViolationCount,
    transitionAuditViolationCount,
    riskDecisionAuditViolationCount: riskDecisionAuditViolations.length,
    sampledViolations,
  };
}

export function scopedObserveRunIds(database: DatabaseSync, scope: ValidationScope): string[] {
  const rows = database.prepare(
    `SELECT observe_run_id FROM observe_runs
     WHERE campaign_id=? AND campaign_session_id=?
       AND target_id=? AND baseline_run_id=?
     ORDER BY started_at,observe_run_id`,
  ).all(
    scope.campaignId,
    scope.sessionId,
    scope.targetId,
    scope.baselineRunId,
  ) as unknown as Array<{ observe_run_id: string }>;
  return rows.map((row) => row.observe_run_id);
}
