import type { DatabaseSync } from "node:sqlite";
import { LiveStore } from "./live-store.js";
import type { LiveReconciliationCheck } from "./live-types.js";

function sumBy<Row>(rows: Row[], key: (row: Row) => string, value: (row: Row) => string): Map<string, bigint> {
  const totals = new Map<string, bigint>();
  for (const row of rows) {
    const rowKey = key(row);
    totals.set(rowKey, (totals.get(rowKey) ?? 0n) + BigInt(value(row)));
  }
  return totals;
}

export class LiveReconciliation {
  constructor(
    private readonly database: DatabaseSync,
    private readonly store: LiveStore,
  ) {}

  run(accountId: string, externalChecks: LiveReconciliationCheck[] = []): { passed: boolean; checks: LiveReconciliationCheck[]; runId: string } {
    const checks = [...this.check(accountId), ...externalChecks];
    const runId = this.store.saveReconciliationRun(accountId, checks);
    return { passed: checks.every((check) => check.passed), checks, runId };
  }

  check(accountId: string): LiveReconciliationCheck[] {
    return [
      this.orphanOrderCheck(),
      this.orphanFillCheck(),
      this.orderFillLedgerCheck(accountId),
      this.orderFillTotalCheck(accountId),
      this.executionFillTotalCheck(accountId),
      this.executionPositionTotalCheck(accountId),
      this.fillCashLedgerCheck(accountId),
      this.feeLedgerTotalCheck(accountId),
      this.negativePositionCheck(accountId),
      this.frozenPositionCheck(accountId),
      this.cashLedgerCheck(accountId),
      this.reservationBalanceCheck(accountId),
      this.assetReservationBalanceCheck(accountId),
      this.redeemSettlementCheck(accountId),
    ];
  }

  private orphanOrderCheck(): LiveReconciliationCheck {
    const row = this.database.prepare(
      `SELECT o.live_order_id
       FROM live_orders o
       LEFT JOIN live_executions e ON e.live_execution_id=o.live_execution_id
       WHERE e.live_execution_id IS NULL
       LIMIT 1`,
    ).get() as { live_order_id: string } | undefined;
    return row
      ? { name: "live_orphan_order", passed: false, reason: `ORPHAN_ORDER:${row.live_order_id}` }
      : { name: "live_orphan_order", passed: true, reason: "OK" };
  }

  private orphanFillCheck(): LiveReconciliationCheck {
    const row = this.database.prepare(
      `SELECT f.live_fill_id
       FROM live_fills f
       LEFT JOIN live_orders o ON o.live_order_id=f.live_order_id
       LEFT JOIN live_executions e ON e.live_execution_id=f.live_execution_id
       WHERE o.live_order_id IS NULL OR e.live_execution_id IS NULL
       LIMIT 1`,
    ).get() as { live_fill_id: string } | undefined;
    return row
      ? { name: "live_orphan_fill", passed: false, reason: `ORPHAN_FILL:${row.live_fill_id}` }
      : { name: "live_orphan_fill", passed: true, reason: "OK" };
  }

  private orderFillLedgerCheck(accountId: string): LiveReconciliationCheck {
    const row = this.database.prepare(
      `SELECT f.live_fill_id
       FROM live_fills f
       JOIN live_executions e ON e.live_execution_id=f.live_execution_id
       LEFT JOIN live_fill_ledger l ON l.live_fill_id=f.live_fill_id
       WHERE e.live_account_id=? AND l.live_fill_id IS NULL
       LIMIT 1`,
    ).get(accountId) as { live_fill_id: string } | undefined;
    return row
      ? { name: "live_fill_ledger", passed: false, reason: `FILL_LEDGER_MISSING:${row.live_fill_id}` }
      : { name: "live_fill_ledger", passed: true, reason: "OK" };
  }

  private orderFillTotalCheck(accountId: string): LiveReconciliationCheck {
    const orders = this.database.prepare(
      `SELECT o.live_order_id,o.filled_size_micros
       FROM live_orders o
       JOIN live_executions e ON e.live_execution_id=o.live_execution_id
       WHERE e.live_account_id=? AND e.execution_type IN ('TARGET_BUY','TARGET_SELL','STOP_LOSS')
       ORDER BY o.live_order_id`,
    ).all(accountId) as unknown as Array<{ live_order_id: string; filled_size_micros: string }>;
    const fills = this.database.prepare(
      `SELECT f.live_order_id,f.fill_size_micros FROM live_fills f
       JOIN live_executions e ON e.live_execution_id=f.live_execution_id
       WHERE e.live_account_id=?`,
    ).all(accountId) as unknown as Array<{ live_order_id: string; fill_size_micros: string }>;
    const totals = sumBy(fills, (row) => row.live_order_id, (row) => row.fill_size_micros);
    const mismatch = orders.find((order) => BigInt(order.filled_size_micros) !== (totals.get(order.live_order_id) ?? 0n));
    return mismatch
      ? { name: "live_order_fill_total", passed: false, reason: `ORDER_FILL_MISMATCH:${mismatch.live_order_id}` }
      : { name: "live_order_fill_total", passed: true, reason: "OK" };
  }

