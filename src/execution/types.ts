import type { PaperAccountSnapshot, PaperSignalEnvelope, SignalExecutionContext } from "../paper/types.js";

export type ExecutorMode = "PAPER" | "LIVE";

export interface ExecutorSignalInput {
  accountId: string;
  signal: PaperSignalEnvelope;
  context: SignalExecutionContext;
  riskDecisionId: string;
}

export interface ExecutorExecutionResult {
  mode: ExecutorMode;
  executionId: string;
  state: string;
}

export interface ExecutorPositionQuery {
  accountId: string;
  positionId?: string;
  assetId?: string;
}

export interface ExecutorBalanceQuery {
  accountId: string;
}

export interface ExecutorReconcileInput {
  accountId: string;
  reason: string;
}

export interface ExecutorReconcileResult {
  mode: ExecutorMode;
  frozenPositionCount: number;
  reason: string;
}

export interface ExecutorInterface {
  readonly mode: ExecutorMode;
  executeBuy(input: ExecutorSignalInput): Promise<ExecutorExecutionResult>;
  executeSell(input: ExecutorSignalInput): Promise<ExecutorExecutionResult>;
  cancelExecution(executionId: string, reason: string): Promise<void>;
  getPosition(query: ExecutorPositionQuery): Promise<unknown>;
  getBalance(query: ExecutorBalanceQuery): Promise<PaperAccountSnapshot>;
  reconcile(input: ExecutorReconcileInput): Promise<ExecutorReconcileResult>;
}

export const EXECUTOR_REQUIRED_CONTEXT_FIELDS = [
  "capitalDecisionId",
  "targetTradeCapitalRatioPpm",
  "capitalSizingRatio",
  "capitalSizingRatioHash",
  "targetTradeTimestamp",
  "marketEndTime",
  "marketEndTimeStatus",
  "executionDeadlineAt",
  "marketMetadataSnapshot",
  "rulesetHash",
  "sourceCodeCommit",
  "configVersion",
] as const;
