export interface MarketOutcomeSetSnapshot {
  condition_id: string;
  tokens: Array<{ token_id: string }>;
}

function normalizedAssets(assets: readonly string[]): string[] {
  return assets.map((asset) => asset.trim()).filter(Boolean).sort();
}

export function verifiedBinaryMarketOutcomeAssets(
  market: MarketOutcomeSetSnapshot,
  expectedConditionId: string,
): string[] {
  const conditionId = expectedConditionId.toLowerCase();
  if (market.condition_id.toLowerCase() !== conditionId) {
    throw new Error(`MARKET_OUTCOME_SET_CONDITION_MISMATCH:${conditionId}:${market.condition_id.toLowerCase()}`);
  }
  const assets = normalizedAssets(market.tokens.map((token) => token.token_id));
  if (assets.length !== 2 || new Set(assets).size !== 2) {
    throw new Error(`MARKET_OUTCOME_SET_NOT_BINARY:${conditionId}:${assets.length}`);
  }
  return assets;
}

export function assertExpectedBinaryMarketOutcomeAssets(
  market: MarketOutcomeSetSnapshot,
  expectedConditionId: string,
  expectedAssets: readonly string[],
): string[] {
  const officialAssets = verifiedBinaryMarketOutcomeAssets(market, expectedConditionId);
  const expected = normalizedAssets(expectedAssets);
  if (
    expected.length !== 2
    || new Set(expected).size !== 2
    || officialAssets.some((asset, index) => asset !== expected[index])
  ) {
    throw new Error(`MARKET_OUTCOME_SET_ASSET_MISMATCH:${expectedConditionId.toLowerCase()}`);
  }
  return officialAssets;
}
