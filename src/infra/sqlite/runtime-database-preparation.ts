import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { VERSIONS } from "../../domain/versioning.js";
import type { SourceVersion } from "../source-version.js";
import { Phase0Database } from "./database.js";
import { assertPaperRuntimeSchemaContract } from "./paper-runtime-schema-contract.js";

export interface RuntimeDatabasePreparationResult {
  databasePath: string;
  migrated: boolean;
  backupPath: string | null;
  schemaVersion: string;
}

export const RUNTIME_SCHEMA_MIGRATION_VERSIONS = [
  "1.2.0",
  "1.3.0",
  "1.4.0",
  "1.5.0",
  "2.0.0",
  "2.1.0",
  "2.2.0",
  "2.3.0",
  "2.4.0",
  "2.5.0",
  "2.6.0",
  "2.7.0",
  "2.8.0",
  "2.9.0",
  "2.10.0",
  "2.11.0",
  "2.12.0",
  "2.13.0",
  "2.14.0",
  "2.15.0",
  "2.16.0",
  "2.17.0",
  "2.18.0",
  "2.19.0",
  "2.20.0",
  "2.21.0",
  "2.22.0",
  "2.23.0",
  "2.24.0",
  "2.25.0",
  "2.26.0",
  "2.27.0",
  "2.28.0",
  "2.29.0",
] as const;

export const RUNTIME_CURRENT_REQUIRED_TRIGGERS = [
  "api_capture_payloads_no_delete",
  "api_capture_payloads_no_update",
  "api_captures_no_delete",
  "api_captures_no_update",
  "audit_log_no_delete",
  "audit_log_no_update",
  "capital_estimates_no_delete",
  "capital_estimates_no_update",
  "capital_estimates_sizing_pair_insert",
  "capture_manifest_items_no_delete",
  "capture_manifest_items_no_update",
  "capture_runs_no_delete",
  "capture_runs_no_update",
  "golden_expectations_no_delete",
  "golden_expectations_no_update",
  "golden_results_no_delete",
  "golden_results_no_update",
  "live_account_state_transitions_no_delete",
  "live_account_state_transitions_no_update",
  "live_accounts_authorized_signer_no_update",
  "live_asset_reservation_ledger_no_delete",
  "live_asset_reservation_ledger_no_update",
  "live_cash_ledger_no_delete",
  "live_cash_ledger_no_update",
  "live_fee_ledger_no_delete",
  "live_fee_ledger_no_update",
  "live_fill_ledger_no_delete",
  "live_fill_ledger_no_update",
  "live_fills_no_delete",
  "live_fills_no_update",
  "live_gate_state_transitions_no_delete",
  "live_gate_state_transitions_no_update",
  "live_market_checks_no_delete",
  "live_market_checks_no_update",
  "live_orders_buy_budget_complete_no_update",
  "live_orders_immutable_intent_no_update",
  "live_pnl_ledger_no_delete",
  "live_pnl_ledger_no_update",
  "live_reservation_ledger_no_delete",
  "live_reservation_ledger_no_update",
  "live_settlement_events_no_delete",
  "live_settlement_events_no_update",
  "live_signal_consumptions_no_delete",
  "live_signal_consumptions_no_update",
  "live_signal_quarantines_no_delete",
  "live_signal_quarantines_no_update",
  "live_state_transitions_no_delete",
  "live_state_transitions_no_update",
  "live_valuation_snapshots_no_delete",
  "live_valuation_snapshots_no_update",
  "observe_checkpoints_projection_snapshot_required",
  "observe_checkpoints_no_delete",
  "observe_checkpoints_no_update",
  "observe_projection_snapshots_no_delete",
  "observe_projection_snapshots_no_update",
  "negative_risk_conversion_evidence_no_delete",
  "negative_risk_conversion_evidence_no_update",
  "observe_runs_campaign_binding_consistency",
  "observe_runs_campaign_binding_immutable",
  "observe_runs_campaign_binding_pair",
  "paper_accounts_target_id_immutable",
  "paper_cash_ledger_no_delete",
  "paper_cash_ledger_no_update",
  "paper_fee_ledger_no_delete",
  "paper_fee_ledger_no_update",
  "paper_fee_snapshots_no_delete",
  "paper_fee_snapshots_no_update",
  "paper_fill_ledger_no_delete",
  "paper_fill_ledger_no_update",
  "paper_market_constraint_evidence_no_delete",
  "paper_market_constraint_evidence_no_update",
  "paper_orderbook_snapshots_no_delete",
  "paper_orderbook_snapshots_no_update",
  "paper_pnl_ledger_no_delete",
  "paper_pnl_ledger_no_update",
  "paper_reservation_ledger_no_delete",
  "paper_reservation_ledger_no_update",
  "paper_state_transitions_no_delete",
  "paper_state_transitions_no_update",
  "paper_validation_campaign_transition_insert_guard",
  "paper_validation_campaigns_no_delete",
  "paper_validation_campaigns_no_update",
  "paper_validation_checkpoints_no_delete",
  "paper_validation_checkpoints_no_update",
  "paper_validation_evidence_adjudications_no_delete",
  "paper_validation_evidence_adjudications_no_update",
  "paper_validation_reports_no_delete",
  "paper_validation_reports_no_update",
  "paper_validation_session_transition_insert_guard",
  "paper_validation_sessions_compatibility_identity_required",
  "paper_validation_sessions_no_delete",
  "paper_validation_sessions_no_update",
  "paper_validation_transitions_no_delete",
  "paper_validation_transitions_no_update",
  "position_baseline_items_no_delete",
  "position_baseline_items_no_update",
  "position_baseline_runs_no_delete",
  "position_baseline_runs_no_update",
  "position_bucket_ledger_no_delete",
  "position_bucket_ledger_no_update",
  "replay_event_classifications_no_delete",
  "replay_event_classifications_no_update",
  "replay_runs_no_delete",
  "replay_runs_no_update",
  "raw_events_target_id_immutable",
  "risk_decisions_account_insert_guard",
  "risk_decisions_no_delete",
  "risk_decisions_no_update",
  "risk_decisions_sizing_pair_insert",
  "ruleset_registry_no_delete",
  "ruleset_registry_no_update",
  "rulesets_no_delete",
  "rulesets_no_update",
  "signal_execution_contexts_no_delete",
  "signal_execution_contexts_no_update",
  "signal_execution_contexts_sizing_pair_insert",
  "signal_execution_contexts_target_capital_consistency",
  "signal_execution_contexts_target_id_immutable",
  "signal_execution_contexts_target_id_required",
  "signal_execution_contexts_target_signal_consistency",
  "signal_ingest_sequences_no_delete",
  "signal_ingest_sequences_no_update",
  "signals_assign_ingest_sequence",
  "signals_no_delete",
  "signals_no_update",
  "signals_target_capital_consistency",
  "signals_target_id_immutable",
  "signals_target_id_required",
  "signals_target_source_consistency",
  "state_transitions_no_delete",
  "state_transitions_no_update",
] as const;

