import { pad } from "viem";
import {
  ORDER_FILLED_TOPIC,
  POLYMARKET_CTF_EXCHANGES,
} from "../adapters/polygon-order-filled.js";

export const POLYGON_ORDER_FILLED_WEBSOCKET_URL = "wss://polygon.drpc.org";

const INITIAL_RECONNECT_MS = 1_000;
const MAX_RECONNECT_MS = 30_000;
const ADDRESS_RE = /^0x[0-9a-f]{40}$/;

export type ObserveWakeResult = "WAKE" | "TIMEOUT";

export interface ObserveWakeSource {
  waitForWake(
    walletAddress: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<ObserveWakeResult>;
  close(): void;
}

export interface PolygonWakeWebSocket {
  readonly readyState: number;
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void;
  send(data: string): void;
  close(): void;
}

export interface PolygonOrderFilledWakeFeedOptions {
  webSocketUrl?: string;
  socketFactory?: (url: string) => PolygonWakeWebSocket;
}

interface WakeWaiter {
  finish(result: ObserveWakeResult): void;
}

function normalizedWallet(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!ADDRESS_RE.test(normalized)) throw new Error("POLYGON_WAKE_WALLET_INVALID");
  return normalized;
}

function validWebSocketUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "wss:") throw new Error("protocol");
    return url.toString().replace(/\/$/, "");
  } catch {
    throw new Error("POLYGON_WAKE_WEBSOCKET_URL_INVALID");
  }
}

/**
 * Public unauthenticated Polygon log subscription used only to wake Observe.
 * The notification is never converted into a Signal: the existing confirmed
 * block scan, REST/Activity confirmation, reorg checks and idempotency path
 * remain the sole source of executable evidence.
 */
export class PolygonOrderFilledWakeFeed implements ObserveWakeSource {
  private readonly webSocketUrl: string;
  private readonly socketFactory: (url: string) => PolygonWakeWebSocket;
  private readonly waiters = new Set<WakeWaiter>();
  private socket: PolygonWakeWebSocket | null = null;
  private reconnect: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelayMs = INITIAL_RECONNECT_MS;
  private walletAddress: string | null = null;
  private subscriptionId: string | null = null;
  private subscriptionRequestId = 0;
  private pendingWake = false;
  private closedByOwner = false;

  constructor(options: PolygonOrderFilledWakeFeedOptions = {}) {
    this.webSocketUrl = validWebSocketUrl(
      options.webSocketUrl ?? POLYGON_ORDER_FILLED_WEBSOCKET_URL,
    );
    this.socketFactory = options.socketFactory ?? ((url) => (
      new WebSocket(url) as unknown as PolygonWakeWebSocket
    ));
  }

  async waitForWake(
    walletAddressInput: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<ObserveWakeResult> {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new Error("POLYGON_WAKE_TIMEOUT_INVALID");
    if (signal?.aborted || timeoutMs === 0 || this.closedByOwner) return "TIMEOUT";
    const walletAddress = normalizedWallet(walletAddressInput);
    if (this.walletAddress !== null && this.walletAddress !== walletAddress) {
      throw new Error("POLYGON_WAKE_WALLET_CHANGED");
    }
    this.walletAddress = walletAddress;
    this.connect();
    if (this.pendingWake) {
      this.pendingWake = false;
      return "WAKE";
    }
    return new Promise<ObserveWakeResult>((resolve) => {
      let settled = false;
      const finish = (result: ObserveWakeResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.waiters.delete(waiter);
        resolve(result);
      };
      const waiter: WakeWaiter = { finish };
      const onAbort = (): void => finish("TIMEOUT");
      const timer = setTimeout(() => finish("TIMEOUT"), timeoutMs);
      this.waiters.add(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  close(): void {
    if (this.closedByOwner) return;
    this.closedByOwner = true;
    this.pendingWake = false;
    if (this.reconnect) clearTimeout(this.reconnect);
    this.reconnect = null;
    for (const waiter of [...this.waiters]) waiter.finish("TIMEOUT");
    const socket = this.socket;
    this.socket = null;
    this.subscriptionId = null;
    socket?.close();
  }

  private connect(): void {
    if (this.closedByOwner || this.walletAddress === null || this.socket) return;
    const socket = this.socketFactory(this.webSocketUrl);
    this.socket = socket;
    socket.addEventListener("open", () => this.onOpen(socket));
    socket.addEventListener("message", (event) => this.onMessage(socket, event.data));
    socket.addEventListener("error", () => socket.close());
    socket.addEventListener("close", () => this.onClose(socket));
  }

  private onOpen(socket: PolygonWakeWebSocket): void {
    if (this.socket !== socket || this.closedByOwner || this.walletAddress === null) return;
    this.subscriptionRequestId += 1;
    socket.send(JSON.stringify({
      jsonrpc: "2.0",
      id: this.subscriptionRequestId,
      method: "eth_subscribe",
      params: ["logs", {
        address: [...POLYMARKET_CTF_EXCHANGES],
        topics: [
          ORDER_FILLED_TOPIC,
          null,
          pad(this.walletAddress as `0x${string}`, { size: 32 }),
        ],
      }],
    }));
  }

  private onMessage(socket: PolygonWakeWebSocket, data: unknown): void {
    if (this.socket !== socket || typeof data !== "string" || this.walletAddress === null) return;
    let message: unknown;
    try {
      message = JSON.parse(data);
    } catch {
      return;
    }
    if (!message || typeof message !== "object" || Array.isArray(message)) return;
    const record = message as Record<string, unknown>;
    if (record.id === this.subscriptionRequestId) {
      if (typeof record.result === "string" && record.result.length > 0) {
        this.subscriptionId = record.result;
        this.reconnectDelayMs = INITIAL_RECONNECT_MS;
      } else socket.close();
      return;
    }
    if (record.method !== "eth_subscription") return;
    const params = record.params;
    if (!params || typeof params !== "object" || Array.isArray(params)) return;
    const subscription = (params as Record<string, unknown>).subscription;
    const result = (params as Record<string, unknown>).result;
    if (subscription !== this.subscriptionId || !result || typeof result !== "object" || Array.isArray(result)) return;
    const log = result as Record<string, unknown>;
    const address = typeof log.address === "string" ? log.address.toLowerCase() : "";
    const topics = Array.isArray(log.topics) ? log.topics : [];
    const makerTopic = pad(this.walletAddress as `0x${string}`, { size: 32 }).toLowerCase();
    if (
      !POLYMARKET_CTF_EXCHANGES.includes(address as typeof POLYMARKET_CTF_EXCHANGES[number])
      || typeof topics[0] !== "string"
      || topics[0].toLowerCase() !== ORDER_FILLED_TOPIC
      || typeof topics[2] !== "string"
      || topics[2].toLowerCase() !== makerTopic
    ) return;
    this.publishWake();
  }

  private publishWake(): void {
    if (this.waiters.size === 0) {
      this.pendingWake = true;
      return;
    }
    for (const waiter of [...this.waiters]) waiter.finish("WAKE");
  }

  private onClose(socket: PolygonWakeWebSocket): void {
    if (this.socket !== socket) return;
    this.socket = null;
    this.subscriptionId = null;
    if (this.closedByOwner || this.walletAddress === null || this.reconnect) return;
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(MAX_RECONNECT_MS, this.reconnectDelayMs * 2);
    this.reconnect = setTimeout(() => {
      this.reconnect = null;
      this.connect();
    }, delay);
  }
}
