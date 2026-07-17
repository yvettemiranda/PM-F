import { describe, expect, it } from "vitest";
import { PolymarketPublicApi, PolymarketPublicHttpError } from "../src/adapters/polymarket-public.js";
import { parseClobMarketInfo } from "../src/adapters/public-api-schema.js";
import {
  executableOrderbookAgeMs,
  PublicExecutionMarketDataProvider,
} from "../src/execution/market-data.js";

describe("PublicExecutionMarketDataProvider", () => {
  it("counts public request latency toward executable orderbook freshness", () => {
    const now = Date.parse("2026-07-08T00:00:00.000Z");
    expect(executableOrderbookAgeMs({
      marketSnapshotTime: "2026-07-07T23:00:00.000Z",
      receivedAt: "2026-07-08T00:00:00.000Z",
      publicCapture: {
        endpoint: "clob-orderbook",
        requestUrl: "https://clob.polymarket.com/book?token_id=asset",
        fetchedAt: "2026-07-08T00:00:00.000Z",
        latencyMs: 2_500.25,
        httpStatus: 200,
        payload: {},
      },
    }, now)).toBe(2_501);
  });

  it("accepts the current public market-info shape when legacy fee fields are absent", () => {
    expect(parseClobMarketInfo({
      t: [{ t: "123", o: "Yes" }],
      mts: 0.01,
      mos: 5,
    })).toMatchObject({ t: [{ t: "123", o: "Yes" }], mts: 0.01, mos: 5 });
  });

  it("preserves public min_order_size and tick_size for executor preflight", async () => {
    const api = {
      orderbook: async () => ({
        fetchedAt: "2026-07-08T00:00:00.000Z",
        url: "https://clob.test/book",
        latencyMs: 10,
        status: 200,
        data: {
          market: "0xcondition",
          asset_id: "asset",
          timestamp: "1783468800000",
          hash: "hash",
          bids: [],
          asks: [],
          min_order_size: "5",
          tick_size: "0.01",
        },
      }),
    } as unknown as PolymarketPublicApi;
    const provider = new PublicExecutionMarketDataProvider(api);
    await expect(provider.orderbook("asset", "0xcondition")).resolves.toMatchObject({
      minOrderSize: "5",
      tickSize: "0.01",
      publicCapture: {
        endpoint: "clob-orderbook",
        requestUrl: "https://clob.test/book",
        fetchedAt: "2026-07-08T00:00:00.000Z",
        latencyMs: 10,
        httpStatus: 200,
      },
    });
  });

  it("retains the immutable public market-info response used to derive fees", async () => {
    const api = {
      feeRate: async () => ({
        fetchedAt: "2026-07-08T00:00:00.000Z",
        url: "https://clob.polymarket.com/fee-rate?token_id=asset",
        latencyMs: 7,
        status: 200,
        data: { base_fee: 30 },
      }),
      clobMarketInfo: async () => ({
        fetchedAt: "2026-07-08T00:00:00.000Z",
        url: "https://clob.polymarket.com/clob-markets/0xcondition",
        latencyMs: 11,
        status: 200,
        data: {
          tbf: 30,
          mbf: 0,
          fd: { r: "0.01", e: "2", to: false },
          t: [{ t: "asset", o: "Yes" }],
          mts: 1,
          mos: 1,
        },
      }),
    } as unknown as PolymarketPublicApi;
    const provider = new PublicExecutionMarketDataProvider(api);
    await expect(provider.fee("asset", "0xcondition")).resolves.toMatchObject({
      status: "AVAILABLE",
      feeRatePpm: "10000",
      exponent: 2,
      publicCapture: {
        endpoint: "clob-market-info",
        requestUrl: "https://clob.polymarket.com/clob-markets/0xcondition",
        fetchedAt: "2026-07-08T00:00:00.000Z",
        latencyMs: 11,
        httpStatus: 200,
      },
    });
  });

  it("uses an explicit public zero fee-rate response without guessing a fee model", async () => {
    let marketInfoCalls = 0;
    const api = {
      feeRate: async (_assetId: string, signal?: AbortSignal) => {
        expect(signal).toBeInstanceOf(AbortSignal);
        return {
          fetchedAt: "2026-07-08T00:00:00.000Z",
          url: "https://clob.polymarket.com/fee-rate?token_id=asset",
          latencyMs: 7,
          status: 200,
          data: { base_fee: 0 },
        };
      },
      clobMarketInfo: async () => {
        marketInfoCalls += 1;
        throw new Error("ZERO_FEE_MUST_NOT_DEPEND_ON_LEGACY_MARKET_INFO");
      },
    } as unknown as PolymarketPublicApi;
    const provider = new PublicExecutionMarketDataProvider(api);
    const controller = new AbortController();

    await expect(provider.fee("asset", "0xcondition", controller.signal)).resolves.toMatchObject({
      status: "AVAILABLE",
      baseFee: 0,
      feeRatePpm: "0",
      exponent: 1,
      sourceUrl: "https://clob.polymarket.com/fee-rate?token_id=asset",
      publicCapture: {
        endpoint: "clob-fee-rate",
        requestUrl: "https://clob.polymarket.com/fee-rate?token_id=asset",
        fetchedAt: "2026-07-08T00:00:00.000Z",
        latencyMs: 7,
        httpStatus: 200,
        payload: { base_fee: 0 },
      },
    });
    expect(marketInfoCalls).toBe(0);
  });

  it("keeps a non-zero fee unavailable when the public response lacks curve details", async () => {
    const api = {
      feeRate: async () => ({
        fetchedAt: "2026-07-08T00:00:00.000Z",
        url: "https://clob.polymarket.com/fee-rate?token_id=asset",
        latencyMs: 7,
        status: 200,
        data: { base_fee: 30 },
      }),
      clobMarketInfo: async () => ({
        fetchedAt: "2026-07-08T00:00:00.100Z",
        url: "https://clob.polymarket.com/clob-markets/0xcondition",
        latencyMs: 8,
        status: 200,
        data: {
          t: [{ t: "asset", o: "Yes" }],
          mts: 0.01,
          mos: 5,
        },
      }),
    } as unknown as PolymarketPublicApi;
    const provider = new PublicExecutionMarketDataProvider(api);

    await expect(provider.fee("asset", "0xcondition")).resolves.toMatchObject({
      status: "UNAVAILABLE",
      baseFee: null,
      feeRatePpm: null,
      exponent: null,
    });
  });

  it("does not turn caller cancellation into a fee-unavailable result", async () => {
    const controller = new AbortController();
    const cancellation = new Error("operator cancelled");
    const api = {
      feeRate: async () => {
        controller.abort(cancellation);
        throw cancellation;
      },
    } as unknown as PolymarketPublicApi;
    const provider = new PublicExecutionMarketDataProvider(api);

    await expect(provider.fee("asset", "0xcondition", controller.signal)).rejects.toBe(cancellation);
  });

  it("maps only the explicit no-orderbook 404 to a typed safe-freeze error", async () => {
    const api = {
      orderbook: async () => {
        throw new PolymarketPublicHttpError(404, "No orderbook exists for the requested token", "https://clob.test/book");
      },
    } as unknown as PolymarketPublicApi;
    const provider = new PublicExecutionMarketDataProvider(api);

    await expect(provider.orderbook("asset", "condition")).rejects.toMatchObject({
      name: "OrderbookUnavailableError",
      code: "NO_ORDERBOOK_EXISTS",
      assetId: "asset",
      conditionId: "condition",
    });
  });

  it("does not misclassify an unrelated 404 as a missing orderbook", async () => {
    const original = new PolymarketPublicHttpError(404, "route not found", "https://clob.test/book");
    const api = {
      orderbook: async () => { throw original; },
    } as unknown as PolymarketPublicApi;
    const provider = new PublicExecutionMarketDataProvider(api);

    await expect(provider.orderbook("asset", "condition")).rejects.toBe(original);
  });
});
