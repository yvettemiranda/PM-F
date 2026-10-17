import type { PolymarketMarketRoute } from "./market-protocol.js";

export interface RedeemCustody {
  /** Exact shares owned by this program, aggregated over every lot in asset. */
  managedSizeMicros: string;
  /** Resolution estimate, never a substitute for actual received collateral. */
  expectedPayoutMicros: string;
  walletAddress: string;
  lots: Array<{ positionId: string; sizeMicros: string; assetId?: string }>;
}

export interface RedeemInput {
  positionId: string;
  conditionId: string;
  assetId: string;
  idempotencyKey: string;
  /** Required by LIVE adapters. Optional only for legacy isolated fake tests. */
  custody?: RedeemCustody;
  marketRoute?: PolymarketMarketRoute;
}

export interface ConfirmedRedemptionEvidence {
  transactionHash: string;
  walletAddress: string;
  assetId: string;
  burnedSizeMicros: string;
  burnedAssets?: Array<{ assetId: string; sizeMicros: string }>;
  actualPayoutMicros: string;
  blockNumber: string;
  confirmations: number;
}

export interface RedeemResult {
  adapterType: "DISABLED" | "FAKE" | "LIVE";
  status: "DISABLED" | "SUBMITTED" | "CONFIRMED" | "FAILED";
  /** LIVE CONFIRMED is valid only with evidence checked against the intent. */
  evidence?: ConfirmedRedemptionEvidence;
  raw: Record<string, unknown>;
}

export interface RedeemAdapter {
  readonly adapterType: "DISABLED" | "FAKE" | "LIVE";
  redeem(input: RedeemInput, options?: {
    recoverOnly?: boolean;
    prepareOnly?: boolean;
    beforeSubmit?: () => void;
  }): Promise<RedeemResult>;
}
