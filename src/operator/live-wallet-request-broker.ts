import { randomUUID } from "node:crypto";
import type { LiveWalletRuntimeBinding } from "./live-wallet-session.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 2 * 60_000;
const SIGNATURE_RE = /^0x[0-9a-fA-F]{130}$/;
const TRANSACTION_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

export type LiveWalletRequestMethod = "eth_signTypedData_v4" | "eth_sendTransaction";

export interface LiveWalletRequest {
  requestId: string;
  sessionId: string;
  walletAddress: string;
  chainId: number;
  method: LiveWalletRequestMethod;
  params: readonly unknown[];
  purpose: string;
  createdAt: string;
  expiresAt: string;
}

export interface CompleteLiveWalletRequestInput {
  sessionId: string;
  requestId: string;
  result?: string;
  error?: string;
}

interface PendingLiveWalletRequest {
  request: LiveWalletRequest;
  binding: LiveWalletRuntimeBinding;
  resolve: (result: string) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  unsubscribe: () => void;
}

function required(value: string, code: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(code);
  return normalized;
}

function normalizedPurpose(value: string): string {
  const purpose = required(value, "LIVE_WALLET_REQUEST_PURPOSE_REQUIRED");
  if (purpose.length > 160) throw new Error("LIVE_WALLET_REQUEST_PURPOSE_TOO_LONG");
  return purpose;
}

/**
 * In-memory, session-bound request channel between the backend Live runtime
 * and the already-connected EIP-1193 wallet in the localhost UI.
 *
 * The broker never receives a private key or seed. It exposes only the exact
 * EIP-1193 request awaiting user approval, accepts one terminal result, and
 * rejects every pending request when the wallet session is invalidated.
 */
export class LiveWalletRequestBroker {
  private readonly pending = new Map<string, PendingLiveWalletRequest>();
  private readonly timeoutMs: number;
  private readonly now: () => Date;

