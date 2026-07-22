import { setTimeout as wait } from "node:timers/promises";
import type { PublicActivity, PublicPosition, PublicProfile, PublicTrade } from "../domain/models.js";
import { stableJson } from "../domain/versioning.js";
import {
  parseClobMarket,
  parseClobMarketInfo,
  parseClobOrderbook,
  parseClobTime,
  parseFeeRate,
  parsePublicActivity,
  parsePublicPositions,
  parsePublicProfile,
  parsePublicTrades,
  parseRelayerDeployment,
  parseRpcResponse,
} from "./public-api-schema.js";
import {
  parsePolygonTransactionReceiptResponse,
  type PolygonTransactionReceiptResponse,
} from "./polygon-receipt.js";

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
  boundaryOverlapRows: T[];
  historyComplete: boolean;
  stopReason: string;
}

export interface MergedPagedResult<T> extends PagedResult<T> {
  merged: ApiCapture<T[]>;
}

export interface ClobOrderbook {
  market: string;
  asset_id: string;
  timestamp: string;
  hash: string;
  bids: Array<{ price: string; size: string }>;
  asks: Array<{ price: string; size: string }>;
  min_order_size?: string;
  tick_size?: string;
  neg_risk?: boolean;
}

export interface ClobMarket {
  condition_id: string;
  question?: string;
  market_slug?: string;
  end_date_iso?: string;
  closed: boolean;
  active?: boolean;
  accepting_orders?: boolean;
  taker_base_fee?: number;
  is_50_50_outcome?: boolean;
  tokens: Array<{ token_id: string; outcome: string; price?: number; winner?: boolean }>;
}

export interface ClobMarketInfo {
  tbf?: number;
  mbf?: number;
  fd?: { r: number | string; e: number | string; to: boolean };
  t: Array<{ t: string; o: string }>;
  mts: number;
  mos: number;
}

export interface PublicApiOptions {
  timeoutMs?: number;
  maxRetries?: number;
  backoffFactor?: number;
  maxBackoffMs?: number;
  polygonRpcUrl?: string;
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

function assertAddress(address: string): string {
  if (!ADDRESS_RE.test(address)) throw new Error(`INVALID_WALLET_ADDRESS:${address}`);
  return address.toLowerCase();
}

function assertPageLimit(name: string, value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`INVALID_${name.toUpperCase()}_LIMIT:${value}`);
  }
  return value;
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("REQUEST_ABORTED");
}

export function exactPaginationBoundaryOverlaps<T>(
  pages: readonly (readonly T[])[],
): T[] {
  const overlaps: T[] = [];
  for (let index = 1; index < pages.length; index += 1) {
    const previous = pages[index - 1]?.at(-1);
    const current = pages[index]?.[0];
    if (
      previous !== undefined
      && current !== undefined
      && stableJson(previous) === stableJson(current)
    ) {
      overlaps.push(current);
    }
  }
  return overlaps;
}

