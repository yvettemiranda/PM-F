-- Persist the complete immutable economic and identity evidence that existed
-- before a Live order crossed the external side-effect boundary. Legacy rows
-- remain NULL because inventing historical signer/fee evidence is unsafe.
ALTER TABLE live_orders ADD COLUMN quote_vwap_price_units TEXT;
ALTER TABLE live_orders ADD COLUMN amount_micros TEXT;
ALTER TABLE live_orders ADD COLUMN budget_micros TEXT;
ALTER TABLE live_orders ADD COLUMN registered_wallet_address TEXT;
ALTER TABLE live_orders ADD COLUMN authorized_signer_address TEXT;
ALTER TABLE live_orders ADD COLUMN fee_rate_bps TEXT;
ALTER TABLE live_orders ADD COLUMN fee_exponent INTEGER;
ALTER TABLE live_orders ADD COLUMN fee_model_version TEXT;
ALTER TABLE live_orders ADD COLUMN signed_payload_json TEXT;
ALTER TABLE live_orders ADD COLUMN order_request_sha256 TEXT;
ALTER TABLE live_orders ADD COLUMN ruleset_hash TEXT REFERENCES ruleset_registry(ruleset_hash);
ALTER TABLE live_orders ADD COLUMN source_code_commit TEXT;
ALTER TABLE live_orders ADD COLUMN source_code_dirty INTEGER CHECK(source_code_dirty IS NULL OR source_code_dirty IN (0,1));
ALTER TABLE live_orders ADD COLUMN config_version TEXT;

CREATE TRIGGER live_orders_immutable_intent_no_update
BEFORE UPDATE OF
  live_execution_id,live_order_idempotency_key,market_id,asset_id,condition_id,
  side,order_type,price_units,size_micros,
  quote_vwap_price_units,amount_micros,budget_micros,registered_wallet_address,
  authorized_signer_address,fee_rate_bps,fee_exponent,fee_model_version,
  signed_payload_json,order_request_sha256,ruleset_hash,source_code_commit,
  source_code_dirty,config_version
ON live_orders
BEGIN
  SELECT RAISE(ABORT, 'live_order intent is immutable');
END;
