import {
  OrderType,
  Side,
  isV2Order,
  type ClobClient,
  type OpenOrder,
  type SignedOrder,
  type Trade,
} from "@polymarket/clob-client-v2";
import { decimalToScaled, PRICE_SCALE_DIGITS, SHARE_SCALE_DIGITS } from "../domain/fixed.js";
import { conservativeClobBuyFeeMicros, roundedClobPlatformFeeMicros } from "../execution/clob-fee.js";
import { OrderSubmissionOutcomeUnknownError, type OrderAdapter } from "./order-adapter.js";
import type {
  CancelResult,
  LiveFillEvent,
  LiveOrderRequest,
  LiveOrderSide,
  LiveOrderState,
  OrderStatus,
  OrderSubmitResult,
} from "./live-types.js";

type ClobClientPort = Pick<
  ClobClient,
  "postOrder" | "cancelOrder" | "getOrder" | "getOpenOrders" | "getTrades" | "getFeeExponent"
>;
type JsonRecord = Record<string, unknown>;
type TradeLifecycleStatus = "MATCHED" | "MINED" | "CONFIRMED" | "RETRYING" | "FAILED";

interface TradeSnapshot {
  fills: LiveFillEvent[];
  pendingTradeIds: string[];
}

const PRICE_SCALE = 10n ** BigInt(PRICE_SCALE_DIGITS);

function rawRecord(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" ? value as JsonRecord : { response: value };
}

function baseStatus(status: string | undefined): LiveOrderState {
  const raw = status?.trim();
  if (!raw) throw new Error("CLOB_ORDER_STATUS_MISSING");
  const normalized = raw.toUpperCase().replace(/^ORDER_STATUS_/, "");
  if (["MATCHED", "FILLED", "CONFIRMED"].includes(normalized)) return "FILLED";
  if (["LIVE", "DELAYED", "UNMATCHED", "PENDING"].includes(normalized)) return "ACKNOWLEDGED";
  if (["CANCELLED", "CANCELED"].includes(normalized)) return "CANCELLED";
  if (normalized === "EXPIRED") return "EXPIRED";
  if (["FAILED", "REJECTED", "INVALID"].includes(normalized)) return "FAILED";
  throw new Error(`UNSUPPORTED_CLOB_ORDER_STATUS:${raw}`);
}

function matchedSize(order: OpenOrder): bigint {
  const original = decimalToScaled(order.original_size, SHARE_SCALE_DIGITS);
  const matched = decimalToScaled(order.size_matched, SHARE_SCALE_DIGITS);
  if (original < 0n || matched < 0n || matched > original) {
    throw new Error(`CLOB_ORDER_SIZE_INVALID:${order.id}`);
  }
  return matched;
}

function mapOpenOrderStatus(order: OpenOrder): LiveOrderState {
  const status = baseStatus(order.status);
  const original = decimalToScaled(order.original_size, SHARE_SCALE_DIGITS);
  const matched = matchedSize(order);
  if (status === "ACKNOWLEDGED" && matched > 0n) return "PARTIALLY_FILLED";
  if (status === "FILLED") {
    if (matched === 0n) throw new Error(`CLOB_FILLED_STATUS_WITH_ZERO_MATCH:${order.id}`);
    return matched < original ? "PARTIALLY_FILLED" : "FILLED";
  }
  return status;
}

function integerString(value: string, errorCode: string): bigint {
  if (!/^\d+$/.test(value)) throw new Error(errorCode);
  return BigInt(value);
}

function isZeroBytes(value: string): boolean {
  return /^0x0+$/i.test(value);
}

