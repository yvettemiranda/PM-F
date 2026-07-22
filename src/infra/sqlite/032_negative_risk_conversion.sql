CREATE TABLE negative_risk_conversion_evidence (
  source_event_key TEXT PRIMARY KEY REFERENCES raw_events(source_event_key),
  observe_run_id TEXT NOT NULL REFERENCES observe_runs(observe_run_id),
  poll_id TEXT NOT NULL REFERENCES observe_polls(poll_id),
  transaction_hash TEXT NOT NULL,
  group_condition_id TEXT NOT NULL,
  event_slug TEXT NOT NULL,
  source_asset_id TEXT NOT NULL,
  destination_legs_json TEXT NOT NULL,
  amount_micros TEXT NOT NULL,
  receipt_block_number TEXT,
  receipt_capture_id TEXT NOT NULL REFERENCES api_captures(capture_id),
  receipt_payload_hash TEXT NOT NULL CHECK(length(receipt_payload_hash)=64),
  evidence_hash TEXT NOT NULL UNIQUE CHECK(length(evidence_hash)=64),
  schema_version TEXT NOT NULL,
  signal_version TEXT NOT NULL,
  source_code_commit TEXT NOT NULL,
  source_code_dirty INTEGER NOT NULL CHECK(source_code_dirty IN (0,1)),
  verified_at TEXT NOT NULL,
  UNIQUE(transaction_hash)
);

CREATE INDEX negative_risk_conversion_evidence_run_idx
ON negative_risk_conversion_evidence(observe_run_id, verified_at);

CREATE TRIGGER negative_risk_conversion_evidence_no_update
BEFORE UPDATE ON negative_risk_conversion_evidence
BEGIN
  SELECT RAISE(ABORT, 'negative_risk_conversion_evidence is immutable');
END;

CREATE TRIGGER negative_risk_conversion_evidence_no_delete
BEFORE DELETE ON negative_risk_conversion_evidence
BEGIN
  SELECT RAISE(ABORT, 'negative_risk_conversion_evidence is immutable');
END;
