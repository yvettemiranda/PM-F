import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { RULESET, RULESET_HASH, stableJson, VERSIONS } from "../domain/versioning.js";
import { registeredExecutionRules } from "../domain/ruleset-registry.js";
import type { SourceVersion } from "../infra/source-version.js";
import type { ExecutorMode } from "../execution/types.js";
import { executionEnvelopeIntegrityError } from "../execution/signal-integrity.js";
import type { PaperSignalEnvelope } from "../paper/types.js";
import {
  isBuyCapitalSizingDecisionValid,
  type BuyCapitalSizingDecision,
} from "../execution/capital-sizing.js";
import {
  isBuyAmountPolicyDecisionValid,
  type BuyAmountPolicyDecision,
} from "../execution/buy-amount-policy.js";

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
  capitalSizingDecision?: BuyCapitalSizingDecision | null;
  buyAmountPolicyDecision?: BuyAmountPolicyDecision | null;
  replacingReservedAmountMicros?: bigint;
  targetExitSupersession?: boolean;
  now: string;
}

export interface SystemRiskDecisionInput {
  mode: ExecutorMode;
  accountId: string;
  signalId: string | null;
  contextId: string | null;
  entityId: string;
  executionType: "STOP_LOSS" | "SETTLEMENT" | "REDEEM";
  decision: RiskDecisionResult;
  reason: string;
  requestedAmountMicros: bigint | null;
  requestedSizeMicros: bigint | null;
  /** Ruleset owned by the position/context that caused this system action. */
  rulesetHash?: string;
  now: string;
}

interface RiskAccount {
  status: string;
  walletStatus: string | null;
  initialBalanceMicros: bigint;
  cashBalanceMicros: bigint;
  reservedBalanceMicros: bigint;
  riskBudgetMicros: bigint | null;
  signalCutoffAt: string;
}

function hash(parts: Array<string | number>): string {
  return createHash("sha256").update(parts.join("|")).digest("hex");
}

function limitFromInitial(initial: bigint, ppm: number): bigint {
  return (initial * BigInt(ppm)) / PPM;
}

function minBigInt(left: bigint, right: bigint): bigint {
  return left < right ? left : right;
}

export class RiskManager {
  constructor(
    private readonly database: DatabaseSync,
    private readonly sourceVersion: SourceVersion,
  ) {
    this.database.exec("PRAGMA recursive_triggers=ON;");
  }

