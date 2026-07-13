import type { PublicActivity, PublicPosition, PublicProfile, PublicTrade } from "../domain/models.js";
import type { ClobMarket, ClobMarketInfo, ClobOrderbook } from "./polymarket-public.js";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const TOKEN_ID_RE = /^\d+$/;

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`API_SCHEMA_INVALID:${path}:object`);
  return value as Record<string, unknown>;
}

function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`API_SCHEMA_INVALID:${path}:array`);
  return value;
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`API_SCHEMA_INVALID:${path}:string`);
  return value;
}

function address(value: unknown, path: string): string {
  const result = text(value, path);
  if (!ADDRESS_RE.test(result)) throw new Error(`API_SCHEMA_INVALID:${path}:address`);
  return result;
}

function hash(value: unknown, path: string): string {
  const result = text(value, path);
  if (!HASH_RE.test(result)) throw new Error(`API_SCHEMA_INVALID:${path}:hash`);
  return result;
}

function tokenId(value: unknown, path: string): string {
  const result = text(value, path);
  if (!TOKEN_ID_RE.test(result)) throw new Error(`API_SCHEMA_INVALID:${path}:token_id`);
  return result;
}

function decimal(value: unknown, path: string, minimum = 0, maximum?: number): number | string {
  if (typeof value !== "number" && typeof value !== "string") throw new Error(`API_SCHEMA_INVALID:${path}:decimal`);
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || (maximum !== undefined && parsed > maximum)) {
    throw new Error(`API_SCHEMA_INVALID:${path}:range`);
  }
  return value;
}

function timestamp(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`API_SCHEMA_INVALID:${path}:timestamp`);
  }
  return value;
}

function optionalBoolean(value: unknown, path: string): void {
  if (value !== undefined && typeof value !== "boolean") {
    throw new Error(`API_SCHEMA_INVALID:${path}:boolean`);
  }
}

export function parsePublicProfile(value: unknown): PublicProfile {
  const row = record(value, "profile");
  if (row.proxyWallet !== undefined && row.proxyWallet !== null) address(row.proxyWallet, "profile.proxyWallet");
  return row as PublicProfile;
}

export function parsePublicTrades(value: unknown): PublicTrade[] {
  return array(value, "trades").map((item, index) => {
    const row = record(item, `trades[${index}]`);
    address(row.proxyWallet, `trades[${index}].proxyWallet`);
    hash(row.transactionHash, `trades[${index}].transactionHash`);
    hash(row.conditionId, `trades[${index}].conditionId`);
    tokenId(row.asset, `trades[${index}].asset`);
    if (row.side !== "BUY" && row.side !== "SELL") throw new Error(`API_SCHEMA_INVALID:trades[${index}].side`);
    decimal(row.price, `trades[${index}].price`, 0, 1);
    decimal(row.size, `trades[${index}].size`, 0);
    timestamp(row.timestamp, `trades[${index}].timestamp`);
    return row as unknown as PublicTrade;
  });
}

export function parsePublicActivity(value: unknown): PublicActivity[] {
  return array(value, "activity").map((item, index) => {
    const row = { ...record(item, `activity[${index}]`) };
    address(row.proxyWallet, `activity[${index}].proxyWallet`);
    hash(row.transactionHash, `activity[${index}].transactionHash`);
    text(row.type, `activity[${index}].type`);
    timestamp(row.timestamp, `activity[${index}].timestamp`);
    // Data API uses empty-string placeholders for fields that do not apply to
    // REWARD/YIELD/MAKER_REBATE rows. Normalize those placeholders to absence;
    // TRADE rows remain strict below and can never pass without full identity.
    for (const field of ["conditionId", "asset", "side"] as const) {
      if (row[field] === "" || row[field] === null) delete row[field];
    }
    for (const field of ["price", "size", "usdcSize", "isCombo"] as const) {
      if (row[field] === null) delete row[field];
    }
    if (row.conditionId !== undefined) hash(row.conditionId, `activity[${index}].conditionId`);
    if (row.asset !== undefined) tokenId(row.asset, `activity[${index}].asset`);
    if (row.side !== undefined && row.side !== "BUY" && row.side !== "SELL") {
      throw new Error(`API_SCHEMA_INVALID:activity[${index}].side`);
    }
    if (row.price !== undefined) decimal(row.price, `activity[${index}].price`, 0, 1);
    if (row.size !== undefined) decimal(row.size, `activity[${index}].size`, 0);
    if (row.usdcSize !== undefined) decimal(row.usdcSize, `activity[${index}].usdcSize`, 0);
    if (row.isCombo !== undefined && typeof row.isCombo !== "boolean") {
      throw new Error(`API_SCHEMA_INVALID:activity[${index}].isCombo:boolean`);
    }
    if (row.type === "TRADE" && (
      row.conditionId === undefined || row.asset === undefined || row.side === undefined
      || row.price === undefined || row.size === undefined
    )) throw new Error(`API_SCHEMA_INVALID:activity[${index}]:trade_fields`);
    return row as unknown as PublicActivity;
  });
}