  private executionFillTotalCheck(accountId: string): LiveReconciliationCheck {
    const executions = this.database.prepare(
      `SELECT e.live_execution_id,e.filled_size_micros,e.filled_notional_micros,e.fee_micros
       FROM live_executions e
       WHERE e.live_account_id=? AND e.execution_type IN ('TARGET_BUY','TARGET_SELL','STOP_LOSS')
       ORDER BY e.live_execution_id`,
    ).all(accountId) as unknown as Array<{
      live_execution_id: string;
      filled_size_micros: string;
      filled_notional_micros: string;
      fee_micros: string;
    }>;
    const fills = this.database.prepare(
      `SELECT f.live_execution_id,f.fill_size_micros,f.fill_notional_micros,f.fee_micros
       FROM live_fills f JOIN live_executions e ON e.live_execution_id=f.live_execution_id
       WHERE e.live_account_id=?`,
    ).all(accountId) as unknown as Array<{
      live_execution_id: string;
      fill_size_micros: string;
      fill_notional_micros: string;
      fee_micros: string;
    }>;
    const size = sumBy(fills, (row) => row.live_execution_id, (row) => row.fill_size_micros);
    const notional = sumBy(fills, (row) => row.live_execution_id, (row) => row.fill_notional_micros);
    const fee = sumBy(fills, (row) => row.live_execution_id, (row) => row.fee_micros);
    const mismatch = executions.find((execution) => (
      BigInt(execution.filled_size_micros) !== (size.get(execution.live_execution_id) ?? 0n)
      || BigInt(execution.filled_notional_micros) !== (notional.get(execution.live_execution_id) ?? 0n)
      || BigInt(execution.fee_micros) !== (fee.get(execution.live_execution_id) ?? 0n)
    ));
    return mismatch
      ? { name: "live_execution_fill_total", passed: false, reason: `EXECUTION_FILL_MISMATCH:${mismatch.live_execution_id}` }
      : { name: "live_execution_fill_total", passed: true, reason: "OK" };
  }

  private executionPositionTotalCheck(accountId: string): LiveReconciliationCheck {
    const executions = this.database.prepare(
      `SELECT live_execution_id,filled_size_micros FROM live_executions
       WHERE live_account_id=?`,
    ).all(accountId) as unknown as Array<{ live_execution_id: string; filled_size_micros: string }>;
    const positions = this.database.prepare(
      `SELECT p.live_execution_id,p.filled_size_micros FROM live_execution_positions p
       JOIN live_executions e ON e.live_execution_id=p.live_execution_id
       WHERE e.live_account_id=?`,
    ).all(accountId) as unknown as Array<{ live_execution_id: string; filled_size_micros: string }>;
    const totals = sumBy(positions, (row) => row.live_execution_id, (row) => row.filled_size_micros);
    const mismatch = executions.find((execution) => {
      const filled = BigInt(execution.filled_size_micros);
      return filled > 0n && filled !== (totals.get(execution.live_execution_id) ?? 0n);
    });
    return mismatch
      ? { name: "live_execution_position_total", passed: false, reason: `EXECUTION_POSITION_MISMATCH:${mismatch.live_execution_id}` }
      : { name: "live_execution_position_total", passed: true, reason: "OK" };
  }