function validateSignedOrder(request: LiveOrderRequest, signedOrder: SignedOrder): void {
  if (signedOrder.tokenId !== request.assetId) throw new Error("SIGNED_ORDER_ASSET_MISMATCH");
  if (signedOrder.side !== PolymarketClobAdapter.officialSide(request.side)) {
    throw new Error("SIGNED_ORDER_SIDE_MISMATCH");
  }
  if (signedOrder.signer.toLowerCase() !== request.signedPayload?.signerAddress.toLowerCase()) {
    throw new Error("SIGNED_ORDER_SIGNER_MISMATCH");
  }
  if (signedOrder.signer.toLowerCase() !== request.authorizedSignerAddress.toLowerCase()) {
    throw new Error("SIGNED_ORDER_SIGNER_NOT_AUTHORIZED");
  }
  if (signedOrder.maker.toLowerCase() !== request.registeredWalletAddress.toLowerCase()) {
    throw new Error("SIGNED_ORDER_MAKER_ACCOUNT_MISMATCH");
  }
  if (integerString(String(signedOrder.feeRateBps), "SIGNED_ORDER_FEE_RATE_INVALID")
    !== integerString(request.feeRateBps, "ORDER_FEE_RATE_INVALID")) {
    throw new Error("SIGNED_ORDER_FEE_RATE_MISMATCH");
  }
  if (signedOrder.signature !== request.signedPayload?.signature) {
    throw new Error("SIGNED_ORDER_SIGNATURE_MISMATCH");
  }
  if (!isV2Order(signedOrder)) throw new Error("CLOB_V1_SIGNED_ORDER_UNSUPPORTED");
  if (!isZeroBytes(signedOrder.builder)) throw new Error("CLOB_BUILDER_FEE_UNSUPPORTED");

  const makerAmount = integerString(signedOrder.makerAmount, "SIGNED_ORDER_MAKER_AMOUNT_INVALID");
  const takerAmount = integerString(signedOrder.takerAmount, "SIGNED_ORDER_TAKER_AMOUNT_INVALID");
  const requestedAmount = integerString(request.amountMicros, "ORDER_AMOUNT_INVALID");
  const approvedBudget = integerString(request.budgetMicros, "ORDER_BUDGET_INVALID");
  const requestedSize = integerString(request.sizeMicros, "ORDER_SIZE_INVALID");
  const amountMatches = request.side === "BUY"
    ? makerAmount === requestedAmount && takerAmount === requestedSize
    : makerAmount === requestedSize && takerAmount === requestedAmount;
  if (!amountMatches) throw new Error("SIGNED_ORDER_AMOUNT_MISMATCH");
  if (request.side === "BUY") {
    const maxCostText = request.signedPayload?.maxTotalCostMicros;
    if (maxCostText === undefined || !request.signedPayload?.feeModelVersion) {
      throw new Error("SIGNED_ORDER_FEE_BUDGET_EVIDENCE_REQUIRED");
    }
    if (request.signedPayload.feeModelVersion !== request.feeModelVersion) {
      throw new Error("SIGNED_ORDER_FEE_MODEL_VERSION_MISMATCH");
    }
    const maxCost = integerString(maxCostText, "SIGNED_ORDER_MAX_COST_INVALID");
    const derivedFee = conservativeClobBuyFeeMicros({
      sizeMicros: requestedSize,
      upperPriceUnits: integerString(request.priceUnits, "ORDER_LIMIT_PRICE_INVALID"),
      feeRateBps: integerString(request.feeRateBps, "ORDER_FEE_RATE_INVALID"),
      feeExponent: request.feeExponent,
    });
    const derivedTotalCost = requestedAmount + derivedFee;
    if (derivedTotalCost > approvedBudget) {
      throw new Error("SIGNED_ORDER_TOTAL_COST_EXCEEDS_BUDGET");
    }
    if (requestedAmount > maxCost || maxCost < derivedTotalCost || maxCost > approvedBudget) {
      throw new Error("SIGNED_ORDER_MAX_COST_OUT_OF_BUDGET");
    }
  } else if (request.signedPayload?.feeModelVersion !== request.feeModelVersion) {
    throw new Error("SIGNED_ORDER_FEE_MODEL_VERSION_MISMATCH");
  }
}

function orderSide(value: string): LiveOrderSide {
  const normalized = value.toUpperCase();
  if (normalized === "BUY" || normalized === "SELL") return normalized;
  throw new Error(`UNSUPPORTED_CLOB_ORDER_SIDE:${value}`);
}

function nonZeroBuilderFee(value: string | undefined): boolean {
  return value !== undefined && !/^0+(?:\.0+)?$/.test(value);
}

