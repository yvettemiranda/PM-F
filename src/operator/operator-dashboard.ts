import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { operatorControlSnapshot, type OperatorControlSnapshot } from "./operator-control.js";
import {
  OPERATOR_ACTIVE_LOCK,
  OPERATOR_DATABASE_FILE,
} from "./operator-mutation-guard.js";
import {
  liveProductionReadiness,
  type LiveProductionReadiness,
} from "./live-production-readiness.js";

const MONEY_SCALE_DIGITS = 6;
const PRICE_SCALE_DIGITS = 18;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

type Row = Record<string, unknown>;

export interface NumericView {
  raw: string;
  display: string;
}

export interface MoneyView {
  micros: string;
  display: string;
  currency: "pUSD";
}

export interface OperatorDashboardSnapshot {
  schemaVersion: "operator-dashboard-v1";
  generatedAt: string;
  database: {
    status: "AVAILABLE" | "NOT_INITIALIZED" | "ERROR";
    path: string;
    error: string | null;
  };
  control: OperatorControlSnapshot;
  targetRuntime: null | {
    targetId: string;
    walletAddress: string;
    identityStatus: string;
    runtimeMode: string;
    syncStatus: string;
    updatedAt: string;
  };
  runtime: {
    state: "RUNNING" | "STOPPED" | "RECOVERY_REQUIRED";
    operatorLocked: boolean;
    observe: Row | null;
    latestPoll: Row | null;
    campaign: Row | null;
    reconciliation: {
      latestReport: Row | null;
      openIssues: Row[];
    };
    logs: Array<{
      name: string;
      updatedAt: string;
      sizeBytes: number;
    }>;
    reports: Array<{
      name: string;
      path: string;
      updatedAt: string;
      sizeBytes: number;
    }>;
  };
  paper: {
    account: null | {
      accountId: string;
      name: string;
      status: string;
      initialBalance: MoneyView;
      cash: MoneyView;
      reserved: MoneyView;
      realizedPnl: MoneyView;
      updatedAt: string;
    };
    portfolio: null | {
      projectionId: string;
      cashBalance: MoneyView;
      reservedBalance: MoneyView;
      availableBalance: MoneyView;
      positionValue: MoneyView;
      realizedPnl: MoneyView;
      unrealizedPnl: MoneyView;
      totalEquity: MoneyView;
      valuationStatus: string;
      unpricedPositionCount: number;
      priceSource: string | null;
      priceTimestamp: string | null;
      createdAt: string;
    };
    executions: Row[];
    orders: Row[];
    fills: Row[];
    positions: Row[];
    ledger: {
      cash: Row[];
      fees: Row[];
      pnl: Row[];
    };
  };
  live: {
    capability: {
      activation: "LIVE_GATE" | "GATE_AVAILABLE_AFTER_DATABASE_INITIALIZATION";
      execution: "AVAILABLE" | "PENDING_PREREQUISITES" | "NOT_CONFIGURED";
      orderManagement: "AVAILABLE" | "PENDING_PREREQUISITES" | "NOT_CONFIGURED";
      externalDependencies: readonly string[];
    };
    production: LiveProductionReadiness;
    gate: null | {
      executionMode: string;
      state: string;
      requestedExecutionMode: string | null;
      lastPreflightId: string | null;
      reason: string;
      updatedAt: string;
    };
    prerequisites: Array<{
      key: string;
      status: string;
      evidence: unknown;
      updatedAt: string;
    }>;
    gateRuns: Row[];
    accounts: Row[];
    executions: Row[];
    orders: Row[];
    attempts: Row[];
    fills: Row[];
    positions: Row[];
    ledger: {
      cash: Row[];
      fees: Row[];
      pnl: Row[];
    };
    reconciliation: Row[];
    recovery: Row[];
    quarantines: Row[];
    valuations: Row[];
    audit: Row[];
  };
  signals: Row[];
  markets: Row[];
  riskDecisions: Row[];
  comparisons: ComparisonEvent[];
}

export interface ComparisonEvent {
  signalId: string;
  occurredAt: string;
  action: "BUY" | "SELL" | "OTHER";
  outcome: string;
  eventClassification: string;
  market: {
    question: string;
    slug: string | null;
    conditionId: string;
    assetId: string;
    endTime: string | null;
    endTimeStatus: string | null;
  };
  target: {
    price: NumericView;
    size: NumericView;
    amount: MoneyView | null;
    capitalRatio: NumericView | null;
    sellRatio: NumericView | null;
    signalStatus: string;
    executionEligible: boolean;
    reason: string;
  };
  mine: {
    mode: "PAPER";
    decision: "FOLLOWED" | "WAITING" | "RISK_REJECTED" | "SKIPPED" | "NOT_PROCESSED";
    riskDecision: string | null;
    riskReason: string | null;
    executionId: string | null;
    executionState: string | null;
    averagePrice: NumericView | null;
    amount: MoneyView | null;
    requestedAmount: MoneyView | null;
    fee: MoneyView | null;
    positionStatus: string | null;
    realizedPnl: MoneyView | null;
    reason: string;
  };
}

export interface OperatorDashboardOptions {
  now?: () => Date;
  limit?: number;
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function integerValue(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : 0;
}

function safeBigInt(value: unknown): bigint {
  if (typeof value !== "string" || !/^-?\d+$/.test(value)) return 0n;
  return BigInt(value);
}

function formatScaled(value: bigint, scaleDigits: number, fractionDigits: number): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const scale = 10n ** BigInt(scaleDigits);
  const fractionScale = 10n ** BigInt(fractionDigits);
  const rounded = (absolute * fractionScale + scale / 2n) / scale;
  const integer = rounded / fractionScale;
  const fraction = rounded % fractionScale;
  const grouped = integer.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const suffix = fractionDigits === 0
    ? ""
    : `.${fraction.toString().padStart(fractionDigits, "0")}`;
  return `${negative ? "-" : ""}${grouped}${suffix}`;
}

