import { decodeAbiParameters } from "viem";
import type { ApiCapture, ClobMarketByToken } from "../adapters/polymarket-public.js";
import {
  ORDER_FILLED_TOPIC,
  POLYMARKET_CTF_EXCHANGES,
  type PolygonBlockHeader,
  type PolygonBlockNumberResponse,
  type PolygonBlockResponse,
  type PolygonLogsResponse,
  type PolygonOrderFilledLog,
} from "../adapters/polygon-order-filled.js";
import { scaledToDecimal } from "../domain/fixed.js";
import type { PublicTrade } from "../domain/models.js";

export {
  ORDER_FILLED_TOPIC,
  POLYMARKET_CTF_EXCHANGES,
};
export type {
  PolygonBlockHeader,
  PolygonBlockNumberResponse,
  PolygonBlockResponse,
  PolygonLogsResponse,
  PolygonOrderFilledLog,
};

const ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const HASH_RE = /^0x[0-9a-f]{64}$/;
const HEX_DATA_RE = /^0x(?:[0-9a-f]{2})*$/;
const QUANTITY_RE = /^0x(?:0|[1-9a-f][0-9a-f]*)$/;
const DATA_API_PRICE_DIGITS = 10;
const MAX_BLOCK_RANGE = 1_000n;

export interface PolygonOrderFilledFeedProvider {
  polygonBlockNumber(signal?: AbortSignal): Promise<ApiCapture<PolygonBlockNumberResponse>>;
  polygonBlock(blockNumber: string, signal?: AbortSignal): Promise<ApiCapture<PolygonBlockResponse>>;
  polygonOrderFilledLogs(
    exchangeAddress: string,
    makerAddress: string,
    fromBlock: string,
    toBlock: string,
    signal?: AbortSignal,
  ): Promise<ApiCapture<PolygonLogsResponse>>;
  clobMarketByToken(tokenId: string, signal?: AbortSignal): Promise<ApiCapture<ClobMarketByToken>>;
}

export interface PolygonOrderFilledEvidence {
  evidenceVersion: "v1.0.0";
  walletAddress: string;
  confirmationDepth: number;
  fromBlock: string;
  toBlock: string;
  confirmedHead: string;
  logs: PolygonOrderFilledLog[];
  blockHeaders: PolygonBlockHeader[];
  marketBindings: ClobMarketByToken[];
  trades: PublicTrade[];
  reorgRecovery?: {
    reorgedCursorBlock: string;
    previousCursorHash: string;
    canonicalCursorHash: string;
    reanchorBlock: string;
    reanchorHash: string;
  } | null;
}

export interface PolygonOrderFilledTradeBatch {
  status: "INITIALIZING" | "AVAILABLE";
  confirmedHead: string;
  fromBlock: string | null;
  toBlock: string | null;
  trades: PublicTrade[];
  capture: ApiCapture<PolygonOrderFilledEvidence> | null;
}

export interface PolygonOrderFilledTradeFeedOptions {
  confirmationDepth?: number;
}

export class PolygonOrderFilledFeedUnsafeError extends Error {}

function normalizedAddress(value: string, label: string): string {
  const normalized = value.toLowerCase();
  if (!ADDRESS_RE.test(normalized)) throw new Error(`POLYGON_TRADE_FEED_${label}_INVALID`);
  return normalized;
}

function quantity(value: string | undefined, label: string): bigint {
  const normalized = value?.toLowerCase();
  if (!normalized || !QUANTITY_RE.test(normalized)) {
    throw new Error(`POLYGON_TRADE_FEED_${label}_INVALID`);
  }
  return BigInt(normalized);
}

function quantityHex(value: bigint): string {
  if (value < 0n) throw new Error("POLYGON_TRADE_FEED_BLOCK_NEGATIVE");
  return `0x${value.toString(16)}`;
}

function topicAddress(value: string | undefined, label: string): string {
  const normalized = value?.toLowerCase();
  if (!normalized || !HASH_RE.test(normalized) || !/^0x0{24}[0-9a-f]{40}$/.test(normalized)) {
    throw new Error(`POLYGON_TRADE_FEED_${label}_INVALID`);
  }
  return `0x${normalized.slice(-40)}`;
}

function assertHash(value: string, label: string): string {
  const normalized = value.toLowerCase();
  if (!HASH_RE.test(normalized)) throw new Error(`POLYGON_TRADE_FEED_${label}_INVALID`);
  return normalized;
}

