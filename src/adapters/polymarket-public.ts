import type { PublicActivity, PublicPosition, PublicProfile, PublicTrade } from "../domain/models.js";

export interface ApiCapture<T> {
  url: string;
  fetchedAt: string;
  latencyMs: number;
  status: number;
  data: T;
}

export interface PagedResult<T> {
  rows: T[];
  captures: ApiCapture<T[]>[];
  historyComplete: boolean;
  stopReason: string;
}

export interface PublicApiOptions {
  timeoutMs?: number;
  maxRetries?: number;
  backoffFactor?: number;
  maxBackoffMs?: number;
  polygonRpcUrl?: string;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly url: string,
  ) {
    super(`HTTP ${status}: ${url}: ${body.slice(0, 300)}`);
  }
}

export class PolymarketPublicApi {
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly backoffFactor: number;
  private readonly maxBackoffMs: number;
  private readonly polygonRpcUrl: string;

  constructor(options: PublicApiOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 3_000;
    this.maxRetries = options.maxRetries ?? 3;
    this.backoffFactor = options.backoffFactor ?? 2;
    this.maxBackoffMs = options.maxBackoffMs ?? 30_000;
    this.polygonRpcUrl = options.polygonRpcUrl ?? "https://polygon-bor-rpc.publicnode.com";
  }

  private async request<T>(url: string, init?: RequestInit): Promise<ApiCapture<T>> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      const started = performance.now();
      try {
        const response = await fetch(url, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
        const body = await response.text();
        const latencyMs = Math.round((performance.now() - started) * 100) / 100;
        if (!response.ok) {
          const error = new HttpError(response.status, body, url);
          if ((response.status !== 429 && response.status < 500) || attempt === this.maxRetries) throw error;
          lastError = error;
        } else {
          return {
            url,
            fetchedAt: new Date().toISOString(),
            latencyMs,
            status: response.status,
            data: JSON.parse(body) as T,
          };
        }
      } catch (error) {
        if (error instanceof HttpError && error.status !== 429 && error.status < 500) throw error;
        lastError = error;
        if (attempt === this.maxRetries) break;
      }
      const base = Math.min(this.maxBackoffMs, 250 * this.backoffFactor ** attempt);
      await new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * base)));
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  async profile(address: string): Promise<ApiCapture<PublicProfile>> {
    return this.request(`https://gamma-api.polymarket.com/public-profile?address=${address}`);
  }

  async positions(address: string): Promise<ApiCapture<PublicPosition[]>> {
    return this.request(`https://data-api.polymarket.com/positions?user=${address}&sizeThreshold=0&limit=500&offset=0`);
  }

  async trades(address: string): Promise<PagedResult<PublicTrade>> {
    return this.paged<PublicTrade>(
      (offset) => `https://data-api.polymarket.com/trades?user=${address}&takerOnly=false&limit=1000&offset=${offset}`,
      1_000,
    );
  }

  async activity(address: string): Promise<PagedResult<PublicActivity>> {
    return this.paged<PublicActivity>(
      (offset) =>
        `https://data-api.polymarket.com/activity?user=${address}&limit=500&offset=${offset}&sortBy=TIMESTAMP&sortDirection=DESC`,
      500,
    );
  }

  private async paged<T>(urlForOffset: (offset: number) => string, pageSize: number): Promise<PagedResult<T>> {
    const rows: T[] = [];
    const captures: ApiCapture<T[]>[] = [];
    for (let offset = 0; offset <= 10_000; offset += pageSize) {
      try {
        const capture = await this.request<T[]>(urlForOffset(offset));
        captures.push(capture);
        rows.push(...capture.data);
        if (capture.data.length < pageSize) {
          return { rows, captures, historyComplete: true, stopReason: "END_OF_DATA" };
        }
      } catch (error) {
        if (error instanceof HttpError && error.status === 400 && error.body.includes("max historical activity offset")) {
          return { rows, captures, historyComplete: false, stopReason: error.body };
        }
        throw error;
      }
    }
    return { rows, captures, historyComplete: false, stopReason: "CLIENT_OFFSET_LIMIT" };
  }

  async clobTime(): Promise<ApiCapture<number>> {
    return this.request("https://clob.polymarket.com/time");
  }

  async contractCode(address: string): Promise<ApiCapture<{ jsonrpc: string; id: number; result?: string; error?: unknown }>> {
    return this.request(this.polygonRpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getCode", params: [address, "latest"] }),
    });
  }

  async pUsdBalance(address: string): Promise<ApiCapture<{ jsonrpc: string; id: number; result?: string; error?: unknown }>> {
    const token = "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB";
    const account = address.toLowerCase().replace(/^0x/, "").padStart(64, "0");
    return this.request(this.polygonRpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "eth_call",
        params: [{ to: token, data: `0x70a08231${account}` }, "latest"],
      }),
    });
  }

  async relayerDeployed(address: string, type: "SAFE" | "WALLET"): Promise<ApiCapture<{ deployed: boolean }> | null> {
    try {
      return await this.request(`https://relayer-v2.polymarket.com/deployed?address=${address}&type=${type}`);
    } catch {
      return null;
    }
  }
}
