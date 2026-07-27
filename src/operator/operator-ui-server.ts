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
  type OperatorLiveRuntimeActions,
  type OperatorLiveRuntimeResult,
  type OperatorRuntimeActions,
} from "./operator-actions.js";
import {
  resetSelectedRulesetProfile,
  saveSelectedRulesetProfile,
  type RulesetValues,
} from "./ruleset-profile.js";
import { OPERATOR_RULESET_PROFILE_CONTEXT } from "../domain/versioning.js";
import { saveSelectedTargetWallet } from "./target-wallet.js";
import {
  liveProductionReadiness,
  saveLiveProductionConfig,
} from "./live-production-readiness.js";
import {
  LiveWalletSessionManager,
  type LiveWalletRuntimeBinding,
  type LiveWalletSession,
} from "./live-wallet-session.js";

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
  connectedLiveRuntimeFactory?: (input: {
    projectRoot: string;
    walletSession: LiveWalletSession;
    walletSessionBinding: LiveWalletRuntimeBinding;
  }) => Promise<OperatorLiveRuntimeActions>;
  now?: () => Date;
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
}

class MutableOperatorLiveRuntimeActions implements OperatorLiveRuntimeActions {
  constructor(private current: OperatorLiveRuntimeActions) {}

  private walletSessionBinding: LiveWalletRuntimeBinding | null = null;
  private walletSessionInvalidationReason: string | null = null;
  private unsubscribeWalletSession: (() => void) | null = null;

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

  install(actions: OperatorLiveRuntimeActions, walletSessionBinding?: LiveWalletRuntimeBinding): void {
    this.unsubscribeWalletSession?.();
    this.unsubscribeWalletSession = null;
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
        });
      });
      walletSessionBinding.assertCurrent();
    }
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
): OperatorDashboardSnapshot {
  const snapshot = options.now === undefined
    ? operatorDashboardSnapshot(options.projectRoot)
    : operatorDashboardSnapshot(options.projectRoot, { now: options.now });
  snapshot.live.capability.execution = liveRuntimeActions.capability.execution;
  snapshot.live.capability.orderManagement = liveRuntimeActions.capability.orderManagement;
  snapshot.live.walletSession = walletSessionManager.snapshot(options.now);
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
  } = context;
  const dashboardSnapshot = (): OperatorDashboardSnapshot => freshSnapshot(
    options,
    liveRuntimeActions,
    walletSessionManager,
  );
  if (isMutation(request.method ?? "GET")) assertRequestOrigin(request);
  const path = url.pathname;

  if (request.method === "GET" && path === "/api/operator/snapshot") {
    success(response, dashboardSnapshot());
    return;
  }

  if (request.method === "GET" && path === "/api/operator/live/wallet-session") {
    success(response, walletSessionManager.snapshot(options.now));
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
    try {
      const session = await walletSessionManager.connect({
        challengeId,
        walletAddress,
        chainId,
        signature,
      }, options.now);
      try {
        saveLiveProductionConfig(options.projectRoot, {
          walletAddress: session.walletAddress,
          network: session.network,
        }, options.now);
        if (options.connectedLiveRuntimeFactory !== undefined) {
          const walletSessionBinding = walletSessionManager.createRuntimeBinding(
            session.sessionId,
            options.now,
          );
          const actions = await options.connectedLiveRuntimeFactory({
            projectRoot: options.projectRoot,
            walletSession: session,
            walletSessionBinding,
          });
          walletSessionBinding.assertCurrent();
          liveRuntimeActions.install(actions, walletSessionBinding);
        }
      } catch (error) {
        await walletSessionManager.disconnect(session.sessionId);
        throw error;
      }
      success(response, { session, snapshot: dashboardSnapshot() });
    } catch (error) {
      const code = error instanceof Error ? error.message : String(error);
      const statusCode = code === "LIVE_WALLET_SIGNATURE_INVALID" ? 401 : 400;
      throw new HttpError(statusCode, code, "钱包连接证明未通过。");
    }
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
    success(response, { session: walletSessionManager.snapshot(options.now), snapshot: dashboardSnapshot() });
    return;
  }

  if (request.method === "PUT" && path === "/api/operator/live/configuration") {
    const body = await readJson(request);
    const walletAddress = stringField(body, "walletAddress");
    const network = stringField(body, "network").toUpperCase();
    if (network !== "POLYGON" && network !== "POLYGON_AMOY") {
      throw new HttpError(400, "LIVE_PRODUCTION_NETWORK_INVALID", "network 只能是 POLYGON 或 POLYGON_AMOY。");
    }
    const config = saveLiveProductionConfig(options.projectRoot, {
      walletAddress,
      network,
    });
    success(response, { config, snapshot: dashboardSnapshot() });
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
    const result = await liveGateActions.preflight();
    if (!result.allowed) {
      failure(response, new HttpError(409, "LIVE_GATE_BLOCKED", "Live Gate 未通过。", result));
      return;
    }
    success(response, { result, snapshot: dashboardSnapshot() });
    return;
  }

  if (request.method === "POST" && path === "/api/operator/live/request") {
    const body = await readJson(request);
    const result = await liveGateActions.requestActivation({
      actor: optionalString(body, "actor", "LOCAL_OPERATOR"),
      reason: optionalString(body, "reason", "UI_MODE_SWITCH"),
    });
    if (!result.allowed) {
      failure(response, new HttpError(409, "LIVE_GATE_BLOCKED", "Live Gate 未允许进入 Live。", result));
      return;
    }
    success(response, { result, snapshot: dashboardSnapshot() });
    return;
  }

  if (request.method === "POST" && path === "/api/operator/live/confirm") {
    const body = await readJson(request);
    const result = await liveGateActions.confirmActivation({
      actor: optionalString(body, "actor", "LOCAL_OPERATOR"),
      confirmationText: stringField(body, "confirmationText"),
    });
    if (!result.allowed) {
      failure(response, new HttpError(409, "LIVE_GATE_BLOCKED", "Live Gate 二次确认未通过。", result));
      return;
    }
    success(response, { result, snapshot: dashboardSnapshot() });
    return;
  }

  if (request.method === "POST" && path === "/api/operator/live/emergency-disable") {
    const body = await readJson(request);
    await liveGateActions.emergencyDisable({
      actor: optionalString(body, "actor", "LOCAL_OPERATOR"),
      reason: optionalString(body, "reason", "UI_EMERGENCY_DISABLE"),
    });
    success(response, { result: { accepted: true }, snapshot: dashboardSnapshot() });
    return;
  }

  if (request.method === "POST" && path === "/api/operator/live/recover") {
    const result = await liveGateActions.recover();
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

export function createOperatorUiServer(options: OperatorUiServerOptions): Server {
  const runtimeActions = options.runtimeActions ?? new DefaultOperatorRuntimeActions(options.projectRoot);
  const liveGateActions = options.liveGateActions ?? new DefaultOperatorLiveGateActions(options.projectRoot);
  const liveRuntimeActions = new MutableOperatorLiveRuntimeActions(
    options.liveRuntimeActions ?? new UnconfiguredOperatorLiveRuntimeActions(),
  );
  const walletSessionManager = options.walletSessionManager ?? new LiveWalletSessionManager();
  const staticRoot = staticRootFromOptions(options);
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
  });
  return server;
}

export async function startOperatorUiServer(
  options: OperatorUiServerOptions,
  port = Number(process.env.OPERATOR_UI_PORT ?? 4173),
): Promise<Server> {
  const server = createOperatorUiServer(options);
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolveListen());
  });
  return server;
}
