import { afterEach, describe, expect, it, vi } from "vitest";
import { PolymarketPublicApi } from "../src/adapters/polymarket-public.js";
import { PublicObserveDataSource } from "../src/observe/public-data-source.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Polymarket public API pagination", () => {
  const conditionId = `0x${"1".repeat(64)}`;

  it("loads every current-position page instead of silently truncating at 500", async () => {
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      requests.push(url);
      const offset = Number(new URL(url).searchParams.get("offset"));
      const position = (asset: string) => ({
        proxyWallet: "0x0000000000000000000000000000000000000001",
        asset,
        conditionId,
        size: "1",
        avgPrice: "0.5",
        currentValue: "0.5",
      });
      const rows = offset === 0
        ? Array.from({ length: 500 }, (_, index) => position(String(100_000 + index)))
        : [position("100500")];
      return new Response(JSON.stringify(rows), { status: 200 });
    }));

    const result = await new PolymarketPublicApi({ maxRetries: 0 }).allPositions(
      "0x0000000000000000000000000000000000000001",
    );

    expect(result.historyComplete).toBe(true);
    expect(result.rows).toHaveLength(501);
    expect(result.captures).toHaveLength(2);
    expect(result.merged.data).toHaveLength(501);
    expect(requests.map((url) => new URL(url).searchParams.get("offset"))).toEqual(["0", "500", "0"]);
  });

  it("fails closed when page zero changes during offset pagination", async () => {
    let firstPageRead = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const offset = Number(new URL(String(input)).searchParams.get("offset"));
      const row = (asset: string) => ({
        proxyWallet: "0x0000000000000000000000000000000000000001",
        asset,
        conditionId,
        size: "1",
        avgPrice: "0.5",
        currentValue: "0.5",
      });
      if (offset === 0) {
        firstPageRead += 1;
        return new Response(JSON.stringify(Array.from(
          { length: 500 },
          (_, index) => row(String(100_000 + (firstPageRead === 1 ? index : index + 1))),
        )), { status: 200 });
      }
      return new Response(JSON.stringify([row("100500")]), { status: 200 });
    }));

    await expect(new PolymarketPublicApi({ maxRetries: 0 }).allPositions(
      "0x0000000000000000000000000000000000000001",
    )).rejects.toThrow("PAGINATION_SNAPSHOT_DRIFT");
  });

  it("fails closed when a successful HTTP response violates the runtime schema", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([{ asset: "missing-fields" }]), { status: 200 })));
    await expect(new PolymarketPublicApi({ maxRetries: 0 }).allPositions(
      "0x0000000000000000000000000000000000000001",
    )).rejects.toThrow("API_SCHEMA_INVALID");
  });

  it("fails closed when concurrent pagination returns the same position twice", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const offset = Number(new URL(String(input)).searchParams.get("offset"));
      const row = (asset: string) => ({
        proxyWallet: "0x0000000000000000000000000000000000000001",
        asset,
        conditionId,
        size: "1",
        avgPrice: "0.5",
        currentValue: "0.5",
      });
      const rows = offset === 0
        ? Array.from({ length: 500 }, (_, index) => row(String(100_000 + index)))
        : [row("100499")];
      return new Response(JSON.stringify(rows), { status: 200 });
    }));

    await expect(new PolymarketPublicApi({ maxRetries: 0 }).allPositions(
      "0x0000000000000000000000000000000000000001",
    )).rejects.toThrow("API_SCHEMA_INVALID:positions:duplicate_asset:100499");
  });

  it("fails an incremental Observe poll when the event head page is saturated", async () => {
    const fetchedAt = "2026-07-13T00:00:00.000Z";
    const wallet = "0x0000000000000000000000000000000000000001";
    const api = {
      recentTrades: async () => ({
        url: "fake://trades",
        fetchedAt,
        latencyMs: 0,
        status: 200,
        data: Array.from({ length: 1_000 }, (_, index) => ({
          proxyWallet: wallet,
          transactionHash: `0x${index}`,
          conditionId: "0xcondition",
          asset: `asset-${index}`,
          side: "BUY" as const,
          price: "0.5",
          size: "1",
          timestamp: 1_700_000_000 + index,
        })),
      }),
      activity: async () => ({
        rows: [],
        captures: [{ url: "fake://activity", fetchedAt, latencyMs: 0, status: 200, data: [] }],
        historyComplete: true,
        stopReason: "END_OF_DATA",
      }),
      allPositions: async () => ({
        rows: [],
        captures: [{ url: "fake://positions", fetchedAt, latencyMs: 0, status: 200, data: [] }],
        historyComplete: true,
        stopReason: "END_OF_DATA",
        merged: { url: "fake://positions", fetchedAt, latencyMs: 0, status: 200, data: [] },
      }),
      pUsdBalance: async () => ({
        url: "fake://balance",
        fetchedAt,
        latencyMs: 0,
        status: 200,
        data: { jsonrpc: "2.0", id: 2, result: "0x0" },
      }),
    };

    await expect(new PublicObserveDataSource(api as unknown as PolymarketPublicApi).poll(wallet))
      .rejects.toThrow("OBSERVE_INCREMENTAL_PAGE_SATURATED");
  });

  it("accepts a full trade head only when it overlaps the recovered cursor", async () => {
    const fetchedAt = "2026-07-13T00:00:00.000Z";
    const wallet = "0x0000000000000000000000000000000000000001";
    const trade = (index: number) => ({
      proxyWallet: wallet,
      transactionHash: `0x${index}`,
      conditionId: "0xcondition",
      asset: `asset-${index}`,
      side: "BUY" as const,
      price: "0.5",
      size: "1",
      timestamp: 1_700_000_000 + index,
    });
    const page = Array.from({ length: 1_000 }, (_, index) => trade(index));
    const activityStarts: number[] = [];
    const paged = <T>(url: string, rows: T[]) => ({
      rows,
      captures: [{ url, fetchedAt, latencyMs: 0, status: 200, data: rows }],
      historyComplete: true,
      stopReason: "END_OF_DATA",
    });
    const api = {
      trades: async () => paged("fake://trades-recovery", page),
      activity: async () => paged("fake://activity-recovery", []),
      recentTrades: async () => ({ url: "fake://trades", fetchedAt, latencyMs: 0, status: 200, data: page }),
      activitySince: async (_address: string, start: number) => {
        activityStarts.push(start);
        return paged("fake://activity-since", []);
      },
      allPositions: async () => ({
        ...paged("fake://positions", []),
        merged: { url: "fake://positions", fetchedAt, latencyMs: 0, status: 200, data: [] },
      }),
      pUsdBalance: async () => ({
        url: "fake://balance",
        fetchedAt,
        latencyMs: 0,
        status: 200,
        data: { jsonrpc: "2.0", id: 2, result: "0x0" },
      }),
    };
    const source = new PublicObserveDataSource(api as unknown as PolymarketPublicApi);
    await expect(source.poll(wallet, 1_700_000_999)).resolves.toBeDefined();
    await expect(source.poll(wallet, undefined, 1_699_999_900))
      .resolves.toMatchObject({ trades: { data: { length: 1_000 } } });
    expect(activityStarts).toEqual([1_699_999_900]);
  });
});
