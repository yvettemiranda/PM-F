import { randomUUID } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { operatorDashboardSnapshot, type OperatorDashboardSnapshot } from "./operator-dashboard.js";
import {
  DefaultOperatorLiveGateActions,
  DefaultOperatorRuntimeActions,
  UnconfiguredOperatorLiveRuntimeActions,
  type OperatorLiveGateActions,
  type OperatorLiveGateResult,
  type OperatorLiveRuntimeActions,
  type OperatorLiveRuntimeResult,
  type OperatorRuntimeActions,
} from "./operator-actions.js";
import {
  OPERATOR_DATABASE_FILE,
  operatorRuntimeSafety,
} from "./operator-mutation-guard.js";
import {
  resetSelectedRulesetProfile,
  saveSelectedRulesetProfile,
  type RulesetValues,
} from "./ruleset-profile.js";
import { OPERATOR_RULESET_PROFILE_CONTEXT } from "../domain/versioning.js";
import { saveSelectedTargetWallet } from "./target-wallet.js";
import {
  liveProductionReadiness,
  readLiveProductionConfig,
  saveLiveProductionConfig,
  type LiveProductionSignatureType,
} from "./live-production-readiness.js";
import {
  discoverPolymarketTradingWallet,
  type PolymarketTradingWallet,
} from "./polymarket-trading-wallet-discovery.js";
import {
  LiveWalletSessionManager,
  type LiveWalletRuntimeBinding,
  type LiveWalletSession,
} from "./live-wallet-session.js";
import { LiveWalletRequestBroker } from "./live-wallet-request-broker.js";
import { resolveSourceVersion, type SourceVersion } from "../infra/source-version.js";
import { effectiveLivePrerequisites } from "./operator-status.js";
import { validatedLiveProductionSourceVersion } from "./production-live-prerequisites.js";

const MAX_BODY_BYTES = 64 * 1024;
const HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

export interface OperatorUiServerOptions {
  projectRoot: string;
  staticRoot?: string;
  runtimeActions?: OperatorRuntimeActions;
  liveGateActions?: OperatorLiveGateActions;
  liveRuntimeActions?: OperatorLiveRuntimeActions;
  walletSessionManager?: LiveWalletSessionManager;
  walletRequestBroker?: LiveWalletRequestBroker;
  tradingWalletDiscovery?: (walletAddress: string) => Promise<PolymarketTradingWallet>;
  connectedLiveRuntimeFactory?: (input: {
    projectRoot: string;
    walletSession: LiveWalletSession;
    walletSessionBinding: LiveWalletRuntimeBinding;
  }) => Promise<
    OperatorLiveRuntimeActions
    | {
      runtimeActions: OperatorLiveRuntimeActions;
      gateActions: OperatorLiveGateActions;
      dispose?: () => void;
    }
  >;
  requestShutdown?: () => void | Promise<void>;
  now?: () => Date;
}

export interface OperatorUiServer extends Server {
  shutdownSafety(): Promise<void>;
}

export type { OperatorLiveGateActions, OperatorLiveRuntimeActions, OperatorRuntimeActions };

class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

interface RequestContext {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  options: OperatorUiServerOptions;
  runtimeActions: OperatorRuntimeActions;
  liveGateActions: OperatorLiveGateActions;
  liveRuntimeActions: MutableOperatorLiveRuntimeActions;
  walletSessionManager: LiveWalletSessionManager;
  walletRequestBroker: LiveWalletRequestBroker;
  service: {
    instanceId: string;
    startedAt: string;
    sourceVersion: SourceVersion;
  };
  prerequisiteSourceVersion: SourceVersion;
}

class MutableOperatorLiveRuntimeActions implements OperatorLiveRuntimeActions {
  constructor(private current: OperatorLiveRuntimeActions) {}

  private walletSessionBinding: LiveWalletRuntimeBinding | null = null;
  private walletSessionInvalidationReason: string | null = null;
  private unsubscribeWalletSession: (() => void) | null = null;
  private disposeCurrent: (() => void) | null = null;

  get capability() {
    this.assertWalletSession();
    const capability = this.current.capability;
    if (this.walletSessionInvalidationReason === null) return capability;
    return {
      execution: "PENDING_PREREQUISITES" as const,
      orderManagement: "PENDING_PREREQUISITES" as const,
      ...(capability.production === undefined
        ? {}
        : {
          production: {
            ...capability.production,
            FORMAL_WALLET: false,
            SECURE_SIGNER: false,
          },
        }),
    };
  }

  get status() {
    if (this.walletSessionInvalidationReason !== null) {
      return {
        state: "ERROR" as const,
        lastError: `LIVE_WALLET_SESSION_${this.walletSessionInvalidationReason}`,
      };
    }
    return this.current.status ?? {
      state: this.current.capability.execution === "AVAILABLE" ? "STOPPED" as const : "NOT_CONFIGURED" as const,
      lastError: null,
    };
  }

  install(
    actions: OperatorLiveRuntimeActions,
    walletSessionBinding?: LiveWalletRuntimeBinding,
    dispose?: () => void,
  ): void {
    this.unsubscribeWalletSession?.();
    this.unsubscribeWalletSession = null;
    this.disposeCurrent?.();
    this.disposeCurrent = dispose ?? null;
    this.current = actions;
    this.walletSessionBinding = walletSessionBinding ?? null;
    this.walletSessionInvalidationReason = null;
    if (walletSessionBinding !== undefined) {
      this.unsubscribeWalletSession = walletSessionBinding.onInvalidated((reason) => {
        this.walletSessionInvalidationReason = reason;
        return this.current.stop({
          actor: "WALLET_SESSION_GUARD",
          reason: `LIVE_WALLET_SESSION_${reason}`,
        }).then((result) => {
          if (!result.accepted) throw new Error(result.code);
        }).finally(() => {
          this.dispose();
        });
      });
      walletSessionBinding.assertCurrent();
    }
  }

  dispose(): void {
    const dispose = this.disposeCurrent;
    this.disposeCurrent = null;
    dispose?.();
  }

  start(input: Parameters<OperatorLiveRuntimeActions["start"]>[0]) {
    const failure = this.walletSessionFailure();
    if (failure !== null) return Promise.resolve(failure);
    return this.current.start(input);
  }

  stop(input: Parameters<OperatorLiveRuntimeActions["stop"]>[0]) {
    return this.current.stop(input);
  }

  cancelOrder(input: Parameters<OperatorLiveRuntimeActions["cancelOrder"]>[0]) {
    const failure = this.walletSessionFailure();
    if (failure !== null) return Promise.resolve(failure);
    return this.current.cancelOrder(input);
  }

  reconcile(input: Parameters<OperatorLiveRuntimeActions["reconcile"]>[0]) {
    const failure = this.walletSessionFailure();
    if (failure !== null) return Promise.resolve(failure);
    return this.current.reconcile(input);
  }

  recover(input: Parameters<OperatorLiveRuntimeActions["recover"]>[0]) {
    const failure = this.walletSessionFailure();
    if (failure !== null) return Promise.resolve(failure);
    return this.current.recover(input);
  }

