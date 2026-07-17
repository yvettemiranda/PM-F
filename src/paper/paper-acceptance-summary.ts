import { DatabaseSync } from "node:sqlite";
import { buildPaperExecutionFunnel, type PaperExecutionFunnel } from "./paper-execution-funnel.js";
import type { PaperMarketDataHealthState } from "./types.js";

export type PaperLifecycleCoverageStatus = "OBSERVED_REAL" | "NOT_OBSERVED";

export interface PaperMarketDataAcceptanceRecord {
  assetId: string;
  conditionId: string;
  state: PaperMarketDataHealthState;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  nextRetryAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  lastFailureAt: string | null;
  lastSuccessAt: string | null;
  frozenAt: string | null;
  updatedAt: string;
}

export interface PaperAcceptanceSummary {
  paperAccountId: string;
  targetId: string;
  generatedAt: string;
  evidenceWindow: { startAt: string; endAt: string };
  consistency: {
    passed: boolean;
    cash: {
      accountCashMicros: string;
      cashLedgerMicros: string;
      accountReservedMicros: string;
      cashLedgerReservedMicros: string;
      matches: boolean;
    };
    reservations: {
      accountReservedMicros: string;
      activeReservationsMicros: string;
      reservationLedgerMicros: string;
      cashLedgerReservedMicros: string;
      matches: boolean;
      reservationIssues: string[];
    };
    negativeValues: {
      count: number;
      details: string[];
    };
    orphans: {
      total: number;
      details: string[];
    };
    aggregates: {
      total: number;
      details: string[];
    };
  };
  coverage: {
    BUY: PaperLifecycleCoverageStatus;
    SELL: PaperLifecycleCoverageStatus;
    STOP_LOSS: PaperLifecycleCoverageStatus;
    SETTLEMENT: PaperLifecycleCoverageStatus;
    REALIZED_PNL: PaperLifecycleCoverageStatus;
  };
  funnel: PaperExecutionFunnel;
  marketData: {
    blockerCount: number;
    blockers: PaperMarketDataAcceptanceRecord[];
    quarantineCount: number;
    quarantined: PaperMarketDataAcceptanceRecord[];
    records: PaperMarketDataAcceptanceRecord[];
  };
}

interface AccountRow {
  target_id: string | null;
  signal_cutoff_at: string;
  cash_balance_micros: string;
  reserved_balance_micros: string;
  realized_pnl_micros: string;
}

interface MarketDataHealthRow {
  asset_id: string;
  condition_id: string;
  state: PaperMarketDataHealthState;
  consecutive_failures: number;
  consecutive_successes: number;
  next_retry_at: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  last_failure_at: string | null;
  last_success_at: string | null;
  frozen_at: string | null;
  updated_at: string;
}

interface NumericValue {
  table: string;
  id: string;
  column: string;
  value: string | null;
}

function parseInteger(value: string | null, label: string, issues?: string[]): bigint | null {
  if (value === null) return null;
  try {
    return BigInt(value);
  } catch {
    issues?.push(`INVALID_INTEGER:${label}`);
    return null;
  }
}

function sumValues(values: Array<string | null>, label: string, issues?: string[]): bigint | null {
  let total = 0n;
  for (const [index, value] of values.entries()) {
    const parsed = parseInteger(value, `${label}:${index}`, issues);
    if (parsed === null) return null;
    total += parsed;
  }
  return total;
}

function filledLifecycleObserved(
  database: DatabaseSync,
  accountId: string,
  executionType: "TARGET_BUY" | "TARGET_SELL" | "STOP_LOSS",
  side: "BUY" | "SELL",
  startAt: string,
  endAt: string,
): boolean {
  const rows = executionType === "TARGET_BUY"
    ? database.prepare(
      `SELECT f.size_micros,f.size_micros allocation_size_micros
       FROM paper_fill_ledger f
       JOIN paper_orders o ON o.paper_order_id=f.paper_order_id AND o.paper_execution_id=f.paper_execution_id
       JOIN paper_executions e ON e.paper_execution_id=f.paper_execution_id
       JOIN paper_positions p ON p.paper_position_id=f.paper_position_id
         AND p.opening_execution_id=e.paper_execution_id AND p.paper_account_id=e.paper_account_id
       WHERE e.paper_account_id=? AND e.execution_type=? AND f.side=?
         AND f.created_at>=? AND f.created_at<=?`,
    ).all(accountId, executionType, side, startAt, endAt)
    : database.prepare(
      `SELECT f.size_micros,ep.filled_size_micros allocation_size_micros
       FROM paper_fill_ledger f
       JOIN paper_orders o ON o.paper_order_id=f.paper_order_id AND o.paper_execution_id=f.paper_execution_id
       JOIN paper_executions e ON e.paper_execution_id=f.paper_execution_id
       JOIN paper_execution_positions ep ON ep.paper_execution_id=e.paper_execution_id
       JOIN paper_positions p ON p.paper_position_id=ep.paper_position_id AND p.paper_account_id=e.paper_account_id
       WHERE e.paper_account_id=? AND e.execution_type=? AND f.side=?
         AND f.created_at>=? AND f.created_at<=?`,
    ).all(accountId, executionType, side, startAt, endAt);
  const evidence = rows as unknown as Array<{ size_micros: string; allocation_size_micros: string }>;
  return evidence.some((row) => {
    const size = parseInteger(row.size_micros, `paper_fill_ledger:${executionType}:size_micros`);
    const allocation = parseInteger(row.allocation_size_micros, `paper_execution_positions:${executionType}:filled_size_micros`);
    return size !== null && size > 0n && allocation !== null && allocation > 0n;
  });
}

