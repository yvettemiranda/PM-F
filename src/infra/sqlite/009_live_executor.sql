CREATE TABLE live_executions (
  live_execution_id TEXT PRIMARY KEY,
  live_account_id TEXT NOT NULL,
  signal_id TEXT REFERENCES signals(signal_id),
  context_id TEXT REFERENCES signal_execution_contexts(context_id),
  risk_decision_id TEXT NOT NULL REFERENCES risk_decisions(risk_decision_id),
  live_gate_run_id TEXT REFERENCES live_gate_runs(live_gate_run_id),
  execution_idempotency_key TEXT NOT NULL UNIQUE,
  execution_type TEXT NOT NULL CHECK(execution_type IN ('TARGET_BUY','TARGET_SELL','STOP_LOSS','SETTLEMENT','REDEEM')),
  state TEXT NOT NULL CHECK(state IN (
    'WAITING_EXECUTION','PARTIALLY_EXECUTED','EXECUTED','EXPIRED','REJECTED',
    'CANCELLED','EXIT_PENDING','STOP_EXIT_PENDING','FAILED','FROZEN'
  )),
  asset_id TEXT NOT NULL,
  condition_id TEXT NOT NULL,
  requested_amount_micros TEXT,
  requested_size_micros TEXT,
  filled_size_micros TEXT NOT NULL,
  filled_notional_micros TEXT NOT NULL,
  fee_micros TEXT NOT NULL,
  target_price_units TEXT,
  reason TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  strategy_version TEXT NOT NULL,
  risk_version TEXT NOT NULL,
  live_version TEXT NOT NULL,
  ruleset_hash TEXT NOT NULL REFERENCES ruleset_registry(ruleset_hash),
  source_code_commit TEXT NOT NULL,
  source_code_dirty INTEGER NOT NULL,
  config_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX live_executions_account_idx ON live_executions(live_account_id, created_at);
CREATE INDEX live_executions_signal_idx ON live_executions(signal_id, risk_decision_id, created_at);

CREATE TABLE live_orders (
  live_order_id TEXT PRIMARY KEY,
  live_execution_id TEXT NOT NULL REFERENCES live_executions(live_execution_id),
  live_order_idempotency_key TEXT NOT NULL UNIQUE,
  external_order_id TEXT,
  market_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  condition_id TEXT NOT NULL,
  side TEXT NOT NULL CHECK(side IN ('BUY','SELL')),
  order_type TEXT NOT NULL CHECK(order_type IN ('FAK','FOK','GTC','GTD')),
  price_units TEXT NOT NULL,
  size_micros TEXT NOT NULL,
  filled_size_micros TEXT NOT NULL,
  filled_notional_micros TEXT NOT NULL,
  fee_micros TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN (
    'CREATED','SUBMITTED','ACKNOWLEDGED','PARTIALLY_FILLED','FILLED',
    'FAILED','CANCEL_PENDING','CANCELLED','EXPIRED'
  )),
  adapter_type TEXT NOT NULL,
  raw_response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX live_orders_execution_idx ON live_orders(live_execution_id, created_at);
CREATE INDEX live_orders_external_idx ON live_orders(external_order_id);

CREATE TABLE live_order_attempts (
  attempt_id TEXT PRIMARY KEY,
  live_order_id TEXT NOT NULL REFERENCES live_orders(live_order_id),
  attempt_sequence INTEGER NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('SUBMIT','CANCEL','STATUS_SYNC')),
  status TEXT NOT NULL CHECK(status IN ('STARTED','SUCCEEDED','FAILED')),
  error_reason TEXT,
  request_json TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(live_order_id, attempt_sequence, action)
);

