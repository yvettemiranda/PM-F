import type { SourceVersion } from "../infra/source-version.js";
import type { PaperExecutionFunnel } from "../paper/paper-execution-funnel.js";

export const PAPER_VALIDATION_REQUIRED_ACTIVE_MS = 72 * 60 * 60 * 1_000;
export const PAPER_VALIDATION_REQUIRED_CONTINUOUS_MS = 12 * 60 * 60 * 1_000;
export const PAPER_VALIDATION_QUALIFYING_MS = 2 * 60 * 60 * 1_000;
export const PAPER_VALIDATION_CHECKPOINT_INTERVAL_MS = 60 * 1_000;
export const PAPER_VALIDATION_MAX_CHECKPOINT_GAP_MS = 90 * 1_000;

export type CampaignState =
  | "QUALIFYING"
  | "RUNNING"
  | "PAUSED"
  | "INCOMPLETE_COVERAGE"
  | "PASSED"
  | "BLOCKED"
  | "FROZEN";

export type ValidationSessionState = "RUNNING" | "COMPLETED" | "FAILED" | "CRASH_RECOVERED" | "BLOCKED";
export type ValidationSessionKind = "QUALIFYING" | "LONG_RUNNING";
export type ValidationCheckpointKind = "START" | "HEARTBEAT" | "SAFE_STOP" | "CRASH_RECOVERY";
export type ValidationSessionOutcome =
  | "SAFE_STOP"
  | "AUTO_STOP"
  | "CRASH_RECOVERED"
  | "CRASH_UNVERIFIED"
  | "FAILED";

export type ValidationAcceptanceStatus =
  | "PASSED_NATURAL"
  | "PASSED_WITH_SUPPLEMENTAL_EVIDENCE"
  | "INCOMPLETE_COVERAGE"
  | "FAILED";

export type ValidationEvidenceSource =
  | "NATURAL"
  | "REAL_SIGNAL_REPLAY"
  | "REAL_EXECUTION_REPLAY"
  | "ISOLATED_CONTROLLED";

export const PAPER_VALIDATION_SCENARIOS = [
  "BUY",
  "SELL",
  "RISK_ALLOW",
  "RISK_REJECT",
  "MIN_ORDER_REJECT",
  "ORDER",
  "FILL",
  "PARTIAL_FILL",
  "POSITION_UPDATE",
  "RESERVATION_RELEASE",
  "FEE",
  "REALIZED_PNL",
  "UNREALIZED_PNL",
  "STOP_LOSS",
  "SETTLEMENT",
  "NO_ORDERBOOK_RECOVERY",
  "API_RECOVERY",
  "SAFE_STOP",
  "RESTART_RECOVERY",
  "CRASH_RECOVERY",
  "RECONCILIATION",
] as const;

export type PaperValidationScenario = typeof PAPER_VALIDATION_SCENARIOS[number];

export interface ScenarioEvidence {
  covered: boolean;
  source: ValidationEvidenceSource;
  evidenceId: string;
  reason: string;
}

export type SessionCoverage = Partial<Record<PaperValidationScenario, ScenarioEvidence>>;
export type CumulativeCoverage = Record<PaperValidationScenario, ScenarioEvidence | null>;

export interface CoreCompatibilityManifest {
  schemaVersion: string;
  signalVersion: string;
  strategyVersion: string;
  riskVersion: string;
  paperVersion: string;
  rulesetHash: string;
  configVersion: string;
  components: {
    amountCalculation: string;
    signalContext: string;
    risk: string;
    paperExecution: string;
    observeRecovery: string;
    settlementPnl: string;
    schema: string;
    runtimeEnvironment: string;
  };
}

export interface CampaignDefinition {
  campaignId: string;
  targetId: string;
  baselineRunId: string;
  paperAccountId: string;
  initialBalanceMicros: string;
  requiredActiveRuntimeMs: number;
  requiredContinuousRuntimeMs: number;
  qualifyingRuntimeMs: number;
  checkpointIntervalMs: number;
  maxCheckpointGapMs: number;
  coreCompatibilityHash: string;
  coreManifest: CoreCompatibilityManifest;
  sourceVersion: SourceVersion;
  createdAt: string;
}

export interface CampaignSnapshot extends CampaignDefinition {
  state: CampaignState;
  qualified: boolean;
  completedSessionCount: number;
  accumulatedActiveRuntimeMs: number;
  longestContinuousRuntimeMs: number;
  coverageStatus: "COMPLETE" | "INCOMPLETE";
  coverage: CumulativeCoverage;
  missingScenarios: PaperValidationScenario[];
  blockers: string[];
  canContinue: boolean;
  latestSessionId: string | null;
  latestReportId: string | null;
}

