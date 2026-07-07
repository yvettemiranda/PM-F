ALTER TABLE rulesets ADD COLUMN source_code_dirty INTEGER NOT NULL DEFAULT 1;
ALTER TABLE raw_events ADD COLUMN capture_run_id TEXT;
ALTER TABLE raw_events ADD COLUMN event_classification TEXT NOT NULL DEFAULT 'STANDARD_TRADE';
ALTER TABLE signals ADD COLUMN execution_eligible INTEGER NOT NULL DEFAULT 1;
ALTER TABLE signals ADD COLUMN execution_block_reason TEXT;
ALTER TABLE signals ADD COLUMN event_classification TEXT NOT NULL DEFAULT 'STANDARD_TRADE';
ALTER TABLE signals ADD COLUMN capital_estimate_id TEXT;
ALTER TABLE signals ADD COLUMN capture_run_id TEXT;
ALTER TABLE signals ADD COLUMN source_code_dirty INTEGER NOT NULL DEFAULT 1;
ALTER TABLE state_transitions ADD COLUMN source_code_dirty INTEGER NOT NULL DEFAULT 1;
ALTER TABLE replay_runs ADD COLUMN capture_run_id TEXT;
ALTER TABLE replay_runs ADD COLUMN golden_evaluation_status TEXT NOT NULL DEFAULT 'NOT_EVALUATED';
ALTER TABLE replay_runs ADD COLUMN source_code_dirty INTEGER NOT NULL DEFAULT 1;

CREATE TABLE capture_runs (
  capture_run_id TEXT PRIMARY KEY,
  target_id TEXT REFERENCES monitor_targets(target_id),
  wallet_address TEXT NOT NULL,
  sample_role TEXT NOT NULL CHECK(sample_role IN ('TARGET', 'FIXTURE')),
  purpose TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('CAPTURING', 'COMPLETE', 'FAILED')),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  manifest_hash TEXT,
  item_count INTEGER NOT NULL DEFAULT 0,
  schema_version TEXT NOT NULL,
  signal_version TEXT NOT NULL,
  strategy_version TEXT NOT NULL,
  risk_version TEXT NOT NULL,
  replay_version TEXT NOT NULL,
  ruleset_snapshot_json TEXT NOT NULL,
  ruleset_hash TEXT NOT NULL REFERENCES rulesets(ruleset_hash),
  source_code_commit TEXT NOT NULL,
  source_code_dirty INTEGER NOT NULL,
  error_detail TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE capture_manifest_items (
  manifest_item_id TEXT PRIMARY KEY,
  capture_run_id TEXT NOT NULL REFERENCES capture_runs(capture_run_id),
  capture_id TEXT NOT NULL REFERENCES api_captures(capture_id),
  source_endpoint TEXT NOT NULL,
  request_url TEXT NOT NULL,
  page_index INTEGER,
  fetched_at TEXT NOT NULL,
  source_time_from INTEGER,
  source_time_to INTEGER,
  row_count INTEGER NOT NULL,
  pagination_status TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(capture_run_id, capture_id)
);

CREATE INDEX capture_manifest_items_run_idx ON capture_manifest_items(capture_run_id, source_endpoint, page_index);

CREATE TABLE position_baseline_runs (
  baseline_run_id TEXT PRIMARY KEY,
  capture_run_id TEXT NOT NULL REFERENCES capture_runs(capture_run_id),
  target_id TEXT NOT NULL REFERENCES monitor_targets(target_id),
  wallet_address TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('CAPTURING', 'READY', 'FAILED')),
  cutoff_from TEXT NOT NULL,
  cutoff_to TEXT NOT NULL,
  snapshot_time TEXT NOT NULL,
  position_capture_id TEXT NOT NULL REFERENCES api_captures(capture_id),
  item_count INTEGER NOT NULL,
  schema_version TEXT NOT NULL,
  strategy_version TEXT NOT NULL,
  ruleset_hash TEXT NOT NULL REFERENCES rulesets(ruleset_hash),
  source_code_commit TEXT NOT NULL,
  source_code_dirty INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE position_baseline_items (
  baseline_item_id TEXT PRIMARY KEY,
  baseline_run_id TEXT NOT NULL REFERENCES position_baseline_runs(baseline_run_id),
  condition_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  market_slug TEXT,
  market_title TEXT,
  outcome TEXT,
  size_micros TEXT NOT NULL,
  average_price_units TEXT NOT NULL,
  snapshot_time TEXT NOT NULL,
  UNIQUE(baseline_run_id, asset_id)
);

CREATE INDEX position_baseline_items_asset_idx ON position_baseline_items(baseline_run_id, asset_id);