function money(value: unknown): MoneyView {
  const micros = safeBigInt(value);
  return {
    micros: micros.toString(),
    display: formatScaled(micros, MONEY_SCALE_DIGITS, 2),
    currency: "pUSD",
  };
}

function price(value: unknown): NumericView {
  const raw = safeBigInt(value);
  return {
    raw: raw.toString(),
    display: formatScaled(raw, PRICE_SCALE_DIGITS, 3),
  };
}

function size(value: unknown): NumericView {
  const raw = safeBigInt(value);
  return {
    raw: raw.toString(),
    display: formatScaled(raw, MONEY_SCALE_DIGITS, 2),
  };
}

function ppmPercent(value: unknown): NumericView | null {
  if (value === null || value === undefined) return null;
  const raw = safeBigInt(value);
  return {
    raw: raw.toString(),
    display: `${formatScaled(raw, 4, 2)}%`,
  };
}

function ratioPercent(numerator: unknown, denominator: unknown): NumericView | null {
  const top = safeBigInt(numerator);
  const bottom = safeBigInt(denominator);
  if (bottom <= 0n) return null;
  const ppm = (top * 1_000_000n) / bottom;
  return {
    raw: `${top}/${bottom}`,
    display: `${formatScaled(ppm, 4, 2)}%`,
  };
}

function tableExists(database: DatabaseSync, table: string): boolean {
  return database.prepare(
    "SELECT 1 ok FROM sqlite_master WHERE type='table' AND name=?",
  ).get(table) !== undefined;
}

function columnExists(database: DatabaseSync, table: string, column: string): boolean {
  if (!tableExists(database, table)) return false;
  const rows = database.prepare(`PRAGMA table_info(${table})`).all() as unknown as Row[];
  return rows.some((row) => row.name === column);
}

function all(
  database: DatabaseSync,
  table: string,
  sql: string,
  parameters: readonly SQLInputValue[] = [],
): Row[] {
  if (!tableExists(database, table)) return [];
  return database.prepare(sql).all(...parameters) as unknown as Row[];
}

function first(
  database: DatabaseSync,
  table: string,
  sql: string,
  parameters: readonly SQLInputValue[] = [],
): Row | null {
  if (!tableExists(database, table)) return null;
  return (database.prepare(sql).get(...parameters) as Row | undefined) ?? null;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    return { parseError: "INVALID_JSON" };
  }
}

function metadata(value: unknown): {
  question: string;
  marketSlug: string | null;
  tokens: Array<{ token_id?: unknown; outcome?: unknown }>;
} {
  const parsed = parseJson(value);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { question: "未知市场", marketSlug: null, tokens: [] };
  }
  const record = parsed as Record<string, unknown>;
  return {
    question: stringValue(record.question, "未知市场"),
    marketSlug: nullableString(record.marketSlug),
    tokens: Array.isArray(record.tokens)
      ? record.tokens.filter((token): token is { token_id?: unknown; outcome?: unknown } => (
        typeof token === "object" && token !== null && !Array.isArray(token)
      ))
      : [],
  };
}

function marketOutcome(
  snapshot: unknown,
  assetId: string,
  fallback: unknown,
): string {
  const data = metadata(snapshot);
  const token = data.tokens.find((candidate) => candidate.token_id === assetId);
  const value = typeof token?.outcome === "string"
    ? token.outcome
    : typeof fallback === "string"
      ? fallback
      : "UNKNOWN";
  return value.toUpperCase();
}

function decorateRows(rows: Row[], fields: {
  money?: readonly string[];
  price?: readonly string[];
  size?: readonly string[];
  json?: readonly string[];
}): Row[] {
  return rows.map((row) => {
    const result: Row = { ...row };
    for (const key of fields.money ?? []) {
      if (row[key] !== null && row[key] !== undefined) result[`${key}_view`] = money(row[key]);
    }
    for (const key of fields.price ?? []) {
      if (row[key] !== null && row[key] !== undefined) result[`${key}_view`] = price(row[key]);
    }
    for (const key of fields.size ?? []) {
      if (row[key] !== null && row[key] !== undefined) result[`${key}_view`] = size(row[key]);
    }
    for (const key of fields.json ?? []) {
      result[`${key}_value`] = parseJson(row[key]);
    }
    return result;
  });
}

function latestFiles(
  directory: string,
  options: { suffix?: string; limit: number },
): Array<{ name: string; path: string; updatedAt: string; sizeBytes: number }> {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && (options.suffix === undefined || entry.name.endsWith(options.suffix)))
    .map((entry) => {
      const path = join(directory, entry.name);
      const stats = statSync(path);
      return {
        name: basename(path),
        path,
        updatedAt: stats.mtime.toISOString(),
        sizeBytes: stats.size,
      };
    })
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, options.limit);
}

function normalizeObserve(row: Row | null): Row | null {
  if (row === null) return null;
  return {
    observeRunId: row.observe_run_id,
    state: row.state,
    recoveredFromCheckpoint: row.recovered_from_checkpoint === 1,
    startedAt: row.started_at,
    lastHeartbeatAt: row.last_heartbeat_at,
    stoppedAt: row.stopped_at,
    stopReason: row.stop_reason,
    successfulPolls: row.successful_polls,
    failedPolls: row.failed_polls,
    processedEvents: row.processed_events,
    emittedSignals: row.emitted_signals,
    gapEvents: row.gap_events,
    reconciliationCount: row.reconciliation_count,
    campaignId: row.campaign_id,
    campaignSessionId: row.campaign_session_id,
  };
}

function normalizePoll(row: Row | null): Row | null {
  if (row === null) return null;
  return {
    pollId: row.poll_id,
    sequence: row.sequence,
    status: row.status,
    completedAt: row.completed_at,
    tradesReceived: row.trades_received,
    activityReceived: row.activity_received,
    positionsReceived: row.positions_received,
    newEvents: row.new_events,
    signalsEmitted: row.signals_emitted,
    gapEvents: row.gap_events,
    reconciliationCount: row.reconciliation_count,
    signalEnrichmentFailures: row.signal_enrichment_failures,
    error: row.error_detail,
    warning: row.warning_detail,
  };
}

