import type {
  PaperExecutor,
  PaperPendingRetryOptions,
} from "./paper-executor.js";
import type { PaperAcceptanceSummary } from "./paper-acceptance-summary.js";
import type { PaperAccountSnapshot, PaperSignalConsumptionScope } from "./types.js";
import type { MarketChangeFeed } from "../execution/market-change-feed.js";

const DEFAULT_REPORT_DETAIL_LIMIT = 100;

export interface PaperRunnerOptions {
  accountId: string;
  intervalMs?: number;
  durationMs?: number;
  reportDetailLimit?: number;
  signalScope?: PaperSignalConsumptionScope;
  marketChangeFeed?: MarketChangeFeed;
  pendingBuyFallbackIntervalMs?: number;
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
  acceptance: PaperAcceptanceSummary;
}

export type PaperRunCompletionStatus =
  | "COMPLETED"
  | "COMPLETED_WITH_ERRORS"
  | "COMPLETED_INCOMPLETE_VALUATION"
  | "COMPLETED_INCONSISTENT"
  | "COMPLETED_WITH_SAFETY_BLOCKERS";

export function paperRunCompletionStatus(report: PaperRunnerReport): PaperRunCompletionStatus {
  if (report.errorCount > 0) return "COMPLETED_WITH_ERRORS";
  if (!report.acceptance.consistency.passed) return "COMPLETED_INCONSISTENT";
  if (report.acceptance.marketData.blockerCount > 0) return "COMPLETED_WITH_SAFETY_BLOCKERS";
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

function isTargetConversionBlock(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("PAPER_TARGET_CONVERSION_BLOCKED:");
}

export class PaperRunner {
  private readonly now: () => Date;
  private readonly wait: (milliseconds: number) => Promise<void>;
  private readonly reportDetailLimit: number;
  private readonly pendingBuyFallbackIntervalMs: number;
  private lastPendingBuyFallbackAtMs: number | null = null;

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
    this.pendingBuyFallbackIntervalMs = options.pendingBuyFallbackIntervalMs ?? 15_000;
    if (!Number.isFinite(this.pendingBuyFallbackIntervalMs) || this.pendingBuyFallbackIntervalMs <= 0) {
      throw new Error(`PAPER_PENDING_BUY_FALLBACK_INTERVAL_MUST_BE_POSITIVE:${String(this.pendingBuyFallbackIntervalMs)}`);
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
    const recordError = (error: unknown): void => {
      errorCount += 1;
      if (errors.length >= this.reportDetailLimit) errors.shift();
      errors.push({ time: this.now().toISOString(), message: error instanceof Error ? error.message : String(error) });
    };
    while (!signal?.aborted && this.now().valueOf() < deadline) {
      try {
        consumedSignals += await this.executeCycle(signal, recordError);
      } catch (error) {
        if (isCancellationFromSignal(error, signal)) break;
        recordError(error);
        if (isTargetConversionBlock(error)) break;
      }
      cycles += 1;
      const remaining = deadline - this.now().valueOf();
      if (remaining <= 0) break;
      await this.waitForInterval(Math.min(this.options.intervalMs ?? 1_000, remaining), signal);
    }
    const account = await this.executor.accountSnapshot(this.options.accountId, signal);
    return {
      accountId: this.options.accountId,
      startedAt,
      stoppedAt: this.now().toISOString(),
      cycles,
      consumedSignals,
      errorCount,
      droppedErrorCount: Math.max(0, errorCount - errors.length),
      errors,
      account,
      acceptance: this.executor.acceptanceSummary(this.options.accountId, {
        startAt: startedAt,
        endAt: this.now().toISOString(),
      }),
    };
  }

  async finalDrain(signal?: AbortSignal): Promise<number> {
    if (signal?.aborted) throw new Error("FINAL_DRAIN_INCOMPLETE");
    const consumed = await this.executeCycle(signal, (error) => { throw error; }, true);
    if (signal?.aborted) throw new Error("FINAL_DRAIN_INCOMPLETE");
    return consumed;
  }

  private async executeCycle(
    signal: AbortSignal | undefined,
    onError: (error: unknown) => void,
    forceAllPending = false,
  ): Promise<number> {
    let consumedSignals = 0;
    // Check before any pending order can be retried. A tracked conversion that
    // Paper cannot reproduce pauses the account and terminates this Session.
    this.executor.assertNoBlockingTargetConversion(
      this.options.accountId,
      this.options.signalScope,
    );
    const runStage = async (action: () => Promise<void>): Promise<boolean> => {
      if (signal?.aborted) return false;
      try {
        await action();
        return true;
      } catch (error) {
        if (isCancellationFromSignal(error, signal)) throw error;
        onError(error);
        return false;
      }
    };
    await runStage(async () => this.executor.recoverMarketData(this.options.accountId, signal));
    await runStage(async () => { await this.executor.processSettlements(this.options.accountId, signal); });
    await runStage(async () => {
      consumedSignals += (await this.executor.consumeAvailableSignals(
        this.options.accountId,
        signal,
        this.options.signalScope,
        { deferAttempts: true },
      )).length;
    });
    // Apply the target's current exits before deriving a protective STOP from
    // the remaining position. Otherwise one cycle can create two competing
    // exits for the same shares.
    await runStage(async () => { await this.executor.checkStopLosses(this.options.accountId, signal); });
    let retryOptions: PaperPendingRetryOptions | undefined;
    if (this.options.marketChangeFeed && !forceAllPending) {
      let pendingAssetIds = new Set<string>();
      const pendingRead = await runStage(async () => {
        const pending = this.executor.pendingBuyMarkets(this.options.accountId);
        pendingAssetIds = new Set(pending.map((market) => market.assetId));
      });
      if (pendingRead) {
        await runStage(async () => {
          this.options.marketChangeFeed!.replaceSubscriptions([...pendingAssetIds]);
        });
      }
      let changedAssetIds: string[] = [];
      const drained = await runStage(async () => {
        changedAssetIds = this.options.marketChangeFeed!.drainChangedAssetIds();
      });
      const currentTime = this.now().valueOf();
      const fallbackDue = this.lastPendingBuyFallbackAtMs === null
        || currentTime - this.lastPendingBuyFallbackAtMs >= this.pendingBuyFallbackIntervalMs;
      const changedPendingAssets = pendingRead && drained
        ? new Set(changedAssetIds.filter((assetId) => pendingAssetIds.has(assetId)))
        : new Set<string>();
      if (fallbackDue) this.lastPendingBuyFallbackAtMs = currentTime;
      retryOptions = consumedSignals > 0
        ? { includeBuys: true, includeExits: true }
        : fallbackDue
        ? { includeBuys: true, includeExits: true }
        : changedPendingAssets.size > 0
          ? { includeBuys: true, includeExits: true, buyAssetIds: changedPendingAssets }
          : { includeBuys: false, includeExits: true };
    }
    await runStage(async () => this.executor.retryPending(this.options.accountId, signal, retryOptions));
    if (this.options.marketChangeFeed && !forceAllPending) {
      await runStage(async () => {
        const pending = this.executor.pendingBuyMarkets(this.options.accountId);
        this.options.marketChangeFeed!.replaceSubscriptions(pending.map((market) => market.assetId));
        if (pending.length > 0 && this.lastPendingBuyFallbackAtMs === null) {
          this.lastPendingBuyFallbackAtMs = this.now().valueOf();
        }
      });
    }
    return consumedSignals;
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