function normalizeTimestamp(value: string): string {
  if (/^\d+$/.test(value)) {
    const numeric = BigInt(value);
    const milliseconds = value.length >= 13 ? numeric : numeric * 1_000n;
    const asNumber = Number(milliseconds);
    if (!Number.isSafeInteger(asNumber)) throw new Error("CLOB_TRADE_TIMESTAMP_INVALID");
    const date = new Date(asNumber);
    if (Number.isNaN(date.valueOf())) throw new Error("CLOB_TRADE_TIMESTAMP_INVALID");
    return date.toISOString();
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) throw new Error("CLOB_TRADE_TIMESTAMP_INVALID");
  return parsed.toISOString();
}

function tradeLifecycleStatus(trade: Trade): TradeLifecycleStatus {
  const tradeStatus = trade.status.trim().toUpperCase().replace(/^TRADE_STATUS_/, "");
  if (!["MATCHED", "MINED", "CONFIRMED", "RETRYING", "FAILED"].includes(tradeStatus)) {
    throw new Error(`UNSUPPORTED_CLOB_TRADE_STATUS:${trade.status}`);
  }
  return tradeStatus as TradeLifecycleStatus;
}

function fillFromTrade(
  trade: Trade,
  orderId: string,
  side: LiveOrderSide,
  feeExponent: number | null,
): LiveFillEvent | null {
  const lifecycle = tradeLifecycleStatus(trade);
  if (lifecycle === "FAILED") throw new Error(`CLOB_TRADE_FAILED:${trade.id}:${trade.bucket_index}`);

  let sizeText: string;
  let priceText: string;
  let feeRateBps: string;
  let isTaker: boolean;
  if (trade.taker_order_id === orderId) {
    if (orderSide(trade.side) !== side) throw new Error(`CLOB_TRADE_SIDE_MISMATCH:${trade.id}`);
    sizeText = trade.size;
    priceText = trade.price;
    feeRateBps = trade.fee_rate_bps;
    isTaker = true;
  } else {
    const makerOrder = trade.maker_orders.find((candidate) => candidate.order_id === orderId);
    if (!makerOrder) return null;
    const makerSide = makerOrder.side ? orderSide(makerOrder.side) : side;
    if (makerSide !== side) throw new Error(`CLOB_TRADE_SIDE_MISMATCH:${trade.id}`);
    if (nonZeroBuilderFee(makerOrder.builder_fee)) throw new Error("CLOB_BUILDER_FEE_UNSUPPORTED");
    sizeText = makerOrder.matched_amount;
    priceText = makerOrder.price;
    feeRateBps = makerOrder.fee_rate_bps;
    isTaker = false;
  }

  // A match is not a durable fill until the related trade reaches CONFIRMED.
  // MATCHED, MINED and RETRYING are deliberately left for recovery polling.
  if (lifecycle !== "CONFIRMED") return null;

  const sizeMicros = decimalToScaled(sizeText, SHARE_SCALE_DIGITS);
  const priceUnits = decimalToScaled(priceText, PRICE_SCALE_DIGITS);
  if (sizeMicros <= 0n) throw new Error(`CLOB_FILL_SIZE_INVALID:${trade.id}`);
  if (priceUnits <= 0n || priceUnits >= PRICE_SCALE) throw new Error(`CLOB_FILL_PRICE_INVALID:${trade.id}`);
  const product = sizeMicros * priceUnits;
  const notionalMicros = side === "BUY"
    ? (product + PRICE_SCALE - 1n) / PRICE_SCALE
    : product / PRICE_SCALE;
  const nonZeroPlatformFee = integerString(feeRateBps, "CLOB_FEE_RATE_INVALID") > 0n;
  if (isTaker && nonZeroPlatformFee && feeExponent === null) {
    throw new Error("CLOB_FEE_EXPONENT_MISSING");
  }
  const feeMicros = isTaker
    ? roundedClobPlatformFeeMicros({
      sizeMicros,
      priceUnits,
      feeRateBps: integerString(feeRateBps, "CLOB_FEE_RATE_INVALID"),
      feeExponent: feeExponent ?? 1,
    })
    : 0n;
  return {
    externalFillId: `${trade.id}:${trade.bucket_index}`,
    priceUnits: priceUnits.toString(),
    sizeMicros: sizeMicros.toString(),
    notionalMicros: notionalMicros.toString(),
    feeMicros: feeMicros.toString(),
    timestamp: normalizeTimestamp(trade.match_time),
    raw: {
      ...(trade as unknown as JsonRecord),
      niKFeeEvidence: {
        isTaker,
        platformFeeRateBps: feeRateBps,
        feeExponent: nonZeroPlatformFee ? feeExponent : 0,
        builderFeeMicros: "0",
        feeLedgerQuantumMicros: "10",
      },
    },
  };
}

