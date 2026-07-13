import type { CancelResult, LiveFillEvent, LiveOrderRequest, OrderStatus, OrderSubmitResult } from "./live-types.js";

/**
 * The adapter crossed the external submit boundary but cannot prove whether the
 * order was accepted. This must never be treated as a normal failed request or
 * retried automatically.
 */
export class OrderSubmissionOutcomeUnknownError extends Error {
  readonly partialResult: OrderSubmitResult | null;

  constructor(reason: string, partialResult: OrderSubmitResult | null = null) {
    super(`ORDER_SUBMISSION_OUTCOME_UNKNOWN:${reason}`);
    this.name = "OrderSubmissionOutcomeUnknownError";
    this.partialResult = partialResult;
  }
}

export interface OrderAdapter {
  readonly adapterType: "DISABLED" | "FAKE" | "POLYMARKET_CLOB";
  submitOrder(order: LiveOrderRequest): Promise<OrderSubmitResult>;
  cancelOrder(orderId: string, idempotencyKey: string): Promise<CancelResult>;
  getOrder(orderId: string): Promise<OrderStatus>;
  getOpenOrders(): Promise<OrderStatus[]>;
  getFills(orderId: string): Promise<LiveFillEvent[]>;
}
