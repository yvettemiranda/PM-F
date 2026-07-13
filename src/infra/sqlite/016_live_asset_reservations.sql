CREATE TABLE live_asset_reservation_ledger (
  asset_reservation_ledger_id TEXT PRIMARY KEY,
  live_execution_id TEXT NOT NULL REFERENCES live_executions(live_execution_id),
  live_order_id TEXT REFERENCES live_orders(live_order_id),
  asset_id TEXT NOT NULL,
  entry_type TEXT NOT NULL CHECK(entry_type IN ('RESERVE','CONSUME','RELEASE')),
  delta_size_micros TEXT NOT NULL,
  remaining_after_micros TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE INDEX live_asset_reservation_execution_idx
ON live_asset_reservation_ledger(live_execution_id, created_at);

CREATE INDEX live_asset_reservation_asset_idx
ON live_asset_reservation_ledger(asset_id, created_at);

CREATE TRIGGER live_asset_reservation_ledger_no_update
BEFORE UPDATE ON live_asset_reservation_ledger
BEGIN
  SELECT RAISE(ABORT, 'live_asset_reservation_ledger is immutable');
END;

CREATE TRIGGER live_asset_reservation_ledger_no_delete
BEFORE DELETE ON live_asset_reservation_ledger
BEGIN
  SELECT RAISE(ABORT, 'live_asset_reservation_ledger is immutable');
END;
