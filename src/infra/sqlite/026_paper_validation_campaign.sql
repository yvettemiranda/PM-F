-- Paper long-running validation evidence is append-only. Current state and
-- accumulated runtime are projections over transitions and finalized reports.

CREATE TABLE paper_validation_campaigns (
  campaign_id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL REFERENCES monitor_targets(target_id),
  baseline_run_id TEXT NOT NULL REFERENCES position_baseline_runs(baseline_run_id),
  paper_account_id TEXT NOT NULL UNIQUE REFERENCES paper_accounts(paper_account_id),
  initial_balance_micros TEXT NOT NULL,
  required_active_runtime_ms INTEGER NOT NULL CHECK(required_active_runtime_ms >= 259200000),
  required_continuous_runtime_ms INTEGER NOT NULL CHECK(required_continuous_runtime_ms >= 43200000),
  qualifying_runtime_ms INTEGER NOT NULL CHECK(qualifying_runtime_ms >= 7200000),
  checkpoint_interval_ms INTEGER NOT NULL CHECK(checkpoint_interval_ms = 60000),
  max_checkpoint_gap_ms INTEGER NOT NULL CHECK(max_checkpoint_gap_ms = 90000),
  core_compatibility_hash TEXT NOT NULL,
  core_manifest_json TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  signal_version TEXT NOT NULL,
  strategy_version TEXT NOT NULL,
  risk_version TEXT NOT NULL,
  paper_version TEXT NOT NULL,
  ruleset_hash TEXT NOT NULL REFERENCES rulesets(ruleset_hash),
  config_version TEXT NOT NULL,
  source_code_commit TEXT NOT NULL,
  source_code_dirty INTEGER NOT NULL CHECK(source_code_dirty IN (0, 1)),
  execution_mode TEXT NOT NULL CHECK(execution_mode = 'PAPER'),
  live_gate_state TEXT NOT NULL CHECK(live_gate_state = 'LIVE_DISABLED'),
  created_at TEXT NOT NULL
);

CREATE INDEX paper_validation_campaigns_target_idx
ON paper_validation_campaigns(target_id, created_at);

CREATE TABLE paper_validation_sessions (
  session_id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES paper_validation_campaigns(campaign_id),
  sequence INTEGER NOT NULL CHECK(sequence > 0),
  session_kind TEXT NOT NULL CHECK(session_kind IN ('QUALIFYING', 'LONG_RUNNING')),
  planned_duration_ms INTEGER NOT NULL CHECK(planned_duration_ms > 0),
  core_compatibility_hash TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  ruleset_hash TEXT NOT NULL REFERENCES rulesets(ruleset_hash),
  config_version TEXT NOT NULL,
  source_code_commit TEXT NOT NULL,
  source_code_dirty INTEGER NOT NULL CHECK(source_code_dirty IN (0, 1)),
  live_gate_transition_count_at_start INTEGER NOT NULL CHECK(live_gate_transition_count_at_start >= 0),
  started_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(campaign_id, sequence),
  UNIQUE(campaign_id, session_id)
);

CREATE INDEX paper_validation_sessions_campaign_idx
ON paper_validation_sessions(campaign_id, sequence);

CREATE TABLE paper_validation_checkpoints (
  checkpoint_id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES paper_validation_campaigns(campaign_id),
  session_id TEXT NOT NULL REFERENCES paper_validation_sessions(session_id),
  sequence INTEGER NOT NULL CHECK(sequence > 0),
  checkpoint_kind TEXT NOT NULL CHECK(checkpoint_kind IN (
    'START', 'HEARTBEAT', 'SAFE_STOP', 'CRASH_RECOVERY'
  )),
  observed_at TEXT NOT NULL,
  elapsed_runtime_ms INTEGER NOT NULL CHECK(elapsed_runtime_ms >= 0),
  observe_active INTEGER NOT NULL CHECK(observe_active IN (0, 1)),
  paper_active INTEGER NOT NULL CHECK(paper_active IN (0, 1)),
  consistency_safe INTEGER NOT NULL CHECK(consistency_safe IN (0, 1)),
  execution_mode TEXT NOT NULL CHECK(execution_mode = 'PAPER'),
  live_gate_state TEXT NOT NULL CHECK(live_gate_state = 'LIVE_DISABLED'),
  live_gate_transition_count INTEGER NOT NULL CHECK(live_gate_transition_count >= 0),
  observe_checkpoint_id TEXT,
  paper_consumer_created_at TEXT,
  paper_consumer_signal_id TEXT,
  position_projection_hash TEXT,
  portfolio_projection_hash TEXT,
  replay_state TEXT,
  capital_snapshot_id TEXT,
  last_processed_event_id TEXT,
  evidence_json TEXT NOT NULL,
  checkpoint_hash TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  UNIQUE(session_id, sequence),
  FOREIGN KEY(campaign_id, session_id)
    REFERENCES paper_validation_sessions(campaign_id, session_id)
);

