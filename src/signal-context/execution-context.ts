import { createHash } from "node:crypto";
import type { ClobMarket } from "../adapters/polymarket-public.js";
import { stableJson, RULESET_HASH, VERSIONS } from "../domain/versioning.js";
import type { SourceVersion } from "../infra/source-version.js";
import type { ObserveEvent, ObserveSignal } from "../observe/types.js";
import type { SignalExecutionContext } from "../paper/types.js";
import type { CapitalEstimate } from "../services/capital-estimator.js";

export interface SignalContextBundle {
  signal: ObserveSignal;
  context: SignalExecutionContext;
  capitalDecision: CapitalEstimate | null;
}

export interface SignalMarketMetadataProvider {
  market(
    conditionId: string,
    signal?: AbortSignal,
  ): Promise<{ sourceUrl: string; fetchedAt: string; market: ClobMarket }>;
}

export function buildSignalExecutionContext(input: {
  signal: ObserveSignal;
  event: ObserveEvent;
  market: ClobMarket;
  marketSourceUrl: string;
  marketFetchedAt: string;
  capitalDecision: CapitalEstimate | null;
  sourceVersion?: SourceVersion;
  createdAt: string;
}): SignalExecutionContext {
  if (!input.signal.targetId.trim()) throw new Error(`SIGNAL_TARGET_ID_REQUIRED:${input.signal.signalId}`);
  const trade = input.event.trade;
  if (!trade) throw new Error(`Signal source trade missing: ${input.signal.signalId}`);
  if (!input.market.end_date_iso) throw new Error(`MARKET_END_TIME_UNAVAILABLE:${input.signal.conditionId}`);
  const metadata = {
    sourceUrl: input.marketSourceUrl,
    fetchedAt: input.marketFetchedAt,
    conditionId: input.market.condition_id,
    question: input.market.question ?? null,
    marketSlug: input.market.market_slug ?? null,
    endDateIso: input.market.end_date_iso,
    closed: input.market.closed,
    active: input.market.active ?? null,
    acceptingOrders: input.market.accepting_orders ?? null,
    takerBaseFee: input.market.taker_base_fee ?? null,
    is5050Outcome: input.market.is_50_50_outcome ?? false,
    tokens: input.market.tokens,
  };
  const metadataHash = createHash("sha256").update(stableJson(metadata)).digest("hex");
  const capitalSizingRatio = input.signal.signalType === "TARGET_BUY"
    ? input.capitalDecision?.capitalSizingRatio ?? null
    : null;
  const capitalSizingRatioHash = input.signal.signalType === "TARGET_BUY"
    ? input.capitalDecision?.capitalSizingRatioHash ?? null
    : null;
  if (
    input.signal.signalType === "TARGET_BUY"
    && input.capitalDecision?.capitalConfidence === "HIGH"
    && input.capitalDecision.capitalEstimateStatus === "COMPLETE"
    && (!capitalSizingRatio || !capitalSizingRatioHash)
  ) throw new Error(`CAPITAL_SIZING_RATIO_REQUIRED:${input.signal.signalId}`);
  if (
    capitalSizingRatio
    && (
      capitalSizingRatio.targetPriceUnits !== input.signal.targetPriceUnits
      || capitalSizingRatio.targetSizeMicros !== input.signal.targetSizeMicros
    )
  ) throw new Error(`CAPITAL_SIZING_SIGNAL_MISMATCH:${input.signal.signalId}`);
  const identity = [
    input.signal.signalId,
    input.signal.targetId,
    input.capitalDecision?.capitalEstimateId ?? "NONE",
    String(trade.timestamp),
    input.market.end_date_iso,
    metadataHash,
    capitalSizingRatioHash ?? "NO_EXACT_CAPITAL_RATIO",
    RULESET_HASH,
  ].join("|");
  return {
    contextId: createHash("sha256").update(identity).digest("hex"),
    targetId: input.signal.targetId,
    signalId: input.signal.signalId,
    capitalDecisionId: input.capitalDecision?.capitalEstimateId ?? null,
    targetTradeCapitalRatioPpm: input.signal.signalType === "TARGET_BUY"
      ? input.capitalDecision?.targetTradeCapitalRatioPpm ?? null
      : null,
    capitalSizingRatio,
    capitalSizingRatioHash,
    targetTradeTimestamp: new Date(trade.timestamp * 1_000).toISOString(),
    marketEndTime: input.market.end_date_iso,
    marketMetadataSnapshot: metadata,
    marketMetadataHash: metadataHash,
    rulesetHash: RULESET_HASH,
    sourceCodeCommit: input.sourceVersion?.commit ?? "UNKNOWN",
    sourceCodeDirty: input.sourceVersion?.dirty ?? true,
    configVersion: VERSIONS.configVersion,
    createdAt: input.createdAt,
  };
}
