import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { RULESET, RULESET_HASH, stableJson, VERSIONS } from "../domain/versioning.js";
import {
  LIVE_EXECUTION_TRANSITIONS,
  LIVE_ORDER_TRANSITIONS,
  LIVE_POSITION_TRANSITIONS,
  transition as assertTransition,
} from "../domain/state-machine.js";
import type { SourceVersion } from "../infra/source-version.js";
import type { ExecutionFeeSnapshot, ExecutionOrderbookSnapshot } from "../execution/market-data.js";
import type { ExecutionMatchResult } from "../execution/orderbook-matching.js";
import type {
  LiveExecutionState,
  LiveFillEvent,
  LiveOrderRequest,
  LiveOrderSide,
  LiveOrderState,
  LivePositionState,
  LiveReconciliationCheck,
  OrderSubmitResult,
} from "./live-types.js";

export interface LiveExecutionRow {
  live_execution_id: string;
  live_account_id: string;
  signal_id: string | null;
  risk_decision_id: string;
  execution_idempotency_key: string;
  execution_type: string;
  state: LiveExecutionState;
  asset_id: string;
  condition_id: string;
  requested_amount_micros: string | null;
  requested_size_micros: string | null;
  filled_size_micros: string;
  filled_notional_micros: string;
  fee_micros: string;
  target_price_units: string | null;
  deadline_at: string | null;
  attempt_count: number;
  ruleset_hash: string;
}

export interface LivePositionRow {
  live_position_id: string;
  live_account_id: string;
  opening_execution_id: string;
  signal_id: string | null;
  asset_id: string;
  condition_id: string;
  entry_price_units: string;
  current_size_micros: string;
  remaining_cost_micros: string;
  status: LivePositionState;
  realized_pnl_micros: string;
  ruleset_hash: string;
}

export interface LiveRecoveryOrderRow {
  live_order_id: string;
  live_execution_id: string;
  external_order_id: string | null;
  side: LiveOrderSide;
  market_id: string;
  asset_id: string;
  condition_id: string;
  order_type: string;
  price_units: string;
  size_micros: string;
  status: LiveOrderState;
  raw_response_json: string;
  buy_budget_complete: number | null;
  live_order_idempotency_key: string;
  quote_vwap_price_units: string | null;
  amount_micros: string | null;
  budget_micros: string | null;
  registered_wallet_address: string | null;
  authorized_signer_address: string | null;
  fee_rate_bps: string | null;
  fee_exponent: number | null;
  fee_model_version: string | null;
  signed_payload_json: string | null;
  order_request_sha256: string | null;
  order_ruleset_hash: string | null;
  order_source_code_commit: string | null;
  order_source_code_dirty: number | null;
  order_config_version: string | null;
  execution: LiveExecutionRow;
}

interface LiveWalletCapacitySnapshot {
  walletBalanceMicros: bigint;
  walletAllowanceMicros: bigint;
}

export interface LiveSettlementConfirmation {
  positionId: string;
  resolved: boolean;
  payoutNumerator: string;
  payoutDenominator: string;
  confirmedAt: string;
  resolutionSnapshot: Record<string, unknown>;
}

export interface LiveSettlementRecord {
  settlement_ledger_id: string;
  live_position_id: string;
  live_execution_id: string | null;
  condition_id: string;
  asset_id: string;
  settlement_status: string;
  redeem_amount_micros: string;
  pnl_micros: string;
  resolution_snapshot_json: string;
  redeem_idempotency_key: string;
}

type LiveSettlementEventStatus = "PENDING" | "RESOLVED" | "REDEEM_PENDING" | "REDEEMED" | "DISABLED" | "FAILED";

function hash(parts: Array<string | number | null>): string {
  return createHash("sha256").update(parts.map((part) => part ?? "NULL").join("|")).digest("hex");
}

export function liveExecutionIdempotencyKey(accountId: string, signalId: string): string {
  return `LIVE_EXECUTION:${accountId}:${signalId}`;
}

export function liveTargetSellWaitingBuyAdjustmentIdempotencyKey(
  buyExecutionId: string,
  targetSellSignalId: string,
): string {
  return `LIVE_TARGET_SELL_WAITING_BUY_ADJUSTMENT:${buyExecutionId}:${targetSellSignalId}`;
}

export function liveOrderIdempotencyKey(executionId: string, side: LiveOrderSide, assetId: string, priceUnits: string, sizeMicros: string, attempt = 1): string {
  return `LIVE_ORDER:${executionId}:${side}:${assetId}:${priceUnits}:${sizeMicros}:${attempt}`;
}

export function cancelIdempotencyKey(orderId: string, reason: string): string {
  return `LIVE_CANCEL:${orderId}:${reason}`;
}

export function fillIdempotencyKey(orderId: string, externalFillId: string): string {
  return `LIVE_FILL:${orderId}:${externalFillId}`;
}

export function redeemIdempotencyKey(positionId: string, conditionId: string, assetId: string): string {
  return `LIVE_REDEEM:${positionId}:${conditionId}:${assetId}`;
}

export class LiveStore {
  private savepointSequence = 0;

  constructor(
    private readonly database: DatabaseSync,
    private readonly sourceVersion: SourceVersion,
    private readonly now: () => Date,
  ) {}

  existingExecution(idempotencyKey: string): LiveExecutionRow | null {
    const row = this.database.prepare("SELECT * FROM live_executions WHERE execution_idempotency_key=?")
      .get(idempotencyKey) as LiveExecutionRow | undefined;
    return row ?? null;
  }

  executionById(executionId: string): LiveExecutionRow | null {
    const row = this.database.prepare("SELECT * FROM live_executions WHERE live_execution_id=?")
      .get(executionId) as LiveExecutionRow | undefined;
    return row ?? null;
  }

