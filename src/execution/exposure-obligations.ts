import type { DatabaseSync } from "node:sqlite";
import type { ExecutorMode } from "./types.js";

export interface ExposureObligation {
  assetId: string;
  conditionId: string;
  amountMicros: bigint;
  executionId?: string;
}

export interface AccountExposure {
  totalMicros: bigint;
  marketMicros: Map<string, bigint>;
  assetMicros: Map<string, bigint>;
  pendingBuys: Map<string, ExposureObligation>;
}

interface ExposureScope {
  assetId: string;
  conditionId: string;
}

function emptyExposure(): AccountExposure {
  return { totalMicros: 0n, marketMicros: new Map(), assetMicros: new Map(), pendingBuys: new Map() };
}

const aggregateConnections = new WeakSet<DatabaseSync>();

/** Keep decimal TEXT exact; SQLite SUM would coerce or overflow large values. */
function registerExposureAggregates(database: DatabaseSync): void {
  if (aggregateConnections.has(database)) return;
  for (const [name, signed] of [["ni_k_exposure_sum", true], ["ni_k_exposure_cost", false]] as const) {
    database.aggregate(name, {
      start: 0n,
      step: (total: bigint, value) => {
        if (typeof value !== "string" || !(signed ? /^-?\d+$/ : /^\d+$/).test(value)) {
          throw new Error("EXPOSURE_OBLIGATION_INVALID");
        }
        return total + BigInt(value);
      },
      result: (total: bigint) => total.toString(),
    });
  }
  aggregateConnections.add(database);
}

function addExposure(
  result: AccountExposure, assetId: string, conditionId: string, amount: bigint, scope?: ExposureScope,
): void {
  if (amount < 0n) throw new Error("EXPOSURE_OBLIGATION_NEGATIVE");
  const market = conditionId.toLowerCase();
  result.totalMicros += amount;
  if (scope === undefined || market === scope.conditionId) {
    result.marketMicros.set(market, (result.marketMicros.get(market) ?? 0n) + amount);
  }
  if (scope === undefined || assetId === scope.assetId) {
    result.assetMicros.set(assetId, (result.assetMicros.get(assetId) ?? 0n) + amount);
  }
}

/** Cash reserved for a BUY remains risk exposure until consumed or released. */
export function projectAccountExposure(
  positions: readonly ExposureObligation[],
  pendingBuys: readonly ExposureObligation[],
  excludeExecutionId?: string,
): AccountExposure {
  const result = emptyExposure();
  for (const pending of pendingBuys) {
    if (!pending.executionId || result.pendingBuys.has(pending.executionId)) {
      throw new Error("EXPOSURE_PENDING_EXECUTION_INVALID");
    }
    result.pendingBuys.set(pending.executionId, pending);
  }
  const add = (item: ExposureObligation) => addExposure(result, item.assetId, item.conditionId, item.amountMicros);
  for (const position of positions) add(position);
  for (const pending of pendingBuys) {
    if (pending.amountMicros < 0n) throw new Error("EXPOSURE_OBLIGATION_NEGATIVE");
    if (pending.executionId !== excludeExecutionId) add(pending);
  }
  return result;
}

/** Two bounded query sets replace separate full scans for each exposure scope. */
export function loadAccountExposure(
  database: DatabaseSync,
  mode: ExecutorMode,
  accountId: string,
  excludeExecutionId?: string,
  /** Optional hot-path scope; total and pending remain complete, maps are scoped. */
  scope?: ExposureScope,
): AccountExposure {
  const paper = mode === "PAPER";
  const result = emptyExposure();
  const normalizedScope = scope === undefined ? undefined : { ...scope, conditionId: scope.conditionId.toLowerCase() };
  registerExposureAggregates(database);
  if (normalizedScope !== undefined) {
    const totals = database.prepare(
      `SELECT ni_k_exposure_cost(remaining_cost_micros) total,
        ni_k_exposure_cost(remaining_cost_micros) FILTER(WHERE condition_id=? COLLATE NOCASE) market,
        ni_k_exposure_cost(remaining_cost_micros) FILTER(WHERE asset_id=?) asset
       FROM ${paper ? "paper_positions" : "live_positions"}
       WHERE ${paper ? "paper_account_id" : "live_account_id"}=?
        AND status IN ('OPEN','PARTIALLY_CLOSED','SETTLEMENT_PENDING','FROZEN')`,
    ).get(normalizedScope.conditionId, normalizedScope.assetId, accountId) as { total: string; market: string; asset: string };
    result.totalMicros = BigInt(totals.total);
    result.marketMicros.set(normalizedScope.conditionId, BigInt(totals.market));
    result.assetMicros.set(normalizedScope.assetId, BigInt(totals.asset));
  } else {
    const rows = database.prepare(
    `SELECT asset_id,condition_id,remaining_cost_micros amount
     FROM ${paper ? "paper_positions" : "live_positions"}
     WHERE ${paper ? "paper_account_id" : "live_account_id"}=?
       AND status IN ('OPEN','PARTIALLY_CLOSED','SETTLEMENT_PENDING','FROZEN')`,
  ).all(accountId) as Array<{ asset_id: string; condition_id: string; amount: string }>;
    for (const row of rows) addExposure(result, row.asset_id, row.condition_id, BigInt(row.amount));
  }
  const pending = paper
    ? database.prepare(
      `SELECT e.paper_execution_id execution_id,e.asset_id,e.condition_id,r.remaining_amount_micros amount
       FROM paper_reservations r JOIN paper_executions e ON e.paper_execution_id=r.paper_execution_id
       WHERE e.paper_account_id=? AND e.execution_type='TARGET_BUY' AND r.status='ACTIVE'`,
    ).all(accountId) as Array<{ execution_id: string; asset_id: string; condition_id: string; amount: string }>
    : database.prepare(
      `SELECT e.live_execution_id execution_id,e.asset_id,e.condition_id,ni_k_exposure_sum(r.delta_micros) amount
       FROM live_reservation_ledger r JOIN live_executions e ON e.live_execution_id=r.live_execution_id
       WHERE e.live_account_id=? AND e.execution_type='TARGET_BUY'
       GROUP BY e.live_execution_id`,
    ).all(accountId) as Array<{ execution_id: string; asset_id: string; condition_id: string; amount: string }>;
  for (const row of pending) {
    const current = result.pendingBuys.get(row.execution_id);
    if (current) current.amountMicros += BigInt(row.amount);
    else result.pendingBuys.set(row.execution_id, {
      executionId: row.execution_id, assetId: row.asset_id, conditionId: row.condition_id, amountMicros: BigInt(row.amount),
    });
  }
  for (const pending of result.pendingBuys.values()) {
    if (pending.amountMicros < 0n) throw new Error("EXPOSURE_OBLIGATION_NEGATIVE");
    if (pending.executionId !== excludeExecutionId) {
      addExposure(result, pending.assetId, pending.conditionId, pending.amountMicros, normalizedScope);
    }
  }
  return result;
}
