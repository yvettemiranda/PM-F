CREATE TABLE live_wallet_position_baselines (
  live_account_id TEXT PRIMARY KEY REFERENCES live_accounts(live_account_id),
  status TEXT NOT NULL CHECK(status='CAPTURED'),
  position_count INTEGER NOT NULL CHECK(position_count>=0),
  snapshot_sha256 TEXT NOT NULL CHECK(length(snapshot_sha256)=64),
  source_code_commit TEXT NOT NULL,
  source_code_dirty INTEGER NOT NULL,
  config_version TEXT NOT NULL,
  captured_at TEXT NOT NULL
);

CREATE TABLE live_wallet_position_baseline_items (
  live_account_id TEXT NOT NULL REFERENCES live_wallet_position_baselines(live_account_id),
  asset_id TEXT NOT NULL,
  balance_micros TEXT NOT NULL CHECK(
    length(balance_micros)>0
    AND balance_micros NOT GLOB '*[^0-9]*'
    AND balance_micros!='0'
  ),
  created_at TEXT NOT NULL,
  PRIMARY KEY(live_account_id, asset_id)
);

CREATE TRIGGER live_wallet_position_baselines_no_update
BEFORE UPDATE ON live_wallet_position_baselines
BEGIN
  SELECT RAISE(ABORT, 'live wallet position baseline is immutable');
END;

CREATE TRIGGER live_wallet_position_baselines_no_delete
BEFORE DELETE ON live_wallet_position_baselines
BEGIN
  SELECT RAISE(ABORT, 'live wallet position baseline is immutable');
END;

CREATE TRIGGER live_wallet_position_baseline_items_insert_guard
BEFORE INSERT ON live_wallet_position_baseline_items
WHEN NOT EXISTS (
  SELECT 1 FROM live_wallet_position_baselines b
  WHERE b.live_account_id=NEW.live_account_id
)
OR (
  SELECT count(*) FROM live_wallet_position_baseline_items i
  WHERE i.live_account_id=NEW.live_account_id
) >= (
  SELECT b.position_count FROM live_wallet_position_baselines b
  WHERE b.live_account_id=NEW.live_account_id
)
BEGIN
  SELECT RAISE(ABORT, 'live wallet position baseline item count exceeded');
END;

CREATE TRIGGER live_wallet_position_baseline_items_no_update
BEFORE UPDATE ON live_wallet_position_baseline_items
BEGIN
  SELECT RAISE(ABORT, 'live wallet position baseline item is immutable');
END;

CREATE TRIGGER live_wallet_position_baseline_items_no_delete
BEFORE DELETE ON live_wallet_position_baseline_items
BEGIN
  SELECT RAISE(ABORT, 'live wallet position baseline item is immutable');
END;
