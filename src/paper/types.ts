import type { CapitalConfidence, CapitalEstimateStatus } from "../services/capital-estimator.js";
import type { ExactCapitalRatioSnapshot } from "../execution/capital-sizing.js";
import type { PublicMarketDataCapture } from "../execution/market-data.js";

export type PaperExecutionState =
  | "WAITING_EXECUTION"
  | "PARTIALLY_EXECUTED"
  | "EXECUTED"
  | "EXPIRED"
  | "REJECTED"
  | "CANCELLED"
  | "EXIT_PENDING"
  | "STOP_EXIT_PENDING";

export type PaperPositionState = "OPEN" | "PARTIALLY_CLOSED" | "SETTLEMENT_PENDING" | "CLOSED" | "REDEEMED" | "FROZEN";

export type PaperMarketDataHealthState = "HEALTHY" | "DEGRADED" | "FROZEN" | "SETTLEMENT_ONLY";

export interface PaperMarketDataHealthSnapshot {
  paperAccountId: string;
  assetId: string;
  conditionId: string;
  state: PaperMarketDataHealthState;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  nextRetryAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  lastFailureAt: string | null;
  lastSuccessAt: string | null;
  frozenAt: string | null;
}

export interface SignalExecutionContext {
  contextId: string;
  targetId: string;
  signalId: string;
  capitalDecisionId: string | null;
  targetTradeCapitalRatioPpm: string | null;
  /** Null/absent only for immutable contexts created before exact sizing v1. */
  capitalSizingRatio?: ExactCapitalRatioSnapshot | null;
  capitalSizingRatioHash?: string | null;
  targetTradeTimestamp: string;
  marketEndTime: string;
  /** Explicit for contexts produced on schema 2.29.0+; omitted means a legacy verified end time. */
  marketEndTimeStatus?: "VERIFIED" | "UNAVAILABLE";
  /** Immutable BUY deadline; legacy contexts derive it from targetTradeTimestamp + marketEndTime. */
  executionDeadlineAt?: string | null;
  marketMetadataSnapshot: Record<string, unknown>;
  marketMetadataHash: string;
  rulesetHash: string;
  sourceCodeCommit: string;
  sourceCodeDirty: boolean;
  configVersion: string;
  createdAt: string;
}

export interface PaperSignalEnvelope {
  signalId: string;
  targetId: string;
  signalType: "TARGET_BUY" | "TARGET_SELL" | "TARGET_CONVERSION";
  status: string;
  executionEligible: boolean;
  executionBlockReason: string | null;
  assetId: string;
  conditionId: string;
  targetPriceUnits: string;
  targetSizeMicros: string;
  sellRatioNumerator: string | null;
  sellRatioDenominator: string | null;
  createdAt: string;
  context: SignalExecutionContext | null;
  capitalDecision: {
    status: CapitalEstimateStatus;
    confidence: CapitalConfidence;
    ratioPpm: string | null;
    fallbackAmountMicros: string;
  } | null;
}

export interface PaperSignalConsumptionScope {
  campaignId: string;
  sessionId: string;
  coreCompatibilityHash: string;
}

export interface OrderbookLevel {
  price: string;
  size: string;
}

export interface PaperOrderbookSnapshot {
  assetId: string;
  conditionId: string;
  marketSnapshotTime: string;
  receivedAt: string;
  sourceUrl: string;
  minOrderSize?: string;
  tickSize?: string;
  bids: OrderbookLevel[];
  asks: OrderbookLevel[];
  publicCapture?: PublicMarketDataCapture;
}

export interface PaperFeeSnapshot {
  assetId: string;
  status: "AVAILABLE" | "UNAVAILABLE";
  baseFee: number | null;
  feeRatePpm: string | null;
  exponent: number | null;
  sourceUrl: string;
  snapshotTime: string;
  publicCapture?: PublicMarketDataCapture;
}

export interface PaperResolutionSnapshot {
  conditionId: string;
  resolved: boolean;
  assetId: string;
  payoutNumerator: string | null;
  payoutDenominator: string | null;
  sourceUrl: string;
  snapshotTime: string;
  raw: Record<string, unknown>;
}

export interface PaperMarketDataProvider {
  orderbook(assetId: string, conditionId: string, signal?: AbortSignal): Promise<PaperOrderbookSnapshot>;
  fee(assetId: string, conditionId: string, signal?: AbortSignal): Promise<PaperFeeSnapshot>;
  resolution(conditionId: string, assetId: string, signal?: AbortSignal): Promise<PaperResolutionSnapshot>;
}

export interface MatchedLevel {
  priceUnits: string;
  sizeMicros: string;
  notionalMicros: string;
}

export interface PaperMatchResult {
  levels: MatchedLevel[];
  filledSizeMicros: string;
  filledNotionalMicros: string;
  feeMicros: string;
  vwapPriceUnits: string | null;
  complete: boolean;
}

export interface PaperAccountSnapshot {
  paperAccountId: string;
  initialBalanceMicros: string;
  cashBalanceMicros: string;
  reservedBalanceMicros: string;
  availableBalanceMicros: string;
  positionValueMicros: string;
  realizedPnlMicros: string;
  unrealizedPnlMicros: string;
  totalEquityMicros: string;
  valuationStatus: "COMPLETE" | "INCOMPLETE";
  unpricedPositionCount: number;
  priceSource: "ORDERBOOK_EXIT_VWAP" | "PARTIAL_ORDERBOOK_EXIT_VWAP" | "UNAVAILABLE";
  priceTimestamp: string;
}