  retryExecution(input: Parameters<OperatorLiveRuntimeActions["retryExecution"]>[0]) {
    const failure = this.walletSessionFailure();
    if (failure !== null) return Promise.resolve(failure);
    return this.current.retryExecution(input);
  }

  prepareWallet(input: { actor: string; reason: string }) {
    const failure = this.walletSessionFailure();
    if (failure !== null) return Promise.resolve(failure);
    if (this.current.prepareWallet === undefined) {
      return Promise.resolve({
        accepted: false,
        code: "LIVE_WALLET_SETUP_NOT_CONFIGURED",
      });
    }
    return this.current.prepareWallet(input);
  }

  private assertWalletSession(): void {
    if (this.walletSessionBinding === null || this.walletSessionInvalidationReason !== null) return;
    try {
      this.walletSessionBinding.assertCurrent();
    } catch {
      this.walletSessionInvalidationReason = "INVALIDATED";
    }
  }

  private walletSessionFailure(): OperatorLiveRuntimeResult | null {
    this.assertWalletSession();
    if (this.walletSessionInvalidationReason === null) return null;
    return {
      accepted: false,
      code: "LIVE_WALLET_SESSION_INVALIDATED",
      details: { reason: this.walletSessionInvalidationReason },
    };
  }
}

class MutableOperatorLiveGateActions implements OperatorLiveGateActions {
  private current: OperatorLiveGateActions;
  private unsubscribeWalletSession: (() => void) | null = null;

  constructor(private readonly fallback: OperatorLiveGateActions) {
    this.current = fallback;
  }

  install(actions: OperatorLiveGateActions, walletSessionBinding: LiveWalletRuntimeBinding): void {
    this.unsubscribeWalletSession?.();
    this.current = actions;
    this.unsubscribeWalletSession = walletSessionBinding.onInvalidated(() => {
      this.current = this.fallback;
      this.unsubscribeWalletSession?.();
      this.unsubscribeWalletSession = null;
    });
    walletSessionBinding.assertCurrent();
  }

  preflight() {
    return this.current.preflight();
  }

  requestActivation(input: Parameters<OperatorLiveGateActions["requestActivation"]>[0]) {
    return this.current.requestActivation(input);
  }

  confirmActivation(input: Parameters<OperatorLiveGateActions["confirmActivation"]>[0]) {
    return this.current.confirmActivation(input);
  }

  emergencyDisable(input: Parameters<OperatorLiveGateActions["emergencyDisable"]>[0]) {
    return this.current.emergencyDisable(input);
  }

  recover() {
    return this.current.recover();
  }
}

function isMutation(method: string): boolean {
  return method !== "GET" && method !== "HEAD";
}

function setHeaders(response: ServerResponse): void {
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("content-security-policy", "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'");
}

function isAllowedHost(host: string | undefined): boolean {
  if (host === undefined) return false;
  const hostname = host.startsWith("[")
    ? host.slice(1, host.indexOf("]"))
    : host.split(":")[0];
  return typeof hostname === "string" && HOSTNAMES.has(hostname);
}

function assertRequestOrigin(request: IncomingMessage): void {
  if (!isAllowedHost(request.headers.host)) {
    throw new HttpError(403, "HOST_NOT_ALLOWED", "仅允许本机 localhost 访问。");
  }
  const origin = request.headers.origin;
  const expected = `http://${request.headers.host}`;
  if (origin !== expected) {
    throw new HttpError(403, "ORIGIN_NOT_ALLOWED", "操作请求必须来自当前 localhost 页面。");
  }
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  let tooLarge = false;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size <= MAX_BODY_BYTES) chunks.push(buffer);
    else tooLarge = true;
  }
  if (tooLarge) {
    throw new HttpError(413, "REQUEST_BODY_TOO_LARGE", "请求内容超过 64 KiB 限制。");
  }
  if (chunks.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new HttpError(400, "INVALID_JSON", "请求 JSON 无法解析。");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(400, "JSON_OBJECT_REQUIRED", "请求体必须是 JSON 对象。");
  }
  return parsed as Record<string, unknown>;
}

function stringField(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HttpError(400, "FIELD_REQUIRED", `字段 ${key} 必须是非空字符串。`);
  }
  return value.trim();
}

const STALE_LIVE_RUNTIME_CODES = new Set([
  "LIVE_PRODUCTION_SOURCE_DIRTY",
  "LIVE_PRODUCTION_RUNTIME_SOURCE_DIRTY",
  "LIVE_PRODUCTION_RUNTIME_HASH_MISMATCH",
  "LIVE_PRODUCTION_VALIDATION_ARTIFACT_MISSING",
  "LIVE_PRODUCTION_VALIDATION_ARTIFACT_INVALID",
  "LIVE_PRODUCTION_FINAL_PAPER_EVIDENCE_INVALID",
  "LIVE_PRODUCTION_ISOLATED_EVIDENCE_INVALID",
]);

function errorCode(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function failForStaleLiveRuntime(input: {
  options: OperatorUiServerOptions;
  walletSessionManager: LiveWalletSessionManager;
  walletRequestBroker: LiveWalletRequestBroker;
  staleCode: string;
}): Promise<never> {
  const session = input.walletSessionManager.snapshot(input.options.now);
  let invalidationError: string | null = null;
  if (session.status === "CONNECTED" && session.sessionId !== null) {
    try {
      await input.walletSessionManager.disconnect(session.sessionId);
    } catch (error) {
      invalidationError = errorCode(error);
    } finally {
      input.walletRequestBroker.cancelSession(
        session.sessionId,
        "LIVE_RUNTIME_SOURCE_STALE_RECONNECT_REQUIRED",
      );
    }
  }
  throw new HttpError(
    409,
    "LIVE_RUNTIME_STALE_RECONNECT_REQUIRED",
    "当前钱包会话绑定了旧版本验证工件，已保持 PAPER 并安全断开；请重新连接钱包。",
    {
      staleCode: input.staleCode,
      reconnectRequired: true,
      safety: "PAPER + LIVE_DISABLED",
      ...(invalidationError === null ? {} : { invalidationError }),
    },
  );
}

async function withLiveRuntimeFreshnessGuard<T>(input: {
  options: OperatorUiServerOptions;
  walletSessionManager: LiveWalletSessionManager;
  walletRequestBroker: LiveWalletRequestBroker;
  action: () => Promise<T>;
}): Promise<T> {
  try {
    return await input.action();
  } catch (error) {
    const code = errorCode(error);
    if (!STALE_LIVE_RUNTIME_CODES.has(code)) throw error;
    return failForStaleLiveRuntime({
      options: input.options,
      walletSessionManager: input.walletSessionManager,
      walletRequestBroker: input.walletRequestBroker,
      staleCode: code,
    });
  }
}

function optionalString(body: Record<string, unknown>, key: string, fallback: string): string {
  const value = body[key];
  if (value === undefined) return fallback;
  return stringField(body, key);
}

function recordField(body: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = body[key];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpError(400, "FIELD_OBJECT_REQUIRED", `字段 ${key} 必须是对象。`);
  }
  return value as Record<string, unknown>;
}

