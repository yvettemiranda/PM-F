import { describe, expect, it } from "vitest";
import type { PaperExecutor } from "../src/paper/paper-executor.js";
import { PaperRunner, paperRunCompletionStatus } from "../src/paper/paper-runner.js";
import type { PaperAccountSnapshot } from "../src/paper/types.js";

const unusedExecutor = {} as PaperExecutor;

const accountSnapshot: PaperAccountSnapshot = {
  paperAccountId: "paper",
  initialBalanceMicros: "1000000000",
  cashBalanceMicros: "1000000000",
  reservedBalanceMicros: "0",
  availableBalanceMicros: "1000000000",
  positionValueMicros: "0",
  realizedPnlMicros: "0",
  unrealizedPnlMicros: "0",
  totalEquityMicros: "1000000000",
  valuationStatus: "COMPLETE",
  unpricedPositionCount: 0,
  priceSource: "ORDERBOOK_EXIT_VWAP",
  priceTimestamp: "2026-07-15T00:00:00.000Z",
};

function idleExecutor(): PaperExecutor {
  return {
    consumeAvailableSignals: async () => [],
    retryPending: async () => undefined,
    checkStopLosses: async () => [],
    processSettlements: async () => [],
    accountSnapshot: async () => accountSnapshot,
  } as unknown as PaperExecutor;
}

describe("PaperRunner options", () => {
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects a non-positive or non-finite interval: %s",
    (intervalMs) => {
      expect(() => new PaperRunner(unusedExecutor, { accountId: "paper", intervalMs }))
        .toThrow("PAPER_INTERVAL_MUST_BE_POSITIVE");
    },
  );

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects a non-positive or non-finite explicit duration: %s",
    (durationMs) => {
      expect(() => new PaperRunner(unusedExecutor, { accountId: "paper", durationMs }))
        .toThrow("PAPER_DURATION_MUST_BE_POSITIVE");
    },
  );

  it("stops promptly when aborted during the interval wait", async () => {
    const controller = new AbortController();
    let enteredWait!: () => void;
    const waitStarted = new Promise<void>((resolvePromise) => { enteredWait = resolvePromise; });
    const reportPromise = new PaperRunner(idleExecutor(), {
      accountId: "paper",
      intervalMs: 1_000,
      wait: async () => {
        enteredWait();
        await new Promise<never>(() => undefined);
      },
    }).run(controller.signal);

    await waitStarted;
    controller.abort();
    const result = await Promise.race([
      reportPromise.then(() => "STOPPED"),
      new Promise<"TIMEOUT">((resolvePromise) => setTimeout(() => resolvePromise("TIMEOUT"), 100)),
    ]);

    expect(result).toBe("STOPPED");
  });

  it("does not count a planned in-flight abort as a Paper run error", async () => {
    const controller = new AbortController();
    let requestStarted!: () => void;
    const started = new Promise<void>((resolvePromise) => { requestStarted = resolvePromise; });
    const executor = {
      ...idleExecutor(),
      consumeAvailableSignals: async (_accountId: string, signal?: AbortSignal) => {
        requestStarted();
        return await new Promise<never>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    } as unknown as PaperExecutor;
    const reportPromise = new PaperRunner(executor, {
      accountId: "paper",
      intervalMs: 1_000,
    }).run(controller.signal);

    await started;
    controller.abort(new Error("PLANNED_SHUTDOWN"));
    const report = await reportPromise;

    expect(report.errorCount).toBe(0);
    expect(report.errors).toEqual([]);
  });

  it("still records an ordinary business error that races with shutdown", async () => {
    const controller = new AbortController();
    const executor = {
      ...idleExecutor(),
      consumeAvailableSignals: async () => {
        controller.abort(new Error("PLANNED_SHUTDOWN"));
        throw new Error("ORDERBOOK_UNAVAILABLE");
      },
    } as unknown as PaperExecutor;

    const report = await new PaperRunner(executor, {
      accountId: "paper",
      intervalMs: 1_000,
    }).run(controller.signal);

    expect(report.errorCount).toBe(1);
    expect(report.errors).toMatchObject([{ message: "ORDERBOOK_UNAVAILABLE" }]);
  });

  it("bounds repeated error details while retaining the total error count", async () => {
    let clock = new Date("2026-07-15T00:00:00.000Z");
    const executor = {
      ...idleExecutor(),
      consumeAvailableSignals: async () => { throw new Error("ORDERBOOK_UNAVAILABLE"); },
    } as unknown as PaperExecutor;

    const report = await new PaperRunner(executor, {
      accountId: "paper",
      intervalMs: 1_000,
      durationMs: 3_000,
      reportDetailLimit: 2,
      now: () => clock,
      wait: async (milliseconds) => { clock = new Date(clock.valueOf() + milliseconds); },
    }).run();

    expect(report.errorCount).toBe(3);
    expect(report.errors).toHaveLength(2);
    expect(report.droppedErrorCount).toBe(1);
    expect(report.errors.every((error) => error.message === "ORDERBOOK_UNAVAILABLE")).toBe(true);
  });

  it("does not classify an incomplete final valuation as completed", () => {
    const report = {
      accountId: "paper",
      startedAt: "2026-07-15T00:00:00.000Z",
      stoppedAt: "2026-07-15T00:00:01.000Z",
      cycles: 1,
      consumedSignals: 0,
      errorCount: 0,
      droppedErrorCount: 0,
      errors: [],
      account: {
        ...accountSnapshot,
        valuationStatus: "INCOMPLETE" as const,
        unpricedPositionCount: 1,
        priceSource: "UNAVAILABLE" as const,
      },
    };

    expect(paperRunCompletionStatus(report)).toBe("COMPLETED_INCOMPLETE_VALUATION");
    expect(paperRunCompletionStatus({ ...report, errorCount: 1 })).toBe("COMPLETED_WITH_ERRORS");
    expect(paperRunCompletionStatus({ ...report, account: accountSnapshot })).toBe("COMPLETED");
  });
});
