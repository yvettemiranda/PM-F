import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { Phase0Database } from "../src/infra/sqlite/database.js";
import type { SourceVersion } from "../src/infra/source-version.js";
import { LiveGateStore } from "../src/live/live-gate-store.js";

const directories: string[] = [];
const sourceVersion: SourceVersion = { commit: "immutability-test", dirty: false };

const protectedTables = [
  "signals",
  "state_transitions",
  "api_captures",
  "api_capture_payloads",
  "negative_risk_conversion_evidence",
  "capture_manifest_items",
  "replay_event_classifications",
  "golden_expectations",
  "golden_results",
  "paper_cash_ledger",
  "paper_reservation_ledger",
  "paper_fill_ledger",
  "paper_fee_ledger",
  "paper_pnl_ledger",
  "paper_state_transitions",
  "live_gate_state_transitions",
  "live_fills",
  "live_cash_ledger",
  "live_reservation_ledger",
  "live_fill_ledger",
  "live_fee_ledger",
  "live_pnl_ledger",
  "live_state_transitions",
  "live_settlement_events",
  "capture_runs",
  "position_baseline_runs",
  "position_baseline_items",
  "capital_estimates",
  "replay_runs",
  "position_bucket_ledger",
  "live_asset_reservation_ledger",
  "live_market_checks",
  "live_valuation_snapshots",
  "live_signal_consumptions",
  "live_signal_quarantines",
  "live_wallet_position_baselines",
  "live_wallet_position_baseline_items",
  "signal_ingest_sequences",
  "rulesets",
  "ruleset_registry",
] as const;

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("append-only production evidence", () => {
  it("installs UPDATE and DELETE guards for every critical evidence table", () => {
    const directory = mkdtempSync(join(tmpdir(), "ni-k-immutable-"));
    directories.push(directory);
    const databasePath = join(directory, "database.sqlite");
    const phase0 = new Phase0Database(databasePath, sourceVersion);
    phase0.initialize();
    phase0.close();
    const database = new DatabaseSync(databasePath);
    const triggerRows = database.prepare(
      "SELECT name FROM sqlite_master WHERE type='trigger'",
    ).all() as unknown as Array<{ name: string }>;
    const triggers = new Set(triggerRows.map((row) => row.name));
    for (const table of protectedTables) {
      expect(triggers.has(`${table}_no_update`), `${table} UPDATE guard`).toBe(true);
      expect(triggers.has(`${table}_no_delete`), `${table} DELETE guard`).toBe(true);
    }

    database.prepare(
      `INSERT INTO api_capture_payloads(
        payload_sha256,compression,payload_blob,uncompressed_bytes,compressed_bytes,created_at
      ) VALUES ('payload-1','GZIP',X'0102',2,2,'2026-07-12T00:00:00.000Z')`,
    ).run();
    expect(() => database.prepare(
      "UPDATE api_capture_payloads SET compressed_bytes=1 WHERE payload_sha256='payload-1'",
    ).run()).toThrow("api_capture_payloads is immutable");
    expect(() => database.prepare(
      "DELETE FROM api_capture_payloads WHERE payload_sha256='payload-1'",
    ).run()).toThrow("api_capture_payloads is immutable");
    database.prepare(
      `INSERT INTO live_gate_state_transitions(
        transition_id,from_execution_mode,to_execution_mode,from_live_gate_state,
        to_live_gate_state,reason,actor,metadata_json,source_code_commit,
        source_code_dirty,config_version,created_at,signal_boundary_sequence
      ) VALUES (
        'gate-transition-1','PAPER','LIVE','LIVE_ARMING','LIVE_ACTIVE','TEST',
        'test','{}','immutability-test',0,'v1.0.0','2026-07-12T00:00:00.000Z',1
      )`,
    ).run();
    expect(() => database.prepare(
      "UPDATE live_gate_state_transitions SET signal_boundary_sequence=999 WHERE transition_id='gate-transition-1'",
    ).run()).toThrow("live_gate_state_transitions is immutable");
    expect(() => database.prepare(
      "DELETE FROM live_gate_state_transitions WHERE transition_id='gate-transition-1'",
    ).run()).toThrow("live_gate_state_transitions is immutable");
    database.exec("PRAGMA foreign_keys=OFF");
    database.prepare(
      `INSERT INTO live_settlement_events(
        settlement_event_id,live_position_id,live_execution_id,event_sequence,
        from_status,to_status,redeem_amount_micros,pnl_micros,resolution_evidence_json,
        redeem_evidence_json,reason,ruleset_hash,source_code_commit,source_code_dirty,
        config_version,idempotency_key,created_at
      ) VALUES (
        'settlement-event-1','position-1',NULL,1,NULL,'PENDING',NULL,NULL,'{}','{}',
        'TEST',(SELECT ruleset_hash FROM ruleset_registry LIMIT 1),'immutability-test',0,
        'v1.0.0','settlement-event-idem-1','2026-07-12T00:00:00.000Z'
      )`,
    ).run();
    database.exec("PRAGMA foreign_keys=ON");
    expect(() => database.prepare(
      "UPDATE live_settlement_events SET to_status='RESOLVED' WHERE settlement_event_id='settlement-event-1'",
    ).run()).toThrow("live_settlement_events is immutable");
    expect(() => database.prepare(
      "DELETE FROM live_settlement_events WHERE settlement_event_id='settlement-event-1'",
    ).run()).toThrow("live_settlement_events is immutable");
    database.close();
  });

  it("does not collapse two distinct audit events that share the same millisecond", () => {
    const directory = mkdtempSync(join(tmpdir(), "ni-k-audit-unique-"));
    directories.push(directory);
    const databasePath = join(directory, "database.sqlite");
    const phase0 = new Phase0Database(databasePath, sourceVersion);
    phase0.initialize();
    phase0.close();
    const database = new DatabaseSync(databasePath);
    const timestamp = "2026-07-12T00:00:00.000Z";
    const store = new LiveGateStore(database, sourceVersion, () => new Date(timestamp));
    const event = {
      entityType: "LIVE_GATE",
      entityId: "default",
      action: "checked",
      reason: "SAME_INPUT",
      metadata: { same: true },
      now: timestamp,
    };
    store.audit(event);
    store.audit(event);
    const count = database.prepare(
      "SELECT count(*) count FROM audit_log WHERE entity_type='LIVE_GATE' AND action='checked'",
    ).get() as { count: number };
    expect(count.count).toBe(2);
    database.close();
  });
});
