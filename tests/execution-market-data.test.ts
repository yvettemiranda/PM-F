import { describe, expect, it } from "vitest";
import { PolymarketPublicApi, PolymarketPublicHttpError } from "../src/adapters/polymarket-public.js";
import { PublicExecutionMarketDataProvider } from "../src/execution/market-data.js";

describe("PublicExecutionMarketDataProvider", () => {
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
