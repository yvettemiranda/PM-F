import type { DatabaseSync } from "node:sqlite";

/**
 * Schema surface that changes Observe/Paper/Checkpoint/Recovery semantics.
 * The global migration dispatcher may grow for Live or report-only features
 * without changing this contract or resetting accumulated Paper runtime.
 */
export const PAPER_RUNTIME_MIGRATION_VERSIONS = [
  "1.2.0",
  "1.3.0",
  "1.4.0",
  "1.5.0",
  "2.0.0",
  "2.1.0",
  "2.2.0",
  "2.3.0",
  "2.7.0",
  "2.9.0",
  "2.10.0",
  "2.19.0",
  "2.20.0",
  "2.21.0",
  "2.22.0",
  "2.23.0",
  "2.24.0",
] as const;

export const PAPER_RUNTIME_REQUIRED_TABLES = [
  "observe_projection_snapshots",
  "paper_market_constraint_evidence",
  "paper_validation_campaigns",
  "paper_validation_sessions",
  "paper_validation_checkpoints",
  "paper_validation_transitions",
  "paper_validation_reports",
] as const;

export const PAPER_RUNTIME_REQUIRED_COLUMNS = Object.freeze({
  capital_estimates: ["capital_sizing_ratio_json", "capital_sizing_ratio_hash"],
  observe_checkpoints: ["projection_snapshot_hash"],
  observe_runs: ["campaign_id", "campaign_session_id"],
  signals: ["target_id"],
  signal_execution_contexts: ["target_id", "capital_sizing_ratio_json", "capital_sizing_ratio_hash"],
  risk_decisions: ["capital_sizing_decision_json", "capital_sizing_decision_hash"],
  paper_orderbook_snapshots: [
    "min_order_size",
    "min_order_size_micros",
    "tick_size",
    "tick_size_units",
    "source_capture_id",
  ],
  paper_fee_snapshots: ["source_capture_id"],
} satisfies Record<string, readonly string[]>);

export const PAPER_RUNTIME_REQUIRED_TRIGGERS = [
  "audit_log_no_delete",
  "audit_log_no_update",
  "observe_checkpoints_projection_snapshot_required",
  "observe_checkpoints_no_delete",
  "observe_checkpoints_no_update",
  "observe_projection_snapshots_no_delete",
  "observe_projection_snapshots_no_update",
  "observe_runs_campaign_binding_consistency",
  "observe_runs_campaign_binding_immutable",
  "observe_runs_campaign_binding_pair",
  "paper_accounts_target_id_immutable",
  "paper_cash_ledger_no_delete",
  "paper_cash_ledger_no_update",
  "paper_fee_ledger_no_delete",
  "paper_fee_ledger_no_update",
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
  "paper_validation_reports_no_delete",
  "paper_validation_reports_no_update",
  "paper_validation_session_transition_insert_guard",
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
  "raw_events_target_id_immutable",
  "risk_decisions_account_insert_guard",
  "risk_decisions_no_delete",
  "risk_decisions_no_update",
  "signal_execution_contexts_no_delete",
  "signal_execution_contexts_no_update",
  "signal_execution_contexts_target_id_immutable",
  "signal_execution_contexts_target_id_required",
  "signal_execution_contexts_target_signal_consistency",
  "signals_no_delete",
  "signals_no_update",
  "signals_target_id_immutable",
  "signals_target_id_required",
  "signals_target_source_consistency",
  "state_transitions_no_delete",
  "state_transitions_no_update",
] as const;

export const PAPER_RUNTIME_REQUIRED_INDEXES = [
  "paper_validation_campaign_transition_sequence_idx",
  "paper_validation_session_transition_sequence_idx",
] as const;

export function assertPaperRuntimeSchemaContract(
  database: DatabaseSync,
  appliedMigrationVersions: ReadonlySet<string>,
): void {
  for (const version of PAPER_RUNTIME_MIGRATION_VERSIONS) {
    if (!appliedMigrationVersions.has(version)) {
      throw new Error(`PAPER_RUNTIME_MIGRATION_MISSING:${version}`);
    }
  }
  for (const table of PAPER_RUNTIME_REQUIRED_TABLES) {
    if (!database.prepare(
      "SELECT 1 ok FROM sqlite_master WHERE type='table' AND name=?",
    ).get(table)) throw new Error(`RUNTIME_DATABASE_SCHEMA_OBJECT_MISSING:table:${table}`);
  }
  for (const [table, columns] of Object.entries(PAPER_RUNTIME_REQUIRED_COLUMNS)) {
    const actual = new Set(
      (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name),
    );
    for (const column of columns) {
      if (!actual.has(column)) throw new Error(`RUNTIME_DATABASE_SCHEMA_OBJECT_MISSING:column:${table}.${column}`);
    }
  }
  for (const trigger of PAPER_RUNTIME_REQUIRED_TRIGGERS) {
    if (!database.prepare(
      "SELECT 1 ok FROM sqlite_master WHERE type='trigger' AND name=?",
    ).get(trigger)) throw new Error(`RUNTIME_DATABASE_SCHEMA_OBJECT_MISSING:trigger:${trigger}`);
  }
  for (const index of PAPER_RUNTIME_REQUIRED_INDEXES) {
    if (!database.prepare(
      "SELECT 1 ok FROM sqlite_master WHERE type='index' AND name=?",
    ).get(index)) throw new Error(`RUNTIME_DATABASE_SCHEMA_OBJECT_MISSING:index:${index}`);
  }
}
