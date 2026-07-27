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
import { buildSafeChildEnvironment } from "./safe-child-environment.js";
import {
  OPERATOR_DATABASE_FILE,
  operatorRuntimeSafety,
} from "./operator-mutation-guard.js";
import { selectedTargetWallet } from "./target-wallet.js";

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
  execution: "AVAILABLE" | "NOT_CONFIGURED";
  orderManagement: "AVAILABLE" | "NOT_CONFIGURED";
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

export class UnconfiguredOperatorLiveRuntimeActions implements OperatorLiveRuntimeActions {
  readonly capability = {
    execution: "NOT_CONFIGURED",
    orderManagement: "NOT_CONFIGURED",
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
        reason: "No signer, authenticated CLOB adapter, or authorized Live runtime was injected.",
      },
    };
  }
}