export class PolymarketClobAdapter implements OrderAdapter {
  readonly adapterType = "POLYMARKET_CLOB" as const;

  constructor(private readonly client: ClobClientPort) {}

  async submitOrder(order: LiveOrderRequest): Promise<OrderSubmitResult> {
    if (!order.signedPayload) throw new Error("SIGNED_PAYLOAD_REQUIRED");
    const signedOrder = order.signedPayload.signedOrder;
    if (!signedOrder) throw new Error("SDK_SIGNED_ORDER_REQUIRED");
    validateSignedOrder(order, signedOrder);
    const liveFeeExponent = await this.client.getFeeExponent(order.assetId);
    if (!Number.isSafeInteger(liveFeeExponent) || liveFeeExponent < 1 || liveFeeExponent !== order.feeExponent) {
      throw new Error("CLOB_FEE_EXPONENT_MISMATCH");
    }
    const orderType = order.orderType === "FAK" ? OrderType.FAK
      : order.orderType === "FOK" ? OrderType.FOK
        : order.orderType === "GTD" ? OrderType.GTD
          : OrderType.GTC;
    let response: unknown;
    try {
      response = await this.client.postOrder(signedOrder, orderType);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "CLOB_POST_ORDER_FAILED";
      throw new OrderSubmissionOutcomeUnknownError(reason);
    }
    const raw = rawRecord(response);
    const externalOrderId = typeof raw.orderID === "string" && raw.orderID.length > 0 ? raw.orderID : null;
    try {
      const responseStatus = raw.success === false
        ? "FAILED"
        : typeof raw.status === "string"
          ? baseStatus(raw.status)
          : (() => { throw new Error("CLOB_ORDER_STATUS_MISSING"); })();
      if (responseStatus !== "FAILED" && !externalOrderId) throw new Error("CLOB_ORDER_ID_MISSING");

      const responseTradeIds = Array.isArray(raw.tradeIDs)
        ? raw.tradeIDs.filter((value): value is string => typeof value === "string" && value.length > 0)
        : [];
      let tradeSnapshot: TradeSnapshot = { fills: [], pendingTradeIds: [] };
      if (externalOrderId && (responseTradeIds.length > 0 || responseStatus === "FILLED")) {
        tradeSnapshot = responseTradeIds.length > 0
          ? await this.fillsForTradeIds(externalOrderId, order.side, responseTradeIds)
          : await this.tradeSnapshotForOrder(externalOrderId);
      }

      const fills = tradeSnapshot.fills;
      const filledSize = fills.reduce((total, fill) => total + BigInt(fill.sizeMicros), 0n);
      const requestedSize = BigInt(order.sizeMicros);
      if (filledSize > requestedSize) throw new Error("CLOB_FILL_EXCEEDS_REQUESTED_SIZE");
      let status = responseStatus;
      if (filledSize > 0n) status = filledSize < requestedSize ? "PARTIALLY_FILLED" : "FILLED";
      if (responseStatus === "FILLED" && fills.length === 0 && tradeSnapshot.pendingTradeIds.length > 0) {
        status = "ACKNOWLEDGED";
      } else if (responseStatus === "FILLED" && fills.length === 0) {
        throw new Error(`CLOB_FILLED_WITHOUT_FILLS:${externalOrderId ?? "UNKNOWN"}`);
      }
      return {
        adapterType: this.adapterType,
        externalOrderId,
        status,
        confirmationPending: tradeSnapshot.pendingTradeIds.length > 0,
        terminal: tradeSnapshot.pendingTradeIds.length === 0
          && (status === "FILLED"
            || status === "FAILED"
            || (["FAK", "FOK"].includes(order.orderType) && status === "PARTIALLY_FILLED")),
        fills,
        raw,
      };
    } catch (error) {
      // success=false explicitly proves rejection. Every other error happened
      // after POST /order returned, so preserve an uncertain intent and force
      // reconciliation instead of allowing an automatic retry.
      if (raw.success === false) throw error;
      const reason = error instanceof Error ? error.message : "CLOB_POST_RESPONSE_INVALID";
      throw new OrderSubmissionOutcomeUnknownError(reason, {
        adapterType: this.adapterType,
        externalOrderId,
        status: "SUBMITTED",
        confirmationPending: true,
        terminal: false,
        fills: [],
        raw: { adapterResponse: raw, lifecycleError: reason },
      });
    }
  }