function latestFetchedAt(captures: readonly ApiCapture<unknown>[]): string {
  const result = captures.map((capture) => capture.fetchedAt).sort().at(-1);
  if (!result) throw new Error("POLYGON_TRADE_FEED_CAPTURE_MISSING");
  return result;
}

function blockHeader(capture: ApiCapture<PolygonBlockResponse>, expectedNumber: string): PolygonBlockHeader {
  const header = capture.data.result;
  if (!header) throw new Error(`POLYGON_TRADE_FEED_BLOCK_UNAVAILABLE:${expectedNumber}`);
  const number = quantityHex(quantity(header.number, "BLOCK_NUMBER"));
  if (number !== expectedNumber) throw new Error(`POLYGON_TRADE_FEED_BLOCK_NUMBER_MISMATCH:${expectedNumber}:${number}`);
  assertHash(header.hash, "BLOCK_HASH");
  assertHash(header.parentHash, "PARENT_HASH");
  quantity(header.timestamp, "BLOCK_TIMESTAMP");
  return {
    number,
    hash: header.hash.toLowerCase(),
    parentHash: header.parentHash.toLowerCase(),
    timestamp: quantityHex(quantity(header.timestamp, "BLOCK_TIMESTAMP")),
  };
}

function normalizedDataApiPrice(collateralMicros: bigint, sizeMicros: bigint): string {
  if (collateralMicros <= 0n || sizeMicros <= 0n) throw new Error("POLYGON_TRADE_FEED_AMOUNT_INVALID");
  const scale = 10n ** BigInt(DATA_API_PRICE_DIGITS);
  const rounded = (collateralMicros * scale + sizeMicros / 2n) / sizeMicros;
  if (rounded <= 0n || rounded >= scale) throw new Error("POLYGON_TRADE_FEED_PRICE_INVALID");
  return scaledToDecimal(rounded, DATA_API_PRICE_DIGITS);
}

interface DecodedTargetFill {
  log: PolygonOrderFilledLog;
  orderHash: string;
  asset: string;
  side: "BUY" | "SELL";
  collateralMicros: bigint;
  sizeMicros: bigint;
  price: string;
  size: string;
}

function decodeTargetFill(log: PolygonOrderFilledLog, walletAddress: string): DecodedTargetFill {
  const address = normalizedAddress(log.address, "EXCHANGE_ADDRESS");
  if (!POLYMARKET_CTF_EXCHANGES.includes(address as typeof POLYMARKET_CTF_EXCHANGES[number])) {
    throw new Error(`POLYGON_TRADE_FEED_EXCHANGE_UNSUPPORTED:${address}`);
  }
  if (log.removed) throw new PolygonOrderFilledFeedUnsafeError("POLYGON_TRADE_FEED_REMOVED_LOG");
  if (log.topics.length !== 4 || log.topics[0]?.toLowerCase() !== ORDER_FILLED_TOPIC) {
    throw new Error("POLYGON_TRADE_FEED_ORDER_FILLED_TOPICS_INVALID");
  }
  const orderHash = assertHash(log.topics[1]!, "ORDER_HASH");
  const maker = topicAddress(log.topics[2], "MAKER");
  topicAddress(log.topics[3], "TAKER");
  if (maker !== walletAddress) throw new Error("POLYGON_TRADE_FEED_MAKER_MISMATCH");
  assertHash(log.blockHash, "LOG_BLOCK_HASH");
  assertHash(log.transactionHash, "TRANSACTION_HASH");
  quantity(log.blockNumber, "LOG_BLOCK_NUMBER");
  quantity(log.transactionIndex, "TRANSACTION_INDEX");
  quantity(log.logIndex, "LOG_INDEX");
  if (!HEX_DATA_RE.test(log.data.toLowerCase())) throw new Error("POLYGON_TRADE_FEED_LOG_DATA_INVALID");
  let decoded: readonly [number, bigint, bigint, bigint, bigint, `0x${string}`, `0x${string}`];
  try {
    decoded = decodeAbiParameters(
      [
        { type: "uint8" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "bytes32" },
        { type: "bytes32" },
      ],
      log.data as `0x${string}`,
    );
  } catch {
    throw new Error("POLYGON_TRADE_FEED_ORDER_FILLED_DATA_INVALID");
  }
  const [sideValue, tokenId, makerAmountFilled, takerAmountFilled] = decoded;
  if (sideValue !== 0 && sideValue !== 1) throw new Error(`POLYGON_TRADE_FEED_SIDE_INVALID:${sideValue}`);
  if (tokenId <= 0n) throw new Error("POLYGON_TRADE_FEED_TOKEN_INVALID");
  const isBuy = sideValue === 0;
  const collateralMicros = isBuy ? makerAmountFilled : takerAmountFilled;
  const sizeMicros = isBuy ? takerAmountFilled : makerAmountFilled;
  return {
    log: {
      ...log,
      address,
      blockHash: log.blockHash.toLowerCase(),
      transactionHash: log.transactionHash.toLowerCase(),
      topics: log.topics.map((topic) => topic.toLowerCase()),
      data: log.data.toLowerCase(),
    },
    orderHash,
    asset: tokenId.toString(),
    side: isBuy ? "BUY" : "SELL",
    collateralMicros,
    sizeMicros,
    price: normalizedDataApiPrice(collateralMicros, sizeMicros),
    size: scaledToDecimal(sizeMicros, 6),
  };
}

