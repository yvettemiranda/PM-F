import { createHash } from "node:crypto";
import { decimalToScaled, PRICE_SCALE_DIGITS, SHARE_SCALE_DIGITS } from "../domain/fixed.js";
import {
  activityEventKey,
  resolveSourceEventMultiplicity,
  signalIdempotencyKey,
} from "../domain/idempotency.js";
import type { EventClassification, IdentityStatus, PublicActivity, PublicTrade, Signal, SourceEvent } from "../domain/models.js";
import { activityAsTrade } from "../domain/activity-trade.js";
import { RULESET, VERSIONS, stableJson } from "../domain/versioning.js";
import { effectiveTargetSellRatio } from "../execution/target-sell-policy.js";
import { mergeExitPrices } from "../observe/position-projector.js";

export interface ReplayGap {
  fromTimestamp: number;
  toTimestamp: number;
}

export interface ReplayInput {
  targetId: string;
  walletAddress: string;
  identityStatus: IdentityStatus;
  trades: PublicTrade[];
  activity: PublicActivity[];
  gaps?: ReplayGap[];
  hasCapitalSnapshots?: boolean;
  hasGoldenExpectations?: boolean;
  hasPositionBaseline?: boolean;
  tradeHistoryComplete?: boolean;
  activityHistoryComplete?: boolean;
  sourceCodeCommit?: string;
  sourceCodeDirty?: boolean;
  positionBaseline?: Array<{ asset: string; size: number | string }>;
  tradePaginationBoundaryOverlaps?: PublicTrade[];
  activityPaginationBoundaryOverlaps?: PublicTrade[];
  confirmedTradeOccurrenceCounts?: Readonly<Record<string, number>>;
  verifiedMarketOutcomeAssetsByCondition?: Readonly<Record<string, readonly string[]>>;
}

export interface ReplayReport {
  status: "PASSED" | "FAILED" | "INCOMPLETE";
  reportHash: string;
  metrics: {
    inputRows: number;
    uniqueEvents: number;
    duplicateRows: number;
    confirmedDuplicateRows: number;
    reconciledPaginationOverlapRows: number;
    ambiguousEvents: number;
    buySignals: number;
    sellSignals: number;
    historicalSells: number;
    gapEvents: number;
    comboEvents: number;
    capitalIncompleteSignals: number;
    finalRecognizedPositions: Record<string, string>;
    finalHistoricalPositions: Record<string, string>;
  };
  signals: SerializedSignal[];
  eventOutcomes: Record<string, ReplayEventOutcome>;
  positionLedger: ReplayPositionLedgerEntry[];
  incompleteReasons: string[];
}

export interface ReplayPositionLedgerEntry {
  sourceEventKey: string;
  asset: string;
  historicalBeforeMicros: string;
  historicalAfterMicros: string;
  trackedBeforeMicros: string;
  trackedAfterMicros: string;
  recognizedSellMicros: string;
  reason: string;
}

export interface ReplayEventOutcome {
  eventClassification: EventClassification;
  signalId?: string;
  signalIds?: string[];
  signalType?: "TARGET_BUY" | "TARGET_SELL";
  executionEligible?: boolean;
  reason: string;
}

export interface SerializedSignal {
  signalId: string;
  targetId: string;
  signalIdempotencyKey: string;
  signalType: "TARGET_BUY" | "TARGET_SELL";
  status: "CREATED" | "VALIDATING" | "READY" | "PUBLISHED" | "REJECTED" | "CANCELLED";
  sourceEventKey: string;
  walletAddress: string;
  asset: string;
  conditionId: string;
  targetPriceUnits: string;
  targetSizeMicros: string;
  sellRatioNumerator?: string;
  sellRatioDenominator?: string;
  reason: string;
  eventClassification: EventClassification;
  executionEligible: boolean;
  executionBlockReason?: string;
}

function insideGap(timestamp: number, gaps: readonly ReplayGap[]): boolean {
  return gaps.some((gap) => timestamp >= gap.fromTimestamp && timestamp <= gap.toTimestamp);
}

function activityKey(activity: PublicActivity): string {
  return [activity.transactionHash.toLowerCase(), activity.asset ?? "", activity.side ?? "", activity.timestamp].join("|");
}

function isTradeActivity(activity: PublicActivity): activity is PublicActivity & PublicTrade {
  return activityAsTrade(activity) !== null;
}

