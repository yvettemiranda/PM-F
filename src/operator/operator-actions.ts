import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type {
  BalanceProviderInput,
  BalanceResult,
  LiveReadonlyBalanceProvider,
} from "../live/balance-provider.js";
import {
  LiveGateService,
  defaultLiveGateConfig,
} from "../live/live-gate-service.js";
import type { LiveGateResult } from "../live/live-gate-types.js";
import type { LiveRunnerOptions } from "../live/live-runner.js";
import { buildSafeChildEnvironment } from "./safe-child-environment.js";
import {
  OPERATOR_DATABASE_FILE,
  operatorRuntimeSafety,
} from "./operator-mutation-guard.js";
import { selectedTargetWallet } from "./target-wallet.js";
import type {
  LiveProductionCapabilityOverrides,
} from "./live-production-readiness.js";
import type {
  LiveWalletRuntimeBinding,
  LiveWalletSessionInvalidationReason,
} from "./live-wallet-session.js";

export interface OperatorRuntimeActionResult {
  accepted: boolean;
  operation: "PAPER_START" | "PAPER_STOP" | "PAPER_RECOVER";
  pid: number;
}

export interface OperatorRuntimeActions {
  startPaper(): Promise<OperatorRuntimeActionResult>;
  stopPaper(): Promise<OperatorRuntimeActionResult>;
  recoverPaper(): Promise<OperatorRuntimeActionResult>;
}

export interface OperatorLiveGateResult extends LiveGateResult {
  requestedExecutionMode: "LIVE";
  executionMode: string;
  liveGateState: string;
}

export interface OperatorLiveGateActions {
  preflight(): Promise<OperatorLiveGateResult>;
  requestActivation(input: { actor: string; reason: string }): Promise<OperatorLiveGateResult>;
  confirmActivation(input: {
    actor: string;
    confirmationText: string;
  }): Promise<OperatorLiveGateResult>;
  emergencyDisable(input: { actor: string; reason: string }): Promise<void>;
  recover(): Promise<OperatorLiveGateResult>;
}

export interface OperatorLiveRuntimeResult {
  accepted: boolean;
  code: string;
  details?: unknown;
}

export interface OperatorLiveRuntimeCapability {
  execution: "AVAILABLE" | "PENDING_PREREQUISITES" | "NOT_CONFIGURED";
  orderManagement: "AVAILABLE" | "PENDING_PREREQUISITES" | "NOT_CONFIGURED";
  walletSetup?: "AVAILABLE" | "PENDING_PREREQUISITES" | "NOT_CONFIGURED";
  production?: LiveProductionCapabilityOverrides;
}

export interface OperatorLiveRuntimeActions {
  readonly capability: OperatorLiveRuntimeCapability;
  start(input: { actor: string; reason: string }): Promise<OperatorLiveRuntimeResult>;
  stop(input: { actor: string; reason: string }): Promise<OperatorLiveRuntimeResult>;
  cancelOrder(input: {
    orderId: string;
    actor: string;
    reason: string;
  }): Promise<OperatorLiveRuntimeResult>;
  reconcile(input: { actor: string; reason: string }): Promise<OperatorLiveRuntimeResult>;
  recover(input: { actor: string; reason: string }): Promise<OperatorLiveRuntimeResult>;
  retryExecution(input: {
    executionId: string;
    actor: string;
    reason: string;
  }): Promise<OperatorLiveRuntimeResult>;
  prepareWallet?(input: {
    actor: string;
    reason: string;
  }): Promise<OperatorLiveRuntimeResult>;
}

/**
 * Backend seam for an already-assembled LiveRuntime. The production localhost
 * host constructs this graph only after a verified browser-wallet session;
 * tests and alternate hosts can inject the same contract explicitly.
 */
export interface OperatorLiveRuntimeBackend {
  recoverOnStartup(accountId: string): Promise<{ ready: boolean }>;
  run(options: LiveRunnerOptions, signal?: AbortSignal): Promise<unknown>;
  emergencyStop(accountId: string, reason: string, actor?: string): Promise<void>;
}

