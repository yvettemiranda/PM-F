import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

const directories: string[] = [];
const sqliteDirectory = join(process.cwd(), "src", "infra", "sqlite");

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function legacyDatabase(): { database: DatabaseSync; path: string } {
  const directory = mkdtempSync(join(tmpdir(), "ni-k-signal-target-"));
  directories.push(directory);
  const path = join(directory, "legacy.sqlite");
  const database = new DatabaseSync(path);
  const migrations = readdirSync(sqliteDirectory)
    .filter((name) => /^\d{3}_.+\.sql$/.test(name) && Number(name.slice(0, 3)) <= 26)
    .sort();
  for (const migration of migrations) database.exec(readFileSync(join(sqliteDirectory, migration), "utf8"));
  return { database, path };
}

function insertRuleset(database: DatabaseSync): void {
  database.prepare(
    `INSERT INTO rulesets(
      ruleset_hash,schema_version,signal_version,strategy_version,risk_version,replay_version,
      ruleset_snapshot_json,source_code_commit,created_at,source_code_dirty,config_version
    ) VALUES ('ruleset-target-test','2.21.0','signal-test','strategy-test','risk-test',
      'replay-test','{}','target-binding-test','2026-07-17T00:00:00.000Z',0,'config-test')`,
  ).run();
}

function insertTargetAndRaw(database: DatabaseSync, targetId: string, sourceKey: string): void {
  database.prepare(
    `INSERT INTO monitor_targets(
      target_id,wallet_address,identity_status,runtime_mode,sync_status,created_at,updated_at
    ) VALUES (?, ?, 'IDENTITY_CONFIRMED','OBSERVE_ONLY','SYNCED',?,?)`,
  ).run(targetId, `wallet-${targetId}`, "2026-07-17T00:00:00.000Z", "2026-07-17T00:00:00.000Z");
  database.prepare(
    `INSERT INTO raw_events(
      source_event_key,target_id,identity_version,source_type,source_transaction_hash,
      source_timestamp,asset_id,condition_id,side,price_units,size_micros,gap_event,
      is_combo,raw_json,created_at,event_classification
    ) VALUES (?,?,'identity-test','DATA_API_TRADE',?,1,'asset','condition','BUY',
      '500000000000000000','10000000',0,0,'{}',?,'STANDARD_TRADE')`,
  ).run(sourceKey, targetId, `tx-${sourceKey}`, "2026-07-17T00:00:00.000Z");
}

function insertLegacyCapitalEstimate(
  database: DatabaseSync,
  capitalEstimateId: string,
  targetId: string,
  sourceKey: string | null,
): void {
  database.prepare(
    `INSERT INTO capital_estimates(
      capital_estimate_id,target_id,source_event_key,position_value_micros,
      wallet_balance_micros,target_visible_capital_micros,target_trade_amount_micros,
      target_trade_capital_ratio_ppm,capital_sizing_ratio_json,capital_sizing_ratio_hash,
      capital_estimate_status,capital_confidence,capital_estimate_reason,
      position_snapshot_time,wallet_balance_snapshot_time,target_trade_timestamp,
      fallback_amount_micros,schema_version,strategy_version,risk_version,
      ruleset_snapshot_json,ruleset_hash,source_code_commit,source_code_dirty,created_at
    ) VALUES (?,?,?,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'INCOMPLETE','MEDIUM','TEST',
      NULL,NULL,NULL,'10000000','2.21.0','strategy-test','risk-test','{}',
      'ruleset-target-test','target-binding-test',0,?)`,
  ).run(capitalEstimateId, targetId, sourceKey, "2026-07-17T00:00:00.000Z");
}

