-- Validation waiting periods are reduced to one third while every historical
-- Campaign row remains byte-for-byte equivalent at the column level. SQLite
-- cannot alter CHECK constraints in place, so the immutable parent table is
-- rebuilt with relaxed lower bounds. The migration runner disables foreign
-- key enforcement only for this transaction and verifies all references
-- before committing.

DROP TRIGGER paper_validation_campaigns_no_update;
DROP TRIGGER paper_validation_campaigns_no_delete;
DROP TRIGGER observe_runs_campaign_binding_consistency;

CREATE TABLE paper_validation_campaigns_v226 (
  campaign_id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL REFERENCES monitor_targets(target_id),
  baseline_run_id TEXT NOT NULL REFERENCES position_baseline_runs(baseline_run_id),
  paper_account_id TEXT NOT NULL UNIQUE REFERENCES paper_accounts(paper_account_id),
  initial_balance_micros TEXT NOT NULL,
  required_active_runtime_ms INTEGER NOT NULL CHECK(required_active_runtime_ms >= 86400000),
  required_continuous_runtime_ms INTEGER NOT NULL CHECK(required_continuous_runtime_ms >= 14400000),
  qualifying_runtime_ms INTEGER NOT NULL CHECK(qualifying_runtime_ms >= 2400000),
  checkpoint_interval_ms INTEGER NOT NULL CHECK(checkpoint_interval_ms = 60000),
  max_checkpoint_gap_ms INTEGER NOT NULL CHECK(max_checkpoint_gap_ms = 90000),
  core_compatibility_hash TEXT NOT NULL,
  core_manifest_json TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  signal_version TEXT NOT NULL,
  strategy_version TEXT NOT NULL,
  risk_version TEXT NOT NULL,
  paper_version TEXT NOT NULL,
  ruleset_hash TEXT NOT NULL REFERENCES rulesets(ruleset_hash),
  config_version TEXT NOT NULL,
  source_code_commit TEXT NOT NULL,
  source_code_dirty INTEGER NOT NULL CHECK(source_code_dirty IN (0, 1)),
  execution_mode TEXT NOT NULL CHECK(execution_mode = 'PAPER'),
  live_gate_state TEXT NOT NULL CHECK(live_gate_state = 'LIVE_DISABLED'),
  created_at TEXT NOT NULL
);

INSERT INTO paper_validation_campaigns_v226(
  campaign_id,target_id,baseline_run_id,paper_account_id,initial_balance_micros,
  required_active_runtime_ms,required_continuous_runtime_ms,qualifying_runtime_ms,
  checkpoint_interval_ms,max_checkpoint_gap_ms,core_compatibility_hash,
  core_manifest_json,schema_version,signal_version,strategy_version,risk_version,
  paper_version,ruleset_hash,config_version,source_code_commit,source_code_dirty,
  execution_mode,live_gate_state,created_at
)
SELECT
  campaign_id,target_id,baseline_run_id,paper_account_id,initial_balance_micros,
  required_active_runtime_ms,required_continuous_runtime_ms,qualifying_runtime_ms,
  checkpoint_interval_ms,max_checkpoint_gap_ms,core_compatibility_hash,
  core_manifest_json,schema_version,signal_version,strategy_version,risk_version,
  paper_version,ruleset_hash,config_version,source_code_commit,source_code_dirty,
  execution_mode,live_gate_state,created_at
FROM paper_validation_campaigns;

DROP TABLE paper_validation_campaigns;
ALTER TABLE paper_validation_campaigns_v226 RENAME TO paper_validation_campaigns;

CREATE INDEX paper_validation_campaigns_target_idx
ON paper_validation_campaigns(target_id, created_at);

CREATE TRIGGER paper_validation_campaigns_no_update
BEFORE UPDATE ON paper_validation_campaigns
BEGIN
  SELECT RAISE(ABORT, 'paper_validation_campaigns is immutable');
END;

CREATE TRIGGER paper_validation_campaigns_no_delete
BEFORE DELETE ON paper_validation_campaigns
BEGIN
  SELECT RAISE(ABORT, 'paper_validation_campaigns is immutable');
END;

CREATE TRIGGER observe_runs_campaign_binding_consistency
BEFORE INSERT ON observe_runs
WHEN NEW.campaign_id IS NOT NULL
 AND NOT EXISTS (
   SELECT 1
   FROM paper_validation_sessions s
   JOIN paper_validation_campaigns c ON c.campaign_id=s.campaign_id
   WHERE s.campaign_id=NEW.campaign_id
     AND s.session_id=NEW.campaign_session_id
     AND c.target_id=NEW.target_id
     AND c.baseline_run_id=NEW.baseline_run_id
     AND s.schema_version=NEW.schema_version
     AND s.ruleset_hash=NEW.ruleset_hash
     AND s.source_code_commit=NEW.source_code_commit
     AND s.source_code_dirty=NEW.source_code_dirty
 )
BEGIN
  SELECT RAISE(ABORT, 'observe campaign session binding is invalid');
END;
