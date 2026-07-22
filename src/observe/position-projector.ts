import { createHash } from "node:crypto";
import { decimalToScaled, PRICE_SCALE_DIGITS, SHARE_SCALE_DIGITS } from "../domain/fixed.js";
import { sourceEventKey } from "../domain/idempotency.js";
import { stableJson } from "../domain/versioning.js";
import type { ObserveBaseline, ObserveEvent, ObserveProjectionEntry, ObserveProjectionResult, ObserveSignal } from "./types.js";

export const OBSERVE_SIGNAL_VERSION = "observe-v1.1.0";

function signalKey(baselineRunId: string, sourceEventKey: string, type: string): string {
  return createHash("sha256")
    .update([OBSERVE_SIGNAL_VERSION, baselineRunId, sourceEventKey, type].join("\u001f"))
    .digest("hex");
}

export function projectObserveEvents(
  baseline: ObserveBaseline,
  events: ObserveEvent[],
  options: { requireVerifiedConversions?: boolean } = {},
): ObserveProjectionResult {
  const historical = new Map(baseline.items.map((item) => [item.asset, BigInt(item.sizeMicros)]));
  const tracked = new Map<string, bigint>();
  const conditionByAsset = new Map(baseline.items.map((item) => [item.asset, item.conditionId.toLowerCase()]));
  const lastEventByAsset = new Map<string, string>();
  const signals: ObserveSignal[] = [];
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
            (historical.get(destination.asset) ?? 0n) + historicalConverted,
          );
          tracked.set(
            destination.asset,
            (tracked.get(destination.asset) ?? 0n) + trackedConverted,
          );
          lastEventByAsset.set(destination.asset, event.sourceEventKey);
        }
        if (trackedConverted > 0n) {
          const id = signalKey(baseline.baselineRunId, event.sourceEventKey, "TARGET_CONVERSION");
          signals.push({
            signalId: id,
            targetId: baseline.targetId,
            signalIdempotencyKey: id,
            sourceEventKey: event.sourceEventKey,
            signalType: "TARGET_CONVERSION",
            asset: sourceAsset,
            conditionId: conversion.groupConditionId,
            targetPriceUnits: "0",
            targetSizeMicros: amount.toString(),
            sellRatioNumerator: trackedConverted.toString(),
            sellRatioDenominator: beforeTracked.toString(),
            reason: event.isGap
              ? "GAP_NEGATIVE_RISK_CONVERSION_RECORDED"
              : "TRACKED_NEGATIVE_RISK_CONVERSION_RECORDED",
            eventClassification: "NEGATIVE_RISK_CONVERSION",
            executionEligible: false,
            executionBlockReason: event.isGap
              ? "GAP_NEGATIVE_RISK_CONVERSION_UNFOLLOWED"
              : "NEGATIVE_RISK_CONVERSION_EXECUTION_UNAVAILABLE",
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
    // Occurrence zero keeps the legacy event key. A later byte-identical Trade
    // occurrence has no upstream row id, so it may affect projection/signals
    // only after the independent Activity feed confirms the same occurrence.
    if (event.sourceEventKey !== sourceEventKey(trade) && !event.activityConfirmed) continue;
    conditionByAsset.set(trade.asset, trade.conditionId.toLowerCase());
    const size = decimalToScaled(trade.size, SHARE_SCALE_DIGITS);
    const beforeHistorical = historical.get(trade.asset) ?? 0n;
    const beforeTracked = tracked.get(trade.asset) ?? 0n;
    lastEventByAsset.set(trade.asset, event.sourceEventKey);
    if (trade.side === "BUY") {
      if (event.isGap) historical.set(trade.asset, beforeHistorical + size);
      else tracked.set(trade.asset, beforeTracked + size);
      if (!event.activityConfirmed) continue;
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
    tracked.set(trade.asset, beforeTracked - recognizedSell);
    const remaining = size - recognizedSell;
    const historicalSell = remaining < beforeHistorical ? remaining : beforeHistorical;
    historical.set(trade.asset, beforeHistorical - historicalSell);
    if (!event.activityConfirmed) continue;
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
        sellRatioNumerator: beforeTracked > 0n ? recognizedSell.toString() : null,
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
    projectionHash: createHash("sha256").update(stableJson(projection)).digest("hex"),
    lastProcessedTimestamp: last?.sourceTimestamp ?? null,
    lastProcessedEventId: last?.sourceEventKey ?? null,
    gapEventCount,
  };
}