function insertLegacySignal(
  database: DatabaseSync,
  signalId: string,
  sourceKey: string,
  capitalEstimateId: string | null = null,
): void {
  database.prepare(
    `INSERT INTO signals(
      signal_id,signal_idempotency_key,source_event_key,signal_type,status,asset_id,
      condition_id,target_price_units,target_size_micros,sell_ratio_numerator,
      sell_ratio_denominator,reason,schema_version,signal_version,strategy_version,
      risk_version,replay_version,ruleset_snapshot_json,ruleset_hash,source_code_commit,
      created_at,execution_eligible,execution_block_reason,event_classification,
      capital_estimate_id,source_code_dirty,producer_mode
    ) VALUES (?,?,?,'TARGET_BUY','PUBLISHED','asset','condition','500000000000000000',
      '10000000',NULL,NULL,'TEST','2.21.0','signal-test','strategy-test','risk-test',
      'replay-test','{}','ruleset-target-test','target-binding-test',?,1,NULL,
      'STANDARD_TRADE',?,0,'OBSERVE_ONLY')`,
  ).run(signalId, `idem-${signalId}`, sourceKey, "2026-07-17T00:00:00.000Z", capitalEstimateId);
}

function insertLegacyContext(
  database: DatabaseSync,
  contextId: string,
  signalId: string,
  capitalDecisionId: string | null = null,
): void {
  database.prepare(
    `INSERT INTO signal_execution_contexts(
      context_id,signal_id,capital_decision_id,target_trade_capital_ratio_ppm,
      capital_sizing_ratio_json,capital_sizing_ratio_hash,target_trade_timestamp,
      market_end_time,market_metadata_snapshot_json,market_metadata_hash,ruleset_hash,
      schema_version,signal_version,strategy_version,source_code_commit,source_code_dirty,
      config_version,created_at
    ) VALUES (?,?,?,NULL,NULL,NULL,?,?, '{}','metadata','ruleset-target-test',
      '2.21.0','signal-test','strategy-test','target-binding-test',0,'config-test',?)`,
  ).run(
    contextId,
    signalId,
    capitalDecisionId,
    "2026-07-17T00:00:00.000Z",
    "2026-07-18T00:00:00.000Z",
    "2026-07-17T00:00:00.000Z",
  );
}

function insertBoundSignal(
  database: DatabaseSync,
  signalId: string,
  targetId: string,
  sourceKey: string,
  capitalEstimateId: string | null,
): void {
  database.prepare(
    `INSERT INTO signals(
      signal_id,target_id,signal_idempotency_key,source_event_key,signal_type,status,
      asset_id,condition_id,target_price_units,target_size_micros,reason,schema_version,
      signal_version,strategy_version,risk_version,replay_version,ruleset_snapshot_json,
      ruleset_hash,source_code_commit,created_at,execution_eligible,event_classification,
      source_code_dirty,producer_mode,capital_estimate_id
    ) VALUES (?,?,?,?,'TARGET_BUY','PUBLISHED','asset','condition','500000000000000000',
      '10000000','TEST','2.22.0','signal-test','strategy-test','risk-test','replay-test','{}',
      'ruleset-target-test','target-binding-test',?,1,'STANDARD_TRADE',0,'OBSERVE_ONLY',?)`,
  ).run(
    signalId,
    targetId,
    `idem-${signalId}`,
    sourceKey,
    "2026-07-17T00:00:00.000Z",
    capitalEstimateId,
  );
}

function insertBoundContext(
  database: DatabaseSync,
  contextId: string,
  targetId: string,
  signalId: string,
  capitalDecisionId: string | null,
): void {
  database.prepare(
    `INSERT INTO signal_execution_contexts(
      context_id,target_id,signal_id,capital_decision_id,target_trade_capital_ratio_ppm,
      capital_sizing_ratio_json,capital_sizing_ratio_hash,target_trade_timestamp,
      market_end_time,market_metadata_snapshot_json,market_metadata_hash,ruleset_hash,
      schema_version,signal_version,strategy_version,source_code_commit,source_code_dirty,
      config_version,created_at
    ) VALUES (?,?,?,?,NULL,NULL,NULL,?,?, '{}','metadata','ruleset-target-test',
      '2.22.0','signal-test','strategy-test','target-binding-test',0,'config-test',?)`,
  ).run(
    contextId,
    targetId,
    signalId,
    capitalDecisionId,
    "2026-07-17T00:00:00.000Z",
    "2026-07-18T00:00:00.000Z",
    "2026-07-17T00:00:00.000Z",
  );
}

