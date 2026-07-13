CREATE TABLE live_accounts (
  live_account_id TEXT PRIMARY KEY,
  live_wallet_id TEXT NOT NULL UNIQUE REFERENCES live_wallets(live_wallet_id),
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('DISABLED','ACTIVE','CLOSED')),
  initial_bankroll_micros TEXT NOT NULL,
  risk_budget_micros TEXT NOT NULL,
  signal_cutoff_at TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  strategy_version TEXT NOT NULL,
  risk_version TEXT NOT NULL,
  live_version TEXT NOT NULL,
  ruleset_hash TEXT NOT NULL REFERENCES ruleset_registry(ruleset_hash),
  source_code_commit TEXT NOT NULL,
  source_code_dirty INTEGER NOT NULL,
  config_version TEXT NOT NULL,
  activated_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX live_accounts_status_idx ON live_accounts(status, updated_at);

CREATE TABLE live_account_state_transitions (
  transition_id TEXT PRIMARY KEY,
  live_account_id TEXT NOT NULL REFERENCES live_accounts(live_account_id),
  from_state TEXT,
  to_state TEXT NOT NULL CHECK(to_state IN ('DISABLED','ACTIVE','CLOSED')),
  reason TEXT NOT NULL,
  actor TEXT NOT NULL,
  ruleset_hash TEXT NOT NULL REFERENCES ruleset_registry(ruleset_hash),
  source_code_commit TEXT NOT NULL,
  source_code_dirty INTEGER NOT NULL,
  config_version TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX live_account_transitions_account_idx
ON live_account_state_transitions(live_account_id, created_at);

CREATE TRIGGER live_account_state_transitions_no_update
BEFORE UPDATE ON live_account_state_transitions
BEGIN
  SELECT RAISE(ABORT, 'live_account_state_transition is immutable');
END;

CREATE TRIGGER live_account_state_transitions_no_delete
BEFORE DELETE ON live_account_state_transitions
BEGIN
  SELECT RAISE(ABORT, 'live_account_state_transition is immutable');
END;

ALTER TABLE risk_decisions ADD COLUMN account_id TEXT;

UPDATE risk_decisions
SET account_id=paper_account_id
WHERE account_id IS NULL AND paper_account_id IS NOT NULL;

UPDATE risk_decisions
SET paper_account_id=NULL
WHERE executor_mode='LIVE';

-- Legacy LIVE decisions may predate live_accounts. The identifier is preserved
-- in account_id above, but only new decisions are required to resolve to the
-- mode-specific account table. Historical decisions remain immutable evidence.
CREATE TRIGGER risk_decisions_account_insert_guard
BEFORE INSERT ON risk_decisions
WHEN NEW.account_id IS NULL
  OR (
    NEW.executor_mode='PAPER'
    AND (
      NEW.paper_account_id IS NULL
      OR NEW.account_id!=NEW.paper_account_id
      OR NOT EXISTS (
        SELECT 1 FROM paper_accounts WHERE paper_account_id=NEW.account_id
      )
    )
  )
  OR (
    NEW.executor_mode='LIVE'
    AND (
      NEW.paper_account_id IS NOT NULL
      OR NOT EXISTS (
        SELECT 1 FROM live_accounts WHERE live_account_id=NEW.account_id
      )
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'risk_decision account/mode mismatch');
END;

CREATE TRIGGER risk_decisions_no_update
BEFORE UPDATE ON risk_decisions
BEGIN
  SELECT RAISE(ABORT, 'risk_decision is immutable');
END;

CREATE TRIGGER risk_decisions_no_delete
BEFORE DELETE ON risk_decisions
BEGIN
  SELECT RAISE(ABORT, 'risk_decision is immutable');
END;

CREATE INDEX risk_decisions_account_idx
ON risk_decisions(executor_mode, account_id, created_at);
