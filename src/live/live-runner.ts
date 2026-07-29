import type { PaperAccountSnapshot } from "../paper/types.js";
import type {
  LiveExecutor,
  LiveSettlementProcessingResult,
  LiveStopLossCheckResult,
} from "./live-executor.js";
import type { LiveSignalConsumer } from "./live-signal-consumer.js";
import {
  recoverIncompleteValuation,
  type ValuationRecoveryPolicy,
} from "../execution/valuation-recovery.js";

const DEFAULT_REPORT_DETAIL_LIMIT = 100;

export interface LiveRunnerOptions {
  accountId: string;
  intervalMs?: number;
  durationMs?: number;
  reconciliationEveryCycles?: number;
  reportDetailLimit?: number;
  now?: () => Date;
  wait?: (milliseconds: number) => Promise<void>;
  valuationRecovery?: Omit<ValuationRecoveryPolicy, "signal">;
}

export interface LiveRunnerSettlementCounts {
  pendingObservations: number;
  resolvedObservations: number;
  failureObservations: number;
}

export interface LiveRunnerReport {
  accountId: string;
  startedAt: string;
  stoppedAt: string;
  cycles: number;
  activeCycles: number;
  activationCount: number;
  consumedSignals: number;
  retriedExecutions: number;
  stopLossExecutions: number;
  stopLossUnsafeCycles: number;
  skippedBuyCycles: number;
  settlements: LiveSettlementProcessingResult;
  settlementCounts: LiveRunnerSettlementCounts;
  reconciliationRuns: number;
  recovery: { passed: boolean; reason: string; recoveryRunId: string };
  errorCount: number;
  droppedErrorCount: number;
  errors: Array<{ time: string; operation: string; message: string }>;
  account: PaperAccountSnapshot | null;
  valuationRecovery: {
    attempts: number;
    recovered: boolean;
    status: "COMPLETE" | "INCOMPLETE";
  } | null;
}

/**
 * Orchestrates the already-gated Live services. It owns no signer, wallet, or
 * adapter and cannot bypass LiveExecutor. Startup recovery always runs first;
 * a human must re-arm Live Gate afterwards before Signal consumption begins.
 */
export class LiveRunner {
  private readonly now: () => Date;
  private readonly wait: (milliseconds: number) => Promise<void>;
  private readonly intervalMs: number;
  private readonly reconciliationEveryCycles: number;
  private readonly reportDetailLimit: number;

