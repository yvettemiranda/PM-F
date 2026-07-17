import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { check, errorCheck } from "./checks.js";
import type { ValidationCheckResult, ValidationValidator, ValidationValidatorContext } from "./types.js";

interface ReplayRunRow {
  replay_run_id: string;
  status: string;
  report_hash: string;
  metrics_json: string;
  incomplete_reasons_json: string;
}

function scalar(database: DatabaseSync, sql: string, ...params: SQLInputValue[]): string {
  const row = database.prepare(sql).get(...params) as { value: string | number | null } | undefined;
  return String(row?.value ?? "0");
}

function sumTextColumn(database: DatabaseSync, sql: string, ...params: SQLInputValue[]): string {
  const rows = database.prepare(sql).all(...params) as unknown as Array<{ value: string }>;
  return rows.reduce((total, row) => total + BigInt(row.value), 0n).toString();
}

export class PaperReplayValidation implements ValidationValidator {
  readonly type = "PAPER_REPLAY" as const;

  async run(context: ValidationValidatorContext): Promise<ValidationCheckResult[]> {
    const database = new DatabaseSync(context.databasePath, { readOnly: true });
    try {
      return [
        this.replaySource(database, context.scope.targetId, context.now),
        this.paperExecutionSummary(database, context.scope, context.now),
        this.historicalOrderbookCoverage(database, context.scope, context.now),
        this.replayEvidenceLevel(context.now),
      ];
    } catch (error) {
      return [errorCheck({ checkType: this.type, checkName: "paper_replay_exception", reason: "PAPER_REPLAY_VALIDATION_FAILED", error, now: context.now })];
    } finally {
      database.close();
    }
  }

  private replaySource(database: DatabaseSync, targetId: string, now: () => Date): ValidationCheckResult {
    const replay = database.prepare(
      `SELECT replay_run_id,status,report_hash,metrics_json,incomplete_reasons_json
       FROM replay_runs WHERE target_id=? ORDER BY created_at DESC LIMIT 1`,
    ).get(targetId) as ReplayRunRow | undefined;
    if (!replay) {
      return check({
        checkType: this.type,
        checkName: "historical_target_replay_artifact",
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
      checkName: "historical_target_replay_artifact",
      status: replay.status === "FAILED" ? "FAIL" : replay.status === "PASSED" ? "PASS" : "WARN",
      blocking: replay.status === "FAILED",
      reason: replay.status === "PASSED" ? "OK" : `REPLAY_${replay.status}`,
      metrics: {
        replayRunId: replay.replay_run_id,
        reportHash: replay.report_hash,
        replayMetrics: JSON.parse(replay.metrics_json) as Record<string, unknown>,
        incompleteReasons,
        evidenceLevel: "HISTORICAL_TARGET_REPLAY",
      },
      now,
    });
  }

  private paperExecutionSummary(
    database: DatabaseSync,
    scope: ValidationValidatorContext["scope"],
    now: () => Date,
  ): ValidationCheckResult {
    const accountId = scope.accountId;
    const scopeArguments = [
      scope.targetId,
      scope.baselineRunId,
      scope.campaignId,
      scope.sessionId,
    ] as const;
    const session = database.prepare(
      "SELECT started_at FROM paper_validation_sessions WHERE campaign_id=? AND session_id=?",
    ).get(scope.campaignId, scope.sessionId) as { started_at: string };
    const scopedExecutionCte = `WITH scoped_signals AS (
      SELECT s.signal_id FROM signals s
      JOIN observe_runs o ON o.observe_run_id=s.observe_run_id
      WHERE s.target_id=? AND s.baseline_run_id=?
        AND o.campaign_id=? AND o.campaign_session_id=?
    ), scoped_executions AS (
      SELECT DISTINCT e.paper_execution_id
      FROM paper_executions e
      LEFT JOIN paper_execution_positions ep ON ep.paper_execution_id=e.paper_execution_id
      LEFT JOIN paper_positions p ON p.paper_position_id=ep.paper_position_id
      WHERE e.paper_account_id=?
        AND (e.signal_id IN (SELECT signal_id FROM scoped_signals)
          OR p.signal_id IN (SELECT signal_id FROM scoped_signals))
    )`;
    const metrics = {
      signals: scalar(database, `SELECT count(*) value FROM signals s
        JOIN observe_runs o ON o.observe_run_id=s.observe_run_id
        WHERE s.target_id=? AND s.baseline_run_id=?
          AND o.campaign_id=? AND o.campaign_session_id=?`,
        scope.targetId,
        scope.baselineRunId,
        scope.campaignId,
        scope.sessionId,
      ),
      executionAttempts: scalar(database, `${scopedExecutionCte}
        SELECT count(*) value FROM scoped_executions`, ...scopeArguments, accountId),
      executed: scalar(database, `${scopedExecutionCte}
        SELECT count(*) value FROM paper_executions e JOIN scoped_executions x USING(paper_execution_id)
        WHERE e.state='EXECUTED'`, ...scopeArguments, accountId),
      rejected: scalar(database, `${scopedExecutionCte}
        SELECT count(*) value FROM paper_executions e JOIN scoped_executions x USING(paper_execution_id)
        WHERE e.state='REJECTED'`, ...scopeArguments, accountId),
      fills: scalar(database, `${scopedExecutionCte}
        SELECT count(*) value FROM paper_fill_ledger f JOIN scoped_executions x USING(paper_execution_id)`,
      ...scopeArguments, accountId),
      partialFills: scalar(database, `${scopedExecutionCte}
        SELECT count(*) value FROM paper_orders o JOIN scoped_executions x USING(paper_execution_id)
        WHERE o.state='PARTIALLY_FILLED'`, ...scopeArguments, accountId),
      pnlMicros: sumTextColumn(database, `${scopedExecutionCte}
        SELECT p.pnl_micros value FROM paper_pnl_ledger p JOIN scoped_executions x USING(paper_execution_id)`,
      ...scopeArguments, accountId),
      exposureMicros: sumTextColumn(database, `SELECT remaining_cost_micros value FROM paper_positions
        WHERE paper_account_id=? AND signal_id IN (
          SELECT s.signal_id FROM signals s JOIN observe_runs o ON o.observe_run_id=s.observe_run_id
          WHERE s.target_id=? AND s.baseline_run_id=? AND o.campaign_id=? AND o.campaign_session_id=?
        ) AND status IN ('OPEN','PARTIALLY_CLOSED','SETTLEMENT_PENDING')`, accountId, ...scopeArguments),
      maxDrawdownMicros: this.maxDrawdown(database, accountId, session.started_at),
      accountLifetime: {
        executionAttempts: scalar(database, "SELECT count(*) value FROM paper_executions WHERE paper_account_id=?", accountId),
        fills: scalar(database, `SELECT count(*) value FROM paper_fill_ledger f
          JOIN paper_executions e ON e.paper_execution_id=f.paper_execution_id WHERE e.paper_account_id=?`, accountId),
      },
      evidenceLevel: "OBSERVED_CAMPAIGN_SESSION",
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
      checkName: "scoped_paper_execution_observation",
      status,
      blocking,
      reason,
      metrics,
      now,
    });
  }

