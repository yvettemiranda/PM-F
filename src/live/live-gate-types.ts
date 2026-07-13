export type ExecutionMode = "PAPER" | "LIVE";
export type RequestedExecutionMode = "LIVE";
export type LiveGateState = "LIVE_DISABLED" | "LIVE_ARMING" | "LIVE_ACTIVE";
export type LiveGateRunType = "PREFLIGHT" | "EXECUTION_CHECK" | "STARTUP_RECOVERY";
export type LiveGateRiskStatus = "SAFE" | "BLOCKED" | "UNKNOWN";
export type LiveGateRuntimeEnvironment = "PRODUCTION" | "TEST";

export interface LiveGateCheck {
  name: string;
  passed: boolean;
  reason: string;
}

export interface LiveGateResult {
  allowed: boolean;
  checks: LiveGateCheck[];
  blockedReasons: string[];
  runId: string;
}

export interface LiveGateConfig {
  bankrollMicros?: string;
  maxTradeSizeMicros?: string;
  maxExposureMicros?: string;
  maxDailyLossMicros?: string;
  stopLossRatioPpm?: number;
  kellyEnabled?: boolean;
  kellyMaxFractionPpm?: number;
  expectedSchemaVersion?: string;
  runtimeEnvironment?: LiveGateRuntimeEnvironment;
  preflightMaxAgeMs?: number;
  prerequisiteMaxAgeMs?: number;
  externalEvidenceMaxAgeMs?: number;
}

export interface LiveGateStateRow {
  state_id: "default";
  execution_mode: ExecutionMode;
  live_gate_state: LiveGateState;
  requested_execution_mode: RequestedExecutionMode | null;
  last_preflight_id: string | null;
  state_reason: string;
  source_code_commit: string;
  source_code_dirty: number;
  config_version: string;
  created_at: string;
  updated_at: string;
}

export interface LiveWalletMetadata {
  liveWalletId: string;
  walletAddress: string;
  walletType: string;
  network: string;
  status: "REGISTERED" | "ACTIVE" | "DISABLED";
}

export interface LiveGatePreflightInput {
  requestedExecutionMode: RequestedExecutionMode;
}

export interface LiveActivationInput {
  actor: string;
  reason: string;
}

export interface LiveActivationConfirmation {
  actor: string;
  confirmationText: string;
}

export interface LiveExecutionGateInput {
  signalId: string;
  riskDecisionId: string;
  rulesetHash: string;
  accountId?: string;
  contextId?: string;
  side?: "BUY" | "SELL";
  assetId?: string;
  conditionId?: string;
  targetPriceUnits?: string;
  targetSizeMicros?: string;
  executionType?: "TARGET_BUY" | "TARGET_SELL" | "STOP_LOSS";
  positionId?: string;
}

export interface LiveAccountActionGateInput {
  action: "REDEEM";
  accountId: string;
  riskDecisionId: string;
  rulesetHash: string;
  assetId: string;
  conditionId: string;
  requestedAmountMicros: string;
  requestedSizeMicros: string;
}

export interface EmergencyDisableInput {
  actor: string;
  reason: string;
}

export interface LiveGate {
  readonly gateType: "PRODUCTION";
  readonly runtimeEnvironment: LiveGateRuntimeEnvironment;
  preflight(input: LiveGatePreflightInput): Promise<LiveGateResult>;
  requestLiveActivation(input: LiveActivationInput): Promise<LiveGateResult>;
  confirmLiveActivation(input: LiveActivationConfirmation): Promise<LiveGateResult>;
  checkExecution(input: LiveExecutionGateInput): Promise<LiveGateResult>;
  checkAccountAction(input: LiveAccountActionGateInput): Promise<LiveGateResult>;
  recoverOnStartup(): Promise<LiveGateResult>;
  emergencyDisable(input: EmergencyDisableInput): Promise<void>;
}
