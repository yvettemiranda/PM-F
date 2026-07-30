import { DatabaseSync } from "node:sqlite";
import { RULESET, VERSIONS } from "../domain/versioning.js";
import { registeredStopLossRules } from "../domain/ruleset-registry.js";
import { resolveSourceVersion, type SourceVersion } from "../infra/source-version.js";
import type { BalanceProvider, BalanceResult } from "./balance-provider.js";
import { LiveGateReconciliation } from "./live-gate-reconciliation.js";
import {
  DisabledClockSafetyProvider,
  DisabledComplianceProvider,
  DisabledGeoblockProvider,
  FakeComplianceProvider,
  type ClockSafetyProvider,
  type ClockSafetyResult,
  type ComplianceProvider,
  type ComplianceResult,
  type GeoblockProvider,
  type GeoblockResult,
} from "./live-safety-provider.js";
import { LiveGateStore } from "./live-gate-store.js";
import type {
  EmergencyDisableInput,
  LiveAccountActionGateInput,
  LiveActivationConfirmation,
  LiveActivationInput,
  LiveExecutionGateInput,
  LiveGate,
  LiveGateCheck,
  LiveGateConfig,
  LiveGatePreflightInput,
  LiveGateResult,
  LiveGateRunType,
  LiveGateRuntimeEnvironment,
  LiveWalletMetadata,
  RequestedExecutionMode,
} from "./live-gate-types.js";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
export const LIVE_ACTIVATION_CONFIRMATION_TEXT = "ENABLE LIVE TRADING";
const REQUIRED_PREREQUISITES = [
  "PHASE_1B_PAPER_VALIDATION",
  "OBSERVE_ONLY_8H_SOAK",
  "PAPER_STABILITY",
  "CRASH_RECOVERY_LONG_RUN",
  "LONG_STATE_CONSISTENCY",
  "SOURCE_COMMIT_RECORDED",
  "WORKTREE_STATUS_KNOWN",
  "GEOBLOCK_COMPLIANCE",
  "USER_EXPLICIT_AUTHORIZATION",
] as const;

interface LiveGateServiceOptions {
  sourceVersion?: SourceVersion;
  now?: () => Date;
  geoblockProvider?: GeoblockProvider;
  complianceProvider?: ComplianceProvider;
  clockProvider?: ClockSafetyProvider;
}

interface FullGateEvaluation {
  checks: LiveGateCheck[];
  wallet: LiveWalletMetadata | null;
  balance: BalanceResult;
}

interface PrerequisiteEvidence {
  evidenceType?: unknown;
  checkedAt?: unknown;
  sourceCodeCommit?: unknown;
  environment?: unknown;
  testOnly?: unknown;
  [key: string]: unknown;
}

interface SignalRow {
  signal_id: string;
  status: string;
  execution_eligible: number;
  ruleset_hash: string;
  signal_type: string;
  asset_id: string;
  condition_id: string;
  target_price_units: string;
  target_size_micros: string;
  context_id: string | null;
  context_market_end_time: string | null;
  context_market_end_time_status: "VERIFIED" | "UNAVAILABLE" | null;
}

interface RiskDecisionRow {
  risk_decision_id: string;
  signal_id: string | null;
  executor_mode: string;
  account_id: string | null;
  context_id: string | null;
  decision: "ALLOW" | "REJECT";
  requested_amount_micros: string | null;
  requested_size_micros: string | null;
  ruleset_hash: string;
  risk_reason: string | null;
}

interface StopLossPositionRow {
  live_position_id: string;
  live_account_id: string;
  signal_id: string | null;
  asset_id: string;
  condition_id: string;
  entry_price_units: string;
  current_size_micros: string;
  status: string;
  ruleset_hash: string;
}

export class LiveGateService implements LiveGate {
  readonly gateType = "PRODUCTION" as const;
  readonly runtimeEnvironment: LiveGateRuntimeEnvironment;
  private readonly database: DatabaseSync;
  private readonly store: LiveGateStore;
  private readonly sourceVersion: SourceVersion;
  private readonly now: () => Date;
  private readonly geoblockProvider: GeoblockProvider;
  private readonly complianceProvider: ComplianceProvider;
  private readonly clockProvider: ClockSafetyProvider;

  constructor(
    databasePath: string,
    private readonly balanceProvider: BalanceProvider,
    private readonly config: LiveGateConfig,
    options: LiveGateServiceOptions = {},
  ) {
    this.database = new DatabaseSync(databasePath);
    this.database.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;");
    this.sourceVersion = options.sourceVersion ?? resolveSourceVersion();
    this.now = options.now ?? (() => new Date());
    this.runtimeEnvironment = this.config.runtimeEnvironment ?? "PRODUCTION";
    this.geoblockProvider = options.geoblockProvider ?? new DisabledGeoblockProvider();
    this.complianceProvider = options.complianceProvider
      ?? (this.runtimeEnvironment === "TEST"
        ? new FakeComplianceProvider({
          status: "ALLOWED",
          checkedAt: this.now().toISOString(),
          source: "TEST_DEFAULT_COMPLIANCE",
          policyVersion: "TEST_POLICY",
          reason: null,
        })
        : new DisabledComplianceProvider());
    this.clockProvider = options.clockProvider ?? new DisabledClockSafetyProvider();
    this.store = new LiveGateStore(this.database, this.sourceVersion, this.now);
    this.store.ensureDefaultState();
  }

  async preflight(input: LiveGatePreflightInput): Promise<LiveGateResult> {
    return this.evaluateGate("PREFLIGHT", input.requestedExecutionMode, null);
  }

  async requestLiveActivation(input: LiveActivationInput): Promise<LiveGateResult> {
    const stateGuard = this.store.stateGuard();
    const now = this.now().toISOString();
    this.store.audit({
      entityType: "LIVE_GATE",
      entityId: "default",
      action: "live_enable_attempt",
      reason: input.reason,
      metadata: { actor: input.actor },
      now,
    });
    const result = await this.preflight({ requestedExecutionMode: "LIVE" });
    if (!result.allowed) {
      this.store.setStateIfUnchanged({
        executionMode: "PAPER",
        liveGateState: "LIVE_DISABLED",
        requestedExecutionMode: null,
        lastPreflightId: result.runId,
        reason: "PREFLIGHT_FAILED",
        actor: input.actor,
        metadata: { blockedReasons: result.blockedReasons },
        now,
      }, stateGuard);
      this.store.audit({
        entityType: "LIVE_GATE",
        entityId: result.runId,
        action: "live_enable_failed",
        reason: "PREFLIGHT_FAILED",
        metadata: { blockedReasons: result.blockedReasons },
        now,
      });
      return result;
    }
    const stateChanged = !this.store.setStateIfUnchanged({
      executionMode: "PAPER",
      liveGateState: "LIVE_ARMING",
      requestedExecutionMode: "LIVE",
      lastPreflightId: result.runId,
      reason: "PREFLIGHT_PASSED_AWAITING_CONFIRMATION",
      actor: input.actor,
      metadata: { reason: input.reason },
      now,
    }, stateGuard);
    if (stateChanged) {
      return this.activationRaceFailure(
        result,
        "ACTIVATION_STATE_CHANGED_DURING_PREFLIGHT",
        input.actor,
        now,
      );
    }
    return result;
  }

