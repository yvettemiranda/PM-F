export interface PolygonReceiptLog {
  address: string;
  topics: readonly string[];
  data: string;
  logIndex?: string;
}

export interface PolygonTransactionReceipt {
  transactionHash: string;
  status: string;
  blockNumber?: string;
  logs: PolygonReceiptLog[];
}

export interface PolygonTransactionReceiptResponse {
  jsonrpc: string;
  id: number;
  result: PolygonTransactionReceipt | null;
  error?: unknown;
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const HEX_RE = /^0x(?:[0-9a-fA-F]{2})*$/;
const QUANTITY_RE = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/;

function record(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`API_SCHEMA_INVALID:${path}:object`);
  }
  return value as Record<string, unknown>;
}

export function parsePolygonTransactionReceiptResponse(value: unknown): PolygonTransactionReceiptResponse {
  const envelope = record(value, "rpcReceipt");
  if (envelope.jsonrpc !== "2.0" || typeof envelope.id !== "number") {
    throw new Error("API_SCHEMA_INVALID:rpcReceipt:envelope");
  }
  if (envelope.result === null) {
    return envelope as unknown as PolygonTransactionReceiptResponse;
  }
  if (envelope.result === undefined) {
    if (envelope.error === undefined) throw new Error("API_SCHEMA_INVALID:rpcReceipt:missing_result_or_error");
    return { ...envelope, result: null } as unknown as PolygonTransactionReceiptResponse;
  }
  const receipt = record(envelope.result, "rpcReceipt.result");
  if (typeof receipt.transactionHash !== "string" || !HASH_RE.test(receipt.transactionHash)) {
    throw new Error("API_SCHEMA_INVALID:rpcReceipt.result.transactionHash");
  }
  if (typeof receipt.status !== "string" || !QUANTITY_RE.test(receipt.status)) {
    throw new Error("API_SCHEMA_INVALID:rpcReceipt.result.status");
  }
  if (receipt.blockNumber !== undefined && (
    typeof receipt.blockNumber !== "string" || !QUANTITY_RE.test(receipt.blockNumber)
  )) throw new Error("API_SCHEMA_INVALID:rpcReceipt.result.blockNumber");
  if (!Array.isArray(receipt.logs)) throw new Error("API_SCHEMA_INVALID:rpcReceipt.result.logs");
  receipt.logs.forEach((value, index) => {
    const log = record(value, `rpcReceipt.result.logs[${index}]`);
    if (typeof log.address !== "string" || !ADDRESS_RE.test(log.address)) {
      throw new Error(`API_SCHEMA_INVALID:rpcReceipt.result.logs[${index}].address`);
    }
    if (!Array.isArray(log.topics) || log.topics.some((topic) => typeof topic !== "string" || !HASH_RE.test(topic))) {
      throw new Error(`API_SCHEMA_INVALID:rpcReceipt.result.logs[${index}].topics`);
    }
    if (typeof log.data !== "string" || !HEX_RE.test(log.data)) {
      throw new Error(`API_SCHEMA_INVALID:rpcReceipt.result.logs[${index}].data`);
    }
    if (log.logIndex !== undefined && (
      typeof log.logIndex !== "string" || !QUANTITY_RE.test(log.logIndex)
    )) throw new Error(`API_SCHEMA_INVALID:rpcReceipt.result.logs[${index}].logIndex`);
  });
  return envelope as unknown as PolygonTransactionReceiptResponse;
}