type SchemaExpectation = "VALID_PREFIX" | "CURRENT";

interface MigrationHistoryState {
  current: boolean;
  liveGateSchemaExpected: boolean;
}

function migrationVersions(database: DatabaseSync): string[] {
  const table = database.prepare(
    "SELECT 1 ok FROM sqlite_master WHERE type='table' AND name='schema_migrations'",
  ).get();
  if (!table) return [];
  return (database.prepare("SELECT version FROM schema_migrations").all() as Array<{ version: string }>)
    .map((row) => row.version);
}

function assertMigrationHistory(database: DatabaseSync, expectation: SchemaExpectation): MigrationHistoryState {
  const expectedCurrent = RUNTIME_SCHEMA_MIGRATION_VERSIONS.at(-1);
  if (expectedCurrent !== VERSIONS.schemaVersion) {
    throw new Error(`RUNTIME_MIGRATION_REGISTRY_VERSION_MISMATCH:${expectedCurrent}:${VERSIONS.schemaVersion}`);
  }
  const actual = migrationVersions(database);
  const known = new Set<string>(RUNTIME_SCHEMA_MIGRATION_VERSIONS);
  const unknown = actual.filter((version) => !known.has(version));
  if (unknown.length > 0) {
    throw new Error(`RUNTIME_DATABASE_UNKNOWN_MIGRATION_VERSION:${unknown.sort().join(",")}`);
  }
  const expectedPrefix = RUNTIME_SCHEMA_MIGRATION_VERSIONS.slice(0, actual.length);
  const actualSet = new Set(actual);
  if (actualSet.size !== actual.length || expectedPrefix.some((version) => !actualSet.has(version))) {
    throw new Error(`RUNTIME_DATABASE_MIGRATION_HISTORY_NON_CONTIGUOUS:${actual.sort().join(",")}`);
  }
  const current = actual.length === RUNTIME_SCHEMA_MIGRATION_VERSIONS.length;
  if (expectation === "CURRENT" && !current) {
    throw new Error(`RUNTIME_DATABASE_SCHEMA_NOT_CURRENT:${actual.length}:${RUNTIME_SCHEMA_MIGRATION_VERSIONS.length}`);
  }
  return {
    current,
    liveGateSchemaExpected: actualSet.has("2.3.0"),
  };
}

