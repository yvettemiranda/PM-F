import { DatabaseSync } from "node:sqlite";
import type {
  ExecutorBalanceQuery,
  ExecutorExecutionResult,
  ExecutorInterface,
  ExecutorPositionQuery,
  ExecutorReconcileInput,
  ExecutorReconcileResult,
  ExecutorSignalInput,
} from "../execution/types.js";
import { executionEnvelopeIntegrityError } from "../execution/signal-integrity.js";
import { conservativeClobBuyFeeMicros } from "../execution/clob-fee.js";
import type { PaperAccountSnapshot, PaperSignalEnvelope, SignalExecutionContext } from "../paper/types.js";
import { PRICE_SCALE_DIGITS, SHARE_SCALE_DIGITS, scaledToDecimal } from "../domain/fixed.js";
import { RULESET, RULESET_HASH } from "../domain/versioning.js";
import { registeredExecutionRules, registeredStopLossRules } from "../domain/ruleset-registry.js";
import {
  bestExecutionAskPriceUnits,
  buyNoFillReason,
  executableSellVwap,
  feeInclusiveBuyVwapPriceUnits,
  matchExecutionBuy,
  matchExecutionSell,
  quoteExecutionBuySize,
  type ExecutionMatchResult,
} from "../execution/orderbook-matching.js";
import {
  cappedBuyPriceUpperUnits,
  executableBuyPriceUpperUnits,
  evaluateBuyMarketConstraint,
  evaluateSellMarketConstraint,
  parseMarketOrderConstraints,
} from "../execution/market-order-constraints.js";
import {
  executableOrderbookAgeMs,
  type ExecutionFeeSnapshot,
  type ExecutionOrderbookSnapshot,
} from "../execution/market-data.js";
import { resolveSourceVersion, type SourceVersion } from "../infra/source-version.js";
import { DisabledOrderAdapter } from "./disabled-order-adapter.js";
import { DisabledRedeemAdapter } from "./disabled-redeem-adapter.js";
import { DisabledSigner } from "./disabled-signer.js";
import { DisabledWalletProvider } from "./disabled-wallet-provider.js";
import { DisabledLiveMarketDataProvider, type LiveMarketDataProvider } from "./live-market-data.js";
import { OrderSubmissionOutcomeUnknownError, type OrderAdapter } from "./order-adapter.js";
import type { RedeemAdapter } from "./redeem-adapter.js";
import type { Signer } from "./signer.js";
import type { WalletProvider } from "./wallet-provider.js";
import { RiskManager } from "../risk/risk-manager.js";
import {
  applyBuyAmountPolicy,
  applyPriorBuyAmountPolicy,
  classifyTargetBuyRatio,
} from "../execution/buy-amount-policy.js";
import { evaluateBuyFollowPolicy } from "../execution/buy-follow-policy.js";
import {
  fullExitThresholdForTargetSell,
  parseEffectiveTargetSellRatio,
} from "../execution/target-sell-policy.js";
import { liveBuyMinimumLiftEligibility } from "./live-buy-eligibility.js";
import type { BuyCapitalSizingDecision, ExactCapitalRatioSnapshot } from "../execution/capital-sizing.js";
import { withExternalTimeout } from "./external-timeout.js";
import { validateLiveOrderFills } from "./fill-validation.js";
import { LiveCrashRecovery } from "./live-crash-recovery.js";
import { LiveReconciliation } from "./live-reconciliation.js";
import {
  cancelIdempotencyKey,
  liveExecutionIdempotencyKey,
  liveTargetSellWaitingBuyAdjustmentIdempotencyKey,
  liveOrderIdempotencyKey,
  LiveStore,
  redeemIdempotencyKey,
  type LiveExecutionRow,
  type LiveSettlementConfirmation,
  type LiveSettlementRecord,
} from "./live-store.js";
import type {
  LiveExecutionGate,
  LiveOrderRequest,
  LiveOrderSide,
  OrderSubmitResult,
} from "./live-types.js";

const PRICE_SCALE = 1_000_000_000_000_000_000n;

interface ApprovedRiskDecisionRow {
  risk_decision_id: string;
  executor_mode: string;
  paper_account_id: string | null;
  account_id: string | null;
  signal_id: string | null;
  context_id: string | null;
  decision: string;
  requested_amount_micros: string | null;
  requested_size_micros: string | null;
  ruleset_hash: string;
  risk_reason: string | null;
  checks_json: string;
}

interface LiveSignalExecutionOptions {
  executionType?: "TARGET_BUY" | "TARGET_SELL" | "STOP_LOSS";
  idempotencySubject?: string;
  positionId?: string;
}

export interface LiveSettlementProcessingResult {
  pendingPositionIds: string[];
  resolvedPositionIds: string[];
  failures: Array<{ positionId: string; reason: string }>;
}

export interface LiveStopLossBlocker {
  positionId: string;
  reason: string;
}

export interface LiveStopLossCheckResult {
  executionIds: string[];
  healthy: boolean;
  blockers: LiveStopLossBlocker[];
}

export type LivePendingRetryScope = "ALL" | "EXITS_ONLY" | "BUYS_ONLY";

export interface LiveExecutorOptions {
  databasePath: string;
  liveGate: LiveExecutionGate;
  orderAdapter?: OrderAdapter;
  walletProvider?: WalletProvider;
  signer?: Signer;
  redeemAdapter?: RedeemAdapter;
  marketDataProvider?: LiveMarketDataProvider;
  sourceVersion?: SourceVersion;
  now?: () => Date;
  /** Fake components are accepted only by explicitly isolated tests. */
  environment?: "PRODUCTION" | "TEST";
  /** Test-only override; production can never disable external CTF reconciliation. */
  requireExternalPositionReconciliation?: boolean;
  externalCallTimeoutMs?: number;
}

type WalletCheckResult =
  | { ok: false; reason: string }
  | {
      ok: true;
      balanceMicros: string;
      allowanceMicros: string;
      registeredWalletAddress: string;
      authorizedSignerAddress: string;
    };

interface LiveMarketPlan {
  book: ExecutionOrderbookSnapshot;
  fee: ExecutionFeeSnapshot;
  ageMs: number;
  match: ExecutionMatchResult;
  orderMatch: ExecutionMatchResult;
  lowerPriceUnits: string | null;
  upperPriceUnits: string | null;
  limitPriceUnits: string;
  outcome: "ALLOW" | "WAIT" | "EXPIRED" | "REJECT";
  reason: string;
  minimumPassingAmountMicros?: string | null;
}

type LiveBuyAutoLiftResult =
  | { status: "NOT_ELIGIBLE" }
  | { status: "REJECTED"; execution: LiveExecutionRow; reason: string }
  | {
      status: "LIFTED";
      execution: LiveExecutionRow;
      approval: ApprovedRiskDecisionRow;
      walletCheck: Extract<WalletCheckResult, { ok: true }>;
      effectiveInput: ExecutorSignalInput;
    };

function notionalMicros(priceUnits: string, sizeMicros: string): bigint {
  return (BigInt(priceUnits) * BigInt(sizeMicros)) / PRICE_SCALE;
}

function ratio(value: bigint, ppm: number): bigint {
  return (value * BigInt(ppm)) / 1_000_000n;
}

function normalizedEvmAddress(value: string, errorCode: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(normalized)) throw new Error(errorCode);
  return normalized;
}

function emptyMatch(): ExecutionMatchResult {
  return {
    levels: [],
    filledSizeMicros: "0",
    filledNotionalMicros: "0",
    feeMicros: "0",
    vwapPriceUnits: null,
    complete: false,
  };
}

export class LiveExecutor implements ExecutorInterface {
  readonly mode = "LIVE" as const;
  private readonly database: DatabaseSync;
  private readonly store: LiveStore;
  private readonly reconciliation: LiveReconciliation;
  private readonly recovery: LiveCrashRecovery;
  private readonly now: () => Date;
  private readonly sourceVersion: SourceVersion;
  private readonly orderAdapter: OrderAdapter;
  private readonly walletProvider: WalletProvider;
  private readonly signer: Signer;
  private readonly redeemAdapter: RedeemAdapter;
  private readonly marketDataProvider: LiveMarketDataProvider;
  private readonly environment: "PRODUCTION" | "TEST";
  private readonly externalCallTimeoutMs: number;
  private readonly accountQueues = new Map<string, Promise<void>>();
  private readonly emergencyHaltedAccounts = new Set<string>();
  private readonly startupRecoveredAccounts = new Set<string>();

  constructor(private readonly options: LiveExecutorOptions) {
    this.now = options.now ?? (() => new Date());
    this.sourceVersion = options.sourceVersion ?? resolveSourceVersion();
    this.orderAdapter = options.orderAdapter ?? new DisabledOrderAdapter();
    this.walletProvider = options.walletProvider ?? new DisabledWalletProvider();
    this.signer = options.signer ?? new DisabledSigner();
    this.redeemAdapter = options.redeemAdapter ?? new DisabledRedeemAdapter();
    this.marketDataProvider = options.marketDataProvider ?? new DisabledLiveMarketDataProvider();
    this.externalCallTimeoutMs = options.externalCallTimeoutMs ?? RULESET.requestTimeoutMs;
    if (!Number.isSafeInteger(this.externalCallTimeoutMs) || this.externalCallTimeoutMs <= 0) {
      throw new Error("LIVE_EXTERNAL_TIMEOUT_CONFIG_INVALID");
    }
    const environment = options.environment ?? "PRODUCTION";
    this.environment = environment;
    if (
      environment !== "TEST"
      && (this.orderAdapter.adapterType === "FAKE"
        || this.walletProvider.providerType === "FAKE"
        || this.signer.signerType === "FAKE"
        || this.redeemAdapter.adapterType === "FAKE"
        || this.marketDataProvider.providerType === "FAKE")
    ) {
      throw new Error("FAKE_LIVE_COMPONENT_FORBIDDEN_IN_PRODUCTION");
    }
    if (
      environment === "TEST"
      && (this.orderAdapter.adapterType === "POLYMARKET_CLOB"
        || this.walletProvider.providerType === "LIVE_READONLY"
        || this.signer.signerType === "LIVE"
        || this.redeemAdapter.adapterType === "LIVE")
    ) {
      throw new Error("REAL_LIVE_COMPONENT_FORBIDDEN_IN_TEST");
    }
    if (options.liveGate.runtimeEnvironment !== environment) {
      throw new Error("LIVE_GATE_RUNTIME_ENVIRONMENT_MISMATCH");
    }
    if (environment === "PRODUCTION" && options.liveGate.gateType !== "PRODUCTION") {
      throw new Error("PRODUCTION_LIVE_GATE_REQUIRED");
    }
    if (environment === "PRODUCTION" && options.requireExternalPositionReconciliation === false) {
      throw new Error("EXTERNAL_POSITION_RECONCILIATION_REQUIRED_IN_PRODUCTION");
    }
    this.database = new DatabaseSync(options.databasePath);
    this.database.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;");
    this.store = new LiveStore(this.database, this.sourceVersion, this.now);
    this.reconciliation = new LiveReconciliation(this.database, this.store);
    this.recovery = new LiveCrashRecovery(
      this.orderAdapter,
      this.reconciliation,
      this.store,
      this.walletProvider,
      options.requireExternalPositionReconciliation ?? this.environment === "PRODUCTION",
      this.externalCallTimeoutMs,
    );
  }

  async executeBuy(input: ExecutorSignalInput): Promise<ExecutorExecutionResult> {
    return this.serializeAccount(input.accountId, () => this.executeSignal(input, "BUY"));
  }

  async executeSell(input: ExecutorSignalInput): Promise<ExecutorExecutionResult> {
    return this.serializeAccount(input.accountId, () => this.executeSignal(input, "SELL"));
  }

  /**
   * Persists a Risk Manager rejection without entering the Live Gate or any
   * external adapter. This path deliberately accepts a missing Execution
   * Context so a malformed but published Signal cannot block the consumer
   * queue forever; it still requires a scoped, persisted REJECT decision.
   */
  async recordRiskRejectedSignal(input: {
    accountId: string;
    signal: PaperSignalEnvelope;
    riskDecisionId: string;
  }): Promise<ExecutorExecutionResult> {
    if (input.signal.signalType === "TARGET_CONVERSION") {
      throw new Error("NEGATIVE_RISK_CONVERSION_EXECUTION_UNAVAILABLE");
    }
    const executionType = input.signal.signalType;
    return this.serializeAccount(input.accountId, async () => {
      const risk = this.database.prepare(
        `SELECT risk_decision_id,account_id,signal_id,context_id,decision,risk_reason,
                requested_amount_micros,requested_size_micros,ruleset_hash
         FROM risk_decisions WHERE risk_decision_id=?`,
      ).get(input.riskDecisionId) as {
        risk_decision_id: string;
        account_id: string | null;
        signal_id: string | null;
        context_id: string | null;
        decision: string;
        risk_reason: string | null;
        requested_amount_micros: string | null;
        requested_size_micros: string | null;
        ruleset_hash: string;
      } | undefined;
      if (!risk) throw new Error("RISK_DECISION_NOT_FOUND");
      if (risk.decision !== "REJECT") throw new Error("RISK_DECISION_NOT_REJECT");
      if (risk.account_id !== input.accountId) throw new Error("RISK_ACCOUNT_MISMATCH");
      if (risk.signal_id !== input.signal.signalId) throw new Error("RISK_SIGNAL_MISMATCH");
      if (risk.context_id !== (input.signal.context?.contextId ?? null)) {
        throw new Error("RISK_CONTEXT_MISMATCH");
      }
      const registered = this.database.prepare(
        "SELECT 1 ok FROM ruleset_registry WHERE ruleset_hash=?",
      ).get(risk.ruleset_hash);
      if (!registered) throw new Error(`RISK_RULESET_NOT_REGISTERED:${risk.ruleset_hash}`);
      const executionIdempotencyKey = liveExecutionIdempotencyKey(input.accountId, input.signal.signalId);
      const execution = this.store.transaction(() => this.store.createExecution({
        liveAccountId: input.accountId,
        signalId: input.signal.signalId,
        contextId: risk.context_id,
        riskDecisionId: input.riskDecisionId,
        liveGateRunId: null,
        executionIdempotencyKey,
        executionType,
        state: "REJECTED",
        assetId: input.signal.assetId,
        conditionId: input.signal.conditionId,
        requestedAmountMicros: risk.requested_amount_micros,
        requestedSizeMicros: risk.requested_size_micros,
        targetPriceUnits: input.signal.targetPriceUnits,
        reason: risk.risk_reason ?? "RISK_REJECT",
        rulesetHash: risk.ruleset_hash,
      }));
      return { mode: "LIVE", executionId: execution.live_execution_id, state: execution.state };
    });
  }

  async cancelExecution(executionId: string, reason: string): Promise<void> {
    const execution = this.store.executionById(executionId);
    if (!execution) throw new Error("LIVE_EXECUTION_NOT_FOUND");
    return this.serializeAccount(execution.live_account_id, () => this.cancelExecutionUnlocked(executionId, reason));
  }

