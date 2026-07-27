import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { assertOperatorMutationAllowed } from "./operator-mutation-guard.js";

const CONFIG_FILE = "data/operator/live-production.json";
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/i;

export type LiveProductionCheckStatus = "READY" | "PENDING";
export type LiveProductionCheckKey = LiveProductionReadinessCheck["key"];
export type LiveProductionCapabilityOverrides = Partial<
  Record<Exclude<LiveProductionCheckKey, "USER_AUTHORIZATION" | "LIVE_RUNTIME">, boolean>
>;

export interface LiveProductionConfig {
  schemaVersion: "live-production-config-v1";
  walletAddress: string | null;
  network: "POLYGON" | "POLYGON_AMOY" | null;
  walletBinding: "SECURE_HOST_INJECTION";
  updatedAt: string | null;
}

export interface LiveProductionReadinessCheck {
  key:
    | "FORMAL_WALLET"
    | "SECURE_SIGNER"
    | "READONLY_BALANCE"
    | "AUTHENTICATED_CLOB"
    | "COMPLIANCE"
    | "GEOBLOCK"
    | "CLOCK_SAFETY"
    | "LIVE_RUNTIME"
    | "USER_AUTHORIZATION";
  status: LiveProductionCheckStatus;
  reason: string;
}

export interface LiveProductionReadiness {
  path: "PRODUCTION_LIVE";
  status: "READY" | "PENDING_PREREQUISITES";
  checkedAt: string;
  config: LiveProductionConfig;
  checks: LiveProductionReadinessCheck[];
  nextStep: "CONNECT_FORMAL_WALLET" | "INJECT_PRODUCTION_DEPENDENCIES" | "RUN_PRODUCTION_PREFLIGHT";
}

export interface LiveProductionReadinessInput {
  databaseAvailable: boolean;
  gatePrerequisites: readonly { key: string; status: string }[];
  executionCapability: "AVAILABLE" | "PENDING_PREREQUISITES" | "NOT_CONFIGURED";
  injectedChecks?: LiveProductionCapabilityOverrides;
  walletSession?: {
    walletAddress: string;
    network: "POLYGON" | "POLYGON_AMOY";
  };
}

function defaultConfig(): LiveProductionConfig {
  return {
    schemaVersion: "live-production-config-v1",
    walletAddress: null,
    network: null,
    walletBinding: "SECURE_HOST_INJECTION",
    updatedAt: null,
  };
}

function parseConfig(value: unknown): LiveProductionConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return defaultConfig();
  const record = value as Record<string, unknown>;
  const walletAddress = typeof record.walletAddress === "string"
    && ADDRESS_RE.test(record.walletAddress)
    ? record.walletAddress.toLowerCase()
    : null;
  const network = record.network === "POLYGON" || record.network === "POLYGON_AMOY"
    ? record.network
    : null;
  return {
    schemaVersion: "live-production-config-v1",
    walletAddress,
    network,
    walletBinding: "SECURE_HOST_INJECTION",
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : null,
  };
}

export function liveProductionConfigPath(projectRoot: string): string {
  return resolve(projectRoot, CONFIG_FILE);
}

export function readLiveProductionConfig(projectRoot: string): LiveProductionConfig {
  const path = liveProductionConfigPath(projectRoot);
  if (!existsSync(path)) return defaultConfig();
  try {
    return parseConfig(JSON.parse(readFileSync(path, "utf8")) as unknown);
  } catch {
    return defaultConfig();
  }
}

export function saveLiveProductionConfig(
  projectRoot: string,
  input: { walletAddress: string; network: "POLYGON" | "POLYGON_AMOY" },
  now: () => Date = () => new Date(),
): LiveProductionConfig {
  assertOperatorMutationAllowed(projectRoot, "LIVE_PRODUCTION_CONFIGURATION");
  if (!ADDRESS_RE.test(input.walletAddress)) throw new Error("LIVE_PRODUCTION_WALLET_ADDRESS_INVALID");
  const config: LiveProductionConfig = {
    schemaVersion: "live-production-config-v1",
    walletAddress: input.walletAddress.toLowerCase(),
    network: input.network,
    walletBinding: "SECURE_HOST_INJECTION",
    updatedAt: now().toISOString(),
  };
  const path = liveProductionConfigPath(projectRoot);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return config;
}

