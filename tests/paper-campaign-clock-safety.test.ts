import { describe, expect, it } from "vitest";
import { RULESET } from "../src/domain/versioning.js";
import {
  CLOB_TIME_ENDPOINT,
  checkPaperCampaignClockSafety,
  evaluatePaperCampaignClockSafety,
  PAPER_CLOCK_CALIBRATION_SAMPLE_COUNT,
} from "../src/paper-validation/clock-safety.js";
import type {
  ClockSafetyProvider,
  ClockSafetyResult,
} from "../src/live/live-safety-provider.js";

describe("Paper Campaign clock safety", () => {
  const result = (offsetMs: number): ClockSafetyResult => ({
    status: Math.abs(offsetMs) <= RULESET.clockUnsafeThresholdMs ? "SAFE" : "UNSAFE",
    offsetMs,
    checkedAt: "2026-07-18T01:00:00.000Z",
    source: CLOB_TIME_ENDPOINT,
    reason: Math.abs(offsetMs) <= RULESET.clockUnsafeThresholdMs ? null : "CLOCK_OFFSET_EXCEEDED",
  });

  it("calibrates a stable multi-sample offset by median even when raw results are unsafe", () => {
    expect(evaluatePaperCampaignClockSafety({
      providerType: "LIVE_READONLY",
      results: [result(1_100), result(1_500), result(2_050), result(1_700), result(1_900)],
    })).toEqual({
      status: "PASSED",
      clockSafetyStatus: "CALIBRATED",
      offsetMs: 1_700,
      checkedAt: "2026-07-18T01:00:00.000Z",
      source: CLOB_TIME_ENDPOINT,
      thresholdMs: RULESET.clockUnsafeThresholdMs,
      maxCalibratableOffsetMs: 5_000,
      sampleCount: PAPER_CLOCK_CALIBRATION_SAMPLE_COUNT,
      successfulSampleCount: PAPER_CLOCK_CALIBRATION_SAMPLE_COUNT,
      sampleOffsetsMs: [1_100, 1_500, 2_050, 1_700, 1_900],
      spreadMs: 950,
      reason: null,
    });
  });

  it("samples the live-readonly provider exactly once per required calibration sample", async () => {
    let calls = 0;
    const offsets = [1_100, 1_500, 2_050, 1_700, 1_900];
    const provider: ClockSafetyProvider = {
      providerType: "LIVE_READONLY",
      check: async () => result(offsets[calls++]!),
    };
    await expect(checkPaperCampaignClockSafety(provider)).resolves.toMatchObject({
      status: "PASSED",
      offsetMs: 1_700,
      successfulSampleCount: PAPER_CLOCK_CALIBRATION_SAMPLE_COUNT,
    });
    expect(calls).toBe(PAPER_CLOCK_CALIBRATION_SAMPLE_COUNT);
  });

  it("fails closed for excessive offset, inconsistent samples, unavailable evidence, wrong source, or fake providers", () => {
    expect(evaluatePaperCampaignClockSafety({
      providerType: "LIVE_READONLY",
      results: [result(5_001), result(5_100), result(5_200), result(5_300), result(5_400)],
    })).toMatchObject({ status: "BLOCKED", reason: "CLOCK_OFFSET_EXCEEDED" });
    expect(evaluatePaperCampaignClockSafety({
      providerType: "LIVE_READONLY",
      results: [result(0), result(100), result(2_100), result(2_200), result(2_300)],
    })).toMatchObject({ status: "BLOCKED", reason: "CLOCK_CALIBRATION_UNSTABLE" });
    expect(evaluatePaperCampaignClockSafety({
      providerType: "LIVE_READONLY",
      results: [
        result(0),
        result(0),
        {
        status: "UNAVAILABLE",
        offsetMs: null,
        checkedAt: null,
        source: CLOB_TIME_ENDPOINT,
        reason: "CLOCK_REQUEST_FAILED",
        },
        result(0),
        result(0),
      ],
    })).toMatchObject({ status: "BLOCKED", reason: "CLOCK_REQUEST_FAILED" });
    expect(evaluatePaperCampaignClockSafety({
      providerType: "LIVE_READONLY",
      results: [
        result(0),
        result(0),
        { ...result(0), source: "https://example.test/time" },
        result(0),
        result(0),
      ],
    })).toMatchObject({ status: "BLOCKED", reason: "CLOCK_SOURCE_INVALID" });
    expect(evaluatePaperCampaignClockSafety({
      providerType: "FAKE",
      results: Array.from({ length: PAPER_CLOCK_CALIBRATION_SAMPLE_COUNT }, () => result(0)),
    })).toMatchObject({ status: "BLOCKED", reason: "CLOCK_PROVIDER_NOT_LIVE_READONLY" });
  });
});
