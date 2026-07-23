import type { DatabaseSync } from "node:sqlite";
import { buyMinimumLiftEligibility } from "../execution/buy-minimum-eligibility.js";
import type { BuyMinimumLiftEligibility } from "../execution/buy-amount-policy.js";

/** Shared Live definition for initial sizing and the final execution-time
 * recheck. The optional exclusion lets an already-persisted BUY revalidate
 * itself without treating its own reservation as a competing entry. */
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
