import { DatabaseSync } from "node:sqlite";
import { RULESET, RULESET_HASH, stableJson, VERSIONS } from "../domain/versioning.js";
import { resolveSourceVersion, type SourceVersion } from "../infra/source-version.js";
import type { BalanceProvider, BalanceResult } from "./balance-provider.js";
import { LiveGateReconciliation } from "./live-gate-reconciliation.js";
import { LiveGateStore } from "./live-gate-store.js";
import type {
  EmergencyDisableInput,
  ExecutionMode,
  LiveActivationConfirmation,
  LiveActivationInput,
  LiveExecutionGateInput,
  LiveGate,
  LiveGateCheck,
  LiveGateConfig,
  LiveGatePreflightInput,
  LiveGateResult,
  LiveGateRunType,
  LiveGateState,
  LiveWalletMetadata,
  RequestedExecutionMode,
} from "./live-gate-types.js";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

interface SignalRow {
  signal_id: string;
  status: string;
  execution_eligible: number;
  ruleset_hash: string;
  condition_id: string;
  context_market_end_time: string | null;
}

interface RiskDecisionRow {
  risk_decision_id: string;
  signal_id: string | null;
  decision: "ALLOW" | "REJECT";
  ruleset_hash: string;
}

export class LiveGateService implements LiveGate {
  private readonly database: DatabaseSync;
  private readonly store: LiveGateStore;
  private readonly sourceVersion: SourceVersion;
  private readonly now: () => Date;

  constructor(
    databasePath: string,
    private readonly balanceProvider: BalanceProvider,
    private readonly config: LiveGateConfig,
    options: { sourceVersion?: SourceVersion; now?: () => Date } = {},
  ) {
    this.database = new DatabaseSync(databasePath);
    this.database.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;");
    this.sourceVersion = options.sourceVersion ?? resolveSourceVersion();
    this.now = options.now ?? (() => new Date());
    this.store = new LiveGateStore(this.database, this.sourceVersion, this.now);
    this.store.ensureDefaultState();
  }

  async preflight(input: LiveGatePreflightInput): Promise<LiveGateResult> {
    return this.evaluateGate("PREFLIGHT", input.requestedExecutionMode, null);
  }

  async requestLiveActivation(input: LiveActivationInput): Promise<LiveGateResult> {
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
      this.store.setState({
        executionMode: "PAPER",
        liveGateState: "LIVE_DISABLED",
        requestedExecutionMode: null,
        lastPreflightId: result.runId,
        reason: "PREFLIGHT_FAILED",
        actor: input.actor,
        metadata: { blockedReasons: result.blockedReasons },
        now,
      });
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
    this.store.setState({
      executionMode: "PAPER",
      liveGateState: "LIVE_ARMING",
      requestedExecutionMode: "LIVE",
      lastPreflightId: result.runId,
      reason: "PREFLIGHT_PASSED_AWAITING_CONFIRMATION",
      actor: input.actor,
      metadata: { reason: input.reason },
      now,
    });
    return result;
  }

