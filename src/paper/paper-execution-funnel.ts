import { DatabaseSync } from "node:sqlite";

export type PaperLifecycleStage =
  | "NO_SIGNAL"
  | "INELIGIBLE_ONLY"
  | "RISK_REJECTED"
  | "WAITING_EXECUTION"
  | "EXECUTION_PRECONDITION_REJECTED"
  | "ORDERED_UNFILLED"
  | "PARTIAL_FILL"
  | "FULL_FILL";

export interface PaperExecutionFunnel {
  signals: {
    buy: number;
    sell: number;
    published: number;
    executionEligible: number;
    ineligible: number;
    gap: number;
    unconsumedEligible: number;
    ineligibleReasons: Record<string, number>;
  };
  capital: {
    high: number;
    medium: number;
    low: number;
    unknown: number;
    sizingDecisionCount: number;
    sizingRejectReasons: Record<string, number>;
    sizingEvidence: Array<{
      calculationVersion: string;
      accountCapitalMicros: string;
      targetTradeAmountMicros: string | null;
      targetVisibleCapitalMicros: string | null;
      ratioExact: string | null;
      ratioDecimal: string | null;
      ratioPpmDecimal: string | null;
      calculatedAmountMicros: string | null;
      remainderNumerator: string | null;
      roundingMode: string | null;
      result: string;
      reason: string | null;
      evidenceHash: string;
    }>;
  };
  risk: {
    allow: number;
    reject: number;
    rejectReasons: Record<string, number>;
  };
  execution: {
    total: number;
    waiting: number;
    rejectedBeforeOrder: number;
    rejectedBeforeOrderReasons: Record<string, number>;
    marketConstraintRejects: number;
    marketConstraintRejectReasons: Record<string, number>;
    expired: number;
    cancelled: number;
    exitPending: number;
    stopExitPending: number;
    orders: number;
    zeroFillOrders: number;
    partialFillOrders: number;
    fullFillOrders: number;
    fills: number;
  };
  positions: {
    total: number;
    open: number;
    partiallyClosed: number;
    frozen: number;
    settlementPending: number;
    closed: number;
    redeemed: number;
  };
  reservations: {
    total: number;
    active: number;
    consumed: number;
    released: number;
    activeMicros: string;
    releasedMicros: string;
  };
  fees: { entries: number; totalMicros: string };
  pnl: {
    realizedEntries: number;
    settlementEntries: number;
    realizedMicros: string;
    unrealizedMicros: string;
  };
  lifecycle: {
    stopLossExecutions: number;
    settlementExecutions: number;
    redeemedPositions: number;
  };
  stage: { BUY: PaperLifecycleStage; SELL: PaperLifecycleStage };
}

interface SignalRow {
  signal_id: string;
  signal_type: string;
  status: string;
  execution_eligible: number;
  execution_block_reason: string | null;
  capital_confidence: string | null;
  consumed: number;
}

interface ExecutionRow {
  execution_type: string;
  state: string;
  reason: string;
}