  constructor(options: { timeoutMs?: number; now?: () => Date } = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.now = options.now ?? (() => new Date());
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new Error("LIVE_WALLET_REQUEST_TIMEOUT_INVALID");
    }
  }

  requestTypedData(
    binding: LiveWalletRuntimeBinding,
    input: {
      domain: Record<string, unknown>;
      types: Record<string, ReadonlyArray<{ name: string; type: string }>>;
      primaryType: string;
      message: Record<string, unknown>;
      purpose: string;
    },
  ): Promise<string> {
    binding.assertCurrent();
    const primaryType = required(input.primaryType, "LIVE_WALLET_TYPED_DATA_PRIMARY_TYPE_REQUIRED");
    if (!Object.hasOwn(input.types, primaryType)) {
      throw new Error("LIVE_WALLET_TYPED_DATA_PRIMARY_TYPE_UNKNOWN");
    }
    const domainTypes = [
      ...(typeof input.domain.name === "string" ? [{ name: "name", type: "string" }] : []),
      ...(typeof input.domain.version === "string" ? [{ name: "version", type: "string" }] : []),
      ...(typeof input.domain.chainId === "number" || typeof input.domain.chainId === "bigint"
        ? [{ name: "chainId", type: "uint256" }]
        : []),
      ...(typeof input.domain.verifyingContract === "string"
        ? [{ name: "verifyingContract", type: "address" }]
        : []),
      ...(typeof input.domain.salt === "string" ? [{ name: "salt", type: "bytes32" }] : []),
    ];
    const typedData = {
      domain: input.domain,
      types: {
        EIP712Domain: domainTypes,
        ...input.types,
      },
      primaryType,
      message: input.message,
    };
    return this.enqueue(binding, {
      method: "eth_signTypedData_v4",
      params: [binding.session.walletAddress, JSON.stringify(typedData)],
      purpose: normalizedPurpose(input.purpose),
    });
  }

  requestTransaction(
    binding: LiveWalletRuntimeBinding,
    input: {
      to: string;
      data: string;
      value?: string;
      purpose: string;
    },
  ): Promise<string> {
    binding.assertCurrent();
    const to = required(input.to, "LIVE_WALLET_TRANSACTION_TO_REQUIRED").toLowerCase();
    const data = required(input.data, "LIVE_WALLET_TRANSACTION_DATA_REQUIRED");
    if (!/^0x[0-9a-f]{40}$/.test(to)) throw new Error("LIVE_WALLET_TRANSACTION_TO_INVALID");
    if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(data)) throw new Error("LIVE_WALLET_TRANSACTION_DATA_INVALID");
    const value = input.value ?? "0x0";
    if (!/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value)) {
      throw new Error("LIVE_WALLET_TRANSACTION_VALUE_INVALID");
    }
    return this.enqueue(binding, {
      method: "eth_sendTransaction",
      params: [{
        from: binding.session.walletAddress,
        to,
        data,
        value,
        chainId: `0x${binding.session.chainId.toString(16)}`,
      }],
      purpose: normalizedPurpose(input.purpose),
    });
  }

  next(sessionId: string): LiveWalletRequest | null {
    const normalizedSessionId = required(sessionId, "LIVE_WALLET_SESSION_ID_REQUIRED");
    const nowMs = this.now().getTime();
    for (const pending of this.pending.values()) {
      if (pending.request.sessionId !== normalizedSessionId) continue;
      if (nowMs > Date.parse(pending.request.expiresAt)) {
        this.rejectPending(pending.request.requestId, "LIVE_WALLET_REQUEST_EXPIRED");
        continue;
      }
      pending.binding.assertCurrent();
      return structuredClone(pending.request);
    }
    return null;
  }

  complete(input: CompleteLiveWalletRequestInput): void {
    const sessionId = required(input.sessionId, "LIVE_WALLET_SESSION_ID_REQUIRED");
    const requestId = required(input.requestId, "LIVE_WALLET_REQUEST_ID_REQUIRED");
    const pending = this.pending.get(requestId);
    if (!pending || pending.request.sessionId !== sessionId) {
      throw new Error("LIVE_WALLET_REQUEST_NOT_FOUND");
    }
    pending.binding.assertCurrent();
    if (this.now().getTime() > Date.parse(pending.request.expiresAt)) {
      this.rejectPending(requestId, "LIVE_WALLET_REQUEST_EXPIRED");
      throw new Error("LIVE_WALLET_REQUEST_EXPIRED");
    }
    if (input.error !== undefined) {
      const detail = input.error.trim().slice(0, 300) || "WALLET_REJECTED";
      this.rejectPending(requestId, `LIVE_WALLET_REQUEST_REJECTED:${detail}`);
      return;
    }
    const result = required(input.result ?? "", "LIVE_WALLET_REQUEST_RESULT_REQUIRED");
    const valid = pending.request.method === "eth_signTypedData_v4"
      ? SIGNATURE_RE.test(result)
      : TRANSACTION_HASH_RE.test(result);
    if (!valid) throw new Error("LIVE_WALLET_REQUEST_RESULT_INVALID");
    this.finish(pending);
    pending.resolve(result);
  }

  cancelSession(sessionId: string, reason = "LIVE_WALLET_SESSION_INVALIDATED"): void {
    for (const pending of [...this.pending.values()]) {
      if (pending.request.sessionId === sessionId) {
        this.rejectPending(pending.request.requestId, reason);
      }
    }
  }

  private enqueue(
    binding: LiveWalletRuntimeBinding,
    input: {
      method: LiveWalletRequestMethod;
      params: readonly unknown[];
      purpose: string;
    },
  ): Promise<string> {
    binding.assertCurrent();
    const duplicate = [...this.pending.values()].find(
      (pending) => pending.request.sessionId === binding.session.sessionId,
    );
    if (duplicate) throw new Error("LIVE_WALLET_REQUEST_ALREADY_PENDING");
    const createdAt = this.now();
    const request: LiveWalletRequest = {
      requestId: randomUUID(),
      sessionId: binding.session.sessionId,
      walletAddress: binding.session.walletAddress,
      chainId: binding.session.chainId,
      method: input.method,
      params: structuredClone(input.params),
      purpose: input.purpose,
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + this.timeoutMs).toISOString(),
    };
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.rejectPending(request.requestId, "LIVE_WALLET_REQUEST_EXPIRED");
      }, this.timeoutMs);
      timer.unref?.();
      const unsubscribe = binding.onInvalidated((reason) => {
        this.rejectPending(request.requestId, `LIVE_WALLET_SESSION_${reason}`);
      });
      this.pending.set(request.requestId, {
        request,
        binding,
        resolve,
        reject,
        timer,
        unsubscribe,
      });
    });
  }

  private rejectPending(requestId: string, reason: string): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.finish(pending);
    pending.reject(new Error(reason));
  }

  private finish(pending: PendingLiveWalletRequest): void {
    this.pending.delete(pending.request.requestId);
    clearTimeout(pending.timer);
    pending.unsubscribe();
  }
}
