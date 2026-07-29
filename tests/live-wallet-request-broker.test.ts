import { describe, expect, it, vi } from "vitest";
import { LiveWalletRequestBroker } from "../src/operator/live-wallet-request-broker.js";
import type {
  LiveWalletRuntimeBinding,
  LiveWalletSessionInvalidationReason,
} from "../src/operator/live-wallet-session.js";

function binding() {
  let invalidationListener:
    | ((reason: LiveWalletSessionInvalidationReason) => void | Promise<void>)
    | undefined;
  const runtimeBinding: LiveWalletRuntimeBinding = {
    session: {
      sessionId: "session-1",
      status: "CONNECTED",
      walletAddress: "0x0000000000000000000000000000000000000001",
      chainId: 137,
      network: "POLYGON",
      walletType: "EIP1193",
      connectedAt: "2026-07-28T00:00:00.000Z",
      lastSeenAt: "2026-07-28T00:00:00.000Z",
      expiresAt: "2026-07-28T00:30:00.000Z",
    },
    assertCurrent: vi.fn(),
    onInvalidated: vi.fn((listener) => {
      invalidationListener = listener;
      return () => {
        invalidationListener = undefined;
      };
    }),
  };
  return {
    runtimeBinding,
    invalidate(reason: LiveWalletSessionInvalidationReason) {
      return invalidationListener?.(reason);
    },
  };
}

describe("LiveWalletRequestBroker", () => {
  it("delivers one session-bound typed-data request and resolves its signature once", async () => {
    const fixture = binding();
    const broker = new LiveWalletRequestBroker({
      now: () => new Date("2026-07-28T00:00:00.000Z"),
    });
    const signaturePromise = broker.requestTypedData(fixture.runtimeBinding, {
      domain: { name: "ClobAuthDomain", version: "1", chainId: 137 },
      types: { ClobAuth: [{ name: "address", type: "address" }] },
      primaryType: "ClobAuth",
      message: { address: fixture.runtimeBinding.session.walletAddress },
      purpose: "创建 CLOB 会话凭据",
    });
    const request = broker.next("session-1");
    expect(request).toMatchObject({
      sessionId: "session-1",
      walletAddress: fixture.runtimeBinding.session.walletAddress,
      chainId: 137,
      method: "eth_signTypedData_v4",
      purpose: "创建 CLOB 会话凭据",
    });
    expect(JSON.parse(String(request?.params[1]))).toMatchObject({
      primaryType: "ClobAuth",
      domain: { chainId: 137 },
      types: {
        EIP712Domain: [
          { name: "name", type: "string" },
          { name: "version", type: "string" },
          { name: "chainId", type: "uint256" },
        ],
      },
    });

    const signature = `0x${"a".repeat(130)}`;
    broker.complete({
      sessionId: "session-1",
      requestId: request!.requestId,
      result: signature,
    });
    await expect(signaturePromise).resolves.toBe(signature);
    expect(broker.next("session-1")).toBeNull();
    expect(() => broker.complete({
      sessionId: "session-1",
      requestId: request!.requestId,
      result: signature,
    })).toThrow("LIVE_WALLET_REQUEST_NOT_FOUND");
  });

  it("rejects a pending wallet operation when its session is invalidated", async () => {
    const fixture = binding();
    const broker = new LiveWalletRequestBroker();
    const transaction = broker.requestTransaction(fixture.runtimeBinding, {
      to: "0x0000000000000000000000000000000000000002",
      data: "0x1234",
      purpose: "授权交易",
    });

    await fixture.invalidate("DISCONNECTED");

    await expect(transaction).rejects.toThrow("LIVE_WALLET_SESSION_DISCONNECTED");
    expect(broker.next("session-1")).toBeNull();
  });

  it("does not accept results from another wallet session or malformed results", async () => {
    const fixture = binding();
    const broker = new LiveWalletRequestBroker();
    const signaturePromise = broker.requestTypedData(fixture.runtimeBinding, {
      domain: { name: "Order" },
      types: { Order: [{ name: "maker", type: "address" }] },
      primaryType: "Order",
      message: { maker: fixture.runtimeBinding.session.walletAddress },
      purpose: "签署订单",
    });
    const request = broker.next("session-1")!;
    expect(() => broker.complete({
      sessionId: "session-2",
      requestId: request.requestId,
      result: `0x${"a".repeat(130)}`,
    })).toThrow("LIVE_WALLET_REQUEST_NOT_FOUND");
    expect(() => broker.complete({
      sessionId: "session-1",
      requestId: request.requestId,
      result: "0xbad",
    })).toThrow("LIVE_WALLET_REQUEST_RESULT_INVALID");

    broker.complete({
      sessionId: "session-1",
      requestId: request.requestId,
      error: "User rejected the request",
    });
    await expect(signaturePromise).rejects.toThrow(
      "LIVE_WALLET_REQUEST_REJECTED:User rejected the request",
    );
  });
});