describe("immutable Signal target binding", () => {
  it("backfills a 2.21 Signal and Execution Context before enforcing immutable consistency", () => {
    const { database } = legacyDatabase();
    insertRuleset(database);
    insertTargetAndRaw(database, "target-a", "source-a");
    insertLegacySignal(database, "signal-a", "source-a");
    insertLegacyContext(database, "context-a", "signal-a");

    database.exec(readFileSync(join(sqliteDirectory, "027_signal_target_binding.sql"), "utf8"));
    expect(database.prepare(
      `SELECT s.target_id signal_target_id,c.target_id context_target_id
       FROM signals s JOIN signal_execution_contexts c ON c.signal_id=s.signal_id`,
    ).get()).toEqual({ signal_target_id: "target-a", context_target_id: "target-a" });
    expect(() => database.prepare("UPDATE raw_events SET target_id='other' WHERE source_event_key='source-a'").run())
      .toThrow("raw event target_id is immutable");
    expect(() => database.prepare("UPDATE signals SET target_id='other' WHERE signal_id='signal-a'").run())
      .toThrow(/immutable/);
    expect(() => database.prepare("UPDATE signal_execution_contexts SET target_id='other' WHERE context_id='context-a'").run())
      .toThrow(/immutable/);
    database.close();
  });

  it("fails closed when a historical Signal capital estimate belongs to another target", () => {
    const { database } = legacyDatabase();
    insertRuleset(database);
    insertTargetAndRaw(database, "target-a", "source-a");
    insertTargetAndRaw(database, "target-b", "source-b");
    insertLegacyCapitalEstimate(database, "capital-b", "target-b", "source-b");
    insertLegacySignal(database, "signal-a", "source-a", "capital-b");

    database.exec("BEGIN IMMEDIATE");
    expect(() => database.exec(readFileSync(join(sqliteDirectory, "027_signal_target_binding.sql"), "utf8")))
      .toThrow(/CHECK constraint failed/);
    database.exec("ROLLBACK");
    expect((database.prepare("PRAGMA table_info(signals)").all() as Array<{ name: string }>)
      .some((column) => column.name === "target_id")).toBe(false);
    database.close();
  });

  it("fails closed when a historical Execution Context changes the Signal capital decision", () => {
    const { database } = legacyDatabase();
    insertRuleset(database);
    insertTargetAndRaw(database, "target-a", "source-a");
    insertLegacyCapitalEstimate(database, "capital-a", "target-a", "source-a");
    insertLegacyCapitalEstimate(database, "capital-account", "target-a", null);
    insertLegacySignal(database, "signal-a", "source-a", "capital-a");
    insertLegacyContext(database, "context-a", "signal-a", "capital-account");

    database.exec("BEGIN IMMEDIATE");
    expect(() => database.exec(readFileSync(join(sqliteDirectory, "027_signal_target_binding.sql"), "utf8")))
      .toThrow(/CHECK constraint failed/);
    database.exec("ROLLBACK");
    database.close();
  });

  it("enforces source-exact capital bindings for new Signals and Execution Contexts", () => {
    const { database } = legacyDatabase();
    insertRuleset(database);
    insertTargetAndRaw(database, "target-a", "source-a");
    insertTargetAndRaw(database, "target-b", "source-b");
    insertLegacySignal(database, "legacy-signal", "source-a");
    insertLegacyContext(database, "legacy-context", "legacy-signal");
    database.exec(readFileSync(join(sqliteDirectory, "027_signal_target_binding.sql"), "utf8"));

    // The target matches, but this estimate describes a different event. A
    // Signal must not silently consume its sizing decision.
    insertLegacyCapitalEstimate(database, "capital-wrong-source", "target-a", "source-b");
    expect(() => insertBoundSignal(
      database,
      "signal-wrong-capital-source",
      "target-a",
      "source-a",
      "capital-wrong-source",
    )).toThrow("signal target_id does not match capital estimate");

    insertLegacyCapitalEstimate(database, "capital-a", "target-a", "source-a");
    insertLegacyCapitalEstimate(database, "capital-account", "target-a", null);
    insertBoundSignal(database, "signal-a", "target-a", "source-a", "capital-a");
    expect(() => insertBoundContext(
      database,
      "context-wrong-capital",
      "target-a",
      "signal-a",
      "capital-account",
    )).toThrow("signal execution context does not match Signal capital decision");
    insertBoundContext(database, "context-a", "target-a", "signal-a", "capital-a");
    database.close();
  });

  it("rejects missing and cross-target Signal identities at the database boundary", () => {
    const { database } = legacyDatabase();
    insertRuleset(database);
    insertTargetAndRaw(database, "target-a", "source-a");
    insertLegacySignal(database, "signal-a", "source-a");
    insertLegacyContext(database, "context-a", "signal-a");
    database.exec(readFileSync(join(sqliteDirectory, "027_signal_target_binding.sql"), "utf8"));
    insertTargetAndRaw(database, "target-b", "source-b");

    const signalColumns = `signal_id,target_id,signal_idempotency_key,source_event_key,signal_type,status,
      asset_id,condition_id,target_price_units,target_size_micros,reason,schema_version,
      signal_version,strategy_version,risk_version,replay_version,ruleset_snapshot_json,
      ruleset_hash,source_code_commit,created_at,execution_eligible,event_classification,
      source_code_dirty,producer_mode`;
    const signalValues = `?,?,?,?,'TARGET_BUY','PUBLISHED','asset','condition','500000000000000000',
      '10000000','TEST','2.22.0','signal-test','strategy-test','risk-test','replay-test','{}',
      'ruleset-target-test','target-binding-test',?,1,'STANDARD_TRADE',0,'OBSERVE_ONLY'`;
    expect(() => database.prepare(`INSERT INTO signals(${signalColumns}) VALUES (${signalValues})`)
      .run("signal-missing", null, "idem-missing", "source-b", "2026-07-17T00:00:00.000Z"))
      .toThrow("signal target_id is required");
    expect(() => database.prepare(`INSERT INTO signals(${signalColumns}) VALUES (${signalValues})`)
      .run("signal-wrong", "target-a", "idem-wrong", "source-b", "2026-07-17T00:00:00.000Z"))
      .toThrow("signal target_id does not match source event");
    database.prepare(`INSERT INTO signals(${signalColumns}) VALUES (${signalValues})`)
      .run("signal-b", "target-b", "idem-b", "source-b", "2026-07-17T00:00:00.000Z");
    const contextSql = `INSERT INTO signal_execution_contexts(
      context_id,target_id,signal_id,capital_decision_id,target_trade_capital_ratio_ppm,
      capital_sizing_ratio_json,capital_sizing_ratio_hash,target_trade_timestamp,
      market_end_time,market_metadata_snapshot_json,market_metadata_hash,ruleset_hash,
      schema_version,signal_version,strategy_version,source_code_commit,source_code_dirty,
      config_version,created_at
    ) VALUES (?,?,?,NULL,NULL,NULL,NULL,?,?, '{}','metadata','ruleset-target-test',
      '2.22.0','signal-test','strategy-test','target-binding-test',0,'config-test',?)`;
    const contextArguments = [
      "signal-b",
      "2026-07-17T00:00:00.000Z",
      "2026-07-18T00:00:00.000Z",
      "2026-07-17T00:00:00.000Z",
    ] as const;
    expect(() => database.prepare(contextSql).run("context-missing", null, ...contextArguments))
      .toThrow("signal execution context target_id is required");
    expect(() => database.prepare(contextSql).run("context-wrong", "target-a", ...contextArguments))
      .toThrow("signal execution context target_id does not match signal");
    database.close();
  });

  it("keeps Paper, Risk, and Live execution code independent from raw_events", () => {
    for (const source of [
      "src/paper/paper-executor.ts",
      "src/risk/risk-manager.ts",
      "src/live/live-signal-consumer.ts",
      "src/live/live-executor.ts",
      "src/execution/signal-integrity.ts",
    ]) {
      expect(readFileSync(join(process.cwd(), source), "utf8"), source).not.toContain("raw_events");
    }
  });
});
