import { createHash } from "node:crypto";
import type { OrderAdapter, OrderSnapshot } from "./order-adapter.js";
import type { WalletProvider } from "./wallet-provider.js";
import { LiveReconciliation } from "./live-reconciliation.js";
import type { LiveRecoveryOrderRow, LiveStore } from "./live-store.js";
import type { LiveExecutionState, LiveFillEvent, LiveOrderState, LiveReconciliationCheck, OrderStatus } from "./live-types.js";
import { withExternalTimeout } from "./external-timeout.js";
import { validateLiveOrderFills } from "./fill-validation.js";
import { stableJson } from "../domain/versioning.js";
import { validateClobOrderIdentity, validateClobTradeIdentity } from "./clob-order-identity.js";

interface ExternalOrderSnapshot {
  local: LiveRecoveryOrderRow;
  status: OrderStatus;
  fills: LiveFillEvent[];
}

const EXTERNAL_READ_MAX_ATTEMPTS = 2;
const EXTERNAL_READ_RETRY_DELAY_MS = 250;

export interface LiveRecoveryResult {
  passed: boolean;
  reason: string;
  recoveryRunId: string;
}

export interface LiveExternalReconciliationResult {
  passed: boolean;
  reason: string;
  runId: string;
  checks: LiveReconciliationCheck[];
  recoveredOrders: number;
  recoveredFills: number;
  recoveredPositions: number;
}

function executionState(status: LiveOrderState, filledSize: bigint, requestedSize: bigint): LiveExecutionState {
  if (status === "FILLED") return "EXECUTED";
  if (status === "PARTIALLY_FILLED") return "PARTIALLY_EXECUTED";
  if (status === "CANCELLED") {
    return filledSize === requestedSize ? "EXECUTED" : filledSize > 0n ? "PARTIALLY_EXECUTED" : "CANCELLED";
  }
  if (status === "EXPIRED") {
    return filledSize === requestedSize ? "EXECUTED" : filledSize > 0n ? "PARTIALLY_EXECUTED" : "EXPIRED";
  }
  if (status === "FAILED") {
    return filledSize === requestedSize ? "EXECUTED" : filledSize > 0n ? "PARTIALLY_EXECUTED" : "FAILED";
  }
  return "WAITING_EXECUTION";
}

function isTerminal(status: OrderStatus): boolean {
  if (status.terminal !== undefined) return status.terminal;
  return status.confirmationPending !== true
    && ["FILLED", "CANCELLED", "EXPIRED", "FAILED"].includes(status.status);
}

function failureReason(error: unknown): string {
  return error instanceof Error ? error.message : "RECOVERY_UNKNOWN_ERROR";
}

function isRetryableExternalReadFailure(error: unknown): boolean {
  const reason = failureReason(error);
  return reason.startsWith("LIVE_EXTERNAL_TIMEOUT:")
    || /(?:fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|UND_ERR|status code 5\d\d)/i.test(reason);
}

