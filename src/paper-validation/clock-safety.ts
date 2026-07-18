import { RULESET } from "../domain/versioning.js";
import { MAX_MARKET_CLOCK_CALIBRATION_OFFSET_MS } from "../execution/market-data.js";
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

export const PAPER_CLOCK_CALIBRATION_SAMPLE_COUNT = 5;

export interface PaperCampaignClockSafetyEvidence {
  status: "PASSED" | "BLOCKED";
  clockSafetyStatus: "SAFE" | "CALIBRATED" | "UNSAFE" | "UNAVAILABLE";
  offsetMs: number | null;
  checkedAt: string | null;
  source: string | null;
  thresholdMs: number;
  maxCalibratableOffsetMs: number;
  sampleCount: number;
  successfulSampleCount: number;
  sampleOffsetsMs: number[];
  spreadMs: number | null;
  reason: string | null;
}

function resultIsWellFormed(result: ClockSafetyResult): boolean {
  if (
    result.source !== CLOB_TIME_ENDPOINT
    || result.checkedAt === null
    || !Number.isFinite(Date.parse(result.checkedAt))
    || typeof result.offsetMs !== "number"
    || !Number.isSafeInteger(result.offsetMs)
  ) {
    return false;
  }
  if (result.status === "SAFE") {
    return Math.abs(result.offsetMs) <= RULESET.clockUnsafeThresholdMs
      && result.reason === null;
  }
  if (result.status === "UNSAFE") {
    return Math.abs(result.offsetMs) > RULESET.clockUnsafeThresholdMs
      && result.reason === "CLOCK_OFFSET_EXCEEDED";
  }
  return false;
}

function median(values: number[]): number {
  return [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)]!;
}

export function evaluatePaperCampaignClockSafety(input: {
  providerType: ReadonlySafetyProviderType;
  results: ClockSafetyResult[];
}): PaperCampaignClockSafetyEvidence {
  const sampleOffsetsMs = input.results.flatMap((result) => (
    typeof result.offsetMs === "number" && Number.isSafeInteger(result.offsetMs)
      ? [result.offsetMs]
      : []
  ));
  const unavailable = input.results.find((result) => result.status === "UNAVAILABLE");
  const invalidSource = input.results.find((result) => result.source !== CLOB_TIME_ENDPOINT);
  const checkedAt = input.results.at(-1)?.checkedAt ?? null;
  const source = invalidSource?.source ?? input.results.at(-1)?.source ?? null;
  const successfulSampleCount = input.results.filter(
    (result) => result.status !== "UNAVAILABLE" && resultIsWellFormed(result),
  ).length;
  const base = {
    offsetMs: null,
    checkedAt,
    source,
    thresholdMs: RULESET.clockUnsafeThresholdMs,
    maxCalibratableOffsetMs: MAX_MARKET_CLOCK_CALIBRATION_OFFSET_MS,
    sampleCount: PAPER_CLOCK_CALIBRATION_SAMPLE_COUNT,
    successfulSampleCount,
    sampleOffsetsMs,
    spreadMs: sampleOffsetsMs.length > 0
      ? Math.max(...sampleOffsetsMs) - Math.min(...sampleOffsetsMs)
      : null,
  } as const;

  let reason: string | null = null;
  if (input.providerType !== "LIVE_READONLY") {
    reason = "CLOCK_PROVIDER_NOT_LIVE_READONLY";
  } else if (input.results.length !== PAPER_CLOCK_CALIBRATION_SAMPLE_COUNT) {
    reason = "CLOCK_SAMPLE_COUNT_INVALID";
  } else if (invalidSource) {
    reason = "CLOCK_SOURCE_INVALID";
  } else if (unavailable) {
    reason = unavailable.reason ?? "CLOCK_UNAVAILABLE";
  } else if (!input.results.every(resultIsWellFormed)) {
    reason = "CLOCK_EVIDENCE_INVALID";
  }

  if (reason !== null) {
    return {
      status: "BLOCKED",
      clockSafetyStatus: unavailable ? "UNAVAILABLE" : "UNSAFE",
      ...base,
      reason,
    };
  }

  const offsetMs = median(sampleOffsetsMs);
  const spreadMs = Math.max(...sampleOffsetsMs) - Math.min(...sampleOffsetsMs);
  if (Math.abs(offsetMs) > MAX_MARKET_CLOCK_CALIBRATION_OFFSET_MS) {
    reason = "CLOCK_OFFSET_EXCEEDED";
  } else if (
    sampleOffsetsMs.some(
      (sampleOffsetMs) => Math.abs(sampleOffsetMs - offsetMs) > RULESET.clockUnsafeThresholdMs,
    )
  ) {
    reason = "CLOCK_CALIBRATION_UNSTABLE";
  }

  if (reason !== null) {
    return {
      status: "BLOCKED",
      clockSafetyStatus: "UNSAFE",
      ...base,
      offsetMs,
      spreadMs,
      reason,
    };
  }
  return {
    status: "PASSED",
    clockSafetyStatus: Math.abs(offsetMs) <= RULESET.clockUnsafeThresholdMs
      ? "SAFE"
      : "CALIBRATED",
    ...base,
    offsetMs,
    spreadMs,
    reason: null,
  };
}

export async function checkPaperCampaignClockSafety(
  provider: ClockSafetyProvider = new ClobClockSafetyProvider(),
): Promise<PaperCampaignClockSafetyEvidence> {
  const results: ClockSafetyResult[] = [];
  for (let index = 0; index < PAPER_CLOCK_CALIBRATION_SAMPLE_COUNT; index += 1) {
    results.push(await provider.check());
  }
  return evaluatePaperCampaignClockSafety({
    providerType: provider.providerType,
    results,
  });
}