  async cancelOrder(orderId: string, _idempotencyKey: string): Promise<CancelResult> {
    const response: unknown = await this.client.cancelOrder({ orderID: orderId });
    const raw = rawRecord(response);
    const cancelled = Array.isArray(raw.canceled) && raw.canceled.includes(orderId);
    if (cancelled) {
      return {
        adapterType: this.adapterType,
        cancelled: true,
        status: "CANCELLED",
        confirmationPending: false,
        terminal: true,
        raw,
      };
    }
    let status: LiveOrderState = "FAILED";
    let confirmationPending: boolean | undefined;
    let terminal: boolean | undefined;
    try {
      const current = await this.getOrder(orderId);
      status = current.status;
      confirmationPending = current.confirmationPending;
      terminal = current.terminal;
    } catch (error) {
      raw.statusLookupError = error instanceof Error ? error.message : String(error);
    }
    return {
      adapterType: this.adapterType,
      cancelled: false,
      status,
      ...(confirmationPending === undefined ? {} : { confirmationPending }),
      ...(terminal === undefined ? {} : { terminal }),
      raw,
    };
  }

  async getOrder(orderId: string): Promise<OrderStatus> {
    const order = await this.client.getOrder(orderId);
    if (order.id !== orderId) throw new Error(`CLOB_ORDER_ID_MISMATCH:${orderId}:${order.id}`);
    return this.mapOrder(order);
  }

  async getOpenOrders(): Promise<OrderStatus[]> {
    const orders = await this.client.getOpenOrders();
    const mapped: OrderStatus[] = [];
    // Keep authenticated history reads sequential to avoid bursting the CLOB
    // rate limit when many orders are open at once.
    for (const order of orders) mapped.push(await this.mapOrder(order));
    return mapped;
  }

  async getFills(orderId: string): Promise<LiveFillEvent[]> {
    return (await this.tradeSnapshotForOrder(orderId)).fills;
  }

  static officialSide(side: "BUY" | "SELL"): Side {
    return side === "BUY" ? Side.BUY : Side.SELL;
  }

  private async mapOrder(order: OpenOrder): Promise<OrderStatus> {
    const base = mapOpenOrderStatus(order);
    const matched = matchedSize(order);
    const snapshot = await this.tradeSnapshot(order);
    const confirmed = snapshot.fills.reduce((total, fill) => total + BigInt(fill.sizeMicros), 0n);
    const original = decimalToScaled(order.original_size, SHARE_SCALE_DIGITS);
    if (confirmed > matched) throw new Error(`CLOB_CONFIRMED_FILL_EXCEEDS_MATCHED_SIZE:${order.id}`);
    if (snapshot.pendingTradeIds.length === 0 && confirmed !== matched) {
      throw new Error(`CLOB_FILL_SIZE_MISMATCH:${order.id}:${matched}:${confirmed}`);
    }
    let status = base;
    if (!["CANCELLED", "EXPIRED", "FAILED"].includes(base)) {
      if (confirmed > 0n) status = confirmed < original ? "PARTIALLY_FILLED" : "FILLED";
      else if (base === "FILLED" && snapshot.pendingTradeIds.length > 0) status = "ACKNOWLEDGED";
    }
    const marketOrder = ["FAK", "FOK"].includes(order.order_type.toUpperCase());
    const terminal = snapshot.pendingTradeIds.length === 0
      && (["FILLED", "CANCELLED", "EXPIRED", "FAILED"].includes(status)
        || (marketOrder && status === "PARTIALLY_FILLED"));
    return {
      adapterType: this.adapterType,
      externalOrderId: order.id,
      status,
      confirmationPending: snapshot.pendingTradeIds.length > 0,
      terminal,
      filledSizeMicros: confirmed.toString(),
      raw: order as unknown as JsonRecord,
    };
  }

