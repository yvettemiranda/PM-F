CREATE TABLE operational_runs (
  operational_run_id TEXT PRIMARY KEY,
  validation_session_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN (
    'OBSERVE_ONLY_OPERATIONAL','PAPER_VALIDATION_OPERATIONAL',
    'HEALTH_MONITOR_ONLY','CONSISTENCY_MONITOR_ONLY','CRASH_RECOVERY_OPERATIONAL'
  )),
  status TEXT NOT NULL CHECK(status IN ('RUNNING','COMPLETED','FAILED','INTERRUPTED')),
  started_at TEXT NOT NULL,
  stopped_at TEXT,
  runtime_duration_ms INTEGER NOT NULL DEFAULT 0,
  source_commit TEXT NOT NULL,
  source_dirty INTEGER NOT NULL,
  schema_version TEXT NOT NULL,
  config_version TEXT NOT NULL,
  ruleset_hash TEXT NOT NULL,
  operational_version TEXT NOT NULL,
  working_database_path TEXT NOT NULL,
  source_database_path TEXT NOT NULL,
  paper_account_id TEXT REFERENCES paper_accounts(paper_account_id),
  target_wallet TEXT,
  final_status TEXT NOT NULL CHECK(final_status IN (
    'OPERATIONAL_FRAMEWORK_READY','OPERATIONAL_RUNNING','OPERATIONAL_PASSED',
    'OPERATIONAL_FAILED','LIVE_NOT_AUTHORIZED'
  )),
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX operational_runs_mode_idx
ON operational_runs(mode, started_at);

CREATE TABLE operational_locks (
  lock_key TEXT PRIMARY KEY,
  operational_run_id TEXT NOT NULL REFERENCES operational_runs(operational_run_id),
  acquired_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL
);

CREATE TABLE operational_heartbeats (
  heartbeat_id TEXT PRIMARY KEY,
  operational_run_id TEXT NOT NULL REFERENCES operational_runs(operational_run_id),
  timestamp TEXT NOT NULL,
  uptime_ms INTEGER NOT NULL,
  memory_rss_bytes INTEGER NOT NULL,
  memory_heap_used_bytes INTEGER NOT NULL,
  event_loop_lag_ms INTEGER NOT NULL,
  restart_count INTEGER NOT NULL,
  error_count INTEGER NOT NULL
);

CREATE INDEX operational_heartbeats_run_idx
ON operational_heartbeats(operational_run_id, timestamp);

CREATE TABLE operational_checkpoints (
  checkpoint_id TEXT PRIMARY KEY,
  operational_run_id TEXT NOT NULL REFERENCES operational_runs(operational_run_id),
  mode TEXT NOT NULL,
  last_processed_timestamp INTEGER,
  last_processed_event_id TEXT,
  observe_checkpoint_id TEXT,
  paper_consumer_checkpoint TEXT,
  portfolio_projection_id TEXT,
  state_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX operational_checkpoints_run_idx
ON operational_checkpoints(operational_run_id, created_at);

CREATE TABLE operational_anomalies (
  anomaly_id TEXT PRIMARY KEY,
  operational_run_id TEXT NOT NULL REFERENCES operational_runs(operational_run_id),
  timestamp TEXT NOT NULL,
  module TEXT NOT NULL,
  severity TEXT NOT NULL CHECK(severity IN ('INFO','WARN','ERROR','CRITICAL')),
  error_code TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  context_json TEXT NOT NULL,
  stack_trace TEXT,
  status TEXT NOT NULL CHECK(status IN ('OPEN','RESOLVED','IGNORED'))
);

CREATE INDEX operational_anomalies_run_idx
ON operational_anomalies(operational_run_id, severity, status, timestamp);

CREATE TABLE operational_health_snapshots (
  health_snapshot_id TEXT PRIMARY KEY,
  operational_run_id TEXT NOT NULL REFERENCES operational_runs(operational_run_id),
  timestamp TEXT NOT NULL,
  uptime_ms INTEGER NOT NULL,
  database_size_bytes INTEGER NOT NULL,
  migration_version TEXT,
  database_integrity_status TEXT NOT NULL,
  api_failure_count INTEGER NOT NULL,
  reconnect_count INTEGER NOT NULL,
  duplicate_event_count INTEGER NOT NULL,
  missed_event_count INTEGER NOT NULL
);

CREATE INDEX operational_health_snapshots_run_idx
ON operational_health_snapshots(operational_run_id, timestamp);

CREATE TABLE operational_consistency_checks (
  consistency_check_id TEXT PRIMARY KEY,
  operational_run_id TEXT NOT NULL REFERENCES operational_runs(operational_run_id),
  check_type TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('PASS','FAIL','WARN','SKIPPED','NOT_RUN')),
  reason TEXT NOT NULL,
  metrics_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX operational_consistency_checks_run_idx
ON operational_consistency_checks(operational_run_id, check_type, created_at);

CREATE TABLE operational_reports (
  operational_report_id TEXT PRIMARY KEY,
  operational_run_id TEXT NOT NULL REFERENCES operational_runs(operational_run_id),
  report_format TEXT NOT NULL CHECK(report_format IN ('JSON','MARKDOWN')),
  report_path TEXT NOT NULL,
  report_hash TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX operational_reports_run_idx
ON operational_reports(operational_run_id, report_format);

CREATE TABLE operational_paper_bindings (
  operational_run_id TEXT PRIMARY KEY REFERENCES operational_runs(operational_run_id),
  paper_account_id TEXT NOT NULL REFERENCES paper_accounts(paper_account_id),
  binding_reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE shadow_risk_observations (
  shadow_risk_observation_id TEXT PRIMARY KEY,
  operational_run_id TEXT NOT NULL REFERENCES operational_runs(operational_run_id),
  signal_id TEXT NOT NULL REFERENCES signals(signal_id),
  result TEXT NOT NULL CHECK(result IN ('ALLOW','REJECT','NOT_EXECUTABLE','OBSERVED_ONLY')),
  reason TEXT NOT NULL,
  checks_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(operational_run_id, signal_id)
);

CREATE INDEX shadow_risk_observations_run_idx
ON shadow_risk_observations(operational_run_id, created_at);
