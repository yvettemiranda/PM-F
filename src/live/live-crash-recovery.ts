import { createHash } from "node:crypto";
import type { OrderAdapter } from "./order-adapter.js";
import type { WalletProvider } from "./wallet-provider.js";
import { LiveReconciliation } from "./live-reconciliation.js";
import type { LiveRecoveryOrderRow, LiveStore } from "./live-store.js";
import type { LiveExecutionState, LiveFillEvent, LiveOrderState, LiveReconciliationCheck, OrderStatus } from "./live-types.js";
import { withExternalTimeout } from "./external-timeout.js";
import { validateLiveOrderFills } from "./fill-validation.js";
import { RULESET, stableJson } from "../domain/versioning.js";

interface ExternalOrderSnapshot {
  local: LiveRecoveryOrderRow;
  status: OrderStatus;
  fills: LiveFillEvent[];
}

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
      const externalOpenOrders = await withExternalTimeout(
        "GET_OPEN_ORDERS",
        this.externalCallTimeoutMs,
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
        const status = await withExternalTimeout(
          "GET_ORDER",
          this.externalCallTimeoutMs,
          () => this.orderAdapter.getOrder(local.external_order_id!),
        );
        if (status.externalOrderId !== local.external_order_id) {
          throw new Error(`EXTERNAL_ORDER_ID_MISMATCH:${local.live_order_id}`);
        }
        const fills = await withExternalTimeout(
          "GET_FILLS",
          this.externalCallTimeoutMs,
          () => this.orderAdapter.getFills(local.external_order_id!),
        );
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
          if (isTerminal(snapshot.status) && snapshot.local.side === "BUY") {
            if (BigInt(refreshed.filled_size_micros) === 0n) {
              recoveredState = "WAITING_EXECUTION";
            } else {
              if (snapshot.local.buy_budget_complete === null) {
                throw new Error(`RECOVERY_BUY_BUDGET_COMPLETENESS_MISSING:${snapshot.local.live_order_id}`);
              }
              this.store.releaseReservation(snapshot.local.execution, snapshot.local.live_order_id, "RECOVERY_TERMINAL_ORDER");
              recoveredState = snapshot.local.buy_budget_complete === 1
                && BigInt(snapshot.status.filledSizeMicros) >= BigInt(snapshot.local.size_micros)
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
      const externalCashCheck = await this.externalCashCheck(accountId);
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
    const snapshot = await withExternalTimeout(
      "WALLET_OUTCOME_POSITIONS",
      this.externalCallTimeoutMs,
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
    const assets = new Set([...local.keys(), ...external.keys()]);
    for (const assetId of [...assets].sort()) {
      const localSize = local.get(assetId) ?? 0n;
      const externalSize = external.get(assetId) ?? 0n;
      if (localSize !== externalSize) {
        return {
          name: "external_wallet_positions",
          passed: false,
          reason: `EXTERNAL_WALLET_POSITION_MISMATCH:${assetId}:${localSize}:${externalSize}`,
        };
      }
    }
    return { name: "external_wallet_positions", passed: true, reason: "EXTERNAL_WALLET_POSITIONS_MATCH" };
  }

  private async externalCashCheck(accountId: string): Promise<LiveReconciliationCheck> {
    if (!this.requireExternalPositions) {
      return {
        name: "external_wallet_cash",
        passed: true,
        reason: "TEST_EXTERNAL_CASH_CHECK_SKIPPED",
      };
    }
    const snapshot = await withExternalTimeout(
      "WALLET_BALANCE",
      this.externalCallTimeoutMs,
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
    const expected = this.store.expectedCashBalance(accountId);
    const difference = external >= expected ? external - expected : expected - external;
    if (difference > BigInt(RULESET.reconciliationCashAbsToleranceMicros)) {
      return {
        name: "external_wallet_cash",
        passed: false,
        reason: `EXTERNAL_WALLET_CASH_MISMATCH:${expected}:${external}:${difference}`,
      };
    }
    return {
      name: "external_wallet_cash",
      passed: true,
      reason: `EXTERNAL_WALLET_CASH_MATCH:${difference}`,
    };
  }

  private validateExternalSnapshot(
    local: LiveRecoveryOrderRow,
    status: OrderStatus,
    fills: LiveFillEvent[],
  ): void {
    const availableSellSize = local.side === "SELL"
      ? this.store.openPositions(local.execution.live_account_id, local.asset_id)
        .reduce((total, position) => total + BigInt(position.current_size_micros), 0n)
        .toString()
      : null;
    validateLiveOrderFills({
      adapterType: this.orderAdapter.adapterType,
      side: local.side,
      status: status.status,
      fills,
      requestedSizeMicros: local.size_micros,
      limitPriceUnits: local.price_units,
      buyBudgetMicros: local.side === "BUY" ? local.execution.requested_amount_micros : null,
      availableSellSizeMicros: availableSellSize,
      reportedFilledSizeMicros: status.filledSizeMicros,
    });
  }
}