function validateOrderIntentEvidence(order: LiveRecoveryOrderRow): void {
  const required = [
    order.quote_vwap_price_units,
    order.amount_micros,
    order.budget_micros,
    order.registered_wallet_address,
    order.authorized_signer_address,
    order.fee_rate_bps,
    order.fee_model_version,
    order.signed_payload_json,
    order.order_request_sha256,
    order.order_ruleset_hash,
    order.order_source_code_commit,
    order.order_config_version,
  ];
  if (required.some((value) => value === null) || order.fee_exponent === null || order.order_source_code_dirty === null) {
    throw new Error(`RECOVERY_ORDER_INTENT_EVIDENCE_MISSING:${order.live_order_id}`);
  }
  if (order.order_ruleset_hash !== order.execution.ruleset_hash) {
    throw new Error(`RECOVERY_ORDER_RULESET_MISMATCH:${order.live_order_id}`);
  }
  if (
    !/^0x[0-9a-f]{40}$/.test(order.registered_wallet_address!)
    || !/^0x[0-9a-f]{40}$/.test(order.authorized_signer_address!)
    || !/^\d+$/.test(order.amount_micros!)
    || !/^\d+$/.test(order.budget_micros!)
    || !/^\d+$/.test(order.fee_rate_bps!)
    || !Number.isSafeInteger(order.fee_exponent)
    || order.fee_exponent! < 1
  ) throw new Error(`RECOVERY_ORDER_INTENT_EVIDENCE_INVALID:${order.live_order_id}`);
  let signedPayload: unknown;
  try {
    signedPayload = JSON.parse(order.signed_payload_json!);
  } catch {
    throw new Error(`RECOVERY_ORDER_SIGNED_PAYLOAD_INVALID:${order.live_order_id}`);
  }
  const snapshot = stableJson({
    liveOrderId: order.live_order_id,
    idempotencyKey: order.live_order_idempotency_key,
    marketId: order.market_id,
    conditionId: order.condition_id,
    assetId: order.asset_id,
    side: order.side,
    orderType: order.order_type,
    priceUnits: order.price_units,
    quoteVwapPriceUnits: order.quote_vwap_price_units,
    sizeMicros: order.size_micros,
    amountMicros: order.amount_micros,
    budgetMicros: order.budget_micros,
    registeredWalletAddress: order.registered_wallet_address,
    authorizedSignerAddress: order.authorized_signer_address,
    feeRateBps: order.fee_rate_bps,
    feeExponent: order.fee_exponent,
    feeModelVersion: order.fee_model_version,
    signedPayload,
    buyBudgetComplete: order.buy_budget_complete === null ? null : order.buy_budget_complete === 1,
    rulesetHash: order.order_ruleset_hash,
    configVersion: order.order_config_version,
  });
  if (createHash("sha256").update(snapshot).digest("hex") !== order.order_request_sha256) {
    throw new Error(`RECOVERY_ORDER_INTENT_HASH_MISMATCH:${order.live_order_id}`);
  }
}

export class LiveCrashRecovery {
  constructor(
    private readonly orderAdapter: OrderAdapter,
    private readonly reconciliation: LiveReconciliation,
    private readonly store: LiveStore,
    private readonly walletProvider: WalletProvider,
    private readonly requireExternalPositions: boolean,
    private readonly externalCallTimeoutMs: number,
  ) {}

  async recover(accountId: string): Promise<LiveRecoveryResult> {
    const reconciliation = await this.reconcile(accountId);
    const status = reconciliation.passed ? "PASSED" : "FAILED";
    const recoveryRunId = this.store.saveRecoveryRun({
      accountId,
      status,
      openOrders: reconciliation.recoveredOrders,
      fills: reconciliation.recoveredFills,
      positions: reconciliation.recoveredPositions,
      reason: reconciliation.reason,
      checks: reconciliation.checks,
    });
    if (!reconciliation.passed) {
      this.store.freezeOpenPositions(accountId, `RECOVERY_RECONCILIATION_FAILED:${reconciliation.reason}`);
      for (const order of this.store.recoverableOrders(accountId)) {
        this.store.freezeExecution(order.live_execution_id, reconciliation.reason);
      }
    } else {
      this.store.transaction(() => this.store.unfreezeReconciledPositions(accountId));
    }
    return { passed: reconciliation.passed, reason: reconciliation.reason, recoveryRunId };
  }

