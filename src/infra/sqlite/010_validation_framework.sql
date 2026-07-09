CREATE TABLE validation_sessions (
  validation_session_id TEXT PRIMARY KEY,
  validation_type TEXT NOT NULL CHECK(validation_type IN (
    'ALL','PAPER_REPLAY','PAPER_CONSISTENCY','CRASH_RECOVERY',
    'RECONCILIATION','LIVE_GATE','OBSERVE_ONLY'
  )),
  status TEXT NOT NULL CHECK(status IN ('RUNNING','PASSED','FAILED')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  source_database_path TEXT NOT NULL,
  working_database_path TEXT NOT NULL,
  source_commit TEXT NOT NULL,
  source_dirty INTEGER NOT NULL,
  schema_version TEXT NOT NULL,
  config_version TEXT NOT NULL,
  ruleset_hash TEXT NOT NULL,
  validation_version TEXT NOT NULL,
  input_snapshot_hash TEXT NOT NULL,
  db_snapshot_hash TEXT NOT NULL,
  report_hash TEXT,
  final_readiness_status TEXT NOT NULL CHECK(final_readiness_status IN (
    'VALIDATION_RUNNING','VALIDATION_FRAMEWORK_READY','VALIDATION_FAILED',
    'VALIDATION_SKIPPED','LIVE_NOT_AUTHORIZED'
  )),
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX validation_sessions_type_idx
ON validation_sessions(validation_type, started_at);

CREATE TABLE validation_checks (
  validation_check_id TEXT PRIMARY KEY,
  validation_session_id TEXT NOT NULL REFERENCES validation_sessions(validation_session_id),
  check_type TEXT NOT NULL,
  check_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('PASS','FAIL','WARN','SKIPPED','NOT_RUN')),
  blocking INTEGER NOT NULL CHECK(blocking IN (0,1)),
  reason TEXT NOT NULL,
  metrics_json TEXT NOT NULL,
  error_json TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX validation_checks_session_idx
ON validation_checks(validation_session_id, check_type, status);

CREATE TABLE validation_artifacts (
  artifact_id TEXT PRIMARY KEY,
  validation_session_id TEXT NOT NULL REFERENCES validation_sessions(validation_session_id),
  artifact_type TEXT NOT NULL,
  artifact_path TEXT NOT NULL,
  artifact_sha256 TEXT NOT NULL,
  content_type TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX validation_artifacts_session_idx
ON validation_artifacts(validation_session_id, artifact_type);

CREATE TABLE validation_reports (
  report_id TEXT PRIMARY KEY,
  validation_session_id TEXT NOT NULL REFERENCES validation_sessions(validation_session_id),
  report_format TEXT NOT NULL CHECK(report_format IN ('JSON','MARKDOWN')),
  report_path TEXT NOT NULL,
  report_sha256 TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX validation_reports_session_idx
ON validation_reports(validation_session_id, report_format);
