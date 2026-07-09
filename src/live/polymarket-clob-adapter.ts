import { OrderType, Side, type ClobClient } from "@polymarket/clob-client-v2";
import type { OrderAdapter } from "./order-adapter.js";
import type { CancelResult, LiveFillEvent, LiveOrderRequest, LiveOrderState, OrderStatus, OrderSubmitResult } from "./live-types.js";

type ClobClientPort = Pick<ClobClient, "postOrder" | "cancelOrder" | "getOrder" | "getOpenOrders" | "getTrades">;

function mapStatus(status: string | undefined): LiveOrderState {
  const normalized = (status ?? "").toLowerCase();
  if (["matched", "filled", "confirmed"].includes(normalized)) return "FILLED";
  if (["live", "delayed", "unmatched"].includes(normalized)) return "ACKNOWLEDGED";
  if (["cancelled", "canceled"].includes(normalized)) return "CANCELLED";
  if (["expired"].includes(normalized)) return "EXPIRED";
  if (["failed", "rejected"].includes(normalized)) return "FAILED";
  return "ACKNOWLEDGED";
}

export class PolymarketClobAdapter implements OrderAdapter {
  readonly adapterType = "POLYMARKET_CLOB" as const;

  constructor(private readonly client: ClobClientPort) {}

  async submitOrder(order: LiveOrderRequest): Promise<OrderSubmitResult> {
    if (!order.signedPayload) throw new Error("SIGNED_PAYLOAD_REQUIRED");
    const orderType = order.orderType === "FAK" ? OrderType.FAK
      : order.orderType === "FOK" ? OrderType.FOK
        : order.orderType === "GTD" ? OrderType.GTD
          : OrderType.GTC;
    const response = await this.client.postOrder(order.signedPayload as never, orderType);
    const externalOrderId = typeof response?.orderID === "string" ? response.orderID : null;
    return {
      adapterType: this.adapterType,
      externalOrderId,
      status: mapStatus(response?.status),
      fills: [],
      raw: response && typeof response === "object" ? response as Record<string, unknown> : { response },
    };
  }

  async cancelOrder(orderId: string, _idempotencyKey: string): Promise<CancelResult> {
    const response = await this.client.cancelOrder({ orderID: orderId });
    return {
      adapterType: this.adapterType,
      cancelled: response?.canceled?.includes?.(orderId) ?? response?.success === true,
      status: "CANCELLED",
      raw: response && typeof response === "object" ? response as Record<string, unknown> : { response },
    };
  }

  async getOrder(orderId: string): Promise<OrderStatus> {
    const order = await this.client.getOrder(orderId);
    return {
      adapterType: this.adapterType,
      externalOrderId: order.id,
      status: mapStatus(order.status),
      filledSizeMicros: "0",
      raw: order as unknown as Record<string, unknown>,
    };
  }

  async getOpenOrders(): Promise<OrderStatus[]> {
    const orders = await this.client.getOpenOrders();
    return orders.map((order) => ({
      adapterType: this.adapterType,
      externalOrderId: order.id,
      status: mapStatus(order.status),
      filledSizeMicros: "0",
      raw: order as unknown as Record<string, unknown>,
    }));
  }

  async getFills(orderId: string): Promise<LiveFillEvent[]> {
    const trades = await this.client.getTrades({ id: orderId });
    return trades.map((trade) => ({
      externalFillId: trade.id,
      priceUnits: Math.round(Number(trade.price) * 1e18).toString(),
      sizeMicros: Math.round(Number(trade.size) * 1e6).toString(),
      notionalMicros: Math.round(Number(trade.price) * Number(trade.size) * 1e6).toString(),
      feeMicros: "0",
      timestamp: trade.match_time,
      raw: trade as unknown as Record<string, unknown>,
    }));
  }

  static officialSide(side: "BUY" | "SELL"): Side {
    return side === "BUY" ? Side.BUY : Side.SELL;
  }
}
