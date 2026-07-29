import { OrderType, SignatureTypeV2, type ClobClient, type ClobClientOptions } from "@polymarket/clob-client-v2";
import { describe, expect, it, vi } from "vitest";
import { SessionAuthenticatedClobClient } from "../src/live/session-authenticated-clob-client.js";
import type {
  LiveWalletRuntimeBinding,
  LiveWalletSessionInvalidationReason,
} from "../src/operator/live-wallet-session.js";

const wallet = "0x0000000000000000000000000000000000000001";

function bindingHarness(): {
  binding: LiveWalletRuntimeBinding;
  invalidate(reason?: LiveWalletSessionInvalidationReason): void;
} {
  let current = true;
  const listeners = new Set<(reason: LiveWalletSessionInvalidationReason) => void | Promise<void>>();
  return {
    binding: {
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
      assertCurrent: vi.fn(() => {
        if (!current) throw new Error("LIVE_WALLET_SESSION_INVALIDATED");
      }),
      onInvalidated: vi.fn((listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }),
    },
    invalidate(reason = "DISCONNECTED") {
      current = false;
      for (const listener of listeners) void listener(reason);
    },
  };
}

function createHarness() {
  const instances: Array<{ options: ClobClientOptions; client: ClobClient }> = [];
  const createOrDeriveApiKey = vi.fn(async () => ({
    key: "session-key",
    secret: "session-secret",
    passphrase: "session-passphrase",
  }));
  const deriveApiKey = vi.fn(async () => ({
    key: "derived-session-key",
    secret: "derived-session-secret",
    passphrase: "derived-session-passphrase",
  }));
  const getOpenOrders = vi.fn(async () => []);
  const postOrder = vi.fn(async () => ({
    success: true,
    errorMsg: "",
    orderID: "order-1",
    tradeIDs: [],
    status: "live",
    takingAmount: "0",
    makingAmount: "0",
  }));
  const factory = vi.fn((options: ClobClientOptions) => {
    const client = {
      createOrDeriveApiKey,
      deriveApiKey,
      getOpenOrders,
      postOrder,
      getFeeExponent: vi.fn(async () => 2),
    } as unknown as ClobClient;
    instances.push({ options, client });
    return client;
  });
  return { factory, instances, createOrDeriveApiKey, deriveApiKey, getOpenOrders, postOrder };
}

