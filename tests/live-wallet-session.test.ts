import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it, vi } from "vitest";
import { LiveWalletSessionManager } from "../src/operator/live-wallet-session.js";

const account = privateKeyToAccount("0x0123456789012345678901234567890123456789012345678901234567890123");

describe("Live wallet session", () => {
  it("proves a Polygon wallet without persisting or exposing wallet secrets", async () => {
    const manager = new LiveWalletSessionManager();
    const now = () => new Date("2026-07-27T08:00:00.000Z");
    const challenge = manager.createChallenge(137, now);
    const signature = await account.signMessage({ message: challenge.message });
    const session = await manager.connect({
      challengeId: challenge.challengeId,
      walletAddress: account.address,
      chainId: 137,
      signature,
    }, now);

    expect(session).toMatchObject({
      status: "CONNECTED",
      walletAddress: account.address.toLowerCase(),
      chainId: 137,
      network: "POLYGON",
      walletType: "EIP1193",
    });
    expect(manager.snapshot(now)).toMatchObject({
      status: "CONNECTED",
      walletAddress: account.address.toLowerCase(),
      signerStatus: "PENDING_HOST_SIGNER",
    });
    expect(JSON.stringify(manager.snapshot(now))).not.toMatch(/private|seed|mnemonic|secret|apiKey/i);
  });

  it("rejects an invalid proof and prevents replay", async () => {
    const manager = new LiveWalletSessionManager();
    const challenge = manager.createChallenge(137);
    const signature = await account.signMessage({ message: challenge.message });
    await expect(manager.connect({
      challengeId: challenge.challengeId,
      walletAddress: "0x0000000000000000000000000000000000000001",
      chainId: 137,
      signature,
    })).rejects.toThrow("LIVE_WALLET_SIGNATURE_INVALID");
    await expect(manager.connect({
      challengeId: challenge.challengeId,
      walletAddress: account.address,
      chainId: 137,
      signature,
    })).rejects.toThrow("LIVE_WALLET_CHALLENGE_NOT_FOUND");
  });

  it("expires challenges and clears disconnected sessions", async () => {
    const manager = new LiveWalletSessionManager();
    const created = new Date("2026-07-27T08:00:00.000Z");
    const challenge = manager.createChallenge(137, () => created);
    const signature = await account.signMessage({ message: challenge.message });
    await expect(manager.connect({
      challengeId: challenge.challengeId,
      walletAddress: account.address,
      chainId: 137,
      signature,
    }, () => new Date(created.getTime() + 5 * 60 * 1000 + 1))).rejects.toThrow("LIVE_WALLET_CHALLENGE_EXPIRED");

    const second = manager.createChallenge(137, () => created);
    const secondSignature = await account.signMessage({ message: second.message });
    const session = await manager.connect({
      challengeId: second.challengeId,
      walletAddress: account.address,
      chainId: 137,
      signature: secondSignature,
    }, () => created);
    await manager.disconnect(session.sessionId);
    expect(manager.snapshot(() => created).status).toBe("DISCONNECTED");
  });

  it("binds the signed challenge to its network", async () => {
    const manager = new LiveWalletSessionManager();
    const challenge = manager.createChallenge(137);
    const signature = await account.signMessage({ message: challenge.message });
    await expect(manager.connect({
      challengeId: challenge.challengeId,
      walletAddress: account.address,
      chainId: 80002,
      signature,
    })).rejects.toThrow("LIVE_WALLET_CHALLENGE_CHAIN_MISMATCH");
  });

  it("invalidates runtime bindings when the wallet disconnects or is replaced", async () => {
    const manager = new LiveWalletSessionManager();
    const challenge = manager.createChallenge(137);
    const signature = await account.signMessage({ message: challenge.message });
    const connected = await manager.connect({
      challengeId: challenge.challengeId,
      walletAddress: account.address,
      chainId: 137,
      signature,
    });
    const binding = manager.createRuntimeBinding(connected.sessionId);
    const invalidations: string[] = [];
    binding.onInvalidated((reason) => {
      invalidations.push(reason);
    });
    binding.assertCurrent();

    const replacementChallenge = manager.createChallenge(137);
    const replacementSignature = await account.signMessage({ message: replacementChallenge.message });
    await manager.connect({
      challengeId: replacementChallenge.challengeId,
      walletAddress: account.address,
      chainId: 137,
      signature: replacementSignature,
    });

    expect(invalidations).toEqual(["REPLACED"]);
    expect(() => binding.assertCurrent()).toThrow("LIVE_WALLET_SESSION_INVALIDATED");
  });

  it("expires the connected runtime lease without waiting for a later API call", async () => {
    vi.useFakeTimers({ now: new Date("2026-07-27T08:00:00.000Z") });
    try {
      const manager = new LiveWalletSessionManager();
      const now = () => new Date("2026-07-27T08:00:00.000Z");
      const challenge = manager.createChallenge(137, now);
      const signature = await account.signMessage({ message: challenge.message });
      const session = await manager.connect({
        challengeId: challenge.challengeId,
        walletAddress: account.address,
        chainId: 137,
        signature,
      }, now);
      const binding = manager.createRuntimeBinding(session.sessionId, now);
      const invalidations: string[] = [];
      binding.onInvalidated((reason) => {
        invalidations.push(reason);
      });

      await vi.advanceTimersByTimeAsync(30 * 60 * 1000 + 1);

      expect(invalidations).toEqual(["EXPIRED"]);
      expect(manager.snapshot(now).status).toBe("DISCONNECTED");
      expect(() => binding.assertCurrent()).toThrow("LIVE_WALLET_SESSION_INVALIDATED");
    } finally {
      vi.useRealTimers();
    }
  });
});