  async confirmLiveActivation(input: LiveActivationConfirmation): Promise<LiveGateResult> {
    const now = this.now().toISOString();
    const stateGuard = this.store.stateGuard();
    const state = stateGuard.state;
    const fullEvaluation = await this.fullGateEvaluation("LIVE", now);
    const armingPreflight = state.last_preflight_id ? this.store.run(state.last_preflight_id) : null;
    const latestAllowedPreflight = this.store.latestAllowedPreflight();
    const preflightAgeMs = armingPreflight ? this.evidenceAgeMs(armingPreflight.created_at, now) : null;
    const maxAgeMs = this.config.preflightMaxAgeMs ?? 5 * 60_000;
    const checks: LiveGateCheck[] = [
      {
        name: "confirm_state",
        passed: state.execution_mode === "PAPER"
          && state.live_gate_state === "LIVE_ARMING"
          && state.requested_execution_mode === "LIVE",
        reason: state.execution_mode === "PAPER"
          && state.live_gate_state === "LIVE_ARMING"
          && state.requested_execution_mode === "LIVE"
          ? "OK"
          : `NOT_ARMING:${state.live_gate_state}`,
      },
      {
        name: "confirm_text",
        passed: input.confirmationText === LIVE_ACTIVATION_CONFIRMATION_TEXT,
        reason: input.confirmationText === LIVE_ACTIVATION_CONFIRMATION_TEXT ? "OK" : "CONFIRMATION_TEXT_MISMATCH",
      },
      {
        name: "confirm_actor",
        passed: input.actor.trim().length > 0,
        reason: input.actor.trim().length > 0 ? "OK" : "CONFIRMATION_ACTOR_REQUIRED",
      },
      {
        name: "arming_preflight",
        passed: armingPreflight?.run_type === "PREFLIGHT" && armingPreflight.allowed === 1,
        reason: armingPreflight?.run_type === "PREFLIGHT" && armingPreflight.allowed === 1 ? "OK" : "ARMING_PREFLIGHT_NOT_ALLOWED",
      },
      {
        name: "arming_preflight_binding",
        passed: armingPreflight !== null
          && latestAllowedPreflight?.live_gate_run_id === armingPreflight.live_gate_run_id,
        reason: armingPreflight !== null
          && latestAllowedPreflight?.live_gate_run_id === armingPreflight.live_gate_run_id
          ? "OK"
          : "ARMING_PREFLIGHT_SUPERSEDED",
      },
      {
        name: "arming_preflight_freshness",
        passed: preflightAgeMs !== null && preflightAgeMs >= 0 && preflightAgeMs <= maxAgeMs,
        reason: preflightAgeMs !== null && preflightAgeMs >= 0 && preflightAgeMs <= maxAgeMs ? "OK" : "ARMING_PREFLIGHT_STALE",
      },
      {
        name: "arming_preflight_source",
        passed: armingPreflight?.source_code_commit === this.sourceVersion.commit
          && (this.runtimeEnvironment === "TEST" || armingPreflight?.source_code_dirty === 0),
        reason: armingPreflight?.source_code_commit === this.sourceVersion.commit
          && (this.runtimeEnvironment === "TEST" || armingPreflight?.source_code_dirty === 0)
          ? "OK"
          : "ARMING_PREFLIGHT_SOURCE_MISMATCH",
      },
      ...fullEvaluation.checks,
    ];
    const result = this.persistResult(
      "PREFLIGHT",
      "LIVE",
      checks,
      null,
      null,
      null,
      now,
      fullEvaluation.wallet,
      fullEvaluation.balance,
    );
    if (!result.allowed) {
      this.store.audit({
        entityType: "LIVE_GATE",
        entityId: result.runId,
        action: "live_enable_failed",
        reason: "CONFIRMATION_FAILED",
        metadata: { blockedReasons: result.blockedReasons, actor: input.actor },
        now,
      });
      return result;
    }
    const stateChanged = !this.store.setStateIfUnchanged({
      executionMode: "LIVE",
      liveGateState: "LIVE_ACTIVE",
      requestedExecutionMode: "LIVE",
      lastPreflightId: result.runId,
      reason: "USER_CONFIRMED_LIVE_ACTIVE",
      actor: input.actor,
      metadata: { confirmationMatched: true, armingPreflightId: armingPreflight?.live_gate_run_id ?? null },
      now,
    }, stateGuard);
    if (stateChanged) {
      return this.activationRaceFailure(
        result,
        "CONFIRMATION_STATE_CHANGED_DURING_PREFLIGHT",
        input.actor,
        now,
      );
    }
    this.store.audit({
      entityType: "LIVE_GATE",
      entityId: result.runId,
      action: "live_enable_success",
      reason: "USER_CONFIRMED_LIVE_ACTIVE",
      metadata: { actor: input.actor },
      now,
    });
    return result;
  }

  private activationRaceFailure(
    original: LiveGateResult,
    reason: string,
    actor: string,
    now: string,
  ): LiveGateResult {
    const checks: LiveGateCheck[] = [
      ...original.checks,
      { name: "activation_state_unchanged", passed: false, reason },
    ];
    const current = this.store.state();
    const result = this.persistResult(
      "PREFLIGHT",
      "LIVE",
      checks,
      null,
      null,
      null,
      now,
    );
    this.store.audit({
      entityType: "LIVE_GATE",
      entityId: result.runId,
      action: "live_enable_failed",
      reason,
      metadata: {
        actor,
        originalRunId: original.runId,
        executionMode: current.execution_mode,
        liveGateState: current.live_gate_state,
      },
      now,
    });
    return result;
  }

