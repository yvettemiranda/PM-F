import type { LiveGateResult } from "./live-gate-types.js";

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
  signerAddress: string;
  signature: string;
  payloadHash: string;
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
  sizeMicros: string;
  amountMicros: string;
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
  fills: LiveFillEvent[];
  raw: Record<string, unknown>;
}

export interface CancelResult {
  adapterType: string;
  cancelled: boolean;
  status: LiveOrderState;
  raw: Record<string, unknown>;
}

export interface OrderStatus {
  adapterType: string;
  externalOrderId: string;
  status: LiveOrderState;
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

export interface LiveReconciliationCheck {
  name: string;
  passed: boolean;
  reason: string;
}

export interface LiveExecutionGate {
  checkExecution(input: { signalId: string; riskDecisionId: string; rulesetHash: string }): Promise<LiveGateResult>;
}

export interface LiveExecutionSummary {
  liveExecutionId: string;
  state: LiveExecutionState;
  filledSizeMicros: string;
  filledNotionalMicros: string;
  feeMicros: string;
}