  private async cancelExecutionUnlocked(executionId: string, reason: string): Promise<void> {
    const execution = this.store.executionById(executionId);
    if (!execution) throw new Error("LIVE_EXECUTION_NOT_FOUND");
    const order = this.database.prepare(
      `SELECT o.live_order_id,o.external_order_id,o.status,e.filled_size_micros,e.live_account_id
       FROM live_orders o JOIN live_executions e ON e.live_execution_id=o.live_execution_id
       WHERE o.live_execution_id=? ORDER BY o.created_at DESC LIMIT 1`,
    ).get(executionId) as {
      live_order_id: string;
      external_order_id: string | null;
      status: string;
      filled_size_micros: string;
      live_account_id: string;
    } | undefined;
    if (!order?.external_order_id) {
      this.store.transaction(() => this.store.cancelPendingExecution(execution, reason));
      return;
    }
    if (order.status === "CANCEL_PENDING") {
      throw new Error(`LIVE_ORDER_CANCEL_ALREADY_PENDING:${order.live_order_id}`);
    }
    if (!["CREATED", "SUBMITTED", "ACKNOWLEDGED", "PARTIALLY_FILLED"].includes(order.status)) {
      throw new Error(`LIVE_ORDER_NOT_CANCELABLE_STATE:${order.status}`);
    }
    const idempotencyKey = cancelIdempotencyKey(order.external_order_id, reason);
    const now = this.now().toISOString();
    const claimed = this.store.transaction(() => {
      const updated = this.database.prepare(
        `UPDATE live_orders
         SET status='CANCEL_PENDING',is_terminal=0,confirmation_pending=0,updated_at=?
         WHERE live_order_id=? AND status=?`,
      ).run(now, order.live_order_id, order.status);
      if (Number(updated.changes) !== 1) return false;
      this.store.transition("LIVE_ORDER", order.live_order_id, order.status, "CANCEL_PENDING", reason, RULESET_HASH, now);
      return true;
    });
    if (!claimed) throw new Error(`LIVE_ORDER_CANCEL_CLAIM_CONFLICT:${order.live_order_id}`);
    try {
      const result = await withExternalTimeout(
        "CANCEL_ORDER",
        this.externalCallTimeoutMs,
        () => this.orderAdapter.cancelOrder(order.external_order_id!, idempotencyKey),
      );
      this.store.audit("LIVE_ORDER", order.live_order_id, "cancel_response", reason, {
        externalOrderId: order.external_order_id,
        result,
      });
      const reconciliation = await this.recovery.reconcile(order.live_account_id);
      if (!reconciliation.passed) {
        throw new Error(`LIVE_ORDER_CANCEL_RECONCILIATION_FAILED:${order.external_order_id}:${reconciliation.reason}`);
      }
      const synchronized = this.database.prepare("SELECT status FROM live_orders WHERE live_order_id=?")
        .get(order.live_order_id) as { status: string } | undefined;
      const terminal = result.terminal === true
        || ["FILLED", "CANCELLED", "EXPIRED", "FAILED"].includes(synchronized?.status ?? "");
      if (!terminal) throw new Error(`LIVE_ORDER_CANCEL_UNCONFIRMED:${order.external_order_id}`);
      this.store.transaction(() => this.store.cancelPendingExecution(execution, reason));
      this.store.audit("LIVE_ORDER", order.live_order_id, "cancel_reconciled", reason, {
        externalOrderId: order.external_order_id,
        cancelled: result.cancelled,
        synchronizedStatus: synchronized?.status ?? null,
      });
    } catch (error) {
      const errorReason = error instanceof Error ? error.message : "LIVE_ORDER_CANCEL_FAILED";
      this.store.transaction(() => {
        this.store.freezeExecution(executionId, `CANCEL_OUTCOME_UNKNOWN:${errorReason}`);
        this.store.freezeOpenPositions(order.live_account_id, `CANCEL_OUTCOME_UNKNOWN:${errorReason}`);
        this.store.forceGateDisabled(`CANCEL_OUTCOME_UNKNOWN:${errorReason}`, "SYSTEM");
        this.store.audit("LIVE_ORDER", order.live_order_id, "cancel_failed", errorReason, {
          externalOrderId: order.external_order_id,
        });
      });
      throw error;
    }
  }

  async getPosition(query: ExecutorPositionQuery): Promise<unknown> {
    if (query.positionId) {
      return this.database.prepare("SELECT * FROM live_positions WHERE live_position_id=?").get(query.positionId) ?? null;
    }
    if (query.assetId) {
      return this.database.prepare(
        `SELECT * FROM live_positions
         WHERE live_account_id=? AND asset_id=? AND status NOT IN ('CLOSED','REDEEMED')
         ORDER BY created_at,live_position_id`,
      ).all(query.accountId, query.assetId);
    }
    return this.database.prepare("SELECT * FROM live_positions WHERE live_account_id=? ORDER BY created_at")
      .all(query.accountId);
  }