  private fillCashLedgerCheck(accountId: string): LiveReconciliationCheck {
    const executions = this.database.prepare(
      `SELECT live_execution_id,execution_type FROM live_executions
       WHERE live_account_id=? AND execution_type IN ('TARGET_BUY','TARGET_SELL','STOP_LOSS')`,
    ).all(accountId) as unknown as Array<{ live_execution_id: string; execution_type: string }>;
    const fills = this.database.prepare(
      `SELECT f.live_execution_id,f.fill_notional_micros,f.fee_micros FROM live_fills f
       JOIN live_executions e ON e.live_execution_id=f.live_execution_id WHERE e.live_account_id=?`,
    ).all(accountId) as unknown as Array<{ live_execution_id: string; fill_notional_micros: string; fee_micros: string }>;
    const cash = this.database.prepare(
      `SELECT live_execution_id,cash_delta_micros FROM live_cash_ledger
       WHERE live_account_id=? AND entry_type IN ('BUY_FILL','SELL_FILL')`,
    ).all(accountId) as unknown as Array<{ live_execution_id: string; cash_delta_micros: string }>;
    const notional = sumBy(fills, (row) => row.live_execution_id, (row) => row.fill_notional_micros);
    const fee = sumBy(fills, (row) => row.live_execution_id, (row) => row.fee_micros);
    const cashTotal = sumBy(cash, (row) => row.live_execution_id, (row) => row.cash_delta_micros);
    const mismatch = executions.find((execution) => {
      const fillNotional = notional.get(execution.live_execution_id) ?? 0n;
      const fillFee = fee.get(execution.live_execution_id) ?? 0n;
      const expected = execution.execution_type === "TARGET_BUY"
        ? -(fillNotional + fillFee)
        : fillNotional - fillFee;
      return (cashTotal.get(execution.live_execution_id) ?? 0n) !== expected;
    });
    return mismatch
      ? { name: "live_fill_cash_ledger", passed: false, reason: `FILL_CASH_MISMATCH:${mismatch.live_execution_id}` }
      : { name: "live_fill_cash_ledger", passed: true, reason: "OK" };
  }

  private feeLedgerTotalCheck(accountId: string): LiveReconciliationCheck {
    const executions = this.database.prepare(
      "SELECT live_execution_id FROM live_executions WHERE live_account_id=?",
    ).all(accountId) as unknown as Array<{ live_execution_id: string }>;
    const fills = this.database.prepare(
      `SELECT f.live_execution_id,f.fee_micros FROM live_fills f
       JOIN live_executions e ON e.live_execution_id=f.live_execution_id WHERE e.live_account_id=?`,
    ).all(accountId) as unknown as Array<{ live_execution_id: string; fee_micros: string }>;
    const ledger = this.database.prepare(
      `SELECT l.live_execution_id,l.fee_micros FROM live_fee_ledger l
       JOIN live_executions e ON e.live_execution_id=l.live_execution_id WHERE e.live_account_id=?`,
    ).all(accountId) as unknown as Array<{ live_execution_id: string; fee_micros: string }>;
    const fillFee = sumBy(fills, (row) => row.live_execution_id, (row) => row.fee_micros);
    const ledgerFee = sumBy(ledger, (row) => row.live_execution_id, (row) => row.fee_micros);
    const mismatch = executions.find((execution) => (
      (fillFee.get(execution.live_execution_id) ?? 0n) !== (ledgerFee.get(execution.live_execution_id) ?? 0n)
    ));
    return mismatch
      ? { name: "live_fee_ledger_total", passed: false, reason: `FEE_LEDGER_MISMATCH:${mismatch.live_execution_id}` }
      : { name: "live_fee_ledger_total", passed: true, reason: "OK" };
  }

  private negativePositionCheck(accountId: string): LiveReconciliationCheck {
    const rows = this.database.prepare(
      `SELECT live_position_id,current_size_micros,remaining_cost_micros FROM live_positions
       WHERE live_account_id=?`,
    ).all(accountId) as unknown as Array<{
      live_position_id: string;
      current_size_micros: string;
      remaining_cost_micros: string;
    }>;
    const mismatch = rows.find((row) => BigInt(row.current_size_micros) < 0n || BigInt(row.remaining_cost_micros) < 0n);
    return mismatch
      ? { name: "live_negative_position", passed: false, reason: `NEGATIVE_POSITION:${mismatch.live_position_id}` }
      : { name: "live_negative_position", passed: true, reason: "OK" };
  }

  private frozenPositionCheck(accountId: string): LiveReconciliationCheck {
    const row = this.database.prepare(
      `SELECT count(*) count FROM live_positions
       WHERE live_account_id=? AND status='FROZEN'
         AND NOT (frozen_reason LIKE 'RECONCILIATION:%'
           OR frozen_reason LIKE 'RECOVERY_RECONCILIATION_FAILED:%')`,
    ).get(accountId) as { count: number };
    return row.count > 0
      ? { name: "live_frozen_positions", passed: false, reason: `FROZEN_POSITIONS:${row.count}` }
      : { name: "live_frozen_positions", passed: true, reason: "OK" };
  }

  private cashLedgerCheck(accountId: string): LiveReconciliationCheck {
    const row = this.database.prepare(
      `SELECT count(*) count FROM live_cash_ledger
       WHERE live_account_id=? AND idempotency_key IS NULL`,
    ).get(accountId) as { count: number };
    return row.count > 0
      ? { name: "live_cash_ledger", passed: false, reason: `CASH_LEDGER_IDEMPOTENCY_MISSING:${row.count}` }
      : { name: "live_cash_ledger", passed: true, reason: "OK" };
  }

