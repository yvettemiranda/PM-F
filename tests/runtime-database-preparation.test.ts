import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { VERSIONS } from "../src/domain/versioning.js";
import type { SourceVersion } from "../src/infra/source-version.js";
import { prepareRuntimeDatabase } from "../src/infra/sqlite/runtime-database-preparation.js";

const directories: string[] = [];
const sourceVersion: SourceVersion = { commit: "runtime-preparation-test", dirty: false };

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), "ni-k-runtime-preparation-"));
  directories.push(path);
  return path;
}

function createPreviousSchema(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const database = new DatabaseSync(path);
  const migrations: Array<[string, string]> = [
    ["1.2.0", "001_phase0.sql"],
    ["1.3.0", "002_phase05.sql"],
    ["1.4.0", "003_replay_event_classifications.sql"],
    ["1.5.0", "004_observe_only.sql"],
    ["2.0.0", "005_paper_executor.sql"],
    ["2.1.0", "006_phase1a_architecture.sql"],
    ["2.2.0", "007_ruleset_portfolio_projection.sql"],
    ["2.3.0", "008_live_gate_safety.sql"],
    ["2.4.0", "009_live_executor.sql"],
    ["2.5.0", "010_validation_framework.sql"],
    ["2.6.0", "011_operational_validation.sql"],
    ["2.7.0", "012_capture_payload_storage.sql"],
    ["2.8.0", "013_live_account_risk_isolation.sql"],
    ["2.9.0", "014_observe_activity_confirmation.sql"],
    ["2.10.0", "015_append_only_evidence.sql"],
    ["2.11.0", "016_live_asset_reservations.sql"],
    ["2.12.0", "017_live_market_execution_safety.sql"],
    ["2.13.0", "018_live_signal_cursor_safety.sql"],
    ["2.14.0", "019_live_buy_budget_completeness.sql"],
    ["2.15.0", "020_live_authorized_signer.sql"],
    ["2.16.0", "021_live_order_intent_evidence.sql"],
    ["2.17.0", "022_live_gate_transition_immutability.sql"],
    ["2.18.0", "023_live_settlement_events.sql"],
    ["2.19.0", "024_paper_market_data_health.sql"],
  ];
  try {
    for (const [version, file] of migrations) {
      const sql = readFileSync(new URL(`../src/infra/sqlite/${file}`, import.meta.url), "utf8");
      database.exec(sql);
      database.prepare("INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES (?,?)")
        .run(version, "2026-07-13T00:00:00.000Z");
    }
    database.prepare(
      `INSERT INTO live_gate_state(
        state_id,execution_mode,live_gate_state,requested_execution_mode,last_preflight_id,
        state_reason,source_code_commit,source_code_dirty,config_version,created_at,updated_at
      ) VALUES ('default','PAPER','LIVE_DISABLED',NULL,NULL,'TEST_BASELINE',?,0,'v1.0.0',?,?)`,
    ).run(sourceVersion.commit, "2026-07-13T00:00:00.000Z", "2026-07-13T00:00:00.000Z");
  } finally {
    database.close();
  }
}

describe("runtime database preparation", () => {
  it("initializes a new runtime database without pretending a migration backup exists", async () => {
    const root = directory();
    const databasePath = join(root, "new", "phase0.sqlite");
    const result = await prepareRuntimeDatabase({ databasePath, sourceVersion });
    expect(result).toMatchObject({ migrated: false, backupPath: null, schemaVersion: VERSIONS.schemaVersion });
    const database = new DatabaseSync(databasePath, { readOnly: true });
    expect(database.prepare("SELECT execution_mode,live_gate_state FROM live_gate_state WHERE state_id='default'").get())
      .toEqual({ execution_mode: "PAPER", live_gate_state: "LIVE_DISABLED" });
    database.close();
  });

  it("creates an Online Backup before migrating the prior schema and verifies safety", async () => {
    const root = directory();
    const databasePath = join(root, "data", "phase0", "phase0.sqlite");
    const backupDirectory = join(root, "backups");
    createPreviousSchema(databasePath);

    const result = await prepareRuntimeDatabase({ databasePath, backupDirectory, sourceVersion });

    expect(result).toMatchObject({ migrated: true, schemaVersion: VERSIONS.schemaVersion });
    expect(result.backupPath).not.toBeNull();
    expect(existsSync(result.backupPath!)).toBe(true);
    const migrated = new DatabaseSync(databasePath, { readOnly: true });
    expect(migrated.prepare("SELECT 1 ok FROM schema_migrations WHERE version=?")
      .get(VERSIONS.schemaVersion)).toBeDefined();
    expect(migrated.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    expect(migrated.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    migrated.close();
    const backup = new DatabaseSync(result.backupPath!, { readOnly: true });
    expect(backup.prepare("SELECT 1 ok FROM schema_migrations WHERE version=?")
      .get(VERSIONS.schemaVersion)).toBeUndefined();
    expect(backup.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    backup.close();
  });

  it("refuses to touch a database outside PAPER plus LIVE_DISABLED", async () => {
    const root = directory();
    const databasePath = join(root, "unsafe.sqlite");
    createPreviousSchema(databasePath);
    const database = new DatabaseSync(databasePath);
    database.prepare(
      `UPDATE live_gate_state
       SET execution_mode='LIVE',live_gate_state='LIVE_ACTIVE',requested_execution_mode='LIVE'
       WHERE state_id='default'`,
    ).run();
    database.close();

    await expect(prepareRuntimeDatabase({ databasePath, sourceVersion }))
      .rejects.toThrow("RUNTIME_DATABASE_UNSAFE_MODE:LIVE:LIVE_ACTIVE");
  });

  it("rejects a current-schema database whose Live Gate safety table is missing", async () => {
    const root = directory();
    const databasePath = join(root, "missing-safety.sqlite");
    await prepareRuntimeDatabase({ databasePath, sourceVersion });
    const database = new DatabaseSync(databasePath);
    database.exec("DROP TABLE live_gate_state");
    database.close();

    await expect(prepareRuntimeDatabase({ databasePath, sourceVersion }))
      .rejects.toThrow("RUNTIME_DATABASE_SAFETY_STATE_TABLE_MISSING");
  });

  it("isolates retention by database prefix and rejects unsafe retention counts", async () => {
    const root = directory();
    const backupDirectory = join(root, "backups");
    const firstPath = join(root, "first.sqlite");
    const secondPath = join(root, "second.sqlite");
    createPreviousSchema(firstPath);
    createPreviousSchema(secondPath);

    const first = await prepareRuntimeDatabase({
      databasePath: firstPath,
      backupDirectory,
      retainBackups: 1,
      sourceVersion,
    });
    const second = await prepareRuntimeDatabase({
      databasePath: secondPath,
      backupDirectory,
      retainBackups: 1,
      sourceVersion,
    });

    expect(existsSync(first.backupPath!)).toBe(true);
    expect(existsSync(second.backupPath!)).toBe(true);
    await expect(prepareRuntimeDatabase({
      databasePath: firstPath,
      backupDirectory,
      retainBackups: 0,
      sourceVersion,
    })).rejects.toThrow("INVALID_RUNTIME_BACKUP_RETENTION:0");
  });
});