  private async tradeSnapshotForOrder(orderId: string): Promise<TradeSnapshot> {
    const order = await this.client.getOrder(orderId);
    if (order.id !== orderId) throw new Error(`CLOB_ORDER_ID_MISMATCH:${orderId}:${order.id}`);
    mapOpenOrderStatus(order);
    return this.tradeSnapshot(order);
  }

  private async tradeSnapshot(order: OpenOrder): Promise<TradeSnapshot> {
    const matched = matchedSize(order);
    if (matched > 0n && order.associate_trades.length === 0) {
      throw new Error(`CLOB_MATCHED_ORDER_WITHOUT_ASSOCIATED_TRADES:${order.id}`);
    }
    const snapshot = await this.fillsForTradeIds(order.id, orderSide(order.side), order.associate_trades);
    const confirmed = snapshot.fills.reduce((total, fill) => total + BigInt(fill.sizeMicros), 0n);
    if (confirmed > matched) throw new Error(`CLOB_CONFIRMED_FILL_EXCEEDS_MATCHED_SIZE:${order.id}`);
    if (snapshot.pendingTradeIds.length === 0 && confirmed !== matched) {
      throw new Error(`CLOB_FILL_SIZE_MISMATCH:${order.id}:${matched}:${confirmed}`);
    }
    return snapshot;
  }

  private async fillsForTradeIds(orderId: string, side: LiveOrderSide, tradeIds: string[]): Promise<TradeSnapshot> {
    const uniqueTradeIds = [...new Set(tradeIds)];
    const pages: Trade[][] = [];
    // Keep authenticated history reads sequential to avoid bursting the CLOB
    // rate limit when one order is associated with many trades.
    for (const tradeId of uniqueTradeIds) {
      const trades = await this.client.getTrades({ id: tradeId }, true);
      const exact = trades.filter((trade) => trade.id === tradeId);
      if (exact.length === 0) throw new Error(`CLOB_ASSOCIATED_TRADE_NOT_FOUND:${orderId}:${tradeId}`);
      pages.push(exact);
    }
    const associatedTrades = pages.flat().filter((trade) => {
      if (trade.taker_order_id === orderId) return true;
      return trade.maker_orders.some((candidate) => candidate.order_id === orderId);
    });
    if (associatedTrades.length !== uniqueTradeIds.length) {
      throw new Error(`CLOB_TRADES_NOT_ASSOCIATED_WITH_ORDER:${orderId}`);
    }
    const pendingTradeIds = associatedTrades
      .filter((trade) => ["MATCHED", "MINED", "RETRYING"].includes(tradeLifecycleStatus(trade)))
      .map((trade) => `${trade.id}:${trade.bucket_index}`);
    const fills: LiveFillEvent[] = [];
    const exponentByAsset = new Map<string, number>();
    // Fetch fee metadata sequentially with trade history reads. A missing or
    // unsupported exponent is a hard failure: silently assuming exponent=1
    // would corrupt the immutable fee ledger for fee-enabled markets.
    for (const trade of associatedTrades) {
      let exponent: number | null = null;
      if (
        tradeLifecycleStatus(trade) === "CONFIRMED"
        && trade.taker_order_id === orderId
        && integerString(trade.fee_rate_bps, "CLOB_FEE_RATE_INVALID") > 0n
      ) {
        exponent = exponentByAsset.get(trade.asset_id) ?? await this.client.getFeeExponent(trade.asset_id);
        if (!Number.isSafeInteger(exponent) || exponent < 1 || exponent > 4) {
          throw new Error(`CLOB_FEE_EXPONENT_INVALID:${trade.asset_id}`);
        }
        exponentByAsset.set(trade.asset_id, exponent);
      }
      const fill = fillFromTrade(trade, orderId, side, exponent);
      if (fill !== null) fills.push(fill);
    }
    const unique = new Map<string, LiveFillEvent>();
    for (const fill of fills) {
      if (unique.has(fill.externalFillId)) throw new Error(`CLOB_DUPLICATE_FILL:${fill.externalFillId}`);
      unique.set(fill.externalFillId, fill);
    }
    return { fills: [...unique.values()], pendingTradeIds };
  }
}