function toMarketDataRecord(row: MarketDataHealthRow): PaperMarketDataAcceptanceRecord {
  return {
    assetId: row.asset_id,
    conditionId: row.condition_id,
    state: row.state,
    consecutiveFailures: row.consecutive_failures,
    consecutiveSuccesses: row.consecutive_successes,
    nextRetryAt: row.next_retry_at,
    lastErrorCode: row.last_error_code,
    lastErrorMessage: row.last_error_message,
    lastFailureAt: row.last_failure_at,
    lastSuccessAt: row.last_success_at,
    frozenAt: row.frozen_at,
    updatedAt: row.updated_at,
  };
}

export class PaperAcceptanceSummaryService {
  private readonly now: () => Date;

  constructor(
    private readonly databasePath: string,
    options: { now?: () => Date } = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  summarize(
    paperAccountId: string,
    window: { startAt?: string; endAt?: string } = {},
  ): PaperAcceptanceSummary {
    const database = new DatabaseSync(this.databasePath, { readOnly: true });
    database.exec("PRAGMA query_only=ON; PRAGMA foreign_keys=ON;");
    try {
      const account = database.prepare(
        `SELECT target_id,signal_cutoff_at,cash_balance_micros,reserved_balance_micros,realized_pnl_micros
         FROM paper_accounts WHERE paper_account_id=?`,
      ).get(paperAccountId) as AccountRow | undefined;
      if (!account) throw new Error(`PAPER_ACCOUNT_NOT_FOUND:${paperAccountId}`);
      const requestedStartAt = window.startAt ?? account.signal_cutoff_at;
      const startAt = Date.parse(requestedStartAt) > Date.parse(account.signal_cutoff_at)
        ? requestedStartAt
        : account.signal_cutoff_at;
      const endAt = window.endAt ?? this.now().toISOString();
      if (!Number.isFinite(Date.parse(startAt)) || !Number.isFinite(Date.parse(endAt))) {
        throw new Error("PAPER_ACCEPTANCE_WINDOW_INVALID");
      }
      if (Date.parse(endAt) < Date.parse(startAt)) throw new Error("PAPER_ACCEPTANCE_WINDOW_REVERSED");

      const aggregateIssues: string[] = [];
      if (!account.target_id) aggregateIssues.push("ACCOUNT_TARGET_NOT_BOUND");
      const cashLedgerRows = database.prepare(
        `SELECT rowid ledger_sequence,cash_delta_micros,reserved_delta_micros,
                cash_after_micros,reserved_after_micros
         FROM paper_cash_ledger WHERE paper_account_id=? ORDER BY rowid`,
      ).all(paperAccountId) as unknown as Array<{
        ledger_sequence: number;
        cash_delta_micros: string;
        reserved_delta_micros: string;
        cash_after_micros: string;
        reserved_after_micros: string;
      }>;
      let runningCash = 0n;
      let runningReserved = 0n;
      for (const row of cashLedgerRows) {
        const cashDelta = parseInteger(row.cash_delta_micros, `paper_cash_ledger:${row.ledger_sequence}:cash_delta_micros`, aggregateIssues);
        const reservedDelta = parseInteger(row.reserved_delta_micros, `paper_cash_ledger:${row.ledger_sequence}:reserved_delta_micros`, aggregateIssues);
        const cashAfter = parseInteger(row.cash_after_micros, `paper_cash_ledger:${row.ledger_sequence}:cash_after_micros`, aggregateIssues);
        const reservedAfter = parseInteger(row.reserved_after_micros, `paper_cash_ledger:${row.ledger_sequence}:reserved_after_micros`, aggregateIssues);
        if (cashDelta === null || reservedDelta === null || cashAfter === null || reservedAfter === null) continue;
        runningCash += cashDelta;
        runningReserved += reservedDelta;
        if (runningCash < 0n || runningReserved < 0n) {
          aggregateIssues.push(`CASH_LEDGER_NEGATIVE:${row.ledger_sequence}`);
        }
        if (runningCash !== cashAfter || runningReserved !== reservedAfter) {
          aggregateIssues.push(`CASH_LEDGER_AFTER:${row.ledger_sequence}`);
        }
      }
      const cashLedgerMicros = sumValues(
        cashLedgerRows.map((row) => row.cash_delta_micros),
        "paper_cash_ledger:cash_delta_micros",
        aggregateIssues,
      );
      const cashLedgerReservedMicros = sumValues(
        cashLedgerRows.map((row) => row.reserved_delta_micros),
        "paper_cash_ledger:reserved_delta_micros",
        aggregateIssues,
      );
      const accountCashMicros = parseInteger(account.cash_balance_micros, "paper_accounts:cash_balance_micros", aggregateIssues);
      const accountReservedMicros = parseInteger(account.reserved_balance_micros, "paper_accounts:reserved_balance_micros", aggregateIssues);
      const cashMatches = accountCashMicros !== null
        && accountReservedMicros !== null
        && cashLedgerMicros !== null
        && cashLedgerReservedMicros !== null
        && accountCashMicros === cashLedgerMicros
        && accountReservedMicros === cashLedgerReservedMicros;

      const reservations = this.reservationConsistency(database, paperAccountId, accountReservedMicros, cashLedgerReservedMicros);
      const negativeValues = this.negativeValues(database, paperAccountId);
      const orphanDetails = this.orphanDetails(database, paperAccountId);
      aggregateIssues.push(...this.executionAndOrderAggregateIssues(database, paperAccountId));
      aggregateIssues.push(...this.positionAggregateIssues(database, paperAccountId));
      aggregateIssues.push(...this.targetBindingIssues(database, paperAccountId, account.target_id));
      aggregateIssues.push(...this.settlementIssueDetails(database, paperAccountId));
      const accountPnl = parseInteger(account.realized_pnl_micros, "paper_accounts:realized_pnl_micros", aggregateIssues);
      const pnlRows = database.prepare(
        "SELECT pnl_micros FROM paper_pnl_ledger WHERE paper_account_id=?",
      ).all(paperAccountId) as unknown as Array<{ pnl_micros: string }>;
      const ledgerPnl = sumValues(pnlRows.map((row) => row.pnl_micros), "paper_pnl_ledger:pnl_micros", aggregateIssues);
      if (accountPnl === null || ledgerPnl === null || accountPnl !== ledgerPnl) {
        aggregateIssues.push("ACCOUNT_REALIZED_PNL");
      }

      const marketRows = database.prepare(
        `SELECT asset_id,condition_id,state,consecutive_failures,consecutive_successes,
                next_retry_at,last_error_code,last_error_message,last_failure_at,
                last_success_at,frozen_at,updated_at
         FROM paper_market_data_health
         WHERE paper_account_id=?
         ORDER BY asset_id,condition_id`,
      ).all(paperAccountId) as unknown as MarketDataHealthRow[];
      const marketRecords = marketRows.map(toMarketDataRecord);
      const unhealthyMarketRecords = marketRecords.filter(
        (row) => row.state === "DEGRADED" || row.state === "FROZEN",
      );

      const settlementObserved = (database.prepare(
        `SELECT count(*) count
         FROM paper_settlements s
         JOIN paper_executions e ON e.paper_execution_id=s.paper_execution_id
         JOIN paper_positions p ON p.paper_position_id=s.paper_position_id
           AND p.paper_account_id=e.paper_account_id
         WHERE e.paper_account_id=? AND e.execution_type='SETTLEMENT'
           AND e.state='EXECUTED' AND p.status='REDEEMED'
           AND s.created_at>=? AND s.created_at<=?`,
      ).get(paperAccountId, startAt, endAt) as { count: number }).count > 0;
      const realizedPnlObserved = (database.prepare(
        `SELECT count(*) count
         FROM paper_pnl_ledger pnl
         JOIN paper_positions p ON p.paper_position_id=pnl.paper_position_id
           AND p.paper_account_id=pnl.paper_account_id
         JOIN paper_executions e ON e.paper_execution_id=pnl.paper_execution_id
           AND e.paper_account_id=pnl.paper_account_id
         WHERE pnl.paper_account_id=? AND pnl.created_at>=? AND pnl.created_at<=?`,
      ).get(paperAccountId, startAt, endAt) as { count: number }).count > 0;

      const consistencyPassed = cashMatches
        && reservations.matches
        && negativeValues.length === 0
        && orphanDetails.length === 0
        && aggregateIssues.length === 0;
      const blockers = unhealthyMarketRecords.filter(
        (row) => !consistencyPassed || this.marketHasExposure(database, paperAccountId, row),
      );
      const blockedMarkets = new Set(blockers.map((row) => `${row.assetId}\u0000${row.conditionId}`));
      const quarantined = unhealthyMarketRecords.filter(
        (row) => !blockedMarkets.has(`${row.assetId}\u0000${row.conditionId}`),
      );
      return {
        paperAccountId,
        targetId: account.target_id ?? "UNBOUND",
        generatedAt: this.now().toISOString(),
        evidenceWindow: { startAt, endAt },
        consistency: {
          passed: consistencyPassed,
          cash: {
            accountCashMicros: account.cash_balance_micros,
            cashLedgerMicros: cashLedgerMicros?.toString() ?? "INVALID",
            accountReservedMicros: account.reserved_balance_micros,
            cashLedgerReservedMicros: cashLedgerReservedMicros?.toString() ?? "INVALID",
            matches: cashMatches,
          },
          reservations: reservations.result,
          negativeValues: { count: negativeValues.length, details: negativeValues },
          orphans: { total: orphanDetails.length, details: orphanDetails },
          aggregates: { total: aggregateIssues.length, details: aggregateIssues },
        },
        coverage: {
          BUY: filledLifecycleObserved(database, paperAccountId, "TARGET_BUY", "BUY", startAt, endAt) ? "OBSERVED_REAL" : "NOT_OBSERVED",
          SELL: filledLifecycleObserved(database, paperAccountId, "TARGET_SELL", "SELL", startAt, endAt) ? "OBSERVED_REAL" : "NOT_OBSERVED",
          STOP_LOSS: filledLifecycleObserved(database, paperAccountId, "STOP_LOSS", "SELL", startAt, endAt) ? "OBSERVED_REAL" : "NOT_OBSERVED",
          SETTLEMENT: settlementObserved ? "OBSERVED_REAL" : "NOT_OBSERVED",
          REALIZED_PNL: realizedPnlObserved ? "OBSERVED_REAL" : "NOT_OBSERVED",
        },
        funnel: buildPaperExecutionFunnel(
          database,
          paperAccountId,
          account.target_id ?? "UNBOUND",
          account.signal_cutoff_at,
          startAt,
          endAt,
        ),
        marketData: {
          blockerCount: blockers.length,
          blockers,
          quarantineCount: quarantined.length,
          quarantined,
          records: marketRecords,
        },
      };
    } finally {
      database.close();
    }
  }

  private marketHasExposure(
    database: DatabaseSync,
    paperAccountId: string,
    market: PaperMarketDataAcceptanceRecord,
  ): boolean {
    const exposure = database.prepare(
      `SELECT
         EXISTS(
           SELECT 1 FROM paper_positions p
           WHERE p.paper_account_id=? AND p.asset_id=? AND p.condition_id=?
             AND p.current_size_micros!='0' AND p.status NOT IN ('CLOSED','REDEEMED')
         ) position_exposure,
         EXISTS(
           SELECT 1 FROM paper_executions e
           WHERE e.paper_account_id=? AND e.asset_id=? AND e.condition_id=?
             AND e.state IN ('WAITING_EXECUTION','EXIT_PENDING','STOP_EXIT_PENDING')
         ) pending_execution,
         EXISTS(
           SELECT 1 FROM paper_reservations r
           JOIN paper_executions e ON e.paper_execution_id=r.paper_execution_id
           WHERE r.paper_account_id=? AND e.asset_id=? AND e.condition_id=?
             AND r.status='ACTIVE' AND r.remaining_amount_micros!='0'
         ) active_reservation`,
    ).get(
      paperAccountId,
      market.assetId,
      market.conditionId,
      paperAccountId,
      market.assetId,
      market.conditionId,
      paperAccountId,
      market.assetId,
      market.conditionId,
    ) as { position_exposure: number; pending_execution: number; active_reservation: number };
    return exposure.position_exposure === 1
      || exposure.pending_execution === 1
      || exposure.active_reservation === 1;
  }

  private reservationConsistency(
    database: DatabaseSync,
    paperAccountId: string,
    accountReservedMicros: bigint | null,
    cashLedgerReservedMicros: bigint | null,
  ): {
    matches: boolean;
    result: PaperAcceptanceSummary["consistency"]["reservations"];
  } {
    const issues: string[] = [];
    const reservations = database.prepare(
      `SELECT reservation_id,paper_execution_id,remaining_amount_micros,status
       FROM paper_reservations WHERE paper_account_id=? ORDER BY reservation_id`,
    ).all(paperAccountId) as unknown as Array<{
      reservation_id: string;
      paper_execution_id: string;
      remaining_amount_micros: string;
      status: "ACTIVE" | "CONSUMED" | "RELEASED";
    }>;
    const ledgerRows = database.prepare(
      `SELECT l.reservation_id,l.paper_execution_id,l.entry_type,l.delta_micros,l.remaining_after_micros
       FROM paper_reservation_ledger l
       JOIN paper_reservations r ON r.reservation_id=l.reservation_id
       WHERE r.paper_account_id=? ORDER BY l.rowid`,
    ).all(paperAccountId) as unknown as Array<{
      reservation_id: string;
      paper_execution_id: string;
      entry_type: string;
      delta_micros: string;
      remaining_after_micros: string;
    }>;
    const ledgerByReservation = new Map<string, typeof ledgerRows>();
    for (const row of ledgerRows) {
      const rows = ledgerByReservation.get(row.reservation_id) ?? [];
      rows.push(row);
      ledgerByReservation.set(row.reservation_id, rows);
    }
    let activeReservationsMicros = 0n;
    let reservationLedgerMicros = 0n;
    for (const reservation of reservations) {
      const remaining = parseInteger(
        reservation.remaining_amount_micros,
        `paper_reservations:${reservation.reservation_id}:remaining_amount_micros`,
        issues,
      );
      if (remaining === null) continue;
      const entries = ledgerByReservation.get(reservation.reservation_id) ?? [];
      if (entries.length === 0) issues.push(`MISSING_LEDGER:${reservation.reservation_id}`);
      let ledgerRemaining = 0n;
      for (const [index, entry] of entries.entries()) {
        if (entry.paper_execution_id !== reservation.paper_execution_id) {
          issues.push(`EXECUTION:${reservation.reservation_id}:${index}`);
        }
        const delta = parseInteger(
          entry.delta_micros,
          `paper_reservation_ledger:${reservation.reservation_id}:${index}:delta_micros`,
          issues,
        );
        const remainingAfter = parseInteger(
          entry.remaining_after_micros,
          `paper_reservation_ledger:${reservation.reservation_id}:${index}:remaining_after_micros`,
          issues,
        );
        if (delta === null || remainingAfter === null) continue;
        ledgerRemaining += delta;
        if (ledgerRemaining < 0n) issues.push(`NEGATIVE_RUNNING_BALANCE:${reservation.reservation_id}:${index}`);
        if (ledgerRemaining !== remainingAfter) issues.push(`AFTER_BALANCE:${reservation.reservation_id}:${index}`);
      }
      reservationLedgerMicros += ledgerRemaining;
      if (ledgerRemaining !== remaining) issues.push(`LEDGER:${reservation.reservation_id}`);
      if ((reservation.status === "ACTIVE") !== (remaining > 0n)) issues.push(`STATUS:${reservation.reservation_id}`);
      if (reservation.status === "ACTIVE") activeReservationsMicros += remaining;
    }
    const matches = issues.length === 0
      && accountReservedMicros !== null
      && cashLedgerReservedMicros !== null
      && accountReservedMicros === activeReservationsMicros
      && accountReservedMicros === reservationLedgerMicros
      && accountReservedMicros === cashLedgerReservedMicros;
    return {
      matches,
      result: {
        accountReservedMicros: accountReservedMicros?.toString() ?? "INVALID",
        activeReservationsMicros: activeReservationsMicros.toString(),
        reservationLedgerMicros: reservationLedgerMicros.toString(),
        cashLedgerReservedMicros: cashLedgerReservedMicros?.toString() ?? "INVALID",
        matches,
        reservationIssues: issues,
      },
    };
  }

  private negativeValues(database: DatabaseSync, paperAccountId: string): string[] {
    const values: NumericValue[] = [];
    const addRows = (
      table: string,
      idColumn: string,
      columns: string[],
      rows: Array<Record<string, string | null>>,
    ): void => {
      for (const row of rows) {
        for (const column of columns) {
          values.push({ table, id: row[idColumn] ?? "UNKNOWN", column, value: row[column] ?? null });
        }
      }
    };
    addRows("paper_accounts", "paper_account_id", ["cash_balance_micros", "reserved_balance_micros"], database.prepare(
      "SELECT paper_account_id,cash_balance_micros,reserved_balance_micros FROM paper_accounts WHERE paper_account_id=?",
    ).all(paperAccountId) as unknown as Array<Record<string, string | null>>);
    addRows("paper_reservations", "reservation_id", ["original_amount_micros", "remaining_amount_micros"], database.prepare(
      "SELECT reservation_id,original_amount_micros,remaining_amount_micros FROM paper_reservations WHERE paper_account_id=?",
    ).all(paperAccountId) as unknown as Array<Record<string, string | null>>);
    addRows("paper_executions", "paper_execution_id", ["requested_amount_micros", "requested_size_micros", "filled_size_micros", "filled_notional_micros", "fee_micros"], database.prepare(
      `SELECT paper_execution_id,requested_amount_micros,requested_size_micros,
              filled_size_micros,filled_notional_micros,fee_micros
       FROM paper_executions WHERE paper_account_id=?`,
    ).all(paperAccountId) as unknown as Array<Record<string, string | null>>);
    addRows("paper_orders", "paper_order_id", ["requested_size_micros", "requested_amount_micros", "filled_size_micros", "filled_notional_micros", "fee_micros"], database.prepare(
      `SELECT o.paper_order_id,o.requested_size_micros,o.requested_amount_micros,
              o.filled_size_micros,o.filled_notional_micros,o.fee_micros
       FROM paper_orders o JOIN paper_executions e ON e.paper_execution_id=o.paper_execution_id
       WHERE e.paper_account_id=?`,
    ).all(paperAccountId) as unknown as Array<Record<string, string | null>>);
    addRows("paper_fill_ledger", "fill_id", ["size_micros", "notional_micros", "fee_micros"], database.prepare(
      `SELECT f.fill_id,f.size_micros,f.notional_micros,f.fee_micros
       FROM paper_fill_ledger f JOIN paper_executions e ON e.paper_execution_id=f.paper_execution_id
       WHERE e.paper_account_id=?`,
    ).all(paperAccountId) as unknown as Array<Record<string, string | null>>);
    addRows("paper_fee_ledger", "fee_ledger_id", ["fee_micros"], database.prepare(
      `SELECT f.fee_ledger_id,f.fee_micros
       FROM paper_fee_ledger f JOIN paper_executions e ON e.paper_execution_id=f.paper_execution_id
       WHERE e.paper_account_id=?`,
    ).all(paperAccountId) as unknown as Array<Record<string, string | null>>);
    addRows("paper_positions", "paper_position_id", ["entry_size_micros", "entry_notional_micros", "entry_fee_micros", "current_size_micros", "remaining_cost_micros"], database.prepare(
      `SELECT paper_position_id,entry_size_micros,entry_notional_micros,entry_fee_micros,
              current_size_micros,remaining_cost_micros
       FROM paper_positions WHERE paper_account_id=?`,
    ).all(paperAccountId) as unknown as Array<Record<string, string | null>>);
    addRows("paper_cash_ledger", "cash_ledger_id", ["cash_after_micros", "reserved_after_micros"], database.prepare(
      "SELECT cash_ledger_id,cash_after_micros,reserved_after_micros FROM paper_cash_ledger WHERE paper_account_id=?",
    ).all(paperAccountId) as unknown as Array<Record<string, string | null>>);
    addRows("paper_reservation_ledger", "reservation_ledger_id", ["remaining_after_micros"], database.prepare(
      `SELECT l.reservation_ledger_id,l.remaining_after_micros
       FROM paper_reservation_ledger l JOIN paper_reservations r ON r.reservation_id=l.reservation_id
       WHERE r.paper_account_id=?`,
    ).all(paperAccountId) as unknown as Array<Record<string, string | null>>);
    addRows("paper_pnl_ledger", "pnl_ledger_id", ["proceeds_micros", "cost_basis_micros", "fee_micros"], database.prepare(
      `SELECT pnl_ledger_id,proceeds_micros,cost_basis_micros,fee_micros
       FROM paper_pnl_ledger WHERE paper_account_id=?`,
    ).all(paperAccountId) as unknown as Array<Record<string, string | null>>);

    const details: string[] = [];
    for (const value of values) {
      if (value.value === null) continue;
      const parsed = parseInteger(value.value, `${value.table}:${value.id}:${value.column}`);
      if (parsed === null) details.push(`${value.table}:${value.id}:${value.column}:INVALID`);
      else if (parsed < 0n) details.push(`${value.table}:${value.id}:${value.column}`);
    }
    return details.sort();
  }

  private orphanDetails(database: DatabaseSync, paperAccountId: string): string[] {
    const details: string[] = [];
    const collect = (sql: string, prefix: string): void => {
      const rows = database.prepare(sql).all(paperAccountId, paperAccountId) as unknown as Array<{ id: string; relation: string }>;
      for (const row of rows) details.push(`${prefix}:${row.id}:${row.relation}`);
    };
    collect(
      `SELECT r.reservation_id id,'execution' relation
       FROM paper_reservations r LEFT JOIN paper_executions e ON e.paper_execution_id=r.paper_execution_id
       WHERE r.paper_account_id=? AND (e.paper_execution_id IS NULL OR e.paper_account_id<>?)`,
      "paper_reservations",
    );
    collect(
      `SELECT f.fill_id id,'order_or_execution' relation
       FROM paper_fill_ledger f
       LEFT JOIN paper_orders o ON o.paper_order_id=f.paper_order_id
       LEFT JOIN paper_executions e ON e.paper_execution_id=f.paper_execution_id
       LEFT JOIN paper_executions oe ON oe.paper_execution_id=o.paper_execution_id
       LEFT JOIN paper_positions p ON p.paper_position_id=f.paper_position_id
       WHERE (e.paper_account_id=? OR oe.paper_account_id=?)
         AND (o.paper_order_id IS NULL OR e.paper_execution_id IS NULL
           OR o.paper_execution_id<>f.paper_execution_id OR e.paper_account_id<>oe.paper_account_id
           OR (f.side='BUY' AND (p.paper_position_id IS NULL
             OR p.paper_account_id<>e.paper_account_id OR p.opening_execution_id<>e.paper_execution_id)))`,
      "paper_fill_ledger",
    );
    collect(
      `SELECT f.fee_ledger_id id,'order_execution_or_snapshot' relation
       FROM paper_fee_ledger f
       LEFT JOIN paper_orders o ON o.paper_order_id=f.paper_order_id
       LEFT JOIN paper_fee_snapshots s ON s.fee_snapshot_id=f.fee_snapshot_id
       LEFT JOIN paper_executions e ON e.paper_execution_id=f.paper_execution_id
       LEFT JOIN paper_executions oe ON oe.paper_execution_id=o.paper_execution_id
       WHERE (e.paper_account_id=? OR oe.paper_account_id=?)
         AND (o.paper_order_id IS NULL OR e.paper_execution_id IS NULL
           OR o.paper_execution_id<>f.paper_execution_id OR s.fee_snapshot_id IS NULL
           OR e.paper_account_id<>oe.paper_account_id)`,
      "paper_fee_ledger",
    );
    collect(
      `SELECT p.paper_position_id id,'opening_execution' relation
       FROM paper_positions p LEFT JOIN paper_executions e ON e.paper_execution_id=p.opening_execution_id
       WHERE p.paper_account_id=? AND (e.paper_execution_id IS NULL OR e.paper_account_id<>?)`,
      "paper_positions",
    );
    collect(
      `SELECT ep.paper_execution_id || ':' || ep.paper_position_id id,'execution_or_position' relation
       FROM paper_execution_positions ep
       LEFT JOIN paper_executions e ON e.paper_execution_id=ep.paper_execution_id
       LEFT JOIN paper_positions p ON p.paper_position_id=ep.paper_position_id
       WHERE (e.paper_account_id=? OR p.paper_account_id=?)
         AND (e.paper_execution_id IS NULL OR p.paper_position_id IS NULL OR e.paper_account_id<>p.paper_account_id)`,
      "paper_execution_positions",
    );
    collect(
      `SELECT c.cash_ledger_id id,'execution' relation
       FROM paper_cash_ledger c LEFT JOIN paper_executions e ON e.paper_execution_id=c.paper_execution_id
       WHERE c.paper_account_id=? AND c.paper_execution_id IS NOT NULL
         AND (e.paper_execution_id IS NULL OR e.paper_account_id<>?)`,
      "paper_cash_ledger",
    );
    collect(
      `SELECT p.pnl_ledger_id id,'position_or_execution' relation
       FROM paper_pnl_ledger p
       LEFT JOIN paper_positions pos ON pos.paper_position_id=p.paper_position_id
       LEFT JOIN paper_executions e ON e.paper_execution_id=p.paper_execution_id
       WHERE p.paper_account_id=? AND (pos.paper_position_id IS NULL OR e.paper_execution_id IS NULL
         OR pos.paper_account_id<>? OR e.paper_account_id<>p.paper_account_id)`,
      "paper_pnl_ledger",
    );
    const settlementRows = database.prepare(
      `SELECT s.paper_settlement_id id,'position_or_execution' relation
       FROM paper_settlements s
       LEFT JOIN paper_positions p ON p.paper_position_id=s.paper_position_id
       LEFT JOIN paper_executions e ON e.paper_execution_id=s.paper_execution_id
       WHERE (p.paper_account_id=? OR e.paper_account_id=?)
         AND (p.paper_position_id IS NULL OR e.paper_execution_id IS NULL OR p.paper_account_id<>e.paper_account_id)`,
    ).all(paperAccountId, paperAccountId) as unknown as Array<{ id: string; relation: string }>;
    for (const row of settlementRows) details.push(`paper_settlements:${row.id}:${row.relation}`);
    return details.sort();
  }

  private executionAndOrderAggregateIssues(database: DatabaseSync, paperAccountId: string): string[] {
    const issues: string[] = [];
    const executions = database.prepare(
      `SELECT paper_execution_id,execution_type,filled_size_micros,filled_notional_micros,fee_micros
       FROM paper_executions WHERE paper_account_id=? ORDER BY paper_execution_id`,
    ).all(paperAccountId) as unknown as Array<{
      paper_execution_id: string;
      execution_type: string;
      filled_size_micros: string;
      filled_notional_micros: string;
      fee_micros: string;
    }>;
    for (const execution of executions) {
      if (execution.execution_type === "SETTLEMENT") continue;
      const fills = database.prepare(
        "SELECT size_micros,notional_micros,fee_micros FROM paper_fill_ledger WHERE paper_execution_id=?",
      ).all(execution.paper_execution_id) as unknown as Array<{ size_micros: string; notional_micros: string; fee_micros: string }>;
      const fillSize = sumValues(fills.map((row) => row.size_micros), `execution:${execution.paper_execution_id}:fill_size`, issues);
      const fillNotional = sumValues(fills.map((row) => row.notional_micros), `execution:${execution.paper_execution_id}:fill_notional`, issues);
      const fillFee = sumValues(fills.map((row) => row.fee_micros), `execution:${execution.paper_execution_id}:fill_fee`, issues);
      if (
        fillSize === null || fillNotional === null || fillFee === null
        || fillSize !== parseInteger(execution.filled_size_micros, `execution:${execution.paper_execution_id}:filled_size`, issues)
        || fillNotional !== parseInteger(execution.filled_notional_micros, `execution:${execution.paper_execution_id}:filled_notional`, issues)
        || fillFee !== parseInteger(execution.fee_micros, `execution:${execution.paper_execution_id}:fee`, issues)
      ) issues.push(`EXECUTION_FILL:${execution.paper_execution_id}`);
    }

    const orders = database.prepare(
      `SELECT o.paper_order_id,o.filled_size_micros,o.filled_notional_micros,o.fee_micros
       FROM paper_orders o JOIN paper_executions e ON e.paper_execution_id=o.paper_execution_id
       WHERE e.paper_account_id=? ORDER BY o.paper_order_id`,
    ).all(paperAccountId) as unknown as Array<{
      paper_order_id: string;
      filled_size_micros: string;
      filled_notional_micros: string;
      fee_micros: string;
    }>;
    for (const order of orders) {
      const fills = database.prepare(
        "SELECT size_micros,notional_micros,fee_micros FROM paper_fill_ledger WHERE paper_order_id=?",
      ).all(order.paper_order_id) as unknown as Array<{ size_micros: string; notional_micros: string; fee_micros: string }>;
      const ledgerFees = database.prepare(
        "SELECT fee_micros FROM paper_fee_ledger WHERE paper_order_id=?",
      ).all(order.paper_order_id) as unknown as Array<{ fee_micros: string }>;
      const size = sumValues(fills.map((row) => row.size_micros), `order:${order.paper_order_id}:fill_size`, issues);
      const notional = sumValues(fills.map((row) => row.notional_micros), `order:${order.paper_order_id}:fill_notional`, issues);
      const fillFee = sumValues(fills.map((row) => row.fee_micros), `order:${order.paper_order_id}:fill_fee`, issues);
      const ledgerFee = sumValues(ledgerFees.map((row) => row.fee_micros), `order:${order.paper_order_id}:ledger_fee`, issues);
      const recordedSize = parseInteger(order.filled_size_micros, `order:${order.paper_order_id}:filled_size`, issues);
      const recordedNotional = parseInteger(order.filled_notional_micros, `order:${order.paper_order_id}:filled_notional`, issues);
      const recordedFee = parseInteger(order.fee_micros, `order:${order.paper_order_id}:fee`, issues);
      if (fills.length > 0 && ledgerFees.length !== 1) {
        issues.push(`FEE_EVIDENCE:${order.paper_order_id}`);
      }
      if (size !== recordedSize || notional !== recordedNotional || fillFee !== recordedFee || ledgerFee !== recordedFee) {
        issues.push(`ORDER_FILL_FEE:${order.paper_order_id}`);
      }
    }
    return issues;
  }

  private targetBindingIssues(
    database: DatabaseSync,
    paperAccountId: string,
    targetId: string | null,
  ): string[] {
    if (!targetId) return [];
    const rows = database.prepare(
      `SELECT e.paper_execution_id
       FROM paper_executions e
       LEFT JOIN signals s ON s.signal_id=e.signal_id
       LEFT JOIN raw_events r ON r.source_event_key=s.source_event_key
       WHERE e.paper_account_id=? AND e.signal_id IS NOT NULL
         AND (r.target_id IS NULL OR r.target_id<>?)
       ORDER BY e.paper_execution_id`,
    ).all(paperAccountId, targetId) as unknown as Array<{ paper_execution_id: string }>;
    return rows.map((row) => `EXECUTION_TARGET:${row.paper_execution_id}`);
  }

  private settlementIssueDetails(database: DatabaseSync, paperAccountId: string): string[] {
    const rows = database.prepare(
      `SELECT p.paper_position_id
       FROM paper_positions p
       JOIN audit_log a ON a.audit_id=(
         SELECT latest.audit_id
         FROM audit_log latest
         WHERE latest.entity_type='PAPER_POSITION'
           AND latest.entity_id=p.paper_position_id
           AND latest.action IN ('SETTLEMENT_DEFERRED','SETTLEMENT_RECOVERED')
         ORDER BY latest.timestamp DESC,latest.audit_id DESC
         LIMIT 1
       )
       WHERE p.paper_account_id=? AND p.status<>'REDEEMED'
         AND a.action='SETTLEMENT_DEFERRED'
       ORDER BY p.paper_position_id`,
    ).all(paperAccountId) as unknown as Array<{ paper_position_id: string }>;
    return rows.map((row) => `SETTLEMENT_ISSUE:${row.paper_position_id}`);
  }

  private positionAggregateIssues(database: DatabaseSync, paperAccountId: string): string[] {
    const issues: string[] = [];
    const positions = database.prepare(
      `SELECT paper_position_id,opening_execution_id,entry_size_micros,entry_notional_micros,
              entry_fee_micros,current_size_micros,remaining_cost_micros,realized_pnl_micros,status
       FROM paper_positions WHERE paper_account_id=? ORDER BY paper_position_id`,
    ).all(paperAccountId) as unknown as Array<{
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
    for (const position of positions) {
      const buyFills = database.prepare(
        `SELECT size_micros,notional_micros,fee_micros FROM paper_fill_ledger
         WHERE paper_execution_id=? AND paper_position_id=? AND side='BUY'`,
      ).all(position.opening_execution_id, position.paper_position_id) as unknown as Array<{
        size_micros: string;
        notional_micros: string;
        fee_micros: string;
      }>;
      const allocations = database.prepare(
        "SELECT filled_size_micros FROM paper_execution_positions WHERE paper_position_id=?",
      ).all(position.paper_position_id) as unknown as Array<{ filled_size_micros: string }>;
      const pendingExitRows = database.prepare(
        `SELECT ep.requested_size_micros,ep.filled_size_micros
         FROM paper_execution_positions ep
         JOIN paper_executions e ON e.paper_execution_id=ep.paper_execution_id
         WHERE ep.paper_position_id=? AND e.state IN ('EXIT_PENDING','STOP_EXIT_PENDING')`,
      ).all(position.paper_position_id) as unknown as Array<{
        requested_size_micros: string;
        filled_size_micros: string;
      }>;
      const pnlRows = database.prepare(
        "SELECT cost_basis_micros,pnl_micros FROM paper_pnl_ledger WHERE paper_position_id=?",
      ).all(position.paper_position_id) as unknown as Array<{ cost_basis_micros: string; pnl_micros: string }>;
      const settlementCount = (database.prepare(
        "SELECT count(*) count FROM paper_settlements WHERE paper_position_id=?",
      ).get(position.paper_position_id) as { count: number }).count;
      const entrySize = parseInteger(position.entry_size_micros, `position:${position.paper_position_id}:entry_size`, issues);
      const entryNotional = parseInteger(position.entry_notional_micros, `position:${position.paper_position_id}:entry_notional`, issues);
      const entryFee = parseInteger(position.entry_fee_micros, `position:${position.paper_position_id}:entry_fee`, issues);
      const buySize = sumValues(buyFills.map((row) => row.size_micros), `position:${position.paper_position_id}:buy_size`, issues);
      const buyNotional = sumValues(buyFills.map((row) => row.notional_micros), `position:${position.paper_position_id}:buy_notional`, issues);
      const buyFee = sumValues(buyFills.map((row) => row.fee_micros), `position:${position.paper_position_id}:buy_fee`, issues);
      const soldSize = sumValues(allocations.map((row) => row.filled_size_micros), `position:${position.paper_position_id}:sold_size`, issues);
      const realizedCost = sumValues(pnlRows.map((row) => row.cost_basis_micros), `position:${position.paper_position_id}:realized_cost`, issues);
      const realizedPnl = sumValues(pnlRows.map((row) => row.pnl_micros), `position:${position.paper_position_id}:realized_pnl`, issues);
      const currentSize = parseInteger(position.current_size_micros, `position:${position.paper_position_id}:current_size`, issues);
      const pendingExitSize = pendingExitRows.reduce((total, row) => {
        const requested = parseInteger(row.requested_size_micros, `position:${position.paper_position_id}:pending_requested`, issues);
        const filled = parseInteger(row.filled_size_micros, `position:${position.paper_position_id}:pending_filled`, issues);
        return requested === null || filled === null ? total : total + requested - filled;
      }, 0n);
      const remainingCost = parseInteger(position.remaining_cost_micros, `position:${position.paper_position_id}:remaining_cost`, issues);
      const recordedPnl = parseInteger(position.realized_pnl_micros, `position:${position.paper_position_id}:recorded_pnl`, issues);
      const statusValid = currentSize !== null && soldSize !== null && (
        position.status === "OPEN" ? currentSize > 0n && soldSize === 0n && settlementCount === 0
          : position.status === "PARTIALLY_CLOSED" ? currentSize > 0n && soldSize > 0n && settlementCount === 0
            : position.status === "SETTLEMENT_PENDING" ? currentSize > 0n && settlementCount === 0
              : position.status === "CLOSED" ? currentSize === 0n && settlementCount === 0
                : position.status === "REDEEMED" ? currentSize === 0n && settlementCount === 1
                  : position.status === "FROZEN" ? currentSize > 0n
                    : false
      );
      if (
        entrySize === null || entryNotional === null || entryFee === null || buySize === null
        || buyNotional === null || buyFee === null || soldSize === null || realizedCost === null
        || realizedPnl === null || currentSize === null || remainingCost === null || recordedPnl === null
        || buySize !== entrySize || buyNotional !== entryNotional || buyFee !== entryFee
        || soldSize < 0n || soldSize > entrySize
        || currentSize !== (settlementCount > 0 ? 0n : entrySize - soldSize)
        || pendingExitSize < 0n || pendingExitSize > currentSize
        || (position.status === "SETTLEMENT_PENDING" && pendingExitSize > 0n)
        || remainingCost !== entryNotional + entryFee - realizedCost
        || recordedPnl !== realizedPnl
        || (position.status === "REDEEMED") !== (settlementCount === 1)
        || !statusValid
      ) issues.push(`POSITION_LEDGER:${position.paper_position_id}`);
    }
    return issues;
  }
}
