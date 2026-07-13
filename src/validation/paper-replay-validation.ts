import { DatabaseSync } from "node:sqlite";
import { check, errorCheck } from "./checks.js";
import type { ValidationCheckResult, ValidationValidator, ValidationValidatorContext } from "./types.js";

interface ReplayRunRow {
  replay_run_id: string;
  status: string;
  report_hash: string;
  metrics_json: string;
  incomplete_reasons_json: string;
}

function scalar(database: DatabaseSync, sql: string): string {
  const row = database.prepare(sql).get() as { value: string | number | null } | undefined;
  return String(row?.value ?? "0");
}

function sumTextColumn(database: DatabaseSync, sql: string): string {
  const rows = database.prepare(sql).all() as unknown as Array<{ value: string }>;
  return rows.reduce((total, row) => total + BigInt(row.value), 0n).toString();
}

export class PaperReplayValidation implements ValidationValidator {
  readonly type = "PAPER_REPLAY" as const;

  async run(context: ValidationValidatorContext): Promise<ValidationCheckResult[]> {
    const database = new DatabaseSync(context.databasePath, { readOnly: true });
    try {
      return [
        this.replaySource(database, context.now),
        this.paperExecutionSummary(database, context.now),
        this.historicalOrderbookCoverage(database, context.now),
      ];
    } catch (error) {
      return [errorCheck({ checkType: this.type, checkName: "paper_replay_exception", reason: "PAPER_REPLAY_VALIDATION_FAILED", error, now: context.now })];
    } finally {
      database.close();
    }
  }

  private replaySource(database: DatabaseSync, now: () => Date): ValidationCheckResult {
    const replay = database.prepare(
      "SELECT replay_run_id,status,report_hash,metrics_json,incomplete_reasons_json FROM replay_runs ORDER BY created_at DESC LIMIT 1",
    ).get() as ReplayRunRow | undefined;
    if (!replay) {
      return check({
        checkType: this.type,
        checkName: "replay_source_available",
        status: "SKIPPED",
        blocking: false,
        reason: "REPLAY_DATA_NOT_AVAILABLE",
        metrics: {},
        now,
      });
    }
    const incompleteReasons = JSON.parse(replay.incomplete_reasons_json) as unknown[];
    return check({
      checkType: this.type,
      checkName: "replay_source_available",
      status: replay.status === "FAILED" ? "FAIL" : replay.status === "PASSED" ? "PASS" : "WARN",
      blocking: replay.status === "FAILED",
      reason: replay.status === "PASSED" ? "OK" : `REPLAY_${replay.status}`,
      metrics: {
        replayRunId: replay.replay_run_id,
        reportHash: replay.report_hash,
        replayMetrics: JSON.parse(replay.metrics_json) as Record<string, unknown>,
        incompleteReasons,
      },
      now,
    });
  }

  private paperExecutionSummary(database: DatabaseSync, now: () => Date): ValidationCheckResult {
    const metrics = {
      signals: scalar(database, "SELECT count(*) value FROM signals"),
      executionAttempts: scalar(database, "SELECT count(*) value FROM paper_executions"),
      executed: scalar(database, "SELECT count(*) value FROM paper_executions WHERE state='EXECUTED'"),
      rejected: scalar(database, "SELECT count(*) value FROM paper_executions WHERE state='REJECTED'"),
      fills: scalar(database, "SELECT count(*) value FROM paper_fill_ledger"),
      partialFills: scalar(database, "SELECT count(*) value FROM paper_orders WHERE state='PARTIALLY_FILLED'"),
      pnlMicros: sumTextColumn(database, "SELECT pnl_micros value FROM paper_pnl_ledger"),
      exposureMicros: sumTextColumn(database, "SELECT remaining_cost_micros value FROM paper_positions WHERE status IN ('OPEN','PARTIALLY_CLOSED','SETTLEMENT_PENDING')"),
      maxDrawdownMicros: this.maxDrawdown(database),
    };
    const signalCount = BigInt(metrics.signals);
    const executionAttempts = BigInt(metrics.executionAttempts);
    const executed = BigInt(metrics.executed);
    const fills = BigInt(metrics.fills);
    let status: ValidationCheckResult["status"];
    let blocking = false;
    let reason: string;
    if (executionAttempts === 0n) {
      status = "NOT_RUN";
      reason = signalCount > 0n ? "PAPER_EXECUTION_NOT_RUN" : "PAPER_REPLAY_NOT_RUN";
    } else if (executed > 0n && fills === 0n) {
      status = "FAIL";
      blocking = true;
      reason = "PAPER_EXECUTED_WITHOUT_FILL_LEDGER";
    } else if (fills === 0n) {
      status = "WARN";
      reason = "PAPER_EXECUTION_NO_FILLS";
    } else {
      status = "PASS";
      reason = "OK";
    }
    return check({
      checkType: this.type,
      checkName: "paper_execution_summary",
      status,
      blocking,
      reason,
      metrics,
      now,
    });
  }

  private historicalOrderbookCoverage(database: DatabaseSync, now: () => Date): ValidationCheckResult {
    const snapshots = Number(scalar(database, "SELECT count(*) value FROM paper_orderbook_snapshots"));
    return check({
      checkType: this.type,
      checkName: "historical_orderbook_replay",
      status: snapshots > 0 ? "PASS" : "SKIPPED",
      blocking: false,
      reason: snapshots > 0 ? "OK" : "ORDERBOOK_SNAPSHOT_MISSING",
      metrics: { orderbookSnapshots: snapshots },
      now,
    });
  }

  private maxDrawdown(database: DatabaseSync): string {
    const rows = database.prepare(
      `SELECT total_equity_micros FROM portfolio_projection_runs ORDER BY created_at`,
    ).all() as unknown as Array<{ total_equity_micros: string }>;
    let peak = 0n;
    let maxDrawdown = 0n;
    for (const row of rows) {
      const equity = BigInt(row.total_equity_micros);
      if (equity > peak) peak = equity;
      const drawdown = peak - equity;
      if (drawdown > maxDrawdown) maxDrawdown = drawdown;
    }
    return maxDrawdown.toString();
  }
}
