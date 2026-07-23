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
import {
  POLYGON_ORDER_FILLED_WEBSOCKET_URL,
  PolygonOrderFilledWakeFeed,
  type PolygonWakeWebSocket,
} from "../src/observe/polygon-order-filled-wake-feed.js";

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

function targetBuyLog(options: {
  orderHashDigit: string;
  logIndex: number;
  collateralMicros: bigint;
  sizeMicros: bigint;
}) {
  return {
    address: POLYMARKET_CTF_EXCHANGES[0],
    blockNumber: "0x65",
    blockHash: `0x${"b".repeat(64)}`,
    transactionHash,
    transactionIndex: "0x1",
    logIndex: toHex(options.logIndex),
    removed: false,
    topics: [
      ORDER_FILLED_TOPIC,
      `0x${options.orderHashDigit.repeat(64)}`,
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
        options.collateralMicros,
        options.sizeMicros,
        0n,
        toHex(0n, { size: 32 }),
        toHex(0n, { size: 32 }),
      ],
    ),
  } as const;
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

  it("aggregates fills from the same order and keeps independent orders in one transaction separate", async () => {
    const logs = [
      targetBuyLog({ orderHashDigit: "4", logIndex: 1, collateralMicros: 1_000_000n, sizeMicros: 2_000_000n }),
      targetBuyLog({ orderHashDigit: "4", logIndex: 2, collateralMicros: 3_000_000n, sizeMicros: 4_000_000n }),
      targetBuyLog({ orderHashDigit: "5", logIndex: 3, collateralMicros: 2_000_000n, sizeMicros: 4_000_000n }),
    ];
    const blockNumbers = ["0x66", "0x67"];
    const provider: PolygonOrderFilledFeedProvider = {
      async polygonBlockNumber(): Promise<ApiCapture<PolygonBlockNumberResponse>> {
        return capture({ jsonrpc: "2.0", id: 10, result: blockNumbers.shift()! });
      },
      async polygonBlock(blockNumber): Promise<ApiCapture<PolygonBlockResponse>> {
        return capture(blockNumber === "0x64"
          ? block("0x64", "a", 1_774_172_560)
          : block("0x65", "b", 1_774_172_562));
      },
      async polygonOrderFilledLogs(exchange, _maker, fromBlock): Promise<ApiCapture<PolygonLogsResponse>> {
        return capture({
          jsonrpc: "2.0",
          id: 11,
          result: exchange === POLYMARKET_CTF_EXCHANGES[0] && fromBlock === "0x65" ? logs : [],
        });
      },
      async clobMarketByToken(): Promise<ApiCapture<ClobMarketByToken>> {
        return capture({
          condition_id: conditionId,
          primary_token_id: asset,
          secondary_token_id: "42",
        });
      },
    };
    const feed = new PolygonOrderFilledTradeFeed(provider, { confirmationDepth: 2 });

    await feed.poll(wallet);
    const detected = await feed.poll(wallet);

    expect(detected.trades).toEqual([
      expect.objectContaining({
        orderHash: `0x${"4".repeat(64)}`,
        price: "0.6666666667",
        size: "6",
      }),
      expect.objectContaining({
        orderHash: `0x${"5".repeat(64)}`,
        price: "0.5",
        size: "4",
      }),
    ]);
    expect(detected.capture?.data.logs).toHaveLength(3);
  });

  it("subscribes to only the target maker logs and treats the public WebSocket message as a wake hint", async () => {
    class FakeSocket implements PolygonWakeWebSocket {
      readyState = 0;
      readonly sent: string[] = [];
      private readonly listeners = new Map<string, Array<(event: { data?: unknown }) => void>>();

      addEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
        const listeners = this.listeners.get(type) ?? [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
      }

      send(data: string): void {
        this.sent.push(data);
      }

      close(): void {
        this.readyState = 3;
        this.emit("close");
      }

      emit(type: string, data?: unknown): void {
        for (const listener of this.listeners.get(type) ?? []) listener({ data });
      }
    }

    const socket = new FakeSocket();
    let openedUrl: string | null = null;
    const feed = new PolygonOrderFilledWakeFeed({
      socketFactory: (url) => {
        openedUrl = url;
        return socket;
      },
    });
    const waiting = feed.waitForWake(wallet, 30_000);
    socket.readyState = 1;
    socket.emit("open");
    expect(openedUrl).toBe(POLYGON_ORDER_FILLED_WEBSOCKET_URL);
    const request = JSON.parse(socket.sent[0]!) as {
      method: string;
      params: [string, { address: string[]; topics: [string, null, string] }];
    };
    expect(request).toMatchObject({
      method: "eth_subscribe",
      params: ["logs", {
        address: [...POLYMARKET_CTF_EXCHANGES],
        topics: [ORDER_FILLED_TOPIC, null, pad(wallet as `0x${string}`, { size: 32 })],
      }],
    });
    socket.emit("message", JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0xsubscription" }));
    socket.emit("message", JSON.stringify({
      jsonrpc: "2.0",
      method: "eth_subscription",
      params: {
        subscription: "0xsubscription",
        result: {
          address: POLYMARKET_CTF_EXCHANGES[0],
          topics: [
            ORDER_FILLED_TOPIC,
            `0x${"3".repeat(64)}`,
            pad(wallet as `0x${string}`, { size: 32 }),
            pad(POLYMARKET_CTF_EXCHANGES[0] as `0x${string}`, { size: 32 }),
          ],
          removed: false,
        },
      },
    }));

    await expect(waiting).resolves.toBe("WAKE");
    feed.close();
  });
});
