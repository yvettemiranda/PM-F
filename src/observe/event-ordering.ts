import type { SourceChainOrder } from "../domain/models.js";
import { stableJson } from "../domain/canonical-json.js";
import { sourceEventKey } from "../domain/idempotency.js";
import type { ObserveEvent, SourceEventOrderAmbiguity } from "./types.js";

const QUANTITY = /^0x(?:0|[1-9a-f][0-9a-f]*)$/;

export function validatedChainOrder(value: unknown): SourceChainOrder {
  if (!value || typeof value !== "object") throw new Error("OBSERVE_CHAIN_ORDER_INVALID");
  const row = value as Record<string, unknown>;
  const quantity = (key: string): string => {
    if (typeof row[key] !== "string" || !QUANTITY.test(row[key])) throw new Error(`OBSERVE_CHAIN_ORDER_INVALID:${key}`);
    return row[key];
  };
  if (typeof row.blockHash !== "string" || !/^0x[0-9a-f]{64}$/.test(row.blockHash)) {
    throw new Error("OBSERVE_CHAIN_ORDER_INVALID:blockHash");
  }
  const result = {
    blockNumber: quantity("blockNumber"), blockHash: row.blockHash,
    transactionIndex: quantity("transactionIndex"), logIndex: quantity("logIndex"), lastLogIndex: quantity("lastLogIndex"),
  };
  if (BigInt(result.lastLogIndex) < BigInt(result.logIndex)) throw new Error("OBSERVE_CHAIN_ORDER_INVALID:logRange");
  return result;
}

export function sameChainOrder(left: SourceChainOrder, right: SourceChainOrder): boolean {
  return stableJson(validatedChainOrder(left)) === stableJson(validatedChainOrder(right));
}

function compareQuantity(left: string, right: string): number {
  const a = BigInt(left), b = BigInt(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareChainOrder(left: SourceChainOrder, right: SourceChainOrder): number {
  if (left.blockNumber === right.blockNumber && left.blockHash !== right.blockHash) {
    throw new Error(`OBSERVE_CHAIN_ORDER_BLOCK_CONFLICT:${left.blockNumber}`);
  }
  return compareQuantity(left.blockNumber, right.blockNumber)
    || compareQuantity(left.transactionIndex, right.transactionIndex)
    || compareQuantity(left.logIndex, right.logIndex);
}

function conditions(event: ObserveEvent, conditionByAsset: ReadonlyMap<string, string>): string[] {
  if (event.trade) return [event.trade.conditionId.toLowerCase()];
  if (event.conversion) return [...new Set([
    event.conversion.groupConditionId, conditionByAsset.get(event.conversion.sourceAsset),
    ...event.conversion.destinationAssets.map((leg) => leg.conditionId),
  ].filter((value): value is string => value !== undefined).map((value) => value.toLowerCase()))];
  const activity = event.activity;
  return activity && ["MERGE", "SPLIT", "REDEEM", "CONVERSION"].includes(activity.type) && activity.conditionId
    ? [activity.conditionId.toLowerCase()] : [];
}

/** An alias keeps its original source label; immutable Polygon proof still
 * confirms its execution without pretending Activity has classified it. */
export function isObserveTradeExecutionConfirmed(event: ObserveEvent): boolean {
  return event.trade !== undefined && (event.activityConfirmed
    || event.sourceType === "POLYGON_ORDER_FILLED" || event.chainOrder !== undefined);
}

/** Hash order is only a reproducible display fallback, never execution evidence. */
export function orderObserveEvents(events: readonly ObserveEvent[], baselineConditions: ReadonlyMap<string, string> = new Map()): {
  ordered: ObserveEvent[];
  ambiguities: SourceEventOrderAmbiguity[];
} {
  for (const event of events) if (event.chainOrder) validatedChainOrder(event.chainOrder);
  const conditionByAsset = new Map(baselineConditions);
  for (const event of events) {
    if (event.trade) conditionByAsset.set(event.trade.asset, event.trade.conditionId);
    for (const leg of event.conversion?.destinationAssets ?? []) conditionByAsset.set(leg.asset, leg.conditionId);
  }
  const groups = new Map<string, { sourceTimestamp: number; conditionId: string; events: ObserveEvent[] }>();
  for (const event of events) {
    if (event.isCombo && event.trade) continue;
    if (event.trade && event.sourceEventKey !== sourceEventKey(event.trade)
      && !isObserveTradeExecutionConfirmed(event)) continue;
    for (const conditionId of conditions(event, conditionByAsset)) {
      const key = `${event.sourceTimestamp}:${conditionId}`;
      let group = groups.get(key);
      if (!group) { group = { sourceTimestamp: event.sourceTimestamp, conditionId, events: [] }; groups.set(key, group); }
      group.events.push(event);
    }
  }
  const ambiguities: SourceEventOrderAmbiguity[] = [];
  for (const group of groups.values()) {
    if (group.events.length < 2) continue;
    // Confirmed byte-identical multiset occurrences are economically
    // indistinguishable. Their established occurrence rank remains valid.
    if (group.events.every((event) => event.trade)
      && new Set(group.events.map((event) => sourceEventKey(event.trade!))).size === 1) continue;
    const ordered = [...group.events].sort((a, b) => a.chainOrder && b.chainOrder ? compareChainOrder(a.chainOrder, b.chainOrder) : 0);
    const proven = ordered.every((event, index) => {
      if (!event.chainOrder) return false;
      if (index === 0) return true;
      const previous = ordered[index - 1]!.chainOrder!;
      if (!previous) return false;
      if (compareChainOrder(previous, event.chainOrder) === 0) return false;
      return previous.blockNumber !== event.chainOrder.blockNumber
        || previous.transactionIndex !== event.chainOrder.transactionIndex
        || BigInt(previous.lastLogIndex) < BigInt(event.chainOrder.logIndex);
    });
    if (!proven) ambiguities.push({
      sourceTimestamp: group.sourceTimestamp, conditionId: group.conditionId,
      sourceEventKeys: group.events.map((event) => event.sourceEventKey).sort(),
    });
  }
  return {
    ordered: [...events].sort((a, b) => a.sourceTimestamp - b.sourceTimestamp || (
      a.chainOrder && b.chainOrder ? compareChainOrder(a.chainOrder, b.chainOrder) : Number(Boolean(b.chainOrder)) - Number(Boolean(a.chainOrder))
    ) || a.sourceEventKey.localeCompare(b.sourceEventKey)),
    ambiguities,
  };
}
