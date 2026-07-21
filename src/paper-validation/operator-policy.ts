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
