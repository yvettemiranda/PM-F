import { afterEach, describe, expect, it, vi } from "vitest";
import { PolymarketPublicApi } from "../src/adapters/polymarket-public.js";
import { parseClobMarket, parsePublicActivity } from "../src/adapters/public-api-schema.js";

describe("Polymarket public API safety", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("rejects unsafe request configuration", () => {
    expect(() => new PolymarketPublicApi({ timeoutMs: 0 })).toThrow("INVALID_REQUEST_TIMEOUT");
    expect(() => new PolymarketPublicApi({ maxRetries: -1 })).toThrow("INVALID_MAX_RETRIES");
    expect(() => new PolymarketPublicApi({ backoffFactor: 0.5 })).toThrow("INVALID_BACKOFF_FACTOR");
    expect(() => new PolymarketPublicApi({ maxBackoffMs: 0 })).toThrow("INVALID_MAX_BACKOFF");
    expect(() => new PolymarketPublicApi({ polygonRpcUrl: "http://localhost:8545" })).toThrow("INVALID_POLYGON_RPC_URL");
  });

  it("rejects malformed wallet addresses and invalid page sizes before network access", async () => {
    const api = new PolymarketPublicApi();
    await expect(api.recentTrades("not-a-wallet")).rejects.toThrow("INVALID_WALLET_ADDRESS");
    await expect(api.recentActivity("0x0000000000000000000000000000000000000001", 0)).rejects.toThrow(
      "INVALID_ACTIVITY_LIMIT",
    );
    await expect(api.recentTrades("0x0000000000000000000000000000000000000001", 1_001)).rejects.toThrow(
      "INVALID_TRADES_LIMIT",
    );
    await expect(api.transactionReceipt("not-a-transaction")).rejects.toThrow("INVALID_TRANSACTION_HASH");
  });

  it("uses only eth_getTransactionReceipt and validates the public Polygon response", async () => {
    const transactionHash = `0x${"3".repeat(64)}`;
    const requests: Array<Record<string, unknown>> = [];
    const requestUrls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requestUrls.push(String(input));
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        result: {
          transactionHash,
          status: "0x1",
          blockNumber: "0x123",
          logs: [{
            address: "0x0000000000000000000000000000000000000001",
            topics: [`0x${"4".repeat(64)}`],
            data: "0x",
            logIndex: "0x0",
          }],
        },
      }), { status: 200 });
    }));

    const capture = await new PolymarketPublicApi({ maxRetries: 0 }).transactionReceipt(transactionHash);
    expect(capture.data.result).toMatchObject({ transactionHash, status: "0x1" });
    expect(requestUrls).toEqual(["https://polygon.drpc.org"]);
    expect(requests).toEqual([{
      jsonrpc: "2.0",
      id: 3,
      method: "eth_getTransactionReceipt",
      params: [transactionHash],
    }]);
  });

  it("rejects ambiguous or stringly-typed market resolution evidence", () => {
    const base = {
      condition_id: `0x${"1".repeat(64)}`,
      closed: true,
      active: false,
      accepting_orders: false,
      is_50_50_outcome: false,
      tokens: [
        { token_id: "1", outcome: "Yes", winner: true },
        { token_id: "2", outcome: "No", winner: false },
      ],
    };
    expect(parseClobMarket(base).closed).toBe(true);
    expect(() => parseClobMarket({ ...base, is_50_50_outcome: "false" })).toThrow(
      "API_SCHEMA_INVALID:market.is_50_50_outcome:boolean",
    );
    expect(() => parseClobMarket({
      ...base,
      tokens: [
        { token_id: "1", outcome: "Yes", winner: "false" },
        { token_id: "2", outcome: "No", winner: false },
      ],
    })).toThrow("API_SCHEMA_INVALID:market.tokens[0].winner:boolean");
    expect(() => parseClobMarket({
      ...base,
      tokens: [
        { token_id: "1", outcome: "Yes", winner: true },
        { token_id: "2", outcome: "No", winner: true },
      ],
    })).toThrow("API_SCHEMA_INVALID:market.tokens:multiple_winners");
    expect(() => parseClobMarket({ ...base, closed: false })).toThrow(
      "API_SCHEMA_INVALID:market.tokens:winner_before_close",
    );
  });

  it("normalizes non-trade Activity placeholder fields without weakening TRADE validation", () => {
    const base = {
      proxyWallet: "0x0000000000000000000000000000000000000001",
      transactionHash: `0x${"1".repeat(64)}`,
      timestamp: 1_783_903_511,
    };
    expect(parsePublicActivity([{
      ...base,
      type: "MAKER_REBATE",
      conditionId: "",
      asset: "",
      side: "",
      size: 4.3488,
      usdcSize: 4.3488,
      price: 0,
      eventSlug: "",
    }])[0]).toMatchObject({ type: "MAKER_REBATE", size: 4.3488 });
    expect(parsePublicActivity([{
      ...base,
      type: "CONVERSION",
      conditionId: `0x${"2".repeat(64)}`,
      size: 1,
      eventSlug: "",
    }])[0]).not.toHaveProperty("eventSlug");
    expect(() => parsePublicActivity([{
      ...base,
      type: "TRADE",
      conditionId: "",
      asset: "",
      side: "",
      size: 1,
      price: 0.5,
    }])).toThrow("API_SCHEMA_INVALID:activity[0]:trade_fields");
  });

  it("stops an in-flight public request when the caller aborts", async () => {
    const fetchStub = vi.fn(async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => (
      await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      })
    ));
    vi.stubGlobal("fetch", fetchStub);
    const api = new PolymarketPublicApi({ timeoutMs: 3_000, maxRetries: 3 });
    const controller = new AbortController();
    const request = api.orderbook("asset", controller.signal)
      .then(() => "COMPLETED", (error: unknown) => error instanceof Error ? error.message : String(error));

    await Promise.resolve();
    controller.abort(new Error("OPERATOR_STOP"));
    const result = await Promise.race([
      request,
      new Promise<"TIMEOUT">((resolvePromise) => setTimeout(() => resolvePromise("TIMEOUT"), 100)),
    ]);

    expect(result).toBe("OPERATOR_STOP");
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });
});
