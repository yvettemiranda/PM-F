import { describe, expect, it } from "vitest";
import {
  assertPaperChildReadyBinding,
  buildFinalizationOutcome,
  buildObserveChildSpec,
  buildPaperChildSpec,
  campaignCheckpointEvidenceInput,
  classifyCampaignChildExit,
  deriveCampaignRuntimeTick,
  deriveCampaignStopPlan,
  nextCampaignCheckpointAt,
  qualificationMilestoneReached,
  type CampaignRuntimeBinding,
} from "../src/paper-validation/campaign-session-runtime.js";

const binding: CampaignRuntimeBinding = {
  campaignId: "PC-TEST",
  sessionId: "PS-TEST",
  paperAccountId: "PA-TEST",
  targetId: "target-test",
  targetWallet: "0x0000000000000000000000000000000000000001",
  baselineRunId: "baseline-test",
  marketClockOffsetMs: 1_700,
};

describe("Paper Campaign runtime contract", () => {
  it("builds fixed Paper and Observe child bindings", () => {
    const paper = buildPaperChildSpec({
      projectRoot: "/project",
      binding,
      accountFile: "/tmp/account",
      readyFile: "/tmp/ready",
      resultFile: "/tmp/paper.json",
    });
    expect(paper.script).toBe("/project/src/cli/paper-run.ts");
    expect(paper.args).toContain("--account-id=PA-TEST");
    expect(paper.args).toContain("--campaign-id=PC-TEST");
    expect(paper.args).toContain("--session-id=PS-TEST");
    expect(paper.args).toContain("--market-clock-offset-ms=1700");

    const observe = buildObserveChildSpec({
      projectRoot: "/project",
      binding,
      resultFile: "/tmp/observe.json",
      minimumSoakSeconds: 7_200,
    });
    expect(observe.script).toBe("/project/src/cli/observe-only.ts");
    expect(observe.args).toContain("--baseline-run-id=baseline-test");
    expect(observe.args).toContain("--minimum-soak-seconds=7200");
    expect(observe.args).toContain("--market-clock-offset-ms=1700");
    expect(observe.args).toContain("--poll-seconds=3");
    expect(observe.args).toContain("--reconciliation-seconds=15");
  });

  it("fails closed on child binding drift", () => {
    const ready = {
      status: "READY",
      mode: "PAPER",
      accountId: binding.paperAccountId,
      accountSource: "EXPLICIT",
      targetId: binding.targetId,
      targetWallet: binding.targetWallet,
      campaignId: binding.campaignId,
      sessionId: binding.sessionId,
      marketClockOffsetMs: binding.marketClockOffsetMs,
    };
    expect(() => assertPaperChildReadyBinding(ready, binding)).not.toThrow();
    expect(() => assertPaperChildReadyBinding({ ...ready, accountId: "wrong" }, binding))
      .toThrow("PAPER_CAMPAIGN_READY_EVIDENCE_INVALID");
    expect(() => assertPaperChildReadyBinding({ ...ready, marketClockOffsetMs: 0 }, binding))
      .toThrow("PAPER_CAMPAIGN_READY_EVIDENCE_INVALID");
  });

  it("fixes stop order, exit classification, milestone and checkpoint scope", () => {
    expect(deriveCampaignStopPlan({ observeRunning: true, paperRunning: true, finalValuation: true }))
      .toEqual([
        { role: "OBSERVE", signal: "SIGTERM" },
        { role: "PAPER", signal: "SIGUSR1" },
      ]);
    expect(classifyCampaignChildExit("PAPER", { code: null, signal: "SIGKILL", forced: true }))
      .toEqual(["PAPER_FORCED_STOP", "PAPER_EXIT_CODE:SIGKILL"]);
    expect(qualificationMilestoneReached({
      alreadyRecorded: false,
      sessionKind: "QUALIFYING",
      nowMs: 7_200_000,
      activeStartedAtMs: 0,
      qualifyingRuntimeMs: 7_200_000,
    })).toBe(true);
    expect(campaignCheckpointEvidenceInput({
      databasePath: "/db",
      binding,
      observeActive: true,
      paperActive: true,
      detail: { stage: "ACTIVE" },
    }).scope).toEqual({
      campaignId: binding.campaignId,
      sessionId: binding.sessionId,
      baselineRunId: binding.baselineRunId,
    });
  });

  it("derives duration and checkpoint timing from monotonic time without catch-up writes", () => {
    expect(deriveCampaignRuntimeTick({
      sessionStartedMonotonicMs: 1_000,
      activeStartedMonotonicMs: 2_000,
      nowMonotonicMs: 122_000,
      nextCheckpointMonotonicMs: 62_000,
      plannedDurationMs: 600_000,
    })).toEqual({
      elapsedRuntimeMs: 121_000,
      activeRuntimeMs: 120_000,
      checkpointDue: true,
      durationReached: false,
    });
    expect(nextCampaignCheckpointAt(122_000, 60_000)).toBe(182_000);
  });

  it("derives finalization outcome without report coupling", () => {
    expect(buildFinalizationOutcome({ processBlockerCount: 1, finalizationBlockerCount: 0, autoStopped: true }))
      .toBe("FAILED");
    expect(buildFinalizationOutcome({ processBlockerCount: 0, finalizationBlockerCount: 0, autoStopped: true }))
      .toBe("AUTO_STOP");
    expect(buildFinalizationOutcome({ processBlockerCount: 0, finalizationBlockerCount: 0, autoStopped: false }))
      .toBe("SAFE_STOP");
  });
});
