-- Bind each Live account to the public address that is authorized to sign its
-- orders. This stores identity metadata only; no credential or signing
-- capability is persisted.
ALTER TABLE live_accounts
ADD COLUMN authorized_signer_address TEXT
CHECK(
  authorized_signer_address IS NULL
  OR (
    length(authorized_signer_address)=42
    AND substr(authorized_signer_address,1,2)='0x'
    AND lower(substr(authorized_signer_address,3)) NOT GLOB '*[^0-9a-f]*'
  )
);

-- Existing EOA accounts have an unambiguous signer identity. Other wallet
-- types deliberately remain NULL and must be reviewed and registered
-- explicitly before the Live Gate can pass.
UPDATE live_accounts
SET authorized_signer_address=(
  SELECT lower(w.wallet_address)
  FROM live_wallets w
  WHERE w.live_wallet_id=live_accounts.live_wallet_id
)
WHERE EXISTS (
  SELECT 1
  FROM live_wallets w
  WHERE w.live_wallet_id=live_accounts.live_wallet_id
    AND w.wallet_type='EOA'
    AND length(w.wallet_address)=42
    AND substr(w.wallet_address,1,2)='0x'
    AND lower(substr(w.wallet_address,3)) NOT GLOB '*[^0-9a-f]*'
);

CREATE TRIGGER live_accounts_authorized_signer_no_update
BEFORE UPDATE OF authorized_signer_address ON live_accounts
WHEN NEW.authorized_signer_address IS NOT OLD.authorized_signer_address
BEGIN
  SELECT RAISE(ABORT, 'live_account authorized signer is immutable');
END;
