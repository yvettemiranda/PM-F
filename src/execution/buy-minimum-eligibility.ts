import type { DatabaseSync } from "node:sqlite";
import {
  buyAmountPolicyDecisionCarriesAmplifiedLineage,
  type BuyMinimumLiftEligibility,
} from "./buy-amount-policy.js";

type BuyMinimumMode = "PAPER" | "LIVE";

function amplifiedPolicyInChecks(checksJson: string | null): boolean {
  if (!checksJson) return false;
  try {
    const checks = JSON.parse(checksJson) as unknown;
    if (!Array.isArray(checks)) return false;
    return checks.some((check) => {
      if (!check || typeof check !== "object" || Array.isArray(check)) return false;
      const row = check as Record<string, unknown>;
      if (row.name !== "buy_amount_policy" || row.result !== "PASS" || typeof row.detail !== "string") {
        return false;
      }
      try {
        return buyAmountPolicyDecisionCarriesAmplifiedLineage(JSON.parse(row.detail));
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

/** Historical v1.8 lineage rule. Current rulesets do not call this helper. */
export function buyMinimumLiftEligibility(input: {
  database: DatabaseSync;
  mode: BuyMinimumMode;
  accountId: string;
  assetId: string;
  excludeExecutionId?: string;
}): BuyMinimumLiftEligibility {
  const paper = input.mode === "PAPER";
  const positionTable = paper ? "paper_positions" : "live_positions";
  const executionTable = paper ? "paper_executions" : "live_executions";
  const accountColumn = paper ? "paper_account_id" : "live_account_id";
  const executionIdColumn = paper ? "paper_execution_id" : "live_execution_id";
  const positions = input.database.prepare(
    `SELECT p.current_size_micros,r.checks_json
     FROM ${positionTable} p
     JOIN ${executionTable} e ON e.${executionIdColumn}=p.opening_execution_id
     LEFT JOIN risk_decisions r ON r.risk_decision_id=e.risk_decision_id
     WHERE p.${accountColumn}=? AND p.asset_id=?`,
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
    `SELECT 1 present FROM ${executionTable}
     WHERE ${accountColumn}=? AND asset_id=? AND execution_type='TARGET_BUY'
       AND state='WAITING_EXECUTION'
       AND (? IS NULL OR ${executionIdColumn}<>?)
     LIMIT 1`,
  ).get(
    input.accountId,
    input.assetId,
    input.excludeExecutionId ?? null,
    input.excludeExecutionId ?? null,
  );
  return pending ? "NONE" : "FIRST_ENTRY";
}
