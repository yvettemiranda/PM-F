import {
  OrderType,
  Side,
  SignatureTypeV1,
  SignatureTypeV2,
  type ClobClient,
  type OpenOrder,
  type SignedOrder,
  type Trade,
} from "@polymarket/clob-client-v2";
import { describe, expect, it, vi } from "vitest";
import { OrderSubmissionOutcomeUnknownError } from "../src/live/order-adapter.js";
import { PolymarketClobAdapter } from "../src/live/polymarket-clob-adapter.js";
import type { LiveOrderRequest } from "../src/live/live-types.js";

type ClobClientPort = Pick<
  ClobClient,
  "postOrder" | "cancelOrder" | "getOrder" | "getOpenOrders" | "getTrades" | "getFeeExponent"
>;

const signerAddress = "0x0000000000000000000000000000000000000001";
const zeroBytes32 = `0x${"0".repeat(64)}`;

function signedOrder(overrides: Partial<SignedOrder> = {}): SignedOrder {
  return {
    salt: "1",
    maker: signerAddress,
    signer: signerAddress,
    tokenId: "asset-1",
    makerAmount: "5000000",
    takerAmount: "10000000",
    side: Side.BUY,
    signatureType: SignatureTypeV2.EOA,
    timestamp: "1773014400000",
    metadata: zeroBytes32,
    builder: zeroBytes32,
    expiration: "0",
    signature: "0xsigned",
    ...overrides,
  } as SignedOrder;
}

function request(overrides: Partial<LiveOrderRequest> = {}): LiveOrderRequest {
  const sdkOrder = signedOrder();
  return {
    liveOrderId: "live-order-1",
    idempotencyKey: "live-order-idempotency-1",
    marketId: "condition-1",
    conditionId: "condition-1",
    assetId: "asset-1",
    side: "BUY",
    orderType: "FAK",
    priceUnits: "500000000000000000",
    quoteVwapPriceUnits: "500000000000000000",
    sizeMicros: "10000000",
    amountMicros: "5000000",
    budgetMicros: "5000000",
    registeredWalletAddress: signerAddress,
    authorizedSignerAddress: signerAddress,
    feeRateBps: "0",
    feeExponent: 1,
    feeModelVersion: "test-fee-v1",
    signedPayload: {
      signerAddress,
      signature: sdkOrder.signature,
      payloadHash: "payload-hash-1",
      signedOrder: sdkOrder,
      maxTotalCostMicros: "5000000",
      feeModelVersion: "test-fee-v1",
    },
    ...overrides,
  };
}

function openOrder(overrides: Partial<OpenOrder> = {}): OpenOrder {
  return {
    id: "order-1",
    status: "ORDER_STATUS_LIVE",
    owner: "api-owner",
    maker_address: signerAddress,
    market: "condition-1",
    asset_id: "asset-1",
    side: "BUY",
    original_size: "10",
    size_matched: "0",
    price: "0.5",
    associate_trades: [],
    outcome: "Yes",
    created_at: 1773014400,
    expiration: "0",
    order_type: "FAK",
    ...overrides,
  };
}

function trade(overrides: Partial<Trade> = {}): Trade {
  return {
    id: "trade-1",
    taker_order_id: "order-1",
    market: "condition-1",
    asset_id: "asset-1",
    side: Side.BUY,
    size: "10",
    fee_rate_bps: "700",
    price: "0.5",
    status: "CONFIRMED",
    match_time: "2026-07-09T00:00:00.000Z",
    last_update: "2026-07-09T00:00:01.000Z",
    outcome: "Yes",
    bucket_index: 0,
    owner: "api-owner",
    maker_address: signerAddress,
    maker_orders: [],
    trader_side: "TAKER",
    ...overrides,
  };
}

