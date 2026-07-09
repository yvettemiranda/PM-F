import type { OperationalStore } from "./operational-store.js";
import type { OperationalSeverity } from "./types.js";

export function recordOperationalError(input: {
  store: OperationalStore;
  operationalRunId: string;
  module: string;
  error: unknown;
  severity?: OperationalSeverity;
  now: () => Date;
  context?: Record<string, unknown>;
}): void {
  const error = input.error instanceof Error ? input.error : new Error(String(input.error));
  input.store.recordAnomaly({
    operationalRunId: input.operationalRunId,
    timestamp: input.now().toISOString(),
    module: input.module,
    severity: input.severity ?? "ERROR",
    errorCode: error.message,
    context: input.context ?? {},
    stackTrace: error.stack ?? null,
  });
}

