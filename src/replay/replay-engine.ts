import { createHash } from "node:crypto";
import { decimalToScaled, PRICE_SCALE_DIGITS, SHARE_SCALE_DIGITS } from "../domain/fixed.js";
import { signalIdempotencyKey, sourceEventKey } from "../domain/idempotency.js";
import type { IdentityStatus, PublicActivity, PublicTrade, Signal, SourceEvent } from "../domain/models.js";
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
  };
  signals: SerializedSignal[];
  incompleteReasons: string[];
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
}

function insideGap(timestamp: number, gaps: readonly ReplayGap[]): boolean {
  return gaps.some((gap) => timestamp >= gap.fromTimestamp && timestamp <= gap.toTimestamp);
}

function activityKey(activity: PublicActivity): string {
  return [activity.transactionHash.toLowerCase(), activity.asset, activity.side, activity.timestamp].join("|");
}

export class ReplayEngine {
  run(input: ReplayInput): ReplayReport {
    if (input.identityStatus !== "IDENTITY_CONFIRMED") {
      return this.finish("FAILED", input.trades.length, [], 0, 0, 0, 0, 0, 0, 0, 0, {}, ["WALLET_IDENTITY_NOT_CONFIRMED"]);
    }

    const comboKeys = new Set(
      input.activity.filter((item) => item.type === "TRADE" && item.isCombo).map(activityKey),
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

    const positions = new Map<string, bigint>();
    const signals: Signal[] = [];
    let historicalSells = 0;
    let gapEvents = 0;
    let comboEvents = 0;

    for (const event of events) {
      const before = positions.get(event.trade.asset) ?? 0n;
      if (event.isCombo) {
        comboEvents += 1;
        continue;
      }
      if (event.gapEvent) gapEvents += 1;

      if (event.trade.side === "BUY") {
        positions.set(event.trade.asset, before + event.sizeMicros);
        if (!event.gapEvent) signals.push(this.signal(event, "TARGET_BUY", "POST_BASELINE_BUY"));
        continue;
      }

      const recognizedSell = event.sizeMicros < before ? event.sizeMicros : before;
      positions.set(event.trade.asset, before - recognizedSell);
      if (before === 0n) {
        historicalSells += 1;
      } else if (!event.gapEvent) {
        signals.push(this.signal(event, "TARGET_SELL", "RECOGNIZED_POSITION_SELL", recognizedSell, before));
      }
    }

    const buySignals = signals.filter((signal) => signal.signalType === "TARGET_BUY").length;
    const sellSignals = signals.length - buySignals;
    const activityEventCounts = new Map<string, number>();
    for (const item of input.activity) {
      if (item.type !== "TRADE") continue;
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
    if (ambiguousEvents > 0) incompleteReasons.push("AMBIGUOUS_DUPLICATE_EVENTS");
    const status = incompleteReasons.length > 0 ? "INCOMPLETE" : "PASSED";
    const finalPositions = Object.fromEntries(
      [...positions.entries()].filter(([, value]) => value !== 0n).map(([asset, value]) => [asset, value.toString()]),
    );

    return this.finish(
      status,
      input.trades.length,
      signals,
      events.length,
      duplicateRows,
      confirmedDuplicateRows,
      ambiguousEvents,
      historicalSells,
      gapEvents,
      comboEvents,
      buySignals,
      finalPositions,
      incompleteReasons,
    );
  }

  private signal(
    event: SourceEvent,
    type: "TARGET_BUY" | "TARGET_SELL",
    reason: string,
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
    };
  }

  private finish(
    status: ReplayReport["status"],
    inputRows: number,
    signals: Signal[],
    uniqueEvents: number,
    duplicateRows: number,
    confirmedDuplicateRows: number,
    ambiguousEvents: number,
    historicalSells: number,
    gapEvents: number,
    comboEvents: number,
    capitalIncompleteSignals: number,
    finalRecognizedPositions: Record<string, string>,
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
      },
      signals: serializedSignals,
      incompleteReasons,
    };
    return {
      ...body,
      reportHash: createHash("sha256").update(stableJson(body)).digest("hex"),
    };
  }
}
