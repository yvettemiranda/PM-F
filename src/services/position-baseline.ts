import { createHash } from "node:crypto";
import { decimalToScaled, PRICE_SCALE_DIGITS, SHARE_SCALE_DIGITS } from "../domain/fixed.js";
import type { PublicPosition } from "../domain/models.js";
import { stableJson } from "../domain/versioning.js";

export interface PositionBaselineItem {
  baselineItemId: string;
  conditionId: string;
  asset: string;
  marketSlug: string | null;
  marketTitle: string | null;
  outcome: string | null;
  sizeMicros: string;
  averagePriceUnits: string;
  snapshotTime: string;
}

export interface PositionBaseline {
  baselineRunId: string;
  captureRunId: string;
  targetId: string;
  walletAddress: string;
  status: "READY";
  cutoffFrom: string;
  cutoffTo: string;
  snapshotTime: string;
  positionCaptureId: string;
  items: PositionBaselineItem[];
}

export function buildPositionBaseline(input: {
  captureRunId: string;
  targetId: string;
  walletAddress: string;
  positionCaptureId: string;
  fetchedAt: string;
  latencyMs: number;
  positions: PublicPosition[];
}): PositionBaseline {
  const walletAddress = input.walletAddress.toLowerCase();
  const duplicateAssets = new Set<string>();
  const seenAssets = new Set<string>();
  const cutoffTo = new Date(input.fetchedAt).toISOString();
  const cutoffFrom = new Date(Date.parse(input.fetchedAt) - input.latencyMs).toISOString();
  const items = input.positions.map((position) => {
    if (position.proxyWallet.toLowerCase() !== walletAddress) {
      throw new Error(`Position wallet mismatch: ${position.proxyWallet}`);
    }
    if (seenAssets.has(position.asset)) duplicateAssets.add(position.asset);
    seenAssets.add(position.asset);
    const body = {
      conditionId: position.conditionId.toLowerCase(),
      asset: position.asset,
      marketSlug: position.slug ?? null,
      marketTitle: position.title ?? null,
      outcome: position.outcome ?? null,
      sizeMicros: decimalToScaled(position.size, SHARE_SCALE_DIGITS).toString(),
      averagePriceUnits: decimalToScaled(position.avgPrice, PRICE_SCALE_DIGITS).toString(),
      snapshotTime: cutoffTo,
    };
    if (BigInt(body.sizeMicros) < 0n) throw new Error(`Negative baseline position: ${position.asset}`);
    return {
      baselineItemId: createHash("sha256").update(`${input.captureRunId}|${stableJson(body)}`).digest("hex"),
      ...body,
    };
  });
  if (duplicateAssets.size > 0) throw new Error(`Duplicate baseline assets: ${[...duplicateAssets].join(",")}`);
  const baselineBody = {
    captureRunId: input.captureRunId,
    targetId: input.targetId,
    walletAddress,
    cutoffFrom,
    cutoffTo,
    snapshotTime: cutoffTo,
    positionCaptureId: input.positionCaptureId,
    items,
  };
  return {
    baselineRunId: createHash("sha256").update(stableJson(baselineBody)).digest("hex"),
    status: "READY",
    ...baselineBody,
  };
}
