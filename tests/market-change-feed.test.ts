import { describe, expect, it } from "vitest";
import {
  POLYMARKET_MARKET_WEBSOCKET_URL,
  PublicClobMarketChangeFeed,
  type MarketWebSocket,
} from "../src/execution/market-change-feed.js";

class FakeMarketWebSocket implements MarketWebSocket {
  readyState = 0;
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, Array<(event: { data?: unknown }) => void>>();

  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
    const values = this.listeners.get(type) ?? [];
    values.push(listener);
    this.listeners.set(type, values);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
  }

  open(): void {
    this.readyState = 1;
    for (const listener of this.listeners.get("open") ?? []) listener({});
  }

  message(value: unknown): void {
    for (const listener of this.listeners.get("message") ?? []) {
      listener({ data: typeof value === "string" ? value : JSON.stringify(value) });
    }
  }
}

describe("PublicClobMarketChangeFeed", () => {
  it("subscribes only to pending assets and reports official market book changes", () => {
    let createdUrl: string | null = null;
    const socket = new FakeMarketWebSocket();
    const feed = new PublicClobMarketChangeFeed({
      socketFactory: (url) => {
        createdUrl = url;
        return socket;
      },
    });

    feed.replaceSubscriptions(["asset-1"]);
    socket.open();
    socket.message({
      event_type: "book",
      asset_id: "asset-1",
      market: "0xcondition",
      bids: [],
      asks: [],
      timestamp: "1757908892351",
      hash: "book-hash",
    });

    expect(createdUrl).toBe(POLYMARKET_MARKET_WEBSOCKET_URL);
    expect(socket.sent.map((item) => JSON.parse(item))).toContainEqual({
      assets_ids: ["asset-1"],
      type: "market",
      custom_feature_enabled: true,
    });
    expect(feed.drainChangedAssetIds()).toEqual(["asset-1"]);
    expect(feed.drainChangedAssetIds()).toEqual([]);
    feed.close();
  });

  it("updates subscriptions without reconnecting and recognizes price changes", () => {
    const socket = new FakeMarketWebSocket();
    const feed = new PublicClobMarketChangeFeed({ socketFactory: () => socket });
    feed.replaceSubscriptions(["asset-1"]);
    socket.open();

    feed.replaceSubscriptions(["asset-1", "asset-2"]);
    feed.replaceSubscriptions(["asset-2"]);
    socket.message({
      event_type: "price_change",
      market: "0xcondition",
      price_changes: [{ asset_id: "asset-2", price: "0.5", size: "1", side: "BUY" }],
    });

    expect(socket.sent.map((item) => JSON.parse(item))).toEqual([
      { assets_ids: ["asset-1"], type: "market", custom_feature_enabled: true },
      { assets_ids: ["asset-2"], operation: "subscribe", custom_feature_enabled: true },
      { assets_ids: ["asset-1"], operation: "unsubscribe" },
    ]);
    expect(feed.drainChangedAssetIds()).toEqual(["asset-2"]);
    feed.close();
  });
});
