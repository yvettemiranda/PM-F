import {
  PAPER_VALIDATION_REQUIRED_CONTINUOUS_MS,
  type CampaignSnapshot,
  type CompatibilityIdentity,
} from "./types.js";

export const PAPER_CAMPAIGN_DEFAULT_LONG_SESSION_MS = PAPER_VALIDATION_REQUIRED_CONTINUOUS_MS;

export type PaperCampaignStartDisposition =
  | "CONTINUE"
  | "CREATE_REPLACEMENT"
  | "REVALIDATE_TERMINAL"
  | "REFUSE_TERMINAL";
export type PaperCampaignReplacementReason = "CORE_VERSION_REPLACEMENT";

function replacementReason(input: {
  campaignState: string;
  previousCoreCompatibilityHash: string;
  currentCoreCompatibilityHash: string;
}): PaperCampaignReplacementReason | null {
  if (input.previousCoreCompatibilityHash === input.currentCoreCompatibilityHash) return null;
  return ["PASSED", "BLOCKED", "FROZEN"].includes(input.campaignState)
    ? "CORE_VERSION_REPLACEMENT"
    : null;
}

export function paperCampaignReplacementAuthorized(input: {
  campaignState: string;
  previousCoreCompatibilityHash: string;
  currentCoreCompatibilityHash: string;
}): boolean {
  return replacementReason(input) !== null;
}

export function paperCampaignReplacementReason(
  snapshot: CampaignSnapshot,
  currentCoreCompatibilityHash: string,
): PaperCampaignReplacementReason | null {
  return replacementReason({
    campaignState: snapshot.state,
    previousCoreCompatibilityHash: snapshot.coreCompatibilityHash,
    currentCoreCompatibilityHash,
  });
}

export function paperCompatibilityRevalidationRequired(
  previous: CompatibilityIdentity | null,
  current: CompatibilityIdentity,
): boolean {
  return previous?.validationPolicyHash !== current.validationPolicyHash
    || previous?.verificationSuiteHash !== current.verificationSuiteHash;
}

/**
 * A user click may create a replacement only when the last Campaign is already
 * terminal and belongs to a different core. Same-core terminal evidence stays
 * closed and requires diagnosis instead of being silently retried.
 */
export function paperCampaignStartDisposition(
  snapshot: CampaignSnapshot,
  currentCoreCompatibilityHash: string,
  currentCompatibilityIdentity?: CompatibilityIdentity,
): PaperCampaignStartDisposition {
  if (!["PASSED", "BLOCKED", "FROZEN"].includes(snapshot.state)) return "CONTINUE";
  if (paperCampaignReplacementReason(snapshot, currentCoreCompatibilityHash)) return "CREATE_REPLACEMENT";
  const revalidationRequired = snapshot.state === "PASSED"
    && currentCompatibilityIdentity !== undefined
    && paperCompatibilityRevalidationRequired(
      snapshot.latestCompatibilityIdentity,
      currentCompatibilityIdentity,
    );
  return revalidationRequired ? "REVALIDATE_TERMINAL" : "REFUSE_TERMINAL";
}

/**
 * A campaign that has already met both runtime gates but is still missing
 * scenario coverage must keep running useful four-hour sessions. The service's
 * ordinary "remaining runtime" calculation is intentionally left untouched;
 * this is an operator-only continuation policy.
 */
export function paperCampaignPlannedDurationOverride(
  snapshot: CampaignSnapshot,
): number | undefined {
  const runtimeGateComplete = snapshot.accumulatedActiveRuntimeMs >= snapshot.requiredActiveRuntimeMs
    && snapshot.longestContinuousRuntimeMs >= snapshot.requiredContinuousRuntimeMs;
  return snapshot.state === "INCOMPLETE_COVERAGE" && runtimeGateComplete
    ? PAPER_CAMPAIGN_DEFAULT_LONG_SESSION_MS
    : undefined;
}

export interface QualifyingFinalizationPolicy {
  blockers: string[];
  qualificationDeferred: boolean;
}

export const OWNER_AUTHORIZED_EXTERNAL_FINALIZATION_EXCEPTION =
  "OWNER_AUTHORIZED_EXTERNAL_FINALIZATION_EXCEPTION" as const;

export interface OwnerAuthorizedFinalizationRuntimeInput {
  ownerAuthorized: boolean;
  stopReason: string;
  blockers: readonly string[];
  plannedDurationMs: number;
  effectiveActiveRuntimeMs: number;
  longestHealthySegmentMs: number;
  observe: {
    successfulPolls: number;
    schedulingGapCount: number;
    gapEvents: number;
    majorDesyncCount: number;
    finalSyncStatus: string | null;
  };
  databaseIntegrityPassed: boolean;
  externalMarketDataRecovered: boolean;
  safety: {
    executionMode: string;
    liveGateState: string;
    liveAllowed: boolean;
    privateKeyLoaded: boolean;
    authenticatedTradingClientPresent: boolean;
    realOrdersCreated: number;
    chainWrites: number;
  };
}

export interface OwnerAuthorizedFinalizationRuntimePolicy {
  accepted: boolean;
  creditedRuntimeMs: number;
  disclosure: typeof OWNER_AUTHORIZED_EXTERNAL_FINALIZATION_EXCEPTION;
  reasons: string[];
}

