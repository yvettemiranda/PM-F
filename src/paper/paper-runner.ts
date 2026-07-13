import type { PaperExecutor } from "./paper-executor.js";
import type { PaperAccountSnapshot } from "./types.js";

export interface PaperRunnerOptions {
  accountId: string;
  intervalMs?: number;
  durationMs?: number;
  now?: () => Date;
  wait?: (milliseconds: number) => Promise<void>;
}

export interface PaperRunnerReport {
  accountId: string;
  startedAt: string;
  stoppedAt: string;
  cycles: number;
  consumedSignals: number;
  errors: Array<{ time: string; message: string }>;
  account: PaperAccountSnapshot;
}

export class PaperRunner {
  private readonly now: () => Date;
  private readonly wait: (milliseconds: number) => Promise<void>;

  constructor(private readonly executor: PaperExecutor, private readonly options: PaperRunnerOptions) {
    const intervalMs = options.intervalMs ?? 1_000;
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      throw new Error(`PAPER_INTERVAL_MUST_BE_POSITIVE:${String(intervalMs)}`);
    }
    if (options.durationMs !== undefined && (!Number.isFinite(options.durationMs) || options.durationMs <= 0)) {
      throw new Error(`PAPER_DURATION_MUST_BE_POSITIVE:${String(options.durationMs)}`);
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
    const errors: PaperRunnerReport["errors"] = [];
    while (!signal?.aborted && this.now().valueOf() < deadline) {
      try {
        consumedSignals += (await this.executor.consumeAvailableSignals(this.options.accountId)).length;
        await this.executor.retryPending(this.options.accountId);
        await this.executor.checkStopLosses(this.options.accountId);
        await this.executor.processSettlements(this.options.accountId);
      } catch (error) {
        errors.push({ time: this.now().toISOString(), message: error instanceof Error ? error.message : String(error) });
      }
      cycles += 1;
      const remaining = deadline - this.now().valueOf();
      if (remaining <= 0) break;
      await this.wait(Math.min(this.options.intervalMs ?? 1_000, remaining));
    }
    return {
      accountId: this.options.accountId,
      startedAt,
      stoppedAt: this.now().toISOString(),
      cycles,
      consumedSignals,
      errors,
      account: await this.executor.accountSnapshot(this.options.accountId),
    };
  }
}