  async checkExecution(input: LiveExecutionGateInput): Promise<LiveGateResult> {
    const now = this.now().toISOString();
    const signal = this.signal(input.signalId);
    const riskDecision = this.riskDecision(input.riskDecisionId);
    const isStopLoss = input.executionType === "STOP_LOSS";
    const stopLossPosition = isStopLoss && input.positionId
      ? this.stopLossPosition(input.positionId)
      : null;
    const stopLossRules = stopLossPosition
      ? registeredStopLossRules(this.database, stopLossPosition.ruleset_hash)
      : null;
    const stopLossSize = input.targetSizeMicros && /^\d+$/.test(input.targetSizeMicros)
      ? BigInt(input.targetSizeMicros)
      : null;
    const stopLossTriggerPrice = stopLossPosition
      && stopLossRules
      && /^\d+$/.test(stopLossPosition.entry_price_units)
      ? ((BigInt(stopLossPosition.entry_price_units) * BigInt(stopLossRules.triggerRatioPpm)) / 1_000_000n).toString()
      : null;
    const fullEvaluation = await this.fullGateEvaluation("LIVE", now);
    const state = this.store.state();
    const checks: LiveGateCheck[] = [
      {
        name: "live_gate_active",
        passed: state.execution_mode === "LIVE" && state.live_gate_state === "LIVE_ACTIVE",
        reason: state.execution_mode === "LIVE" && state.live_gate_state === "LIVE_ACTIVE"
          ? "OK"
          : `NOT_LIVE_ACTIVE:${state.execution_mode}:${state.live_gate_state}`,
      },
      {
        name: "signal_exists",
        passed: signal !== null,
        reason: signal ? "OK" : "SIGNAL_NOT_FOUND",
      },
      {
        name: "signal_status",
        passed: signal?.status === "PUBLISHED",
        reason: signal?.status === "PUBLISHED" ? "OK" : `SIGNAL_NOT_PUBLISHED:${signal?.status ?? "NONE"}`,
      },
      {
        name: "signal_execution_eligible",
        passed: signal?.execution_eligible === 1,
        reason: signal?.execution_eligible === 1 ? "OK" : "SIGNAL_NOT_EXECUTION_ELIGIBLE",
      },
      {
        name: "signal_side_match",
        passed: isStopLoss
          ? signal?.signal_id === stopLossPosition?.signal_id && input.side === "SELL"
          : signal?.signal_type === (input.side === "BUY" ? "TARGET_BUY" : input.side === "SELL" ? "TARGET_SELL" : null),
        reason: (isStopLoss
          ? signal?.signal_id === stopLossPosition?.signal_id && input.side === "SELL"
          : signal?.signal_type === (input.side === "BUY" ? "TARGET_BUY" : input.side === "SELL" ? "TARGET_SELL" : null))
          ? "OK"
          : "SIGNAL_SIDE_MISMATCH",
      },
      {
        name: "signal_asset_match",
        passed: signal?.asset_id === input.assetId,
        reason: signal?.asset_id === input.assetId ? "OK" : "SIGNAL_ASSET_MISMATCH",
      },
      {
        name: "signal_condition_match",
        passed: signal?.condition_id === input.conditionId,
        reason: signal?.condition_id === input.conditionId ? "OK" : "SIGNAL_CONDITION_MISMATCH",
      },
      {
        name: "signal_price_match",
        passed: isStopLoss
          ? stopLossTriggerPrice !== null && input.targetPriceUnits === stopLossTriggerPrice
          : signal?.target_price_units === input.targetPriceUnits,
        reason: (isStopLoss
          ? stopLossTriggerPrice !== null && input.targetPriceUnits === stopLossTriggerPrice
          : signal?.target_price_units === input.targetPriceUnits) ? "OK" : "SIGNAL_PRICE_MISMATCH",
      },
      {
        name: "signal_size_match",
        passed: isStopLoss
          ? stopLossPosition !== null
            && input.targetSizeMicros === riskDecision?.requested_size_micros
            && stopLossSize !== null
            && stopLossSize > 0n
            && /^\d+$/.test(stopLossPosition.current_size_micros)
            && stopLossSize <= BigInt(stopLossPosition.current_size_micros)
          : signal?.target_size_micros === input.targetSizeMicros,
        reason: (isStopLoss
          ? stopLossPosition !== null
            && input.targetSizeMicros === riskDecision?.requested_size_micros
            && stopLossSize !== null
            && stopLossSize > 0n
            && /^\d+$/.test(stopLossPosition.current_size_micros)
            && stopLossSize <= BigInt(stopLossPosition.current_size_micros)
          : signal?.target_size_micros === input.targetSizeMicros) ? "OK" : "SIGNAL_SIZE_MISMATCH",
      },
      {
        name: "signal_context_match",
        passed: signal?.context_id === input.contextId,
        reason: signal?.context_id === input.contextId ? "OK" : "SIGNAL_CONTEXT_MISMATCH",
      },
      {
        name: "risk_decision_exists",
        passed: riskDecision !== null,
        reason: riskDecision ? "OK" : "RISK_DECISION_NOT_FOUND",
      },
      {
        name: "risk_decision_allow",
        passed: riskDecision?.decision === "ALLOW",
        reason: riskDecision?.decision === "ALLOW" ? "OK" : `RISK_DECISION_NOT_ALLOW:${riskDecision?.decision ?? "NONE"}`,
      },
      {
        name: "risk_signal_match",
        passed: riskDecision?.signal_id === input.signalId,
        reason: riskDecision?.signal_id === input.signalId ? "OK" : "RISK_SIGNAL_MISMATCH",
      },
      {
        name: "risk_executor_mode",
        passed: riskDecision?.executor_mode === "LIVE",
        reason: riskDecision?.executor_mode === "LIVE" ? "OK" : "RISK_EXECUTOR_MODE_MISMATCH",
      },
      {
        name: "risk_account_match",
        passed: riskDecision?.account_id === input.accountId,
        reason: riskDecision?.account_id === input.accountId ? "OK" : "RISK_ACCOUNT_MISMATCH",
      },
      this.liveAccountCheck(riskDecision?.account_id ?? null, fullEvaluation.wallet),
      {
        name: "risk_context_match",
        passed: riskDecision?.context_id === input.contextId,
        reason: riskDecision?.context_id === input.contextId ? "OK" : "RISK_CONTEXT_MISMATCH",
      },
      this.approvedExecutionCheck(riskDecision, input.side),
      this.approvedExecutionLimitCheck(riskDecision, input.side, fullEvaluation.balance),
      {
        name: "stop_loss_scope",
        passed: !isStopLoss || (stopLossPosition !== null
          && stopLossRules !== null
          && stopLossPosition.live_account_id === input.accountId
          && stopLossPosition.asset_id === input.assetId
          && stopLossPosition.condition_id === input.conditionId
          && ["OPEN", "PARTIALLY_CLOSED"].includes(stopLossPosition.status)
          && stopLossPosition.ruleset_hash === input.rulesetHash
          && riskDecision?.risk_reason === "STOP_LOSS_TRIGGERED"),
        reason: !isStopLoss || (stopLossPosition !== null
          && stopLossRules !== null
          && stopLossPosition.live_account_id === input.accountId
          && stopLossPosition.asset_id === input.assetId
          && stopLossPosition.condition_id === input.conditionId
          && ["OPEN", "PARTIALLY_CLOSED"].includes(stopLossPosition.status)
          && stopLossPosition.ruleset_hash === input.rulesetHash
          && riskDecision?.risk_reason === "STOP_LOSS_TRIGGERED") ? "OK" : "STOP_LOSS_SCOPE_MISMATCH",
      },
      {
        name: "ruleset_exists",
        passed: this.rulesetExists(input.rulesetHash),
        reason: this.rulesetExists(input.rulesetHash) ? "OK" : "RULESET_NOT_REGISTERED",
      },
      {
        name: "ruleset_match",
        passed: riskDecision?.ruleset_hash === input.rulesetHash && signal?.ruleset_hash === input.rulesetHash,
        reason: riskDecision?.ruleset_hash === input.rulesetHash && signal?.ruleset_hash === input.rulesetHash ? "OK" : "RULESET_MISMATCH",
      },
      this.exposureCheck(riskDecision, input.side),
      this.dailyLossCheck(riskDecision?.account_id ?? null, input.side),
      this.marketStatusCheck(signal),
      ...fullEvaluation.checks,
    ];
    const result = this.persistResult(
      "EXECUTION_CHECK",
      null,
      checks,
      input.signalId,
      input.riskDecisionId,
      input.rulesetHash,
      now,
      fullEvaluation.wallet,
      fullEvaluation.balance,
    );
    if (!result.allowed) {
      this.store.audit({
        entityType: "LIVE_GATE",
        entityId: result.runId,
        action: "execution_blocked",
        reason: "LIVE_EXECUTION_GATE_BLOCKED",
        metadata: { input, blockedReasons: result.blockedReasons },
        now,
        rulesetHash: input.rulesetHash,
      });
    }
    return result;
  }

  async checkAccountAction(input: LiveAccountActionGateInput): Promise<LiveGateResult> {
    const now = this.now().toISOString();
    const riskDecision = this.riskDecision(input.riskDecisionId);
    const fullEvaluation = await this.fullGateEvaluation("LIVE", now);
    const state = this.store.state();
    const checks: LiveGateCheck[] = [
      {
        name: "live_gate_active",
        passed: state.execution_mode === "LIVE" && state.live_gate_state === "LIVE_ACTIVE",
        reason: state.execution_mode === "LIVE" && state.live_gate_state === "LIVE_ACTIVE"
          ? "OK"
          : `NOT_LIVE_ACTIVE:${state.execution_mode}:${state.live_gate_state}`,
      },
      {
        name: "account_action",
        passed: input.action === "REDEEM",
        reason: input.action === "REDEEM" ? "OK" : "LIVE_ACCOUNT_ACTION_UNSUPPORTED",
      },
      {
        name: "risk_decision_exists",
        passed: riskDecision !== null,
        reason: riskDecision ? "OK" : "RISK_DECISION_NOT_FOUND",
      },
      {
        name: "risk_decision_allow",
        passed: riskDecision?.decision === "ALLOW",
        reason: riskDecision?.decision === "ALLOW" ? "OK" : `RISK_DECISION_NOT_ALLOW:${riskDecision?.decision ?? "NONE"}`,
      },
      {
        name: "risk_executor_mode",
        passed: riskDecision?.executor_mode === "LIVE",
        reason: riskDecision?.executor_mode === "LIVE" ? "OK" : "RISK_EXECUTOR_MODE_MISMATCH",
      },
      {
        name: "risk_account_match",
        passed: riskDecision?.account_id === input.accountId,
        reason: riskDecision?.account_id === input.accountId ? "OK" : "RISK_ACCOUNT_MISMATCH",
      },
      this.liveAccountCheck(riskDecision?.account_id ?? null, fullEvaluation.wallet),
      {
        name: "risk_action_scope",
        passed: riskDecision?.signal_id === null
          && riskDecision.context_id === null
          && riskDecision.risk_reason === "REDEEM_CONFIRMED",
        reason: riskDecision?.signal_id === null
          && riskDecision.context_id === null
          && riskDecision.risk_reason === "REDEEM_CONFIRMED"
          ? "OK"
          : "REDEEM_RISK_SCOPE_MISMATCH",
      },
      {
        name: "risk_action_amount",
        passed: riskDecision?.requested_amount_micros === input.requestedAmountMicros
          && riskDecision.requested_size_micros === input.requestedSizeMicros,
        reason: riskDecision?.requested_amount_micros === input.requestedAmountMicros
          && riskDecision.requested_size_micros === input.requestedSizeMicros
          ? "OK"
          : "REDEEM_RISK_ECONOMICS_MISMATCH",
      },
      {
        name: "ruleset_exists",
        passed: this.rulesetExists(input.rulesetHash),
        reason: this.rulesetExists(input.rulesetHash) ? "OK" : "RULESET_NOT_REGISTERED",
      },
      {
        name: "ruleset_match",
        passed: riskDecision?.ruleset_hash === input.rulesetHash,
        reason: riskDecision?.ruleset_hash === input.rulesetHash ? "OK" : "RULESET_MISMATCH",
      },
      ...fullEvaluation.checks,
    ];
    const result = this.persistResult(
      "EXECUTION_CHECK",
      null,
      checks,
      null,
      input.riskDecisionId,
      input.rulesetHash,
      now,
      fullEvaluation.wallet,
      fullEvaluation.balance,
    );
    if (!result.allowed) {
      this.store.audit({
        entityType: "LIVE_GATE",
        entityId: result.runId,
        action: "account_action_blocked",
        reason: "LIVE_ACCOUNT_ACTION_GATE_BLOCKED",
        metadata: { input, blockedReasons: result.blockedReasons },
        now,
        rulesetHash: input.rulesetHash,
      });
    }
    return result;
  }