export interface OperatorLiveExecutionBackend {
  cancelOrder(orderId: string, reason: string): Promise<void>;
  retryExecution(executionId: string, reason: string): Promise<void>;
  reconcile(input: { accountId: string; reason: string }): Promise<{ reason: string }>;
}

export interface ConfiguredOperatorLiveRuntimeOptions {
  runtime: OperatorLiveRuntimeBackend;
  executor: OperatorLiveExecutionBackend;
  accountId: string;
  runOptions?: Omit<LiveRunnerOptions, "accountId">;
  production?: LiveProductionCapabilityOverrides;
  walletSessionBinding?: LiveWalletRuntimeBinding;
  walletSetup?: {
    prepare(): Promise<unknown>;
  };
  manageWalletInvalidation?: boolean;
}

class UnavailableLiveBalanceProvider implements LiveReadonlyBalanceProvider {
  readonly providerType = "LIVE_READONLY" as const;

  async getBalance(_input: BalanceProviderInput): Promise<BalanceResult> {
    return {
      status: "UNAVAILABLE",
      balanceMicros: null,
      reason: "LIVE_READONLY_BALANCE_PROVIDER_NOT_CONFIGURED",
      checkedAt: new Date().toISOString(),
      source: "OPERATOR_UI_FAIL_CLOSED",
    };
  }
}

function detachedEnvironment(): NodeJS.ProcessEnv {
  return {
    ...buildSafeChildEnvironment(),
    NI_K_OPERATOR_HEADLESS: "1",
  };
}

function spawnDetached(
  projectRoot: string,
  command: string,
  args: readonly string[],
): number {
  const child = spawn(command, [...args], {
    cwd: projectRoot,
    detached: true,
    stdio: "ignore",
    env: detachedEnvironment(),
  });
  child.unref();
  if (child.pid === undefined) throw new Error("OPERATOR_PROCESS_PID_UNAVAILABLE");
  return child.pid;
}

export class DefaultOperatorRuntimeActions implements OperatorRuntimeActions {
  constructor(private readonly projectRoot: string) {}

  async startPaper(): Promise<OperatorRuntimeActionResult> {
    const safety = operatorRuntimeSafety(this.projectRoot);
    if (safety.operatorLocked) throw new Error("PAPER_START_BLOCKED_BY_OPERATOR_LOCK");
    if (safety.databaseAvailable
      && (safety.executionMode !== "PAPER" || safety.liveGateState !== "LIVE_DISABLED")) {
      throw new Error("PAPER_START_BLOCKED:DATABASE_NOT_PAPER_LIVE_DISABLED");
    }
    const script = resolve(this.projectRoot, "操作入口/1_开始或继续Paper累计验证.command");
    if (!existsSync(script)) throw new Error("PAPER_START_SCRIPT_MISSING");
    return {
      accepted: true,
      operation: "PAPER_START",
      pid: spawnDetached(this.projectRoot, "/bin/zsh", [script]),
    };
  }

  async stopPaper(): Promise<OperatorRuntimeActionResult> {
    const script = resolve(this.projectRoot, "操作入口/2_安全暂停并生成报告.command");
    if (!existsSync(script)) throw new Error("PAPER_STOP_SCRIPT_MISSING");
    return {
      accepted: true,
      operation: "PAPER_STOP",
      pid: spawnDetached(this.projectRoot, "/bin/zsh", [script]),
    };
  }

