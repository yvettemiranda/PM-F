import type { PaperExecutor } from "./paper-executor.js";
import type { PaperAccountSnapshot } from "./types.js";

const DEFAULT_REPORT_DETAIL_LIMIT = 100;

export interface PaperRunnerOptions {
  accountId: string;
  intervalMs?: number;
  durationMs?: number;
  reportDetailLimit?: number;
  now?: () => Date;
  wait?: (milliseconds: number) => Promise<void>;
}

export interface PaperRunnerReport {
  accountId: string;
  startedAt: string;
  stoppedAt: string;
  cycles: number;
  consumedSignals: number;
  errorCount: number;
  droppedErrorCount: number;
  errors: Array<{ time: string; message: string }>;
  account: PaperAccountSnapshot;
}

export type PaperRunCompletionStatus =
  | "COMPLETED"
  | "COMPLETED_WITH_ERRORS"
  | "COMPLETED_INCOMPLETE_VALUATION";

export function paperRunCompletionStatus(report: PaperRunnerReport): PaperRunCompletionStatus {
  if (report.errorCount > 0) return "COMPLETED_WITH_ERRORS";
  if (report.account.valuationStatus !== "COMPLETE" || report.account.unpricedPositionCount !== 0) {
    return "COMPLETED_INCOMPLETE_VALUATION";
  }
  return "COMPLETED";
}

function isCancellationFromSignal(error: unknown, signal?: AbortSignal): boolean {
  if (!signal?.aborted) return false;
  if (error === signal.reason) return true;
  if (!(error instanceof Error) || error.name !== "AbortError") return false;
  if (signal.reason instanceof Error && signal.reason.name === "AbortError") return true;
  return "cause" in error && error.cause === signal.reason;
}

export class PaperRunner {
  private readonly now: () => Date;
  private readonly wait: (milliseconds: number) => Promise<void>;
  private readonly reportDetailLimit: number;

  constructor(private readonly executor: PaperExecutor, private readonly options: PaperRunnerOptions) {
    const intervalMs = options.intervalMs ?? 1_000;
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      throw new Error(`PAPER_INTERVAL_MUST_BE_POSITIVE:${String(intervalMs)}`);
    }
    if (options.durationMs !== undefined && (!Number.isFinite(options.durationMs) || options.durationMs <= 0)) {
      throw new Error(`PAPER_DURATION_MUST_BE_POSITIVE:${String(options.durationMs)}`);
    }
    this.reportDetailLimit = options.reportDetailLimit ?? DEFAULT_REPORT_DETAIL_LIMIT;
    if (!Number.isSafeInteger(this.reportDetailLimit) || this.reportDetailLimit <= 0) {
      throw new Error(`PAPER_REPORT_DETAIL_LIMIT_MUST_BE_POSITIVE:${String(this.reportDetailLimit)}`);
    }
    this.now = options.now ?? (() => new Date());
    this.wait = options.wait ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  async run(signal?: AbortSignal): Promise<PaperRunnerReport> {
    const startedAt = this.now().toISOString();
    const deadline = this.options.durationMs && this.options.durationMs > 0
      ? this.now().valueOf() + this.options.durationMs
      : Number.POSITIVE_INFINITY;
    let cycles = 0;
    let consumedSignals = 0;
    let errorCount = 0;
    const errors: PaperRunnerReport["errors"] = [];
    while (!signal?.aborted && this.now().valueOf() < deadline) {
      try {
        consumedSignals += (await this.executor.consumeAvailableSignals(this.options.accountId, signal)).length;
        if (!signal?.aborted) await this.executor.retryPending(this.options.accountId, signal);
        if (!signal?.aborted) await this.executor.checkStopLosses(this.options.accountId, signal);
        if (!signal?.aborted) await this.executor.processSettlements(this.options.accountId, signal);
      } catch (error) {
        if (isCancellationFromSignal(error, signal)) break;
        errorCount += 1;
        if (errors.length >= this.reportDetailLimit) errors.shift();
        errors.push({ time: this.now().toISOString(), message: error instanceof Error ? error.message : String(error) });
      }
      cycles += 1;
      const remaining = deadline - this.now().valueOf();
      if (remaining <= 0) break;
      await this.waitForInterval(Math.min(this.options.intervalMs ?? 1_000, remaining), signal);
    }
    return {
      accountId: this.options.accountId,
      startedAt,
      stoppedAt: this.now().toISOString(),
      cycles,
      consumedSignals,
      errorCount,
      droppedErrorCount: Math.max(0, errorCount - errors.length),
      errors,
      account: await this.executor.accountSnapshot(this.options.accountId, signal),
    };
  }

  private async waitForInterval(milliseconds: number, signal?: AbortSignal): Promise<void> {
    if (!signal) {
      await this.wait(milliseconds);
      return;
    }
    if (signal.aborted) return;
    let onAbort = (): void => undefined;
    const aborted = new Promise<void>((resolve) => {
      onAbort = resolve;
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      await Promise.race([this.wait(milliseconds), aborted]);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }
}
