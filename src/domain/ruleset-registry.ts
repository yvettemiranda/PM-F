import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export interface RegisteredStopLossRules {
  rulesetHash: string;
  triggerRatioPpm: number;
  maxSlippagePpm: number;
  configVersion: string;
}

export interface RegisteredExecutionRules extends RegisteredStopLossRules {
  buyPriceMinRatioPpm: number;
  buyPriceMaxRatioPpm: number;
  buyPriceImprovementAllowed: boolean;
  buyPriceMinimumTickSteps: number;
  buyMaximumPriceUnits: bigint;
  buyFirstEntryMinimumAmountMicros: bigint;
  buyMarketMinimumAutoLiftCapMicros: bigint;
  smallFollowBuyMaxCount: number;
  smallFollowBuyPolicyEnabled: boolean;
  followSellFullExitThresholdPpm: number;
  followSellMaxSlippagePpm: number;
  waitRatioPpm: number;
  maxWaitMs: number;
  feeModelVersion: string;
}

interface RulesetRegistryRow {
  stop_loss_ratio_ppm: number;
  buy_price_lower_ratio_ppm: number;
  buy_price_upper_ratio_ppm: number;
  wait_ratio_ppm: number;
  max_wait_time_ms: number;
  fee_model_version: string;
  ruleset_snapshot_json: string;
  config_version: string;
  ruleset_version: string;
  canonical_snapshot_json: string;
}

function validRatioPpm(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0 && Number(value) < 1_000_000;
}

function validPriceRatioPpm(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0 && Number(value) < 2_000_000;
}

function validUnitRatioPpm(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 1_000_000;
}

function validPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

/**
 * Loads stop-loss execution rules by the immutable hash carried by a position.
 * Historical positions must never be reinterpreted with the process's current
 * constants after a ruleset upgrade.
 */
