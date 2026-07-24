import { createHash } from "node:crypto";
import { decimalToScaled, PRICE_SCALE_DIGITS, SHARE_SCALE_DIGITS } from "../domain/fixed.js";
import { sourceEventKey } from "../domain/idempotency.js";
import { stableJson } from "../domain/versioning.js";
import { effectiveTargetSellRatio } from "../execution/target-sell-policy.js";
import type { ObserveBaseline, ObserveEvent, ObserveProjectionEntry, ObserveProjectionResult, ObserveSignal } from "./types.js";

export const OBSERVE_SIGNAL_VERSION = "observe-v1.5.0";

function signalKey(baselineRunId: string, sourceEventKey: string, type: string, asset = ""): string {
  const identity = [OBSERVE_SIGNAL_VERSION, baselineRunId, sourceEventKey, type];
  if (asset) identity.push(asset);
  return createHash("sha256")
    .update(identity.join("\u001f"))
    .digest("hex");
}

export function mergeExitPrices(
  assets: string[],
  lastPriceByAsset: Map<string, bigint>,
): Map<string, bigint> {
  const prices = assets.map((asset) => ({ asset, price: lastPriceByAsset.get(asset) ?? 0n }));
  if (prices.some((item) => item.price <= 0n)) {
    return new Map(prices.filter((item) => item.price > 0n).map((item) => [item.asset, item.price]));
  }
  const scale = 10n ** BigInt(PRICE_SCALE_DIGITS);
  const total = prices.reduce((sum, item) => sum + item.price, 0n);
  if (total <= 0n) return new Map();
  const normalized = prices.map((item) => ({
    ...item,
    units: (item.price * scale) / total,
    remainder: (item.price * scale) % total,
  }));
  let undistributed = scale - normalized.reduce((sum, item) => sum + item.units, 0n);
  for (const item of [...normalized].sort((left, right) => (
    left.remainder === right.remainder
      ? left.asset.localeCompare(right.asset)
      : left.remainder > right.remainder ? -1 : 1
  ))) {
    if (undistributed <= 0n) break;
    item.units += 1n;
    undistributed -= 1n;
  }
  return new Map(normalized.map((item) => [item.asset, item.units]));
}