const EXTERNAL_FINALIZATION_BLOCKERS = [
  "PAPER_CHILD_FAILED:FINAL_DRAIN_INCOMPLETE",
  "PAPER_EXIT_CODE:1",
] as const;

function exactBlockerSet(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length
    && [...actual].sort().every((blocker, index) => blocker === [...expected].sort()[index]);
}

/**
 * Owner-authorized reporting policy for a fully elapsed, otherwise healthy
 * Paper Session whose only failure was a transient public-data timeout during
 * final valuation. This never rewrites the persisted Session or Campaign
 * result; it only credits runtime in the separately disclosed owner aggregate.
 */
export function paperOwnerAuthorizedFinalizationRuntimePolicy(
  input: OwnerAuthorizedFinalizationRuntimeInput,
): OwnerAuthorizedFinalizationRuntimePolicy {
  const reasons = [
    ...(input.ownerAuthorized ? [] : ["OWNER_AUTHORIZATION_MISSING"]),
    ...(input.stopReason === "PLANNED_SESSION_DURATION_REACHED"
      ? []
      : ["SESSION_DID_NOT_REACH_PLANNED_STOP"]),
    ...(exactBlockerSet(input.blockers, EXTERNAL_FINALIZATION_BLOCKERS)
      ? []
      : ["FAILURE_NOT_LIMITED_TO_EXTERNAL_FINALIZATION"]),
    ...(Number.isSafeInteger(input.plannedDurationMs) && input.plannedDurationMs > 0
      ? []
      : ["PLANNED_DURATION_INVALID"]),
    ...(Number.isSafeInteger(input.effectiveActiveRuntimeMs)
      && input.effectiveActiveRuntimeMs >= input.plannedDurationMs
      ? []
      : ["EFFECTIVE_RUNTIME_INCOMPLETE"]),
    ...(Number.isSafeInteger(input.longestHealthySegmentMs)
      && input.longestHealthySegmentMs >= input.plannedDurationMs
      ? []
      : ["HEALTHY_SEGMENT_INCOMPLETE"]),
    ...(input.observe.successfulPolls > 0 ? [] : ["OBSERVE_NO_SUCCESSFUL_POLL"]),
    ...(input.observe.schedulingGapCount === 0 ? [] : ["OBSERVE_SCHEDULING_GAP"]),
    ...(input.observe.gapEvents === 0 ? [] : ["OBSERVE_DATA_GAP"]),
    ...(input.observe.majorDesyncCount === 0 ? [] : ["OBSERVE_MAJOR_DESYNC"]),
    ...(input.observe.finalSyncStatus === "SYNCED" ? [] : ["OBSERVE_FINAL_SYNC_INCOMPLETE"]),
    ...(input.databaseIntegrityPassed ? [] : ["DATABASE_INTEGRITY_NOT_PROVEN"]),
    ...(input.externalMarketDataRecovered ? [] : ["EXTERNAL_MARKET_DATA_NOT_RECOVERED"]),
    ...(input.safety.executionMode === "PAPER" ? [] : ["EXECUTION_MODE_NOT_PAPER"]),
    ...(input.safety.liveGateState === "LIVE_DISABLED" ? [] : ["LIVE_GATE_NOT_DISABLED"]),
    ...(!input.safety.liveAllowed ? [] : ["LIVE_ALLOWED"]),
    ...(!input.safety.privateKeyLoaded ? [] : ["PRIVATE_KEY_LOADED"]),
    ...(!input.safety.authenticatedTradingClientPresent
      ? []
      : ["AUTHENTICATED_TRADING_CLIENT_PRESENT"]),
    ...(input.safety.realOrdersCreated === 0 ? [] : ["REAL_ORDER_CREATED"]),
    ...(input.safety.chainWrites === 0 ? [] : ["CHAIN_WRITE_DETECTED"]),
  ];
  return {
    accepted: reasons.length === 0,
    creditedRuntimeMs: reasons.length === 0 ? input.effectiveActiveRuntimeMs : 0,
    disclosure: OWNER_AUTHORIZED_EXTERNAL_FINALIZATION_EXCEPTION,
    reasons,
  };
}

/**
 * A deliberate operator pause before the initial 40-minute qualification is a
 * safe, resumable stop rather than a system failure. Its verified runtime counts
 * toward the 24-hour total, but it never replaces the separate full 40-minute
 * qualifying Session.
 */
export function paperQualifyingFinalizationPolicy(input: {
  stopReason: string;
  gateBlockers: string[];
}): QualifyingFinalizationPolicy {
  const safeOperatorPause = /^USER_SAFE_PAUSE_(SIGINT|SIGTERM|SIGHUP)$/.test(input.stopReason);
  const qualificationDeferred = safeOperatorPause
    && input.gateBlockers.includes("MINIMUM_RUNTIME_NOT_REACHED");
  return {
    qualificationDeferred,
    blockers: qualificationDeferred
      ? input.gateBlockers.filter((blocker) => blocker !== "MINIMUM_RUNTIME_NOT_REACHED")
      : [...input.gateBlockers],
  };
}
