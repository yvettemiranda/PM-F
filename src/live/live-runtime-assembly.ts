import type { SourceVersion } from "../infra/source-version.js";
import { resolveSourceVersion } from "../infra/source-version.js";
import { LiveGateService, defaultLiveGateConfig } from "./live-gate-service.js";
import type { LiveGateConfig, LiveGateRuntimeEnvironment } from "./live-gate-types.js";
import { LiveExecutor } from "./live-executor.js";
import { LiveIdentityBinding } from "./live-identity-binding.js";
import { LiveRuntime } from "./live-runtime.js";
import { LiveSignalConsumer } from "./live-signal-consumer.js";
import type { BalanceProvider } from "./balance-provider.js";
import type { ClockSafetyProvider, ComplianceProvider, GeoblockProvider } from "./live-safety-provider.js";
import type { LiveMarketDataProvider } from "./live-market-data.js";
import type { OrderAdapter } from "./order-adapter.js";
import type { RedeemAdapter } from "./redeem-adapter.js";
import type { Signer } from "./signer.js";
import type { WalletProvider } from "./wallet-provider.js";

export interface LiveRuntimeAssemblyInput {
  databasePath: string;
  sourceVersion?: SourceVersion;
  now?: () => Date;
  environment: LiveGateRuntimeEnvironment;
  balanceProvider: BalanceProvider;
  gateConfig?: LiveGateConfig;
  geoblockProvider: GeoblockProvider;
  complianceProvider: ComplianceProvider;
  clockProvider: ClockSafetyProvider;
  orderAdapter: OrderAdapter;
  walletProvider: WalletProvider;
  signer: Signer;
  redeemAdapter: RedeemAdapter;
  marketDataProvider: LiveMarketDataProvider;
  requireExternalPositionReconciliation?: boolean;
  externalCallTimeoutMs?: number;
}

export interface LiveRuntimeAssembly {
  readonly gate: LiveGateService;
  readonly executor: LiveExecutor;
  readonly consumer: LiveSignalConsumer;
  readonly identityBinding: LiveIdentityBinding;
  readonly runtime: LiveRuntime;
  close(): void;
}

/**
 * Constructs the complete backend Live graph from explicitly injected
 * dependencies. No adapter is discovered implicitly and no credential is read
 * here; production callers must supply their own already-authorized signer and
 * read-only wallet/balance providers. In this repository's current safety
 * state, callers should use `environment: "TEST"` with fake components only.
 */
export function assembleLiveRuntime(input: LiveRuntimeAssemblyInput): LiveRuntimeAssembly {
  const sourceVersion = input.sourceVersion ?? resolveSourceVersion();
  const now = input.now ?? (() => new Date());
  const gateConfig = {
    ...defaultLiveGateConfig(),
    ...(input.gateConfig ?? {}),
    runtimeEnvironment: input.environment,
  };
  const liveRiskLimits = {
    maxTradeSizeMicros: gateConfig.maxTradeSizeMicros as string,
    maxExposureMicros: gateConfig.maxExposureMicros as string,
    maxDailyLossMicros: gateConfig.maxDailyLossMicros as string,
  };
  const gate = new LiveGateService(
    input.databasePath,
    input.balanceProvider,
    gateConfig,
    {
      sourceVersion,
      now,
      geoblockProvider: input.geoblockProvider,
      complianceProvider: input.complianceProvider,
      clockProvider: input.clockProvider,
    },
  );
  const executor = new LiveExecutor({
    databasePath: input.databasePath,
    liveGate: gate,
    orderAdapter: input.orderAdapter,
    walletProvider: input.walletProvider,
    signer: input.signer,
    redeemAdapter: input.redeemAdapter,
    marketDataProvider: input.marketDataProvider,
    sourceVersion,
    now,
    environment: input.environment,
    liveRiskLimits,
    ...(input.requireExternalPositionReconciliation === undefined
      ? {}
      : { requireExternalPositionReconciliation: input.requireExternalPositionReconciliation }),
    ...(input.externalCallTimeoutMs === undefined ? {} : { externalCallTimeoutMs: input.externalCallTimeoutMs }),
  });
  const consumer = new LiveSignalConsumer(
    input.databasePath,
    executor,
    sourceVersion,
    now,
    liveRiskLimits,
  );
  const identityBinding = new LiveIdentityBinding(
    input.databasePath,
    input.walletProvider,
    input.signer,
    input.environment,
    sourceVersion,
  );
  const runtime = new LiveRuntime(gate, executor, consumer, identityBinding);
  return {
    gate,
    executor,
    consumer,
    identityBinding,
    runtime,
    close(): void {
      runtime.close();
      gate.close();
    },
  };
}
