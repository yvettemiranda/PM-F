import { Side, SignatureTypeV2, type SignedOrder } from "@polymarket/clob-client-v2";
import { describe, expect, it, vi } from "vitest";
import { BrowserWalletClobSigner } from "../src/live/browser-wallet-clob-signer.js";
import { LiveWalletRequestBroker } from "../src/operator/live-wallet-request-broker.js";
import type { LiveWalletRuntimeBinding } from "../src/operator/live-wallet-session.js";
import { marketRoute, PublicMarketRouteProvider } from "../src/live/market-protocol.js";

const wallet = "0x0000000000000000000000000000000000000001";
const funder = "0x0000000000000000000000000000000000000002";
const zeroBytes32 = `0x${"0".repeat(64)}`;
const v2Asset = (BigInt(`0x${"a".repeat(62)}`) << 8n).toString();
const routeProvider = { resolve: async () => marketRoute({ assetId: v2Asset, conditionId: `0x${"a".repeat(62)}`, version: "v2" }) };

function binding(): LiveWalletRuntimeBinding {
  return {
    session: {
      sessionId: "session-1",
      status: "CONNECTED",
      walletAddress: wallet,
      chainId: 137,
      network: "POLYGON",
      walletType: "EIP1193",
      connectedAt: "2026-07-28T00:00:00.000Z",
      lastSeenAt: "2026-07-28T00:00:00.000Z",
      expiresAt: "2026-07-28T00:30:00.000Z",
    },
    assertCurrent: vi.fn(),
    onInvalidated: vi.fn(() => () => undefined),
  };
}

function signedOrder(overrides: Partial<SignedOrder> = {}): SignedOrder {
  return {
    salt: "1",
    maker: wallet,
    signer: wallet,
    tokenId: v2Asset,
    makerAmount: "5000000",
    takerAmount: "10000000",
    side: Side.BUY,
    signatureType: SignatureTypeV2.EOA,
    timestamp: "1773014400000",
    metadata: zeroBytes32,
    builder: zeroBytes32,
    expiration: "0",
    signature: `0x${"a".repeat(130)}`,
    ...overrides,
  } as SignedOrder;
}

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    side: "BUY",
    assetId: v2Asset,
    amountMicros: "5000000",
    sizeMicros: "10000000",
    budgetMicros: "5100000",
    priceUnits: "500000000000000000",
    feeRateBps: "100",
    feeExponent: 2,
    feeModelVersion: "clob-fd-v1",
    makerAddress: wallet,
    signerAddress: wallet,
    ...overrides,
  };
}

