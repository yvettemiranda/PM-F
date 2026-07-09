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
import type { PaperAccountSnapshot } from "../paper/types.js";
import { RULESET_HASH } from "../domain/versioning.js";
import { resolveSourceVersion, type SourceVersion } from "../infra/source-version.js";
import { DisabledOrderAdapter } from "./disabled-order-adapter.js";
import { DisabledRedeemAdapter } from "./disabled-redeem-adapter.js";
import { DisabledSigner } from "./disabled-signer.js";
import { DisabledWalletProvider } from "./disabled-wallet-provider.js";
import type { OrderAdapter } from "./order-adapter.js";
import type { RedeemAdapter } from "./redeem-adapter.js";
import type { Signer } from "./signer.js";
import type { WalletProvider } from "./wallet-provider.js";
import { LiveCrashRecovery } from "./live-crash-recovery.js";
import { LiveReconciliation } from "./live-reconciliation.js";
import {
  cancelIdempotencyKey,
  liveExecutionIdempotencyKey,
  liveOrderIdempotencyKey,
  LiveStore,
  redeemIdempotencyKey,
  type LiveExecutionRow,
} from "./live-store.js";
import type { LiveExecutionGate, LiveExecutionState, LiveOrderRequest, LiveOrderSide } from "./live-types.js";

const PRICE_SCALE = 1_000_000_000_000_000_000n;

export interface LiveExecutorOptions {
  databasePath: string;
  liveGate: LiveExecutionGate;
  orderAdapter?: OrderAdapter;
  walletProvider?: WalletProvider;
  signer?: Signer;
  redeemAdapter?: RedeemAdapter;
  sourceVersion?: SourceVersion;
  now?: () => Date;
}

function notionalMicros(priceUnits: string, sizeMicros: string): bigint {
  return (BigInt(priceUnits) * BigInt(sizeMicros)) / PRICE_SCALE;
}

