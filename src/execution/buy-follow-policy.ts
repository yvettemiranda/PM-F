import type { DatabaseSync } from "node:sqlite";
import { classifyTargetBuyRatio, type BuyAmountPolicyClass } from "./buy-amount-policy.js";

type BuyFollowMode = "PAPER" | "LIVE";

interface EventOrder {
  timestamp: number;
  key: string;
}

interface SignalEvidence {
  signalId: string;
  targetId: string;
  assetId: string;
  conditionId: string;
  event: EventOrder;
  policyClass: BuyAmountPolicyClass;
}

export interface BuyFollowPolicyDecision {
  policyClass: BuyAmountPolicyClass;
  allowed: boolean;
  reason: "ALLOW" | "SMALL_FOLLOW_BUY_LIMIT_REACHED" | "STOP_LOSS_REENTRY_BLOCKED";
  openingFillPresent: boolean;
  smallFollowFillCount: number;
  smallFollowBuyMaxCount: number;
  cycleBoundarySourceEventKey: string | null;
}

function compareEvent(left: EventOrder, right: EventOrder): number {
  return left.timestamp - right.timestamp || left.key.localeCompare(right.key);
}

function policyClassFromContext(
  exactJson: string | null,
  legacyRatioPpm: string | null,
  capitalConfidence: string | null,
): BuyAmountPolicyClass | null {
  if (exactJson) {
    try {
      const exact = JSON.parse(exactJson) as { ratioNumerator?: unknown; ratioDenominator?: unknown };
      if (typeof exact.ratioNumerator !== "string" || typeof exact.ratioDenominator !== "string") return null;
      return classifyTargetBuyRatio({
        ratioNumerator: exact.ratioNumerator,
        ratioDenominator: exact.ratioDenominator,
      });
    } catch {
      return null;
    }
  }
  return classifyTargetBuyRatio({
    legacyRatioPpm,
    fixedFallback: capitalConfidence === "MEDIUM",
  });
}

function signalEvidence(database: DatabaseSync, signalId: string): SignalEvidence {
  const row = database.prepare(
    `SELECT s.signal_id,s.target_id,s.asset_id,s.condition_id,
            r.source_timestamp,r.source_event_key,c.capital_sizing_ratio_json,
            c.target_trade_capital_ratio_ppm,ce.capital_confidence
     FROM signals s
     JOIN raw_events r ON r.source_event_key=s.source_event_key
     LEFT JOIN signal_execution_contexts c ON c.signal_id=s.signal_id
     LEFT JOIN capital_estimates ce ON ce.capital_estimate_id=c.capital_decision_id
     WHERE s.signal_id=? AND s.signal_type='TARGET_BUY'`,
  ).get(signalId) as {
    signal_id: string;
    target_id: string;
    asset_id: string;
    condition_id: string;
    source_timestamp: number;
    source_event_key: string;
    capital_sizing_ratio_json: string | null;
    target_trade_capital_ratio_ppm: string | null;
    capital_confidence: string | null;
  } | undefined;
  if (!row) throw new Error(`BUY_FOLLOW_SIGNAL_EVIDENCE_UNAVAILABLE:${signalId}`);
  const policyClass = policyClassFromContext(
    row.capital_sizing_ratio_json,
    row.target_trade_capital_ratio_ppm,
    row.capital_confidence,
  );
  if (!policyClass) throw new Error(`BUY_FOLLOW_RATIO_EVIDENCE_UNAVAILABLE:${signalId}`);
  return {
    signalId: row.signal_id,
    targetId: row.target_id,
    assetId: row.asset_id,
    conditionId: row.condition_id.toLowerCase(),
    event: { timestamp: row.source_timestamp, key: row.source_event_key },
    policyClass,
  };
}

function latestFullExit(database: DatabaseSync, signal: SignalEvidence): EventOrder | null {
  const candidates: EventOrder[] = [];
  const sells = database.prepare(
    `SELECT r.source_timestamp,r.source_event_key,s.sell_ratio_numerator,s.sell_ratio_denominator
     FROM signals s JOIN raw_events r ON r.source_event_key=s.source_event_key
     WHERE s.target_id=? AND s.asset_id=?
       AND s.signal_type='TARGET_SELL'`,
  ).all(signal.targetId, signal.assetId) as Array<{
    source_timestamp: number;
    source_event_key: string;
    sell_ratio_numerator: string | null;
    sell_ratio_denominator: string | null;
  }>;
  for (const row of sells) {
    if (row.sell_ratio_numerator === null || row.sell_ratio_denominator === null) continue;
    let full = false;
    try {
      const numerator = BigInt(row.sell_ratio_numerator);
      const denominator = BigInt(row.sell_ratio_denominator);
      full = denominator > 0n && numerator === denominator;
    } catch {
      full = false;
    }
    const event = { timestamp: row.source_timestamp, key: row.source_event_key };
    if (full && compareEvent(event, signal.event) < 0) candidates.push(event);
  }
  const activities = database.prepare(
    `SELECT r.source_timestamp,r.source_event_key,r.raw_json
     FROM observe_events o JOIN raw_events r ON r.source_event_key=o.source_event_key
     WHERE r.target_id=? AND r.condition_id=?
       AND r.source_type='DATA_API_ACTIVITY'`,
  ).all(signal.targetId, signal.conditionId) as Array<{
    source_timestamp: number;
    source_event_key: string;
    raw_json: string;
  }>;
  for (const row of activities) {
    try {
      const activity = JSON.parse(row.raw_json) as { type?: unknown };
      const event = { timestamp: row.source_timestamp, key: row.source_event_key };
      if (activity.type === "REDEEM" && compareEvent(event, signal.event) < 0) candidates.push(event);
    } catch {
      // Malformed activity evidence cannot create a cycle reset.
    }
  }
  return candidates.sort(compareEvent).at(-1) ?? null;
}