function assertCurrentSchemaObjects(database: DatabaseSync): void {
  assertPaperRuntimeSchemaContract(database, new Set(migrationVersions(database)));
  const requiredTables = [
    "negative_risk_conversion_evidence",
    "observe_projection_snapshots",
    "paper_market_constraint_evidence",
    "paper_settlement_retry_state",
    "paper_validation_evidence_adjudications",
    "paper_validation_campaigns",
    "paper_validation_sessions",
    "paper_validation_checkpoints",
    "paper_validation_transitions",
    "paper_validation_reports",
  ];
  for (const table of requiredTables) {
    const row = database.prepare(
      "SELECT 1 ok FROM sqlite_master WHERE type='table' AND name=?",
    ).get(table);
    if (!row) throw new Error(`RUNTIME_DATABASE_SCHEMA_OBJECT_MISSING:table:${table}`);
  }
  const requiredColumns: Record<string, string[]> = {
    capital_estimates: ["capital_sizing_ratio_json", "capital_sizing_ratio_hash"],
    observe_checkpoints: ["projection_snapshot_hash"],
    observe_runs: ["campaign_id", "campaign_session_id"],
    signals: ["target_id"],
    signal_execution_contexts: [
      "target_id",
      "capital_sizing_ratio_json",
      "capital_sizing_ratio_hash",
      "market_end_time_status",
      "execution_deadline_at",
    ],
    observe_polls: ["signal_enrichment_failures", "warning_detail"],
    risk_decisions: ["capital_sizing_decision_json", "capital_sizing_decision_hash"],
    paper_orderbook_snapshots: [
      "min_order_size",
      "min_order_size_micros",
      "tick_size",
      "tick_size_units",
      "source_capture_id",
    ],
    paper_fee_snapshots: ["source_capture_id"],
    paper_validation_sessions: [
      "validation_policy_hash",
      "verification_suite_hash",
      "operator_build_hash",
      "artifact_provenance_hash",
    ],
  };
  for (const [table, columns] of Object.entries(requiredColumns)) {
    const actual = new Set(
      (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name),
    );
    for (const column of columns) {
      if (!actual.has(column)) throw new Error(`RUNTIME_DATABASE_SCHEMA_OBJECT_MISSING:column:${table}.${column}`);
    }
  }
  for (const trigger of RUNTIME_CURRENT_REQUIRED_TRIGGERS) {
    const row = database.prepare(
      "SELECT 1 ok FROM sqlite_master WHERE type='trigger' AND name=?",
    ).get(trigger);
    if (!row) throw new Error(`RUNTIME_DATABASE_SCHEMA_OBJECT_MISSING:trigger:${trigger}`);
  }
  for (const index of [
    "observe_signal_emissions_source_event_idx",
    "paper_validation_campaign_transition_sequence_idx",
    "paper_validation_session_transition_sequence_idx",
    "replay_event_classifications_event_idx",
  ]) {
    const row = database.prepare(
      "SELECT 1 ok FROM sqlite_master WHERE type='index' AND name=?",
    ).get(index);
    if (!row) throw new Error(`RUNTIME_DATABASE_SCHEMA_OBJECT_MISSING:index:${index}`);
  }
}

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function safetyState(database: DatabaseSync, allowMissing = false): void {
  const table = database.prepare(
    "SELECT 1 ok FROM sqlite_master WHERE type='table' AND name='live_gate_state'",
  ).get();
  if (!table) {
    if (allowMissing) return;
    throw new Error("RUNTIME_DATABASE_SAFETY_STATE_TABLE_MISSING");
  }
  const row = database.prepare(
    "SELECT execution_mode,live_gate_state FROM live_gate_state WHERE state_id='default'",
  ).get() as { execution_mode: string; live_gate_state: string } | undefined;
  if (!row || row.execution_mode !== "PAPER" || row.live_gate_state !== "LIVE_DISABLED") {
    throw new Error(`RUNTIME_DATABASE_UNSAFE_MODE:${row?.execution_mode ?? "MISSING"}:${row?.live_gate_state ?? "MISSING"}`);
  }
}

