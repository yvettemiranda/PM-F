import type { SignedOrder } from "@polymarket/clob-client-v2";
import type { PolymarketMarketRoute } from "./market-protocol.js";
import type {
  LiveAccountActionGateInput,
  LiveExecutionGateInput,
  LiveGateResult,
  LiveGateRuntimeEnvironment,
} from "./live-gate-types.js";

export type LiveOrderSide = "BUY" | "SELL";
export type LiveOrderType = "FAK" | "FOK" | "GTC" | "GTD";
export type LiveExecutionState =
  | "WAITING_EXECUTION"
  | "PARTIALLY_EXECUTED"
  | "EXECUTED"
  | "EXPIRED"
  | "REJECTED"
  | "CANCELLED"
  | "EXIT_PENDING"
  | "STOP_EXIT_PENDING"
  | "FAILED"
  | "FROZEN";
export type LiveOrderState =
  | "CREATED"
  | "SUBMITTED"
  | "ACKNOWLEDGED"
  | "PARTIALLY_FILLED"
  | "FILLED"
  | "FAILED"
  | "CANCEL_PENDING"
  | "CANCELLED"
  | "EXPIRED";
export type LivePositionState = "OPEN" | "PARTIALLY_CLOSED" | "SETTLEMENT_PENDING" | "CLOSED" | "REDEEMED" | "FROZEN";

export interface SignedPayload {
  readonly signerAddress: string;
  readonly signature: string;
  readonly payloadHash: string;
  /**
   * The exact SDK order that was signed. Fake and disabled signers intentionally
   * omit it; the authenticated CLOB adapter refuses to submit without it.
   */
  readonly signedOrder?: SignedOrder;
  /** Protocol/asset identity captured by the signer and retained for recovery. */
  readonly marketRoute?: PolymarketMarketRoute;
  /**
   * Optional exact order amounts produced by a fee-aware signer. They let the
   * executor reserve the approved capital budget while submitting a smaller
   * notional whose fees still fit inside that budget.
   */
  readonly orderAmountMicros?: string;
  readonly orderSizeMicros?: string;
  /** Conservative upper bound for notional plus all taker fees. */
  readonly maxTotalCostMicros?: string;
  readonly feeModelVersion?: string;
}

export interface LiveOrderRequest {
  liveOrderId: string;
  idempotencyKey: string;
  marketId: string;
  conditionId: string;
  assetId: string;
  side: LiveOrderSide;
  orderType: LiveOrderType;
  priceUnits: string;
  /** Full-depth executable VWAP observed immediately before signing. */
  quoteVwapPriceUnits: string;
  sizeMicros: string;
  /** Signed/submitted notional. */
  amountMicros: string;
  /** Immutable Risk Decision capital ceiling reserved by the executor. */
  budgetMicros: string;
  /** Wallet/funder and signer identities registered for this Live account. */
  registeredWalletAddress: string;
  authorizedSignerAddress: string;
  /** Fee evidence captured from the same fresh market-data plan. */
  feeRateBps: string;
  feeExponent: number;
  feeModelVersion: string;
  signedPayload: SignedPayload | null;
}

export interface LiveFillEvent {
  externalFillId: string;
  priceUnits: string;
  sizeMicros: string;
  notionalMicros: string;
  feeMicros: string;
  timestamp: string;
  raw: Record<string, unknown>;
}

export interface OrderSubmitResult {
  adapterType: string;
  externalOrderId: string | null;
  status: LiveOrderState;
  /**
   * True when the CLOB has matched the order but at least one related trade has
   * not reached CONFIRMED finality. Confirmed fills may still be present for a
   * partially finalized order. Callers must retain reservations and keep the
   * order recoverable while this flag is true.
   */
  confirmationPending?: boolean;
  /** True only when no further fill can be produced by this order. */
  terminal?: boolean;
  fills: LiveFillEvent[];
  raw: Record<string, unknown>;
}

export interface CancelResult {
  adapterType: string;
  cancelled: boolean;
  status: LiveOrderState;
  confirmationPending?: boolean;
  terminal?: boolean;
  raw: Record<string, unknown>;
}

export interface OrderStatus {
  adapterType: string;
  externalOrderId: string;
  status: LiveOrderState;
  /** See OrderSubmitResult.confirmationPending. */
  confirmationPending?: boolean;
  /** True only when no further fill can be produced by this order. */
  terminal?: boolean;
  filledSizeMicros: string;
  raw: Record<string, unknown>;
}

export interface WalletBalance {
  status: "AVAILABLE" | "UNAVAILABLE";
  balanceMicros: string | null;
  reason: string | null;
}

export interface WalletAllowance {
  status: "AVAILABLE" | "UNAVAILABLE";
  allowanceMicros: string | null;
  reason: string | null;
}

export interface WalletStatus {
  status: "ACTIVE" | "DISABLED" | "UNKNOWN";
  reason: string | null;
}

export interface WalletOutcomePosition {
  assetId: string;
  balanceMicros: string;
}

export interface WalletOutcomePositions {
  status: "AVAILABLE" | "UNAVAILABLE";
  positions: WalletOutcomePosition[];
  reason: string | null;
}

export interface LiveReconciliationCheck {
  name: string;
  passed: boolean;
  reason: string;
}

export interface LiveExecutionGate {
  readonly gateType: "PRODUCTION" | "FAKE";
  readonly runtimeEnvironment: LiveGateRuntimeEnvironment;
  checkExecution(input: LiveExecutionGateInput): Promise<LiveGateResult>;
  checkAccountAction(input: LiveAccountActionGateInput): Promise<LiveGateResult>;
}

export interface LiveExecutionSummary {
  liveExecutionId: string;
  state: LiveExecutionState;
  filledSizeMicros: string;
  filledNotionalMicros: string;
  feeMicros: string;
}
