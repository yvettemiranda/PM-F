import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { stableJson } from "../domain/versioning.js";
import { assertOperatorMutationAllowed } from "./operator-mutation-guard.js";

const CONFIG_FILE = "data/operator/live-production.json";
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/i;
const INTEGER_RE = /^(?:0|[1-9][0-9]*)$/;

export type LiveProductionSignatureType =
  | "EOA"
  | "POLY_PROXY"
  | "POLY_GNOSIS_SAFE"
  | "POLY_1271";

export type LiveProductionCheckStatus = "READY" | "PENDING";
export type LiveProductionCheckKey = LiveProductionReadinessCheck["key"];
export type LiveProductionCapabilityOverrides = Partial<
  Record<Exclude<LiveProductionCheckKey, "USER_AUTHORIZATION" | "LIVE_RUNTIME" | "LIVE_LIMITS">, boolean>
>;

export interface LiveProductionConfig {
  schemaVersion: "live-production-config-v2";
  walletAddress: string | null;
  tradingWalletAddress: string | null;
  signatureType: LiveProductionSignatureType;
  network: "POLYGON" | "POLYGON_AMOY" | null;
  walletBinding: "BROWSER_EIP1193";
  liveBankrollMicros: string;
  maxTradeSizeMicros: string;
  maxExposureMicros: string;
  maxDailyLossMicros: string;
  limitsConfirmedAt: string | null;
  limitsConfirmationHash: string | null;
  complianceAcceptedAt: string | null;
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
    | "LIVE_LIMITS"
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
  gatePrerequisites: readonly { key: string; status: string; effectiveStatus?: string }[];
  executionCapability: "AVAILABLE" | "PENDING_PREREQUISITES" | "NOT_CONFIGURED";
  injectedChecks?: LiveProductionCapabilityOverrides;
  walletSession?: {
    walletAddress: string;
    network: "POLYGON" | "POLYGON_AMOY";
  };
}

export interface SaveLiveProductionConfigInput {
  walletAddress?: string | null;
  tradingWalletAddress?: string | null;
  signatureType?: LiveProductionSignatureType;
  network?: "POLYGON" | "POLYGON_AMOY" | null;
  liveBankrollMicros?: string;
  maxTradeSizeMicros?: string;
  maxExposureMicros?: string;
  maxDailyLossMicros?: string;
  confirmLimits?: boolean;
  acceptCompliance?: boolean;
}

