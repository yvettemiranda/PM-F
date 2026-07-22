import { encodeAbiParameters, pad, toHex } from "viem";
import { describe, expect, it } from "vitest";
import type { ApiCapture, ClobMarketByToken } from "../src/adapters/polymarket-public.js";
import {
  ORDER_FILLED_TOPIC,
  POLYMARKET_CTF_EXCHANGES,
  PolygonOrderFilledTradeFeed,
  type PolygonBlockNumberResponse,
  type PolygonBlockResponse,
  type PolygonLogsResponse,
  type PolygonOrderFilledFeedProvider,
} from "../src/observe/polygon-order-filled-trade-feed.js";

const wallet = "0x1f9e15f39bbd5d163b0eacf0fbef647ced9e4f1a";
const transactionHash = "0xb68833e931e9a298357e3200d5242599624eaaa1caf798c15f7941e416217c83";
const asset = "30518385375198439635185229487622977022492810585983145828956543777339451661080";
const conditionId = `0x${"2".repeat(64)}`;

function capture<T>(data: T, fetchedAt = "2026-07-22T08:42:45.000Z"): ApiCapture<T> {
  return {
    url: "https://polygon.example.test",
    fetchedAt,
    latencyMs: 5,
    status: 200,
    data,
  };
}

function block(number: string, hashDigit: string, timestamp: number): PolygonBlockResponse {
  return {
    jsonrpc: "2.0",
    id: 12,
    result: {
      number,
      hash: `0x${hashDigit.repeat(64)}`,
      parentHash: `0x${"9".repeat(64)}`,
      timestamp: toHex(timestamp),
    },
  };
}

describe("PolygonOrderFilledTradeFeed", () => {
  it("publishes a canonical target BUY before Data API publication and never replays the same block", async () => {
    const blockNumbers = ["0x66", "0x67", "0x67"];
    const log = {
      address: POLYMARKET_CTF_EXCHANGES[0],
      blockNumber: "0x65",
      blockHash: `0x${"b".repeat(64)}`,
      transactionHash,
      transactionIndex: "0x1",
      logIndex: "0x2dd",
      removed: false,
      topics: [
        ORDER_FILLED_TOPIC,
        `0x${"3".repeat(64)}`,
        pad(wallet as `0x${string}`, { size: 32 }),
        pad(POLYMARKET_CTF_EXCHANGES[0] as `0x${string}`, { size: 32 }),
      ],
      data: encodeAbiParameters(
        [
          { type: "uint8" },
          { type: "uint256" },
          { type: "uint256" },
          { type: "uint256" },
          { type: "uint256" },
          { type: "bytes32" },
          { type: "bytes32" },
        ],
        [
          0,
          BigInt(asset),
          870_853_000n,
          1_208_580_000n,
          0n,
          toHex(0n, { size: 32 }),
          toHex(0n, { size: 32 }),
        ],
      ),
    } as const;
    const requestedRanges: Array<[string, string, string]> = [];
    const provider: PolygonOrderFilledFeedProvider = {
      async polygonBlockNumber(): Promise<ApiCapture<PolygonBlockNumberResponse>> {
        return capture({ jsonrpc: "2.0", id: 10, result: blockNumbers.shift()! });
      },
      async polygonBlock(blockNumber): Promise<ApiCapture<PolygonBlockResponse>> {
        return capture(blockNumber === "0x64"
          ? block("0x64", "a", 1_774_172_560)
          : block("0x65", "b", 1_774_172_562));
      },
      async polygonOrderFilledLogs(exchange, _maker, fromBlock, toBlock): Promise<ApiCapture<PolygonLogsResponse>> {
        requestedRanges.push([exchange, fromBlock, toBlock]);
        return capture({
          jsonrpc: "2.0",
          id: 11,
          result: exchange === POLYMARKET_CTF_EXCHANGES[0] && fromBlock === "0x65" ? [log] : [],
        });
      },
      async clobMarketByToken(tokenId): Promise<ApiCapture<ClobMarketByToken>> {
        expect(tokenId).toBe(asset);
        return capture({
          condition_id: conditionId,
          primary_token_id: asset,
          secondary_token_id: "42",
        });
      },
    };
    const feed = new PolygonOrderFilledTradeFeed(provider, { confirmationDepth: 2 });

    expect(await feed.poll(wallet)).toMatchObject({ status: "INITIALIZING", trades: [] });
    const detected = await feed.poll(wallet);
    expect(detected).toMatchObject({
      status: "AVAILABLE",
      fromBlock: "0x65",
      toBlock: "0x65",
      confirmedHead: "0x65",
      trades: [{
        proxyWallet: wallet,
        transactionHash,
        conditionId,
        asset,
        side: "BUY",
        price: "0.7205588376",
        size: "1208.58",
        timestamp: 1_774_172_562,
      }],
    });
    expect(detected.capture?.data.logs).toHaveLength(1);
    expect(detected.capture?.data.blockHeaders).toHaveLength(1);

    expect(await feed.poll(wallet)).toMatchObject({ status: "AVAILABLE", trades: [] });
    expect(requestedRanges).toEqual([
      [POLYMARKET_CTF_EXCHANGES[0], "0x65", "0x65"],
      [POLYMARKET_CTF_EXCHANGES[1], "0x65", "0x65"],
    ]);
  });
});
