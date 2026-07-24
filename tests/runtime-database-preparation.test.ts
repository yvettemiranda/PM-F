import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { ApiCapture } from "../src/adapters/polymarket-public.js";
import { VERSIONS } from "../src/domain/versioning.js";
import { Phase0Database } from "../src/infra/sqlite/database.js";
import { PaperExecutor } from "../src/paper/paper-executor.js";
import { PublicPaperMarketDataProvider } from "../src/paper/public-market-data.js";
import {
  buildCurrentCompatibilityEvidence,
  buildCurrentCoreCompatibilityManifest,
} from "../src/paper-validation/core-compatibility.js";
import { PaperValidationCampaignService } from "../src/paper-validation/service.js";
import type { SourceVersion } from "../src/infra/source-version.js";
import {
  prepareRuntimeDatabase,
  RUNTIME_CURRENT_REQUIRED_TRIGGERS,
  RUNTIME_SCHEMA_MIGRATION_VERSIONS,
} from "../src/infra/sqlite/runtime-database-preparation.js";
import { preparePhase0ValidationDatabase } from "../src/infra/sqlite/phase0-validation-database.js";
import { buildCaptureManifest, captureIdentity } from "../src/services/capture-manifest.js";
import { buildPositionBaseline } from "../src/services/position-baseline.js";

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

function createLegacyDurationCampaign(databasePath: string): { campaignId: string; sessionId: string } {
  const timestamp = "2026-07-20T00:00:00.000Z";
  const walletAddress = "0x00000000000000000000000000000000000000aa";
  const positionsCapture: ApiCapture<[]> = {
    url: "https://example.test/positions",
    fetchedAt: timestamp,
    latencyMs: 1,
    status: 200,
    data: [],
  };
  const phase0 = new Phase0Database(databasePath, sourceVersion);
  const targetId = phase0.ensureTarget(walletAddress, "IDENTITY_CONFIRMED");
  phase0.saveCapture("data-positions", positionsCapture);
  const captureManifest = buildCaptureManifest({
    walletAddress,
    sampleRole: "TARGET",
    purpose: "MIGRATION_031_TEST",
    sourceVersion,
    sources: [{ endpoint: "data-positions", capture: positionsCapture, paginationStatus: "END_OF_DATA" }],
  });
  phase0.saveCaptureManifest(targetId, captureManifest);
  const baseline = buildPositionBaseline({
    captureRunId: captureManifest.captureRunId,
    targetId,
    walletAddress,
    positionCaptureId: captureIdentity(positionsCapture).captureId,
    fetchedAt: timestamp,
    latencyMs: positionsCapture.latencyMs,
    positions: [],
  });
  phase0.savePositionBaseline(baseline);
  phase0.close();

  const executor = new PaperExecutor(databasePath, new PublicPaperMarketDataProvider(), {
    sourceVersion,
    now: () => new Date(timestamp),
  });
  const accountId = executor.createAccount("Migration 031", 1_000_000_000n, targetId);
  executor.close();

  const campaignId = "PC-MIGRATION-031";
  const sessionId = "PS-MIGRATION-031";
  const coreManifest = buildCurrentCoreCompatibilityManifest(process.cwd());
  const compatibilityEvidence = buildCurrentCompatibilityEvidence(process.cwd());
  const service = new PaperValidationCampaignService(databasePath);
  service.createCampaign({
    campaignId,
    targetId,
    baselineRunId: baseline.baselineRunId,
    paperAccountId: accountId,
    requiredActiveRuntimeMs: 72 * 60 * 60 * 1_000,
    requiredContinuousRuntimeMs: 12 * 60 * 60 * 1_000,
    qualifyingRuntimeMs: 2 * 60 * 60 * 1_000,
    coreManifest,
    compatibilityEvidence,
    sourceVersion,
    now: timestamp,
  });
  service.startSession({
    campaignId,
    sessionId,
    coreManifest,
    compatibilityEvidence,
    sourceVersion,
    now: timestamp,
  });
  service.close();
  return { campaignId, sessionId };
}