  evaluate(input: RiskEvaluationInput): RiskDecision {
    const checks: RiskDecision["checks"] = [];
    const fail = (name: string, reason: string): RiskDecision => {
      checks.push({ name, result: "FAIL", detail: reason });
      return this.recordSignalDecision(input, "REJECT", reason, reason, checks);
    };
    const pass = (name: string, detail?: string): void => {
      checks.push({ name, result: "PASS", ...(detail ? { detail } : {}) });
    };

    const account = this.account(input.mode, input.accountId);
    if (account.status !== "ACTIVE") {
      return fail("account_status", input.mode === "LIVE" ? "LIVE_ACCOUNT_NOT_ACTIVE" : "PAPER_ACCOUNT_NOT_ACTIVE");
    }
    pass("account_status");
    if (input.mode === "LIVE" && account.walletStatus !== "ACTIVE") {
      return fail("wallet_status", "LIVE_WALLET_NOT_ACTIVE");
    }
    if (input.mode === "LIVE") pass("wallet_status");
    if (input.signal.createdAt < account.signalCutoffAt) return fail("signal_cutoff", "SIGNAL_BEFORE_CUTOFF");
    pass("signal_cutoff");
    if (input.signal.status !== "PUBLISHED") return fail("signal_status", "SIGNAL_NOT_PUBLISHED");
    pass("signal_status");
    if (!input.signal.executionEligible) {
      return fail("execution_eligible", input.signal.executionBlockReason ?? "SIGNAL_NOT_EXECUTION_ELIGIBLE");
    }
    pass("execution_eligible");
    if (!input.signal.context) return fail("execution_context", "EXECUTION_CONTEXT_MISSING");
    pass("execution_context");
    const integrityFailure = executionEnvelopeIntegrityError(this.database, input.signal, input.signal.context);
    if (integrityFailure) return fail("signal_integrity", integrityFailure);
    pass("signal_integrity");
    const signalRuleset = this.database.prepare(
      "SELECT ruleset_hash FROM signals WHERE signal_id=?",
    ).get(input.signal.signalId) as { ruleset_hash: string } | undefined;
    if (!signalRuleset || signalRuleset.ruleset_hash !== input.signal.context.rulesetHash) {
      return fail("ruleset_hash", "SIGNAL_CONTEXT_RULESET_MISMATCH");
    }
    const registeredRules = registeredExecutionRules(this.database, input.signal.context.rulesetHash);
    if (!registeredRules || registeredRules.configVersion !== input.signal.context.configVersion) {
      return fail("ruleset_hash", "RULESET_UNREGISTERED_OR_INVALID");
    }
    pass("ruleset_hash", input.signal.context.rulesetHash);

    const target = this.signalTarget(input.signal.signalId);
    if (target?.sync_status === "MAJOR_DESYNC") return fail("target_sync", "MAJOR_DESYNC_PROTECTION");
    if (input.mode === "LIVE" && input.signal.signalType === "TARGET_BUY" && target?.sync_status === "MINOR_DIFF") {
      return fail("target_sync", "LIVE_MINOR_DIFF_NEW_OPEN_BLOCKED");
    }
    pass("target_sync", target?.sync_status ?? "UNKNOWN");

    const issue = target ? this.majorReconciliationIssue(target.target_id, input.signal.assetId) : null;
    if (issue) return fail("reconciliation", `MAJOR_DESYNC_RECONCILIATION:${issue.issue_id}`);
    pass("reconciliation");

    const frozen = this.blockingFrozenPositionCount(input.mode, input.accountId);
    if (frozen > 0) return fail("frozen_positions", "FROZEN_POSITION_PROTECTION");
    pass("frozen_positions");

    if (input.mode === "PAPER" && input.signal.signalType === "TARGET_BUY") {
      const marketDataState = this.paperMarketDataState(
        input.accountId,
        input.signal.assetId,
        input.signal.conditionId,
      );
      if (marketDataState && marketDataState !== "HEALTHY") {
        return fail(
          "market_data_health",
          marketDataState === "SETTLEMENT_ONLY" ? "MARKET_SETTLEMENT_ONLY" : "MARKET_DATA_FROZEN",
        );
      }
      pass("market_data_health", marketDataState ?? "HEALTHY");
    }

    if (input.signal.signalType === "TARGET_BUY") {
      let targetBuyPrice: bigint;
      try {
        targetBuyPrice = BigInt(input.signal.targetPriceUnits);
      } catch {
        return fail("target_buy_price", "TARGET_BUY_PRICE_INVALID");
      }
      if (targetBuyPrice > registeredRules.buyMaximumPriceUnits) {
        return fail("target_buy_price", "TARGET_BUY_PRICE_ABOVE_MAX");
      }
      pass("target_buy_price", `${targetBuyPrice}/${registeredRules.buyMaximumPriceUnits}`);
      const capital = input.signal.capitalDecision;
      if (!capital || capital.confidence === "LOW" || capital.status === "FAILED") {
        return fail("capital_decision", "CAPITAL_CONFIDENCE_LOW");
      }
      if (capital.status === "COMPLETE" && capital.confidence === "HIGH") {
        const ratioPpm = input.signal.context.targetTradeCapitalRatioPpm ?? capital.ratioPpm;
        if (ratioPpm === null) return fail("capital_decision", "CAPITAL_RATIO_UNAVAILABLE");
      }
      pass("capital_decision");
      if (input.capitalSizingDecision) {
        if (!isBuyCapitalSizingDecisionValid(input.capitalSizingDecision)) {
          return fail("capital_sizing", "CAPITAL_SIZING_EVIDENCE_HASH_MISMATCH");
        }
        const sizedAmount = input.capitalSizingDecision.calculatedAmountMicros;
        const amountPolicy = input.buyAmountPolicyDecision ?? null;
        if (amountPolicy) {
          if (!isBuyAmountPolicyDecisionValid(amountPolicy)) {
            return fail("buy_amount_policy", "BUY_AMOUNT_POLICY_EVIDENCE_HASH_MISMATCH");
          }
          if (
            amountPolicy.calculatedAmountMicros !== sizedAmount
            || amountPolicy.firstEntryMinimumAmountMicros
              !== registeredRules.buyFirstEntryMinimumAmountMicros.toString()
            || amountPolicy.marketMinimumAutoLiftCapMicros
              !== registeredRules.buyMarketMinimumAutoLiftCapMicros.toString()
          ) return fail("buy_amount_policy", "BUY_AMOUNT_POLICY_RULESET_MISMATCH");
          if (
            input.requestedAmountMicros === null
            || amountPolicy.finalAmountMicros !== input.requestedAmountMicros.toString()
          ) return fail("buy_amount_policy", "BUY_AMOUNT_POLICY_AMOUNT_MISMATCH");
          pass("buy_amount_policy", stableJson(amountPolicy));
        } else if (
          input.requestedAmountMicros !== null
          && sizedAmount !== input.requestedAmountMicros.toString()
        ) return fail("capital_sizing", "CAPITAL_SIZING_AMOUNT_MISMATCH");
        pass("capital_sizing", input.capitalSizingDecision.calculationVersion);
      }
      if (input.requestedAmountMicros === null || input.requestedAmountMicros <= 0n) {
        return fail(
          "requested_amount",
          input.capitalSizingDecision?.reason ?? "BUY_AMOUNT_UNAVAILABLE",
        );
      }
      const reservationCredit = input.replacingReservedAmountMicros ?? 0n;
      if (reservationCredit < 0n || reservationCredit > account.reservedBalanceMicros) {
        return fail("reservation_credit", "RISK_RESERVATION_CREDIT_INVALID");
      }
      if (reservationCredit > 0n) pass("reservation_credit", reservationCredit.toString());
      const available = account.cashBalanceMicros - account.reservedBalanceMicros + reservationCredit;
      if (input.requestedAmountMicros > available) return fail("account_balance", "INSUFFICIENT_AVAILABLE_CASH");
      pass("account_balance");
      const limitRejection = input.mode === "LIVE"
        ? this.evaluateLiveBuyLimits(input, account, fail, pass)
        : this.evaluatePaperBuyLimits(input, account, fail, pass);
      if (limitRejection) return limitRejection;
    } else {
      if (input.requestedSizeMicros === null || input.requestedSizeMicros <= 0n) {
        if (!input.targetExitSupersession) return fail("requested_size", "SELL_SIZE_UNAVAILABLE");
        pass("target_exit_supersession");
      } else {
        pass("requested_size");
      }
    }

    return this.recordSignalDecision(input, "ALLOW", "ALLOW", null, checks);
  }

