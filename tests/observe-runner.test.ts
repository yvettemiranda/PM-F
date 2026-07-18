import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { PolymarketPublicApi, type ApiCapture } from "../src/adapters/polymarket-public.js";
import type { PublicActivity, PublicPosition, PublicTrade } from "../src/domain/models.js";
import { Phase0Database } from "../src/infra/sqlite/database.js";
import type { SourceVersion } from "../src/infra/source-version.js";
import { ObserveOnlyRunner } from "../src/observe/observe-runner.js";
import { PublicObserveDataSource } from "../src/observe/public-data-source.js";
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
    activity: capture<PublicActivity[]>("activity", trades.map((item) => ({
      ...item,
      type: "TRADE",
      isCombo: false,
    })), fetchedAt),
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
  readonly recoveryFromTimestamps: Array<number | undefined> = [];
  readonly activityFromTimestamps: Array<number | undefined> = [];

  constructor(private readonly queue: Array<ObservePollSnapshot | Error>) {}
  async poll(
    _walletAddress: string,
    recoveryFromTimestamp?: number,
    activityFromTimestamp?: number,
  ): Promise<ObservePollSnapshot> {
    this.recoveryFromTimestamps.push(recoveryFromTimestamp);
    this.activityFromTimestamps.push(activityFromTimestamp);
    const item = this.queue.shift();
    if (!item) throw new Error("Fake queue exhausted");
    if (item instanceof Error) throw item;
    return item;
  }
}

function setup(baselinePositions: PublicPosition[] = [position("100")]): {
  databasePath: string;
  targetId: string;
  baselineRunId: string;
} {
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
  return { databasePath, targetId, baselineRunId: baseline.baselineRunId };
}