export class PolygonOrderFilledTradeFeed {
  private readonly confirmationDepth: number;
  private cursorBlock: bigint | null = null;
  private cursorHash: string | null = null;
  private previousCursorBlock: bigint | null = null;
  private previousCursorHash: string | null = null;
  private cursorBatchTargetFillCount = 0;
  private readonly marketCache = new Map<string, ApiCapture<ClobMarketByToken>>();

  constructor(
    private readonly provider: PolygonOrderFilledFeedProvider,
    options: PolygonOrderFilledTradeFeedOptions = {},
  ) {
    this.confirmationDepth = options.confirmationDepth ?? 2;
    if (!Number.isSafeInteger(this.confirmationDepth) || this.confirmationDepth < 1 || this.confirmationDepth > 64) {
      throw new Error("POLYGON_TRADE_FEED_CONFIRMATION_DEPTH_INVALID");
    }
  }

  async poll(walletAddressInput: string, signal?: AbortSignal): Promise<PolygonOrderFilledTradeBatch> {
    const walletAddress = normalizedAddress(walletAddressInput, "WALLET");
    const headCapture = await this.provider.polygonBlockNumber(signal);
    const latestBlock = quantity(headCapture.data.result, "HEAD_BLOCK");
    const depth = BigInt(this.confirmationDepth);
    if (latestBlock < depth) throw new Error("POLYGON_TRADE_FEED_HEAD_BELOW_CONFIRMATION_DEPTH");
    const confirmedHead = latestBlock - depth;
    const confirmedHeadHex = quantityHex(confirmedHead);

    if (this.cursorBlock === null) {
      const capture = await this.provider.polygonBlock(confirmedHeadHex, signal);
      const header = blockHeader(capture, confirmedHeadHex);
      this.cursorBlock = confirmedHead;
      this.cursorHash = header.hash;
      return {
        status: "INITIALIZING",
        confirmedHead: confirmedHeadHex,
        fromBlock: null,
        toBlock: null,
        trades: [],
        capture: null,
      };
    }
    if (this.cursorHash === null) throw new Error("POLYGON_TRADE_FEED_CURSOR_HASH_MISSING");

    let cursorHex = quantityHex(this.cursorBlock);
    let cursorCapture = await this.provider.polygonBlock(cursorHex, signal);
    let currentCursorHeader = blockHeader(cursorCapture, cursorHex);
    const reorgCaptures: ApiCapture<PolygonBlockResponse>[] = [];
    let reorgRecovery: NonNullable<PolygonOrderFilledEvidence["reorgRecovery"]> | null = null;
    if (currentCursorHeader.hash !== this.cursorHash) {
      const reorgedCursorBlock = cursorHex;
      const previousCursorHash = this.cursorHash;
      const verificationCapture = await this.provider.polygonBlock(cursorHex, signal);
      const verifiedCursorHeader = blockHeader(verificationCapture, cursorHex);
      reorgCaptures.push(cursorCapture, verificationCapture);
      if (verifiedCursorHeader.hash === previousCursorHash) {
        cursorCapture = verificationCapture;
        currentCursorHeader = verifiedCursorHeader;
      } else {
        if (
          verifiedCursorHeader.hash !== currentCursorHeader.hash
          || this.previousCursorBlock === null
          || this.previousCursorHash === null
          || this.cursorBatchTargetFillCount > 0
        ) {
          throw new PolygonOrderFilledFeedUnsafeError(
            `POLYGON_TRADE_FEED_CONFIRMED_REORG:${reorgedCursorBlock}`,
          );
        }
        const reanchorBlock = quantityHex(this.previousCursorBlock);
        const reanchorCapture = await this.provider.polygonBlock(reanchorBlock, signal);
        const reanchorHeader = blockHeader(reanchorCapture, reanchorBlock);
        reorgCaptures.push(reanchorCapture);
        if (reanchorHeader.hash !== this.previousCursorHash) {
          throw new PolygonOrderFilledFeedUnsafeError(
            `POLYGON_TRADE_FEED_CONFIRMED_REORG:${reorgedCursorBlock}`,
          );
        }
        reorgRecovery = {
          reorgedCursorBlock,
          previousCursorHash,
          canonicalCursorHash: verifiedCursorHeader.hash,
          reanchorBlock,
          reanchorHash: reanchorHeader.hash,
        };
        this.cursorBlock = this.previousCursorBlock;
        this.cursorHash = this.previousCursorHash;
        cursorHex = reanchorBlock;
        cursorCapture = reanchorCapture;
        currentCursorHeader = reanchorHeader;
      }
    }
    if (confirmedHead <= this.cursorBlock) {
      return {
        status: "AVAILABLE",
        confirmedHead: confirmedHeadHex,
        fromBlock: null,
        toBlock: null,
        trades: [],
        capture: null,
      };
    }
    if (confirmedHead - this.cursorBlock > MAX_BLOCK_RANGE) {
      throw new Error(`POLYGON_TRADE_FEED_BLOCK_RANGE_EXCEEDED:${this.cursorBlock}:${confirmedHead}`);
    }

    const fromBlock = this.cursorBlock + 1n;
    const fromBlockHex = quantityHex(fromBlock);
    const logCaptures = await Promise.all(POLYMARKET_CTF_EXCHANGES.map((exchange) => (
      this.provider.polygonOrderFilledLogs(exchange, walletAddress, fromBlockHex, confirmedHeadHex, signal)
    )));
    const rawLogs = logCaptures.flatMap((capture) => {
      if (!capture.data.result) throw new Error("POLYGON_TRADE_FEED_LOG_RESULT_MISSING");
      return capture.data.result;
    });
    const decoded = rawLogs.map((log) => decodeTargetFill(log, walletAddress)).sort((left, right) => (
      Number(quantity(left.log.blockNumber, "LOG_BLOCK_NUMBER") - quantity(right.log.blockNumber, "LOG_BLOCK_NUMBER"))
      || Number(quantity(left.log.transactionIndex, "TRANSACTION_INDEX") - quantity(right.log.transactionIndex, "TRANSACTION_INDEX"))
      || Number(quantity(left.log.logIndex, "LOG_INDEX") - quantity(right.log.logIndex, "LOG_INDEX"))
    ));
    const grouped = new Map<string, {
      first: DecodedTargetFill;
      lastLogIndex: string;
      collateralMicros: bigint;
      sizeMicros: bigint;
    }>();
    for (const item of decoded) {
      const key = `${item.log.transactionHash}\u0000${item.orderHash}`;
      const prior = grouped.get(key);
      if (!prior) {
        grouped.set(key, {
          first: item,
          lastLogIndex: item.log.logIndex,
          collateralMicros: item.collateralMicros,
          sizeMicros: item.sizeMicros,
        });
        continue;
      }
      if (
        prior.first.asset !== item.asset
        || prior.first.side !== item.side
        || prior.first.log.blockNumber !== item.log.blockNumber
      ) {
        throw new PolygonOrderFilledFeedUnsafeError(
          `POLYGON_TRADE_FEED_ORDER_ECONOMIC_CONFLICT:${item.log.transactionHash}:${item.orderHash}`,
        );
      }
      prior.collateralMicros += item.collateralMicros;
      prior.sizeMicros += item.sizeMicros;
      prior.lastLogIndex = item.log.logIndex;
    }
    const blockNumbers = [...new Set(decoded.map((item) => quantityHex(quantity(item.log.blockNumber, "LOG_BLOCK_NUMBER"))))];
    const blockCaptures = await Promise.all(blockNumbers.map((blockNumber) => this.provider.polygonBlock(blockNumber, signal)));
    const headers = blockCaptures.map((capture, index) => blockHeader(capture, blockNumbers[index]!));
    const headerByNumber = new Map(headers.map((header) => [header.number, header]));
    for (const item of decoded) {
      const header = headerByNumber.get(quantityHex(quantity(item.log.blockNumber, "LOG_BLOCK_NUMBER")));
      if (!header || header.hash !== item.log.blockHash) {
        throw new PolygonOrderFilledFeedUnsafeError(`POLYGON_TRADE_FEED_LOG_BLOCK_MISMATCH:${item.log.transactionHash}`);
      }
    }
    const marketCaptures: ApiCapture<ClobMarketByToken>[] = [];
    for (const asset of [...new Set([...grouped.values()].map((item) => item.first.asset))]) {
      let market = this.marketCache.get(asset);
      if (!market) {
        market = await this.provider.clobMarketByToken(asset, signal);
        if (!/^0x[0-9a-fA-F]{64}$/.test(market.data.condition_id)) {
          throw new Error(`POLYGON_TRADE_FEED_CONDITION_INVALID:${asset}`);
        }
        if (![market.data.primary_token_id, market.data.secondary_token_id].includes(asset)) {
          throw new Error(`POLYGON_TRADE_FEED_MARKET_TOKEN_MISMATCH:${asset}`);
        }
        this.marketCache.set(asset, market);
      }
      marketCaptures.push(market);
    }
    const marketByAsset = new Map<string, ClobMarketByToken>();
    for (const market of marketCaptures) {
      marketByAsset.set(market.data.primary_token_id, market.data);
      marketByAsset.set(market.data.secondary_token_id, market.data);
    }
    const trades = [...grouped.values()].map((group): PublicTrade => {
      const item = group.first;
      const header = headerByNumber.get(quantityHex(quantity(item.log.blockNumber, "LOG_BLOCK_NUMBER")))!;
      const market = marketByAsset.get(item.asset);
      if (!market) throw new Error(`POLYGON_TRADE_FEED_MARKET_BINDING_MISSING:${item.asset}`);
      return {
        proxyWallet: walletAddress,
        transactionHash: item.log.transactionHash,
        orderHash: item.orderHash,
        chainOrder: {
          blockNumber: item.log.blockNumber,
          blockHash: item.log.blockHash,
          transactionIndex: item.log.transactionIndex,
          logIndex: item.log.logIndex,
          lastLogIndex: group.lastLogIndex,
        },
        conditionId: market.condition_id.toLowerCase(),
        asset: item.asset,
        side: item.side,
        price: normalizedDataApiPrice(group.collateralMicros, group.sizeMicros),
        size: scaledToDecimal(group.sizeMicros, 6),
        timestamp: Number(quantity(header.timestamp, "BLOCK_TIMESTAMP")),
      };
    });
    const confirmedHeaderCapture = blockNumbers.includes(confirmedHeadHex)
      ? blockCaptures[blockNumbers.indexOf(confirmedHeadHex)]!
      : await this.provider.polygonBlock(confirmedHeadHex, signal);
    const confirmedHeader = blockHeader(confirmedHeaderCapture, confirmedHeadHex);
    const allCaptures: ApiCapture<unknown>[] = [
      headCapture,
      cursorCapture,
      ...reorgCaptures,
      ...logCaptures,
      ...blockCaptures,
      ...marketCaptures,
      confirmedHeaderCapture,
    ];
    const evidence: PolygonOrderFilledEvidence = {
      evidenceVersion: "v1.0.0",
      walletAddress,
      confirmationDepth: this.confirmationDepth,
      fromBlock: fromBlockHex,
      toBlock: confirmedHeadHex,
      confirmedHead: confirmedHeadHex,
      logs: decoded.map((item) => item.log),
      blockHeaders: headers,
      marketBindings: [...new Map(marketCaptures.map((capture) => [capture.data.condition_id.toLowerCase(), {
        ...capture.data,
        condition_id: capture.data.condition_id.toLowerCase(),
      }])).values()],
      trades,
      reorgRecovery,
    };
    this.previousCursorBlock = this.cursorBlock;
    this.previousCursorHash = this.cursorHash;
    this.cursorBlock = confirmedHead;
    this.cursorHash = confirmedHeader.hash;
    this.cursorBatchTargetFillCount = decoded.length;
    return {
      status: "AVAILABLE",
      confirmedHead: confirmedHeadHex,
      fromBlock: fromBlockHex,
      toBlock: confirmedHeadHex,
      trades,
      capture: {
        url: `ni-k://polygon/order-filled/${walletAddress}/${fromBlockHex}-${confirmedHeadHex}`,
        fetchedAt: latestFetchedAt(allCaptures),
        latencyMs: allCaptures.reduce((total, capture) => total + capture.latencyMs, 0),
        status: 200,
        data: evidence,
      },
    };
  }
}