  async recoverPaper(): Promise<OperatorRuntimeActionResult> {
    const safety = operatorRuntimeSafety(this.projectRoot);
    if (safety.operatorLocked) throw new Error("PAPER_RECOVERY_BLOCKED_BY_OPERATOR_LOCK");
    const script = resolve(this.projectRoot, "src/cli/paper-campaign-run.ts");
    if (!existsSync(script)) throw new Error("PAPER_RECOVERY_SCRIPT_MISSING");
    const target = selectedTargetWallet(this.projectRoot);
    return {
      accepted: true,
      operation: "PAPER_RECOVER",
      pid: spawnDetached(this.projectRoot, process.execPath, [
        "--import",
        "tsx",
        script,
        "--recover-only",
        `--target-wallet=${target.walletAddress}`,
      ]),
    };
  }
}

export class DefaultOperatorLiveGateActions implements OperatorLiveGateActions {
  constructor(private readonly projectRoot: string) {}

  async preflight(): Promise<OperatorLiveGateResult> {
    return this.withGate((gate) => gate.preflight({ requestedExecutionMode: "LIVE" }));
  }

  async requestActivation(input: {
    actor: string;
    reason: string;
  }): Promise<OperatorLiveGateResult> {
    return this.withGate((gate) => gate.requestLiveActivation(input));
  }

  async confirmActivation(input: {
    actor: string;
    confirmationText: string;
  }): Promise<OperatorLiveGateResult> {
    return this.withGate((gate) => gate.confirmLiveActivation(input));
  }

  async emergencyDisable(input: { actor: string; reason: string }): Promise<void> {
    const gate = this.service();
    try {
      await gate.emergencyDisable(input);
    } finally {
      gate.close();
    }
  }

  async recover(): Promise<OperatorLiveGateResult> {
    return this.withGate((gate) => gate.recoverOnStartup());
  }

  private service(): LiveGateService {
    const databasePath = resolve(this.projectRoot, OPERATOR_DATABASE_FILE);
    if (!existsSync(databasePath)) throw new Error("LIVE_GATE_DATABASE_NOT_INITIALIZED");
    return new LiveGateService(
      databasePath,
      new UnavailableLiveBalanceProvider(),
      defaultLiveGateConfig(),
    );
  }

  private async withGate(
    operation: (gate: LiveGateService) => Promise<LiveGateResult>,
  ): Promise<OperatorLiveGateResult> {
    const gate = this.service();
    try {
      const result = await operation(gate);
      const safety = operatorRuntimeSafety(this.projectRoot);
      return {
        ...result,
        requestedExecutionMode: "LIVE",
        executionMode: safety.executionMode ?? "PAPER",
        liveGateState: safety.liveGateState ?? "LIVE_DISABLED",
      };
    } finally {
      gate.close();
    }
  }
}

/**
 * Operator facade over the exact production gate owned by an assembled
 * connected Live runtime. Unlike the default facade, this does not construct a
 * second fail-closed gate with placeholder providers.
 */
export class ConfiguredOperatorLiveGateActions implements OperatorLiveGateActions {
  constructor(
    private readonly projectRoot: string,
    private readonly gate: LiveGateService,
    private readonly prerequisiteManager?: {
      refreshStaticEvidence(): void;
      authorizeActivation(input: { actor: string; reason: string }): Promise<void>;
    },
  ) {}

  async preflight(): Promise<OperatorLiveGateResult> {
    this.prerequisiteManager?.refreshStaticEvidence();
    return this.withState(this.gate.preflight({ requestedExecutionMode: "LIVE" }));
  }

  async requestActivation(input: {
    actor: string;
    reason: string;
  }): Promise<OperatorLiveGateResult> {
    await this.prerequisiteManager?.authorizeActivation(input);
    return this.withState(this.gate.requestLiveActivation(input));
  }

  async confirmActivation(input: {
    actor: string;
    confirmationText: string;
  }): Promise<OperatorLiveGateResult> {
    return this.withState(this.gate.confirmLiveActivation(input));
  }

  async emergencyDisable(input: { actor: string; reason: string }): Promise<void> {
    await this.gate.emergencyDisable(input);
  }

  async recover(): Promise<OperatorLiveGateResult> {
    return this.withState(this.gate.recoverOnStartup());
  }

