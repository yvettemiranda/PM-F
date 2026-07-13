import { describe, expect, it } from "vitest";
import type { PaperExecutor } from "../src/paper/paper-executor.js";
import { PaperRunner } from "../src/paper/paper-runner.js";

const unusedExecutor = {} as PaperExecutor;

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
});
