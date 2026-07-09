import type { ValidationCheckResult, ValidationType } from "./types.js";

export function check(input: {
  checkType: ValidationType;
  checkName: string;
  status: ValidationCheckResult["status"];
  blocking?: boolean;
  reason: string;
  metrics?: Record<string, unknown>;
  error?: Record<string, unknown>;
  now: () => Date;
}): ValidationCheckResult {
  const timestamp = input.now().toISOString();
  const result: ValidationCheckResult = {
    checkType: input.checkType,
    checkName: input.checkName,
    status: input.status,
    blocking: input.blocking ?? input.status === "FAIL",
    reason: input.reason,
    startedAt: timestamp,
    finishedAt: timestamp,
  };
  if (input.metrics !== undefined) result.metrics = input.metrics;
  if (input.error !== undefined) result.error = input.error;
  return result;
}

export function errorCheck(input: {
  checkType: ValidationType;
  checkName: string;
  reason: string;
  error: unknown;
  now: () => Date;
}): ValidationCheckResult {
  return check({
    checkType: input.checkType,
    checkName: input.checkName,
    status: "FAIL",
    blocking: true,
    reason: input.reason,
    error: {
      message: input.error instanceof Error ? input.error.message : String(input.error),
    },
    now: input.now,
  });
}
