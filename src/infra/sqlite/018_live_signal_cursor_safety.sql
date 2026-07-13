CREATE TABLE signal_ingest_sequences (
  signal_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  signal_id TEXT NOT NULL UNIQUE REFERENCES signals(signal_id)
);

INSERT INTO signal_ingest_sequences(signal_id)
SELECT signal_id FROM signals ORDER BY created_at,signal_id;

CREATE TRIGGER signals_assign_ingest_sequence
AFTER INSERT ON signals
BEGIN
  INSERT OR IGNORE INTO signal_ingest_sequences(signal_id) VALUES (NEW.signal_id);
END;

CREATE TRIGGER signal_ingest_sequences_no_update
BEFORE UPDATE ON signal_ingest_sequences
BEGIN
  SELECT RAISE(ABORT, 'signal_ingest_sequences is immutable');
END;

CREATE TRIGGER signal_ingest_sequences_no_delete
BEFORE DELETE ON signal_ingest_sequences
BEGIN
  SELECT RAISE(ABORT, 'signal_ingest_sequences is immutable');
END;

ALTER TABLE live_gate_state_transitions ADD COLUMN signal_boundary_sequence INTEGER;

ALTER TABLE live_consumer_checkpoints
ADD COLUMN cutoff_signal_sequence INTEGER NOT NULL DEFAULT 0 CHECK(cutoff_signal_sequence >= 0);

ALTER TABLE live_consumer_checkpoints
ADD COLUMN activation_transition_id TEXT;

ALTER TABLE live_consumer_checkpoints
ADD COLUMN last_signal_sequence INTEGER CHECK(last_signal_sequence IS NULL OR last_signal_sequence > 0);

CREATE TABLE live_signal_quarantines (
  live_account_id TEXT NOT NULL REFERENCES live_accounts(live_account_id),
  signal_id TEXT NOT NULL REFERENCES signals(signal_id),
  signal_sequence INTEGER NOT NULL REFERENCES signal_ingest_sequences(signal_sequence),
  failure_stage TEXT NOT NULL,
  reason TEXT NOT NULL,
  risk_decision_id TEXT REFERENCES risk_decisions(risk_decision_id),
  live_execution_id TEXT REFERENCES live_executions(live_execution_id),
  idempotency_key TEXT NOT NULL UNIQUE,
  ruleset_hash TEXT NOT NULL REFERENCES ruleset_registry(ruleset_hash),
  source_code_commit TEXT NOT NULL,
  source_code_dirty INTEGER NOT NULL,
  config_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(live_account_id,signal_id)
);

CREATE INDEX live_signal_quarantines_sequence_idx
ON live_signal_quarantines(live_account_id,signal_sequence);

CREATE TRIGGER live_signal_quarantines_no_update
BEFORE UPDATE ON live_signal_quarantines
BEGIN
  SELECT RAISE(ABORT, 'live_signal_quarantines is immutable');
END;

CREATE TRIGGER live_signal_quarantines_no_delete
BEFORE DELETE ON live_signal_quarantines
BEGIN
  SELECT RAISE(ABORT, 'live_signal_quarantines is immutable');
END;

CREATE TRIGGER rulesets_no_update
BEFORE UPDATE ON rulesets
BEGIN
  SELECT RAISE(ABORT, 'rulesets is immutable');
END;

CREATE TRIGGER rulesets_no_delete
BEFORE DELETE ON rulesets
BEGIN
  SELECT RAISE(ABORT, 'rulesets is immutable');
END;

CREATE TRIGGER ruleset_registry_no_update
BEFORE UPDATE ON ruleset_registry
BEGIN
  SELECT RAISE(ABORT, 'ruleset_registry is immutable');
END;

CREATE TRIGGER ruleset_registry_no_delete
BEFORE DELETE ON ruleset_registry
BEGIN
  SELECT RAISE(ABORT, 'ruleset_registry is immutable');
END;
