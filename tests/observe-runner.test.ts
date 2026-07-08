import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { ApiCapture } from "../src/adapters/polymarket-public.js";
import type { PublicActivity, PublicPosition, PublicTrade } from "../src/domain/models.js";
import { Phase0Database } from "../src/infra/sqlite/database.js";
import type { SourceVersion } from "../src/infra/source-version.js";
import { ObserveOnlyRunner } from "../src/observe/observe-runner.js";
import { ObserveStore } from "../src/observe/observe-store.js";
import type { ObserveDataSource, ObservePollSnapshot } from "../src/observe/types.js";
import { buildCaptureManifest, captureIdentity } from "../src/services/capture-manifest.js";
import { buildPositionBaseline } from "../src/services/position-baseline.js";

const wallet = "0x0000000000000000000000000000000000000001";
const sourceVersion: SourceVersion = { commit: "test-commit", dirty: false };
const baselineTime = "2026-07-08T00:00:00.000Z";
const baselineSecond = Date.parse(baselineTime) / 1_000;
const directories: string[] = [];

function capture<T>(endpoint: string, data: T, fetchedAt: string): ApiCapture<T> {
  return { url: `https://example.test/${endpoint}`, fetchedAt, latencyMs: 10, status: 200, data };
}

function position(size: string): PublicPosition {
  return {
    proxyWallet: wallet,
    asset: "asset-1",
    conditionId: "0xcondition",
    size,
    avgPrice: "0.5",
    currentValue: String(Number(size) * 0.5),
    title: "Test market",
    slug: "test-market",
    outcome: "Yes",
  };
}

function trade(overrides: Partial<PublicTrade>): PublicTrade {
  return {
    proxyWallet: wallet,
    transactionHash: "0x1",
    conditionId: "0xcondition",
    asset: "asset-1",
    side: "BUY",
    price: "0.5",
    size: "10",
    timestamp: baselineSecond + 10,
    ...overrides,
  };
}

function snapshot(trades: PublicTrade[], positions: PublicPosition[], fetchedAt: string): ObservePollSnapshot {
  return {
    trades: capture("trades", trades, fetchedAt),
    activity: capture<PublicActivity[]>("activity", [], fetchedAt),
    positions: capture("positions", positions, fetchedAt),
    pUsdBalance: capture("balance", { jsonrpc: "2.0", id: 2, result: "0x0" }, fetchedAt),
  };
}

function activity(overrides: Partial<PublicActivity>): PublicActivity {
  return {
    proxyWallet: wallet,
    transactionHash: "0xactivity",
    conditionId: "0xcondition",
    asset: "",
    type: "REDEEM",
    timestamp: baselineSecond + 10,
    ...overrides,
  };
}

function snapshotWithActivity(
  activities: PublicActivity[],
  positions: PublicPosition[],
  fetchedAt: string,
): ObservePollSnapshot {
  const result = snapshot([], positions, fetchedAt);
  result.activity = capture("activity", activities, fetchedAt);
  return result;
}

class QueueSource implements ObserveDataSource {
  constructor(private readonly queue: Array<ObservePollSnapshot | Error>) {}
  async poll(): Promise<ObservePollSnapshot> {
    const item = this.queue.shift();
    if (!item) throw new Error("Fake queue exhausted");
    if (item instanceof Error) throw item;
    return item;
  }
}