function prerequisitePassed(
  prerequisites: readonly { key: string; status: string }[],
  key: string,
): boolean {
  return prerequisites.some((item) => item.key === key && item.status === "PASSED");
}

export function liveProductionReadiness(
  projectRoot: string,
  input: LiveProductionReadinessInput,
  now: () => Date = () => new Date(),
): LiveProductionReadiness {
  const config = readLiveProductionConfig(projectRoot);
  const injected = input.injectedChecks ?? {};
  const connectedWalletMatches = input.walletSession?.network === "POLYGON"
    && input.walletSession.walletAddress.toLowerCase() === config.walletAddress;
  const walletReady = config.walletAddress !== null
    && config.network === "POLYGON"
    && (connectedWalletMatches || injected.FORMAL_WALLET === true);
  const checks: LiveProductionReadinessCheck[] = [
    {
      key: "FORMAL_WALLET",
      status: walletReady ? "READY" : "PENDING",
      reason: walletReady
        ? "生产钱包身份已登记并完成本机钱包会话证明。"
        : "尚未连接 Polygon 主网正式钱包。",
    },
    {
      key: "SECURE_SIGNER",
      status: injected.SECURE_SIGNER === true ? "READY" : "PENDING",
      reason: injected.SECURE_SIGNER === true
        ? "Signer 已由安全宿主显式注入。"
        : "Signer 只能由安全宿主显式注入，浏览器和配置文件不保存私钥。",
    },
    {
      key: "READONLY_BALANCE",
      status: injected.READONLY_BALANCE === true ? "READY" : "PENDING",
      reason: injected.READONLY_BALANCE === true
        ? "生产只读余额与 allowance provider 已注入。"
        : "等待生产只读余额与 allowance provider。",
    },
    {
      key: "AUTHENTICATED_CLOB",
      status: injected.AUTHENTICATED_CLOB === true ? "READY" : "PENDING",
      reason: injected.AUTHENTICATED_CLOB === true
        ? "认证 CLOB adapter 已注入。"
        : "等待认证 CLOB adapter；当前不会提交或取消真实订单。",
    },
    {
      key: "COMPLIANCE",
      status: injected.COMPLIANCE === true ? "READY" : "PENDING",
      reason: injected.COMPLIANCE === true
        ? "生产合规 provider 已注入。"
        : "等待生产合规 provider 和新鲜证据。",
    },
    {
      key: "GEOBLOCK",
      status: injected.GEOBLOCK === true ? "READY" : "PENDING",
      reason: injected.GEOBLOCK === true
        ? "生产地域限制 provider 已注入。"
        : "等待生产地域限制 provider 和新鲜证据。",
    },
    {
      key: "CLOCK_SAFETY",
      status: injected.CLOCK_SAFETY === true ? "READY" : "PENDING",
      reason: injected.CLOCK_SAFETY === true
        ? "生产时钟安全 provider 已注入。"
        : "等待生产时钟安全 provider。",
    },
    {
      key: "LIVE_RUNTIME",
      status: input.executionCapability === "AVAILABLE" ? "READY" : "PENDING",
      reason: input.executionCapability === "AVAILABLE"
        ? "LiveRuntime 已由宿主显式注入。"
        : "LiveRuntime 尚未由宿主注入。",
    },
    {
      key: "USER_AUTHORIZATION",
      status: input.databaseAvailable && prerequisitePassed(input.gatePrerequisites, "USER_EXPLICIT_AUTHORIZATION")
        ? "READY"
        : "PENDING",
      reason: input.databaseAvailable && prerequisitePassed(input.gatePrerequisites, "USER_EXPLICIT_AUTHORIZATION")
        ? "Gate 已记录用户授权。"
        : "需要在所有生产前置条件通过后重新确认。",
    },
  ];
  const ready = checks.every((check) => check.status === "READY");
  return {
    path: "PRODUCTION_LIVE",
    status: ready ? "READY" : "PENDING_PREREQUISITES",
    checkedAt: now().toISOString(),
    config,
    checks,
    nextStep: ready
      ? "RUN_PRODUCTION_PREFLIGHT"
      : walletReady
        ? "INJECT_PRODUCTION_DEPENDENCIES"
        : "CONNECT_FORMAL_WALLET",
  };
}
