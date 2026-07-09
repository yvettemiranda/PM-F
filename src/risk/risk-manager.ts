import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { RULESET, RULESET_HASH, stableJson, VERSIONS } from "../domain/versioning.js";
import type { SourceVersion } from "../infra/source-version.js";
import type { ExecutorMode } from "../execution/types.js";
import type { PaperSignalEnvelope } from "../paper/types.js";

const PPM = 1_000_000n;

export type RiskDecisionResult = "ALLOW" | "REJECT";

export interface RiskDecision {
  riskDecisionId: string;
  decision: RiskDecisionResult;
  riskReason: string;
  riskRejectReason: string | null;
  checks: Array<{ name: string; result: "PASS" | "FAIL"; detail?: string }>;
}

export interface RiskEvaluationInput {
  mode: ExecutorMode;
  accountId: string;
  signal: PaperSignalEnvelope;
  requestedAmountMicros: bigint | null;
  requestedSizeMicros: bigint | null;
  now: string;
}

export interface SystemRiskDecisionInput {
  mode: ExecutorMode;
  accountId: string;
  signalId: string | null;
  contextId: string | null;
  entityId: string;
  executionType: "STOP_LOSS" | "SETTLEMENT";
  decision: RiskDecisionResult;
  reason: string;
  requestedAmountMicros: bigint | null;
  requestedSizeMicros: bigint | null;
  now: string;
}

interface AccountRow {
  status: string;
  initial_balance_micros: string;
  cash_balance_micros: string;
  reserved_balance_micros: string;
  signal_cutoff_at: string;
}

function hash(parts: Array<string | number>): string {
  return createHash("sha256").update(parts.join("|")).digest("hex");
}

function limitFromInitial(initial: bigint, ppm: number): bigint {
  return (initial * BigInt(ppm)) / PPM;
}

export class RiskManager {
  constructor(
    private readonly database: DatabaseSync,
    private readonly sourceVersion: SourceVersion,
  ) {}

  evaluate(input: RiskEvaluationInput): RiskDecision {
    const checks: RiskDecision["checks"] = [];
    const fail = (name: string, reason: string): RiskDecision => {
      checks.push({ name, result: "FAIL", detail: reason });
      return this.recordSignalDecision(input, "REJECT", reason, reason, checks);
    };
    const pass = (name: string, detail?: string): void => {
      checks.push({ name, result: "PASS", ...(detail ? { detail } : {}) });
    };

    const account = this.account(input.accountId);
    if (account.status !== "ACTIVE") return fail("account_status", "PAPER_ACCOUNT_NOT_ACTIVE");
    pass("account_status");
    if (input.signal.createdAt < account.signal_cutoff_at) return fail("signal_cutoff", "SIGNAL_BEFORE_CUTOFF");
    pass("signal_cutoff");
    if (input.signal.status !== "PUBLISHED") return fail("signal_status", "SIGNAL_NOT_PUBLISHED");
    pass("signal_status");
    if (!input.signal.executionEligible) {
      return fail("execution_eligible", input.signal.executionBlockReason ?? "SIGNAL_NOT_EXECUTION_ELIGIBLE");
    }
    pass("execution_eligible");
    if (!input.signal.context) return fail("execution_context", "EXECUTION_CONTEXT_MISSING");
    pass("execution_context");
    if (input.signal.context.rulesetHash !== RULESET_HASH) return fail("ruleset_hash", "RULESET_MISMATCH");
    pass("ruleset_hash");

    const target = this.signalTarget(input.signal.signalId);
    if (target?.sync_status === "MAJOR_DESYNC") return fail("target_sync", "MAJOR_DESYNC_PROTECTION");
    if (input.mode === "LIVE" && input.signal.signalType === "TARGET_BUY" && target?.sync_status === "MINOR_DIFF") {
      return fail("target_sync", "LIVE_MINOR_DIFF_NEW_OPEN_BLOCKED");
    }
    pass("target_sync", target?.sync_status ?? "UNKNOWN");

    const issue = target ? this.majorReconciliationIssue(target.target_id, input.signal.assetId) : null;
    if (issue) return fail("reconciliation", `MAJOR_DESYNC_RECONCILIATION:${issue.issue_id}`);
    pass("reconciliation");

    const frozen = this.frozenPositionCount(input.accountId);
    if (frozen > 0) return fail("frozen_positions", "FROZEN_POSITION_PROTECTION");
    pass("frozen_positions");

    if (input.signal.signalType === "TARGET_BUY") {
      const capital = input.signal.capitalDecision;
      if (!capital || capital.confidence === "LOW" || capital.status === "FAILED") {
        return fail("capital_decision", "CAPITAL_CONFIDENCE_LOW");
      }
      if (capital.status === "COMPLETE" && capital.confidence === "HIGH") {
        const ratioPpm = input.signal.context.targetTradeCapitalRatioPpm ?? capital.ratioPpm;
        if (ratioPpm === null) return fail("capital_decision", "CAPITAL_RATIO_UNAVAILABLE");
      }
      pass("capital_decision");
      if (input.requestedAmountMicros === null) return fail("requested_amount", "BUY_AMOUNT_UNAVAILABLE");
      const available = BigInt(account.cash_balance_micros) - BigInt(account.reserved_balance_micros);
      if (input.requestedAmountMicros > available) return fail("account_balance", "INSUFFICIENT_AVAILABLE_CASH");
      pass("account_balance");
      const initial = BigInt(account.initial_balance_micros);
      const singleLimit = limitFromInitial(initial, RULESET.paperMaxSingleTradePpm);
      if (input.requestedAmountMicros > singleLimit) return fail("single_trade_limit", "SINGLE_TRADE_LIMIT_EXCEEDED");
      pass("single_trade_limit");
      const marketExposure = this.marketExposure(input.accountId, input.signal.conditionId) + input.requestedAmountMicros;
      const marketLimit = limitFromInitial(initial, RULESET.paperMaxMarketExposurePpm);
      if (marketExposure > marketLimit) return fail("market_exposure_limit", "MARKET_EXPOSURE_LIMIT_EXCEEDED");
      pass("market_exposure_limit");
      const assetExposure = this.assetExposure(input.accountId, input.signal.assetId) + input.requestedAmountMicros;
      const positionLimit = limitFromInitial(initial, RULESET.paperMaxPositionExposurePpm);
      if (assetExposure > positionLimit) return fail("position_exposure_limit", "POSITION_EXPOSURE_LIMIT_EXCEEDED");
      pass("position_exposure_limit");
    } else {
      if (input.requestedSizeMicros === null || input.requestedSizeMicros <= 0n) return fail("requested_size", "SELL_SIZE_UNAVAILABLE");
      pass("requested_size");
    }

    return this.recordSignalDecision(input, "ALLOW", "ALLOW", null, checks);
  }

