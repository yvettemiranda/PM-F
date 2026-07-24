import { describe, expect, it } from "vitest";
import { parsePaperCampaignChildResult } from "../src/paper-validation/campaign-child-result.js";

describe("Paper Campaign child result parsing", () => {
  it("does not treat a Paper runner failure payload as a normal campaign report", () => {
    const result = parsePaperCampaignChildResult({
      mode: "PAPER",
      status: "FAILED",
      failedAt: "2026-07-24T08:45:07.600Z",
      error: "unable to open database file",
      safety: {
        privateKeyLoaded: false,
        authenticatedTradingClientPresent: false,
        realOrdersCreated: 0,
        chainWrites: 0,
      },
    });

    expect(result).toEqual({
      kind: "FAILURE",
      failure: {
        mode: "PAPER",
        status: "FAILED",
        failedAt: "2026-07-24T08:45:07.600Z",
        error: "unable to open database file",
      },
    });
  });

  it("accepts a complete Paper campaign report", () => {
    const report = {
      mode: "PAPER",
      status: "COMPLETED",
      shutdownMode: "FINAL_VALUATION",
      sourceCodeCommit: "a".repeat(40),
      sourceCodeDirty: false,
      campaignId: "PC-TEST",
      sessionId: "PS-TEST",
      marketClockOffsetMs: 1_266,
      finalDrainConsumedSignals: 0,
      report: {
        startedAt: "2026-07-24T08:00:00.000Z",
        stoppedAt: "2026-07-24T08:01:00.000Z",
        errorCount: 0,
        account: { valuationStatus: "COMPLETE", unpricedPositionCount: 0 },
        acceptance: {},
      },
      safety: {
        privateKeyLoaded: false,
        authenticatedTradingClientPresent: false,
        realOrdersCreated: 0,
        chainWrites: 0,
        liveExecutorPresent: false,
      },
    };

    expect(parsePaperCampaignChildResult(report)).toEqual({
      kind: "REPORT",
      report,
    });
  });
});
