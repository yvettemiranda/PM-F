import type { ApiCapture } from "../adapters/polymarket-public.js";
import type { EventClassification, PublicActivity, PublicPosition, PublicTrade, SyncStatus } from "../domain/models.js";
import type { VerifiedNegativeRiskConversion } from "./negative-risk-conversion.js";
import type {
  PolygonOrderFilledTradeBatch,
  PolygonOrderFilledEvidence,
} from "./polygon-order-filled-trade-feed.js";

export interface ObserveBaselineItem {
  asset: string;
  conditionId: string;
  sizeMicros: string;
}

export interface ObserveBaseline {
  baselineRunId: string;
  targetId: string;
  walletAddress: string;
  snapshotTime: string;
  items: ObserveBaselineItem[];
}

export interface ObserveEvent {
  sourceEventKey: string;
  sourceType: "DATA_API_TRADE" | "DATA_API_ACTIVITY" | "POLYGON_ORDER_FILLED";
  sourceTimestamp: number;
  isGap: boolean;
  isCombo: boolean;
  activityConfirmed: boolean;
  trade?: PublicTrade;
  activity?: PublicActivity;
  conversion?: VerifiedNegativeRiskConversion;
}

export interface ObserveSignal {
  signalId: string;
  targetId: string;
  signalIdempotencyKey: string;
  sourceEventKey: string;
  signalType: "TARGET_BUY" | "TARGET_SELL" | "TARGET_CONVERSION";
  asset: string;
  conditionId: string;
  targetPriceUnits: string;
  targetSizeMicros: string;
  sellRatioNumerator: string | null;
  sellRatioDenominator: string | null;
  reason: string;
  eventClassification: EventClassification;
  executionEligible: boolean;
  executionBlockReason: string | null;
  requiredMarketOutcomeAssets?: string[];
}

export interface ObserveProjectionEntry {
  asset: string;
  historicalMicros: string;
  trackedMicros: string;
  expectedTotalMicros: string;
  lastSourceEventKey: string | null;
}

export interface ObserveProjectionResult {
  signals: ObserveSignal[];
  projection: ObserveProjectionEntry[];
  unsupportedActivities: UnsupportedTargetActivity[];
  projectionHash: string;
  lastProcessedTimestamp: number | null;
  lastProcessedEventId: string | null;
  gapEventCount: number;
}

export interface ObservePollSnapshot {
  trades: ApiCapture<PublicTrade[]>;
  activity: ApiCapture<PublicActivity[]>;
  positions: ApiCapture<PublicPosition[]>;
  pUsdBalance: ApiCapture<{ jsonrpc: string; id: number; result?: string; error?: unknown }>;
  polygonOrderFilled?: PolygonOrderFilledTradeBatch | {
    status: "DEGRADED";
    confirmedHead: null;
    fromBlock: null;
    toBlock: null;
    trades: [];
    capture: ApiCapture<PolygonOrderFilledEvidence> | null;
    errorDetail: string;
  };
}

export interface ObserveDataSource {
  poll(
    walletAddress: string,
    recoveryFromTimestamp?: number,
    activityFromTimestamp?: number,
    signal?: AbortSignal,
  ): Promise<ObservePollSnapshot>;
}

export interface ReconciliationResult {
  syncStatus: SyncStatus;
  issueCount: number;
  observedPositionsHash: string;
  details: ReconciliationDetail[];
}

export type ReconciliationDetail = ({
  issueType: "POSITION_QUANTITY_DIFF";
  asset: string;
  expectedMicros: string;
  observedMicros: string;
  differenceMicros: string;
  toleranceMicros: string;
} | {
  issueType: "SOURCE_EVENT_MULTIPLICITY_AMBIGUOUS";
  sourceEventKey: string;
  tradesCount: number;
  activityCount: number;
} | {
  issueType: "UNSUPPORTED_TARGET_ACTIVITY";
  sourceEventKey: string;
  activityType: "MERGE" | "SPLIT";
}) & {
  firstObservedAt?: string;
  consecutiveCount?: number;
};

export interface ReconciliationHistoryReport {
  createdAt: string;
  details: ReconciliationDetail[];
}

export interface SourceEventMultiplicityAmbiguity {
  sourceEventKey: string;
  tradesCount: number;
  activityCount: number;
}

export interface UnsupportedTargetActivity {
  sourceEventKey: string;
  activityType: "MERGE" | "SPLIT";
}

export interface ObserveRunMetrics {
  observeRunId: string;
  baselineRunId: string;
  startedAt: string;
  stoppedAt: string;
  durationMs: number;
  activeRuntimeMs: number;
  schedulingGapCount: number;
  maxSchedulingGapMs: number;
  successfulPolls: number;
  failedPolls: number;
  processedEvents: number;
  emittedSignals: number;
  duplicateEvents: number;
  gapEvents: number;
  reconciliationCount: number;
  stateDriftDetected: boolean;
  minorDiffCount: number;
  majorDesyncCount: number;
  unrecoveredConnectionGap: boolean;
  checkpointRecovered: boolean;
  checkpointProjectionHashMismatch: boolean;
  lastCheckpointId: string | null;
  finalSyncStatus: SyncStatus | null;
  polygonTradeFeedDegradedPolls: number;
  polygonOrderFilledEvents: number;
}
