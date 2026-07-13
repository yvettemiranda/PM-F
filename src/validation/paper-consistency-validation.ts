import { DatabaseSync } from "node:sqlite";
import { check, errorCheck } from "./checks.js";
import type { ValidationCheckResult, ValidationValidator, ValidationValidatorContext } from "./types.js";

interface AccountRow {
  paper_account_id: string;
  cash_balance_micros: string;
  reserved_balance_micros: string;
  realized_pnl_micros: string;
}

interface CashLedgerRow {
  paper_account_id: string;
  cash_delta_micros: string;
  reserved_delta_micros: string;
}

interface PnlLedgerRow {
  paper_account_id: string;
  pnl_micros: string;
}

function sum(rows: string[]): bigint {
  return rows.reduce((total, value) => total + BigInt(value), 0n);
}

function count(database: DatabaseSync, sql: string): number {
  const row = database.prepare(sql).get() as { count: number };
  return row.count;
}

function negativeTextCount(database: DatabaseSync, table: string, columns: string[]): number {
  const rows = database.prepare(`SELECT ${columns.join(",")} FROM ${table}`).all() as unknown as Array<Record<string, string>>;
  return rows.filter((row) => columns.some((column) => BigInt(row[column]!) < 0n)).length;
}

export class PaperConsistencyValidation implements ValidationValidator {
  readonly type = "PAPER_CONSISTENCY" as const;

  async run(context: ValidationValidatorContext): Promise<ValidationCheckResult[]> {
    const database = new DatabaseSync(context.databasePath, { readOnly: true });
    try {
      return [
        this.sqliteIntegrity(database, context.now),
        this.paperLedgerConsistency(database, context.now),
        this.paperReservationConsistency(database, context.now),
        this.paperExecutionFillConsistency(database, context.now),
        this.paperFeeFillConsistency(database, context.now),
        this.paperPositionLedgerConsistency(database, context.now),
        this.paperPortfolioProjection(database, context.now),
        this.orphanRecordCheck(database, context.now),
        this.idempotencyCheck(database, context.now),
        this.negativeStateCheck(database, context.now),
      ];
    } catch (error) {
      return [errorCheck({ checkType: this.type, checkName: "paper_consistency_exception", reason: "CONSISTENCY_VALIDATION_FAILED", error, now: context.now })];
    } finally {
      database.close();
    }
  }