describe("SessionAuthenticatedClobClient", () => {
  it("derives one session credential set lazily and reuses only the in-memory SDK client", async () => {
    const session = bindingHarness();
    const harness = createHarness();
    const client = new SessionAuthenticatedClobClient({
      walletBinding: session.binding,
      signer: { account: { address: wallet } } as never,
      signatureType: SignatureTypeV2.EOA,
      funderAddress: wallet,
      clientFactory: harness.factory,
    });

    expect(harness.factory).toHaveBeenCalledTimes(1);
    expect(harness.createOrDeriveApiKey).not.toHaveBeenCalled();
    await Promise.all([client.getOpenOrders(), client.getOpenOrders()]);

    expect(harness.createOrDeriveApiKey).toHaveBeenCalledTimes(1);
    expect(harness.factory).toHaveBeenCalledTimes(2);
    expect(harness.instances[1]?.options.creds).toEqual({
      key: "session-key",
      secret: "session-secret",
      passphrase: "session-passphrase",
    });
    expect(harness.getOpenOrders).toHaveBeenCalledTimes(2);
  });

  it("derives an existing API key when SDK key creation reports that one already exists", async () => {
    const session = bindingHarness();
    const harness = createHarness();
    harness.createOrDeriveApiKey.mockRejectedValueOnce(new Error("Could not create api key"));
    const client = new SessionAuthenticatedClobClient({
      walletBinding: session.binding,
      signer: { account: { address: wallet } } as never,
      signatureType: SignatureTypeV2.EOA,
      funderAddress: wallet,
      clientFactory: harness.factory,
    });

    await expect(client.getOpenOrders()).resolves.toEqual([]);

    expect(harness.createOrDeriveApiKey).toHaveBeenCalledTimes(1);
    expect(harness.deriveApiKey).toHaveBeenCalledTimes(1);
    expect(harness.instances[1]?.options.creds).toEqual({
      key: "derived-session-key",
      secret: "derived-session-secret",
      passphrase: "derived-session-passphrase",
    });
  });

  it("does not mask unrelated API credential failures with a derive attempt", async () => {
    const session = bindingHarness();
    const harness = createHarness();
    harness.createOrDeriveApiKey.mockRejectedValueOnce(new Error("Invalid L1 Request headers"));
    const client = new SessionAuthenticatedClobClient({
      walletBinding: session.binding,
      signer: { account: { address: wallet } } as never,
      signatureType: SignatureTypeV2.EOA,
      funderAddress: wallet,
      clientFactory: harness.factory,
    });

    await expect(client.getOpenOrders()).rejects.toThrow("Invalid L1 Request headers");
    expect(harness.deriveApiKey).not.toHaveBeenCalled();
  });

  it("drops the authenticated client and refuses every later call after wallet invalidation", async () => {
    const session = bindingHarness();
    const harness = createHarness();
    const client = new SessionAuthenticatedClobClient({
      walletBinding: session.binding,
      signer: { account: { address: wallet } } as never,
      signatureType: SignatureTypeV2.EOA,
      funderAddress: wallet,
      clientFactory: harness.factory,
    });
    await client.getOpenOrders();

    session.invalidate();

    await expect(client.getOpenOrders()).rejects.toThrow("LIVE_CLOB_SESSION_INVALIDATED");
    await expect(client.postOrder({} as never, OrderType.FAK)).rejects.toThrow(
      "LIVE_CLOB_SESSION_INVALIDATED",
    );
    expect(harness.createOrDeriveApiKey).toHaveBeenCalledTimes(1);
  });

  it("does not publish a client if the wallet is invalidated during credential derivation", async () => {
    const session = bindingHarness();
    let resolveCredentials!: (value: { key: string; secret: string; passphrase: string }) => void;
    const pendingCredentials = new Promise<{ key: string; secret: string; passphrase: string }>(
      (resolve) => {
        resolveCredentials = resolve;
      },
    );
    const factory = vi.fn((options: ClobClientOptions) => ({
      createOrDeriveApiKey: vi.fn(() => pendingCredentials),
      getOpenOrders: vi.fn(async () => []),
      options,
    }) as unknown as ClobClient);
    const client = new SessionAuthenticatedClobClient({
      walletBinding: session.binding,
      signer: { account: { address: wallet } } as never,
      signatureType: SignatureTypeV2.EOA,
      funderAddress: wallet,
      clientFactory: factory,
    });
    const request = client.getOpenOrders();

    session.invalidate("EXPIRED");
    resolveCredentials({ key: "k", secret: "s", passphrase: "p" });

    await expect(request).rejects.toThrow("LIVE_CLOB_SESSION_INVALIDATED");
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the wallet is invalidated while an authenticated request is in flight", async () => {
    const session = bindingHarness();
    let resolveOrders!: (value: []) => void;
    const pendingOrders = new Promise<[]>((resolve) => {
      resolveOrders = resolve;
    });
    const factory = vi.fn((options: ClobClientOptions) => ({
      createOrDeriveApiKey: vi.fn(async () => ({
        key: "session-key",
        secret: "session-secret",
        passphrase: "session-passphrase",
      })),
      getOpenOrders: vi.fn(() => pendingOrders),
      options,
    }) as unknown as ClobClient);
    const client = new SessionAuthenticatedClobClient({
      walletBinding: session.binding,
      signer: { account: { address: wallet } } as never,
      signatureType: SignatureTypeV2.EOA,
      funderAddress: wallet,
      clientFactory: factory,
    });
    const request = client.getOpenOrders();
    await vi.waitFor(() => expect(factory).toHaveBeenCalledTimes(2));

    session.invalidate("DISCONNECTED");
    resolveOrders([]);

    await expect(request).rejects.toThrow("LIVE_CLOB_SESSION_INVALIDATED");
  });
});