  recordSystemDecision(input: SystemRiskDecisionInput): RiskDecision {
    const checks: RiskDecision["checks"] = [{
      name: "system_execution",
      result: input.decision === "ALLOW" ? "PASS" : "FAIL",
      detail: input.reason,
    }];
    const riskDecisionId = hash([
      "RISK",
      input.mode,
      input.accountId,
      "SYSTEM",
      input.executionType,
      input.entityId,
      input.signalId ?? "NO_SIGNAL",
      input.requestedAmountMicros?.toString() ?? "NONE",
      input.requestedSizeMicros?.toString() ?? "NONE",
      RULESET_HASH,
    ]);
    return this.insertDecision({
      riskDecisionId,
      mode: input.mode,
      accountId: input.accountId,
      signalId: input.signalId,
      contextId: input.contextId,
      decision: input.decision,
      riskReason: input.reason,
      riskRejectReason: input.decision === "REJECT" ? input.reason : null,
      requestedAmountMicros: input.requestedAmountMicros,
      requestedSizeMicros: input.requestedSizeMicros,
      checks,
      now: input.now,
    });
  }

  private recordSignalDecision(
    input: RiskEvaluationInput,
    decision: RiskDecisionResult,
    riskReason: string,
    riskRejectReason: string | null,
    checks: RiskDecision["checks"],
  ): RiskDecision {
    const contextId = input.signal.context?.contextId ?? null;
    const riskDecisionId = hash([
      "RISK",
      input.mode,
      input.accountId,
      input.signal.signalId,
      input.requestedAmountMicros?.toString() ?? "NONE",
      input.requestedSizeMicros?.toString() ?? "NONE",
      RULESET_HASH,
    ]);
    return this.insertDecision({
      riskDecisionId,
      mode: input.mode,
      accountId: input.accountId,
      signalId: input.signal.signalId,
      contextId,
      decision,
      riskReason,
      riskRejectReason,
      requestedAmountMicros: input.requestedAmountMicros,
      requestedSizeMicros: input.requestedSizeMicros,
      checks,
      now: input.now,
    });
  }

