import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { PublicTrade } from "../src/domain/models.js";
import { Phase0Database } from "../src/infra/sqlite/database.js";
import { ReplayEngine } from "../src/replay/replay-engine.js";
import { sourceEventKey } from "../src/domain/idempotency.js";
import { estimateTargetCapital } from "../src/services/capital-estimator.js";

const wallet = "0x0000000000000000000000000000000000000001";
const directories: string[] = [];

function workspace(): { directory: string; databasePath: string } {
  const directory = mkdtempSync(join(tmpdir(), "ni-k-phase0-"));
  directories.push(directory);
  return { directory, databasePath: join(directory, "phase0.sqlite") };
}

function trade(overrides: Partial<PublicTrade> = {}): PublicTrade {
  return {
    proxyWallet: wallet,
    transactionHash: "0x1",
    conditionId: "0x2",
    asset: "1",
    side: "BUY",
    price: "0.5",
    size: "10",
    timestamp: 1_700_000_000,
    ...overrides,
  };
}

function passedReport(trades: PublicTrade[]) {
  return new ReplayEngine().run({
    walletAddress: wallet,
    identityStatus: "IDENTITY_CONFIRMED",
    trades,
    activity: [],
    hasCapitalSnapshots: true,
    hasGoldenExpectations: true,
  });
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Phase0Database", () => {
  it("keeps raw events, signals, and signal transitions idempotent across repeated replay saves", () => {
    const { databasePath } = workspace();
    const trades = [trade(), trade({ transactionHash: "0x2", price: "0.6" })];
    const database = new Phase0Database(databasePath);
    database.initialize();
    const targetId = database.ensureTarget(wallet, "IDENTITY_CONFIRMED");
    const report = passedReport(trades);
    database.saveReplay(targetId, trades, [], report);
    database.saveReplay(targetId, trades, [], report);
    database.close();

    const check = new DatabaseSync(databasePath, { readOnly: true });
    expect((check.prepare("SELECT count(*) count FROM raw_events").get() as { count: number }).count).toBe(2);
    expect((check.prepare("SELECT count(*) count FROM signals").get() as { count: number }).count).toBe(2);
    expect(
      (check.prepare("SELECT count(*) count FROM state_transitions WHERE entity_type='SIGNAL'").get() as { count: number }).count,
    ).toBe(8);
    expect((check.prepare("SELECT count(*) count FROM replay_runs").get() as { count: number }).count).toBe(2);
    check.close();
  });

  it("persists confirmed identical fill occurrences without collapsing them", () => {
    const { databasePath } = workspace();
    const first = trade({ transactionHash: "0xidentical" });
    const trades = [first, { ...first }];
    const activity = trades.map((item) => ({ ...item, type: "TRADE" }));
    const report = new ReplayEngine().run({
      walletAddress: wallet,
      identityStatus: "IDENTITY_CONFIRMED",
      trades,
      activity,
      hasCapitalSnapshots: true,
      hasGoldenExpectations: true,
    });
    const database = new Phase0Database(databasePath);
    database.initialize();
    const targetId = database.ensureTarget(wallet, "IDENTITY_CONFIRMED");
    database.saveReplay(targetId, trades, activity, report);
    database.saveReplay(targetId, trades, activity, report);
    database.close();

    const check = new DatabaseSync(databasePath, { readOnly: true });
    expect((check.prepare("SELECT count(*) count FROM raw_events").get() as { count: number }).count).toBe(2);
    expect((check.prepare("SELECT count(*) count FROM signals").get() as { count: number }).count).toBe(2);
    expect((check.prepare(
      "SELECT count(DISTINCT source_event_key) count FROM raw_events",
    ).get() as { count: number }).count).toBe(2);
    check.close();
  });

  it("rolls back the complete critical transaction when one raw event is invalid", () => {
    const { databasePath } = workspace();
    const valid = trade();
    const invalid = trade({ transactionHash: "0x2", price: "0.1234567890123456789" });
    const database = new Phase0Database(databasePath);
    database.initialize();
    const targetId = database.ensureTarget(wallet, "IDENTITY_CONFIRMED");
    expect(() => database.saveReplay(targetId, [valid, invalid], [], passedReport([valid]))).toThrow(/Precision exceeds/);
    database.close();

    const check = new DatabaseSync(databasePath, { readOnly: true });
    expect((check.prepare("SELECT count(*) count FROM raw_events").get() as { count: number }).count).toBe(0);
    expect((check.prepare("SELECT count(*) count FROM signals").get() as { count: number }).count).toBe(0);
    expect((check.prepare("SELECT count(*) count FROM replay_runs").get() as { count: number }).count).toBe(0);
    check.close();
  });

  it("marks an orphaned replay job INTERRUPTED and completes a clean replacement without duplicates", () => {
    const { databasePath } = workspace();
    const trades = [trade()];
    const first = new Phase0Database(databasePath);
    first.initialize();
    const targetId = first.ensureTarget(wallet, "IDENTITY_CONFIRMED");
    const orphanedJobId = first.beginReplayJob(null);
    first.close();

    const mutate = new DatabaseSync(databasePath);
    mutate.prepare("UPDATE replay_jobs SET heartbeat_at=? WHERE replay_job_id=?")
      .run("2026-01-01T00:00:00.000Z", orphanedJobId);
    mutate.close();

    const recovered = new Phase0Database(databasePath);
    recovered.initialize();
    expect(recovered.recoverInterruptedReplayJobs("2026-07-07T00:00:00.000Z")).toEqual([orphanedJobId]);
    const replacementJobId = recovered.beginReplayJob(null, orphanedJobId);
    const replayRunId = recovered.saveReplay(targetId, trades, [], passedReport(trades));
    recovered.completeReplayJob(replacementJobId, replayRunId);
    recovered.close();

    const check = new DatabaseSync(databasePath, { readOnly: true });
    expect((check.prepare("SELECT state FROM replay_jobs WHERE replay_job_id=?").get(orphanedJobId) as { state: string }).state)
      .toBe("INTERRUPTED");
    expect((check.prepare("SELECT state FROM replay_jobs WHERE replay_job_id=?").get(replacementJobId) as { state: string }).state)
      .toBe("COMPLETED");
    expect((check.prepare("SELECT count(*) count FROM raw_events").get() as { count: number }).count).toBe(1);
    expect((check.prepare("SELECT count(*) count FROM signals").get() as { count: number }).count).toBe(1);
    check.close();
  });

  it("persists gap behavior signals as execution ineligible", () => {
    const { databasePath } = workspace();
    const trades = [trade()];
    const report = new ReplayEngine().run({
      walletAddress: wallet,
      identityStatus: "IDENTITY_CONFIRMED",
      trades,
      activity: [],
      gaps: [{ fromTimestamp: 1_699_999_999, toTimestamp: 1_700_000_001 }],
      hasCapitalSnapshots: true,
      hasGoldenExpectations: true,
    });
    const database = new Phase0Database(databasePath);
    database.initialize();
    const targetId = database.ensureTarget(wallet, "IDENTITY_CONFIRMED");
    database.saveReplay(targetId, trades, [], report);
    database.close();

    const check = new DatabaseSync(databasePath, { readOnly: true });
    const signal = check.prepare(
      "SELECT execution_eligible, execution_block_reason, event_classification FROM signals LIMIT 1",
    ).get() as { execution_eligible: number; execution_block_reason: string; event_classification: string };
    expect(signal).toEqual({ execution_eligible: 0, execution_block_reason: "GAP_EVENT", event_classification: "GAP_TRADE" });
    check.close();
  });

  it("links a BUY signal to its versioned capital estimate", () => {
    const { databasePath } = workspace();
    const trades = [trade()];
    const eventKey = sourceEventKey(trades[0]!);
    const estimate = estimateTargetCapital({
      walletAddress: wallet,
      sourceEventKey: eventKey,
      identityStatus: "IDENTITY_CONFIRMED",
      syncStatus: "SYNCED",
      positions: null,
      positionSnapshotTime: null,
      walletBalanceMicros: null,
      walletBalanceSnapshotTime: null,
      targetTrade: { price: "0.5", size: "10", timestamp: 1_700_000_000 },
    });
    const database = new Phase0Database(databasePath);
    database.initialize();
    const targetId = database.ensureTarget(wallet, "IDENTITY_CONFIRMED");
    database.saveReplay(targetId, trades, [], passedReport(trades), {
      capitalEstimatesBySourceEventKey: { [eventKey]: estimate },
    });
    database.close();

    const check = new DatabaseSync(databasePath, { readOnly: true });
    expect((check.prepare("SELECT capital_estimate_id FROM signals LIMIT 1").get() as { capital_estimate_id: string }).capital_estimate_id)
      .toBe(estimate.capitalEstimateId);
    expect((check.prepare("SELECT capital_confidence FROM capital_estimates LIMIT 1").get() as { capital_confidence: string }).capital_confidence)
      .toBe("MEDIUM");
    check.close();
  });

  it("deduplicates identical capital estimates and rejects a conflicting reused identity", () => {
    const { databasePath } = workspace();
    const database = new Phase0Database(databasePath);
    database.initialize();
    const targetId = database.ensureTarget(wallet, "IDENTITY_CONFIRMED");
    const estimate = estimateTargetCapital({
      walletAddress: wallet,
      identityStatus: "IDENTITY_CONFIRMED",
      syncStatus: "SYNCED",
      positions: null,
      positionSnapshotTime: null,
      walletBalanceMicros: null,
      walletBalanceSnapshotTime: null,
    });

    database.saveCapitalEstimate(targetId, null, estimate);
    database.saveCapitalEstimate(targetId, null, estimate);
    expect(() => database.saveCapitalEstimate(targetId, null, {
      ...estimate,
      targetVisibleCapitalMicros: "1",
    })).toThrow("CAPITAL_ESTIMATE_CONFLICT");
    database.close();

    const check = new DatabaseSync(databasePath, { readOnly: true });
    expect((check.prepare("SELECT count(*) count FROM capital_estimates").get() as { count: number }).count).toBe(1);
    expect(check.prepare("SELECT target_visible_capital_micros FROM capital_estimates").get())
      .toEqual({ target_visible_capital_micros: null });
    check.close();
  });
});