function client(overrides: Partial<Record<keyof ClobClientPort, unknown>> = {}): ClobClientPort {
  return {
    postOrder: vi.fn(async () => ({
      success: true,
      errorMsg: "",
      orderID: "order-1",
      tradeIDs: [],
      status: "live",
      takingAmount: "0",
      makingAmount: "0",
    })),
    cancelOrder: vi.fn(async () => ({ canceled: [], not_canceled: {} })),
    getOrder: vi.fn(async () => openOrder()),
    getOpenOrders: vi.fn(async () => []),
    getTrades: vi.fn(async () => []),
    getFeeExponent: vi.fn(async () => 1),
    ...overrides,
  } as unknown as ClobClientPort;
}

describe("PolymarketClobAdapter", () => {
  it("passes an actual SDK SignedOrder and maps a matched taker fill without Number precision loss", async () => {
    const largeSize = "9007199254.740991";
    const largeSizeMicros = "9007199254740991";
    const price = "0.123456789012345678";
    const priceUnits = "123456789012345678";
    const sdkOrder = signedOrder({
      makerAmount: "1111111109999999",
      takerAmount: largeSizeMicros,
    });
    const postOrder = vi.fn(async () => ({
      success: true,
      errorMsg: "",
      orderID: "order-1",
      tradeIDs: ["trade-1"],
      status: "matched",
      takingAmount: largeSize,
      makingAmount: "1111111109.999999",
    }));
    const getTrades = vi.fn(async () => [trade({ size: largeSize, price })]);
    const adapter = new PolymarketClobAdapter(client({ postOrder, getTrades }));

    const result = await adapter.submitOrder(request({
      priceUnits,
      sizeMicros: largeSizeMicros,
      amountMicros: sdkOrder.makerAmount,
      budgetMicros: sdkOrder.makerAmount,
      signedPayload: {
        signerAddress,
        signature: sdkOrder.signature,
        payloadHash: "payload-hash-large",
        signedOrder: sdkOrder,
        maxTotalCostMicros: sdkOrder.makerAmount,
        feeModelVersion: "test-fee-v1",
      },
    }));

    expect(postOrder).toHaveBeenCalledWith(sdkOrder, OrderType.FAK);
    expect(getTrades).toHaveBeenCalledWith({ id: "trade-1" }, true);
    expect(result.status).toBe("FILLED");
    expect(result.fills).toHaveLength(1);
    expect(result.fills[0]).toMatchObject({
      externalFillId: "trade-1:0",
      priceUnits,
      sizeMicros: largeSizeMicros,
    });
    const expectedNotional = (BigInt(largeSizeMicros) * BigInt(priceUnits) + 10n ** 18n - 1n) / 10n ** 18n;
    expect(result.fills[0]?.notionalMicros).toBe(expectedNotional.toString());
    expect(BigInt(result.fills[0]?.feeMicros ?? "0")).toBeGreaterThan(0n);
  });

  it("rejects a simplified signature object instead of casting it to SignedOrder", async () => {
    const postOrder = vi.fn();
    const adapter = new PolymarketClobAdapter(client({ postOrder }));

    await expect(adapter.submitOrder(request({
      signedPayload: {
        signerAddress,
        signature: "0xsigned",
        payloadHash: "payload-only",
      },
    }))).rejects.toThrow("SDK_SIGNED_ORDER_REQUIRED");
    expect(postOrder).not.toHaveBeenCalled();
  });

  it("rejects a signed order whose immutable economics do not match the approved request", async () => {
    const adapter = new PolymarketClobAdapter(client());
    const mismatched = signedOrder({ makerAmount: "5000001" });

    await expect(adapter.submitOrder(request({
      signedPayload: {
        signerAddress,
        signature: mismatched.signature,
        payloadHash: "payload-mismatch",
        signedOrder: mismatched,
      },
    }))).rejects.toThrow("SIGNED_ORDER_AMOUNT_MISMATCH");
  });

  it("rejects maker, signer and external fee evidence that differ from the registered request", async () => {
    const adapter = new PolymarketClobAdapter(client());
    const other = "0x0000000000000000000000000000000000000002";
    await expect(adapter.submitOrder(request({
      signedPayload: {
        ...request().signedPayload!,
        signedOrder: signedOrder({ maker: other }),
      },
    }))).rejects.toThrow("SIGNED_ORDER_MAKER_ACCOUNT_MISMATCH");
    await expect(adapter.submitOrder(request({
      signedPayload: {
        ...request().signedPayload!,
        signedOrder: signedOrder({ signer: other }),
      },
    }))).rejects.toThrow("SIGNED_ORDER_SIGNER_NOT_AUTHORIZED");
    await expect(adapter.submitOrder(request({
      signedPayload: {
        ...request().signedPayload!,
        signerAddress: other,
      },
    }))).rejects.toThrow("SIGNED_PAYLOAD_SIGNER_NOT_AUTHORIZED");
    await expect(adapter.submitOrder(request({
      signedPayload: {
        ...request().signedPayload!,
        feeModelVersion: "wrong-fee-model",
      },
    }))).rejects.toThrow("SIGNED_ORDER_FEE_MODEL_VERSION_MISMATCH");
    const postOrder = vi.fn();
    const exponentAdapter = new PolymarketClobAdapter(client({
      postOrder,
      getFeeExponent: vi.fn(async () => 2),
    }));
    await expect(exponentAdapter.submitOrder(request())).rejects.toThrow("CLOB_FEE_EXPONENT_MISMATCH");
    expect(postOrder).not.toHaveBeenCalled();
  });

  it("accepts a POLY_1271 order whose smart-account signer differs from its authorized browser EOA", async () => {
    const accountAddress = "0x0000000000000000000000000000000000000002";
    const sdkOrder = signedOrder({
      maker: accountAddress,
      signer: accountAddress,
      signatureType: SignatureTypeV2.POLY_1271,
    });
    const postOrder = vi.fn(async () => ({
      success: true,
      errorMsg: "",
      orderID: "order-1271",
      tradeIDs: [],
      status: "live",
      takingAmount: "0",
      makingAmount: "0",
    }));
    const adapter = new PolymarketClobAdapter(client({ postOrder }));

    await expect(adapter.submitOrder(request({
      registeredWalletAddress: accountAddress,
      signedPayload: {
        ...request().signedPayload!,
        signerAddress,
        signature: sdkOrder.signature,
        signedOrder: sdkOrder,
      },
    }))).resolves.toMatchObject({
      externalOrderId: "order-1271",
      status: "ACKNOWLEDGED",
    });
    expect(postOrder).toHaveBeenCalledWith(sdkOrder, OrderType.FAK);
  });

  it("rejects a BUY signed without fee-budget evidence before calling CLOB", async () => {
    const postOrder = vi.fn();
    const sdkOrder = signedOrder();
    const adapter = new PolymarketClobAdapter(client({ postOrder }));
    await expect(adapter.submitOrder(request({
      signedPayload: {
        signerAddress,
        signature: sdkOrder.signature,
        payloadHash: "fee-evidence-missing",
        signedOrder: sdkOrder,
      },
    }))).rejects.toThrow("SIGNED_ORDER_FEE_BUDGET_EVIDENCE_REQUIRED");
    expect(postOrder).not.toHaveBeenCalled();
  });

  it("independently rejects a signed BUY whose fee makes the approved budget insufficient", async () => {
    const postOrder = vi.fn();
    const sdkOrder = signedOrder();
    const adapter = new PolymarketClobAdapter(client({ postOrder, getFeeExponent: vi.fn(async () => 2) }));

    await expect(adapter.submitOrder(request({
      feeRateBps: "700",
      feeExponent: 2,
      signedPayload: {
        signerAddress,
        signature: sdkOrder.signature,
        payloadHash: "malicious-understated-fee",
        signedOrder: sdkOrder,
        // A signer assertion is not trusted: 5 pUSD cannot cover both the
        // signed notional and the non-zero platform fee.
        maxTotalCostMicros: "5000000",
        feeModelVersion: "test-fee-v1",
      },
    }))).rejects.toThrow("SIGNED_ORDER_TOTAL_COST_EXCEEDS_BUDGET");
    expect(postOrder).not.toHaveBeenCalled();
  });

  it("fails closed on an unknown CLOB order status", async () => {
    const adapter = new PolymarketClobAdapter(client({
      getOrder: vi.fn(async () => openOrder({ status: "MYSTERY_STATUS" })),
    }));

    await expect(adapter.getOrder("order-1")).rejects.toThrow("UNSUPPORTED_CLOB_ORDER_STATUS:MYSTERY_STATUS");
  });

  it("uses confirmed trade size exactly and derives partial fill state", async () => {
    const adapter = new PolymarketClobAdapter(client({
      getOrder: vi.fn(async () => openOrder({
        original_size: "3",
        size_matched: "1.234567",
        associate_trades: ["trade-partial"],
      })),
      getTrades: vi.fn(async () => [trade({ id: "trade-partial", size: "1.234567" })]),
    }));

    await expect(adapter.getOrder("order-1")).resolves.toMatchObject({
      status: "PARTIALLY_FILLED",
      filledSizeMicros: "1234567",
    });
  });

  it.each(["MATCHED", "MINED", "RETRYING"])(
    "does not expose a %s trade as a fill before CONFIRMED finality",
    async (tradeStatus) => {
      const adapter = new PolymarketClobAdapter(client({
        postOrder: vi.fn(async () => ({
          success: true,
          errorMsg: "",
          orderID: "order-1",
          tradeIDs: ["trade-pending"],
          status: "matched",
          takingAmount: "10",
          makingAmount: "5",
        })),
        getOrder: vi.fn(async () => openOrder({
          status: "MATCHED",
          original_size: "10",
          size_matched: "10",
          associate_trades: ["trade-pending"],
        })),
        getTrades: vi.fn(async () => [trade({ id: "trade-pending", status: tradeStatus })]),
      }));

      await expect(adapter.submitOrder(request())).resolves.toMatchObject({
        status: "ACKNOWLEDGED",
        confirmationPending: true,
        fills: [],
      });
      await expect(adapter.getOrder("order-1")).resolves.toMatchObject({
        status: "ACKNOWLEDGED",
        confirmationPending: true,
        filledSizeMicros: "0",
      });
      await expect(adapter.getFills("order-1")).resolves.toEqual([]);
    },
  );

  it("loads only associated trade ids and maps maker matched_amount rather than taker size", async () => {
    const getTrades = vi.fn(async ({ id }: { id?: string }) => id === "trade-maker" ? [trade({
      id: "trade-maker",
      taker_order_id: "someone-else",
      size: "100",
      trader_side: "MAKER",
      maker_orders: [{
        order_id: "order-1",
        owner: "api-owner",
        maker_address: signerAddress,
        matched_amount: "1.250001",
        price: "0.42",
        fee_rate_bps: "0",
        asset_id: "asset-1",
        outcome: "Yes",
        side: Side.SELL,
      }],
    })] : []);
    const adapter = new PolymarketClobAdapter(client({
      getOrder: vi.fn(async () => openOrder({
        status: "MATCHED",
        side: "SELL",
        original_size: "1.250001",
        size_matched: "1.250001",
        associate_trades: ["trade-maker"],
      })),
      getTrades,
    }));

    const fills = await adapter.getFills("order-1");

    expect(getTrades).toHaveBeenCalledTimes(1);
    expect(getTrades).toHaveBeenCalledWith({ id: "trade-maker" }, true);
    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({
      externalFillId: "trade-maker:0",
      priceUnits: "420000000000000000",
      sizeMicros: "1250001",
      notionalMicros: "525000",
      feeMicros: "0",
    });
  });

  it("calculates the official taker fee exactly and rounds to five USDC decimals", async () => {
    const adapter = new PolymarketClobAdapter(client({
      getOrder: vi.fn(async () => openOrder({
        status: "MATCHED",
        original_size: "100",
        size_matched: "100",
        associate_trades: ["trade-fee"],
      })),
      getTrades: vi.fn(async () => [trade({
        id: "trade-fee",
        size: "100",
        price: "0.5",
        fee_rate_bps: "700",
      })]),
    }));

    const fills = await adapter.getFills("order-1");

    expect(fills[0]?.feeMicros).toBe("1750000");
  });

  it("uses the official market fee exponent instead of assuming exponent one", async () => {
    const getFeeExponent = vi.fn(async () => 2);
    const adapter = new PolymarketClobAdapter(client({
      getOrder: vi.fn(async () => openOrder({
        status: "MATCHED",
        original_size: "100",
        size_matched: "100",
        associate_trades: ["trade-fee-exponent"],
      })),
      getTrades: vi.fn(async () => [trade({
        id: "trade-fee-exponent",
        size: "100",
        price: "0.5",
        fee_rate_bps: "700",
      })]),
      getFeeExponent,
    }));

    const fills = await adapter.getFills("order-1");

    expect(getFeeExponent).toHaveBeenCalledWith("asset-1");
    expect(fills[0]?.feeMicros).toBe("437500");
  });

  it("does not require fee metadata for a fee-free confirmed trade", async () => {
    const getFeeExponent = vi.fn(async () => { throw new Error("NO_FEE_METADATA"); });
    const adapter = new PolymarketClobAdapter(client({
      getOrder: vi.fn(async () => openOrder({
        status: "MATCHED",
        original_size: "10",
        size_matched: "10",
        associate_trades: ["trade-no-fee"],
      })),
      getTrades: vi.fn(async () => [trade({ id: "trade-no-fee", fee_rate_bps: "0" })]),
      getFeeExponent,
    }));

    const fills = await adapter.getFills("order-1");

    expect(fills[0]?.feeMicros).toBe("0");
    expect(getFeeExponent).not.toHaveBeenCalled();
  });

  it("accepts the official TRADE_STATUS_ prefix returned by the V2 API", async () => {
    const adapter = new PolymarketClobAdapter(client({
      getOrder: vi.fn(async () => openOrder({
        status: "ORDER_STATUS_MATCHED",
        original_size: "10",
        size_matched: "10",
        associate_trades: ["trade-prefixed"],
      })),
      getTrades: vi.fn(async () => [trade({ id: "trade-prefixed", status: "TRADE_STATUS_CONFIRMED" })]),
    }));

    await expect(adapter.getFills("order-1")).resolves.toHaveLength(1);
  });

  it("rejects a filled order when the API cannot provide its associated fills", async () => {
    const adapter = new PolymarketClobAdapter(client({
      getOrder: vi.fn(async () => openOrder({
        status: "MATCHED",
        original_size: "10",
        size_matched: "10",
        associate_trades: [],
      })),
    }));

    await expect(adapter.getFills("order-1")).rejects.toThrow("CLOB_MATCHED_ORDER_WITHOUT_ASSOCIATED_TRADES:order-1");
  });

  it("does not report cancellation success when the order id is in not_canceled", async () => {
    const adapter = new PolymarketClobAdapter(client({
      cancelOrder: vi.fn(async () => ({
        canceled: [],
        not_canceled: { "order-1": "Order already matched" },
      })),
      getOrder: vi.fn(async () => openOrder({
        status: "MATCHED",
        size_matched: "10",
        associate_trades: ["trade-cancelled-match"],
      })),
      getTrades: vi.fn(async () => [trade({ id: "trade-cancelled-match" })]),
    }));

    await expect(adapter.cancelOrder("order-1", "cancel-idempotency-1")).resolves.toMatchObject({
      cancelled: false,
      status: "FILLED",
    });
  });

  it("rejects non-zero builder fee orders until the ledger can account for builder fees", async () => {
    const adapter = new PolymarketClobAdapter(client());
    const withBuilder = signedOrder({ builder: `0x${"1".repeat(64)}` });

    await expect(adapter.submitOrder(request({
      signedPayload: {
        signerAddress,
        signature: withBuilder.signature,
        payloadHash: "payload-builder",
        signedOrder: withBuilder,
      },
    }))).rejects.toThrow("CLOB_BUILDER_FEE_UNSUPPORTED");
  });

  it("rejects legacy V1 orders after the official CLOB V2 cutover", async () => {
    const legacyOrder: SignedOrder = {
      salt: "1",
      maker: signerAddress,
      signer: signerAddress,
      taker: "0x0000000000000000000000000000000000000000",
      tokenId: "asset-1",
      makerAmount: "5000000",
      takerAmount: "10000000",
      expiration: "0",
      nonce: "0",
      feeRateBps: "0",
      side: Side.BUY,
      signatureType: SignatureTypeV1.EOA,
      signature: "0xsigned",
    };
    const adapter = new PolymarketClobAdapter(client());

    await expect(adapter.submitOrder(request({
      signedPayload: {
        signerAddress,
        signature: legacyOrder.signature,
        payloadHash: "payload-v1",
        signedOrder: legacyOrder,
      },
    }))).rejects.toThrow("CLOB_V1_SIGNED_ORDER_UNSUPPORTED");
  });

  it("treats success=false as failed even if the response status says live", async () => {
    const adapter = new PolymarketClobAdapter(client({
      postOrder: vi.fn(async () => ({
        success: false,
        errorMsg: "invalid order",
        orderID: "",
        tradeIDs: [],
        status: "live",
        takingAmount: "0",
        makingAmount: "0",
      })),
    }));

    await expect(adapter.submitOrder(request())).resolves.toMatchObject({
      externalOrderId: null,
      status: "FAILED",
      fills: [],
    });
  });

  it("marks a transport exception after POST /order starts as an unknown submission outcome", async () => {
    const adapter = new PolymarketClobAdapter(client({
      postOrder: vi.fn(async () => { throw new Error("NETWORK_RESPONSE_LOST"); }),
    }));

    const error = await adapter.submitOrder(request()).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(OrderSubmissionOutcomeUnknownError);
    expect((error as OrderSubmissionOutcomeUnknownError).message)
      .toBe("ORDER_SUBMISSION_OUTCOME_UNKNOWN:NETWORK_RESPONSE_LOST");
    expect((error as OrderSubmissionOutcomeUnknownError).partialResult).toBeNull();
  });

  it("preserves the external order id when post-submit lifecycle lookup is uncertain", async () => {
    const adapter = new PolymarketClobAdapter(client({
      postOrder: vi.fn(async () => ({
        success: true,
        errorMsg: "",
        orderID: "order-1",
        tradeIDs: ["trade-1"],
        status: "matched",
        takingAmount: "10",
        makingAmount: "5",
      })),
      getTrades: vi.fn(async () => { throw new Error("TRADE_LOOKUP_UNAVAILABLE"); }),
    }));

    const error = await adapter.submitOrder(request()).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(OrderSubmissionOutcomeUnknownError);
    expect((error as OrderSubmissionOutcomeUnknownError).partialResult).toMatchObject({
      externalOrderId: "order-1",
      status: "SUBMITTED",
      confirmationPending: true,
      fills: [],
    });
  });

  it("rejects CLOB decimals that exceed local ledger precision instead of rounding them", async () => {
    const adapter = new PolymarketClobAdapter(client({
      getOrder: vi.fn(async () => openOrder({ size_matched: "0.0000001" })),
    }));

    await expect(adapter.getOrder("order-1")).rejects.toThrow("Precision exceeds 6");
  });

  it("maps the official side enum without creating any client", () => {
    expect(PolymarketClobAdapter.officialSide("BUY")).toBe(Side.BUY);
    expect(PolymarketClobAdapter.officialSide("SELL")).toBe(Side.SELL);
  });
});
