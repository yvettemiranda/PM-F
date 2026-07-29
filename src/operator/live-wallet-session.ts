import { randomUUID } from "node:crypto";
import { isAddress, verifyMessage } from "viem";

export type LiveWalletNetwork = "POLYGON" | "POLYGON_AMOY";
export type LiveWalletSessionStatus = "DISCONNECTED" | "CONNECTED";

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const SESSION_TTL_MS = 30 * 60 * 1000;
const MAX_PENDING_CHALLENGES = 8;

export interface WalletChallenge {
  challengeId: string;
  message: string;
  chainId: number;
  network: LiveWalletNetwork;
  createdAt: string;
  expiresAt: string;
}

export interface LiveWalletSession {
  sessionId: string;
  status: "CONNECTED";
  walletAddress: string;
  chainId: number;
  network: LiveWalletNetwork;
  walletType: "EIP1193";
  connectedAt: string;
  lastSeenAt: string;
  expiresAt: string;
}

export interface LiveWalletSessionSnapshot {
  status: LiveWalletSessionStatus;
  sessionId: string | null;
  walletAddress: string | null;
  chainId: number | null;
  network: LiveWalletNetwork | null;
  walletType: "EIP1193" | null;
  connectedAt: string | null;
  lastSeenAt: string | null;
  expiresAt: string | null;
  signerStatus: "NOT_CONNECTED" | "PENDING_HOST_SIGNER" | "READY";
}

export type LiveWalletSessionConnectInput = {
  challengeId: string;
  walletAddress: string;
  chainId: number;
  signature: string;
};

export type LiveWalletSessionInvalidationReason = "DISCONNECTED" | "EXPIRED" | "REPLACED";

export interface LiveWalletRuntimeBinding {
  readonly session: LiveWalletSession;
  assertCurrent(): void;
  onInvalidated(
    listener: (reason: LiveWalletSessionInvalidationReason) => void | Promise<void>,
  ): () => void;
}

export function networkForChainId(chainId: number): LiveWalletNetwork | null {
  if (chainId === 137) return "POLYGON";
  if (chainId === 80002) return "POLYGON_AMOY";
  return null;
}

function assertString(value: unknown, code: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(code);
  return value.trim();
}

function assertChainId(value: unknown): number {
  const chainId = typeof value === "number"
    ? value
    : typeof value === "string" && /^0x[0-9a-f]+$/i.test(value)
      ? Number.parseInt(value, 16)
      : Number.NaN;
  if (!Number.isSafeInteger(chainId) || networkForChainId(chainId) === null) {
    throw new Error("LIVE_WALLET_CHAIN_NOT_SUPPORTED");
  }
  return chainId;
}

/**
 * Keeps the browser-wallet identity session in memory only. It deliberately
 * stores no private key, API key, seed, or reusable wallet signature.
 *
 * The returned session proves control of a public address for this localhost
 * process. The production host binds its browser signer/CLOB/provider bundle
 * to this exact session; the proof alone never authorizes a trade.
 */
export class LiveWalletSessionManager {
  private currentSession: LiveWalletSession | null = null;
  private readonly challenges = new Map<string, WalletChallenge>();
  private readonly invalidationListeners = new Map<
    string,
    Set<(reason: LiveWalletSessionInvalidationReason) => void | Promise<void>>
  >();
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;

  createChallenge(chainIdInput: number, now: () => Date = () => new Date()): WalletChallenge {
    const createdAt = now();
    const chainId = assertChainId(chainIdInput);
    const network = networkForChainId(chainId);
    if (network === null) throw new Error("LIVE_WALLET_CHAIN_NOT_SUPPORTED");
    for (const [id, challenge] of this.challenges) {
      if (createdAt.getTime() > Date.parse(challenge.expiresAt)) this.challenges.delete(id);
    }
    while (this.challenges.size >= MAX_PENDING_CHALLENGES) {
      const oldestId = this.challenges.keys().next().value as string | undefined;
      if (oldestId === undefined) break;
      this.challenges.delete(oldestId);
    }
    const challengeId = randomUUID();
    const expiresAt = new Date(createdAt.getTime() + CHALLENGE_TTL_MS);
    const message = [
      "Hecatonchires wallet connection",
      `Challenge: ${challengeId}`,
      `Network: ${network} (${chainId})`,
      `Issued at: ${createdAt.toISOString()}`,
      "This signature only proves control of the public wallet address.",
      "It does not authorize trades or move funds.",
    ].join("\n");
    const challenge: WalletChallenge = {
      challengeId,
      message,
      chainId,
      network,
      createdAt: createdAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };
    this.challenges.set(challengeId, challenge);
    return challenge;
  }

