import { createHash } from "node:crypto";
import { decimalToScaled, PRICE_SCALE_DIGITS, SHARE_SCALE_DIGITS } from "../domain/fixed.js";
import type { IdentityStatus, PublicPosition, SyncStatus } from "../domain/models.js";
import { RULESET, RULESET_HASH, stableJson } from "../domain/versioning.js";

export type CapitalEstimateStatus = "COMPLETE" | "INCOMPLETE" | "FAILED";
export type CapitalConfidence = "HIGH" | "MEDIUM" | "LOW";

export interface CapitalEstimate {
  capitalEstimateId: string;
  positionValueMicros: string | null;
  walletBalanceMicros: string | null;
  targetVisibleCapitalMicros: string | null;
  targetTradeAmountMicros: string | null;
  targetTradeCapitalRatioPpm: string | null;
  capitalEstimateStatus: CapitalEstimateStatus;
  capitalConfidence: CapitalConfidence;
  capitalEstimateReason: string;
  positionSnapshotTime: string | null;
  walletBalanceSnapshotTime: string | null;
  targetTradeTimestamp: string | null;
  fallbackAmountMicros: string;
}

function positionValueMicros(positions: readonly PublicPosition[]): bigint {
  return positions.reduce((sum, position) => sum + decimalToScaled(position.currentValue, 6), 0n);
}

function tradeValueMicros(price: number | string, size: number | string): bigint {
  const priceUnits = decimalToScaled(price, PRICE_SCALE_DIGITS);
  const sizeMicros = decimalToScaled(size, SHARE_SCALE_DIGITS);
  return (priceUnits * sizeMicros) / 10n ** BigInt(PRICE_SCALE_DIGITS);
}

export function estimateTargetCapital(input: {
  walletAddress: string;
  sourceEventKey?: string | null;
  identityStatus: IdentityStatus;
  syncStatus: SyncStatus;
  positions: PublicPosition[] | null;
  positionSnapshotTime: string | null;
  walletBalanceMicros: bigint | null;
  walletBalanceSnapshotTime: string | null;
  targetTrade?: { price: number | string; size: number | string; timestamp: number };
}): CapitalEstimate {
  const fallbackAmountMicros = BigInt(RULESET.fallbackAmountMicros);
  const tradeTimestamp = input.targetTrade ? new Date(input.targetTrade.timestamp * 1_000).toISOString() : null;
  const referenceTime = tradeTimestamp
    ? Date.parse(tradeTimestamp)
    : Math.max(
      input.positionSnapshotTime ? Date.parse(input.positionSnapshotTime) : Number.NEGATIVE_INFINITY,
      input.walletBalanceSnapshotTime ? Date.parse(input.walletBalanceSnapshotTime) : Number.NEGATIVE_INFINITY,
    );
  const positionFresh = input.positions !== null && input.positionSnapshotTime !== null
    && Math.abs(Date.parse(input.positionSnapshotTime) - referenceTime) <= RULESET.capitalTimeToleranceMs;
  const balanceFresh = input.walletBalanceMicros !== null && input.walletBalanceSnapshotTime !== null
    && Math.abs(Date.parse(input.walletBalanceSnapshotTime) - referenceTime) <= RULESET.capitalTimeToleranceMs;
  const positionValue = input.positions === null ? null : positionValueMicros(input.positions);
  const tradeAmount = input.targetTrade ? tradeValueMicros(input.targetTrade.price, input.targetTrade.size) : null;

  let status: CapitalEstimateStatus;
  let confidence: CapitalConfidence;
  let reason: string;
  let visibleCapital: bigint | null = null;
  let ratioPpm: bigint | null = null;

  if (input.identityStatus !== "IDENTITY_CONFIRMED" || input.syncStatus === "MAJOR_DESYNC") {
    status = "FAILED";
    confidence = "LOW";
    reason = input.identityStatus !== "IDENTITY_CONFIRMED" ? "IDENTITY_NOT_CONFIRMED" : "MAJOR_DESYNC";
  } else if (positionFresh && balanceFresh && positionValue !== null && input.walletBalanceMicros !== null) {
    visibleCapital = positionValue + input.walletBalanceMicros;
    if (visibleCapital < 0n || input.walletBalanceMicros < 0n) {
      status = "FAILED";
      confidence = "LOW";
      reason = "NEGATIVE_CAPITAL_COMPONENT";
      visibleCapital = null;
    } else {
      status = "COMPLETE";
      confidence = "HIGH";
      reason = "POSITION_AND_PUSD_BALANCE_FRESH";
      if (tradeAmount !== null && visibleCapital > 0n) ratioPpm = (tradeAmount * 1_000_000n) / visibleCapital;
    }
  } else {
    status = "INCOMPLETE";
    confidence = "MEDIUM";
    reason = !positionFresh && !balanceFresh
      ? "POSITION_AND_BALANCE_MISSING_OR_STALE"
      : !positionFresh
        ? "POSITION_SNAPSHOT_MISSING_OR_STALE"
        : "WALLET_BALANCE_MISSING_OR_STALE";
  }

  const identity = stableJson({
    walletAddress: input.walletAddress.toLowerCase(),
    sourceEventKey: input.sourceEventKey ?? null,
    identityStatus: input.identityStatus,
    syncStatus: input.syncStatus,
    positionValueMicros: positionValue?.toString() ?? null,
    walletBalanceMicros: input.walletBalanceMicros?.toString() ?? null,
    targetVisibleCapitalMicros: visibleCapital?.toString() ?? null,
    targetTradeAmountMicros: tradeAmount?.toString() ?? null,
    targetTradeCapitalRatioPpm: ratioPpm?.toString() ?? null,
    capitalEstimateStatus: status,
    capitalConfidence: confidence,
    capitalEstimateReason: reason,
    positionSnapshotTime: input.positionSnapshotTime,
    walletBalanceSnapshotTime: input.walletBalanceSnapshotTime,
    targetTradeTimestamp: tradeTimestamp,
    fallbackAmountMicros: fallbackAmountMicros.toString(),
    rulesetHash: RULESET_HASH,
  });
  return {
    capitalEstimateId: createHash("sha256").update(identity).digest("hex"),
    positionValueMicros: positionValue?.toString() ?? null,
    walletBalanceMicros: input.walletBalanceMicros?.toString() ?? null,
    targetVisibleCapitalMicros: visibleCapital?.toString() ?? null,
    targetTradeAmountMicros: tradeAmount?.toString() ?? null,
    targetTradeCapitalRatioPpm: ratioPpm?.toString() ?? null,
    capitalEstimateStatus: status,
    capitalConfidence: confidence,
    capitalEstimateReason: reason,
    positionSnapshotTime: input.positionSnapshotTime,
    walletBalanceSnapshotTime: input.walletBalanceSnapshotTime,
    targetTradeTimestamp: tradeTimestamp,
    fallbackAmountMicros: fallbackAmountMicros.toString(),
  };
}
