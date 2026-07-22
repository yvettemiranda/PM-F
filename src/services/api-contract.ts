import type { ApiCapture } from "../adapters/polymarket-public.js";
import { resolveSourceEventMultiplicity, sourceEventKey } from "../domain/idempotency.js";
import type { PublicActivity, PublicPosition, PublicTrade } from "../domain/models.js";

export interface ApiContractInput {
  trades: PublicTrade[];
  activity: PublicActivity[];
  positions: PublicPosition[];
  tradeHistoryComplete: boolean;
  activityHistoryComplete: boolean;
  tradePaginationBoundaryOverlaps?: PublicTrade[];
  activityPaginationBoundaryOverlaps?: PublicTrade[];
  confirmedTradeOccurrenceCounts?: Readonly<Record<string, number>>;
  clobTime: ApiCapture<number>;
  captures: ApiCapture<unknown>[];
}

export interface ApiContractReport {
  status: "PASSED" | "INCOMPLETE" | "FAILED";
  schemaErrors: string[];
  warnings: string[];
  observations: {
    tradeRows: number;
    buyRows: number;
    sellRows: number;
    uniqueAssets: number;
    uniqueConditions: number;
    earliestTradeTime: string | null;
    latestTradeTime: string | null;
    activityRows: number;
    activityTypeCounts: Record<string, number>;
    positionRows: number;
    maxPriceFractionDigits: number;
    maxSizeFractionDigits: number;
    exactDuplicateRows: number;
    confirmedDuplicateRows: number;
    reconciledPaginationOverlapRows: number;
    ambiguousDuplicateRows: number;
    sameSecondGroups: number;
    maxRowsInSameSecond: number;
    multiRowTransactions: number;
    maxRowsPerTransaction: number;
    requestCount: number;
    requestLatencyP50Ms: number;
    requestLatencyP95Ms: number;
    requestLatencyMaxMs: number;
    clockOffsetMs: number;
  };
}

const ADDRESS = /^0x[a-fA-F0-9]{40}$/;

function fractionDigits(value: number | string): number {
  const text = String(value).toLowerCase();
  if (text.includes("e")) {
    const [coefficient = "0", exponentText] = text.split("e");
    const exponent = Number(exponentText);
    const coefficientDigits = coefficient.split(".")[1]?.length ?? 0;
    return Math.max(0, coefficientDigits - exponent);
  }
  return text.split(".")[1]?.length ?? 0;
}

function percentile(values: readonly number[], ratio: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)] ?? 0;
}

function isTradeActivity(activity: PublicActivity): activity is PublicActivity & PublicTrade {
  return activity.type === "TRADE"
    && typeof activity.conditionId === "string"
    && typeof activity.asset === "string"
    && (activity.side === "BUY" || activity.side === "SELL")
    && activity.price !== undefined
    && activity.size !== undefined;
}

