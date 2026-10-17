import { ClobClient, OrderType, Side, SignatureTypeV2, type ClobClientOptions, type SignedOrder } from "@polymarket/clob-client-v2";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { SessionAuthenticatedClobClient } from "../src/live/session-authenticated-clob-client.js";
import { OrderSubmissionNotSentError } from "../src/live/order-adapter.js";
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

function barrier() {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const wait = new Promise<void>((resolve) => { release = resolve; });
  return { enter, entered, release, wait };
}

function sdkOrder(): SignedOrder {
  return { salt: "1", maker: wallet, signer: wallet, tokenId: "1", makerAmount: "5000000", takerAmount: "10000000",
    side: Side.BUY, signatureType: SignatureTypeV2.EOA, timestamp: "1773014400000", expiration: "0",
    metadata: `0x${"0".repeat(64)}`, builder: `0x${"0".repeat(64)}`, signature: `0x${"1".repeat(130)}` } as SignedOrder;
}

async function realSdkHarness() {
  const session = bindingHarness();
  const timePauses: ReturnType<typeof barrier>[] = [];
  const authPauses: ReturnType<typeof barrier>[] = [];
  let orderPosts = 0;
  const server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    const path = new URL(request.url!, "http://localhost").pathname;
    if (path === "/time") {
      const pause = timePauses.shift();
      if (pause) { pause.enter(); await pause.wait; }
      response.end("1773014400");
    } else if (path === "/auth/api-key") {
      const pause = authPauses.shift();
      if (pause) { pause.enter(); await pause.wait; }
      response.end(JSON.stringify({ apiKey: "key", secret: Buffer.from("secret").toString("base64"), passphrase: "passphrase" }));
    } else if (path === "/order") {
      orderPosts += 1;
      response.end(JSON.stringify({ success: true, orderID: `order-${orderPosts}`, status: "live", tradeIDs: [] }));
    } else response.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const client = new SessionAuthenticatedClobClient({
    walletBinding: session.binding,
    signer: { account: { address: wallet }, signTypedData: async () => `0x${"1".repeat(130)}` } as never,
    signatureType: SignatureTypeV2.EOA, funderAddress: wallet, clobHost: host,
  });
  return { client, session, timePauses, authPauses, orderPosts: () => orderPosts,
    close: async () => { client.invalidate(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); } };
}

describe("SessionAuthenticatedClobClient", () => {
  it("checks the guard after the real SDK's server-time and L2-header awaits", async () => {
    const harness = await realSdkHarness();
    const pause = barrier();
    try {
      await harness.client.getClosedOnlyMode();
      harness.timePauses.push(pause);
      let cancelled = false;
      const pending = harness.client.postOrderGuarded(sdkOrder(), OrderType.FAK, { beforeSubmit() {
        if (cancelled) throw new Error("ORDERBOOK_STALE_BEFORE_POST");
      } }).catch((error: unknown) => error);
      await pause.entered;
      cancelled = true;
      pause.release();
      const error = await pending;
      expect(error).toBeInstanceOf(OrderSubmissionNotSentError);
      expect((error as Error).message).toBe("ORDERBOOK_STALE_BEFORE_POST");
      expect(harness.orderPosts()).toBe(0);
      await expect(harness.client.postOrderGuarded(sdkOrder(), OrderType.FAK, { beforeSubmit() {} }))
        .resolves.toMatchObject({ success: true });
      expect(harness.orderPosts()).toBe(1);
    } finally { pause.release(); await harness.close(); }
  });

  it("does not submit an order cancelled while real SDK credential authentication is pending", async () => {
    const harness = await realSdkHarness();
    const pause = barrier();
    try {
      harness.authPauses.push(pause);
      let cancelled = false;
      const pending = harness.client.postOrderGuarded(sdkOrder(), OrderType.FAK, { beforeSubmit() {
        if (cancelled) throw new Error("LIVE_GATE_CHANGED_BEFORE_POST");
      } }).catch((error: unknown) => error);
      await pause.entered;
      cancelled = true;
      pause.release();
      const error = await pending;
      expect(error).toBeInstanceOf(OrderSubmissionNotSentError);
      expect((error as Error).message).toBe("LIVE_GATE_CHANGED_BEFORE_POST");
      expect(harness.orderPosts()).toBe(0);
    } finally { pause.release(); await harness.close(); }
  });

  it("isolates concurrent real SDK order guards across server-time awaits", async () => {
    const harness = await realSdkHarness();
    const blocked = barrier(), allowed = barrier();
    try {
      await harness.client.getClosedOnlyMode();
      harness.timePauses.push(blocked, allowed);
      let cancelled = false;
      const first = harness.client.postOrderGuarded(sdkOrder(), OrderType.FAK, { beforeSubmit() {
        if (cancelled) throw new Error("FIRST_ORDER_CANCELLED");
      } }).catch((error: unknown) => error);
      await blocked.entered;
      const second = harness.client.postOrderGuarded(sdkOrder(), OrderType.FAK, { beforeSubmit() {} });
      await allowed.entered;
      cancelled = true;
      allowed.release();
      await expect(second).resolves.toMatchObject({ success: true });
      blocked.release();
      expect(await first).toBeInstanceOf(OrderSubmissionNotSentError);
      expect(harness.orderPosts()).toBe(1);
    } finally { blocked.release(); allowed.release(); await harness.close(); }
  });

  it.each(["server-time", "authentication"])("does not POST after wallet expiry during %s", async (stage) => {
    const harness = await realSdkHarness();
    const pause = barrier();
    try {
      if (stage === "server-time") {
        await harness.client.getClosedOnlyMode();
        harness.timePauses.push(pause);
      } else harness.authPauses.push(pause);
      const pending = harness.client.postOrderGuarded(sdkOrder(), OrderType.FAK, { beforeSubmit() {} })
        .catch((error: unknown) => error);
      await pause.entered;
      harness.session.invalidate("EXPIRED");
      pause.release();
      expect(await pending).toBeInstanceOf(OrderSubmissionNotSentError);
      expect(harness.orderPosts()).toBe(0);
    } finally { pause.release(); await harness.close(); }
  });

  it("fails closed when a factory changes the pinned SDK order transport shape", async () => {
    const harness = createHarness(), session = bindingHarness();
    const client = new SessionAuthenticatedClobClient({ walletBinding: session.binding,
      signer: { account: { address: wallet } } as never, signatureType: SignatureTypeV2.EOA,
      funderAddress: wallet, clientFactory: harness.factory });
    await expect(client.postOrderGuarded(sdkOrder(), OrderType.FAK, { beforeSubmit() {} }))
      .rejects.toThrow("LIVE_CLOB_ORDER_TRANSPORT_UNSUPPORTED");
    expect(harness.postOrder).not.toHaveBeenCalled();
    client.invalidate();
  });
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