  async connect(
    input: LiveWalletSessionConnectInput,
    now: () => Date = () => new Date(),
  ): Promise<LiveWalletSession> {
    const challengeId = assertString(input.challengeId, "LIVE_WALLET_CHALLENGE_REQUIRED");
    const walletAddress = assertString(input.walletAddress, "LIVE_WALLET_ADDRESS_REQUIRED");
    const signature = assertString(input.signature, "LIVE_WALLET_SIGNATURE_REQUIRED");
    if (!isAddress(walletAddress)) throw new Error("LIVE_WALLET_ADDRESS_INVALID");
    const challenge = this.challenges.get(challengeId);
    if (!challenge) throw new Error("LIVE_WALLET_CHALLENGE_NOT_FOUND");
    const nowDate = now();
    if (nowDate.getTime() > Date.parse(challenge.expiresAt)) {
      this.challenges.delete(challengeId);
      throw new Error("LIVE_WALLET_CHALLENGE_EXPIRED");
    }
    const chainId = assertChainId(input.chainId);
    const network = networkForChainId(chainId);
    if (network === null) throw new Error("LIVE_WALLET_CHAIN_NOT_SUPPORTED");
    if (challenge.chainId !== chainId) {
      this.challenges.delete(challengeId);
      throw new Error("LIVE_WALLET_CHALLENGE_CHAIN_MISMATCH");
    }
    let verified = false;
    try {
      verified = await verifyMessage({
        address: walletAddress as `0x${string}`,
        message: challenge.message,
        signature: signature as `0x${string}`,
      });
    } catch {
      verified = false;
    }
    this.challenges.delete(challengeId);
    if (!verified) throw new Error("LIVE_WALLET_SIGNATURE_INVALID");
    const connectedAt = nowDate.toISOString();
    const session: LiveWalletSession = {
      sessionId: randomUUID(),
      status: "CONNECTED",
      walletAddress: walletAddress.toLowerCase(),
      chainId,
      network,
      walletType: "EIP1193",
      connectedAt,
      lastSeenAt: connectedAt,
      expiresAt: new Date(nowDate.getTime() + SESSION_TTL_MS).toISOString(),
    };
    if (this.currentSession !== null) await this.invalidateCurrent("REPLACED");
    this.currentSession = session;
    this.scheduleExpiry(session);
    return { ...session };
  }

  snapshot(now: () => Date = () => new Date()): LiveWalletSessionSnapshot {
    const session = this.currentSession;
    if (!session) {
      return {
        status: "DISCONNECTED",
        sessionId: null,
        walletAddress: null,
        chainId: null,
        network: null,
        walletType: null,
        connectedAt: null,
        lastSeenAt: null,
        expiresAt: null,
        signerStatus: "NOT_CONNECTED",
      };
    }
    const observedAt = now();
    if (observedAt.getTime() > Date.parse(session.expiresAt)) {
      void this.invalidateCurrent("EXPIRED").catch(() => undefined);
      return {
        status: "DISCONNECTED",
        sessionId: null,
        walletAddress: null,
        chainId: null,
        network: null,
        walletType: null,
        connectedAt: null,
        lastSeenAt: null,
        expiresAt: null,
        signerStatus: "NOT_CONNECTED",
      };
    }
    session.lastSeenAt = observedAt.toISOString();
    session.expiresAt = new Date(observedAt.getTime() + SESSION_TTL_MS).toISOString();
    this.scheduleExpiry(session);
    return {
      status: session.status,
      sessionId: session.sessionId,
      walletAddress: session.walletAddress,
      chainId: session.chainId,
      network: session.network,
      walletType: session.walletType,
      connectedAt: session.connectedAt,
      lastSeenAt: session.lastSeenAt,
      expiresAt: session.expiresAt,
      signerStatus: "PENDING_HOST_SIGNER",
    };
  }

  private scheduleExpiry(session: LiveWalletSession): void {
    if (this.expiryTimer !== null) clearTimeout(this.expiryTimer);
    this.expiryTimer = setTimeout(() => {
      if (this.currentSession?.sessionId !== session.sessionId) return;
      void this.invalidateCurrent("EXPIRED").catch(() => undefined);
    }, SESSION_TTL_MS);
    this.expiryTimer.unref?.();
  }

  async disconnect(sessionId?: string): Promise<void> {
    if (sessionId !== undefined && this.currentSession?.sessionId !== sessionId) {
      throw new Error("LIVE_WALLET_SESSION_NOT_FOUND");
    }
    await this.invalidateCurrent("DISCONNECTED");
  }

  createRuntimeBinding(
    sessionId: string,
    now: () => Date = () => new Date(),
  ): LiveWalletRuntimeBinding {
    const session = this.currentSession;
    if (session === null || session.sessionId !== sessionId) {
      throw new Error("LIVE_WALLET_SESSION_NOT_FOUND");
    }
    const bindingSession = { ...session };
    return {
      session: bindingSession,
      assertCurrent: (): void => {
        const active = this.currentSession;
        if (
          active === null
          || active.sessionId !== bindingSession.sessionId
          || active.walletAddress !== bindingSession.walletAddress
          || active.chainId !== bindingSession.chainId
        ) {
          throw new Error("LIVE_WALLET_SESSION_INVALIDATED");
        }
        if (now().getTime() > Date.parse(active.expiresAt)) {
          void this.invalidateCurrent("EXPIRED").catch(() => undefined);
          throw new Error("LIVE_WALLET_SESSION_EXPIRED");
        }
      },
      onInvalidated: (listener): (() => void) => {
        const listeners = this.invalidationListeners.get(bindingSession.sessionId) ?? new Set();
        listeners.add(listener);
        this.invalidationListeners.set(bindingSession.sessionId, listeners);
        return () => {
          const current = this.invalidationListeners.get(bindingSession.sessionId);
          current?.delete(listener);
          if (current?.size === 0) this.invalidationListeners.delete(bindingSession.sessionId);
        };
      },
    };
  }

  private async invalidateCurrent(reason: LiveWalletSessionInvalidationReason): Promise<void> {
    const session = this.currentSession;
    if (session === null) return;
    this.currentSession = null;
    if (this.expiryTimer !== null) {
      clearTimeout(this.expiryTimer);
      this.expiryTimer = null;
    }
    const listeners = this.invalidationListeners.get(session.sessionId);
    this.invalidationListeners.delete(session.sessionId);
    const results = await Promise.allSettled(
      [...(listeners ?? [])].map((listener) => Promise.resolve().then(() => listener(reason))),
    );
    const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure !== undefined) {
      const detail = failure.reason instanceof Error ? failure.reason.message : String(failure.reason);
      throw new Error(`LIVE_WALLET_SESSION_INVALIDATION_FAILED:${detail}`);
    }
  }
}