  private insertDecision(input: {
    riskDecisionId: string;
    mode: ExecutorMode;
    accountId: string;
    signalId: string | null;
    contextId: string | null;
    decision: RiskDecisionResult;
    riskReason: string;
    riskRejectReason: string | null;
    requestedAmountMicros: bigint | null;
    requestedSizeMicros: bigint | null;
    checks: RiskDecision["checks"];
    now: string;
  }): RiskDecision {
    this.database.prepare(
      `INSERT OR IGNORE INTO risk_decisions(
        risk_decision_id,executor_mode,paper_account_id,signal_id,context_id,decision,
        risk_reject_reason,requested_amount_micros,requested_size_micros,checks_json,
        schema_version,strategy_version,risk_version,ruleset_hash,source_code_commit,
        source_code_dirty,config_version,created_at,risk_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.riskDecisionId,
      input.mode,
      input.accountId,
      input.signalId,
      input.contextId,
      input.decision,
      input.riskRejectReason,
      input.requestedAmountMicros?.toString() ?? null,
      input.requestedSizeMicros?.toString() ?? null,
      stableJson(input.checks),
      VERSIONS.schemaVersion,
      VERSIONS.strategyVersion,
      VERSIONS.riskVersion,
      RULESET_HASH,
      this.sourceVersion.commit,
      this.sourceVersion.dirty ? 1 : 0,
      VERSIONS.configVersion,
      input.now,
      input.riskReason,
    );
    this.database.prepare(
      `INSERT OR IGNORE INTO audit_log(
        audit_id,timestamp,entity_type,entity_id,action,reason,ruleset_hash,
        source_code_commit,source_code_dirty,config_version,metadata_json
      ) VALUES (?, ?, 'RISK_DECISION', ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      hash(["AUDIT", "RISK_DECISION", input.riskDecisionId, input.decision]),
      input.now,
      input.riskDecisionId,
      input.decision === "ALLOW" ? "ALLOW" : "REJECT",
      input.riskReason,
      RULESET_HASH,
      this.sourceVersion.commit,
      this.sourceVersion.dirty ? 1 : 0,
      VERSIONS.configVersion,
      stableJson({ signalId: input.signalId, contextId: input.contextId, checks: input.checks }),
    );
    return {
      riskDecisionId: input.riskDecisionId,
      decision: input.decision,
      riskReason: input.riskReason,
      riskRejectReason: input.riskRejectReason,
      checks: input.checks,
    };
  }

  private account(accountId: string): AccountRow {
    const row = this.database.prepare(
      `SELECT status,initial_balance_micros,cash_balance_micros,reserved_balance_micros,
              signal_cutoff_at FROM paper_accounts WHERE paper_account_id=?`,
    ).get(accountId) as AccountRow | undefined;
    if (!row) throw new Error(`PAPER_ACCOUNT_NOT_FOUND:${accountId}`);
    return row;
  }

  private signalTarget(signalId: string): { target_id: string; sync_status: string } | null {
    const row = this.database.prepare(
      `SELECT r.target_id,t.sync_status
       FROM signals s
       JOIN raw_events r ON r.source_event_key=s.source_event_key
       JOIN monitor_targets t ON t.target_id=r.target_id
       WHERE s.signal_id=?`,
    ).get(signalId) as { target_id: string; sync_status: string } | undefined;
    return row ?? null;
  }

  private majorReconciliationIssue(targetId: string, assetId: string): { issue_id: string } | null {
    const row = this.database.prepare(
      `SELECT issue_id FROM reconciliation_issues
       WHERE target_id=? AND (asset_id IS NULL OR asset_id=?) AND sync_status='MAJOR_DESYNC'
         AND status!='RESOLVED'
       ORDER BY created_at DESC LIMIT 1`,
    ).get(targetId, assetId) as { issue_id: string } | undefined;
    return row ?? null;
  }

  private frozenPositionCount(accountId: string): number {
    const row = this.database.prepare("SELECT count(*) count FROM paper_positions WHERE paper_account_id=? AND status='FROZEN'")
      .get(accountId) as { count: number };
    return row.count;
  }

  private marketExposure(accountId: string, conditionId: string): bigint {
    const row = this.database.prepare(
      `SELECT COALESCE(SUM(CAST(remaining_cost_micros AS INTEGER)),0) total
       FROM paper_positions
       WHERE paper_account_id=? AND condition_id=? AND status IN ('OPEN','PARTIALLY_CLOSED','SETTLEMENT_PENDING')`,
    ).get(accountId, conditionId) as { total: number };
    return BigInt(row.total);
  }

  private assetExposure(accountId: string, assetId: string): bigint {
    const row = this.database.prepare(
      `SELECT COALESCE(SUM(CAST(remaining_cost_micros AS INTEGER)),0) total
       FROM paper_positions
       WHERE paper_account_id=? AND asset_id=? AND status IN ('OPEN','PARTIALLY_CLOSED','SETTLEMENT_PENDING')`,
    ).get(accountId, assetId) as { total: number };
    return BigInt(row.total);
  }
}