export interface ValidationSessionDefinition {
  sessionId: string;
  campaignId: string;
  sequence: number;
  sessionKind: ValidationSessionKind;
  plannedDurationMs: number;
  state: ValidationSessionState;
  sourceVersion: SourceVersion;
  liveGateTransitionCountAtStart: number;
  startedAt: string;
}

export interface CheckpointEvidence {
  observeActive: boolean;
  paperActive: boolean;
  consistencySafe: boolean;
  observeCheckpointId?: string | null;
  paperConsumerCreatedAt?: string | null;
  paperConsumerSignalId?: string | null;
  positionProjectionHash?: string | null;
  portfolioProjectionHash?: string | null;
  replayState?: string | null;
  capitalSnapshotId?: string | null;
  lastProcessedEventId?: string | null;
  detail?: Record<string, unknown>;
}

export interface ValidationCheckpoint {
  checkpointId: string;
  campaignId: string;
  sessionId: string;
  sequence: number;
  checkpointKind: ValidationCheckpointKind;
  observedAt: string;
  elapsedRuntimeMs: number;
  observeActive: boolean;
  paperActive: boolean;
  consistencySafe: boolean;
  executionMode: "PAPER";
  liveGateState: "LIVE_DISABLED";
  liveGateTransitionCount: number;
  checkpointHash: string;
  idempotencyKey: string;
  evidence: CheckpointEvidence;
}

export interface SessionRuntimeMetrics {
  effectiveActiveRuntimeMs: number;
  longestHealthySegmentMs: number;
  qualifyingContinuousRuntimeMs: number;
  acceptedIntervalCount: number;
  rejectedIntervalCount: number;
  checkpointCount: number;
}

export interface ObserveOperationalMetrics {
  successfulPolls: number;
  failedPolls: number;
  processedEvents: number;
  emittedSignals: number;
  duplicateEvents: number;
  gapEvents: number;
  reconciliationCount: number;
  minorDiffCount: number;
  majorDesyncCount: number;
  schedulingGapCount: number;
  recoveredApiFailureSessions: number;
  checkpointRecoveredSessions: number;
  unrecoveredConnectionGapSessions: number;
}

export interface CampaignOperationalMetrics {
  observe: ObserveOperationalMetrics;
  paper: PaperExecutionFunnel;
  integrity: {
    finalizedSessionCount: number;
    consistencyPassedSessionCount: number;
    consistencyFailedSessionCount: number;
    checkpointCount: number;
    rejectedCheckpointIntervalCount: number;
  };
}

export interface FinalizeSessionInput {
  sessionId: string;
  outcome: ValidationSessionOutcome;
  acceptanceStatus: ValidationAcceptanceStatus;
  consistencyPassed: boolean;
  recoveryConfirmed: boolean;
  stopReason: string;
  blockers: string[];
  coverage: SessionCoverage;
  observeMetrics?: ObserveOperationalMetrics | null;
  stoppedAt: string;
}

export interface SessionValidationReport {
  reportId: string;
  campaignId: string;
  sessionId: string;
  sessionKind: ValidationSessionKind;
  sessionState: ValidationSessionState;
  outcome: ValidationSessionOutcome;
  acceptanceStatus: ValidationAcceptanceStatus;
  consistencyPassed: boolean;
  recoveryConfirmed: boolean;
  stopReason: string;
  blockers: string[];
  coverage: SessionCoverage;
  observeMetrics: ObserveOperationalMetrics | null;
  runtime: SessionRuntimeMetrics;
  countsTowardCampaign: boolean;
  finalizationInputHash: string;
  sourceVersion: SourceVersion;
  coreCompatibilityHash: string;
  startedAt: string;
  stoppedAt: string;
  createdAt: string;
}

export interface CampaignValidationReport {
  reportId: string;
  campaignId: string;
  afterSessionId: string;
  campaignState: CampaignState;
  qualified: boolean;
  accumulatedActiveRuntimeMs: number;
  longestContinuousRuntimeMs: number;
  completedSessionCount: number;
  coverageStatus: "COMPLETE" | "INCOMPLETE";
  coverage: CumulativeCoverage;
  missingScenarios: PaperValidationScenario[];
  blockers: string[];
  canContinue: boolean;
  operationalMetrics: CampaignOperationalMetrics;
  sourceVersion: SourceVersion;
  coreCompatibilityHash: string;
  createdAt: string;
}

export interface FinalizeSessionResult {
  session: SessionValidationReport;
  campaign: CampaignValidationReport;
}