  async reconcile(accountId: string): Promise<LiveExternalReconciliationResult> {
    let recoveredOrders = 0;
    let recoveredFills = 0;
    let recoveredPositions = 0;
    const recoveredPositionIds = new Set<string>();
    try {
      let localOrders = this.store.recoverableOrders(accountId);
      for (const local of localOrders) {
        if (local.external_order_id !== null) validateOrderIntentEvidence(local);
        if (local.external_order_id !== null) continue;
        const attempt = this.store.submitAttemptStatus(local.live_order_id);
        if (attempt !== null) {
          throw new Error(`LOCAL_ORDER_SUBMIT_OUTCOME_UNKNOWN:${local.live_order_id}:${attempt.status}`);
        }
        this.store.transaction(() => {
          this.store.failUnsubmittedOrder(
            local.execution,
            local.live_order_id,
            "RECOVERY_UNSUBMITTED_INTENT",
          );
          this.store.updateCheckpoint(accountId, {
            executionId: local.live_execution_id,
            orderId: local.live_order_id,
          });
        });
        recoveredOrders += 1;
      }
      if (recoveredOrders > 0) localOrders = this.store.recoverableOrders(accountId);
      if (this.orderAdapter.adapterType === "DISABLED") {
        const disabledCheck: LiveReconciliationCheck = localOrders.length === 0
          ? { name: "external_order_recovery", passed: true, reason: "NO_PENDING_LIVE_ORDERS" }
          : { name: "external_order_recovery", passed: false, reason: "ORDER_ADAPTER_DISABLED_WITH_PENDING_ORDERS" };
        const local = this.reconciliation.run(accountId, [disabledCheck]);
        return {
          passed: local.passed,
          reason: local.passed ? "RECOVERY_RECONCILED" : disabledCheck.reason,
          runId: local.runId,
          checks: local.checks,
          recoveredOrders,
          recoveredFills,
          recoveredPositions,
        };
      }

      const localExternalOrderIds = localOrders.flatMap((order) => order.external_order_id ? [order.external_order_id] : []);
      if (new Set(localExternalOrderIds).size !== localExternalOrderIds.length) {
        throw new Error("LOCAL_EXTERNAL_ORDER_ID_DUPLICATE");
      }
      const externalOpenOrders = await this.readExternal(
        "GET_OPEN_ORDERS",
        () => this.orderAdapter.getOpenOrders(),
      );
      const localExternalIds = this.store.localExternalOrderIds(accountId);
      const unknownExternal = externalOpenOrders.find((order) => !localExternalIds.has(order.externalOrderId));
      if (unknownExternal) throw new Error(`EXTERNAL_ORDER_NOT_LOCAL:${unknownExternal.externalOrderId}`);
      const recoverableExternalIds = new Set(
        localOrders.flatMap((order) => order.external_order_id ? [order.external_order_id] : []),
      );
      const unexpectedlyOpen = externalOpenOrders.find((order) => !recoverableExternalIds.has(order.externalOrderId));
      if (unexpectedlyOpen) throw new Error(`EXTERNAL_ORDER_LOCAL_TERMINAL:${unexpectedlyOpen.externalOrderId}`);

      const snapshots: ExternalOrderSnapshot[] = [];
      for (const local of localOrders) {
        if (!local.external_order_id) throw new Error(`LOCAL_ORDER_EXTERNAL_ID_MISSING:${local.live_order_id}`);
        const { status, fills } = await this.readOrderSnapshot(local);
        if (status.externalOrderId !== local.external_order_id) {
          throw new Error(`EXTERNAL_ORDER_ID_MISMATCH:${local.live_order_id}`);
        }
        this.validateExternalSnapshot(local, status, fills);
        snapshots.push({ local, status, fills });
      }

      let lastFillId: string | null = null;
      let synchronizedOrders = 0;
      let insertedFills = 0;
      this.store.transaction(() => {
        for (const snapshot of snapshots) {
          for (const fill of snapshot.fills) {
            const recorded = this.store.recordFill({
              execution: snapshot.local.execution,
              liveOrderId: snapshot.local.live_order_id,
              side: snapshot.local.side,
              fill,
            });
            if (!recorded.inserted) continue;
            if (snapshot.local.side === "BUY") {
              recoveredPositionIds.add(this.store.applyBuyFill(snapshot.local.execution, fill));
            } else {
              const available = this.store.openPositions(
                snapshot.local.execution.live_account_id,
                snapshot.local.execution.asset_id,
              ).reduce((total, position) => total + BigInt(position.current_size_micros), 0n);
              if (BigInt(fill.sizeMicros) > available) throw new Error("RECOVERY_SELL_FILL_EXCEEDS_LOCAL_POSITION");
              this.store.applySellFill(snapshot.local.execution, snapshot.local.live_order_id, fill);
            }
            insertedFills += 1;
            lastFillId = recorded.fillId;
          }
          if (this.store.recordedOrderFillSize(snapshot.local.live_order_id) !== BigInt(snapshot.status.filledSizeMicros)) {
            throw new Error("RECOVERY_CUMULATIVE_FILL_HISTORY_MISMATCH");
          }
          this.store.syncRecoveredOrder(snapshot.local, {
            status: snapshot.status.status,
            terminal: isTerminal(snapshot.status),
            confirmationPending: snapshot.status.confirmationPending === true,
            raw: snapshot.status.raw,
          });
          this.store.updateExecutionTotals(snapshot.local.live_execution_id);
          const refreshed = this.store.executionById(snapshot.local.live_execution_id)!;
          let recoveredState = executionState(
            snapshot.status.status,
            BigInt(snapshot.status.filledSizeMicros),
            BigInt(snapshot.local.size_micros),
          );
          if (!isTerminal(snapshot.status)) {
            // Confirmed partial fills do not finish an order whose remaining
            // quantity/finality is still outstanding; preserve its reservations.
            recoveredState = snapshot.local.side === "BUY" ? "WAITING_EXECUTION"
              : refreshed.execution_type === "STOP_LOSS" ? "STOP_EXIT_PENDING" : "EXIT_PENDING";
          }
          if (isTerminal(snapshot.status) && snapshot.local.side === "BUY") {
            if (BigInt(refreshed.filled_size_micros) === 0n) {
              recoveredState = "WAITING_EXECUTION";
            } else {
              if (snapshot.local.buy_budget_complete === null) {
                throw new Error(`RECOVERY_BUY_BUDGET_COMPLETENESS_MISSING:${snapshot.local.live_order_id}`);
              }
              this.store.releaseReservation(snapshot.local.execution, snapshot.local.live_order_id, "RECOVERY_TERMINAL_ORDER");
              recoveredState = snapshot.local.buy_budget_complete === 1
                && (this.orderAdapter.adapterType === "POLYMARKET_CLOB"
                  ? snapshot.fills.reduce((total, fill) => total + BigInt(fill.notionalMicros), 0n)
                    >= BigInt(snapshot.local.amount_micros!)
                  : BigInt(snapshot.status.filledSizeMicros) >= BigInt(snapshot.local.size_micros))
                ? "EXECUTED"
                : "PARTIALLY_EXECUTED";
            }
          } else if (isTerminal(snapshot.status) && snapshot.local.side === "SELL") {
            const remaining = BigInt(refreshed.requested_size_micros ?? "0") - BigInt(refreshed.filled_size_micros);
            if (remaining <= 0n) {
              this.store.releaseAssetReservation(snapshot.local.execution, snapshot.local.live_order_id, "RECOVERY_SELL_COMPLETED");
              recoveredState = "EXECUTED";
            } else {
              recoveredState = refreshed.execution_type === "STOP_LOSS" ? "STOP_EXIT_PENDING" : "EXIT_PENDING";
            }
          }
          this.store.updateExecutionState(
            snapshot.local.live_execution_id,
            recoveredState,
            "RECOVERY_ORDER_SYNC",
            snapshot.local.execution.ruleset_hash,
          );
          this.store.updateCheckpoint(accountId, {
            executionId: snapshot.local.live_execution_id,
            orderId: snapshot.local.live_order_id,
            fillId: lastFillId,
          });
          synchronizedOrders += 1;
        }
      });
      recoveredOrders += synchronizedOrders;
      recoveredFills = insertedFills;
      recoveredPositions = recoveredPositionIds.size;

      const externalCheck: LiveReconciliationCheck = {
        name: "external_order_recovery",
        passed: true,
        reason: "EXTERNAL_ORDER_STATE_SYNCED",
      };
      const externalPositionCheck = await this.externalPositionCheck(accountId);
      const externalCashCheck = await this.externalCashCheck();
      const local = this.reconciliation.run(accountId, [externalCheck, externalPositionCheck, externalCashCheck]);
      this.store.updateCheckpoint(accountId, { reconciliationRunId: local.runId });
      return {
        passed: local.passed,
        reason: local.passed ? "RECOVERY_RECONCILED" : "RECOVERY_RECONCILIATION_FAILED",
        runId: local.runId,
        checks: local.checks,
        recoveredOrders,
        recoveredFills,
        recoveredPositions,
      };
    } catch (error) {
      const reason = failureReason(error);
      const failedCheck: LiveReconciliationCheck = { name: "external_order_recovery", passed: false, reason };
      const local = this.reconciliation.run(accountId, [failedCheck]);
      this.store.updateCheckpoint(accountId, { reconciliationRunId: local.runId });
      return {
        passed: false,
        reason,
        runId: local.runId,
        checks: local.checks,
        recoveredOrders,
        recoveredFills,
        recoveredPositions,
      };
    }
  }