describe("BrowserWalletClobSigner", () => {
  it("reduces the signed cash before signing so improved-price and rounded-fill fees fit the approved budget", async () => {
    const signer = new BrowserWalletClobSigner({
      routeProvider, walletBinding: binding(), requestBroker: new LiveWalletRequestBroker(),
      orderClient: { createExchangeV3OrderFromAmounts: vi.fn(async (input: { makerAmount: string; takerAmount: string }) =>
        signedOrder({ makerAmount: input.makerAmount, takerAmount: input.takerAmount })) },
    });
    const result = await signer.signOrder(payload({ feeRateBps: "700", feeExponent: 1, budgetMicros: "5175000" }));
    const notional = BigInt(result.orderAmountMicros!);
    expect(notional).toBeLessThan(5_000_000n);
    expect(BigInt(result.orderSizeMicros!)).toBeLessThan(10_000_000n);
    expect(BigInt(result.maxTotalCostMicros!)).toBeLessThanOrEqual(5_175_000n);
    // At p=0.4 the unrounded platform fee is 4.2% of cash. The new
    // signed notional plus that fee fits even when received shares increase.
    expect(notional + (notional * 42n + 999n) / 1_000n + 10n).toBeLessThanOrEqual(5_175_000n);
  });

  it("reuses the validated route from the fresh book without another public GET", async () => {
    const resolve = vi.fn(async () => { throw new Error("UNEXPECTED_ROUTE_FETCH"); });
    const route = await routeProvider.resolve();
    const signer = new BrowserWalletClobSigner({
      walletBinding: binding(), requestBroker: new LiveWalletRequestBroker(), routeProvider: { resolve },
      orderClient: { createExchangeV3OrderFromAmounts: vi.fn(async () => signedOrder()) },
    });
    await expect(signer.signOrder(payload({ marketRoute: route, conditionId: route.conditionId }))).resolves.toMatchObject({ marketRoute: route });
    expect(resolve).not.toHaveBeenCalled();
    await expect(signer.signOrder(payload({ marketRoute: { ...route, exchange: funder } })))
      .rejects.toThrow("LIVE_MARKET_ROUTE_CONTRACT_MISMATCH");
  });

  it("uses exact base-unit V3 order amounts and returns fee-budget evidence", async () => {
    const createExchangeV3OrderFromAmounts = vi.fn(async () => signedOrder());
    const signer = new BrowserWalletClobSigner({
      routeProvider,
      walletBinding: binding(),
      requestBroker: new LiveWalletRequestBroker(),
      orderClient: { createExchangeV3OrderFromAmounts },
    });

    const result = await signer.signOrder(payload());

    expect(createExchangeV3OrderFromAmounts).toHaveBeenCalledWith({
      tokenID: v2Asset,
      makerAmount: "5000000",
      takerAmount: "10000000",
      side: Side.BUY,
    });
    expect(result).toMatchObject({
      signerAddress: wallet,
      signature: `0x${"a".repeat(130)}`,
      orderAmountMicros: "5000000",
      orderSizeMicros: "10000000",
      feeModelVersion: "clob-fd-v1",
      signedOrder: expect.objectContaining({ tokenId: v2Asset }),
    });
    expect(BigInt(result.maxTotalCostMicros!)).toBeGreaterThanOrEqual(5_000_000n);
    expect(BigInt(result.maxTotalCostMicros!)).toBeLessThanOrEqual(5_100_000n);
  });

  it("supports a distinct funder for POLY_1271 while retaining the browser EOA identity", async () => {
    const order = signedOrder({
      maker: funder,
      signer: funder,
      signatureType: SignatureTypeV2.POLY_1271,
    });
    const signer = new BrowserWalletClobSigner({
      routeProvider,
      walletBinding: binding(),
      requestBroker: new LiveWalletRequestBroker(),
      signatureType: SignatureTypeV2.POLY_1271,
      funderAddress: funder,
      orderClient: {
        createExchangeV3OrderFromAmounts: vi.fn(async () => order),
      },
    });

    await expect(signer.signOrder(payload({ makerAddress: funder }))).resolves.toMatchObject({
      signerAddress: wallet,
      signedOrder: expect.objectContaining({
        maker: funder,
        signer: funder,
        signatureType: SignatureTypeV2.POLY_1271,
      }),
    });
  });

  it("forwards SDK typed data to the session broker instead of loading a key", async () => {
    const requestBroker = new LiveWalletRequestBroker();
    const signer = new BrowserWalletClobSigner({
      routeProvider,
      walletBinding: binding(),
      requestBroker,
      orderClient: {
        createExchangeV3OrderFromAmounts: vi.fn(async () => signedOrder()),
      },
    });
    const sdkSigner = signer.clobSigner as unknown as {
      signTypedData(input: {
        domain: Record<string, unknown>;
        types: Record<string, Array<{ name: string; type: string }>>;
        primaryType: string;
        message: Record<string, unknown>;
      }): Promise<string>;
    };
    const signaturePromise = sdkSigner.signTypedData({
      domain: { name: "ClobAuthDomain", chainId: 137 },
      types: { ClobAuth: [{ name: "address", type: "address" }] },
      primaryType: "ClobAuth",
      message: { address: wallet },
    });
    const request = requestBroker.next("session-1")!;
    expect(request).toMatchObject({
      method: "eth_signTypedData_v4",
      purpose: "创建或恢复本次钱包会话的 CLOB 凭据",
    });
    const signature = `0x${"b".repeat(130)}`;
    requestBroker.complete({
      sessionId: "session-1",
      requestId: request.requestId,
      result: signature,
    });
    await expect(signaturePromise).resolves.toBe(signature);
  });

  it("rejects a signed order whose SDK identity does not match the configured account", async () => {
    const signer = new BrowserWalletClobSigner({
      routeProvider,
      walletBinding: binding(),
      requestBroker: new LiveWalletRequestBroker(),
      orderClient: {
        createExchangeV3OrderFromAmounts: vi.fn(async () => signedOrder({ maker: funder })),
      },
    });

    await expect(signer.signOrder(payload())).rejects.toThrow("LIVE_SIGNER_SDK_MAKER_MISMATCH");
  });

  it.each([
    { neg_risk: false, version: undefined, domain: "2", exchange: "0xE111180000d2663C0091e4f400237545B87B996B" },
    { neg_risk: true, version: undefined, domain: "2", exchange: "0xe2222d279d744050d28e00520010520000310F59" },
    { neg_risk: false, version: "v2", domain: "3", exchange: "0xe3333700cA9d93003F00f0F71f8515005F6c00Aa" },
  ])("uses the real SDK signing domain for market route $exchange", async ({ neg_risk, version, domain, exchange }) => {
    const assetId = version === "v2" ? v2Asset : "123";
    const route = marketRoute({ assetId, conditionId: `0x${"a".repeat(version === "v2" ? 62 : 64)}`, neg_risk, version });
    const broker = new LiveWalletRequestBroker();
    const request = vi.spyOn(broker, "requestTypedData").mockResolvedValue(`0x${"a".repeat(130)}`);
    const signer = new BrowserWalletClobSigner({ walletBinding: binding(), requestBroker: broker, routeProvider: { resolve: async () => route } });
    const result = await signer.signOrder(payload({ assetId }));
    expect(request.mock.calls[0]?.[1].domain).toMatchObject({ version: domain, verifyingContract: exchange, chainId: 137 });
    expect(result.marketRoute).toEqual(route);
    expect(result.signedOrder).toMatchObject({ makerAmount: "5000000", takerAmount: "10000000" });
  });

  it("recovers an ended CTF route from matching market metadata after its book disappears", async () => {
    const conditionId = `0x${"b".repeat(64)}`;
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response("missing", { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ condition_id: conditionId, neg_risk: true, tokens: [{ token_id: "123" }] })));
    const route = await new PublicMarketRouteProvider(fetchImpl).resolve("123", conditionId);
    expect(route).toMatchObject({ protocol: "CTF_NEG_RISK", assetId: "123", conditionId });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(() => marketRoute({ assetId: "123", conditionId: `0x${"b".repeat(62)}`, version: "v2" }))
      .toThrow("LIVE_MARKET_V2_ASSET_CONDITION_MISMATCH");
  });
});
