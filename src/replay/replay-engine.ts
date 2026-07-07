import { createHash } from "node:crypto";
import { decimalToScaled, PRICE_SCALE_DIGITS, SHARE_SCALE_DIGITS } from "../domain/fixed.js";
import { activityEventKey, signalIdempotencyKey, sourceEventKey } from "../domain/idempotency.js";
import type { EventClassification, IdentityStatus, PublicActivity, PublicTrade, Signal, SourceEvent } from "../domain/models.js";
import { VERSIONS, stableJson } from "../domain/versioning.js";

export interface ReplayGap {
  fromTimestamp: number;
  toTimestamp: number;
}

export interface ReplayInput {
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
}

export interface ReplayReport {
  status: "PASSED" | "FAILED" | "INCOMPLETE";
  reportHash: string;
  metrics: {
    inputRows: number;
    uniqueEvents: number;
    duplicateRows: number;
    confirmedDuplicateRows: number;
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
  signalType?: "TARGET_BUY" | "TARGET_SELL";
  executionEligible?: boolean;
  reason: string;
}

export interface SerializedSignal {
  signalId: string;
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
  return activity.type === "TRADE"
    && typeof activity.conditionId === "string"
    && typeof activity.asset === "string"
    && (activity.side === "BUY" || activity.side === "SELL")
    && activity.price !== undefined
    && activity.size !== undefined;
}

export class ReplayEngine {
  run(input: ReplayInput): ReplayReport {
    if (input.identityStatus !== "IDENTITY_CONFIRMED") {
      return this.finish("FAILED", input.trades.length, [], {}, [], 0, 0, 0, 0, 0, 0, 0, 0, {}, {}, ["WALLET_IDENTITY_NOT_CONFIRMED"]);
    }

    const comboKeys = new Set(
      input.activity.filter((item) => isTradeActivity(item) && item.isCombo).map(activityKey),
    );
    const seen = new Set<string>();
    const duplicateRowsByKey = new Map<string, number>();
    const events: SourceEvent[] = [];
    let duplicateRows = 0;

    for (const trade of input.trades) {
      const key = sourceEventKey(trade);
      if (seen.has(key)) {
        duplicateRows += 1;
        duplicateRowsByKey.set(key, (duplicateRowsByKey.get(key) ?? 0) + 1);
        continue;
      }
      seen.add(key);
      events.push({
        sourceEventKey: key,
        trade,
        priceUnits: decimalToScaled(trade.price, PRICE_SCALE_DIGITS),
        sizeMicros: decimalToScaled(trade.size, SHARE_SCALE_DIGITS),
        gapEvent: insideGap(trade.timestamp, input.gaps ?? []),
        isCombo: comboKeys.has([trade.transactionHash.toLowerCase(), trade.asset, trade.side, trade.timestamp].join("|")),
      });
    }

    events.sort((a, b) => a.trade.timestamp - b.trade.timestamp || a.sourceEventKey.localeCompare(b.sourceEventKey));

    const trackedPositions = new Map<string, bigint>();
    const historicalPositions = new Map<string, bigint>();
    for (const baseline of input.positionBaseline ?? []) {
      historicalPositions.set(baseline.asset, decimalToScaled(baseline.size, SHARE_SCALE_DIGITS));
    }
    const signals: Signal[] = [];
    const eventOutcomes: Record<string, ReplayEventOutcome> = {};
    const positionLedger: ReplayPositionLedgerEntry[] = [];
    const officialNonTradeTypes = new Set(["SPLIT", "MERGE", "REDEEM", "REWARD", "CONVERSION", "MAKER_REBATE", "REFERRAL_REWARD"]);
    for (const item of input.activity) {
      if (isTradeActivity(item)) continue;
      const key = activityEventKey(item);
      if (["SPLIT", "MERGE", "CONVERSION"].includes(item.type)) {
        eventOutcomes[key] = { eventClassification: "COMBO_ACTIVITY", reason: `${item.type}_RECORDED_WITHOUT_SIGNAL` };
      } else if (officialNonTradeTypes.has(item.type)) {
        eventOutcomes[key] = { eventClassification: "NON_TRADE_ACTIVITY", reason: `${item.type}_RECORDED_WITHOUT_SIGNAL` };
      } else {
        eventOutcomes[key] = { eventClassification: "UNRECOGNIZED", reason: `UNRECOGNIZED_ACTIVITY_TYPE:${item.type}` };
      }
    }
    let historicalSells = 0;
    let gapEvents = 0;
    let comboEvents = 0;

    for (const event of events) {
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
      if (event.gapEvent) gapEvents += 1;

      if (event.trade.side === "BUY") {
        if (event.gapEvent) {
          historicalPositions.set(event.trade.asset, beforeHistorical + event.sizeMicros);
          const signal = this.signal(event, "TARGET_BUY", "GAP_EVENT_RECORDED", "GAP_TRADE", false, "GAP_EVENT");
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
          const signal = this.signal(event, "TARGET_BUY", "POST_BASELINE_BUY", "STANDARD_TRADE", true);
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
      trackedPositions.set(event.trade.asset, beforeTracked - recognizedSell);
      const historicalSell = event.sizeMicros - recognizedSell < beforeHistorical
        ? event.sizeMicros - recognizedSell
        : beforeHistorical;
      historicalPositions.set(event.trade.asset, beforeHistorical - historicalSell);
      if (event.gapEvent) {
        const signal = this.signal(
          event,
          "TARGET_SELL",
          "GAP_EVENT_RECORDED",
          "GAP_TRADE",
          false,
          "GAP_EVENT",
          beforeTracked === 0n ? undefined : recognizedSell,
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
          event,
          "TARGET_SELL",
          "RECOGNIZED_POSITION_SELL",
          "STANDARD_TRADE",
          true,
          undefined,
          recognizedSell,
          beforeTracked,
        );
        signals.push(signal);
        eventOutcomes[event.sourceEventKey] = this.outcome(signal);
      }
      positionLedger.push(this.ledger(
        event,
        beforeHistorical,
        beforeHistorical - historicalSell,
        beforeTracked,
        beforeTracked - recognizedSell,
        recognizedSell,
        event.gapEvent ? "GAP_SELL_TRACKED_FIRST_NO_EXECUTION" : beforeTracked === 0n ? "HISTORICAL_SELL_ONLY" : "TRACKED_FIRST_SELL",
      ));
    }

    const buySignals = signals.filter((signal) => signal.signalType === "TARGET_BUY").length;
    const sellSignals = signals.length - buySignals;
    const activityEventCounts = new Map<string, number>();
    for (const item of input.activity) {
      if (!isTradeActivity(item)) continue;
      const key = sourceEventKey(item);
      activityEventCounts.set(key, (activityEventCounts.get(key) ?? 0) + 1);
    }
    let confirmedDuplicateRows = 0;
    let ambiguousEvents = 0;
    for (const [key, count] of duplicateRowsByKey) {
      if (activityEventCounts.get(key) === 1) confirmedDuplicateRows += count;
      else ambiguousEvents += count;
    }
    const incompleteReasons: string[] = [];
    if (!input.hasCapitalSnapshots) incompleteReasons.push("HISTORICAL_CAPITAL_SNAPSHOTS_MISSING");
    if (!input.hasGoldenExpectations) incompleteReasons.push("GOLDEN_EXPECTATIONS_MISSING");
    if ((input.hasPositionBaseline ?? true) === false) incompleteReasons.push("STARTING_POSITION_BASELINE_MISSING");
    if ((input.tradeHistoryComplete ?? true) === false) incompleteReasons.push("TRADE_HISTORY_TRUNCATED");
    if ((input.activityHistoryComplete ?? true) === false) incompleteReasons.push("ACTIVITY_HISTORY_TRUNCATED");
    if (input.sourceCodeCommit === "UNCOMMITTED") incompleteReasons.push("SOURCE_CODE_COMMIT_MISSING");
    if (input.sourceCodeDirty) incompleteReasons.push("SOURCE_CODE_DIRTY");
    if (ambiguousEvents > 0) incompleteReasons.push("AMBIGUOUS_DUPLICATE_EVENTS");
    const status = incompleteReasons.length > 0 ? "INCOMPLETE" : "PASSED";
    const finalTrackedPositions = Object.fromEntries(
      [...trackedPositions.entries()].filter(([, value]) => value !== 0n).map(([asset, value]) => [asset, value.toString()]),
    );
    const finalHistoricalPositions = Object.fromEntries(
      [...historicalPositions.entries()].filter(([, value]) => value !== 0n).map(([asset, value]) => [asset, value.toString()]),
    );

    return this.finish(
      status,
      input.trades.length,
      signals,
      eventOutcomes,
      positionLedger,
      events.length,
      duplicateRows,
      confirmedDuplicateRows,
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
    event: SourceEvent,
    type: "TARGET_BUY" | "TARGET_SELL",
    reason: string,
    eventClassification: EventClassification,
    executionEligible: boolean,
    executionBlockReason?: string,
    numerator?: bigint,
    denominator?: bigint,
  ): Signal {
    const idempotency = signalIdempotencyKey(event.sourceEventKey, type, VERSIONS.signalVersion);
    return {
      signalId: idempotency,
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
