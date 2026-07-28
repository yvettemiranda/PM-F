import { Side, SignatureTypeV2, type SignedOrder } from "@polymarket/clob-client-v2";
import { describe, expect, it, vi } from "vitest";
import { BrowserWalletClobSigner } from "../src/live/browser-wallet-clob-signer.js";
import { LiveWalletRequestBroker } from "../src/operator/live-wallet-request-broker.js";
import type { LiveWalletRuntimeBinding } from "../src/operator/live-wallet-session.js";

const wallet = "0x0000000000000000000000000000000000000001";
const funder = "0x0000000000000000000000000000000000000002";
const zeroBytes32 = `0x${"0".repeat(64)}`;

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
    tokenId: "123",
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
    assetId: "123",
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
  it("uses exact base-unit V3 order amounts and returns fee-budget evidence", async () => {
    const createExchangeV3OrderFromAmounts = vi.fn(async () => signedOrder());
    const signer = new BrowserWalletClobSigner({
      walletBinding: binding(),
      requestBroker: new LiveWalletRequestBroker(),
      orderClient: { createExchangeV3OrderFromAmounts },
    });

    const result = await signer.signOrder(payload());

    expect(createExchangeV3OrderFromAmounts).toHaveBeenCalledWith({
      tokenID: "123",
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
      signedOrder: expect.objectContaining({ tokenId: "123" }),
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
      walletBinding: binding(),
      requestBroker: new LiveWalletRequestBroker(),
      orderClient: {
        createExchangeV3OrderFromAmounts: vi.fn(async () => signedOrder({ maker: funder })),
      },
    });

    await expect(signer.signOrder(payload())).rejects.toThrow("LIVE_SIGNER_SDK_MAKER_MISMATCH");
  });
});
