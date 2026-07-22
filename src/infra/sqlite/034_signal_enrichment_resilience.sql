ALTER TABLE observe_polls
ADD COLUMN signal_enrichment_failures INTEGER NOT NULL DEFAULT 0;

ALTER TABLE observe_polls
ADD COLUMN warning_detail TEXT;

ALTER TABLE signal_execution_contexts
ADD COLUMN market_end_time_status TEXT NOT NULL DEFAULT 'VERIFIED'
CHECK(market_end_time_status IN ('VERIFIED', 'UNAVAILABLE'));

ALTER TABLE signal_execution_contexts
ADD COLUMN execution_deadline_at TEXT;

CREATE TABLE observe_signal_emissions_v2 (
  emission_id TEXT PRIMARY KEY,
  baseline_run_id TEXT NOT NULL REFERENCES position_baseline_runs(baseline_run_id),
  observe_run_id TEXT NOT NULL REFERENCES observe_runs(observe_run_id),
  poll_id TEXT NOT NULL REFERENCES observe_polls(poll_id),
  source_event_key TEXT NOT NULL REFERENCES raw_events(source_event_key),
  signal_id TEXT NOT NULL REFERENCES signals(signal_id),
  execution_eligible INTEGER NOT NULL,
  event_classification TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(baseline_run_id, signal_id)
);

INSERT INTO observe_signal_emissions_v2(
  emission_id,baseline_run_id,observe_run_id,poll_id,source_event_key,signal_id,
  execution_eligible,event_classification,created_at
)
SELECT emission_id,baseline_run_id,observe_run_id,poll_id,source_event_key,signal_id,
       execution_eligible,event_classification,created_at
FROM observe_signal_emissions;

DROP TABLE observe_signal_emissions;
ALTER TABLE observe_signal_emissions_v2 RENAME TO observe_signal_emissions;

CREATE INDEX observe_signal_emissions_source_event_idx
ON observe_signal_emissions(baseline_run_id, source_event_key);

DROP TRIGGER position_bucket_ledger_no_update;
DROP TRIGGER position_bucket_ledger_no_delete;

CREATE TABLE position_bucket_ledger_v2 (
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
  UNIQUE(replay_run_id, source_event_key, asset_id)
);

INSERT INTO position_bucket_ledger_v2(
  bucket_ledger_id,replay_run_id,source_event_key,asset_id,
  historical_before_micros,historical_after_micros,
  tracked_before_micros,tracked_after_micros,recognized_sell_micros,
  reason,ruleset_hash,created_at
)
SELECT bucket_ledger_id,replay_run_id,source_event_key,asset_id,
       historical_before_micros,historical_after_micros,
       tracked_before_micros,tracked_after_micros,recognized_sell_micros,
       reason,ruleset_hash,created_at
FROM position_bucket_ledger;

DROP TABLE position_bucket_ledger;
ALTER TABLE position_bucket_ledger_v2 RENAME TO position_bucket_ledger;

CREATE TRIGGER position_bucket_ledger_no_update
BEFORE UPDATE ON position_bucket_ledger
BEGIN
  SELECT RAISE(ABORT, 'position_bucket_ledger is immutable');
END;

CREATE TRIGGER position_bucket_ledger_no_delete
BEFORE DELETE ON position_bucket_ledger
BEGIN
  SELECT RAISE(ABORT, 'position_bucket_ledger is immutable');
END;

DROP TRIGGER replay_event_classifications_no_update;
DROP TRIGGER replay_event_classifications_no_delete;

CREATE TABLE replay_event_classifications_v2 (
  replay_classification_id TEXT PRIMARY KEY,
  replay_run_id TEXT NOT NULL REFERENCES replay_runs(replay_run_id),
  source_event_key TEXT NOT NULL REFERENCES raw_events(source_event_key),
  event_classification TEXT NOT NULL,
  signal_id TEXT,
  signal_type TEXT,
  execution_eligible INTEGER,
  reason TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  signal_version TEXT NOT NULL,
  replay_version TEXT NOT NULL,
  ruleset_hash TEXT NOT NULL REFERENCES rulesets(ruleset_hash),
  source_code_commit TEXT NOT NULL,
  source_code_dirty INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(replay_run_id, source_event_key, signal_id)
);

INSERT INTO replay_event_classifications_v2(
  replay_classification_id,replay_run_id,source_event_key,event_classification,
  signal_id,signal_type,execution_eligible,reason,schema_version,
  signal_version,replay_version,ruleset_hash,source_code_commit,
  source_code_dirty,created_at
)
SELECT replay_classification_id,replay_run_id,source_event_key,event_classification,
       signal_id,signal_type,execution_eligible,reason,schema_version,
       signal_version,replay_version,ruleset_hash,source_code_commit,
       source_code_dirty,created_at
FROM replay_event_classifications;

DROP TABLE replay_event_classifications;
ALTER TABLE replay_event_classifications_v2 RENAME TO replay_event_classifications;

CREATE INDEX replay_event_classifications_event_idx
ON replay_event_classifications(source_event_key, replay_run_id);

CREATE TRIGGER replay_event_classifications_no_update
BEFORE UPDATE ON replay_event_classifications
BEGIN
  SELECT RAISE(ABORT, 'replay_event_classifications is immutable');
END;

CREATE TRIGGER replay_event_classifications_no_delete
BEFORE DELETE ON replay_event_classifications
BEGIN
  SELECT RAISE(ABORT, 'replay_event_classifications is immutable');
END;