  private historicalOrderbookCoverage(
    database: DatabaseSync,
    scope: ValidationValidatorContext["scope"],
    now: () => Date,
  ): ValidationCheckResult {
    const snapshots = Number(scalar(database, `SELECT count(DISTINCT orders.orderbook_snapshot_id) value
      FROM paper_orders orders
      JOIN paper_executions e ON e.paper_execution_id=orders.paper_execution_id
      LEFT JOIN paper_execution_positions ep ON ep.paper_execution_id=e.paper_execution_id
      LEFT JOIN paper_positions p ON p.paper_position_id=ep.paper_position_id
      WHERE e.paper_account_id=? AND (
        e.signal_id IN (
          SELECT s.signal_id FROM signals s JOIN observe_runs o ON o.observe_run_id=s.observe_run_id
          WHERE s.target_id=? AND s.baseline_run_id=? AND o.campaign_id=? AND o.campaign_session_id=?
        ) OR p.signal_id IN (
          SELECT s.signal_id FROM signals s JOIN observe_runs o ON o.observe_run_id=s.observe_run_id
          WHERE s.target_id=? AND s.baseline_run_id=? AND o.campaign_id=? AND o.campaign_session_id=?
        )
      )`,
    scope.accountId,
    scope.targetId, scope.baselineRunId, scope.campaignId, scope.sessionId,
    scope.targetId, scope.baselineRunId, scope.campaignId, scope.sessionId));
    return check({
      checkType: this.type,
      checkName: "scoped_orderbook_evidence",
      status: snapshots > 0 ? "PASS" : "SKIPPED",
      blocking: false,
      reason: snapshots > 0 ? "OK" : "ORDERBOOK_SNAPSHOT_MISSING",
      metrics: { orderbookSnapshots: snapshots, evidenceLevel: "OBSERVED_CAMPAIGN_SESSION" },
      now,
    });
  }

  private replayEvidenceLevel(now: () => Date): ValidationCheckResult {
    return check({
      checkType: this.type,
      checkName: "campaign_execution_replay_evidence_level",
      status: "WARN",
      blocking: false,
      reason: "NO_SESSION_BOUND_EXECUTION_REPLAY_PROOF",
      metrics: {
        evidenceLevel: "OBSERVED_CAMPAIGN_ACCOUNT_PLUS_HISTORICAL_TARGET_REPLAY",
        provesDeterministicExecutionReplay: false,
      },
      now,
    });
  }

  private maxDrawdown(database: DatabaseSync, accountId: string, startedAt: string): string {
    const rows = database.prepare(
      `SELECT total_equity_micros FROM portfolio_projection_runs
       WHERE paper_account_id=? AND created_at>=? ORDER BY created_at`,
    ).all(accountId, startedAt) as unknown as Array<{ total_equity_micros: string }>;
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
