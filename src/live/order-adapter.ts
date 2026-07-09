import type { CancelResult, LiveFillEvent, LiveOrderRequest, OrderStatus, OrderSubmitResult } from "./live-types.js";

export interface OrderAdapter {
  readonly adapterType: "DISABLED" | "FAKE" | "POLYMARKET_CLOB";
  submitOrder(order: LiveOrderRequest): Promise<OrderSubmitResult>;
  cancelOrder(orderId: string, idempotencyKey: string): Promise<CancelResult>;
  getOrder(orderId: string): Promise<OrderStatus>;
  getOpenOrders(): Promise<OrderStatus[]>;
  getFills(orderId: string): Promise<LiveFillEvent[]>;
}
