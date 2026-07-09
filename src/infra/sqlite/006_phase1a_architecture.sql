ALTER TABLE rulesets ADD COLUMN config_version TEXT NOT NULL DEFAULT 'v1.0.0';

ALTER TABLE signal_execution_contexts ADD COLUMN config_version TEXT NOT NULL DEFAULT 'v1.0.0';

ALTER TABLE paper_executions ADD COLUMN risk_decision_id TEXT;
ALTER TABLE paper_executions ADD COLUMN risk_reject_reason TEXT;
ALTER TABLE paper_executions ADD COLUMN source_code_commit TEXT NOT NULL DEFAULT 'UNKNOWN';
ALTER TABLE paper_executions ADD COLUMN source_code_dirty INTEGER NOT NULL DEFAULT 1;
ALTER TABLE paper_executions ADD COLUMN config_version TEXT NOT NULL DEFAULT 'v1.0.0';

ALTER TABLE paper_state_transitions ADD COLUMN source_code_commit TEXT NOT NULL DEFAULT 'UNKNOWN';
ALTER TABLE paper_state_transitions ADD COLUMN source_code_dirty INTEGER NOT NULL DEFAULT 1;
ALTER TABLE paper_state_transitions ADD COLUMN config_version TEXT NOT NULL DEFAULT 'v1.0.0';

ALTER TABLE paper_settlements ADD COLUMN ruleset_hash TEXT;
ALTER TABLE paper_settlements ADD COLUMN source_code_commit TEXT NOT NULL DEFAULT 'UNKNOWN';
ALTER TABLE paper_settlements ADD COLUMN source_code_dirty INTEGER NOT NULL DEFAULT 1;
ALTER TABLE paper_settlements ADD COLUMN config_version TEXT NOT NULL DEFAULT 'v1.0.0';

ALTER TABLE paper_portfolio_snapshots ADD COLUMN price_source TEXT;
ALTER TABLE paper_portfolio_snapshots ADD COLUMN price_timestamp TEXT;
ALTER TABLE paper_portfolio_snapshots ADD COLUMN source_code_commit TEXT NOT NULL DEFAULT 'UNKNOWN';
ALTER TABLE paper_portfolio_snapshots ADD COLUMN source_code_dirty INTEGER NOT NULL DEFAULT 1;
ALTER TABLE paper_portfolio_snapshots ADD COLUMN config_version TEXT NOT NULL DEFAULT 'v1.0.0';

ALTER TABLE paper_pnl_ledger ADD COLUMN price_source TEXT;
ALTER TABLE paper_pnl_ledger ADD COLUMN price_timestamp TEXT;
ALTER TABLE paper_pnl_ledger ADD COLUMN fee_snapshot_id TEXT;
ALTER TABLE paper_pnl_ledger ADD COLUMN ruleset_hash TEXT;
ALTER TABLE paper_pnl_ledger ADD COLUMN source_code_commit TEXT NOT NULL DEFAULT 'UNKNOWN';
ALTER TABLE paper_pnl_ledger ADD COLUMN source_code_dirty INTEGER NOT NULL DEFAULT 1;
ALTER TABLE paper_pnl_ledger ADD COLUMN config_version TEXT NOT NULL DEFAULT 'v1.0.0';

DROP INDEX IF EXISTS paper_positions_open_idx;

PRAGMA legacy_alter_table=ON;