  async recoverOnStartup(): Promise<LiveGateResult> {
    const now = this.now().toISOString();
    const state = this.store.state();
    if (state.live_gate_state === "LIVE_ACTIVE") {
      this.store.setState({
        executionMode: "PAPER",
        liveGateState: "LIVE_ARMING",
        requestedExecutionMode: "LIVE",
        lastPreflightId: state.last_preflight_id,
        reason: "RESTART_REQUIRES_REVALIDATION",
        actor: "SYSTEM",
        metadata: { previousExecutionMode: state.execution_mode, previousLiveGateState: state.live_gate_state },
        now,
      });
    }
    return this.evaluateGate("STARTUP_RECOVERY", "LIVE", null);
  }

  async emergencyDisable(input: EmergencyDisableInput): Promise<void> {
    const now = this.now().toISOString();
    this.store.setState({
      executionMode: "PAPER",
      liveGateState: "LIVE_DISABLED",
      requestedExecutionMode: null,
      lastPreflightId: null,
      reason: input.reason,
      actor: input.actor,
      metadata: { emergency: true },
      now,
    });
    this.store.audit({
      entityType: "LIVE_GATE",
      entityId: "default",
      action: "emergency_disable",
      reason: input.reason,
      metadata: { actor: input.actor },
      now,
    });
  }

  close(): void {
    this.database.close();
  }

  private async evaluateGate(
    runType: LiveGateRunType,
    requestedExecutionMode: RequestedExecutionMode,
    walletOverride: LiveWalletMetadata | null,
  ): Promise<LiveGateResult> {
    const now = this.now().toISOString();
    const evaluation = await this.fullGateEvaluation(requestedExecutionMode, now, walletOverride);
    return this.persistResult(
      runType,
      requestedExecutionMode,
      evaluation.checks,
      null,
      null,
      null,
      now,
      evaluation.wallet,
      evaluation.balance,
    );
  }

  private async fullGateEvaluation(
    requestedExecutionMode: RequestedExecutionMode,
    now: string,
    walletOverride: LiveWalletMetadata | null = null,
  ): Promise<FullGateEvaluation> {
    const wallet = walletOverride ?? this.store.activeWallet();
    const balance = wallet ? await this.readBalance(wallet) : {
      status: "UNAVAILABLE" as const,
      balanceMicros: null,
      reason: "WALLET_METADATA_MISSING",
    };
    const geoblock = wallet
      ? await this.readGeoblock(wallet)
      : { status: "UNAVAILABLE" as const, checkedAt: null, source: null, reason: "WALLET_METADATA_MISSING" };
    const clock = await this.readClockSafety();
    const evidenceNow = this.now().toISOString();
    return {
      wallet,
      balance,
      checks: [
        ...this.modeChecks(requestedExecutionMode),
        ...this.environmentChecks(),
        this.walletMetadataCheck(wallet),
        this.balanceProviderCheck(balance, evidenceNow),
        this.geoblockCheck(geoblock, evidenceNow),
        await this.complianceCheck(wallet),
        this.clockSafetyCheck(clock, evidenceNow),
        ...this.configurationChecks(),
        ...this.riskParameterChecks(),
        ...this.liveAccountPreflightChecks(wallet, balance),
        ...this.databaseChecks(),
        ...(this.runtimeEnvironment === "PRODUCTION"
          ? new LiveGateReconciliation(this.database).checkLiveOnly()
          : new LiveGateReconciliation(this.database).check()),
        ...this.prerequisiteChecks(now),
      ],
    };
  }

  private persistResult(
    runType: LiveGateRunType,
    requestedExecutionMode: RequestedExecutionMode | null,
    checks: LiveGateCheck[],
    signalId: string | null,
    riskDecisionId: string | null,
    rulesetHash: string | null,
    now: string,
    wallet: LiveWalletMetadata | null = this.store.activeWallet(),
    balance: BalanceResult | null = null,
  ): LiveGateResult {
    const state = this.store.state();
    const blockedReasons = checks.filter((check) => !check.passed).map((check) => check.reason);
    const allowed = blockedReasons.length === 0;
    const saved = this.store.saveRun({
      runType,
      allowed,
      checks,
      blockedReasons,
      requestedExecutionMode,
      executionMode: state.execution_mode,
      liveGateState: state.live_gate_state,
      signalId,
      riskDecisionId,
      rulesetHash,
      now,
    });
    const riskAccountId = riskDecisionId
      ? this.riskDecision(riskDecisionId)?.account_id ?? null
      : this.liveAccountIdForWallet(wallet?.liveWalletId ?? null);
    const exposure = this.currentExposureMicros(riskAccountId);
    const dailyLoss = this.dailyLossMicros(riskAccountId, now);
    this.store.saveRiskSnapshot({
      mode: state.execution_mode,
      walletAddress: wallet?.walletAddress ?? null,
      balanceMicros: balance?.balanceMicros ?? null,
      exposureMicros: exposure.toString(),
      dailyLossMicros: dailyLoss.toString(),
      riskStatus: allowed ? "SAFE" : "BLOCKED",
      checks,
      liveGateRunId: saved.runId,
      now,
    });
    if (!allowed && (runType === "PREFLIGHT" || runType === "STARTUP_RECOVERY")) {
      this.store.audit({
        entityType: "LIVE_GATE",
        entityId: saved.runId,
        action: "preflight_failed",
        reason: "LIVE_GATE_CHECK_FAILED",
        metadata: { runType, blockedReasons },
        now,
      });
    }
    return { allowed, checks, blockedReasons, runId: saved.runId };
  }

  private modeChecks(requestedExecutionMode: RequestedExecutionMode): LiveGateCheck[] {
    const state = this.store.state();
    return [
      {
        name: "execution_mode_valid",
        passed: ["PAPER", "LIVE"].includes(state.execution_mode),
        reason: ["PAPER", "LIVE"].includes(state.execution_mode) ? "OK" : `INVALID_EXECUTION_MODE:${state.execution_mode}`,
      },
      {
        name: "requested_execution_mode_live",
        passed: requestedExecutionMode === "LIVE",
        reason: requestedExecutionMode === "LIVE" ? "OK" : "REQUESTED_EXECUTION_MODE_NOT_LIVE",
      },
      {
        name: "live_gate_state_valid",
        passed: ["LIVE_DISABLED", "LIVE_ARMING", "LIVE_ACTIVE"].includes(state.live_gate_state),
        reason: ["LIVE_DISABLED", "LIVE_ARMING", "LIVE_ACTIVE"].includes(state.live_gate_state) ? "OK" : `INVALID_LIVE_GATE_STATE:${state.live_gate_state}`,
      },
    ];
  }

  private walletMetadataCheck(wallet: LiveWalletMetadata | null): LiveGateCheck {
    if (!wallet) return { name: "wallet_metadata", passed: false, reason: "WALLET_METADATA_MISSING" };
    if (!ADDRESS_RE.test(wallet.walletAddress)) return { name: "wallet_metadata", passed: false, reason: "WALLET_ADDRESS_INVALID" };
    if (!wallet.network) return { name: "wallet_metadata", passed: false, reason: "WALLET_NETWORK_MISSING" };
    if (wallet.status === "DISABLED") return { name: "wallet_metadata", passed: false, reason: "WALLET_DISABLED" };
    return { name: "wallet_metadata", passed: true, reason: "OK" };
  }

