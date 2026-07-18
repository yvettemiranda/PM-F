import { RULESET } from "../domain/versioning.js";
import {
  CLOB_TIME_ENDPOINT,
  ClobClockSafetyProvider,
} from "../live/clob-clock-safety-provider.js";
import type {
  ClockSafetyProvider,
  ClockSafetyResult,
  ReadonlySafetyProviderType,
} from "../live/live-safety-provider.js";

export { CLOB_TIME_ENDPOINT };

export interface PaperCampaignClockSafetyEvidence {
  status: "PASSED" | "BLOCKED";
  clockSafetyStatus: ClockSafetyResult["status"];
  offsetMs: number | null;
  checkedAt: string | null;
  source: string | null;
  thresholdMs: number;
  reason: string | null;
}

export function evaluatePaperCampaignClockSafety(input: {
  providerType: ReadonlySafetyProviderType;
  result: ClockSafetyResult;
}): PaperCampaignClockSafetyEvidence {
  const evidence = {
    clockSafetyStatus: input.result.status,
    offsetMs: input.result.offsetMs,
    checkedAt: input.result.checkedAt,
    source: input.result.source,
    thresholdMs: RULESET.clockUnsafeThresholdMs,
  } as const;
  let reason: string | null = null;
  if (input.providerType !== "LIVE_READONLY") {
    reason = "CLOCK_PROVIDER_NOT_LIVE_READONLY";
  } else if (input.result.source !== CLOB_TIME_ENDPOINT) {
    reason = "CLOCK_SOURCE_INVALID";
  } else if (input.result.status !== "SAFE") {
    reason = input.result.reason ?? `CLOCK_STATUS_${input.result.status}`;
  } else if (
    typeof input.result.offsetMs !== "number"
    || !Number.isSafeInteger(input.result.offsetMs)
    || Math.abs(input.result.offsetMs) > RULESET.clockUnsafeThresholdMs
  ) {
    reason = "CLOCK_OFFSET_EXCEEDED";
  } else if (
    input.result.checkedAt === null
    || !Number.isFinite(Date.parse(input.result.checkedAt))
    || input.result.reason !== null
  ) {
    reason = "CLOCK_EVIDENCE_INVALID";
  }
  return reason === null
    ? { status: "PASSED", ...evidence, reason: null }
    : { status: "BLOCKED", ...evidence, reason };
}

export async function checkPaperCampaignClockSafety(
  provider: ClockSafetyProvider = new ClobClockSafetyProvider(),
): Promise<PaperCampaignClockSafetyEvidence> {
  return evaluatePaperCampaignClockSafety({
    providerType: provider.providerType,
    result: await provider.check(),
  });
}
