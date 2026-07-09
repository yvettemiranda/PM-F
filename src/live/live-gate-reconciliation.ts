import type { DatabaseSync } from "node:sqlite";
import type { LiveGateCheck } from "./live-gate-types.js";

function sumStrings(values: string[]): bigint {
  return values.reduce((total, value) => total + BigInt(value), 0n);
}

export class LiveGateReconciliation {
  constructor(private readonly database: DatabaseSync) {}

  check(): LiveGateCheck[] {
    return [
      this.cashLedgerCheck(),
      this.reservedLedgerCheck(),
      this.realizedPnlCheck(),
      this.negativeBalanceCheck(),
      this.negativePositionCheck(),
      this.orphanExecutionCheck(),
      this.orphanPositionCheck(),
      this.frozenPositionCheck(),
      this.majorDesyncCheck(),
      this.portfolioProjectionCheck(),
    ];
  }

  private cashLedgerCheck(): LiveGateCheck {
    const rows = this.database.prepare(
      `SELECT a.paper_account_id,a.cash_balance_micros,
              COALESCE(SUM(CAST(l.cash_delta_micros AS INTEGER)),0) ledger_cash
       FROM paper_accounts a
       LEFT JOIN paper_cash_ledger l ON l.paper_account_id=a.paper_account_id
       GROUP BY a.paper_account_id`,
    ).all() as unknown as Array<{ paper_account_id: string; cash_balance_micros: string; ledger_cash: number }>;
    const mismatch = rows.find((row) => BigInt(row.cash_balance_micros) !== BigInt(row.ledger_cash));
    return mismatch
      ? { name: "reconciliation_cash_ledger", passed: false, reason: `CASH_LEDGER_MISMATCH:${mismatch.paper_account_id}` }
      : { name: "reconciliation_cash_ledger", passed: true, reason: "OK" };
  }

  private reservedLedgerCheck(): LiveGateCheck {
    const rows = this.database.prepare(
      `SELECT a.paper_account_id,a.reserved_balance_micros,
              COALESCE(SUM(CAST(l.reserved_delta_micros AS INTEGER)),0) ledger_reserved
       FROM paper_accounts a
       LEFT JOIN paper_cash_ledger l ON l.paper_account_id=a.paper_account_id
       GROUP BY a.paper_account_id`,
    ).all() as unknown as Array<{ paper_account_id: string; reserved_balance_micros: string; ledger_reserved: number }>;
    const mismatch = rows.find((row) => BigInt(row.reserved_balance_micros) !== BigInt(row.ledger_reserved));
    return mismatch
      ? { name: "reconciliation_reserved_ledger", passed: false, reason: `RESERVED_LEDGER_MISMATCH:${mismatch.paper_account_id}` }
      : { name: "reconciliation_reserved_ledger", passed: true, reason: "OK" };
  }

  private realizedPnlCheck(): LiveGateCheck {
    const rows = this.database.prepare(
      `SELECT a.paper_account_id,a.realized_pnl_micros,
              COALESCE(SUM(CAST(p.pnl_micros AS INTEGER)),0) ledger_pnl
       FROM paper_accounts a
       LEFT JOIN paper_pnl_ledger p ON p.paper_account_id=a.paper_account_id
       GROUP BY a.paper_account_id`,
    ).all() as unknown as Array<{ paper_account_id: string; realized_pnl_micros: string; ledger_pnl: number }>;
    const mismatch = rows.find((row) => BigInt(row.realized_pnl_micros) !== BigInt(row.ledger_pnl));
    return mismatch
      ? { name: "reconciliation_realized_pnl", passed: false, reason: `REALIZED_PNL_MISMATCH:${mismatch.paper_account_id}` }
      : { name: "reconciliation_realized_pnl", passed: true, reason: "OK" };
  }

  private negativeBalanceCheck(): LiveGateCheck {
    const row = this.database.prepare(
      `SELECT paper_account_id FROM paper_accounts
       WHERE CAST(cash_balance_micros AS INTEGER)<0 OR CAST(reserved_balance_micros AS INTEGER)<0
       LIMIT 1`,
    ).get() as { paper_account_id: string } | undefined;
    return row
      ? { name: "reconciliation_negative_balance", passed: false, reason: `NEGATIVE_BALANCE:${row.paper_account_id}` }
      : { name: "reconciliation_negative_balance", passed: true, reason: "OK" };
  }