function defaultConfig(): LiveProductionConfig {
  return {
    schemaVersion: "live-production-config-v2",
    walletAddress: null,
    tradingWalletAddress: null,
    signatureType: "EOA",
    network: null,
    walletBinding: "BROWSER_EIP1193",
    liveBankrollMicros: "10000000",
    maxTradeSizeMicros: "1000000",
    maxExposureMicros: "3000000",
    maxDailyLossMicros: "1000000",
    limitsConfirmedAt: null,
    limitsConfirmationHash: null,
    complianceAcceptedAt: null,
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
  const signatureType = [
    "EOA",
    "POLY_PROXY",
    "POLY_GNOSIS_SAFE",
    "POLY_1271",
  ].includes(String(record.signatureType))
    ? record.signatureType as LiveProductionSignatureType
    : "EOA";
  const tradingWalletAddress = typeof record.tradingWalletAddress === "string"
    && ADDRESS_RE.test(record.tradingWalletAddress)
    ? record.tradingWalletAddress.toLowerCase()
    : walletAddress;
  const defaults = defaultConfig();
  const limits = validateLimits({
    liveBankrollMicros: integerOrDefault(record.liveBankrollMicros, defaults.liveBankrollMicros),
    maxTradeSizeMicros: integerOrDefault(record.maxTradeSizeMicros, defaults.maxTradeSizeMicros),
    maxExposureMicros: integerOrDefault(record.maxExposureMicros, defaults.maxExposureMicros),
    maxDailyLossMicros: integerOrDefault(record.maxDailyLossMicros, defaults.maxDailyLossMicros),
  });
  const storedHash = typeof record.limitsConfirmationHash === "string"
    ? record.limitsConfirmationHash
    : null;
  const limitsConfirmationHash = storedHash === limitsHash(limits) ? storedHash : null;
  return {
    schemaVersion: "live-production-config-v2",
    walletAddress,
    tradingWalletAddress,
    signatureType,
    network,
    walletBinding: "BROWSER_EIP1193",
    ...limits,
    limitsConfirmedAt: limitsConfirmationHash !== null && typeof record.limitsConfirmedAt === "string"
      ? record.limitsConfirmedAt
      : null,
    limitsConfirmationHash,
    complianceAcceptedAt: typeof record.complianceAcceptedAt === "string"
      ? record.complianceAcceptedAt
      : null,
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : null,
  };
}

function integerOrDefault(value: unknown, fallback: string): string {
  return typeof value === "string" && INTEGER_RE.test(value) ? value : fallback;
}

function requiredMicros(value: string, code: string): bigint {
  if (!INTEGER_RE.test(value) || BigInt(value) <= 0n) throw new Error(code);
  return BigInt(value);
}

function validateLimits(
  limits: Pick<
    LiveProductionConfig,
    "liveBankrollMicros" | "maxTradeSizeMicros" | "maxExposureMicros" | "maxDailyLossMicros"
  >,
): Pick<
  LiveProductionConfig,
  "liveBankrollMicros" | "maxTradeSizeMicros" | "maxExposureMicros" | "maxDailyLossMicros"
> {
  const bankroll = requiredMicros(limits.liveBankrollMicros, "LIVE_BANKROLL_INVALID");
  const trade = requiredMicros(limits.maxTradeSizeMicros, "LIVE_MAX_TRADE_INVALID");
  const exposure = requiredMicros(limits.maxExposureMicros, "LIVE_MAX_EXPOSURE_INVALID");
  const dailyLoss = requiredMicros(limits.maxDailyLossMicros, "LIVE_MAX_DAILY_LOSS_INVALID");
  if (trade > exposure || exposure > bankroll || dailyLoss > bankroll) {
    throw new Error("LIVE_LIMIT_RELATIONSHIP_INVALID");
  }
  if (
    (
      bankroll > 100_000_000n
      || trade > 10_000_000n
      || exposure > 25_000_000n
      || dailyLoss > 10_000_000n
    )
  ) {
    throw new Error("LIVE_SMALL_LIMIT_HARD_CAP_EXCEEDED");
  }
  return {
    liveBankrollMicros: bankroll.toString(),
    maxTradeSizeMicros: trade.toString(),
    maxExposureMicros: exposure.toString(),
    maxDailyLossMicros: dailyLoss.toString(),
  };
}

function limitsHash(
  limits: Pick<
    LiveProductionConfig,
    "liveBankrollMicros" | "maxTradeSizeMicros" | "maxExposureMicros" | "maxDailyLossMicros"
  >,
): string {
  return createHash("sha256").update(stableJson({
    liveBankrollMicros: limits.liveBankrollMicros,
    maxTradeSizeMicros: limits.maxTradeSizeMicros,
    maxExposureMicros: limits.maxExposureMicros,
    maxDailyLossMicros: limits.maxDailyLossMicros,
  })).digest("hex");
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
  input: SaveLiveProductionConfigInput,
  now: () => Date = () => new Date(),
): LiveProductionConfig {
  assertOperatorMutationAllowed(projectRoot, "LIVE_PRODUCTION_CONFIGURATION");
  const previous = readLiveProductionConfig(projectRoot);
  const walletAddress = input.walletAddress === undefined
    ? previous.walletAddress
    : input.walletAddress === null
      ? null
      : input.walletAddress.toLowerCase();
  if (walletAddress !== null && !ADDRESS_RE.test(walletAddress)) {
    throw new Error("LIVE_PRODUCTION_WALLET_ADDRESS_INVALID");
  }
  const walletChanged = walletAddress !== previous.walletAddress;
  const signatureType = input.signatureType ?? (walletChanged ? "EOA" : previous.signatureType);
  const tradingWalletAddress = input.tradingWalletAddress === undefined
    ? walletChanged
      ? walletAddress
      : previous.tradingWalletAddress
    : input.tradingWalletAddress === null
      ? null
      : input.tradingWalletAddress.toLowerCase();
  if (tradingWalletAddress !== null && !ADDRESS_RE.test(tradingWalletAddress)) {
    throw new Error("LIVE_PRODUCTION_TRADING_WALLET_INVALID");
  }
  if (signatureType === "EOA" && walletAddress !== tradingWalletAddress) {
    throw new Error("LIVE_PRODUCTION_EOA_WALLET_MISMATCH");
  }
  const limits = validateLimits({
    liveBankrollMicros: input.liveBankrollMicros ?? previous.liveBankrollMicros,
    maxTradeSizeMicros: input.maxTradeSizeMicros ?? previous.maxTradeSizeMicros,
    maxExposureMicros: input.maxExposureMicros ?? previous.maxExposureMicros,
    maxDailyLossMicros: input.maxDailyLossMicros ?? previous.maxDailyLossMicros,
  });
  const hash = limitsHash(limits);
  const limitsChanged = hash !== previous.limitsConfirmationHash;
  const timestamp = now().toISOString();
  const identityChanged = walletChanged
    || tradingWalletAddress !== previous.tradingWalletAddress
    || signatureType !== previous.signatureType
    || input.network !== undefined && input.network !== previous.network;
  const config: LiveProductionConfig = {
    schemaVersion: "live-production-config-v2",
    walletAddress,
    tradingWalletAddress,
    signatureType,
    network: input.network === undefined ? previous.network : input.network,
    walletBinding: "BROWSER_EIP1193",
    ...limits,
    limitsConfirmedAt: input.confirmLimits === true
      ? timestamp
      : limitsChanged || identityChanged
        ? null
        : previous.limitsConfirmedAt,
    limitsConfirmationHash: input.confirmLimits === true
      ? hash
      : limitsChanged || identityChanged
        ? null
        : previous.limitsConfirmationHash,
    complianceAcceptedAt: input.acceptCompliance === true
      ? timestamp
      : input.acceptCompliance === false
        ? null
      : identityChanged
        ? null
        : previous.complianceAcceptedAt,
    updatedAt: timestamp,
  };
  const path = liveProductionConfigPath(projectRoot);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return config;
}

function prerequisitePassed(
  prerequisites: readonly { key: string; status: string; effectiveStatus?: string }[],
  key: string,
): boolean {
  return prerequisites.some((item) => (
    item.key === key
    && (item.effectiveStatus ?? item.status) === "PASSED"
  ));
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
  const limitsReady = config.limitsConfirmedAt !== null
    && config.limitsConfirmationHash === limitsHash(config);
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
      status: injected.COMPLIANCE === true && config.complianceAcceptedAt !== null ? "READY" : "PENDING",
      reason: injected.COMPLIANCE === true && config.complianceAcceptedAt !== null
        ? "已完成本次钱包合规确认，生产合规 provider 已注入。"
        : "需要确认合规声明并取得生产合规 provider 的新鲜证据。",
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
      key: "LIVE_LIMITS",
      status: limitsReady ? "READY" : "PENDING",
      reason: limitsReady
        ? "小额 Live 资金、单笔、总敞口和单日亏损上限已逐项确认。"
        : "需要保存并确认小额 Live 风险上限。",
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