ALTER TABLE paper_positions RENAME TO paper_positions_v2_0_0;

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
  status TEXT NOT NULL CHECK(status IN ('OPEN','PARTIALLY_CLOSED','SETTLEMENT_PENDING','CLOSED','REDEEMED','FROZEN')),
  frozen_from_status TEXT,
  frozen_reason TEXT,
  frozen_at TEXT,
  realized_pnl_micros TEXT NOT NULL,
  ruleset_hash TEXT,
  source_code_commit TEXT NOT NULL,
  source_code_dirty INTEGER NOT NULL,
  config_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO paper_positions(
  paper_position_id,paper_account_id,opening_execution_id,signal_id,asset_id,
  condition_id,outcome,entry_price_units,entry_size_micros,entry_notional_micros,
  entry_fee_micros,current_size_micros,remaining_cost_micros,stop_loss_price_units,
  status,frozen_from_status,frozen_reason,frozen_at,realized_pnl_micros,
  ruleset_hash,source_code_commit,source_code_dirty,config_version,created_at,updated_at
)
SELECT
  paper_position_id,paper_account_id,opening_execution_id,signal_id,asset_id,
  condition_id,outcome,entry_price_units,entry_size_micros,entry_notional_micros,
  entry_fee_micros,current_size_micros,remaining_cost_micros,stop_loss_price_units,
  status,NULL,NULL,NULL,realized_pnl_micros,
  (SELECT ruleset_hash FROM rulesets ORDER BY created_at DESC LIMIT 1),
  'UNKNOWN',1,'v1.0.0',created_at,updated_at
FROM paper_positions_v2_0_0;

DROP TABLE paper_positions_v2_0_0;

PRAGMA legacy_alter_table=OFF;

CREATE INDEX paper_positions_open_idx ON paper_positions(paper_account_id, asset_id, status, created_at);

ALTER TABLE paper_execution_positions RENAME TO paper_execution_positions_v2_0_0;

CREATE TABLE paper_execution_positions (
  paper_execution_id TEXT NOT NULL REFERENCES paper_executions(paper_execution_id),
  paper_position_id TEXT NOT NULL REFERENCES paper_positions(paper_position_id),
  requested_size_micros TEXT NOT NULL,
  filled_size_micros TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(paper_execution_id, paper_position_id)
);

INSERT INTO paper_execution_positions(
  paper_execution_id,paper_position_id,requested_size_micros,filled_size_micros,created_at
)
SELECT paper_execution_id,paper_position_id,requested_size_micros,filled_size_micros,created_at
FROM paper_execution_positions_v2_0_0;

DROP TABLE paper_execution_positions_v2_0_0;

ALTER TABLE paper_fill_ledger RENAME TO paper_fill_ledger_v2_0_0;

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

INSERT INTO paper_fill_ledger(
  fill_id,paper_order_id,paper_execution_id,paper_position_id,side,price_units,
  size_micros,notional_micros,fee_micros,level_sequence,created_at
)
SELECT
  fill_id,paper_order_id,paper_execution_id,paper_position_id,side,price_units,
  size_micros,notional_micros,fee_micros,level_sequence,created_at
FROM paper_fill_ledger_v2_0_0;

DROP TABLE paper_fill_ledger_v2_0_0;

ALTER TABLE paper_pnl_ledger RENAME TO paper_pnl_ledger_v2_0_0;

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
  created_at TEXT NOT NULL,
  price_source TEXT,
  price_timestamp TEXT,
  fee_snapshot_id TEXT,
  ruleset_hash TEXT,
  source_code_commit TEXT NOT NULL DEFAULT 'UNKNOWN',
  source_code_dirty INTEGER NOT NULL DEFAULT 1,
  config_version TEXT NOT NULL DEFAULT 'v1.0.0'
);

INSERT INTO paper_pnl_ledger(
  pnl_ledger_id,paper_account_id,paper_position_id,paper_execution_id,pnl_type,
  proceeds_micros,cost_basis_micros,fee_micros,pnl_micros,created_at,
  price_source,price_timestamp,fee_snapshot_id,ruleset_hash,source_code_commit,
  source_code_dirty,config_version
)
SELECT
  pnl_ledger_id,paper_account_id,paper_position_id,paper_execution_id,pnl_type,
  proceeds_micros,cost_basis_micros,fee_micros,pnl_micros,created_at,
  price_source,price_timestamp,fee_snapshot_id,ruleset_hash,source_code_commit,
  source_code_dirty,config_version
FROM paper_pnl_ledger_v2_0_0;

