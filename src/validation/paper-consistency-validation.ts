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

export class PaperConsistencyValidation implements ValidationValidator {
  readonly type = "PAPER_CONSISTENCY" as const;

  async run(context: ValidationValidatorContext): Promise<ValidationCheckResult[]> {
    const database = new DatabaseSync(context.databasePath, { readOnly: true });
    try {
      return [
        this.sqliteIntegrity(database, context.now),
        this.paperLedgerConsistency(database, context.now),
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
      negativePaperAccounts: count(database, "SELECT count(*) count FROM paper_accounts WHERE CAST(cash_balance_micros AS INTEGER)<0 OR CAST(reserved_balance_micros AS INTEGER)<0"),
      negativePaperPositions: count(database, "SELECT count(*) count FROM paper_positions WHERE CAST(current_size_micros AS INTEGER)<0 OR CAST(remaining_cost_micros AS INTEGER)<0"),
      negativeLivePositions: count(database, "SELECT count(*) count FROM live_positions WHERE CAST(current_size_micros AS INTEGER)<0 OR CAST(remaining_cost_micros AS INTEGER)<0"),
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
