import { describe, expect, it } from "vitest";
import {
  PAPER_CAMPAIGN_DEFAULT_LONG_SESSION_MS,
  paperCampaignPlannedDurationOverride,
  paperQualifyingFinalizationPolicy,
} from "../src/paper-validation/operator-policy.js";
import type { CampaignSnapshot } from "../src/paper-validation/types.js";

function snapshot(overrides: Partial<CampaignSnapshot>): CampaignSnapshot {
  return {
    campaignId: "PC-TEST",
    targetId: "target",
    baselineRunId: "baseline",
    paperAccountId: "account",
    initialBalanceMicros: "1000000000",
    requiredActiveRuntimeMs: 72 * 60 * 60 * 1_000,
    requiredContinuousRuntimeMs: 12 * 60 * 60 * 1_000,
    qualifyingRuntimeMs: 2 * 60 * 60 * 1_000,
    checkpointIntervalMs: 60_000,
    maxCheckpointGapMs: 90_000,
    coreCompatibilityHash: "a".repeat(64),
    coreManifest: {
      schemaVersion: "test",
      signalVersion: "test",
      strategyVersion: "test",
      riskVersion: "test",
      paperVersion: "test",
      rulesetHash: "test",
      configVersion: "test",
      components: {
        amountCalculation: "a",
        signalContext: "b",
        risk: "c",
        paperExecution: "d",
        observeRecovery: "e",
        settlementPnl: "f",
        schema: "g",
        runtimeEnvironment: "h",
      },
    },
    sourceVersion: { commit: "commit", dirty: false },
    createdAt: "2026-07-16T00:00:00.000Z",
    state: "PAUSED",
    qualified: true,
    completedSessionCount: 7,
    accumulatedActiveRuntimeMs: 72 * 60 * 60 * 1_000,
    longestContinuousRuntimeMs: 12 * 60 * 60 * 1_000,
    coverageStatus: "INCOMPLETE",
    coverage: {} as CampaignSnapshot["coverage"],
    missingScenarios: ["FILL"],
    blockers: [],
    canContinue: true,
    latestSessionId: "PS-LAST",
    latestReportId: "PR-LAST",
    ...overrides,
  };
}

describe("paper Campaign operator policy", () => {
  it("keeps a coverage-incomplete Campaign on a useful 12-hour session", () => {
    expect(paperCampaignPlannedDurationOverride(snapshot({ state: "INCOMPLETE_COVERAGE" })))
      .toBe(PAPER_CAMPAIGN_DEFAULT_LONG_SESSION_MS);
  });

  it("leaves ordinary qualifying and remaining-runtime planning to the service", () => {
    expect(paperCampaignPlannedDurationOverride(snapshot({ state: "PAUSED" }))).toBeUndefined();
    expect(paperCampaignPlannedDurationOverride(snapshot({
      state: "INCOMPLETE_COVERAGE",
      accumulatedActiveRuntimeMs: 71 * 60 * 60 * 1_000,
    }))).toBeUndefined();
  });

  it("keeps an early operator pause resumable without hiding any real blocker", () => {
    expect(paperQualifyingFinalizationPolicy({
      stopReason: "USER_SAFE_PAUSE_SIGTERM",
      gateBlockers: ["MINIMUM_RUNTIME_NOT_REACHED"],
    })).toEqual({ blockers: [], qualificationDeferred: true });
    expect(paperQualifyingFinalizationPolicy({
      stopReason: "USER_SAFE_PAUSE_SIGTERM",
      gateBlockers: ["MINIMUM_RUNTIME_NOT_REACHED", "PAPER_CONSISTENCY_FAILED"],
    })).toEqual({ blockers: ["PAPER_CONSISTENCY_FAILED"], qualificationDeferred: true });
    expect(paperQualifyingFinalizationPolicy({
      stopReason: "PLANNED_SESSION_DURATION_REACHED",
      gateBlockers: ["MINIMUM_RUNTIME_NOT_REACHED"],
    })).toEqual({ blockers: ["MINIMUM_RUNTIME_NOT_REACHED"], qualificationDeferred: false });
  });
});
