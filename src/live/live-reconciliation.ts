import type { DatabaseSync } from "node:sqlite";
import { LiveStore } from "./live-store.js";
import type { LiveReconciliationCheck } from "./live-types.js";

export class LiveReconciliation {
  constructor(
    private readonly database: DatabaseSync,
    private readonly store: LiveStore,
  ) {}

  run(accountId: string): { passed: boolean; checks: LiveReconciliationCheck[]; runId: string } {
    const checks = this.check(accountId);
    const runId = this.store.saveReconciliationRun(accountId, checks);
    return { passed: checks.every((check) => check.passed), checks, runId };
  }

  check(accountId: string): LiveReconciliationCheck[] {
    return [
      this.orphanOrderCheck(accountId),
      this.orphanFillCheck(accountId),
      this.orderFillLedgerCheck(accountId),
      this.orderFillTotalCheck(accountId),
      this.negativePositionCheck(accountId),
      this.frozenPositionCheck(accountId),
      this.cashLedgerCheck(accountId),
    ];
  }

  private orphanOrderCheck(accountId: string): LiveReconciliationCheck {
    const row = this.database.prepare(
      `SELECT o.live_order_id
       FROM live_orders o
       LEFT JOIN live_executions e ON e.live_execution_id=o.live_execution_id
       WHERE e.live_execution_id IS NULL OR e.live_account_id!=?
       LIMIT 1`,
    ).get(accountId) as { live_order_id: string } | undefined;
    return row
      ? { name: "live_orphan_order", passed: false, reason: `ORPHAN_ORDER:${row.live_order_id}` }
      : { name: "live_orphan_order", passed: true, reason: "OK" };
  }

  private orphanFillCheck(accountId: string): LiveReconciliationCheck {
    const row = this.database.prepare(
      `SELECT f.live_fill_id
       FROM live_fills f
       LEFT JOIN live_orders o ON o.live_order_id=f.live_order_id
       LEFT JOIN live_executions e ON e.live_execution_id=f.live_execution_id
       WHERE o.live_order_id IS NULL OR e.live_account_id!=?
       LIMIT 1`,
    ).get(accountId) as { live_fill_id: string } | undefined;
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
    const row = this.database.prepare(
      `SELECT o.live_order_id,o.filled_size_micros,
              COALESCE(SUM(CAST(f.fill_size_micros AS INTEGER)),0) fill_total
       FROM live_orders o
       JOIN live_executions e ON e.live_execution_id=o.live_execution_id
       LEFT JOIN live_fills f ON f.live_order_id=o.live_order_id
       WHERE e.live_account_id=?
       GROUP BY o.live_order_id
       HAVING CAST(o.filled_size_micros AS INTEGER)!=fill_total
       LIMIT 1`,
    ).get(accountId) as { live_order_id: string } | undefined;
    return row
      ? { name: "live_order_fill_total", passed: false, reason: `ORDER_FILL_MISMATCH:${row.live_order_id}` }
      : { name: "live_order_fill_total", passed: true, reason: "OK" };
  }

  private negativePositionCheck(accountId: string): LiveReconciliationCheck {
    const row = this.database.prepare(
      `SELECT live_position_id FROM live_positions
       WHERE live_account_id=? AND (CAST(current_size_micros AS INTEGER)<0 OR CAST(remaining_cost_micros AS INTEGER)<0)
       LIMIT 1`,
    ).get(accountId) as { live_position_id: string } | undefined;
    return row
      ? { name: "live_negative_position", passed: false, reason: `NEGATIVE_POSITION:${row.live_position_id}` }
      : { name: "live_negative_position", passed: true, reason: "OK" };
  }

  private frozenPositionCheck(accountId: string): LiveReconciliationCheck {
    const row = this.database.prepare(
      "SELECT count(*) count FROM live_positions WHERE live_account_id=? AND status='FROZEN'",
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
}
