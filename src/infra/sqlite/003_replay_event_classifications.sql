CREATE TABLE replay_event_classifications (
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
  UNIQUE(replay_run_id, source_event_key)
);

CREATE INDEX replay_event_classifications_event_idx
  ON replay_event_classifications(source_event_key, replay_run_id);
