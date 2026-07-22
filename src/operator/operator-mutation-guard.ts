import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const OPERATOR_ACTIVE_LOCK = "data/operator/run/active.lock";
export const OPERATOR_DATABASE_FILE = "data/phase0/phase0.sqlite";

export type OperatorMutationBlockedReason =
  | "OPERATOR_LOCK_PRESENT"
  | "DATABASE_GATE_UNAVAILABLE"
  | "DATABASE_NOT_PAPER_LIVE_DISABLED";

export interface OperatorRuntimeSafety {
  operatorLocked: boolean;
  databaseAvailable: boolean;
  executionMode: string | null;
  liveGateState: string | null;
  mutationBlockedReason: OperatorMutationBlockedReason | null;
}

function tableExists(database: DatabaseSync, table: string): boolean {
  return database.prepare(
    "SELECT 1 ok FROM sqlite_master WHERE type='table' AND name=?",
  ).get(table) !== undefined;
}

/**
 * Reads the two independent operator mutation gates without initializing or
 * changing the database. A missing database is valid for first-time setup; an
 * existing database without an exact PAPER + LIVE_DISABLED state fails closed.
 */
export function operatorRuntimeSafety(projectRoot: string): OperatorRuntimeSafety {
  const operatorLocked = existsSync(resolve(projectRoot, OPERATOR_ACTIVE_LOCK));
  const databasePath = resolve(projectRoot, OPERATOR_DATABASE_FILE);
  const databaseAvailable = existsSync(databasePath);
  let executionMode: string | null = null;
  let liveGateState: string | null = null;

  if (databaseAvailable) {
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      database.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=5000;");
      if (tableExists(database, "live_gate_state")) {
        const row = database.prepare(
          "SELECT execution_mode,live_gate_state FROM live_gate_state WHERE state_id='default'",
        ).get() as { execution_mode: string; live_gate_state: string } | undefined;
        executionMode = row?.execution_mode ?? null;
        liveGateState = row?.live_gate_state ?? null;
      }
    } finally {
      database.close();
    }
  }

  const mutationBlockedReason: OperatorMutationBlockedReason | null = operatorLocked
    ? "OPERATOR_LOCK_PRESENT"
    : !databaseAvailable
      ? null
      : executionMode === null || liveGateState === null
        ? "DATABASE_GATE_UNAVAILABLE"
        : executionMode === "PAPER" && liveGateState === "LIVE_DISABLED"
          ? null
          : "DATABASE_NOT_PAPER_LIVE_DISABLED";

  return {
    operatorLocked,
    databaseAvailable,
    executionMode,
    liveGateState,
    mutationBlockedReason,
  };
}

export function assertOperatorMutationAllowed(projectRoot: string, operation: string): void {
  const safety = operatorRuntimeSafety(projectRoot);
  if (safety.mutationBlockedReason === null) return;
  if (safety.mutationBlockedReason === "OPERATOR_LOCK_PRESENT") {
    throw new Error(`${operation}_BLOCKED_BY_OPERATOR_LOCK:${OPERATOR_ACTIVE_LOCK}`);
  }
  throw new Error(`${operation}_BLOCKED:${safety.mutationBlockedReason}`);
}
