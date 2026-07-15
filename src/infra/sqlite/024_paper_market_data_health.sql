CREATE TABLE paper_market_data_health (
  paper_account_id TEXT NOT NULL REFERENCES paper_accounts(paper_account_id),
  asset_id TEXT NOT NULL,
  condition_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('HEALTHY','DEGRADED','FROZEN','SETTLEMENT_ONLY')),
  consecutive_failures INTEGER NOT NULL,
  consecutive_successes INTEGER NOT NULL,
  next_retry_at TEXT,
  last_error_code TEXT,
  last_error_message TEXT,
  last_failure_at TEXT,
  last_success_at TEXT,
  frozen_at TEXT,
  ruleset_hash TEXT NOT NULL REFERENCES rulesets(ruleset_hash),
  source_code_commit TEXT NOT NULL,
  source_code_dirty INTEGER NOT NULL,
  config_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(paper_account_id, asset_id, condition_id)
);

CREATE INDEX paper_market_data_health_retry_idx
ON paper_market_data_health(paper_account_id, state, next_retry_at);

ALTER TABLE paper_accounts
ADD COLUMN target_id TEXT REFERENCES monitor_targets(target_id);

CREATE INDEX paper_accounts_target_idx
ON paper_accounts(target_id, status);

CREATE TRIGGER paper_accounts_target_id_immutable
BEFORE UPDATE OF target_id ON paper_accounts
WHEN OLD.target_id IS NOT NEW.target_id
BEGIN
  SELECT RAISE(ABORT, 'paper account target binding is immutable');
END;
