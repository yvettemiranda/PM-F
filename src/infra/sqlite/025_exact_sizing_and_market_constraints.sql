-- Exact rational capital sizing. Existing rows remain immutable historical
-- evidence and continue to use target_trade_capital_ratio_ppm.
ALTER TABLE capital_estimates ADD COLUMN capital_sizing_ratio_json TEXT;
ALTER TABLE capital_estimates ADD COLUMN capital_sizing_ratio_hash TEXT;

ALTER TABLE signal_execution_contexts ADD COLUMN capital_sizing_ratio_json TEXT;
ALTER TABLE signal_execution_contexts ADD COLUMN capital_sizing_ratio_hash TEXT;

ALTER TABLE risk_decisions ADD COLUMN capital_sizing_decision_json TEXT;
ALTER TABLE risk_decisions ADD COLUMN capital_sizing_decision_hash TEXT;

CREATE TRIGGER capital_estimates_sizing_pair_insert
BEFORE INSERT ON capital_estimates
WHEN (NEW.capital_sizing_ratio_json IS NULL) <> (NEW.capital_sizing_ratio_hash IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'capital sizing ratio json/hash must be paired');
END;

CREATE TRIGGER signal_execution_contexts_sizing_pair_insert
BEFORE INSERT ON signal_execution_contexts
WHEN (NEW.capital_sizing_ratio_json IS NULL) <> (NEW.capital_sizing_ratio_hash IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'execution context sizing ratio json/hash must be paired');
END;

CREATE TRIGGER risk_decisions_sizing_pair_insert
BEFORE INSERT ON risk_decisions
WHEN (NEW.capital_sizing_decision_json IS NULL) <> (NEW.capital_sizing_decision_hash IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'risk sizing decision json/hash must be paired');
END;

ALTER TABLE paper_orderbook_snapshots ADD COLUMN min_order_size TEXT;
ALTER TABLE paper_orderbook_snapshots ADD COLUMN min_order_size_micros TEXT;
ALTER TABLE paper_orderbook_snapshots ADD COLUMN tick_size TEXT;
ALTER TABLE paper_orderbook_snapshots ADD COLUMN tick_size_units TEXT;
ALTER TABLE paper_orderbook_snapshots ADD COLUMN source_capture_id TEXT REFERENCES api_captures(capture_id);

ALTER TABLE paper_fee_snapshots ADD COLUMN source_capture_id TEXT REFERENCES api_captures(capture_id);

-- Orderbook and fee snapshots are execution evidence.  The capture FK is only
-- meaningful when the snapshot row itself cannot later be repointed or
-- removed.
CREATE TRIGGER paper_orderbook_snapshots_no_update
BEFORE UPDATE ON paper_orderbook_snapshots
BEGIN
  SELECT RAISE(ABORT, 'paper orderbook snapshots is immutable');
END;

CREATE TRIGGER paper_orderbook_snapshots_no_delete
BEFORE DELETE ON paper_orderbook_snapshots
BEGIN
  SELECT RAISE(ABORT, 'paper orderbook snapshots is immutable');
END;

CREATE TRIGGER paper_fee_snapshots_no_update
BEFORE UPDATE ON paper_fee_snapshots
BEGIN
  SELECT RAISE(ABORT, 'paper fee snapshots is immutable');
END;

CREATE TRIGGER paper_fee_snapshots_no_delete
BEFORE DELETE ON paper_fee_snapshots
BEGIN
  SELECT RAISE(ABORT, 'paper fee snapshots is immutable');
END;

CREATE TABLE paper_market_constraint_evidence (
  market_constraint_evidence_id TEXT PRIMARY KEY,
  paper_execution_id TEXT NOT NULL REFERENCES paper_executions(paper_execution_id),
  orderbook_snapshot_id TEXT NOT NULL REFERENCES paper_orderbook_snapshots(orderbook_snapshot_id),
  attempt_sequence INTEGER NOT NULL CHECK(attempt_sequence >= 1),
  side TEXT NOT NULL CHECK(side IN ('BUY','SELL')),
  check_result TEXT NOT NULL CHECK(check_result IN ('PASS','REJECT','UNAVAILABLE')),
  reason TEXT NOT NULL,
  min_order_size TEXT,
  min_order_size_micros TEXT,
  tick_size TEXT,
  tick_size_units TEXT,
  proposed_amount_micros TEXT,
  normalized_order_amount_micros TEXT,
  proposed_size_micros TEXT,
  normalized_order_size_micros TEXT,
  effective_price_units TEXT,
  derived_min_notional_micros TEXT,
  price_rounding TEXT CHECK(price_rounding IS NULL OR price_rounding IN ('FLOOR_TO_TICK','CEIL_TO_TICK')),
  evidence_json TEXT NOT NULL,
  evidence_hash TEXT NOT NULL,
  ruleset_hash TEXT NOT NULL REFERENCES ruleset_registry(ruleset_hash),
  source_code_commit TEXT NOT NULL,
  source_code_dirty INTEGER NOT NULL,
  config_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(paper_execution_id, attempt_sequence, orderbook_snapshot_id, side)
);

CREATE INDEX paper_market_constraint_execution_idx
ON paper_market_constraint_evidence(paper_execution_id, created_at);

CREATE TRIGGER paper_market_constraint_evidence_no_update
BEFORE UPDATE ON paper_market_constraint_evidence
BEGIN
  SELECT RAISE(ABORT, 'paper market constraint evidence is immutable');
END;

CREATE TRIGGER paper_market_constraint_evidence_no_delete
BEFORE DELETE ON paper_market_constraint_evidence
BEGIN
  SELECT RAISE(ABORT, 'paper market constraint evidence is immutable');
END;