function grouped(values: Array<string | null>): Record<string, number> {
  const result: Record<string, number> = {};
  for (const value of values) {
    const key = value && value.trim() ? value : "UNSPECIFIED";
    result[key] = (result[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(result).sort(([left], [right]) => left.localeCompare(right)));
}

function sumIntegerRows(rows: Array<{ value: string }>, absolute = false): string {
  let total = 0n;
  for (const row of rows) {
    const value = BigInt(row.value);
    total += absolute && value < 0n ? -value : value;
  }
  return total.toString();
}

function lifecycleStage(input: {
  signalCount: number;
  eligibleCount: number;
  riskAllow: number;
  riskReject: number;
  waiting: number;
  rejected: number;
  orders: number;
  zeroFill: number;
  partialFill: number;
  fullFill: number;
}): PaperLifecycleStage {
  if (input.signalCount === 0) return "NO_SIGNAL";
  if (input.eligibleCount === 0) return "INELIGIBLE_ONLY";
  if (input.fullFill > 0) return "FULL_FILL";
  if (input.partialFill > 0) return "PARTIAL_FILL";
  if (input.orders > 0 || input.zeroFill > 0) return "ORDERED_UNFILLED";
  if (input.rejected > 0) return "EXECUTION_PRECONDITION_REJECTED";
  if (input.waiting > 0 || input.riskAllow > 0) return "WAITING_EXECUTION";
  if (input.riskReject > 0) return "RISK_REJECTED";
  return "WAITING_EXECUTION";
}

/** Read-only, account-scoped evidence funnel. It never changes business state. */
export function buildPaperExecutionFunnel(
  database: DatabaseSync,
  paperAccountId: string,
  targetId: string,
  signalCutoffAt: string,
  windowStartAt = signalCutoffAt,
  windowEndAt = new Date().toISOString(),
): PaperExecutionFunnel {
  const startAt = Date.parse(windowStartAt) > Date.parse(signalCutoffAt) ? windowStartAt : signalCutoffAt;
  if (!Number.isFinite(Date.parse(startAt)) || !Number.isFinite(Date.parse(windowEndAt))) {
    throw new Error("PAPER_FUNNEL_WINDOW_INVALID");
  }
  if (Date.parse(windowEndAt) < Date.parse(startAt)) throw new Error("PAPER_FUNNEL_WINDOW_REVERSED");
  const signals = database.prepare(
    `SELECT s.signal_id,s.signal_type,s.status,s.execution_eligible,s.execution_block_reason,
            ce.capital_confidence,
            CASE WHEN pc.signal_id IS NULL THEN 0 ELSE 1 END consumed
     FROM signals s
     LEFT JOIN capital_estimates ce ON ce.capital_estimate_id=s.capital_estimate_id
     LEFT JOIN paper_signal_consumptions pc
       ON pc.paper_account_id=? AND pc.signal_id=s.signal_id
     WHERE s.target_id=? AND s.created_at>=? AND s.created_at<=?
     ORDER BY s.created_at,s.signal_id`,
  ).all(paperAccountId, targetId, startAt, windowEndAt) as unknown as SignalRow[];
  const buySignals = signals.filter((row) => row.signal_type === "TARGET_BUY");
  const sellSignals = signals.filter((row) => row.signal_type === "TARGET_SELL");
  const eligibleSignals = signals.filter((row) => row.status === "PUBLISHED" && row.execution_eligible === 1);
  const ineligibleSignals = signals.filter((row) => row.execution_eligible !== 1);
  const gapSignals = ineligibleSignals.filter((row) => row.execution_block_reason === "GAP_EVENT");

  const riskRows = database.prepare(
    `SELECT rd.decision,rd.risk_reject_reason,rd.capital_sizing_decision_json,
            rd.capital_sizing_decision_hash
     FROM paper_executions e
     JOIN risk_decisions rd ON rd.risk_decision_id=e.risk_decision_id
     WHERE e.paper_account_id=? AND e.created_at>=? AND e.created_at<=?
     ORDER BY e.created_at,e.paper_execution_id`,
  ).all(paperAccountId, startAt, windowEndAt) as unknown as Array<{
    decision: "ALLOW" | "REJECT";
    risk_reject_reason: string | null;
    capital_sizing_decision_json: string | null;
    capital_sizing_decision_hash: string | null;
  }>;
  const riskAllow = riskRows.filter((row) => row.decision === "ALLOW").length;
  const riskRejectRows = riskRows.filter((row) => row.decision === "REJECT");

  const executions = database.prepare(
    `SELECT execution_type,state,reason
     FROM paper_executions WHERE paper_account_id=? AND created_at>=? AND created_at<=?
     ORDER BY created_at,paper_execution_id`,
  ).all(paperAccountId, startAt, windowEndAt) as unknown as ExecutionRow[];
  const orders = database.prepare(
    `SELECT o.side,o.state
     FROM paper_orders o
     JOIN paper_executions e ON e.paper_execution_id=o.paper_execution_id
     WHERE e.paper_account_id=? AND o.created_at>=? AND o.created_at<=?
     ORDER BY o.created_at,o.paper_order_id`,
  ).all(paperAccountId, startAt, windowEndAt) as unknown as Array<{ side: "BUY" | "SELL"; state: string }>;
  const fills = database.prepare(
    `SELECT f.side
     FROM paper_fill_ledger f
     JOIN paper_executions e ON e.paper_execution_id=f.paper_execution_id
     WHERE e.paper_account_id=? AND f.created_at>=? AND f.created_at<=?`,
  ).all(paperAccountId, startAt, windowEndAt) as unknown as Array<{ side: "BUY" | "SELL" }>;
  const constraintRows = database.prepare(
    `SELECT m.check_result,m.reason
     FROM paper_market_constraint_evidence m
     JOIN paper_executions e ON e.paper_execution_id=m.paper_execution_id
     WHERE e.paper_account_id=? AND m.created_at>=? AND m.created_at<=?`,
  ).all(paperAccountId, startAt, windowEndAt) as unknown as Array<{ check_result: string; reason: string }>;

  const reservations = database.prepare(
    `SELECT status,remaining_amount_micros FROM paper_reservations
     WHERE paper_account_id=? AND created_at>=? AND created_at<=?`,
  ).all(paperAccountId, startAt, windowEndAt) as unknown as Array<{ status: string; remaining_amount_micros: string }>;
  const releasedRows = database.prepare(
    `SELECT l.delta_micros value
     FROM paper_reservation_ledger l
     JOIN paper_reservations r ON r.reservation_id=l.reservation_id
     WHERE r.paper_account_id=? AND l.entry_type='RELEASE' AND l.created_at>=? AND l.created_at<=?`,
  ).all(paperAccountId, startAt, windowEndAt) as unknown as Array<{ value: string }>;
  const feeRows = database.prepare(
    `SELECT f.fee_micros value
     FROM paper_fee_ledger f
     JOIN paper_executions e ON e.paper_execution_id=f.paper_execution_id
     WHERE e.paper_account_id=? AND f.created_at>=? AND f.created_at<=?`,
  ).all(paperAccountId, startAt, windowEndAt) as unknown as Array<{ value: string }>;
  const pnlRows = database.prepare(
    `SELECT pnl_type,pnl_micros FROM paper_pnl_ledger
     WHERE paper_account_id=? AND created_at>=? AND created_at<=?`,
  ).all(paperAccountId, startAt, windowEndAt) as unknown as Array<{ pnl_type: "REALIZED" | "SETTLEMENT"; pnl_micros: string }>;
  const latestPortfolio = database.prepare(
    `SELECT unrealized_pnl_micros
     FROM paper_portfolio_snapshots WHERE paper_account_id=? AND created_at>=? AND created_at<=?
     ORDER BY created_at DESC,portfolio_snapshot_id DESC LIMIT 1`,
  ).get(paperAccountId, startAt, windowEndAt) as { unrealized_pnl_micros: string } | undefined;

  const positionStates = database.prepare(
    `SELECT status,count(*) count FROM paper_positions
     WHERE paper_account_id=?
       AND ((created_at>=? AND created_at<=?) OR (updated_at>=? AND updated_at<=?))
     GROUP BY status`,
  ).all(paperAccountId, startAt, windowEndAt, startAt, windowEndAt) as unknown as Array<{ status: string; count: number }>;
  const positionCount = (state: string): number => positionStates.find((row) => row.status === state)?.count ?? 0;

  const executionCount = (state: string): number => executions.filter((row) => row.state === state).length;
  const orderCount = (side: "BUY" | "SELL", state?: string): number => orders.filter(
    (row) => row.side === side && (state === undefined || row.state === state),
  ).length;
  const executionByType = (type: string): ExecutionRow[] => executions.filter((row) => row.execution_type === type);
  const risksForSignalType = (signalType: "TARGET_BUY" | "TARGET_SELL"): { allow: number; reject: number } => {
    const rows = database.prepare(
      `SELECT rd.decision,count(*) count
       FROM paper_executions e
       JOIN risk_decisions rd ON rd.risk_decision_id=e.risk_decision_id
       JOIN signals s ON s.signal_id=e.signal_id
       WHERE e.paper_account_id=? AND s.signal_type=?
         AND e.created_at>=? AND e.created_at<=?
       GROUP BY rd.decision`,
    ).all(paperAccountId, signalType, startAt, windowEndAt) as unknown as Array<{ decision: string; count: number }>;
    return {
      allow: rows.find((row) => row.decision === "ALLOW")?.count ?? 0,
      reject: rows.find((row) => row.decision === "REJECT")?.count ?? 0,
    };
  };
  const buyRisks = risksForSignalType("TARGET_BUY");
  const sellRisks = risksForSignalType("TARGET_SELL");
  const buyExecutions = executionByType("TARGET_BUY");
  const sellExecutions = executionByType("TARGET_SELL");

  const capitalCounts = { high: 0, medium: 0, low: 0, unknown: 0 };
  for (const signal of buySignals) {
    if (signal.capital_confidence === "HIGH") capitalCounts.high += 1;
    else if (signal.capital_confidence === "MEDIUM") capitalCounts.medium += 1;
    else if (signal.capital_confidence === "LOW") capitalCounts.low += 1;
    else capitalCounts.unknown += 1;
  }
  const sizingEvidence = riskRows.flatMap((row) => {
    if (!row.capital_sizing_decision_json || !row.capital_sizing_decision_hash) return [];
    try {
      const value = JSON.parse(row.capital_sizing_decision_json) as Record<string, unknown>;
      return [{
        calculationVersion: String(value.calculationVersion ?? "UNKNOWN"),
        accountCapitalMicros: String(value.accountCapitalMicros ?? "UNKNOWN"),
        targetTradeAmountMicros: typeof value.targetTradeAmountMicros === "string" ? value.targetTradeAmountMicros : null,
        targetVisibleCapitalMicros: typeof value.targetVisibleCapitalMicros === "string" ? value.targetVisibleCapitalMicros : null,
        ratioExact: typeof value.ratioExact === "string" ? value.ratioExact : null,
        ratioDecimal: typeof value.ratioDecimal === "string" ? value.ratioDecimal : null,
        ratioPpmDecimal: typeof value.ratioPpmDecimal === "string" ? value.ratioPpmDecimal : null,
        calculatedAmountMicros: typeof value.calculatedAmountMicros === "string" ? value.calculatedAmountMicros : null,
        remainderNumerator: typeof value.remainderNumerator === "string" ? value.remainderNumerator : null,
        roundingMode: typeof value.roundingMode === "string" ? value.roundingMode : null,
        result: String(value.result ?? "UNKNOWN"),
        reason: typeof value.reason === "string" ? value.reason : null,
        evidenceHash: row.capital_sizing_decision_hash,
      }];
    } catch {
      return [];
    }
  });
  const sizingRejectReasons = grouped(sizingEvidence.filter((item) => item.result === "REJECTED").map((item) => item.reason));
  const executionRejectRows = executions.filter((row) => row.state === "REJECTED");
  const constraintRejectRows = constraintRows.filter((row) => row.check_result === "REJECT");

  return {
    signals: {
      buy: buySignals.length,
      sell: sellSignals.length,
      published: signals.filter((row) => row.status === "PUBLISHED").length,
      executionEligible: eligibleSignals.length,
      ineligible: ineligibleSignals.length,
      gap: gapSignals.length,
      unconsumedEligible: eligibleSignals.filter((row) => row.consumed === 0).length,
      ineligibleReasons: grouped(ineligibleSignals.map((row) => row.execution_block_reason)),
    },
    capital: {
      ...capitalCounts,
      sizingDecisionCount: sizingEvidence.length,
      sizingRejectReasons,
      sizingEvidence: sizingEvidence.slice(-20),
    },
    risk: {
      allow: riskAllow,
      reject: riskRejectRows.length,
      rejectReasons: grouped(riskRejectRows.map((row) => row.risk_reject_reason)),
    },
    execution: {
      total: executions.length,
      waiting: executionCount("WAITING_EXECUTION"),
      rejectedBeforeOrder: executionRejectRows.length,
      rejectedBeforeOrderReasons: grouped(executionRejectRows.map((row) => row.reason)),
      marketConstraintRejects: constraintRejectRows.length,
      marketConstraintRejectReasons: grouped(constraintRejectRows.map((row) => row.reason)),
      expired: executionCount("EXPIRED"),
      cancelled: executionCount("CANCELLED"),
      exitPending: executionCount("EXIT_PENDING"),
      stopExitPending: executionCount("STOP_EXIT_PENDING"),
      orders: orders.length,
      zeroFillOrders: orders.filter((row) => row.state === "NO_FILL").length,
      partialFillOrders: orders.filter((row) => row.state === "PARTIALLY_FILLED").length,
      fullFillOrders: orders.filter((row) => row.state === "FILLED").length,
      fills: fills.length,
    },
    positions: {
      total: positionStates.reduce((total, row) => total + row.count, 0),
      open: positionCount("OPEN"),
      partiallyClosed: positionCount("PARTIALLY_CLOSED"),
      frozen: positionCount("FROZEN"),
      settlementPending: positionCount("SETTLEMENT_PENDING"),
      closed: positionCount("CLOSED"),
      redeemed: positionCount("REDEEMED"),
    },
    reservations: {
      total: reservations.length,
      active: reservations.filter((row) => row.status === "ACTIVE").length,
      consumed: reservations.filter((row) => row.status === "CONSUMED").length,
      released: reservations.filter((row) => row.status === "RELEASED").length,
      activeMicros: sumIntegerRows(
        reservations.filter((row) => row.status === "ACTIVE").map((row) => ({ value: row.remaining_amount_micros })),
      ),
      releasedMicros: sumIntegerRows(releasedRows, true),
    },
    fees: { entries: feeRows.length, totalMicros: sumIntegerRows(feeRows) },
    pnl: {
      realizedEntries: pnlRows.filter((row) => row.pnl_type === "REALIZED").length,
      settlementEntries: pnlRows.filter((row) => row.pnl_type === "SETTLEMENT").length,
      realizedMicros: sumIntegerRows(pnlRows.map((row) => ({ value: row.pnl_micros }))),
      unrealizedMicros: latestPortfolio?.unrealized_pnl_micros ?? "0",
    },
    lifecycle: {
      stopLossExecutions: executionByType("STOP_LOSS").length,
      settlementExecutions: executionByType("SETTLEMENT").length,
      redeemedPositions: positionCount("REDEEMED"),
    },
    stage: {
      BUY: lifecycleStage({
        signalCount: buySignals.length,
        eligibleCount: buySignals.filter((row) => row.execution_eligible === 1).length,
        riskAllow: buyRisks.allow,
        riskReject: buyRisks.reject,
        waiting: buyExecutions.filter((row) => row.state === "WAITING_EXECUTION").length,
        rejected: buyExecutions.filter((row) => row.state === "REJECTED").length,
        orders: orderCount("BUY"),
        zeroFill: orderCount("BUY", "NO_FILL"),
        partialFill: orderCount("BUY", "PARTIALLY_FILLED"),
        fullFill: orderCount("BUY", "FILLED"),
      }),
      SELL: lifecycleStage({
        signalCount: sellSignals.length,
        eligibleCount: sellSignals.filter((row) => row.execution_eligible === 1).length,
        riskAllow: sellRisks.allow,
        riskReject: sellRisks.reject,
        waiting: sellExecutions.filter((row) => row.state === "WAITING_EXECUTION").length,
        rejected: sellExecutions.filter((row) => row.state === "REJECTED").length,
        orders: orderCount("SELL"),
        zeroFill: orderCount("SELL", "NO_FILL"),
        partialFill: orderCount("SELL", "PARTIALLY_FILLED"),
        fullFill: orderCount("SELL", "FILLED"),
      }),
    },
  };
}