  async confirmLiveActivation(input: LiveActivationConfirmation): Promise<LiveGateResult> {
    const now = this.now().toISOString();
    const state = this.store.state();
    const checks: LiveGateCheck[] = [
      {
        name: "confirm_state",
        passed: state.live_gate_state === "LIVE_ARMING",
        reason: state.live_gate_state === "LIVE_ARMING" ? "OK" : `NOT_ARMING:${state.live_gate_state}`,
      },
      {
        name: "confirm_text",
        passed: input.confirmationText.trim().length > 0,
        reason: input.confirmationText.trim().length > 0 ? "OK" : "CONFIRMATION_TEXT_REQUIRED",
      },
      {
        name: "latest_preflight",
        passed: this.store.latestAllowedPreflight() !== null,
        reason: this.store.latestAllowedPreflight() !== null ? "OK" : "NO_ALLOWED_PREFLIGHT",
      },
      ...this.prerequisiteChecks(),
    ];
    const result = this.persistResult("PREFLIGHT", "LIVE", checks, null, null, null, now);
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
    this.store.setState({
      executionMode: "LIVE",
      liveGateState: "LIVE_ACTIVE",
      requestedExecutionMode: "LIVE",
      lastPreflightId: result.runId,
      reason: "USER_CONFIRMED_LIVE_ACTIVE",
      actor: input.actor,
      metadata: { confirmationText: input.confirmationText },
      now,
    });
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

  async checkExecution(input: LiveExecutionGateInput): Promise<LiveGateResult> {
    const now = this.now().toISOString();
    const state = this.store.state();
    const signal = this.signal(input.signalId);
    const riskDecision = this.riskDecision(input.riskDecisionId);
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
        name: "ruleset_exists",
        passed: this.rulesetExists(input.rulesetHash),
        reason: this.rulesetExists(input.rulesetHash) ? "OK" : "RULESET_NOT_REGISTERED",
      },
      {
        name: "ruleset_match",
        passed: riskDecision?.ruleset_hash === input.rulesetHash && signal?.ruleset_hash === input.rulesetHash,
        reason: riskDecision?.ruleset_hash === input.rulesetHash && signal?.ruleset_hash === input.rulesetHash ? "OK" : "RULESET_MISMATCH",
      },
      this.exposureCheck(),
      this.dailyLossCheck(),
      this.marketStatusCheck(signal),
      ...new LiveGateReconciliation(this.database).check().filter((check) => [
        "reconciliation_frozen_positions",
        "reconciliation_major_desync",
      ].includes(check.name)),
    ];
    const result = this.persistResult("EXECUTION_CHECK", null, checks, input.signalId, input.riskDecisionId, input.rulesetHash, now);
    if (!result.allowed) {
      this.store.audit({
        entityType: "LIVE_GATE",
        entityId: result.runId,
        action: "execution_blocked",
        reason: "LIVE_EXECUTION_GATE_BLOCKED",
        metadata: { input, blockedReasons: result.blockedReasons },
        now,
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
    const wallet = walletOverride ?? this.store.activeWallet();
    const balance = wallet ? await this.balanceProvider.getBalance({
      walletAddress: wallet.walletAddress,
      network: wallet.network,
    }) : { status: "UNAVAILABLE" as const, balanceMicros: null, reason: "WALLET_METADATA_MISSING" };
    const checks: LiveGateCheck[] = [
      ...this.modeChecks(requestedExecutionMode),
      this.walletMetadataCheck(wallet),
      this.balanceProviderCheck(balance),
      ...this.configurationChecks(),
      ...this.riskParameterChecks(),
      ...this.databaseChecks(),
      ...new LiveGateReconciliation(this.database).check(),
      ...this.prerequisiteChecks(),
    ];
    return this.persistResult(runType, requestedExecutionMode, checks, null, null, null, now, wallet, balance);
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
    const exposure = this.currentExposureMicros();
    const dailyLoss = this.dailyLossMicros(now);
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

  private balanceProviderCheck(balance: BalanceResult): LiveGateCheck {
    if (!["MOCK", "PAPER"].includes(this.balanceProvider.providerType)) {
      return { name: "balance_provider", passed: false, reason: "BALANCE_PROVIDER_NOT_ALLOWED" };
    }
    if (balance.status !== "AVAILABLE" || balance.balanceMicros === null) {
      return { name: "balance_provider", passed: false, reason: balance.reason ?? "BALANCE_UNAVAILABLE" };
    }
    const bankroll = this.config.bankrollMicros;
    if (bankroll && BigInt(balance.balanceMicros) < BigInt(bankroll)) {
      return { name: "balance_provider", passed: false, reason: "BALANCE_BELOW_BANKROLL" };
    }
    return { name: "balance_provider", passed: true, reason: "OK" };
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
    const checks: LiveGateCheck[] = [
      {
        name: "risk_single_market_limit",
        passed: this.config.maxExposureMicros !== undefined && BigInt(this.config.maxExposureMicros) > 0n,
        reason: this.config.maxExposureMicros !== undefined && BigInt(this.config.maxExposureMicros) > 0n ? "OK" : "MAX_EXPOSURE_INVALID",
      },
      {
        name: "risk_single_event_limit",
        passed: this.config.maxTradeSizeMicros !== undefined && BigInt(this.config.maxTradeSizeMicros) > 0n,
        reason: this.config.maxTradeSizeMicros !== undefined && BigInt(this.config.maxTradeSizeMicros) > 0n ? "OK" : "MAX_TRADE_SIZE_INVALID",
      },
      {
        name: "risk_total_limit",
        passed: this.config.maxExposureMicros !== undefined
          && this.config.bankrollMicros !== undefined
          && BigInt(this.config.maxExposureMicros) <= BigInt(this.config.bankrollMicros),
        reason: this.config.maxExposureMicros !== undefined
          && this.config.bankrollMicros !== undefined
          && BigInt(this.config.maxExposureMicros) <= BigInt(this.config.bankrollMicros) ? "OK" : "MAX_EXPOSURE_EXCEEDS_BANKROLL",
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
    const latest = this.database.prepare("SELECT version FROM schema_migrations ORDER BY applied_at DESC, version DESC LIMIT 1")
      .get() as { version: string } | undefined;
    const requiredTables = ["live_gate_state", "live_wallets", "live_gate_runs", "risk_snapshots", "live_gate_prerequisites"];
    return [
      {
        name: "database_schema_version",
        passed: latest?.version === (this.config.expectedSchemaVersion ?? VERSIONS.schemaVersion),
        reason: latest?.version === (this.config.expectedSchemaVersion ?? VERSIONS.schemaVersion) ? "OK" : `SCHEMA_VERSION_MISMATCH:${latest?.version ?? "NONE"}`,
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

  private prerequisiteChecks(): LiveGateCheck[] {
    return this.store.prerequisites().map((row) => ({
      name: `prerequisite_${row.prerequisite_key}`,
      passed: row.status === "PASSED",
      reason: row.status === "PASSED" ? "OK" : `PREREQUISITE_${row.status}:${row.prerequisite_key}`,
    }));
  }

  private positiveConfig(name: string, value: string | undefined): LiveGateCheck {
    const passed = value !== undefined && BigInt(value) > 0n;
    return { name: `config_${name}`, passed, reason: passed ? "OK" : `CONFIG_${name}_MISSING_OR_INVALID` };
  }

  private exposureCheck(): LiveGateCheck {
    const exposure = this.currentExposureMicros();
    const limit = this.config.maxExposureMicros;
    const passed = limit !== undefined && exposure <= BigInt(limit);
    return { name: "live_exposure_limit", passed, reason: passed ? "OK" : "LIVE_EXPOSURE_LIMIT_EXCEEDED" };
  }

  private dailyLossCheck(): LiveGateCheck {
    const dailyLoss = this.dailyLossMicros(this.now().toISOString());
    const limit = this.config.maxDailyLossMicros;
    const passed = limit !== undefined && dailyLoss <= BigInt(limit);
    return { name: "live_daily_loss_limit", passed, reason: passed ? "OK" : "LIVE_DAILY_LOSS_LIMIT_EXCEEDED" };
  }

  private marketStatusCheck(signal: SignalRow | null): LiveGateCheck {
    if (!signal?.context_market_end_time) return { name: "market_status", passed: false, reason: "MARKET_METADATA_MISSING" };
    const passed = this.now().valueOf() < Date.parse(signal.context_market_end_time);
    return { name: "market_status", passed, reason: passed ? "OK" : "MARKET_CLOSED" };
  }

  private currentExposureMicros(): bigint {
    const row = this.database.prepare(
      `SELECT COALESCE(SUM(CAST(remaining_cost_micros AS INTEGER)),0) exposure
       FROM paper_positions
       WHERE status IN ('OPEN','PARTIALLY_CLOSED','SETTLEMENT_PENDING')`,
    ).get() as { exposure: number };
    return BigInt(row.exposure);
  }

  private dailyLossMicros(now: string): bigint {
    const day = now.slice(0, 10);
    const rows = this.database.prepare(
      `SELECT pnl_micros FROM paper_pnl_ledger
       WHERE created_at>=? AND created_at<?`,
    ).all(`${day}T00:00:00.000Z`, `${day}T23:59:59.999Z`) as unknown as Array<{ pnl_micros: string }>;
    return rows.reduce((loss, row) => {
      const pnl = BigInt(row.pnl_micros);
      return pnl < 0n ? loss - pnl : loss;
    }, 0n);
  }

  private rulesetExists(rulesetHash: string): boolean {
    const row = this.database.prepare("SELECT 1 ok FROM ruleset_registry WHERE ruleset_hash=?")
      .get(rulesetHash);
    return row !== undefined;
  }

  private signal(signalId: string): SignalRow | null {
    const row = this.database.prepare(
      `SELECT s.signal_id,s.status,s.execution_eligible,s.ruleset_hash,s.condition_id,
              c.market_end_time context_market_end_time
       FROM signals s
       LEFT JOIN signal_execution_contexts c ON c.signal_id=s.signal_id
       WHERE s.signal_id=?`,
    ).get(signalId) as SignalRow | undefined;
    return row ?? null;
  }

  private riskDecision(riskDecisionId: string): RiskDecisionRow | null {
    const row = this.database.prepare(
      "SELECT risk_decision_id,signal_id,decision,ruleset_hash FROM risk_decisions WHERE risk_decision_id=?",
    ).get(riskDecisionId) as RiskDecisionRow | undefined;
    return row ?? null;
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
  };
}
