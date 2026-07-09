import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { RULESET_HASH, RULESET_SNAPSHOT_JSON, VERSIONS } from "../src/domain/versioning.js";
import { Phase0Database } from "../src/infra/sqlite/database.js";
import type { SourceVersion } from "../src/infra/source-version.js";
import { LiveGateValidation } from "../src/validation/live-gate-validation.js";
import { PaperConsistencyValidation } from "../src/validation/paper-consistency-validation.js";
import { buildValidationReport } from "../src/validation/report-generator.js";
import { ValidationRunner } from "../src/validation/validation-runner.js";

const directories: string[] = [];
const sourceVersion: SourceVersion = { commit: "validation-test", dirty: false };
const now = () => new Date("2026-07-09T00:00:00.000Z");

function setup(prefix = "ni-k-validation-") {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  const databasePath = join(directory, "phase0.sqlite");
  const phase0 = new Phase0Database(databasePath, sourceVersion);
  phase0.initialize();
  phase0.close();
  return { directory, databasePath };
}

function count(databasePath: string, table: string): number {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  const row = database.prepare(`SELECT count(*) count FROM ${table}`).get() as { count: number };
  database.close();
  return row.count;
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Final validation framework", () => {
  it("runs all validators on a snapshot and leaves the source database business data unchanged", async () => {
    const env = setup();
    const outputDirectory = join(env.directory, "validation");
    const result = await new ValidationRunner(sourceVersion, now).run({
      sourceDatabasePath: env.databasePath,
      outputDirectory,
      validationType: "ALL",
      useSnapshot: true,
    });
    expect(result.report.finalResult.liveAllowed).toBe(false);
    expect(result.report.finalResult.finalReadinessStatus).toBe("VALIDATION_FRAMEWORK_READY");
    expect(existsSync(result.jsonReportPath)).toBe(true);
    expect(existsSync(result.markdownReportPath)).toBe(true);
    expect(result.workingDatabasePath).not.toBe(env.databasePath);
    expect(count(env.databasePath, "validation_sessions")).toBe(0);
    expect(count(result.workingDatabasePath, "validation_sessions")).toBe(1);
    const sourceState = new DatabaseSync(env.databasePath, { readOnly: true });
    const state = sourceState.prepare("SELECT execution_mode,live_gate_state FROM live_gate_state WHERE state_id='default'")
      .get() as { execution_mode: string; live_gate_state: string };
    sourceState.close();
    expect(state).toEqual({ execution_mode: "PAPER", live_gate_state: "LIVE_DISABLED" });
  });

  it("detects paper ledger mismatches as blocking consistency failures", async () => {
    const env = setup();
    const database = new DatabaseSync(env.databasePath);
    database.prepare(
      `INSERT INTO paper_accounts(
        paper_account_id,name,status,initial_balance_micros,cash_balance_micros,
        reserved_balance_micros,realized_pnl_micros,signal_cutoff_at,schema_version,
        strategy_version,risk_version,paper_version,ruleset_snapshot_json,ruleset_hash,
        source_code_commit,source_code_dirty,created_at,updated_at
      ) VALUES ('bad-paper','Bad','ACTIVE','1000','1000','0','0',?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    ).run(
      now().toISOString(),
      VERSIONS.schemaVersion,
      VERSIONS.strategyVersion,
      VERSIONS.riskVersion,
      VERSIONS.paperVersion,
      RULESET_SNAPSHOT_JSON,
      RULESET_HASH,
      sourceVersion.commit,
      now().toISOString(),
      now().toISOString(),
    );
    database.close();
    const checks = await new PaperConsistencyValidation().run({ databasePath: env.databasePath, sourceVersion, now });
    expect(checks.some((item) => item.checkName === "paper_ledger_consistency" && item.status === "FAIL" && item.blocking)).toBe(true);
  });

  it("validates Live Gate fake path and restores validation database to PAPER + LIVE_DISABLED", async () => {
    const env = setup();
    const checks = await new LiveGateValidation().run({ databasePath: env.databasePath, sourceVersion, now });
    expect(checks.every((item) => item.status === "PASS")).toBe(true);
    const database = new DatabaseSync(env.databasePath, { readOnly: true });
    const state = database.prepare("SELECT execution_mode,live_gate_state FROM live_gate_state WHERE state_id='default'")
      .get() as { execution_mode: string; live_gate_state: string };
    expect(state).toEqual({ execution_mode: "PAPER", live_gate_state: "LIVE_DISABLED" });
    expect((database.prepare("SELECT count(*) count FROM live_orders").get() as { count: number }).count).toBe(0);
    database.close();
  });

  it("builds stable report hashes and never marks Live as allowed", () => {
    const base = {
      sessionId: "validation-stable",
      validationType: "ALL" as const,
      startedAt: now().toISOString(),
      finishedAt: now().toISOString(),
      sourceVersion,
      inputSnapshotHash: "input",
      dbSnapshotHash: "db",
      checks: [{
        checkType: "PAPER_CONSISTENCY" as const,
        checkName: "paper_ledger_consistency",
        status: "PASS" as const,
        blocking: true,
        reason: "OK",
        startedAt: now().toISOString(),
        finishedAt: now().toISOString(),
      }],
    };
    const first = buildValidationReport(base);
    const second = buildValidationReport(base);
    expect(first.system.reportHash).toBe(second.system.reportHash);
    expect(first.finalResult.liveAllowed).toBe(false);
  });
});