  createExecution(input: {
    liveAccountId: string;
    signalId: string | null;
    contextId: string | null;
    riskDecisionId: string;
    liveGateRunId: string | null;
    executionIdempotencyKey: string;
    executionType: "TARGET_BUY" | "TARGET_SELL" | "STOP_LOSS" | "SETTLEMENT" | "REDEEM";
    state: LiveExecutionState;
    assetId: string;
    conditionId: string;
    requestedAmountMicros: string | null;
    requestedSizeMicros: string | null;
    targetPriceUnits: string | null;
    deadlineAt?: string | null;
    reason: string;
    rulesetHash: string;
  }): LiveExecutionRow {
    return this.transaction(() => {
      const existing = this.existingExecution(input.executionIdempotencyKey);
      if (existing) return existing;
      const now = this.now().toISOString();
      const configVersion = this.rulesetConfigVersion(input.rulesetHash);
      const executionId = hash(["LIVE_EXECUTION", input.executionIdempotencyKey, input.rulesetHash]);
      this.database.prepare(
        `INSERT INTO live_executions(
          live_execution_id,live_account_id,signal_id,context_id,risk_decision_id,live_gate_run_id,
          execution_idempotency_key,execution_type,state,asset_id,condition_id,requested_amount_micros,
          requested_size_micros,filled_size_micros,filled_notional_micros,fee_micros,target_price_units,
          reason,schema_version,strategy_version,risk_version,live_version,ruleset_hash,source_code_commit,
          source_code_dirty,config_version,created_at,updated_at,deadline_at,attempt_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '0', '0', '0', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      ).run(
        executionId,
        input.liveAccountId,
        input.signalId,
        input.contextId,
        input.riskDecisionId,
        input.liveGateRunId,
        input.executionIdempotencyKey,
        input.executionType,
        input.state,
        input.assetId,
        input.conditionId,
        input.requestedAmountMicros,
        input.requestedSizeMicros,
        input.targetPriceUnits,
        input.reason,
        VERSIONS.schemaVersion,
        VERSIONS.strategyVersion,
        VERSIONS.riskVersion,
        VERSIONS.liveVersion,
        input.rulesetHash,
        this.sourceVersion.commit,
        this.sourceVersion.dirty ? 1 : 0,
        configVersion,
        now,
        now,
        input.deadlineAt ?? null,
      );
      this.transition("LIVE_EXECUTION", executionId, null, input.state, input.reason, input.rulesetHash, now);
      this.audit("LIVE_EXECUTION", executionId, input.state === "REJECTED" ? "rejected" : "created", input.reason, { signalId: input.signalId });
      return this.existingExecution(input.executionIdempotencyKey)!;
    });
  }

  updateExecutionState(executionId: string, toState: LiveExecutionState, reason: string, rulesetHash: string): void {
    this.transaction(() => {
      const current = this.database.prepare("SELECT state FROM live_executions WHERE live_execution_id=?")
        .get(executionId) as { state: string } | undefined;
      if (!current) throw new Error("LIVE_EXECUTION_NOT_FOUND");
      assertTransition(LIVE_EXECUTION_TRANSITIONS, current.state as LiveExecutionState, toState);
      const now = this.now().toISOString();
      this.database.prepare("UPDATE live_executions SET state=?,reason=?,updated_at=? WHERE live_execution_id=?")
        .run(toState, reason, now, executionId);
      this.transition("LIVE_EXECUTION", executionId, current.state, toState, reason, rulesetHash, now);
      this.audit("LIVE_EXECUTION", executionId, toState.toLowerCase(), reason, {});
    });
  }

  updateExecutionTotals(executionId: string): void {
    const row = this.fillTotals("live_execution_id", executionId);
    const now = this.now().toISOString();
    this.database.prepare(
      "UPDATE live_executions SET filled_size_micros=?,filled_notional_micros=?,fee_micros=?,updated_at=? WHERE live_execution_id=?",
    ).run(row.size.toString(), row.notional.toString(), row.fee.toString(), now, executionId);
  }

  createOrder(
    input: LiveOrderRequest,
    executionId: string,
    adapterType: string,
    buyBudgetComplete: boolean | null,
  ): boolean {
    if (input.side === "BUY" && buyBudgetComplete === null) {
      throw new Error("LIVE_BUY_BUDGET_COMPLETENESS_REQUIRED");
    }
    if (input.side === "SELL" && buyBudgetComplete !== null) {
      throw new Error("LIVE_SELL_BUDGET_COMPLETENESS_FORBIDDEN");
    }
    const execution = this.executionById(executionId);
    if (!execution) throw new Error("LIVE_EXECUTION_NOT_FOUND");
    const configVersion = this.rulesetConfigVersion(execution.ruleset_hash);
    const signedPayloadJson = stableJson(input.signedPayload);
    const intentSnapshot = stableJson({
      liveOrderId: input.liveOrderId,
      idempotencyKey: input.idempotencyKey,
      marketId: input.marketId,
      conditionId: input.conditionId,
      assetId: input.assetId,
      side: input.side,
      orderType: input.orderType,
      priceUnits: input.priceUnits,
      quoteVwapPriceUnits: input.quoteVwapPriceUnits,
      sizeMicros: input.sizeMicros,
      amountMicros: input.amountMicros,
      budgetMicros: input.budgetMicros,
      registeredWalletAddress: input.registeredWalletAddress,
      authorizedSignerAddress: input.authorizedSignerAddress,
      feeRateBps: input.feeRateBps,
      feeExponent: input.feeExponent,
      feeModelVersion: input.feeModelVersion,
      signedPayload: input.signedPayload,
      buyBudgetComplete,
      rulesetHash: execution.ruleset_hash,
      configVersion,
    });
    const now = this.now().toISOString();
    const inserted = this.database.prepare(
      `INSERT OR IGNORE INTO live_orders(
        live_order_id,live_execution_id,live_order_idempotency_key,external_order_id,market_id,
        asset_id,condition_id,side,order_type,price_units,size_micros,filled_size_micros,
        filled_notional_micros,fee_micros,status,adapter_type,raw_response_json,created_at,updated_at,
        buy_budget_complete,quote_vwap_price_units,amount_micros,budget_micros,
        registered_wallet_address,authorized_signer_address,fee_rate_bps,fee_exponent,
        fee_model_version,signed_payload_json,order_request_sha256,ruleset_hash,
        source_code_commit,source_code_dirty,config_version
      ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, '0', '0', '0', 'CREATED', ?, '{}', ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.liveOrderId,
      executionId,
      input.idempotencyKey,
      input.marketId,
      input.assetId,
      input.conditionId,
      input.side,
      input.orderType,
      input.priceUnits,
      input.sizeMicros,
      adapterType,
      now,
      now,
      buyBudgetComplete === null ? null : buyBudgetComplete ? 1 : 0,
      input.quoteVwapPriceUnits,
      input.amountMicros,
      input.budgetMicros,
      input.registeredWalletAddress,
      input.authorizedSignerAddress,
      input.feeRateBps,
      input.feeExponent,
      input.feeModelVersion,
      signedPayloadJson,
      createHash("sha256").update(intentSnapshot).digest("hex"),
      execution.ruleset_hash,
      this.sourceVersion.commit,
      this.sourceVersion.dirty ? 1 : 0,
      configVersion,
    );
    if (Number(inserted.changes) === 0) return false;
    this.transition("LIVE_ORDER", input.liveOrderId, null, "CREATED", "ORDER_CREATED", RULESET_HASH, now);
    this.database.prepare(
      "UPDATE live_executions SET attempt_count=attempt_count+1,updated_at=? WHERE live_execution_id=?",
    ).run(now, executionId);
    return true;
  }

  nextOrderAttempt(executionId: string): number {
    const row = this.database.prepare(
      "SELECT attempt_count FROM live_executions WHERE live_execution_id=?",
    ).get(executionId) as { attempt_count: number } | undefined;
    if (!row) throw new Error("LIVE_EXECUTION_NOT_FOUND");
    return row.attempt_count + 1;
  }

  hasNonTerminalOrder(executionId: string): boolean {
    return this.database.prepare(
      `SELECT 1 ok FROM live_orders
       WHERE live_execution_id=?
         AND is_terminal=0
       LIMIT 1`,
    ).get(executionId) !== undefined;
  }

  recordMarketCheck(input: {
    execution: LiveExecutionRow;
    side: LiveOrderSide;
    book: ExecutionOrderbookSnapshot;
    fee: ExecutionFeeSnapshot;
    ageMs: number;
    lowerPriceUnits: string | null;
    upperPriceUnits: string | null;
    requestedSizeMicros: string | null;
    match: ExecutionMatchResult;
    outcome: "ALLOW" | "WAIT" | "EXPIRED" | "REJECT";
    reason: string;
  }): string {
    const now = this.now().toISOString();
    const orderbook = {
      assetId: input.book.assetId,
      conditionId: input.book.conditionId,
      marketSnapshotTime: input.book.marketSnapshotTime,
      receivedAt: input.book.receivedAt,
      sourceUrl: input.book.sourceUrl,
      minOrderSize: input.book.minOrderSize ?? null,
      tickSize: input.book.tickSize ?? null,
      bids: input.book.bids,
      asks: input.book.asks,
    };
    const orderbookJson = stableJson(orderbook);
    const feeJson = stableJson(input.fee);
    const marketCheckId = randomUUID();
    const configVersion = this.rulesetConfigVersion(input.execution.ruleset_hash);
    this.database.prepare(
      `INSERT INTO live_market_checks(
        market_check_id,live_execution_id,live_account_id,signal_id,risk_decision_id,
        side,execution_type,asset_id,condition_id,market_snapshot_time,received_at,data_age_ms,
        target_price_units,lower_price_units,upper_price_units,quoted_vwap_price_units,
        requested_size_micros,quoted_size_micros,quoted_notional_micros,quoted_fee_micros,
        outcome,reason,orderbook_sha256,orderbook_json,fee_snapshot_json,ruleset_hash,
        source_code_commit,source_code_dirty,config_version,created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      marketCheckId,
      input.execution.live_execution_id,
      input.execution.live_account_id,
      input.execution.signal_id,
      input.execution.risk_decision_id,
      input.side,
      input.execution.execution_type,
      input.execution.asset_id,
      input.execution.condition_id,
      input.book.marketSnapshotTime,
      input.book.receivedAt,
      input.ageMs,
      input.execution.target_price_units,
      input.lowerPriceUnits,
      input.upperPriceUnits,
      input.match.vwapPriceUnits,
      input.requestedSizeMicros,
      input.match.filledSizeMicros,
      input.match.filledNotionalMicros,
      input.match.feeMicros,
      input.outcome,
      input.reason,
      createHash("sha256").update(orderbookJson).digest("hex"),
      orderbookJson,
      feeJson,
      input.execution.ruleset_hash,
      this.sourceVersion.commit,
      this.sourceVersion.dirty ? 1 : 0,
      configVersion,
      now,
    );
    this.audit("LIVE_MARKET_CHECK", marketCheckId, input.outcome.toLowerCase(), input.reason, {
      executionId: input.execution.live_execution_id,
      marketSnapshotTime: input.book.marketSnapshotTime,
      dataAgeMs: input.ageMs,
      quotedVwapPriceUnits: input.match.vwapPriceUnits,
      quotedSizeMicros: input.match.filledSizeMicros,
    });
    return marketCheckId;
  }

  saveValuationSnapshot(input: {
    accountId: string;
    cashBalanceMicros: string;
    reservedBalanceMicros: string;
    availableBalanceMicros: string;
    positionValueMicros: string;
    realizedPnlMicros: string;
    unrealizedPnlMicros: string;
    totalEquityMicros: string;
    valuationStatus: "COMPLETE" | "INCOMPLETE";
    unpricedPositionCount: number;
    priceTimestamp: string;
    positionEvidence: Array<Record<string, unknown>>;
  }): string {
    const snapshotId = randomUUID();
    const now = this.now().toISOString();
    this.database.prepare(
      `INSERT INTO live_valuation_snapshots(
        valuation_snapshot_id,live_account_id,cash_balance_micros,reserved_balance_micros,
        available_balance_micros,position_value_micros,realized_pnl_micros,
        unrealized_pnl_micros,total_equity_micros,valuation_status,unpriced_position_count,
        price_source,price_timestamp,position_evidence_json,ruleset_hash,source_code_commit,
        source_code_dirty,config_version,created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ORDERBOOK_EXIT_VWAP', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      snapshotId,
      input.accountId,
      input.cashBalanceMicros,
      input.reservedBalanceMicros,
      input.availableBalanceMicros,
      input.positionValueMicros,
      input.realizedPnlMicros,
      input.unrealizedPnlMicros,
      input.totalEquityMicros,
      input.valuationStatus,
      input.unpricedPositionCount,
      input.priceTimestamp,
      stableJson(input.positionEvidence),
      RULESET_HASH,
      this.sourceVersion.commit,
      this.sourceVersion.dirty ? 1 : 0,
      VERSIONS.configVersion,
      now,
    );
    this.audit("LIVE_ACCOUNT", input.accountId, "valuation_snapshot", input.valuationStatus, {
      valuationSnapshotId: snapshotId,
      unpricedPositionCount: input.unpricedPositionCount,
      totalEquityMicros: input.totalEquityMicros,
    });
    return snapshotId;
  }

  linkExecutionPosition(executionId: string, positionId: string, requestedSizeMicros: string): void {
    this.database.prepare(
      `INSERT OR IGNORE INTO live_execution_positions(
        live_execution_id,live_position_id,requested_size_micros,filled_size_micros,created_at
      ) VALUES (?, ?, ?, '0', ?)`,
    ).run(executionId, positionId, requestedSizeMicros, this.now().toISOString());
  }

  updateOrderFromSubmit(liveOrderId: string, result: OrderSubmitResult): void {
    const current = this.database.prepare("SELECT status FROM live_orders WHERE live_order_id=?")
      .get(liveOrderId) as { status: string } | undefined;
    if (!current) throw new Error("LIVE_ORDER_NOT_FOUND");
    assertTransition(LIVE_ORDER_TRANSITIONS, current.status as LiveOrderState, result.status);
    if (result.externalOrderId !== null) {
      const duplicate = this.database.prepare(
        "SELECT live_order_id FROM live_orders WHERE external_order_id=? AND live_order_id!=? LIMIT 1",
      ).get(result.externalOrderId, liveOrderId) as { live_order_id: string } | undefined;
      if (duplicate) throw new Error(`LIVE_EXTERNAL_ORDER_ID_DUPLICATE:${result.externalOrderId}`);
    }
    const now = this.now().toISOString();
    const totals = result.fills.reduce((total, fill) => ({
      size: total.size + BigInt(fill.sizeMicros),
      notional: total.notional + BigInt(fill.notionalMicros),
      fee: total.fee + BigInt(fill.feeMicros),
    }), { size: 0n, notional: 0n, fee: 0n });
    this.database.prepare(
      `UPDATE live_orders
       SET external_order_id=?,status=?,filled_size_micros=?,filled_notional_micros=?,
           fee_micros=?,adapter_type=?,raw_response_json=?,is_terminal=?,confirmation_pending=?,updated_at=?
       WHERE live_order_id=?`,
    ).run(
      result.externalOrderId,
      result.status,
      totals.size.toString(),
      totals.notional.toString(),
      totals.fee.toString(),
      result.adapterType,
      stableJson(result.raw),
      result.terminal === true ? 1 : 0,
      result.confirmationPending === true ? 1 : 0,
      now,
      liveOrderId,
    );
    this.transition("LIVE_ORDER", liveOrderId, current.status, result.status, "ORDER_SUBMIT_RESULT", RULESET_HASH, now);
    this.audit("LIVE_ORDER", liveOrderId, "submit_result", result.status, { externalOrderId: result.externalOrderId });
  }

  markSubmitOutcomeUnknown(liveOrderId: string, result: OrderSubmitResult, reason: string): void {
    const current = this.database.prepare("SELECT status FROM live_orders WHERE live_order_id=?")
      .get(liveOrderId) as { status: string } | undefined;
    if (!current) throw new Error("LIVE_ORDER_NOT_FOUND");
    assertTransition(LIVE_ORDER_TRANSITIONS, current.status as LiveOrderState, "SUBMITTED");
    const now = this.now().toISOString();
    this.database.prepare(
      `UPDATE live_orders
       SET external_order_id=?,status='SUBMITTED',adapter_type=?,raw_response_json=?,is_terminal=0,confirmation_pending=1,updated_at=?
       WHERE live_order_id=?`,
    ).run(
      result.externalOrderId,
      result.adapterType,
      stableJson({ adapterResult: result.raw, reportedStatus: result.status, persistenceReason: reason }),
      now,
      liveOrderId,
    );
    this.transition("LIVE_ORDER", liveOrderId, current.status, "SUBMITTED", reason, RULESET_HASH, now);
    this.audit("LIVE_ORDER", liveOrderId, "submit_outcome_unknown", reason, {
      externalOrderId: result.externalOrderId,
      reportedStatus: result.status,
    });
  }

  recordOrderAttempt(input: {
    liveOrderId: string;
    sequence: number;
    action: "SUBMIT" | "CANCEL" | "STATUS_SYNC";
    status: "STARTED" | "SUCCEEDED" | "FAILED";
    errorReason: string | null;
    request: Record<string, unknown>;
    response: Record<string, unknown>;
  }): void {
    this.database.prepare(
      `INSERT INTO live_order_attempts(
        attempt_id,live_order_id,attempt_sequence,action,status,error_reason,request_json,response_json,created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(live_order_id,attempt_sequence,action) DO UPDATE SET
        status=excluded.status,
        error_reason=excluded.error_reason,
        request_json=excluded.request_json,
        response_json=excluded.response_json`,
    ).run(
      hash(["LIVE_ORDER_ATTEMPT", input.liveOrderId, input.sequence, input.action]),
      input.liveOrderId,
      input.sequence,
      input.action,
      input.status,
      input.errorReason,
      stableJson(input.request),
      stableJson(input.response),
      this.now().toISOString(),
    );
  }

  submitAttemptStatus(liveOrderId: string): { status: string; errorReason: string | null } | null {
    const row = this.database.prepare(
      `SELECT status,error_reason FROM live_order_attempts
       WHERE live_order_id=? AND action='SUBMIT'
       ORDER BY attempt_sequence DESC LIMIT 1`,
    ).get(liveOrderId) as { status: string; error_reason: string | null } | undefined;
    return row ? { status: row.status, errorReason: row.error_reason } : null;
  }

  gateTransitionCount(): number {
    const row = this.database.prepare(
      "SELECT count(*) count FROM live_gate_state_transitions",
    ).get() as { count: number };
    return row.count;
  }

  submittingOrders(accountId: string): Array<{ liveOrderId: string; executionId: string }> {
    const rows = this.database.prepare(
      `SELECT o.live_order_id,o.live_execution_id
       FROM live_orders o
       JOIN live_executions e ON e.live_execution_id=o.live_execution_id
       JOIN live_order_attempts a ON a.live_order_id=o.live_order_id
       WHERE e.live_account_id=? AND o.is_terminal=0
         AND a.action='SUBMIT' AND a.status='STARTED'
       ORDER BY o.created_at,o.live_order_id`,
    ).all(accountId) as unknown as Array<{ live_order_id: string; live_execution_id: string }>;
    return rows.map((row) => ({ liveOrderId: row.live_order_id, executionId: row.live_execution_id }));
  }

  failUnsubmittedOrder(
    execution: LiveExecutionRow,
    liveOrderId: string,
    reason: string,
  ): void {
    const row = this.database.prepare(
      "SELECT status,external_order_id FROM live_orders WHERE live_order_id=?",
    ).get(liveOrderId) as { status: string; external_order_id: string | null } | undefined;
    if (!row) throw new Error("LIVE_ORDER_NOT_FOUND");
    if (row.external_order_id !== null) throw new Error("LIVE_ORDER_ALREADY_EXTERNAL");
    const now = this.now().toISOString();
    if (row.status !== "FAILED") {
      assertTransition(LIVE_ORDER_TRANSITIONS, row.status as LiveOrderState, "FAILED");
      this.database.prepare("UPDATE live_orders SET status='FAILED',is_terminal=1,confirmation_pending=0,updated_at=? WHERE live_order_id=?")
        .run(now, liveOrderId);
      this.transition("LIVE_ORDER", liveOrderId, row.status, "FAILED", reason, execution.ruleset_hash, now);
      this.audit("LIVE_ORDER", liveOrderId, "failed_before_external_ack", reason, {});
    }
    this.updateExecutionState(execution.live_execution_id, "FAILED", reason, execution.ruleset_hash);
    if (execution.execution_type === "TARGET_BUY") {
      this.releaseReservation(execution, liveOrderId, reason);
    } else if (execution.execution_type === "TARGET_SELL" || execution.execution_type === "STOP_LOSS") {
      this.releaseAssetReservation(execution, liveOrderId, reason);
    }
  }

  failPendingExecution(execution: LiveExecutionRow, reason: string): void {
    if (this.hasNonTerminalOrder(execution.live_execution_id)) {
      throw new Error("LIVE_PENDING_EXECUTION_HAS_OPEN_ORDER");
    }
    this.updateExecutionState(execution.live_execution_id, "FAILED", reason, execution.ruleset_hash);
    if (execution.execution_type === "TARGET_BUY") {
      this.releaseReservation(execution, null, reason);
    } else if (execution.execution_type === "TARGET_SELL" || execution.execution_type === "STOP_LOSS") {
      this.releaseAssetReservation(execution, null, reason);
    }
  }

  rejectPendingExecution(execution: LiveExecutionRow, reason: string): void {
    if (this.hasNonTerminalOrder(execution.live_execution_id)) {
      throw new Error("LIVE_PENDING_EXECUTION_HAS_OPEN_ORDER");
    }
    this.updateExecutionState(execution.live_execution_id, "REJECTED", reason, execution.ruleset_hash);
    if (execution.execution_type === "TARGET_BUY") {
      this.releaseReservation(execution, null, reason);
    } else if (execution.execution_type === "TARGET_SELL" || execution.execution_type === "STOP_LOSS") {
      this.releaseAssetReservation(execution, null, reason);
    }
  }

  cancelPendingExecution(execution: LiveExecutionRow, reason: string): void {
    if (this.hasNonTerminalOrder(execution.live_execution_id)) {
      throw new Error("LIVE_PENDING_EXECUTION_HAS_OPEN_ORDER");
    }
    const current = this.executionById(execution.live_execution_id);
    if (!current || ["EXECUTED", "EXPIRED", "REJECTED", "CANCELLED", "FAILED", "FROZEN"].includes(current.state)) return;
    this.updateExecutionState(current.live_execution_id, "CANCELLED", reason, current.ruleset_hash);
    if (current.execution_type === "TARGET_BUY") {
      this.releaseReservation(current, null, reason);
    } else if (current.execution_type === "TARGET_SELL" || current.execution_type === "STOP_LOSS") {
      this.releaseAssetReservation(current, null, reason);
    }
  }

  adjustWaitingBuyForTargetExit(input: {
    buyExecutionId: string;
    targetSellSignalId: string;
    retainedAmountMicros: bigint;
    adjustedRiskDecisionId: string;
  }): boolean {
    return this.transaction(() => {
      const idempotencyKey = liveTargetSellWaitingBuyAdjustmentIdempotencyKey(
        input.buyExecutionId,
        input.targetSellSignalId,
      );
      if (this.database.prepare(
        "SELECT 1 present FROM live_reservation_ledger WHERE idempotency_key=?",
      ).get(idempotencyKey)) return false;
      const execution = this.executionById(input.buyExecutionId);
      if (!execution) throw new Error("LIVE_WAITING_BUY_EXECUTION_NOT_FOUND");
      if (execution.execution_type !== "TARGET_BUY" || execution.state !== "WAITING_EXECUTION") {
        throw new Error("LIVE_WAITING_BUY_EXECUTION_STATE_MISMATCH");
      }
      if (execution.requested_amount_micros === null) {
        throw new Error("LIVE_WAITING_BUY_REQUESTED_AMOUNT_MISSING");
      }
      if (
        BigInt(execution.filled_size_micros) !== 0n
        || BigInt(execution.filled_notional_micros) !== 0n
        || BigInt(execution.fee_micros) !== 0n
      ) throw new Error("LIVE_WAITING_BUY_ALREADY_FILLED");
      if (this.hasNonTerminalOrder(execution.live_execution_id)) {
        throw new Error("LIVE_WAITING_BUY_HAS_NON_TERMINAL_ORDER");
      }
      const currentAmount = BigInt(execution.requested_amount_micros);
      const reservation = this.reservationBalance(execution.live_execution_id);
      if (currentAmount <= 0n || reservation !== currentAmount) {
        throw new Error("LIVE_WAITING_BUY_RESERVATION_MISMATCH");
      }
      if (input.retainedAmountMicros < 0n || input.retainedAmountMicros >= currentAmount) {
        throw new Error("LIVE_WAITING_BUY_TARGET_EXIT_ADJUSTMENT_INVALID");
      }
      const adjustedRisk = this.database.prepare(
        `SELECT executor_mode,account_id,decision,requested_amount_micros,
                requested_size_micros,ruleset_hash
         FROM risk_decisions WHERE risk_decision_id=?`,
      ).get(input.adjustedRiskDecisionId) as {
        executor_mode: string;
        account_id: string | null;
        decision: string;
        requested_amount_micros: string | null;
        requested_size_micros: string | null;
        ruleset_hash: string;
      } | undefined;
      if (
        !adjustedRisk
        || adjustedRisk.executor_mode !== "LIVE"
        || adjustedRisk.account_id !== execution.live_account_id
        || adjustedRisk.decision !== "ALLOW"
        || adjustedRisk.requested_amount_micros !== input.retainedAmountMicros.toString()
        || adjustedRisk.requested_size_micros !== null
        || adjustedRisk.ruleset_hash !== execution.ruleset_hash
      ) throw new Error("LIVE_WAITING_BUY_ADJUSTED_RISK_MISMATCH");

      const released = currentAmount - input.retainedAmountMicros;
      const now = this.now().toISOString();
      const nextState: LiveExecutionState = input.retainedAmountMicros === 0n
        ? "CANCELLED"
        : "WAITING_EXECUTION";
      const reason = input.retainedAmountMicros === 0n
        ? "TARGET_SELL_SUPERSEDED_WAITING_BUY"
        : "TARGET_SELL_REDUCED_WAITING_BUY";
      this.database.prepare(
        `INSERT INTO live_reservation_ledger(
          reservation_ledger_id,live_execution_id,live_order_id,entry_type,delta_micros,
          remaining_after_micros,idempotency_key,created_at
        ) VALUES (?, ?, NULL, 'RELEASE', ?, ?, ?, ?)`,
      ).run(
        hash(["LIVE_RESERVATION", execution.live_execution_id, input.targetSellSignalId, "TARGET_SELL_RELEASE"]),
        execution.live_execution_id,
        (-released).toString(),
        input.retainedAmountMicros.toString(),
        idempotencyKey,
        now,
      );
      const cashIdempotencyKey = `LIVE_CASH_TARGET_SELL_WAITING_BUY_ADJUSTMENT:${execution.live_execution_id}:${input.targetSellSignalId}`;
      this.database.prepare(
        `INSERT INTO live_cash_ledger(
          cash_ledger_id,live_account_id,live_execution_id,entry_type,cash_delta_micros,
          reserved_delta_micros,cash_after_micros,reserved_after_micros,idempotency_key,created_at
        ) VALUES (?, ?, ?, ?, '0', ?, NULL, NULL, ?, ?)`,
      ).run(
        hash(["LIVE_CASH", execution.live_execution_id, input.targetSellSignalId, "TARGET_SELL_RELEASE"]),
        execution.live_account_id,
        execution.live_execution_id,
        `RELEASE:${reason}`,
        (-released).toString(),
        cashIdempotencyKey,
        now,
      );
      this.database.prepare(
        `UPDATE live_executions
         SET requested_amount_micros=?,state=?,reason=?,risk_decision_id=?,updated_at=?
         WHERE live_execution_id=?`,
      ).run(
        input.retainedAmountMicros.toString(),
        nextState,
        reason,
        input.adjustedRiskDecisionId,
        now,
        execution.live_execution_id,
      );
      this.transition(
        "LIVE_EXECUTION",
        execution.live_execution_id,
        execution.state,
        nextState,
        reason,
        execution.ruleset_hash,
        now,
      );
      this.audit(
        "LIVE_EXECUTION",
        execution.live_execution_id,
        input.retainedAmountMicros === 0n ? "reservation_cancelled" : "reservation_reduced",
        reason,
        {
          targetExitSignalId: input.targetSellSignalId,
          releasedAmountMicros: released.toString(),
          retainedAmountMicros: input.retainedAmountMicros.toString(),
          priorRiskDecisionId: execution.risk_decision_id,
          riskDecisionId: input.adjustedRiskDecisionId,
        },
      );
      return true;
    });
  }

  reserve(execution: LiveExecutionRow, amountMicros: bigint): void {
    const now = this.now().toISOString();
    this.database.prepare(
      `INSERT OR IGNORE INTO live_reservation_ledger(
        reservation_ledger_id,live_execution_id,live_order_id,entry_type,delta_micros,
        remaining_after_micros,idempotency_key,created_at
      ) VALUES (?, ?, NULL, 'RESERVE', ?, ?, ?, ?)`,
    ).run(
      hash(["LIVE_RESERVATION", execution.live_execution_id, "RESERVE"]),
      execution.live_execution_id,
      amountMicros.toString(),
      amountMicros.toString(),
      `LIVE_RESERVE:${execution.live_execution_id}`,
      now,
    );
    this.database.prepare(
      `INSERT OR IGNORE INTO live_cash_ledger(
        cash_ledger_id,live_account_id,live_execution_id,entry_type,cash_delta_micros,
        reserved_delta_micros,cash_after_micros,reserved_after_micros,idempotency_key,created_at
      ) VALUES (?, ?, ?, 'RESERVE', '0', ?, NULL, NULL, ?, ?)`,
    ).run(
      hash(["LIVE_CASH", execution.live_execution_id, "RESERVE"]),
      execution.live_account_id,
      execution.live_execution_id,
      amountMicros.toString(),
      `LIVE_CASH_RESERVE:${execution.live_execution_id}`,
      now,
    );
  }

  /**
   * Last transactional line of defence against concurrent BUY intents. Risk
   * Decisions are immutable evidence, but two individually valid decisions
   * must not reserve the same wallet capital or jointly exceed exposure caps.
   * The caller must hold BEGIN IMMEDIATE while invoking this method.
   */
  reserveChecked(
    execution: LiveExecutionRow,
    amountMicros: bigint,
    external: LiveWalletCapacitySnapshot,
  ): void {
    if (amountMicros <= 0n) throw new Error("LIVE_RESERVATION_AMOUNT_INVALID");
    this.assertBuyReservationCapacity(execution, amountMicros, amountMicros, external);
    this.reserve(execution, amountMicros);
  }

  private assertBuyReservationCapacity(
    execution: LiveExecutionRow,
    finalAmountMicros: bigint,
    additionalAmountMicros: bigint,
    external: LiveWalletCapacitySnapshot,
  ): void {
    const account = this.database.prepare(
      `SELECT status,initial_bankroll_micros,risk_budget_micros
       FROM live_accounts WHERE live_account_id=?`,
    ).get(execution.live_account_id) as {
      status: string;
      initial_bankroll_micros: string;
      risk_budget_micros: string;
    } | undefined;
    if (!account || account.status !== "ACTIVE") throw new Error("LIVE_ACCOUNT_NOT_ACTIVE");

    const bankroll = BigInt(account.initial_bankroll_micros);
    const riskBudget = BigInt(account.risk_budget_micros);
    const singleLimit = minBigInt(
      BigInt(RULESET.liveMaxTradeSizeMicros),
      (bankroll * BigInt(RULESET.liveMaxSingleTradePpm)) / 1_000_000n,
    );
    if (finalAmountMicros > singleLimit) throw new Error("LIVE_RESERVATION_SINGLE_TRADE_LIMIT");

    const pendingTotal = this.pendingReservationTotal(execution.live_account_id);
    if (pendingTotal + additionalAmountMicros > external.walletBalanceMicros) {
      throw new Error("LIVE_RESERVATION_WALLET_BALANCE_INSUFFICIENT");
    }
    if (pendingTotal + additionalAmountMicros > external.walletAllowanceMicros) {
      throw new Error("LIVE_RESERVATION_ALLOWANCE_INSUFFICIENT");
    }

    const totalExposure = this.positionCostTotal(execution.live_account_id);
    const totalLimit = minBigInt(
      riskBudget,
      BigInt(RULESET.liveMaxExposureMicros),
      (bankroll * BigInt(RULESET.liveMaxTotalExposurePpm)) / 1_000_000n,
    );
    if (totalExposure + pendingTotal + additionalAmountMicros > totalLimit) {
      throw new Error("LIVE_RESERVATION_TOTAL_EXPOSURE_LIMIT");
    }

    const marketExposure = this.positionCostTotal(execution.live_account_id, { conditionId: execution.condition_id });
    const marketPending = this.pendingReservationTotal(execution.live_account_id, { conditionId: execution.condition_id });
    const marketLimit = (bankroll * BigInt(RULESET.liveMaxMarketExposurePpm)) / 1_000_000n;
    if (marketExposure + marketPending + additionalAmountMicros > marketLimit) {
      throw new Error("LIVE_RESERVATION_MARKET_EXPOSURE_LIMIT");
    }

    const positionExposure = this.positionCostTotal(execution.live_account_id, { assetId: execution.asset_id });
    const positionPending = this.pendingReservationTotal(execution.live_account_id, { assetId: execution.asset_id });
    const positionLimit = (bankroll * BigInt(RULESET.liveMaxPositionExposurePpm)) / 1_000_000n;
    if (positionExposure + positionPending + additionalAmountMicros > positionLimit) {
      throw new Error("LIVE_RESERVATION_POSITION_EXPOSURE_LIMIT");
    }
  }

  increaseBuyReservationChecked(
    execution: LiveExecutionRow,
    finalAmountMicros: bigint,
    external: LiveWalletCapacitySnapshot,
  ): void {
    const currentAmount = this.reservationBalance(execution.live_execution_id);
    if (currentAmount <= 0n || finalAmountMicros <= currentAmount) {
      throw new Error("LIVE_RESERVATION_INCREASE_AMOUNT_INVALID");
    }
    const delta = finalAmountMicros - currentAmount;
    this.assertBuyReservationCapacity(execution, finalAmountMicros, delta, external);

    const now = this.now().toISOString();
    const adjustmentKey = `AUTO_LIFT:${finalAmountMicros.toString()}`;
    this.database.prepare(
      `INSERT INTO live_reservation_ledger(
        reservation_ledger_id,live_execution_id,live_order_id,entry_type,delta_micros,
        remaining_after_micros,idempotency_key,created_at
      ) VALUES (?, ?, NULL, 'RESERVE', ?, ?, ?, ?)`,
    ).run(
      hash(["LIVE_RESERVATION", execution.live_execution_id, adjustmentKey]),
      execution.live_execution_id,
      delta.toString(),
      finalAmountMicros.toString(),
      `LIVE_RESERVE:${execution.live_execution_id}:${adjustmentKey}`,
      now,
    );
    this.database.prepare(
      `INSERT INTO live_cash_ledger(
        cash_ledger_id,live_account_id,live_execution_id,entry_type,cash_delta_micros,
        reserved_delta_micros,cash_after_micros,reserved_after_micros,idempotency_key,created_at
      ) VALUES (?, ?, ?, 'RESERVE', '0', ?, NULL, NULL, ?, ?)`,
    ).run(
      hash(["LIVE_CASH", execution.live_execution_id, adjustmentKey]),
      execution.live_account_id,
      execution.live_execution_id,
      delta.toString(),
      `LIVE_CASH_RESERVE:${execution.live_execution_id}:${adjustmentKey}`,
      now,
    );
  }

  updateBuyApproval(
    execution: LiveExecutionRow,
    input: { riskDecisionId: string; finalAmountMicros: bigint; reason: string; policyEvidenceHash: string },
  ): LiveExecutionRow {
    const now = this.now().toISOString();
    this.database.prepare(
      `UPDATE live_executions
       SET risk_decision_id=?,requested_amount_micros=?,reason=?,updated_at=?
       WHERE live_execution_id=?`,
    ).run(
      input.riskDecisionId,
      input.finalAmountMicros.toString(),
      input.reason,
      now,
      execution.live_execution_id,
    );
    this.audit("LIVE_EXECUTION", execution.live_execution_id, "buy_amount_adjusted", input.reason, {
      priorAmountMicros: execution.requested_amount_micros,
      finalAmountMicros: input.finalAmountMicros.toString(),
      riskDecisionId: input.riskDecisionId,
      buyAmountPolicyEvidenceHash: input.policyEvidenceHash,
    });
    return this.executionById(execution.live_execution_id)!;
  }

  bindFinalGateRun(executionId: string, liveGateRunId: string): void {
    const execution = this.executionById(executionId);
    if (!execution) throw new Error("LIVE_EXECUTION_NOT_FOUND");
    const now = this.now().toISOString();
    this.database.prepare(
      "UPDATE live_executions SET live_gate_run_id=?,updated_at=? WHERE live_execution_id=?",
    ).run(liveGateRunId, now, executionId);
    this.audit("LIVE_EXECUTION", executionId, "final_gate_bound", "LIVE_FINAL_GATE_RECHECK_ALLOW", {
      liveGateRunId,
      riskDecisionId: execution.risk_decision_id,
    });
  }

  reserveAssetChecked(
    execution: LiveExecutionRow,
    sizeMicros: bigint,
    external: { outcomeBalanceMicros: bigint; outcomeAllowanceMicros: bigint },
  ): void {
    if (sizeMicros <= 0n) throw new Error("LIVE_ASSET_RESERVATION_SIZE_INVALID");
    const pending = this.pendingAssetReservationTotal(execution.live_account_id, execution.asset_id);
    const local = this.openPositions(execution.live_account_id, execution.asset_id)
      .reduce((total, position) => total + BigInt(position.current_size_micros), 0n);
    if (pending + sizeMicros > local) throw new Error("LIVE_ASSET_RESERVATION_LOCAL_POSITION_INSUFFICIENT");
    if (pending + sizeMicros > external.outcomeBalanceMicros) {
      throw new Error("LIVE_ASSET_RESERVATION_WALLET_BALANCE_INSUFFICIENT");
    }
    if (pending + sizeMicros > external.outcomeAllowanceMicros) {
      throw new Error("LIVE_ASSET_RESERVATION_ALLOWANCE_INSUFFICIENT");
    }
    const now = this.now().toISOString();
    this.database.prepare(
      `INSERT INTO live_asset_reservation_ledger(
        asset_reservation_ledger_id,live_execution_id,live_order_id,asset_id,entry_type,
        delta_size_micros,remaining_after_micros,idempotency_key,created_at
      ) VALUES (?, ?, NULL, ?, 'RESERVE', ?, ?, ?, ?)`,
    ).run(
      hash(["LIVE_ASSET_RESERVATION", execution.live_execution_id, "RESERVE"]),
      execution.live_execution_id,
      execution.asset_id,
      sizeMicros.toString(),
      sizeMicros.toString(),
      `LIVE_ASSET_RESERVE:${execution.live_execution_id}`,
      now,
    );
  }

  consumeAssetReservation(execution: LiveExecutionRow, liveOrderId: string, fill: LiveFillEvent): void {
    const current = this.assetReservationBalance(execution.live_execution_id);
    const fillSize = BigInt(fill.sizeMicros);
    if (fillSize <= 0n || fillSize > current) throw new Error("SELL_FILL_EXCEEDS_ASSET_RESERVATION");
    const now = this.now().toISOString();
    this.database.prepare(
      `INSERT OR IGNORE INTO live_asset_reservation_ledger(
        asset_reservation_ledger_id,live_execution_id,live_order_id,asset_id,entry_type,
        delta_size_micros,remaining_after_micros,idempotency_key,created_at
      ) VALUES (?, ?, ?, ?, 'CONSUME', ?, ?, ?, ?)`,
    ).run(
      hash(["LIVE_ASSET_RESERVATION", execution.live_execution_id, "CONSUME", fill.externalFillId]),
      execution.live_execution_id,
      liveOrderId,
      execution.asset_id,
      (-fillSize).toString(),
      (current - fillSize).toString(),
      `LIVE_ASSET_CONSUME:${execution.live_execution_id}:${fill.externalFillId}`,
      now,
    );
  }

  releaseAssetReservation(execution: LiveExecutionRow, liveOrderId: string | null, reason: string): void {
    const current = this.assetReservationBalance(execution.live_execution_id);
    if (current <= 0n) return;
    const now = this.now().toISOString();
    this.database.prepare(
      `INSERT OR IGNORE INTO live_asset_reservation_ledger(
        asset_reservation_ledger_id,live_execution_id,live_order_id,asset_id,entry_type,
        delta_size_micros,remaining_after_micros,idempotency_key,created_at
      ) VALUES (?, ?, ?, ?, 'RELEASE', ?, '0', ?, ?)`,
    ).run(
      hash(["LIVE_ASSET_RESERVATION", execution.live_execution_id, "RELEASE", reason]),
      execution.live_execution_id,
      liveOrderId,
      execution.asset_id,
      (-current).toString(),
      `LIVE_ASSET_RELEASE:${execution.live_execution_id}:${reason}`,
      now,
    );
  }

  releaseReservation(execution: LiveExecutionRow, liveOrderId: string | null, reason: string): void {
    const amountMicros = this.reservationBalance(execution.live_execution_id);
    if (amountMicros <= 0n) return;
    const now = this.now().toISOString();
    this.database.prepare(
      `INSERT OR IGNORE INTO live_reservation_ledger(
        reservation_ledger_id,live_execution_id,live_order_id,entry_type,delta_micros,
        remaining_after_micros,idempotency_key,created_at
      ) VALUES (?, ?, ?, 'RELEASE', ?, '0', ?, ?)`,
    ).run(
      hash(["LIVE_RESERVATION", execution.live_execution_id, "RELEASE", reason]),
      execution.live_execution_id,
      liveOrderId,
      (-amountMicros).toString(),
      `LIVE_RELEASE:${execution.live_execution_id}:${reason}`,
      now,
    );
    this.database.prepare(
      `INSERT OR IGNORE INTO live_cash_ledger(
        cash_ledger_id,live_account_id,live_execution_id,entry_type,cash_delta_micros,
        reserved_delta_micros,cash_after_micros,reserved_after_micros,idempotency_key,created_at
      ) VALUES (?, ?, ?, ?, '0', ?, NULL, NULL, ?, ?)`,
    ).run(
      hash(["LIVE_CASH", execution.live_execution_id, "RELEASE", reason]),
      execution.live_account_id,
      execution.live_execution_id,
      `RELEASE:${reason}`,
      (-amountMicros).toString(),
      `LIVE_CASH_RELEASE:${execution.live_execution_id}:${reason}`,
      now,
    );
  }

  fillAlreadyRecorded(idempotencyKey: string): boolean {
    return this.database.prepare("SELECT 1 ok FROM live_fills WHERE fill_idempotency_key=?").get(idempotencyKey) !== undefined;
  }

  recordFill(input: {
    execution: LiveExecutionRow;
    liveOrderId: string;
    side: LiveOrderSide;
    fill: LiveFillEvent;
  }): { inserted: boolean; fillId: string } {
    const idempotencyKey = fillIdempotencyKey(input.liveOrderId, input.fill.externalFillId);
    const fillId = hash(["LIVE_FILL", input.liveOrderId, input.fill.externalFillId]);
    if (this.fillAlreadyRecorded(idempotencyKey)) return { inserted: false, fillId };
    const now = this.now().toISOString();
    this.database.prepare(
      `INSERT INTO live_fills(
        live_fill_id,live_order_id,live_execution_id,external_fill_id,side,fill_price_units,
        fill_size_micros,fill_notional_micros,fee_micros,fill_timestamp,raw_json,
        fill_idempotency_key,created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      fillId,
      input.liveOrderId,
      input.execution.live_execution_id,
      input.fill.externalFillId,
      input.side,
      input.fill.priceUnits,
      input.fill.sizeMicros,
      input.fill.notionalMicros,
      input.fill.feeMicros,
      input.fill.timestamp,
      stableJson(input.fill.raw),
      idempotencyKey,
      now,
    );
    this.database.prepare(
      `INSERT OR IGNORE INTO live_fill_ledger(
        fill_ledger_id,live_fill_id,live_order_id,live_execution_id,live_position_id,
        side,price_units,size_micros,notional_micros,fee_micros,idempotency_key,created_at
      ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      hash(["LIVE_FILL_LEDGER", fillId]),
      fillId,
      input.liveOrderId,
      input.execution.live_execution_id,
      input.side,
      input.fill.priceUnits,
      input.fill.sizeMicros,
      input.fill.notionalMicros,
      input.fill.feeMicros,
      `LIVE_FILL_LEDGER:${idempotencyKey}`,
      now,
    );
    this.database.prepare(
      `INSERT OR IGNORE INTO live_fee_ledger(
        fee_ledger_id,live_execution_id,live_order_id,fee_micros,fee_source,idempotency_key,created_at
      ) VALUES (?, ?, ?, ?, 'CLOB_FILL', ?, ?)`,
    ).run(
      hash(["LIVE_FEE", fillId]),
      input.execution.live_execution_id,
      input.liveOrderId,
      input.fill.feeMicros,
      `LIVE_FEE:${idempotencyKey}`,
      now,
    );
    return { inserted: true, fillId };
  }

  applyBuyFill(execution: LiveExecutionRow, fill: LiveFillEvent): string {
    const now = this.now().toISOString();
    const positionId = hash(["LIVE_POSITION", execution.live_execution_id]);
    const existing = this.database.prepare("SELECT * FROM live_positions WHERE live_position_id=?")
      .get(positionId) as LivePositionRow | undefined;
    const fillSize = BigInt(fill.sizeMicros);
    const fillCost = BigInt(fill.notionalMicros) + BigInt(fill.feeMicros);
    const reserved = this.reservationBalance(execution.live_execution_id);
    const configVersion = this.rulesetConfigVersion(execution.ruleset_hash);
    if (fillCost > reserved) throw new Error("BUY_FILL_EXCEEDS_RESERVATION");
    if (!existing) {
      this.database.prepare(
        `INSERT INTO live_positions(
          live_position_id,live_account_id,opening_execution_id,signal_id,asset_id,condition_id,outcome,
          entry_price_units,entry_size_micros,entry_notional_micros,entry_fee_micros,current_size_micros,
          remaining_cost_micros,status,frozen_from_status,frozen_reason,frozen_at,realized_pnl_micros,
          ruleset_hash,source_code_commit,source_code_dirty,config_version,created_at,updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, 'OPEN', NULL, NULL, NULL, '0', ?, ?, ?, ?, ?, ?)`,
      ).run(
        positionId,
        execution.live_account_id,
        execution.live_execution_id,
        execution.signal_id,
        execution.asset_id,
        execution.condition_id,
        fill.priceUnits,
        fill.sizeMicros,
        fill.notionalMicros,
        fill.feeMicros,
        fill.sizeMicros,
        fillCost.toString(),
        execution.ruleset_hash,
        this.sourceVersion.commit,
        this.sourceVersion.dirty ? 1 : 0,
        configVersion,
        now,
        now,
      );
      this.transition("LIVE_POSITION", positionId, null, "OPEN", "BUY_FILL", execution.ruleset_hash, now);
    } else {
      if (existing.status !== "OPEN") throw new Error(`LIVE_BUY_POSITION_STATE_INVALID:${existing.status}`);
      const currentSize = BigInt(existing.current_size_micros) + fillSize;
      const remainingCost = BigInt(existing.remaining_cost_micros) + fillCost;
      this.database.prepare(
        "UPDATE live_positions SET current_size_micros=?,remaining_cost_micros=?,updated_at=? WHERE live_position_id=?",
      ).run(currentSize.toString(), remainingCost.toString(), now, positionId);
    }
    this.addExecutionPositionFill(
      execution.live_execution_id,
      positionId,
      execution.requested_size_micros ?? fill.sizeMicros,
      fill.sizeMicros,
      now,
    );
    this.database.prepare(
      `INSERT OR IGNORE INTO live_reservation_ledger(
        reservation_ledger_id,live_execution_id,live_order_id,entry_type,delta_micros,
        remaining_after_micros,idempotency_key,created_at
      ) VALUES (?, ?, NULL, 'CONSUME', ?, ?, ?, ?)`,
    ).run(
      hash(["LIVE_RESERVATION", execution.live_execution_id, "CONSUME", fill.externalFillId]),
      execution.live_execution_id,
      (-fillCost).toString(),
      (reserved - fillCost).toString(),
      `LIVE_CONSUME:${execution.live_execution_id}:${fill.externalFillId}`,
      now,
    );
    this.database.prepare(
      `INSERT OR IGNORE INTO live_cash_ledger(
        cash_ledger_id,live_account_id,live_execution_id,entry_type,cash_delta_micros,
        reserved_delta_micros,cash_after_micros,reserved_after_micros,idempotency_key,created_at
      ) VALUES (?, ?, ?, 'BUY_FILL', ?, ?, NULL, NULL, ?, ?)`,
    ).run(
      hash(["LIVE_CASH", execution.live_execution_id, fill.externalFillId]),
      execution.live_account_id,
      execution.live_execution_id,
      (-fillCost).toString(),
      (-fillCost).toString(),
      `LIVE_CASH_FILL:${execution.live_execution_id}:${fill.externalFillId}`,
      now,
    );
    return positionId;
  }

  private reservationBalance(executionId: string): bigint {
    const rows = this.database.prepare(
      "SELECT delta_micros FROM live_reservation_ledger WHERE live_execution_id=?",
    ).all(executionId) as unknown as Array<{ delta_micros: string }>;
    return rows.reduce((total, row) => total + BigInt(row.delta_micros), 0n);
  }

  applySellFill(execution: LiveExecutionRow, liveOrderId: string, fill: LiveFillEvent): void {
    let remainingToSell = BigInt(fill.sizeMicros);
    const totalFillSize = remainingToSell;
    const proceeds = BigInt(fill.notionalMicros);
    const fee = BigInt(fill.feeMicros);
    const positions = this.openPositions(execution.live_account_id, execution.asset_id);
    const now = this.now().toISOString();
    this.consumeAssetReservation(execution, liveOrderId, fill);
    let allocatedProceeds = 0n;
    let allocatedFee = 0n;
    for (const position of positions) {
      if (remainingToSell <= 0n) break;
      const currentSize = BigInt(position.current_size_micros);
      if (currentSize <= 0n) continue;
      const closeSize = remainingToSell > currentSize ? currentSize : remainingToSell;
      const costBasis = (BigInt(position.remaining_cost_micros) * closeSize) / currentSize;
      const isFinalAllocation = remainingToSell === closeSize;
      const proceedsShare = isFinalAllocation
        ? proceeds - allocatedProceeds
        : (proceeds * closeSize) / totalFillSize;
      const feeShare = isFinalAllocation
        ? fee - allocatedFee
        : (fee * closeSize) / totalFillSize;
      allocatedProceeds += proceedsShare;
      allocatedFee += feeShare;
      const pnl = proceedsShare - costBasis - feeShare;
      const newSize = currentSize - closeSize;
      const newCost = BigInt(position.remaining_cost_micros) - costBasis;
      const newStatus: LivePositionState = newSize === 0n ? "CLOSED" : "PARTIALLY_CLOSED";
      assertTransition(LIVE_POSITION_TRANSITIONS, position.status, newStatus);
      this.database.prepare(
        `UPDATE live_positions
         SET current_size_micros=?,remaining_cost_micros=?,status=?,realized_pnl_micros=?,
             updated_at=?
         WHERE live_position_id=?`,
      ).run(
        newSize.toString(),
        newCost.toString(),
        newStatus,
        (BigInt(position.realized_pnl_micros) + pnl).toString(),
        now,
        position.live_position_id,
      );
      this.transition("LIVE_POSITION", position.live_position_id, position.status, newStatus, "SELL_FILL", execution.ruleset_hash, now);
      this.addExecutionPositionFill(
        execution.live_execution_id,
        position.live_position_id,
        execution.requested_size_micros ?? fill.sizeMicros,
        closeSize.toString(),
        now,
      );
      this.database.prepare(
        `INSERT OR IGNORE INTO live_pnl_ledger(
          pnl_ledger_id,live_account_id,live_position_id,live_execution_id,pnl_type,proceeds_micros,
          cost_basis_micros,fee_micros,pnl_micros,price_source,price_timestamp,ruleset_hash,
          source_code_commit,source_code_dirty,config_version,idempotency_key,created_at
        ) VALUES (?, ?, ?, ?, 'REALIZED', ?, ?, ?, ?, 'CLOB_FILL', ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        hash(["LIVE_PNL", execution.live_execution_id, position.live_position_id, fill.externalFillId]),
        execution.live_account_id,
        position.live_position_id,
        execution.live_execution_id,
        proceedsShare.toString(),
        costBasis.toString(),
        feeShare.toString(),
        pnl.toString(),
        fill.timestamp,
        execution.ruleset_hash,
        this.sourceVersion.commit,
        this.sourceVersion.dirty ? 1 : 0,
        this.rulesetConfigVersion(execution.ruleset_hash),
        `LIVE_PNL:${execution.live_execution_id}:${position.live_position_id}:${fill.externalFillId}`,
        now,
      );
      remainingToSell -= closeSize;
    }
    this.database.prepare(
      `INSERT OR IGNORE INTO live_cash_ledger(
        cash_ledger_id,live_account_id,live_execution_id,entry_type,cash_delta_micros,
        reserved_delta_micros,cash_after_micros,reserved_after_micros,idempotency_key,created_at
      ) VALUES (?, ?, ?, 'SELL_FILL', ?, '0', NULL, NULL, ?, ?)`,
    ).run(
      hash(["LIVE_CASH", execution.live_execution_id, fill.externalFillId]),
      execution.live_account_id,
      execution.live_execution_id,
      (proceeds - fee).toString(),
      `LIVE_CASH_SELL:${execution.live_execution_id}:${fill.externalFillId}`,
      now,
    );
  }

  transaction<T>(work: () => T): T {
    if (this.database.isTransaction) {
      const savepoint = `live_store_${this.savepointSequence += 1}`;
      this.database.exec(`SAVEPOINT ${savepoint}`);
      try {
        const result = work();
        this.database.exec(`RELEASE SAVEPOINT ${savepoint}`);
        return result;
      } catch (error) {
        this.database.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        this.database.exec(`RELEASE SAVEPOINT ${savepoint}`);
        throw error;
      }
    }
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private recordSettlementEvent(input: {
    positionId: string;
    executionId: string | null;
    toStatus: LiveSettlementEventStatus;
    redeemAmountMicros: string | null;
    pnlMicros: string | null;
    resolutionEvidenceJson: string;
    redeemEvidenceJson: string;
    reason: string;
    rulesetHash: string;
    idempotencyKey: string;
    now: string;
  }): boolean {
    const existing = this.database.prepare(
      `SELECT live_position_id,live_execution_id,to_status,redeem_amount_micros,pnl_micros,
              resolution_evidence_json,redeem_evidence_json,reason,ruleset_hash
       FROM live_settlement_events WHERE idempotency_key=?`,
    ).get(input.idempotencyKey) as {
      live_position_id: string;
      live_execution_id: string | null;
      to_status: string;
      redeem_amount_micros: string | null;
      pnl_micros: string | null;
      resolution_evidence_json: string;
      redeem_evidence_json: string;
      reason: string;
      ruleset_hash: string;
    } | undefined;
    if (existing) {
      if (
        existing.live_position_id !== input.positionId
        || existing.live_execution_id !== input.executionId
        || existing.to_status !== input.toStatus
        || existing.redeem_amount_micros !== input.redeemAmountMicros
        || existing.pnl_micros !== input.pnlMicros
        || existing.resolution_evidence_json !== input.resolutionEvidenceJson
        || existing.redeem_evidence_json !== input.redeemEvidenceJson
        || existing.reason !== input.reason
        || existing.ruleset_hash !== input.rulesetHash
      ) throw new Error("LIVE_SETTLEMENT_EVENT_IDEMPOTENCY_CONFLICT");
      return false;
    }
    const latest = this.database.prepare(
      `SELECT event_sequence,to_status FROM live_settlement_events
       WHERE live_position_id=? ORDER BY event_sequence DESC LIMIT 1`,
    ).get(input.positionId) as { event_sequence: number; to_status: LiveSettlementEventStatus } | undefined;
    const sequence = (latest?.event_sequence ?? 0) + 1;
    this.database.prepare(
      `INSERT INTO live_settlement_events(
        settlement_event_id,live_position_id,live_execution_id,event_sequence,
        from_status,to_status,redeem_amount_micros,pnl_micros,resolution_evidence_json,
        redeem_evidence_json,reason,ruleset_hash,source_code_commit,source_code_dirty,
        config_version,idempotency_key,created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      hash(["LIVE_SETTLEMENT_EVENT", input.idempotencyKey]),
      input.positionId,
      input.executionId,
      sequence,
      latest?.to_status ?? null,
      input.toStatus,
      input.redeemAmountMicros,
      input.pnlMicros,
      input.resolutionEvidenceJson,
      input.redeemEvidenceJson,
      input.reason,
      input.rulesetHash,
      this.sourceVersion.commit,
      this.sourceVersion.dirty ? 1 : 0,
      this.rulesetConfigVersion(input.rulesetHash),
      input.idempotencyKey,
      input.now,
    );
    return true;
  }

  recoverableOrders(accountId: string): LiveRecoveryOrderRow[] {
    const rows = this.database.prepare(
      `SELECT o.live_order_id,o.live_execution_id,o.live_order_idempotency_key,o.external_order_id,o.side,o.market_id,
              o.asset_id order_asset_id,o.condition_id order_condition_id,o.order_type,
              o.price_units,o.size_micros,o.status,o.raw_response_json,o.is_terminal,o.confirmation_pending,
              o.buy_budget_complete,o.quote_vwap_price_units,o.amount_micros,o.budget_micros,
              o.registered_wallet_address,o.authorized_signer_address,o.fee_rate_bps,o.fee_exponent,
              o.fee_model_version,o.signed_payload_json,o.order_request_sha256,
              o.ruleset_hash order_ruleset_hash,o.source_code_commit order_source_code_commit,
              o.source_code_dirty order_source_code_dirty,o.config_version order_config_version,
              e.live_account_id,e.signal_id,e.risk_decision_id,e.execution_idempotency_key,
              e.execution_type,e.state,e.asset_id,e.condition_id,e.requested_amount_micros,
              e.requested_size_micros,e.filled_size_micros,e.filled_notional_micros,
              e.fee_micros,e.target_price_units,e.deadline_at,e.attempt_count,e.ruleset_hash
       FROM live_orders o
       JOIN live_executions e ON e.live_execution_id=o.live_execution_id
       WHERE e.live_account_id=?
         AND o.is_terminal=0
       ORDER BY o.created_at,o.live_order_id`,
    ).all(accountId) as unknown as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      live_order_id: row.live_order_id as string,
      live_execution_id: row.live_execution_id as string,
      external_order_id: row.external_order_id as string | null,
      side: row.side as LiveOrderSide,
      market_id: row.market_id as string,
      asset_id: row.order_asset_id as string,
      condition_id: row.order_condition_id as string,
      order_type: row.order_type as string,
      price_units: row.price_units as string,
      size_micros: row.size_micros as string,
      status: row.status as LiveOrderState,
      raw_response_json: row.raw_response_json as string,
      buy_budget_complete: row.buy_budget_complete as number | null,
      live_order_idempotency_key: row.live_order_idempotency_key as string,
      quote_vwap_price_units: row.quote_vwap_price_units as string | null,
      amount_micros: row.amount_micros as string | null,
      budget_micros: row.budget_micros as string | null,
      registered_wallet_address: row.registered_wallet_address as string | null,
      authorized_signer_address: row.authorized_signer_address as string | null,
      fee_rate_bps: row.fee_rate_bps as string | null,
      fee_exponent: row.fee_exponent as number | null,
      fee_model_version: row.fee_model_version as string | null,
      signed_payload_json: row.signed_payload_json as string | null,
      order_request_sha256: row.order_request_sha256 as string | null,
      order_ruleset_hash: row.order_ruleset_hash as string | null,
      order_source_code_commit: row.order_source_code_commit as string | null,
      order_source_code_dirty: row.order_source_code_dirty as number | null,
      order_config_version: row.order_config_version as string | null,
      execution: {
        live_execution_id: row.live_execution_id as string,
        live_account_id: row.live_account_id as string,
        signal_id: row.signal_id as string | null,
        risk_decision_id: row.risk_decision_id as string,
        execution_idempotency_key: row.execution_idempotency_key as string,
        execution_type: row.execution_type as string,
        state: row.state as LiveExecutionState,
        asset_id: row.asset_id as string,
        condition_id: row.condition_id as string,
        requested_amount_micros: row.requested_amount_micros as string | null,
        requested_size_micros: row.requested_size_micros as string | null,
        filled_size_micros: row.filled_size_micros as string,
        filled_notional_micros: row.filled_notional_micros as string,
        fee_micros: row.fee_micros as string,
        target_price_units: row.target_price_units as string | null,
        deadline_at: row.deadline_at as string | null,
        attempt_count: row.attempt_count as number,
        ruleset_hash: row.ruleset_hash as string,
      },
    }));
  }

  localExternalOrderIds(accountId: string): Set<string> {
    const rows = this.database.prepare(
      `SELECT o.external_order_id
       FROM live_orders o
       JOIN live_executions e ON e.live_execution_id=o.live_execution_id
       WHERE e.live_account_id=? AND o.external_order_id IS NOT NULL`,
    ).all(accountId) as unknown as Array<{ external_order_id: string }>;
    return new Set(rows.map((row) => row.external_order_id));
  }

  syncRecoveredOrder(
    order: LiveRecoveryOrderRow,
    input: {
      status: LiveOrderState;
      terminal: boolean;
      confirmationPending: boolean;
      raw: Record<string, unknown>;
    },
  ): void {
    assertTransition(LIVE_ORDER_TRANSITIONS, order.status, input.status);
    const now = this.now().toISOString();
    const totals = this.fillTotals("live_order_id", order.live_order_id);
    this.database.prepare(
      `UPDATE live_orders
       SET status=?,filled_size_micros=?,filled_notional_micros=?,fee_micros=?,
           raw_response_json=?,is_terminal=?,confirmation_pending=?,updated_at=?
       WHERE live_order_id=?`,
    ).run(
      input.status,
      totals.size.toString(),
      totals.notional.toString(),
      totals.fee.toString(),
      stableJson(input.raw),
      input.terminal ? 1 : 0,
      input.confirmationPending ? 1 : 0,
      now,
      order.live_order_id,
    );
    this.transition("LIVE_ORDER", order.live_order_id, order.status, input.status, "RECOVERY_STATUS_SYNC", order.execution.ruleset_hash, now);
    this.audit("LIVE_ORDER", order.live_order_id, "recovery_status_sync", input.status, {
      externalOrderId: order.external_order_id,
      filledSizeMicros: totals.size.toString(),
    });
    this.recordOrderAttempt({
      liveOrderId: order.live_order_id,
      sequence: 2,
      action: "STATUS_SYNC",
      status: "SUCCEEDED",
      errorReason: null,
      request: { externalOrderId: order.external_order_id },
      response: input.raw,
    });
  }

  freezeExecution(executionId: string, reason: string): void {
    this.transaction(() => {
      const row = this.database.prepare("SELECT state,ruleset_hash FROM live_executions WHERE live_execution_id=?")
        .get(executionId) as { state: LiveExecutionState; ruleset_hash: string } | undefined;
      if (!row || row.state === "FROZEN") return;
      this.updateExecutionState(executionId, "FROZEN", reason, row.ruleset_hash);
    });
  }

  forceGateDisabled(reason: string, actor = "LIVE_EXECUTOR"): void {
    const current = this.database.prepare(
      `SELECT execution_mode,live_gate_state FROM live_gate_state WHERE state_id='default'`,
    ).get() as { execution_mode: string; live_gate_state: string } | undefined;
    if (!current) throw new Error("LIVE_GATE_STATE_NOT_INITIALIZED");
    const now = this.now().toISOString();
    this.database.prepare(
      `UPDATE live_gate_state
       SET execution_mode='PAPER',live_gate_state='LIVE_DISABLED',requested_execution_mode=NULL,
           last_preflight_id=NULL,state_reason=?,source_code_commit=?,source_code_dirty=?,
           config_version=?,updated_at=?
       WHERE state_id='default'`,
    ).run(
      reason,
      this.sourceVersion.commit,
      this.sourceVersion.dirty ? 1 : 0,
      VERSIONS.configVersion,
      now,
    );
    this.database.prepare(
      `INSERT OR IGNORE INTO live_gate_state_transitions(
        transition_id,from_execution_mode,to_execution_mode,from_live_gate_state,to_live_gate_state,
        reason,actor,metadata_json,source_code_commit,source_code_dirty,config_version,created_at
      ) VALUES (?, ?, 'PAPER', ?, 'LIVE_DISABLED', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      hash(["LIVE_GATE_FORCE_DISABLE", current.execution_mode, current.live_gate_state, reason, now]),
      current.execution_mode,
      current.live_gate_state,
      reason,
      actor,
      stableJson({ emergency: true }),
      this.sourceVersion.commit,
      this.sourceVersion.dirty ? 1 : 0,
      VERSIONS.configVersion,
      now,
    );
    this.audit("LIVE_GATE", "default", "emergency_disable", reason, { actor });
  }

  isGateActive(): boolean {
    const row = this.database.prepare(
      `SELECT execution_mode,live_gate_state FROM live_gate_state WHERE state_id='default'`,
    ).get() as { execution_mode: string; live_gate_state: string } | undefined;
    return row?.execution_mode === "LIVE" && row.live_gate_state === "LIVE_ACTIVE";
  }

  markSettlementPending(input: {
    positionId: string;
    checkedAt: string;
    resolutionSnapshot: Record<string, unknown>;
  }): void {
    this.transaction(() => {
      const position = this.database.prepare(
      `SELECT p.live_position_id,p.condition_id,p.asset_id,p.status,p.ruleset_hash,c.market_end_time
       FROM live_positions p
       LEFT JOIN signal_execution_contexts c ON c.signal_id=p.signal_id
       WHERE p.live_position_id=?`,
    ).get(input.positionId) as {
      live_position_id: string;
      condition_id: string;
      asset_id: string;
      status: LivePositionState;
      ruleset_hash: string;
      market_end_time: string | null;
    } | undefined;
      if (!position) throw new Error("LIVE_POSITION_NOT_FOUND");
      if (!["OPEN", "PARTIALLY_CLOSED", "SETTLEMENT_PENDING"].includes(position.status)) return;
      const marketEnd = position.market_end_time === null ? Number.NaN : Date.parse(position.market_end_time);
      const checkedAt = Date.parse(input.checkedAt);
      if (!Number.isFinite(marketEnd) || !Number.isFinite(checkedAt) || checkedAt < marketEnd || checkedAt > this.now().valueOf()) {
        throw new Error("LIVE_SETTLEMENT_PENDING_TIME_INVALID");
      }
      const now = this.now().toISOString();
      if (position.status !== "SETTLEMENT_PENDING") {
        assertTransition(LIVE_POSITION_TRANSITIONS, position.status, "SETTLEMENT_PENDING");
        this.database.prepare("UPDATE live_positions SET status='SETTLEMENT_PENDING',updated_at=? WHERE live_position_id=?")
          .run(now, position.live_position_id);
        this.transition("LIVE_POSITION", position.live_position_id, position.status, "SETTLEMENT_PENDING", "MARKET_ENDED_RESULT_PENDING", position.ruleset_hash, now);
      }
      const redeemKey = redeemIdempotencyKey(position.live_position_id, position.condition_id, position.asset_id);
      const resolutionEvidence = stableJson({ resolved: false, checkedAt: input.checkedAt, snapshot: input.resolutionSnapshot });
      const inserted = this.database.prepare(
      `INSERT OR IGNORE INTO live_settlement_ledger(
        settlement_ledger_id,live_position_id,live_execution_id,condition_id,asset_id,
        settlement_status,redeem_amount_micros,pnl_micros,resolution_snapshot_json,
        redeem_idempotency_key,created_at
      ) VALUES (?, ?, NULL, ?, ?, 'PENDING', NULL, NULL, ?, ?, ?)`,
    ).run(
      hash(["LIVE_SETTLEMENT", position.live_position_id]),
      position.live_position_id,
      position.condition_id,
      position.asset_id,
      resolutionEvidence,
      redeemKey,
      now,
    );
      if (inserted.changes > 0) {
        this.recordSettlementEvent({
          positionId: position.live_position_id,
          executionId: null,
          toStatus: "PENDING",
          redeemAmountMicros: null,
          pnlMicros: null,
          resolutionEvidenceJson: resolutionEvidence,
          redeemEvidenceJson: "{}",
          reason: "MARKET_ENDED_RESULT_PENDING",
          rulesetHash: position.ruleset_hash,
          idempotencyKey: `LIVE_SETTLEMENT_EVENT:${position.live_position_id}:PENDING`,
          now,
        });
        this.transition("LIVE_SETTLEMENT", position.live_position_id, null, "PENDING", "MARKET_ENDED_RESULT_PENDING", position.ruleset_hash, now);
      }
      this.audit("LIVE_SETTLEMENT", position.live_position_id, "pending", "MARKET_ENDED_RESULT_PENDING", {
        checkedAt: input.checkedAt,
        snapshot: input.resolutionSnapshot,
      });
    });
  }

  confirmSettlement(input: LiveSettlementConfirmation): { redeemAmountMicros: string; pnlMicros: string } {
    return this.transaction(() => {
      if (!input.resolved) throw new Error("LIVE_SETTLEMENT_NOT_RESOLVED");
      const numerator = BigInt(input.payoutNumerator);
      const denominator = BigInt(input.payoutDenominator);
      if (denominator <= 0n || numerator < 0n || numerator > denominator) {
        throw new Error("LIVE_SETTLEMENT_PAYOUT_INVALID");
      }
      const position = this.database.prepare(
      `SELECT p.live_position_id,p.condition_id,p.asset_id,p.current_size_micros,
              p.remaining_cost_micros,p.status,p.ruleset_hash,c.market_end_time
       FROM live_positions p
       LEFT JOIN signal_execution_contexts c ON c.signal_id=p.signal_id
       WHERE p.live_position_id=?`,
    ).get(input.positionId) as {
      live_position_id: string;
      condition_id: string;
      asset_id: string;
      current_size_micros: string;
      remaining_cost_micros: string;
      status: LivePositionState;
      ruleset_hash: string;
      market_end_time: string | null;
    } | undefined;
      if (!position) throw new Error("LIVE_POSITION_NOT_FOUND");
      if (!["OPEN", "PARTIALLY_CLOSED", "SETTLEMENT_PENDING"].includes(position.status)) {
        throw new Error(`LIVE_POSITION_NOT_SETTLEABLE:${position.status}`);
      }
      if (BigInt(position.current_size_micros) <= 0n) throw new Error("LIVE_SETTLEMENT_POSITION_EMPTY");
      const marketEnd = position.market_end_time === null ? Number.NaN : Date.parse(position.market_end_time);
      const confirmedAt = Date.parse(input.confirmedAt);
      const currentTime = this.now().valueOf();
      if (!Number.isFinite(marketEnd)) throw new Error("LIVE_SETTLEMENT_MARKET_END_UNKNOWN");
      if (!Number.isFinite(confirmedAt) || confirmedAt < marketEnd || confirmedAt > currentTime) {
        throw new Error("LIVE_SETTLEMENT_CONFIRMATION_TIME_INVALID");
      }
      if (Object.keys(input.resolutionSnapshot).length === 0) throw new Error("LIVE_SETTLEMENT_EVIDENCE_MISSING");
      const redeemAmount = (BigInt(position.current_size_micros) * numerator) / denominator;
      const pnl = redeemAmount - BigInt(position.remaining_cost_micros);
      const redeemKey = redeemIdempotencyKey(position.live_position_id, position.condition_id, position.asset_id);
      const resolution = stableJson({
      resolved: true,
      payoutNumerator: input.payoutNumerator,
      payoutDenominator: input.payoutDenominator,
      confirmedAt: input.confirmedAt,
      snapshot: input.resolutionSnapshot,
    });
      const now = this.now().toISOString();
      const existing = this.database.prepare(
      `SELECT settlement_status,redeem_amount_micros,pnl_micros,resolution_snapshot_json
       FROM live_settlement_ledger WHERE live_position_id=?`,
    ).get(position.live_position_id) as {
      settlement_status: string;
      redeem_amount_micros: string | null;
      pnl_micros: string | null;
      resolution_snapshot_json: string;
    } | undefined;
      if (existing) {
        if (existing.settlement_status === "PENDING") {
          this.database.prepare(
          `UPDATE live_settlement_ledger
           SET settlement_status='RESOLVED',redeem_amount_micros=?,pnl_micros=?,resolution_snapshot_json=?
           WHERE live_position_id=? AND settlement_status='PENDING'`,
        ).run(redeemAmount.toString(), pnl.toString(), resolution, position.live_position_id);
          this.recordSettlementEvent({
            positionId: position.live_position_id,
            executionId: null,
            toStatus: "RESOLVED",
            redeemAmountMicros: redeemAmount.toString(),
            pnlMicros: pnl.toString(),
            resolutionEvidenceJson: resolution,
            redeemEvidenceJson: "{}",
            reason: "SETTLEMENT_CONFIRMED",
            rulesetHash: position.ruleset_hash,
            idempotencyKey: `LIVE_SETTLEMENT_EVENT:${position.live_position_id}:RESOLVED:${hash([resolution])}`,
            now,
          });
          this.transition("LIVE_SETTLEMENT", position.live_position_id, "PENDING", "RESOLVED", "SETTLEMENT_CONFIRMED", position.ruleset_hash, now);
          this.audit("LIVE_SETTLEMENT", position.live_position_id, "resolved", "SETTLEMENT_CONFIRMED", {
            redeemAmountMicros: redeemAmount.toString(),
            payoutNumerator: input.payoutNumerator,
            payoutDenominator: input.payoutDenominator,
            promotedFromPending: true,
          });
          return { redeemAmountMicros: redeemAmount.toString(), pnlMicros: pnl.toString() };
        }
        if (existing.redeem_amount_micros !== redeemAmount.toString()
          || existing.pnl_micros !== pnl.toString()
          || existing.resolution_snapshot_json !== resolution) {
          throw new Error("LIVE_SETTLEMENT_CONFLICT");
        }
        return { redeemAmountMicros: redeemAmount.toString(), pnlMicros: pnl.toString() };
      }
      if (position.status !== "SETTLEMENT_PENDING") {
        assertTransition(LIVE_POSITION_TRANSITIONS, position.status, "SETTLEMENT_PENDING");
        this.database.prepare(
        `UPDATE live_positions SET status='SETTLEMENT_PENDING',updated_at=? WHERE live_position_id=?`,
      ).run(now, position.live_position_id);
        this.transition("LIVE_POSITION", position.live_position_id, position.status, "SETTLEMENT_PENDING", "SETTLEMENT_CONFIRMED", position.ruleset_hash, now);
      }
      this.database.prepare(
      `INSERT INTO live_settlement_ledger(
        settlement_ledger_id,live_position_id,live_execution_id,condition_id,asset_id,
        settlement_status,redeem_amount_micros,pnl_micros,resolution_snapshot_json,
        redeem_idempotency_key,created_at
      ) VALUES (?, ?, NULL, ?, ?, 'RESOLVED', ?, ?, ?, ?, ?)`,
    ).run(
      hash(["LIVE_SETTLEMENT", position.live_position_id]),
      position.live_position_id,
      position.condition_id,
      position.asset_id,
      redeemAmount.toString(),
      pnl.toString(),
      resolution,
      redeemKey,
      now,
    );
      this.recordSettlementEvent({
        positionId: position.live_position_id,
        executionId: null,
        toStatus: "RESOLVED",
        redeemAmountMicros: redeemAmount.toString(),
        pnlMicros: pnl.toString(),
        resolutionEvidenceJson: resolution,
        redeemEvidenceJson: "{}",
        reason: "SETTLEMENT_CONFIRMED",
        rulesetHash: position.ruleset_hash,
        idempotencyKey: `LIVE_SETTLEMENT_EVENT:${position.live_position_id}:RESOLVED:${hash([resolution])}`,
        now,
      });
      this.transition("LIVE_SETTLEMENT", position.live_position_id, null, "RESOLVED", "SETTLEMENT_CONFIRMED", position.ruleset_hash, now);
      this.audit("LIVE_SETTLEMENT", position.live_position_id, "resolved", "SETTLEMENT_CONFIRMED", {
        redeemAmountMicros: redeemAmount.toString(),
        payoutNumerator: input.payoutNumerator,
        payoutDenominator: input.payoutDenominator,
      });
      return { redeemAmountMicros: redeemAmount.toString(), pnlMicros: pnl.toString() };
    });
  }

  settlementForRedeem(positionId: string): (LiveSettlementRecord & {
    live_account_id: string;
    signal_id: string | null;
    current_size_micros: string;
    remaining_cost_micros: string;
    position_status: LivePositionState;
    ruleset_hash: string;
  }) | null {
    const row = this.database.prepare(
      `SELECT s.*,p.live_account_id,p.signal_id,p.current_size_micros,p.remaining_cost_micros,
              p.status position_status,p.ruleset_hash
       FROM live_settlement_ledger s
       JOIN live_positions p ON p.live_position_id=s.live_position_id
       WHERE s.live_position_id=?`,
    ).get(positionId) as (LiveSettlementRecord & {
      live_account_id: string;
      signal_id: string | null;
      current_size_micros: string;
      remaining_cost_micros: string;
      position_status: LivePositionState;
      ruleset_hash: string;
    }) | undefined;
    return row ?? null;
  }

  saveRedeemResult(input: {
    positionId: string;
    executionId: string;
    idempotencyKey: string;
    status: "DISABLED" | "SUBMITTED" | "CONFIRMED" | "FAILED";
    adapterType: string;
    raw: Record<string, unknown>;
  }): void {
    this.transaction(() => {
      const now = this.now().toISOString();
      const current = this.database.prepare(
        "SELECT status FROM live_redeems WHERE redeem_idempotency_key=?",
      ).get(input.idempotencyKey) as { status: string } | undefined;
      const settlementBefore = this.database.prepare(
        `SELECT s.settlement_status,s.redeem_amount_micros,s.pnl_micros,
                s.resolution_snapshot_json,p.ruleset_hash
         FROM live_settlement_ledger s
         JOIN live_positions p ON p.live_position_id=s.live_position_id
         WHERE s.live_position_id=?`,
      ).get(input.positionId) as {
        settlement_status: string;
        redeem_amount_micros: string | null;
        pnl_micros: string | null;
        resolution_snapshot_json: string;
        ruleset_hash: string;
      } | undefined;
      if (!settlementBefore) throw new Error("LIVE_SETTLEMENT_NOT_FOUND");
      const nextSettlementStatus = input.status === "CONFIRMED" ? "REDEEMED"
        : input.status === "SUBMITTED" ? "REDEEM_PENDING"
          : input.status === "DISABLED" ? "REDEEM_DISABLED" : "RESOLVED";
      const eventStatus: LiveSettlementEventStatus = input.status === "CONFIRMED" ? "REDEEMED"
        : input.status === "SUBMITTED" ? "REDEEM_PENDING"
          : input.status === "DISABLED" ? "DISABLED" : "RESOLVED";
      const redeemEvidence = stableJson({
        status: input.status,
        adapterType: input.adapterType,
        raw: input.raw,
      });
      this.database.prepare(
      `INSERT INTO live_redeems(
        live_redeem_id,live_position_id,redeem_idempotency_key,status,adapter_type,
        raw_response_json,created_at,updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(redeem_idempotency_key) DO UPDATE SET
        status=excluded.status,adapter_type=excluded.adapter_type,
        raw_response_json=excluded.raw_response_json,updated_at=excluded.updated_at`,
    ).run(
      hash(["LIVE_REDEEM", input.idempotencyKey]),
      input.positionId,
      input.idempotencyKey,
      input.status,
      input.adapterType,
      stableJson(input.raw),
      now,
      now,
    );
      this.database.prepare(
      `UPDATE live_settlement_ledger
       SET live_execution_id=?,settlement_status=?
       WHERE live_position_id=?`,
    ).run(
      input.executionId,
      nextSettlementStatus,
      input.positionId,
    );
      const eventReason = `REDEEM_${input.status}`;
      this.recordSettlementEvent({
        positionId: input.positionId,
        executionId: input.executionId,
        toStatus: eventStatus,
        redeemAmountMicros: settlementBefore.redeem_amount_micros,
        pnlMicros: settlementBefore.pnl_micros,
        resolutionEvidenceJson: settlementBefore.resolution_snapshot_json,
        redeemEvidenceJson: redeemEvidence,
        reason: eventReason,
        rulesetHash: settlementBefore.ruleset_hash,
        idempotencyKey: `LIVE_SETTLEMENT_EVENT:${input.positionId}:REDEEM_RESULT:${input.status}:${hash([redeemEvidence])}`,
        now,
      });
      if (settlementBefore.settlement_status !== nextSettlementStatus) {
        this.transition(
          "LIVE_SETTLEMENT",
          input.positionId,
          settlementBefore.settlement_status,
          nextSettlementStatus,
          eventReason,
          settlementBefore.ruleset_hash,
          now,
        );
      }
      this.audit("LIVE_SETTLEMENT", input.positionId, "redeem_result", eventReason, {
        executionId: input.executionId,
        status: input.status,
        adapterType: input.adapterType,
        raw: input.raw,
      });
      this.transition("LIVE_REDEEM", input.positionId, current?.status ?? "CREATED", input.status, "REDEEM_ADAPTER_RESULT", settlementBefore.ruleset_hash, now);
      this.audit("LIVE_REDEEM", input.positionId, "redeem_attempt", input.status, input.raw);
    });
  }

  createRedeemIntent(input: {
    positionId: string;
    executionId: string;
    idempotencyKey: string;
    adapterType: string;
  }): void {
    this.transaction(() => {
      const now = this.now().toISOString();
      const settlementBefore = this.database.prepare(
        `SELECT s.settlement_status,s.redeem_amount_micros,s.pnl_micros,
                s.resolution_snapshot_json,p.ruleset_hash
         FROM live_settlement_ledger s
         JOIN live_positions p ON p.live_position_id=s.live_position_id
         WHERE s.live_position_id=?`,
      ).get(input.positionId) as {
        settlement_status: string;
        redeem_amount_micros: string | null;
        pnl_micros: string | null;
        resolution_snapshot_json: string;
        ruleset_hash: string;
      } | undefined;
      if (!settlementBefore) throw new Error("LIVE_SETTLEMENT_NOT_FOUND");
      const redeemEvidence = stableJson({
        status: "CREATED",
        executionId: input.executionId,
        idempotencyKey: input.idempotencyKey,
        adapterType: input.adapterType,
      });
      this.database.prepare(
      `INSERT INTO live_redeems(
        live_redeem_id,live_position_id,redeem_idempotency_key,status,adapter_type,
        raw_response_json,created_at,updated_at
      ) VALUES (?, ?, ?, 'CREATED', ?, '{}', ?, ?)`,
    ).run(
      hash(["LIVE_REDEEM", input.idempotencyKey]),
      input.positionId,
      input.idempotencyKey,
      input.adapterType,
      now,
      now,
    );
      this.database.prepare(
      `UPDATE live_settlement_ledger
       SET live_execution_id=?,settlement_status='REDEEM_PENDING'
       WHERE live_position_id=?`,
    ).run(input.executionId, input.positionId);
      this.recordSettlementEvent({
        positionId: input.positionId,
        executionId: input.executionId,
        toStatus: "REDEEM_PENDING",
        redeemAmountMicros: settlementBefore.redeem_amount_micros,
        pnlMicros: settlementBefore.pnl_micros,
        resolutionEvidenceJson: settlementBefore.resolution_snapshot_json,
        redeemEvidenceJson: redeemEvidence,
        reason: "REDEEM_INTENT_CREATED",
        rulesetHash: settlementBefore.ruleset_hash,
        idempotencyKey: `LIVE_SETTLEMENT_EVENT:${input.positionId}:REDEEM_PENDING:${input.idempotencyKey}`,
        now,
      });
      if (settlementBefore.settlement_status !== "REDEEM_PENDING") {
        this.transition(
          "LIVE_SETTLEMENT",
          input.positionId,
          settlementBefore.settlement_status,
          "REDEEM_PENDING",
          "REDEEM_INTENT_CREATED",
          settlementBefore.ruleset_hash,
          now,
        );
      }
      this.audit("LIVE_SETTLEMENT", input.positionId, "redeem_pending", "REDEEM_INTENT_CREATED", {
        executionId: input.executionId,
        adapterType: input.adapterType,
      });
      this.transition("LIVE_REDEEM", input.positionId, null, "CREATED", "REDEEM_INTENT_CREATED", settlementBefore.ruleset_hash, now);
      this.audit("LIVE_REDEEM", input.positionId, "created", "REDEEM_INTENT_CREATED", {
        executionId: input.executionId,
        adapterType: input.adapterType,
      });
    });
  }

  finalizeConfirmedRedeem(execution: LiveExecutionRow, settlement: LiveSettlementRecord & {
    live_account_id: string;
    current_size_micros: string;
    remaining_cost_micros: string;
    position_status: LivePositionState;
    ruleset_hash: string;
  }): void {
    this.transaction(() => {
      const position = this.database.prepare(
      `SELECT status,current_size_micros,remaining_cost_micros,realized_pnl_micros,ruleset_hash
       FROM live_positions WHERE live_position_id=?`,
    ).get(settlement.live_position_id) as {
      status: LivePositionState;
      current_size_micros: string;
      remaining_cost_micros: string;
      realized_pnl_micros: string;
      ruleset_hash: string;
    } | undefined;
      if (!position) throw new Error("LIVE_POSITION_NOT_FOUND");
      if (position.status === "REDEEMED") return;
      if (position.status !== "SETTLEMENT_PENDING") throw new Error(`LIVE_POSITION_NOT_REDEEMABLE:${position.status}`);
      const now = this.now().toISOString();
      const redeemAmount = BigInt(settlement.redeem_amount_micros);
      const costBasis = BigInt(position.remaining_cost_micros);
      const pnl = redeemAmount - costBasis;
      this.database.prepare(
      `INSERT OR IGNORE INTO live_cash_ledger(
        cash_ledger_id,live_account_id,live_execution_id,entry_type,cash_delta_micros,
        reserved_delta_micros,cash_after_micros,reserved_after_micros,idempotency_key,created_at
      ) VALUES (?, ?, ?, 'REDEEM', ?, '0', NULL, NULL, ?, ?)`,
    ).run(
      hash(["LIVE_CASH", execution.live_execution_id, "REDEEM"]),
      settlement.live_account_id,
      execution.live_execution_id,
      redeemAmount.toString(),
      `LIVE_CASH_REDEEM:${settlement.redeem_idempotency_key}`,
      now,
    );
      this.database.prepare(
      `INSERT OR IGNORE INTO live_pnl_ledger(
        pnl_ledger_id,live_account_id,live_position_id,live_execution_id,pnl_type,
        proceeds_micros,cost_basis_micros,fee_micros,pnl_micros,price_source,
        price_timestamp,ruleset_hash,source_code_commit,source_code_dirty,config_version,
        idempotency_key,created_at
      ) VALUES (?, ?, ?, ?, 'SETTLEMENT', ?, ?, '0', ?, 'CONFIRMED_SETTLEMENT', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      hash(["LIVE_PNL", execution.live_execution_id, settlement.live_position_id, "SETTLEMENT"]),
      settlement.live_account_id,
      settlement.live_position_id,
      execution.live_execution_id,
      redeemAmount.toString(),
      costBasis.toString(),
      pnl.toString(),
      now,
      settlement.ruleset_hash,
      this.sourceVersion.commit,
      this.sourceVersion.dirty ? 1 : 0,
      this.rulesetConfigVersion(settlement.ruleset_hash),
      `LIVE_PNL_REDEEM:${settlement.redeem_idempotency_key}`,
      now,
    );
      assertTransition(LIVE_POSITION_TRANSITIONS, position.status, "REDEEMED");
      assertTransition(LIVE_EXECUTION_TRANSITIONS, execution.state, "EXECUTED");
      this.database.prepare(
      `UPDATE live_positions
       SET current_size_micros='0',remaining_cost_micros='0',status='REDEEMED',
           realized_pnl_micros=?,updated_at=?
       WHERE live_position_id=?`,
    ).run((BigInt(position.realized_pnl_micros) + pnl).toString(), now, settlement.live_position_id);
      this.database.prepare(
      `UPDATE live_executions
       SET filled_size_micros=?,filled_notional_micros=?,fee_micros='0',state='EXECUTED',
           reason='REDEEM_CONFIRMED',updated_at=?
       WHERE live_execution_id=?`,
    ).run(position.current_size_micros, redeemAmount.toString(), now, execution.live_execution_id);
      this.database.prepare(
      `INSERT OR IGNORE INTO live_execution_positions(
        live_execution_id,live_position_id,requested_size_micros,filled_size_micros,created_at
      ) VALUES (?, ?, ?, ?, ?)`,
    ).run(
      execution.live_execution_id,
      settlement.live_position_id,
      execution.requested_size_micros ?? position.current_size_micros,
      position.current_size_micros,
      now,
    );
      const settlementBefore = this.database.prepare(
        `SELECT settlement_status,live_execution_id,redeem_amount_micros,pnl_micros,
                resolution_snapshot_json
         FROM live_settlement_ledger WHERE live_position_id=?`,
      ).get(settlement.live_position_id) as {
        settlement_status: string;
        live_execution_id: string | null;
        redeem_amount_micros: string | null;
        pnl_micros: string | null;
        resolution_snapshot_json: string;
      } | undefined;
      if (!settlementBefore) throw new Error("LIVE_SETTLEMENT_NOT_FOUND");
      const settlementChanged = settlementBefore.live_execution_id !== execution.live_execution_id
        || settlementBefore.settlement_status !== "REDEEMED"
        || settlementBefore.redeem_amount_micros !== redeemAmount.toString()
        || settlementBefore.pnl_micros !== pnl.toString();
      if (settlementChanged) {
        this.database.prepare(
          `UPDATE live_settlement_ledger
           SET live_execution_id=?,settlement_status='REDEEMED',redeem_amount_micros=?,pnl_micros=?
           WHERE live_position_id=?`,
        ).run(execution.live_execution_id, redeemAmount.toString(), pnl.toString(), settlement.live_position_id);
        const redeemRow = this.database.prepare(
          `SELECT status,adapter_type,raw_response_json FROM live_redeems
           WHERE live_position_id=? ORDER BY updated_at DESC,live_redeem_id DESC LIMIT 1`,
        ).get(settlement.live_position_id) as {
          status: string;
          adapter_type: string;
          raw_response_json: string;
        } | undefined;
        const redeemEvidence = redeemRow ? stableJson({
          status: redeemRow.status,
          adapterType: redeemRow.adapter_type,
          rawResponseJson: redeemRow.raw_response_json,
        }) : "{}";
        this.recordSettlementEvent({
          positionId: settlement.live_position_id,
          executionId: execution.live_execution_id,
          toStatus: "REDEEMED",
          redeemAmountMicros: redeemAmount.toString(),
          pnlMicros: pnl.toString(),
          resolutionEvidenceJson: settlementBefore.resolution_snapshot_json,
          redeemEvidenceJson: redeemEvidence,
          reason: "REDEEM_CONFIRMED",
          rulesetHash: settlement.ruleset_hash,
          idempotencyKey: `LIVE_SETTLEMENT_EVENT:${settlement.live_position_id}:REDEEMED:FINALIZE:${execution.live_execution_id}:${hash([redeemEvidence])}`,
          now,
        });
        if (settlementBefore.settlement_status !== "REDEEMED") {
          this.transition(
            "LIVE_SETTLEMENT",
            settlement.live_position_id,
            settlementBefore.settlement_status,
            "REDEEMED",
            "REDEEM_CONFIRMED",
            settlement.ruleset_hash,
            now,
          );
        }
        this.audit("LIVE_SETTLEMENT", settlement.live_position_id, "redeemed", "REDEEM_CONFIRMED", {
          executionId: execution.live_execution_id,
          redeemAmountMicros: redeemAmount.toString(),
          pnlMicros: pnl.toString(),
        });
      }
      this.transition("LIVE_POSITION", settlement.live_position_id, position.status, "REDEEMED", "REDEEM_CONFIRMED", settlement.ruleset_hash, now);
      this.transition("LIVE_EXECUTION", execution.live_execution_id, execution.state, "EXECUTED", "REDEEM_CONFIRMED", settlement.ruleset_hash, now);
      this.audit("LIVE_POSITION", settlement.live_position_id, "redeemed", "REDEEM_CONFIRMED", {
        redeemAmountMicros: redeemAmount.toString(),
        pnlMicros: pnl.toString(),
      });
    });
  }

  existingRedeemStatus(idempotencyKey: string): string | null {
    const row = this.database.prepare("SELECT status FROM live_redeems WHERE redeem_idempotency_key=?")
      .get(idempotencyKey) as { status: string } | undefined;
    return row?.status ?? null;
  }

  openPositions(accountId: string, assetId: string): LivePositionRow[] {
    return this.database.prepare(
      `SELECT * FROM live_positions
       WHERE live_account_id=? AND asset_id=? AND status IN ('OPEN','PARTIALLY_CLOSED')
       ORDER BY created_at,live_position_id`,
    ).all(accountId, assetId) as unknown as LivePositionRow[];
  }

  outcomePositionBalances(accountId: string): Map<string, bigint> {
    const rows = this.database.prepare(
      `SELECT asset_id,current_size_micros FROM live_positions
       WHERE live_account_id=? AND status!='REDEEMED'`,
    ).all(accountId) as unknown as Array<{ asset_id: string; current_size_micros: string }>;
    const balances = new Map<string, bigint>();
    for (const row of rows) {
      const size = BigInt(row.current_size_micros);
      if (size < 0n) throw new Error(`LIVE_POSITION_NEGATIVE:${row.asset_id}`);
      balances.set(row.asset_id, (balances.get(row.asset_id) ?? 0n) + size);
    }
    for (const [assetId, size] of balances) {
      if (size === 0n) balances.delete(assetId);
    }
    return balances;
  }

  externalPositionBaseline(accountId: string): Map<string, bigint> | null {
    const baseline = this.database.prepare(
      `SELECT status,position_count,snapshot_sha256
       FROM live_wallet_position_baselines WHERE live_account_id=?`,
    ).get(accountId) as {
      status: string;
      position_count: number;
      snapshot_sha256: string;
    } | undefined;
    if (!baseline) return null;
    if (baseline.status !== "CAPTURED" || !Number.isSafeInteger(baseline.position_count) || baseline.position_count < 0) {
      throw new Error("LIVE_WALLET_POSITION_BASELINE_INVALID");
    }
    const rows = this.database.prepare(
      `SELECT asset_id,balance_micros
       FROM live_wallet_position_baseline_items
       WHERE live_account_id=? ORDER BY asset_id`,
    ).all(accountId) as unknown as Array<{ asset_id: string; balance_micros: string }>;
    if (rows.length !== baseline.position_count) {
      throw new Error("LIVE_WALLET_POSITION_BASELINE_COUNT_MISMATCH");
    }
    const snapshot = rows.map((row) => {
      if (!row.asset_id || !/^\d+$/.test(row.balance_micros) || BigInt(row.balance_micros) <= 0n) {
        throw new Error("LIVE_WALLET_POSITION_BASELINE_ITEM_INVALID");
      }
      return { assetId: row.asset_id, balanceMicros: row.balance_micros };
    });
    const snapshotSha256 = createHash("sha256").update(stableJson(snapshot)).digest("hex");
    if (snapshotSha256 !== baseline.snapshot_sha256) {
      throw new Error("LIVE_WALLET_POSITION_BASELINE_HASH_MISMATCH");
    }
    return new Map(snapshot.map((row) => [row.assetId, BigInt(row.balanceMicros)]));
  }

  canCaptureExternalPositionBaseline(accountId: string): boolean {
    const account = this.database.prepare(
      "SELECT 1 ok FROM live_accounts WHERE live_account_id=?",
    ).get(accountId);
    if (!account || this.externalPositionBaseline(accountId) !== null) return false;
    const activity = this.database.prepare(
      `SELECT
        (SELECT count(*) FROM live_executions WHERE live_account_id=?)
        + (SELECT count(*) FROM live_positions WHERE live_account_id=?)
        + (SELECT count(*) FROM live_cash_ledger WHERE live_account_id=?)
        AS count`,
    ).get(accountId, accountId, accountId) as { count: number };
    return activity.count === 0;
  }

  captureExternalPositionBaseline(
    accountId: string,
    balances: ReadonlyMap<string, bigint>,
  ): Map<string, bigint> {
    return this.transaction(() => {
      const existing = this.externalPositionBaseline(accountId);
      if (existing !== null) return existing;
      if (!this.canCaptureExternalPositionBaseline(accountId)) {
        throw new Error("LIVE_WALLET_POSITION_BASELINE_CAPTURE_NOT_PRISTINE");
      }
      const snapshot = [...balances.entries()]
        .filter(([, balance]) => balance > 0n)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([assetId, balance]) => {
          if (!assetId || balance <= 0n) throw new Error("LIVE_WALLET_POSITION_BASELINE_INPUT_INVALID");
          return { assetId, balanceMicros: balance.toString() };
        });
      const snapshotSha256 = createHash("sha256").update(stableJson(snapshot)).digest("hex");
      const capturedAt = this.now().toISOString();
      this.database.prepare(
        `INSERT INTO live_wallet_position_baselines(
          live_account_id,status,position_count,snapshot_sha256,source_code_commit,
          source_code_dirty,config_version,captured_at
        ) VALUES (?, 'CAPTURED', ?, ?, ?, ?, ?, ?)`,
      ).run(
        accountId,
        snapshot.length,
        snapshotSha256,
        this.sourceVersion.commit,
        this.sourceVersion.dirty ? 1 : 0,
        VERSIONS.configVersion,
        capturedAt,
      );
      const insertItem = this.database.prepare(
        `INSERT INTO live_wallet_position_baseline_items(
          live_account_id,asset_id,balance_micros,created_at
        ) VALUES (?, ?, ?, ?)`,
      );
      for (const position of snapshot) {
        insertItem.run(accountId, position.assetId, position.balanceMicros, capturedAt);
      }
      const captured = this.externalPositionBaseline(accountId);
      if (captured === null) throw new Error("LIVE_WALLET_POSITION_BASELINE_CAPTURE_FAILED");
      this.audit(
        "LIVE_WALLET_POSITION_BASELINE",
        accountId,
        "captured",
        "PREEXISTING_EXTERNAL_POSITIONS_ISOLATED",
        { positionCount: snapshot.length, snapshotSha256 },
      );
      return captured;
    });
  }

  accountLedgerSnapshot(accountId: string): {
    initialBankrollMicros: bigint;
    reservedMicros: bigint;
    realizedPnlMicros: bigint;
    unpricedPositionCount: number;
  } {
    const account = this.database.prepare(
      "SELECT initial_bankroll_micros FROM live_accounts WHERE live_account_id=?",
    ).get(accountId) as { initial_bankroll_micros: string } | undefined;
    if (!account) throw new Error("LIVE_ACCOUNT_NOT_FOUND");
    const cashRows = this.database.prepare(
      "SELECT reserved_delta_micros FROM live_cash_ledger WHERE live_account_id=?",
    ).all(accountId) as unknown as Array<{ reserved_delta_micros: string }>;
    const pnlRows = this.database.prepare(
      "SELECT pnl_micros FROM live_pnl_ledger WHERE live_account_id=?",
    ).all(accountId) as unknown as Array<{ pnl_micros: string }>;
    const positionRow = this.database.prepare(
      `SELECT count(*) count FROM live_positions
       WHERE live_account_id=? AND status IN ('OPEN','PARTIALLY_CLOSED','SETTLEMENT_PENDING','FROZEN')
         AND current_size_micros!='0'`,
    ).get(accountId) as { count: number };
    const reservedMicros = cashRows.reduce((total, row) => total + BigInt(row.reserved_delta_micros), 0n);
    if (reservedMicros < 0n) throw new Error("LIVE_RESERVED_BALANCE_NEGATIVE");
    return {
      initialBankrollMicros: BigInt(account.initial_bankroll_micros),
      reservedMicros,
      realizedPnlMicros: pnlRows.reduce((total, row) => total + BigInt(row.pnl_micros), 0n),
      unpricedPositionCount: positionRow.count,
    };
  }

  expectedCashBalance(accountId: string): bigint {
    const account = this.database.prepare(
      "SELECT initial_bankroll_micros FROM live_accounts WHERE live_account_id=?",
    ).get(accountId) as { initial_bankroll_micros: string } | undefined;
    if (!account) throw new Error("LIVE_ACCOUNT_NOT_FOUND");
    const rows = this.database.prepare(
      "SELECT cash_delta_micros FROM live_cash_ledger WHERE live_account_id=?",
    ).all(accountId) as unknown as Array<{ cash_delta_micros: string }>;
    const expected = rows.reduce(
      (total, row) => total + BigInt(row.cash_delta_micros),
      BigInt(account.initial_bankroll_micros),
    );
    if (expected < 0n) throw new Error("LIVE_EXPECTED_CASH_NEGATIVE");
    return expected;
  }

  freezeOpenPositions(accountId: string, reason: string): number {
    return this.transaction(() => {
      const positions = this.database.prepare(
        `SELECT live_position_id,status,ruleset_hash FROM live_positions
         WHERE live_account_id=? AND status IN ('OPEN','PARTIALLY_CLOSED','SETTLEMENT_PENDING')`,
      ).all(accountId) as unknown as Array<{ live_position_id: string; status: LivePositionState; ruleset_hash: string }>;
      const now = this.now().toISOString();
      for (const position of positions) {
        assertTransition(LIVE_POSITION_TRANSITIONS, position.status, "FROZEN");
        this.database.prepare(
          `UPDATE live_positions
           SET status='FROZEN',frozen_from_status=?,frozen_reason=?,frozen_at=?,updated_at=?
           WHERE live_position_id=?`,
        ).run(position.status, reason, now, now, position.live_position_id);
        this.transition("LIVE_POSITION", position.live_position_id, position.status, "FROZEN", reason, position.ruleset_hash, now);
      }
      return positions.length;
    });
  }

  /** Restore only positions frozen by a reconciliation check. Other safety
   * freezes (unknown submit, settlement conflict, emergency stop) require
   * explicit human handling and are never cleared here. */
  unfreezeReconciledPositions(accountId: string): number {
    const positions = this.database.prepare(
      `SELECT live_position_id,frozen_from_status,ruleset_hash FROM live_positions
       WHERE live_account_id=? AND status='FROZEN'
         AND (frozen_reason LIKE 'RECONCILIATION:%'
           OR frozen_reason LIKE 'RECOVERY_RECONCILIATION_FAILED:%')`,
    ).all(accountId) as unknown as Array<{
      live_position_id: string;
      frozen_from_status: LivePositionState | null;
      ruleset_hash: string;
    }>;
    const now = this.now().toISOString();
    for (const position of positions) {
      const restored = position.frozen_from_status;
      if (!restored || !["OPEN", "PARTIALLY_CLOSED", "SETTLEMENT_PENDING"].includes(restored)) {
        throw new Error(`LIVE_FROZEN_POSITION_RESTORE_STATE_INVALID:${position.live_position_id}`);
      }
      assertTransition(LIVE_POSITION_TRANSITIONS, "FROZEN", restored);
      this.database.prepare(
        `UPDATE live_positions
         SET status=?,frozen_from_status=NULL,frozen_reason=NULL,frozen_at=NULL,updated_at=?
         WHERE live_position_id=? AND status='FROZEN'`,
      ).run(restored, now, position.live_position_id);
      this.transition(
        "LIVE_POSITION",
        position.live_position_id,
        "FROZEN",
        restored,
        "RECONCILIATION_RESTORED",
        position.ruleset_hash,
        now,
      );
      this.audit("LIVE_POSITION", position.live_position_id, "unfrozen", "RECONCILIATION_RESTORED", {});
    }
    return positions.length;
  }

  saveReconciliationRun(accountId: string, checks: LiveReconciliationCheck[]): string {
    const now = this.now().toISOString();
    const status = checks.every((check) => check.passed) ? "PASSED" : "FAILED";
    const runId = randomUUID();
    this.database.prepare(
      `INSERT INTO live_reconciliation_runs(
        reconciliation_run_id,live_account_id,status,checks_json,source_code_commit,
        source_code_dirty,config_version,created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(runId, accountId, status, stableJson(checks), this.sourceVersion.commit, this.sourceVersion.dirty ? 1 : 0, VERSIONS.configVersion, now);
    return runId;
  }

  saveRecoveryRun(input: {
    accountId: string;
    status: "PASSED" | "FAILED";
    openOrders: number;
    fills: number;
    positions: number;
    reason: string;
    checks: LiveReconciliationCheck[];
  }): string {
    const now = this.now().toISOString();
    const runId = randomUUID();
    this.database.prepare(
      `INSERT INTO live_recovery_runs(
        recovery_run_id,live_account_id,status,recovered_open_orders,recovered_fills,
        recovered_positions,reason,checks_json,source_code_commit,source_code_dirty,
        config_version,created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      runId,
      input.accountId,
      input.status,
      input.openOrders,
      input.fills,
      input.positions,
      input.reason,
      stableJson(input.checks),
      this.sourceVersion.commit,
      this.sourceVersion.dirty ? 1 : 0,
      VERSIONS.configVersion,
      now,
    );
    return runId;
  }

  updateCheckpoint(accountId: string, input: { executionId?: string | null; orderId?: string | null; fillId?: string | null; reconciliationRunId?: string | null }): void {
    const now = this.now().toISOString();
    this.database.prepare(
      `INSERT INTO live_execution_checkpoints(
        live_account_id,last_execution_id,last_order_id,last_fill_id,last_reconciliation_run_id,updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(live_account_id) DO UPDATE SET
        last_execution_id=COALESCE(excluded.last_execution_id,last_execution_id),
        last_order_id=COALESCE(excluded.last_order_id,last_order_id),
        last_fill_id=COALESCE(excluded.last_fill_id,last_fill_id),
        last_reconciliation_run_id=COALESCE(excluded.last_reconciliation_run_id,last_reconciliation_run_id),
        updated_at=excluded.updated_at`,
    ).run(accountId, input.executionId ?? null, input.orderId ?? null, input.fillId ?? null, input.reconciliationRunId ?? null, now);
  }

  transition(entityType: string, entityId: string, fromState: string | null, toState: string, reason: string, rulesetHash: string, now = this.now().toISOString()): void {
    const effectiveRulesetHash = this.entityRulesetHash(entityType, entityId) ?? rulesetHash;
    const version = this.database.prepare(
      "SELECT config_version FROM ruleset_registry WHERE ruleset_hash=?",
    ).get(effectiveRulesetHash) as { config_version: string } | undefined;
    if (!version) throw new Error(`STATE_TRANSITION_RULESET_NOT_REGISTERED:${effectiveRulesetHash}`);
    const row = this.database.prepare(
      "SELECT COALESCE(MAX(sequence),0)+1 seq FROM live_state_transitions WHERE entity_type=? AND entity_id=?",
    ).get(entityType, entityId) as { seq: number };
    this.database.prepare(
      `INSERT OR IGNORE INTO live_state_transitions(
        transition_id,entity_type,entity_id,from_state,to_state,reason,sequence,ruleset_hash,
        source_code_commit,source_code_dirty,config_version,created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      hash(["LIVE_STATE", entityType, entityId, row.seq]),
      entityType,
      entityId,
      fromState,
      toState,
      reason,
      row.seq,
      effectiveRulesetHash,
      this.sourceVersion.commit,
      this.sourceVersion.dirty ? 1 : 0,
      version.config_version,
      now,
    );
  }

  audit(
    entityType: string,
    entityId: string,
    action: string,
    reason: string | null,
    metadata: Record<string, unknown>,
    rulesetHash?: string,
    configVersion?: string,
  ): void {
    const now = this.now().toISOString();
    const effectiveRulesetHash = rulesetHash ?? this.entityRulesetHash(entityType, entityId) ?? RULESET_HASH;
    const registered = this.database.prepare(
      "SELECT config_version FROM ruleset_registry WHERE ruleset_hash=?",
    ).get(effectiveRulesetHash) as { config_version: string } | undefined;
    if (!registered) throw new Error(`AUDIT_RULESET_NOT_REGISTERED:${effectiveRulesetHash}`);
    const effectiveConfigVersion = configVersion ?? registered.config_version;
    this.database.prepare(
      `INSERT INTO audit_log(
        audit_id,timestamp,entity_type,entity_id,action,reason,ruleset_hash,
        source_code_commit,source_code_dirty,config_version,metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      hash(["AUDIT", entityType, entityId, action, reason, now, randomUUID()]),
      now,
      entityType,
      entityId,
      action,
      reason,
      effectiveRulesetHash,
      this.sourceVersion.commit,
      this.sourceVersion.dirty ? 1 : 0,
      effectiveConfigVersion,
      stableJson(metadata),
    );
  }

  private entityRulesetHash(entityType: string, entityId: string): string | null {
    let row: { ruleset_hash: string } | undefined;
    if (entityType === "LIVE_EXECUTION") {
      row = this.database.prepare(
        "SELECT ruleset_hash FROM live_executions WHERE live_execution_id=?",
      ).get(entityId) as { ruleset_hash: string } | undefined;
    } else if (entityType === "LIVE_ORDER") {
      row = this.database.prepare(
        `SELECT e.ruleset_hash
         FROM live_orders o
         JOIN live_executions e ON e.live_execution_id=o.live_execution_id
         WHERE o.live_order_id=?`,
      ).get(entityId) as { ruleset_hash: string } | undefined;
    } else if (["LIVE_POSITION", "LIVE_SETTLEMENT", "LIVE_REDEEM"].includes(entityType)) {
      row = this.database.prepare(
        "SELECT ruleset_hash FROM live_positions WHERE live_position_id=?",
      ).get(entityId) as { ruleset_hash: string } | undefined;
    } else if (entityType === "LIVE_MARKET_CHECK") {
      row = this.database.prepare(
        "SELECT ruleset_hash FROM live_market_checks WHERE market_check_id=?",
      ).get(entityId) as { ruleset_hash: string } | undefined;
    }
    return row?.ruleset_hash ?? null;
  }

  private rulesetConfigVersion(rulesetHash: string): string {
    const row = this.database.prepare(
      "SELECT config_version FROM ruleset_registry WHERE ruleset_hash=?",
    ).get(rulesetHash) as { config_version: string } | undefined;
    if (!row) throw new Error(`RULESET_NOT_REGISTERED:${rulesetHash}`);
    return row.config_version;
  }

  private fillTotals(column: "live_execution_id" | "live_order_id", value: string): {
    size: bigint;
    notional: bigint;
    fee: bigint;
  } {
    const rows = this.database.prepare(
      `SELECT fill_size_micros,fill_notional_micros,fee_micros FROM live_fills WHERE ${column}=?`,
    ).all(value) as unknown as Array<{
      fill_size_micros: string;
      fill_notional_micros: string;
      fee_micros: string;
    }>;
    return rows.reduce((total, row) => ({
      size: total.size + BigInt(row.fill_size_micros),
      notional: total.notional + BigInt(row.fill_notional_micros),
      fee: total.fee + BigInt(row.fee_micros),
    }), { size: 0n, notional: 0n, fee: 0n });
  }

  private pendingReservationTotal(
    accountId: string,
    scope: { conditionId?: string; assetId?: string } = {},
  ): bigint {
    const predicates = ["e.live_account_id=?"];
    const parameters: string[] = [accountId];
    if (scope.conditionId !== undefined) {
      predicates.push("e.condition_id=?");
      parameters.push(scope.conditionId);
    }
    if (scope.assetId !== undefined) {
      predicates.push("e.asset_id=?");
      parameters.push(scope.assetId);
    }
    const rows = this.database.prepare(
      `SELECT r.delta_micros
       FROM live_reservation_ledger r
       JOIN live_executions e ON e.live_execution_id=r.live_execution_id
       WHERE ${predicates.join(" AND ")}`,
    ).all(...parameters) as unknown as Array<{ delta_micros: string }>;
    const total = rows.reduce((sum, row) => sum + BigInt(row.delta_micros), 0n);
    if (total < 0n) throw new Error("LIVE_RESERVATION_LEDGER_NEGATIVE");
    return total;
  }

  private pendingAssetReservationTotal(accountId: string, assetId: string): bigint {
    const rows = this.database.prepare(
      `SELECT r.delta_size_micros
       FROM live_asset_reservation_ledger r
       JOIN live_executions e ON e.live_execution_id=r.live_execution_id
       WHERE e.live_account_id=? AND r.asset_id=?`,
    ).all(accountId, assetId) as unknown as Array<{ delta_size_micros: string }>;
    const total = rows.reduce((sum, row) => sum + BigInt(row.delta_size_micros), 0n);
    if (total < 0n) throw new Error("LIVE_ASSET_RESERVATION_LEDGER_NEGATIVE");
    return total;
  }

  private assetReservationBalance(executionId: string): bigint {
    const rows = this.database.prepare(
      "SELECT delta_size_micros FROM live_asset_reservation_ledger WHERE live_execution_id=?",
    ).all(executionId) as unknown as Array<{ delta_size_micros: string }>;
    return rows.reduce((sum, row) => sum + BigInt(row.delta_size_micros), 0n);
  }

  private positionCostTotal(
    accountId: string,
    scope: { conditionId?: string; assetId?: string } = {},
  ): bigint {
    const predicates = [
      "live_account_id=?",
      "status IN ('OPEN','PARTIALLY_CLOSED','SETTLEMENT_PENDING','FROZEN')",
    ];
    const parameters: string[] = [accountId];
    if (scope.conditionId !== undefined) {
      predicates.push("condition_id=?");
      parameters.push(scope.conditionId);
    }
    if (scope.assetId !== undefined) {
      predicates.push("asset_id=?");
      parameters.push(scope.assetId);
    }
    const rows = this.database.prepare(
      `SELECT remaining_cost_micros FROM live_positions WHERE ${predicates.join(" AND ")}`,
    ).all(...parameters) as unknown as Array<{ remaining_cost_micros: string }>;
    return rows.reduce((sum, row) => sum + BigInt(row.remaining_cost_micros), 0n);
  }

  private addExecutionPositionFill(
    executionId: string,
    positionId: string,
    requestedSizeMicros: string,
    fillSizeMicros: string,
    now: string,
  ): void {
    const existing = this.database.prepare(
      `SELECT filled_size_micros FROM live_execution_positions
       WHERE live_execution_id=? AND live_position_id=?`,
    ).get(executionId, positionId) as { filled_size_micros: string } | undefined;
    if (!existing) {
      this.database.prepare(
        `INSERT INTO live_execution_positions(
          live_execution_id,live_position_id,requested_size_micros,filled_size_micros,created_at
        ) VALUES (?, ?, ?, ?, ?)`,
      ).run(executionId, positionId, requestedSizeMicros, fillSizeMicros, now);
      return;
    }
    const nextFilledSize = BigInt(existing.filled_size_micros) + BigInt(fillSizeMicros);
    this.database.prepare(
      `UPDATE live_execution_positions SET filled_size_micros=?
       WHERE live_execution_id=? AND live_position_id=?`,
    ).run(nextFilledSize.toString(), executionId, positionId);
  }
}

function minBigInt(first: bigint, ...rest: bigint[]): bigint {
  return rest.reduce((minimum, value) => value < minimum ? value : minimum, first);
}