function comparisonDecision(row: Row): ComparisonEvent["mine"]["decision"] {
  if (row.risk_decision === "REJECT") return "RISK_REJECTED";
  const state = nullableString(row.execution_state);
  if (state === null) return "NOT_PROCESSED";
  if (state === "WAITING_EXECUTION" || state === "PARTIALLY_EXECUTED"
    || state === "EXIT_PENDING" || state === "STOP_EXIT_PENDING") return "WAITING";
  if (safeBigInt(row.filled_size_micros) > 0n) return "FOLLOWED";
  return "SKIPPED";
}

function comparisons(
  database: DatabaseSync,
  targetId: string,
  accountId: string | null,
  limit: number,
): ComparisonEvent[] {
  if (!tableExists(database, "signals")) return [];
  const hasContexts = tableExists(database, "signal_execution_contexts");
  const hasRisk = tableExists(database, "risk_decisions");
  const hasExecutions = tableExists(database, "paper_executions");
  const hasOrders = tableExists(database, "paper_orders");
  const hasPositions = tableExists(database, "paper_positions");
  const rows = database.prepare(
    `SELECT
       s.signal_id,s.signal_type,s.status signal_status,s.asset_id,s.condition_id,
       s.target_price_units,s.target_size_micros,s.sell_ratio_numerator,s.sell_ratio_denominator,
       s.reason signal_reason,s.execution_eligible,s.event_classification,s.created_at,
       ${hasContexts ? "c.target_trade_capital_ratio_ppm,c.target_trade_timestamp,c.market_end_time,c.market_metadata_snapshot_json,c.market_end_time_status,c.execution_deadline_at" : "NULL target_trade_capital_ratio_ppm,NULL target_trade_timestamp,NULL market_end_time,NULL market_metadata_snapshot_json,NULL market_end_time_status,NULL execution_deadline_at"},
       ${hasRisk ? "r.risk_decision_id,r.decision risk_decision,coalesce(r.risk_reason,r.risk_reject_reason) risk_reason,r.requested_amount_micros risk_requested_amount_micros" : "NULL risk_decision_id,NULL risk_decision,NULL risk_reason,NULL risk_requested_amount_micros"},
       ${hasExecutions ? "e.paper_execution_id,e.state execution_state,e.filled_size_micros,e.filled_notional_micros,e.fee_micros,e.requested_amount_micros,e.reason execution_reason" : "NULL paper_execution_id,NULL execution_state,NULL filled_size_micros,NULL filled_notional_micros,NULL fee_micros,NULL requested_amount_micros,NULL execution_reason"},
       ${hasOrders ? "(SELECT o.vwap_price_units FROM paper_orders o WHERE o.paper_execution_id=e.paper_execution_id AND o.vwap_price_units IS NOT NULL ORDER BY o.created_at DESC,o.paper_order_id DESC LIMIT 1) average_price_units" : "NULL average_price_units"},
       ${hasPositions ? "(SELECT p.status FROM paper_positions p WHERE p.signal_id=s.signal_id AND p.paper_account_id=? ORDER BY p.updated_at DESC,p.paper_position_id DESC LIMIT 1) position_status,(SELECT p.realized_pnl_micros FROM paper_positions p WHERE p.signal_id=s.signal_id AND p.paper_account_id=? ORDER BY p.updated_at DESC,p.paper_position_id DESC LIMIT 1) position_realized_pnl_micros,(SELECT p.outcome FROM paper_positions p WHERE p.signal_id=s.signal_id AND p.paper_account_id=? ORDER BY p.updated_at DESC,p.paper_position_id DESC LIMIT 1) position_outcome" : "NULL position_status,NULL position_realized_pnl_micros,NULL position_outcome"}
     FROM signals s
     ${hasContexts ? "LEFT JOIN signal_execution_contexts c ON c.signal_id=s.signal_id" : ""}
     ${hasRisk ? "LEFT JOIN risk_decisions r ON r.risk_decision_id=(SELECT r2.risk_decision_id FROM risk_decisions r2 WHERE r2.signal_id=s.signal_id AND r2.executor_mode='PAPER' ORDER BY r2.created_at DESC,r2.risk_decision_id DESC LIMIT 1)" : ""}
     ${hasExecutions ? "LEFT JOIN paper_executions e ON e.paper_execution_id=(SELECT e2.paper_execution_id FROM paper_executions e2 WHERE e2.signal_id=s.signal_id AND e2.paper_account_id=? ORDER BY e2.created_at DESC,e2.paper_execution_id DESC LIMIT 1)" : ""}
     WHERE s.target_id=?
     ORDER BY s.created_at DESC,s.signal_id DESC
     LIMIT ?`,
  ).all(
    ...(hasPositions ? [accountId ?? "", accountId ?? "", accountId ?? ""] : []),
    ...(hasExecutions ? [accountId ?? ""] : []),
    targetId,
    limit,
  ) as unknown as Row[];
  return rows.map((row) => {
    const signalType = stringValue(row.signal_type);
    const action: ComparisonEvent["action"] = signalType.includes("BUY")
      ? "BUY"
      : signalType.includes("SELL")
        ? "SELL"
        : "OTHER";
    const targetPrice = safeBigInt(row.target_price_units);
    const targetSize = safeBigInt(row.target_size_micros);
    const targetNotional = action === "BUY"
      ? (targetPrice * targetSize) / 10n ** BigInt(PRICE_SCALE_DIGITS)
      : null;
    const market = metadata(row.market_metadata_snapshot_json);
    const averagePrice = row.average_price_units === null || row.average_price_units === undefined
      ? null
      : price(row.average_price_units);
    const filledNotional = row.filled_notional_micros === null || row.filled_notional_micros === undefined
      ? null
      : money(row.filled_notional_micros);
    const decision = comparisonDecision(row);
    const riskReason = nullableString(row.risk_reason);
    const executionReason = nullableString(row.execution_reason);
    return {
      signalId: stringValue(row.signal_id),
      occurredAt: stringValue(row.target_trade_timestamp, stringValue(row.created_at)),
      action,
      outcome: marketOutcome(
        row.market_metadata_snapshot_json,
        stringValue(row.asset_id),
        row.position_outcome,
      ),
      eventClassification: stringValue(row.event_classification),
      market: {
        question: market.question,
        slug: market.marketSlug,
        conditionId: stringValue(row.condition_id),
        assetId: stringValue(row.asset_id),
        endTime: nullableString(row.market_end_time),
        endTimeStatus: nullableString(row.market_end_time_status),
      },
      target: {
        price: price(row.target_price_units),
        size: size(row.target_size_micros),
        amount: targetNotional === null ? null : money(targetNotional.toString()),
        capitalRatio: ppmPercent(row.target_trade_capital_ratio_ppm),
        sellRatio: ratioPercent(row.sell_ratio_numerator, row.sell_ratio_denominator),
        signalStatus: stringValue(row.signal_status),
        executionEligible: row.execution_eligible === 1,
        reason: stringValue(row.signal_reason),
      },
      mine: {
        mode: "PAPER",
        decision,
        riskDecision: nullableString(row.risk_decision),
        riskReason,
        executionId: nullableString(row.paper_execution_id),
        executionState: nullableString(row.execution_state),
        averagePrice,
        amount: filledNotional,
        requestedAmount: row.risk_requested_amount_micros === null
          || row.risk_requested_amount_micros === undefined
          ? row.requested_amount_micros === null || row.requested_amount_micros === undefined
            ? null
            : money(row.requested_amount_micros)
          : money(row.risk_requested_amount_micros),
        fee: row.fee_micros === null || row.fee_micros === undefined ? null : money(row.fee_micros),
        positionStatus: nullableString(row.position_status),
        realizedPnl: row.position_realized_pnl_micros === null
          || row.position_realized_pnl_micros === undefined
          ? null
          : money(row.position_realized_pnl_micros),
        reason: executionReason ?? riskReason ?? (
          decision === "NOT_PROCESSED" ? "尚未进入 Paper 执行链路" : stringValue(row.signal_reason)
        ),
      },
    };
  });
}