  async getBalance(query: ExecutorBalanceQuery): Promise<PaperAccountSnapshot> {
    let balance: Awaited<ReturnType<WalletProvider["getBalance"]>>;
    try {
      balance = await withExternalTimeout(
        "WALLET_BALANCE",
        this.externalCallTimeoutMs,
        () => this.walletProvider.getBalance(),
      );
    } catch (error) {
      balance = {
        status: "UNAVAILABLE",
        balanceMicros: null,
        reason: error instanceof Error ? error.message : "WALLET_BALANCE_FAILED",
      };
    }
    if (
      balance.status === "AVAILABLE"
      && (balance.balanceMicros === null || !/^\d+$/.test(balance.balanceMicros))
    ) {
      balance = { status: "UNAVAILABLE", balanceMicros: null, reason: "WALLET_BALANCE_INVALID" };
    }
    const cash = BigInt(balance.balanceMicros ?? "0");
    const ledger = this.store.accountLedgerSnapshot(query.accountId);
    const available = cash > ledger.reservedMicros ? cash - ledger.reservedMicros : 0n;
    const positions = this.database.prepare(
      `SELECT live_position_id,asset_id,condition_id,current_size_micros,remaining_cost_micros,status
       FROM live_positions
       WHERE live_account_id=? AND status NOT IN ('CLOSED','REDEEMED')
         AND current_size_micros!='0'
       ORDER BY created_at,live_position_id`,
    ).all(query.accountId) as unknown as Array<{
      live_position_id: string;
      asset_id: string;
      condition_id: string;
      current_size_micros: string;
      remaining_cost_micros: string;
      status: string;
    }>;
    let positionValue = 0n;
    let unrealizedPnl = 0n;
    let unpricedPositionCount = 0;
    const evidence: Array<Record<string, unknown>> = [{
      evidenceType: "WALLET_BALANCE",
      status: balance.status,
      balanceMicros: balance.balanceMicros,
      reason: balance.reason,
      providerType: this.walletProvider.providerType,
    }];
    for (const position of positions) {
      try {
        if (this.marketDataProvider.providerType === "DISABLED") throw new Error("LIVE_MARKET_DATA_DISABLED");
        const fee = await withExternalTimeout(
          "VALUATION_FEE",
          this.externalCallTimeoutMs,
          () => this.marketDataProvider.fee(position.asset_id, position.condition_id),
        );
        const book = await withExternalTimeout(
          "VALUATION_ORDERBOOK",
          this.externalCallTimeoutMs,
          () => this.marketDataProvider.orderbook(position.asset_id, position.condition_id),
        );
        const ageMs = executableOrderbookAgeMs(book, this.now().valueOf());
        if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > RULESET.orderbookMaxAgeMs) {
          throw new Error("ORDERBOOK_STALE");
        }
        if (fee.status !== "AVAILABLE" || fee.feeRatePpm === null || fee.exponent === null) {
          throw new Error("FEE_MODEL_UNAVAILABLE");
        }
        const match = matchExecutionSell({
          bids: book.bids,
          requestedSizeMicros: BigInt(position.current_size_micros),
          minimumPriceUnits: 0n,
          feeRatePpm: BigInt(fee.feeRatePpm),
          feeExponent: fee.exponent,
        });
        if (!match.complete) throw new Error("INSUFFICIENT_FULL_EXIT_DEPTH");
        const exitValue = BigInt(match.filledNotionalMicros) - BigInt(match.feeMicros);
        positionValue += exitValue;
        unrealizedPnl += exitValue - BigInt(position.remaining_cost_micros);
        evidence.push({
          positionId: position.live_position_id,
          status: position.status,
          marketSnapshotTime: book.marketSnapshotTime,
          dataAgeMs: ageMs,
          exitVwapPriceUnits: match.vwapPriceUnits,
          grossExitValueMicros: match.filledNotionalMicros,
          exitFeeMicros: match.feeMicros,
          netExitValueMicros: exitValue.toString(),
          costBasisMicros: position.remaining_cost_micros,
        });
      } catch (error) {
        unpricedPositionCount += 1;
        evidence.push({
          positionId: position.live_position_id,
          status: position.status,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const complete = balance.status === "AVAILABLE" && unpricedPositionCount === 0;
    const priceTimestamp = this.now().toISOString();
    const snapshot: PaperAccountSnapshot = {
      paperAccountId: query.accountId,
      initialBalanceMicros: ledger.initialBankrollMicros.toString(),
      cashBalanceMicros: cash.toString(),
      reservedBalanceMicros: ledger.reservedMicros.toString(),
      availableBalanceMicros: available.toString(),
      positionValueMicros: positionValue.toString(),
      realizedPnlMicros: ledger.realizedPnlMicros.toString(),
      unrealizedPnlMicros: unrealizedPnl.toString(),
      totalEquityMicros: (cash + positionValue).toString(),
      valuationStatus: complete ? "COMPLETE" : "INCOMPLETE",
      unpricedPositionCount,
      priceSource: "ORDERBOOK_EXIT_VWAP",
      priceTimestamp,
    };
    this.store.transaction(() => this.store.saveValuationSnapshot({
      accountId: query.accountId,
      cashBalanceMicros: snapshot.cashBalanceMicros,
      reservedBalanceMicros: snapshot.reservedBalanceMicros,
      availableBalanceMicros: snapshot.availableBalanceMicros,
      positionValueMicros: snapshot.positionValueMicros,
      realizedPnlMicros: snapshot.realizedPnlMicros,
      unrealizedPnlMicros: snapshot.unrealizedPnlMicros,
      totalEquityMicros: snapshot.totalEquityMicros,
      valuationStatus: snapshot.valuationStatus,
      unpricedPositionCount,
      priceTimestamp,
      positionEvidence: evidence,
    }));
    return snapshot;
  }

  async reconcile(input: ExecutorReconcileInput): Promise<ExecutorReconcileResult> {
    return this.serializeAccount(input.accountId, async () => {
      const result = await this.recovery.reconcile(input.accountId);
      if (result.passed) this.store.transaction(() => this.store.unfreezeReconciledPositions(input.accountId));
      const frozenPositionCount = result.passed ? 0 : this.store.transaction(() => {
        const frozen = this.store.freezeOpenPositions(input.accountId, `RECONCILIATION:${input.reason}`);
        this.store.forceGateDisabled(`LIVE_RECONCILIATION_FAILED:${result.reason}`, "SYSTEM");
        return frozen;
      });
      this.store.updateCheckpoint(input.accountId, { reconciliationRunId: result.runId });
      return { mode: "LIVE", frozenPositionCount, reason: result.passed ? "LIVE_RECONCILED" : "LIVE_RECONCILIATION_FAILED" };
    });
  }

  async recoverOnStartup(accountId: string): Promise<{ passed: boolean; reason: string; recoveryRunId: string }> {
    return this.serializeAccount(accountId, async () => {
      if (this.store.isGateActive()) {
        this.store.forceGateDisabled("RECOVERY_REQUIRES_REARMING", "SYSTEM");
      }
      const result = await this.recovery.recover(accountId);
      if (result.passed) this.startupRecoveredAccounts.add(accountId);
      else this.startupRecoveredAccounts.delete(accountId);
      return result;
    });
  }

  isGateActive(): boolean {
    return this.store.isGateActive();
  }

  async checkStopLosses(accountId: string): Promise<LiveStopLossCheckResult> {
    return this.serializeAccount(accountId, async () => {
      const positions = this.database.prepare(
        `SELECT live_position_id,signal_id,asset_id,condition_id,entry_price_units,current_size_micros,ruleset_hash
         FROM live_positions
         WHERE live_account_id=? AND status IN ('OPEN','PARTIALLY_CLOSED')
           AND CAST(current_size_micros AS TEXT)!='0'
         ORDER BY created_at,live_position_id`,
      ).all(accountId) as unknown as Array<{
        live_position_id: string;
        signal_id: string | null;
        asset_id: string;
        condition_id: string;
        entry_price_units: string;
        current_size_micros: string;
        ruleset_hash: string;
      }>;
      const triggered: string[] = [];
      const blockers: LiveStopLossBlocker[] = [];
      const finish = (): LiveStopLossCheckResult => {
        if (blockers.length > 0) {
          this.store.audit(
            "LIVE_ACCOUNT",
            accountId,
            "stop_loss_health_blocked_new_signals",
            "STOP_LOSS_HEALTH_UNSAFE",
            { blockers },
          );
        }
        return {
          executionIds: triggered,
          healthy: blockers.length === 0,
          blockers,
        };
      };
      if (positions.length > 0 && this.marketDataProvider.providerType === "DISABLED") {
        blockers.push(...positions.map((position) => ({
          positionId: position.live_position_id,
          reason: "LIVE_MARKET_DATA_DISABLED",
        })));
        return finish();
      }
      for (const position of positions) {
        if (!position.signal_id) {
          blockers.push({ positionId: position.live_position_id, reason: "STOP_LOSS_SIGNAL_CONTEXT_MISSING" });
          this.store.audit(
            "LIVE_POSITION",
            position.live_position_id,
            "stop_loss_context_missing",
            "STOP_LOSS_SIGNAL_CONTEXT_MISSING",
            {},
            position.ruleset_hash,
          );
          continue;
        }
        if (BigInt(position.current_size_micros) <= 0n) {
          blockers.push({ positionId: position.live_position_id, reason: "STOP_LOSS_POSITION_SIZE_INVALID" });
          this.store.audit(
            "LIVE_POSITION",
            position.live_position_id,
            "stop_loss_position_invalid",
            "STOP_LOSS_POSITION_SIZE_INVALID",
            { currentSizeMicros: position.current_size_micros },
            position.ruleset_hash,
          );
          continue;
        }
        const stopLossRules = registeredStopLossRules(this.database, position.ruleset_hash);
        if (!stopLossRules) {
          blockers.push({ positionId: position.live_position_id, reason: "HISTORICAL_RULESET_UNAVAILABLE" });
          this.store.transaction(() => {
            this.store.audit("LIVE_POSITION", position.live_position_id, "stop_loss_rules_unavailable", "HISTORICAL_RULESET_UNAVAILABLE", {
              rulesetHash: position.ruleset_hash,
            });
            this.store.freezeOpenPositions(accountId, "HISTORICAL_RULESET_UNAVAILABLE");
            this.store.forceGateDisabled("HISTORICAL_RULESET_UNAVAILABLE", "SYSTEM");
          });
          break;
        }
        let book: ExecutionOrderbookSnapshot;
        try {
          book = await withExternalTimeout(
            "STOP_LOSS_ORDERBOOK",
            this.externalCallTimeoutMs,
            () => this.marketDataProvider.orderbook(position.asset_id, position.condition_id),
          );
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          blockers.push({ positionId: position.live_position_id, reason: `STOP_LOSS_MARKET_DATA_FAILED:${reason}` });
          this.store.audit(
            "LIVE_POSITION",
            position.live_position_id,
            "stop_loss_market_data_failed",
            reason,
            {},
            position.ruleset_hash,
            stopLossRules.configVersion,
          );
          continue;
        }
        const ageMs = executableOrderbookAgeMs(book, this.now().valueOf());
        if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > RULESET.orderbookMaxAgeMs) {
          blockers.push({ positionId: position.live_position_id, reason: "ORDERBOOK_STALE" });
          this.store.audit("LIVE_POSITION", position.live_position_id, "stop_loss_orderbook_stale", "ORDERBOOK_STALE", {
            marketSnapshotTime: book.marketSnapshotTime,
            dataAgeMs: ageMs,
          }, position.ruleset_hash, stopLossRules.configVersion);
          continue;
        }
        const currentSize = BigInt(position.current_size_micros);
        const vwap = executableSellVwap(book.bids, currentSize);
        const triggerPrice = ratio(BigInt(position.entry_price_units), stopLossRules.triggerRatioPpm);
        this.store.audit("LIVE_POSITION", position.live_position_id, "stop_loss_checked", vwap === null ? "INSUFFICIENT_FULL_DEPTH" : "VWAP_CHECKED", {
          currentSizeMicros: currentSize.toString(),
          executableVwapPriceUnits: vwap?.toString() ?? null,
          triggerPriceUnits: triggerPrice.toString(),
          stopLossRatioPpm: stopLossRules.triggerRatioPpm,
          maxSlippagePpm: stopLossRules.maxSlippagePpm,
          rulesetHash: position.ruleset_hash,
          marketSnapshotTime: book.marketSnapshotTime,
        }, position.ruleset_hash, stopLossRules.configVersion);
        if (vwap === null) {
          blockers.push({ positionId: position.live_position_id, reason: "INSUFFICIENT_FULL_DEPTH" });
          continue;
        }
        if (vwap > triggerPrice) continue;

        let base: ReturnType<LiveExecutor["loadSignalForSystemExecution"]>;
        try {
          base = this.loadSignalForSystemExecution(position.signal_id);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          blockers.push({ positionId: position.live_position_id, reason: `STOP_LOSS_CONTEXT_LOAD_FAILED:${reason}` });
          this.store.audit(
            "LIVE_POSITION",
            position.live_position_id,
            "stop_loss_context_load_failed",
            reason,
            {},
            position.ruleset_hash,
            stopLossRules.configVersion,
          );
          continue;
        }
        if (base.context.rulesetHash !== position.ruleset_hash) {
          blockers.push({ positionId: position.live_position_id, reason: "POSITION_CONTEXT_RULESET_MISMATCH" });
          this.store.transaction(() => {
            this.store.audit("LIVE_POSITION", position.live_position_id, "stop_loss_context_mismatch", "POSITION_CONTEXT_RULESET_MISMATCH", {
              positionRulesetHash: position.ruleset_hash,
              contextRulesetHash: base.context.rulesetHash,
            }, position.ruleset_hash, stopLossRules.configVersion);
            this.store.freezeOpenPositions(accountId, "POSITION_CONTEXT_RULESET_MISMATCH");
            this.store.forceGateDisabled("POSITION_CONTEXT_RULESET_MISMATCH", "SYSTEM");
          });
          break;
        }
        await this.supersedePendingTargetExits(accountId, position.asset_id);
        const refreshed = this.store.openPositions(accountId, position.asset_id)
          .find((candidate) => candidate.live_position_id === position.live_position_id);
        if (!refreshed || refreshed.status === "FROZEN" || BigInt(refreshed.current_size_micros) <= 0n) continue;
        const size = BigInt(refreshed.current_size_micros);
        const syntheticSignal: PaperSignalEnvelope = {
          ...base.signal,
          signalType: "TARGET_SELL",
          targetPriceUnits: triggerPrice.toString(),
          targetSizeMicros: size.toString(),
          sellRatioNumerator: "1",
          sellRatioDenominator: "1",
          context: base.context,
          capitalDecision: null,
        };
        const risk = new RiskManager(this.database, this.sourceVersion).recordSystemDecision({
          mode: "LIVE",
          accountId,
          signalId: position.signal_id,
          contextId: base.context.contextId,
          entityId: position.live_position_id,
          executionType: "STOP_LOSS",
          decision: "ALLOW",
          reason: "STOP_LOSS_TRIGGERED",
          requestedAmountMicros: null,
          requestedSizeMicros: size,
          rulesetHash: position.ruleset_hash,
          now: this.now().toISOString(),
        });
        const result = await this.executeSignal({
          accountId,
          signal: syntheticSignal,
          context: base.context,
          riskDecisionId: risk.riskDecisionId,
        }, "SELL", {
          executionType: "STOP_LOSS",
          idempotencySubject: `STOP_LOSS:${position.live_position_id}`,
          positionId: position.live_position_id,
        });
        this.store.transaction(() => this.store.linkExecutionPosition(
          result.executionId,
          position.live_position_id,
          size.toString(),
        ));
        triggered.push(result.executionId);
        if (!["EXECUTED", "PARTIALLY_EXECUTED", "STOP_EXIT_PENDING"].includes(result.state)) {
          blockers.push({
            positionId: position.live_position_id,
            reason: `STOP_LOSS_EXECUTION_UNSAFE_STATE:${result.state}`,
          });
        }
      }
      return finish();
    });
  }

  async retryPending(accountId: string, scope: LivePendingRetryScope = "ALL"): Promise<string[]> {
    return this.serializeAccount(accountId, async () => {
      const rows = this.database.prepare(
        `SELECT live_execution_id,signal_id,risk_decision_id,execution_type,state,
                target_price_units,requested_size_micros
         FROM live_executions
         WHERE live_account_id=?
           AND state IN ('WAITING_EXECUTION','EXIT_PENDING','STOP_EXIT_PENDING')
           AND execution_type IN ('TARGET_BUY','TARGET_SELL','STOP_LOSS')
           AND (
             ?='ALL'
             OR (?='EXITS_ONLY' AND execution_type IN ('TARGET_SELL','STOP_LOSS'))
             OR (?='BUYS_ONLY' AND execution_type='TARGET_BUY')
           )
         ORDER BY CASE execution_type WHEN 'STOP_LOSS' THEN 0 WHEN 'TARGET_SELL' THEN 1 ELSE 2 END,
                  created_at,live_execution_id`,
      ).all(accountId, scope, scope, scope) as unknown as Array<{
        live_execution_id: string;
        signal_id: string | null;
        risk_decision_id: string;
        execution_type: "TARGET_BUY" | "TARGET_SELL" | "STOP_LOSS";
        state: string;
        target_price_units: string | null;
        requested_size_micros: string | null;
      }>;
      const processed: string[] = [];
      for (const row of rows) {
        if (!row.signal_id) continue;
        const base = this.loadSignalForSystemExecution(row.signal_id);
        if (row.execution_type === "STOP_LOSS") {
          const link = this.database.prepare(
            `SELECT live_position_id FROM live_execution_positions
             WHERE live_execution_id=? ORDER BY live_position_id LIMIT 1`,
          ).get(row.live_execution_id) as { live_position_id: string } | undefined;
          if (!link || row.target_price_units === null || row.requested_size_micros === null) {
            this.store.transaction(() => {
              const execution = this.store.executionById(row.live_execution_id)!;
              this.store.failPendingExecution(execution, "STOP_LOSS_RECOVERY_CONTEXT_MISSING");
              this.store.forceGateDisabled("STOP_LOSS_RECOVERY_CONTEXT_MISSING", "SYSTEM");
            });
            processed.push(row.live_execution_id);
            continue;
          }
          const signal: PaperSignalEnvelope = {
            ...base.signal,
            signalType: "TARGET_SELL",
            targetPriceUnits: row.target_price_units,
            targetSizeMicros: row.requested_size_micros,
            sellRatioNumerator: "1",
            sellRatioDenominator: "1",
            capitalDecision: null,
          };
          await this.executeSignal({
            accountId,
            signal,
            context: base.context,
            riskDecisionId: row.risk_decision_id,
          }, "SELL", {
            executionType: "STOP_LOSS",
            idempotencySubject: `STOP_LOSS:${link.live_position_id}`,
            positionId: link.live_position_id,
          });
        } else {
          await this.executeSignal({
            accountId,
            signal: base.signal,
            context: base.context,
            riskDecisionId: row.risk_decision_id,
          }, row.execution_type === "TARGET_BUY" ? "BUY" : "SELL");
        }
        processed.push(row.live_execution_id);
      }
      return processed;
    });
  }

  async processSettlements(accountId: string): Promise<LiveSettlementProcessingResult> {
    return this.serializeAccount(accountId, async () => {
      const result: LiveSettlementProcessingResult = {
        pendingPositionIds: [],
        resolvedPositionIds: [],
        failures: [],
      };
      if (this.marketDataProvider.providerType === "DISABLED") return result;
      const rows = this.database.prepare(
        `SELECT p.live_position_id,p.asset_id,p.condition_id,c.market_end_time
         FROM live_positions p
         LEFT JOIN signal_execution_contexts c ON c.signal_id=p.signal_id
         WHERE p.live_account_id=?
           AND p.status IN ('OPEN','PARTIALLY_CLOSED','SETTLEMENT_PENDING')
           AND p.current_size_micros!='0'
         ORDER BY p.created_at,p.live_position_id`,
      ).all(accountId) as unknown as Array<{
        live_position_id: string;
        asset_id: string;
        condition_id: string;
        market_end_time: string | null;
      }>;
      for (const row of rows) {
        const marketEnd = row.market_end_time === null ? Number.NaN : Date.parse(row.market_end_time);
        if (!Number.isFinite(marketEnd)) {
          result.failures.push({ positionId: row.live_position_id, reason: "LIVE_SETTLEMENT_MARKET_END_UNKNOWN" });
          this.store.audit("LIVE_SETTLEMENT", row.live_position_id, "processing_failed", "LIVE_SETTLEMENT_MARKET_END_UNKNOWN", {});
          continue;
        }
        if (this.now().valueOf() < marketEnd) continue;
        try {
          const resolution = await withExternalTimeout(
            "SETTLEMENT_RESOLUTION",
            this.externalCallTimeoutMs,
            () => this.marketDataProvider.resolution(row.condition_id, row.asset_id),
          );
          if (resolution.conditionId.toLowerCase() !== row.condition_id.toLowerCase() || resolution.assetId !== row.asset_id) {
            throw new Error("LIVE_SETTLEMENT_IDENTITY_MISMATCH");
          }
          const snapshotTime = Date.parse(resolution.snapshotTime);
          if (!Number.isFinite(snapshotTime) || snapshotTime < marketEnd || snapshotTime > this.now().valueOf()) {
            throw new Error("LIVE_SETTLEMENT_SNAPSHOT_TIME_INVALID");
          }
          if (!resolution.resolved) {
            this.store.transaction(() => this.store.markSettlementPending({
              positionId: row.live_position_id,
              checkedAt: resolution.snapshotTime,
              resolutionSnapshot: {
                sourceUrl: resolution.sourceUrl,
                raw: resolution.raw,
              },
            }));
            result.pendingPositionIds.push(row.live_position_id);
            continue;
          }
          if (resolution.payoutNumerator === null || resolution.payoutDenominator === null) {
            throw new Error("LIVE_SETTLEMENT_PAYOUT_MISSING");
          }
          this.confirmSettlement({
            positionId: row.live_position_id,
            resolved: true,
            payoutNumerator: resolution.payoutNumerator,
            payoutDenominator: resolution.payoutDenominator,
            confirmedAt: resolution.snapshotTime,
            resolutionSnapshot: {
              sourceUrl: resolution.sourceUrl,
              raw: resolution.raw,
            },
          });
          result.resolvedPositionIds.push(row.live_position_id);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          result.failures.push({ positionId: row.live_position_id, reason });
          this.store.audit("LIVE_SETTLEMENT", row.live_position_id, "processing_failed", reason, {});
        }
      }
      return result;
    });
  }

  async emergencyStop(accountId: string, reason: string): Promise<void> {
    const emergencyReason = `EMERGENCY_STOP:${reason}`;
    // Set the in-memory halt before waiting for the account queue. An execution
    // that is currently signing will observe it before creating/submitting an
    // order intent, while the durable Gate transition blocks other processes.
    this.emergencyHaltedAccounts.add(accountId);
    this.startupRecoveredAccounts.delete(accountId);
    this.store.forceGateDisabled(emergencyReason, "SYSTEM");
    return this.serializeAccount(accountId, () => this.emergencyStopUnlocked(accountId, emergencyReason));
  }

  private async emergencyStopUnlocked(accountId: string, emergencyReason: string): Promise<void> {
    const submitting = this.store.submittingOrders(accountId);
    const submittingExecutionIds = new Set(submitting.map((order) => order.executionId));
    const openOrders = this.database.prepare(
      `SELECT live_execution_id FROM live_executions
       WHERE live_account_id=? AND state IN ('WAITING_EXECUTION','PARTIALLY_EXECUTED','EXIT_PENDING','STOP_EXIT_PENDING')`,
    ).all(accountId) as unknown as Array<{ live_execution_id: string }>;
    const failures: Array<{ executionId: string; reason: string }> = submitting.map((order) => ({
      executionId: order.executionId,
      reason: `SUBMITTING_OUTCOME_PENDING:${order.liveOrderId}`,
    }));
    for (const order of submitting) {
      this.store.freezeExecution(order.executionId, `${emergencyReason}:SUBMITTING_OUTCOME_PENDING`);
      this.store.audit("LIVE_ORDER", order.liveOrderId, "emergency_submit_pending", emergencyReason, {
        executionId: order.executionId,
      });
    }
    for (const order of openOrders) {
      if (submittingExecutionIds.has(order.live_execution_id)) continue;
      try {
        await this.cancelExecutionUnlocked(order.live_execution_id, emergencyReason);
      } catch (error) {
        const failure = error instanceof Error ? error.message : String(error);
        failures.push({ executionId: order.live_execution_id, reason: failure });
        this.store.freezeExecution(order.live_execution_id, `${emergencyReason}:${failure}`);
        this.store.audit("LIVE_EXECUTION", order.live_execution_id, "emergency_cancel_failed", emergencyReason, { error: failure });
      }
    }
    const frozenPositions = this.store.freezeOpenPositions(accountId, emergencyReason);
    this.store.audit("LIVE_ACCOUNT", accountId, "emergency_stop", emergencyReason, {
      cancellationCount: openOrders.length,
      frozenPositions,
      failures,
    });
    if (failures.length > 0) {
      throw new Error(`EMERGENCY_STOP_INCOMPLETE:${failures.map((failure) => failure.executionId).join(",")}`);
    }
  }

  confirmSettlement(input: LiveSettlementConfirmation): { redeemAmountMicros: string; pnlMicros: string } {
    try {
      return this.store.transaction(() => this.store.confirmSettlement(input));
    } catch (error) {
      if (error instanceof Error && error.message === "LIVE_SETTLEMENT_CONFLICT") {
        const row = this.database.prepare("SELECT live_account_id FROM live_positions WHERE live_position_id=?")
          .get(input.positionId) as { live_account_id: string } | undefined;
        if (row) this.store.freezeOpenPositions(row.live_account_id, error.message);
      }
      throw error;
    }
  }

  async redeemPosition(positionId: string, riskDecisionId: string): Promise<{ status: string }> {
    const settlement = this.store.settlementForRedeem(positionId);
    if (!settlement) throw new Error("LIVE_SETTLEMENT_NOT_CONFIRMED");
    return this.serializeAccount(
      settlement.live_account_id,
      () => this.redeemPositionUnlocked(positionId, riskDecisionId),
    );
  }

  private async redeemPositionUnlocked(positionId: string, riskDecisionId: string): Promise<{ status: string }> {
    const settlement = this.store.settlementForRedeem(positionId);
    if (!settlement) throw new Error("LIVE_SETTLEMENT_NOT_CONFIRMED");
    const idempotencyKey = redeemIdempotencyKey(positionId, settlement.condition_id, settlement.asset_id);
    const existingStatus = this.store.existingRedeemStatus(idempotencyKey);
    if (existingStatus === "CONFIRMED" && settlement.position_status === "REDEEMED") return { status: "CONFIRMED" };
    if (["CREATED", "SUBMITTED", "FAILED"].includes(existingStatus ?? "")) {
      throw new Error(`LIVE_REDEEM_STATUS_UNKNOWN:${existingStatus}`);
    }
    if (!["RESOLVED", "REDEEM_DISABLED"].includes(settlement.settlement_status)) {
      throw new Error(`LIVE_SETTLEMENT_NOT_REDEEMABLE:${settlement.settlement_status}`);
    }
    if (settlement.position_status !== "SETTLEMENT_PENDING") {
      throw new Error(`LIVE_POSITION_NOT_REDEEMABLE:${settlement.position_status}`);
    }
    if (!this.store.isGateActive()) throw new Error("LIVE_GATE_NOT_ACTIVE");
    const risk = this.approvedRedeemRisk(riskDecisionId, settlement);
    if (typeof risk === "string") throw new Error(risk);
    const actionGate = await this.options.liveGate.checkAccountAction({
      action: "REDEEM",
      accountId: settlement.live_account_id,
      riskDecisionId,
      rulesetHash: settlement.ruleset_hash,
      assetId: settlement.asset_id,
      conditionId: settlement.condition_id,
      requestedAmountMicros: settlement.redeem_amount_micros,
      requestedSizeMicros: settlement.current_size_micros,
    });
    if (!actionGate.allowed) {
      throw new Error(`LIVE_ACCOUNT_ACTION_GATE_BLOCKED:${actionGate.blockedReasons.join(",")}`);
    }
    const actionGateAttestationFailure = this.productionAccountActionGateRunFailure(
      actionGate.runId,
      riskDecisionId,
      settlement.ruleset_hash,
    );
    if (actionGateAttestationFailure) throw new Error(actionGateAttestationFailure);
    const reconciliation = await this.recovery.reconcile(settlement.live_account_id);
    if (!reconciliation.passed) {
      this.store.transaction(() => {
        this.store.freezeOpenPositions(settlement.live_account_id, "REDEEM_RECONCILIATION_FAILED");
        this.store.forceGateDisabled(`REDEEM_RECONCILIATION_FAILED:${reconciliation.reason}`, "SYSTEM");
      });
      throw new Error("REDEEM_RECONCILIATION_FAILED");
    }

    const executionIdempotencyKey = liveExecutionIdempotencyKey(
      settlement.live_account_id,
      `REDEEM:${positionId}`,
    );
    const execution = this.store.createExecution({
      liveAccountId: settlement.live_account_id,
      signalId: null,
      contextId: null,
      riskDecisionId,
      liveGateRunId: this.liveGateRunExists(actionGate.runId) ? actionGate.runId : null,
      executionIdempotencyKey,
      executionType: "REDEEM",
      state: "WAITING_EXECUTION",
      assetId: settlement.asset_id,
      conditionId: settlement.condition_id,
      requestedAmountMicros: settlement.redeem_amount_micros,
      requestedSizeMicros: settlement.current_size_micros,
      targetPriceUnits: null,
      reason: "REDEEM_APPROVED",
      rulesetHash: settlement.ruleset_hash,
    });
    if (existingStatus === null) {
      this.store.transaction(() => this.store.createRedeemIntent({
        positionId,
        executionId: execution.live_execution_id,
        idempotencyKey,
        adapterType: this.redeemAdapter.adapterType,
      }));
    }
    let result: Awaited<ReturnType<RedeemAdapter["redeem"]>>;
    try {
      result = await this.redeemAdapter.redeem({
        positionId,
        conditionId: settlement.condition_id,
        assetId: settlement.asset_id,
        idempotencyKey,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "LIVE_REDEEM_ADAPTER_FAILED";
      this.store.transaction(() => {
        this.store.freezeExecution(execution.live_execution_id, `REDEEM_STATUS_UNKNOWN:${reason}`);
        this.store.freezeOpenPositions(settlement.live_account_id, `REDEEM_STATUS_UNKNOWN:${reason}`);
        this.store.forceGateDisabled(`REDEEM_STATUS_UNKNOWN:${reason}`, "SYSTEM");
        this.store.audit("LIVE_REDEEM", positionId, "status_unknown", reason, {
          executionId: execution.live_execution_id,
          idempotencyKey,
        });
      });
      throw error;
    }
    this.store.transaction(() => {
      this.store.saveRedeemResult({
        positionId,
        executionId: execution.live_execution_id,
        idempotencyKey,
        status: result.status,
        adapterType: result.adapterType,
        raw: result.raw,
      });
      if (result.status === "CONFIRMED") {
        this.store.finalizeConfirmedRedeem(execution, settlement);
      } else {
        this.store.updateExecutionState(
          execution.live_execution_id,
          result.status === "SUBMITTED" ? "WAITING_EXECUTION" : result.status === "DISABLED" ? "REJECTED" : "FAILED",
          `REDEEM_${result.status}`,
          settlement.ruleset_hash,
        );
      }
      this.store.updateCheckpoint(settlement.live_account_id, { executionId: execution.live_execution_id });
    });
    return { status: result.status };
  }

  close(): void {
    this.database.close();
  }

  private async executeSignal(
    input: ExecutorSignalInput,
    side: LiveOrderSide,
    options: LiveSignalExecutionOptions = {},
  ): Promise<ExecutorExecutionResult> {
    if (this.emergencyHaltedAccounts.has(input.accountId)) {
      throw new Error("LIVE_ACCOUNT_EMERGENCY_HALTED");
    }
    if (input.signal.signalType !== (side === "BUY" ? "TARGET_BUY" : "TARGET_SELL")) {
      throw new Error(`LIVE_EXECUTOR_SIGNAL_SIDE_MISMATCH:${input.signal.signalType}:${side}`);
    }
    if (input.signal.status !== "PUBLISHED") {
      return this.rejectWithoutGate(input, side, "SIGNAL_NOT_PUBLISHED");
    }
    if (!input.signal.executionEligible) {
      return this.rejectWithoutGate(
        input,
        side,
        input.signal.executionBlockReason ?? "SIGNAL_NOT_EXECUTION_ELIGIBLE",
      );
    }
    if (!input.signal.context) {
      return this.rejectWithoutGate(input, side, "EXECUTION_CONTEXT_MISSING");
    }
    const executionType = options.executionType ?? (side === "BUY" ? "TARGET_BUY" : "TARGET_SELL");
    if (executionType !== "STOP_LOSS") {
      const integrityFailure = executionEnvelopeIntegrityError(this.database, input.signal, input.context);
      if (integrityFailure) return this.rejectWithoutGate(input, side, integrityFailure);
    }
    const rulesetHash = input.signal.context.rulesetHash;
    const executionIdempotencyKey = liveExecutionIdempotencyKey(
      input.accountId,
      options.idempotencySubject ?? input.signal.signalId,
    );
    const gateInput = {
      signalId: input.signal.signalId,
      riskDecisionId: input.riskDecisionId,
      rulesetHash,
      accountId: input.accountId,
      contextId: input.context.contextId,
      side,
      assetId: input.signal.assetId,
      conditionId: input.signal.conditionId,
      targetPriceUnits: input.signal.targetPriceUnits,
      targetSizeMicros: input.signal.targetSizeMicros,
      executionType,
      ...(options.positionId ? { positionId: options.positionId } : {}),
    };
    const gate = await this.options.liveGate.checkExecution(gateInput);
    const liveGateRunId = this.liveGateRunExists(gate.runId) ? gate.runId : null;
    if (!gate.allowed) {
      return this.reject(input, side, executionIdempotencyKey, liveGateRunId, `LIVE_GATE_BLOCKED:${gate.blockedReasons.join(",")}`, executionType);
    }
    const gateAttestationFailure = this.productionGateRunFailure(gate.runId, gateInput);
    if (gateAttestationFailure) {
      return this.reject(input, side, executionIdempotencyKey, null, gateAttestationFailure, executionType);
    }
    let approval = this.approvedRiskDecision(input, side, executionType);
    if (typeof approval === "string") {
      return this.reject(input, side, executionIdempotencyKey, liveGateRunId, approval, executionType);
    }
    const reconciliation = await this.recovery.reconcile(input.accountId);
    if (!reconciliation.passed) {
      this.store.transaction(() => {
        this.store.freezeOpenPositions(input.accountId, "LIVE_RECONCILIATION_FAILED");
        this.store.forceGateDisabled(`LIVE_RECONCILIATION_FAILED:${reconciliation.reason}`, "SYSTEM");
      });
      return this.reject(input, side, executionIdempotencyKey, liveGateRunId, "LIVE_RECONCILIATION_FAILED", executionType);
    }
    if (this.orderAdapter.adapterType === "DISABLED") {
      return this.reject(input, side, executionIdempotencyKey, liveGateRunId, "ORDER_ADAPTER_DISABLED", executionType);
    }
    if (this.signer.signerType === "DISABLED") {
      return this.reject(input, side, executionIdempotencyKey, liveGateRunId, "SIGNER_DISABLED", executionType);
    }
    if (this.marketDataProvider.providerType === "DISABLED") {
      return this.reject(input, side, executionIdempotencyKey, liveGateRunId, "LIVE_MARKET_DATA_DISABLED", executionType);
    }

    let execution = this.store.existingExecution(executionIdempotencyKey);
    if (execution && !["WAITING_EXECUTION", "EXIT_PENDING", "STOP_EXIT_PENDING"].includes(execution.state)) {
      return { mode: "LIVE", executionId: execution.live_execution_id, state: execution.state };
    }
    const executionRules = registeredExecutionRules(this.database, rulesetHash);
    if (!executionRules) {
      return this.reject(input, side, executionIdempotencyKey, liveGateRunId, "EXECUTION_RULESET_NOT_REGISTERED", executionType);
    }
    if (side === "BUY" && executionRules.smallFollowBuyPolicyEnabled) {
      const follow = evaluateBuyFollowPolicy({
        database: this.database,
        mode: "LIVE",
        accountId: input.accountId,
        signalId: input.signal.signalId,
        smallFollowBuyMaxCount: executionRules.smallFollowBuyMaxCount,
      });
      if (!follow.allowed) {
        if (execution) {
          this.store.transaction(() => this.store.rejectPendingExecution(execution!, follow.reason));
          return { mode: "LIVE", executionId: execution.live_execution_id, state: "REJECTED" };
        }
        return this.reject(input, side, executionIdempotencyKey, liveGateRunId, follow.reason, executionType);
      }
    }

    if (
      side === "SELL"
      && executionType === "TARGET_SELL"
      && executionRules.smallFollowBuyPolicyEnabled
    ) {
      try {
        if (approval.requested_size_micros === null) {
          const supersession = this.store.transaction(() => {
            const adjustedWaitingBuyCount = this.applyWaitingBuyTargetExitAdjustments(
              input.accountId,
              input.signal,
              fullExitThresholdForTargetSell(
                input.signal.eventClassification,
                executionRules.followSellFullExitThresholdPpm,
              ),
            );
            if (adjustedWaitingBuyCount === 0) return null;
            const created = this.store.createExecution({
              liveAccountId: input.accountId,
              signalId: input.signal.signalId,
              contextId: input.context.contextId,
              riskDecisionId: input.riskDecisionId,
              liveGateRunId,
              executionIdempotencyKey,
              executionType: "TARGET_SELL",
              state: "EXECUTED",
              assetId: input.signal.assetId,
              conditionId: input.signal.conditionId,
              requestedAmountMicros: null,
              requestedSizeMicros: null,
              targetPriceUnits: input.signal.targetPriceUnits,
              deadlineAt: null,
              reason: "TARGET_EXIT_APPLIED_TO_WAITING_BUY",
              rulesetHash,
            });
            this.store.updateCheckpoint(input.accountId, { executionId: created.live_execution_id });
            return created;
          });
          if (!supersession) {
            return this.reject(
              input,
              side,
              executionIdempotencyKey,
              liveGateRunId,
              "TARGET_EXIT_SUPERSESSION_NO_WAITING_BUY",
              executionType,
            );
          }
          return { mode: "LIVE", executionId: supersession.live_execution_id, state: supersession.state };
        }
        this.applyWaitingBuyTargetExitAdjustments(
          input.accountId,
          input.signal,
          fullExitThresholdForTargetSell(
            input.signal.eventClassification,
            executionRules.followSellFullExitThresholdPpm,
          ),
        );
      } catch (error) {
        const reason = error instanceof Error ? error.message : "LIVE_WAITING_BUY_TARGET_EXIT_ADJUSTMENT_FAILED";
        this.store.transaction(() => this.store.forceGateDisabled(
          `LIVE_WAITING_BUY_TARGET_EXIT_ADJUSTMENT_FAILED:${reason}`,
          "SYSTEM",
        ));
        throw error;
      }
    }

    const requestedSize = side === "BUY"
      ? null
      : BigInt(approval.requested_size_micros!) - BigInt(execution?.filled_size_micros ?? "0");
    if (requestedSize !== null && requestedSize <= 0n && execution) {
      return { mode: "LIVE", executionId: execution.live_execution_id, state: execution.state };
    }
    const requiredWalletAmount = side === "BUY"
      ? BigInt(approval.requested_amount_micros!)
      : requestedSize!;
    let walletCheck = await this.walletChecks(approval, side, input.signal.assetId, requiredWalletAmount);
    if (!walletCheck.ok) {
      if (execution) {
        this.store.audit("LIVE_EXECUTION", execution.live_execution_id, "wallet_check_blocked", walletCheck.reason, {});
        return { mode: "LIVE", executionId: execution.live_execution_id, state: execution.state };
      }
      return this.reject(input, side, executionIdempotencyKey, liveGateRunId, walletCheck.reason, executionType);
    }

    const deadline = side === "BUY" ? this.buyDeadline(input) : null;
    if (!execution && deadline !== null && this.now().valueOf() >= Date.parse(deadline)) {
      const expired = this.store.createExecution({
        liveAccountId: input.accountId,
        signalId: input.signal.signalId,
        contextId: input.context.contextId,
        riskDecisionId: input.riskDecisionId,
        liveGateRunId,
        executionIdempotencyKey,
        executionType: "TARGET_BUY",
        state: "EXPIRED",
        assetId: input.signal.assetId,
        conditionId: input.signal.conditionId,
        requestedAmountMicros: approval.requested_amount_micros,
        requestedSizeMicros: null,
        targetPriceUnits: input.signal.targetPriceUnits,
        deadlineAt: deadline,
        reason: "WAIT_TIMEOUT",
        rulesetHash,
      });
      return { mode: "LIVE", executionId: expired.live_execution_id, state: expired.state };
    }

    if (!execution) {
      this.database.exec("BEGIN IMMEDIATE");
      try {
        execution = this.store.createExecution({
          liveAccountId: input.accountId,
          signalId: input.signal.signalId,
          contextId: input.context.contextId,
          riskDecisionId: input.riskDecisionId,
          liveGateRunId,
          executionIdempotencyKey,
          executionType,
          state: side === "BUY" ? "WAITING_EXECUTION" : executionType === "STOP_LOSS" ? "STOP_EXIT_PENDING" : "EXIT_PENDING",
          assetId: input.signal.assetId,
          conditionId: input.signal.conditionId,
          requestedAmountMicros: side === "BUY" ? approval.requested_amount_micros : null,
          requestedSizeMicros: side === "BUY" ? null : approval.requested_size_micros,
          targetPriceUnits: input.signal.targetPriceUnits,
          deadlineAt: deadline,
          reason: side === "BUY" ? "LIVE_BUY_WAITING_MARKET" : executionType === "STOP_LOSS" ? "STOP_LOSS_TRIGGERED" : "LIVE_SELL_EXIT_PENDING",
          rulesetHash,
        });
        if (side === "BUY") {
          this.store.reserveChecked(execution, BigInt(approval.requested_amount_micros!), {
            walletBalanceMicros: BigInt(walletCheck.balanceMicros),
            walletAllowanceMicros: BigInt(walletCheck.allowanceMicros),
          });
        } else {
          this.store.reserveAssetChecked(execution, BigInt(approval.requested_size_micros!), {
            outcomeBalanceMicros: BigInt(walletCheck.balanceMicros),
            outcomeAllowanceMicros: BigInt(walletCheck.allowanceMicros),
          });
        }
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    }

    if (side === "BUY" && execution.deadline_at !== null && this.now().valueOf() >= Date.parse(execution.deadline_at)) {
      this.store.transaction(() => {
        this.store.releaseReservation(execution!, null, "WAIT_TIMEOUT");
        this.store.updateExecutionState(execution!.live_execution_id, "EXPIRED", "WAIT_TIMEOUT", rulesetHash);
      });
      return { mode: "LIVE", executionId: execution.live_execution_id, state: "EXPIRED" };
    }

    if (this.store.hasNonTerminalOrder(execution.live_execution_id)) {
      const synchronized = await this.recovery.reconcile(input.accountId);
      if (!synchronized.passed) {
        this.store.transaction(() => {
          this.store.freezeExecution(execution!.live_execution_id, `OPEN_ORDER_RECONCILIATION_FAILED:${synchronized.reason}`);
          this.store.forceGateDisabled(`OPEN_ORDER_RECONCILIATION_FAILED:${synchronized.reason}`, "SYSTEM");
        });
        return { mode: "LIVE", executionId: execution.live_execution_id, state: "FROZEN" };
      }
      const current = this.store.existingExecution(executionIdempotencyKey)!;
      return { mode: "LIVE", executionId: current.live_execution_id, state: current.state };
    }

    let plan: LiveMarketPlan;
    let effectiveInput = input;
    try {
      plan = await this.marketPlan(execution, side, approval);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "LIVE_MARKET_DATA_FAILED";
      this.store.audit("LIVE_EXECUTION", execution.live_execution_id, "market_data_failed", reason, {});
      return { mode: "LIVE", executionId: execution.live_execution_id, state: execution.state };
    }
    if (side === "BUY") {
      let adjustmentAttempts = 0;
      while (
        plan.outcome === "REJECT"
        && ["ORDER_AMOUNT_BELOW_EXECUTOR_PRECISION", "BELOW_MARKET_MIN_ORDER_SIZE"].includes(plan.reason)
        && plan.minimumPassingAmountMicros !== null
        && plan.minimumPassingAmountMicros !== undefined
      ) {
        if (adjustmentAttempts >= RULESET.maxRetryCount) {
          plan = { ...plan, reason: "LIVE_BUY_MARKET_MINIMUM_CHANGED_REPEATEDLY" };
          break;
        }
        adjustmentAttempts += 1;
        const adjustment = await this.tryLiftEligibleBuyToMarketMinimum(
          effectiveInput,
          execution,
          approval,
          BigInt(plan.minimumPassingAmountMicros),
        );
        if (adjustment.status === "NOT_ELIGIBLE") break;
        execution = adjustment.execution;
        if (adjustment.status === "REJECTED") {
          plan = { ...plan, reason: adjustment.reason };
          break;
        }
        approval = adjustment.approval;
        walletCheck = adjustment.walletCheck;
        effectiveInput = adjustment.effectiveInput;
        gateInput.riskDecisionId = approval.risk_decision_id;
        try {
          plan = await this.marketPlan(execution, side, approval);
        } catch (error) {
          const reason = error instanceof Error ? error.message : "LIVE_MARKET_DATA_FAILED_AFTER_AUTO_LIFT";
          this.store.audit("LIVE_EXECUTION", execution.live_execution_id, "market_data_failed", reason, {});
          return { mode: "LIVE", executionId: execution.live_execution_id, state: execution.state };
        }
      }
    }
    this.store.transaction(() => this.store.recordMarketCheck({
      execution: execution!,
      side,
      book: plan.book,
      fee: plan.fee,
      ageMs: plan.ageMs,
      lowerPriceUnits: plan.lowerPriceUnits,
      upperPriceUnits: plan.upperPriceUnits,
      requestedSizeMicros: side === "SELL"
        ? (BigInt(execution!.requested_size_micros ?? "0") - BigInt(execution!.filled_size_micros)).toString()
        : null,
      match: plan.match,
      outcome: plan.outcome,
      reason: plan.reason,
    }));
    if (plan.outcome !== "ALLOW") {
      if (plan.outcome === "REJECT" && side === "BUY") {
        if (execution.state !== "REJECTED") {
          this.store.transaction(() => this.store.rejectPendingExecution(execution!, plan.reason));
        }
        return { mode: "LIVE", executionId: execution.live_execution_id, state: "REJECTED" };
      }
      return { mode: "LIVE", executionId: execution.live_execution_id, state: execution.state };
    }

    if (side === "BUY" && effectiveInput.riskDecisionId !== input.riskDecisionId) {
      const repricedGate = await this.options.liveGate.checkExecution(gateInput);
      if (!repricedGate.allowed) {
        const reason = `LIVE_GATE_REPRICE_BLOCKED:${repricedGate.blockedReasons.join(",")}`;
        this.store.transaction(() => this.store.rejectPendingExecution(execution!, reason));
        return { mode: "LIVE", executionId: execution.live_execution_id, state: "REJECTED" };
      }
      const repricedGateAttestationFailure = this.productionGateRunFailure(repricedGate.runId, gateInput);
      if (repricedGateAttestationFailure) {
        this.store.transaction(() => this.store.rejectPendingExecution(execution!, repricedGateAttestationFailure));
        return { mode: "LIVE", executionId: execution.live_execution_id, state: "REJECTED" };
      }
      if (this.liveGateRunExists(repricedGate.runId)) {
        this.store.transaction(() => this.store.bindFinalGateRun(execution!.live_execution_id, repricedGate.runId));
      }
    }

    let request: LiveOrderRequest;
    try {
      request = await this.buildOrderRequest(effectiveInput, execution, side, approval, plan, walletCheck);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "LIVE_ORDER_SIGNING_FAILED";
      this.store.transaction(() => this.store.failPendingExecution(execution!, `LIVE_ORDER_SIGNING_FAILED:${reason}`));
      return { mode: "LIVE", executionId: execution.live_execution_id, state: "FAILED" };
    }
    const signedSnapshotAge = executableOrderbookAgeMs(plan.book, this.now().valueOf());
    if (
      !Number.isFinite(signedSnapshotAge)
      || signedSnapshotAge < 0
      || signedSnapshotAge > RULESET.orderbookMaxAgeMs
    ) {
      this.store.audit("LIVE_EXECUTION", execution.live_execution_id, "signing_snapshot_stale", "ORDERBOOK_STALE_AFTER_SIGNING", {
        marketSnapshotTime: plan.book.marketSnapshotTime,
        dataAgeMs: signedSnapshotAge,
      });
      return { mode: "LIVE", executionId: execution.live_execution_id, state: execution.state };
    }
    // Re-run the complete gate after all asynchronous preparation. No external
    // side effect may occur on evidence that became stale while signing.
    const finalGate = await this.options.liveGate.checkExecution(gateInput);
    if (!finalGate.allowed) {
      const reason = `LIVE_GATE_RECHECK_BLOCKED:${finalGate.blockedReasons.join(",")}`;
      this.store.transaction(() => this.store.rejectPendingExecution(execution!, reason));
      return { mode: "LIVE", executionId: execution.live_execution_id, state: "REJECTED" };
    }
    const finalGateAttestationFailure = this.productionGateRunFailure(finalGate.runId, gateInput);
    if (finalGateAttestationFailure) {
      this.store.transaction(() => this.store.rejectPendingExecution(execution!, finalGateAttestationFailure));
      return { mode: "LIVE", executionId: execution.live_execution_id, state: "REJECTED" };
    }
    if (this.liveGateRunExists(finalGate.runId)) {
      this.store.transaction(() => this.store.bindFinalGateRun(execution!.live_execution_id, finalGate.runId));
    }
    if (this.emergencyHaltedAccounts.has(input.accountId)) {
      this.store.transaction(() => this.store.rejectPendingExecution(execution!, "LIVE_ACCOUNT_EMERGENCY_HALTED"));
      return { mode: "LIVE", executionId: execution.live_execution_id, state: "REJECTED" };
    }
    if (this.environment === "PRODUCTION" && !this.startupRecoveredAccounts.has(input.accountId)) {
      this.store.transaction(() => {
        this.store.rejectPendingExecution(execution!, "LIVE_STARTUP_RECOVERY_REQUIRED");
        this.store.forceGateDisabled("LIVE_STARTUP_RECOVERY_REQUIRED", "SYSTEM");
      });
      return { mode: "LIVE", executionId: execution.live_execution_id, state: "REJECTED" };
    }

    let intentCreated = false;
    let submitClaimGateTransitionCount: number | null = null;
    let durableExecutionState = execution.state;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const currentExecution = this.store.executionById(execution.live_execution_id);
      if (currentExecution) durableExecutionState = currentExecution.state;
      const gateTransitionCount = this.store.gateTransitionCount();
      if (
        currentExecution
        && !this.emergencyHaltedAccounts.has(input.accountId)
        && (this.environment !== "PRODUCTION" || this.store.isGateActive())
        && ["WAITING_EXECUTION", "EXIT_PENDING", "STOP_EXIT_PENDING"].includes(currentExecution.state)
        && !this.store.hasNonTerminalOrder(execution.live_execution_id)
      ) {
        intentCreated = this.store.createOrder(
          request,
          execution.live_execution_id,
          this.orderAdapter.adapterType,
          side === "BUY" ? plan.match.complete : null,
        );
        if (intentCreated) {
          submitClaimGateTransitionCount = gateTransitionCount;
          this.store.recordOrderAttempt({
            liveOrderId: request.liveOrderId,
            sequence: 1,
            action: "SUBMIT",
            status: "STARTED",
            errorReason: null,
            request: {
              side,
              assetId: request.assetId,
              sizeMicros: request.sizeMicros,
              gateTransitionCount,
            },
            response: {},
          });
        }
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    if (!intentCreated) {
      return { mode: "LIVE", executionId: execution.live_execution_id, state: durableExecutionState };
    }

    if (submitClaimGateTransitionCount === null) throw new Error("LIVE_SUBMIT_CLAIM_MISSING");
    const submissionBlockedReason = this.emergencyHaltedAccounts.has(input.accountId)
      ? "LIVE_ACCOUNT_EMERGENCY_HALTED"
      : this.store.gateTransitionCount() !== submitClaimGateTransitionCount
        ? "LIVE_GATE_GENERATION_CHANGED_BEFORE_SUBMIT"
      : this.environment === "PRODUCTION" && !this.store.isGateActive()
        ? "LIVE_GATE_DISABLED_BEFORE_SUBMIT"
        : null;
    if (submissionBlockedReason) {
      this.store.transaction(() => {
        this.store.recordOrderAttempt({
          liveOrderId: request.liveOrderId,
          sequence: 1,
          action: "SUBMIT",
          status: "FAILED",
          errorReason: submissionBlockedReason,
          request: {
            side,
            assetId: request.assetId,
            sizeMicros: request.sizeMicros,
            gateTransitionCount: submitClaimGateTransitionCount,
          },
          response: {},
        });
        this.store.failUnsubmittedOrder(execution!, request.liveOrderId, submissionBlockedReason);
      });
      return { mode: "LIVE", executionId: execution.live_execution_id, state: "FAILED" };
    }

    let submitResult: OrderSubmitResult | null = null;
    try {
      const submit = await withExternalTimeout(
        "SUBMIT_ORDER",
        this.externalCallTimeoutMs,
        () => this.orderAdapter.submitOrder(request),
      );
      submitResult = submit;
      this.validateSubmitResult(input.accountId, request, submit);
      const gateChangedDuringSubmit = this.store.gateTransitionCount() !== submitClaimGateTransitionCount;
      this.database.exec("BEGIN IMMEDIATE");
      try {
        this.store.updateOrderFromSubmit(request.liveOrderId, submit);
        this.store.recordOrderAttempt({
          liveOrderId: request.liveOrderId,
          sequence: 1,
          action: "SUBMIT",
          status: "SUCCEEDED",
          errorReason: null,
          request: { side, assetId: request.assetId, sizeMicros: request.sizeMicros },
          response: submit.raw,
        });
        for (const fill of submit.fills) {
          const recorded = this.store.recordFill({ execution, liveOrderId: request.liveOrderId, side, fill });
          if (!recorded.inserted) continue;
          if (side === "BUY") this.store.applyBuyFill(execution, fill);
          else this.store.applySellFill(execution, request.liveOrderId, fill);
        }
        this.store.updateExecutionTotals(execution.live_execution_id);
        const totalFilled = this.store.executionById(execution.live_execution_id)!.filled_size_micros;
        const terminal = submit.terminal === true
          || (submit.terminal === undefined
            && submit.confirmationPending !== true
            && !["CREATED", "SUBMITTED", "ACKNOWLEDGED"].includes(submit.status));
        let nextState = execution.state;
        let stateReason = "ORDER_CONFIRMATION_PENDING";
        if (side === "BUY" && terminal) {
          if (BigInt(totalFilled) === 0n) {
            nextState = "WAITING_EXECUTION";
            stateReason = "FAK_ZERO_FILL_RETRY";
          } else {
            this.store.releaseReservation(execution, request.liveOrderId, "FAK_REMAINDER_RELEASE");
            nextState = plan.match.complete && BigInt(totalFilled) >= BigInt(request.sizeMicros)
              ? "EXECUTED"
              : "PARTIALLY_EXECUTED";
            stateReason = nextState === "EXECUTED" ? "FAK_FILLED" : "FAK_PARTIAL_CANCEL_REMAINDER";
          }
        } else if (side === "SELL" && terminal) {
          const remaining = BigInt(execution.requested_size_micros ?? "0") - BigInt(totalFilled);
          if (remaining <= 0n) {
            this.store.releaseAssetReservation(execution, request.liveOrderId, "SELL_COMPLETED");
            nextState = "EXECUTED";
            stateReason = "SELL_COMPLETED";
          } else {
            nextState = execution.execution_type === "STOP_LOSS" ? "STOP_EXIT_PENDING" : "EXIT_PENDING";
            stateReason = BigInt(totalFilled) === 0n ? "FAK_ZERO_FILL_RETRY" : "SELL_PARTIAL_PENDING";
          }
        }
        if (gateChangedDuringSubmit) {
          nextState = "FROZEN";
          stateReason = "LIVE_GATE_CHANGED_DURING_SUBMIT";
          this.store.freezeOpenPositions(input.accountId, stateReason);
          this.store.freezeExecution(execution.live_execution_id, stateReason);
        } else {
          this.store.updateExecutionState(execution.live_execution_id, nextState, stateReason, rulesetHash);
        }
        this.store.updateCheckpoint(input.accountId, { executionId: execution.live_execution_id, orderId: request.liveOrderId });
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
      const updated = this.database.prepare("SELECT state FROM live_executions WHERE live_execution_id=?")
        .get(execution.live_execution_id) as { state: string };
      return { mode: "LIVE", executionId: execution.live_execution_id, state: updated.state };
    } catch (error) {
      const reason = error instanceof Error ? error.message : "ORDER_SUBMIT_FAILED";
      const submitOutcomeUnknown = error instanceof OrderSubmissionOutcomeUnknownError
        || reason.startsWith("LIVE_EXTERNAL_TIMEOUT:SUBMIT_ORDER:");
      const uncertainResult = submitOutcomeUnknown
        ? (error instanceof OrderSubmissionOutcomeUnknownError ? error.partialResult : null) ?? {
          adapterType: this.orderAdapter.adapterType,
          externalOrderId: null,
          status: "SUBMITTED" as const,
          confirmationPending: true,
          terminal: false,
          fills: [],
          raw: { error: reason },
        }
        : submitResult;
      if (uncertainResult?.externalOrderId || submitOutcomeUnknown) {
        this.store.transaction(() => {
          this.store.recordOrderAttempt({
            liveOrderId: request.liveOrderId,
            sequence: 1,
            action: "SUBMIT",
            status: "FAILED",
            errorReason: `SUBMIT_OUTCOME_UNKNOWN:${reason}`,
            request: { side, assetId: request.assetId, sizeMicros: request.sizeMicros },
            response: uncertainResult?.raw ?? {},
          });
          this.store.markSubmitOutcomeUnknown(request.liveOrderId, uncertainResult!, reason);
          this.store.freezeExecution(execution.live_execution_id, `SUBMIT_OUTCOME_UNKNOWN:${reason}`);
          this.store.freezeOpenPositions(input.accountId, `SUBMIT_OUTCOME_UNKNOWN:${reason}`);
          this.store.forceGateDisabled(`SUBMIT_OUTCOME_UNKNOWN:${reason}`, "SYSTEM");
        });
        return { mode: "LIVE", executionId: execution.live_execution_id, state: "FROZEN" };
      }
      this.database.exec("BEGIN IMMEDIATE");
      try {
        this.store.recordOrderAttempt({
          liveOrderId: request.liveOrderId,
          sequence: 1,
          action: "SUBMIT",
          status: "FAILED",
          errorReason: reason,
          request: { side, assetId: request.assetId, sizeMicros: request.sizeMicros },
          response: { error: reason },
        });
        this.store.failUnsubmittedOrder(execution, request.liveOrderId, `ORDER_SUBMIT_FAILED:${reason}`);
        if (side === "SELL" && reason.startsWith("SELL_FILL_")) {
          this.store.freezeOpenPositions(input.accountId, reason);
        }
        this.database.exec("COMMIT");
      } catch (persistenceError) {
        this.database.exec("ROLLBACK");
        throw persistenceError;
      }
      return { mode: "LIVE", executionId: execution.live_execution_id, state: "FAILED" };
    }
  }

  private buyDeadline(input: ExecutorSignalInput): string {
    const explicitDeadline = input.context.executionDeadlineAt === null || input.context.executionDeadlineAt === undefined
      ? Number.NaN
      : Date.parse(input.context.executionDeadlineAt);
    if (Number.isFinite(explicitDeadline)) return new Date(explicitDeadline).toISOString();
    if (input.context.marketEndTimeStatus === "UNAVAILABLE") {
      throw new Error("LIVE_EXECUTION_DEADLINE_MISSING");
    }
    const target = Date.parse(input.context.targetTradeTimestamp);
    const end = Date.parse(input.context.marketEndTime);
    if (!Number.isFinite(target) || !Number.isFinite(end)) throw new Error("LIVE_WAIT_TIME_INPUT_INVALID");
    const executionRules = registeredExecutionRules(this.database, input.context.rulesetHash);
    if (!executionRules) throw new Error(`HISTORICAL_RULESET_UNAVAILABLE:${input.context.rulesetHash}`);
    const remaining = Math.max(0, end - target);
    const wait = Math.min(
      (remaining * executionRules.waitRatioPpm) / 1_000_000,
      executionRules.maxWaitMs,
    );
    return new Date(target + wait).toISOString();
  }

  private buyPolicyClass(signal: PaperSignalEnvelope) {
    return classifyTargetBuyRatio({
      ratioNumerator: signal.context?.capitalSizingRatio?.ratioNumerator ?? null,
      ratioDenominator: signal.context?.capitalSizingRatio?.ratioDenominator ?? null,
      legacyRatioPpm: signal.context?.targetTradeCapitalRatioPpm
        ?? signal.capitalDecision?.ratioPpm
        ?? null,
      fixedFallback: signal.capitalDecision?.confidence === "MEDIUM",
    });
  }

  private applyWaitingBuyTargetExitAdjustments(
    accountId: string,
    signal: PaperSignalEnvelope,
    fullExitThresholdPpm: number,
  ): number {
    const ratio = parseEffectiveTargetSellRatio({
      numerator: signal.sellRatioNumerator,
      denominator: signal.sellRatioDenominator,
      fullExitThresholdPpm,
    });
    if (!ratio) return 0;
    const rows = this.database.prepare(
      `SELECT live_execution_id,risk_decision_id,requested_amount_micros
       FROM live_executions
       WHERE live_account_id=? AND asset_id=? AND condition_id=?
         AND execution_type='TARGET_BUY' AND state='WAITING_EXECUTION'
       ORDER BY created_at,live_execution_id`,
    ).all(accountId, signal.assetId, signal.conditionId) as unknown as Array<{
      live_execution_id: string;
      risk_decision_id: string;
      requested_amount_micros: string | null;
    }>;
    const riskManager = new RiskManager(this.database, this.sourceVersion);
    return this.store.transaction(() => {
      let adjustedCount = 0;
      for (const row of rows) {
        const adjustmentIdempotencyKey = liveTargetSellWaitingBuyAdjustmentIdempotencyKey(
          row.live_execution_id,
          signal.signalId,
        );
        if (this.database.prepare(
          "SELECT 1 present FROM live_reservation_ledger WHERE idempotency_key=?",
        ).get(adjustmentIdempotencyKey)) continue;
        if (row.requested_amount_micros === null) {
          throw new Error("LIVE_WAITING_BUY_REQUESTED_AMOUNT_MISSING");
        }
        const reservationRows = this.database.prepare(
          "SELECT delta_micros FROM live_reservation_ledger WHERE live_execution_id=?",
        ).all(row.live_execution_id) as unknown as Array<{ delta_micros: string }>;
        const reserved = reservationRows.reduce(
          (total, entry) => total + BigInt(entry.delta_micros),
          0n,
        );
        if (reserved !== BigInt(row.requested_amount_micros) || reserved <= 0n) {
          throw new Error("LIVE_WAITING_BUY_RESERVATION_MISMATCH");
        }
        const released = (reserved * ratio.numerator) / ratio.denominator;
        if (released <= 0n) continue;
        const retained = reserved - released;
        const reason = retained === 0n
          ? "TARGET_SELL_SUPERSEDED_WAITING_BUY"
          : "TARGET_SELL_REDUCED_WAITING_BUY";
        const adjustedRisk = riskManager.recordDownwardAmountAdjustment({
          mode: "LIVE",
          accountId,
          entityId: `${row.live_execution_id}:TARGET_SELL:${signal.signalId}`,
          priorRiskDecisionId: row.risk_decision_id,
          requestedAmountMicros: retained,
          reason,
          now: this.now().toISOString(),
        });
        if (!this.store.adjustWaitingBuyForTargetExit({
          buyExecutionId: row.live_execution_id,
          targetSellSignalId: signal.signalId,
          retainedAmountMicros: retained,
          adjustedRiskDecisionId: adjustedRisk.riskDecisionId,
        })) throw new Error("LIVE_WAITING_BUY_TARGET_EXIT_ADJUSTMENT_RACE");
        adjustedCount += 1;
      }
      return adjustedCount;
    });
  }

  private wasWaitingBuyReducedByTargetExit(executionId: string): boolean {
    return Boolean(this.database.prepare(
      `SELECT 1 reduced FROM live_reservation_ledger
       WHERE live_execution_id=? AND entry_type='RELEASE'
         AND idempotency_key LIKE ? ESCAPE '\\'
       LIMIT 1`,
    ).get(
      executionId,
      `LIVE\_TARGET\_SELL\_WAITING\_BUY\_ADJUSTMENT:${executionId}:%`,
    ));
  }

  private async supersedePendingTargetExits(accountId: string, assetId: string): Promise<void> {
    const rows = this.database.prepare(
      `SELECT live_execution_id FROM live_executions
       WHERE live_account_id=? AND asset_id=? AND execution_type='TARGET_SELL'
         AND state IN ('WAITING_EXECUTION','PARTIALLY_EXECUTED','EXIT_PENDING')
       ORDER BY created_at,live_execution_id`,
    ).all(accountId, assetId) as unknown as Array<{ live_execution_id: string }>;
    for (const row of rows) await this.cancelExecutionUnlocked(row.live_execution_id, "STOP_LOSS_SUPERSEDED");
  }

  private loadSignalForSystemExecution(signalId: string): {
    signal: PaperSignalEnvelope;
    context: SignalExecutionContext;
  } {
    const row = this.database.prepare(
      `SELECT s.signal_id,s.signal_type,s.status,s.execution_eligible,s.execution_block_reason,
              s.target_id,s.asset_id,s.condition_id,s.target_price_units,s.target_size_micros,s.event_classification,
              s.sell_ratio_numerator,s.sell_ratio_denominator,s.created_at,
              c.context_id,c.target_id context_target_id,c.capital_decision_id,c.target_trade_capital_ratio_ppm,
              c.capital_sizing_ratio_json,c.capital_sizing_ratio_hash,
              c.target_trade_timestamp,c.market_end_time,c.market_end_time_status,c.execution_deadline_at,
              c.market_metadata_snapshot_json,
              c.market_metadata_hash,c.ruleset_hash,c.source_code_commit,c.source_code_dirty,
              c.config_version,c.created_at context_created_at,
              ce.capital_estimate_status,ce.capital_confidence,
              ce.target_trade_capital_ratio_ppm capital_ratio_ppm,ce.fallback_amount_micros
       FROM signals s
       JOIN signal_execution_contexts c ON c.signal_id=s.signal_id
       LEFT JOIN capital_estimates ce ON ce.capital_estimate_id=c.capital_decision_id
       WHERE s.signal_id=?`,
    ).get(signalId) as {
      signal_id: string;
      target_id: string;
      signal_type: "TARGET_BUY" | "TARGET_SELL";
      status: string;
      execution_eligible: number;
      execution_block_reason: string | null;
      event_classification: PaperSignalEnvelope["eventClassification"];
      asset_id: string;
      condition_id: string;
      target_price_units: string;
      target_size_micros: string;
      sell_ratio_numerator: string | null;
      sell_ratio_denominator: string | null;
      created_at: string;
      context_id: string;
      context_target_id: string;
      capital_decision_id: string | null;
      target_trade_capital_ratio_ppm: string | null;
      capital_sizing_ratio_json: string | null;
      capital_sizing_ratio_hash: string | null;
      target_trade_timestamp: string;
      market_end_time: string;
      market_end_time_status: "VERIFIED" | "UNAVAILABLE";
      execution_deadline_at: string | null;
      market_metadata_snapshot_json: string;
      market_metadata_hash: string;
      ruleset_hash: string;
      source_code_commit: string;
      source_code_dirty: number;
      config_version: string;
      context_created_at: string;
      capital_estimate_status: "COMPLETE" | "INCOMPLETE" | "FAILED" | null;
      capital_confidence: "HIGH" | "MEDIUM" | "LOW" | null;
      capital_ratio_ppm: string | null;
      fallback_amount_micros: string | null;
    } | undefined;
    if (!row) throw new Error(`LIVE_SYSTEM_SIGNAL_CONTEXT_NOT_FOUND:${signalId}`);
    const metadata = JSON.parse(row.market_metadata_snapshot_json) as unknown;
    if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
      throw new Error(`LIVE_SYSTEM_SIGNAL_METADATA_INVALID:${signalId}`);
    }
    const context: SignalExecutionContext = {
      contextId: row.context_id,
      targetId: row.context_target_id,
      signalId: row.signal_id,
      capitalDecisionId: row.capital_decision_id,
      targetTradeCapitalRatioPpm: row.target_trade_capital_ratio_ppm,
      capitalSizingRatio: row.capital_sizing_ratio_json
        ? JSON.parse(row.capital_sizing_ratio_json) as ExactCapitalRatioSnapshot
        : null,
      capitalSizingRatioHash: row.capital_sizing_ratio_hash,
      targetTradeTimestamp: row.target_trade_timestamp,
      marketEndTime: row.market_end_time,
      marketEndTimeStatus: row.market_end_time_status,
      executionDeadlineAt: row.execution_deadline_at,
      marketMetadataSnapshot: metadata as Record<string, unknown>,
      marketMetadataHash: row.market_metadata_hash,
      rulesetHash: row.ruleset_hash,
      sourceCodeCommit: row.source_code_commit,
      sourceCodeDirty: row.source_code_dirty === 1,
      configVersion: row.config_version,
      createdAt: row.context_created_at,
    };
    return {
      context,
      signal: {
        signalId: row.signal_id,
        targetId: row.target_id,
        signalType: row.signal_type,
        eventClassification: row.event_classification,
        status: row.status,
        executionEligible: row.execution_eligible === 1,
        executionBlockReason: row.execution_block_reason,
        assetId: row.asset_id,
        conditionId: row.condition_id,
        targetPriceUnits: row.target_price_units,
        targetSizeMicros: row.target_size_micros,
        sellRatioNumerator: row.sell_ratio_numerator,
        sellRatioDenominator: row.sell_ratio_denominator,
        createdAt: row.created_at,
        context,
        capitalDecision: row.capital_estimate_status
          && row.capital_confidence
          && row.fallback_amount_micros
          ? {
            status: row.capital_estimate_status,
            confidence: row.capital_confidence,
            ratioPpm: row.capital_ratio_ppm,
            fallbackAmountMicros: row.fallback_amount_micros,
          }
          : null,
      },
    };
  }

  private async marketPlan(
    execution: ReturnType<LiveStore["createExecution"]>,
    side: LiveOrderSide,
    approval: ApprovedRiskDecisionRow,
  ): Promise<LiveMarketPlan> {
    const fee = await withExternalTimeout(
      "EXECUTION_FEE",
      this.externalCallTimeoutMs,
      () => this.marketDataProvider.fee(execution.asset_id, execution.condition_id),
    );
    const book = await withExternalTimeout(
      "EXECUTION_ORDERBOOK",
      this.externalCallTimeoutMs,
      () => this.marketDataProvider.orderbook(execution.asset_id, execution.condition_id),
    );
    if (book.assetId !== execution.asset_id || book.conditionId.toLowerCase() !== execution.condition_id.toLowerCase()) {
      throw new Error("LIVE_ORDERBOOK_IDENTITY_MISMATCH");
    }
    if (fee.assetId !== execution.asset_id) throw new Error("LIVE_FEE_IDENTITY_MISMATCH");
    const ageMs = executableOrderbookAgeMs(book, this.now().valueOf());
    if (!Number.isFinite(ageMs)) throw new Error("LIVE_ORDERBOOK_TIMESTAMP_INVALID");
    const target = BigInt(execution.target_price_units ?? "0");
    if (target <= 0n || target >= PRICE_SCALE) throw new Error("LIVE_TARGET_PRICE_INVALID");
    const executionRules = registeredExecutionRules(this.database, execution.ruleset_hash);
    if (!executionRules) {
      throw new Error(`HISTORICAL_RULESET_UNAVAILABLE:${execution.ruleset_hash}`);
    }
    const parsedConstraints = side === "BUY"
      ? parseMarketOrderConstraints({ minOrderSize: book.minOrderSize, tickSize: book.tickSize })
      : null;
    const lower = side === "BUY"
      ? executionRules.buyPriceImprovementAllowed
        ? 0n
        : ratio(target, executionRules.buyPriceMinRatioPpm)
      : null;
    const upper = side === "BUY"
      ? cappedBuyPriceUpperUnits({
        targetPriceUnits: target,
        maximumRatioPpm: executionRules.buyPriceMaxRatioPpm,
        ...(
          executionRules.buyPriceMinimumTickSteps > 0
          && parsedConstraints !== null && !("error" in parsedConstraints)
            ? {
              minimumTickSteps: executionRules.buyPriceMinimumTickSteps,
              tickSizeUnits: parsedConstraints.tickSizeUnits,
            }
            : {}
        ),
        maximumBuyPriceUnits: executionRules.buyMaximumPriceUnits,
      })
      : null;
    const sellSlippage = execution.execution_type === "STOP_LOSS"
      ? executionRules.maxSlippagePpm
      : executionRules.followSellMaxSlippagePpm;
    const sellMinimum = side === "SELL" ? ratio(target, 1_000_000 - sellSlippage) : null;
    if (
      fee.status !== "AVAILABLE"
      || fee.feeRatePpm === null
      || fee.exponent === null
      || !/^\d+$/.test(fee.feeRatePpm)
      || !Number.isSafeInteger(fee.exponent)
      || fee.exponent < 1
      || fee.exponent > 4
    ) {
      return {
        book,
        fee,
        ageMs,
        match: emptyMatch(),
        orderMatch: emptyMatch(),
        lowerPriceUnits: lower?.toString() ?? sellMinimum?.toString() ?? null,
        upperPriceUnits: upper?.toString() ?? null,
        limitPriceUnits: (upper ?? sellMinimum ?? target).toString(),
        outcome: side === "BUY" ? "REJECT" : "WAIT",
        reason: "FEE_MODEL_UNAVAILABLE",
      };
    }
    if (ageMs < 0 || ageMs > RULESET.orderbookMaxAgeMs) {
      return {
        book,
        fee,
        ageMs,
        match: emptyMatch(),
        orderMatch: emptyMatch(),
        lowerPriceUnits: lower?.toString() ?? sellMinimum?.toString() ?? null,
        upperPriceUnits: upper?.toString() ?? null,
        limitPriceUnits: (upper ?? sellMinimum ?? target).toString(),
        outcome: "WAIT",
        reason: "ORDERBOOK_STALE",
      };
    }
    const feeRate = BigInt(fee.feeRatePpm);
    if (side === "BUY") {
      const executableUpper = parsedConstraints !== null && !("error" in parsedConstraints)
        ? executableBuyPriceUpperUnits(upper!, parsedConstraints.tickSizeUnits)
        : upper!;
      const matchingLower = executionRules.smallFollowBuyPolicyEnabled ? 0n : lower!;
      const bestAsk = bestExecutionAskPriceUnits(book.asks);
      if (bestAsk !== null && bestAsk > executionRules.buyMaximumPriceUnits) {
        return {
          book,
          fee,
          ageMs,
          match: emptyMatch(),
          orderMatch: emptyMatch(),
          lowerPriceUnits: lower!.toString(),
          upperPriceUnits: upper!.toString(),
          limitPriceUnits: upper!.toString(),
          outcome: "REJECT",
          reason: "BUY_EXECUTION_PRICE_ABOVE_MAX",
        };
      }
      const budget = BigInt(approval.requested_amount_micros!);
      const minimumQuote = parsedConstraints !== null && !("error" in parsedConstraints)
        ? quoteExecutionBuySize({
          asks: book.asks,
          requestedSizeMicros: parsedConstraints.normalizedMinOrderSizeMicros,
          lowerPriceUnits: matchingLower,
          upperPriceUnits: executableUpper,
          feeRatePpm: feeRate,
          feeExponent: fee.exponent,
        })
        : null;
      if (minimumQuote && !minimumQuote.complete) {
        const reason = buyNoFillReason({
          bestAskPriceUnits: bestAsk,
          lowerPriceUnits: matchingLower,
          upperPriceUnits: upper!,
          inRangeReason: "BUY_MARKET_MINIMUM_LIQUIDITY_UNAVAILABLE",
        });
        return {
          book,
          fee,
          ageMs,
          match: minimumQuote,
          orderMatch: emptyMatch(),
          lowerPriceUnits: lower!.toString(),
          upperPriceUnits: upper!.toString(),
          limitPriceUnits: upper!.toString(),
          outcome: "WAIT",
          reason,
        };
      }
      const constraint = evaluateBuyMarketConstraint({
        minOrderSize: book.minOrderSize,
        tickSize: book.tickSize,
        requestedAmountMicros: budget,
        upperPriceUnits: upper!,
        maximumBuyPriceUnits: executionRules.buyMaximumPriceUnits,
        ...(minimumQuote?.complete ? {
          executableMinimumNotionalMicros: BigInt(minimumQuote.filledNotionalMicros),
          executableMinimumTotalMicros: BigInt(minimumQuote.filledNotionalMicros)
            + BigInt(minimumQuote.feeMicros),
        } : {}),
      });
      if (constraint.result !== "PASS") {
        return {
          book,
          fee,
          ageMs,
          match: emptyMatch(),
          orderMatch: emptyMatch(),
          lowerPriceUnits: lower!.toString(),
          upperPriceUnits: upper!.toString(),
          limitPriceUnits: constraint.effectivePriceUnits ?? upper!.toString(),
          outcome: "REJECT",
          reason: constraint.reason,
          minimumPassingAmountMicros: constraint.minimumPassingAmountMicros,
        };
      }
      const normalizedBudget = BigInt(constraint.normalizedOrderAmountMicros!);
      const match = matchExecutionBuy({
        asks: book.asks,
        reservationMicros: normalizedBudget,
        lowerPriceUnits: matchingLower,
        upperPriceUnits: BigInt(constraint.effectivePriceUnits!),
        feeRatePpm: feeRate,
        feeExponent: fee.exponent,
      });
      if (BigInt(match.filledSizeMicros) === 0n) {
        const reason = buyNoFillReason({
          bestAskPriceUnits: bestAsk,
          lowerPriceUnits: lower!,
          upperPriceUnits: BigInt(constraint.effectivePriceUnits!),
        });
        return {
          book,
          fee,
          ageMs,
          match,
          orderMatch: emptyMatch(),
          lowerPriceUnits: lower!.toString(),
          upperPriceUnits: upper!.toString(),
          limitPriceUnits: upper!.toString(),
          outcome: "WAIT",
          reason,
        };
      }
      const feeInclusiveVwap = executionRules.smallFollowBuyPolicyEnabled
        ? feeInclusiveBuyVwapPriceUnits(match)
        : null;
      if (executionRules.smallFollowBuyPolicyEnabled && feeInclusiveVwap === null) {
        throw new Error("LIVE_BUY_FEE_INCLUSIVE_VWAP_UNAVAILABLE");
      }
      const priceOutcome = !executionRules.smallFollowBuyPolicyEnabled
        ? null
        : feeInclusiveVwap! > executionRules.buyMaximumPriceUnits
          ? { outcome: "REJECT" as const, reason: "BUY_EXECUTION_VWAP_ABOVE_MAX" }
          : feeInclusiveVwap! > upper!
            ? { outcome: "WAIT" as const, reason: "BUY_EXECUTION_VWAP_ABOVE_LIMIT" }
            : feeInclusiveVwap! < lower!
              ? { outcome: "REJECT" as const, reason: "BUY_EXECUTION_VWAP_BELOW_LIMIT" }
              : null;
      if (priceOutcome) {
        return {
          book,
          fee,
          ageMs,
          match,
          orderMatch: emptyMatch(),
          lowerPriceUnits: lower!.toString(),
          upperPriceUnits: upper!.toString(),
          limitPriceUnits: upper!.toString(),
          ...priceOutcome,
        };
      }
      const observedLimit = BigInt(match.levels.at(-1)!.priceUnits);
      // Sign at the worst price actually observed in the eligible full-depth
      // quote. This remains inside the configured band and prevents the order
      // from reaching unobserved, more expensive levels.
      const orderMatch = matchExecutionBuy({
        asks: [{
          price: scaledToDecimal(observedLimit, PRICE_SCALE_DIGITS),
          size: scaledToDecimal(BigInt(match.filledSizeMicros), SHARE_SCALE_DIGITS),
        }],
        reservationMicros: normalizedBudget,
        lowerPriceUnits: observedLimit,
        upperPriceUnits: observedLimit,
        feeRatePpm: feeRate,
        feeExponent: fee.exponent,
      });
      if (BigInt(orderMatch.filledSizeMicros) === 0n) throw new Error("LIVE_BUY_ORDER_SIZE_ZERO_AFTER_FEE");
      return {
        book,
        fee,
        ageMs,
        match,
        orderMatch,
        lowerPriceUnits: lower!.toString(),
        upperPriceUnits: upper!.toString(),
        limitPriceUnits: observedLimit.toString(),
        outcome: "ALLOW",
        reason: "LIVE_BUY_MARKET_CHECK_ALLOW",
      };
    }
    const remaining = BigInt(execution.requested_size_micros ?? "0") - BigInt(execution.filled_size_micros);
    if (remaining <= 0n) throw new Error("LIVE_SELL_REMAINING_SIZE_INVALID");
    const constraint = evaluateSellMarketConstraint({
      minOrderSize: book.minOrderSize,
      tickSize: book.tickSize,
      requestedSizeMicros: remaining,
      minimumPriceUnits: sellMinimum!,
    });
    if (constraint.result !== "PASS") {
      return {
        book,
        fee,
        ageMs,
        match: emptyMatch(),
        orderMatch: emptyMatch(),
        lowerPriceUnits: sellMinimum!.toString(),
        upperPriceUnits: null,
        limitPriceUnits: constraint.effectivePriceUnits ?? sellMinimum!.toString(),
        outcome: "WAIT",
        reason: constraint.reason,
      };
    }
    const effectiveSellMinimum = BigInt(constraint.effectivePriceUnits!);
    const match = matchExecutionSell({
      bids: book.bids,
      requestedSizeMicros: BigInt(constraint.normalizedOrderSizeMicros!),
      minimumPriceUnits: effectiveSellMinimum,
      feeRatePpm: feeRate,
      feeExponent: fee.exponent,
    });
    if (BigInt(match.filledSizeMicros) === 0n) {
      return {
        book,
        fee,
        ageMs,
        match,
        orderMatch: emptyMatch(),
        lowerPriceUnits: sellMinimum!.toString(),
        upperPriceUnits: null,
        limitPriceUnits: sellMinimum!.toString(),
        outcome: "WAIT",
        reason: "SELL_SLIPPAGE_OR_LIQUIDITY_WAIT",
      };
    }
    const orderMatch = matchExecutionSell({
      bids: [{
        price: scaledToDecimal(effectiveSellMinimum, PRICE_SCALE_DIGITS),
        size: scaledToDecimal(BigInt(match.filledSizeMicros), SHARE_SCALE_DIGITS),
      }],
      requestedSizeMicros: BigInt(match.filledSizeMicros),
      minimumPriceUnits: effectiveSellMinimum,
      feeRatePpm: feeRate,
      feeExponent: fee.exponent,
    });
    return {
      book,
      fee,
      ageMs,
      match,
      orderMatch,
      lowerPriceUnits: effectiveSellMinimum.toString(),
      upperPriceUnits: null,
      limitPriceUnits: effectiveSellMinimum.toString(),
      outcome: "ALLOW",
      reason: "LIVE_SELL_MARKET_CHECK_ALLOW",
    };
  }

  private async tryLiftEligibleBuyToMarketMinimum(
    input: ExecutorSignalInput,
    execution: NonNullable<ReturnType<LiveStore["executionById"]>>,
    approval: ApprovedRiskDecisionRow,
    requiredAmountMicros: bigint,
  ): Promise<LiveBuyAutoLiftResult> {
    const rules = registeredExecutionRules(this.database, execution.ruleset_hash);
    if (!rules) throw new Error(`HISTORICAL_RULESET_UNAVAILABLE:${execution.ruleset_hash}`);
    if (
      rules.buyFirstEntryMinimumAmountMicros <= 0n
      || rules.buyMarketMinimumAutoLiftCapMicros <= 0n
    ) return { status: "NOT_ELIGIBLE" };
    const legacyMinimumLiftEligibility = rules.smallFollowBuyPolicyEnabled
      ? null
      : liveBuyMinimumLiftEligibility(
        this.database,
        execution.live_account_id,
        execution.asset_id,
        execution.live_execution_id,
      );
    if (
      this.wasWaitingBuyReducedByTargetExit(execution.live_execution_id)
      || (rules.smallFollowBuyPolicyEnabled
        ? this.buyPolicyClass(input.signal) !== "SMALL_BUY"
        : legacyMinimumLiftEligibility === "NONE")
    ) {
      return { status: "NOT_ELIGIBLE" };
    }
    if (requiredAmountMicros > rules.buyMarketMinimumAutoLiftCapMicros) {
      return { status: "REJECTED", execution, reason: "BUY_MARKET_MINIMUM_ABOVE_AUTO_LIFT_CAP" };
    }
    const priorRisk = this.database.prepare(
      "SELECT capital_sizing_decision_json FROM risk_decisions WHERE risk_decision_id=?",
    ).get(approval.risk_decision_id) as { capital_sizing_decision_json: string | null } | undefined;
    if (!priorRisk?.capital_sizing_decision_json) return { status: "NOT_ELIGIBLE" };
    const capitalSizing = JSON.parse(priorRisk.capital_sizing_decision_json) as BuyCapitalSizingDecision;
    if (capitalSizing.calculatedAmountMicros === null) return { status: "NOT_ELIGIBLE" };
    const amountPolicy = rules.smallFollowBuyPolicyEnabled
      ? applyBuyAmountPolicy({
        calculatedAmountMicros: BigInt(capitalSizing.calculatedAmountMicros),
        policyClass: "SMALL_BUY",
        firstEntryMinimumAmountMicros: rules.buyFirstEntryMinimumAmountMicros,
        marketMinimumAmountMicros: requiredAmountMicros,
        marketMinimumAutoLiftCapMicros: rules.buyMarketMinimumAutoLiftCapMicros,
      })
      : applyPriorBuyAmountPolicy({
        calculatedAmountMicros: BigInt(capitalSizing.calculatedAmountMicros),
        minimumLiftEligibility: legacyMinimumLiftEligibility!,
        firstEntryMinimumAmountMicros: rules.buyFirstEntryMinimumAmountMicros,
        marketMinimumAmountMicros: requiredAmountMicros,
        marketMinimumAutoLiftCapMicros: rules.buyMarketMinimumAutoLiftCapMicros,
      });
    const finalAmount = BigInt(amountPolicy.finalAmountMicros);
    const currentAmount = BigInt(execution.requested_amount_micros ?? "0");
    if (finalAmount <= currentAmount) return { status: "NOT_ELIGIBLE" };
    const walletCheck = await this.walletChecks(approval, "BUY", execution.asset_id, finalAmount);
    const riskManager = new RiskManager(this.database, this.sourceVersion);
    let finalRiskDecisionId: string;
    let rejectionReason: string | null = null;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const lockedLegacyEligibility = rules.smallFollowBuyPolicyEnabled
        ? null
        : liveBuyMinimumLiftEligibility(
          this.database,
          execution.live_account_id,
          execution.asset_id,
          execution.live_execution_id,
        );
      if (
        this.wasWaitingBuyReducedByTargetExit(execution.live_execution_id)
        || (rules.smallFollowBuyPolicyEnabled
          ? this.buyPolicyClass(input.signal) !== "SMALL_BUY"
          : lockedLegacyEligibility === "NONE")
      ) {
        this.database.exec("COMMIT");
        return { status: "NOT_ELIGIBLE" };
      }
      const risk = riskManager.evaluate({
        mode: "LIVE",
        accountId: execution.live_account_id,
        signal: input.signal,
        requestedAmountMicros: finalAmount,
        requestedSizeMicros: null,
        capitalSizingDecision: capitalSizing,
        buyAmountPolicyDecision: amountPolicy,
        replacingReservedAmountMicros: currentAmount,
        now: this.now().toISOString(),
      });
      finalRiskDecisionId = risk.riskDecisionId;
      rejectionReason = risk.decision === "REJECT"
        ? risk.riskRejectReason ?? "BUY_MARKET_MINIMUM_RISK_REJECTED"
        : !walletCheck.ok ? walletCheck.reason : null;
      if (risk.decision === "ALLOW" && walletCheck.ok) {
        this.store.increaseBuyReservationChecked(execution, finalAmount, {
          walletBalanceMicros: BigInt(walletCheck.balanceMicros),
          walletAllowanceMicros: BigInt(walletCheck.allowanceMicros),
        });
      }
      execution = this.store.updateBuyApproval(execution, {
        riskDecisionId: finalRiskDecisionId,
        finalAmountMicros: finalAmount,
        reason: rejectionReason ?? "BUY_MARKET_MINIMUM_AUTO_LIFTED",
        policyEvidenceHash: amountPolicy.evidenceHash,
      });
      if (rejectionReason !== null) {
        this.store.rejectPendingExecution(execution, rejectionReason);
        execution = this.store.executionById(execution.live_execution_id)!;
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    if (!walletCheck.ok) return { status: "REJECTED", execution, reason: walletCheck.reason };
    if (rejectionReason !== null) return { status: "REJECTED", execution, reason: rejectionReason };
    const effectiveInput = { ...input, riskDecisionId: finalRiskDecisionId! };
    const finalApproval = this.approvedRiskDecision(effectiveInput, "BUY", "TARGET_BUY");
    if (typeof finalApproval === "string") throw new Error(`LIVE_BUY_AUTO_LIFT_APPROVAL_INVALID:${finalApproval}`);
    return {
      status: "LIFTED",
      execution,
      approval: finalApproval,
      walletCheck,
      effectiveInput,
    };
  }

  private async walletChecks(
    approval: ApprovedRiskDecisionRow,
    side: LiveOrderSide,
    assetId: string,
    requiredOverride?: bigint,
  ): Promise<WalletCheckResult> {
    const registered = this.database.prepare(
      `SELECT w.wallet_address,a.authorized_signer_address
       FROM live_accounts a
       JOIN live_wallets w ON w.live_wallet_id=a.live_wallet_id
       WHERE a.live_account_id=?`,
    ).get(approval.account_id) as {
      wallet_address: string;
      authorized_signer_address: string | null;
    } | undefined;
    if (!registered) return { ok: false, reason: "LIVE_ACCOUNT_WALLET_BINDING_MISSING" };
    let registeredWalletAddress: string;
    let authorizedSignerAddress: string;
    try {
      registeredWalletAddress = normalizedEvmAddress(registered.wallet_address, "LIVE_ACCOUNT_WALLET_ADDRESS_INVALID");
      if (registered.authorized_signer_address === null) {
        return { ok: false, reason: "LIVE_ACCOUNT_AUTHORIZED_SIGNER_MISSING" };
      }
      authorizedSignerAddress = normalizedEvmAddress(
        registered.authorized_signer_address,
        "LIVE_ACCOUNT_AUTHORIZED_SIGNER_INVALID",
      );
      const [providerAddress, signerAddress] = await Promise.all([
        withExternalTimeout("WALLET_ADDRESS", this.externalCallTimeoutMs, () => this.walletProvider.getAddress()),
        withExternalTimeout("SIGNER_ADDRESS", this.externalCallTimeoutMs, () => this.signer.address()),
      ]);
      if (normalizedEvmAddress(providerAddress, "WALLET_PROVIDER_ADDRESS_INVALID") !== registeredWalletAddress) {
        return { ok: false, reason: "WALLET_PROVIDER_ACCOUNT_MISMATCH" };
      }
      if (normalizedEvmAddress(signerAddress, "SIGNER_ADDRESS_INVALID") !== authorizedSignerAddress) {
        return { ok: false, reason: "SIGNER_ACCOUNT_MISMATCH" };
      }
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : "LIVE_ACCOUNT_IDENTITY_CHECK_FAILED" };
    }
    const status = await withExternalTimeout(
      "WALLET_STATUS",
      this.externalCallTimeoutMs,
      () => this.walletProvider.getStatus(),
    );
    if (status.status !== "ACTIVE") return { ok: false, reason: status.reason ?? "WALLET_DISABLED" };
    const balance = await withExternalTimeout(
      side === "BUY" ? "WALLET_BALANCE" : "OUTCOME_BALANCE",
      this.externalCallTimeoutMs,
      () => side === "BUY" ? this.walletProvider.getBalance() : this.walletProvider.getOutcomeBalance(assetId),
    );
    if (balance.status !== "AVAILABLE" || balance.balanceMicros === null) {
      return { ok: false, reason: balance.reason ?? (side === "BUY" ? "WALLET_BALANCE_UNAVAILABLE" : "OUTCOME_BALANCE_UNAVAILABLE") };
    }
    const allowance = await withExternalTimeout(
      side === "BUY" ? "WALLET_ALLOWANCE" : "OUTCOME_ALLOWANCE",
      this.externalCallTimeoutMs,
      () => side === "BUY" ? this.walletProvider.getAllowance() : this.walletProvider.getOutcomeAllowance(assetId),
    );
    if (allowance.status !== "AVAILABLE" || allowance.allowanceMicros === null) {
      return { ok: false, reason: allowance.reason ?? (side === "BUY" ? "ALLOWANCE_UNAVAILABLE" : "OUTCOME_ALLOWANCE_UNAVAILABLE") };
    }
    const required = requiredOverride
      ?? BigInt(side === "BUY" ? approval.requested_amount_micros! : approval.requested_size_micros!);
    if (BigInt(balance.balanceMicros) < required) {
      return { ok: false, reason: side === "BUY" ? "WALLET_BALANCE_INSUFFICIENT" : "OUTCOME_BALANCE_INSUFFICIENT" };
    }
    if (BigInt(allowance.allowanceMicros) < required) {
      return { ok: false, reason: side === "BUY" ? "ALLOWANCE_INSUFFICIENT" : "OUTCOME_ALLOWANCE_INSUFFICIENT" };
    }
    return {
      ok: true,
      balanceMicros: balance.balanceMicros,
      allowanceMicros: allowance.allowanceMicros,
      registeredWalletAddress,
      authorizedSignerAddress,
    };
  }

  private async buildOrderRequest(
    input: ExecutorSignalInput,
    execution: ReturnType<LiveStore["createExecution"]>,
    side: LiveOrderSide,
    approval: ApprovedRiskDecisionRow,
    plan: LiveMarketPlan,
    walletIdentity: Extract<WalletCheckResult, { ok: true }>,
  ): Promise<LiveOrderRequest> {
    const approvedBudgetMicros = side === "BUY"
      ? approval.requested_amount_micros!
      : plan.orderMatch.filledNotionalMicros;
    const plannedAmountMicros = plan.orderMatch.filledNotionalMicros;
    const plannedSizeMicros = plan.orderMatch.filledSizeMicros;
    let amountMicros = plannedAmountMicros;
    let sizeMicros = plannedSizeMicros;
    if (BigInt(sizeMicros) <= 0n) throw new Error("APPROVED_ORDER_SIZE_INVALID");
    if (
      plan.fee.status !== "AVAILABLE"
      || plan.fee.baseFee === null
      || !Number.isSafeInteger(plan.fee.baseFee)
      || plan.fee.baseFee < 0
      || plan.fee.exponent === null
      || !Number.isSafeInteger(plan.fee.exponent)
      || plan.fee.exponent < 1
    ) throw new Error("APPROVED_ORDER_FEE_EVIDENCE_INVALID");
    const feeRateBps = plan.fee.baseFee;
    const feeExponent = plan.fee.exponent;
    const executionRules = registeredExecutionRules(this.database, execution.ruleset_hash);
    if (!executionRules) throw new Error("EXECUTION_RULESET_NOT_REGISTERED");
    const attempt = this.store.nextOrderAttempt(execution.live_execution_id);
    const liveOrderId = `live-order-${execution.live_execution_id}-${attempt}`;
    const idempotencyKey = liveOrderIdempotencyKey(
      execution.live_execution_id,
      side,
      input.signal.assetId,
      plan.limitPriceUnits,
      sizeMicros,
      attempt,
    );
    const signedPayload = await withExternalTimeout(
      "SIGN_ORDER",
      this.externalCallTimeoutMs,
      () => this.signer.signOrder({
        signalId: input.signal.signalId,
        riskDecisionId: input.riskDecisionId,
        side,
        assetId: input.signal.assetId,
        conditionId: input.signal.conditionId,
        priceUnits: plan.limitPriceUnits,
        sizeMicros,
        amountMicros,
        budgetMicros: approvedBudgetMicros,
        makerAddress: walletIdentity.registeredWalletAddress,
        signerAddress: walletIdentity.authorizedSignerAddress,
        feeRateBps: feeRateBps.toString(),
        feeExponent,
        feeModelVersion: executionRules.feeModelVersion,
        idempotencyKey,
      }),
    );
    if ((signedPayload.orderAmountMicros === undefined) !== (signedPayload.orderSizeMicros === undefined)) {
      throw new Error("SIGNED_ORDER_AMOUNT_EVIDENCE_INCOMPLETE");
    }
    if (signedPayload.signedOrder) {
      amountMicros = side === "BUY"
        ? signedPayload.signedOrder.makerAmount
        : signedPayload.signedOrder.takerAmount;
      sizeMicros = side === "BUY"
        ? signedPayload.signedOrder.takerAmount
        : signedPayload.signedOrder.makerAmount;
    } else if (signedPayload.orderAmountMicros !== undefined && signedPayload.orderSizeMicros !== undefined) {
      amountMicros = signedPayload.orderAmountMicros;
      sizeMicros = signedPayload.orderSizeMicros;
    }
    if (!/^\d+$/.test(amountMicros) || !/^\d+$/.test(sizeMicros) || BigInt(amountMicros) <= 0n || BigInt(sizeMicros) <= 0n) {
      throw new Error("SIGNED_ORDER_AMOUNT_INVALID");
    }
    const signedAmount = BigInt(amountMicros);
    const signedSize = BigInt(sizeMicros);
    if (signedSize > BigInt(plannedSizeMicros)) throw new Error("SIGNED_ORDER_SIZE_EXCEEDS_EXECUTION_PLAN");
    if (signedAmount > signedSize) throw new Error("SIGNED_ORDER_PRICE_ABOVE_ONE");
    const plannedLimitNumerator = BigInt(plan.limitPriceUnits) * signedSize;
    const signedPriceNumerator = signedAmount * PRICE_SCALE;
    const signedOrderMatchesPlan = signedAmount === BigInt(plannedAmountMicros)
      && signedSize === BigInt(plannedSizeMicros);
    if (side === "BUY" && !signedOrderMatchesPlan && signedPriceNumerator > plannedLimitNumerator) {
      throw new Error("SIGNED_ORDER_BUY_PRICE_EXCEEDS_LIMIT");
    }
    if (side === "SELL" && signedPriceNumerator < plannedLimitNumerator) {
      throw new Error("SIGNED_ORDER_SELL_PRICE_BELOW_LIMIT");
    }
    if (side === "BUY" && signedAmount > BigInt(plannedAmountMicros)) {
      throw new Error("SIGNED_ORDER_NOTIONAL_EXCEEDS_EXECUTION_PLAN");
    }
    if (side === "BUY" && BigInt(amountMicros) > BigInt(approvedBudgetMicros)) {
      throw new Error("SIGNED_ORDER_NOTIONAL_EXCEEDS_RISK_BUDGET");
    }
    if (normalizedEvmAddress(signedPayload.signerAddress, "SIGNED_PAYLOAD_SIGNER_INVALID")
      !== walletIdentity.authorizedSignerAddress) {
      throw new Error("SIGNED_PAYLOAD_SIGNER_NOT_AUTHORIZED");
    }
    if (this.signer.signerType === "LIVE") {
      if (!signedPayload.signedOrder) throw new Error("LIVE_SIGNER_SDK_ORDER_REQUIRED");
      if (!signedPayload.maxTotalCostMicros || !signedPayload.feeModelVersion) {
        throw new Error("LIVE_SIGNER_FEE_BUDGET_EVIDENCE_REQUIRED");
      }
      if (signedPayload.feeModelVersion !== executionRules.feeModelVersion) {
        throw new Error("SIGNED_ORDER_FEE_MODEL_VERSION_MISMATCH");
      }
    }
    if (signedPayload.maxTotalCostMicros !== undefined) {
      if (!/^\d+$/.test(signedPayload.maxTotalCostMicros)) throw new Error("SIGNED_ORDER_MAX_COST_INVALID");
      const maxCost = BigInt(signedPayload.maxTotalCostMicros);
      const independentlyDerivedTotal = side === "BUY"
        ? signedAmount + conservativeClobBuyFeeMicros({
          sizeMicros: signedSize,
          upperPriceUnits: BigInt(plan.limitPriceUnits),
          feeRateBps: BigInt(feeRateBps),
          feeExponent,
        })
        : signedAmount;
      if (independentlyDerivedTotal > BigInt(approvedBudgetMicros)) {
        throw new Error("SIGNED_ORDER_TOTAL_COST_EXCEEDS_RISK_BUDGET");
      }
      if (maxCost < independentlyDerivedTotal) {
        throw new Error("SIGNED_ORDER_MAX_COST_UNDERSTATES_DERIVED_FEE");
      }
      if (maxCost > BigInt(approvedBudgetMicros)) {
        throw new Error("SIGNED_ORDER_MAX_COST_OUT_OF_BUDGET");
      }
    } else if (side === "BUY") {
      const independentlyDerivedTotal = signedAmount + conservativeClobBuyFeeMicros({
        sizeMicros: signedSize,
        upperPriceUnits: BigInt(plan.limitPriceUnits),
        feeRateBps: BigInt(feeRateBps),
        feeExponent,
      });
      if (independentlyDerivedTotal > BigInt(approvedBudgetMicros)) {
        throw new Error("SIGNED_ORDER_TOTAL_COST_EXCEEDS_RISK_BUDGET");
      }
    }
    return {
      liveOrderId,
      // Keep the exact key the signer saw. A fee-aware signer may safely
      // reduce size/notional, but it must not silently move the durable intent
      // into a different idempotency domain after signing.
      idempotencyKey,
      marketId: input.signal.conditionId,
      conditionId: input.signal.conditionId,
      assetId: input.signal.assetId,
      side,
      orderType: "FAK",
      priceUnits: plan.limitPriceUnits,
      quoteVwapPriceUnits: plan.match.vwapPriceUnits!,
      sizeMicros,
      amountMicros,
      budgetMicros: approvedBudgetMicros,
      registeredWalletAddress: walletIdentity.registeredWalletAddress,
      authorizedSignerAddress: walletIdentity.authorizedSignerAddress,
      feeRateBps: feeRateBps.toString(),
      feeExponent,
      feeModelVersion: executionRules.feeModelVersion,
      signedPayload,
    };
  }

  private approvedRiskDecision(
    input: ExecutorSignalInput,
    side: LiveOrderSide,
    executionType: "TARGET_BUY" | "TARGET_SELL" | "STOP_LOSS",
  ): ApprovedRiskDecisionRow | string {
    const row = this.database.prepare(
      `SELECT risk_decision_id,executor_mode,paper_account_id,account_id,signal_id,context_id,decision,
              requested_amount_micros,requested_size_micros,ruleset_hash,risk_reason,checks_json
       FROM risk_decisions WHERE risk_decision_id=?`,
    ).get(input.riskDecisionId) as ApprovedRiskDecisionRow | undefined;
    if (!row) return "RISK_DECISION_NOT_FOUND";
    if (row.decision !== "ALLOW") return "RISK_DECISION_NOT_ALLOW";
    if (row.executor_mode !== "LIVE") return "RISK_EXECUTOR_MODE_MISMATCH";
    if (row.paper_account_id !== null) return "RISK_PAPER_ACCOUNT_ANCHOR_FORBIDDEN";
    if (row.account_id !== input.accountId) return "RISK_ACCOUNT_MISMATCH";
    if (row.signal_id !== input.signal.signalId) return "RISK_SIGNAL_MISMATCH";
    if (row.context_id !== input.context.contextId) return "RISK_CONTEXT_MISMATCH";
    if (row.ruleset_hash !== input.context.rulesetHash) return "RISK_RULESET_MISMATCH";
    if (executionType === "STOP_LOSS" && row.risk_reason !== "STOP_LOSS_TRIGGERED") {
      return "STOP_LOSS_RISK_REASON_MISMATCH";
    }
    if (side === "BUY") {
      if (row.requested_amount_micros === null || BigInt(row.requested_amount_micros) <= 0n) {
        return "RISK_APPROVED_BUY_AMOUNT_INVALID";
      }
    } else if (row.requested_size_micros === null || BigInt(row.requested_size_micros) <= 0n) {
      let targetExitSupersession = false;
      try {
        const checks = JSON.parse(row.checks_json) as Array<{
          name?: unknown;
          result?: unknown;
        }>;
        targetExitSupersession = executionType === "TARGET_SELL"
          && checks.some((check) => check.name === "target_exit_supersession" && check.result === "PASS");
      } catch {
        return "RISK_CHECKS_JSON_INVALID";
      }
      if (!targetExitSupersession) return "RISK_APPROVED_SELL_SIZE_INVALID";
    }
    return row;
  }

  private approvedRedeemRisk(
    riskDecisionId: string,
    settlement: LiveSettlementRecord & {
      live_account_id: string;
      signal_id: string | null;
      current_size_micros: string;
      ruleset_hash: string;
    },
  ): ApprovedRiskDecisionRow | string {
    const row = this.database.prepare(
      `SELECT risk_decision_id,executor_mode,paper_account_id,account_id,signal_id,context_id,decision,
              requested_amount_micros,requested_size_micros,ruleset_hash,risk_reason
       FROM risk_decisions WHERE risk_decision_id=?`,
    ).get(riskDecisionId) as (ApprovedRiskDecisionRow & { risk_reason: string | null }) | undefined;
    if (!row) return "REDEEM_RISK_DECISION_NOT_FOUND";
    if (row.decision !== "ALLOW") return "REDEEM_RISK_DECISION_NOT_ALLOW";
    if (row.executor_mode !== "LIVE") return "REDEEM_RISK_EXECUTOR_MODE_MISMATCH";
    if (row.paper_account_id !== null) return "REDEEM_RISK_PAPER_ACCOUNT_ANCHOR_FORBIDDEN";
    if (row.account_id !== settlement.live_account_id) return "REDEEM_RISK_ACCOUNT_MISMATCH";
    if (row.risk_reason !== "REDEEM_CONFIRMED") return "REDEEM_RISK_REASON_MISMATCH";
    if (row.ruleset_hash !== settlement.ruleset_hash) return "REDEEM_RISK_RULESET_MISMATCH";
    if (row.signal_id !== null || row.context_id !== null) return "REDEEM_RISK_SCOPE_MISMATCH";
    if (row.requested_amount_micros !== settlement.redeem_amount_micros) return "REDEEM_RISK_AMOUNT_MISMATCH";
    if (row.requested_size_micros !== settlement.current_size_micros) return "REDEEM_RISK_SIZE_MISMATCH";
    return row;
  }

  private validateSubmitResult(
    accountId: string,
    request: LiveOrderRequest,
    submit: OrderSubmitResult,
  ): void {
    const availableSellSize = request.side === "SELL"
      ? this.store.openPositions(accountId, request.assetId)
        .reduce((total, position) => total + BigInt(position.current_size_micros), 0n)
        .toString()
      : null;
    validateLiveOrderFills({
      adapterType: this.orderAdapter.adapterType,
      side: request.side,
      status: submit.status,
      fills: submit.fills,
      requestedSizeMicros: request.sizeMicros,
      limitPriceUnits: request.priceUnits,
      buyBudgetMicros: request.side === "BUY" ? request.budgetMicros : null,
      availableSellSizeMicros: availableSellSize,
    });
  }

  private rejectWithoutGate(input: ExecutorSignalInput, side: LiveOrderSide, reason: string): ExecutorExecutionResult {
    const executionIdempotencyKey = liveExecutionIdempotencyKey(input.accountId, input.signal.signalId);
    return this.reject(input, side, executionIdempotencyKey, null, reason);
  }

  private reject(
    input: ExecutorSignalInput,
    side: LiveOrderSide,
    executionIdempotencyKey: string,
    liveGateRunId: string | null,
    reason: string,
    executionType: "TARGET_BUY" | "TARGET_SELL" | "STOP_LOSS" = side === "BUY" ? "TARGET_BUY" : "TARGET_SELL",
  ): ExecutorExecutionResult {
    const execution = this.store.createExecution({
      liveAccountId: input.accountId,
      signalId: input.signal.signalId,
      contextId: input.context.contextId,
      riskDecisionId: input.riskDecisionId,
      liveGateRunId,
      executionIdempotencyKey,
      executionType,
      state: "REJECTED",
      assetId: input.signal.assetId,
      conditionId: input.signal.conditionId,
      requestedAmountMicros: side === "BUY" ? notionalMicros(input.signal.targetPriceUnits, input.signal.targetSizeMicros).toString() : null,
      requestedSizeMicros: input.signal.targetSizeMicros,
      targetPriceUnits: input.signal.targetPriceUnits,
      reason,
      rulesetHash: input.context.rulesetHash,
    });
    return { mode: "LIVE", executionId: execution.live_execution_id, state: execution.state };
  }

  private liveGateRunExists(runId: string): boolean {
    return this.database.prepare("SELECT 1 ok FROM live_gate_runs WHERE live_gate_run_id=?").get(runId) !== undefined;
  }

  private productionGateRunFailure(
    runId: string,
    input: Parameters<LiveExecutionGate["checkExecution"]>[0],
  ): string | null {
    return this.productionPersistedGateRunFailure(
      runId,
      input.signalId,
      input.riskDecisionId,
      input.rulesetHash,
    );
  }

  private productionAccountActionGateRunFailure(
    runId: string,
    riskDecisionId: string,
    rulesetHash: string,
  ): string | null {
    return this.productionPersistedGateRunFailure(runId, null, riskDecisionId, rulesetHash);
  }

  private productionPersistedGateRunFailure(
    runId: string,
    signalId: string | null,
    riskDecisionId: string,
    rulesetHash: string,
  ): string | null {
    if (this.environment !== "PRODUCTION") return null;
    const row = this.database.prepare(
      `SELECT run_type,allowed,execution_mode,live_gate_state,signal_id,risk_decision_id,
              ruleset_hash,source_code_commit,source_code_dirty
       FROM live_gate_runs WHERE live_gate_run_id=?`,
    ).get(runId) as {
      run_type: string;
      allowed: number;
      execution_mode: string | null;
      live_gate_state: string | null;
      signal_id: string | null;
      risk_decision_id: string | null;
      ruleset_hash: string | null;
      source_code_commit: string;
      source_code_dirty: number;
    } | undefined;
    if (!row) return "LIVE_GATE_ALLOWED_RUN_NOT_PERSISTED";
    if (
      row.run_type !== "EXECUTION_CHECK"
      || row.allowed !== 1
      || row.execution_mode !== "LIVE"
      || row.live_gate_state !== "LIVE_ACTIVE"
      || row.signal_id !== signalId
      || row.risk_decision_id !== riskDecisionId
      || row.ruleset_hash !== rulesetHash
      || row.source_code_commit !== this.sourceVersion.commit
      || row.source_code_dirty !== 0
    ) return "LIVE_GATE_ALLOWED_RUN_ATTESTATION_MISMATCH";
    return null;
  }

  private async serializeAccount<T>(accountId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.accountQueues.get(accountId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.catch(() => undefined).then(() => current);
    this.accountQueues.set(accountId, queued);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.accountQueues.get(accountId) === queued) this.accountQueues.delete(accountId);
    }
  }
}

export class LiveExecutorPlaceholder implements ExecutorInterface {
  readonly mode = "LIVE" as const;

  async executeBuy(_input: ExecutorSignalInput): Promise<ExecutorExecutionResult> {
    throw new Error("LIVE_EXECUTOR_NOT_IMPLEMENTED");
  }

  async executeSell(_input: ExecutorSignalInput): Promise<ExecutorExecutionResult> {
    throw new Error("LIVE_EXECUTOR_NOT_IMPLEMENTED");
  }

  async cancelExecution(_executionId: string, _reason: string): Promise<void> {
    throw new Error("LIVE_EXECUTOR_NOT_IMPLEMENTED");
  }

  async getPosition(_query: ExecutorPositionQuery): Promise<unknown> {
    throw new Error("LIVE_EXECUTOR_NOT_IMPLEMENTED");
  }

  async getBalance(_query: ExecutorBalanceQuery): Promise<PaperAccountSnapshot> {
    throw new Error("LIVE_EXECUTOR_NOT_IMPLEMENTED");
  }

  async reconcile(_input: ExecutorReconcileInput): Promise<ExecutorReconcileResult> {
    return { mode: "LIVE", frozenPositionCount: 0, reason: "LIVE_EXECUTOR_DISABLED" };
  }
}