CREATE INDEX paper_validation_checkpoints_session_idx
ON paper_validation_checkpoints(session_id, sequence);

CREATE TABLE paper_validation_transitions (
  transition_id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL CHECK(entity_type IN ('CAMPAIGN', 'SESSION')),
  campaign_id TEXT REFERENCES paper_validation_campaigns(campaign_id),
  session_id TEXT REFERENCES paper_validation_sessions(session_id),
  from_state TEXT,
  to_state TEXT NOT NULL,
  reason TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK(sequence > 0),
  evidence_json TEXT NOT NULL,
  evidence_hash TEXT NOT NULL,
  core_compatibility_hash TEXT NOT NULL,
  source_code_commit TEXT NOT NULL,
  source_code_dirty INTEGER NOT NULL CHECK(source_code_dirty IN (0, 1)),
  config_version TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  CHECK(
    (entity_type = 'CAMPAIGN' AND campaign_id IS NOT NULL AND session_id IS NULL)
    OR
    (entity_type = 'SESSION' AND campaign_id IS NOT NULL AND session_id IS NOT NULL)
  ),
  UNIQUE(entity_type, campaign_id, session_id, sequence),
  FOREIGN KEY(campaign_id, session_id)
    REFERENCES paper_validation_sessions(campaign_id, session_id)
);

CREATE INDEX paper_validation_transitions_campaign_idx
ON paper_validation_transitions(campaign_id, entity_type, sequence);

CREATE INDEX paper_validation_transitions_session_idx
ON paper_validation_transitions(session_id, sequence);

CREATE UNIQUE INDEX paper_validation_campaign_transition_sequence_idx
ON paper_validation_transitions(campaign_id, sequence)
WHERE entity_type = 'CAMPAIGN';

CREATE UNIQUE INDEX paper_validation_session_transition_sequence_idx
ON paper_validation_transitions(session_id, sequence)
WHERE entity_type = 'SESSION';

CREATE TABLE paper_validation_reports (
  report_id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES paper_validation_campaigns(campaign_id),
  session_id TEXT REFERENCES paper_validation_sessions(session_id),
  report_scope TEXT NOT NULL CHECK(report_scope IN ('SESSION', 'CAMPAIGN')),
  status TEXT NOT NULL,
  effective_active_runtime_ms INTEGER NOT NULL CHECK(effective_active_runtime_ms >= 0),
  longest_continuous_runtime_ms INTEGER NOT NULL CHECK(longest_continuous_runtime_ms >= 0),
  counts_toward_campaign INTEGER NOT NULL CHECK(counts_toward_campaign IN (0, 1)),
  coverage_status TEXT NOT NULL CHECK(coverage_status IN ('COMPLETE', 'INCOMPLETE')),
  report_json TEXT NOT NULL,
  report_hash TEXT NOT NULL,
  core_compatibility_hash TEXT NOT NULL,
  source_code_commit TEXT NOT NULL,
  source_code_dirty INTEGER NOT NULL CHECK(source_code_dirty IN (0, 1)),
  config_version TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  CHECK(
    (report_scope = 'SESSION' AND session_id IS NOT NULL)
    OR
    (report_scope = 'CAMPAIGN' AND session_id IS NULL)
  ),
  FOREIGN KEY(campaign_id, session_id)
    REFERENCES paper_validation_sessions(campaign_id, session_id)
);

CREATE INDEX paper_validation_reports_campaign_idx
ON paper_validation_reports(campaign_id, report_scope, created_at);

CREATE INDEX paper_validation_reports_session_idx
ON paper_validation_reports(session_id, report_scope);

