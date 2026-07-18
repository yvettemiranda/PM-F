import { describe, expect, it } from "vitest";
import { RULESET } from "../src/domain/versioning.js";
import {
  CLOB_TIME_ENDPOINT,
  evaluatePaperCampaignClockSafety,
} from "../src/paper-validation/clock-safety.js";

describe("Paper Campaign clock safety", () => {
  it("accepts only a live-readonly CLOB clock result inside the Paper threshold", () => {
    expect(evaluatePaperCampaignClockSafety({
      providerType: "LIVE_READONLY",
      result: {
        status: "SAFE",
        offsetMs: RULESET.clockUnsafeThresholdMs,
        checkedAt: "2026-07-18T01:00:00.000Z",
        source: CLOB_TIME_ENDPOINT,
        reason: null,
      },
    })).toEqual({
      status: "PASSED",
      clockSafetyStatus: "SAFE",
      offsetMs: RULESET.clockUnsafeThresholdMs,
      checkedAt: "2026-07-18T01:00:00.000Z",
      source: CLOB_TIME_ENDPOINT,
      thresholdMs: RULESET.clockUnsafeThresholdMs,
      reason: null,
    });
  });

  it("fails closed for excessive offset, unavailable evidence, wrong source, or fake providers", () => {
    const safeResult = {
      status: "SAFE" as const,
      offsetMs: 0,
      checkedAt: "2026-07-18T01:00:00.000Z",
      source: CLOB_TIME_ENDPOINT,
      reason: null,
    };
    expect(evaluatePaperCampaignClockSafety({
      providerType: "LIVE_READONLY",
      result: {
        ...safeResult,
        status: "UNSAFE",
        offsetMs: RULESET.clockUnsafeThresholdMs + 1,
        reason: "CLOCK_OFFSET_EXCEEDED",
      },
    })).toMatchObject({ status: "BLOCKED", reason: "CLOCK_OFFSET_EXCEEDED" });
    expect(evaluatePaperCampaignClockSafety({
      providerType: "LIVE_READONLY",
      result: {
        status: "UNAVAILABLE",
        offsetMs: null,
        checkedAt: null,
        source: CLOB_TIME_ENDPOINT,
        reason: "CLOCK_REQUEST_FAILED",
      },
    })).toMatchObject({ status: "BLOCKED", reason: "CLOCK_REQUEST_FAILED" });
    expect(evaluatePaperCampaignClockSafety({
      providerType: "LIVE_READONLY",
      result: { ...safeResult, source: "https://example.test/time" },
    })).toMatchObject({ status: "BLOCKED", reason: "CLOCK_SOURCE_INVALID" });
    expect(evaluatePaperCampaignClockSafety({
      providerType: "FAKE",
      result: safeResult,
    })).toMatchObject({ status: "BLOCKED", reason: "CLOCK_PROVIDER_NOT_LIVE_READONLY" });
  });
});
