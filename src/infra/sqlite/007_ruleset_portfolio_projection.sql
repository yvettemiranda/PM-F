ALTER TABLE risk_decisions ADD COLUMN risk_reason TEXT;

CREATE TABLE ruleset_registry (
  ruleset_hash TEXT PRIMARY KEY REFERENCES rulesets(ruleset_hash),
  ruleset_version TEXT NOT NULL,
  buy_price_lower_ratio_ppm INTEGER NOT NULL,
  buy_price_upper_ratio_ppm INTEGER NOT NULL,
  stop_loss_ratio_ppm INTEGER NOT NULL,
  wait_ratio_ppm INTEGER NOT NULL,
  max_wait_time_ms INTEGER NOT NULL,
  capital_mode TEXT NOT NULL,
  fee_model_version TEXT NOT NULL,
  ruleset_snapshot_json TEXT NOT NULL,
  source_code_commit TEXT NOT NULL,
  source_code_dirty INTEGER NOT NULL,
  config_version TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE portfolio_projection_runs (
  projection_id TEXT PRIMARY KEY,
  paper_account_id TEXT NOT NULL REFERENCES paper_accounts(paper_account_id),
  cash_balance_micros TEXT NOT NULL,
  reserved_balance_micros TEXT NOT NULL,
  available_balance_micros TEXT NOT NULL,
  position_value_micros TEXT NOT NULL,
  realized_pnl_micros TEXT NOT NULL,
  unrealized_pnl_micros TEXT NOT NULL,
  total_equity_micros TEXT NOT NULL,
  valuation_status TEXT NOT NULL CHECK(valuation_status IN ('COMPLETE','INCOMPLETE')),
  unpriced_position_count INTEGER NOT NULL,
  price_source TEXT NOT NULL,
  price_timestamp TEXT NOT NULL,
  ruleset_hash TEXT NOT NULL REFERENCES ruleset_registry(ruleset_hash),
  source_code_commit TEXT NOT NULL,
  source_code_dirty INTEGER NOT NULL,
  config_version TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX portfolio_projection_runs_account_idx
ON portfolio_projection_runs(paper_account_id, created_at);
