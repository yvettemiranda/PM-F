import { createHash } from "node:crypto";
import { decimalToScaled, PRICE_SCALE_DIGITS, SHARE_SCALE_DIGITS } from "./fixed.js";
import type { PublicActivity, PublicTrade, SignalType } from "./models.js";

function hash(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\u001f")).digest("hex");
}

export const SOURCE_IDENTITY_VERSION = "v1.1.0";
export const ACTIVITY_IDENTITY_VERSION = "v1.0.0";

export function sourceEventKey(trade: PublicTrade): string {
  return hash([
    SOURCE_IDENTITY_VERSION,
    trade.proxyWallet.toLowerCase(),
    trade.transactionHash.toLowerCase(),
    trade.conditionId.toLowerCase(),
    trade.asset,
    trade.side,
    decimalToScaled(trade.price, PRICE_SCALE_DIGITS).toString(),
    decimalToScaled(trade.size, SHARE_SCALE_DIGITS).toString(),
    String(trade.timestamp),
  ]);
}

export function signalIdempotencyKey(sourceKey: string, type: SignalType, signalVersion: string): string {
  return hash([sourceKey, type, signalVersion]);
}

export function activityEventKey(activity: PublicActivity): string {
  return hash([
    ACTIVITY_IDENTITY_VERSION,
    "ACTIVITY",
    activity.proxyWallet.toLowerCase(),
    activity.transactionHash.toLowerCase(),
    activity.type,
    activity.conditionId?.toLowerCase() ?? "NONE",
    activity.asset ?? "NONE",
    activity.side ?? "NONE",
    activity.price === undefined ? "NONE" : String(activity.price),
    activity.size === undefined ? "NONE" : String(activity.size),
    String(activity.timestamp),
  ]);
}

export function executionIdempotencyKey(
  signalId: string,
  consumerMode: "PAPER" | "LIVE",
  positionId: string | null,
  actionSequence: number,
): string {
  return hash([signalId, consumerMode, positionId ?? "NONE", String(actionSequence)]);
}