export function registeredExecutionRules(
  database: DatabaseSync,
  rulesetHash: string,
): RegisteredExecutionRules | null {
  const row = database.prepare(
    `SELECT r.stop_loss_ratio_ppm,r.buy_price_lower_ratio_ppm,r.buy_price_upper_ratio_ppm,
            r.wait_ratio_ppm,r.max_wait_time_ms,r.fee_model_version,
            r.ruleset_snapshot_json,r.config_version,r.ruleset_version,
            s.ruleset_snapshot_json canonical_snapshot_json
     FROM ruleset_registry r
     JOIN rulesets s ON s.ruleset_hash=r.ruleset_hash
     WHERE r.ruleset_hash=?`,
  ).get(rulesetHash) as RulesetRegistryRow | undefined;
  if (!row) return null;
  if (row.ruleset_snapshot_json !== row.canonical_snapshot_json) return null;
  if (createHash("sha256").update(row.ruleset_snapshot_json).digest("hex") !== rulesetHash) return null;

  let snapshot: unknown;
  try {
    snapshot = JSON.parse(row.ruleset_snapshot_json);
  } catch {
    return null;
  }
  if (!snapshot || typeof snapshot !== "object") return null;
  const rules = (snapshot as { rules?: unknown }).rules;
  const versions = (snapshot as { versions?: unknown }).versions;
  if (!rules || typeof rules !== "object") return null;
  if (!versions || typeof versions !== "object") return null;
  const maxSlippagePpm = (rules as { stopSellMaxSlippagePpm?: unknown }).stopSellMaxSlippagePpm;
  const followSellMaxSlippagePpm = (rules as { followSellMaxSlippagePpm?: unknown }).followSellMaxSlippagePpm;
  const snapshotTrigger = (rules as { stopTriggerRatioPpm?: unknown }).stopTriggerRatioPpm;
  const snapshotBuyMin = (rules as { buyPriceMinRatioPpm?: unknown }).buyPriceMinRatioPpm;
  const snapshotBuyMax = (rules as { buyPriceMaxRatioPpm?: unknown }).buyPriceMaxRatioPpm;
  const snapshotBuyPriceImprovementAllowed = (rules as { buyPriceImprovementAllowed?: unknown })
    .buyPriceImprovementAllowed;
  const snapshotBuyMinimumTickSteps = (rules as { buyPriceMinimumTickSteps?: unknown })
    .buyPriceMinimumTickSteps;
  const snapshotBuyMaximumPrice = (rules as { buyMaximumPricePpm?: unknown }).buyMaximumPricePpm;
  const snapshotBuyFirstEntryMinimum = (rules as { buyFirstEntryMinimumAmountMicros?: unknown })
    .buyFirstEntryMinimumAmountMicros;
  const snapshotBuyAutoLiftCap = (rules as { buyMarketMinimumAutoLiftCapMicros?: unknown })
    .buyMarketMinimumAutoLiftCapMicros;
  const snapshotSmallFollowBuyMaxCount = (rules as { smallFollowBuyMaxCount?: unknown })
    .smallFollowBuyMaxCount;
  const snapshotFollowSellFullExitThreshold = (rules as { followSellFullExitThresholdPpm?: unknown })
    .followSellFullExitThresholdPpm;
  const snapshotWaitRatio = (rules as { waitRatioPpm?: unknown }).waitRatioPpm;
  const snapshotMaxWait = (rules as { maxWaitMs?: unknown }).maxWaitMs;
  const snapshotConfig = (versions as { configVersion?: unknown }).configVersion;
  const snapshotRulesetVersion = (versions as { rulesetVersion?: unknown }).rulesetVersion;
  const snapshotFeeModelVersion = (versions as { feeModelVersion?: unknown }).feeModelVersion;
  const legacyBuyAmountPolicy = snapshotBuyMaximumPrice === undefined
    && snapshotBuyFirstEntryMinimum === undefined
    && snapshotBuyAutoLiftCap === undefined;
  const legacyBuyTickPolicy = snapshotBuyPriceImprovementAllowed === undefined
    && snapshotBuyMinimumTickSteps === undefined;
  if (
    !validRatioPpm(row.stop_loss_ratio_ppm)
    || !validRatioPpm(snapshotTrigger)
    || row.stop_loss_ratio_ppm !== snapshotTrigger
    || !validRatioPpm(maxSlippagePpm)
    || !validRatioPpm(followSellMaxSlippagePpm)
    || (snapshotFollowSellFullExitThreshold !== undefined
      && !validUnitRatioPpm(snapshotFollowSellFullExitThreshold))
    || !validPriceRatioPpm(snapshotBuyMin)
    || !validPriceRatioPpm(snapshotBuyMax)
    || snapshotBuyMin >= snapshotBuyMax
    || (!legacyBuyTickPolicy && (
      typeof snapshotBuyPriceImprovementAllowed !== "boolean"
      || !Number.isSafeInteger(snapshotBuyMinimumTickSteps)
      || Number(snapshotBuyMinimumTickSteps) < 0
    ))
    || (!legacyBuyAmountPolicy && (
      !validRatioPpm(snapshotBuyMaximumPrice)
      || !validPositiveSafeInteger(snapshotBuyFirstEntryMinimum)
      || !validPositiveSafeInteger(snapshotBuyAutoLiftCap)
      || Number(snapshotBuyAutoLiftCap) < Number(snapshotBuyFirstEntryMinimum)
      || (snapshotSmallFollowBuyMaxCount !== undefined && (
        !Number.isSafeInteger(snapshotSmallFollowBuyMaxCount)
        || Number(snapshotSmallFollowBuyMaxCount) < 0
      ))
    ))
    || row.buy_price_lower_ratio_ppm !== snapshotBuyMin
    || row.buy_price_upper_ratio_ppm !== snapshotBuyMax
    || !validRatioPpm(snapshotWaitRatio)
    || row.wait_ratio_ppm !== snapshotWaitRatio
    || !Number.isSafeInteger(snapshotMaxWait)
    || Number(snapshotMaxWait) <= 0
    || row.max_wait_time_ms !== snapshotMaxWait
    || snapshotConfig !== row.config_version
    || snapshotRulesetVersion !== row.ruleset_version
    || snapshotFeeModelVersion !== row.fee_model_version
  ) return null;

  return {
    rulesetHash,
    triggerRatioPpm: row.stop_loss_ratio_ppm,
    maxSlippagePpm,
    buyPriceMinRatioPpm: row.buy_price_lower_ratio_ppm,
    buyPriceMaxRatioPpm: row.buy_price_upper_ratio_ppm,
    buyPriceImprovementAllowed: legacyBuyTickPolicy
      ? false
      : snapshotBuyPriceImprovementAllowed as boolean,
    buyPriceMinimumTickSteps: legacyBuyTickPolicy
      ? 0
      : snapshotBuyMinimumTickSteps as number,
    buyMaximumPriceUnits: legacyBuyAmountPolicy
      ? 999_999_999_999_999_999n
      : (BigInt(snapshotBuyMaximumPrice as number) * 1_000_000_000_000_000_000n) / 1_000_000n,
    buyFirstEntryMinimumAmountMicros: legacyBuyAmountPolicy
      ? 0n
      : BigInt(snapshotBuyFirstEntryMinimum as number),
    buyMarketMinimumAutoLiftCapMicros: legacyBuyAmountPolicy
      ? 0n
      : BigInt(snapshotBuyAutoLiftCap as number),
    smallFollowBuyMaxCount: legacyBuyAmountPolicy || snapshotSmallFollowBuyMaxCount === undefined
      ? 0
      : Number(snapshotSmallFollowBuyMaxCount),
    smallFollowBuyPolicyEnabled: !legacyBuyAmountPolicy && snapshotSmallFollowBuyMaxCount !== undefined,
    followSellFullExitThresholdPpm: snapshotFollowSellFullExitThreshold === undefined
      ? 1_000_000
      : Number(snapshotFollowSellFullExitThreshold),
    followSellMaxSlippagePpm,
    waitRatioPpm: row.wait_ratio_ppm,
    maxWaitMs: row.max_wait_time_ms,
    feeModelVersion: row.fee_model_version,
    configVersion: row.config_version,
  };
}

export function registeredStopLossRules(
  database: DatabaseSync,
  rulesetHash: string,
): RegisteredStopLossRules | null {
  const rules = registeredExecutionRules(database, rulesetHash);
  return rules ? {
    rulesetHash: rules.rulesetHash,
    triggerRatioPpm: rules.triggerRatioPpm,
    maxSlippagePpm: rules.maxSlippagePpm,
    configVersion: rules.configVersion,
  } : null;
}
