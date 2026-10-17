import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { loadAccountExposure, projectAccountExposure } from "../src/execution/exposure-obligations.js";
import { allocateRemainingTargetSellSizes, remainingTargetSellSize } from "../src/execution/target-sell-policy.js";
import { settlementClaimAmount } from "../src/settlement/settlement-allocation.js";
import { LiveSignalConsumer } from "../src/live/live-signal-consumer.js";
import { LiveStore, type LiveExecutionRow } from "../src/live/live-store.js";
import type { PaperSignalEnvelope } from "../src/paper/types.js";

describe("exposure obligations", () => {
  it("projects position cost and pending BUYs with exact integer scope totals", () => {
    const huge = 10n ** 25n;
    const positions = [{ assetId: "a", conditionId: "Market", amountMicros: huge }];
    const pending = [
      { executionId: "own", assetId: "a", conditionId: "market", amountMicros: 50n },
      { executionId: "other", assetId: "b", conditionId: "elsewhere", amountMicros: 75n },
    ];
    const exposure = projectAccountExposure(positions, pending, "own");
    expect(exposure.totalMicros).toBe(huge + 75n);
    expect(exposure.marketMicros.get("market")).toBe(huge);
    expect(exposure.assetMicros.get("b")).toBe(75n);
    expect(exposure.pendingBuys.get("own")?.amountMicros).toBe(50n);
    expect(() => projectAccountExposure([], [{ ...pending[0]!, amountMicros: -1n }])).toThrow("EXPOSURE_OBLIGATION_NEGATIVE");
  });

  it.each(["PAPER", "LIVE"] as const)("loads %s obligations by account, including partial/released reservations and frozen cost", (mode) => {
    const db = new DatabaseSync(":memory:");
    const prefix = mode.toLowerCase();
    db.exec(`CREATE TABLE ${prefix}_positions(${prefix}_account_id TEXT,asset_id TEXT,condition_id TEXT,remaining_cost_micros TEXT,status TEXT);
      CREATE TABLE ${prefix}_executions(${prefix}_execution_id TEXT,${prefix}_account_id TEXT,asset_id TEXT,condition_id TEXT,execution_type TEXT);
      INSERT INTO ${prefix}_positions VALUES ('a','asset','Market','100','FROZEN'),('b','asset','Market','999','OPEN'),('a','asset','Market','999','REDEEMED');
      INSERT INTO ${prefix}_executions VALUES ('pending','a','asset','market','TARGET_BUY'),('released','a','asset','market','TARGET_BUY'),('foreign','b','asset','market','TARGET_BUY');`);
    if (mode === "PAPER") db.exec(`CREATE TABLE paper_reservations(paper_execution_id TEXT,remaining_amount_micros TEXT,status TEXT);
      INSERT INTO paper_reservations VALUES ('pending','40','ACTIVE'),('released','0','RELEASED'),('foreign','999','ACTIVE');`);
    else db.exec(`CREATE TABLE live_reservation_ledger(live_execution_id TEXT,delta_micros TEXT);
      INSERT INTO live_reservation_ledger VALUES ('pending','60'),('pending','-20'),('released','70'),('released','-70'),('foreign','999');`);
    expect(loadAccountExposure(db, mode, "a").totalMicros).toBe(140n);
    expect(loadAccountExposure(db, mode, "a", "pending").totalMicros).toBe(100n);
    const huge = 10n ** 25n;
    db.prepare(`UPDATE ${prefix}_positions SET remaining_cost_micros=? WHERE ${prefix}_account_id='a' AND status='FROZEN'`).run(huge.toString());
    const scoped = loadAccountExposure(db, mode, "a", undefined, { assetId: "asset", conditionId: "MARKET" });
    expect(scoped.totalMicros).toBe(huge + 40n);
    expect(scoped.marketMicros.get("market")).toBe(huge + 40n);
    expect(scoped.assetMicros.get("asset")).toBe(huge + 40n);
    db.close();
  });
});