  recordSystemDecision(input: SystemRiskDecisionInput): RiskDecision {
    const rulesetHash = input.rulesetHash ?? RULESET_HASH;
    const registeredRuleset = this.database.prepare(
      "SELECT config_version FROM ruleset_registry WHERE ruleset_hash=?",
    ).get(rulesetHash) as { config_version: string } | undefined;
    if (!registeredRuleset) throw new Error(`RISK_RULESET_NOT_REGISTERED:${rulesetHash}`);
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
      input.decision,
      input.reason,
      rulesetHash,
      this.sourceVersion.commit,
      this.sourceVersion.dirty ? 1 : 0,
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
      rulesetHash,
      configVersion: registeredRuleset.config_version,
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
    const decisionRuleset = this.signalDecisionRuleset(input.signal);
    const riskDecisionId = hash([
      "RISK",
      input.mode,
      input.accountId,
      input.signal.signalId,
      input.requestedAmountMicros?.toString() ?? "NONE",
      input.requestedSizeMicros?.toString() ?? "NONE",
      input.capitalSizingDecision?.evidenceHash ?? "NO_CAPITAL_SIZING_EVIDENCE",
      input.buyAmountPolicyDecision?.evidenceHash ?? "NO_BUY_AMOUNT_POLICY_EVIDENCE",
      input.replacingReservedAmountMicros?.toString() ?? "NO_RESERVATION_CREDIT",
      ...(input.targetExitSupersession ? ["TARGET_EXIT_SUPERSESSION"] : []),
      decision,
      riskReason,
      stableJson(checks),
      decisionRuleset.rulesetHash,
      this.sourceVersion.commit,
      this.sourceVersion.dirty ? 1 : 0,
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
      capitalSizingDecision: input.capitalSizingDecision ?? null,
      checks,
      rulesetHash: decisionRuleset.rulesetHash,
      configVersion: decisionRuleset.configVersion,
      now: input.now,
    });
  }

