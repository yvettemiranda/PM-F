import type { CampaignSnapshot } from "./types.js";

export const PAPER_CAMPAIGN_DEFAULT_LONG_SESSION_MS = 12 * 60 * 60 * 1_000;

/**
 * A campaign that has already met both runtime gates but is still missing
 * scenario coverage must keep running useful 12-hour sessions. The service's
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
 * A deliberate operator pause before the initial two-hour qualification is a
 * safe, resumable stop rather than a system failure. Its verified runtime counts
 * toward the 72-hour total, but it never replaces the separate full two-hour
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
