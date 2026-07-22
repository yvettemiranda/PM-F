const TARGET_WALLET_PATTERN = /^0x[0-9a-f]{40}$/;

export function normalizeTargetWallet(value: string | undefined): string {
  if (value === undefined || value.trim().length === 0) {
    throw new Error("PAPER_CAMPAIGN_TARGET_WALLET_REQUIRED");
  }
  const normalized = value.trim().toLowerCase();
  if (!TARGET_WALLET_PATTERN.test(normalized)) {
    throw new Error(`PAPER_CAMPAIGN_TARGET_WALLET_INVALID:${value}`);
  }
  return normalized;
}
