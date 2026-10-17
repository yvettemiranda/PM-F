import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

const migration = readFileSync(new URL("../src/infra/sqlite/038_observe_event_ordering.sql", import.meta.url), "utf8");

function fixture() {
  const database = new DatabaseSync(":memory:");
  // The ordering migration reads only these legacy evidence columns. Keep
  // their exact names and shapes while making chronology cases explicit.
  database.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE monitor_targets(target_id TEXT PRIMARY KEY,sync_status TEXT);
    CREATE TABLE position_baseline_runs(baseline_run_id TEXT PRIMARY KEY,target_id TEXT);
    CREATE TABLE position_baseline_items(baseline_run_id TEXT,asset_id TEXT,condition_id TEXT);
    CREATE TABLE raw_events(source_event_key TEXT PRIMARY KEY,source_transaction_hash TEXT,source_timestamp INTEGER,
      asset_id TEXT,condition_id TEXT,side TEXT,price_units TEXT,size_micros TEXT,raw_json TEXT);
    CREATE TABLE observe_events(baseline_run_id TEXT,source_event_key TEXT,source_timestamp INTEGER);
    CREATE TABLE negative_risk_conversion_evidence(source_event_key TEXT,source_asset_id TEXT,destination_legs_json TEXT);
    INSERT INTO monitor_targets VALUES('target','SYNCED');
    INSERT INTO position_baseline_runs VALUES('baseline','target');`);
  const event = (key: string, input: { asset?: string; condition: string; timestamp?: number; type?: string; tx?: string }) => {
    const side = input.type === "CONVERSION" ? "NONE" : "BUY";
    database.prepare("INSERT INTO raw_events VALUES(?,?,?,?,?,?,?,?,?)").run(key, input.tx ?? key, input.timestamp ?? 2,
      input.asset ?? "", input.condition, side, side === "BUY" ? "500000000000000000" : "0", side === "BUY" ? "1000000" : "0",
      JSON.stringify({ type: input.type ?? "TRADE", size: "1" }));
    database.prepare("INSERT INTO observe_events VALUES('baseline',?,?)").run(key, input.timestamp ?? 2);
  };
  const conversion = (key: string, source: string, destination: string, condition: string, timestamp = 2) => {
    event(key, { type: "CONVERSION", condition: `group-${key}`, timestamp });
    database.prepare("INSERT INTO negative_risk_conversion_evidence VALUES(?,?,?)").run(key, source,
      JSON.stringify([{ asset: destination, conditionId: condition, amountMicros: "1000000" }]));
  };
  return { database, event, conversion };
}

describe("legacy Observe ordering migration", () => {
  it.each(["baseline", "trade", "prior-conversion"])(
    "quarantines source-asset chronology using its %s condition binding", (binding) => {
      const { database, event, conversion } = fixture();
      try {
        if (binding === "baseline") database.exec("INSERT INTO position_baseline_items VALUES('baseline','source','source-condition')");
        if (binding === "trade") event("source-binding", { asset: "source", condition: "source-condition", timestamp: 1 });
        if (binding === "prior-conversion") conversion("older", "older-source", "source", "source-condition", 1);
        conversion("convert", "source", "destination", "destination-condition");
        event("source-condition-buy", { asset: "opposite-outcome", condition: "source-condition" });
        const before = database.prepare("SELECT * FROM raw_events ORDER BY source_event_key").all();
        database.exec(migration);
        expect(database.prepare("SELECT reason FROM observe_ordering_blocks").all()).toEqual([{ reason: "LEGACY_SAME_SECOND_ORDER_UNVERIFIED" }]);
        expect(database.prepare("SELECT sync_status FROM monitor_targets").get()).toEqual({ sync_status: "MAJOR_DESYNC" });
        expect(database.prepare("SELECT * FROM raw_events ORDER BY source_event_key").all()).toEqual(before);
        expect(() => database.exec("DELETE FROM observe_ordering_blocks")).toThrow("immutable");
        expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      } finally { database.close(); }
    },
  );

  it("quarantines destination chronology even when the raw conversion condition is only the event group", () => {
    const { database, event, conversion } = fixture();
    try {
      conversion("convert", "source", "destination", "destination-condition");
      event("destination-buy", { asset: "destination", condition: "DESTINATION-CONDITION" });
      database.exec(migration);
      expect(database.prepare("SELECT count(*) n FROM observe_ordering_blocks").get()).toEqual({ n: 1 });
    } finally { database.close(); }
  });

  it("does not block unrelated simultaneous conditions or a later trade", () => {
    const { database, event, conversion } = fixture();
    try {
      conversion("convert", "source", "destination", "destination-condition");
      event("other-buy", { asset: "other", condition: "other-condition" });
      event("later-buy", { asset: "destination", condition: "destination-condition", timestamp: 3 });
      database.exec(migration);
      expect(database.prepare("SELECT count(*) n FROM observe_ordering_blocks").get()).toEqual({ n: 0 });
      expect(database.prepare("SELECT sync_status FROM monitor_targets").get()).toEqual({ sync_status: "SYNCED" });
    } finally { database.close(); }
  });

  it("preserves indistinguishable confirmed trade occurrences without imposing a rebase", () => {
    const { database, event } = fixture();
    try {
      event("occurrence-0", { tx: "same", asset: "source", condition: "condition" });
      event("occurrence-1", { tx: "same", asset: "source", condition: "condition" });
      database.exec(migration);
      expect(database.prepare("SELECT count(*) n FROM observe_ordering_blocks").get()).toEqual({ n: 0 });
      expect(database.prepare("SELECT count(*) n FROM raw_events").get()).toEqual({ n: 2 });
    } finally { database.close(); }
  });
});
