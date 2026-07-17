import { createHash } from "node:crypto";
import { decimalToScaled, PRICE_SCALE_DIGITS, SHARE_SCALE_DIGITS } from "./fixed.js";
import type { PublicActivity, PublicTrade, SignalType } from "./models.js";

function hash(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\u001f")).digest("hex");
}

const SOURCE_FINGERPRINT_VERSION = "v1.1.0";
export const SOURCE_IDENTITY_VERSION = "v1.2.0";
export const ACTIVITY_IDENTITY_VERSION = "v1.0.0";

function sourceEventFingerprint(trade: PublicTrade): string {
  return hash([
    SOURCE_FINGERPRINT_VERSION,
    trade.proxyWallet.toLowerCase(),
    trade.transactionHash.toLowerCase(),
    trade.conditionId.toLowerCase(),
    trade.asset,
    trade.side,
    decimalToScaled(trade.price, PRICE_SCALE_DIGITS).toString(),
    decimalToScaled(trade.size, SHARE_SCALE_DIGITS).toString(),
    String(trade.timestamp),
  ]);
}

export function sourceEventKey(trade: PublicTrade, occurrenceIndex = 0): string {
  if (!Number.isSafeInteger(occurrenceIndex) || occurrenceIndex < 0) {
    throw new Error(`INVALID_SOURCE_EVENT_OCCURRENCE:${occurrenceIndex}`);
  }
  const fingerprint = sourceEventFingerprint(trade);
  // Keep occurrence zero byte-for-byte compatible with existing raw events,
  // signals, Golden expectations, and checkpoints. Public Data API rows do not
  // expose a per-fill id, so later identical occurrences need a local,
  // deterministic multiset identity instead of being collapsed.
  return occurrenceIndex === 0
    ? fingerprint
    : hash([SOURCE_IDENTITY_VERSION, fingerprint, String(occurrenceIndex)]);
}

export interface SourceEventOccurrence<T extends PublicTrade = PublicTrade> {
  trade: T;
  sourceEventKey: string;
  occurrenceIndex: number;
}

/**
 * Assign stable identities to a source-local multiset of public trades.
 * Identical rows receive occurrence indexes 0..n-1. The resulting key set is
 * independent of response order because rows sharing a fingerprint are
 * economically indistinguishable; Trades and Activity can enumerate their
 * copies independently and still converge on the same keys.
 */
export function sourceEventOccurrences<T extends PublicTrade>(
  trades: readonly T[],
): SourceEventOccurrence<T>[] {
  const counts = new Map<string, number>();
  return trades.map((trade) => {
    const fingerprint = sourceEventFingerprint(trade);
    const occurrenceIndex = counts.get(fingerprint) ?? 0;
    counts.set(fingerprint, occurrenceIndex + 1);
    return {
      trade,
      sourceEventKey: sourceEventKey(trade, occurrenceIndex),
      occurrenceIndex,
    };
  });
}

export interface SourceEventMultiplicityResolution<
  TTrade extends PublicTrade = PublicTrade,
  TActivityTrade extends PublicTrade = PublicTrade,
> {
  trades: SourceEventOccurrence<TTrade>[];
  activityTrades: SourceEventOccurrence<TActivityTrade>[];
  confirmedRepeatedKeys: string[];
  ambiguousRepeatedKeys: string[];
  reconciledPaginationOverlapRows: number;
}

export interface SourceEventMultiplicityEvidence {
  tradePaginationBoundaryOverlaps?: readonly PublicTrade[];
  activityPaginationBoundaryOverlaps?: readonly PublicTrade[];
}

/** Resolve repeated identical fills by matching source-local occurrence rank. */
export function resolveSourceEventMultiplicity<
  TTrade extends PublicTrade,
  TActivityTrade extends PublicTrade,
