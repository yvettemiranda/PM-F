import type { OrderAdapter } from "./order-adapter.js";
import type { CancelResult, LiveFillEvent, LiveOrderRequest, OrderStatus, OrderSubmitResult } from "./live-types.js";

export class DisabledOrderAdapter implements OrderAdapter {
  readonly adapterType = "DISABLED" as const;

  async submitOrder(_order: LiveOrderRequest): Promise<OrderSubmitResult> {
    throw new Error("ORDER_ADAPTER_DISABLED");
  }

  async cancelOrder(_orderId: string, _idempotencyKey: string): Promise<CancelResult> {
    throw new Error("ORDER_ADAPTER_DISABLED");
  }

  async getOrder(_orderId: string): Promise<OrderStatus> {
    throw new Error("ORDER_ADAPTER_DISABLED");
  }

  async getOpenOrders(): Promise<OrderStatus[]> {
    throw new Error("ORDER_ADAPTER_DISABLED");
  }

  async getFills(_orderId: string): Promise<LiveFillEvent[]> {
    throw new Error("ORDER_ADAPTER_DISABLED");
  }
}