CREATE TABLE position_bucket_ledger (
  bucket_ledger_id TEXT PRIMARY KEY,
  replay_run_id TEXT NOT NULL REFERENCES replay_runs(replay_run_id),
  source_event_key TEXT NOT NULL REFERENCES raw_events(source_event_key),
  asset_id TEXT NOT NULL,
  historical_before_micros TEXT NOT NULL,
  historical_after_micros TEXT NOT NULL,
  tracked_before_micros TEXT NOT NULL,
  tracked_after_micros TEXT NOT NULL,
  recognized_sell_micros TEXT NOT NULL,
  reason TEXT NOT NULL,
  ruleset_hash TEXT NOT NULL REFERENCES rulesets(ruleset_hash),
  created_at TEXT NOT NULL,
  UNIQUE(replay_run_id, source_event_key)
);

CREATE TABLE capital_estimates (
  capital_estimate_id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL REFERENCES monitor_targets(target_id),
  source_event_key TEXT REFERENCES raw_events(source_event_key),
  position_value_micros TEXT,
  wallet_balance_micros TEXT,
  target_visible_capital_micros TEXT,
  target_trade_amount_micros TEXT,
  target_trade_capital_ratio_ppm TEXT,
  capital_estimate_status TEXT NOT NULL CHECK(capital_estimate_status IN ('COMPLETE', 'INCOMPLETE', 'FAILED')),
  capital_confidence TEXT NOT NULL CHECK(capital_confidence IN ('HIGH', 'MEDIUM', 'LOW')),
  capital_estimate_reason TEXT NOT NULL,
  position_snapshot_time TEXT,
  wallet_balance_snapshot_time TEXT,
  target_trade_timestamp TEXT,
  fallback_amount_micros TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  strategy_version TEXT NOT NULL,
  risk_version TEXT NOT NULL,
  ruleset_snapshot_json TEXT NOT NULL,
  ruleset_hash TEXT NOT NULL REFERENCES rulesets(ruleset_hash),
  source_code_commit TEXT NOT NULL,
  source_code_dirty INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE golden_expectations (
  golden_case_id TEXT PRIMARY KEY,
  capture_run_id TEXT NOT NULL REFERENCES capture_runs(capture_run_id),
  sample_wallet TEXT NOT NULL,
  sample_role TEXT NOT NULL CHECK(sample_role IN ('TARGET', 'FIXTURE')),
  case_type TEXT NOT NULL CHECK(case_type IN ('NORMAL_BUY', 'NORMAL_SELL', 'HISTORICAL_SELL', 'COMBO', 'UNRECOGNIZED')),
  source_event_key TEXT,
  source_transaction_hash TEXT,
  expected_signal_type TEXT,
  expected_signal_present INTEGER NOT NULL,
  expected_execution_eligible INTEGER,
  expected_event_classification TEXT NOT NULL,
  expected_reason TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('CANDIDATE', 'APPROVED', 'REJECTED')),
  approved_at TEXT,
  approved_by TEXT,
  schema_version TEXT NOT NULL,
  signal_version TEXT NOT NULL,
  replay_version TEXT NOT NULL,
  ruleset_hash TEXT NOT NULL REFERENCES rulesets(ruleset_hash),
  source_code_commit TEXT NOT NULL,
  source_code_dirty INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX golden_expectations_run_idx ON golden_expectations(capture_run_id, status, case_type);

CREATE TABLE golden_results (
  golden_result_id TEXT PRIMARY KEY,
  replay_run_id TEXT NOT NULL REFERENCES replay_runs(replay_run_id),
  golden_case_id TEXT NOT NULL REFERENCES golden_expectations(golden_case_id),
  result_status TEXT NOT NULL CHECK(result_status IN ('MATCH', 'DIFF', 'NOT_EVALUATED')),
  actual_signal_type TEXT,
  actual_signal_present INTEGER NOT NULL,
  actual_execution_eligible INTEGER,
  actual_event_classification TEXT,
  diff_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(replay_run_id, golden_case_id)
);

CREATE TABLE replay_jobs (
  replay_job_id TEXT PRIMARY KEY,
  capture_run_id TEXT REFERENCES capture_runs(capture_run_id),
  state TEXT NOT NULL CHECK(state IN ('CREATED', 'RUNNING', 'COMPLETED', 'FAILED', 'INTERRUPTED')),
  replay_run_id TEXT REFERENCES replay_runs(replay_run_id),
  replaces_job_id TEXT REFERENCES replay_jobs(replay_job_id),
  started_at TEXT,
  heartbeat_at TEXT,
  finished_at TEXT,
  error_detail TEXT,
  source_code_commit TEXT NOT NULL,
  source_code_dirty INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX replay_jobs_state_idx ON replay_jobs(state, heartbeat_at);