>(
  trades: readonly TTrade[],
  activityTrades: readonly TActivityTrade[],
  evidence: SourceEventMultiplicityEvidence = {},
): SourceEventMultiplicityResolution<TTrade, TActivityTrade> {
  const rawTradeOccurrences = sourceEventOccurrences(trades);
  const rawActivityOccurrences = sourceEventOccurrences(activityTrades);
  const countsByBaseKey = (occurrences: readonly SourceEventOccurrence[]): Map<string, number> => {
    const result = new Map<string, number>();
    for (const occurrence of occurrences) {
      const key = sourceEventKey(occurrence.trade);
      result.set(key, (result.get(key) ?? 0) + 1);
    }
    return result;
  };
  const evidenceCounts = (rows: readonly PublicTrade[] | undefined): Map<string, number> => {
    const result = new Map<string, number>();
    for (const row of rows ?? []) {
      const key = sourceEventKey(row);
      result.set(key, (result.get(key) ?? 0) + 1);
    }
    return result;
  };
  const rawTradeCounts = countsByBaseKey(rawTradeOccurrences);
  const rawActivityCounts = countsByBaseKey(rawActivityOccurrences);
  const tradeOverlapCounts = evidenceCounts(evidence.tradePaginationBoundaryOverlaps);
  const activityOverlapCounts = evidenceCounts(evidence.activityPaginationBoundaryOverlaps);
  const assertValidEvidence = (overlaps: Map<string, number>, raw: Map<string, number>): void => {
    for (const [key, count] of overlaps) {
      if (count <= 0 || count >= (raw.get(key) ?? 0)) {
        throw new Error(`INVALID_PAGINATION_BOUNDARY_OVERLAP_EVIDENCE:${key}`);
      }
    }
  };
  assertValidEvidence(tradeOverlapCounts, rawTradeCounts);
  assertValidEvidence(activityOverlapCounts, rawActivityCounts);

  const effectiveTradeCounts = new Map(rawTradeCounts);
  const effectiveActivityCounts = new Map(rawActivityCounts);
  const forcedAmbiguousBaseKeys = new Set<string>();
  let reconciledPaginationOverlapRows = 0;
  const baseKeys = new Set([
    ...rawTradeCounts.keys(),
    ...rawActivityCounts.keys(),
    ...tradeOverlapCounts.keys(),
    ...activityOverlapCounts.keys(),
  ]);
  for (const key of baseKeys) {
    const tradeCount = rawTradeCounts.get(key) ?? 0;
    const activityCount = rawActivityCounts.get(key) ?? 0;
    const tradeOverlapCount = tradeOverlapCounts.get(key) ?? 0;
    const activityOverlapCount = activityOverlapCounts.get(key) ?? 0;
    if (tradeOverlapCount > 0 && activityOverlapCount > 0) {
      forcedAmbiguousBaseKeys.add(key);
      continue;
    }
    if (
      tradeOverlapCount > 0
      && activityCount > 0
      && tradeCount - tradeOverlapCount === activityCount
    ) {
      effectiveTradeCounts.set(key, tradeCount - tradeOverlapCount);
      reconciledPaginationOverlapRows += tradeOverlapCount;
      continue;
    }
    if (
      activityOverlapCount > 0
      && tradeCount > 0
      && activityCount - activityOverlapCount === tradeCount
    ) {
      effectiveActivityCounts.set(key, activityCount - activityOverlapCount);
      reconciledPaginationOverlapRows += activityOverlapCount;
    }
  }

  const tradeOccurrences = rawTradeOccurrences.filter(
    (item) => item.occurrenceIndex < (effectiveTradeCounts.get(sourceEventKey(item.trade)) ?? 0),
  );
  const activityOccurrences = rawActivityOccurrences.filter(
    (item) => item.occurrenceIndex < (effectiveActivityCounts.get(sourceEventKey(item.trade)) ?? 0),
  );
  const confirmedRepeatedKeys: string[] = [];
  const ambiguousRepeatedKeys: string[] = [];
  const sampleByBaseKey = new Map<string, PublicTrade>();
  for (const row of [...trades, ...activityTrades]) {
    const key = sourceEventKey(row);
    if (!sampleByBaseKey.has(key)) sampleByBaseKey.set(key, row);
  }
  for (const key of baseKeys) {
    const sample = sampleByBaseKey.get(key);
    if (!sample) continue;
    const tradeCount = effectiveTradeCounts.get(key) ?? 0;
    const activityCount = effectiveActivityCounts.get(key) ?? 0;
    for (let occurrenceIndex = 1; occurrenceIndex < Math.max(tradeCount, activityCount); occurrenceIndex += 1) {
      const repeatedKey = sourceEventKey(sample, occurrenceIndex);
      if (
        !forcedAmbiguousBaseKeys.has(key)
        && occurrenceIndex < tradeCount
        && occurrenceIndex < activityCount
      ) {
        confirmedRepeatedKeys.push(repeatedKey);
      } else {
        ambiguousRepeatedKeys.push(repeatedKey);
      }
    }
  }
  confirmedRepeatedKeys.sort();
  ambiguousRepeatedKeys.sort();
  return {
    trades: tradeOccurrences,
    activityTrades: activityOccurrences,
    confirmedRepeatedKeys,
    ambiguousRepeatedKeys,
    reconciledPaginationOverlapRows,
  };
}

export function resolvedSourceEventTradeMap<
  TTrade extends PublicTrade,
  TActivityTrade extends PublicTrade,
>(
  trades: readonly TTrade[],
  activityTrades: readonly TActivityTrade[],
): Map<string, TTrade | TActivityTrade> {
  const resolution = resolveSourceEventMultiplicity(trades, activityTrades);
  const confirmedRepeatedKeys = new Set(resolution.confirmedRepeatedKeys);
  const result = new Map<string, TTrade | TActivityTrade>();
  for (const item of resolution.trades) {
    if (item.occurrenceIndex === 0 || confirmedRepeatedKeys.has(item.sourceEventKey)) {
      result.set(item.sourceEventKey, item.trade);
    }
  }
  for (const item of resolution.activityTrades) {
    if (
      (item.occurrenceIndex === 0 || confirmedRepeatedKeys.has(item.sourceEventKey))
      && !result.has(item.sourceEventKey)
    ) {
      result.set(item.sourceEventKey, item.trade);
    }
  }
  return result;
}

export function signalIdempotencyKey(sourceKey: string, type: SignalType, signalVersion: string): string {
  return hash([sourceKey, type, signalVersion]);
}

export function activityEventKey(activity: PublicActivity): string {
  return hash([
    ACTIVITY_IDENTITY_VERSION,
    "ACTIVITY",
    activity.proxyWallet.toLowerCase(),
    activity.transactionHash.toLowerCase(),
    activity.type,
    activity.conditionId?.toLowerCase() ?? "NONE",
    activity.asset ?? "NONE",
    activity.side ?? "NONE",
    activity.price === undefined ? "NONE" : String(activity.price),
    activity.size === undefined ? "NONE" : String(activity.size),
    String(activity.timestamp),
  ]);
}

export function executionIdempotencyKey(
  signalId: string,
  consumerMode: "PAPER" | "LIVE",
  positionId: string | null,
  actionSequence: number,
): string {
  return hash([signalId, consumerMode, positionId ?? "NONE", String(actionSequence)]);
}