  private async withState(resultPromise: Promise<LiveGateResult>): Promise<OperatorLiveGateResult> {
    const result = await resultPromise;
    const safety = operatorRuntimeSafety(this.projectRoot);
    return {
      ...result,
      requestedExecutionMode: "LIVE",
      executionMode: safety.executionMode ?? "PAPER",
      liveGateState: safety.liveGateState ?? "LIVE_DISABLED",
    };
  }
}

export class UnconfiguredOperatorLiveRuntimeActions implements OperatorLiveRuntimeActions {
  readonly capability = {
    execution: "PENDING_PREREQUISITES",
    orderManagement: "PENDING_PREREQUISITES",
  } as const;

  async start(_input: { actor: string; reason: string }): Promise<OperatorLiveRuntimeResult> {
    return this.unavailable("LIVE_RUNTIME_NOT_CONFIGURED");
  }

  async stop(_input: { actor: string; reason: string }): Promise<OperatorLiveRuntimeResult> {
    return this.unavailable("LIVE_RUNTIME_NOT_CONFIGURED");
  }

  async cancelOrder(_input: {
    orderId: string;
    actor: string;
    reason: string;
  }): Promise<OperatorLiveRuntimeResult> {
    return this.unavailable("AUTHENTICATED_CLOB_CANCEL_ADAPTER_NOT_CONFIGURED");
  }

  async reconcile(_input: {
    actor: string;
    reason: string;
  }): Promise<OperatorLiveRuntimeResult> {
    return this.unavailable("LIVE_RECONCILIATION_RUNTIME_NOT_CONFIGURED");
  }

  async recover(_input: {
    actor: string;
    reason: string;
  }): Promise<OperatorLiveRuntimeResult> {
    return this.unavailable("LIVE_RECOVERY_RUNTIME_NOT_CONFIGURED");
  }

  async retryExecution(_input: {
    executionId: string;
    actor: string;
    reason: string;
  }): Promise<OperatorLiveRuntimeResult> {
    return this.unavailable("LIVE_EXECUTOR_NOT_CONFIGURED");
  }

  private async unavailable(code: string): Promise<OperatorLiveRuntimeResult> {
    return {
      accepted: false,
      code,
      details: {
        safety: "PAPER + LIVE_DISABLED",
        reason: "Production Live path is prepared, but no wallet, signer, authenticated CLOB adapter, or authorized Live runtime was injected.",
      },
    };
  }
}

/**
 * Bridges UI operations to an assembled LiveRuntime and LiveExecutor. Starting
 * performs a synchronous recovery/readiness check before the background loop
 * is accepted; a later loop failure independently triggers emergency stop.
 */
export class ConfiguredOperatorLiveRuntimeActions implements OperatorLiveRuntimeActions {
  private readonly configuredCapability: OperatorLiveRuntimeCapability;

  private running = false;
  private abortController: AbortController | null = null;
  private lastRunError: string | null = null;
  private walletSessionInvalidated = false;

  constructor(private readonly options: ConfiguredOperatorLiveRuntimeOptions) {
    if (options.production !== undefined && options.walletSessionBinding === undefined) {
      throw new Error("PRODUCTION_LIVE_RUNTIME_REQUIRES_WALLET_SESSION_BINDING");
    }
    options.walletSessionBinding?.assertCurrent();
    if (options.manageWalletInvalidation !== false) {
      options.walletSessionBinding?.onInvalidated((reason) => this.invalidateWalletSession(reason));
    }
    this.configuredCapability = {
      execution: "AVAILABLE",
      orderManagement: "AVAILABLE",
      walletSetup: options.walletSetup === undefined ? "NOT_CONFIGURED" : "AVAILABLE",
      ...(options.production === undefined ? {} : { production: options.production }),
    };
  }