function eventAtOrBeforeBoundary(event: EventOrder | null, boundary: EventOrder): boolean {
  return event === null || compareEvent(event, boundary) <= 0;
}

function hasOldObligations(
  database: DatabaseSync,
  mode: BuyFollowMode,
  accountId: string,
  assetId: string,
  boundary: EventOrder,
): boolean {
  const paper = mode === "PAPER";
  const positions = database.prepare(
    `SELECT r.source_timestamp,r.source_event_key,p.current_size_micros
     FROM ${paper ? "paper_positions" : "live_positions"} p
     JOIN ${paper ? "paper_executions" : "live_executions"} e
       ON e.${paper ? "paper_execution_id" : "live_execution_id"}=p.opening_execution_id
     LEFT JOIN signals s ON s.signal_id=e.signal_id
     LEFT JOIN raw_events r ON r.source_event_key=s.source_event_key
     WHERE p.${paper ? "paper_account_id" : "live_account_id"}=? AND p.asset_id=?`,
  ).all(accountId, assetId) as Array<{
    source_timestamp: number | null;
    source_event_key: string | null;
    current_size_micros: string;
  }>;
  if (positions.some((row) => {
    if (BigInt(row.current_size_micros) <= 0n) return false;
    const event = row.source_timestamp === null || row.source_event_key === null
      ? null
      : { timestamp: row.source_timestamp, key: row.source_event_key };
    return eventAtOrBeforeBoundary(event, boundary);
  })) return true;

  const pending = database.prepare(
    `SELECT r.source_timestamp,r.source_event_key
     FROM ${paper ? "paper_executions" : "live_executions"} e
     LEFT JOIN signals s ON s.signal_id=e.signal_id
     LEFT JOIN raw_events r ON r.source_event_key=s.source_event_key
     WHERE e.${paper ? "paper_account_id" : "live_account_id"}=? AND e.asset_id=?
       AND e.state IN (${paper
    ? "'WAITING_EXECUTION','EXIT_PENDING','STOP_EXIT_PENDING'"
    : "'WAITING_EXECUTION','EXIT_PENDING','STOP_EXIT_PENDING','FROZEN'"})`,
  ).all(accountId, assetId) as Array<{
    source_timestamp: number | null;
    source_event_key: string | null;
  }>;
  if (pending.some((row) => eventAtOrBeforeBoundary(
    row.source_timestamp === null || row.source_event_key === null
      ? null
      : { timestamp: row.source_timestamp, key: row.source_event_key },
    boundary,
  ))) return true;

  if (paper) return false;
  const liveOrders = database.prepare(
    `SELECT r.source_timestamp,r.source_event_key
     FROM live_orders o
     JOIN live_executions e ON e.live_execution_id=o.live_execution_id
     LEFT JOIN signals s ON s.signal_id=e.signal_id
     LEFT JOIN raw_events r ON r.source_event_key=s.source_event_key
     WHERE e.live_account_id=? AND e.asset_id=?
       AND o.status IN ('CREATED','SUBMITTED','ACKNOWLEDGED','PARTIALLY_FILLED','CANCEL_PENDING')`,
  ).all(accountId, assetId) as Array<{
    source_timestamp: number | null;
    source_event_key: string | null;
  }>;
  return liveOrders.some((row) => eventAtOrBeforeBoundary(
    row.source_timestamp === null || row.source_event_key === null
      ? null
      : { timestamp: row.source_timestamp, key: row.source_event_key },
    boundary,
  ));
}

