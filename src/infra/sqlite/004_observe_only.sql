ALTER TABLE signals ADD COLUMN producer_mode TEXT NOT NULL DEFAULT 'REPLAY';
ALTER TABLE signals ADD COLUMN baseline_run_id TEXT;
ALTER TABLE signals ADD COLUMN observe_run_id TEXT;

ALTER TABLE monitor_checkpoints ADD COLUMN checkpoint_id TEXT;
ALTER TABLE monitor_checkpoints ADD COLUMN baseline_run_id TEXT;
ALTER TABLE monitor_checkpoints ADD COLUMN observe_run_id TEXT;
ALTER TABLE monitor_checkpoints ADD COLUMN replay_state TEXT;
ALTER TABLE monitor_checkpoints ADD COLUMN position_projection_hash TEXT;
ALTER TABLE monitor_checkpoints ADD COLUMN capital_snapshot_id TEXT;

CREATE TABLE observe_runs (
  observe_run_id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL REFERENCES monitor_targets(target_id),
  baseline_run_id TEXT NOT NULL REFERENCES position_baseline_runs(baseline_run_id),
  state TEXT NOT NULL CHECK(state IN ('RUNNING', 'COMPLETED', 'FAILED', 'INTERRUPTED')),
  recovered_from_checkpoint INTEGER NOT NULL,
  poll_interval_ms INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  last_heartbeat_at TEXT NOT NULL,
  stopped_at TEXT,
  stop_reason TEXT,
  successful_polls INTEGER NOT NULL DEFAULT 0,
  failed_polls INTEGER NOT NULL DEFAULT 0,
  processed_events INTEGER NOT NULL DEFAULT 0,
  emitted_signals INTEGER NOT NULL DEFAULT 0,
  duplicate_events INTEGER NOT NULL DEFAULT 0,
  gap_events INTEGER NOT NULL DEFAULT 0,
  reconciliation_count INTEGER NOT NULL DEFAULT 0,
  schema_version TEXT NOT NULL,
  signal_version TEXT NOT NULL,
  strategy_version TEXT NOT NULL,
  risk_version TEXT NOT NULL,
  ruleset_hash TEXT NOT NULL REFERENCES rulesets(ruleset_hash),
  source_code_commit TEXT NOT NULL,
  source_code_dirty INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX observe_runs_target_idx ON observe_runs(target_id, started_at);

CREATE TABLE observe_polls (
  poll_id TEXT PRIMARY KEY,
  observe_run_id TEXT NOT NULL REFERENCES observe_runs(observe_run_id),
  sequence INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('SUCCESS', 'API_FAILED', 'PROCESSING_FAILED')),
  started_at TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  trades_received INTEGER NOT NULL DEFAULT 0,
  activity_received INTEGER NOT NULL DEFAULT 0,
  positions_received INTEGER NOT NULL DEFAULT 0,
  new_events INTEGER NOT NULL DEFAULT 0,
  duplicate_events INTEGER NOT NULL DEFAULT 0,
  signals_emitted INTEGER NOT NULL DEFAULT 0,
  gap_events INTEGER NOT NULL DEFAULT 0,
  reconciliation_count INTEGER NOT NULL DEFAULT 0,
  checkpoint_id TEXT,
  error_detail TEXT,
  UNIQUE(observe_run_id, sequence)
);

CREATE TABLE observe_events (
  observe_event_id TEXT PRIMARY KEY,
  baseline_run_id TEXT NOT NULL REFERENCES position_baseline_runs(baseline_run_id),
  source_event_key TEXT NOT NULL REFERENCES raw_events(source_event_key),
  source_type TEXT NOT NULL,
  source_timestamp INTEGER NOT NULL,
  is_gap INTEGER NOT NULL,
  first_observe_run_id TEXT NOT NULL REFERENCES observe_runs(observe_run_id),
  first_poll_id TEXT NOT NULL REFERENCES observe_polls(poll_id),
  first_observed_at TEXT NOT NULL,
  UNIQUE(baseline_run_id, source_event_key)
);

CREATE INDEX observe_events_order_idx ON observe_events(baseline_run_id, source_timestamp, source_event_key);

CREATE TABLE observe_poll_captures (
  poll_id TEXT NOT NULL REFERENCES observe_polls(poll_id),
  endpoint TEXT NOT NULL,
  capture_id TEXT NOT NULL REFERENCES api_captures(capture_id),
  PRIMARY KEY(poll_id, endpoint)
);

CREATE TABLE observe_signal_emissions (
  emission_id TEXT PRIMARY KEY,
  baseline_run_id TEXT NOT NULL REFERENCES position_baseline_runs(baseline_run_id),
  observe_run_id TEXT NOT NULL REFERENCES observe_runs(observe_run_id),
  poll_id TEXT NOT NULL REFERENCES observe_polls(poll_id),
  source_event_key TEXT NOT NULL REFERENCES raw_events(source_event_key),
  signal_id TEXT NOT NULL REFERENCES signals(signal_id),
  execution_eligible INTEGER NOT NULL,
  event_classification TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(baseline_run_id, source_event_key)
);

CREATE TABLE observe_checkpoints (
  checkpoint_id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL REFERENCES monitor_targets(target_id),
  baseline_run_id TEXT NOT NULL REFERENCES position_baseline_runs(baseline_run_id),
  observe_run_id TEXT NOT NULL REFERENCES observe_runs(observe_run_id),
  poll_id TEXT NOT NULL REFERENCES observe_polls(poll_id),
  last_processed_timestamp INTEGER,
  last_processed_event_id TEXT,
  replay_state TEXT NOT NULL,
  position_projection_json TEXT NOT NULL,
  position_projection_hash TEXT NOT NULL,
  capital_snapshot_id TEXT NOT NULL REFERENCES capital_estimates(capital_estimate_id),
  created_at TEXT NOT NULL
);

CREATE INDEX observe_checkpoints_target_idx ON observe_checkpoints(target_id, created_at);

CREATE TABLE observe_position_projection (
  baseline_run_id TEXT NOT NULL REFERENCES position_baseline_runs(baseline_run_id),
  asset_id TEXT NOT NULL,
  historical_micros TEXT NOT NULL,
  tracked_micros TEXT NOT NULL,
  expected_total_micros TEXT NOT NULL,
  last_source_event_key TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(baseline_run_id, asset_id)
);

CREATE TABLE reconciliation_reports (
  reconciliation_report_id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL REFERENCES monitor_targets(target_id),
  baseline_run_id TEXT NOT NULL REFERENCES position_baseline_runs(baseline_run_id),
  observe_run_id TEXT NOT NULL REFERENCES observe_runs(observe_run_id),
  poll_id TEXT NOT NULL REFERENCES observe_polls(poll_id),
  sync_status TEXT NOT NULL CHECK(sync_status IN ('SYNCED', 'MINOR_DIFF', 'MAJOR_DESYNC')),
  issue_count INTEGER NOT NULL,
  expected_projection_hash TEXT NOT NULL,
  observed_positions_hash TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX reconciliation_reports_run_idx ON reconciliation_reports(observe_run_id, created_at);
