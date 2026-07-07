import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { PublicTrade } from "../src/domain/models.js";
import { Phase0Database } from "../src/infra/sqlite/database.js";
import { ReplayEngine } from "../src/replay/replay-engine.js";

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
    database.saveReplay(targetId, trades, report);
    database.saveReplay(targetId, trades, report);
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

  it("rolls back the complete critical transaction when one raw event is invalid", () => {
    const { databasePath } = workspace();
    const valid = trade();
    const invalid = trade({ transactionHash: "0x2", price: "0.1234567890123456789" });
    const database = new Phase0Database(databasePath);
    database.initialize();
    const targetId = database.ensureTarget(wallet, "IDENTITY_CONFIRMED");
    expect(() => database.saveReplay(targetId, [valid, invalid], passedReport([valid]))).toThrow(/Precision exceeds/);
    database.close();

    const check = new DatabaseSync(databasePath, { readOnly: true });
    expect((check.prepare("SELECT count(*) count FROM raw_events").get() as { count: number }).count).toBe(0);
    expect((check.prepare("SELECT count(*) count FROM signals").get() as { count: number }).count).toBe(0);
    expect((check.prepare("SELECT count(*) count FROM replay_runs").get() as { count: number }).count).toBe(0);
    check.close();
  });
});
