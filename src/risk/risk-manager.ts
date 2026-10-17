import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { RULESET, RULESET_HASH, stableJson, VERSIONS } from "../domain/versioning.js";
import { registeredExecutionRules } from "../domain/ruleset-registry.js";
import type { SourceVersion } from "../infra/source-version.js";
import type { ExecutorMode } from "../execution/types.js";
import { loadAccountExposure, type AccountExposure } from "../execution/exposure-obligations.js";
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

export interface LiveRiskLimits {
  maxTradeSizeMicros: string;
  maxExposureMicros: string;
  maxDailyLossMicros: string;
}

interface ParsedLiveRiskLimits {
  maxTradeSizeMicros: bigint;
  maxExposureMicros: bigint;
  maxDailyLossMicros: bigint;
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
  replacingExecutionId?: string;
  targetExitSupersession?: boolean;
  now: string;
}

export interface SystemRiskDecisionInput {
  mode: ExecutorMode;
  accountId: string;
  signalId: string | null;
  contextId: string | null;
  entityId: string;
  executionType: "TARGET_BUY" | "STOP_LOSS" | "SETTLEMENT" | "REDEEM";
  decision: RiskDecisionResult;
  reason: string;
  requestedAmountMicros: bigint | null;
  requestedSizeMicros: bigint | null;
  /** Ruleset owned by the position/context that caused this system action. */
  rulesetHash?: string;
  now: string;
}

export interface DownwardAmountRiskAdjustmentInput {
  mode: ExecutorMode;
  accountId: string;
  entityId: string;
  priorRiskDecisionId: string;
  requestedAmountMicros: bigint;
  reason: string;
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

function parsedPositiveLimit(value: string, name: string): bigint {
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error(`LIVE_RISK_${name}_INVALID`);
  return BigInt(value);
}

export class RiskManager {
  private readonly liveRiskLimits: ParsedLiveRiskLimits;

