import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { RULESET_HASH, stableJson, VERSIONS } from "../domain/versioning.js";
import type { SourceVersion } from "../infra/source-version.js";
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
}

function hash(parts: Array<string | number | null>): string {
  return createHash("sha256").update(parts.map((part) => part ?? "NULL").join("|")).digest("hex");
}

export function liveExecutionIdempotencyKey(accountId: string, signalId: string, riskDecisionId: string): string {
  return `LIVE_EXECUTION:${accountId}:${signalId}:${riskDecisionId}`;
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
    reason: string;
    rulesetHash: string;
  }): LiveExecutionRow {
    const existing = this.existingExecution(input.executionIdempotencyKey);
    if (existing) return existing;
    const now = this.now().toISOString();
    const executionId = hash(["LIVE_EXECUTION", input.executionIdempotencyKey, input.rulesetHash]);
    this.database.prepare(
      `INSERT INTO live_executions(
        live_execution_id,live_account_id,signal_id,context_id,risk_decision_id,live_gate_run_id,
        execution_idempotency_key,execution_type,state,asset_id,condition_id,requested_amount_micros,
        requested_size_micros,filled_size_micros,filled_notional_micros,fee_micros,target_price_units,
        reason,schema_version,strategy_version,risk_version,live_version,ruleset_hash,source_code_commit,
        source_code_dirty,config_version,created_at,updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '0', '0', '0', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      VERSIONS.configVersion,
      now,
      now,
    );
    this.transition("LIVE_EXECUTION", executionId, null, input.state, input.reason, input.rulesetHash, now);
    this.audit("LIVE_EXECUTION", executionId, input.state === "REJECTED" ? "rejected" : "created", input.reason, { signalId: input.signalId });
    return this.existingExecution(input.executionIdempotencyKey)!;
  }

  updateExecutionState(executionId: string, toState: LiveExecutionState, reason: string, rulesetHash: string): void {
    const current = this.database.prepare("SELECT state FROM live_executions WHERE live_execution_id=?")
      .get(executionId) as { state: string } | undefined;
    const now = this.now().toISOString();
    this.database.prepare("UPDATE live_executions SET state=?,reason=?,updated_at=? WHERE live_execution_id=?")
      .run(toState, reason, now, executionId);
    this.transition("LIVE_EXECUTION", executionId, current?.state ?? null, toState, reason, rulesetHash, now);
    this.audit("LIVE_EXECUTION", executionId, toState.toLowerCase(), reason, {});
  }

  updateExecutionTotals(executionId: string): void {
    const row = this.database.prepare(
      `SELECT COALESCE(SUM(CAST(fill_size_micros AS INTEGER)),0) size,
              COALESCE(SUM(CAST(fill_notional_micros AS INTEGER)),0) notional,
              COALESCE(SUM(CAST(fee_micros AS INTEGER)),0) fee
       FROM live_fills WHERE live_execution_id=?`,
    ).get(executionId) as { size: number; notional: number; fee: number };
    const now = this.now().toISOString();
    this.database.prepare(
      "UPDATE live_executions SET filled_size_micros=?,filled_notional_micros=?,fee_micros=?,updated_at=? WHERE live_execution_id=?",
    ).run(row.size.toString(), row.notional.toString(), row.fee.toString(), now, executionId);
  }

  createOrder(input: LiveOrderRequest, executionId: string, adapterType: string): void {
    const now = this.now().toISOString();
    this.database.prepare(
      `INSERT OR IGNORE INTO live_orders(
        live_order_id,live_execution_id,live_order_idempotency_key,external_order_id,market_id,
        asset_id,condition_id,side,order_type,price_units,size_micros,filled_size_micros,
        filled_notional_micros,fee_micros,status,adapter_type,raw_response_json,created_at,updated_at
      ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, '0', '0', '0', 'CREATED', ?, '{}', ?, ?)`,
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
    );
    this.transition("LIVE_ORDER", input.liveOrderId, null, "CREATED", "ORDER_CREATED", RULESET_HASH, now);
  }

  updateOrderFromSubmit(liveOrderId: string, result: OrderSubmitResult): void {
    const current = this.database.prepare("SELECT status FROM live_orders WHERE live_order_id=?")
      .get(liveOrderId) as { status: string } | undefined;
    const now = this.now().toISOString();
    const totals = result.fills.reduce((total, fill) => ({
      size: total.size + BigInt(fill.sizeMicros),
      notional: total.notional + BigInt(fill.notionalMicros),
      fee: total.fee + BigInt(fill.feeMicros),
    }), { size: 0n, notional: 0n, fee: 0n });
    this.database.prepare(
      `UPDATE live_orders
       SET external_order_id=?,status=?,filled_size_micros=?,filled_notional_micros=?,
           fee_micros=?,adapter_type=?,raw_response_json=?,updated_at=?
       WHERE live_order_id=?`,
    ).run(
      result.externalOrderId,
      result.status,
      totals.size.toString(),
      totals.notional.toString(),
      totals.fee.toString(),
      result.adapterType,
      stableJson(result.raw),
      now,
      liveOrderId,
    );
    this.transition("LIVE_ORDER", liveOrderId, current?.status ?? "CREATED", result.status, "ORDER_SUBMIT_RESULT", RULESET_HASH, now);
    this.audit("LIVE_ORDER", liveOrderId, "submit_result", result.status, { externalOrderId: result.externalOrderId });
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
      `INSERT OR IGNORE INTO live_order_attempts(
        attempt_id,live_order_id,attempt_sequence,action,status,error_reason,request_json,response_json,created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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

  releaseReservation(execution: LiveExecutionRow, liveOrderId: string | null, amountMicros: bigint, reason: string): void {
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
  }): void {
    const idempotencyKey = fillIdempotencyKey(input.liveOrderId, input.fill.externalFillId);
    if (this.fillAlreadyRecorded(idempotencyKey)) return;
    const now = this.now().toISOString();
    const fillId = hash(["LIVE_FILL", input.liveOrderId, input.fill.externalFillId]);
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
  }

  applyBuyFill(execution: LiveExecutionRow, fill: LiveFillEvent): string {
    const now = this.now().toISOString();
    const positionId = hash(["LIVE_POSITION", execution.live_execution_id]);
    const existing = this.database.prepare("SELECT * FROM live_positions WHERE live_position_id=?")
      .get(positionId) as LivePositionRow | undefined;
    const fillSize = BigInt(fill.sizeMicros);
    const fillCost = BigInt(fill.notionalMicros) + BigInt(fill.feeMicros);
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
        VERSIONS.configVersion,
        now,
        now,
      );
      this.transition("LIVE_POSITION", positionId, null, "OPEN", "BUY_FILL", execution.ruleset_hash, now);
    } else {
      const currentSize = BigInt(existing.current_size_micros) + fillSize;
      const remainingCost = BigInt(existing.remaining_cost_micros) + fillCost;
      this.database.prepare(
        "UPDATE live_positions SET current_size_micros=?,remaining_cost_micros=?,status='OPEN',updated_at=? WHERE live_position_id=?",
      ).run(currentSize.toString(), remainingCost.toString(), now, positionId);
    }
    this.database.prepare(
      `INSERT OR IGNORE INTO live_execution_positions(
        live_execution_id,live_position_id,requested_size_micros,filled_size_micros,created_at
      ) VALUES (?, ?, ?, ?, ?)`,
    ).run(execution.live_execution_id, positionId, execution.requested_size_micros ?? fill.sizeMicros, fill.sizeMicros, now);
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
      (-BigInt(execution.requested_amount_micros ?? fill.notionalMicros)).toString(),
      `LIVE_CASH_FILL:${execution.live_execution_id}:${fill.externalFillId}`,
      now,
    );
    return positionId;
  }

  applySellFill(execution: LiveExecutionRow, fill: LiveFillEvent): void {
    let remainingToSell = BigInt(fill.sizeMicros);
    const totalFillSize = remainingToSell;
    const proceeds = BigInt(fill.notionalMicros);
    const fee = BigInt(fill.feeMicros);
    const positions = this.openPositions(execution.live_account_id, execution.asset_id);
    const now = this.now().toISOString();
    for (const position of positions) {
      if (remainingToSell <= 0n) break;
      const currentSize = BigInt(position.current_size_micros);
      if (currentSize <= 0n) continue;
      const closeSize = remainingToSell > currentSize ? currentSize : remainingToSell;
      const costBasis = (BigInt(position.remaining_cost_micros) * closeSize) / currentSize;
      const proceedsShare = totalFillSize > 0n ? (proceeds * closeSize) / totalFillSize : 0n;
      const feeShare = totalFillSize > 0n ? (fee * closeSize) / totalFillSize : 0n;
      const pnl = proceedsShare - costBasis - feeShare;
      const newSize = currentSize - closeSize;
      const newCost = BigInt(position.remaining_cost_micros) - costBasis;
      const newStatus: LivePositionState = newSize === 0n ? "CLOSED" : "PARTIALLY_CLOSED";
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
      this.database.prepare(
        `INSERT OR IGNORE INTO live_execution_positions(
          live_execution_id,live_position_id,requested_size_micros,filled_size_micros,created_at
        ) VALUES (?, ?, ?, ?, ?)`,
      ).run(execution.live_execution_id, position.live_position_id, execution.requested_size_micros ?? fill.sizeMicros, closeSize.toString(), now);
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
        VERSIONS.configVersion,
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

  openPositions(accountId: string, assetId: string): LivePositionRow[] {
    return this.database.prepare(
      `SELECT * FROM live_positions
       WHERE live_account_id=? AND asset_id=? AND status IN ('OPEN','PARTIALLY_CLOSED','SETTLEMENT_PENDING')
       ORDER BY created_at,live_position_id`,
    ).all(accountId, assetId) as unknown as LivePositionRow[];
  }

  freezeOpenPositions(accountId: string, reason: string): number {
    const positions = this.database.prepare(
      `SELECT live_position_id,status,ruleset_hash FROM live_positions
       WHERE live_account_id=? AND status IN ('OPEN','PARTIALLY_CLOSED','SETTLEMENT_PENDING')`,
    ).all(accountId) as unknown as Array<{ live_position_id: string; status: LivePositionState; ruleset_hash: string }>;
    const now = this.now().toISOString();
    for (const position of positions) {
      this.database.prepare(
        `UPDATE live_positions
         SET status='FROZEN',frozen_from_status=?,frozen_reason=?,frozen_at=?,updated_at=?
         WHERE live_position_id=?`,
      ).run(position.status, reason, now, now, position.live_position_id);
      this.transition("LIVE_POSITION", position.live_position_id, position.status, "FROZEN", reason, position.ruleset_hash, now);
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
      rulesetHash,
      this.sourceVersion.commit,
      this.sourceVersion.dirty ? 1 : 0,
      VERSIONS.configVersion,
      now,
    );
  }

  audit(entityType: string, entityId: string, action: string, reason: string | null, metadata: Record<string, unknown>): void {
    const now = this.now().toISOString();
    this.database.prepare(
      `INSERT OR IGNORE INTO audit_log(
        audit_id,timestamp,entity_type,entity_id,action,reason,ruleset_hash,
        source_code_commit,source_code_dirty,config_version,metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      hash(["AUDIT", entityType, entityId, action, reason, now]),
      now,
      entityType,
      entityId,
      action,
      reason,
      RULESET_HASH,
      this.sourceVersion.commit,
      this.sourceVersion.dirty ? 1 : 0,
      VERSIONS.configVersion,
      stableJson(metadata),
    );
  }
}
