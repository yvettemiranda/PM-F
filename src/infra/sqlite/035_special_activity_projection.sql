CREATE TABLE split_projection_evidence (
  source_event_key TEXT PRIMARY KEY REFERENCES raw_events(source_event_key),
  observe_run_id TEXT NOT NULL REFERENCES observe_runs(observe_run_id),
  poll_id TEXT NOT NULL REFERENCES observe_polls(poll_id),
  transaction_hash TEXT NOT NULL UNIQUE,
  condition_id TEXT NOT NULL,
  outcome_assets_json TEXT NOT NULL,
  amount_micros TEXT NOT NULL,
  market_source_url TEXT NOT NULL,
  market_fetched_at TEXT NOT NULL,
  market_snapshot_json TEXT NOT NULL,
  market_snapshot_hash TEXT NOT NULL CHECK(length(market_snapshot_hash)=64),
  positions_snapshot_time TEXT NOT NULL,
  positions_snapshot_json TEXT NOT NULL,
  positions_snapshot_hash TEXT NOT NULL CHECK(length(positions_snapshot_hash)=64),
  evidence_hash TEXT NOT NULL UNIQUE CHECK(length(evidence_hash)=64),
  schema_version TEXT NOT NULL,
  signal_version TEXT NOT NULL,
  source_code_commit TEXT NOT NULL,
  source_code_dirty INTEGER NOT NULL CHECK(source_code_dirty IN (0,1)),
  verified_at TEXT NOT NULL
);

CREATE INDEX split_projection_evidence_run_idx
ON split_projection_evidence(observe_run_id, verified_at);

CREATE TRIGGER split_projection_evidence_no_update
BEFORE UPDATE ON split_projection_evidence
BEGIN
  SELECT RAISE(ABORT, 'split_projection_evidence is immutable');
END;

CREATE TRIGGER split_projection_evidence_no_delete
BEFORE DELETE ON split_projection_evidence
BEGIN
  SELECT RAISE(ABORT, 'split_projection_evidence is immutable');
END;
