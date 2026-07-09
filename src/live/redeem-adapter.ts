export interface RedeemResult {
  adapterType: "DISABLED" | "FAKE" | "LIVE";
  status: "DISABLED" | "SUBMITTED" | "CONFIRMED" | "FAILED";
  raw: Record<string, unknown>;
}

export interface RedeemAdapter {
  readonly adapterType: "DISABLED" | "FAKE" | "LIVE";
  redeem(input: {
    positionId: string;
    conditionId: string;
    assetId: string;
    idempotencyKey: string;
  }): Promise<RedeemResult>;
}
