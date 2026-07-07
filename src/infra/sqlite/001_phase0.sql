PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = FULL;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rulesets (
  ruleset_hash TEXT PRIMARY KEY,
  schema_version TEXT NOT NULL,
  signal_version TEXT NOT NULL,
  strategy_version TEXT NOT NULL,
  risk_version TEXT NOT NULL,
  replay_version TEXT NOT NULL,
  ruleset_snapshot_json TEXT NOT NULL,
  source_code_commit TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS wallet_identity_reports (
  report_id TEXT PRIMARY KEY,
  wallet_address TEXT NOT NULL,
  wallet_type TEXT NOT NULL,
  proxy_wallet TEXT,
  chain TEXT NOT NULL,
  first_seen_time TEXT,
  last_activity_time TEXT,
  trade_count INTEGER NOT NULL,
  trade_count_scope TEXT NOT NULL,
  position_count INTEGER NOT NULL,
  status TEXT NOT NULL,
  confidence TEXT NOT NULL,
  implementation_address TEXT,
  evidence_json TEXT NOT NULL,
  ruleset_hash TEXT NOT NULL REFERENCES rulesets(ruleset_hash),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_captures (
  capture_id TEXT PRIMARY KEY,
  endpoint TEXT NOT NULL,
  request_url TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  latency_ms REAL NOT NULL,
  http_status INTEGER NOT NULL,
  payload_sha256 TEXT NOT NULL,
  response_json TEXT NOT NULL,
  schema_version TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS monitor_targets (
  target_id TEXT PRIMARY KEY,
  wallet_address TEXT NOT NULL UNIQUE,
  identity_status TEXT NOT NULL,
  baseline_at TEXT,
  runtime_mode TEXT NOT NULL DEFAULT 'OBSERVE_ONLY',
  sync_status TEXT NOT NULL DEFAULT 'SYNCED',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS monitor_checkpoints (
  target_id TEXT PRIMARY KEY REFERENCES monitor_targets(target_id),
  last_trade_timestamp INTEGER,
  last_success_at TEXT,
  last_source_event_key TEXT,
  history_complete INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS connection_windows (
  window_id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL REFERENCES monitor_targets(target_id),
  disconnected_at TEXT NOT NULL,
  reconnected_at TEXT,
  status TEXT NOT NULL,
  reason TEXT
);

CREATE TABLE IF NOT EXISTS raw_events (
  source_event_key TEXT PRIMARY KEY,
  target_id TEXT NOT NULL REFERENCES monitor_targets(target_id),
  identity_version TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_transaction_hash TEXT NOT NULL,
  source_timestamp INTEGER NOT NULL,
  asset_id TEXT NOT NULL,
  condition_id TEXT NOT NULL,
  side TEXT NOT NULL,
  price_units TEXT NOT NULL,
  size_micros TEXT NOT NULL,
  gap_event INTEGER NOT NULL DEFAULT 0,
  is_combo INTEGER NOT NULL DEFAULT 0,
  raw_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS raw_events_time_idx ON raw_events(target_id, source_timestamp);
CREATE INDEX IF NOT EXISTS raw_events_tx_idx ON raw_events(source_transaction_hash);

CREATE TABLE IF NOT EXISTS target_position_baselines (
  baseline_id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL REFERENCES monitor_targets(target_id),
  asset_id TEXT NOT NULL,
  size_micros TEXT NOT NULL,
  snapshot_time TEXT NOT NULL,
  UNIQUE(target_id, asset_id, snapshot_time)
);

CREATE TABLE IF NOT EXISTS target_position_ledger (
  ledger_id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL REFERENCES monitor_targets(target_id),
  source_event_key TEXT REFERENCES raw_events(source_event_key),
  asset_id TEXT NOT NULL,
  remote_total_delta_micros TEXT NOT NULL,
  recognized_delta_micros TEXT NOT NULL,
  reason TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  signal_version TEXT NOT NULL,
  strategy_version TEXT NOT NULL,
  risk_version TEXT NOT NULL,
  replay_version TEXT NOT NULL,
  ruleset_snapshot_json TEXT NOT NULL,
  ruleset_hash TEXT NOT NULL REFERENCES rulesets(ruleset_hash),
  source_code_commit TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS target_position_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL REFERENCES monitor_targets(target_id),
  asset_id TEXT NOT NULL,
  expected_remote_micros TEXT NOT NULL,
  recognized_micros TEXT NOT NULL,
  observed_remote_micros TEXT,
  difference_micros TEXT,
  sync_status TEXT NOT NULL,
  snapshot_time TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS capital_snapshots (
  capital_snapshot_id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL REFERENCES monitor_targets(target_id),
  position_value_micros TEXT,
  wallet_balance_micros TEXT,
  total_visible_capital_micros TEXT,
  snapshot_time TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT,
  block_number TEXT
);

CREATE TABLE IF NOT EXISTS signals (
  signal_id TEXT PRIMARY KEY,
  signal_idempotency_key TEXT NOT NULL UNIQUE,
  source_event_key TEXT NOT NULL REFERENCES raw_events(source_event_key),
  signal_type TEXT NOT NULL,
  status TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  condition_id TEXT NOT NULL,
  target_price_units TEXT NOT NULL,
  target_size_micros TEXT NOT NULL,
  sell_ratio_numerator TEXT,
  sell_ratio_denominator TEXT,
  reason TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  signal_version TEXT NOT NULL,
  strategy_version TEXT NOT NULL,
  risk_version TEXT NOT NULL,
  replay_version TEXT NOT NULL,
  ruleset_snapshot_json TEXT NOT NULL,
  ruleset_hash TEXT NOT NULL REFERENCES rulesets(ruleset_hash),
  source_code_commit TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS state_transitions (
  transition_id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT NOT NULL,
  reason TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  signal_version TEXT NOT NULL,
  strategy_version TEXT NOT NULL,
  risk_version TEXT NOT NULL,
  replay_version TEXT NOT NULL,
  ruleset_snapshot_json TEXT NOT NULL,
  ruleset_hash TEXT NOT NULL REFERENCES rulesets(ruleset_hash),
  source_code_commit TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reconciliation_issues (
  issue_id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL REFERENCES monitor_targets(target_id),
  asset_id TEXT,
  issue_type TEXT NOT NULL,
  expected_value TEXT,
  observed_value TEXT,
  sync_status TEXT NOT NULL,
  status TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS replay_runs (
  replay_run_id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL REFERENCES monitor_targets(target_id),
  status TEXT NOT NULL,
  input_rows INTEGER NOT NULL,
  unique_events INTEGER NOT NULL,
  duplicate_rows INTEGER NOT NULL,
  report_hash TEXT NOT NULL,
  metrics_json TEXT NOT NULL,
  incomplete_reasons_json TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  signal_version TEXT NOT NULL,
  strategy_version TEXT NOT NULL,
  risk_version TEXT NOT NULL,
  replay_version TEXT NOT NULL,
  ruleset_snapshot_json TEXT NOT NULL,
  ruleset_hash TEXT NOT NULL REFERENCES rulesets(ruleset_hash),
  source_code_commit TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS latency_metrics (
  metric_id TEXT PRIMARY KEY,
  component TEXT NOT NULL,
  operation TEXT NOT NULL,
  duration_ms REAL NOT NULL,
  local_timestamp TEXT NOT NULL,
  server_timestamp TEXT,
  clock_offset_ms INTEGER,
  success INTEGER NOT NULL,
  detail_json TEXT NOT NULL
);