describe("runtime database preparation", () => {
  it("keeps the current safety-trigger registry synchronized with every migration trigger", () => {
    const sqliteDirectory = join(process.cwd(), "src", "infra", "sqlite");
    const migrationTriggers = [...new Set(readdirSync(sqliteDirectory)
      .filter((name) => /^\d{3}_.+\.sql$/.test(name))
      .flatMap((name) => [...readFileSync(join(sqliteDirectory, name), "utf8").matchAll(/^CREATE TRIGGER\s+(\S+)/gm)]
        .map((match) => match[1]!)))]
      .sort();

    expect([...RUNTIME_CURRENT_REQUIRED_TRIGGERS].sort()).toEqual(migrationTriggers);
  });

  it("forces Phase 0 validation through backup-first preparation", async () => {
    const root = directory();
    const databasePath = join(root, "data", "phase0", "phase0.sqlite");
    const backupDirectory = join(root, "backups");
    createPreviousSchema(databasePath);

    const prepared = await preparePhase0ValidationDatabase({
      databasePath,
      backupDirectory,
      sourceVersion,
    });
    prepared.database.close();

    expect(prepared.preparation.migrated).toBe(true);
    expect(prepared.preparation.backupPath).not.toBeNull();
    const backup = new DatabaseSync(prepared.preparation.backupPath!, { readOnly: true });
    expect(backup.prepare("SELECT 1 ok FROM schema_migrations WHERE version=?")
      .get(VERSIONS.schemaVersion)).toBeUndefined();
    expect(backup.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    backup.close();
    const current = new DatabaseSync(databasePath, { readOnly: true });
    expect(current.prepare("SELECT 1 ok FROM schema_migrations WHERE version=?")
      .get(VERSIONS.schemaVersion)).toBeDefined();
    expect(current.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    expect(current.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    current.close();
  });

  it("initializes a new runtime database without pretending a migration backup exists", async () => {
    const root = directory();
    const databasePath = join(root, "new", "phase0.sqlite");
    const result = await prepareRuntimeDatabase({ databasePath, sourceVersion });
    expect(result).toMatchObject({ migrated: false, backupPath: null, schemaVersion: VERSIONS.schemaVersion });
    const database = new DatabaseSync(databasePath, { readOnly: true });
    expect(database.prepare("SELECT execution_mode,live_gate_state FROM live_gate_state WHERE state_id='default'").get())
      .toEqual({ execution_mode: "PAPER", live_gate_state: "LIVE_DISABLED" });
    const actualVersions = (database.prepare("SELECT version FROM schema_migrations").all() as Array<{ version: string }>)
      .map((row) => row.version)
      .sort();
    expect(actualVersions).toEqual([...RUNTIME_SCHEMA_MIGRATION_VERSIONS].sort());
    database.close();
  });

  it("renames the Observe prerequisite to the actual eight-hour policy without losing evidence", async () => {
    const root = directory();
    const databasePath = join(root, "observe-prerequisite", "phase0.sqlite");
    await prepareRuntimeDatabase({ databasePath, sourceVersion });
    const evidence = JSON.stringify({ evidenceType: "TEST", checkedAt: "2026-07-20T00:00:00.000Z" });
    const legacy = new DatabaseSync(databasePath);
    legacy.prepare(
      `INSERT INTO live_gate_prerequisites(prerequisite_key,status,evidence_json,updated_at)
       VALUES ('OBSERVE_ONLY_24H_SOAK','PASSED',?,?)`,
    ).run(evidence, "2026-07-20T00:00:00.000Z");
    legacy.prepare("DELETE FROM live_gate_prerequisites WHERE prerequisite_key='OBSERVE_ONLY_8H_SOAK'").run();
    legacy.prepare("DELETE FROM schema_migrations WHERE version IN ('2.28.0','2.29.0','2.30.0')").run();
    legacy.close();

    const result = await prepareRuntimeDatabase({
      databasePath,
      backupDirectory: join(root, "backups"),
      sourceVersion,
    });
    expect(result).toMatchObject({ migrated: true, schemaVersion: VERSIONS.schemaVersion });
    const migrated = new DatabaseSync(databasePath, { readOnly: true });
    expect(migrated.prepare(
      "SELECT status,evidence_json,updated_at FROM live_gate_prerequisites WHERE prerequisite_key='OBSERVE_ONLY_8H_SOAK'",
    ).get()).toEqual({
      status: "PASSED",
      evidence_json: evidence,
      updated_at: "2026-07-20T00:00:00.000Z",
    });
    expect(migrated.prepare(
      "SELECT 1 ok FROM live_gate_prerequisites WHERE prerequisite_key='OBSERVE_ONLY_24H_SOAK'",
    ).get()).toBeUndefined();
    migrated.close();
  });

  it("does not record migration 034 when its schema objects are only partially present", async () => {
    const root = directory();
    const databasePath = join(root, "partial-migration-034", "phase0.sqlite");
    await prepareRuntimeDatabase({ databasePath, sourceVersion });
    const partial = new DatabaseSync(databasePath);
    partial.exec("DROP INDEX observe_signal_emissions_source_event_idx");
    partial.prepare("DELETE FROM schema_migrations WHERE version IN ('2.29.0','2.30.0')").run();
    partial.close();

    await expect(prepareRuntimeDatabase({
      databasePath,
      backupDirectory: join(root, "backups"),
      sourceVersion,
    })).rejects.toThrow("MIGRATION_034_PARTIAL_SCHEMA_PRESENT");

    const checked = new DatabaseSync(databasePath, { readOnly: true });
    expect(checked.prepare("SELECT 1 ok FROM schema_migrations WHERE version='2.29.0'").get()).toBeUndefined();
    checked.close();
  });

  it.each([
    {
      label: "index",
      damageSql: "DROP INDEX split_projection_evidence_run_idx",
    },
    {
      label: "immutability trigger",
      damageSql: "DROP TRIGGER split_projection_evidence_no_update",
    },
  ])("does not record migration 035 when its $label is missing", async ({ label, damageSql }) => {
    const root = directory();
    const databasePath = join(root, `partial-migration-035-${label.replaceAll(" ", "-")}`, "phase0.sqlite");
    await prepareRuntimeDatabase({ databasePath, sourceVersion });
    const partial = new DatabaseSync(databasePath);
    partial.exec(damageSql);
    partial.prepare("DELETE FROM schema_migrations WHERE version='2.30.0'").run();
    partial.close();

    await expect(prepareRuntimeDatabase({
      databasePath,
      backupDirectory: join(root, "backups"),
      sourceVersion,
    })).rejects.toThrow("MIGRATION_035_PARTIAL_SCHEMA_PRESENT");

    const checked = new DatabaseSync(databasePath, { readOnly: true });
    expect(checked.prepare("SELECT 1 ok FROM schema_migrations WHERE version='2.30.0'").get()).toBeUndefined();
    checked.close();
  });

  it("records migration 035 when its complete immutable schema already exists", async () => {
    const root = directory();
    const databasePath = join(root, "complete-migration-035", "phase0.sqlite");
    await prepareRuntimeDatabase({ databasePath, sourceVersion });
    const existing = new DatabaseSync(databasePath);
    existing.prepare("DELETE FROM schema_migrations WHERE version='2.30.0'").run();
    existing.close();

    const result = await prepareRuntimeDatabase({
      databasePath,
      backupDirectory: join(root, "backups"),
      sourceVersion,
    });

    expect(result).toMatchObject({ migrated: true, schemaVersion: "2.30.0" });
    const checked = new DatabaseSync(databasePath, { readOnly: true });
    expect(checked.prepare("SELECT count(*) count FROM schema_migrations WHERE version='2.30.0'").get())
      .toEqual({ count: 1 });
    expect(checked.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    checked.close();
  });

  it("preserves legacy Campaign and Session evidence while relaxing duration constraints", async () => {
    const root = directory();
    const databasePath = join(root, "legacy-duration", "phase0.sqlite");
    await prepareRuntimeDatabase({ databasePath, sourceVersion });
    const identity = createLegacyDurationCampaign(databasePath);

    const legacy = new DatabaseSync(databasePath);
    const campaignBefore = legacy.prepare(
      "SELECT * FROM paper_validation_campaigns WHERE campaign_id=?",
    ).get(identity.campaignId);
    const sessionBefore = legacy.prepare(
      "SELECT * FROM paper_validation_sessions WHERE session_id=?",
    ).get(identity.sessionId);
    const downgradeSql = readFileSync(
      new URL("../src/infra/sqlite/031_validation_duration_policy.sql", import.meta.url),
      "utf8",
    )
      .replace("86400000", "259200000")
      .replace("14400000", "43200000")
      .replace("2400000", "7200000");
    legacy.exec("PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE");
    try {
      legacy.exec(`
        DROP TRIGGER negative_risk_conversion_evidence_no_update;
        DROP TRIGGER negative_risk_conversion_evidence_no_delete;
        DROP TABLE negative_risk_conversion_evidence;
      `);
      legacy.exec(downgradeSql);
      legacy.prepare("DELETE FROM schema_migrations WHERE version IN ('2.26.0','2.27.0','2.28.0','2.29.0','2.30.0')").run();
      expect(legacy.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      legacy.exec("COMMIT");
    } catch (error) {
      legacy.exec("ROLLBACK");
      throw error;
    } finally {
      legacy.exec("PRAGMA foreign_keys=ON");
      legacy.close();
    }

    const result = await prepareRuntimeDatabase({
      databasePath,
      backupDirectory: join(root, "backups"),
      sourceVersion,
    });
    expect(result).toMatchObject({ migrated: true, schemaVersion: VERSIONS.schemaVersion });

    const migrated = new DatabaseSync(databasePath, { readOnly: true });
    expect(migrated.prepare(
      "SELECT * FROM paper_validation_campaigns WHERE campaign_id=?",
    ).get(identity.campaignId)).toEqual(campaignBefore);
    expect(migrated.prepare(
      "SELECT * FROM paper_validation_sessions WHERE session_id=?",
    ).get(identity.sessionId)).toEqual(sessionBefore);
    expect(migrated.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    const campaignSql = migrated.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='paper_validation_campaigns'",
    ).get() as { sql: string };
    expect(campaignSql.sql).toContain("CHECK(required_active_runtime_ms >= 86400000)");
    expect(campaignSql.sql).toContain("CHECK(required_continuous_runtime_ms >= 14400000)");
    expect(campaignSql.sql).toContain("CHECK(qualifying_runtime_ms >= 2400000)");
    migrated.close();
  });

  it("rejects a new validation Session whose compatibility identity is NULL", async () => {
    const root = directory();
    const databasePath = join(root, "compatibility-identity.sqlite");
    await prepareRuntimeDatabase({ databasePath, sourceVersion });
    const database = new DatabaseSync(databasePath);
    try {
      expect(() => database.prepare(
        `INSERT INTO paper_validation_sessions(
          session_id,campaign_id,sequence,session_kind,planned_duration_ms,
          core_compatibility_hash,schema_version,ruleset_hash,config_version,
          source_code_commit,source_code_dirty,live_gate_transition_count_at_start,
          started_at,created_at
        )
        SELECT 'PS-MISSING-IDENTITY','PC-MISSING',1,'QUALIFYING',7200000,
               ?,schema_version,ruleset_hash,config_version,?,0,0,?,?
        FROM rulesets LIMIT 1`,
      ).run(
        "a".repeat(64),
        sourceVersion.commit,
        "2026-07-18T00:00:00.000Z",
        "2026-07-18T00:00:00.000Z",
      )).toThrow("paper validation session compatibility identity required");
    } finally {
      database.close();
    }
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

  it("rejects a non-contiguous migration history before applying any missing migration", async () => {
    const root = directory();
    const databasePath = join(root, "non-contiguous.sqlite");
    createPreviousSchema(databasePath);
    const database = new DatabaseSync(databasePath);
    database.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES (?,?)")
      .run(VERSIONS.schemaVersion, "2026-07-16T00:00:00.000Z");
    database.close();

    await expect(prepareRuntimeDatabase({ databasePath, sourceVersion }))
      .rejects.toThrow("RUNTIME_DATABASE_MIGRATION_HISTORY_NON_CONTIGUOUS");

    const unchanged = new DatabaseSync(databasePath, { readOnly: true });
    expect(unchanged.prepare("SELECT 1 ok FROM schema_migrations WHERE version='2.20.0'").get())
      .toBeUndefined();
    expect(unchanged.prepare(
      "SELECT 1 ok FROM sqlite_master WHERE type='table' AND name='paper_validation_campaigns'",
    ).get()).toBeUndefined();
    unchanged.close();
  });

  it("rejects an unknown future migration without opening it as the current schema", async () => {
    const root = directory();
    const databasePath = join(root, "future.sqlite");
    await prepareRuntimeDatabase({ databasePath, sourceVersion });
    const database = new DatabaseSync(databasePath);
    database.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES (?,?)")
      .run("9.9.0", "2026-07-16T00:00:00.000Z");
    database.close();

    await expect(prepareRuntimeDatabase({ databasePath, sourceVersion }))
      .rejects.toThrow("RUNTIME_DATABASE_UNKNOWN_MIGRATION_VERSION:9.9.0");
  });

  it("rejects a current marker set when a required schema object is missing", async () => {
    const root = directory();
    const databasePath = join(root, "missing-current-object.sqlite");
    await prepareRuntimeDatabase({ databasePath, sourceVersion });
    const database = new DatabaseSync(databasePath);
    database.exec("DROP TABLE paper_validation_reports");
    database.close();

    await expect(prepareRuntimeDatabase({ databasePath, sourceVersion }))
      .rejects.toThrow("RUNTIME_DATABASE_SCHEMA_OBJECT_MISSING:table:paper_validation_reports");
  });

  it("rejects a post-Live-Gate prefix with a missing safety table before backup or migration", async () => {
    const root = directory();
    const databasePath = join(root, "missing-prefix-safety.sqlite");
    const backupDirectory = join(root, "backups");
    createPreviousSchema(databasePath);
    const database = new DatabaseSync(databasePath);
    database.exec("DROP TABLE live_gate_state");
    database.close();

    await expect(prepareRuntimeDatabase({ databasePath, backupDirectory, sourceVersion }))
      .rejects.toThrow("RUNTIME_DATABASE_SAFETY_STATE_TABLE_MISSING");

    expect(existsSync(backupDirectory)).toBe(false);
    const unchanged = new DatabaseSync(databasePath, { readOnly: true });
    expect(unchanged.prepare("SELECT 1 ok FROM schema_migrations WHERE version='2.20.0'").get())
      .toBeUndefined();
    expect(unchanged.prepare(
      "SELECT 1 ok FROM sqlite_master WHERE type='table' AND name='paper_validation_campaigns'",
    ).get()).toBeUndefined();
    unchanged.close();
  });

  it("rejects every missing immutable or state-machine trigger in the current schema", async () => {
    const root = directory();
    const intactDatabasePath = join(root, "intact-current.sqlite");
    await prepareRuntimeDatabase({ databasePath: intactDatabasePath, sourceVersion });
    for (const trigger of RUNTIME_CURRENT_REQUIRED_TRIGGERS) {
      const databasePath = join(root, `${trigger}.sqlite`);
      copyFileSync(intactDatabasePath, databasePath);
      const database = new DatabaseSync(databasePath);
      database.exec(`DROP TRIGGER ${trigger}`);
      database.close();

      await expect(prepareRuntimeDatabase({ databasePath, sourceVersion }))
        .rejects.toThrow(`RUNTIME_DATABASE_SCHEMA_OBJECT_MISSING:trigger:${trigger}`);
    }
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

  it("retains only the newest migration backup by default", async () => {
    const root = directory();
    const backupDirectory = join(root, "backups");
    const databasePath = join(root, "phase0.sqlite");
    createPreviousSchema(databasePath);
    mkdirSync(backupDirectory, { recursive: true });
    writeFileSync(join(backupDirectory, "phase0-before-20200101-000000.sqlite"), "stale-1");
    writeFileSync(join(backupDirectory, "phase0-before-20210101-000000.sqlite"), "stale-2");

    const result = await prepareRuntimeDatabase({ databasePath, backupDirectory, sourceVersion });
    const retained = readdirSync(backupDirectory)
      .filter((name) => name.startsWith("phase0-before-") && name.endsWith(".sqlite"));

    expect(result.backupPath).not.toBeNull();
    expect(retained).toEqual([result.backupPath!.split("/").at(-1)]);
  });
});
