import type { DatabaseSync } from "node:sqlite";

/** Shared first-entry definition for Live sizing and the final execution-time
 * recheck. The optional exclusion lets an already-persisted BUY revalidate
 * itself without treating its own reservation as a competing first entry. */
export function isLiveFirstEntryBuyEligible(
  database: DatabaseSync,
  accountId: string,
  assetId: string,
  excludeExecutionId?: string,
): boolean {
  const positions = database.prepare(
    `SELECT current_size_micros FROM live_positions
     WHERE live_account_id=? AND asset_id=?`,
  ).all(accountId, assetId) as unknown as Array<{ current_size_micros: string }>;
  if (positions.some((position) => BigInt(position.current_size_micros) > 0n)) return false;
  const pending = database.prepare(
    `SELECT 1 present FROM live_executions
     WHERE live_account_id=? AND asset_id=? AND execution_type='TARGET_BUY'
       AND state='WAITING_EXECUTION'
       AND (? IS NULL OR live_execution_id<>?)
     LIMIT 1`,
  ).get(accountId, assetId, excludeExecutionId ?? null, excludeExecutionId ?? null);
  return !pending;
}
