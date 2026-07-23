export type WalletType = "PROXY_WALLET" | "EOA" | "SAFE" | "DEPOSIT_WALLET" | "UNKNOWN";
export type IdentityStatus = "IDENTITY_CONFIRMED" | "IDENTITY_UNKNOWN" | "IDENTITY_CONFLICT" | "INACTIVE";
export type SyncStatus = "SYNCED" | "MINOR_DIFF" | "MAJOR_DESYNC";
export type RuntimeMode = "OBSERVE_ONLY" | "PAPER" | "LIVE";
export type SignalType = "TARGET_BUY" | "TARGET_SELL";
export type SignalStatus = "CREATED" | "VALIDATING" | "READY" | "PUBLISHED" | "REJECTED" | "CANCELLED";
export type EventClassification =
  | "STANDARD_TRADE"
  | "GAP_TRADE"
  | "HISTORICAL_POSITION_SELL"
  | "COMBO_ACTIVITY"
  | "NEGATIVE_RISK_CONVERSION"
  | "NON_TRADE_ACTIVITY"
  | "UNRECOGNIZED";

export interface PublicProfile {
  createdAt?: string | null;
  proxyWallet?: string | null;
  name?: string | null;
  pseudonym?: string | null;
}

export interface PublicTrade {
  proxyWallet: string;
  transactionHash: string;
  /** Present only when an official Polygon OrderFilled log proves the maker
   * order identity. Data API rows do not expose this field. */
  orderHash?: string;
  conditionId: string;
  asset: string;
  side: "BUY" | "SELL";
  price: number | string;
  size: number | string;
  timestamp: number;
  outcome?: string;
  title?: string;
}

export interface PublicActivity {
  proxyWallet: string;
  timestamp: number;
  conditionId?: string;
  asset?: string;
  side?: "BUY" | "SELL";
  price?: number | string;
  size?: number | string;
  transactionHash: string;
  type: string;
  isCombo?: boolean;
  usdcSize?: number | string;
  outcome?: string;
  title?: string;
  eventSlug?: string;
}

export interface PublicPosition {
  proxyWallet: string;
  asset: string;
  conditionId: string;
  size: number | string;
  avgPrice: number | string;
  currentValue: number | string;
  title?: string;
  slug?: string;
  eventSlug?: string;
  outcome?: string;
  negativeRisk?: boolean;
  redeemable?: boolean;
  mergeable?: boolean;
}

export interface IdentityEvidence {
  source: string;
  outcome: "MATCH" | "NO_MATCH" | "UNAVAILABLE" | "CONFLICT";
  detail: string;
}

export interface WalletIdentityReport {
  walletAddress: string;
  walletType: WalletType;
  proxyWallet: string | null;
  chain: "polygon:137";
  firstSeenTime: string | null;
  firstSeenSource: string | null;
  lastActivityTime: string | null;
  tradeCount: number;
  tradeCountScope: string;
  positionCount: number;
  positionSnapshotTime: string;
  status: IdentityStatus;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  implementationAddress: string | null;
  evidence: IdentityEvidence[];
}

export interface SourceEvent {
  sourceEventKey: string;
  trade: PublicTrade;
  priceUnits: bigint;
  sizeMicros: bigint;
  gapEvent: boolean;
  isCombo: boolean;
}

export interface Signal {
  signalId: string;
  targetId: string;
  signalIdempotencyKey: string;
  signalType: SignalType;
  status: SignalStatus;
  sourceEventKey: string;
  walletAddress: string;
  asset: string;
  conditionId: string;
  targetPriceUnits: bigint;
  targetSizeMicros: bigint;
  sellRatioNumerator?: bigint;
  sellRatioDenominator?: bigint;
  reason: string;
  eventClassification: EventClassification;
  executionEligible: boolean;
  executionBlockReason?: string;
}