function verifyDatabase(
  path: string,
  schemaExpectation: SchemaExpectation = "CURRENT",
): void {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    database.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    const integrity = database.prepare("PRAGMA integrity_check").all() as Array<{ integrity_check: string }>;
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") {
      throw new Error("RUNTIME_DATABASE_INTEGRITY_CHECK_FAILED");
    }
    const foreignKeys = database.prepare("PRAGMA foreign_key_check").all();
    if (foreignKeys.length > 0) throw new Error("RUNTIME_DATABASE_FOREIGN_KEY_CHECK_FAILED");
    const history = assertMigrationHistory(database, schemaExpectation);
    safetyState(database, !history.liveGateSchemaExpected);
    if (history.current) assertCurrentSchemaObjects(database);
  } finally {
    database.close();
  }
}

function pruneBackups(
  directory: string,
  retain: number,
  databasePrefix: string,
  currentBackupName: string,
): void {
  const backups = readdirSync(directory)
    .filter((name) => name.startsWith(databasePrefix) && name.endsWith(".sqlite"))
    .sort((left, right) => {
      if (left === currentBackupName) return -1;
      if (right === currentBackupName) return 1;
      const modifiedDifference = statSync(join(directory, right)).mtimeMs
        - statSync(join(directory, left)).mtimeMs;
      return modifiedDifference !== 0 ? modifiedDifference : right.localeCompare(left);
    });
  for (const stale of backups.slice(retain)) rmSync(join(directory, stale), { force: true });
}

/** Backup-first initialization used by operator-facing Observe/Paper CLIs. */
export async function prepareRuntimeDatabase(input: {
  databasePath: string;
  sourceVersion: SourceVersion;
  backupDirectory?: string;
  retainBackups?: number;
}): Promise<RuntimeDatabasePreparationResult> {
  const retainBackups = input.retainBackups ?? 1;
  if (!Number.isSafeInteger(retainBackups) || retainBackups < 1) {
    throw new Error(`INVALID_RUNTIME_BACKUP_RETENTION:${retainBackups}`);
  }
  const databasePath = resolve(input.databasePath);
  mkdirSync(dirname(databasePath), { recursive: true });
  const existed = existsSync(databasePath);
  let migrationRequired = existed;
  if (existed) {
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      database.exec("PRAGMA busy_timeout=5000;");
      const history = assertMigrationHistory(database, "VALID_PREFIX");
      safetyState(database, !history.liveGateSchemaExpected);
      migrationRequired = !history.current;
      if (!migrationRequired) {
        safetyState(database);
        assertCurrentSchemaObjects(database);
      }
    } finally {
      database.close();
    }
  }

  let backupPath: string | null = null;
  if (existed && migrationRequired) {
    const backupDirectory = resolve(
      input.backupDirectory ?? join(dirname(dirname(databasePath)), "operator", "backups"),
    );
    mkdirSync(backupDirectory, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    backupPath = join(backupDirectory, `${basename(databasePath, ".sqlite")}-before-${VERSIONS.schemaVersion}-${timestamp}.sqlite`);
    const source = new DatabaseSync(databasePath, { readOnly: true });
    source.exec("PRAGMA busy_timeout=5000;");
    try {
      await backup(source, backupPath);
    } finally {
      source.close();
    }
    verifyDatabase(backupPath, "VALID_PREFIX");
    await sha256(backupPath); // force a complete readable-file pass before migration
    pruneBackups(
      backupDirectory,
      retainBackups,
      `${basename(databasePath, ".sqlite")}-before-`,
      basename(backupPath),
    );
  }

  const migrations = new Phase0Database(databasePath, input.sourceVersion);
  try {
    migrations.initialize();
  } finally {
    migrations.close();
  }
  verifyDatabase(databasePath);
  return {
    databasePath,
    migrated: migrationRequired,
    backupPath,
    schemaVersion: VERSIONS.schemaVersion,
  };
}