function executionStateFromOrder(status: string): LiveExecutionState {
  if (status === "FILLED") return "EXECUTED";
  if (status === "PARTIALLY_FILLED") return "PARTIALLY_EXECUTED";
  if (status === "CANCELLED") return "CANCELLED";
  if (status === "EXPIRED") return "EXPIRED";
  if (status === "FAILED") return "FAILED";
  return "WAITING_EXECUTION";
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

  constructor(private readonly options: LiveExecutorOptions) {
    this.database = new DatabaseSync(options.databasePath);
    this.database.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;");
    this.now = options.now ?? (() => new Date());
    this.sourceVersion = options.sourceVersion ?? resolveSourceVersion();
    this.orderAdapter = options.orderAdapter ?? new DisabledOrderAdapter();
    this.walletProvider = options.walletProvider ?? new DisabledWalletProvider();
    this.signer = options.signer ?? new DisabledSigner();
    this.redeemAdapter = options.redeemAdapter ?? new DisabledRedeemAdapter();
    this.store = new LiveStore(this.database, this.sourceVersion, this.now);
    this.reconciliation = new LiveReconciliation(this.database, this.store);
    this.recovery = new LiveCrashRecovery(this.orderAdapter, this.reconciliation, this.store);
  }

  async executeBuy(input: ExecutorSignalInput): Promise<ExecutorExecutionResult> {
    return this.executeSignal(input, "BUY");
  }

  async executeSell(input: ExecutorSignalInput): Promise<ExecutorExecutionResult> {
    return this.executeSignal(input, "SELL");
  }

  async cancelExecution(executionId: string, reason: string): Promise<void> {
    const order = this.database.prepare(
      `SELECT live_order_id,external_order_id,status FROM live_orders
       WHERE live_execution_id=? ORDER BY created_at DESC LIMIT 1`,
    ).get(executionId) as { live_order_id: string; external_order_id: string | null; status: string } | undefined;
    if (!order?.external_order_id) throw new Error("LIVE_ORDER_NOT_CANCELABLE");
    const idempotencyKey = cancelIdempotencyKey(order.external_order_id, reason);
    const now = this.now().toISOString();
    this.store.transition("LIVE_ORDER", order.live_order_id, order.status, "CANCEL_PENDING", reason, RULESET_HASH, now);
    const result = await this.orderAdapter.cancelOrder(order.external_order_id, idempotencyKey);
    this.database.prepare("UPDATE live_orders SET status=?,raw_response_json=?,updated_at=? WHERE live_order_id=?")
      .run(result.status, JSON.stringify(result.raw), now, order.live_order_id);
    this.store.transition("LIVE_ORDER", order.live_order_id, "CANCEL_PENDING", result.status, reason, RULESET_HASH, now);
    this.store.updateExecutionState(executionId, result.cancelled ? "CANCELLED" : "FAILED", reason, RULESET_HASH);
    this.store.audit("LIVE_ORDER", order.live_order_id, "cancel", reason, { externalOrderId: order.external_order_id, result });
  }

  async getPosition(query: ExecutorPositionQuery): Promise<unknown> {
    if (query.positionId) {
      return this.database.prepare("SELECT * FROM live_positions WHERE live_position_id=?").get(query.positionId) ?? null;
    }
    if (query.assetId) {
      return this.store.openPositions(query.accountId, query.assetId);
    }
    return this.database.prepare("SELECT * FROM live_positions WHERE live_account_id=? ORDER BY created_at")
      .all(query.accountId);
  }

  async getBalance(query: ExecutorBalanceQuery): Promise<PaperAccountSnapshot> {
    const balance = await this.walletProvider.getBalance();
    const cash = balance.balanceMicros ?? "0";
    return {
      paperAccountId: query.accountId,
      initialBalanceMicros: cash,
      cashBalanceMicros: cash,
      reservedBalanceMicros: "0",
      availableBalanceMicros: cash,
      positionValueMicros: "0",
      realizedPnlMicros: "0",
      unrealizedPnlMicros: "0",
      totalEquityMicros: cash,
      valuationStatus: balance.status === "AVAILABLE" ? "COMPLETE" : "INCOMPLETE",
      unpricedPositionCount: 0,
      priceSource: "ORDERBOOK_EXIT_VWAP",
      priceTimestamp: this.now().toISOString(),
    };
  }

  async reconcile(input: ExecutorReconcileInput): Promise<ExecutorReconcileResult> {
    const result = this.reconciliation.run(input.accountId);
    const frozenPositionCount = result.passed ? 0 : this.store.freezeOpenPositions(input.accountId, input.reason);
    this.store.updateCheckpoint(input.accountId, { reconciliationRunId: result.runId });
    return { mode: "LIVE", frozenPositionCount, reason: result.passed ? "LIVE_RECONCILED" : "LIVE_RECONCILIATION_FAILED" };
  }

  async recoverOnStartup(accountId: string): Promise<{ passed: boolean; reason: string; recoveryRunId: string }> {
    return this.recovery.recover(accountId);
  }

  async emergencyStop(accountId: string, reason: string): Promise<void> {
    const openOrders = this.database.prepare(
      `SELECT live_execution_id FROM live_executions
       WHERE live_account_id=? AND state IN ('WAITING_EXECUTION','PARTIALLY_EXECUTED','EXIT_PENDING','STOP_EXIT_PENDING')`,
    ).all(accountId) as unknown as Array<{ live_execution_id: string }>;
    for (const order of openOrders) {
      try {
        await this.cancelExecution(order.live_execution_id, `EMERGENCY_STOP:${reason}`);
      } catch (error) {
        this.store.audit("LIVE_EXECUTION", order.live_execution_id, "emergency_cancel_failed", reason, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    this.store.freezeOpenPositions(accountId, `EMERGENCY_STOP:${reason}`);
    this.store.audit("LIVE_ACCOUNT", accountId, "emergency_stop", reason, {});
  }

  async redeemPosition(positionId: string): Promise<{ status: string }> {
    const position = this.database.prepare("SELECT * FROM live_positions WHERE live_position_id=?")
      .get(positionId) as { live_position_id: string; condition_id: string; asset_id: string; status: string } | undefined;
    if (!position) throw new Error("LIVE_POSITION_NOT_FOUND");
    const idempotencyKey = redeemIdempotencyKey(position.live_position_id, position.condition_id, position.asset_id);
    const result = await this.redeemAdapter.redeem({
      positionId,
      conditionId: position.condition_id,
      assetId: position.asset_id,
      idempotencyKey,
    });
    const now = this.now().toISOString();
    this.database.prepare(
      `INSERT OR IGNORE INTO live_redeems(
        live_redeem_id,live_position_id,redeem_idempotency_key,status,adapter_type,
        raw_response_json,created_at,updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      `redeem-${positionId}`,
      positionId,
      idempotencyKey,
      result.status,
      result.adapterType,
      JSON.stringify(result.raw),
      now,
      now,
    );
    this.store.audit("LIVE_REDEEM", positionId, "redeem_attempt", result.status, result.raw);
    return { status: result.status };
  }

  close(): void {
    this.database.close();
  }

  private async executeSignal(input: ExecutorSignalInput, side: LiveOrderSide): Promise<ExecutorExecutionResult> {
    if (!input.signal.context) {
      return this.rejectWithoutGate(input, side, "EXECUTION_CONTEXT_MISSING");
    }
    const rulesetHash = input.signal.context.rulesetHash;
    const executionIdempotencyKey = liveExecutionIdempotencyKey(input.accountId, input.signal.signalId, input.riskDecisionId);
    const gate = await this.options.liveGate.checkExecution({
      signalId: input.signal.signalId,
      riskDecisionId: input.riskDecisionId,
      rulesetHash,
    });
    const liveGateRunId = this.liveGateRunExists(gate.runId) ? gate.runId : null;
    if (!gate.allowed) {
      return this.reject(input, side, executionIdempotencyKey, liveGateRunId, `LIVE_GATE_BLOCKED:${gate.blockedReasons.join(",")}`);
    }
    const reconciliation = this.reconciliation.run(input.accountId);
    if (!reconciliation.passed) {
      this.store.freezeOpenPositions(input.accountId, "LIVE_RECONCILIATION_FAILED");
      return this.reject(input, side, executionIdempotencyKey, liveGateRunId, "LIVE_RECONCILIATION_FAILED");
    }
    const walletCheck = await this.walletChecks(input, side);
    if (walletCheck !== "OK") {
      return this.reject(input, side, executionIdempotencyKey, liveGateRunId, walletCheck);
    }
    if (this.orderAdapter.adapterType === "DISABLED") {
      return this.reject(input, side, executionIdempotencyKey, liveGateRunId, "ORDER_ADAPTER_DISABLED");
    }
    if (this.signer.signerType === "DISABLED") {
      return this.reject(input, side, executionIdempotencyKey, liveGateRunId, "SIGNER_DISABLED");
    }

    const existing = this.store.existingExecution(executionIdempotencyKey);
    if (existing) return { mode: "LIVE", executionId: existing.live_execution_id, state: existing.state };

    const request = await this.buildOrderRequest(input, side);
    const execution = this.store.createExecution({
      liveAccountId: input.accountId,
      signalId: input.signal.signalId,
      contextId: input.context.contextId,
      riskDecisionId: input.riskDecisionId,
      liveGateRunId,
      executionIdempotencyKey,
      executionType: side === "BUY" ? "TARGET_BUY" : "TARGET_SELL",
      state: "WAITING_EXECUTION",
      assetId: input.signal.assetId,
      conditionId: input.signal.conditionId,
      requestedAmountMicros: request.amountMicros,
      requestedSizeMicros: request.sizeMicros,
      targetPriceUnits: input.signal.targetPriceUnits,
      reason: "LIVE_EXECUTION_ACCEPTED",
      rulesetHash,
    });

    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.store.createOrder(request, execution.live_execution_id, this.orderAdapter.adapterType);
      if (side === "BUY") this.store.reserve(execution, BigInt(request.amountMicros));
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }

    try {
      this.store.recordOrderAttempt({
        liveOrderId: request.liveOrderId,
        sequence: 1,
        action: "SUBMIT",
        status: "STARTED",
        errorReason: null,
        request: { side, assetId: request.assetId, sizeMicros: request.sizeMicros },
        response: {},
      });
      const submit = await this.orderAdapter.submitOrder(request);
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
          this.store.recordFill({ execution, liveOrderId: request.liveOrderId, side, fill });
          if (side === "BUY") this.store.applyBuyFill(execution, fill);
          else this.store.applySellFill(execution, fill);
        }
        if (side === "BUY") this.store.releaseReservation(execution, request.liveOrderId, BigInt(request.amountMicros), "FAK_REMAINDER_RELEASE");
        this.store.updateExecutionTotals(execution.live_execution_id);
        this.store.updateExecutionState(execution.live_execution_id, executionStateFromOrder(submit.status), "ORDER_SUBMIT_RESULT", rulesetHash);
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
      this.store.recordOrderAttempt({
        liveOrderId: request.liveOrderId,
        sequence: 1,
        action: "SUBMIT",
        status: "FAILED",
        errorReason: reason,
        request: { side, assetId: request.assetId, sizeMicros: request.sizeMicros },
        response: { error: reason },
      });
      this.store.updateExecutionState(execution.live_execution_id, "FAILED", reason, rulesetHash);
      if (side === "BUY") this.store.releaseReservation(execution, request.liveOrderId, BigInt(request.amountMicros), "ORDER_SUBMIT_FAILED");
      return { mode: "LIVE", executionId: execution.live_execution_id, state: "FAILED" };
    }
  }

  private async walletChecks(input: ExecutorSignalInput, side: LiveOrderSide): Promise<string> {
    const status = await this.walletProvider.getStatus();
    if (status.status !== "ACTIVE") return status.reason ?? "WALLET_DISABLED";
    const balance = await this.walletProvider.getBalance();
    if (balance.status !== "AVAILABLE" || balance.balanceMicros === null) return balance.reason ?? "WALLET_BALANCE_UNAVAILABLE";
    const allowance = await this.walletProvider.getAllowance();
    if (allowance.status !== "AVAILABLE" || allowance.allowanceMicros === null) return allowance.reason ?? "ALLOWANCE_UNAVAILABLE";
    if (side === "BUY") {
      const amount = notionalMicros(input.signal.targetPriceUnits, input.signal.targetSizeMicros);
      if (BigInt(balance.balanceMicros) < amount) return "WALLET_BALANCE_INSUFFICIENT";
      if (BigInt(allowance.allowanceMicros) < amount) return "ALLOWANCE_INSUFFICIENT";
    }
    return "OK";
  }

  private async buildOrderRequest(input: ExecutorSignalInput, side: LiveOrderSide): Promise<LiveOrderRequest> {
    const sizeMicros = side === "BUY" ? input.signal.targetSizeMicros : this.sellSizeMicros(input);
    const amountMicros = notionalMicros(input.signal.targetPriceUnits, sizeMicros).toString();
    const liveOrderId = `live-order-${input.accountId}-${input.signal.signalId}-${side}`;
    const idempotencyKey = liveOrderIdempotencyKey(liveOrderId, side, input.signal.assetId, input.signal.targetPriceUnits, sizeMicros);
    const signedPayload = await this.signer.signOrder({
      signalId: input.signal.signalId,
      riskDecisionId: input.riskDecisionId,
      side,
      assetId: input.signal.assetId,
      conditionId: input.signal.conditionId,
      priceUnits: input.signal.targetPriceUnits,
      sizeMicros,
      idempotencyKey,
    });
    return {
      liveOrderId,
      idempotencyKey,
      marketId: input.signal.conditionId,
      conditionId: input.signal.conditionId,
      assetId: input.signal.assetId,
      side,
      orderType: "FAK",
      priceUnits: input.signal.targetPriceUnits,
      sizeMicros,
      amountMicros,
      signedPayload,
    };
  }

  private sellSizeMicros(input: ExecutorSignalInput): string {
    const open = this.store.openPositions(input.accountId, input.signal.assetId);
    const total = open.reduce((sum, position) => sum + BigInt(position.current_size_micros), 0n);
    const numerator = input.signal.sellRatioNumerator ? BigInt(input.signal.sellRatioNumerator) : null;
    const denominator = input.signal.sellRatioDenominator ? BigInt(input.signal.sellRatioDenominator) : null;
    if (numerator !== null && denominator !== null && denominator > 0n) return ((total * numerator) / denominator).toString();
    return input.signal.targetSizeMicros;
  }

  private rejectWithoutGate(input: ExecutorSignalInput, side: LiveOrderSide, reason: string): ExecutorExecutionResult {
    const executionIdempotencyKey = liveExecutionIdempotencyKey(input.accountId, input.signal.signalId, input.riskDecisionId);
    return this.reject(input, side, executionIdempotencyKey, null, reason);
  }

  private reject(input: ExecutorSignalInput, side: LiveOrderSide, executionIdempotencyKey: string, liveGateRunId: string | null, reason: string): ExecutorExecutionResult {
    const execution = this.store.createExecution({
      liveAccountId: input.accountId,
      signalId: input.signal.signalId,
      contextId: input.context.contextId,
      riskDecisionId: input.riskDecisionId,
      liveGateRunId,
      executionIdempotencyKey,
      executionType: side === "BUY" ? "TARGET_BUY" : "TARGET_SELL",
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