function emptySnapshot(
  projectRoot: string,
  generatedAt: string,
  control: OperatorControlSnapshot,
): OperatorDashboardSnapshot {
  return {
    schemaVersion: "operator-dashboard-v1",
    generatedAt,
    database: {
      status: "NOT_INITIALIZED",
      path: resolve(projectRoot, OPERATOR_DATABASE_FILE),
      error: null,
    },
    control,
    targetRuntime: null,
    runtime: {
      state: "STOPPED",
      operatorLocked: control.runtime.operatorLocked,
      observe: null,
      latestPoll: null,
      campaign: null,
      reconciliation: { latestReport: null, openIssues: [] },
      logs: [],
      reports: [],
    },
    paper: {
      account: null,
      portfolio: null,
      executions: [],
      orders: [],
      fills: [],
      positions: [],
      ledger: { cash: [], fees: [], pnl: [] },
    },
    live: {
      capability: {
        activation: "GATE_AVAILABLE_AFTER_DATABASE_INITIALIZATION",
        execution: "PENDING_PREREQUISITES",
        orderManagement: "PENDING_PREREQUISITES",
        externalDependencies: [
          "LIVE_READONLY_BALANCE_PROVIDER",
          "COMPLIANCE_POLICY",
          "GEOBLOCK_PROVIDER",
          "CLOCK_SAFETY_PROVIDER",
          "AUTHORIZED_SIGNER",
          "AUTHENTICATED_CLOB_ADAPTER",
          "USER_EXPLICIT_AUTHORIZATION",
        ],
      },
      production: liveProductionReadiness(projectRoot, {
        databaseAvailable: false,
        gatePrerequisites: [],
        executionCapability: "PENDING_PREREQUISITES",
      }, () => new Date(generatedAt)),
      gate: null,
      prerequisites: [],
      gateRuns: [],
      accounts: [],
      executions: [],
      orders: [],
      attempts: [],
      fills: [],
      positions: [],
      ledger: { cash: [], fees: [], pnl: [] },
      reconciliation: [],
      recovery: [],
      quarantines: [],
      valuations: [],
      audit: [],
    },
    signals: [],
    markets: [],
    riskDecisions: [],
    comparisons: [],
  };
}