export class ReplayEngine {
  run(input: ReplayInput): ReplayReport {
    if (!input.targetId.trim()) throw new Error("REPLAY_TARGET_ID_REQUIRED");
    if (input.identityStatus !== "IDENTITY_CONFIRMED") {
      return this.finish("FAILED", input.trades.length + input.activity.length, [], {}, [], 0, 0, 0, 0, 0, 0, 0, 0, 0, {}, {}, ["WALLET_IDENTITY_NOT_CONFIRMED"]);
    }

    const comboKeys = new Set(
      input.activity.filter((item) => isTradeActivity(item) && item.isCombo).map(activityKey),
    );
    const activityTradeRows = input.activity.flatMap((activity) => {
      const trade = activityAsTrade(activity);
      return trade ? [{ activity, trade }] : [];
    });
    const multiplicity = resolveSourceEventMultiplicity(
      input.trades,
      activityTradeRows.map((item) => item.trade),
      {
        ...(input.tradePaginationBoundaryOverlaps === undefined
          ? {}
          : { tradePaginationBoundaryOverlaps: input.tradePaginationBoundaryOverlaps }),
        ...(input.activityPaginationBoundaryOverlaps === undefined
          ? {}
          : { activityPaginationBoundaryOverlaps: input.activityPaginationBoundaryOverlaps }),
        ...(input.confirmedTradeOccurrenceCounts === undefined
          ? {}
          : { confirmedOccurrenceCounts: input.confirmedTradeOccurrenceCounts }),
      },
    );
    const confirmedRepeatedKeys = new Set(multiplicity.confirmedRepeatedKeys);
    const ambiguousRepeatedKeys = new Set(multiplicity.ambiguousRepeatedKeys);
    const events: SourceEvent[] = [];
    let duplicateRows = multiplicity.trades.filter((item) => item.occurrenceIndex > 0).length
      + multiplicity.activityTrades.filter((item) => item.occurrenceIndex > 0).length
      + multiplicity.reconciledPaginationOverlapRows;

    for (const { trade, sourceEventKey: key, occurrenceIndex } of multiplicity.trades) {
      if (occurrenceIndex > 0 && !confirmedRepeatedKeys.has(key)) continue;
      events.push({
        sourceEventKey: key,
        trade,
        priceUnits: decimalToScaled(trade.price, PRICE_SCALE_DIGITS),
        sizeMicros: decimalToScaled(trade.size, SHARE_SCALE_DIGITS),
        gapEvent: insideGap(trade.timestamp, input.gaps ?? []),
        isCombo: comboKeys.has([trade.transactionHash.toLowerCase(), trade.asset, trade.side, trade.timestamp].join("|")),
      });
    }
    const eventByKey = new Map(events.map((event) => [event.sourceEventKey, event]));

    // Activity can lead Trades or remain the only available source when the
    // historical Trades endpoint is truncated. Merge both sources by the same
    // source_event_key instead of silently discarding Activity-only trades.
    for (const [index, { trade, sourceEventKey: key, occurrenceIndex }] of multiplicity.activityTrades.entries()) {
      if (occurrenceIndex > 0 && !confirmedRepeatedKeys.has(key)) continue;
      const activity = activityTradeRows[index]!.activity;
      const existing = eventByKey.get(key);
      if (existing) {
        existing.isCombo = existing.isCombo || activity.isCombo === true;
        continue;
      }
      events.push({
        sourceEventKey: key,
        trade,
        priceUnits: decimalToScaled(trade.price, PRICE_SCALE_DIGITS),
        sizeMicros: decimalToScaled(trade.size, SHARE_SCALE_DIGITS),
        gapEvent: insideGap(trade.timestamp, input.gaps ?? []),
        isCombo: activity.isCombo === true,
      });
      eventByKey.set(key, events.at(-1)!);
    }

    events.sort((a, b) => a.trade.timestamp - b.trade.timestamp || a.sourceEventKey.localeCompare(b.sourceEventKey));

    const trackedPositions = new Map<string, bigint>();
    const historicalPositions = new Map<string, bigint>();
    const conditionByAsset = new Map<string, string>();
    const lastPriceByAsset = new Map<string, bigint>();
    for (const baseline of input.positionBaseline ?? []) {
      historicalPositions.set(baseline.asset, decimalToScaled(baseline.size, SHARE_SCALE_DIGITS));
    }
    const signals: Signal[] = [];
    const eventOutcomes: Record<string, ReplayEventOutcome> = {};
    const positionLedger: ReplayPositionLedgerEntry[] = [];
    const officialNonTradeTypes = new Set(["SPLIT", "MERGE", "REDEEM", "REWARD", "CONVERSION", "MAKER_REBATE", "REFERRAL_REWARD"]);
    for (const key of ambiguousRepeatedKeys) {
      eventOutcomes[key] = {
        eventClassification: "UNRECOGNIZED",
        reason: "AMBIGUOUS_IDENTICAL_TRADE_OCCURRENCE",
      };
    }
    let historicalSells = 0;
    let gapEvents = 0;
    let comboEvents = 0;
    const activityIncompleteReasons = new Set<string>();
    const uniqueNonTradeActivities = new Map<string, PublicActivity>();
    for (const activity of input.activity.filter((item) => !isTradeActivity(item))) {
      const key = activityEventKey(activity);
      if (uniqueNonTradeActivities.has(key)) {
        duplicateRows += 1;
      } else {
        uniqueNonTradeActivities.set(key, activity);
      }
    }
    const orderedItems = [
      ...events.map((event) => ({
        kind: "TRADE" as const,
        timestamp: event.trade.timestamp,
        sourceEventKey: event.sourceEventKey,
        event,
      })),
      ...[...uniqueNonTradeActivities.entries()].map(([sourceEventKey, activity]) => ({
        kind: "ACTIVITY" as const,
        timestamp: activity.timestamp,
        sourceEventKey,
        activity,
      })),
    ].sort((left, right) => (
      left.timestamp - right.timestamp || left.sourceEventKey.localeCompare(right.sourceEventKey)
    ));

    for (const ordered of orderedItems) {
      if (ordered.kind === "ACTIVITY") {
        const activity = ordered.activity;
        const key = ordered.sourceEventKey;
        const conditionId = activity.conditionId?.toLowerCase();
        if (activity.type === "MERGE") {
          comboEvents += 1;
          let amount: bigint | null = null;
          try {
            if (activity.size !== undefined) amount = decimalToScaled(activity.size, SHARE_SCALE_DIGITS);
          } catch {
            amount = null;
          }
          const visibleAssets = conditionId ? [...conditionByAsset.entries()]
            .filter(([asset, knownConditionId]) => (
              knownConditionId === conditionId
              && (trackedPositions.get(asset) ?? 0n) + (historicalPositions.get(asset) ?? 0n) > 0n
            ))
            .map(([asset]) => asset)
            .sort() : [];
          const officialAssets = conditionId
            ? input.verifiedMarketOutcomeAssetsByCondition?.[conditionId]
            : undefined;
          const sortedOfficialAssets = officialAssets === undefined ? undefined : [...officialAssets].sort();
          const historyTruncated = input.tradeHistoryComplete === false || input.activityHistoryComplete === false;
          const canReconcileTruncatedHistory = historyTruncated
            && amount !== null
            && amount > 0n
            && sortedOfficialAssets !== undefined
            && sortedOfficialAssets.length === 2
            && new Set(sortedOfficialAssets).size === 2
            && sortedOfficialAssets.every((asset) => asset.trim().length > 0)
            && visibleAssets.every((asset) => sortedOfficialAssets.includes(asset));
          const assets = canReconcileTruncatedHistory ? sortedOfficialAssets : visibleAssets;
          let reconciledTruncatedHistory = false;
          if (canReconcileTruncatedHistory) {
            for (const asset of assets) {
              const tracked = trackedPositions.get(asset) ?? 0n;
              const historical = historicalPositions.get(asset) ?? 0n;
              const missingHistorical = amount! - tracked - historical;
              if (missingHistorical <= 0n) continue;
              historicalPositions.set(asset, historical + missingHistorical);
              reconciledTruncatedHistory = true;
            }
          }
          const structurallyUnsupported = amount === null || amount <= 0n || assets.length !== 2 || assets.some((asset) => (
            (trackedPositions.get(asset) ?? 0n) + (historicalPositions.get(asset) ?? 0n) < amount!
          ));
          const authoritativeOutcomeSetInvalid = officialAssets === undefined
            || officialAssets.length !== 2
            || [...officialAssets].sort().some((asset, index) => asset !== assets[index]);
          const exitPrices = structurallyUnsupported ? new Map<string, bigint>() : mergeExitPrices(assets, lastPriceByAsset);
          const gapEvent = insideGap(activity.timestamp, input.gaps ?? []);
          const unpricedTrackedExit = !gapEvent && !structurallyUnsupported && assets.some((asset) => (
            (trackedPositions.get(asset) ?? 0n) > 0n && !exitPrices.has(asset)
          ));
          if (structurallyUnsupported) {
            eventOutcomes[key] = {
              eventClassification: "COMBO_ACTIVITY",
              reason: "MERGE_UNSUPPORTED_TARGET_ACTIVITY",
            };
            activityIncompleteReasons.add("UNSUPPORTED_TARGET_ACTIVITY:MERGE");
            continue;
          }
          const mergeSignals: Signal[] = [];
          for (const asset of assets) {
            const beforeTracked = trackedPositions.get(asset) ?? 0n;
            const beforeHistorical = historicalPositions.get(asset) ?? 0n;
            const trackedMerged = amount! < beforeTracked ? amount! : beforeTracked;
            const historicalMerged = amount! - trackedMerged;
            trackedPositions.set(asset, beforeTracked - trackedMerged);
            historicalPositions.set(asset, beforeHistorical - historicalMerged);
            const syntheticEvent: SourceEvent = {
              sourceEventKey: key,
              trade: {
                proxyWallet: activity.proxyWallet,
                transactionHash: activity.transactionHash,
                conditionId: conditionId!,
                asset,
                side: "SELL",
                price: "0",
                size: activity.size!,
                timestamp: activity.timestamp,
              },
              priceUnits: exitPrices.get(asset) ?? 0n,
              sizeMicros: amount!,
              gapEvent,
              isCombo: true,
            };
            if (trackedMerged > 0n && !unpricedTrackedExit && !authoritativeOutcomeSetInvalid) {
              const signal = this.signal(
                input.targetId,
                syntheticEvent,
                "TARGET_SELL",
                gapEvent ? "GAP_MERGE_EXIT_RECORDED" : "TARGET_MERGE_EQUIVALENT_EXIT",
                "COMBO_ACTIVITY",
                !gapEvent,
                gapEvent ? "GAP_EVENT" : undefined,
                trackedMerged,
                beforeTracked,
                asset,
              );
              signals.push(signal);
              mergeSignals.push(signal);
            }
            positionLedger.push(this.ledger(
              syntheticEvent,
              beforeHistorical,
              beforeHistorical - historicalMerged,
              beforeTracked,
              beforeTracked - trackedMerged,
              trackedMerged,
              gapEvent
                ? "GAP_MERGE_TRACKED_FIRST_NO_EXECUTION"
                : authoritativeOutcomeSetInvalid
                  ? "UNVERIFIED_MERGE_OUTCOME_SET_NO_EXECUTION"
                  : unpricedTrackedExit
                    ? "UNPRICED_MERGE_TRACKED_FIRST_NO_EXECUTION"
                    : reconciledTruncatedHistory
                      ? "TARGET_MERGE_TRACKED_FIRST_WITH_TRUNCATED_HISTORY_RECONCILIATION"
                      : "TARGET_MERGE_TRACKED_FIRST",
            ));
          }
          if (unpricedTrackedExit || authoritativeOutcomeSetInvalid) {
            eventOutcomes[key] = {
              eventClassification: "COMBO_ACTIVITY",
              reason: "MERGE_UNSUPPORTED_TARGET_ACTIVITY",
            };
            activityIncompleteReasons.add("UNSUPPORTED_TARGET_ACTIVITY:MERGE");
            continue;
          }
          if (gapEvent) gapEvents += 1;
          eventOutcomes[key] = mergeSignals.length > 0
            ? { ...this.outcome(mergeSignals[0]!), signalIds: mergeSignals.map((signal) => signal.signalId) }
            : { eventClassification: "COMBO_ACTIVITY", reason: "HISTORICAL_MERGE_PROJECTED" };
          continue;
        }
        if (activity.type === "REDEEM") {
          if (conditionId) {
            for (const [asset, knownConditionId] of conditionByAsset) {
              if (knownConditionId !== conditionId) continue;
              historicalPositions.set(asset, 0n);
              trackedPositions.set(asset, 0n);
            }
          }
          eventOutcomes[key] = { eventClassification: "NON_TRADE_ACTIVITY", reason: "REDEEM_PROJECTED" };
          continue;
        }
        if (activity.type === "SPLIT" || activity.type === "CONVERSION") {
          comboEvents += 1;
          eventOutcomes[key] = { eventClassification: "COMBO_ACTIVITY", reason: `${activity.type}_RECORDED_WITHOUT_SIGNAL` };
          activityIncompleteReasons.add(`UNSUPPORTED_TARGET_ACTIVITY:${activity.type}`);
          continue;
        }
        eventOutcomes[key] = officialNonTradeTypes.has(activity.type)
          ? { eventClassification: "NON_TRADE_ACTIVITY", reason: `${activity.type}_RECORDED_WITHOUT_SIGNAL` }
          : { eventClassification: "UNRECOGNIZED", reason: `UNRECOGNIZED_ACTIVITY_TYPE:${activity.type}` };
        continue;
      }
      const event = ordered.event;
      const beforeTracked = trackedPositions.get(event.trade.asset) ?? 0n;
      const beforeHistorical = historicalPositions.get(event.trade.asset) ?? 0n;
      if (event.isCombo) {
        comboEvents += 1;
        eventOutcomes[event.sourceEventKey] = {
          eventClassification: "COMBO_ACTIVITY",
          reason: "COMBO_RECORDED_WITHOUT_SIGNAL",
        };
        positionLedger.push(this.ledger(event, beforeHistorical, beforeHistorical, beforeTracked, beforeTracked, 0n, "COMBO_NO_PROJECTION"));
        continue;
      }
      conditionByAsset.set(event.trade.asset, event.trade.conditionId.toLowerCase());
      lastPriceByAsset.set(event.trade.asset, event.priceUnits);
      if (event.gapEvent) gapEvents += 1;

      if (event.trade.side === "BUY") {
        if (event.gapEvent) {
          historicalPositions.set(event.trade.asset, beforeHistorical + event.sizeMicros);
          const signal = this.signal(input.targetId, event, "TARGET_BUY", "GAP_EVENT_RECORDED", "GAP_TRADE", false, "GAP_EVENT");
          signals.push(signal);
          eventOutcomes[event.sourceEventKey] = this.outcome(signal);
          positionLedger.push(this.ledger(
            event,
            beforeHistorical,
            beforeHistorical + event.sizeMicros,
            beforeTracked,
            beforeTracked,
            0n,
            "GAP_BUY_TO_HISTORICAL_BUCKET",
          ));
        } else {
          trackedPositions.set(event.trade.asset, beforeTracked + event.sizeMicros);
          const signal = this.signal(input.targetId, event, "TARGET_BUY", "POST_BASELINE_BUY", "STANDARD_TRADE", true);
          signals.push(signal);
          eventOutcomes[event.sourceEventKey] = this.outcome(signal);
          positionLedger.push(this.ledger(
            event,
            beforeHistorical,
            beforeHistorical,
            beforeTracked,
            beforeTracked + event.sizeMicros,
            0n,
            "POST_BASELINE_BUY_TO_TRACKED_BUCKET",
          ));
        }
        continue;
      }

      const recognizedSell = event.sizeMicros < beforeTracked ? event.sizeMicros : beforeTracked;
      const followedSell = beforeTracked > 0n
        ? effectiveTargetSellRatio({
          numerator: recognizedSell,
          denominator: beforeTracked,
          fullExitThresholdPpm: RULESET.followSellFullExitThresholdPpm,
        }).numerator
        : 0n;
      const reclassifiedResidual = followedSell - recognizedSell;
      trackedPositions.set(event.trade.asset, beforeTracked - followedSell);
      const historicalSell = event.sizeMicros - recognizedSell < beforeHistorical
        ? event.sizeMicros - recognizedSell
        : beforeHistorical;
      const historicalAfter = beforeHistorical - historicalSell + reclassifiedResidual;
      historicalPositions.set(event.trade.asset, historicalAfter);
      if (event.gapEvent) {
        const signal = this.signal(
          input.targetId,
          event,
          "TARGET_SELL",
          "GAP_EVENT_RECORDED",
          "GAP_TRADE",
          false,
          "GAP_EVENT",
          beforeTracked === 0n ? undefined : followedSell,
          beforeTracked === 0n ? undefined : beforeTracked,
        );
        signals.push(signal);
        eventOutcomes[event.sourceEventKey] = this.outcome(signal);
      } else if (beforeTracked === 0n) {
        historicalSells += 1;
        eventOutcomes[event.sourceEventKey] = {
          eventClassification: "HISTORICAL_POSITION_SELL",
          reason: "NO_POST_BASELINE_POSITION",
        };
      } else {
        const signal = this.signal(
          input.targetId,
          event,
          "TARGET_SELL",
          "RECOGNIZED_POSITION_SELL",
          "STANDARD_TRADE",
          true,
          undefined,
          followedSell,
          beforeTracked,
        );
        signals.push(signal);
        eventOutcomes[event.sourceEventKey] = this.outcome(signal);
      }
      positionLedger.push(this.ledger(
        event,
        beforeHistorical,
        historicalAfter,
        beforeTracked,
        beforeTracked - followedSell,
        recognizedSell,
        event.gapEvent
          ? "GAP_SELL_TRACKED_FIRST_NO_EXECUTION"
          : beforeTracked === 0n
            ? "HISTORICAL_SELL_ONLY"
            : reclassifiedResidual > 0n
              ? "TRACKED_SELL_FULL_EXIT_THRESHOLD"
              : "TRACKED_FIRST_SELL",
      ));
    }

    const buySignals = signals.filter((signal) => signal.signalType === "TARGET_BUY").length;
    const confirmedDuplicateRows = confirmedRepeatedKeys.size;
    const ambiguousEvents = ambiguousRepeatedKeys.size;
    const incompleteReasons: string[] = [];
    if (!input.hasCapitalSnapshots) incompleteReasons.push("HISTORICAL_CAPITAL_SNAPSHOTS_MISSING");
    if (!input.hasGoldenExpectations) incompleteReasons.push("GOLDEN_EXPECTATIONS_MISSING");
    if ((input.hasPositionBaseline ?? true) === false) incompleteReasons.push("STARTING_POSITION_BASELINE_MISSING");
    if ((input.tradeHistoryComplete ?? true) === false) incompleteReasons.push("TRADE_HISTORY_TRUNCATED");
    if ((input.activityHistoryComplete ?? true) === false) incompleteReasons.push("ACTIVITY_HISTORY_TRUNCATED");
    if (input.sourceCodeCommit === "UNCOMMITTED") incompleteReasons.push("SOURCE_CODE_COMMIT_MISSING");
    if (input.sourceCodeDirty) incompleteReasons.push("SOURCE_CODE_DIRTY");
    if (ambiguousEvents > 0) incompleteReasons.push("AMBIGUOUS_DUPLICATE_EVENTS");
    incompleteReasons.push(...activityIncompleteReasons);
    const status = incompleteReasons.length > 0 ? "INCOMPLETE" : "PASSED";
    const finalTrackedPositions = Object.fromEntries(
      [...trackedPositions.entries()].filter(([, value]) => value !== 0n).map(([asset, value]) => [asset, value.toString()]),
    );
    const finalHistoricalPositions = Object.fromEntries(
      [...historicalPositions.entries()].filter(([, value]) => value !== 0n).map(([asset, value]) => [asset, value.toString()]),
    );

    return this.finish(
      status,
      input.trades.length + input.activity.length,
      signals,
      eventOutcomes,
      positionLedger,
      events.length + uniqueNonTradeActivities.size,
      duplicateRows,
      confirmedDuplicateRows,
      multiplicity.reconciledPaginationOverlapRows,
      ambiguousEvents,
      historicalSells,
      gapEvents,
      comboEvents,
      buySignals,
      finalTrackedPositions,
      finalHistoricalPositions,
      incompleteReasons,
    );
  }

