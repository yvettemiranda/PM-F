import { createHash } from "node:crypto";
import { decimalToScaled, SHARE_SCALE_DIGITS } from "../domain/fixed.js";
import type { PublicPosition, SyncStatus } from "../domain/models.js";
import { RULESET, stableJson } from "../domain/versioning.js";
import type { ObserveProjectionEntry, ReconciliationResult } from "./types.js";

function absolute(value: bigint): bigint {
  return value < 0n ? -value : value;
}

export function reconcileProjection(
  projection: ObserveProjectionEntry[],
  positions: PublicPosition[],
  previousConsecutiveDiffs = 0,
): ReconciliationResult {
  const expected = new Map(projection.map((entry) => [entry.asset, BigInt(entry.expectedTotalMicros)]));
  const observed = new Map(positions.map((position) => [position.asset, decimalToScaled(position.size, SHARE_SCALE_DIGITS)]));
  const assets = new Set([...expected.keys(), ...observed.keys()]);
  const details: ReconciliationResult["details"] = [];
  for (const asset of assets) {
    const expectedValue = expected.get(asset) ?? 0n;
    const observedValue = observed.get(asset) ?? 0n;
    const difference = observedValue - expectedValue;
    const relativeTolerance = (absolute(observedValue) * BigInt(RULESET.reconciliationRelativeTolerancePpm)) / 1_000_000n;
    const absoluteTolerance = BigInt(RULESET.reconciliationShareAbsToleranceMicros);
    const tolerance = relativeTolerance > absoluteTolerance ? relativeTolerance : absoluteTolerance;
    if (absolute(difference) > tolerance) {
      details.push({
        asset,
        expectedMicros: expectedValue.toString(),
        observedMicros: observedValue.toString(),
        differenceMicros: difference.toString(),
        toleranceMicros: tolerance.toString(),
      });
    }
  }
  let syncStatus: SyncStatus = "SYNCED";
  if (details.length > 0) {
    syncStatus = previousConsecutiveDiffs + 1 >= RULESET.majorDesyncConsecutiveCount ? "MAJOR_DESYNC" : "MINOR_DIFF";
  }
  const observedRows = [...observed.entries()]
    .filter(([, size]) => size !== 0n)
    .map(([asset, size]) => ({ asset, sizeMicros: size.toString() }))
    .sort((a, b) => a.asset.localeCompare(b.asset));
  return {
    syncStatus,
    issueCount: details.length,
    observedPositionsHash: createHash("sha256").update(stableJson(observedRows)).digest("hex"),
    details,
  };
}