function assertPersistedLiveGateActive(projectRoot: string): void {
  const safety = operatorRuntimeSafety(projectRoot);
  if (safety.executionMode === "LIVE" && safety.liveGateState === "LIVE_ACTIVE") return;
  throw new HttpError(
    409,
    "LIVE_GATE_NOT_ACTIVE",
    "Live Gate 尚未处于 LIVE_ACTIVE；请使用一键切换 Live 完成对账、钱包准备和最终确认。",
    {
      executionMode: safety.executionMode,
      liveGateState: safety.liveGateState,
    },
  );
}

function responseJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(body);
}

function success(response: ServerResponse, data: unknown, statusCode = 200): void {
  responseJson(response, statusCode, { ok: true, data });
}

function failure(response: ServerResponse, error: unknown): void {
  const normalized = error instanceof HttpError
    ? error
    : new HttpError(500, "OPERATOR_UI_INTERNAL_ERROR", error instanceof Error ? error.message : String(error));
  responseJson(response, normalized.statusCode, {
    ok: false,
    error: {
      code: normalized.code,
      message: normalized.message,
      details: normalized.details ?? null,
    },
  });
}

function freshSnapshot(
  options: OperatorUiServerOptions,
  liveRuntimeActions: OperatorLiveRuntimeActions,
  walletSessionManager: LiveWalletSessionManager,
  service: RequestContext["service"],
  prerequisiteSourceVersion: SourceVersion,
): OperatorDashboardSnapshot {
  const snapshot = options.now === undefined
    ? operatorDashboardSnapshot(options.projectRoot)
    : operatorDashboardSnapshot(options.projectRoot, { now: options.now });
  snapshot.service = service;
  snapshot.live.prerequisites = effectiveLivePrerequisites(
    snapshot.live.prerequisites,
    prerequisiteSourceVersion,
  );
  snapshot.live.capability.execution = liveRuntimeActions.capability.execution;
  snapshot.live.capability.orderManagement = liveRuntimeActions.capability.orderManagement;
  snapshot.live.capability.walletSetup = liveRuntimeActions.capability.walletSetup
    ?? "PENDING_PREREQUISITES";
  snapshot.live.walletSession = walletSessionManager.snapshot(options.now);
  snapshot.live.runtime = liveRuntimeActions.status ?? {
    state: liveRuntimeActions.capability.execution === "AVAILABLE" ? "STOPPED" : "NOT_CONFIGURED",
    lastError: null,
  };
  if (
    snapshot.live.walletSession.status === "CONNECTED"
    && liveRuntimeActions.capability.production?.SECURE_SIGNER === true
  ) {
    snapshot.live.walletSession.signerStatus = "READY";
  }
  snapshot.live.production = liveProductionReadiness(options.projectRoot, {
    databaseAvailable: snapshot.database.status === "AVAILABLE",
    gatePrerequisites: snapshot.live.prerequisites,
    executionCapability: liveRuntimeActions.capability.execution,
    ...(snapshot.live.walletSession.status === "CONNECTED"
      && snapshot.live.walletSession.walletAddress !== null
      && snapshot.live.walletSession.network !== null
      ? {
        walletSession: {
          walletAddress: snapshot.live.walletSession.walletAddress,
          network: snapshot.live.walletSession.network,
        },
      }
      : {}),
    ...(liveRuntimeActions.capability.production === undefined
      ? {}
      : { injectedChecks: liveRuntimeActions.capability.production }),
  }, options.now);
  return snapshot;
}

function canKeepWalletSessionWhenRuntimeAssemblyIsBlocked(code: string): boolean {
  // A verified wallet identity is still useful for showing readiness while a
  // clean, audited source tree is prepared. This must not apply to identity,
  // network, or chain-verification failures.
  return STALE_LIVE_RUNTIME_CODES.has(code)
    || code.startsWith("LIVE_PRODUCTION_SAFE_OWNER_LOOKUP_FAILED:")
    || code === "LIVE_PRODUCTION_TRADING_WALLET_OWNER_MISMATCH";
}