  private environmentChecks(): LiveGateCheck[] {
    const environment = this.runtimeEnvironment;
    const commitRecorded = this.sourceVersion.commit.trim().length > 0
      && !["UNKNOWN", "UNCOMMITTED"].includes(this.sourceVersion.commit.toUpperCase());
    return [
      {
        name: "runtime_environment",
        passed: environment === "PRODUCTION" || environment === "TEST",
        reason: environment === "PRODUCTION" || environment === "TEST" ? "OK" : "RUNTIME_ENVIRONMENT_INVALID",
      },
      {
        name: "source_commit_recorded",
        passed: commitRecorded,
        reason: commitRecorded ? "OK" : "SOURCE_COMMIT_NOT_RECORDED",
      },
      {
        name: "source_worktree_clean",
        passed: environment === "TEST" || !this.sourceVersion.dirty,
        reason: environment === "TEST" || !this.sourceVersion.dirty ? "OK" : "SOURCE_WORKTREE_DIRTY",
      },
    ];
  }

  private balanceProviderCheck(balance: BalanceResult, now: string): LiveGateCheck {
    const environment = this.runtimeEnvironment;
    if (environment === "PRODUCTION" && this.balanceProvider.providerType !== "LIVE_READONLY") {
      return {
        name: "balance_provider",
        passed: false,
        reason: `BALANCE_PROVIDER_FORBIDDEN_IN_PRODUCTION:${this.balanceProvider.providerType}`,
      };
    }
    if (environment === "TEST" && !["MOCK", "PAPER", "LIVE_READONLY"].includes(this.balanceProvider.providerType)) {
      return { name: "balance_provider", passed: false, reason: "BALANCE_PROVIDER_NOT_ALLOWED" };
    }
    if (balance.status !== "AVAILABLE" || balance.balanceMicros === null) {
      return { name: "balance_provider", passed: false, reason: balance.reason ?? "BALANCE_UNAVAILABLE" };
    }
    if (!this.externalEvidenceFresh(balance.checkedAt, balance.source, now)) {
      return { name: "balance_provider", passed: false, reason: "BALANCE_EVIDENCE_STALE_OR_INVALID" };
    }
    if (!this.isInteger(balance.balanceMicros) || BigInt(balance.balanceMicros) < 0n) {
      return { name: "balance_provider", passed: false, reason: "BALANCE_INVALID" };
    }
    return { name: "balance_provider", passed: true, reason: "OK" };
  }

  private geoblockCheck(result: GeoblockResult, now: string): LiveGateCheck {
    const environment = this.runtimeEnvironment;
    if (environment === "PRODUCTION" && this.geoblockProvider.providerType !== "LIVE_READONLY") {
      return {
        name: "geoblock_compliance",
        passed: false,
        reason: `GEOBLOCK_PROVIDER_FORBIDDEN_IN_PRODUCTION:${this.geoblockProvider.providerType}`,
      };
    }
    if (environment === "TEST" && this.geoblockProvider.providerType !== "FAKE") {
      return { name: "geoblock_compliance", passed: false, reason: "TEST_GEOBLOCK_PROVIDER_MUST_BE_FAKE" };
    }
    if (result.status !== "ALLOWED") {
      return { name: "geoblock_compliance", passed: false, reason: result.reason ?? `GEOBLOCK_${result.status}` };
    }
    if (!this.externalEvidenceFresh(result.checkedAt, result.source, now)) {
      return { name: "geoblock_compliance", passed: false, reason: "GEOBLOCK_EVIDENCE_STALE_OR_INVALID" };
    }
    return { name: "geoblock_compliance", passed: true, reason: "OK" };
  }

  private async complianceCheck(wallet: LiveWalletMetadata | null): Promise<LiveGateCheck> {
    if (!wallet) return { name: "compliance_policy", passed: false, reason: "WALLET_METADATA_MISSING" };
    if (this.runtimeEnvironment === "PRODUCTION" && this.complianceProvider.providerType !== "LIVE_READONLY") {
      return {
        name: "compliance_policy",
        passed: false,
        reason: `COMPLIANCE_PROVIDER_FORBIDDEN_IN_PRODUCTION:${this.complianceProvider.providerType}`,
      };
    }
    if (this.runtimeEnvironment === "TEST" && this.complianceProvider.providerType !== "FAKE") {
      return { name: "compliance_policy", passed: false, reason: "TEST_COMPLIANCE_PROVIDER_MUST_BE_FAKE" };
    }
    let signer: string | null = null;
    const row = this.database.prepare(
      `SELECT authorized_signer_address
       FROM live_accounts
       WHERE live_wallet_id=? AND status='ACTIVE'`,
    ).get(wallet.liveWalletId) as { authorized_signer_address: string | null } | undefined;
    signer = row?.authorized_signer_address ?? null;
    let result: ComplianceResult;
    try {
      result = await this.complianceProvider.check({
        walletAddress: wallet.walletAddress,
        walletType: wallet.walletType,
        network: wallet.network,
        authorizedSignerAddress: signer,
      });
    } catch {
      return { name: "compliance_policy", passed: false, reason: "COMPLIANCE_PROVIDER_ERROR" };
    }
    if (result.status !== "ALLOWED") {
      return { name: "compliance_policy", passed: false, reason: result.reason ?? `COMPLIANCE_${result.status}` };
    }
    if (!result.policyVersion?.trim()) {
      return { name: "compliance_policy", passed: false, reason: "COMPLIANCE_POLICY_VERSION_MISSING" };
    }
    if (!this.externalEvidenceFresh(result.checkedAt, result.source, this.now().toISOString())) {
      return { name: "compliance_policy", passed: false, reason: "COMPLIANCE_EVIDENCE_STALE_OR_INVALID" };
    }
    return { name: "compliance_policy", passed: true, reason: "OK" };
  }

  private clockSafetyCheck(result: ClockSafetyResult, now: string): LiveGateCheck {
    const environment = this.runtimeEnvironment;
    if (environment === "PRODUCTION" && this.clockProvider.providerType !== "LIVE_READONLY") {
      return {
        name: "clock_safety",
        passed: false,
        reason: `CLOCK_PROVIDER_FORBIDDEN_IN_PRODUCTION:${this.clockProvider.providerType}`,
      };
    }
    if (environment === "TEST" && this.clockProvider.providerType !== "FAKE") {
      return { name: "clock_safety", passed: false, reason: "TEST_CLOCK_PROVIDER_MUST_BE_FAKE" };
    }
    if (result.status !== "SAFE") {
      return { name: "clock_safety", passed: false, reason: result.reason ?? `CLOCK_${result.status}` };
    }
    if (!this.externalEvidenceFresh(result.checkedAt, result.source, now)) {
      return { name: "clock_safety", passed: false, reason: "CLOCK_EVIDENCE_STALE_OR_INVALID" };
    }
    const passed = result.offsetMs !== null && Number.isFinite(result.offsetMs);
    return {
      name: "clock_safety",
      passed,
      reason: passed ? result.reason ?? "OK" : "CLOCK_OFFSET_INVALID",
    };
  }

  private configurationChecks(): LiveGateCheck[] {
    return [
      this.positiveConfig("BANKROLL", this.config.bankrollMicros),
      this.positiveConfig("MAX_TRADE_SIZE", this.config.maxTradeSizeMicros),
      this.positiveConfig("MAX_EXPOSURE", this.config.maxExposureMicros),
      this.positiveConfig("MAX_DAILY_LOSS", this.config.maxDailyLossMicros),
      {
        name: "config_STOP_LOSS",
        passed: this.config.stopLossRatioPpm !== undefined && this.config.stopLossRatioPpm > 0 && this.config.stopLossRatioPpm < 1_000_000,
        reason: this.config.stopLossRatioPpm !== undefined && this.config.stopLossRatioPpm > 0 && this.config.stopLossRatioPpm < 1_000_000 ? "OK" : "CONFIG_STOP_LOSS_INVALID",
      },
    ];
  }

