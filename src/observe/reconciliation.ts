import { createHash } from "node:crypto";
import { decimalToScaled, SHARE_SCALE_DIGITS } from "../domain/fixed.js";
import type { PublicPosition, SyncStatus } from "../domain/models.js";
import { RULESET, stableJson } from "../domain/versioning.js";
import type {
  ObserveProjectionEntry,
  ReconciliationHistoryReport,
  ReconciliationResult,
  ReconciliationDetail,
  SourceEventMultiplicityAmbiguity,
  UnsupportedTargetActivity,
  SourceEventOrderAmbiguity,
} from "./types.js";

function absolute(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function issueIdentity(detail: ReconciliationDetail): string {
  if (detail.issueType === "SOURCE_EVENT_ORDER_AMBIGUOUS") return stableJson({
    issueType: detail.issueType, sourceEventKey: detail.sourceEventKey, sourceTimestamp: detail.sourceTimestamp, conditionId: detail.conditionId,
  });
  if (detail.issueType === "POSITION_QUANTITY_DIFF") {
    return stableJson({
      issueType: detail.issueType,
      asset: detail.asset,
      differenceMicros: detail.differenceMicros,
    });
  }
  if (detail.issueType === "SOURCE_EVENT_MULTIPLICITY_AMBIGUOUS") {
    return stableJson({
      issueType: detail.issueType,
      sourceEventKey: detail.sourceEventKey,
      tradesCount: detail.tradesCount,
      activityCount: detail.activityCount,
    });
  }
  return stableJson({
    issueType: detail.issueType,
    sourceEventKey: detail.sourceEventKey,
    activityType: detail.activityType,
  });
}

export function reconcileProjection(
  projection: ObserveProjectionEntry[],
  positions: PublicPosition[],
  observedAt: string,
  previousReport: ReconciliationHistoryReport | null,
  sourceEventAmbiguities: readonly SourceEventMultiplicityAmbiguity[] = [],
  unsupportedActivities: readonly UnsupportedTargetActivity[] = [],
  orderingAmbiguities: readonly SourceEventOrderAmbiguity[] = [],
): ReconciliationResult {
  const observedAtMs = Date.parse(observedAt);
  if (!Number.isFinite(observedAtMs)) throw new Error("RECONCILIATION_OBSERVED_AT_INVALID");
  const expected = new Map(projection.map((entry) => [entry.asset, BigInt(entry.expectedTotalMicros)]));
  const observed = new Map(positions.map((position) => [position.asset, decimalToScaled(position.size, SHARE_SCALE_DIGITS)]));
  const assets = new Set([...expected.keys(), ...observed.keys()]);
  const currentDetails: ReconciliationDetail[] = [];
  for (const asset of assets) {
    const expectedValue = expected.get(asset) ?? 0n;
    const observedValue = observed.get(asset) ?? 0n;
    const difference = observedValue - expectedValue;
    const relativeTolerance = (absolute(observedValue) * BigInt(RULESET.reconciliationRelativeTolerancePpm)) / 1_000_000n;
    const absoluteTolerance = BigInt(RULESET.reconciliationShareAbsToleranceMicros);
    const tolerance = relativeTolerance > absoluteTolerance ? relativeTolerance : absoluteTolerance;
    if (absolute(difference) > tolerance) {
      currentDetails.push({
        issueType: "POSITION_QUANTITY_DIFF",
        asset,
        expectedMicros: expectedValue.toString(),
        observedMicros: observedValue.toString(),
        differenceMicros: difference.toString(),
        toleranceMicros: tolerance.toString(),
      });
    }
  }
  for (const ambiguity of sourceEventAmbiguities) {
    currentDetails.push({
      issueType: "SOURCE_EVENT_MULTIPLICITY_AMBIGUOUS",
      sourceEventKey: ambiguity.sourceEventKey,
      tradesCount: ambiguity.tradesCount,
      activityCount: ambiguity.activityCount,
    });
  }
  for (const activity of unsupportedActivities) {
    currentDetails.push({
      issueType: "UNSUPPORTED_TARGET_ACTIVITY",
      sourceEventKey: activity.sourceEventKey,
      activityType: activity.activityType,
    });
  }
  for (const ambiguity of orderingAmbiguities) currentDetails.push({
    issueType: "SOURCE_EVENT_ORDER_AMBIGUOUS", sourceEventKey: ambiguity.sourceEventKeys[0]!,
    sourceTimestamp: ambiguity.sourceTimestamp, conditionId: ambiguity.conditionId,
  });
  const previousDetails = new Map(
    (previousReport?.details ?? []).map((detail) => [issueIdentity(detail), detail]),
  );
  const previousCreatedAtMs = previousReport ? Date.parse(previousReport.createdAt) : null;
  if (
    previousReport
    && (!Number.isFinite(previousCreatedAtMs) || previousCreatedAtMs! > observedAtMs)
  ) {
    throw new Error("RECONCILIATION_HISTORY_TIMESTAMP_INVALID");
  }
  const details = currentDetails.map((detail): ReconciliationDetail => {
    const previous = previousDetails.get(issueIdentity(detail));
    if (!previous || !previousReport) {
      return { ...detail, firstObservedAt: observedAt, consecutiveCount: 1 };
    }
    const previousFirstObservedAt = previous.firstObservedAt ?? previousReport.createdAt;
    const previousFirstObservedAtMs = Date.parse(previousFirstObservedAt);
    if (
      !Number.isFinite(previousFirstObservedAtMs)
      || previousFirstObservedAtMs > previousCreatedAtMs!
    ) {
      throw new Error("RECONCILIATION_HISTORY_FIRST_OBSERVED_AT_INVALID");
    }
    const previousConsecutiveCount = previous.consecutiveCount ?? 1;
    if (!Number.isInteger(previousConsecutiveCount) || previousConsecutiveCount < 1) {
      throw new Error("RECONCILIATION_HISTORY_CONSECUTIVE_COUNT_INVALID");
    }
    return {
      ...detail,
      firstObservedAt: previousFirstObservedAt,
      consecutiveCount: previousConsecutiveCount + 1,
    };
  });
  let syncStatus: SyncStatus = "SYNCED";
  if (details.length > 0) {
    const major = details.some((detail) => (
      detail.issueType === "UNSUPPORTED_TARGET_ACTIVITY"
      || detail.issueType === "SOURCE_EVENT_ORDER_AMBIGUOUS"
      || (
        detail.consecutiveCount! >= RULESET.majorDesyncConsecutiveCount
        && observedAtMs - Date.parse(detail.firstObservedAt!) >= RULESET.reconciliationGraceMs
      )
    ));
    syncStatus = major ? "MAJOR_DESYNC" : "MINOR_DIFF";
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
