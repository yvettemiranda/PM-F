export const POLYMARKET_MARKET_WEBSOCKET_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";

const WEBSOCKET_OPEN = 1;
const HEARTBEAT_INTERVAL_MS = 10_000;
const INITIAL_RECONNECT_MS = 1_000;
const MAX_RECONNECT_MS = 30_000;

export interface MarketWebSocket {
  readonly readyState: number;
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void;
  send(data: string): void;
  close(): void;
}

export interface MarketChangeFeed {
  replaceSubscriptions(assetIds: readonly string[]): void;
  drainChangedAssetIds(): string[];
  close(): void;
}

export interface PublicClobMarketChangeFeedOptions {
  socketFactory?: (url: string) => MarketWebSocket;
}

function normalizedAssetIds(assetIds: readonly string[]): string[] {
  return [...new Set(assetIds.filter((assetId) => assetId.trim() === assetId && assetId.length > 0))]
    .sort();
}

function messageAssetIds(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const message = value as Record<string, unknown>;
  const eventType = message.event_type;
  if (typeof eventType !== "string") return [];
  if (eventType === "price_change") {
    if (!Array.isArray(message.price_changes)) return [];
    return message.price_changes.flatMap((change) => (
      change
      && typeof change === "object"
      && !Array.isArray(change)
      && typeof (change as Record<string, unknown>).asset_id === "string"
        ? [(change as Record<string, unknown>).asset_id as string]
        : []
    ));
  }
  if (["book", "tick_size_change", "last_trade_price", "best_bid_ask"].includes(eventType)) {
    return typeof message.asset_id === "string" ? [message.asset_id] : [];
  }
  if (["new_market", "market_resolved"].includes(eventType) && Array.isArray(message.assets_ids)) {
    return message.assets_ids.filter((assetId): assetId is string => typeof assetId === "string");
  }
  return [];
}

/**
 * Public unauthenticated CLOB Market Channel used only as a wake-up hint.
 * Execution always reloads an authoritative full REST orderbook before any
 * Paper match or future Live planning decision.
 */
export class PublicClobMarketChangeFeed implements MarketChangeFeed {
  private readonly socketFactory: (url: string) => MarketWebSocket;
  private readonly desiredAssets = new Set<string>();
  private readonly subscribedAssets = new Set<string>();
  private readonly changedAssets = new Set<string>();
  private socket: MarketWebSocket | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private reconnect: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelayMs = INITIAL_RECONNECT_MS;
  private closedByOwner = false;

  constructor(options: PublicClobMarketChangeFeedOptions = {}) {
    this.socketFactory = options.socketFactory ?? ((url) => (
      new WebSocket(url) as unknown as MarketWebSocket
    ));
  }

  replaceSubscriptions(assetIds: readonly string[]): void {
    const next = new Set(normalizedAssetIds(assetIds));
    this.desiredAssets.clear();
    for (const assetId of next) this.desiredAssets.add(assetId);
    if (next.size === 0) {
      this.disconnectIdleSocket();
      return;
    }
    if (!this.socket) {
      this.connect();
      return;
    }
    if (this.socket.readyState !== WEBSOCKET_OPEN) return;
    const additions = [...next].filter((assetId) => !this.subscribedAssets.has(assetId));
    const removals = [...this.subscribedAssets].filter((assetId) => !next.has(assetId));
    if (additions.length > 0) {
      this.socket.send(JSON.stringify({
        assets_ids: additions,
        operation: "subscribe",
        custom_feature_enabled: true,
      }));
      for (const assetId of additions) this.subscribedAssets.add(assetId);
    }
    if (removals.length > 0) {
      this.socket.send(JSON.stringify({ assets_ids: removals, operation: "unsubscribe" }));
      for (const assetId of removals) this.subscribedAssets.delete(assetId);
    }
  }

  drainChangedAssetIds(): string[] {
    const values = [...this.changedAssets].sort();
    this.changedAssets.clear();
    return values;
  }

  close(): void {
    this.closedByOwner = true;
    this.desiredAssets.clear();
    this.changedAssets.clear();
    this.clearTimers();
    const socket = this.socket;
    this.socket = null;
    this.subscribedAssets.clear();
    socket?.close();
  }

  private connect(): void {
    if (this.closedByOwner || this.desiredAssets.size === 0 || this.socket) return;
    const socket = this.socketFactory(POLYMARKET_MARKET_WEBSOCKET_URL);
    this.socket = socket;
    socket.addEventListener("open", () => this.onOpen(socket));
    socket.addEventListener("message", (event) => this.onMessage(event.data));
    socket.addEventListener("error", () => socket.close());
    socket.addEventListener("close", () => this.onClose(socket));
  }

  private onOpen(socket: MarketWebSocket): void {
    if (this.socket !== socket || this.closedByOwner) return;
    const assets = [...this.desiredAssets].sort();
    if (assets.length === 0) {
      socket.close();
      return;
    }
    socket.send(JSON.stringify({
      assets_ids: assets,
      type: "market",
      custom_feature_enabled: true,
    }));
    this.subscribedAssets.clear();
    for (const assetId of assets) this.subscribedAssets.add(assetId);
    this.reconnectDelayMs = INITIAL_RECONNECT_MS;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = setInterval(() => {
      if (this.socket === socket && socket.readyState === WEBSOCKET_OPEN) socket.send("PING");
    }, HEARTBEAT_INTERVAL_MS);
  }

  private onMessage(data: unknown): void {
    if (data === "PONG") return;
    if (typeof data !== "string") return;
    let decoded: unknown;
    try {
      decoded = JSON.parse(data);
    } catch {
      return;
    }
    const messages = Array.isArray(decoded) ? decoded : [decoded];
    for (const message of messages) {
      for (const assetId of messageAssetIds(message)) {
        if (this.desiredAssets.has(assetId)) this.changedAssets.add(assetId);
      }
    }
  }

  private onClose(socket: MarketWebSocket): void {
    if (this.socket !== socket) return;
    this.socket = null;
    this.subscribedAssets.clear();
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    if (this.closedByOwner || this.desiredAssets.size === 0 || this.reconnect) return;
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(MAX_RECONNECT_MS, this.reconnectDelayMs * 2);
    this.reconnect = setTimeout(() => {
      this.reconnect = null;
      this.connect();
    }, delay);
  }

  private disconnectIdleSocket(): void {
    if (this.reconnect) clearTimeout(this.reconnect);
    this.reconnect = null;
    const socket = this.socket;
    this.socket = null;
    this.subscribedAssets.clear();
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    socket?.close();
  }

  private clearTimers(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.reconnect) clearTimeout(this.reconnect);
    this.heartbeat = null;
    this.reconnect = null;
  }
}
