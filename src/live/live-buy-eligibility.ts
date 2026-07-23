import type { DatabaseSync } from "node:sqlite";
import { buyMinimumLiftEligibility } from "../execution/buy-minimum-eligibility.js";
import type { BuyMinimumLiftEligibility } from "../execution/buy-amount-policy.js";

/** Historical v1.8 Live lineage rule. Current rulesets use per-trade classes. */
export function liveBuyMinimumLiftEligibility(
  database: DatabaseSync,
  accountId: string,
  assetId: string,
  excludeExecutionId?: string,
): BuyMinimumLiftEligibility {
  return buyMinimumLiftEligibility({
    database,
    mode: "LIVE",
    accountId,
    assetId,
    ...(excludeExecutionId ? { excludeExecutionId } : {}),
  });
}
