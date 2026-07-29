import type {
  LiveActivationConfirmation,
  LiveActivationInput,
  LiveGate,
  LiveGateResult,
} from "./live-gate-types.js";
import type { LiveExecutor } from "./live-executor.js";
import type { LiveIdentityBinding, LiveIdentityBindingResult } from "./live-identity-binding.js";
import { LiveRunner, type LiveRunnerOptions, type LiveRunnerReport } from "./live-runner.js";
import type { LiveSignalConsumer } from "./live-signal-consumer.js";

export interface LiveRuntimeRecovery {
  gate: LiveGateResult;
  execution: {
    passed: boolean;
    reason: string;
    recoveryRunId: string;
  };
  identity: LiveIdentityBindingResult;
  ready: boolean;
}

export interface LiveRuntimeRunResult {
  gateRecovery: LiveGateResult;
  identity: LiveIdentityBindingResult;
  report: LiveRunnerReport;
}

/**
 * Backend-only Live lifecycle composition.
 *
 * The runtime deliberately receives every adapter and safety boundary through
 * the already-constructed executor/gate. It never discovers credentials,
 * creates a signer, or changes PAPER into LIVE by itself. A restart therefore
 * performs recovery and revalidation first; signal consumption remains
 * disabled until the persisted Gate is independently armed.
 */
export class LiveRuntime {
  private readonly preparedRecoveries = new Map<string, LiveRuntimeRecovery>();

  constructor(
    private readonly gate: Pick<
      LiveGate,
      "recoverOnStartup" | "emergencyDisable" | "requestLiveActivation" | "confirmLiveActivation"
    >,
    private readonly executor: LiveExecutor,
    private readonly consumer: LiveSignalConsumer,
    private readonly identityBinding: LiveIdentityBinding,
  ) {}

  async recoverOnStartup(accountId: string): Promise<LiveRuntimeRecovery> {
    const gate = await this.gate.recoverOnStartup();
    const execution = await this.executor.recoverOnStartup(accountId);
    const identity = await this.checkIdentity(accountId);
    const recovery = {
      gate,
      execution,
      identity,
      ready: gate.allowed && execution.passed && identity.ready,
    };
    if (recovery.ready) this.preparedRecoveries.set(accountId, recovery);
    else this.preparedRecoveries.delete(accountId);
    return recovery;
  }

  async requestActivation(accountId: string, input: LiveActivationInput): Promise<LiveGateResult> {
    await this.requireIdentity(accountId);
    return this.gate.requestLiveActivation(input);
  }

  async confirmActivation(accountId: string, input: LiveActivationConfirmation): Promise<LiveGateResult> {
    await this.requireIdentity(accountId);
    return this.gate.confirmLiveActivation(input);
  }

  /**
   * Runs the polling loop after Gate startup recovery. This method does not
   * arm Live; LiveRunner will remain idle while the persisted Gate is disabled
   * or arming, and it still owns final valuation/reconciliation evidence.
   */
  async run(options: LiveRunnerOptions, signal?: AbortSignal): Promise<LiveRuntimeRunResult> {
    const gateRecovery = await this.gate.recoverOnStartup();
    const identity = await this.checkIdentity(options.accountId);
    const report = await new LiveRunner(this.executor, this.consumer, options).run(signal);
    return { gateRecovery, identity, report };
  }

  async runAfterRecovery(options: LiveRunnerOptions, signal?: AbortSignal): Promise<LiveRuntimeRunResult> {
    const recovery = this.preparedRecoveries.get(options.accountId);
    if (recovery === undefined) throw new Error("LIVE_RUNTIME_STARTUP_RECOVERY_REQUIRED");
    this.preparedRecoveries.delete(options.accountId);
    const identity = await this.checkIdentity(options.accountId);
    if (!identity.ready) throw new Error("LIVE_RUNTIME_IDENTITY_NOT_READY");
    const report = await new LiveRunner(this.executor, this.consumer, options).run(
      signal,
      recovery.execution,
    );
    return { gateRecovery: recovery.gate, identity, report };
  }

  async emergencyStop(accountId: string, reason: string, actor = "SYSTEM"): Promise<void> {
    await this.executor.emergencyStop(accountId, reason);
    await this.gate.emergencyDisable({ actor, reason });
  }

  close(): void {
    this.preparedRecoveries.clear();
    this.identityBinding.close();
    this.consumer.close();
    this.executor.close();
  }

  private async checkIdentity(accountId: string): Promise<LiveIdentityBindingResult> {
    const identity = await this.identityBinding.check(accountId);
    if (!identity.ready) {
      await this.gate.emergencyDisable({
        actor: "SYSTEM",
        reason: `LIVE_IDENTITY_BINDING_FAILED:${identity.checks.filter((check) => !check.passed).map((check) => check.reason).join(",")}`,
      });
    }
    return identity;
  }

  private async requireIdentity(accountId: string): Promise<void> {
    const identity = await this.checkIdentity(accountId);
    if (!identity.ready) {
      throw new Error(
        `LIVE_IDENTITY_BINDING_FAILED:${identity.checks.filter((check) => !check.passed).map((check) => check.reason).join(",")}`,
      );
    }
  }
}
