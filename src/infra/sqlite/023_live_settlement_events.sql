-- live_settlement_ledger is the mutable current-state projection. This table
-- is the append-only evidence ledger for every durable settlement state.
CREATE TABLE live_settlement_events (
  settlement_event_id TEXT PRIMARY KEY,
  live_position_id TEXT NOT NULL REFERENCES live_positions(live_position_id),
  live_execution_id TEXT REFERENCES live_executions(live_execution_id),
  event_sequence INTEGER NOT NULL CHECK(event_sequence > 0),
  from_status TEXT CHECK(from_status IS NULL OR from_status IN (
    'PENDING','RESOLVED','REDEEM_PENDING','REDEEMED','DISABLED','FAILED'
  )),
  to_status TEXT NOT NULL CHECK(to_status IN (
    'PENDING','RESOLVED','REDEEM_PENDING','REDEEMED','DISABLED','FAILED'
  )),
  redeem_amount_micros TEXT,
  pnl_micros TEXT,
  resolution_evidence_json TEXT NOT NULL,
  redeem_evidence_json TEXT NOT NULL,
  reason TEXT NOT NULL,
  ruleset_hash TEXT NOT NULL REFERENCES ruleset_registry(ruleset_hash),
  source_code_commit TEXT NOT NULL,
  source_code_dirty INTEGER NOT NULL CHECK(source_code_dirty IN (0,1)),
  config_version TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  UNIQUE(live_position_id,event_sequence)
);

CREATE INDEX live_settlement_events_position_idx
ON live_settlement_events(live_position_id,event_sequence);

-- Existing projections predate the event ledger. Preserve their current
-- evidence as one migration-time snapshot without inventing historical states
-- or pretending that the snapshot time is when the projected state occurred.
INSERT INTO live_settlement_events(
  settlement_event_id,live_position_id,live_execution_id,event_sequence,
  from_status,to_status,redeem_amount_micros,pnl_micros,resolution_evidence_json,
  redeem_evidence_json,reason,ruleset_hash,source_code_commit,source_code_dirty,
  config_version,idempotency_key,created_at
)
SELECT
  'migrated-settlement-event:' || s.settlement_ledger_id,
  s.live_position_id,
  s.live_execution_id,
  1,
  NULL,
  CASE s.settlement_status WHEN 'REDEEM_DISABLED' THEN 'DISABLED' ELSE s.settlement_status END,
  s.redeem_amount_micros,
  s.pnl_micros,
  s.resolution_snapshot_json,
  COALESCE((
    SELECT r.raw_response_json
    FROM live_redeems r
    WHERE r.live_position_id=s.live_position_id
    ORDER BY r.updated_at DESC,r.live_redeem_id DESC
    LIMIT 1
  ), '{}'),
  'MIGRATION_SNAPSHOT_CURRENT_PROJECTION',
  p.ruleset_hash,
  p.source_code_commit,
  p.source_code_dirty,
  p.config_version,
  'LIVE_SETTLEMENT_EVENT:MIGRATED:' || s.settlement_ledger_id,
  strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM live_settlement_ledger s
JOIN live_positions p ON p.live_position_id=s.live_position_id;

CREATE TRIGGER live_settlement_events_no_update
BEFORE UPDATE ON live_settlement_events
BEGIN
  SELECT RAISE(ABORT, 'live_settlement_events is immutable');
END;

CREATE TRIGGER live_settlement_events_no_delete
BEFORE DELETE ON live_settlement_events
BEGIN
  SELECT RAISE(ABORT, 'live_settlement_events is immutable');
END;
