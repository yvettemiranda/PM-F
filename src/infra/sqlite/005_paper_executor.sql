CREATE TABLE signal_execution_contexts (
  context_id TEXT PRIMARY KEY,
  signal_id TEXT NOT NULL UNIQUE REFERENCES signals(signal_id),
  capital_decision_id TEXT REFERENCES capital_estimates(capital_estimate_id),
  target_trade_capital_ratio_ppm TEXT,
  target_trade_timestamp TEXT NOT NULL,
  market_end_time TEXT NOT NULL,
  market_metadata_snapshot_json TEXT NOT NULL,
  market_metadata_hash TEXT NOT NULL,
  ruleset_hash TEXT NOT NULL REFERENCES rulesets(ruleset_hash),
  schema_version TEXT NOT NULL,
  signal_version TEXT NOT NULL,
  strategy_version TEXT NOT NULL,
  source_code_commit TEXT NOT NULL,
  source_code_dirty INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TRIGGER signal_execution_contexts_no_update
BEFORE UPDATE ON signal_execution_contexts
BEGIN
  SELECT RAISE(ABORT, 'signal_execution_context is immutable');
END;

CREATE TRIGGER signal_execution_contexts_no_delete
BEFORE DELETE ON signal_execution_contexts
BEGIN
  SELECT RAISE(ABORT, 'signal_execution_context is immutable');
END;

CREATE TABLE paper_accounts (
  paper_account_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('ACTIVE', 'PAUSED', 'CLOSED')),
  initial_balance_micros TEXT NOT NULL,
  cash_balance_micros TEXT NOT NULL,
  reserved_balance_micros TEXT NOT NULL,
  realized_pnl_micros TEXT NOT NULL,
  signal_cutoff_at TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  strategy_version TEXT NOT NULL,
  risk_version TEXT NOT NULL,
  paper_version TEXT NOT NULL,
  ruleset_snapshot_json TEXT NOT NULL,
  ruleset_hash TEXT NOT NULL REFERENCES rulesets(ruleset_hash),
  source_code_commit TEXT NOT NULL,
  source_code_dirty INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE paper_signal_consumptions (
  consumption_id TEXT PRIMARY KEY,
  paper_account_id TEXT NOT NULL REFERENCES paper_accounts(paper_account_id),
  signal_id TEXT NOT NULL REFERENCES signals(signal_id),
  execution_idempotency_key TEXT NOT NULL UNIQUE,
  result TEXT NOT NULL CHECK(result IN ('ACCEPTED', 'REJECTED')),
  reject_reason TEXT,
  paper_execution_id TEXT REFERENCES paper_executions(paper_execution_id),
  consumed_at TEXT NOT NULL,
  UNIQUE(paper_account_id, signal_id)
);

CREATE TABLE paper_executions (
  paper_execution_id TEXT PRIMARY KEY,
  paper_account_id TEXT NOT NULL REFERENCES paper_accounts(paper_account_id),
  signal_id TEXT REFERENCES signals(signal_id),
  execution_idempotency_key TEXT NOT NULL UNIQUE,
  execution_type TEXT NOT NULL CHECK(execution_type IN ('TARGET_BUY', 'TARGET_SELL', 'STOP_LOSS', 'SETTLEMENT')),
  state TEXT NOT NULL CHECK(state IN (
    'WAITING_EXECUTION','PARTIALLY_EXECUTED','EXECUTED','EXPIRED','REJECTED',
    'CANCELLED','EXIT_PENDING','STOP_EXIT_PENDING'
  )),
  asset_id TEXT NOT NULL,
  condition_id TEXT NOT NULL,
  requested_amount_micros TEXT,
  requested_size_micros TEXT,
  filled_size_micros TEXT NOT NULL,
  filled_notional_micros TEXT NOT NULL,
  fee_micros TEXT NOT NULL,
  target_price_units TEXT,
  price_limit_lower_units TEXT,
  price_limit_upper_units TEXT,
  capital_mode TEXT CHECK(capital_mode IN ('PROPORTIONAL', 'FIXED_FALLBACK')),
  deadline_at TEXT,
  attempt_count INTEGER NOT NULL,
  reason TEXT NOT NULL,
  context_id TEXT REFERENCES signal_execution_contexts(context_id),
  schema_version TEXT NOT NULL,
  strategy_version TEXT NOT NULL,
  risk_version TEXT NOT NULL,
  paper_version TEXT NOT NULL,
  ruleset_hash TEXT NOT NULL REFERENCES rulesets(ruleset_hash),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE paper_reservations (
  reservation_id TEXT PRIMARY KEY,
  paper_account_id TEXT NOT NULL REFERENCES paper_accounts(paper_account_id),
  paper_execution_id TEXT NOT NULL UNIQUE REFERENCES paper_executions(paper_execution_id),
  original_amount_micros TEXT NOT NULL,
  remaining_amount_micros TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('ACTIVE', 'CONSUMED', 'RELEASED')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE paper_orders (
  paper_order_id TEXT PRIMARY KEY,
  paper_execution_id TEXT NOT NULL REFERENCES paper_executions(paper_execution_id),
  attempt_sequence INTEGER NOT NULL,
  side TEXT NOT NULL CHECK(side IN ('BUY', 'SELL')),
  order_type TEXT NOT NULL CHECK(order_type='FAK'),
  state TEXT NOT NULL CHECK(state IN ('NO_FILL', 'PARTIALLY_FILLED', 'FILLED', 'REJECTED')),
  requested_size_micros TEXT,
  requested_amount_micros TEXT,
  filled_size_micros TEXT NOT NULL,
  filled_notional_micros TEXT NOT NULL,
  vwap_price_units TEXT,
  fee_micros TEXT NOT NULL,
  reject_reason TEXT,
  orderbook_snapshot_id TEXT NOT NULL,
  fee_snapshot_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(paper_execution_id, attempt_sequence)
);

CREATE TABLE paper_positions (
  paper_position_id TEXT PRIMARY KEY,
  paper_account_id TEXT NOT NULL REFERENCES paper_accounts(paper_account_id),
  opening_execution_id TEXT NOT NULL UNIQUE REFERENCES paper_executions(paper_execution_id),
  signal_id TEXT NOT NULL REFERENCES signals(signal_id),
  asset_id TEXT NOT NULL,
  condition_id TEXT NOT NULL,
  outcome TEXT,
  entry_price_units TEXT NOT NULL,
  entry_size_micros TEXT NOT NULL,
  entry_notional_micros TEXT NOT NULL,
  entry_fee_micros TEXT NOT NULL,
  current_size_micros TEXT NOT NULL,
  remaining_cost_micros TEXT NOT NULL,
  stop_loss_price_units TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('OPEN','PARTIALLY_CLOSED','SETTLEMENT_PENDING','CLOSED','REDEEMED')),
  realized_pnl_micros TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX paper_positions_open_idx ON paper_positions(paper_account_id, asset_id, status, created_at);

CREATE TABLE paper_execution_positions (
  paper_execution_id TEXT NOT NULL REFERENCES paper_executions(paper_execution_id),
  paper_position_id TEXT NOT NULL REFERENCES paper_positions(paper_position_id),
  requested_size_micros TEXT NOT NULL,
  filled_size_micros TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(paper_execution_id, paper_position_id)
);

CREATE TABLE paper_orderbook_snapshots (
  orderbook_snapshot_id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL,
  condition_id TEXT NOT NULL,
  market_snapshot_time TEXT NOT NULL,
  received_at TEXT NOT NULL,
  data_age_ms INTEGER NOT NULL,
  payload_hash TEXT NOT NULL,
  bids_json TEXT NOT NULL,
  asks_json TEXT NOT NULL,
  source_url TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE paper_fee_snapshots (
  fee_snapshot_id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL,
  fee_rate_ppm TEXT,
  base_fee INTEGER,
  fee_exponent INTEGER,
  status TEXT NOT NULL CHECK(status IN ('AVAILABLE', 'UNAVAILABLE')),
  source_url TEXT NOT NULL,
  snapshot_time TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE paper_cash_ledger (
  cash_ledger_id TEXT PRIMARY KEY,
  paper_account_id TEXT NOT NULL REFERENCES paper_accounts(paper_account_id),
  paper_execution_id TEXT REFERENCES paper_executions(paper_execution_id),
  entry_type TEXT NOT NULL,
  cash_delta_micros TEXT NOT NULL,
  reserved_delta_micros TEXT NOT NULL,
  cash_after_micros TEXT NOT NULL,
  reserved_after_micros TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE paper_reservation_ledger (
  reservation_ledger_id TEXT PRIMARY KEY,
  reservation_id TEXT NOT NULL REFERENCES paper_reservations(reservation_id),
  paper_execution_id TEXT NOT NULL REFERENCES paper_executions(paper_execution_id),
  entry_type TEXT NOT NULL CHECK(entry_type IN ('RESERVE','CONSUME','RELEASE')),
  delta_micros TEXT NOT NULL,
  remaining_after_micros TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE paper_fill_ledger (
  fill_id TEXT PRIMARY KEY,
  paper_order_id TEXT NOT NULL REFERENCES paper_orders(paper_order_id),
  paper_execution_id TEXT NOT NULL REFERENCES paper_executions(paper_execution_id),
  paper_position_id TEXT REFERENCES paper_positions(paper_position_id),
  side TEXT NOT NULL CHECK(side IN ('BUY','SELL')),
  price_units TEXT NOT NULL,
  size_micros TEXT NOT NULL,
  notional_micros TEXT NOT NULL,
  fee_micros TEXT NOT NULL,
  level_sequence INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE paper_fee_ledger (
  fee_ledger_id TEXT PRIMARY KEY,
  paper_execution_id TEXT NOT NULL REFERENCES paper_executions(paper_execution_id),
  paper_order_id TEXT NOT NULL REFERENCES paper_orders(paper_order_id),
  fee_snapshot_id TEXT NOT NULL REFERENCES paper_fee_snapshots(fee_snapshot_id),
  fee_micros TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE paper_pnl_ledger (
  pnl_ledger_id TEXT PRIMARY KEY,
  paper_account_id TEXT NOT NULL REFERENCES paper_accounts(paper_account_id),
  paper_position_id TEXT NOT NULL REFERENCES paper_positions(paper_position_id),
  paper_execution_id TEXT NOT NULL REFERENCES paper_executions(paper_execution_id),
  pnl_type TEXT NOT NULL CHECK(pnl_type IN ('REALIZED','SETTLEMENT')),
  proceeds_micros TEXT NOT NULL,
  cost_basis_micros TEXT NOT NULL,
  fee_micros TEXT NOT NULL,
  pnl_micros TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE paper_state_transitions (
  transition_id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT NOT NULL,
  reason TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  ruleset_hash TEXT NOT NULL REFERENCES rulesets(ruleset_hash),
  created_at TEXT NOT NULL,
  UNIQUE(entity_type, entity_id, sequence)
);

CREATE TABLE paper_consumer_checkpoints (
  paper_account_id TEXT PRIMARY KEY REFERENCES paper_accounts(paper_account_id),
  last_signal_created_at TEXT,
  last_signal_id TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE paper_settlements (
  paper_settlement_id TEXT PRIMARY KEY,
  paper_position_id TEXT NOT NULL UNIQUE REFERENCES paper_positions(paper_position_id),
  paper_execution_id TEXT NOT NULL REFERENCES paper_executions(paper_execution_id),
  condition_id TEXT NOT NULL,
  payout_numerator TEXT NOT NULL,
  payout_denominator TEXT NOT NULL,
  redeem_amount_micros TEXT NOT NULL,
  pnl_micros TEXT NOT NULL,
  resolution_snapshot_json TEXT NOT NULL,
  resolution_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE paper_portfolio_snapshots (
  portfolio_snapshot_id TEXT PRIMARY KEY,
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
  ruleset_hash TEXT NOT NULL REFERENCES rulesets(ruleset_hash),
  created_at TEXT NOT NULL
);

CREATE INDEX paper_portfolio_snapshots_account_idx
ON paper_portfolio_snapshots(paper_account_id, created_at);
