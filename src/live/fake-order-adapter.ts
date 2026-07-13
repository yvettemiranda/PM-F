import type { OrderAdapter } from "./order-adapter.js";
import type { CancelResult, LiveFillEvent, LiveOrderRequest, LiveOrderState, OrderStatus, OrderSubmitResult } from "./live-types.js";

export class FakeOrderAdapter implements OrderAdapter {
  readonly adapterType = "FAKE" as const;
  private readonly orders = new Map<string, OrderStatus>();
  private readonly fillsByOrder = new Map<string, LiveFillEvent[]>();

  constructor(private readonly options: {
    fillRatioPpm?: number;
    forceStatus?: LiveOrderState;
  } = {}) {}

  async submitOrder(order: LiveOrderRequest): Promise<OrderSubmitResult> {
    const externalOrderId = `fake-${order.liveOrderId}`;
    const ratio = BigInt(this.options.fillRatioPpm ?? 1_000_000);
    const filledSize = (BigInt(order.sizeMicros) * ratio) / 1_000_000n;
    const quotePrice = BigInt(order.quoteVwapPriceUnits);
    const filledNotional = order.side === "BUY"
      ? (filledSize * quotePrice + 1_000_000_000_000_000_000n - 1n) / 1_000_000_000_000_000_000n
      : (filledSize * quotePrice) / 1_000_000_000_000_000_000n;
    const status = this.options.forceStatus
      ?? (filledSize === 0n ? "ACKNOWLEDGED" : filledSize < BigInt(order.sizeMicros) ? "PARTIALLY_FILLED" : "FILLED");
    const fill: LiveFillEvent[] = filledSize > 0n ? [{
      externalFillId: `${externalOrderId}-fill-1`,
      priceUnits: order.quoteVwapPriceUnits,
      sizeMicros: filledSize.toString(),
      notionalMicros: filledNotional.toString(),
      feeMicros: "0",
      timestamp: new Date(0).toISOString(),
      raw: { fake: true },
    }] : [];
    const orderStatus: OrderStatus = {
      adapterType: this.adapterType,
      externalOrderId,
      status,
      confirmationPending: false,
      terminal: !["CREATED", "SUBMITTED", "ACKNOWLEDGED"].includes(status),
      filledSizeMicros: filledSize.toString(),
      raw: { fake: true, idempotencyKey: order.idempotencyKey },
    };
    this.orders.set(externalOrderId, orderStatus);
    this.fillsByOrder.set(externalOrderId, fill);
    return {
      adapterType: this.adapterType,
      externalOrderId,
      status,
      confirmationPending: false,
      terminal: !["CREATED", "SUBMITTED", "ACKNOWLEDGED"].includes(status),
      fills: fill,
      raw: { fake: true, idempotencyKey: order.idempotencyKey },
    };
  }

  async cancelOrder(orderId: string, _idempotencyKey: string): Promise<CancelResult> {
    const existing = this.orders.get(orderId);
    this.orders.set(orderId, {
      adapterType: this.adapterType,
      externalOrderId: orderId,
      status: "CANCELLED",
      confirmationPending: false,
      terminal: true,
      filledSizeMicros: existing?.filledSizeMicros ?? "0",
      raw: { fake: true, cancelled: true },
    });
    return {
      adapterType: this.adapterType,
      cancelled: true,
      status: "CANCELLED",
      confirmationPending: false,
      terminal: true,
      raw: { fake: true },
    };
  }

  async getOrder(orderId: string): Promise<OrderStatus> {
    const order = this.orders.get(orderId);
    if (!order) throw new Error("FAKE_ORDER_NOT_FOUND");
    return order;
  }

  async getOpenOrders(): Promise<OrderStatus[]> {
    return [...this.orders.values()].filter((order) => order.terminal !== true);
  }

  async getFills(orderId: string): Promise<LiveFillEvent[]> {
    return this.fillsByOrder.get(orderId) ?? [];
  }
}