function filledBuys(
  database: DatabaseSync,
  mode: BuyFollowMode,
  accountId: string,
  assetId: string,
  boundary: EventOrder | null,
): Array<{ event: EventOrder; policyClass: BuyAmountPolicyClass }> {
  const paper = mode === "PAPER";
  const rows = database.prepare(
    `SELECT e.filled_size_micros,r.source_timestamp,r.source_event_key,
            c.capital_sizing_ratio_json,c.target_trade_capital_ratio_ppm,ce.capital_confidence
     FROM ${paper ? "paper_executions" : "live_executions"} e
     JOIN signals s ON s.signal_id=e.signal_id
     JOIN raw_events r ON r.source_event_key=s.source_event_key
     LEFT JOIN signal_execution_contexts c ON c.signal_id=s.signal_id
     LEFT JOIN capital_estimates ce ON ce.capital_estimate_id=c.capital_decision_id
     WHERE e.${paper ? "paper_account_id" : "live_account_id"}=? AND e.asset_id=?
       AND e.execution_type='TARGET_BUY'`,
  ).all(accountId, assetId) as Array<{
    filled_size_micros: string;
    source_timestamp: number;
    source_event_key: string;
    capital_sizing_ratio_json: string | null;
    target_trade_capital_ratio_ppm: string | null;
    capital_confidence: string | null;
  }>;
  return rows.flatMap((row) => {
    if (BigInt(row.filled_size_micros) <= 0n) return [];
    const event = { timestamp: row.source_timestamp, key: row.source_event_key };
    if (boundary && compareEvent(event, boundary) <= 0) return [];
    const policyClass = policyClassFromContext(
      row.capital_sizing_ratio_json,
      row.target_trade_capital_ratio_ppm,
      row.capital_confidence,
    );
    return policyClass ? [{ event, policyClass }] : [];
  }).sort((left, right) => compareEvent(left.event, right.event));
}

function stopLossTriggered(
  database: DatabaseSync,
  mode: BuyFollowMode,
  accountId: string,
  assetId: string,
  boundary: EventOrder | null,
): boolean {
  const paper = mode === "PAPER";
  const rows = database.prepare(
    `SELECT e.${paper ? "paper_execution_id" : "live_execution_id"} execution_id,
            e.created_at,r.source_timestamp,r.source_event_key
     FROM ${paper ? "paper_executions" : "live_executions"} e
     LEFT JOIN signals s ON s.signal_id=e.signal_id
     LEFT JOIN raw_events r ON r.source_event_key=s.source_event_key
     WHERE e.${paper ? "paper_account_id" : "live_account_id"}=? AND e.asset_id=?
       AND e.execution_type='STOP_LOSS'`,
  ).all(accountId, assetId) as Array<{
    execution_id: string;
    created_at: string;
    source_timestamp: number | null;
    source_event_key: string | null;
  }>;
  return rows.some((row) => {
    if (!boundary) return true;
    const event = row.source_timestamp === null || row.source_event_key === null
      ? {
        timestamp: Math.floor(Date.parse(row.created_at) / 1_000),
        key: `STOP_LOSS:${row.execution_id}`,
      }
      : { timestamp: row.source_timestamp, key: row.source_event_key };
    if (!Number.isFinite(event.timestamp)) return true;
    return compareEvent(event, boundary) > 0;
  });
}

export function evaluateBuyFollowPolicy(input: {
  database: DatabaseSync;
  mode: BuyFollowMode;
  accountId: string;
  signalId: string;
  smallFollowBuyMaxCount: number;
}): BuyFollowPolicyDecision {
  if (!Number.isSafeInteger(input.smallFollowBuyMaxCount) || input.smallFollowBuyMaxCount < 0) {
    throw new Error("SMALL_FOLLOW_BUY_MAX_COUNT_INVALID");
  }
  const signal = signalEvidence(input.database, input.signalId);
  const candidateBoundary = latestFullExit(input.database, signal);
  const boundary = candidateBoundary && !hasOldObligations(
    input.database,
    input.mode,
    input.accountId,
    signal.assetId,
    candidateBoundary,
  ) ? candidateBoundary : null;
  const fills = filledBuys(input.database, input.mode, input.accountId, signal.assetId, boundary);
  const openingFillPresent = fills.length > 0;
  const smallFollowFillCount = fills.slice(1)
    .filter((fill) => fill.policyClass === "SMALL_BUY").length;
  const stopLocked = stopLossTriggered(
    input.database,
    input.mode,
    input.accountId,
    signal.assetId,
    boundary,
  );
  const reason = stopLocked
    ? "STOP_LOSS_REENTRY_BLOCKED"
    : signal.policyClass === "SMALL_BUY"
      && openingFillPresent
      && smallFollowFillCount >= input.smallFollowBuyMaxCount
      ? "SMALL_FOLLOW_BUY_LIMIT_REACHED"
      : "ALLOW";
  return {
    policyClass: signal.policyClass,
    allowed: reason === "ALLOW",
    reason,
    openingFillPresent,
    smallFollowFillCount,
    smallFollowBuyMaxCount: input.smallFollowBuyMaxCount,
    cycleBoundarySourceEventKey: boundary?.key ?? null,
  };
}
