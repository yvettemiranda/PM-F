import { describe, expect, it } from "vitest";
import {
  PAPER_CAMPAIGN_DEFAULT_LONG_SESSION_MS,
  paperCampaignReplacementReason,
  paperCampaignStartDisposition,
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
        paperRules: "i",
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
    latestCompatibilityIdentity: {
      validationPolicyHash: "1".repeat(64),
      verificationSuiteHash: "2".repeat(64),
      operatorBuildHash: "3".repeat(64),
      artifactProvenanceHash: "4".repeat(64),
    },
    ...overrides,
  };
}

describe("paper Campaign operator policy", () => {
  it("starts a replacement for any terminal Campaign on a different core", () => {
    const clockBlocked = snapshot({
      state: "BLOCKED",
      coreCompatibilityHash: "a".repeat(64),
      blockers: [
        "FINAL_VALUATION_INCOMPLETE",
        "PAPER_EXIT_CODE:1",
        "PAPER_FINAL_VALUATION_INCOMPLETE",
        "PAPER_STATUS:COMPLETED_WITH_SAFETY_BLOCKERS",
        "UNRECOVERED_MARKET_DATA_BLOCKER",
      ],
    });
    expect(paperCampaignReplacementReason(clockBlocked, "b".repeat(64)))
      .toBe("CORE_VERSION_REPLACEMENT");
    expect(paperCampaignStartDisposition(clockBlocked, "b".repeat(64)))
      .toBe("CREATE_REPLACEMENT");
    expect(paperCampaignStartDisposition(
      snapshot({
        state: "BLOCKED",
        coreCompatibilityHash: "a".repeat(64),
        blockers: [
          "PAPER_EXIT_CODE:1",
          "PAPER_STATUS:COMPLETED_WITH_SAFETY_BLOCKERS",
          "UNRECOVERED_MARKET_DATA_BLOCKER",
        ],
      }),
      "b".repeat(64),
    )).toBe("CREATE_REPLACEMENT");
    expect(paperCampaignStartDisposition(
      snapshot({
        state: "BLOCKED",
        coreCompatibilityHash: "a".repeat(64),
        blockers: ["MAJOR_DESYNC:1", "OBSERVE_STATUS:SHORT_SOAK_FAILED"],
      }),
      "b".repeat(64),
    )).toBe("CREATE_REPLACEMENT");
    expect(paperCampaignStartDisposition(
      snapshot({ state: "BLOCKED", coreCompatibilityHash: "a".repeat(64) }),
      "a".repeat(64),
    )).toBe("REFUSE_TERMINAL");
    expect(paperCampaignStartDisposition(
      snapshot({
        state: "BLOCKED",
        coreCompatibilityHash: "a".repeat(64),
        blockers: ["PAPER_EXIT_CODE:1"],
      }),
      "b".repeat(64),
    )).toBe("CREATE_REPLACEMENT");
    expect(paperCampaignStartDisposition(
      snapshot({
        state: "BLOCKED",
        coreCompatibilityHash: "a".repeat(64),
        blockers: ["UNRECOVERED_MARKET_DATA_BLOCKER", "PAPER_EXIT_CODE:137"],
      }),
      "b".repeat(64),
    )).toBe("CREATE_REPLACEMENT");
    expect(paperCampaignStartDisposition(
      snapshot({
        ...clockBlocked,
        blockers: clockBlocked.blockers.filter((blocker) => blocker !== "PAPER_FINAL_VALUATION_INCOMPLETE"),
      }),
      "b".repeat(64),
    )).toBe("CREATE_REPLACEMENT");
    expect(paperCampaignStartDisposition(
      snapshot({
        ...clockBlocked,
        blockers: [...clockBlocked.blockers, "PAPER_CONSISTENCY_FAILED"],
      }),
      "b".repeat(64),
    )).toBe("CREATE_REPLACEMENT");
    expect(paperCampaignStartDisposition(
      snapshot({ state: "PAUSED", coreCompatibilityHash: "a".repeat(64) }),
      "a".repeat(64),
    )).toBe("CONTINUE");
    expect(paperCampaignStartDisposition(
      snapshot({
        state: "BLOCKED",
        coreCompatibilityHash: "a".repeat(64),
        blockers: ["PAPER_ACCEPTANCE_INCONSISTENT"],
      }),
      "b".repeat(64),
    )).toBe("CREATE_REPLACEMENT");
    expect(paperCampaignStartDisposition(
      snapshot({
        state: "BLOCKED",
        coreCompatibilityHash: "a".repeat(64),
        blockers: ["MAJOR_DESYNC:1", "OBSERVE_STATUS:SHORT_SOAK_FAILED", "PAPER_CONSISTENCY_FAILED"],
      }),
      "b".repeat(64),
    )).toBe("CREATE_REPLACEMENT");
    expect(paperCampaignStartDisposition(
      snapshot({ state: "PASSED", coreCompatibilityHash: "a".repeat(64) }),
      "b".repeat(64),
    )).toBe("CREATE_REPLACEMENT");
    expect(paperCampaignStartDisposition(
      snapshot({ state: "FROZEN", coreCompatibilityHash: "a".repeat(64) }),
      "b".repeat(64),
    )).toBe("CREATE_REPLACEMENT");
  });

  it("revalidates only a same-core PASSED Campaign whose policy or suite changed", () => {
    const passed = snapshot({ state: "PASSED", coreCompatibilityHash: "a".repeat(64) });
    expect(paperCampaignStartDisposition(passed, "a".repeat(64), {
      ...passed.latestCompatibilityIdentity!,
      validationPolicyHash: "5".repeat(64),
    })).toBe("REVALIDATE_TERMINAL");
    expect(paperCampaignStartDisposition(passed, "a".repeat(64), passed.latestCompatibilityIdentity!))
      .toBe("REFUSE_TERMINAL");
    expect(paperCampaignStartDisposition(
      snapshot({ ...passed, state: "BLOCKED" }),
      "a".repeat(64),
      {
        ...passed.latestCompatibilityIdentity!,
        verificationSuiteHash: "6".repeat(64),
      },
    )).toBe("REFUSE_TERMINAL");
  });

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