  constructor(
    private readonly executor: LiveExecutor,
    private readonly consumer: LiveSignalConsumer,
    private readonly options: LiveRunnerOptions,
  ) {
    this.intervalMs = options.intervalMs ?? 1_000;
    this.reconciliationEveryCycles = options.reconciliationEveryCycles ?? 60;
    this.reportDetailLimit = options.reportDetailLimit ?? DEFAULT_REPORT_DETAIL_LIMIT;
    if (!Number.isSafeInteger(this.intervalMs) || this.intervalMs <= 0) throw new Error("LIVE_RUNNER_INTERVAL_INVALID");
    if (options.durationMs !== undefined && (!Number.isFinite(options.durationMs) || options.durationMs <= 0)) {
      throw new Error("LIVE_RUNNER_DURATION_INVALID");
    }
    if (!Number.isSafeInteger(this.reconciliationEveryCycles) || this.reconciliationEveryCycles <= 0) {
      throw new Error("LIVE_RUNNER_RECONCILIATION_INTERVAL_INVALID");
    }
    if (!Number.isSafeInteger(this.reportDetailLimit) || this.reportDetailLimit <= 0) {
      throw new Error("LIVE_RUNNER_REPORT_DETAIL_LIMIT_INVALID");
    }
    this.now = options.now ?? (() => new Date());
    this.wait = options.wait ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  async run(
    signal?: AbortSignal,
    preparedRecovery?: { passed: boolean; reason: string; recoveryRunId: string },
  ): Promise<LiveRunnerReport> {
    const startedAt = this.now().toISOString();
    const deadline = this.options.durationMs
      ? this.now().valueOf() + this.options.durationMs
      : Number.POSITIVE_INFINITY;
    const recovery = preparedRecovery ?? await this.executor.recoverOnStartup(this.options.accountId);
    const errors: LiveRunnerReport["errors"] = [];
    let errorCount = 0;
    const recordError = (operation: string, message: string): void => {
      errorCount += 1;
      if (errors.length >= this.reportDetailLimit) errors.shift();
      errors.push({ time: this.now().toISOString(), operation, message });
      this.consumer.recordRuntimeError(this.options.accountId, operation, message);
    };
    const capture = async <T>(operation: string, task: () => Promise<T>): Promise<{
      ok: true;
      value: T;
    } | {
      ok: false;
    }> => {
      try {
        return { ok: true, value: await task() };
      } catch (error) {
        recordError(operation, error instanceof Error ? error.message : String(error));
        return { ok: false };
      }
    };
    if (!recovery.passed) recordError("STARTUP_RECOVERY", recovery.reason);
    let cycles = 0;
    let activeCycles = 0;
    let activationCount = 0;
    let consumedSignals = 0;
    let retriedExecutions = 0;
    let stopLossExecutions = 0;
    let stopLossUnsafeCycles = 0;
    let skippedBuyCycles = 0;
    let reconciliationRuns = 0;
    let wasActive = false;
    const settlements: LiveSettlementProcessingResult = {
      pendingPositionIds: [],
      resolvedPositionIds: [],
      failures: [],
    };
    const settlementCounts: LiveRunnerSettlementCounts = {
      pendingObservations: 0,
      resolvedObservations: 0,
      failureObservations: 0,
    };
    const appendUniqueBounded = <T>(values: T[], value: T, equals: (left: T, right: T) => boolean): void => {
      if (values.some((existing) => equals(existing, value))) return;
      if (values.length < this.reportDetailLimit) values.push(value);
    };
    while (!signal?.aborted && this.now().valueOf() < deadline) {
      const active = this.executor.isGateActive();
      if (active && !wasActive) {
        this.consumer.syncActiveGateBoundary(this.options.accountId);
        activationCount += 1;
      }
      wasActive = active;
      if (active) {
        activeCycles += 1;
        // Stage the target's exits before deriving a STOP or retrying any old
        // BUY. Legacy unexecutable TARGET_CONVERSION signals still route
        // through emergencyStop(), so they cannot be crossed by later Signals.
        const conversionSafety = await capture(
          "CHECK_TARGET_CONVERSION_BLOCK",
          () => this.consumer.assertNoBlockingTargetConversion(this.options.accountId),
        );
        const targetExits = await capture(
          "CONSUME_TARGET_EXITS",
          () => this.consumer.consumeAvailableSignals(this.options.accountId, 1_000, "LEADING_TARGET_SELLS"),
        );
        if (targetExits.ok) consumedSignals += targetExits.value.length;
        const stopLoss = await capture<LiveStopLossCheckResult>(
          "CHECK_STOP_LOSSES",
          () => this.executor.checkStopLosses(this.options.accountId),
        );
        const stopLossHealthy = stopLoss.ok && stopLoss.value.healthy;
        if (stopLoss.ok) stopLossExecutions += stopLoss.value.executionIds.length;
        if (!stopLossHealthy) stopLossUnsafeCycles += 1;

        await capture("RETRY_PENDING_EXITS", async () => {
          retriedExecutions += (await this.executor.retryPending(this.options.accountId, "EXITS_ONLY")).length;
        });

        const lateTargetExits = targetExits.ok
          ? await capture(
            "CONSUME_LATE_TARGET_EXITS",
            () => this.consumer.consumeAvailableSignals(this.options.accountId, 1_000, "LEADING_TARGET_SELLS"),
          )
          : targetExits;
        if (lateTargetExits.ok) consumedSignals += lateTargetExits.value.length;

        if (stopLossHealthy && conversionSafety.ok && targetExits.ok && lateTargetExits.ok) {
          const orderedSignals = await capture("CONSUME_SIGNALS_IN_ORDER", async () => {
            const results = await this.consumer.consumeAvailableSignals(
              this.options.accountId,
              1_000,
              "ALL",
            );
            consumedSignals += results.length;
            return results;
          });
          // Only retry older BUYs after the complete newly arrived Signal
          // sequence has been applied. A BUY followed by a SELL keeps target
          // chronology, while that SELL can still cancel an older wait before
          // the older BUY reaches the market again.
          if (orderedSignals.ok) {
            await capture("RETRY_PENDING_BUYS", async () => {
              retriedExecutions += (await this.executor.retryPending(this.options.accountId, "BUYS_ONLY")).length;
            });
          } else {
            skippedBuyCycles += 1;
          }
        } else {
          skippedBuyCycles += 1;
        }
        if (activeCycles % this.reconciliationEveryCycles === 0) {
          await capture("RECONCILIATION", async () => {
            const result = await this.executor.reconcile({
              accountId: this.options.accountId,
              reason: "LIVE_RUNNER_PERIODIC_RECONCILIATION",
            });
            reconciliationRuns += 1;
            if (result.reason !== "LIVE_RECONCILED") throw new Error(result.reason);
          });
        }
      }
      await capture("PROCESS_SETTLEMENTS", async () => {
        const current = await this.executor.processSettlements(this.options.accountId);
        settlementCounts.pendingObservations += current.pendingPositionIds.length;
        settlementCounts.resolvedObservations += current.resolvedPositionIds.length;
        settlementCounts.failureObservations += current.failures.length;
        for (const positionId of current.pendingPositionIds) {
          appendUniqueBounded(settlements.pendingPositionIds, positionId, (left, right) => left === right);
        }
        for (const positionId of current.resolvedPositionIds) {
          appendUniqueBounded(settlements.resolvedPositionIds, positionId, (left, right) => left === right);
        }
        for (const failure of current.failures) {
          appendUniqueBounded(
            settlements.failures,
            failure,
            (left, right) => left.positionId === right.positionId && left.reason === right.reason,
          );
        }
      });
      cycles += 1;
      const remaining = deadline - this.now().valueOf();
      if (remaining <= 0) break;
      await this.wait(Math.min(this.intervalMs, remaining));
    }
    let account: PaperAccountSnapshot | null = null;
    let valuationRecovery: LiveRunnerReport["valuationRecovery"] = null;
    await capture("FINAL_ACCOUNT_SNAPSHOT", async () => {
      const recovered = await recoverIncompleteValuation(
        () => this.executor.getBalance({ accountId: this.options.accountId }),
        {
          ...this.options.valuationRecovery,
          ...(signal === undefined ? {} : { signal }),
        },
      );
      account = recovered.value;
      valuationRecovery = {
        attempts: recovered.attempts,
        recovered: recovered.recovered,
        status: recovered.status,
      };
    });
    return {
      accountId: this.options.accountId,
      startedAt,
      stoppedAt: this.now().toISOString(),
      cycles,
      activeCycles,
      activationCount,
      consumedSignals,
      retriedExecutions,
      stopLossExecutions,
      stopLossUnsafeCycles,
      skippedBuyCycles,
      settlements,
      settlementCounts,
      reconciliationRuns,
      recovery,
      errorCount,
      droppedErrorCount: Math.max(0, errorCount - errors.length),
      errors,
      account,
      valuationRecovery,
    };
  }
}
