import { describe, expect, it, vi } from "vitest";
import {
  assembleConnectedLiveRuntime,
  type ConnectedLiveRuntimeDependencyBundle,
} from "../src/live/live-connected-runtime.js";
import type {
  LiveWalletRuntimeBinding,
  LiveWalletSession,
} from "../src/operator/live-wallet-session.js";

function session(overrides: Partial<LiveWalletSession> = {}): LiveWalletSession {
  return {
    sessionId: "session-1",
    status: "CONNECTED",
    walletAddress: "0x0000000000000000000000000000000000000001",
    chainId: 80002,
    network: "POLYGON_AMOY",
    walletType: "EIP1193",
    connectedAt: "2026-07-27T08:00:00.000Z",
    lastSeenAt: "2026-07-27T08:00:00.000Z",
    expiresAt: "2026-07-27T08:30:00.000Z",
    ...overrides,
  };
}

function binding(walletSession: LiveWalletSession): LiveWalletRuntimeBinding {
  return {
    session: walletSession,
    assertCurrent: vi.fn(),
    onInvalidated: vi.fn(() => () => undefined),
  };
}

describe("connected Live runtime assembly", () => {
  it("does not assemble production dependencies from a test network session", async () => {
    const create = vi.fn();
    await expect(assembleConnectedLiveRuntime({
      databasePath: "/tmp/ni-k-unused.sqlite",
      walletBinding: binding(session()),
      dependencyFactory: { create },
    })).rejects.toThrow("LIVE_PRODUCTION_NETWORK_REQUIRED");
    expect(create).not.toHaveBeenCalled();
  });

  it("asks the host for production dependencies only after a mainnet session is present", async () => {
    const create = vi.fn(async () => {
      throw new Error("HOST_FACTORY_STOP");
    });
    const mainnetSession = session({ status: "CONNECTED", network: "POLYGON", chainId: 137 });
    await expect(assembleConnectedLiveRuntime({
      databasePath: "/tmp/ni-k-unused.sqlite",
      walletBinding: binding(mainnetSession),
      dependencyFactory: { create },
    })).rejects.toThrow("HOST_FACTORY_STOP");
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      databasePath: "/tmp/ni-k-unused.sqlite",
      walletSession: mainnetSession,
    }));
  });

  it("requires the injected wallet provider to verify the production chain", async () => {
    const mainnetSession = session({ status: "CONNECTED", network: "POLYGON", chainId: 137 });
    const incompleteBundle = {
      walletProvider: {},
      verifiedChainId: 137,
    } as unknown as ConnectedLiveRuntimeDependencyBundle;
    await expect(assembleConnectedLiveRuntime({
      databasePath: "/tmp/ni-k-unused.sqlite",
      walletBinding: binding(mainnetSession),
      dependencyFactory: {
        create: vi.fn(async () => incompleteBundle),
      },
    })).rejects.toThrow("LIVE_PRODUCTION_CHAIN_VERIFIER_NOT_CONFIGURED");

    const mismatchedBundle = {
      walletProvider: { getChainId: vi.fn(async () => 80002) },
      verifiedChainId: 137,
    } as unknown as ConnectedLiveRuntimeDependencyBundle;
    await expect(assembleConnectedLiveRuntime({
      databasePath: "/tmp/ni-k-unused.sqlite",
      walletBinding: binding(mainnetSession),
      dependencyFactory: {
        create: vi.fn(async () => mismatchedBundle),
      },
    })).rejects.toThrow("LIVE_PRODUCTION_CHAIN_VERIFICATION_FAILED");
  });
});