  private async externalPositionCheck(accountId: string): Promise<LiveReconciliationCheck> {
    const snapshot = await this.readExternal(
      "WALLET_OUTCOME_POSITIONS",
      () => this.walletProvider.getOutcomePositions(),
    );
    if (snapshot.status !== "AVAILABLE") {
      return this.requireExternalPositions
        ? {
          name: "external_wallet_positions",
          passed: false,
          reason: snapshot.reason ?? "EXTERNAL_WALLET_POSITIONS_UNAVAILABLE",
        }
        : {
          name: "external_wallet_positions",
          passed: true,
          reason: "TEST_EXTERNAL_POSITION_CHECK_SKIPPED",
        };
    }
    const external = new Map<string, bigint>();
    for (const position of snapshot.positions) {
      if (!position.assetId || !/^\d+$/.test(position.balanceMicros)) {
        return { name: "external_wallet_positions", passed: false, reason: "EXTERNAL_WALLET_POSITION_INVALID" };
      }
      const size = BigInt(position.balanceMicros);
      if (size < 0n || external.has(position.assetId)) {
        return { name: "external_wallet_positions", passed: false, reason: `EXTERNAL_WALLET_POSITION_DUPLICATE_OR_NEGATIVE:${position.assetId}` };
      }
      if (size > 0n) external.set(position.assetId, size);
    }
    const local = this.store.outcomePositionBalances(accountId);
    let baseline = this.store.externalPositionBaseline(accountId);
    if (baseline === null && this.store.canCaptureExternalPositionBaseline(accountId)) {
      baseline = this.store.captureExternalPositionBaseline(accountId, external);
    }
    const expected = new Map(baseline ?? []);
    for (const [assetId, managedSize] of local) {
      expected.set(assetId, (expected.get(assetId) ?? 0n) + managedSize);
    }
    const assets = new Set([...expected.keys(), ...external.keys()]);
    for (const assetId of [...assets].sort()) {
      const expectedSize = expected.get(assetId) ?? 0n;
      const externalSize = external.get(assetId) ?? 0n;
      if (expectedSize !== externalSize) {
        return {
          name: "external_wallet_positions",
          passed: false,
          reason: `EXTERNAL_WALLET_POSITION_MISMATCH:${assetId}:${expectedSize}:${externalSize}`,
        };
      }
    }
    return {
      name: "external_wallet_positions",
      passed: true,
      reason: `EXTERNAL_WALLET_POSITIONS_MATCH:BASELINE=${baseline?.size ?? 0}:MANAGED=${local.size}`,
    };
  }