function setup(baselinePositions: PublicPosition[] = [position("100")]): { databasePath: string; targetId: string } {
  const directory = mkdtempSync(join(tmpdir(), "ni-k-observe-"));
  directories.push(directory);
  const databasePath = join(directory, "phase0.sqlite");
  const database = new Phase0Database(databasePath, sourceVersion);
  database.initialize();
  const targetId = database.ensureTarget(wallet, "IDENTITY_CONFIRMED");
  const positionsCapture = capture("positions", baselinePositions, baselineTime);
  database.saveCapture("data-positions", positionsCapture);
  const manifest = buildCaptureManifest({
    walletAddress: wallet,
    sampleRole: "TARGET",
    purpose: "OBSERVE_TEST_BASELINE",
    sourceVersion,
    sources: [{ endpoint: "data-positions", capture: positionsCapture, paginationStatus: "END_OF_DATA" }],
  });
  database.saveCaptureManifest(targetId, manifest);
  const baseline = buildPositionBaseline({
    captureRunId: manifest.captureRunId,
    targetId,
    walletAddress: wallet,
    positionCaptureId: captureIdentity(positionsCapture).captureId,
    fetchedAt: positionsCapture.fetchedAt,
    latencyMs: positionsCapture.latencyMs,
    positions: baselinePositions,
  });
  database.savePositionBaseline(baseline);
  database.close();
  return { databasePath, targetId };
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("ObserveOnlyRunner", () => {
  it("runs continuously, sorts input, and does not duplicate events or signals", async () => {
    const { databasePath } = setup();
    let now = new Date("2026-07-08T00:01:00.000Z");
    const buy = trade({ transactionHash: "0xbuy", timestamp: baselineSecond + 61 });
    const source = new QueueSource([
      snapshot([], [position("100")], "2026-07-08T00:01:00.000Z"),
      snapshot([buy], [position("110")], "2026-07-08T00:01:10.000Z"),
      snapshot([buy], [position("110")], "2026-07-08T00:01:20.000Z"),
    ]);
    const store = new ObserveStore(databasePath, sourceVersion);
    const runner = new ObserveOnlyRunner(store, source, {
      walletAddress: wallet,
      pollIntervalMs: 1_000,
      now: () => now,
    });
    runner.start();
    await runner.pollOnce();
    now = new Date("2026-07-08T00:01:10.000Z");
    await runner.pollOnce();
    now = new Date("2026-07-08T00:01:20.000Z");
    await runner.pollOnce();
    store.stopRun(runner.start().observeRunId, now.toISOString(), "TEST_COMPLETE");
    const metrics = store.runMetrics(runner.start().observeRunId);
    expect(metrics).toMatchObject({ successfulPolls: 3, failedPolls: 0, processedEvents: 1, emittedSignals: 1, duplicateEvents: 1 });
    expect(metrics.finalSyncStatus).toBe("SYNCED");
    store.close();

    const check = new DatabaseSync(databasePath, { readOnly: true });
    expect((check.prepare("SELECT count(*) count FROM observe_events").get() as { count: number }).count).toBe(1);
    expect((check.prepare("SELECT count(*) count FROM observe_signal_emissions").get() as { count: number }).count).toBe(1);
    check.close();
  });

  it("records an API failure and makes recovered events non-executable gap signals", async () => {
    const { databasePath } = setup();
    let now = new Date("2026-07-08T00:01:00.000Z");
    const gapBuy = trade({ transactionHash: "0xgap", timestamp: baselineSecond + 70 });
    const source = new QueueSource([
      snapshot([], [position("100")], "2026-07-08T00:01:00.000Z"),
      new Error("temporary API failure"),
      snapshot([gapBuy], [position("110")], "2026-07-08T00:01:20.000Z"),
    ]);
    const store = new ObserveStore(databasePath, sourceVersion);
    const runner = new ObserveOnlyRunner(store, source, { walletAddress: wallet, pollIntervalMs: 1_000, now: () => now });
    await runner.pollOnce();
    now = new Date("2026-07-08T00:01:10.000Z");
    expect(await runner.pollOnce()).toBe(false);
    now = new Date("2026-07-08T00:01:20.000Z");
    expect(await runner.pollOnce()).toBe(true);
    store.stopRun(runner.start().observeRunId, now.toISOString(), "TEST_COMPLETE");
    const metrics = store.runMetrics(runner.start().observeRunId);
    expect(metrics.failedPolls).toBe(1);
    expect(metrics.gapEvents).toBe(1);
    store.close();

    const check = new DatabaseSync(databasePath, { readOnly: true });
    const signal = check.prepare(
      "SELECT execution_eligible,execution_block_reason,event_classification FROM signals WHERE producer_mode='OBSERVE_ONLY'",
    ).get() as { execution_eligible: number; execution_block_reason: string; event_classification: string };
    expect(signal).toEqual({ execution_eligible: 0, execution_block_reason: "GAP_EVENT", event_classification: "GAP_TRADE" });
    check.close();
  });

  it("recovers a checkpoint after restart and marks downtime events as gaps", async () => {
    const { databasePath } = setup();
    let now = new Date("2026-07-08T00:01:00.000Z");
    const firstStore = new ObserveStore(databasePath, sourceVersion);
    const firstRunner = new ObserveOnlyRunner(
      firstStore,
      new QueueSource([snapshot([], [position("100")], now.toISOString())]),
      { walletAddress: wallet, pollIntervalMs: 1_000, staleRunAfterMs: 1_000, now: () => now },
    );
    await firstRunner.pollOnce();
    firstStore.close();

    now = new Date("2026-07-08T00:02:00.000Z");
    const restartTrade = trade({ transactionHash: "0xrestart", timestamp: baselineSecond + 90 });
    const secondStore = new ObserveStore(databasePath, sourceVersion);
    const secondRunner = new ObserveOnlyRunner(
      secondStore,
      new QueueSource([snapshot([restartTrade], [position("110")], now.toISOString())]),
      { walletAddress: wallet, pollIntervalMs: 1_000, staleRunAfterMs: 1_000, now: () => now },
    );
    const started = secondRunner.start();
    expect(started.recoveredFromCheckpoint).toBe(true);
    await secondRunner.pollOnce();
    secondStore.stopRun(started.observeRunId, now.toISOString(), "TEST_COMPLETE");
    expect(secondStore.runMetrics(started.observeRunId)).toMatchObject({ checkpointRecovered: true, gapEvents: 1 });
    secondStore.close();
  });

  it("sorts a 3-1-2 response and reaches the correct final projection", async () => {
    const { databasePath } = setup([]);
    let now = new Date("2026-07-08T00:01:00.000Z");
    const source = new QueueSource([
      snapshot([], [], now.toISOString()),
      snapshot([
        trade({ transactionHash: "0x3", side: "SELL", size: "30", timestamp: baselineSecond + 3 }),
        trade({ transactionHash: "0x1", size: "100", timestamp: baselineSecond + 1 }),
        trade({ transactionHash: "0x2", size: "20", timestamp: baselineSecond + 2 }),
      ], [position("90")], "2026-07-08T00:01:10.000Z"),
    ]);
    const store = new ObserveStore(databasePath, sourceVersion);
    const runner = new ObserveOnlyRunner(store, source, { walletAddress: wallet, pollIntervalMs: 1_000, now: () => now });
    await runner.pollOnce();
    now = new Date("2026-07-08T00:01:10.000Z");
    await runner.pollOnce();
    store.stopRun(runner.start().observeRunId, now.toISOString(), "TEST_COMPLETE");
    expect(store.runMetrics(runner.start().observeRunId).finalSyncStatus).toBe("SYNCED");
    store.close();

    const check = new DatabaseSync(databasePath, { readOnly: true });
    const projection = check.prepare("SELECT expected_total_micros FROM observe_position_projection WHERE asset_id='asset-1'").get() as { expected_total_micros: string };
    expect(projection.expected_total_micros).toBe("90000000");
    check.close();
  });

  it("projects a redeem activity to zero without emitting an execution signal", async () => {
    const { databasePath } = setup();
    const now = new Date("2026-07-08T00:01:00.000Z");
    const source = new QueueSource([
      snapshotWithActivity([activity({ timestamp: baselineSecond + 30 })], [], now.toISOString()),
    ]);
    const store = new ObserveStore(databasePath, sourceVersion);
    const runner = new ObserveOnlyRunner(store, source, { walletAddress: wallet, pollIntervalMs: 1_000, now: () => now });
    await runner.pollOnce();
    store.stopRun(runner.start().observeRunId, now.toISOString(), "TEST_COMPLETE");
    expect(store.runMetrics(runner.start().observeRunId)).toMatchObject({
      processedEvents: 1,
      emittedSignals: 0,
      finalSyncStatus: "SYNCED",
    });
    store.close();

    const check = new DatabaseSync(databasePath, { readOnly: true });
    const checkpoint = check.prepare(
      "SELECT last_processed_timestamp,last_processed_event_id FROM observe_checkpoints ORDER BY created_at DESC LIMIT 1",
    ).get() as { last_processed_timestamp: number; last_processed_event_id: string };
    expect(checkpoint.last_processed_timestamp).toBe(baselineSecond + 30);
    expect(checkpoint.last_processed_event_id).toBeTruthy();
    expect((check.prepare("SELECT count(*) count FROM observe_signal_emissions").get() as { count: number }).count).toBe(0);
    check.close();
  });

  it("normalizes an Activity trade and deduplicates the later Trades response", async () => {
    const { databasePath } = setup();
    let now = new Date("2026-07-08T00:01:00.000Z");
    const activityTrade = activity({
      type: "TRADE",
      transactionHash: "0xactivity-first",
      asset: "asset-1",
      side: "BUY",
      price: "0.5",
      size: "10",
      timestamp: baselineSecond + 30,
    });
    const normalizedTrade = trade({
      transactionHash: activityTrade.transactionHash,
      side: "BUY",
      price: activityTrade.price!,
      size: activityTrade.size!,
      timestamp: activityTrade.timestamp,
    });
    const first = snapshotWithActivity([activityTrade], [position("110")], now.toISOString());
    const second = snapshot([normalizedTrade], [position("110")], "2026-07-08T00:01:10.000Z");
    const store = new ObserveStore(databasePath, sourceVersion);
    const runner = new ObserveOnlyRunner(store, new QueueSource([first, second]), {
      walletAddress: wallet,
      pollIntervalMs: 1_000,
      now: () => now,
    });
    await runner.pollOnce();
    now = new Date("2026-07-08T00:01:10.000Z");
    await runner.pollOnce();
    store.stopRun(runner.start().observeRunId, now.toISOString(), "TEST_COMPLETE");
    expect(store.runMetrics(runner.start().observeRunId)).toMatchObject({
      processedEvents: 1,
      emittedSignals: 1,
      duplicateEvents: 1,
      finalSyncStatus: "SYNCED",
    });
    store.close();
  });

  it("does not advance the checkpoint when the recovery window is truncated", async () => {
    const { databasePath } = setup();
    const now = new Date("2026-07-08T00:01:00.000Z");
    const rows = Array.from({ length: 1_000 }, (_, index) => trade({
      transactionHash: `0x${index.toString(16).padStart(64, "0")}`,
      timestamp: baselineSecond + 30,
    }));
    const store = new ObserveStore(databasePath, sourceVersion);
    const runner = new ObserveOnlyRunner(
      store,
      new QueueSource([snapshot(rows, [position("100")], now.toISOString())]),
      { walletAddress: wallet, pollIntervalMs: 1_000, now: () => now },
    );
    expect(await runner.pollOnce()).toBe(false);
    store.stopRun(runner.start().observeRunId, now.toISOString(), "TEST_COMPLETE");
    expect(store.runMetrics(runner.start().observeRunId)).toMatchObject({
      successfulPolls: 0,
      failedPolls: 1,
      lastCheckpointId: null,
    });
    store.close();

    const check = new DatabaseSync(databasePath, { readOnly: true });
    expect((check.prepare("SELECT status FROM observe_polls").get() as { status: string }).status).toBe("PROCESSING_FAILED");
    check.close();
  });

  it("emits an immutable execution context and per-BUY capital decision", async () => {
    const { databasePath } = setup();
    let now = new Date("2026-07-08T00:01:00.000Z");
    const buy = trade({ transactionHash: "0xcontext", timestamp: baselineSecond + 70 });
    const source = new QueueSource([
      snapshot([], [position("100")], now.toISOString()),
      snapshot([buy], [position("110")], "2026-07-08T00:01:10.000Z"),
    ]);
    const store = new ObserveStore(databasePath, sourceVersion);
    const runner = new ObserveOnlyRunner(store, source, {
      walletAddress: wallet,
      pollIntervalMs: 1_000,
      now: () => now,
      signalMarketMetadataProvider: {
        async market() {
          return {
            sourceUrl: "https://clob.test/markets/condition",
            fetchedAt: now.toISOString(),
            market: {
              condition_id: "0xcondition",
              end_date_iso: "2026-07-08T01:00:00.000Z",
              closed: false,
              tokens: [{ token_id: "asset-1", outcome: "Yes" }],
            },
          };
        },
      },
    });
    await runner.pollOnce();
    now = new Date("2026-07-08T00:01:10.000Z");
    await runner.pollOnce();
    store.stopRun(runner.start().observeRunId, now.toISOString(), "TEST_COMPLETE");
    store.close();

    const check = new DatabaseSync(databasePath);
    const context = check.prepare(
      `SELECT c.target_trade_capital_ratio_ppm,ce.source_event_key
       FROM signal_execution_contexts c JOIN capital_estimates ce ON ce.capital_estimate_id=c.capital_decision_id`,
    ).get() as { target_trade_capital_ratio_ppm: string; source_event_key: string };
    expect(BigInt(context.target_trade_capital_ratio_ppm)).toBeGreaterThan(0n);
    expect(context.source_event_key).toBeTruthy();
    expect(() => check.prepare("UPDATE signal_execution_contexts SET market_end_time=?").run("2099-01-01T00:00:00Z")).toThrow("immutable");
    check.close();
  });

  it("does not publish a Paper-eligible signal when execution context construction fails", async () => {
    const { databasePath } = setup();
    let now = new Date("2026-07-08T00:01:00.000Z");
    const buy = trade({ transactionHash: "0xcontext-fail", timestamp: baselineSecond + 70 });
    const store = new ObserveStore(databasePath, sourceVersion);
    const runner = new ObserveOnlyRunner(
      store,
      new QueueSource([
        snapshot([], [position("100")], now.toISOString()),
        snapshot([buy], [position("110")], "2026-07-08T00:01:10.000Z"),
      ]),
      {
        walletAddress: wallet,
        pollIntervalMs: 1_000,
        now: () => now,
        signalMarketMetadataProvider: { async market() { throw new Error("market metadata unavailable"); } },
      },
    );
    expect(await runner.pollOnce()).toBe(true);
    now = new Date("2026-07-08T00:01:10.000Z");
    expect(await runner.pollOnce()).toBe(false);
    store.stopRun(runner.start().observeRunId, now.toISOString(), "TEST_COMPLETE");
    expect(store.runMetrics(runner.start().observeRunId).failedPolls).toBe(1);
    store.close();
    const check = new DatabaseSync(databasePath, { readOnly: true });
    expect((check.prepare("SELECT count(*) count FROM signals").get() as { count: number }).count).toBe(0);
    expect((check.prepare("SELECT status FROM observe_polls WHERE sequence=2").get() as { status: string }).status).toBe("PROCESSING_FAILED");
    check.close();
  });
});