  private signal(
    targetId: string,
    event: SourceEvent,
    type: "TARGET_BUY" | "TARGET_SELL",
    reason: string,
    eventClassification: EventClassification,
    executionEligible: boolean,
    executionBlockReason?: string,
    numerator?: bigint,
    denominator?: bigint,
    idempotencyDiscriminator?: string,
  ): Signal {
    const idempotency = signalIdempotencyKey(
      idempotencyDiscriminator
        ? `${event.sourceEventKey}\u001f${idempotencyDiscriminator}`
        : event.sourceEventKey,
      type,
      VERSIONS.signalVersion,
    );
    return {
      signalId: idempotency,
      targetId,
      signalIdempotencyKey: idempotency,
      signalType: type,
      status: "PUBLISHED",
      sourceEventKey: event.sourceEventKey,
      walletAddress: event.trade.proxyWallet.toLowerCase(),
      asset: event.trade.asset,
      conditionId: event.trade.conditionId.toLowerCase(),
      targetPriceUnits: event.priceUnits,
      targetSizeMicros: event.sizeMicros,
      ...(numerator === undefined ? {} : { sellRatioNumerator: numerator }),
      ...(denominator === undefined ? {} : { sellRatioDenominator: denominator }),
      reason,
      eventClassification,
      executionEligible,
      ...(executionBlockReason === undefined ? {} : { executionBlockReason }),
    };
  }