  constructor(
    private readonly database: DatabaseSync,
    private readonly sourceVersion: SourceVersion,
    liveRiskLimits?: LiveRiskLimits,
  ) {
    this.database.exec("PRAGMA recursive_triggers=ON;");
    this.liveRiskLimits = liveRiskLimits === undefined
      ? {
        maxTradeSizeMicros: BigInt(RULESET.liveMaxTradeSizeMicros),
        maxExposureMicros: BigInt(RULESET.liveMaxExposureMicros),
        maxDailyLossMicros: BigInt(RULESET.liveMaxDailyLossMicros),
      }
      : {
        maxTradeSizeMicros: parsedPositiveLimit(liveRiskLimits.maxTradeSizeMicros, "MAX_TRADE"),
        maxExposureMicros: parsedPositiveLimit(liveRiskLimits.maxExposureMicros, "MAX_EXPOSURE"),
        maxDailyLossMicros: parsedPositiveLimit(liveRiskLimits.maxDailyLossMicros, "MAX_DAILY_LOSS"),
      };
    if (
      this.liveRiskLimits.maxTradeSizeMicros > this.liveRiskLimits.maxExposureMicros
    ) {
      throw new Error("LIVE_RISK_MAX_TRADE_EXCEEDS_EXPOSURE");
    }
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

    const issue = target
      ? this.majorReconciliationIssue(target.target_id, input.signal.assetId, target.observe_run_id)
      : null;
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
      if (targetBuyPrice <= 0n || targetBuyPrice >= 10n ** 18n) {
        return fail("target_buy_price", "TARGET_BUY_PRICE_INVALID");
      }
      if (!registeredRules.smallFollowBuyPolicyEnabled
        && targetBuyPrice > registeredRules.buyMaximumPriceUnits) {
        return fail("target_buy_price", "TARGET_BUY_PRICE_ABOVE_MAX");
      }
      pass("target_buy_price", targetBuyPrice.toString());
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
      const exposure = loadAccountExposure(this.database, input.mode, input.accountId, input.replacingExecutionId, {
        assetId: input.signal.assetId, conditionId: input.signal.conditionId,
      });
      const ownReservation = input.replacingExecutionId
        ? exposure.pendingBuys.get(input.replacingExecutionId)
        : undefined;
      if (reservationCredit < 0n || reservationCredit > account.reservedBalanceMicros
        || (input.replacingExecutionId !== undefined || reservationCredit > 0n) && (
          !ownReservation || ownReservation.amountMicros !== reservationCredit
          || ownReservation.assetId !== input.signal.assetId
          || ownReservation.conditionId.toLowerCase() !== input.signal.conditionId.toLowerCase()
        )) {
        return fail("reservation_credit", "RISK_RESERVATION_CREDIT_INVALID");
      }
      if (reservationCredit > 0n) pass("reservation_credit", reservationCredit.toString());
      const available = account.cashBalanceMicros - account.reservedBalanceMicros + reservationCredit;
      if (input.requestedAmountMicros > available) return fail("account_balance", "INSUFFICIENT_AVAILABLE_CASH");
      pass("account_balance");
      const limitRejection = input.mode === "LIVE"
        ? this.evaluateLiveBuyLimits(input, account, exposure, fail, pass)
        : this.evaluateBuyExposureLimits(input, account, exposure, fail, pass);
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

  recordDownwardAmountAdjustment(input: DownwardAmountRiskAdjustmentInput): RiskDecision {
    const prior = this.database.prepare(
      `SELECT executor_mode,account_id,signal_id,context_id,decision,
              requested_amount_micros,requested_size_micros,ruleset_hash
       FROM risk_decisions WHERE risk_decision_id=?`,
    ).get(input.priorRiskDecisionId) as {
      executor_mode: string;
      account_id: string;
      signal_id: string | null;
      context_id: string | null;
      decision: string;
      requested_amount_micros: string | null;
      requested_size_micros: string | null;
      ruleset_hash: string;
    } | undefined;
    if (!prior) throw new Error("PRIOR_RISK_DECISION_NOT_FOUND");
    if (prior.executor_mode !== input.mode || prior.account_id !== input.accountId) {
      throw new Error("PRIOR_RISK_DECISION_SCOPE_MISMATCH");
    }
    if (prior.decision !== "ALLOW" || prior.requested_amount_micros === null) {
      throw new Error("PRIOR_RISK_DECISION_NOT_AMOUNT_ALLOW");
    }
    if (prior.requested_size_micros !== null) {
      throw new Error("PRIOR_RISK_DECISION_AMOUNT_SIZE_CONFLICT");
    }
    const priorAmount = BigInt(prior.requested_amount_micros);
    if (input.requestedAmountMicros < 0n || input.requestedAmountMicros >= priorAmount) {
      throw new Error("RISK_AMOUNT_ADJUSTMENT_NOT_DOWNWARD");
    }
    const registeredRuleset = this.database.prepare(
      "SELECT config_version FROM ruleset_registry WHERE ruleset_hash=?",
    ).get(prior.ruleset_hash) as { config_version: string } | undefined;
    if (!registeredRuleset) throw new Error(`RISK_RULESET_NOT_REGISTERED:${prior.ruleset_hash}`);
    const checks: RiskDecision["checks"] = [
      { name: "prior_risk_decision", result: "PASS", detail: input.priorRiskDecisionId },
      {
        name: "downward_amount_adjustment",
        result: "PASS",
        detail: `${priorAmount.toString()}->${input.requestedAmountMicros.toString()}`,
      },
    ];
    const riskDecisionId = hash([
      "RISK",
      input.mode,
      input.accountId,
      "DOWNWARD_AMOUNT_ADJUSTMENT",
      input.entityId,
      input.priorRiskDecisionId,
      input.requestedAmountMicros.toString(),
      input.reason,
      prior.ruleset_hash,
      this.sourceVersion.commit,
      this.sourceVersion.dirty ? 1 : 0,
    ]);
    return this.insertDecision({
      riskDecisionId,
      mode: input.mode,
      accountId: input.accountId,
      signalId: prior.signal_id,
      contextId: prior.context_id,
      decision: "ALLOW",
      riskReason: input.reason,
      riskRejectReason: null,
      requestedAmountMicros: input.requestedAmountMicros,
      requestedSizeMicros: null,
      checks,
      rulesetHash: prior.ruleset_hash,
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

  private signalTarget(
    signalId: string,
  ): { target_id: string; sync_status: string; observe_run_id: string | null } | null {
    const row = this.database.prepare(
      `SELECT s.target_id,t.sync_status,s.observe_run_id
       FROM signals s
       JOIN monitor_targets t ON t.target_id=s.target_id
       WHERE s.signal_id=?`,
    ).get(signalId) as {
      target_id: string;
      sync_status: string;
      observe_run_id: string | null;
    } | undefined;
    return row ?? null;
  }

  private majorReconciliationIssue(
    targetId: string,
    assetId: string,
    observeRunId: string | null,
  ): { issue_id: string } | null {
    const rows = this.database.prepare(
      `SELECT issue_id,issue_type,detail_json FROM reconciliation_issues
       WHERE target_id=? AND (asset_id IS NULL OR asset_id=?) AND sync_status='MAJOR_DESYNC'
         AND status!='RESOLVED'
       ORDER BY created_at DESC`,
    ).all(targetId, assetId) as Array<{
      issue_id: string;
      issue_type: string;
      detail_json: string;
    }>;
    for (const row of rows) {
      if (row.issue_type !== "POLYGON_TRADE_FEED_UNSAFE") return row;
      if (observeRunId === null) return row;
      let issueObserveRunId: string | null = null;
      try {
        const detail = JSON.parse(row.detail_json) as { observeRunId?: unknown };
        issueObserveRunId = typeof detail.observeRunId === "string" ? detail.observeRunId : null;
      } catch {
        return row;
      }
      if (issueObserveRunId === null || issueObserveRunId === observeRunId) return row;
    }
    return null;
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

  /** Recheck the current obligations while the caller holds its write transaction. */
  buyExposureRejectReason(input: {
    mode: ExecutorMode;
    accountId: string;
    assetId: string;
    conditionId: string;
    requestedAmountMicros: bigint;
    replacingExecutionId?: string;
  }): string | null {
    const exposure = loadAccountExposure(this.database, input.mode, input.accountId, input.replacingExecutionId, {
      assetId: input.assetId, conditionId: input.conditionId,
    });
    if (input.replacingExecutionId) {
      const own = exposure.pendingBuys.get(input.replacingExecutionId);
      if (!own || own.assetId !== input.assetId
        || own.conditionId.toLowerCase() !== input.conditionId.toLowerCase()
        || own.amountMicros !== input.requestedAmountMicros) return "RISK_RESERVATION_CREDIT_INVALID";
    }
    return this.buyExposureChecks(input, this.account(input.mode, input.accountId), exposure)
      .find((check) => !check.passed)?.reason ?? null;
  }

  private buyExposureChecks(input: {
    mode: ExecutorMode;
    assetId: string;
    conditionId: string;
    requestedAmountMicros: bigint;
  }, account: RiskAccount, exposure: AccountExposure): Array<{
    name: string; reason: string; passed: boolean; detail?: string;
  }> {
    const requested = input.requestedAmountMicros;
    const market = (exposure.marketMicros.get(input.conditionId.toLowerCase()) ?? 0n) + requested;
    const asset = (exposure.assetMicros.get(input.assetId) ?? 0n) + requested;
    if (input.mode === "PAPER") return [
      { name: "single_trade_limit", reason: "SINGLE_TRADE_LIMIT_EXCEEDED",
        passed: requested <= limitFromInitial(account.initialBalanceMicros, RULESET.paperMaxSingleTradePpm) },
      { name: "market_exposure_limit", reason: "MARKET_EXPOSURE_LIMIT_EXCEEDED",
        passed: market <= limitFromInitial(account.initialBalanceMicros, RULESET.paperMaxMarketExposurePpm) },
      { name: "position_exposure_limit", reason: "POSITION_EXPOSURE_LIMIT_EXCEEDED",
        passed: asset <= limitFromInitial(account.initialBalanceMicros, RULESET.paperMaxPositionExposurePpm) },
    ];
    const riskBudget = account.riskBudgetMicros as bigint;
    const single = minBigInt(this.liveRiskLimits.maxTradeSizeMicros, riskBudget);
    const limit = minBigInt(this.liveRiskLimits.maxExposureMicros, riskBudget);
    const total = exposure.totalMicros + requested;
    return [
      { name: "live_single_trade", reason: "LIVE_SINGLE_TRADE_LIMIT_EXCEEDED",
        passed: requested <= single, detail: single.toString() },
      { name: "live_market_exposure", reason: "LIVE_MARKET_EXPOSURE_LIMIT_EXCEEDED",
        passed: market <= limit, detail: `${market}/${limit}` },
      { name: "live_position_exposure", reason: "LIVE_POSITION_EXPOSURE_LIMIT_EXCEEDED",
        passed: asset <= limit, detail: `${asset}/${limit}` },
      { name: "live_total_exposure", reason: "LIVE_TOTAL_EXPOSURE_LIMIT_EXCEEDED",
        passed: total <= limit, detail: `${total}/${limit}` },
    ];
  }

  private sumTextRows(query: string, ...parameters: string[]): bigint {
    const rows = this.database.prepare(query).all(...parameters) as unknown as Array<{ value: string }>;
    return rows.reduce((total, row) => total + BigInt(row.value), 0n);
  }

  private evaluateBuyExposureLimits(
    input: RiskEvaluationInput,
    account: RiskAccount,
    exposure: AccountExposure,
    fail: (name: string, reason: string) => RiskDecision,
    pass: (name: string, detail?: string) => void,
  ): RiskDecision | null {
    for (const check of this.buyExposureChecks({
      mode: input.mode,
      assetId: input.signal.assetId,
      conditionId: input.signal.conditionId,
      requestedAmountMicros: input.requestedAmountMicros as bigint,
    }, account, exposure)) {
      if (!check.passed) return fail(check.name, check.reason);
      pass(check.name, check.detail);
    }
    return null;
  }

  private evaluateLiveBuyLimits(
    input: RiskEvaluationInput,
    account: RiskAccount,
    exposure: AccountExposure,
    fail: (name: string, reason: string) => RiskDecision,
    pass: (name: string, detail?: string) => void,
  ): RiskDecision | null {
    const exposureRejection = this.evaluateBuyExposureLimits(input, account, exposure, fail, pass);
    if (exposureRejection) return exposureRejection;
    const dailyLoss = this.liveDailyLossMicros(input.accountId, input.now);
    if (dailyLoss >= this.liveRiskLimits.maxDailyLossMicros) {
      return fail("live_daily_loss", "LIVE_DAILY_LOSS_LIMIT_REACHED");
    }
    pass("live_daily_loss", `${dailyLoss}/${this.liveRiskLimits.maxDailyLossMicros}`);
    return null;
  }

  private liveDailyLossMicros(accountId: string, now: string): bigint {
    const timestamp = Date.parse(now);
    if (!Number.isFinite(timestamp)) throw new Error(`INVALID_RISK_TIMESTAMP:${now}`);
    const dayStart = new Date(timestamp);
    dayStart.setUTCHours(0, 0, 0, 0);
    const rows = this.database.prepare(
      `SELECT p.pnl_micros,p.created_at
       FROM live_pnl_ledger p
       WHERE p.live_account_id=?
       ORDER BY p.created_at,p.pnl_ledger_id`,
    ).all(accountId) as unknown as Array<{ pnl_micros: string; created_at: string }>;
    let dailyLossMicros = 0n;
    for (const row of rows) {
      const pnl = BigInt(row.pnl_micros);
      if (Date.parse(row.created_at) >= dayStart.valueOf() && pnl < 0n) dailyLossMicros -= pnl;
    }
    return dailyLossMicros;
  }
}