CREATE TABLE live_fills (
  live_fill_id TEXT PRIMARY KEY,
  live_order_id TEXT NOT NULL REFERENCES live_orders(live_order_id),
  live_execution_id TEXT NOT NULL REFERENCES live_executions(live_execution_id),
  external_fill_id TEXT NOT NULL,
  side TEXT NOT NULL CHECK(side IN ('BUY','SELL')),
  fill_price_units TEXT NOT NULL,
  fill_size_micros TEXT NOT NULL,
  fill_notional_micros TEXT NOT NULL,
  fee_micros TEXT NOT NULL,
  fill_timestamp TEXT NOT NULL,
  raw_json TEXT NOT NULL,
  fill_idempotency_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE INDEX live_fills_order_idx ON live_fills(live_order_id, created_at);

CREATE TABLE live_positions (
  live_position_id TEXT PRIMARY KEY,
  live_account_id TEXT NOT NULL,
  opening_execution_id TEXT NOT NULL REFERENCES live_executions(live_execution_id),
  signal_id TEXT REFERENCES signals(signal_id),
  asset_id TEXT NOT NULL,
  condition_id TEXT NOT NULL,
  outcome TEXT,
  entry_price_units TEXT NOT NULL,
  entry_size_micros TEXT NOT NULL,
  entry_notional_micros TEXT NOT NULL,
  entry_fee_micros TEXT NOT NULL,
  current_size_micros TEXT NOT NULL,
  remaining_cost_micros TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('OPEN','PARTIALLY_CLOSED','SETTLEMENT_PENDING','CLOSED','REDEEMED','FROZEN')),
  frozen_from_status TEXT,
  frozen_reason TEXT,
  frozen_at TEXT,
  realized_pnl_micros TEXT NOT NULL,
  ruleset_hash TEXT NOT NULL REFERENCES ruleset_registry(ruleset_hash),
  source_code_commit TEXT NOT NULL,
  source_code_dirty INTEGER NOT NULL,
  config_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX live_positions_open_idx ON live_positions(live_account_id, asset_id, status, created_at);

CREATE TABLE live_execution_positions (
  live_execution_id TEXT NOT NULL REFERENCES live_executions(live_execution_id),
  live_position_id TEXT NOT NULL REFERENCES live_positions(live_position_id),
  requested_size_micros TEXT NOT NULL,
  filled_size_micros TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(live_execution_id, live_position_id)
);

CREATE TABLE live_cash_ledger (
  cash_ledger_id TEXT PRIMARY KEY,
  live_account_id TEXT NOT NULL,
  live_execution_id TEXT REFERENCES live_executions(live_execution_id),
  entry_type TEXT NOT NULL,
  cash_delta_micros TEXT NOT NULL,
  reserved_delta_micros TEXT NOT NULL,
  cash_after_micros TEXT,
  reserved_after_micros TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE live_reservation_ledger (
  reservation_ledger_id TEXT PRIMARY KEY,
  live_execution_id TEXT NOT NULL REFERENCES live_executions(live_execution_id),
  live_order_id TEXT REFERENCES live_orders(live_order_id),
  entry_type TEXT NOT NULL CHECK(entry_type IN ('RESERVE','CONSUME','RELEASE')),
  delta_micros TEXT NOT NULL,
  remaining_after_micros TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE live_fill_ledger (
  fill_ledger_id TEXT PRIMARY KEY,
  live_fill_id TEXT NOT NULL REFERENCES live_fills(live_fill_id),
  live_order_id TEXT NOT NULL REFERENCES live_orders(live_order_id),
  live_execution_id TEXT NOT NULL REFERENCES live_executions(live_execution_id),
  live_position_id TEXT REFERENCES live_positions(live_position_id),
  side TEXT NOT NULL CHECK(side IN ('BUY','SELL')),
  price_units TEXT NOT NULL,
  size_micros TEXT NOT NULL,
  notional_micros TEXT NOT NULL,
  fee_micros TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE live_fee_ledger (
  fee_ledger_id TEXT PRIMARY KEY,
  live_execution_id TEXT NOT NULL REFERENCES live_executions(live_execution_id),
  live_order_id TEXT NOT NULL REFERENCES live_orders(live_order_id),
  fee_micros TEXT NOT NULL,
  fee_source TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE live_pnl_ledger (
  pnl_ledger_id TEXT PRIMARY KEY,
  live_account_id TEXT NOT NULL,
  live_position_id TEXT NOT NULL REFERENCES live_positions(live_position_id),
  live_execution_id TEXT NOT NULL REFERENCES live_executions(live_execution_id),
  pnl_type TEXT NOT NULL CHECK(pnl_type IN ('REALIZED','SETTLEMENT')),
  proceeds_micros TEXT NOT NULL,
  cost_basis_micros TEXT NOT NULL,
  fee_micros TEXT NOT NULL,
  pnl_micros TEXT NOT NULL,
  price_source TEXT NOT NULL,
  price_timestamp TEXT NOT NULL,
  ruleset_hash TEXT NOT NULL REFERENCES ruleset_registry(ruleset_hash),
  source_code_commit TEXT NOT NULL,
  source_code_dirty INTEGER NOT NULL,
  config_version TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE live_settlement_ledger (
  settlement_ledger_id TEXT PRIMARY KEY,
  live_position_id TEXT NOT NULL REFERENCES live_positions(live_position_id),
  live_execution_id TEXT REFERENCES live_executions(live_execution_id),
  condition_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  settlement_status TEXT NOT NULL CHECK(settlement_status IN ('PENDING','RESOLVED','REDEEM_PENDING','REDEEMED','REDEEM_DISABLED')),
  redeem_amount_micros TEXT,
  pnl_micros TEXT,
  resolution_snapshot_json TEXT NOT NULL,
  redeem_idempotency_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE live_redeems (
  live_redeem_id TEXT PRIMARY KEY,
  live_position_id TEXT NOT NULL REFERENCES live_positions(live_position_id),
  redeem_idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK(status IN ('CREATED','SUBMITTED','CONFIRMED','DISABLED','FAILED')),
  adapter_type TEXT NOT NULL,
  raw_response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE live_state_transitions (
  transition_id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT NOT NULL,
  reason TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  ruleset_hash TEXT NOT NULL REFERENCES ruleset_registry(ruleset_hash),
  source_code_commit TEXT NOT NULL,
  source_code_dirty INTEGER NOT NULL,
  config_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(entity_type, entity_id, sequence)
);

CREATE TABLE live_reconciliation_runs (
  reconciliation_run_id TEXT PRIMARY KEY,
  live_account_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('PASSED','FAILED')),
  checks_json TEXT NOT NULL,
  source_code_commit TEXT NOT NULL,
  source_code_dirty INTEGER NOT NULL,
  config_version TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE live_recovery_runs (
  recovery_run_id TEXT PRIMARY KEY,
  live_account_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('PASSED','FAILED')),
  recovered_open_orders INTEGER NOT NULL,
  recovered_fills INTEGER NOT NULL,
  recovered_positions INTEGER NOT NULL,
  reason TEXT NOT NULL,
  checks_json TEXT NOT NULL,
  source_code_commit TEXT NOT NULL,
  source_code_dirty INTEGER NOT NULL,
  config_version TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE live_execution_checkpoints (
  live_account_id TEXT PRIMARY KEY,
  last_execution_id TEXT,
  last_order_id TEXT,
  last_fill_id TEXT,
  last_reconciliation_run_id TEXT,
  updated_at TEXT NOT NULL
);
