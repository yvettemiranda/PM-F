import type { DatabaseSync } from "node:sqlite";
import {
  buyAmountPolicyDecisionCarriesAmplifiedLineage,
  type BuyMinimumLiftEligibility,
} from "./buy-amount-policy.js";

type BuyMinimumMode = "PAPER" | "LIVE";

interface ModeTables {
  positionTable: "paper_positions" | "live_positions";
  executionTable: "paper_executions" | "live_executions";
  accountColumn: "paper_account_id" | "live_account_id";
  executionIdColumn: "paper_execution_id" | "live_execution_id";
}

function modeTables(mode: BuyMinimumMode): ModeTables {
  return mode === "PAPER" ? {
    positionTable: "paper_positions",
    executionTable: "paper_executions",
    accountColumn: "paper_account_id",
    executionIdColumn: "paper_execution_id",
  } : {
    positionTable: "live_positions",
    executionTable: "live_executions",
    accountColumn: "live_account_id",
    executionIdColumn: "live_execution_id",
  };
}

function amplifiedPolicyInChecks(checksJson: string | null): boolean {
  if (!checksJson) return false;
  try {
    const checks = JSON.parse(checksJson) as unknown;
    if (!Array.isArray(checks)) return false;
    for (const check of checks) {
      if (!check || typeof check !== "object" || Array.isArray(check)) continue;
      const row = check as Record<string, unknown>;
      if (row.name !== "buy_amount_policy" || row.result !== "PASS" || typeof row.detail !== "string") continue;
      try {
        if (buyAmountPolicyDecisionCarriesAmplifiedLineage(JSON.parse(row.detail))) return true;
      } catch {
        // Malformed historical evidence never grants amplification lineage.
      }
    }
    return false;
  } catch {
    return false;
  }
}

/** A lineage exists only after a BUY produced a positive persisted position
 * whose opening Risk Decision proves either the root lift or inherited lineage.
 * Waiting or rejected BUYs can therefore never activate inheritance. */
export function buyMinimumLiftEligibility(input: {
  database: DatabaseSync;
  mode: BuyMinimumMode;
  accountId: string;
  assetId: string;
  excludeExecutionId?: string;
}): BuyMinimumLiftEligibility {
  const tables = modeTables(input.mode);
  const positions = input.database.prepare(
    `SELECT p.current_size_micros,r.checks_json
     FROM ${tables.positionTable} p
     JOIN ${tables.executionTable} e ON e.${tables.executionIdColumn}=p.opening_execution_id
     LEFT JOIN risk_decisions r ON r.risk_decision_id=e.risk_decision_id
     WHERE p.${tables.accountColumn}=? AND p.asset_id=?`,
  ).all(input.accountId, input.assetId) as unknown as Array<{
    current_size_micros: string;
    checks_json: string | null;
  }>;
  const openPositions = positions.filter((position) => BigInt(position.current_size_micros) > 0n);
  if (openPositions.length > 0) {
    return openPositions.some((position) => amplifiedPolicyInChecks(position.checks_json))
      ? "AMPLIFIED_POSITION"
      : "NONE";
  }
  const pending = input.database.prepare(
    `SELECT 1 present FROM ${tables.executionTable}
     WHERE ${tables.accountColumn}=? AND asset_id=? AND execution_type='TARGET_BUY'
       AND state='WAITING_EXECUTION'
       AND (? IS NULL OR ${tables.executionIdColumn}<>?)
     LIMIT 1`,
  ).get(
    input.accountId,
    input.assetId,
    input.excludeExecutionId ?? null,
    input.excludeExecutionId ?? null,
  );
  return pending ? "NONE" : "FIRST_ENTRY";
}