export function operatorDashboardSnapshot(
  projectRoot: string,
  options: OperatorDashboardOptions = {},
): OperatorDashboardSnapshot {
  const generatedAt = (options.now ?? (() => new Date()))().toISOString();
  const limit = Math.max(1, Math.min(MAX_LIMIT, options.limit ?? DEFAULT_LIMIT));
  const control = operatorControlSnapshot(projectRoot);
  const snapshot = emptySnapshot(projectRoot, generatedAt, control);
  const databasePath = resolve(projectRoot, OPERATOR_DATABASE_FILE);
  if (!existsSync(databasePath)) return snapshot;

  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    database.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=5000;");
    snapshot.database.status = "AVAILABLE";
    const targetRow = first(
      database,
      "monitor_targets",
      `SELECT target_id,wallet_address,identity_status,runtime_mode,sync_status,updated_at
       FROM monitor_targets WHERE lower(wallet_address)=?
       ORDER BY updated_at DESC,target_id DESC LIMIT 1`,
      [control.target.walletAddress],
    );
    const targetId = nullableString(targetRow?.target_id);
    if (targetRow !== null && targetId !== null) {
      snapshot.targetRuntime = {
        targetId,
        walletAddress: stringValue(targetRow.wallet_address),
        identityStatus: stringValue(targetRow.identity_status),
        runtimeMode: stringValue(targetRow.runtime_mode),
        syncStatus: stringValue(targetRow.sync_status),
        updatedAt: stringValue(targetRow.updated_at),
      };
    }

    const observeRow = targetId === null ? null : first(
      database,
      "observe_runs",
      `SELECT observe_run_id,state,recovered_from_checkpoint,started_at,last_heartbeat_at,
              stopped_at,stop_reason,successful_polls,failed_polls,processed_events,
              emitted_signals,gap_events,reconciliation_count,campaign_id,campaign_session_id
       FROM observe_runs WHERE target_id=?
       ORDER BY started_at DESC,observe_run_id DESC LIMIT 1`,
      [targetId],
    );
    const observeId = nullableString(observeRow?.observe_run_id);
    const pollRow = observeId === null ? null : first(
      database,
      "observe_polls",
      `SELECT poll_id,sequence,status,completed_at,trades_received,activity_received,
              positions_received,new_events,signals_emitted,gap_events,reconciliation_count,
              signal_enrichment_failures,error_detail,warning_detail
       FROM observe_polls WHERE observe_run_id=?
       ORDER BY sequence DESC,poll_id DESC LIMIT 1`,
      [observeId],
    );
    snapshot.runtime.observe = normalizeObserve(observeRow);
    snapshot.runtime.latestPoll = normalizePoll(pollRow);

    if (targetId !== null && tableExists(database, "paper_validation_campaigns")) {
      const transitionAvailable = tableExists(database, "paper_validation_transitions");
      snapshot.runtime.campaign = first(
        database,
        "paper_validation_campaigns",
        `SELECT c.campaign_id,c.paper_account_id,c.created_at,
                ${transitionAvailable
                  ? "(SELECT t.to_state FROM paper_validation_transitions t WHERE t.campaign_id=c.campaign_id AND t.entity_type='CAMPAIGN' ORDER BY t.sequence DESC LIMIT 1)"
                  : "NULL"} state
         FROM paper_validation_campaigns c WHERE c.target_id=?
         ORDER BY c.created_at DESC,c.campaign_id DESC LIMIT 1`,
        [targetId],
      );
    }

    if (targetId !== null) {
      snapshot.runtime.reconciliation.latestReport = first(
        database,
        "reconciliation_reports",
        `SELECT reconciliation_report_id,sync_status,issue_count,created_at,detail_json
         FROM reconciliation_reports WHERE target_id=?
         ORDER BY created_at DESC,reconciliation_report_id DESC LIMIT 1`,
        [targetId],
      );
      snapshot.runtime.reconciliation.openIssues = decorateRows(all(
        database,
        "reconciliation_issues",
        `SELECT issue_id,asset_id,issue_type,sync_status,status,detail_json,created_at,resolved_at
         FROM reconciliation_issues WHERE target_id=? AND status<>'RESOLVED'
         ORDER BY created_at DESC,issue_id DESC LIMIT ?`,
        [targetId, limit],
      ), { json: ["detail_json"] });
    }

    const hasPaperTarget = columnExists(database, "paper_accounts", "target_id");
    const paperAccountRow = first(
      database,
      "paper_accounts",
      `SELECT paper_account_id,name,status,initial_balance_micros,cash_balance_micros,
              reserved_balance_micros,realized_pnl_micros,updated_at
       FROM paper_accounts
       ${hasPaperTarget && targetId !== null ? "WHERE target_id=?" : ""}
       ORDER BY updated_at DESC,paper_account_id DESC LIMIT 1`,
      hasPaperTarget && targetId !== null ? [targetId] : [],
    );
    const paperAccountId = nullableString(paperAccountRow?.paper_account_id);
    if (paperAccountRow !== null && paperAccountId !== null) {
      snapshot.paper.account = {
        accountId: paperAccountId,
        name: stringValue(paperAccountRow.name),
        status: stringValue(paperAccountRow.status),
        initialBalance: money(paperAccountRow.initial_balance_micros),
        cash: money(paperAccountRow.cash_balance_micros),
        reserved: money(paperAccountRow.reserved_balance_micros),
        realizedPnl: money(paperAccountRow.realized_pnl_micros),
        updatedAt: stringValue(paperAccountRow.updated_at),
      };
      const projection = first(
        database,
        "portfolio_projection_runs",
        `SELECT projection_id,cash_balance_micros,reserved_balance_micros,
                available_balance_micros,position_value_micros,realized_pnl_micros,
                unrealized_pnl_micros,total_equity_micros,valuation_status,
                unpriced_position_count,price_source,price_timestamp,created_at
         FROM portfolio_projection_runs WHERE paper_account_id=?
         ORDER BY created_at DESC,projection_id DESC LIMIT 1`,
        [paperAccountId],
      );
      if (projection !== null) {
        snapshot.paper.portfolio = {
          projectionId: stringValue(projection.projection_id),
          cashBalance: money(projection.cash_balance_micros),
          reservedBalance: money(projection.reserved_balance_micros),
          availableBalance: money(projection.available_balance_micros),
          positionValue: money(projection.position_value_micros),
          realizedPnl: money(projection.realized_pnl_micros),
          unrealizedPnl: money(projection.unrealized_pnl_micros),
          totalEquity: money(projection.total_equity_micros),
          valuationStatus: stringValue(projection.valuation_status),
          unpricedPositionCount: integerValue(projection.unpriced_position_count),
          priceSource: nullableString(projection.price_source),
          priceTimestamp: nullableString(projection.price_timestamp),
          createdAt: stringValue(projection.created_at),
        };
      }

      snapshot.paper.executions = decorateRows(all(
        database,
        "paper_executions",
        `SELECT paper_execution_id,signal_id,risk_decision_id,execution_type,state,
                requested_amount_micros,requested_size_micros,filled_size_micros,
                filled_notional_micros,fee_micros,target_price_units,reason,
                attempt_count,created_at,updated_at
         FROM paper_executions WHERE paper_account_id=?
         ORDER BY created_at DESC,paper_execution_id DESC LIMIT ?`,
        [paperAccountId, limit],
      ), {
        money: ["requested_amount_micros", "filled_notional_micros", "fee_micros"],
        price: ["target_price_units"],
        size: ["requested_size_micros", "filled_size_micros"],
      });
      snapshot.paper.orders = decorateRows(all(
        database,
        "paper_orders",
        `SELECT o.paper_order_id,o.paper_execution_id,o.side,o.state,o.requested_size_micros,
                o.requested_amount_micros,o.filled_size_micros,o.filled_notional_micros,
                o.vwap_price_units,o.fee_micros,o.reject_reason,o.created_at
         FROM paper_orders o JOIN paper_executions e
           ON e.paper_execution_id=o.paper_execution_id
         WHERE e.paper_account_id=?
         ORDER BY o.created_at DESC,o.paper_order_id DESC LIMIT ?`,
        [paperAccountId, limit],
      ), {
        money: ["requested_amount_micros", "filled_notional_micros", "fee_micros"],
        price: ["vwap_price_units"],
        size: ["requested_size_micros", "filled_size_micros"],
      });
      snapshot.paper.fills = decorateRows(all(
        database,
        "paper_fill_ledger",
        `SELECT f.fill_id,f.paper_order_id,f.paper_execution_id,f.paper_position_id,
                f.side,f.price_units,f.size_micros,f.notional_micros,f.fee_micros,f.created_at
         FROM paper_fill_ledger f JOIN paper_executions e
           ON e.paper_execution_id=f.paper_execution_id
         WHERE e.paper_account_id=?
         ORDER BY f.created_at DESC,f.fill_id DESC LIMIT ?`,
        [paperAccountId, limit],
      ), {
        money: ["notional_micros", "fee_micros"],
        price: ["price_units"],
        size: ["size_micros"],
      });
      snapshot.paper.positions = decorateRows(all(
        database,
        "paper_positions",
        `SELECT paper_position_id,signal_id,asset_id,condition_id,outcome,entry_price_units,
                current_size_micros,remaining_cost_micros,status,realized_pnl_micros,
                frozen_reason,created_at,updated_at
         FROM paper_positions WHERE paper_account_id=?
         ORDER BY updated_at DESC,paper_position_id DESC LIMIT ?`,
        [paperAccountId, limit],
      ), {
        money: ["remaining_cost_micros", "realized_pnl_micros"],
        price: ["entry_price_units"],
        size: ["current_size_micros"],
      });
      snapshot.paper.ledger.cash = decorateRows(all(
        database,
        "paper_cash_ledger",
        `SELECT cash_ledger_id,paper_execution_id,entry_type,cash_delta_micros,
                reserved_delta_micros,cash_after_micros,reserved_after_micros,created_at
         FROM paper_cash_ledger WHERE paper_account_id=?
         ORDER BY created_at DESC,cash_ledger_id DESC LIMIT ?`,
        [paperAccountId, limit],
      ), {
        money: [
          "cash_delta_micros",
          "reserved_delta_micros",
          "cash_after_micros",
          "reserved_after_micros",
        ],
      });
      snapshot.paper.ledger.fees = decorateRows(all(
        database,
        "paper_fee_ledger",
        `SELECT f.fee_ledger_id,f.paper_execution_id,f.paper_order_id,f.fee_micros,f.created_at
         FROM paper_fee_ledger f JOIN paper_executions e
           ON e.paper_execution_id=f.paper_execution_id
         WHERE e.paper_account_id=?
         ORDER BY f.created_at DESC,f.fee_ledger_id DESC LIMIT ?`,
        [paperAccountId, limit],
      ), { money: ["fee_micros"] });
      snapshot.paper.ledger.pnl = decorateRows(all(
        database,
        "paper_pnl_ledger",
        `SELECT pnl_ledger_id,paper_position_id,paper_execution_id,pnl_type,
                proceeds_micros,cost_basis_micros,fee_micros,pnl_micros,created_at
         FROM paper_pnl_ledger WHERE paper_account_id=?
         ORDER BY created_at DESC,pnl_ledger_id DESC LIMIT ?`,
        [paperAccountId, limit],
      ), {
        money: ["proceeds_micros", "cost_basis_micros", "fee_micros", "pnl_micros"],
      });
    }

    if (targetId !== null) {
      snapshot.signals = decorateRows(all(
        database,
        "signals",
        `SELECT signal_id,signal_type,status,asset_id,condition_id,target_price_units,
                target_size_micros,sell_ratio_numerator,sell_ratio_denominator,reason,
                execution_eligible,execution_block_reason,event_classification,producer_mode,
                observe_run_id,created_at
         FROM signals WHERE target_id=?
         ORDER BY created_at DESC,signal_id DESC LIMIT ?`,
        [targetId, limit],
      ), {
        price: ["target_price_units"],
        size: ["target_size_micros"],
      });
      snapshot.markets = decorateRows(all(
        database,
        "signal_execution_contexts",
        `SELECT c.signal_id,s.condition_id,c.target_trade_capital_ratio_ppm,c.target_trade_timestamp,
                c.market_end_time,c.market_metadata_snapshot_json,c.market_end_time_status,
                c.execution_deadline_at
         FROM signal_execution_contexts c JOIN signals s ON s.signal_id=c.signal_id
         WHERE s.target_id=?
         ORDER BY c.target_trade_timestamp DESC,c.signal_id DESC LIMIT ?`,
        [targetId, limit],
      ), { json: ["market_metadata_snapshot_json"] }).map((row) => {
        const market = metadata(row.market_metadata_snapshot_json);
        return {
          ...row,
          question: market.question,
          slug: market.marketSlug,
          conditionId: row.condition_id ?? null,
          endTime: row.market_end_time ?? null,
          endTimeStatus: row.market_end_time_status ?? null,
        };
      });
      snapshot.riskDecisions = decorateRows(all(
        database,
        "risk_decisions",
        `SELECT r.risk_decision_id,r.executor_mode,r.account_id,r.signal_id,r.decision,
                r.risk_reject_reason,r.risk_reason,r.requested_amount_micros,
                r.requested_size_micros,r.checks_json,r.created_at
         FROM risk_decisions r JOIN signals s ON s.signal_id=r.signal_id
         WHERE s.target_id=?
         ORDER BY r.created_at DESC,r.risk_decision_id DESC LIMIT ?`,
        [targetId, limit],
      ), {
        money: ["requested_amount_micros"],
        size: ["requested_size_micros"],
        json: ["checks_json"],
      });
      snapshot.comparisons = comparisons(database, targetId, paperAccountId, limit);
    }

    const gate = first(
      database,
      "live_gate_state",
      `SELECT execution_mode,live_gate_state,requested_execution_mode,last_preflight_id,
              state_reason,updated_at
       FROM live_gate_state WHERE state_id='default' LIMIT 1`,
    );
    snapshot.live.capability.activation = "LIVE_GATE";
    if (gate !== null) {
      snapshot.live.gate = {
        executionMode: stringValue(gate.execution_mode),
        state: stringValue(gate.live_gate_state),
        requestedExecutionMode: nullableString(gate.requested_execution_mode),
        lastPreflightId: nullableString(gate.last_preflight_id),
        reason: stringValue(gate.state_reason),
        updatedAt: stringValue(gate.updated_at),
      };
    }
    snapshot.live.prerequisites = all(
      database,
      "live_gate_prerequisites",
      `SELECT prerequisite_key,status,evidence_json,updated_at
       FROM live_gate_prerequisites ORDER BY prerequisite_key`,
    ).map((row) => ({
      key: stringValue(row.prerequisite_key),
      status: stringValue(row.status),
      evidence: parseJson(row.evidence_json),
      updatedAt: stringValue(row.updated_at),
    }));
    snapshot.live.gateRuns = decorateRows(all(
      database,
      "live_gate_runs",
      `SELECT live_gate_run_id,run_type,allowed,blocked_reasons_json,checks_json,
              requested_execution_mode,execution_mode,live_gate_state,created_at
       FROM live_gate_runs ORDER BY created_at DESC,live_gate_run_id DESC LIMIT ?`,
      [limit],
    ), { json: ["blocked_reasons_json", "checks_json"] });
    snapshot.live.accounts = decorateRows(all(
      database,
      "live_accounts",
      `SELECT live_account_id,live_wallet_id,name,status,initial_bankroll_micros,
              risk_budget_micros,authorized_signer_address,activated_at,created_at,updated_at
       FROM live_accounts ORDER BY updated_at DESC,live_account_id DESC LIMIT ?`,
      [limit],
    ), { money: ["initial_bankroll_micros", "risk_budget_micros"] });
    const liveAccountId = nullableString(snapshot.live.accounts[0]?.live_account_id);
    if (liveAccountId !== null) {
      snapshot.live.executions = decorateRows(all(
        database,
        "live_executions",
        `SELECT live_execution_id,signal_id,risk_decision_id,live_gate_run_id,
                execution_type,state,requested_amount_micros,requested_size_micros,
                filled_size_micros,filled_notional_micros,fee_micros,target_price_units,
                reason,attempt_count,deadline_at,created_at,updated_at
         FROM live_executions WHERE live_account_id=?
         ORDER BY created_at DESC,live_execution_id DESC LIMIT ?`,
        [liveAccountId, limit],
      ), {
        money: ["requested_amount_micros", "filled_notional_micros", "fee_micros"],
        price: ["target_price_units"],
        size: ["requested_size_micros", "filled_size_micros"],
      });
      snapshot.live.orders = decorateRows(all(
        database,
        "live_orders",
        `SELECT o.live_order_id,o.live_execution_id,o.external_order_id,o.side,o.order_type,
                o.price_units,o.size_micros,o.filled_size_micros,o.filled_notional_micros,
                o.fee_micros,o.status,o.is_terminal,o.confirmation_pending,o.created_at,o.updated_at
         FROM live_orders o JOIN live_executions e ON e.live_execution_id=o.live_execution_id
         WHERE e.live_account_id=?
         ORDER BY o.created_at DESC,o.live_order_id DESC LIMIT ?`,
        [liveAccountId, limit],
      ), {
        money: ["filled_notional_micros", "fee_micros"],
        price: ["price_units"],
        size: ["size_micros", "filled_size_micros"],
      });
      snapshot.live.attempts = decorateRows(all(
        database,
        "live_order_attempts",
        `SELECT a.attempt_id,a.live_order_id,a.attempt_sequence,a.action,a.status,
                a.error_reason,a.created_at
         FROM live_order_attempts a JOIN live_orders o ON o.live_order_id=a.live_order_id
         JOIN live_executions e ON e.live_execution_id=o.live_execution_id
         WHERE e.live_account_id=?
         ORDER BY a.created_at DESC,a.attempt_id DESC LIMIT ?`,
        [liveAccountId, limit],
      ), {});
      snapshot.live.fills = decorateRows(all(
        database,
        "live_fills",
        `SELECT f.live_fill_id,f.live_order_id,f.live_execution_id,f.external_fill_id,
                f.side,f.fill_price_units,f.fill_size_micros,f.fill_notional_micros,
                f.fee_micros,f.fill_timestamp,f.created_at
         FROM live_fills f JOIN live_executions e ON e.live_execution_id=f.live_execution_id
         WHERE e.live_account_id=?
         ORDER BY f.created_at DESC,f.live_fill_id DESC LIMIT ?`,
        [liveAccountId, limit],
      ), {
        money: ["fill_notional_micros", "fee_micros"],
        price: ["fill_price_units"],
        size: ["fill_size_micros"],
      });
      snapshot.live.positions = decorateRows(all(
        database,
        "live_positions",
        `SELECT live_position_id,signal_id,asset_id,condition_id,outcome,entry_price_units,
                current_size_micros,remaining_cost_micros,status,realized_pnl_micros,
                frozen_reason,created_at,updated_at
         FROM live_positions WHERE live_account_id=?
         ORDER BY updated_at DESC,live_position_id DESC LIMIT ?`,
        [liveAccountId, limit],
      ), {
        money: ["remaining_cost_micros", "realized_pnl_micros"],
        price: ["entry_price_units"],
        size: ["current_size_micros"],
      });
      snapshot.live.ledger.cash = decorateRows(all(
        database,
        "live_cash_ledger",
        `SELECT cash_ledger_id,live_execution_id,entry_type,cash_delta_micros,
                reserved_delta_micros,cash_after_micros,reserved_after_micros,created_at
         FROM live_cash_ledger WHERE live_account_id=?
         ORDER BY created_at DESC,cash_ledger_id DESC LIMIT ?`,
        [liveAccountId, limit],
      ), {
        money: [
          "cash_delta_micros",
          "reserved_delta_micros",
          "cash_after_micros",
          "reserved_after_micros",
        ],
      });
      snapshot.live.ledger.fees = decorateRows(all(
        database,
        "live_fee_ledger",
        `SELECT f.fee_ledger_id,f.live_execution_id,f.live_order_id,f.fee_micros,
                f.fee_source,f.created_at
         FROM live_fee_ledger f JOIN live_executions e
           ON e.live_execution_id=f.live_execution_id
         WHERE e.live_account_id=?
         ORDER BY f.created_at DESC,f.fee_ledger_id DESC LIMIT ?`,
        [liveAccountId, limit],
      ), { money: ["fee_micros"] });
      snapshot.live.ledger.pnl = decorateRows(all(
        database,
        "live_pnl_ledger",
        `SELECT pnl_ledger_id,live_position_id,live_execution_id,pnl_type,
                proceeds_micros,cost_basis_micros,fee_micros,pnl_micros,
                price_source,price_timestamp,created_at
         FROM live_pnl_ledger WHERE live_account_id=?
         ORDER BY created_at DESC,pnl_ledger_id DESC LIMIT ?`,
        [liveAccountId, limit],
      ), {
        money: ["proceeds_micros", "cost_basis_micros", "fee_micros", "pnl_micros"],
      });
      snapshot.live.reconciliation = decorateRows(all(
        database,
        "live_reconciliation_runs",
        `SELECT reconciliation_run_id,status,checks_json,created_at
         FROM live_reconciliation_runs WHERE live_account_id=?
         ORDER BY created_at DESC,reconciliation_run_id DESC LIMIT ?`,
        [liveAccountId, limit],
      ), { json: ["checks_json"] });
      snapshot.live.recovery = decorateRows(all(
        database,
        "live_recovery_runs",
        `SELECT recovery_run_id,status,recovered_open_orders,recovered_fills,
                recovered_positions,reason,checks_json,created_at
         FROM live_recovery_runs WHERE live_account_id=?
         ORDER BY created_at DESC,recovery_run_id DESC LIMIT ?`,
        [liveAccountId, limit],
      ), { json: ["checks_json"] });
      snapshot.live.quarantines = all(
        database,
        "live_signal_quarantines",
        `SELECT signal_id,signal_sequence,failure_stage,reason,risk_decision_id,
                live_execution_id,created_at
         FROM live_signal_quarantines WHERE live_account_id=?
         ORDER BY created_at DESC,signal_sequence DESC LIMIT ?`,
        [liveAccountId, limit],
      );
      snapshot.live.valuations = decorateRows(all(
        database,
        "live_valuation_snapshots",
        `SELECT valuation_snapshot_id,cash_balance_micros,reserved_balance_micros,
                available_balance_micros,position_value_micros,realized_pnl_micros,
                unrealized_pnl_micros,total_equity_micros,valuation_status,
                unpriced_position_count,price_source,price_timestamp,created_at
         FROM live_valuation_snapshots WHERE live_account_id=?
         ORDER BY created_at DESC,valuation_snapshot_id DESC LIMIT ?`,
        [liveAccountId, limit],
      ), {
        money: [
          "cash_balance_micros",
          "reserved_balance_micros",
          "available_balance_micros",
          "position_value_micros",
          "realized_pnl_micros",
          "unrealized_pnl_micros",
          "total_equity_micros",
        ],
      });
    }
    snapshot.live.audit = decorateRows(all(
      database,
      "audit_log",
      `SELECT audit_id,timestamp,entity_type,entity_id,action,reason,metadata_json
       FROM audit_log WHERE entity_type LIKE 'LIVE%'
       ORDER BY timestamp DESC,audit_id DESC LIMIT ?`,
      [limit],
    ), { json: ["metadata_json"] });
    snapshot.live.production = liveProductionReadiness(projectRoot, {
      databaseAvailable: snapshot.database.status === "AVAILABLE",
      gatePrerequisites: snapshot.live.prerequisites,
      executionCapability: snapshot.live.capability.execution,
    }, () => new Date(generatedAt));

    const lockPath = resolve(projectRoot, OPERATOR_ACTIVE_LOCK);
    const operatorLocked = existsSync(lockPath);
    const staleRunning = !operatorLocked && observeRow?.state === "RUNNING";
    snapshot.runtime.operatorLocked = operatorLocked;
    snapshot.runtime.state = operatorLocked
      ? "RUNNING"
      : staleRunning
        ? "RECOVERY_REQUIRED"
        : "STOPPED";
    snapshot.runtime.logs = latestFiles(resolve(projectRoot, "data/operator/logs"), {
      suffix: ".log",
      limit: 3,
    }).map((entry) => ({
      name: entry.name,
      updatedAt: entry.updatedAt,
      sizeBytes: entry.sizeBytes,
    }));
    snapshot.runtime.reports = [
      ...latestFiles(resolve(projectRoot, "data/operator/final-reports"), {
        limit: 10,
      }),
      ...latestFiles(resolve(projectRoot, "data/operator"), {
        suffix: ".zip",
        limit: 10,
      }),
    ].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).slice(0, 10)
      .map((entry) => ({
        name: entry.name,
        path: entry.path,
        updatedAt: entry.updatedAt,
        sizeBytes: entry.sizeBytes,
      }));
    return snapshot;
  } catch (error) {
    snapshot.database.status = "ERROR";
    snapshot.database.error = error instanceof Error ? error.message : String(error);
    return snapshot;
  } finally {
    database.close();
  }
}