  private negativePositionCheck(): LiveGateCheck {
    const row = this.database.prepare(
      `SELECT paper_position_id FROM paper_positions
       WHERE CAST(current_size_micros AS INTEGER)<0 OR CAST(remaining_cost_micros AS INTEGER)<0
       LIMIT 1`,
    ).get() as { paper_position_id: string } | undefined;
    return row
      ? { name: "reconciliation_negative_position", passed: false, reason: `NEGATIVE_POSITION:${row.paper_position_id}` }
      : { name: "reconciliation_negative_position", passed: true, reason: "OK" };
  }

  private orphanExecutionCheck(): LiveGateCheck {
    const row = this.database.prepare(
      `SELECT e.paper_execution_id FROM paper_executions e
       LEFT JOIN paper_accounts a ON a.paper_account_id=e.paper_account_id
       WHERE a.paper_account_id IS NULL
       LIMIT 1`,
    ).get() as { paper_execution_id: string } | undefined;
    return row
      ? { name: "reconciliation_orphan_execution", passed: false, reason: `ORPHAN_EXECUTION:${row.paper_execution_id}` }
      : { name: "reconciliation_orphan_execution", passed: true, reason: "OK" };
  }

  private orphanPositionCheck(): LiveGateCheck {
    const row = this.database.prepare(
      `SELECT p.paper_position_id FROM paper_positions p
       LEFT JOIN paper_executions e ON e.paper_execution_id=p.opening_execution_id
       WHERE e.paper_execution_id IS NULL
       LIMIT 1`,
    ).get() as { paper_position_id: string } | undefined;
    return row
      ? { name: "reconciliation_orphan_position", passed: false, reason: `ORPHAN_POSITION:${row.paper_position_id}` }
      : { name: "reconciliation_orphan_position", passed: true, reason: "OK" };
  }

  private frozenPositionCheck(): LiveGateCheck {
    const row = this.database.prepare(
      "SELECT count(*) count FROM paper_positions WHERE status='FROZEN'",
    ).get() as { count: number };
    return row.count > 0
      ? { name: "reconciliation_frozen_positions", passed: false, reason: `FROZEN_POSITIONS:${row.count}` }
      : { name: "reconciliation_frozen_positions", passed: true, reason: "OK" };
  }

  private majorDesyncCheck(): LiveGateCheck {
    const row = this.database.prepare(
      "SELECT count(*) count FROM reconciliation_issues WHERE sync_status='MAJOR_DESYNC' AND status!='RESOLVED'",
    ).get() as { count: number };
    return row.count > 0
      ? { name: "reconciliation_major_desync", passed: false, reason: `MAJOR_DESYNC:${row.count}` }
      : { name: "reconciliation_major_desync", passed: true, reason: "OK" };
  }

  private portfolioProjectionCheck(): LiveGateCheck {
    const accounts = this.database.prepare(
      "SELECT paper_account_id,cash_balance_micros,reserved_balance_micros,realized_pnl_micros FROM paper_accounts",
    ).all() as unknown as Array<{
      paper_account_id: string;
      cash_balance_micros: string;
      reserved_balance_micros: string;
      realized_pnl_micros: string;
    }>;
    for (const account of accounts) {
      const openSizeRows = this.database.prepare(
        `SELECT current_size_micros FROM paper_positions
         WHERE paper_account_id=? AND status IN ('OPEN','PARTIALLY_CLOSED','SETTLEMENT_PENDING')`,
      ).all(account.paper_account_id) as unknown as Array<{ current_size_micros: string }>;
      const hasOpenPosition = sumStrings(openSizeRows.map((row) => row.current_size_micros)) > 0n;
      if (!hasOpenPosition) continue;
      const projection = this.database.prepare(
        `SELECT cash_balance_micros,reserved_balance_micros,realized_pnl_micros
         FROM portfolio_projection_runs
         WHERE paper_account_id=? ORDER BY created_at DESC LIMIT 1`,
      ).get(account.paper_account_id) as {
        cash_balance_micros: string;
        reserved_balance_micros: string;
        realized_pnl_micros: string;
      } | undefined;
      if (!projection) {
        return { name: "reconciliation_portfolio_projection", passed: false, reason: `PORTFOLIO_PROJECTION_MISSING:${account.paper_account_id}` };
      }
      if (
        projection.cash_balance_micros !== account.cash_balance_micros
        || projection.reserved_balance_micros !== account.reserved_balance_micros
        || projection.realized_pnl_micros !== account.realized_pnl_micros
      ) {
        return { name: "reconciliation_portfolio_projection", passed: false, reason: `PORTFOLIO_PROJECTION_MISMATCH:${account.paper_account_id}` };
      }
    }
    return { name: "reconciliation_portfolio_projection", passed: true, reason: "OK" };
  }
}
