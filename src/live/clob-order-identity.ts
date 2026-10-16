import type { LiveOrderSide } from "./live-types.js";

export interface ClobOrderIdentity {
  assetId: string;
  conditionId: string;
  side: LiveOrderSide;
}

interface OrderFields {
  id?: unknown;
  asset_id?: unknown;
  market?: unknown;
  side?: unknown;
}

interface TradeFields extends OrderFields {
  taker_order_id?: unknown;
  maker_orders?: unknown;
}

function side(value: unknown): LiveOrderSide {
  if (typeof value === "string") {
    const normalized = value.toUpperCase();
    if (normalized === "BUY" || normalized === "SELL") return normalized;
  }
  throw new Error(`UNSUPPORTED_CLOB_ORDER_SIDE:${String(value)}`);
}

export function clobOrderIdentity(order: OrderFields): ClobOrderIdentity {
  if (typeof order.asset_id !== "string" || !order.asset_id || typeof order.market !== "string" || !order.market) {
    throw new Error(`CLOB_ORDER_IDENTITY_MISSING:${String(order.id)}`);
  }
  return { assetId: order.asset_id, conditionId: order.market, side: side(order.side) };
}

export function validateClobOrderIdentity(order: OrderFields, expected: ClobOrderIdentity): void {
  const actual = clobOrderIdentity(order);
  if (actual.assetId !== expected.assetId) throw new Error(`CLOB_ORDER_ASSET_MISMATCH:${String(order.id)}`);
  if (actual.conditionId !== expected.conditionId) throw new Error(`CLOB_ORDER_MARKET_MISMATCH:${String(order.id)}`);
  if (actual.side !== expected.side) throw new Error(`CLOB_ORDER_SIDE_MISMATCH:${String(order.id)}`);
}

export function validateClobTradeIdentity(trade: TradeFields, orderId: string, identity: ClobOrderIdentity): void {
  if (trade.market !== identity.conditionId) throw new Error(`CLOB_TRADE_MARKET_MISMATCH:${String(trade.id)}`);
  if (trade.taker_order_id === orderId) {
    if (trade.asset_id !== identity.assetId) throw new Error(`CLOB_TRADE_ASSET_MISMATCH:${String(trade.id)}`);
    if (side(trade.side) !== identity.side) throw new Error(`CLOB_TRADE_SIDE_MISMATCH:${String(trade.id)}`);
    return;
  }
  const maker = Array.isArray(trade.maker_orders)
    ? trade.maker_orders.find((candidate: unknown): candidate is Record<string, unknown> =>
      candidate !== null && typeof candidate === "object" && "order_id" in candidate && candidate.order_id === orderId)
    : undefined;
  if (!maker) throw new Error(`CLOB_TRADES_NOT_ASSOCIATED_WITH_ORDER:${orderId}`);
  // Complementary-token matches can have a different top-level taker asset
  // and side. The SDK's maker asset is required, while maker.side is optional.
  if (maker.asset_id !== identity.assetId) throw new Error(`CLOB_TRADE_ASSET_MISMATCH:${String(trade.id)}`);
  if (maker.side !== undefined && side(maker.side) !== identity.side) {
    throw new Error(`CLOB_TRADE_SIDE_MISMATCH:${String(trade.id)}`);
  }
}
