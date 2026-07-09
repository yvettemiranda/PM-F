import type {
  ExecutorBalanceQuery,
  ExecutorExecutionResult,
  ExecutorInterface,
  ExecutorPositionQuery,
  ExecutorReconcileInput,
  ExecutorReconcileResult,
  ExecutorSignalInput,
} from "../execution/types.js";
import type { PaperAccountSnapshot } from "../paper/types.js";

export class LiveExecutorPlaceholder implements ExecutorInterface {
  readonly mode = "LIVE" as const;

  async executeBuy(_input: ExecutorSignalInput): Promise<ExecutorExecutionResult> {
    throw new Error("LIVE_EXECUTOR_NOT_IMPLEMENTED");
  }

  async executeSell(_input: ExecutorSignalInput): Promise<ExecutorExecutionResult> {
    throw new Error("LIVE_EXECUTOR_NOT_IMPLEMENTED");
  }

  async cancelExecution(_executionId: string, _reason: string): Promise<void> {
    throw new Error("LIVE_EXECUTOR_NOT_IMPLEMENTED");
  }

  async getPosition(_query: ExecutorPositionQuery): Promise<unknown> {
    throw new Error("LIVE_EXECUTOR_NOT_IMPLEMENTED");
  }

  async getBalance(_query: ExecutorBalanceQuery): Promise<PaperAccountSnapshot> {
    throw new Error("LIVE_EXECUTOR_NOT_IMPLEMENTED");
  }

  async reconcile(_input: ExecutorReconcileInput): Promise<ExecutorReconcileResult> {
    return { mode: "LIVE", frozenPositionCount: 0, reason: "LIVE_EXECUTOR_DISABLED" };
  }
}
