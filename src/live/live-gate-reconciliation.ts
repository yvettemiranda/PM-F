import type { DatabaseSync } from "node:sqlite";
import type { LiveGateCheck } from "./live-gate-types.js";

function sumStrings(values: string[]): bigint {
  return values.reduce((total, value) => total + BigInt(value), 0n);
}

function totalsByAccount(rows: Array<{ paper_account_id: string; value: string }>): Map<string, bigint> {
  const totals = new Map<string, bigint>();
  for (const row of rows) {
    totals.set(row.paper_account_id, (totals.get(row.paper_account_id) ?? 0n) + BigInt(row.value));
  }
  return totals;
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
      this.liveCashLedgerCheck(),
      this.liveReservationLedgerCheck(),
      this.liveOrphanExecutionCheck(),
      this.liveOrphanPositionCheck(),
      this.liveNegativePositionCheck(),
      this.liveFrozenPositionCheck(),
    ];
  }

  private cashLedgerCheck(): LiveGateCheck {
    const accounts = this.database.prepare(
      "SELECT paper_account_id,cash_balance_micros FROM paper_accounts",
    ).all() as unknown as Array<{ paper_account_id: string; cash_balance_micros: string }>;
    const ledger = this.database.prepare(
      "SELECT paper_account_id,cash_delta_micros value FROM paper_cash_ledger",
    ).all() as unknown as Array<{ paper_account_id: string; value: string }>;
    const totals = totalsByAccount(ledger);
    const mismatch = accounts.find((row) => BigInt(row.cash_balance_micros) !== (totals.get(row.paper_account_id) ?? 0n));
    return mismatch
      ? { name: "reconciliation_cash_ledger", passed: false, reason: `CASH_LEDGER_MISMATCH:${mismatch.paper_account_id}` }
      : { name: "reconciliation_cash_ledger", passed: true, reason: "OK" };
  }

  private reservedLedgerCheck(): LiveGateCheck {
    const accounts = this.database.prepare(
      "SELECT paper_account_id,reserved_balance_micros FROM paper_accounts",
    ).all() as unknown as Array<{ paper_account_id: string; reserved_balance_micros: string }>;
    const ledger = this.database.prepare(
      "SELECT paper_account_id,reserved_delta_micros value FROM paper_cash_ledger",
    ).all() as unknown as Array<{ paper_account_id: string; value: string }>;
    const totals = totalsByAccount(ledger);
    const mismatch = accounts.find((row) => BigInt(row.reserved_balance_micros) !== (totals.get(row.paper_account_id) ?? 0n));
    return mismatch
      ? { name: "reconciliation_reserved_ledger", passed: false, reason: `RESERVED_LEDGER_MISMATCH:${mismatch.paper_account_id}` }
      : { name: "reconciliation_reserved_ledger", passed: true, reason: "OK" };
  }

  private realizedPnlCheck(): LiveGateCheck {
    const accounts = this.database.prepare(
      "SELECT paper_account_id,realized_pnl_micros FROM paper_accounts",
    ).all() as unknown as Array<{ paper_account_id: string; realized_pnl_micros: string }>;
    const ledger = this.database.prepare(
      "SELECT paper_account_id,pnl_micros value FROM paper_pnl_ledger",
    ).all() as unknown as Array<{ paper_account_id: string; value: string }>;
    const totals = totalsByAccount(ledger);
    const mismatch = accounts.find((row) => BigInt(row.realized_pnl_micros) !== (totals.get(row.paper_account_id) ?? 0n));
    return mismatch
      ? { name: "reconciliation_realized_pnl", passed: false, reason: `REALIZED_PNL_MISMATCH:${mismatch.paper_account_id}` }
      : { name: "reconciliation_realized_pnl", passed: true, reason: "OK" };
  }

  private negativeBalanceCheck(): LiveGateCheck {
    const rows = this.database.prepare(
      "SELECT paper_account_id,cash_balance_micros,reserved_balance_micros FROM paper_accounts",
    ).all() as unknown as Array<{
      paper_account_id: string;
      cash_balance_micros: string;
      reserved_balance_micros: string;
    }>;
    const mismatch = rows.find((row) => BigInt(row.cash_balance_micros) < 0n || BigInt(row.reserved_balance_micros) < 0n);
    return mismatch
      ? { name: "reconciliation_negative_balance", passed: false, reason: `NEGATIVE_BALANCE:${mismatch.paper_account_id}` }
      : { name: "reconciliation_negative_balance", passed: true, reason: "OK" };
  }

  private negativePositionCheck(): LiveGateCheck {
    const rows = this.database.prepare(
      "SELECT paper_position_id,current_size_micros,remaining_cost_micros FROM paper_positions",
    ).all() as unknown as Array<{
      paper_position_id: string;
      current_size_micros: string;
      remaining_cost_micros: string;
    }>;
    const mismatch = rows.find((row) => BigInt(row.current_size_micros) < 0n || BigInt(row.remaining_cost_micros) < 0n);
    return mismatch
      ? { name: "reconciliation_negative_position", passed: false, reason: `NEGATIVE_POSITION:${mismatch.paper_position_id}` }
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

  private liveCashLedgerCheck(): LiveGateCheck {
    const accounts = this.database.prepare(
      "SELECT live_account_id,initial_bankroll_micros FROM live_accounts",
    ).all() as unknown as Array<{ live_account_id: string; initial_bankroll_micros: string }>;
    for (const account of accounts) {
      const rows = this.database.prepare(
        "SELECT cash_delta_micros FROM live_cash_ledger WHERE live_account_id=?",
      ).all(account.live_account_id) as unknown as Array<{ cash_delta_micros: string }>;
      const expected = rows.reduce(
        (total, row) => total + BigInt(row.cash_delta_micros),
        BigInt(account.initial_bankroll_micros),
      );
      if (expected < 0n) {
        return {
          name: "live_reconciliation_cash_ledger",
          passed: false,
          reason: `LIVE_NEGATIVE_EXPECTED_CASH:${account.live_account_id}`,
        };
      }
    }
    return { name: "live_reconciliation_cash_ledger", passed: true, reason: "OK" };
  }

  private liveReservationLedgerCheck(): LiveGateCheck {
    const rows = this.database.prepare(
      `SELECT e.live_account_id,SUM(r.delta_micros) reserved_micros
       FROM live_reservation_ledger r
       JOIN live_executions e ON e.live_execution_id=r.live_execution_id
       GROUP BY e.live_account_id`,
    ).all() as unknown as Array<{ live_account_id: string; reserved_micros: string }>;
    const mismatch = rows.find((row) => BigInt(row.reserved_micros) < 0n);
    return mismatch
      ? {
        name: "live_reconciliation_reservations",
        passed: false,
        reason: `LIVE_NEGATIVE_RESERVATIONS:${mismatch.live_account_id}`,
      }
      : { name: "live_reconciliation_reservations", passed: true, reason: "OK" };
  }

  private liveOrphanExecutionCheck(): LiveGateCheck {
    const row = this.database.prepare(
      `SELECT e.live_execution_id
       FROM live_executions e
       LEFT JOIN live_accounts a ON a.live_account_id=e.live_account_id
       WHERE a.live_account_id IS NULL
       LIMIT 1`,
    ).get() as { live_execution_id: string } | undefined;
    return row
      ? { name: "live_reconciliation_orphan_execution", passed: false, reason: `LIVE_ORPHAN_EXECUTION:${row.live_execution_id}` }
      : { name: "live_reconciliation_orphan_execution", passed: true, reason: "OK" };
  }

  private liveOrphanPositionCheck(): LiveGateCheck {
    const row = this.database.prepare(
      `SELECT p.live_position_id
       FROM live_positions p
       LEFT JOIN live_executions e ON e.live_execution_id=p.opening_execution_id
       WHERE e.live_execution_id IS NULL
       LIMIT 1`,
    ).get() as { live_position_id: string } | undefined;
    return row
      ? { name: "live_reconciliation_orphan_position", passed: false, reason: `LIVE_ORPHAN_POSITION:${row.live_position_id}` }
      : { name: "live_reconciliation_orphan_position", passed: true, reason: "OK" };
  }

  private liveNegativePositionCheck(): LiveGateCheck {
    const row = this.database.prepare(
      `SELECT live_position_id
       FROM live_positions
       WHERE CAST(current_size_micros AS INTEGER)<0 OR CAST(remaining_cost_micros AS INTEGER)<0
       LIMIT 1`,
    ).get() as { live_position_id: string } | undefined;
    return row
      ? { name: "live_reconciliation_negative_position", passed: false, reason: `LIVE_NEGATIVE_POSITION:${row.live_position_id}` }
      : { name: "live_reconciliation_negative_position", passed: true, reason: "OK" };
  }

  private liveFrozenPositionCheck(): LiveGateCheck {
    const row = this.database.prepare(
      `SELECT live_position_id
       FROM live_positions
       WHERE status='FROZEN' AND current_size_micros<>'0'
       LIMIT 1`,
    ).get() as { live_position_id: string } | undefined;
    return row
      ? { name: "live_reconciliation_frozen_positions", passed: false, reason: `LIVE_FROZEN_POSITION:${row.live_position_id}` }
      : { name: "live_reconciliation_frozen_positions", passed: true, reason: "OK" };
  }
}
