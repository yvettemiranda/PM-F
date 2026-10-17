CREATE TABLE IF NOT EXISTS live_redemption_journal (
  idempotency_key TEXT PRIMARY KEY,
  wallet_address TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  intent_json TEXT NOT NULL,
  intent_sha256 TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('PREPARED','SUBMITTING','SUBMITTED','CONFIRMED','FAILED')),
  transaction_hash TEXT UNIQUE,
  evidence_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS live_redemption_wallet_inflight
  ON live_redemption_journal(wallet_address) WHERE state IN ('SUBMITTING','SUBMITTED');
CREATE TRIGGER IF NOT EXISTS live_redemption_intent_immutable
BEFORE UPDATE OF idempotency_key,wallet_address,asset_id,intent_json,intent_sha256 ON live_redemption_journal
BEGIN SELECT RAISE(ABORT,'live redemption intent is immutable'); END;
CREATE TRIGGER IF NOT EXISTS live_redemption_hash_immutable
BEFORE UPDATE OF transaction_hash ON live_redemption_journal
WHEN OLD.transaction_hash IS NOT NULL AND NEW.transaction_hash IS NOT OLD.transaction_hash
BEGIN SELECT RAISE(ABORT,'live redemption transaction hash is immutable'); END;
CREATE TRIGGER IF NOT EXISTS live_redemption_confirmed_immutable
BEFORE UPDATE ON live_redemption_journal WHEN OLD.state='CONFIRMED'
BEGIN SELECT RAISE(ABORT,'confirmed live redemption is immutable'); END;
CREATE TRIGGER IF NOT EXISTS live_redemption_no_delete
BEFORE DELETE ON live_redemption_journal
BEGIN SELECT RAISE(ABORT,'live redemption journal is immutable'); END;