async function handleApi(context: RequestContext): Promise<void> {
  const {
    request,
    response,
    url,
    options,
    runtimeActions,
    liveGateActions,
    liveRuntimeActions,
    walletSessionManager,
    walletRequestBroker,
    service,
    prerequisiteSourceVersion,
  } = context;
  const dashboardSnapshot = (): OperatorDashboardSnapshot => freshSnapshot(
    options,
    liveRuntimeActions,
    walletSessionManager,
    service,
    prerequisiteSourceVersion,
  );
  if (isMutation(request.method ?? "GET")) assertRequestOrigin(request);
  const path = url.pathname;

  if (request.method === "GET" && path === "/api/operator/snapshot") {
    success(response, dashboardSnapshot());
    return;
  }

  if (request.method === "POST" && path === "/api/operator/service/shutdown") {
    await readJson(request);
    if (options.requestShutdown === undefined) {
      throw new HttpError(409, "OPERATOR_UI_SAFE_SHUTDOWN_NOT_CONFIGURED", "当前宿主未提供安全退出能力。");
    }
    success(response, {
      accepted: true,
      code: "OPERATOR_UI_SAFE_SHUTDOWN_REQUESTED",
    }, 202);
    response.once("finish", () => {
      setImmediate(() => {
        void Promise.resolve(options.requestShutdown?.()).catch((error) => {
          console.error(error instanceof Error ? error.message : String(error));
        });
      });
    });
    return;
  }

  if (request.method === "GET" && path === "/api/operator/live/wallet-session") {
    success(response, walletSessionManager.snapshot(options.now));
    return;
  }

  if (request.method === "GET" && path === "/api/operator/live/wallet-requests/next") {
    const sessionId = url.searchParams.get("sessionId");
    if (!sessionId) {
      throw new HttpError(400, "LIVE_WALLET_SESSION_ID_REQUIRED", "缺少钱包会话标识。");
    }
    try {
      success(response, { request: walletRequestBroker.next(sessionId) });
    } catch (error) {
      const code = error instanceof Error ? error.message : String(error);
      throw new HttpError(409, code, "钱包签名请求所属会话已失效。");
    }
    return;
  }

  if (request.method === "POST" && path === "/api/operator/live/wallet-requests/complete") {
    const body = await readJson(request);
    try {
      walletRequestBroker.complete({
        sessionId: stringField(body, "sessionId"),
        requestId: stringField(body, "requestId"),
        ...(body.result === undefined ? {} : { result: stringField(body, "result") }),
        ...(body.error === undefined ? {} : { error: stringField(body, "error") }),
      });
    } catch (error) {
      const code = error instanceof Error ? error.message : String(error);
      const statusCode = code === "LIVE_WALLET_REQUEST_NOT_FOUND" ? 404 : 409;
      throw new HttpError(statusCode, code, "钱包签名请求结果未被接受。");
    }
    success(response, { accepted: true });
    return;
  }

  if (request.method === "POST" && path === "/api/operator/live/wallet-session/challenge") {
    const body = await readJson(request);
    const chainIdValue = body.chainId;
    const chainId = typeof chainIdValue === "number"
      ? chainIdValue
      : typeof chainIdValue === "string" && /^0x[0-9a-f]+$/i.test(chainIdValue)
        ? Number.parseInt(chainIdValue, 16)
        : Number.NaN;
    try {
      success(response, walletSessionManager.createChallenge(chainId, options.now));
    } catch (error) {
      const code = error instanceof Error ? error.message : String(error);
      throw new HttpError(400, code, "当前钱包网络不受支持。");
    }
    return;
  }

  if (request.method === "POST" && path === "/api/operator/live/wallet-session/connect") {
    const body = await readJson(request);
    const challengeId = stringField(body, "challengeId");
    const walletAddress = stringField(body, "walletAddress");
    const signature = stringField(body, "signature");
    const chainIdValue = body.chainId;
    const chainId = typeof chainIdValue === "number"
      ? chainIdValue
      : typeof chainIdValue === "string" && /^0x[0-9a-f]+$/i.test(chainIdValue)
        ? Number.parseInt(chainIdValue, 16)
        : Number.NaN;
    let session: LiveWalletSession;
    try {
      session = await walletSessionManager.connect({
        challengeId,
        walletAddress,
        chainId,
        signature,
      }, options.now);
    } catch (error) {
      const code = error instanceof Error ? error.message : String(error);
      const statusCode = code === "LIVE_WALLET_SIGNATURE_INVALID" ? 401 : 400;
      throw new HttpError(statusCode, code, "钱包连接证明未通过。");
    }
    try {
      const previousConfig = readLiveProductionConfig(options.projectRoot);
      const persistedIdentityIsReusable = previousConfig.walletAddress === session.walletAddress
        && previousConfig.tradingWalletAddress !== null
        && previousConfig.signatureType === "POLY_GNOSIS_SAFE";
      const tradingWallet = persistedIdentityIsReusable
        ? {
          walletAddress: session.walletAddress,
          tradingWalletAddress: previousConfig.tradingWalletAddress!,
          signatureType: previousConfig.signatureType,
          source: "GAMMA_PROFILE_GNOSIS_SAFE" as const,
        }
        : await (
          options.tradingWalletDiscovery ?? discoverPolymarketTradingWallet
        )(session.walletAddress);
      if (tradingWallet.walletAddress !== session.walletAddress) {
        throw new Error("LIVE_PRODUCTION_TRADING_WALLET_SIGNER_MISMATCH");
      }
      const preserveAuthorization = previousConfig.walletAddress === session.walletAddress;
      saveLiveProductionConfig(options.projectRoot, {
        walletAddress: session.walletAddress,
        tradingWalletAddress: tradingWallet.tradingWalletAddress,
        signatureType: tradingWallet.signatureType,
        network: session.network,
        ...(preserveAuthorization && previousConfig.limitsConfirmedAt !== null
          ? { confirmLimits: true }
          : {}),
        ...(preserveAuthorization && previousConfig.complianceAcceptedAt !== null
          ? { acceptCompliance: true }
          : {}),
      }, options.now);
      if (options.connectedLiveRuntimeFactory !== undefined) {
        const walletSessionBinding = walletSessionManager.createRuntimeBinding(
          session.sessionId,
          options.now,
        );
        const connected = await options.connectedLiveRuntimeFactory({
          projectRoot: options.projectRoot,
          walletSession: session,
          walletSessionBinding,
        });
        walletSessionBinding.assertCurrent();
        if ("runtimeActions" in connected) {
          liveRuntimeActions.install(
            connected.runtimeActions,
            walletSessionBinding,
            connected.dispose,
          );
          if (liveGateActions instanceof MutableOperatorLiveGateActions) {
            liveGateActions.install(connected.gateActions, walletSessionBinding);
          }
        } else {
          liveRuntimeActions.install(connected, walletSessionBinding);
        }
      }
    } catch (error) {
      const code = error instanceof Error ? error.message : String(error);
      if (canKeepWalletSessionWhenRuntimeAssemblyIsBlocked(code)) {
        success(response, {
          session,
          runtime: {
            accepted: false,
            code,
            details: { safety: "PAPER + LIVE_DISABLED" },
          },
          snapshot: dashboardSnapshot(),
        });
        return;
      }
      await walletSessionManager.disconnect(session.sessionId);
      const statusCode = code === "LIVE_WALLET_SIGNATURE_INVALID" ? 401 : 400;
      throw new HttpError(statusCode, code, "钱包连接证明未通过。");
    }
    success(response, { session, snapshot: dashboardSnapshot() });
    return;
  }

  if (request.method === "POST" && path === "/api/operator/live/wallet-session/disconnect") {
    const body = await readJson(request);
    const sessionId = body.sessionId === undefined ? undefined : stringField(body, "sessionId");
    try {
      await walletSessionManager.disconnect(sessionId);
    } catch (error) {
      const code = error instanceof Error ? error.message : String(error);
      const statusCode = code.startsWith("LIVE_WALLET_SESSION_INVALIDATION_FAILED:")
        ? 503
        : 404;
      throw new HttpError(statusCode, code, statusCode === 503 ? "钱包会话已断开，但 Live 紧急停用需要重试。" : "钱包会话不存在。");
    }
    if (sessionId !== undefined) walletRequestBroker.cancelSession(sessionId);
    success(response, { session: walletSessionManager.snapshot(options.now), snapshot: dashboardSnapshot() });
    return;
  }

  if (request.method === "PUT" && path === "/api/operator/live/configuration") {
    const body = await readJson(request);
    const networkValue = body.network === undefined ? undefined : stringField(body, "network").toUpperCase();
    if (networkValue !== undefined && networkValue !== "POLYGON" && networkValue !== "POLYGON_AMOY") {
      throw new HttpError(400, "LIVE_PRODUCTION_NETWORK_INVALID", "network 只能是 POLYGON 或 POLYGON_AMOY。");
    }
    const signatureType = body.signatureType === undefined
      ? undefined
      : stringField(body, "signatureType").toUpperCase();
    if (
      signatureType !== undefined
      && !["EOA", "POLY_PROXY", "POLY_GNOSIS_SAFE", "POLY_1271"].includes(signatureType)
    ) {
      throw new HttpError(400, "LIVE_PRODUCTION_SIGNATURE_TYPE_INVALID", "钱包类型不受支持。");
    }
    if (body.confirmLimits !== undefined && typeof body.confirmLimits !== "boolean") {
      throw new HttpError(400, "LIVE_LIMIT_CONFIRMATION_INVALID", "Live 限额确认必须是布尔值。");
    }
    const legacyTextConfirmed = body.confirmationText === undefined
      ? false
      : stringField(body, "confirmationText") === "CONFIRM SMALL LIVE LIMITS";
    if (body.confirmationText !== undefined && !legacyTextConfirmed) {
      throw new HttpError(400, "LIVE_LIMIT_CONFIRMATION_TEXT_MISMATCH", "Live 限额确认词不正确。");
    }
    const confirmLimits = body.confirmLimits === true || legacyTextConfirmed;
    const acceptCompliance = body.acceptCompliance === true;
    if (body.acceptCompliance !== undefined && typeof body.acceptCompliance !== "boolean") {
      throw new HttpError(400, "LIVE_COMPLIANCE_ACCEPTANCE_INVALID", "合规确认必须是布尔值。");
    }
    const previousConfig = readLiveProductionConfig(options.projectRoot);
    let config;
    try {
      config = saveLiveProductionConfig(options.projectRoot, {
        ...(body.walletAddress === undefined ? {} : { walletAddress: stringField(body, "walletAddress") }),
        ...(body.tradingWalletAddress === undefined
          ? {}
          : { tradingWalletAddress: stringField(body, "tradingWalletAddress") }),
        ...(signatureType === undefined
          ? {}
          : { signatureType: signatureType as LiveProductionSignatureType }),
        ...(networkValue === undefined
          ? {}
          : { network: networkValue as "POLYGON" | "POLYGON_AMOY" }),
        ...(body.liveBankrollMicros === undefined
          ? {}
          : { liveBankrollMicros: stringField(body, "liveBankrollMicros") }),
        ...(body.maxTradeSizeMicros === undefined
          ? {}
          : { maxTradeSizeMicros: stringField(body, "maxTradeSizeMicros") }),
        ...(body.maxExposureMicros === undefined
          ? {}
          : { maxExposureMicros: stringField(body, "maxExposureMicros") }),
        ...(body.maxDailyLossMicros === undefined
          ? {}
          : { maxDailyLossMicros: stringField(body, "maxDailyLossMicros") }),
        confirmLimits,
        acceptCompliance,
      }, options.now);
    } catch (error) {
      const code = error instanceof Error ? error.message : String(error);
      throw new HttpError(400, code, "Live 生产配置未通过校验。");
    }
    const runtimeBindingKeys = [
      "walletAddress",
      "tradingWalletAddress",
      "signatureType",
      "network",
      "liveBankrollMicros",
      "maxTradeSizeMicros",
      "maxExposureMicros",
      "maxDailyLossMicros",
    ] as const;
    const reconnectRequired = runtimeBindingKeys.some((key) => previousConfig[key] !== config[key]);
    const connectedSession = walletSessionManager.snapshot(options.now);
    if (reconnectRequired && connectedSession.status === "CONNECTED" && connectedSession.sessionId !== null) {
      await walletSessionManager.disconnect(connectedSession.sessionId);
      walletRequestBroker.cancelSession(
        connectedSession.sessionId,
        "LIVE_CONFIGURATION_CHANGED_RECONNECT_REQUIRED",
      );
    }
    success(response, {
      config,
      reconnectRequired: reconnectRequired && connectedSession.status === "CONNECTED",
      snapshot: dashboardSnapshot(),
    });
    return;
  }

  if (request.method === "PUT" && path === "/api/operator/target") {
    const body = await readJson(request);
    const result = saveSelectedTargetWallet(options.projectRoot, stringField(body, "walletAddress"));
    success(response, { result, snapshot: dashboardSnapshot() });
    return;
  }

  if (request.method === "PUT" && path === "/api/operator/ruleset") {
    const body = await readJson(request);
    const result = saveSelectedRulesetProfile(
      options.projectRoot,
      OPERATOR_RULESET_PROFILE_CONTEXT,
      {
        name: stringField(body, "name"),
        overrides: recordField(body, "overrides") as RulesetValues,
      },
    );
    success(response, { result, snapshot: dashboardSnapshot() });
    return;
  }

  if (request.method === "DELETE" && path === "/api/operator/ruleset") {
    const reset = resetSelectedRulesetProfile(options.projectRoot);
    success(response, { result: { reset }, snapshot: dashboardSnapshot() });
    return;
  }

  const runtimeMatch = path.match(/^\/api\/operator\/runtime\/(start|stop|recover)$/);
  if (request.method === "POST" && runtimeMatch !== null) {
    const body = await readJson(request);
    const mode = optionalString(body, "mode", "PAPER").toUpperCase();
    let result;
    if (mode === "PAPER") {
      result = runtimeMatch[1] === "start"
        ? await runtimeActions.startPaper()
        : runtimeMatch[1] === "stop"
          ? await runtimeActions.stopPaper()
          : await runtimeActions.recoverPaper();
    } else if (mode === "LIVE") {
      const actor = optionalString(body, "actor", "LOCAL_OPERATOR");
      const reason = optionalString(body, "reason", `UI_RUNTIME_${runtimeMatch[1]?.toUpperCase()}`);
      if (runtimeMatch[1] === "start") {
        if (
          liveRuntimeActions.status?.state === "ERROR"
          && liveRuntimeActions.status.lastError?.startsWith("LIVE_WALLET_SESSION_")
        ) {
          throw new HttpError(
            409,
            "LIVE_WALLET_SESSION_INVALIDATED",
            "当前钱包会话已经失效，请重新连接钱包。",
            { reason: liveRuntimeActions.status.lastError },
          );
        }
        assertPersistedLiveGateActive(options.projectRoot);
      }
      result = runtimeMatch[1] === "start"
        ? await liveRuntimeActions.start({ actor, reason })
        : runtimeMatch[1] === "stop"
          ? await liveRuntimeActions.stop({ actor, reason })
          : await liveRuntimeActions.recover({ actor, reason });
      if (!result.accepted) {
        throw new HttpError(409, result.code, "Live 运行时未配置或被安全边界阻断。", result);
      }
      success(response, { result, snapshot: dashboardSnapshot() }, 202);
      return;
    } else {
      throw new HttpError(400, "UNSUPPORTED_RUNTIME_MODE", "mode 只能是 PAPER 或 LIVE。");
    }
    success(response, { result, snapshot: dashboardSnapshot() }, 202);
    return;
  }

  if (request.method === "POST" && path === "/api/operator/live/preflight") {
    const result = await withLiveRuntimeFreshnessGuard({
      options,
      walletSessionManager,
      walletRequestBroker,
      action: () => liveGateActions.preflight(),
    });
    if (!result.allowed) {
      failure(response, new HttpError(409, "LIVE_GATE_BLOCKED", "Live Gate 未通过。", result));
      return;
    }
    success(response, { result, snapshot: dashboardSnapshot() });
    return;
  }

  if (request.method === "POST" && path === "/api/operator/live/request") {
    const body = await readJson(request);
    const result = await withLiveRuntimeFreshnessGuard({
      options,
      walletSessionManager,
      walletRequestBroker,
      action: () => liveGateActions.requestActivation({
        actor: optionalString(body, "actor", "LOCAL_OPERATOR"),
        reason: optionalString(body, "reason", "UI_MODE_SWITCH"),
      }),
    });
    if (!result.allowed) {
      failure(response, new HttpError(409, "LIVE_GATE_BLOCKED", "Live Gate 未允许进入 Live。", result));
      return;
    }
    success(response, { result, snapshot: dashboardSnapshot() });
    return;
  }

  if (request.method === "POST" && path === "/api/operator/live/activate") {
    const body = await readJson(request);
    const actor = optionalString(body, "actor", "LOCAL_OPERATOR");
    const reason = optionalString(body, "reason", "UI_ONE_CLICK_LIVE");
    const confirmationText = stringField(body, "confirmationText");
    let stage = "GATE";
    let runtimeStarted = false;
    const rollback = async (code: string) => {
      const runtimeStopRequired = runtimeStarted;
      let gateDisabled = false;
      let gateError: string | null = null;
      let runtimeStopped: boolean | null = runtimeStopRequired ? false : null;
      let runtimeCode: string | null = null;
      const rollbackReason = `LIVE_ACTIVATION_${stage}_ROLLBACK:${code}`;
      try {
        await liveGateActions.emergencyDisable({
          actor: "SYSTEM",
          reason: rollbackReason,
        });
        gateDisabled = true;
      } catch (error) {
        gateError = errorCode(error);
      }
      if (runtimeStopRequired) {
        try {
          const stopped = await liveRuntimeActions.stop({
            actor: "SYSTEM",
            reason: rollbackReason,
          });
          runtimeStopped = stopped.accepted;
          runtimeCode = stopped.code;
        } catch (error) {
          runtimeStopped = false;
          runtimeCode = errorCode(error);
        }
      }
      runtimeStarted = false;
      return {
        gateDisabled,
        gateError,
        runtimeStopRequired,
        runtimeStopped,
        runtimeCode,
      };
    };
    const assertRollbackComplete = (
      originalCode: string,
      result: Awaited<ReturnType<typeof rollback>>,
    ): void => {
      if (result.gateDisabled && (!result.runtimeStopRequired || result.runtimeStopped)) return;
      throw new HttpError(
        503,
        "LIVE_ACTIVATION_ROLLBACK_INCOMPLETE",
        "Live 切换失败后的安全回滚未完整完成；请立即使用“紧急停用 Live”重试。",
        {
          stage,
          originalCode,
          ...result,
          safety: result.gateDisabled ? "PAPER + LIVE_DISABLED" : "UNCONFIRMED",
        },
      );
    };
    try {
      const initialGate = await withLiveRuntimeFreshnessGuard({
        options,
        walletSessionManager,
        walletRequestBroker,
        action: () => liveGateActions.requestActivation({ actor, reason }),
      });
      if (!initialGate.allowed) {
        failure(response, new HttpError(
          409,
          "LIVE_GATE_BLOCKED",
          "Live Gate 未允许进入 Live。",
          { ...initialGate, stage },
        ));
        return;
      }

      stage = "RECONCILIATION";
      const reconciliation = await liveRuntimeActions.reconcile({
        actor,
        reason: "ONE_CLICK_LIVE_RECONCILIATION",
      });
      if (!reconciliation.accepted) {
        const rollbackResult = await rollback(reconciliation.code);
        assertRollbackComplete(reconciliation.code, rollbackResult);
        throw new HttpError(
          409,
          reconciliation.code,
          "Live 对账未通过，已自动回到 Paper。",
          {
            stage,
            safety: "PAPER + LIVE_DISABLED",
            result: reconciliation,
          },
        );
      }

      stage = "WALLET";
      const wallet = await liveRuntimeActions.prepareWallet({
        actor,
        reason: "ONE_CLICK_LIVE_WALLET_READINESS",
      });
      if (!wallet.accepted) {
        const rollbackResult = await rollback(wallet.code);
        assertRollbackComplete(wallet.code, rollbackResult);
        throw new HttpError(
          409,
          wallet.code,
          "钱包交易授权未准备完成，已自动回到 Paper。",
          {
            stage,
            safety: "PAPER + LIVE_DISABLED",
            result: wallet,
          },
        );
      }

      stage = "GATE_REFRESH";
      const refreshedGate = await withLiveRuntimeFreshnessGuard({
        options,
        walletSessionManager,
        walletRequestBroker,
        action: () => liveGateActions.requestActivation({
          actor,
          reason: `${reason}:AFTER_RECONCILIATION`,
        }),
      });
      if (!refreshedGate.allowed) {
        const rollbackResult = await rollback("LIVE_GATE_BLOCKED");
        assertRollbackComplete("LIVE_GATE_BLOCKED", rollbackResult);
        throw new HttpError(
          409,
          "LIVE_GATE_BLOCKED",
          "最终 Live Gate 检查未通过，已自动回到 Paper。",
          {
            ...refreshedGate,
            stage,
            safety: "PAPER + LIVE_DISABLED",
          },
        );
      }

      stage = "RUNTIME_START";
      const runtime = await withLiveRuntimeFreshnessGuard({
        options,
        walletSessionManager,
        walletRequestBroker,
        action: () => liveRuntimeActions.start({
          actor,
          reason: "LIVE_GATE_ARMED_RUNTIME_START",
        }),
      });
      if (!runtime.accepted) {
        const rollbackResult = await rollback(runtime.code);
        assertRollbackComplete(runtime.code, rollbackResult);
        throw new HttpError(
          409,
          runtime.code,
          "Live 运行时启动失败，Gate 已自动回滚。",
          {
            stage,
            safety: "PAPER + LIVE_DISABLED",
            result: runtime,
          },
        );
      }
      runtimeStarted = true;

      stage = "CONFIRMATION";
      const result = await withLiveRuntimeFreshnessGuard({
        options,
        walletSessionManager,
        walletRequestBroker,
        action: () => liveGateActions.confirmActivation({
          actor,
          confirmationText,
        }),
      });
      if (!result.allowed) {
        const rollbackResult = await rollback("LIVE_GATE_BLOCKED");
        assertRollbackComplete("LIVE_GATE_BLOCKED", rollbackResult);
        throw new HttpError(
          409,
          "LIVE_GATE_BLOCKED",
          "Live 最终确认未通过，已自动回到 Paper。",
          {
            ...result,
            stage,
            safety: "PAPER + LIVE_DISABLED",
          },
        );
      }
      success(response, {
        result,
        runtime,
        preparation: {
          reconciliation,
          wallet,
          initialGate,
          refreshedGate,
        },
        snapshot: dashboardSnapshot(),
      }, 202);
      return;
    } catch (error) {
      const code = errorCode(error);
      const runtimeWasStarted = runtimeStarted;
      if (runtimeWasStarted) {
        const rollbackResult = await rollback(code);
        assertRollbackComplete(code, rollbackResult);
      }
      if (error instanceof HttpError) throw error;
      if (!runtimeWasStarted) {
        const rollbackResult = await rollback(code);
        assertRollbackComplete(code, rollbackResult);
      }
      throw new HttpError(
        409,
        code,
        "Live 一键切换未完成，已保持 Paper。",
        {
          stage,
          safety: "PAPER + LIVE_DISABLED",
          reason: code,
        },
      );
    }
  }

  if (request.method === "POST" && path === "/api/operator/live/confirm") {
    const body = await readJson(request);
    const actor = optionalString(body, "actor", "LOCAL_OPERATOR");
    const confirmationText = stringField(body, "confirmationText");
    const runtime = await withLiveRuntimeFreshnessGuard({
      options,
      walletSessionManager,
      walletRequestBroker,
      action: () => liveRuntimeActions.start({
        actor,
        reason: "LIVE_GATE_ARMED_RUNTIME_START",
      }),
    });
    if (!runtime.accepted) {
      await liveGateActions.emergencyDisable({
        actor: "SYSTEM",
        reason: `LIVE_RUNTIME_START_ROLLBACK:${runtime.code}`,
      });
      throw new HttpError(
        409,
        runtime.code,
        "Live Gate 已回滚：运行时启动失败。",
        { runtime },
      );
    }
    const rollbackConfirmation = async (originalCode: string): Promise<void> => {
      let gateDisabled = false;
      let gateError: string | null = null;
      try {
        await liveGateActions.emergencyDisable({
          actor: "SYSTEM",
          reason: "LIVE_GATE_CONFIRMATION_ROLLBACK",
        });
        gateDisabled = true;
      } catch (error) {
        gateError = errorCode(error);
      }
      let stopped: OperatorLiveRuntimeResult;
      try {
        stopped = await liveRuntimeActions.stop({
          actor: "SYSTEM",
          reason: "LIVE_GATE_CONFIRMATION_ROLLBACK",
        });
      } catch (error) {
        stopped = {
          accepted: false,
          code: errorCode(error),
        };
      }
      if (gateDisabled && stopped.accepted) return;
      throw new HttpError(
        503,
        "LIVE_CONFIRMATION_ROLLBACK_INCOMPLETE",
        "Live 最终确认失败后的安全回滚未完整完成；请立即使用“紧急停用 Live”重试。",
        {
          originalCode,
          gateDisabled,
          gateError,
          runtimeStopped: stopped.accepted,
          runtimeCode: stopped.code,
          safety: gateDisabled ? "PAPER + LIVE_DISABLED" : "UNCONFIRMED",
        },
      );
    };
    let result: OperatorLiveGateResult;
    try {
      result = await withLiveRuntimeFreshnessGuard({
        options,
        walletSessionManager,
        walletRequestBroker,
        action: () => liveGateActions.confirmActivation({
          actor,
          confirmationText,
        }),
      });
    } catch (error) {
      await rollbackConfirmation(errorCode(error));
      throw error;
    }
    if (!result.allowed) {
      await rollbackConfirmation("LIVE_GATE_BLOCKED");
      failure(response, new HttpError(409, "LIVE_GATE_BLOCKED", "Live Gate 二次确认未通过。", result));
      return;
    }
    success(response, { result, runtime, snapshot: dashboardSnapshot() }, 202);
    return;
  }

  if (request.method === "POST" && path === "/api/operator/live/emergency-disable") {
    const body = await readJson(request);
    const actor = optionalString(body, "actor", "LOCAL_OPERATOR");
    const reason = optionalString(body, "reason", "UI_EMERGENCY_DISABLE");
    let gateError: unknown = null;
    try {
      await liveGateActions.emergencyDisable({
        actor,
        reason,
      });
    } catch (error) {
      gateError = error;
    }
    const runtime = await liveRuntimeActions.stop({ actor, reason });
    if (gateError !== null) {
      throw new HttpError(
        503,
        "LIVE_EMERGENCY_DISABLE_INCOMPLETE",
        "Live 紧急停用未完整完成：后台运行已请求停止，但 Gate 状态写入失败，请保持页面打开并立即重试。",
        {
          gateDisabled: false,
          gateError: errorCode(gateError),
          runtimeStopped: runtime.accepted,
          runtimeCode: runtime.code,
        },
      );
    }
    if (!runtime.accepted) {
      throw new HttpError(
        409,
        "LIVE_GATE_DISABLED_RUNTIME_STOP_FAILED",
        "Live Gate 已切回 Paper，但后台运行循环未能确认停止；新交易已被 Gate 阻断，请立即重试安全暂停。",
        {
          gateDisabled: true,
          runtimeStopped: false,
          runtimeCode: runtime.code,
          runtimeDetails: runtime.details ?? null,
          safety: "PAPER + LIVE_DISABLED",
        },
      );
    }
    success(response, {
      result: {
        accepted: true,
        runtimeStopped: true,
        runtimeCode: runtime.code,
      },
      snapshot: dashboardSnapshot(),
    }, 202);
    return;
  }

  if (request.method === "POST" && path === "/api/operator/live/recover") {
    const result = await withLiveRuntimeFreshnessGuard({
      options,
      walletSessionManager,
      walletRequestBroker,
      action: () => liveGateActions.recover(),
    });
    if (!result.allowed) {
      failure(response, new HttpError(409, "LIVE_GATE_BLOCKED", "Live Gate 恢复检查未通过。", result));
      return;
    }
    success(response, { result, snapshot: dashboardSnapshot() });
    return;
  }

  const cancelMatch = path.match(/^\/api\/operator\/live\/orders\/([^/]+)\/cancel$/);
  if (request.method === "POST" && cancelMatch !== null) {
    const body = await readJson(request);
    const result = await liveRuntimeActions.cancelOrder({
      orderId: decodeURIComponent(cancelMatch[1] ?? ""),
      actor: optionalString(body, "actor", "LOCAL_OPERATOR"),
      reason: optionalString(body, "reason", "UI_ORDER_CANCEL"),
    });
    if (!result.accepted) {
      throw new HttpError(409, result.code, "Live 订单取消未执行。", result);
    }
    success(response, { result, snapshot: dashboardSnapshot() }, 202);
    return;
  }

  if (request.method === "POST" && path === "/api/operator/live/reconcile") {
    const body = await readJson(request);
    const result = await liveRuntimeActions.reconcile({
      actor: optionalString(body, "actor", "LOCAL_OPERATOR"),
      reason: optionalString(body, "reason", "UI_RECONCILIATION"),
    });
    if (!result.accepted) throw new HttpError(409, result.code, "Live 对账未执行。", result);
    success(response, { result, snapshot: dashboardSnapshot() }, 202);
    return;
  }

  if (request.method === "POST" && path === "/api/operator/live/wallet-setup") {
    const body = await readJson(request);
    const result = await liveRuntimeActions.prepareWallet({
      actor: optionalString(body, "actor", "LOCAL_OPERATOR"),
      reason: optionalString(body, "reason", "UI_WALLET_ALLOWANCE_SETUP"),
    });
    if (!result.accepted) throw new HttpError(409, result.code, "钱包交易授权未完成。", result);
    success(response, { result, snapshot: dashboardSnapshot() });
    return;
  }

  if (request.method === "POST" && path === "/api/operator/live/recover-runtime") {
    const body = await readJson(request);
    const result = await liveRuntimeActions.recover({
      actor: optionalString(body, "actor", "LOCAL_OPERATOR"),
      reason: optionalString(body, "reason", "UI_RECOVERY"),
    });
    if (!result.accepted) throw new HttpError(409, result.code, "Live 恢复未执行。", result);
    success(response, { result, snapshot: dashboardSnapshot() }, 202);
    return;
  }

  const retryMatch = path.match(/^\/api\/operator\/live\/executions\/([^/]+)\/retry$/);
  if (request.method === "POST" && retryMatch !== null) {
    const body = await readJson(request);
    assertPersistedLiveGateActive(options.projectRoot);
    const result = await liveRuntimeActions.retryExecution({
      executionId: decodeURIComponent(retryMatch[1] ?? ""),
      actor: optionalString(body, "actor", "LOCAL_OPERATOR"),
      reason: optionalString(body, "reason", "UI_EXECUTION_RETRY"),
    });
    if (!result.accepted) throw new HttpError(409, result.code, "Live 执行重试未执行。", result);
    success(response, { result, snapshot: dashboardSnapshot() }, 202);
    return;
  }

  throw new HttpError(404, "API_ROUTE_NOT_FOUND", "未找到该操作接口。");
}