export class PolymarketPublicHttpError extends Error {
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
    this.polygonRpcUrl = options.polygonRpcUrl ?? "https://polygon.drpc.org";
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0) throw new Error("INVALID_REQUEST_TIMEOUT");
    if (!Number.isSafeInteger(this.maxRetries) || this.maxRetries < 0) throw new Error("INVALID_MAX_RETRIES");
    if (!Number.isFinite(this.backoffFactor) || this.backoffFactor < 1) throw new Error("INVALID_BACKOFF_FACTOR");
    if (!Number.isSafeInteger(this.maxBackoffMs) || this.maxBackoffMs <= 0) throw new Error("INVALID_MAX_BACKOFF");
    try {
      const rpc = new URL(this.polygonRpcUrl);
      if (rpc.protocol !== "https:") throw new Error("INVALID_RPC_PROTOCOL");
    } catch {
      throw new Error("INVALID_POLYGON_RPC_URL");
    }
  }

  private async request<T>(
    url: string,
    init?: RequestInit,
    parse?: (value: unknown) => T,
    externalSignal?: AbortSignal,
  ): Promise<ApiCapture<T>> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      if (externalSignal?.aborted) throw abortError(externalSignal);
      const started = performance.now();
      try {
        const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
        const requestSignal = externalSignal
          ? AbortSignal.any([externalSignal, timeoutSignal])
          : timeoutSignal;
        const response = await fetch(url, { ...init, signal: requestSignal });
        const body = await response.text();
        const latencyMs = Math.round((performance.now() - started) * 100) / 100;
        if (!response.ok) {
          const error = new PolymarketPublicHttpError(response.status, body, url);
          if ((response.status !== 429 && response.status < 500) || attempt === this.maxRetries) throw error;
          lastError = error;
        } else {
          return {
            url,
            fetchedAt: new Date().toISOString(),
            latencyMs,
            status: response.status,
            data: parse ? parse(JSON.parse(body) as unknown) : JSON.parse(body) as T,
          };
        }
      } catch (error) {
        if (externalSignal?.aborted) throw abortError(externalSignal);
        if (error instanceof PolymarketPublicHttpError && error.status !== 429 && error.status < 500) throw error;
        lastError = error;
        if (attempt === this.maxRetries) break;
      }
      const base = Math.min(this.maxBackoffMs, 250 * this.backoffFactor ** attempt);
      const backoffMs = Math.floor(Math.random() * base);
      try {
        await wait(backoffMs, undefined, externalSignal ? { signal: externalSignal } : undefined);
      } catch {
        if (externalSignal?.aborted) throw abortError(externalSignal);
        throw new Error("REQUEST_BACKOFF_FAILED");
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  async profile(address: string): Promise<ApiCapture<PublicProfile>> {
    return this.request(`https://gamma-api.polymarket.com/public-profile?address=${encodeURIComponent(assertAddress(address))}`, undefined, parsePublicProfile);
  }

  async positions(address: string): Promise<ApiCapture<PublicPosition[]>> {
    return this.request(`https://data-api.polymarket.com/positions?user=${encodeURIComponent(assertAddress(address))}&sizeThreshold=0&limit=500&offset=0`, undefined, parsePublicPositions);
  }

  async allPositions(address: string, signal?: AbortSignal): Promise<MergedPagedResult<PublicPosition>> {
    const wallet = encodeURIComponent(assertAddress(address));
    const result = await this.paged<PublicPosition>(
      (offset) => `https://data-api.polymarket.com/positions?user=${wallet}&sizeThreshold=0&limit=500&offset=${offset}`,
      500,
      parsePublicPositions,
      signal,
    );
    const last = result.captures.at(-1);
    if (!last) throw new Error("Positions pagination returned no capture");
    const seenAssets = new Set<string>();
    for (const position of result.rows) {
      if (seenAssets.has(position.asset)) {
        throw new Error(`API_SCHEMA_INVALID:positions:duplicate_asset:${position.asset}`);
      }
      seenAssets.add(position.asset);
    }
    return {
      ...result,
      merged: {
        url: `${last.url}&mergedPages=${result.captures.length}`,
        fetchedAt: last.fetchedAt,
        latencyMs: result.captures.reduce((total, capture) => total + capture.latencyMs, 0),
        status: last.status,
        data: result.rows,
      },
    };
  }

  async trades(address: string, signal?: AbortSignal): Promise<PagedResult<PublicTrade>> {
    const wallet = encodeURIComponent(assertAddress(address));
    return this.paged<PublicTrade>(
      (offset) => `https://data-api.polymarket.com/trades?user=${wallet}&takerOnly=false&limit=1000&offset=${offset}`,
      1_000,
      parsePublicTrades,
      signal,
    );
  }

  async tradesSince(
    address: string,
    startTimestamp: number,
    signal?: AbortSignal,
  ): Promise<PagedResult<PublicTrade>> {
    if (!Number.isSafeInteger(startTimestamp) || startTimestamp < 0) {
      throw new Error("INVALID_TRADE_START_TIMESTAMP");
    }
    const wallet = encodeURIComponent(assertAddress(address));
    return this.paged<PublicTrade>(
      (offset) => `https://data-api.polymarket.com/trades?user=${wallet}&takerOnly=false&limit=1000&offset=${offset}`,
      1_000,
      parsePublicTrades,
      signal,
      (page) => page.some((row) => row.timestamp <= startTimestamp)
        ? "RECOVERY_CURSOR_COVERED"
        : null,
    );
  }

  async recentTrades(
    address: string,
    limit = 1_000,
    signal?: AbortSignal,
  ): Promise<ApiCapture<PublicTrade[]>> {
    const wallet = encodeURIComponent(assertAddress(address));
    return this.request(`https://data-api.polymarket.com/trades?user=${wallet}&takerOnly=false&limit=${assertPageLimit("trades", limit, 1_000)}&offset=0`, undefined, parsePublicTrades, signal);
  }

  async activity(address: string, signal?: AbortSignal): Promise<PagedResult<PublicActivity>> {
    const wallet = encodeURIComponent(assertAddress(address));
    return this.paged<PublicActivity>(
      (offset) =>
        `https://data-api.polymarket.com/activity?user=${wallet}&limit=500&offset=${offset}&sortBy=TIMESTAMP&sortDirection=DESC`,
      500,
      parsePublicActivity,
      signal,
    );
  }

  async recentActivity(
    address: string,
    limit = 500,
    signal?: AbortSignal,
  ): Promise<ApiCapture<PublicActivity[]>> {
    const wallet = encodeURIComponent(assertAddress(address));
    return this.request(
      `https://data-api.polymarket.com/activity?user=${wallet}&limit=${assertPageLimit("activity", limit, 500)}&offset=0&sortBy=TIMESTAMP&sortDirection=DESC`,
      undefined,
      parsePublicActivity,
      signal,
    );
  }

  async activitySince(
    address: string,
    startTimestamp: number,
    signal?: AbortSignal,
  ): Promise<PagedResult<PublicActivity>> {
    if (!Number.isSafeInteger(startTimestamp) || startTimestamp < 0) {
      throw new Error("INVALID_ACTIVITY_START_TIMESTAMP");
    }
    const wallet = encodeURIComponent(assertAddress(address));
    return this.paged<PublicActivity>(
      (offset) => `https://data-api.polymarket.com/activity?user=${wallet}&limit=500&offset=${offset}&start=${startTimestamp}&sortBy=TIMESTAMP&sortDirection=ASC`,
      500,
      parsePublicActivity,
      signal,
    );
  }

  private async paged<T>(
    urlForOffset: (offset: number) => string,
    pageSize: number,
    parsePage: (value: unknown) => T[],
    signal?: AbortSignal,
    boundedStopReason?: (page: readonly T[]) => string | null,
  ): Promise<PagedResult<T>> {
    const rows: T[] = [];
    const captures: ApiCapture<T[]>[] = [];
    const finish = async (historyComplete: boolean, stopReason: string): Promise<PagedResult<T>> => {
      // Offset pagination is not snapshot-isolated. If page zero changed while
      // later offsets were being read, the merged history can contain a hole;
      // fail closed and let the caller retry from its persisted cursor.
      if (captures.length > 1) {
        const head = await this.request<T[]>(urlForOffset(0), undefined, parsePage, signal);
        if (stableJson(head.data) !== stableJson(captures[0]!.data)) {
          throw new Error("PAGINATION_SNAPSHOT_DRIFT");
        }
      }
      return {
        rows,
        captures,
        boundaryOverlapRows: exactPaginationBoundaryOverlaps(captures.map((capture) => capture.data)),
        historyComplete,
        stopReason,
      };
    };
    for (let offset = 0; offset <= 10_000; offset += pageSize) {
      try {
        const capture = await this.request<T[]>(urlForOffset(offset), undefined, parsePage, signal);
        captures.push(capture);
        rows.push(...capture.data);
        const boundedStop = boundedStopReason?.(capture.data) ?? null;
        if (boundedStop) {
          return finish(true, boundedStop);
        }
        if (capture.data.length < pageSize) {
          return finish(true, "END_OF_DATA");
        }
      } catch (error) {
        if (error instanceof PolymarketPublicHttpError && error.status === 400 && error.body.includes("max historical activity offset")) {
          return finish(false, error.body);
        }
        throw error;
      }
    }
    return finish(false, "CLIENT_OFFSET_LIMIT");
  }

  async clobTime(): Promise<ApiCapture<number>> {
    return this.request("https://clob.polymarket.com/time", undefined, parseClobTime);
  }

  async orderbook(assetId: string, signal?: AbortSignal): Promise<ApiCapture<ClobOrderbook>> {
    return this.request(`https://clob.polymarket.com/book?token_id=${encodeURIComponent(assetId)}`, undefined, parseClobOrderbook, signal);
  }

  async feeRate(assetId: string, signal?: AbortSignal): Promise<ApiCapture<{ base_fee: number }>> {
    return this.request(
      `https://clob.polymarket.com/fee-rate?token_id=${encodeURIComponent(assetId)}`,
      undefined,
      parseFeeRate,
      signal,
    );
  }

  async clobMarket(conditionId: string, signal?: AbortSignal): Promise<ApiCapture<ClobMarket>> {
    return this.request(`https://clob.polymarket.com/markets/${encodeURIComponent(conditionId)}`, undefined, parseClobMarket, signal);
  }

  async clobMarketInfo(conditionId: string, signal?: AbortSignal): Promise<ApiCapture<ClobMarketInfo>> {
    return this.request(`https://clob.polymarket.com/clob-markets/${encodeURIComponent(conditionId)}`, undefined, parseClobMarketInfo, signal);
  }

  async contractCode(address: string): Promise<ApiCapture<{ jsonrpc: string; id: number; result?: string; error?: unknown }>> {
    const wallet = assertAddress(address);
    return this.request(this.polygonRpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getCode", params: [wallet, "latest"] }),
    }, parseRpcResponse);
  }

  async transactionReceipt(
    transactionHash: string,
    signal?: AbortSignal,
  ): Promise<ApiCapture<PolygonTransactionReceiptResponse>> {
    const normalized = transactionHash.toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(normalized)) throw new Error("INVALID_TRANSACTION_HASH");
    return this.request(this.polygonRpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "eth_getTransactionReceipt",
        params: [normalized],
      }),
    }, parsePolygonTransactionReceiptResponse, signal);
  }

  async pUsdBalance(
    address: string,
    signal?: AbortSignal,
  ): Promise<ApiCapture<{ jsonrpc: string; id: number; result?: string; error?: unknown }>> {
    const token = "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB";
    const account = assertAddress(address).replace(/^0x/, "").padStart(64, "0");
    return this.request(this.polygonRpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "eth_call",
        params: [{ to: token, data: `0x70a08231${account}` }, "latest"],
      }),
    }, parseRpcResponse, signal);
  }

  async relayerDeployed(address: string, type: "SAFE" | "WALLET"): Promise<ApiCapture<{ deployed: boolean }> | null> {
    const wallet = encodeURIComponent(assertAddress(address));
    try {
      return await this.request(`https://relayer-v2.polymarket.com/deployed?address=${wallet}&type=${type}`, undefined, parseRelayerDeployment);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("API_SCHEMA_INVALID:")) throw error;
      return null;
    }
  }
}
