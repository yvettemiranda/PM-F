import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { PublicTrade } from "../src/domain/models.js";
import { Phase0Database } from "../src/infra/sqlite/database.js";
import { ReplayEngine } from "../src/replay/replay-engine.js";
import { sourceEventKey } from "../src/domain/idempotency.js";
import { stableJson } from "../src/domain/versioning.js";
import { estimateTargetCapital } from "../src/services/capital-estimator.js";
import { assertObserveProjectionSnapshotMigrationPreflight } from "../src/infra/sqlite/migration-preflight.js";

const wallet = "0x0000000000000000000000000000000000000001";
const replayTargetId = createHash("sha256").update(wallet).digest("hex");
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
    targetId: replayTargetId,
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
  it("verifies every legacy Observe projection against canonical stableJson SHA-256", () => {
    const { databasePath } = workspace();
    const database = new DatabaseSync(databasePath);
    database.exec(`CREATE TABLE observe_checkpoints(
      checkpoint_id TEXT PRIMARY KEY,
      position_projection_json TEXT NOT NULL,
      position_projection_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`);
    const projection = { z: 2, assets: [{ tracked: "10", asset: "a" }] };
    const projectionJson = JSON.stringify(projection);
    const canonicalHash = createHash("sha256").update(stableJson(projection)).digest("hex");
    database.prepare(
      `INSERT INTO observe_checkpoints(
        checkpoint_id,position_projection_json,position_projection_hash,created_at
      ) VALUES (?,?,?,?)`,
    ).run("checkpoint-valid", projectionJson, canonicalHash, "2026-07-17T00:00:00.000Z");

    expect(() => assertObserveProjectionSnapshotMigrationPreflight(database)).not.toThrow();
    database.prepare(
      "UPDATE observe_checkpoints SET position_projection_hash=? WHERE checkpoint_id=?",
    ).run("0".repeat(64), "checkpoint-valid");
    expect(() => assertObserveProjectionSnapshotMigrationPreflight(database))
      .toThrow("MIGRATION_028_PROJECTION_HASH_MISMATCH:checkpoint-valid");
    database.close();
  });

  it("fails closed when historical Observe checkpoints reuse a projection hash for different payloads", () => {
    const { databasePath } = workspace();
    const database = new DatabaseSync(databasePath);
    database.exec(`CREATE TABLE observe_checkpoints(
      checkpoint_id TEXT PRIMARY KEY,
      position_projection_json TEXT NOT NULL,
      position_projection_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`);
    const insert = database.prepare(
      `INSERT INTO observe_checkpoints(
        checkpoint_id,position_projection_json,position_projection_hash,created_at
      ) VALUES (?,?,?,?)`,
    );
    insert.run("checkpoint-a", '[{"asset":"a"}]', "same-hash", "2026-07-17T00:00:00.000Z");
    insert.run("checkpoint-b", '[{"asset":"b"}]', "same-hash", "2026-07-17T00:01:00.000Z");
    const migration = readFileSync(
      new URL("../src/infra/sqlite/028_observe_projection_snapshots.sql", import.meta.url),
      "utf8",
    );

    database.exec("BEGIN IMMEDIATE");
    expect(() => database.exec(migration)).toThrow(/CHECK constraint failed/);
    database.exec("ROLLBACK");
    expect(database.prepare(
      "SELECT 1 ok FROM sqlite_master WHERE type='table' AND name='observe_projection_snapshots'",
    ).get()).toBeUndefined();
    database.close();
  });

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
      targetId: replayTargetId,
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
      targetId: replayTargetId,
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