export function validateApiContract(input: ApiContractInput): ApiContractReport {
  const schemaErrors: string[] = [];
  for (const [index, trade] of input.trades.entries()) {
    if (!ADDRESS.test(trade.proxyWallet)) schemaErrors.push(`trades[${index}].proxyWallet invalid`);
    if (!trade.transactionHash) schemaErrors.push(`trades[${index}].transactionHash missing`);
    if (!trade.conditionId) schemaErrors.push(`trades[${index}].conditionId missing`);
    if (!trade.asset) schemaErrors.push(`trades[${index}].asset missing`);
    if (trade.side !== "BUY" && trade.side !== "SELL") schemaErrors.push(`trades[${index}].side invalid`);
    if (!Number.isInteger(trade.timestamp) || trade.timestamp <= 0) schemaErrors.push(`trades[${index}].timestamp invalid`);
    const price = Number(trade.price);
    const size = Number(trade.size);
    if (!Number.isFinite(price) || price < 0 || price > 1) schemaErrors.push(`trades[${index}].price invalid`);
    if (!Number.isFinite(size) || size < 0) schemaErrors.push(`trades[${index}].size invalid`);
    if (schemaErrors.length >= 100) break;
  }

  for (const [index, position] of input.positions.entries()) {
    if (!ADDRESS.test(position.proxyWallet)) schemaErrors.push(`positions[${index}].proxyWallet invalid`);
    if (!position.asset) schemaErrors.push(`positions[${index}].asset missing`);
    if (!position.conditionId) schemaErrors.push(`positions[${index}].conditionId missing`);
    if (!Number.isFinite(Number(position.size))) schemaErrors.push(`positions[${index}].size invalid`);
    if (schemaErrors.length >= 100) break;
  }

  const eventCounts = new Map<string, number>();
  const secondCounts = new Map<number, number>();
  const transactionCounts = new Map<string, number>();
  let maxPriceFractionDigits = 0;
  let maxSizeFractionDigits = 0;
  for (const trade of input.trades) {
    const key = sourceEventKey(trade);
    eventCounts.set(key, (eventCounts.get(key) ?? 0) + 1);
    secondCounts.set(trade.timestamp, (secondCounts.get(trade.timestamp) ?? 0) + 1);
    const transactionHash = trade.transactionHash.toLowerCase();
    transactionCounts.set(transactionHash, (transactionCounts.get(transactionHash) ?? 0) + 1);
    maxPriceFractionDigits = Math.max(maxPriceFractionDigits, fractionDigits(trade.price));
    maxSizeFractionDigits = Math.max(maxSizeFractionDigits, fractionDigits(trade.size));
  }
  const tradeActivities = input.activity.filter(isTradeActivity);
  const multiplicity = resolveSourceEventMultiplicity(input.trades, tradeActivities, {
    ...(input.tradePaginationBoundaryOverlaps === undefined
      ? {}
      : { tradePaginationBoundaryOverlaps: input.tradePaginationBoundaryOverlaps }),
    ...(input.activityPaginationBoundaryOverlaps === undefined
      ? {}
      : { activityPaginationBoundaryOverlaps: input.activityPaginationBoundaryOverlaps }),
    ...(input.confirmedTradeOccurrenceCounts === undefined
      ? {}
      : { confirmedOccurrenceCounts: input.confirmedTradeOccurrenceCounts }),
  });

  const requestLatencies = input.captures.map((capture) => capture.latencyMs);
  const tradeTimestamps = input.trades.map((trade) => trade.timestamp).filter(Number.isFinite);
  const activityTypeCounts: Record<string, number> = {};
  for (const item of input.activity) activityTypeCounts[item.type] = (activityTypeCounts[item.type] ?? 0) + 1;
  const exactDuplicateRows = [...eventCounts.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0);
  const confirmedDuplicateRows = multiplicity.confirmedRepeatedKeys.length;
  const ambiguousDuplicateRows = multiplicity.ambiguousRepeatedKeys.length;
  const sameSecond = [...secondCounts.values()].filter((count) => count > 1);
  const multiRowTransactions = [...transactionCounts.values()].filter((count) => count > 1);
  const localTimeAtResponse = Date.parse(input.clobTime.fetchedAt);
  const estimatedLocalTimeAtServerResponse = localTimeAtResponse - input.clobTime.latencyMs / 2;
  const clockOffsetMs = Math.round(input.clobTime.data * 1_000 - estimatedLocalTimeAtServerResponse);
  const warnings: string[] = [];
  if (!input.tradeHistoryComplete) warnings.push("TRADE_HISTORY_TRUNCATED_BY_SOURCE_OFFSET_LIMIT");
  if (!input.activityHistoryComplete) warnings.push("ACTIVITY_HISTORY_TRUNCATED_BY_SOURCE_OFFSET_LIMIT");
  if (ambiguousDuplicateRows > 0) warnings.push("EXACT_DUPLICATE_TRADE_ROWS_REQUIRE_RECONCILIATION");

  return {
    status: schemaErrors.length > 0 ? "FAILED" : warnings.length > 0 ? "INCOMPLETE" : "PASSED",
    schemaErrors,
    warnings,
    observations: {
      tradeRows: input.trades.length,
      buyRows: input.trades.filter((trade) => trade.side === "BUY").length,
      sellRows: input.trades.filter((trade) => trade.side === "SELL").length,
      uniqueAssets: new Set(input.trades.map((trade) => trade.asset)).size,
      uniqueConditions: new Set(input.trades.map((trade) => trade.conditionId.toLowerCase())).size,
      earliestTradeTime: tradeTimestamps.length === 0 ? null : new Date(Math.min(...tradeTimestamps) * 1_000).toISOString(),
      latestTradeTime: tradeTimestamps.length === 0 ? null : new Date(Math.max(...tradeTimestamps) * 1_000).toISOString(),
      activityRows: input.activity.length,
      activityTypeCounts,
      positionRows: input.positions.length,
      maxPriceFractionDigits,
      maxSizeFractionDigits,
      exactDuplicateRows,
      confirmedDuplicateRows,
      reconciledPaginationOverlapRows: multiplicity.reconciledPaginationOverlapRows,
      ambiguousDuplicateRows,
      sameSecondGroups: sameSecond.length,
      maxRowsInSameSecond: sameSecond.length === 0 ? 1 : Math.max(...sameSecond),
      multiRowTransactions: multiRowTransactions.length,
      maxRowsPerTransaction: multiRowTransactions.length === 0 ? 1 : Math.max(...multiRowTransactions),
      requestCount: requestLatencies.length,
      requestLatencyP50Ms: percentile(requestLatencies, 0.5),
      requestLatencyP95Ms: percentile(requestLatencies, 0.95),
      requestLatencyMaxMs: requestLatencies.length === 0 ? 0 : Math.max(...requestLatencies),
      clockOffsetMs,
    },
  };
}
