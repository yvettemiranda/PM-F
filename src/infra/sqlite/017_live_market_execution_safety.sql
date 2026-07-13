ALTER TABLE live_executions ADD COLUMN deadline_at TEXT;
ALTER TABLE live_executions ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0);
ALTER TABLE live_orders ADD COLUMN is_terminal INTEGER NOT NULL DEFAULT 0 CHECK(is_terminal IN (0,1));
ALTER TABLE live_orders ADD COLUMN confirmation_pending INTEGER NOT NULL DEFAULT 0 CHECK(confirmation_pending IN (0,1));

UPDATE live_orders
SET is_terminal=1
WHERE status IN ('FILLED','FAILED','CANCELLED','EXPIRED');

CREATE TABLE live_market_checks (
  market_check_id TEXT PRIMARY KEY,
  live_execution_id TEXT NOT NULL REFERENCES live_executions(live_execution_id),
  live_account_id TEXT NOT NULL,
  signal_id TEXT REFERENCES signals(signal_id),
  risk_decision_id TEXT NOT NULL REFERENCES risk_decisions(risk_decision_id),
  side TEXT NOT NULL CHECK(side IN ('BUY','SELL')),
  execution_type TEXT NOT NULL CHECK(execution_type IN ('TARGET_BUY','TARGET_SELL','STOP_LOSS')),
  asset_id TEXT NOT NULL,
  condition_id TEXT NOT NULL,
  market_snapshot_time TEXT NOT NULL,
  received_at TEXT NOT NULL,
  data_age_ms INTEGER NOT NULL,
  target_price_units TEXT NOT NULL,
  lower_price_units TEXT,
  upper_price_units TEXT,
  quoted_vwap_price_units TEXT,
  requested_size_micros TEXT,
  quoted_size_micros TEXT NOT NULL,
  quoted_notional_micros TEXT NOT NULL,
  quoted_fee_micros TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('ALLOW','WAIT','EXPIRED','REJECT')),
  reason TEXT NOT NULL,
  orderbook_sha256 TEXT NOT NULL,
  orderbook_json TEXT NOT NULL,
  fee_snapshot_json TEXT NOT NULL,
  ruleset_hash TEXT NOT NULL REFERENCES ruleset_registry(ruleset_hash),
  source_code_commit TEXT NOT NULL,
  source_code_dirty INTEGER NOT NULL,
  config_version TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX live_market_checks_execution_idx
ON live_market_checks(live_execution_id, created_at);

CREATE INDEX live_market_checks_account_idx
ON live_market_checks(live_account_id, created_at);

CREATE TRIGGER live_market_checks_no_update
BEFORE UPDATE ON live_market_checks
BEGIN
  SELECT RAISE(ABORT, 'live_market_checks is immutable');
END;

CREATE TRIGGER live_market_checks_no_delete
BEFORE DELETE ON live_market_checks
BEGIN
  SELECT RAISE(ABORT, 'live_market_checks is immutable');
END;

CREATE TABLE live_valuation_snapshots (
  valuation_snapshot_id TEXT PRIMARY KEY,
  live_account_id TEXT NOT NULL,
  cash_balance_micros TEXT NOT NULL,
  reserved_balance_micros TEXT NOT NULL,
  available_balance_micros TEXT NOT NULL,
  position_value_micros TEXT NOT NULL,
  realized_pnl_micros TEXT NOT NULL,
  unrealized_pnl_micros TEXT NOT NULL,
  total_equity_micros TEXT NOT NULL,
  valuation_status TEXT NOT NULL CHECK(valuation_status IN ('COMPLETE','INCOMPLETE')),
  unpriced_position_count INTEGER NOT NULL CHECK(unpriced_position_count >= 0),
  price_source TEXT NOT NULL,
  price_timestamp TEXT NOT NULL,
  position_evidence_json TEXT NOT NULL,
  ruleset_hash TEXT NOT NULL REFERENCES ruleset_registry(ruleset_hash),
  source_code_commit TEXT NOT NULL,
  source_code_dirty INTEGER NOT NULL,
  config_version TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX live_valuation_snapshots_account_idx
ON live_valuation_snapshots(live_account_id, created_at);

CREATE TRIGGER live_valuation_snapshots_no_update
BEFORE UPDATE ON live_valuation_snapshots
BEGIN
  SELECT RAISE(ABORT, 'live_valuation_snapshots is immutable');
END;

CREATE TRIGGER live_valuation_snapshots_no_delete
BEFORE DELETE ON live_valuation_snapshots
BEGIN
  SELECT RAISE(ABORT, 'live_valuation_snapshots is immutable');
END;

CREATE TABLE live_signal_consumptions (
  live_account_id TEXT NOT NULL,
  signal_id TEXT NOT NULL REFERENCES signals(signal_id),
  risk_decision_id TEXT NOT NULL REFERENCES risk_decisions(risk_decision_id),
  live_execution_id TEXT NOT NULL REFERENCES live_executions(live_execution_id),
  consumption_result TEXT NOT NULL CHECK(consumption_result IN ('ACCEPTED','REJECTED')),
  reason TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  ruleset_hash TEXT NOT NULL REFERENCES ruleset_registry(ruleset_hash),
  source_code_commit TEXT NOT NULL,
  source_code_dirty INTEGER NOT NULL,
  config_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(live_account_id, signal_id)
);

CREATE INDEX live_signal_consumptions_execution_idx
ON live_signal_consumptions(live_execution_id);

CREATE TABLE live_consumer_checkpoints (
  live_account_id TEXT PRIMARY KEY,
  signal_cutoff_at TEXT NOT NULL,
  last_signal_created_at TEXT,
  last_signal_id TEXT,
  updated_at TEXT NOT NULL
);

CREATE TRIGGER live_signal_consumptions_no_update
BEFORE UPDATE ON live_signal_consumptions
BEGIN
  SELECT RAISE(ABORT, 'live_signal_consumptions is immutable');
END;

CREATE TRIGGER live_signal_consumptions_no_delete
BEFORE DELETE ON live_signal_consumptions
BEGIN
  SELECT RAISE(ABORT, 'live_signal_consumptions is immutable');
END;