  private outcome(signal: Signal): ReplayEventOutcome {
    return {
      eventClassification: signal.eventClassification,
      signalId: signal.signalId,
      signalType: signal.signalType,
      executionEligible: signal.executionEligible,
      reason: signal.reason,
    };
  }

  private ledger(
    event: SourceEvent,
    historicalBefore: bigint,
    historicalAfter: bigint,
    trackedBefore: bigint,
    trackedAfter: bigint,
    recognizedSell: bigint,
    reason: string,
  ): ReplayPositionLedgerEntry {
    return {
      sourceEventKey: event.sourceEventKey,
      asset: event.trade.asset,
      historicalBeforeMicros: historicalBefore.toString(),
      historicalAfterMicros: historicalAfter.toString(),
      trackedBeforeMicros: trackedBefore.toString(),
      trackedAfterMicros: trackedAfter.toString(),
      recognizedSellMicros: recognizedSell.toString(),
      reason,
    };
  }

  private finish(
    status: ReplayReport["status"],
    inputRows: number,
    signals: Signal[],
    eventOutcomes: Record<string, ReplayEventOutcome>,
    positionLedger: ReplayPositionLedgerEntry[],
    uniqueEvents: number,
    duplicateRows: number,
    confirmedDuplicateRows: number,
    reconciledPaginationOverlapRows: number,
    ambiguousEvents: number,
    historicalSells: number,
    gapEvents: number,
    comboEvents: number,
    capitalIncompleteSignals: number,
    finalRecognizedPositions: Record<string, string>,
    finalHistoricalPositions: Record<string, string>,
    incompleteReasons: string[],
  ): ReplayReport {
    const serializedSignals: SerializedSignal[] = signals.map((signal) => ({
      signalId: signal.signalId,
      targetId: signal.targetId,
      signalIdempotencyKey: signal.signalIdempotencyKey,
      signalType: signal.signalType,
      status: signal.status,
      sourceEventKey: signal.sourceEventKey,
      walletAddress: signal.walletAddress,
      asset: signal.asset,
      conditionId: signal.conditionId,
      targetPriceUnits: signal.targetPriceUnits.toString(),
      targetSizeMicros: signal.targetSizeMicros.toString(),
      ...(signal.sellRatioNumerator === undefined ? {} : { sellRatioNumerator: signal.sellRatioNumerator.toString() }),
      ...(signal.sellRatioDenominator === undefined ? {} : { sellRatioDenominator: signal.sellRatioDenominator.toString() }),
      reason: signal.reason,
      eventClassification: signal.eventClassification,
      executionEligible: signal.executionEligible,
      ...(signal.executionBlockReason === undefined ? {} : { executionBlockReason: signal.executionBlockReason }),
    }));
    const body = {
      status,
      metrics: {
        inputRows,
        uniqueEvents,
        duplicateRows,
        confirmedDuplicateRows,
        reconciledPaginationOverlapRows,
        ambiguousEvents,
        buySignals: signals.filter((signal) => signal.signalType === "TARGET_BUY").length,
        sellSignals: signals.filter((signal) => signal.signalType === "TARGET_SELL").length,
        historicalSells,
        gapEvents,
        comboEvents,
        capitalIncompleteSignals,
        finalRecognizedPositions,
        finalHistoricalPositions,
      },
      signals: serializedSignals,
      eventOutcomes,
      positionLedger,
      incompleteReasons,
    };
    return {
      ...body,
      reportHash: createHash("sha256").update(stableJson(body)).digest("hex"),
    };
  }
}
