export const ORDER_FILLED_TOPIC = "0xd543adfd945773f1a62f74f0ee55a5e3b9b1a28262980ba90b1a89f2ea84d8ee";
export const POLYMARKET_CTF_EXCHANGES = [
  "0xe111180000d2663c0091e4f400237545b87b996b",
  "0xe2222d279d744050d28e00520010520000310f59",
] as const;

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const HEX_DATA_RE = /^0x(?:[0-9a-fA-F]{2})*$/;
const QUANTITY_RE = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/;

export interface PolygonBlockNumberResponse {
  jsonrpc: "2.0";
  id: number;
  result?: string;
  error?: unknown;
}

export interface PolygonBlockHeader {
  number: string;
  hash: string;
  parentHash: string;
  timestamp: string;
}

export interface PolygonBlockResponse {
  jsonrpc: "2.0";
  id: number;
  result: PolygonBlockHeader | null;
  error?: unknown;
}

export interface PolygonOrderFilledLog {
  address: string;
  blockNumber: string;
  blockHash: string;
  transactionHash: string;
  transactionIndex: string;
  logIndex: string;
  removed: boolean;
  topics: readonly string[];
  data: string;
}

export interface PolygonLogsResponse {
  jsonrpc: "2.0";
  id: number;
  result?: PolygonOrderFilledLog[];
  error?: unknown;
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`API_SCHEMA_INVALID:${path}:object`);
  }
  return value as Record<string, unknown>;
}

function envelope(value: unknown, path: string): Record<string, unknown> {
  const parsed = record(value, path);
  if (parsed.jsonrpc !== "2.0" || typeof parsed.id !== "number") {
    throw new Error(`API_SCHEMA_INVALID:${path}:envelope`);
  }
  return parsed;
}

function quantity(value: unknown, path: string): string {
  if (typeof value !== "string" || !QUANTITY_RE.test(value)) {
    throw new Error(`API_SCHEMA_INVALID:${path}:quantity`);
  }
  return value.toLowerCase();
}

function hash(value: unknown, path: string): string {
  if (typeof value !== "string" || !HASH_RE.test(value)) {
    throw new Error(`API_SCHEMA_INVALID:${path}:hash`);
  }
  return value.toLowerCase();
}

export function parsePolygonBlockNumberResponse(value: unknown): PolygonBlockNumberResponse {
  const parsed = envelope(value, "rpcBlockNumber");
  if (parsed.result === undefined) {
    if (parsed.error === undefined) throw new Error("API_SCHEMA_INVALID:rpcBlockNumber:missing_result_or_error");
    return parsed as unknown as PolygonBlockNumberResponse;
  }
  parsed.result = quantity(parsed.result, "rpcBlockNumber.result");
  return parsed as unknown as PolygonBlockNumberResponse;
}

export function parsePolygonBlockResponse(value: unknown): PolygonBlockResponse {
  const parsed = envelope(value, "rpcBlock");
  if (parsed.result === null) return parsed as unknown as PolygonBlockResponse;
  if (parsed.result === undefined) {
    if (parsed.error === undefined) throw new Error("API_SCHEMA_INVALID:rpcBlock:missing_result_or_error");
    return { ...parsed, result: null } as unknown as PolygonBlockResponse;
  }
  const block = record(parsed.result, "rpcBlock.result");
  block.number = quantity(block.number, "rpcBlock.result.number");
  block.hash = hash(block.hash, "rpcBlock.result.hash");
  block.parentHash = hash(block.parentHash, "rpcBlock.result.parentHash");
  block.timestamp = quantity(block.timestamp, "rpcBlock.result.timestamp");
  return parsed as unknown as PolygonBlockResponse;
}

export function parsePolygonLogsResponse(value: unknown): PolygonLogsResponse {
  const parsed = envelope(value, "rpcLogs");
  if (parsed.result === undefined) {
    if (parsed.error === undefined) throw new Error("API_SCHEMA_INVALID:rpcLogs:missing_result_or_error");
    return parsed as unknown as PolygonLogsResponse;
  }
  if (!Array.isArray(parsed.result)) throw new Error("API_SCHEMA_INVALID:rpcLogs.result:array");
  parsed.result = parsed.result.map((value, index): PolygonOrderFilledLog => {
    const path = `rpcLogs.result[${index}]`;
    const log = record(value, path);
    if (typeof log.address !== "string" || !ADDRESS_RE.test(log.address)) {
      throw new Error(`API_SCHEMA_INVALID:${path}.address`);
    }
    if (!Array.isArray(log.topics) || log.topics.some((topic) => typeof topic !== "string" || !HASH_RE.test(topic))) {
      throw new Error(`API_SCHEMA_INVALID:${path}.topics`);
    }
    if (typeof log.data !== "string" || !HEX_DATA_RE.test(log.data)) {
      throw new Error(`API_SCHEMA_INVALID:${path}.data`);
    }
    if (typeof log.removed !== "boolean") throw new Error(`API_SCHEMA_INVALID:${path}.removed`);
    return {
      address: log.address.toLowerCase(),
      blockNumber: quantity(log.blockNumber, `${path}.blockNumber`),
      blockHash: hash(log.blockHash, `${path}.blockHash`),
      transactionHash: hash(log.transactionHash, `${path}.transactionHash`),
      transactionIndex: quantity(log.transactionIndex, `${path}.transactionIndex`),
      logIndex: quantity(log.logIndex, `${path}.logIndex`),
      removed: log.removed,
      topics: log.topics.map((topic) => (topic as string).toLowerCase()),
      data: log.data.toLowerCase(),
    };
  });
  return parsed as unknown as PolygonLogsResponse;
}