  private async externalCashCheck(): Promise<LiveReconciliationCheck> {
    if (!this.requireExternalPositions) {
      return {
        name: "external_wallet_cash",
        passed: true,
        reason: "TEST_EXTERNAL_CASH_CHECK_SKIPPED",
      };
    }
    const snapshot = await this.readExternal(
      "WALLET_BALANCE",
      () => this.walletProvider.getBalance(),
    );
    if (
      snapshot.status !== "AVAILABLE"
      || snapshot.balanceMicros === null
      || !/^\d+$/.test(snapshot.balanceMicros)
    ) {
      return {
        name: "external_wallet_cash",
        passed: false,
        reason: snapshot.reason ?? "EXTERNAL_WALLET_CASH_UNAVAILABLE",
      };
    }
    const external = BigInt(snapshot.balanceMicros);
    return {
      name: "external_wallet_cash",
      passed: true,
      reason: `EXTERNAL_WALLET_CASH_OBSERVED:${external}`,
    };
  }

  private async readOrderSnapshot(local: LiveRecoveryOrderRow): Promise<OrderSnapshot> {
    const orderId = local.external_order_id!;
    if (this.orderAdapter.getOrderSnapshot !== undefined) {
      return this.readExternal("GET_ORDER_SNAPSHOT", () => this.orderAdapter.getOrderSnapshot!(orderId));
    }
    const status = await this.readExternal("GET_ORDER", () => this.orderAdapter.getOrder(orderId));
    if (status.externalOrderId !== orderId) throw new Error(`EXTERNAL_ORDER_ID_MISMATCH:${local.live_order_id}`);
    const fills = await this.readExternal("GET_FILLS", () => this.orderAdapter.getFills(orderId));
    return { status, fills };
  }

