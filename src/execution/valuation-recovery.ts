export interface ValuationRecoveryPolicy {
  maxAttempts?: number;
  backoffMs?: readonly number[];
  wait?: (milliseconds: number) => Promise<void>;
  signal?: AbortSignal;
}

export interface ValuationRecoveryResult<T> {
  value: T;
  attempts: number;
  recovered: boolean;
  status: "COMPLETE" | "INCOMPLETE";
}

/**
 * Retries only an append-only/read-only valuation projection. Callers must do
 * every order cancellation or execution drain before entering this helper.
 */
export async function recoverIncompleteValuation<T extends {
  valuationStatus: string;
  unpricedPositionCount: number;
}>(
  capture: () => Promise<T>,
  policy: ValuationRecoveryPolicy = {},
): Promise<ValuationRecoveryResult<T>> {
  const maxAttempts = policy.maxAttempts ?? 3;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts <= 0) {
    throw new Error("VALUATION_RECOVERY_MAX_ATTEMPTS_INVALID");
  }
  const backoffMs = policy.backoffMs ?? [1_000, 3_000];
  if (backoffMs.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new Error("VALUATION_RECOVERY_BACKOFF_INVALID");
  }
  const wait = policy.wait ?? ((milliseconds: number) => (
    new Promise((resolve) => setTimeout(resolve, milliseconds))
  ));
  let latest!: T;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (policy.signal?.aborted) throw policy.signal.reason ?? new Error("VALUATION_RECOVERY_ABORTED");
    latest = await capture();
    const complete = latest.valuationStatus === "COMPLETE"
      && latest.unpricedPositionCount === 0;
    if (complete) {
      return {
        value: latest,
        attempts: attempt,
        recovered: attempt > 1,
        status: "COMPLETE",
      };
    }
    if (attempt < maxAttempts) {
      const delay = backoffMs[Math.min(attempt - 1, backoffMs.length - 1)] ?? 0;
      if (delay > 0) await wait(delay);
    }
  }
  return {
    value: latest,
    attempts: maxAttempts,
    recovered: false,
    status: "INCOMPLETE",
  };
}
