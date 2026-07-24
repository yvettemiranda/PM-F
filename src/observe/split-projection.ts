import { createHash } from "node:crypto";
import type { ClobMarket } from "../adapters/polymarket-public.js";
import type { PublicActivity, PublicPosition } from "../domain/models.js";
import { decimalToScaled, SHARE_SCALE_DIGITS } from "../domain/fixed.js";
import { stableJson } from "../domain/versioning.js";
import { verifiedBinaryMarketOutcomeAssets } from "../signal-context/market-outcome-set.js";

export interface VerifiedSplitProjection {
  transactionHash: string;
  conditionId: string;
  outcomeAssets: string[];
  amountMicros: string;
  marketSourceUrl: string;
  marketFetchedAt: string;
  marketSnapshotJson: string;
  marketSnapshotHash: string;
  positionsSnapshotTime: string;
  positionsSnapshotJson: string;
  positionsSnapshotHash: string;
  evidenceHash: string;
}

export function splitProjectionEvidenceHash(
  value: Omit<VerifiedSplitProjection, "evidenceHash">,
): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

/**
 * Proves only the deterministic position projection of a public SPLIT. It
 * deliberately does not make the operation executable: the copied account
 * does not perform a chain write and the new target legs enter the historical
 * bucket. The same-poll Positions reconciliation is the second half of the
 * proof and is enforced by ObserveRunner before this evidence is committed.
 */
export function verifySplitProjection(input: {
  activity: PublicActivity;
  market: ClobMarket;
  marketSourceUrl: string;
  marketFetchedAt: string;
  positions: readonly PublicPosition[];
  positionsSnapshotTime: string;
}): VerifiedSplitProjection {
  if (input.activity.type !== "SPLIT") throw new Error("SPLIT_ACTIVITY_TYPE_INVALID");
  const transactionHash = input.activity.transactionHash.trim().toLowerCase();
  if (!transactionHash) throw new Error("SPLIT_TRANSACTION_HASH_MISSING");
  const conditionId = input.activity.conditionId?.trim().toLowerCase();
  if (!conditionId) throw new Error("SPLIT_CONDITION_ID_MISSING");
  if (input.activity.size === undefined) throw new Error("SPLIT_AMOUNT_MISSING");
  const amountMicros = decimalToScaled(input.activity.size, SHARE_SCALE_DIGITS);
  if (amountMicros <= 0n) throw new Error("SPLIT_AMOUNT_INVALID");
  if (!input.marketSourceUrl.trim()) throw new Error("SPLIT_MARKET_SOURCE_URL_MISSING");
  if (!Number.isFinite(Date.parse(input.marketFetchedAt))) throw new Error("SPLIT_MARKET_FETCHED_AT_INVALID");
  if (!Number.isFinite(Date.parse(input.positionsSnapshotTime))) {
    throw new Error("SPLIT_POSITIONS_SNAPSHOT_TIME_INVALID");
  }
  const outcomeAssets = verifiedBinaryMarketOutcomeAssets(input.market, conditionId);
  const marketSnapshotJson = stableJson(input.market);
  const positionsSnapshotJson = stableJson(input.positions);
  const withoutHash = {
    transactionHash,
    conditionId,
    outcomeAssets,
    amountMicros: amountMicros.toString(),
    marketSourceUrl: input.marketSourceUrl,
    marketFetchedAt: input.marketFetchedAt,
    marketSnapshotJson,
    marketSnapshotHash: createHash("sha256").update(marketSnapshotJson).digest("hex"),
    positionsSnapshotTime: input.positionsSnapshotTime,
    positionsSnapshotJson,
    positionsSnapshotHash: createHash("sha256").update(positionsSnapshotJson).digest("hex"),
  };
  return { ...withoutHash, evidenceHash: splitProjectionEvidenceHash(withoutHash) };
}