  private signalDecisionRuleset(signal: PaperSignalEnvelope): {
    rulesetHash: string;
    configVersion: string;
  } {
    const signalRow = this.database.prepare(
      `SELECT s.ruleset_hash,r.config_version
       FROM signals s
       LEFT JOIN ruleset_registry r ON r.ruleset_hash=s.ruleset_hash
       WHERE s.signal_id=?`,
    ).get(signal.signalId) as { ruleset_hash: string; config_version: string | null } | undefined;
    const candidate = signal.context?.rulesetHash ?? signalRow?.ruleset_hash ?? RULESET_HASH;
    const registered = this.database.prepare(
      "SELECT config_version FROM ruleset_registry WHERE ruleset_hash=?",
    ).get(candidate) as { config_version: string } | undefined;
    if (registered) return { rulesetHash: candidate, configVersion: registered.config_version };
    // A malformed/unregistered historical ruleset is itself a rejection, but
    // the Risk Decision must still be persistable and auditable. Fall back to
    // the process ruleset without ever allowing execution.
    return { rulesetHash: RULESET_HASH, configVersion: VERSIONS.configVersion };
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
    capitalSizingDecision?: BuyCapitalSizingDecision | null;
    checks: RiskDecision["checks"];
    rulesetHash: string;
    configVersion: string;
    now: string;
  }): RiskDecision {
    this.database.exec("SAVEPOINT risk_decision_write");
    try {
      this.database.prepare(
        `INSERT OR IGNORE INTO risk_decisions(
          risk_decision_id,executor_mode,paper_account_id,account_id,signal_id,context_id,decision,
          risk_reject_reason,requested_amount_micros,requested_size_micros,checks_json,
          capital_sizing_decision_json,capital_sizing_decision_hash,
          schema_version,strategy_version,risk_version,ruleset_hash,source_code_commit,
          source_code_dirty,config_version,created_at,risk_reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.riskDecisionId,
        input.mode,
        input.mode === "PAPER" ? input.accountId : null,
        input.accountId,
        input.signalId,
        input.contextId,
        input.decision,
        input.riskRejectReason,
        input.requestedAmountMicros?.toString() ?? null,
        input.requestedSizeMicros?.toString() ?? null,
        stableJson(input.checks),
        input.capitalSizingDecision ? stableJson(input.capitalSizingDecision) : null,
        input.capitalSizingDecision?.evidenceHash ?? null,
        VERSIONS.schemaVersion,
        VERSIONS.strategyVersion,
        VERSIONS.riskVersion,
        input.rulesetHash,
        this.sourceVersion.commit,
        this.sourceVersion.dirty ? 1 : 0,
        input.configVersion,
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
        input.rulesetHash,
        this.sourceVersion.commit,
        this.sourceVersion.dirty ? 1 : 0,
        input.configVersion,
        stableJson({
          mode: input.mode,
          accountId: input.accountId,
          signalId: input.signalId,
          contextId: input.contextId,
          checks: input.checks,
          capitalSizingDecisionHash: input.capitalSizingDecision?.evidenceHash ?? null,
        }),
      );
      this.database.exec("RELEASE SAVEPOINT risk_decision_write");
    } catch (error) {
      this.database.exec("ROLLBACK TO SAVEPOINT risk_decision_write");
      this.database.exec("RELEASE SAVEPOINT risk_decision_write");
      throw error;
    }
    return {
      riskDecisionId: input.riskDecisionId,
      decision: input.decision,
      riskReason: input.riskReason,
      riskRejectReason: input.riskRejectReason,
      checks: input.checks,
    };
  }

  private account(mode: ExecutorMode, accountId: string): RiskAccount {
    if (mode === "LIVE") return this.liveAccount(accountId);
    const row = this.database.prepare(
      `SELECT status,initial_balance_micros,cash_balance_micros,reserved_balance_micros,
              signal_cutoff_at FROM paper_accounts WHERE paper_account_id=?`,
    ).get(accountId) as {
      status: string;
      initial_balance_micros: string;
      cash_balance_micros: string;
      reserved_balance_micros: string;
      signal_cutoff_at: string;
    } | undefined;
    if (!row) throw new Error(`PAPER_ACCOUNT_NOT_FOUND:${accountId}`);
    return {
      status: row.status,
      walletStatus: null,
      initialBalanceMicros: BigInt(row.initial_balance_micros),
      cashBalanceMicros: BigInt(row.cash_balance_micros),
      reservedBalanceMicros: BigInt(row.reserved_balance_micros),
      riskBudgetMicros: null,
      signalCutoffAt: row.signal_cutoff_at,
    };
  }

  private liveAccount(accountId: string): RiskAccount {
    const row = this.database.prepare(
      `SELECT a.status,w.status wallet_status,a.initial_bankroll_micros,
              a.risk_budget_micros,a.signal_cutoff_at
       FROM live_accounts a
       JOIN live_wallets w ON w.live_wallet_id=a.live_wallet_id
       WHERE a.live_account_id=?`,
    ).get(accountId) as {
      status: string;
      wallet_status: string;
      initial_bankroll_micros: string;
      risk_budget_micros: string;
      signal_cutoff_at: string;
    } | undefined;
    if (!row) throw new Error(`LIVE_ACCOUNT_NOT_FOUND:${accountId}`);
    const cashDelta = this.sumTextRows(
      "SELECT cash_delta_micros value FROM live_cash_ledger WHERE live_account_id=?",
      accountId,
    );
    const reserved = this.sumTextRows(
      "SELECT reserved_delta_micros value FROM live_cash_ledger WHERE live_account_id=?",
      accountId,
    );
    return {
      status: row.status,
      walletStatus: row.wallet_status,
      initialBalanceMicros: BigInt(row.initial_bankroll_micros),
      cashBalanceMicros: BigInt(row.initial_bankroll_micros) + cashDelta,
      reservedBalanceMicros: reserved,
      riskBudgetMicros: BigInt(row.risk_budget_micros),
      signalCutoffAt: row.signal_cutoff_at,
    };
  }

  private signalTarget(signalId: string): { target_id: string; sync_status: string } | null {
    const row = this.database.prepare(
      `SELECT s.target_id,t.sync_status
       FROM signals s
       JOIN monitor_targets t ON t.target_id=s.target_id
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

  private blockingFrozenPositionCount(mode: ExecutorMode, accountId: string): number {
    const table = mode === "LIVE" ? "live_positions" : "paper_positions";
    const accountColumn = mode === "LIVE" ? "live_account_id" : "paper_account_id";
    const marketDataExclusion = mode === "PAPER"
      ? " AND (frozen_reason IS NULL OR frozen_reason NOT LIKE 'MARKET_DATA:%')"
      : "";
    const row = this.database.prepare(
      `SELECT count(*) count FROM ${table}
       WHERE ${accountColumn}=? AND status='FROZEN'${marketDataExclusion}`,
    )
      .get(accountId) as { count: number };
    return row.count;
  }

  private paperMarketDataState(accountId: string, assetId: string, conditionId: string): string | null {
    const row = this.database.prepare(
      `SELECT state FROM paper_market_data_health
       WHERE paper_account_id=? AND asset_id=? AND condition_id=?`,
    ).get(accountId, assetId, conditionId) as { state: string } | undefined;
    return row?.state ?? null;
  }

  private marketExposure(mode: ExecutorMode, accountId: string, conditionId: string): bigint {
    const table = mode === "LIVE" ? "live_positions" : "paper_positions";
    const accountColumn = mode === "LIVE" ? "live_account_id" : "paper_account_id";
    return this.sumTextRows(
      `SELECT remaining_cost_micros value FROM ${table}
       WHERE ${accountColumn}=? AND condition_id=?
         AND status IN ('OPEN','PARTIALLY_CLOSED','SETTLEMENT_PENDING')`,
      accountId,
      conditionId,
    );
  }

  private assetExposure(mode: ExecutorMode, accountId: string, assetId: string): bigint {
    const table = mode === "LIVE" ? "live_positions" : "paper_positions";
    const accountColumn = mode === "LIVE" ? "live_account_id" : "paper_account_id";
    return this.sumTextRows(
      `SELECT remaining_cost_micros value FROM ${table}
       WHERE ${accountColumn}=? AND asset_id=?
         AND status IN ('OPEN','PARTIALLY_CLOSED','SETTLEMENT_PENDING')`,
      accountId,
      assetId,
    );
  }

  private totalExposure(mode: ExecutorMode, accountId: string): bigint {
    const table = mode === "LIVE" ? "live_positions" : "paper_positions";
    const accountColumn = mode === "LIVE" ? "live_account_id" : "paper_account_id";
    return this.sumTextRows(
      `SELECT remaining_cost_micros value FROM ${table}
       WHERE ${accountColumn}=? AND status IN ('OPEN','PARTIALLY_CLOSED','SETTLEMENT_PENDING')`,
      accountId,
    );
  }

  private sumTextRows(query: string, ...parameters: string[]): bigint {
    const rows = this.database.prepare(query).all(...parameters) as unknown as Array<{ value: string }>;
    return rows.reduce((total, row) => total + BigInt(row.value), 0n);
  }

  private evaluatePaperBuyLimits(
    input: RiskEvaluationInput,
    account: RiskAccount,
    fail: (name: string, reason: string) => RiskDecision,
    pass: (name: string, detail?: string) => void,
  ): RiskDecision | null {
    const requested = input.requestedAmountMicros as bigint;
    const singleLimit = limitFromInitial(account.initialBalanceMicros, RULESET.paperMaxSingleTradePpm);
    if (requested > singleLimit) return fail("single_trade_limit", "SINGLE_TRADE_LIMIT_EXCEEDED");
    pass("single_trade_limit");
    const marketExposure = this.marketExposure("PAPER", input.accountId, input.signal.conditionId) + requested;
    const marketLimit = limitFromInitial(account.initialBalanceMicros, RULESET.paperMaxMarketExposurePpm);
    if (marketExposure > marketLimit) return fail("market_exposure_limit", "MARKET_EXPOSURE_LIMIT_EXCEEDED");
    pass("market_exposure_limit");
    const assetExposure = this.assetExposure("PAPER", input.accountId, input.signal.assetId) + requested;
    const positionLimit = limitFromInitial(account.initialBalanceMicros, RULESET.paperMaxPositionExposurePpm);
    if (assetExposure > positionLimit) return fail("position_exposure_limit", "POSITION_EXPOSURE_LIMIT_EXCEEDED");
    pass("position_exposure_limit");
    return null;
  }

  private evaluateLiveBuyLimits(
    input: RiskEvaluationInput,
    account: RiskAccount,
    fail: (name: string, reason: string) => RiskDecision,
    pass: (name: string, detail?: string) => void,
  ): RiskDecision | null {
    const requested = input.requestedAmountMicros as bigint;
    const riskBudget = account.riskBudgetMicros as bigint;
    const singleLimit = minBigInt(
      minBigInt(limitFromInitial(account.initialBalanceMicros, RULESET.liveMaxSingleTradePpm), BigInt(RULESET.liveMaxTradeSizeMicros)),
      riskBudget,
    );
    if (requested > singleLimit) return fail("live_single_trade", "LIVE_SINGLE_TRADE_LIMIT_EXCEEDED");
    pass("live_single_trade", singleLimit.toString());
    const marketExposure = this.marketExposure("LIVE", input.accountId, input.signal.conditionId) + requested;
    const marketLimit = minBigInt(
      minBigInt(limitFromInitial(account.initialBalanceMicros, RULESET.liveMaxMarketExposurePpm), BigInt(RULESET.liveMaxTradeSizeMicros)),
      riskBudget,
    );
    if (marketExposure > marketLimit) {
      return fail("live_market_exposure", "LIVE_MARKET_EXPOSURE_LIMIT_EXCEEDED");
    }
    pass("live_market_exposure", marketExposure.toString());
    const assetExposure = this.assetExposure("LIVE", input.accountId, input.signal.assetId) + requested;
    const positionLimit = minBigInt(
      minBigInt(limitFromInitial(account.initialBalanceMicros, RULESET.liveMaxPositionExposurePpm), BigInt(RULESET.liveMaxTradeSizeMicros)),
      riskBudget,
    );
    if (assetExposure > positionLimit) {
      return fail("live_position_exposure", "LIVE_POSITION_EXPOSURE_LIMIT_EXCEEDED");
    }
    pass("live_position_exposure", assetExposure.toString());
    const totalLimit = minBigInt(
      minBigInt(limitFromInitial(account.initialBalanceMicros, RULESET.liveMaxTotalExposurePpm), BigInt(RULESET.liveMaxExposureMicros)),
      riskBudget,
    );
    const totalExposure = this.totalExposure("LIVE", input.accountId) + requested;
    if (totalExposure > totalLimit) {
      return fail("live_total_exposure", "LIVE_TOTAL_EXPOSURE_LIMIT_EXCEEDED");
    }
    pass("live_total_exposure", totalExposure.toString());
    const loss = this.liveLossStats(input.accountId, input.now);
    const dailyLossLimit = minBigInt(
      limitFromInitial(account.initialBalanceMicros, RULESET.liveMaxDailyLossPpm),
      BigInt(RULESET.liveMaxDailyLossMicros),
    );
    if (loss.dailyLossMicros >= dailyLossLimit && dailyLossLimit > 0n) {
      return fail("live_daily_loss", "LIVE_DAILY_LOSS_LIMIT_REACHED");
    }
    pass("live_daily_loss", `${loss.dailyLossMicros}/${dailyLossLimit}`);
    if (loss.consecutiveLosses >= RULESET.liveMaxConsecutiveLosses) {
      return fail("live_consecutive_losses", "LIVE_CONSECUTIVE_LOSS_LIMIT_REACHED");
    }
    pass("live_consecutive_losses", `${loss.consecutiveLosses}/${RULESET.liveMaxConsecutiveLosses}`);
    return null;
  }

  private liveLossStats(accountId: string, now: string): { dailyLossMicros: bigint; consecutiveLosses: number } {
    const timestamp = Date.parse(now);
    if (!Number.isFinite(timestamp)) throw new Error(`INVALID_RISK_TIMESTAMP:${now}`);
    const dayStart = new Date(timestamp);
    dayStart.setUTCHours(0, 0, 0, 0);
    const rows = this.database.prepare(
      `SELECT p.live_execution_id,p.pnl_ledger_id,p.pnl_micros,p.created_at
       FROM live_pnl_ledger p
       WHERE p.live_account_id=?
       ORDER BY p.created_at,p.pnl_ledger_id`,
    ).all(accountId) as unknown as Array<{
      live_execution_id: string;
      pnl_ledger_id: string;
      pnl_micros: string;
      created_at: string;
    }>;
    let dailyLossMicros = 0n;
    const executions = new Map<string, { pnl: bigint; createdAt: string }>();
    for (const row of rows) {
      const pnl = BigInt(row.pnl_micros);
      if (Date.parse(row.created_at) >= dayStart.valueOf() && pnl < 0n) dailyLossMicros -= pnl;
      const prior = executions.get(row.live_execution_id);
      executions.set(row.live_execution_id, {
        pnl: (prior?.pnl ?? 0n) + pnl,
        createdAt: prior && prior.createdAt > row.created_at ? prior.createdAt : row.created_at,
      });
    }
    const ordered = [...executions.entries()]
      .sort(([leftId, left], [rightId, right]) => right.createdAt.localeCompare(left.createdAt) || rightId.localeCompare(leftId));
    let consecutiveLosses = 0;
    for (const [, execution] of ordered) {
      if (execution.pnl >= 0n) break;
      consecutiveLosses += 1;
    }
    return { dailyLossMicros, consecutiveLosses };
  }
}
