import type { PublicActivity, PublicTrade } from "./models.js";

/** Normalizes an Activity TRADE into the same immutable identity used by Trades. */
export function activityAsTrade(activity: PublicActivity): PublicTrade | null {
  if (
    activity.type !== "TRADE"
    || !activity.conditionId
    || !activity.asset
    || (activity.side !== "BUY" && activity.side !== "SELL")
    || activity.price === undefined
    || activity.size === undefined
  ) return null;
  return {
    proxyWallet: activity.proxyWallet,
    transactionHash: activity.transactionHash,
    conditionId: activity.conditionId,
    asset: activity.asset,
    side: activity.side,
    price: activity.price,
    size: activity.size,
    timestamp: activity.timestamp,
    ...(activity.outcome !== undefined ? { outcome: activity.outcome } : {}),
    ...(activity.title !== undefined ? { title: activity.title } : {}),
  };
}