DROP TABLE paper_pnl_ledger_v2_0_0;

ALTER TABLE paper_settlements RENAME TO paper_settlements_v2_0_0;

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
  created_at TEXT NOT NULL,
  ruleset_hash TEXT,
  source_code_commit TEXT NOT NULL DEFAULT 'UNKNOWN',
  source_code_dirty INTEGER NOT NULL DEFAULT 1,
  config_version TEXT NOT NULL DEFAULT 'v1.0.0'
);

INSERT INTO paper_settlements(
  paper_settlement_id,paper_position_id,paper_execution_id,condition_id,payout_numerator,
  payout_denominator,redeem_amount_micros,pnl_micros,resolution_snapshot_json,resolution_hash,
  created_at,ruleset_hash,source_code_commit,source_code_dirty,config_version
)
SELECT
  paper_settlement_id,paper_position_id,paper_execution_id,condition_id,payout_numerator,
  payout_denominator,redeem_amount_micros,pnl_micros,resolution_snapshot_json,resolution_hash,
  created_at,ruleset_hash,source_code_commit,source_code_dirty,config_version
FROM paper_settlements_v2_0_0;

DROP TABLE paper_settlements_v2_0_0;

CREATE TABLE risk_decisions (
  risk_decision_id TEXT PRIMARY KEY,
  executor_mode TEXT NOT NULL CHECK(executor_mode IN ('PAPER','LIVE')),
  paper_account_id TEXT REFERENCES paper_accounts(paper_account_id),
  signal_id TEXT REFERENCES signals(signal_id),
  context_id TEXT REFERENCES signal_execution_contexts(context_id),
  decision TEXT NOT NULL CHECK(decision IN ('ALLOW','REJECT')),
  risk_reject_reason TEXT,
  requested_amount_micros TEXT,
  requested_size_micros TEXT,
  checks_json TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  strategy_version TEXT NOT NULL,
  risk_version TEXT NOT NULL,
  ruleset_hash TEXT NOT NULL REFERENCES rulesets(ruleset_hash),
  source_code_commit TEXT NOT NULL,
  source_code_dirty INTEGER NOT NULL,
  config_version TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX risk_decisions_signal_idx ON risk_decisions(signal_id, executor_mode, created_at);

CREATE TABLE audit_log (
  audit_id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  reason TEXT,
  ruleset_hash TEXT NOT NULL REFERENCES rulesets(ruleset_hash),
  source_code_commit TEXT NOT NULL,
  source_code_dirty INTEGER NOT NULL,
  config_version TEXT NOT NULL,
  metadata_json TEXT NOT NULL
);

CREATE INDEX audit_log_entity_idx ON audit_log(entity_type, entity_id, timestamp);

CREATE TRIGGER audit_log_no_update
BEFORE UPDATE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is immutable');
END;

CREATE TRIGGER audit_log_no_delete
BEFORE DELETE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is immutable');
END;

CREATE TABLE paper_unrealized_pnl_snapshots (
  unrealized_pnl_snapshot_id TEXT PRIMARY KEY,
  paper_account_id TEXT NOT NULL REFERENCES paper_accounts(paper_account_id),
  paper_position_id TEXT NOT NULL REFERENCES paper_positions(paper_position_id),
  position_value_micros TEXT NOT NULL,
  remaining_cost_micros TEXT NOT NULL,
  fee_micros TEXT NOT NULL,
  unrealized_pnl_micros TEXT NOT NULL,
  price_source TEXT NOT NULL,
  price_timestamp TEXT NOT NULL,
  orderbook_snapshot_id TEXT,
  fee_snapshot_id TEXT,
  ruleset_hash TEXT NOT NULL REFERENCES rulesets(ruleset_hash),
  source_code_commit TEXT NOT NULL,
  source_code_dirty INTEGER NOT NULL,
  config_version TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX paper_unrealized_pnl_snapshots_position_idx
ON paper_unrealized_pnl_snapshots(paper_position_id, created_at);
