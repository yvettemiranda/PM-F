import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import {
  advancePaperSessionCutoff,
  assertPaperCampaignRuntimeBinding,
  finalizePaperSession,
  paperCampaignScope,
  paperRunnerOptions,
} from "../src/paper/paper-session-runtime.js";
import type { PaperRunnerReport } from "../src/paper/paper-runner.js";

const coreHash = "a".repeat(64);

function bindingDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE paper_accounts(paper_account_id TEXT PRIMARY KEY,target_id TEXT,status TEXT);
    CREATE TABLE position_baseline_runs(baseline_run_id TEXT PRIMARY KEY,target_id TEXT,status TEXT);
    CREATE TABLE paper_validation_campaigns(
      campaign_id TEXT PRIMARY KEY,paper_account_id TEXT,target_id TEXT,baseline_run_id TEXT,
      core_compatibility_hash TEXT,execution_mode TEXT,live_gate_state TEXT
    );
    CREATE TABLE paper_validation_sessions(
      session_id TEXT PRIMARY KEY,campaign_id TEXT,core_compatibility_hash TEXT,
      source_code_commit TEXT,source_code_dirty INTEGER
    );
    CREATE TABLE paper_validation_transitions(
      sequence INTEGER,entity_type TEXT,campaign_id TEXT,session_id TEXT,to_state TEXT
    );
    INSERT INTO paper_accounts VALUES ('PA','target','ACTIVE');
    INSERT INTO position_baseline_runs VALUES ('baseline','target','READY');
    INSERT INTO paper_validation_campaigns VALUES (
      'PC','PA','target','baseline','${coreHash}','PAPER','LIVE_DISABLED'
    );
    INSERT INTO paper_validation_sessions VALUES ('PS','PC','${coreHash}','commit',0);
    INSERT INTO paper_validation_transitions VALUES (1,'CAMPAIGN','PC',NULL,'RUNNING');
    INSERT INTO paper_validation_transitions VALUES (1,'SESSION','PC','PS','RUNNING');
  `);
  return database;
}

describe("Paper Session runtime contract", () => {
  it("binds Campaign scope to current core before cutoff", () => {
    const scope = paperCampaignScope("PC", "PS", coreHash)!;
    const database = bindingDatabase();
    expect(assertPaperCampaignRuntimeBinding(database, scope, { commit: "commit", dirty: false }))
      .toEqual({
        campaignId: "PC",
        sessionId: "PS",
        paperAccountId: "PA",
        targetId: "target",
        baselineRunId: "baseline",
      });
    expect(() => assertPaperCampaignRuntimeBinding(
      database,
      { ...scope, coreCompatibilityHash: "b".repeat(64) },
      { commit: "commit", dirty: false },
    )).toThrow("PAPER_CAMPAIGN_SESSION_RUNTIME_BINDING_INVALID");
    expect(() => assertPaperCampaignRuntimeBinding(database, scope, { commit: "commit", dirty: true }))
      .toThrow("PAPER_CAMPAIGN_SESSION_SOURCE_DIRTY");
    database.close();
  });

  it("carries core scope into the PaperRunner and advances cutoff with the fixed reason", () => {
    const scope = paperCampaignScope("PC", "PS", coreHash);
    expect(paperRunnerOptions({ accountId: "PA", intervalMs: 1_000, campaignScope: scope }))
      .toMatchObject({ signalScope: { campaignId: "PC", sessionId: "PS", coreCompatibilityHash: coreHash } });
    const advance = vi.fn(() => ({ accountId: "PA" }));
    advancePaperSessionCutoff({ advanceConsumerCutoff: advance } as never, "PA", "2026-07-17T00:00:00Z");
    expect(advance).toHaveBeenCalledWith("PA", "2026-07-17T00:00:00Z", "PAPER_RUNNER_SESSION_START");
  });

  it("drains before cancelling waiting BUYs and rebuilding final valuation", async () => {
    const order: string[] = [];
    const account = {
      paperAccountId: "PA",
      valuationStatus: "COMPLETE",
      unpricedPositionCount: 0,
    };
    const report = {
      accountId: "PA",
      startedAt: "2026-07-17T00:00:00.000Z",
      stoppedAt: "2026-07-17T00:01:00.000Z",
      cycles: 2,
      consumedSignals: 3,
      errorCount: 0,
      droppedErrorCount: 0,
      errors: [],
      account,
      acceptance: {},
    } as unknown as PaperRunnerReport;
    const finalized = await finalizePaperSession({
      runner: { finalDrain: async () => { order.push("drain"); return 2; } },
      executor: {
        cancelWaitingBuys: async () => { order.push("cancel"); return 1; },
        accountSnapshot: async () => { order.push("snapshot"); return account as never; },
        acceptanceSummary: () => { order.push("acceptance"); return {} as never; },
      },
      accountId: "PA",
      report,
      signal: new AbortController().signal,
      now: () => new Date("2026-07-17T00:02:00.000Z"),
    });
    expect(order).toEqual(["drain", "cancel", "snapshot", "acceptance"]);
    expect(finalized.finalDrainConsumedSignals).toBe(2);
    expect(finalized.cancelledWaitingBuyCount).toBe(1);
    expect(finalized.report.consumedSignals).toBe(5);
    expect(finalized.report.cycles).toBe(3);
  });

  it("retries only the read-only final valuation when the public API recovers", async () => {
    const incomplete = {
      paperAccountId: "PA",
      valuationStatus: "INCOMPLETE",
      unpricedPositionCount: 1,
    };
    const complete = {
      paperAccountId: "PA",
      valuationStatus: "COMPLETE",
      unpricedPositionCount: 0,
    };
    const accountSnapshot = vi.fn()
      .mockResolvedValueOnce(incomplete)
      .mockResolvedValueOnce(complete);
    const report = {
      accountId: "PA",
      startedAt: "2026-07-17T00:00:00.000Z",
      stoppedAt: "2026-07-17T00:01:00.000Z",
      cycles: 1,
      consumedSignals: 0,
      errorCount: 0,
      droppedErrorCount: 0,
      errors: [],
      account: incomplete,
      acceptance: {},
    } as unknown as PaperRunnerReport;

    const finalized = await finalizePaperSession({
      runner: { finalDrain: async () => 0 },
      executor: {
        cancelWaitingBuys: async () => 0,
        accountSnapshot,
        acceptanceSummary: () => ({} as never),
      },
      accountId: "PA",
      report,
      signal: new AbortController().signal,
      valuationRecovery: {
        maxAttempts: 2,
        wait: async () => undefined,
      },
    });

    expect(accountSnapshot).toHaveBeenCalledTimes(2);
    expect(finalized.account).toBe(complete);
    expect(finalized.valuationRecovery).toEqual({
      attempts: 2,
      recovered: true,
      status: "COMPLETE",
    });
  });

  it("retries an aborted final drain idempotently before cancelling BUYs", async () => {
    const finalDrain = vi.fn()
      .mockRejectedValueOnce(new Error("FINAL_DRAIN_INCOMPLETE"))
      .mockResolvedValueOnce(1);
    const cancelWaitingBuys = vi.fn(async () => 0);
    const account = {
      paperAccountId: "PA",
      valuationStatus: "COMPLETE",
      unpricedPositionCount: 0,
    };
    const report = {
      accountId: "PA",
      startedAt: "2026-07-17T00:00:00.000Z",
      stoppedAt: "2026-07-17T00:01:00.000Z",
      cycles: 1,
      consumedSignals: 0,
      errorCount: 0,
      droppedErrorCount: 0,
      errors: [],
      account,
      acceptance: {},
    } as unknown as PaperRunnerReport;

    const finalized = await finalizePaperSession({
      runner: { finalDrain },
      executor: {
        cancelWaitingBuys,
        accountSnapshot: async () => account as never,
        acceptanceSummary: () => ({} as never),
      },
      accountId: "PA",
      report,
      signal: new AbortController().signal,
      finalDrainRecovery: {
        maxAttempts: 2,
        wait: async () => undefined,
      },
    });

    expect(finalDrain).toHaveBeenCalledTimes(2);
    expect(cancelWaitingBuys).toHaveBeenCalledTimes(1);
    expect(finalized.finalDrainConsumedSignals).toBe(1);
    expect(finalized.finalDrainRecovery).toEqual({
      attempts: 2,
      recovered: true,
      status: "COMPLETE",
    });
  });
});