  private sqliteIntegrity(database: DatabaseSync, now: () => Date): ValidationCheckResult {
    const integrity = (database.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check;
    const foreignKeys = database.prepare("PRAGMA foreign_key_check").all() as unknown[];
    const passed = integrity === "ok" && foreignKeys.length === 0;
    return check({
      checkType: this.type,
      checkName: "sqlite_integrity",
      status: passed ? "PASS" : "FAIL",
      reason: passed ? "OK" : "SQLITE_INTEGRITY_OR_FOREIGN_KEY_FAILURE",
      metrics: { integrity, foreignKeyFailures: foreignKeys.length },
      now,
    });
  }

  private paperLedgerConsistency(database: DatabaseSync, now: () => Date): ValidationCheckResult {
    const accounts = database.prepare(
      "SELECT paper_account_id,cash_balance_micros,reserved_balance_micros,realized_pnl_micros FROM paper_accounts",
    ).all() as unknown as AccountRow[];
    const cashRows = database.prepare(
      "SELECT paper_account_id,cash_delta_micros,reserved_delta_micros FROM paper_cash_ledger",
    ).all() as unknown as CashLedgerRow[];
    const pnlRows = database.prepare("SELECT paper_account_id,pnl_micros FROM paper_pnl_ledger").all() as unknown as PnlLedgerRow[];
    const mismatches: string[] = [];
    for (const account of accounts) {
      const ledgerCash = sum(cashRows.filter((row) => row.paper_account_id === account.paper_account_id).map((row) => row.cash_delta_micros));
      const ledgerReserved = sum(cashRows.filter((row) => row.paper_account_id === account.paper_account_id).map((row) => row.reserved_delta_micros));
      const ledgerPnl = sum(pnlRows.filter((row) => row.paper_account_id === account.paper_account_id).map((row) => row.pnl_micros));
      if (ledgerCash !== BigInt(account.cash_balance_micros)) mismatches.push(`CASH:${account.paper_account_id}`);
      if (ledgerReserved !== BigInt(account.reserved_balance_micros)) mismatches.push(`RESERVED:${account.paper_account_id}`);
      if (ledgerPnl !== BigInt(account.realized_pnl_micros)) mismatches.push(`REALIZED_PNL:${account.paper_account_id}`);
    }
    return check({
      checkType: this.type,
      checkName: "paper_ledger_consistency",
      status: mismatches.length === 0 ? "PASS" : "FAIL",
      reason: mismatches.length === 0 ? "OK" : "LEDGER_ACCOUNT_MISMATCH",
      metrics: { accountCount: accounts.length, mismatches },
      now,
    });
  }

  private paperReservationConsistency(database: DatabaseSync, now: () => Date): ValidationCheckResult {
    const accounts = database.prepare(
      "SELECT paper_account_id,reserved_balance_micros FROM paper_accounts",
    ).all() as unknown as Array<{ paper_account_id: string; reserved_balance_micros: string }>;
    const reservations = database.prepare(
      `SELECT reservation_id,paper_account_id,remaining_amount_micros,status
       FROM paper_reservations`,
    ).all() as unknown as Array<{
      reservation_id: string;
      paper_account_id: string;
      remaining_amount_micros: string;
      status: "ACTIVE" | "CONSUMED" | "RELEASED";
    }>;
    const reservationLedger = database.prepare(
      "SELECT reservation_id,delta_micros FROM paper_reservation_ledger",
    ).all() as unknown as Array<{ reservation_id: string; delta_micros: string }>;
    const cashLedger = database.prepare(
      "SELECT paper_account_id,reserved_delta_micros FROM paper_cash_ledger",
    ).all() as unknown as Array<{ paper_account_id: string; reserved_delta_micros: string }>;
    const ledgerByReservation = new Map<string, bigint>();
    for (const row of reservationLedger) {
      ledgerByReservation.set(row.reservation_id, (ledgerByReservation.get(row.reservation_id) ?? 0n) + BigInt(row.delta_micros));
    }
    const activeByAccount = new Map<string, bigint>();
    const reservationMismatches: string[] = [];
    for (const reservation of reservations) {
      const remaining = BigInt(reservation.remaining_amount_micros);
      const ledgerRemaining = ledgerByReservation.get(reservation.reservation_id) ?? 0n;
      if (remaining !== ledgerRemaining) reservationMismatches.push(`LEDGER:${reservation.reservation_id}`);
      if ((reservation.status === "ACTIVE") !== (remaining > 0n)) {
        reservationMismatches.push(`STATUS:${reservation.reservation_id}`);
      }
      if (reservation.status === "ACTIVE") {
        activeByAccount.set(
          reservation.paper_account_id,
          (activeByAccount.get(reservation.paper_account_id) ?? 0n) + remaining,
        );
      }
    }
    const cashReservedByAccount = new Map<string, bigint>();
    for (const row of cashLedger) {
      cashReservedByAccount.set(
        row.paper_account_id,
        (cashReservedByAccount.get(row.paper_account_id) ?? 0n) + BigInt(row.reserved_delta_micros),
      );
    }
    const accountMismatches: string[] = [];
    for (const account of accounts) {
      const recorded = BigInt(account.reserved_balance_micros);
      if (recorded !== (activeByAccount.get(account.paper_account_id) ?? 0n)) {
        accountMismatches.push(`ACTIVE_RESERVATIONS:${account.paper_account_id}`);
      }
      if (recorded !== (cashReservedByAccount.get(account.paper_account_id) ?? 0n)) {
        accountMismatches.push(`CASH_LEDGER:${account.paper_account_id}`);
      }
    }
    const passed = reservationMismatches.length === 0 && accountMismatches.length === 0;
    return check({
      checkType: this.type,
      checkName: "paper_reservation_consistency",
      status: passed ? "PASS" : "FAIL",
      reason: passed ? "OK" : "RESERVATION_LEDGER_MISMATCH",
      metrics: { reservationMismatches, accountMismatches },
      now,
    });
  }

  private paperExecutionFillConsistency(database: DatabaseSync, now: () => Date): ValidationCheckResult {
    const executions = database.prepare(
      `SELECT paper_execution_id,filled_size_micros,filled_notional_micros
       FROM paper_executions`,
    ).all() as unknown as Array<{
      paper_execution_id: string;
      filled_size_micros: string;
      filled_notional_micros: string;
    }>;
    const fills = database.prepare(
      "SELECT paper_execution_id,size_micros,notional_micros FROM paper_fill_ledger",
    ).all() as unknown as Array<{ paper_execution_id: string; size_micros: string; notional_micros: string }>;
    const sizeByExecution = new Map<string, bigint>();
    const notionalByExecution = new Map<string, bigint>();
    for (const fill of fills) {
      sizeByExecution.set(fill.paper_execution_id, (sizeByExecution.get(fill.paper_execution_id) ?? 0n) + BigInt(fill.size_micros));
      notionalByExecution.set(fill.paper_execution_id, (notionalByExecution.get(fill.paper_execution_id) ?? 0n) + BigInt(fill.notional_micros));
    }
    const mismatches = executions
      .filter((execution) => (
        BigInt(execution.filled_size_micros) !== (sizeByExecution.get(execution.paper_execution_id) ?? 0n)
        || BigInt(execution.filled_notional_micros) !== (notionalByExecution.get(execution.paper_execution_id) ?? 0n)
      ))
      .map((execution) => execution.paper_execution_id);
    return check({
      checkType: this.type,
      checkName: "paper_execution_fill_consistency",
      status: mismatches.length === 0 ? "PASS" : "FAIL",
      reason: mismatches.length === 0 ? "OK" : "EXECUTION_FILL_TOTAL_MISMATCH",
      metrics: { mismatches },
      now,
    });
  }

  private paperFeeFillConsistency(database: DatabaseSync, now: () => Date): ValidationCheckResult {
    const orders = database.prepare(
      "SELECT paper_order_id,fee_micros FROM paper_orders",
    ).all() as unknown as Array<{ paper_order_id: string; fee_micros: string }>;
    const fills = database.prepare(
      "SELECT paper_order_id,fee_micros FROM paper_fill_ledger",
    ).all() as unknown as Array<{ paper_order_id: string; fee_micros: string }>;
    const fees = database.prepare(
      "SELECT paper_order_id,fee_micros FROM paper_fee_ledger",
    ).all() as unknown as Array<{ paper_order_id: string; fee_micros: string }>;
    const fillFeeByOrder = new Map<string, bigint>();
    const ledgerFeeByOrder = new Map<string, bigint>();
    for (const fill of fills) {
      fillFeeByOrder.set(fill.paper_order_id, (fillFeeByOrder.get(fill.paper_order_id) ?? 0n) + BigInt(fill.fee_micros));
    }
    for (const fee of fees) {
      ledgerFeeByOrder.set(fee.paper_order_id, (ledgerFeeByOrder.get(fee.paper_order_id) ?? 0n) + BigInt(fee.fee_micros));
    }
    const mismatches = orders
      .filter((order) => {
        const recorded = BigInt(order.fee_micros);
        return recorded !== (fillFeeByOrder.get(order.paper_order_id) ?? 0n)
          || recorded !== (ledgerFeeByOrder.get(order.paper_order_id) ?? 0n);
      })
      .map((order) => order.paper_order_id);
    return check({
      checkType: this.type,
      checkName: "paper_fee_fill_consistency",
      status: mismatches.length === 0 ? "PASS" : "FAIL",
      reason: mismatches.length === 0 ? "OK" : "FEE_LEDGER_FILL_MISMATCH",
      metrics: { mismatches },
      now,
    });
  }

  private paperPositionLedgerConsistency(database: DatabaseSync, now: () => Date): ValidationCheckResult {
    const positions = database.prepare(
      `SELECT paper_position_id,opening_execution_id,entry_size_micros,entry_notional_micros,
              entry_fee_micros,current_size_micros,remaining_cost_micros,
              realized_pnl_micros,status
       FROM paper_positions`,
    ).all() as unknown as Array<{
      paper_position_id: string;
      opening_execution_id: string;
      entry_size_micros: string;
      entry_notional_micros: string;
      entry_fee_micros: string;
      current_size_micros: string;
      remaining_cost_micros: string;
      realized_pnl_micros: string;
      status: string;
    }>;
    const issues: string[] = [];
    for (const position of positions) {
      const buyFills = database.prepare(
        `SELECT size_micros,notional_micros FROM paper_fill_ledger
         WHERE paper_position_id=? AND paper_execution_id=? AND side='BUY'`,
      ).all(position.paper_position_id, position.opening_execution_id) as unknown as Array<{
        size_micros: string;
        notional_micros: string;
      }>;
      const allocationRows = database.prepare(
        "SELECT filled_size_micros FROM paper_execution_positions WHERE paper_position_id=?",
      ).all(position.paper_position_id) as unknown as Array<{ filled_size_micros: string }>;
      const pnlRows = database.prepare(
        "SELECT cost_basis_micros,pnl_micros FROM paper_pnl_ledger WHERE paper_position_id=?",
      ).all(position.paper_position_id) as unknown as Array<{ cost_basis_micros: string; pnl_micros: string }>;
      const settlementCount = (database.prepare(
        "SELECT count(*) count FROM paper_settlements WHERE paper_position_id=?",
      ).get(position.paper_position_id) as { count: number }).count;
      const entrySize = BigInt(position.entry_size_micros);
      const entryCost = BigInt(position.entry_notional_micros) + BigInt(position.entry_fee_micros);
      const buySize = sum(buyFills.map((row) => row.size_micros));
      const buyNotional = sum(buyFills.map((row) => row.notional_micros));
      const soldSize = sum(allocationRows.map((row) => row.filled_size_micros));
      const realizedCost = sum(pnlRows.map((row) => row.cost_basis_micros));
      const realizedPnl = sum(pnlRows.map((row) => row.pnl_micros));
      const expectedSize = position.status === "REDEEMED" ? 0n : entrySize - soldSize;
      const expectedCost = entryCost - realizedCost;
      if (buySize !== entrySize) issues.push(`ENTRY_SIZE:${position.paper_position_id}`);
      if (buyNotional !== BigInt(position.entry_notional_micros)) issues.push(`ENTRY_NOTIONAL:${position.paper_position_id}`);
      if (soldSize < 0n || soldSize > entrySize) issues.push(`SOLD_SIZE:${position.paper_position_id}`);
      if (expectedSize !== BigInt(position.current_size_micros)) issues.push(`CURRENT_SIZE:${position.paper_position_id}`);
      if (expectedCost !== BigInt(position.remaining_cost_micros)) issues.push(`REMAINING_COST:${position.paper_position_id}`);
      if (realizedPnl !== BigInt(position.realized_pnl_micros)) issues.push(`REALIZED_PNL:${position.paper_position_id}`);
      const currentSize = BigInt(position.current_size_micros);
      const statusValid = position.status === "OPEN" ? currentSize > 0n && soldSize === 0n && settlementCount === 0
        : position.status === "PARTIALLY_CLOSED" ? currentSize > 0n && soldSize > 0n && settlementCount === 0
          : position.status === "SETTLEMENT_PENDING" ? currentSize > 0n && settlementCount === 0
            : position.status === "CLOSED" ? currentSize === 0n && settlementCount === 0
              : position.status === "REDEEMED" ? currentSize === 0n && settlementCount === 1
                : position.status === "FROZEN" ? currentSize > 0n
                  : false;
      if (!statusValid) issues.push(`STATUS:${position.paper_position_id}`);
    }
    return check({
      checkType: this.type,
      checkName: "paper_position_ledger_consistency",
      status: issues.length === 0 ? "PASS" : "FAIL",
      reason: issues.length === 0 ? "OK" : "POSITION_LEDGER_MISMATCH",
      metrics: { positionCount: positions.length, issues },
      now,
    });
  }

  private paperPortfolioProjection(database: DatabaseSync, now: () => Date): ValidationCheckResult {
    const accounts = database.prepare(
      "SELECT paper_account_id,cash_balance_micros,reserved_balance_micros,realized_pnl_micros FROM paper_accounts",
    ).all() as unknown as AccountRow[];
    const issues: string[] = [];
    for (const account of accounts) {
      const openPositions = database.prepare(
        `SELECT paper_position_id,current_size_micros FROM paper_positions
         WHERE paper_account_id=? AND status IN ('OPEN','PARTIALLY_CLOSED','SETTLEMENT_PENDING')`,
      ).all(account.paper_account_id) as unknown as Array<{ paper_position_id: string; current_size_micros: string }>;
      const hasOpenSize = openPositions.some((position) => BigInt(position.current_size_micros) > 0n);
      if (!hasOpenSize) continue;
      const projection = database.prepare(
        `SELECT cash_balance_micros,reserved_balance_micros,realized_pnl_micros
         FROM portfolio_projection_runs
         WHERE paper_account_id=? ORDER BY created_at DESC LIMIT 1`,
      ).get(account.paper_account_id) as { cash_balance_micros: string; reserved_balance_micros: string; realized_pnl_micros: string } | undefined;
      if (!projection) {
        issues.push(`PROJECTION_MISSING:${account.paper_account_id}`);
        continue;
      }
      if (
        projection.cash_balance_micros !== account.cash_balance_micros
        || projection.reserved_balance_micros !== account.reserved_balance_micros
        || projection.realized_pnl_micros !== account.realized_pnl_micros
      ) {
        issues.push(`PROJECTION_MISMATCH:${account.paper_account_id}`);
      }
    }
    return check({
      checkType: this.type,
      checkName: "paper_portfolio_projection",
      status: issues.length === 0 ? "PASS" : "FAIL",
      reason: issues.length === 0 ? "OK" : "PORTFOLIO_PROJECTION_MISMATCH",
      metrics: { issues },
      now,
    });
  }

  private orphanRecordCheck(database: DatabaseSync, now: () => Date): ValidationCheckResult {
    const metrics = {
      orphanPaperExecutions: count(database, "SELECT count(*) count FROM paper_executions e LEFT JOIN paper_accounts a ON a.paper_account_id=e.paper_account_id WHERE a.paper_account_id IS NULL"),
      orphanPaperOrders: count(database, "SELECT count(*) count FROM paper_orders o LEFT JOIN paper_executions e ON e.paper_execution_id=o.paper_execution_id WHERE e.paper_execution_id IS NULL"),
      orphanPaperFills: count(database, "SELECT count(*) count FROM paper_fill_ledger f LEFT JOIN paper_orders o ON o.paper_order_id=f.paper_order_id WHERE o.paper_order_id IS NULL"),
      orphanLiveOrders: count(database, "SELECT count(*) count FROM live_orders o LEFT JOIN live_executions e ON e.live_execution_id=o.live_execution_id WHERE e.live_execution_id IS NULL"),
      orphanLiveFills: count(database, "SELECT count(*) count FROM live_fills f LEFT JOIN live_orders o ON o.live_order_id=f.live_order_id WHERE o.live_order_id IS NULL"),
    };
    const failures = Object.values(metrics).reduce((total, value) => total + value, 0);
    return check({
      checkType: this.type,
      checkName: "orphan_records",
      status: failures === 0 ? "PASS" : "FAIL",
      reason: failures === 0 ? "OK" : "ORPHAN_RECORDS_FOUND",
      metrics,
      now,
    });
  }

  private idempotencyCheck(database: DatabaseSync, now: () => Date): ValidationCheckResult {
    const metrics = {
      paperExecutionsMissing: count(database, "SELECT count(*) count FROM paper_executions WHERE execution_idempotency_key IS NULL OR execution_idempotency_key=''"),
      liveExecutionsMissing: count(database, "SELECT count(*) count FROM live_executions WHERE execution_idempotency_key IS NULL OR execution_idempotency_key=''"),
      paperCashLedgerMissing: count(database, "SELECT count(*) count FROM paper_cash_ledger WHERE idempotency_key IS NULL OR idempotency_key=''"),
      liveCashLedgerMissing: count(database, "SELECT count(*) count FROM live_cash_ledger WHERE idempotency_key IS NULL OR idempotency_key=''"),
    };
    const failures = Object.values(metrics).reduce((total, value) => total + value, 0);
    return check({
      checkType: this.type,
      checkName: "idempotency_keys",
      status: failures === 0 ? "PASS" : "FAIL",
      reason: failures === 0 ? "OK" : "IDEMPOTENCY_KEY_MISSING",
      metrics,
      now,
    });
  }

  private negativeStateCheck(database: DatabaseSync, now: () => Date): ValidationCheckResult {
    const metrics = {
      negativePaperAccounts: negativeTextCount(database, "paper_accounts", ["cash_balance_micros", "reserved_balance_micros"]),
      negativePaperPositions: negativeTextCount(database, "paper_positions", ["current_size_micros", "remaining_cost_micros"]),
      negativeLivePositions: negativeTextCount(database, "live_positions", ["current_size_micros", "remaining_cost_micros"]),
    };
    const failures = Object.values(metrics).reduce((total, value) => total + value, 0);
    return check({
      checkType: this.type,
      checkName: "negative_state",
      status: failures === 0 ? "PASS" : "FAIL",
      reason: failures === 0 ? "OK" : "NEGATIVE_BALANCE_OR_POSITION",
      metrics,
      now,
    });
  }
}