  private async readExternal<T>(operation: string, task: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= EXTERNAL_READ_MAX_ATTEMPTS; attempt += 1) {
      try {
        return await withExternalTimeout(operation, this.externalCallTimeoutMs, task);
      } catch (error) {
        lastError = error;
        if (attempt === EXTERNAL_READ_MAX_ATTEMPTS || !isRetryableExternalReadFailure(error)) throw error;
        await new Promise((resolve) => setTimeout(resolve, EXTERNAL_READ_RETRY_DELAY_MS));
      }
    }
    throw lastError;
  }

  private validateExternalSnapshot(
    local: LiveRecoveryOrderRow,
    status: OrderStatus,
    fills: LiveFillEvent[],
  ): void {
    if (this.orderAdapter.adapterType === "POLYMARKET_CLOB") {
      const identity = { assetId: local.asset_id, conditionId: local.condition_id, side: local.side };
      validateClobOrderIdentity(status.raw, identity);
      for (const fill of fills) validateClobTradeIdentity(fill.raw, local.external_order_id!, identity);
    }
    const availableSellSize = local.side === "SELL"
      // Snapshots are cumulative. Already-booked fills of this same order have
      // reduced current holdings and must be restored for this validation only.
      ? (this.store.openPositions(local.execution.live_account_id, local.asset_id)
        .reduce((total, position) => total + BigInt(position.current_size_micros), 0n)
        + this.store.recordedOrderFillSize(local.live_order_id)).toString()
      : null;
    validateLiveOrderFills({
      adapterType: this.orderAdapter.adapterType,
      side: local.side,
      status: status.status,
      fills,
      requestedSizeMicros: local.size_micros,
      ...(local.amount_micros === null ? {} : { requestedNotionalMicros: local.amount_micros }),
      orderType: local.order_type,
      limitPriceUnits: local.price_units,
      buyBudgetMicros: local.side === "BUY" ? local.budget_micros : null,
      availableSellSizeMicros: availableSellSize,
      reportedFilledSizeMicros: status.filledSizeMicros,
    });
  }
}