describe("target sell obligations", () => {
  it("rounds once for an asset and allocates the remainder deterministically over lots", () => {
    const ratio = { numerator: 1n, denominator: 2n };
    expect(allocateRemainingTargetSellSizes([
      { currentSizeMicros: 3n, pendingExitSizeMicros: 2n },
      { currentSizeMicros: 3n, pendingExitSizeMicros: 2n },
    ], ratio)).toEqual([0n, 1n]);
    expect(() => remainingTargetSellSize({ currentSizeMicros: 1n, pendingExitSizeMicros: 2n, ratio })).toThrow("TARGET_SELL_PENDING_SIZE_INVALID");
  });

  it.each([0n, 50_000_000n, 150_000_000n])("Live reserves a second proportional exit after %s microshares have filled", (filled) => {
    const db = new DatabaseSync(":memory:");
    db.exec(`CREATE TABLE live_positions(live_position_id TEXT,live_account_id TEXT,asset_id TEXT,condition_id TEXT,current_size_micros TEXT,status TEXT,created_at TEXT);
      CREATE TABLE live_executions(live_execution_id TEXT,live_account_id TEXT,asset_id TEXT,condition_id TEXT);
      CREATE TABLE live_asset_reservation_ledger(asset_reservation_ledger_id TEXT,live_execution_id TEXT,live_order_id TEXT,asset_id TEXT,entry_type TEXT,delta_size_micros TEXT,remaining_after_micros TEXT,idempotency_key TEXT,created_at TEXT);
      INSERT INTO live_positions VALUES ('p','a','asset','condition','200000000','OPEN','2026-10-16');
      INSERT INTO live_executions VALUES ('first','a','asset','condition'),('second','a','asset','condition'),('foreign','b','asset','condition');
      INSERT INTO live_asset_reservation_ledger VALUES ('foreign','foreign',NULL,'asset','RESERVE','999999999','999999999','foreign','2026-10-16');`);
    const consumer = Object.create(LiveSignalConsumer.prototype) as {
      database: DatabaseSync;
      sellSize(account: string, signal: PaperSignalEnvelope, threshold: number): bigint | null;
    };
    consumer.database = db;
    const signal = (numerator: string, denominator: string) => ({
      assetId: "asset", conditionId: "condition", sellRatioNumerator: numerator, sellRatioDenominator: denominator,
    }) as PaperSignalEnvelope;
    const execution = (id: string) => ({ live_execution_id: id, live_account_id: "a", asset_id: "asset" }) as LiveExecutionRow;
    const store = new LiveStore(db, { commit: "obligation-test", dirty: false }, () => new Date("2026-10-16T00:00:00Z"));
    const wallet = { outcomeBalanceMicros: 200_000_000n, outcomeAllowanceMicros: 200_000_000n };
    const first = consumer.sellSize("a", signal("3", "4"), 1_000_000)!;
    expect(first).toBe(150_000_000n);
    store.reserveAssetChecked(execution("first"), first, wallet);
    db.prepare("UPDATE live_positions SET current_size_micros=? WHERE live_position_id='p'").run((200_000_000n - filled).toString());
    db.prepare("INSERT INTO live_asset_reservation_ledger VALUES ('fill','first',NULL,'asset','CONSUME',?,'0','fill','2026-10-16')").run((-filled).toString());
    const second = consumer.sellSize("a", signal("1", "2"), 1_000_000)!;
    expect(second).toBe(25_000_000n);
    expect(() => store.reserveAssetChecked(execution("second"), second, wallet)).not.toThrow();
    db.close();
  });
});

describe("asset settlement allocation", () => {
  it("carries fractional payout over claims and retains a zero-payout asset", () => {
    expect(settlementClaimAmount({ sizeMicros: 3_333_333n, numerator: 1n, denominator: 2n,
      previouslySettledSizeMicros: 3_333_333n, previouslyPaidMicros: 1_666_666n })).toEqual({
      redeemMicros: 1_666_667n, aggregateRedeemMicros: 3_333_333n,
    });
    expect(settlementClaimAmount({ sizeMicros: 3n, numerator: 0n, denominator: 2n,
      previouslySettledSizeMicros: 3n, previouslyPaidMicros: 0n }).redeemMicros).toBe(0n);
    expect(() => settlementClaimAmount({ sizeMicros: 3n, numerator: 1n, denominator: 2n,
      previouslySettledSizeMicros: 3n, previouslyPaidMicros: 2n })).toThrow("SETTLEMENT_PRIOR_PAYOUT_EXCEEDS_ENTITLEMENT");
  });
});
