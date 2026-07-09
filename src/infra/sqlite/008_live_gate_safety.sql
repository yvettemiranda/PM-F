CREATE TABLE live_gate_state (
  state_id TEXT PRIMARY KEY CHECK(state_id='default'),
  execution_mode TEXT NOT NULL CHECK(execution_mode IN ('PAPER','LIVE')),
  live_gate_state TEXT NOT NULL CHECK(live_gate_state IN ('LIVE_DISABLED','LIVE_ARMING','LIVE_ACTIVE')),
  requested_execution_mode TEXT CHECK(requested_execution_mode IN ('LIVE')),
  last_preflight_id TEXT,
  state_reason TEXT NOT NULL,
  source_code_commit TEXT NOT NULL,
  source_code_dirty INTEGER NOT NULL,
  config_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE live_gate_state_transitions (
  transition_id TEXT PRIMARY KEY,
  from_execution_mode TEXT,
  to_execution_mode TEXT NOT NULL,
  from_live_gate_state TEXT,
  to_live_gate_state TEXT NOT NULL,
  reason TEXT NOT NULL,
  actor TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  source_code_commit TEXT NOT NULL,
  source_code_dirty INTEGER NOT NULL,
  config_version TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE live_wallets (
  live_wallet_id TEXT PRIMARY KEY,
  wallet_address TEXT NOT NULL UNIQUE,
  wallet_type TEXT NOT NULL,
  network TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('REGISTERED','ACTIVE','DISABLED')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE live_gate_runs (
  live_gate_run_id TEXT PRIMARY KEY,
  run_type TEXT NOT NULL CHECK(run_type IN ('PREFLIGHT','EXECUTION_CHECK','STARTUP_RECOVERY')),
  allowed INTEGER NOT NULL,
  blocked_reasons_json TEXT NOT NULL,
  checks_json TEXT NOT NULL,
  requested_execution_mode TEXT,
  execution_mode TEXT,
  live_gate_state TEXT,
  risk_decision_id TEXT REFERENCES risk_decisions(risk_decision_id),
  signal_id TEXT REFERENCES signals(signal_id),
  ruleset_hash TEXT REFERENCES rulesets(ruleset_hash),
  source_code_commit TEXT NOT NULL,
  source_code_dirty INTEGER NOT NULL,
  config_version TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX live_gate_runs_type_idx ON live_gate_runs(run_type, created_at);
CREATE INDEX live_gate_runs_signal_idx ON live_gate_runs(signal_id, risk_decision_id, created_at);

CREATE TABLE risk_snapshots (
  risk_snapshot_id TEXT PRIMARY KEY,
  mode TEXT NOT NULL,
  wallet_address TEXT,
  balance_micros TEXT,
  exposure_micros TEXT NOT NULL,
  daily_loss_micros TEXT NOT NULL,
  risk_status TEXT NOT NULL CHECK(risk_status IN ('SAFE','BLOCKED','UNKNOWN')),
  checks_json TEXT NOT NULL,
  live_gate_run_id TEXT NOT NULL REFERENCES live_gate_runs(live_gate_run_id),
  source_code_commit TEXT NOT NULL,
  source_code_dirty INTEGER NOT NULL,
  config_version TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX risk_snapshots_run_idx ON risk_snapshots(live_gate_run_id, created_at);

CREATE TABLE live_gate_prerequisites (
  prerequisite_key TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK(status IN ('PENDING','PASSED','FAILED')),
  evidence_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO live_gate_prerequisites(prerequisite_key,status,evidence_json,updated_at) VALUES
  ('PHASE_1B_PAPER_VALIDATION','PENDING','{}',datetime('now')),
  ('OBSERVE_ONLY_24H_SOAK','PENDING','{}',datetime('now')),
  ('PAPER_STABILITY','PENDING','{}',datetime('now')),
  ('CRASH_RECOVERY_LONG_RUN','PENDING','{}',datetime('now')),
  ('LONG_STATE_CONSISTENCY','PENDING','{}',datetime('now')),
  ('SOURCE_COMMIT_RECORDED','PENDING','{}',datetime('now')),
  ('WORKTREE_STATUS_KNOWN','PENDING','{}',datetime('now')),
  ('GEOBLOCK_COMPLIANCE','PENDING','{}',datetime('now')),
  ('USER_EXPLICIT_AUTHORIZATION','PENDING','{}',datetime('now'));