  get capability(): OperatorLiveRuntimeCapability {
    const sessionFailure = this.walletSessionFailure();
    if (sessionFailure === null) return this.configuredCapability;
    return {
      execution: "PENDING_PREREQUISITES",
      orderManagement: "PENDING_PREREQUISITES",
      ...(this.configuredCapability.production === undefined
        ? {}
        : {
          production: {
            ...this.configuredCapability.production,
            FORMAL_WALLET: false,
            SECURE_SIGNER: false,
          },
        }),
    };
  }

  async start(input: { actor: string; reason: string }): Promise<OperatorLiveRuntimeResult> {
    const sessionFailure = this.walletSessionFailure();
    if (sessionFailure !== null) return sessionFailure;
    if (this.running) {
      return {
        accepted: false,
        code: "LIVE_RUNTIME_ALREADY_RUNNING",
      };
    }
    let recovery: { ready: boolean };
    try {
      recovery = await this.options.runtime.recoverOnStartup(this.options.accountId);
    } catch (error) {
      return {
        accepted: false,
        code: "LIVE_RUNTIME_STARTUP_RECOVERY_FAILED",
        details: {
          accountId: this.options.accountId,
          reason: error instanceof Error ? error.message : String(error),
        },
      };
    }
    if (!recovery.ready) {
      return {
        accepted: false,
        code: "LIVE_RUNTIME_STARTUP_RECOVERY_BLOCKED",
        details: {
          accountId: this.options.accountId,
          recovery,
        },
      };
    }
    const controller = new AbortController();
    this.abortController = controller;
    this.running = true;
    this.lastRunError = null;
    void this.options.runtime.run(
      {
        ...(this.options.runOptions ?? {}),
        accountId: this.options.accountId,
      },
      controller.signal,
    ).catch(async (error: unknown) => {
      this.lastRunError = error instanceof Error ? error.message : String(error);
      try {
        await this.options.runtime.emergencyStop(
          this.options.accountId,
          `LIVE_RUNTIME_BACKGROUND_FAILED:${this.lastRunError}`,
          "SYSTEM",
        );
      } catch (stopError) {
        this.lastRunError = `LIVE_RUNTIME_BACKGROUND_FAILED:${this.lastRunError};EMERGENCY_STOP_FAILED:${
          stopError instanceof Error ? stopError.message : String(stopError)
        }`;
      }
    }).finally(() => {
      this.running = false;
      this.abortController = null;
    });
    return {
      accepted: true,
      code: "LIVE_RUNTIME_STARTED",
      details: {
        actor: input.actor,
        reason: input.reason,
        accountId: this.options.accountId,
      },
    };
  }