export function parsePublicPositions(value: unknown): PublicPosition[] {
  return array(value, "positions").map((item, index) => {
    const row = record(item, `positions[${index}]`);
    address(row.proxyWallet, `positions[${index}].proxyWallet`);
    tokenId(row.asset, `positions[${index}].asset`);
    hash(row.conditionId, `positions[${index}].conditionId`);
    decimal(row.size, `positions[${index}].size`, 0);
    decimal(row.avgPrice, `positions[${index}].avgPrice`, 0, 1);
    decimal(row.currentValue, `positions[${index}].currentValue`, 0);
    return row as unknown as PublicPosition;
  });
}

export function parseClobTime(value: unknown): number {
  return timestamp(value, "clobTime");
}

export function parseClobOrderbook(value: unknown): ClobOrderbook {
  const row = record(value, "orderbook");
  hash(row.market, "orderbook.market");
  tokenId(row.asset_id, "orderbook.asset_id");
  text(row.timestamp, "orderbook.timestamp");
  const levels = (key: "bids" | "asks") => array(row[key], `orderbook.${key}`).forEach((item, index) => {
    const level = record(item, `orderbook.${key}[${index}]`);
    decimal(level.price, `orderbook.${key}[${index}].price`, 0, 1);
    decimal(level.size, `orderbook.${key}[${index}].size`, 0);
  });
  levels("bids");
  levels("asks");
  return row as unknown as ClobOrderbook;
}

export function parseClobMarket(value: unknown): ClobMarket {
  const row = record(value, "market");
  hash(row.condition_id, "market.condition_id");
  if (typeof row.closed !== "boolean") throw new Error("API_SCHEMA_INVALID:market.closed:boolean");
  optionalBoolean(row.active, "market.active");
  optionalBoolean(row.accepting_orders, "market.accepting_orders");
  optionalBoolean(row.is_50_50_outcome, "market.is_50_50_outcome");
  if (row.taker_base_fee !== undefined && (!Number.isSafeInteger(row.taker_base_fee) || Number(row.taker_base_fee) < 0)) {
    throw new Error("API_SCHEMA_INVALID:market.taker_base_fee");
  }
  let winnerCount = 0;
  array(row.tokens, "market.tokens").forEach((item, index) => {
    const token = record(item, `market.tokens[${index}]`);
    tokenId(token.token_id, `market.tokens[${index}].token_id`);
    text(token.outcome, `market.tokens[${index}].outcome`);
    if (token.price !== undefined) decimal(token.price, `market.tokens[${index}].price`, 0, 1);
    optionalBoolean(token.winner, `market.tokens[${index}].winner`);
    if (token.winner === true) winnerCount += 1;
  });
  if (winnerCount > 1) throw new Error("API_SCHEMA_INVALID:market.tokens:multiple_winners");
  if (winnerCount > 0 && row.closed !== true) throw new Error("API_SCHEMA_INVALID:market.tokens:winner_before_close");
  return row as unknown as ClobMarket;
}

export function parseClobMarketInfo(value: unknown): ClobMarketInfo {
  const row = record(value, "marketInfo");
  if (!Number.isSafeInteger(row.tbf) || Number(row.tbf) < 0) throw new Error("API_SCHEMA_INVALID:marketInfo.tbf");
  if (!Number.isSafeInteger(row.mbf) || Number(row.mbf) < 0) throw new Error("API_SCHEMA_INVALID:marketInfo.mbf");
  array(row.t, "marketInfo.t").forEach((item, index) => {
    const token = record(item, `marketInfo.t[${index}]`);
    tokenId(token.t, `marketInfo.t[${index}].t`);
    text(token.o, `marketInfo.t[${index}].o`);
  });
  if (row.fd !== undefined) {
    const fee = record(row.fd, "marketInfo.fd");
    decimal(fee.r, "marketInfo.fd.r", 0);
    decimal(fee.e, "marketInfo.fd.e", 0);
    optionalBoolean(fee.to, "marketInfo.fd.to");
  }
  return row as unknown as ClobMarketInfo;
}

export function parseRpcResponse(value: unknown): { jsonrpc: string; id: number; result?: string; error?: unknown } {
  const row = record(value, "rpc");
  if (row.jsonrpc !== "2.0" || typeof row.id !== "number") throw new Error("API_SCHEMA_INVALID:rpc:envelope");
  if (row.result !== undefined && (typeof row.result !== "string" || !/^0x[0-9a-fA-F]*$/.test(row.result))) {
    throw new Error("API_SCHEMA_INVALID:rpc.result");
  }
  if (row.result === undefined && row.error === undefined) throw new Error("API_SCHEMA_INVALID:rpc:missing_result_or_error");
  return row as { jsonrpc: string; id: number; result?: string; error?: unknown };
}

export function parseRelayerDeployment(value: unknown): { deployed: boolean } {
  const row = record(value, "relayer");
  if (typeof row.deployed !== "boolean") throw new Error("API_SCHEMA_INVALID:relayer.deployed");
  return { deployed: row.deployed };
}

export function parseFeeRate(value: unknown): { base_fee: number } {
  const row = record(value, "feeRate");
  if (!Number.isSafeInteger(row.base_fee) || Number(row.base_fee) < 0) throw new Error("API_SCHEMA_INVALID:feeRate.base_fee");
  return { base_fee: Number(row.base_fee) };
}
