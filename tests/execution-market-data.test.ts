import { describe, expect, it } from "vitest";
import { PolymarketPublicApi, PolymarketPublicHttpError } from "../src/adapters/polymarket-public.js";
import { PublicExecutionMarketDataProvider } from "../src/execution/market-data.js";

describe("PublicExecutionMarketDataProvider", () => {
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
      clobMarketInfo: async () => ({
        fetchedAt: "2026-07-08T00:00:00.000Z",
        url: "https://clob.polymarket.com/clob-markets/0xcondition",
        latencyMs: 11,
        status: 200,
        data: {
          tbf: 0,
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