  async stop(input: { actor: string; reason: string }): Promise<OperatorLiveRuntimeResult> {
    this.abortController?.abort();
    try {
      await this.options.runtime.emergencyStop(this.options.accountId, input.reason, input.actor);
      this.running = false;
      return {
        accepted: true,
        code: "LIVE_RUNTIME_STOPPED",
        details: { accountId: this.options.accountId },
      };
    } catch (error) {
      return {
        accepted: false,
        code: "LIVE_RUNTIME_STOP_FAILED",
        details: {
          accountId: this.options.accountId,
          reason: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  async cancelOrder(input: {
    orderId: string;
    actor: string;
    reason: string;
  }): Promise<OperatorLiveRuntimeResult> {
    const sessionFailure = this.walletSessionFailure();
    if (sessionFailure !== null) return sessionFailure;
    try {
      await this.options.executor.cancelOrder(input.orderId, input.reason);
      return { accepted: true, code: "LIVE_ORDER_CANCEL_ACCEPTED" };
    } catch (error) {
      return {
        accepted: false,
        code: "LIVE_ORDER_CANCEL_FAILED",
        details: {
          actor: input.actor,
          reason: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  async reconcile(input: { actor: string; reason: string }): Promise<OperatorLiveRuntimeResult> {
    const sessionFailure = this.walletSessionFailure();
    if (sessionFailure !== null) return sessionFailure;
    try {
      const result = await this.options.executor.reconcile({
        accountId: this.options.accountId,
        reason: input.reason,
      });
      return {
        accepted: result.reason === "LIVE_RECONCILED",
        code: result.reason,
        details: { actor: input.actor, accountId: this.options.accountId },
      };
    } catch (error) {
      return {
        accepted: false,
        code: "LIVE_RECONCILIATION_FAILED",
        details: {
          actor: input.actor,
          reason: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  async recover(input: { actor: string; reason: string }): Promise<OperatorLiveRuntimeResult> {
    const sessionFailure = this.walletSessionFailure();
    if (sessionFailure !== null) return sessionFailure;
    try {
      const result = await this.options.runtime.recoverOnStartup(this.options.accountId);
      return {
        accepted: result.ready,
        code: result.ready ? "LIVE_RUNTIME_RECOVERED" : "LIVE_RUNTIME_RECOVERY_BLOCKED",
        details: {
          actor: input.actor,
          reason: input.reason,
          recovery: result,
        },
      };
    } catch (error) {
      return {
        accepted: false,
        code: "LIVE_RUNTIME_RECOVERY_FAILED",
        details: {
          actor: input.actor,
          reason: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  async retryExecution(input: {
    executionId: string;
    actor: string;
    reason: string;
  }): Promise<OperatorLiveRuntimeResult> {
    const sessionFailure = this.walletSessionFailure();
    if (sessionFailure !== null) return sessionFailure;
    try {
      await this.options.executor.retryExecution(input.executionId, input.reason);
      return { accepted: true, code: "LIVE_EXECUTION_RETRY_ACCEPTED" };
    } catch (error) {
      return {
        accepted: false,
        code: "LIVE_EXECUTION_RETRY_FAILED",
        details: {
          actor: input.actor,
          reason: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  async prepareWallet(input: {
    actor: string;
    reason: string;
  }): Promise<OperatorLiveRuntimeResult> {
    const sessionFailure = this.walletSessionFailure();
    if (sessionFailure !== null) return sessionFailure;
    if (this.options.walletSetup === undefined) {
      return { accepted: false, code: "LIVE_WALLET_SETUP_NOT_CONFIGURED" };
    }
    try {
      const result = await this.options.walletSetup.prepare();
      return {
        accepted: true,
        code: "LIVE_WALLET_SETUP_READY",
        details: { actor: input.actor, reason: input.reason, result },
      };
    } catch (error) {
      return {
        accepted: false,
        code: "LIVE_WALLET_SETUP_FAILED",
        details: {
          actor: input.actor,
          reason: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  get lastError(): string | null {
    return this.lastRunError;
  }

  private walletSessionFailure(): OperatorLiveRuntimeResult | null {
    if (this.walletSessionInvalidated) {
      return {
        accepted: false,
        code: "LIVE_WALLET_SESSION_INVALIDATED",
      };
    }
    try {
      this.options.walletSessionBinding?.assertCurrent();
      return null;
    } catch (error) {
      this.invalidateWalletSession("EXPIRED");
      return {
        accepted: false,
        code: "LIVE_WALLET_SESSION_INVALIDATED",
        details: {
          reason: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  private async invalidateWalletSession(reason: LiveWalletSessionInvalidationReason): Promise<void> {
    if (this.walletSessionInvalidated) return;
    this.walletSessionInvalidated = true;
    this.abortController?.abort();
    this.abortController = null;
    this.running = false;
    this.lastRunError = `LIVE_WALLET_SESSION_${reason}`;
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await this.options.runtime.emergencyStop(
          this.options.accountId,
          `LIVE_WALLET_SESSION_${reason}`,
          "WALLET_SESSION_GUARD",
        );
        return;
      } catch (error: unknown) {
        lastError = error;
      }
    }
    this.lastRunError = `LIVE_WALLET_SESSION_EMERGENCY_STOP_FAILED:${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`;
    throw lastError instanceof Error ? lastError : new Error(this.lastRunError);
  }
}