CREATE TRIGGER paper_validation_campaign_transition_insert_guard
BEFORE INSERT ON paper_validation_transitions
WHEN NEW.entity_type = 'CAMPAIGN'
BEGIN
  SELECT RAISE(ABORT, 'paper validation campaign transition sequence mismatch')
  WHERE NEW.sequence <> (
    SELECT coalesce(max(sequence), 0) + 1
    FROM paper_validation_transitions
    WHERE entity_type = 'CAMPAIGN' AND campaign_id = NEW.campaign_id
  );

  SELECT RAISE(ABORT, 'paper validation campaign transition from_state mismatch')
  WHERE NEW.from_state IS NOT (
    SELECT to_state
    FROM paper_validation_transitions
    WHERE entity_type = 'CAMPAIGN' AND campaign_id = NEW.campaign_id
    ORDER BY sequence DESC
    LIMIT 1
  );

  SELECT RAISE(ABORT, 'paper validation campaign transition is illegal')
  WHERE NOT (
    (NEW.from_state IS NULL AND NEW.to_state = 'QUALIFYING')
    OR (NEW.from_state = 'QUALIFYING' AND NEW.to_state IN ('RUNNING', 'BLOCKED', 'FROZEN'))
    OR (NEW.from_state = 'RUNNING' AND NEW.to_state IN (
      'PAUSED', 'INCOMPLETE_COVERAGE', 'PASSED', 'BLOCKED', 'FROZEN'
    ))
    OR (NEW.from_state = 'PAUSED' AND NEW.to_state IN ('RUNNING', 'BLOCKED', 'FROZEN'))
    OR (NEW.from_state = 'INCOMPLETE_COVERAGE' AND NEW.to_state IN ('RUNNING', 'BLOCKED', 'FROZEN'))
  );
END;

CREATE TRIGGER paper_validation_session_transition_insert_guard
BEFORE INSERT ON paper_validation_transitions
WHEN NEW.entity_type = 'SESSION'
BEGIN
  SELECT RAISE(ABORT, 'paper validation session transition sequence mismatch')
  WHERE NEW.sequence <> (
    SELECT coalesce(max(sequence), 0) + 1
    FROM paper_validation_transitions
    WHERE entity_type = 'SESSION' AND session_id = NEW.session_id
  );

  SELECT RAISE(ABORT, 'paper validation session transition from_state mismatch')
  WHERE NEW.from_state IS NOT (
    SELECT to_state
    FROM paper_validation_transitions
    WHERE entity_type = 'SESSION' AND session_id = NEW.session_id
    ORDER BY sequence DESC
    LIMIT 1
  );

  SELECT RAISE(ABORT, 'paper validation session transition is illegal')
  WHERE NOT (
    (NEW.from_state IS NULL AND NEW.to_state = 'RUNNING')
    OR (NEW.from_state = 'RUNNING' AND NEW.to_state IN (
      'COMPLETED', 'FAILED', 'CRASH_RECOVERED', 'BLOCKED'
    ))
  );
END;

CREATE TRIGGER paper_validation_campaigns_no_update
BEFORE UPDATE ON paper_validation_campaigns
BEGIN
  SELECT RAISE(ABORT, 'paper_validation_campaigns is immutable');
END;

CREATE TRIGGER paper_validation_campaigns_no_delete
BEFORE DELETE ON paper_validation_campaigns
BEGIN
  SELECT RAISE(ABORT, 'paper_validation_campaigns is immutable');
END;

CREATE TRIGGER paper_validation_sessions_no_update
BEFORE UPDATE ON paper_validation_sessions
BEGIN
  SELECT RAISE(ABORT, 'paper_validation_sessions is immutable');
END;

CREATE TRIGGER paper_validation_sessions_no_delete
BEFORE DELETE ON paper_validation_sessions
BEGIN
  SELECT RAISE(ABORT, 'paper_validation_sessions is immutable');
END;

CREATE TRIGGER paper_validation_checkpoints_no_update
BEFORE UPDATE ON paper_validation_checkpoints
BEGIN
  SELECT RAISE(ABORT, 'paper_validation_checkpoints is immutable');
END;

CREATE TRIGGER paper_validation_checkpoints_no_delete
BEFORE DELETE ON paper_validation_checkpoints
BEGIN
  SELECT RAISE(ABORT, 'paper_validation_checkpoints is immutable');
END;

CREATE TRIGGER paper_validation_transitions_no_update
BEFORE UPDATE ON paper_validation_transitions
BEGIN
  SELECT RAISE(ABORT, 'paper_validation_transitions is immutable');
END;

CREATE TRIGGER paper_validation_transitions_no_delete
BEFORE DELETE ON paper_validation_transitions
BEGIN
  SELECT RAISE(ABORT, 'paper_validation_transitions is immutable');
END;

CREATE TRIGGER paper_validation_reports_no_update
BEFORE UPDATE ON paper_validation_reports
BEGIN
  SELECT RAISE(ABORT, 'paper_validation_reports is immutable');
END;

CREATE TRIGGER paper_validation_reports_no_delete
BEFORE DELETE ON paper_validation_reports
BEGIN
  SELECT RAISE(ABORT, 'paper_validation_reports is immutable');
END;