  private reservationBalanceCheck(accountId: string): LiveReconciliationCheck {
    const executions = this.database.prepare(
      "SELECT live_execution_id,state FROM live_executions WHERE live_account_id=?",
    ).all(accountId) as unknown as Array<{ live_execution_id: string; state: string }>;
    const reservations = this.database.prepare(
      `SELECT r.live_execution_id,r.delta_micros FROM live_reservation_ledger r
       JOIN live_executions e ON e.live_execution_id=r.live_execution_id WHERE e.live_account_id=?`,
    ).all(accountId) as unknown as Array<{ live_execution_id: string; delta_micros: string }>;
    const cashReservations = this.database.prepare(
      `SELECT live_execution_id,reserved_delta_micros FROM live_cash_ledger
       WHERE live_account_id=? AND live_execution_id IS NOT NULL`,
    ).all(accountId) as unknown as Array<{ live_execution_id: string; reserved_delta_micros: string }>;
    const reservationBalance = sumBy(reservations, (row) => row.live_execution_id, (row) => row.delta_micros);
    const cashBalance = sumBy(cashReservations, (row) => row.live_execution_id, (row) => row.reserved_delta_micros);
    const terminal = new Set(["EXECUTED", "EXPIRED", "REJECTED", "CANCELLED", "FAILED"]);
    const mismatch = executions.find((execution) => {
      const reservation = reservationBalance.get(execution.live_execution_id) ?? 0n;
      return reservation < 0n
        || reservation !== (cashBalance.get(execution.live_execution_id) ?? 0n)
        || (terminal.has(execution.state) && reservation !== 0n);
    });
    return mismatch
      ? { name: "live_reservation_balance", passed: false, reason: `RESERVATION_LEDGER_MISMATCH:${mismatch.live_execution_id}` }
      : { name: "live_reservation_balance", passed: true, reason: "OK" };
  }

  private assetReservationBalanceCheck(accountId: string): LiveReconciliationCheck {
    const executions = this.database.prepare(
      `SELECT live_execution_id,state,requested_size_micros,asset_id FROM live_executions
       WHERE live_account_id=? AND execution_type IN ('TARGET_SELL','STOP_LOSS')`,
    ).all(accountId) as unknown as Array<{
      live_execution_id: string;
      state: string;
      requested_size_micros: string | null;
      asset_id: string;
    }>;
    const ledger = this.database.prepare(
      `SELECT r.live_execution_id,r.asset_id,r.delta_size_micros
       FROM live_asset_reservation_ledger r
       JOIN live_executions e ON e.live_execution_id=r.live_execution_id
       WHERE e.live_account_id=?`,
    ).all(accountId) as unknown as Array<{
      live_execution_id: string;
      asset_id: string;
      delta_size_micros: string;
    }>;
    const totals = sumBy(ledger, (row) => row.live_execution_id, (row) => row.delta_size_micros);
    const terminal = new Set(["EXECUTED", "PARTIALLY_EXECUTED", "EXPIRED", "REJECTED", "CANCELLED", "FAILED"]);
    const mismatch = executions.find((execution) => {
      const balance = totals.get(execution.live_execution_id) ?? 0n;
      const requested = execution.requested_size_micros === null ? 0n : BigInt(execution.requested_size_micros);
      const wrongAsset = ledger.some((row) => (
        row.live_execution_id === execution.live_execution_id && row.asset_id !== execution.asset_id
      ));
      return wrongAsset
        || balance < 0n
        || balance > requested
        || (terminal.has(execution.state) && balance !== 0n);
    });
    return mismatch
      ? {
        name: "live_asset_reservation_balance",
        passed: false,
        reason: `ASSET_RESERVATION_LEDGER_MISMATCH:${mismatch.live_execution_id}`,
      }
      : { name: "live_asset_reservation_balance", passed: true, reason: "OK" };
  }

  private redeemSettlementCheck(accountId: string): LiveReconciliationCheck {
    const row = this.database.prepare(
      `SELECT r.live_redeem_id
       FROM live_redeems r
       JOIN live_positions p ON p.live_position_id=r.live_position_id
       LEFT JOIN live_settlement_ledger s ON s.live_position_id=r.live_position_id
       WHERE p.live_account_id=?
         AND (s.live_position_id IS NULL
           OR r.status IN ('CREATED','SUBMITTED','FAILED')
           OR (r.status='CONFIRMED' AND (s.settlement_status!='REDEEMED' OR p.status!='REDEEMED')))
       LIMIT 1`,
    ).get(accountId) as { live_redeem_id: string } | undefined;
    return row
      ? { name: "live_redeem_settlement", passed: false, reason: `REDEEM_SETTLEMENT_MISMATCH:${row.live_redeem_id}` }
      : { name: "live_redeem_settlement", passed: true, reason: "OK" };
  }
}