function addBaseline(databasePath: string, snapshotTime: string, positions: PublicPosition[]): string {
  const database = new Phase0Database(databasePath, sourceVersion);
  database.initialize();
  const targetId = database.ensureTarget(wallet, "IDENTITY_CONFIRMED");
  const positionsCapture = capture("positions", positions, snapshotTime);
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
    positions,
  });
  database.savePositionBaseline(baseline);
  database.close();
  return baseline.baselineRunId;
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("ObserveOnlyRunner", () => {
  it("marks one exactly identified abandoned run as interrupted", () => {
    const env = setup();
    const store = new ObserveStore(env.databasePath, sourceVersion);
    const started = store.startRun(wallet, 15_000, baselineTime, 30_000, env.baselineRunId);
    expect(store.interruptAbandonedRun(
      started.observeRunId,
      "2026-07-08T00:00:05.000Z",
      "PAPER_CAMPAIGN_CRASH_RECOVERY",
    )).toBe(true);
    expect(store.interruptAbandonedRun(
      started.observeRunId,
      "2026-07-08T00:00:06.000Z",
      "PAPER_CAMPAIGN_CRASH_RECOVERY",
    )).toBe(false);
    store.close();
    const database = new DatabaseSync(env.databasePath, { readOnly: true });
    expect(database.prepare(
      "SELECT state,stop_reason FROM observe_runs WHERE observe_run_id=?",
    ).get(started.observeRunId)).toEqual({
      state: "INTERRUPTED",
      stop_reason: "PAPER_CAMPAIGN_CRASH_RECOVERY",
    });
    database.close();
  });

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
    expect(metrics).toMatchObject({ successfulPolls: 3, failedPolls: 0, processedEvents: 1, emittedSignals: 1, duplicateEvents: 3 });
    expect(metrics.finalSyncStatus).toBe("SYNCED");
    store.close();

    const check = new DatabaseSync(databasePath, { readOnly: true });
    expect((check.prepare("SELECT count(*) count FROM observe_events").get() as { count: number }).count).toBe(1);
    expect((check.prepare("SELECT count(*) count FROM observe_signal_emissions").get() as { count: number }).count).toBe(1);
    check.close();
  });

  it("keeps position-leading delayed trades inside the grace period without historical major desync", async () => {
    const { databasePath } = setup();
    let now = new Date("2026-07-08T00:01:00.000Z");
    const delayedSell = trade({
      transactionHash: "0xdelayed-sell",
      side: "SELL",
      size: "10",
      timestamp: baselineSecond + 70,
    });
    const source = new QueueSource([
      snapshot([], [position("100")], now.toISOString()),
      snapshot([], [position("90")], "2026-07-08T00:01:10.000Z"),
      snapshot([], [position("90")], "2026-07-08T00:01:26.000Z"),
      snapshot([], [position("90")], "2026-07-08T00:01:41.000Z"),
      snapshot([delayedSell], [position("90")], "2026-07-08T00:01:57.000Z"),
    ]);
    const store = new ObserveStore(databasePath, sourceVersion);
    const runner = new ObserveOnlyRunner(store, source, {
      walletAddress: wallet,
      pollIntervalMs: 15_000,
      now: () => now,
    });

    await runner.pollOnce();
    now = new Date("2026-07-08T00:01:10.000Z");
    await runner.pollOnce();
    now = new Date("2026-07-08T00:01:26.000Z");
    await runner.pollOnce();
    now = new Date("2026-07-08T00:01:41.000Z");
    await runner.pollOnce();
    expect(store.runMetrics(runner.start().observeRunId)).toMatchObject({
      finalSyncStatus: "MINOR_DIFF",
      minorDiffCount: 3,
      majorDesyncCount: 0,
    });

    now = new Date("2026-07-08T00:01:57.000Z");
    await runner.pollOnce();
    store.stopRun(runner.start().observeRunId, now.toISOString(), "TEST_COMPLETE");
    expect(store.runMetrics(runner.start().observeRunId)).toMatchObject({
      processedEvents: 1,
      finalSyncStatus: "SYNCED",
      minorDiffCount: 3,
      majorDesyncCount: 0,
    });
    store.close();
  });

  it("stores an unchanged position projection once and references it from later checkpoints", async () => {
    const { databasePath } = setup();
    let now = new Date("2026-07-08T00:01:00.000Z");
    const source = new QueueSource([
      snapshot([], [position("100")], now.toISOString()),
      snapshot([], [position("100")], "2026-07-08T00:01:10.000Z"),
      snapshot([], [position("100")], "2026-07-08T00:01:20.000Z"),
    ]);
    const store = new ObserveStore(databasePath, sourceVersion);
    const runner = new ObserveOnlyRunner(store, source, {
      walletAddress: wallet,
      pollIntervalMs: 1_000,
      now: () => now,
    });

    await runner.pollOnce();
    now = new Date("2026-07-08T00:01:10.000Z");
    await runner.pollOnce();
    now = new Date("2026-07-08T00:01:20.000Z");
    await runner.pollOnce();
    store.stopRun(runner.start().observeRunId, now.toISOString(), "TEST_COMPLETE");
    store.close();

    const check = new DatabaseSync(databasePath, { readOnly: true });
    const checkpoints = check.prepare(
      `SELECT position_projection_json,position_projection_hash,projection_snapshot_hash
       FROM observe_checkpoints ORDER BY created_at,checkpoint_id`,
    ).all() as Array<{
      position_projection_json: string;
      position_projection_hash: string;
      projection_snapshot_hash: string;
    }>;
    const snapshots = check.prepare(
      "SELECT projection_snapshot_hash,projection_json FROM observe_projection_snapshots",
    ).all() as Array<{ projection_snapshot_hash: string; projection_json: string }>;
    check.close();

    expect(checkpoints).toHaveLength(3);
    expect(new Set(checkpoints.map((row) => row.position_projection_hash)).size).toBe(1);
    expect(checkpoints.every((row) => row.position_projection_json === "")).toBe(true);
    expect(checkpoints.every((row) => row.projection_snapshot_hash === row.position_projection_hash)).toBe(true);
    expect(snapshots).toHaveLength(1);
    expect(JSON.parse(snapshots[0]!.projection_json)).toBeInstanceOf(Array);
  });

  it("anchors the Activity cursor at the position baseline when no events exist", async () => {
    const { databasePath } = setup();
    let now = new Date("2026-07-08T00:01:00.000Z");
    const source = new QueueSource([
      snapshot([], [position("100")], now.toISOString()),
      snapshot([], [position("100")], "2026-07-08T00:01:10.000Z"),
    ]);
    const store = new ObserveStore(databasePath, sourceVersion);
    const runner = new ObserveOnlyRunner(store, source, {
      walletAddress: wallet,
      pollIntervalMs: 1_000,
      now: () => now,
    });

    await runner.pollOnce();
    now = new Date("2026-07-08T00:01:10.000Z");
    await runner.pollOnce();
    store.stopRun(runner.start().observeRunId, now.toISOString(), "TEST_COMPLETE");
    store.close();

    expect(source.activityFromTimestamps).toEqual([
      baselineSecond - 1,
      baselineSecond - 1,
    ]);
  });

  it("keeps the conservative Activity window while a Trade awaits confirmation", async () => {
    const { databasePath } = setup();
    let now = new Date("2026-07-08T00:01:00.000Z");
    const pending = trade({ transactionHash: "0xpending-confirmation", timestamp: baselineSecond + 70 });
    const pendingSnapshot = snapshot([pending], [position("100")], "2026-07-08T00:01:10.000Z");
    pendingSnapshot.activity = capture("activity", [], pendingSnapshot.activity.fetchedAt);
    const source = new QueueSource([
      snapshot([], [position("100")], now.toISOString()),
      pendingSnapshot,
      { ...pendingSnapshot, trades: capture("trades", [pending], "2026-07-08T00:01:20.000Z") },
    ]);
    const store = new ObserveStore(databasePath, sourceVersion);
    const runner = new ObserveOnlyRunner(store, source, {
      walletAddress: wallet,
      pollIntervalMs: 1_000,
      now: () => now,
    });

    await runner.pollOnce();
    now = new Date("2026-07-08T00:01:10.000Z");
    await runner.pollOnce();
    now = new Date("2026-07-08T00:01:20.000Z");
    await runner.pollOnce();

    store.close();
  });

  it("preserves event, Signal, gap, and projection semantics with reduced normal-poll windows", async () => {
    const runScenario = async () => {
      const { databasePath } = setup([]);
      let now = new Date("2026-07-08T00:01:00.000Z");
      const buy = trade({ transactionHash: "0xoptimized-buy", timestamp: baselineSecond + 70 });
      const reward = activity({
        transactionHash: "0xoptimized-reward",
        type: "REWARD",
        timestamp: baselineSecond + 10,
      });
      const activityRows: PublicActivity[] = [reward, { ...buy, type: "TRADE", isCombo: false }];
      const tradeLimits: number[] = [];
      const activityStarts: number[] = [];
      let positionPoll = 0;
      const paged = <T>(url: string, rows: T[]) => ({
        rows,
        captures: [capture(url, rows, now.toISOString())],
        historyComplete: true,
        stopReason: "END_OF_DATA",
      });
      const api = {
        tradesSince: async () => paged("trades-recovery", []),
        recentTrades: async (_address: string, limit: number) => {
          tradeLimits.push(limit);
          return capture("trades-head", [buy], now.toISOString());
        },
        activitySince: async (_address: string, start: number) => {
          activityStarts.push(start);
          return paged("activity-since", activityRows.filter((row) => row.timestamp >= start));
        },
        allPositions: async () => {
          const rows = positionPoll++ === 0 ? [] : [position("10")];
          return { ...paged("positions", rows), merged: capture("positions", rows, now.toISOString()) };
        },
        pUsdBalance: async () => capture(
          "balance",
          { jsonrpc: "2.0", id: 2, result: "0x0" },
          now.toISOString(),
        ),
      };
      const delegate = new PublicObserveDataSource(api as unknown as PolymarketPublicApi);
      const source: ObserveDataSource = delegate;
      const store = new ObserveStore(databasePath, sourceVersion);
      const runner = new ObserveOnlyRunner(store, source, {
        walletAddress: wallet,
        pollIntervalMs: 1_000,
        now: () => now,
      });
      await runner.pollOnce();
      now = new Date("2026-07-08T00:01:10.000Z");
      await runner.pollOnce();
      now = new Date("2026-07-08T00:01:20.000Z");
      await runner.pollOnce();
      const observeRunId = runner.start().observeRunId;
      store.stopRun(observeRunId, now.toISOString(), "TEST_COMPLETE");
      const metrics = store.runMetrics(observeRunId);
      store.close();

      const check = new DatabaseSync(databasePath, { readOnly: true });
      const events = check.prepare(
        `SELECT source_event_key,is_gap,activity_confirmed
         FROM observe_events ORDER BY source_event_key`,
      ).all();
      const signals = check.prepare(
        `SELECT signal_type,execution_eligible,event_classification
         FROM signals WHERE producer_mode='OBSERVE_ONLY' ORDER BY signal_id`,
      ).all();
      const checkpoint = check.prepare(
        `SELECT replay_state,c.position_projection_hash,
                COALESCE(NULLIF(c.position_projection_json,''),s.projection_json) position_projection_json
         FROM observe_checkpoints c
         LEFT JOIN observe_projection_snapshots s
           ON s.projection_snapshot_hash=c.projection_snapshot_hash
         WHERE c.observe_run_id=? ORDER BY c.created_at DESC LIMIT 1`,
      ).get(observeRunId);
      check.close();
      return {
        tradeLimits,
        activityStarts,
        events,
        signals,
        checkpoint,
        semanticMetrics: {
          processedEvents: metrics.processedEvents,
          emittedSignals: metrics.emittedSignals,
          gapEvents: metrics.gapEvents,
          finalSyncStatus: metrics.finalSyncStatus,
        },
      };
    };

    const optimized = await runScenario();

    expect(optimized.tradeLimits).toEqual([100, 100]);
    expect(optimized.activityStarts).toEqual([
      baselineSecond - 1,
      baselineSecond - 230,
      baselineSecond - 230,
    ]);
    expect(optimized.events).toHaveLength(2);
    expect(optimized.signals).toHaveLength(1);
    expect(optimized.semanticMetrics).toMatchObject({
      processedEvents: 2,
      emittedSignals: 1,
      finalSyncStatus: "SYNCED",
    });
  });

  it("preserves confirmed identical fills as separate occurrences across polls and restart", async () => {
    const { databasePath } = setup([position("62851.16")]);
    let now = new Date("2026-07-08T00:01:00.000Z");
    const transactionHash = "0x31add6643877a7ed3aea1d8507e377ebc1efbd663cfdb6dc3c57837c3301affc";
    const repeatedSell = trade({
      transactionHash,
      side: "SELL",
      price: "0.997",
      size: "15712.79",
      timestamp: baselineSecond + 70,
    });
    const aggregateSell = trade({
      transactionHash,
      side: "SELL",
      price: "0.997",
      size: "31425.58",
      timestamp: baselineSecond + 70,
    });
    const fills = [repeatedSell, { ...repeatedSell }, aggregateSell];
    const firstStore = new ObserveStore(databasePath, sourceVersion);
    const firstRunner = new ObserveOnlyRunner(firstStore, new QueueSource([
      snapshot([], [position("62851.16")], now.toISOString()),
      snapshot(fills, [position("0")], "2026-07-08T00:01:10.000Z"),
    ]), {
      walletAddress: wallet,
      pollIntervalMs: 1_000,
      now: () => now,
    });

    await firstRunner.pollOnce();
    now = new Date("2026-07-08T00:01:10.000Z");
    await firstRunner.pollOnce();
    firstStore.stopRun(firstRunner.start().observeRunId, now.toISOString(), "TEST_COMPLETE");
    expect(firstStore.runMetrics(firstRunner.start().observeRunId)).toMatchObject({
      processedEvents: 3,
      emittedSignals: 0,
      finalSyncStatus: "SYNCED",
    });
    firstStore.close();

    now = new Date("2026-07-08T00:01:20.000Z");
    const secondStore = new ObserveStore(databasePath, sourceVersion);
    const secondRunner = new ObserveOnlyRunner(secondStore, new QueueSource([
      snapshot([aggregateSell, ...fills.slice(0, 2).reverse()], [position("0")], now.toISOString()),
    ]), {
      walletAddress: wallet,
      pollIntervalMs: 1_000,
      now: () => now,
    });
    await secondRunner.pollOnce();
    secondStore.stopRun(secondRunner.start().observeRunId, now.toISOString(), "TEST_COMPLETE");
    expect(secondStore.runMetrics(secondRunner.start().observeRunId)).toMatchObject({
      processedEvents: 0,
      emittedSignals: 0,
      finalSyncStatus: "SYNCED",
    });
    secondStore.close();

    const check = new DatabaseSync(databasePath, { readOnly: true });
    expect((check.prepare(
      "SELECT count(*) count FROM raw_events WHERE source_transaction_hash=?",
    ).get(transactionHash) as { count: number }).count).toBe(3);
    check.close();
  });

  it("waits for multiplicity confirmation and emits each identical BUY exactly once", async () => {
    const { databasePath } = setup([]);
    let now = new Date("2026-07-08T00:01:00.000Z");
    const repeatedBuy = trade({
      transactionHash: "0xidentical-buy",
      side: "BUY",
      price: "0.5",
      size: "10",
      timestamp: baselineSecond + 70,
    });
    const firstTradeSnapshot = snapshot(
      [repeatedBuy, { ...repeatedBuy }],
      [position("20")],
      "2026-07-08T00:01:10.000Z",
    );
    firstTradeSnapshot.activity = capture("activity", [{
      ...repeatedBuy,
      type: "TRADE",
      isCombo: false,
    }], firstTradeSnapshot.activity.fetchedAt);
    const confirmedSnapshot = snapshot(
      [{ ...repeatedBuy }, repeatedBuy],
      [position("20")],
      "2026-07-08T00:01:20.000Z",
    );
    const store = new ObserveStore(databasePath, sourceVersion);
    const runner = new ObserveOnlyRunner(store, new QueueSource([
      snapshot([], [], now.toISOString()),
      firstTradeSnapshot,
      confirmedSnapshot,
      snapshot([repeatedBuy, { ...repeatedBuy }], [position("20")], "2026-07-08T00:01:30.000Z"),
    ]), {
      walletAddress: wallet,
      pollIntervalMs: 1_000,
      now: () => now,
    });

    await runner.pollOnce();
    now = new Date("2026-07-08T00:01:10.000Z");
    await runner.pollOnce();
    expect(store.runMetrics(runner.start().observeRunId)).toMatchObject({
      processedEvents: 2,
      emittedSignals: 1,
      finalSyncStatus: "MINOR_DIFF",
    });
    now = new Date("2026-07-08T00:01:20.000Z");
    await runner.pollOnce();
    now = new Date("2026-07-08T00:01:30.000Z");
    await runner.pollOnce();
    store.stopRun(runner.start().observeRunId, now.toISOString(), "TEST_COMPLETE");
    expect(store.runMetrics(runner.start().observeRunId)).toMatchObject({
      processedEvents: 2,
      emittedSignals: 2,
      finalSyncStatus: "SYNCED",
    });
    store.close();

    const check = new DatabaseSync(databasePath, { readOnly: true });
    expect((check.prepare(
      "SELECT count(*) count FROM observe_events WHERE activity_confirmed=1",
    ).get() as { count: number }).count).toBe(2);
    expect((check.prepare(
      "SELECT count(*) count FROM signals WHERE producer_mode='OBSERVE_ONLY'",
    ).get() as { count: number }).count).toBe(2);
    check.close();
  });

  it("keeps an unresolved repeated occurrence out of the Observe gate even when positions match", async () => {
    const { databasePath } = setup([]);
    let now = new Date("2026-07-08T00:01:00.000Z");
    const repeatedBuy = trade({
      transactionHash: "0xambiguous-identical-buy",
      side: "BUY",
      price: "0.5",
      size: "10",
      timestamp: baselineSecond + 70,
    });
    const ambiguousSnapshot = snapshot(
      [repeatedBuy, { ...repeatedBuy }],
      [position("10")],
      now.toISOString(),
    );
    ambiguousSnapshot.activity = capture("activity", [{
      ...repeatedBuy,
      type: "TRADE",
      isCombo: false,
    }], ambiguousSnapshot.activity.fetchedAt);
    const store = new ObserveStore(databasePath, sourceVersion);
    const runner = new ObserveOnlyRunner(store, new QueueSource([
      snapshot([], [], now.toISOString()),
      ambiguousSnapshot,
    ]), {
      walletAddress: wallet,
      pollIntervalMs: 1_000,
      now: () => now,
    });

    await runner.pollOnce();
    now = new Date("2026-07-08T00:01:10.000Z");
    await runner.pollOnce();
    store.stopRun(runner.start().observeRunId, now.toISOString(), "TEST_COMPLETE");
    expect(store.runMetrics(runner.start().observeRunId)).toMatchObject({
      emittedSignals: 1,
      finalSyncStatus: "MINOR_DIFF",
    });
    store.close();

    const check = new DatabaseSync(databasePath, { readOnly: true });
    const report = check.prepare(
      "SELECT detail_json FROM reconciliation_reports WHERE observe_run_id=? ORDER BY created_at DESC LIMIT 1",
    ).get(runner.start().observeRunId) as { detail_json: string };
    expect(JSON.parse(report.detail_json)).toContainEqual(expect.objectContaining({
      issueType: "SOURCE_EVENT_MULTIPLICITY_AMBIGUOUS",
      tradesCount: 1,
      activityCount: 0,
    }));
    check.close();
  });

  it("keeps an Activity-only repeated occurrence out of the Observe gate", async () => {
    const { databasePath } = setup([]);
    let now = new Date("2026-07-08T00:01:00.000Z");
    const repeatedBuy = trade({
      transactionHash: "0xactivity-only-identical-buy",
      side: "BUY",
      price: "0.5",
      size: "10",
      timestamp: baselineSecond + 70,
    });
    const activityAhead = snapshot([repeatedBuy], [position("10")], now.toISOString());
    activityAhead.activity = capture("activity", [
      { ...repeatedBuy, type: "TRADE", isCombo: false },
      { ...repeatedBuy, type: "TRADE", isCombo: false },
    ], activityAhead.activity.fetchedAt);
    const store = new ObserveStore(databasePath, sourceVersion);
    const runner = new ObserveOnlyRunner(store, new QueueSource([
      snapshot([], [], now.toISOString()),
      activityAhead,
    ]), {
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
      finalSyncStatus: "MINOR_DIFF",
    });
    store.close();
  });

  it("makes an identical occurrence confirmed only after restart a non-executable gap signal", async () => {
    const { databasePath } = setup([]);
    let now = new Date("2026-07-08T00:01:00.000Z");
    const repeatedBuy = trade({
      transactionHash: "0xrestart-confirmed-identical-buy",
      side: "BUY",
      price: "0.5",
      size: "10",
      timestamp: baselineSecond + 70,
    });
    const ambiguousSnapshot = snapshot(
      [repeatedBuy, { ...repeatedBuy }],
      [position("10")],
      now.toISOString(),
    );
    ambiguousSnapshot.activity = capture("activity", [{
      ...repeatedBuy,
      type: "TRADE",
      isCombo: false,
    }], ambiguousSnapshot.activity.fetchedAt);

    const firstStore = new ObserveStore(databasePath, sourceVersion);
    const firstRunner = new ObserveOnlyRunner(firstStore, new QueueSource([
      snapshot([], [], now.toISOString()),
      ambiguousSnapshot,
    ]), {
      walletAddress: wallet,
      pollIntervalMs: 1_000,
      now: () => now,
    });
    await firstRunner.pollOnce();
    now = new Date("2026-07-08T00:01:10.000Z");
    await firstRunner.pollOnce();
    firstStore.stopRun(firstRunner.start().observeRunId, now.toISOString(), "TEST_RESTART");
    firstStore.close();

    now = new Date("2026-07-08T00:01:20.000Z");
    const delayedActivity = snapshot([], [position("20")], now.toISOString());
    delayedActivity.activity = capture("activity", [
      { ...repeatedBuy, type: "TRADE", isCombo: false },
      { ...repeatedBuy, type: "TRADE", isCombo: false },
    ], delayedActivity.activity.fetchedAt);
    const secondStore = new ObserveStore(databasePath, sourceVersion);
    const secondRunner = new ObserveOnlyRunner(secondStore, new QueueSource([
      delayedActivity,
    ]), {
      walletAddress: wallet,
      pollIntervalMs: 1_000,
      now: () => now,
    });
    await secondRunner.pollOnce();
    secondStore.stopRun(secondRunner.start().observeRunId, now.toISOString(), "TEST_COMPLETE");
    expect(secondStore.runMetrics(secondRunner.start().observeRunId).finalSyncStatus).toBe("SYNCED");
    secondStore.close();

    const check = new DatabaseSync(databasePath, { readOnly: true });
    const signals = check.prepare(
      `SELECT execution_eligible,execution_block_reason,event_classification
       FROM signals WHERE producer_mode='OBSERVE_ONLY' ORDER BY created_at,signal_id`,
    ).all() as Array<{
      execution_eligible: number;
      execution_block_reason: string | null;
      event_classification: string;
    }>;
    expect(signals).toEqual(expect.arrayContaining([
      { execution_eligible: 1, execution_block_reason: null, event_classification: "STANDARD_TRADE" },
      { execution_eligible: 0, execution_block_reason: "GAP_EVENT", event_classification: "GAP_TRADE" },
    ]));
    const gapConfirmed = check.prepare(
      "SELECT count(*) count FROM observe_events WHERE activity_confirmed=1 AND is_gap=1",
    ).get() as { count: number };
    expect(gapConfirmed.count).toBe(1);
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
    expect(source.recoveryFromTimestamps).toEqual([baselineSecond, undefined, baselineSecond + 60]);
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

  it("treats a long scheduling pause as a recovery gap and excludes it from active runtime", async () => {
    const { databasePath } = setup();
    let now = new Date("2026-07-08T00:01:00.000Z");
    const delayedBuy = trade({ transactionHash: "0xsleep-gap", timestamp: baselineSecond + 90 });
    const source = new QueueSource([
      snapshot([], [position("100")], now.toISOString()),
      snapshot([delayedBuy], [position("110")], "2026-07-08T00:01:40.000Z"),
    ]);
    const store = new ObserveStore(databasePath, sourceVersion);
    const runner = new ObserveOnlyRunner(store, source, {
      walletAddress: wallet,
      pollIntervalMs: 1_000,
      now: () => now,
    });

    await runner.pollOnce();
    now = new Date("2026-07-08T00:01:40.000Z");
    await runner.pollOnce();
    store.stopRun(runner.start().observeRunId, now.toISOString(), "TEST_COMPLETE");

    expect(source.recoveryFromTimestamps).toEqual([baselineSecond, baselineSecond + 60]);
    expect(store.runMetrics(runner.start().observeRunId)).toMatchObject({
      schedulingGapCount: 1,
      maxSchedulingGapMs: 39_000,
      activeRuntimeMs: 1_000,
      gapEvents: 1,
    });
    store.close();

    const check = new DatabaseSync(databasePath, { readOnly: true });
    expect(check.prepare(
      "SELECT execution_eligible,execution_block_reason FROM signals WHERE producer_mode='OBSERVE_ONLY'",
    ).get()).toEqual({ execution_eligible: 0, execution_block_reason: "GAP_EVENT" });
    check.close();
  });

  it("treats a long in-flight poll pause as a gap before emitting its events", async () => {
    const { databasePath } = setup();
    let now = new Date("2026-07-08T00:01:00.000Z");
    let pollCount = 0;
    const recoveryRequests: Array<number | undefined> = [];
    const delayedBuy = trade({ transactionHash: "0xinflight-sleep", timestamp: baselineSecond + 90 });
    const source: ObserveDataSource = {
      async poll(_walletAddress, recoveryFromTimestamp) {
        pollCount += 1;
        recoveryRequests.push(recoveryFromTimestamp);
        if (pollCount === 1) return snapshot([], [position("100")], now.toISOString());
        now = new Date("2026-07-08T00:01:40.000Z");
        return snapshot([delayedBuy], [position("110")], now.toISOString());
      },
    };
    const store = new ObserveStore(databasePath, sourceVersion);
    const runner = new ObserveOnlyRunner(store, source, {
      walletAddress: wallet,
      pollIntervalMs: 1_000,
      now: () => now,
    });

    await runner.pollOnce();
    await runner.pollOnce();
    store.stopRun(runner.start().observeRunId, now.toISOString(), "TEST_COMPLETE");

    expect(recoveryRequests).toEqual([baselineSecond, undefined, baselineSecond + 60]);
    expect(store.runMetrics(runner.start().observeRunId)).toMatchObject({
      schedulingGapCount: 1,
      maxSchedulingGapMs: 10_000,
      activeRuntimeMs: 30_000,
      gapEvents: 1,
    });
    store.close();

    const check = new DatabaseSync(databasePath, { readOnly: true });
    expect(check.prepare(
      "SELECT execution_eligible,execution_block_reason FROM signals WHERE producer_mode='OBSERVE_ONLY'",
    ).get()).toEqual({ execution_eligible: 0, execution_block_reason: "GAP_EVENT" });
    check.close();
  });

  it("detects a trailing scheduling gap when sleep carries the run past its deadline", async () => {
    const { databasePath } = setup();
    let now = new Date("2026-07-08T00:01:00.000Z");
    const store = new ObserveStore(databasePath, sourceVersion);
    const runner = new ObserveOnlyRunner(
      store,
      new QueueSource([snapshot([], [position("100")], now.toISOString())]),
      {
        walletAddress: wallet,
        pollIntervalMs: 1_000,
        durationMs: 40_000,
        now: () => now,
        wait: async () => {
          now = new Date("2026-07-08T00:01:40.000Z");
        },
      },
    );

    await expect(runner.run()).resolves.toMatchObject({
      schedulingGapCount: 1,
      maxSchedulingGapMs: 39_000,
      activeRuntimeMs: 1_000,
    });
    store.close();
  });

  it("keeps poll starts on a monotonic fixed-rate cadence without overlapping polls", async () => {
    const { databasePath } = setup();
    const baseMs = Date.parse("2026-07-08T00:01:00.000Z");
    let monotonicMs = 0;
    const pollStarts: number[] = [];
    const waits: number[] = [];
    const source: ObserveDataSource = {
      async poll() {
        pollStarts.push(monotonicMs);
        monotonicMs += 1_200;
        return snapshot([], [position("100")], new Date(baseMs + monotonicMs).toISOString());
      },
    };
    const store = new ObserveStore(databasePath, sourceVersion);
    const runner = new ObserveOnlyRunner(store, source, {
      walletAddress: wallet,
      pollIntervalMs: 15_000,
      durationMs: 30_000,
      now: () => new Date(baseMs + monotonicMs),
      monotonicNow: () => monotonicMs,
      wait: async (milliseconds) => {
        waits.push(milliseconds);
        monotonicMs += milliseconds;
      },
    });

    await runner.run();

    expect(pollStarts).toEqual([0, 15_000]);
    expect(waits).toEqual([13_800, 13_800]);
    store.close();
  });

  it("cancels an in-flight poll without recording an API failure or partial checkpoint", async () => {
    const { databasePath } = setup();
    const now = new Date("2026-07-08T00:01:00.000Z");
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const source: ObserveDataSource = {
      async poll(_walletAddress, _recoveryFromTimestamp, _activityFromTimestamp, signal) {
        receivedSignal = signal;
        controller.abort(new Error("TEST_SAFE_STOP"));
        throw controller.signal.reason;
      },
    };
    const store = new ObserveStore(databasePath, sourceVersion);
    const runner = new ObserveOnlyRunner(store, source, {
      walletAddress: wallet,
      pollIntervalMs: 1_000,
      now: () => now,
    });

    expect(await runner.pollOnce(controller.signal)).toBe(false);
    expect(receivedSignal).toBe(controller.signal);
    store.stopRun(runner.start().observeRunId, now.toISOString(), "TEST_COMPLETE");
    expect(store.runMetrics(runner.start().observeRunId)).toMatchObject({
      successfulPolls: 0,
      failedPolls: 0,
      lastCheckpointId: null,
    });
    store.close();
  });

  it("passes one AbortSignal through every recovery data read", async () => {
    const now = new Date("2026-07-08T00:01:00.000Z");
    const controller = new AbortController();
    const received: AbortSignal[] = [];
    const paged = <T>(endpoint: string, rows: T[]) => ({
      rows,
      captures: [capture(endpoint, rows, now.toISOString())],
      boundaryOverlapRows: [],
      historyComplete: true,
      stopReason: "END_OF_DATA",
    });
    const api = {
      tradesSince: async (_address: string, _start: number, signal?: AbortSignal) => {
        if (signal) received.push(signal);
        return paged<PublicTrade>("trades", []);
      },
      activitySince: async (_address: string, _start: number, signal?: AbortSignal) => {
        if (signal) received.push(signal);
        return paged<PublicActivity>("activity", []);
      },
      allPositions: async (_address: string, signal?: AbortSignal) => {
        if (signal) received.push(signal);
        const result = paged<PublicPosition>("positions", []);
        return { ...result, merged: capture("positions", [], now.toISOString()) };
      },
      pUsdBalance: async (_address: string, signal?: AbortSignal) => {
        if (signal) received.push(signal);
        return capture("balance", { jsonrpc: "2.0", id: 2, result: "0x0" }, now.toISOString());
      },
    };
    const source = new PublicObserveDataSource(api as unknown as PolymarketPublicApi);

    await source.poll(wallet, baselineSecond, baselineSecond, controller.signal);

    expect(received).toEqual([
      controller.signal,
      controller.signal,
      controller.signal,
      controller.signal,
    ]);
  });

  it("keeps an event after runner startup eligible even when it arrives in the first poll", async () => {
    const { databasePath } = setup();
    let now = new Date("2026-07-08T00:01:00.000Z");
    const postStartTrade = trade({
      transactionHash: "0xpost-start-first-poll",
      timestamp: baselineSecond + 61,
    });
    const store = new ObserveStore(databasePath, sourceVersion);
    const runner = new ObserveOnlyRunner(
      store,
      new QueueSource([snapshot([postStartTrade], [position("110")], "2026-07-08T00:01:02.000Z")]),
      { walletAddress: wallet, pollIntervalMs: 1_000, now: () => now },
    );

    runner.start();
    now = new Date("2026-07-08T00:01:02.000Z");
    await runner.pollOnce();
    store.stopRun(runner.start().observeRunId, "2026-07-08T00:01:02.000Z", "TEST_COMPLETE");
    store.close();

    const check = new DatabaseSync(databasePath, { readOnly: true });
    expect(check.prepare(
      `SELECT execution_eligible,execution_block_reason,event_classification
       FROM signals WHERE producer_mode='OBSERVE_ONLY'`,
    ).get()).toEqual({
      execution_eligible: 1,
      execution_block_reason: null,
      event_classification: "STANDARD_TRADE",
    });
    check.close();
  });

  it("uses the calibrated market clock to keep a pre-start event inside the no-catch-up gap", async () => {
    const { databasePath } = setup();
    let now = new Date("2026-07-08T00:01:00.000Z");
    const preStartByMarketClock = trade({
      transactionHash: "0xmarket-clock-pre-start",
      timestamp: baselineSecond + 61,
    });
    const store = new ObserveStore(databasePath, sourceVersion);
    const runner = new ObserveOnlyRunner(
      store,
      new QueueSource([
        snapshot([preStartByMarketClock], [position("110")], "2026-07-08T00:01:02.000Z"),
      ]),
      {
        walletAddress: wallet,
        pollIntervalMs: 1_000,
        marketClockOffsetMs: 1_700,
        now: () => now,
      },
    );

    runner.start();
    now = new Date("2026-07-08T00:01:02.000Z");
    await runner.pollOnce();
    store.stopRun(runner.start().observeRunId, now.toISOString(), "TEST_COMPLETE");
    store.close();

    const check = new DatabaseSync(databasePath, { readOnly: true });
    expect(check.prepare(
      `SELECT execution_eligible,execution_block_reason,event_classification
       FROM signals WHERE producer_mode='OBSERVE_ONLY'`,
    ).get()).toEqual({
      execution_eligible: 0,
      execution_block_reason: "GAP_EVENT",
      event_classification: "GAP_TRADE",
    });
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

  it("fails closed and marks MAJOR_DESYNC when a recovered checkpoint projection hash is corrupt", async () => {
    const { databasePath, targetId } = setup();
    let now = new Date("2026-07-08T00:01:00.000Z");
    const firstStore = new ObserveStore(databasePath, sourceVersion);
    const firstRunner = new ObserveOnlyRunner(
      firstStore,
      new QueueSource([snapshot([], [position("100")], now.toISOString())]),
      { walletAddress: wallet, pollIntervalMs: 1_000, staleRunAfterMs: 1_000, now: () => now },
    );
    await firstRunner.pollOnce();
    firstStore.close();

    const corrupt = new DatabaseSync(databasePath);
    corrupt.exec("DROP TRIGGER observe_checkpoints_no_update");
    corrupt.prepare("UPDATE observe_checkpoints SET position_projection_hash='corrupt'").run();
    corrupt.close();

    now = new Date("2026-07-08T00:02:00.000Z");
    const source = new QueueSource([snapshot([], [position("100")], now.toISOString())]);
    const secondStore = new ObserveStore(databasePath, sourceVersion);
    const secondRunner = new ObserveOnlyRunner(
      secondStore,
      source,
      { walletAddress: wallet, pollIntervalMs: 1_000, staleRunAfterMs: 1_000, now: () => now },
    );

    expect(() => secondRunner.start()).toThrow("CHECKPOINT_PROJECTION_HASH_MISMATCH");
    expect(source.recoveryFromTimestamps).toEqual([]);
    secondStore.close();

    const check = new DatabaseSync(databasePath, { readOnly: true });
    expect(check.prepare("SELECT sync_status FROM monitor_targets WHERE target_id=?").get(targetId))
      .toEqual({ sync_status: "MAJOR_DESYNC" });
    expect(check.prepare(
      `SELECT issue_type,sync_status,status FROM reconciliation_issues
       WHERE target_id=? AND issue_type='CHECKPOINT_PROJECTION_HASH_MISMATCH'`,
    ).get(targetId)).toEqual({
      issue_type: "CHECKPOINT_PROJECTION_HASH_MISMATCH",
      sync_status: "MAJOR_DESYNC",
      status: "OPEN",
    });
    expect(check.prepare("SELECT state,stop_reason FROM observe_runs ORDER BY started_at DESC LIMIT 1").get())
      .toEqual({ state: "FAILED", stop_reason: "CHECKPOINT_PROJECTION_HASH_MISMATCH" });
    check.close();
  });

  it("does not recover a checkpoint created for an older position baseline", async () => {
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

    const newBaselineTime = "2026-07-08T00:01:30.000Z";
    const newBaselineRunId = addBaseline(databasePath, newBaselineTime, [position("100")]);
    now = new Date("2026-07-08T00:02:00.000Z");
    const secondStore = new ObserveStore(databasePath, sourceVersion);
    const secondRunner = new ObserveOnlyRunner(
      secondStore,
      new QueueSource([snapshot([], [position("100")], now.toISOString())]),
      { walletAddress: wallet, pollIntervalMs: 1_000, staleRunAfterMs: 1_000, now: () => now },
    );
    const started = secondRunner.start();

    expect(started.baseline.baselineRunId).toBe(newBaselineRunId);
    expect(started.recoveredFromCheckpoint).toBe(false);
    expect(started.checkpoint).toBeNull();
    expect(started.gapFrom).toBe(newBaselineTime);
    secondStore.stopRun(started.observeRunId, now.toISOString(), "TEST_COMPLETE");
    secondStore.close();
  });

  it("uses an explicitly bound baseline even when a newer baseline exists", () => {
    const { databasePath, baselineRunId } = setup();
    addBaseline(databasePath, "2026-07-08T00:01:30.000Z", [position("250")]);
    const now = new Date("2026-07-08T00:02:00.000Z");
    const store = new ObserveStore(databasePath, sourceVersion);
    const runner = new ObserveOnlyRunner(
      store,
      new QueueSource([]),
      {
        walletAddress: wallet,
        baselineRunId,
        pollIntervalMs: 1_000,
        staleRunAfterMs: 1_000,
        now: () => now,
      },
    );

    const started = runner.start();
    expect(started.baseline.baselineRunId).toBe(baselineRunId);
    store.stopRun(started.observeRunId, now.toISOString(), "TEST_COMPLETE");
    expect(store.runMetrics(started.observeRunId).baselineRunId).toBe(baselineRunId);
    store.close();

    const invalidStore = new ObserveStore(databasePath, sourceVersion);
    const invalid = new ObserveOnlyRunner(
      invalidStore,
      new QueueSource([]),
      { walletAddress: wallet, baselineRunId: "missing-baseline", pollIntervalMs: 1_000, now: () => now },
    );
    expect(() => invalid.start()).toThrow("OBSERVE_BASELINE_NOT_READY_OR_WALLET_MISMATCH:missing-baseline");
    invalidStore.close();
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
    second.activity = capture("activity", [], second.activity.fetchedAt);
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

  it("records a combo trade from Activity without projecting it or emitting a signal", async () => {
    const { databasePath } = setup();
    let now = new Date("2026-07-08T00:01:00.000Z");
    const comboActivity = activity({
      type: "TRADE",
      transactionHash: "0xcombo-trade",
      asset: "asset-1",
      side: "BUY",
      price: "0.5",
      size: "10",
      timestamp: baselineSecond + 70,
      isCombo: true,
    });
    const matchingTrade = trade({
      transactionHash: comboActivity.transactionHash,
      price: comboActivity.price!,
      size: comboActivity.size!,
      timestamp: comboActivity.timestamp,
    });
    const second = snapshot([matchingTrade], [position("100")], "2026-07-08T00:01:10.000Z");
    second.activity = capture("activity", [comboActivity], second.activity.fetchedAt);
    const store = new ObserveStore(databasePath, sourceVersion);
    const runner = new ObserveOnlyRunner(store, new QueueSource([
      snapshot([], [position("100")], now.toISOString()),
      second,
    ]), {
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
      emittedSignals: 0,
      finalSyncStatus: "SYNCED",
    });
    store.close();

    const check = new DatabaseSync(databasePath, { readOnly: true });
    expect(check.prepare(
      "SELECT is_combo,event_classification FROM raw_events WHERE source_transaction_hash='0xcombo-trade'",
    ).get()).toEqual({ is_combo: 1, event_classification: "COMBO_ACTIVITY" });
    expect((check.prepare("SELECT count(*) count FROM observe_signal_emissions").get() as { count: number }).count).toBe(0);
    check.close();
  });

  it("waits for Activity confirmation before publishing a Trades-only event", async () => {
    const { databasePath } = setup();
    let now = new Date("2026-07-08T00:01:00.000Z");
    const pendingTrade = trade({ transactionHash: "0xactivity-delayed", timestamp: baselineSecond + 70 });
    const tradeOnly = snapshot([pendingTrade], [position("110")], "2026-07-08T00:01:10.000Z");
    tradeOnly.activity = capture("activity", [], tradeOnly.activity.fetchedAt);
    const confirmed = snapshotWithActivity([activity({
      ...pendingTrade,
      type: "TRADE",
      isCombo: false,
    })], [position("110")], "2026-07-08T00:01:20.000Z");
    const store = new ObserveStore(databasePath, sourceVersion);
    const source = new QueueSource([
      snapshot([], [position("100")], now.toISOString()),
      tradeOnly,
      confirmed,
    ]);
    const runner = new ObserveOnlyRunner(store, source, {
      walletAddress: wallet,
      pollIntervalMs: 1_000,
      now: () => now,
      sourceVersion,
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
    let check = new DatabaseSync(databasePath, { readOnly: true });
    expect((check.prepare("SELECT count(*) count FROM signals WHERE producer_mode='OBSERVE_ONLY'").get() as { count: number }).count).toBe(0);
    check.close();

    now = new Date("2026-07-08T00:01:20.000Z");
    await runner.pollOnce();
    store.stopRun(runner.start().observeRunId, now.toISOString(), "TEST_COMPLETE");
    store.close();
    check = new DatabaseSync(databasePath, { readOnly: true });
    expect((check.prepare("SELECT count(*) count FROM signals WHERE producer_mode='OBSERVE_ONLY'").get() as { count: number }).count).toBe(1);
    expect(check.prepare(
      "SELECT activity_confirmed FROM observe_events WHERE source_event_key=(SELECT source_event_key FROM signals WHERE producer_mode='OBSERVE_ONLY')",
    ).get()).toEqual({ activity_confirmed: 1 });
    expect((check.prepare("SELECT count(*) count FROM signal_execution_contexts").get() as { count: number }).count).toBe(1);
    expect(source.activityFromTimestamps).toEqual([
      baselineSecond - 1,
      baselineSecond - 1,
      pendingTrade.timestamp - 1,
    ]);
    check.close();
  });

  it("reclassifies a delayed combo confirmation without ever publishing a signal", async () => {
    const { databasePath } = setup();
    let now = new Date("2026-07-08T00:01:00.000Z");
    const pendingTrade = trade({ transactionHash: "0xcombo-delayed", timestamp: baselineSecond + 70 });
    const tradeOnly = snapshot([pendingTrade], [position("110")], "2026-07-08T00:01:10.000Z");
    tradeOnly.activity = capture("activity", [], tradeOnly.activity.fetchedAt);
    const comboConfirmation = snapshotWithActivity([activity({
      ...pendingTrade,
      type: "TRADE",
      isCombo: true,
    })], [position("100")], "2026-07-08T00:01:20.000Z");
    const store = new ObserveStore(databasePath, sourceVersion);
    const runner = new ObserveOnlyRunner(store, new QueueSource([
      snapshot([], [position("100")], now.toISOString()),
      tradeOnly,
      comboConfirmation,
    ]), { walletAddress: wallet, pollIntervalMs: 1_000, now: () => now });

    await runner.pollOnce();
    now = new Date("2026-07-08T00:01:10.000Z");
    await runner.pollOnce();
    now = new Date("2026-07-08T00:01:20.000Z");
    await runner.pollOnce();
    store.stopRun(runner.start().observeRunId, now.toISOString(), "TEST_COMPLETE");
    expect(store.runMetrics(runner.start().observeRunId)).toMatchObject({
      emittedSignals: 0,
      finalSyncStatus: "SYNCED",
    });
    store.close();

    const check = new DatabaseSync(databasePath, { readOnly: true });
    expect(check.prepare(
      "SELECT is_combo,event_classification FROM raw_events WHERE source_transaction_hash='0xcombo-delayed'",
    ).get()).toEqual({ is_combo: 1, event_classification: "COMBO_ACTIVITY" });
    check.close();
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
      `SELECT c.target_id context_target_id,s.target_id signal_target_id,ce.target_id capital_target_id,
              c.target_trade_capital_ratio_ppm,ce.source_event_key,
              c.capital_sizing_ratio_json context_sizing_json,
              c.capital_sizing_ratio_hash context_sizing_hash,
              ce.capital_sizing_ratio_json estimate_sizing_json,
              ce.capital_sizing_ratio_hash estimate_sizing_hash
       FROM signal_execution_contexts c
       JOIN signals s ON s.signal_id=c.signal_id
       JOIN capital_estimates ce ON ce.capital_estimate_id=c.capital_decision_id`,
    ).get() as {
      context_target_id: string;
      signal_target_id: string;
      capital_target_id: string;
      target_trade_capital_ratio_ppm: string;
      source_event_key: string;
      context_sizing_json: string;
      context_sizing_hash: string;
      estimate_sizing_json: string;
      estimate_sizing_hash: string;
    };
    expect(context.context_target_id).toBe(context.signal_target_id);
    expect(context.context_target_id).toBe(context.capital_target_id);
    expect(BigInt(context.target_trade_capital_ratio_ppm)).toBeGreaterThan(0n);
    expect(context.source_event_key).toBeTruthy();
    expect(context.context_sizing_json).toBe(context.estimate_sizing_json);
    expect(context.context_sizing_hash).toBe(context.estimate_sizing_hash);
    expect(JSON.parse(context.context_sizing_json)).toMatchObject({
      calculationVersion: "EXACT_RATIONAL_V1",
      targetPriceUnits: "500000000000000000",
      targetSizeMicros: "10000000",
    });
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