export function projectObserveEvents(
  baseline: ObserveBaseline,
  events: ObserveEvent[],
  options: {
    requireVerifiedConversions?: boolean;
    requireVerifiedSplits?: boolean;
    mergeOutcomeAssetsByCondition?: ReadonlyMap<string, readonly string[]>;
    pendingMergeConditions?: ReadonlySet<string>;
    followSellFullExitThresholdPpm?: number;
  } = {},
): ObserveProjectionResult {
  const followSellFullExitThresholdPpm = options.followSellFullExitThresholdPpm ?? 1_000_000;
  if (
    !Number.isSafeInteger(followSellFullExitThresholdPpm)
    || followSellFullExitThresholdPpm <= 0
    || followSellFullExitThresholdPpm > 1_000_000
  ) throw new Error("FOLLOW_SELL_FULL_EXIT_THRESHOLD_INVALID");
  const historical = new Map(baseline.items.map((item) => [item.asset, BigInt(item.sizeMicros)]));
  const tracked = new Map<string, bigint>();
  const conditionByAsset = new Map(baseline.items.map((item) => [item.asset, item.conditionId.toLowerCase()]));
  const lastEventByAsset = new Map<string, string>();
  const lastPriceByAsset = new Map<string, bigint>();
  const signals: ObserveSignal[] = [];
  const unsupportedActivities: ObserveProjectionResult["unsupportedActivities"] = [];
  let gapEventCount = 0;

  const allOrdered = [...events]
    .sort((a, b) => a.sourceTimestamp - b.sourceTimestamp || a.sourceEventKey.localeCompare(b.sourceEventKey));

  for (const event of allOrdered) {
    if (event.activity) {
      const conditionId = event.activity.conditionId?.toLowerCase();
      if (event.activity.type === "CONVERSION") {
        if (!event.conversion) {
          if (options.requireVerifiedConversions) {
            throw new Error(`NEGATIVE_RISK_CONVERSION_EVIDENCE_MISSING:${event.sourceEventKey}`);
          }
          continue;
        }
        const conversion = event.conversion;
        const sourceAsset = conversion.sourceAsset;
        const amount = BigInt(conversion.amountMicros);
        const beforeHistorical = historical.get(sourceAsset) ?? 0n;
        const beforeTracked = tracked.get(sourceAsset) ?? 0n;
        if (amount > beforeHistorical + beforeTracked) {
          throw new Error(`NEGATIVE_RISK_CONVERSION_SOURCE_BALANCE_INSUFFICIENT:${event.sourceEventKey}`);
        }
        const trackedConverted = amount < beforeTracked ? amount : beforeTracked;
        const historicalConverted = amount - trackedConverted;
        tracked.set(sourceAsset, beforeTracked - trackedConverted);
        historical.set(sourceAsset, beforeHistorical - historicalConverted);
        lastEventByAsset.set(sourceAsset, event.sourceEventKey);
        for (const destination of conversion.destinationAssets) {
          conditionByAsset.set(destination.asset, destination.conditionId);
          historical.set(
            destination.asset,
            (historical.get(destination.asset) ?? 0n) + historicalConverted + trackedConverted,
          );
          lastEventByAsset.set(destination.asset, event.sourceEventKey);
        }
        if (trackedConverted > 0n) {
          const sourcePrice = lastPriceByAsset.get(sourceAsset);
          const sourceConditionId = conditionByAsset.get(sourceAsset);
          if (!event.isGap && (!sourcePrice || sourcePrice <= 0n || !sourceConditionId)) {
            throw new Error(`NEGATIVE_RISK_CONVERSION_SOURCE_EXIT_EVIDENCE_MISSING:${event.sourceEventKey}`);
          }
          const id = signalKey(baseline.baselineRunId, event.sourceEventKey, "TARGET_SELL", sourceAsset);
          signals.push({
            signalId: id,
            targetId: baseline.targetId,
            signalIdempotencyKey: id,
            sourceEventKey: event.sourceEventKey,
            signalType: "TARGET_SELL",
            asset: sourceAsset,
            conditionId: sourceConditionId ?? conversion.groupConditionId,
            targetPriceUnits: (sourcePrice ?? 0n).toString(),
            targetSizeMicros: amount.toString(),
            sellRatioNumerator: trackedConverted.toString(),
            sellRatioDenominator: beforeTracked.toString(),
            reason: event.isGap
              ? "GAP_NEGATIVE_RISK_CONVERSION_SOURCE_EXIT_RECORDED"
              : "TARGET_CONVERSION_EQUIVALENT_SOURCE_EXIT",
            eventClassification: "NEGATIVE_RISK_CONVERSION",
            executionEligible: !event.isGap,
            executionBlockReason: event.isGap ? "GAP_EVENT" : null,
          });
        }
        continue;
      }
      if (event.activity.type === "SPLIT") {
        if (!event.split) {
          if (options.requireVerifiedSplits) {
            throw new Error(`SPLIT_PROJECTION_EVIDENCE_MISSING:${event.sourceEventKey}`);
          }
          unsupportedActivities.push({ sourceEventKey: event.sourceEventKey, activityType: "SPLIT" });
          continue;
        }
        for (const asset of event.split.outcomeAssets) {
          conditionByAsset.set(asset, event.split.conditionId);
          historical.set(asset, (historical.get(asset) ?? 0n) + BigInt(event.split.amountMicros));
          lastEventByAsset.set(asset, event.sourceEventKey);
        }
        continue;
      }
      if (event.activity.type === "MERGE") {
        let amount: bigint | null = null;
        try {
          if (event.activity.size !== undefined) {
            amount = decimalToScaled(event.activity.size, SHARE_SCALE_DIGITS);
          }
        } catch {
          amount = null;
        }
        if (!conditionId || amount === null || amount <= 0n) {
          unsupportedActivities.push({ sourceEventKey: event.sourceEventKey, activityType: "MERGE" });
          continue;
        }
        const assets = [...conditionByAsset.entries()]
          .filter(([asset, knownConditionId]) => (
            knownConditionId === conditionId
            && (historical.get(asset) ?? 0n) + (tracked.get(asset) ?? 0n) > 0n
          ))
          .map(([asset]) => asset)
          .sort();
        if (assets.length !== 2 || assets.some((asset) => (
          (historical.get(asset) ?? 0n) + (tracked.get(asset) ?? 0n) < amount!
        ))) {
          unsupportedActivities.push({ sourceEventKey: event.sourceEventKey, activityType: "MERGE" });
          continue;
        }
        const trackedByAsset = new Map(assets.map((asset) => {
          const beforeTracked = tracked.get(asset) ?? 0n;
          return [asset, amount! < beforeTracked ? amount! : beforeTracked];
        }));
        const exitPrices = mergeExitPrices(assets, lastPriceByAsset);
        const pendingOutcomeSet = options.pendingMergeConditions?.has(conditionId) === true;
        const officialAssets = options.mergeOutcomeAssetsByCondition?.get(conditionId);
        const authoritativeOutcomeSetRequired = options.mergeOutcomeAssetsByCondition !== undefined;
        const authoritativeOutcomeSetInvalid = authoritativeOutcomeSetRequired
          && !pendingOutcomeSet
          && (
            officialAssets === undefined
            || officialAssets.length !== 2
            || [...officialAssets].sort().some((asset, index) => asset !== assets[index])
          );
        const unpricedTrackedExit = !event.isGap && assets.some((asset) => (
          (trackedByAsset.get(asset) ?? 0n) > 0n && !exitPrices.has(asset)
        ));
        for (const asset of assets) {
          const beforeTracked = tracked.get(asset) ?? 0n;
          const beforeHistorical = historical.get(asset) ?? 0n;
          const trackedMerged = trackedByAsset.get(asset) ?? 0n;
          const historicalMerged = amount - trackedMerged;
          tracked.set(asset, beforeTracked - trackedMerged);
          historical.set(asset, beforeHistorical - historicalMerged);
          lastEventByAsset.set(asset, event.sourceEventKey);
        }
        if (pendingOutcomeSet) continue;
        if (authoritativeOutcomeSetInvalid) {
          unsupportedActivities.push({ sourceEventKey: event.sourceEventKey, activityType: "MERGE" });
          continue;
        }
        if (unpricedTrackedExit) {
          unsupportedActivities.push({ sourceEventKey: event.sourceEventKey, activityType: "MERGE" });
          continue;
        }
        for (const asset of assets) {
          const trackedMerged = trackedByAsset.get(asset) ?? 0n;
          if (trackedMerged <= 0n) continue;
          const beforeTracked = trackedMerged + (tracked.get(asset) ?? 0n);
          const id = signalKey(baseline.baselineRunId, event.sourceEventKey, "TARGET_SELL", asset);
          signals.push({
            signalId: id,
            targetId: baseline.targetId,
            signalIdempotencyKey: id,
            sourceEventKey: event.sourceEventKey,
            signalType: "TARGET_SELL",
            asset,
            conditionId,
            targetPriceUnits: (exitPrices.get(asset) ?? 0n).toString(),
            targetSizeMicros: amount.toString(),
            sellRatioNumerator: trackedMerged.toString(),
            sellRatioDenominator: beforeTracked.toString(),
            reason: event.isGap ? "GAP_MERGE_EXIT_RECORDED" : "TARGET_MERGE_EQUIVALENT_EXIT",
            eventClassification: "COMBO_ACTIVITY",
            executionEligible: !event.isGap,
            executionBlockReason: event.isGap ? "GAP_EVENT" : null,
            requiredMarketOutcomeAssets: assets,
          });
        }
        continue;
      }
      if (event.activity.type === "REDEEM" && conditionId) {
        for (const [asset, knownConditionId] of conditionByAsset) {
          if (knownConditionId !== conditionId) continue;
          historical.set(asset, 0n);
          tracked.set(asset, 0n);
          lastEventByAsset.set(asset, event.sourceEventKey);
        }
      }
      continue;
    }
    if (event.isCombo) continue;
    const trade = event.trade!;
    const tradeExecutionConfirmed = event.activityConfirmed
      || event.sourceType === "POLYGON_ORDER_FILLED";
    // Occurrence zero keeps the legacy event key. A later byte-identical Trade
    // occurrence has no upstream row id, so it may affect projection/signals
    // only after Activity or an exact official OrderFilled log confirms it.
    if (event.sourceEventKey !== sourceEventKey(trade) && !tradeExecutionConfirmed) continue;
    conditionByAsset.set(trade.asset, trade.conditionId.toLowerCase());
    const size = decimalToScaled(trade.size, SHARE_SCALE_DIGITS);
    lastPriceByAsset.set(trade.asset, decimalToScaled(trade.price, PRICE_SCALE_DIGITS));
    const beforeHistorical = historical.get(trade.asset) ?? 0n;
    const beforeTracked = tracked.get(trade.asset) ?? 0n;
    lastEventByAsset.set(trade.asset, event.sourceEventKey);
    if (trade.side === "BUY") {
      if (event.isGap) historical.set(trade.asset, beforeHistorical + size);
      else tracked.set(trade.asset, beforeTracked + size);
      if (!tradeExecutionConfirmed) continue;
      const id = signalKey(baseline.baselineRunId, event.sourceEventKey, "TARGET_BUY");
      signals.push({
        signalId: id,
        targetId: baseline.targetId,
        signalIdempotencyKey: id,
        sourceEventKey: event.sourceEventKey,
        signalType: "TARGET_BUY",
        asset: trade.asset,
        conditionId: trade.conditionId.toLowerCase(),
        targetPriceUnits: decimalToScaled(trade.price, PRICE_SCALE_DIGITS).toString(),
        targetSizeMicros: size.toString(),
        sellRatioNumerator: null,
        sellRatioDenominator: null,
        reason: event.isGap ? "GAP_EVENT_RECORDED" : "POST_BASELINE_BUY",
        eventClassification: event.isGap ? "GAP_TRADE" : "STANDARD_TRADE",
        executionEligible: !event.isGap,
        executionBlockReason: event.isGap ? "GAP_EVENT" : null,
      });
      continue;
    }

    const recognizedSell = size < beforeTracked ? size : beforeTracked;
    const followedSell = beforeTracked > 0n
      ? effectiveTargetSellRatio({
        numerator: recognizedSell,
        denominator: beforeTracked,
        fullExitThresholdPpm: followSellFullExitThresholdPpm,
      }).numerator
      : 0n;
    const reclassifiedResidual = followedSell - recognizedSell;
    tracked.set(trade.asset, beforeTracked - followedSell);
    const remaining = size - recognizedSell;
    const historicalSell = remaining < beforeHistorical ? remaining : beforeHistorical;
    historical.set(trade.asset, beforeHistorical - historicalSell + reclassifiedResidual);
    if (!tradeExecutionConfirmed) continue;
    if (event.isGap || beforeTracked > 0n) {
      const id = signalKey(baseline.baselineRunId, event.sourceEventKey, "TARGET_SELL");
      signals.push({
        signalId: id,
        targetId: baseline.targetId,
        signalIdempotencyKey: id,
        sourceEventKey: event.sourceEventKey,
        signalType: "TARGET_SELL",
        asset: trade.asset,
        conditionId: trade.conditionId.toLowerCase(),
        targetPriceUnits: decimalToScaled(trade.price, PRICE_SCALE_DIGITS).toString(),
        targetSizeMicros: size.toString(),
        sellRatioNumerator: beforeTracked > 0n ? followedSell.toString() : null,
        sellRatioDenominator: beforeTracked > 0n ? beforeTracked.toString() : null,
        reason: event.isGap ? "GAP_EVENT_RECORDED" : "RECOGNIZED_POSITION_SELL",
        eventClassification: event.isGap ? "GAP_TRADE" : "STANDARD_TRADE",
        executionEligible: !event.isGap,
        executionBlockReason: event.isGap ? "GAP_EVENT" : null,
      });
    }
  }

  const assets = new Set([...historical.keys(), ...tracked.keys()]);
  const projection: ObserveProjectionEntry[] = [...assets]
    .map((asset) => {
      const historicalMicros = historical.get(asset) ?? 0n;
      const trackedMicros = tracked.get(asset) ?? 0n;
      return {
        asset,
        historicalMicros: historicalMicros.toString(),
        trackedMicros: trackedMicros.toString(),
        expectedTotalMicros: (historicalMicros + trackedMicros).toString(),
        lastSourceEventKey: lastEventByAsset.get(asset) ?? null,
      };
    })
    .filter((entry) => BigInt(entry.expectedTotalMicros) !== 0n)
    .sort((a, b) => a.asset.localeCompare(b.asset));
  for (const event of allOrdered) {
    if (event.isGap) gapEventCount += 1;
  }
  const last = allOrdered.at(-1);
  return {
    signals,
    projection,
    unsupportedActivities,
    projectionHash: createHash("sha256").update(stableJson(projection)).digest("hex"),
    lastProcessedTimestamp: last?.sourceTimestamp ?? null,
    lastProcessedEventId: last?.sourceEventKey ?? null,
    gapEventCount,
  };
}