  private riskParameterChecks(): LiveGateCheck[] {
    const exposureValid = this.isPositiveInteger(this.config.maxExposureMicros);
    const tradeSizeValid = this.isPositiveInteger(this.config.maxTradeSizeMicros);
    const dailyLossValid = this.isPositiveInteger(this.config.maxDailyLossMicros);
    const bankrollValid = this.isPositiveInteger(this.config.bankrollMicros);
    const totalLimitValid = exposureValid
      && bankrollValid
      && BigInt(this.config.maxExposureMicros as string) <= BigInt(this.config.bankrollMicros as string);
    const tradeWithinExposure = tradeSizeValid
      && exposureValid
      && BigInt(this.config.maxTradeSizeMicros as string) <= BigInt(this.config.maxExposureMicros as string);
    const dailyLossWithinBankroll = dailyLossValid
      && bankrollValid
      && BigInt(this.config.maxDailyLossMicros as string) <= BigInt(this.config.bankrollMicros as string);
    const checks: LiveGateCheck[] = [
      {
        name: "risk_single_market_limit",
        passed: exposureValid,
        reason: exposureValid ? "OK" : "MAX_EXPOSURE_INVALID",
      },
      {
        name: "risk_single_event_limit",
        passed: tradeWithinExposure,
        reason: tradeWithinExposure
          ? "OK"
          : !tradeSizeValid
            ? "MAX_TRADE_SIZE_INVALID"
            : !exposureValid
              ? "MAX_EXPOSURE_INVALID"
              : "MAX_TRADE_SIZE_EXCEEDS_EXPOSURE",
      },
      {
        name: "risk_total_limit",
        passed: totalLimitValid,
        reason: totalLimitValid ? "OK" : "MAX_EXPOSURE_EXCEEDS_BANKROLL",
      },
      {
        name: "risk_daily_loss_limit",
        passed: dailyLossWithinBankroll,
        reason: dailyLossWithinBankroll ? "OK" : "MAX_DAILY_LOSS_EXCEEDS_BANKROLL",
      },
    ];
    if (this.config.kellyEnabled !== true) {
      checks.push({ name: "risk_kelly", passed: true, reason: "KELLY_ENABLED=false" });
    } else {
      checks.push({
        name: "risk_kelly",
        passed: this.config.kellyMaxFractionPpm !== undefined && this.config.kellyMaxFractionPpm > 0 && this.config.kellyMaxFractionPpm <= 1_000_000,
        reason: this.config.kellyMaxFractionPpm !== undefined && this.config.kellyMaxFractionPpm > 0 && this.config.kellyMaxFractionPpm <= 1_000_000 ? "OK" : "KELLY_CONFIG_INVALID",
      });
    }
    return checks;
  }

  private databaseChecks(): LiveGateCheck[] {
    const integrity = this.database.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
    const foreignKeys = this.database.prepare("PRAGMA foreign_key_check").all();
    const expectedVersion = this.config.expectedSchemaVersion ?? VERSIONS.schemaVersion;
    const expectedMigration = this.database.prepare("SELECT version FROM schema_migrations WHERE version=?")
      .get(expectedVersion) as { version: string } | undefined;
    const requiredTables = ["live_gate_state", "live_wallets", "live_gate_runs", "risk_snapshots", "live_gate_prerequisites"];
    return [
      {
        name: "database_schema_version",
        passed: expectedMigration?.version === expectedVersion,
        reason: expectedMigration?.version === expectedVersion ? "OK" : `SCHEMA_VERSION_MISMATCH:EXPECTED_${expectedVersion}_NOT_APPLIED`,
      },
      {
        name: "database_integrity",
        passed: integrity.integrity_check === "ok",
        reason: integrity.integrity_check === "ok" ? "OK" : `INTEGRITY_CHECK_FAILED:${integrity.integrity_check}`,
      },
      {
        name: "database_foreign_keys",
        passed: foreignKeys.length === 0,
        reason: foreignKeys.length === 0 ? "OK" : `FOREIGN_KEY_ISSUES:${foreignKeys.length}`,
      },
      ...requiredTables.map((table) => {
        const row = this.database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
        return {
          name: `database_table_${table}`,
          passed: row !== undefined,
          reason: row !== undefined ? "OK" : `TABLE_MISSING:${table}`,
        };
      }),
    ];
  }

