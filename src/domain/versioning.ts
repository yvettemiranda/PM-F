import { createHash } from "node:crypto";

export const VERSIONS = Object.freeze({
  schemaVersion: "1.5.0",
  signalVersion: "1.3.0",
  strategyVersion: "1.2.0",
  riskVersion: "1.0.0",
  replayVersion: "1.5.0",
});

export const RULESET = Object.freeze({
  buyExecutionMode: "FAK",
  buyPriceMinRatioPpm: 980_000,
  buyPriceMaxRatioPpm: 1_020_000,
  waitRatioPpm: 500_000,
  maxWaitMs: 30 * 60 * 1_000,
  followSellMaxSlippagePpm: 100_000,
  stopSellMaxSlippagePpm: 150_000,
  stopTriggerRatioPpm: 500_000,
  capitalTimeToleranceMs: 5 * 60 * 1_000,
  fallbackAmountMicros: 10_000_000,
  reconciliationShareAbsToleranceMicros: 100_000,
  reconciliationCashAbsToleranceMicros: 10_000,
  reconciliationRelativeTolerancePpm: 1_000,
  reconciliationGraceMs: 120_000,
  majorDesyncConsecutiveCount: 3,
  requestTimeoutMs: 3_000,
  maxRetryCount: 3,
  backoffFactor: 2,
  maxBackoffMs: 30_000,
  clockUnsafeThresholdMs: 1_000,
  orderbookMaxAgeMs: 2_000,
});

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, stable(child)]),
    );
  }
  return value;
}

export function stableJson(value: unknown): string {
  return JSON.stringify(stable(value));
}

export const RULESET_SNAPSHOT_JSON = stableJson({ versions: VERSIONS, rules: RULESET });
export const RULESET_HASH = createHash("sha256").update(RULESET_SNAPSHOT_JSON).digest("hex");