async function serveStatic(
  response: ServerResponse,
  staticRoot: string,
  pathname: string,
): Promise<void> {
  const requested = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const root = resolve(staticRoot);
  const file = resolve(root, normalize(requested));
  if (file !== root && !file.startsWith(`${root}/`)) {
    throw new HttpError(404, "STATIC_NOT_FOUND", "未找到页面。");
  }
  if (!existsSync(file) || !statSync(file).isFile()) {
    throw new HttpError(404, "STATIC_NOT_FOUND", "未找到页面。");
  }
  setHeaders(response);
  response.writeHead(200, {
    "content-type": CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
  });
  createReadStream(file).pipe(response);
}

function staticRootFromOptions(options: OperatorUiServerOptions): string {
  return options.staticRoot
    ? resolve(options.staticRoot)
    : resolve(fileURLToPath(new URL("../../prototype/live-ui/", import.meta.url)));
}

export function createOperatorUiServer(options: OperatorUiServerOptions): OperatorUiServer {
  const runtimeActions = options.runtimeActions ?? new DefaultOperatorRuntimeActions(options.projectRoot);
  const liveGateActions = new MutableOperatorLiveGateActions(
    options.liveGateActions ?? new DefaultOperatorLiveGateActions(options.projectRoot),
  );
  const liveRuntimeActions = new MutableOperatorLiveRuntimeActions(
    options.liveRuntimeActions ?? new UnconfiguredOperatorLiveRuntimeActions(),
  );
  const walletSessionManager = options.walletSessionManager ?? new LiveWalletSessionManager();
  const walletRequestBroker = options.walletRequestBroker ?? new LiveWalletRequestBroker({
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const staticRoot = staticRootFromOptions(options);
  const service = {
    instanceId: randomUUID(),
    startedAt: (options.now ?? (() => new Date()))().toISOString(),
    sourceVersion: resolveSourceVersion(options.projectRoot),
  };
  let prerequisiteSourceVersion = service.sourceVersion;
  try {
    prerequisiteSourceVersion = validatedLiveProductionSourceVersion(
      options.projectRoot,
      service.sourceVersion,
    );
  } catch {
    // The dashboard will keep existing prerequisite evidence visibly stale;
    // the production assembly returns the exact actionable validation error.
  }
  const server = createServer(async (request, response) => {
    setHeaders(response);
    try {
      if (!isAllowedHost(request.headers.host)) {
        throw new HttpError(403, "HOST_NOT_ALLOWED", "仅允许本机 localhost 访问。");
      }
      const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
      if (url.pathname.startsWith("/api/")) {
        await handleApi({
          request,
          response,
          url,
          options,
          runtimeActions,
          liveGateActions,
          liveRuntimeActions,
          walletSessionManager,
          walletRequestBroker,
          service,
          prerequisiteSourceVersion,
        });
      } else if (request.method === "GET" || request.method === "HEAD") {
        await serveStatic(response, staticRoot, url.pathname);
      } else {
        throw new HttpError(405, "METHOD_NOT_ALLOWED", "该页面只支持 GET。");
      }
    } catch (error) {
      if (!response.headersSent) failure(response, error);
      else response.destroy(error instanceof Error ? error : undefined);
    }
  }) as OperatorUiServer;
  server.shutdownSafety = async (): Promise<void> => {
    const failures: string[] = [];
    let shouldDisableGate = false;
    try {
      const safety = operatorRuntimeSafety(options.projectRoot);
      shouldDisableGate = safety.databaseAvailable
        && safety.liveGateState !== "LIVE_DISABLED";
    } catch (error) {
      failures.push(`SAFETY:${error instanceof Error ? error.message : String(error)}`);
      shouldDisableGate = existsSync(resolve(options.projectRoot, OPERATOR_DATABASE_FILE));
    }
    if (shouldDisableGate) {
      try {
        await liveGateActions.emergencyDisable({
          actor: "SYSTEM",
          reason: "OPERATOR_UI_SHUTDOWN",
        });
      } catch (error) {
        failures.push(`GATE:${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const session = walletSessionManager.snapshot(options.now);
    if (session.status === "CONNECTED" && session.sessionId !== null) {
      try {
        await walletSessionManager.disconnect(session.sessionId);
      } catch (error) {
        failures.push(`WALLET:${error instanceof Error ? error.message : String(error)}`);
      } finally {
        walletRequestBroker.cancelSession(
          session.sessionId,
          "LIVE_OPERATOR_UI_SHUTDOWN",
        );
      }
    } else if (liveRuntimeActions.capability.execution === "AVAILABLE") {
      const stopped = await liveRuntimeActions.stop({
        actor: "SYSTEM",
        reason: "OPERATOR_UI_SHUTDOWN",
      });
      if (!stopped.accepted) failures.push(`RUNTIME:${stopped.code}`);
    }
    liveRuntimeActions.dispose();
    if (failures.length > 0) {
      throw new Error(`OPERATOR_UI_SAFE_SHUTDOWN_FAILED:${failures.join(";")}`);
    }
  };
  return server;
}

export async function startOperatorUiServer(
  options: OperatorUiServerOptions,
  port = Number(process.env.OPERATOR_UI_PORT ?? 4173),
): Promise<OperatorUiServer> {
  const startupSafety = operatorRuntimeSafety(options.projectRoot);
  if (startupSafety.databaseAvailable
    && (startupSafety.executionMode !== "PAPER"
      || startupSafety.liveGateState !== "LIVE_DISABLED")) {
    const startupGateActions = options.liveGateActions
      ?? new DefaultOperatorLiveGateActions(options.projectRoot);
    await startupGateActions.emergencyDisable({
      actor: "SYSTEM",
      reason: "OPERATOR_UI_STARTUP_STALE_LIVE_RESET",
    });
    const resetSafety = operatorRuntimeSafety(options.projectRoot);
    if (resetSafety.executionMode !== "PAPER"
      || resetSafety.liveGateState !== "LIVE_DISABLED") {
      throw new Error("OPERATOR_UI_STARTUP_SAFETY_RESET_FAILED");
    }
  }
  const server = createOperatorUiServer(options);
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolveListen());
  });
  return server;
}