  private prerequisiteChecks(now: string): LiveGateCheck[] {
    const rows = new Map(this.store.prerequisites().map((row) => [row.prerequisite_key, row]));
    return REQUIRED_PREREQUISITES.map((key) => {
      const row = rows.get(key);
      const name = `prerequisite_${key}`;
      if (!row) return { name, passed: false, reason: `PREREQUISITE_MISSING:${key}` };
      if (row.status !== "PASSED") {
        return { name, passed: false, reason: `PREREQUISITE_${row.status}:${row.prerequisite_key}` };
      }
      let evidence: PrerequisiteEvidence;
      try {
        const parsed = JSON.parse(row.evidence_json) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          return { name, passed: false, reason: `PREREQUISITE_EVIDENCE_INVALID:${row.prerequisite_key}` };
        }
        evidence = parsed as PrerequisiteEvidence;
      } catch {
        return { name, passed: false, reason: `PREREQUISITE_EVIDENCE_INVALID:${row.prerequisite_key}` };
      }
      if (Object.keys(evidence).length === 0) {
        return { name, passed: false, reason: `PREREQUISITE_EVIDENCE_EMPTY:${row.prerequisite_key}` };
      }
      if (typeof evidence.evidenceType !== "string" || evidence.evidenceType.trim().length === 0) {
        return { name, passed: false, reason: `PREREQUISITE_EVIDENCE_TYPE_MISSING:${row.prerequisite_key}` };
      }
      if (evidence.sourceCodeCommit !== this.sourceVersion.commit) {
        return { name, passed: false, reason: `PREREQUISITE_SOURCE_COMMIT_MISMATCH:${row.prerequisite_key}` };
      }
      const environment = this.runtimeEnvironment;
      if (evidence.environment !== environment) {
        return { name, passed: false, reason: `PREREQUISITE_ENVIRONMENT_MISMATCH:${row.prerequisite_key}` };
      }
      if (environment === "TEST" && evidence.testOnly !== true) {
        return { name, passed: false, reason: `PREREQUISITE_TEST_EVIDENCE_NOT_MARKED:${row.prerequisite_key}` };
      }
      if (environment === "PRODUCTION" && evidence.testOnly === true) {
        return { name, passed: false, reason: `PREREQUISITE_TEST_EVIDENCE_FORBIDDEN:${row.prerequisite_key}` };
      }
      const age = typeof evidence.checkedAt === "string" ? this.evidenceAgeMs(evidence.checkedAt, now) : null;
      const maxAge = this.config.prerequisiteMaxAgeMs ?? 7 * 24 * 60 * 60_000;
      if (age === null || age < 0 || age > maxAge) {
        return { name, passed: false, reason: `PREREQUISITE_EVIDENCE_STALE:${row.prerequisite_key}` };
      }
      return { name, passed: true, reason: "OK" };
    });
  }

  private positiveConfig(name: string, value: string | undefined): LiveGateCheck {
    const passed = this.isPositiveInteger(value);
    return { name: `config_${name}`, passed, reason: passed ? "OK" : `CONFIG_${name}_MISSING_OR_INVALID` };
  }

  private exposureCheck(riskDecision: RiskDecisionRow | null, side?: "BUY" | "SELL"): LiveGateCheck {
    if (side === "SELL") {
      return { name: "live_exposure_limit", passed: true, reason: "EXIT_NOT_EXPOSURE_LIMITED" };
    }
    const exposure = this.currentExposureMicros(riskDecision?.account_id ?? null);
    const configuredLimit = this.config.maxExposureMicros;
    const account = riskDecision?.account_id ? this.liveAccountRiskLimits(riskDecision.account_id) : null;
    const requestedRaw = side === "BUY" ? riskDecision?.requested_amount_micros : null;
    const requestedValid = requestedRaw === null || requestedRaw === undefined || this.isPositiveInteger(requestedRaw);
    const requested = requestedRaw !== null && requestedRaw !== undefined && requestedValid ? BigInt(requestedRaw) : 0n;
    const limit = this.isPositiveInteger(configuredLimit) && account !== null
      ? account.riskBudgetMicros < BigInt(configuredLimit as string)
        ? account.riskBudgetMicros
        : BigInt(configuredLimit as string)
      : 0n;
    const passed = limit > 0n && requestedValid && exposure + requested <= limit;
    return { name: "live_exposure_limit", passed, reason: passed ? "OK" : "LIVE_EXPOSURE_LIMIT_EXCEEDED" };
  }

  private dailyLossCheck(accountId: string | null, side?: "BUY" | "SELL"): LiveGateCheck {
    if (side === "SELL") {
      return { name: "live_daily_loss_limit", passed: true, reason: "EXIT_NOT_DAILY_LOSS_LIMITED" };
    }
    if (!accountId) return { name: "live_daily_loss_limit", passed: false, reason: "LIVE_ACCOUNT_ID_MISSING" };
    const dailyLoss = this.dailyLossMicros(accountId, this.now().toISOString());
    const configuredLimit = this.config.maxDailyLossMicros;
    const account = this.liveAccountRiskLimits(accountId);
    if (!this.isPositiveInteger(configuredLimit) || !account) {
      return { name: "live_daily_loss_limit", passed: false, reason: "LIVE_DAILY_LOSS_LIMIT_UNAVAILABLE" };
    }
    const limit = BigInt(configuredLimit as string);
    const passed = limit > 0n && dailyLoss < limit;
    return { name: "live_daily_loss_limit", passed, reason: passed ? "OK" : "LIVE_DAILY_LOSS_LIMIT_EXCEEDED" };
  }

  private marketStatusCheck(signal: SignalRow | null): LiveGateCheck {
    if (signal?.context_market_end_time_status === "UNAVAILABLE") {
      return { name: "market_status", passed: false, reason: "MARKET_END_TIME_UNAVAILABLE" };
    }
    if (!signal?.context_market_end_time) return { name: "market_status", passed: false, reason: "MARKET_METADATA_MISSING" };
    const passed = this.now().valueOf() < Date.parse(signal.context_market_end_time);
    return { name: "market_status", passed, reason: passed ? "OK" : "MARKET_CLOSED" };
  }

  private currentExposureMicros(accountId: string | null = null): bigint {
    if (!accountId) return 0n;
    const rows = this.database.prepare(
      `SELECT remaining_cost_micros FROM live_positions
       WHERE live_account_id=? AND status IN ('OPEN','PARTIALLY_CLOSED','SETTLEMENT_PENDING')`,
    ).all(accountId) as unknown as Array<{ remaining_cost_micros: string }>;
    return rows.reduce((total, row) => total + BigInt(row.remaining_cost_micros), 0n);
  }

  private dailyLossMicros(accountId: string | null, now: string): bigint {
    if (!accountId) return 0n;
    const day = now.slice(0, 10);
    const rows = this.database.prepare(
      `SELECT pnl_micros FROM live_pnl_ledger
       WHERE live_account_id=? AND created_at>=? AND created_at<?`,
    ).all(accountId, `${day}T00:00:00.000Z`, `${day}T23:59:59.999Z`) as unknown as Array<{ pnl_micros: string }>;
    return rows.reduce((loss, row) => {
      const pnl = BigInt(row.pnl_micros);
      return pnl < 0n ? loss - pnl : loss;
    }, 0n);
  }

  private liveAccountIdForWallet(liveWalletId: string | null): string | null {
    if (!liveWalletId) return null;
    const row = this.database.prepare(
      "SELECT live_account_id FROM live_accounts WHERE live_wallet_id=? AND status='ACTIVE'",
    ).get(liveWalletId) as { live_account_id: string } | undefined;
    return row?.live_account_id ?? null;
  }

  private liveAccountRiskLimits(accountId: string): { initialBankrollMicros: bigint; riskBudgetMicros: bigint } | null {
    const row = this.database.prepare(
      "SELECT initial_bankroll_micros,risk_budget_micros FROM live_accounts WHERE live_account_id=?",
    ).get(accountId) as { initial_bankroll_micros: string; risk_budget_micros: string } | undefined;
    return row ? {
      initialBankrollMicros: BigInt(row.initial_bankroll_micros),
      riskBudgetMicros: BigInt(row.risk_budget_micros),
    } : null;
  }

  private rulesetExists(rulesetHash: string): boolean {
    const row = this.database.prepare("SELECT 1 ok FROM ruleset_registry WHERE ruleset_hash=?")
      .get(rulesetHash);
    return row !== undefined;
  }

  private signal(signalId: string): SignalRow | null {
    const row = this.database.prepare(
      `SELECT s.signal_id,s.status,s.execution_eligible,s.ruleset_hash,s.signal_type,
              s.asset_id,s.condition_id,s.target_price_units,s.target_size_micros,
              c.context_id,c.market_end_time context_market_end_time,
              c.market_end_time_status context_market_end_time_status
       FROM signals s
       LEFT JOIN signal_execution_contexts c ON c.signal_id=s.signal_id
       WHERE s.signal_id=?`,
    ).get(signalId) as SignalRow | undefined;
    return row ?? null;
  }

  private riskDecision(riskDecisionId: string): RiskDecisionRow | null {
    const row = this.database.prepare(
      `SELECT risk_decision_id,signal_id,executor_mode,account_id,context_id,decision,
              requested_amount_micros,requested_size_micros,ruleset_hash,risk_reason
       FROM risk_decisions WHERE risk_decision_id=?`,
    ).get(riskDecisionId) as RiskDecisionRow | undefined;
    return row ?? null;
  }

  private stopLossPosition(positionId: string): StopLossPositionRow | null {
    const row = this.database.prepare(
      `SELECT live_position_id,live_account_id,signal_id,asset_id,condition_id,
              entry_price_units,current_size_micros,status,ruleset_hash
       FROM live_positions WHERE live_position_id=?`,
    ).get(positionId) as StopLossPositionRow | undefined;
    return row ?? null;
  }

  private liveAccountCheck(accountId: string | null, activeWallet: LiveWalletMetadata | null): LiveGateCheck {
    if (!accountId) return { name: "live_account", passed: false, reason: "LIVE_ACCOUNT_ID_MISSING" };
    const account = this.database.prepare(
      `SELECT a.status account_status,w.status wallet_status,w.live_wallet_id,w.wallet_address
       FROM live_accounts a
       JOIN live_wallets w ON w.live_wallet_id=a.live_wallet_id
       WHERE a.live_account_id=?`,
    ).get(accountId) as {
      account_status: string;
      wallet_status: string;
      live_wallet_id: string;
      wallet_address: string;
    } | undefined;
    if (!account) return { name: "live_account", passed: false, reason: "LIVE_ACCOUNT_NOT_FOUND" };
    if (account.account_status !== "ACTIVE") {
      return { name: "live_account", passed: false, reason: `LIVE_ACCOUNT_NOT_ACTIVE:${account.account_status}` };
    }
    if (account.wallet_status !== "ACTIVE") {
      return { name: "live_account", passed: false, reason: `LIVE_ACCOUNT_WALLET_NOT_ACTIVE:${account.wallet_status}` };
    }
    if (!activeWallet
      || activeWallet.liveWalletId !== account.live_wallet_id
      || activeWallet.walletAddress.toLowerCase() !== account.wallet_address.toLowerCase()) {
      return { name: "live_account", passed: false, reason: "LIVE_ACCOUNT_WALLET_MISMATCH" };
    }
    return { name: "live_account", passed: true, reason: "OK" };
  }

  private approvedExecutionCheck(riskDecision: RiskDecisionRow | null, side?: "BUY" | "SELL"): LiveGateCheck {
    if (side === "BUY") {
      const amount = riskDecision?.requested_amount_micros;
      const passed = amount !== null && amount !== undefined && this.isInteger(amount) && BigInt(amount) > 0n;
      return { name: "risk_approved_execution", passed, reason: passed ? "OK" : "RISK_APPROVED_BUY_AMOUNT_INVALID" };
    }
    if (side === "SELL") {
      const size = riskDecision?.requested_size_micros;
      const passed = size !== null && size !== undefined && this.isInteger(size) && BigInt(size) > 0n;
      return { name: "risk_approved_execution", passed, reason: passed ? "OK" : "RISK_APPROVED_SELL_SIZE_INVALID" };
    }
    return { name: "risk_approved_execution", passed: false, reason: "RISK_APPROVED_SIDE_INVALID" };
  }

  private approvedExecutionLimitCheck(
    riskDecision: RiskDecisionRow | null,
    side: "BUY" | "SELL" | undefined,
    balance: BalanceResult,
  ): LiveGateCheck {
    if (side === "SELL") return { name: "risk_approved_execution_limit", passed: true, reason: "EXIT_NOT_CAPITAL_LIMITED" };
    const amount = riskDecision?.requested_amount_micros;
    const account = riskDecision?.account_id ? this.liveAccountRiskLimits(riskDecision.account_id) : null;
    const configuredLimit = this.config.maxTradeSizeMicros;
    const externalBalance = balance.balanceMicros;
    const inputsValid = side === "BUY"
      && this.isPositiveInteger(amount ?? undefined)
      && this.isPositiveInteger(configuredLimit)
      && this.isPositiveInteger(externalBalance ?? undefined)
      && account !== null;
    if (!inputsValid) {
      return { name: "risk_approved_execution_limit", passed: false, reason: "LIVE_BUY_LIMIT_UNAVAILABLE" };
    }
    const requested = BigInt(amount as string);
    const limit = [
      BigInt(configuredLimit as string),
      BigInt(externalBalance as string),
      account.riskBudgetMicros,
    ].reduce((minimum, value) => value < minimum ? value : minimum);
    return requested <= limit
      ? { name: "risk_approved_execution_limit", passed: true, reason: "OK" }
      : { name: "risk_approved_execution_limit", passed: false, reason: "LIVE_BUY_LIMIT_EXCEEDED" };
  }

  private liveAccountPreflightChecks(
    wallet: LiveWalletMetadata | null,
    balance: BalanceResult,
  ): LiveGateCheck[] {
    if (!wallet) {
      return [{ name: "live_account_preflight", passed: false, reason: "LIVE_ACCOUNT_WALLET_MISSING" }];
    }
    const row = this.database.prepare(
      `SELECT live_account_id,initial_bankroll_micros,risk_budget_micros,authorized_signer_address
       FROM live_accounts
       WHERE live_wallet_id=? AND status='ACTIVE'`,
    ).get(wallet.liveWalletId) as {
      live_account_id: string;
      initial_bankroll_micros: string;
      risk_budget_micros: string;
      authorized_signer_address: string | null;
    } | undefined;
    if (!row) {
      return [{ name: "live_account_preflight", passed: false, reason: "ACTIVE_LIVE_ACCOUNT_MISSING" }];
    }
    const accountValuesValid = this.isPositiveInteger(row.initial_bankroll_micros)
      && this.isPositiveInteger(row.risk_budget_micros);
    const bankrollConfigured = this.isPositiveInteger(this.config.bankrollMicros);
    const maxExposureConfigured = this.isPositiveInteger(this.config.maxExposureMicros);
    const accountBankroll = accountValuesValid ? BigInt(row.initial_bankroll_micros) : 0n;
    const riskBudget = accountValuesValid ? BigInt(row.risk_budget_micros) : 0n;
    const configuredBankroll = bankrollConfigured ? BigInt(this.config.bankrollMicros as string) : 0n;
    const configuredExposure = maxExposureConfigured ? BigInt(this.config.maxExposureMicros as string) : 0n;
    const budgetValid = accountValuesValid
      && riskBudget <= accountBankroll
      && maxExposureConfigured
      && riskBudget <= configuredExposure;
    const bankrollBound = accountValuesValid && bankrollConfigured && accountBankroll === configuredBankroll;
    const signerAddressValid = typeof row.authorized_signer_address === "string"
      && ADDRESS_RE.test(row.authorized_signer_address);
    const eoaSignerBound = wallet.walletType !== "EOA"
      || row.authorized_signer_address?.toLowerCase() === wallet.walletAddress.toLowerCase();
    const signerIdentityValid = signerAddressValid && eoaSignerBound;

    const balanceValid = balance.status === "AVAILABLE"
      && this.isInteger(balance.balanceMicros ?? "")
      && BigInt(balance.balanceMicros as string) >= 0n;

    return [
      { name: "live_account_preflight", passed: true, reason: "OK" },
      {
        name: "live_account_signer_identity",
        passed: signerIdentityValid,
        reason: signerIdentityValid
          ? "OK"
          : !row.authorized_signer_address
            ? "LIVE_ACCOUNT_AUTHORIZED_SIGNER_MISSING"
            : !signerAddressValid
              ? "LIVE_ACCOUNT_AUTHORIZED_SIGNER_INVALID"
              : "LIVE_ACCOUNT_EOA_SIGNER_MISMATCH",
      },
      {
        name: "live_account_bankroll_binding",
        passed: bankrollBound,
        reason: bankrollBound ? "OK" : "LIVE_ACCOUNT_BANKROLL_CONFIG_MISMATCH",
      },
      {
        name: "live_account_risk_budget",
        passed: budgetValid,
        reason: budgetValid ? "OK" : "LIVE_ACCOUNT_RISK_BUDGET_INVALID",
      },
      {
        name: "live_account_external_balance_observed",
        passed: balanceValid,
        reason: balanceValid ? "OK" : "LIVE_ACCOUNT_BALANCE_UNAVAILABLE",
      },
    ];
  }

  private externalEvidenceFresh(checkedAt: string | null | undefined, source: string | null | undefined, now: string): boolean {
    if (!checkedAt || !source?.trim()) return false;
    const age = this.evidenceAgeMs(checkedAt, now);
    const maxAge = this.config.externalEvidenceMaxAgeMs ?? 60_000;
    return age !== null && age >= 0 && age <= maxAge;
  }

  private evidenceAgeMs(checkedAt: string, now: string): number | null {
    const checked = Date.parse(checkedAt);
    const current = Date.parse(now);
    if (!Number.isFinite(checked) || !Number.isFinite(current)) return null;
    return current - checked;
  }

  private isInteger(value: string): boolean {
    return /^-?\d+$/.test(value);
  }

  private isPositiveInteger(value: string | undefined): boolean {
    return value !== undefined && /^\d+$/.test(value) && BigInt(value) > 0n;
  }

  private async readBalance(wallet: LiveWalletMetadata): Promise<BalanceResult> {
    try {
      return await this.balanceProvider.getBalance({ walletAddress: wallet.walletAddress, network: wallet.network });
    } catch {
      return { status: "UNAVAILABLE", balanceMicros: null, reason: "BALANCE_PROVIDER_ERROR" };
    }
  }

  private async readGeoblock(wallet: LiveWalletMetadata): Promise<GeoblockResult> {
    try {
      return await this.geoblockProvider.check({ walletAddress: wallet.walletAddress, network: wallet.network });
    } catch {
      return { status: "UNAVAILABLE", checkedAt: null, source: null, reason: "GEOBLOCK_PROVIDER_ERROR" };
    }
  }

  private async readClockSafety(): Promise<ClockSafetyResult> {
    try {
      return await this.clockProvider.check();
    } catch {
      return { status: "UNAVAILABLE", offsetMs: null, checkedAt: null, source: null, reason: "CLOCK_PROVIDER_ERROR" };
    }
  }
}

export function defaultLiveGateConfig(): LiveGateConfig {
  return {
    bankrollMicros: RULESET.liveBankrollMicros.toString(),
    maxTradeSizeMicros: RULESET.liveMaxTradeSizeMicros.toString(),
    maxExposureMicros: RULESET.liveMaxExposureMicros.toString(),
    maxDailyLossMicros: RULESET.liveMaxDailyLossMicros.toString(),
    stopLossRatioPpm: RULESET.liveStopLossRatioPpm,
    kellyEnabled: RULESET.liveKellyEnabled,
    expectedSchemaVersion: VERSIONS.schemaVersion,
    runtimeEnvironment: "PRODUCTION",
    preflightMaxAgeMs: 5 * 60_000,
    prerequisiteMaxAgeMs: 7 * 24 * 60 * 60_000,
    externalEvidenceMaxAgeMs: 60_000,
  };
}
