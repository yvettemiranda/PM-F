import { createHash } from "node:crypto";
import { stableJson } from "./canonical-json.js";
import {
  rulesetProfileFromEnvironment,
  type RulesetProfileContext,
} from "../operator/ruleset-profile.js";
export { stableJson } from "./canonical-json.js";

export const DEFAULT_VERSIONS = Object.freeze({
  schemaVersion: "2.29.0",
  signalVersion: "1.8.0",
  strategyVersion: "2.4.0",
  riskVersion: "1.7.0",
  replayVersion: "2.0.0",
  paperVersion: "1.11.0",
  liveVersion: "1.8.0",
  validationVersion: "1.6.0",
  operationalVersion: "1.5.0",
  rulesetVersion: "v1.7.0",
  feeModelVersion: "clob-fd-v1",
  configVersion: "v1.4.0",
});

export const DEFAULT_RULESET = Object.freeze({
  buyExecutionMode: "FAK",
  buyPriceMinRatioPpm: 980_000,
  buyPriceMaxRatioPpm: 1_020_000,
  buyPriceImprovementAllowed: true,
  buyPriceMinimumTickSteps: 2,
  buyMaximumPricePpm: 950_000,
  buyFirstEntryMinimumAmountMicros: 1_000_000,
  buyMarketMinimumAutoLiftCapMicros: 5_000_000,
  waitRatioPpm: 500_000,
  maxWaitMs: 30 * 60 * 1_000,
  followSellMaxSlippagePpm: 100_000,
  stopSellMaxSlippagePpm: 150_000,
  stopTriggerRatioPpm: 500_000,
  capitalTimeToleranceMs: 5 * 60 * 1_000,
  fallbackAmountMicros: 10_000_000,
  reconciliationShareAbsToleranceMicros: 100_000,
  reconciliationCashAbsToleranceMicros: 10_000,
  reconciliationRelativeTolerancePpm: 1_000,
  reconciliationGraceMs: 120_000,
  majorDesyncConsecutiveCount: 3,
  requestTimeoutMs: 3_000,
  maxRetryCount: 3,
  backoffFactor: 2,
  maxBackoffMs: 30_000,
  clockUnsafeThresholdMs: 1_000,
  orderbookMaxAgeMs: 2_000,
  paperInitialBalanceMicros: 1_000_000_000,
  paperFeeRoundingMicros: 10,
  paperMaxSingleTradePpm: 1_000_000,
  paperMaxMarketExposurePpm: 1_000_000,
  paperMaxPositionExposurePpm: 1_000_000,
  paperMarketDataFreezeThreshold: 1,
  paperMarketDataRecoverySuccesses: 2,
  paperMarketDataInitialBackoffMs: 5_000,
  paperMarketDataMaxBackoffMs: 5 * 60 * 1_000,
  capitalMode: "PROPORTIONAL_WITH_FIXED_FALLBACK",
  liveBankrollMicros: 1_000_000_000,
  liveMaxSingleTradePpm: 200_000,
  liveMaxMarketExposurePpm: 200_000,
  liveMaxPositionExposurePpm: 200_000,
  liveMaxTotalExposurePpm: 500_000,
  liveMaxDailyLossPpm: 50_000,
  liveMaxConsecutiveLosses: 5,
  liveMaxTradeSizeMicros: 200_000_000,
  liveMaxExposureMicros: 500_000_000,
  liveMaxDailyLossMicros: 50_000_000,
  liveStopLossRatioPpm: 500_000,
  liveKellyEnabled: false,
});

/**
 * Rules whose current Paper/Observe/Risk implementation is validated for
 * operator profiles. Live-only settings stay frozen until the real Live
 * runtime, signer boundary, and dedicated profile tests exist.
 */
export const PAPER_RULESET_KEYS = Object.freeze([
  "buyExecutionMode",
  "buyPriceMinRatioPpm",
  "buyPriceMaxRatioPpm",
  "buyPriceImprovementAllowed",
  "buyPriceMinimumTickSteps",
  "buyMaximumPricePpm",
  "buyFirstEntryMinimumAmountMicros",
  "buyMarketMinimumAutoLiftCapMicros",
  "waitRatioPpm",
  "maxWaitMs",
  "followSellMaxSlippagePpm",
  "stopSellMaxSlippagePpm",
  "stopTriggerRatioPpm",
  "capitalTimeToleranceMs",
  "fallbackAmountMicros",
  "reconciliationShareAbsToleranceMicros",
  "reconciliationRelativeTolerancePpm",
  "reconciliationGraceMs",
  "majorDesyncConsecutiveCount",
  "clockUnsafeThresholdMs",
  "orderbookMaxAgeMs",
  "paperInitialBalanceMicros",
  "paperFeeRoundingMicros",
  "paperMaxSingleTradePpm",
  "paperMaxMarketExposurePpm",
  "paperMaxPositionExposurePpm",
  "paperMarketDataFreezeThreshold",
  "paperMarketDataRecoverySuccesses",
  "paperMarketDataInitialBackoffMs",
  "paperMarketDataMaxBackoffMs",
  "capitalMode",
] as const);

/** User-facing Paper strategy/risk knobs; infrastructure safety gates stay frozen. */
export const OPERATOR_EDITABLE_RULESET_KEYS = Object.freeze([
  "buyPriceMinRatioPpm",
  "buyPriceMaxRatioPpm",
  "buyMaximumPricePpm",
  "buyFirstEntryMinimumAmountMicros",
  "buyMarketMinimumAutoLiftCapMicros",
  "waitRatioPpm",
  "maxWaitMs",
  "followSellMaxSlippagePpm",
  "stopSellMaxSlippagePpm",
  "stopTriggerRatioPpm",
  "fallbackAmountMicros",
  "paperInitialBalanceMicros",
  "paperMaxSingleTradePpm",
  "paperMaxMarketExposurePpm",
  "paperMaxPositionExposurePpm",
] as const);

type WidenRuleValue<Value> = Value extends string
  ? string
  : Value extends number
    ? number
    : Value extends boolean
      ? boolean
      : Value;
export type VersionCatalog = { [Key in keyof typeof DEFAULT_VERSIONS]: string };
export type RulesetCatalog = {
  [Key in keyof typeof DEFAULT_RULESET]: WidenRuleValue<(typeof DEFAULT_RULESET)[Key]>;
};

export const OPERATOR_RULESET_PROFILE_CONTEXT: RulesetProfileContext<RulesetCatalog> = Object.freeze({
  defaultRules: DEFAULT_RULESET,
  defaultConfigVersion: DEFAULT_VERSIONS.configVersion,
  rulesetVersion: DEFAULT_VERSIONS.rulesetVersion,
  editableKeys: OPERATOR_EDITABLE_RULESET_KEYS,
});

export const RULESET_PROFILE = rulesetProfileFromEnvironment(OPERATOR_RULESET_PROFILE_CONTEXT);
export const VERSIONS: Readonly<VersionCatalog> = Object.freeze({
  ...DEFAULT_VERSIONS,
  configVersion: RULESET_PROFILE.configVersion,
});
export const RULESET: Readonly<RulesetCatalog> = Object.freeze({ ...RULESET_PROFILE.rules });

/**
 * Versions which can change the meaning of a Signal, RiskDecision or
 * Paper/Live execution result. Infrastructure and acceptance-tool versions are
 * deliberately not part of the ruleset identity: changing a report renderer or
 * a replay validator must not reinterpret an already-created trade decision.
 *
 * `configVersion` is retained because it identifies the executable strategy
 * configuration stored in `ruleset_registry`; presentation-only configuration
 * belongs in artifact provenance instead.
 */
export const RULESET_BEHAVIOR_VERSION_KEYS = Object.freeze([
  "signalVersion",
  "strategyVersion",
  "riskVersion",
  "paperVersion",
  "rulesetVersion",
  "feeModelVersion",
  "configVersion",
] as const);

/**
 * Rules that can change Observe, Signal, Risk or Paper execution semantics.
 * Live-only limits remain in the full ruleset provenance, but must not reset
 * an otherwise compatible Paper validation Campaign.
 */
export const PAPER_RULESET_BEHAVIOR_VERSION_KEYS = Object.freeze([
  "signalVersion",
  "strategyVersion",
  "riskVersion",
  "paperVersion",
  "feeModelVersion",
] as const);

export function rulesetBehaviorVersions(
  versions: Readonly<VersionCatalog> = VERSIONS,
): Readonly<Pick<VersionCatalog, typeof RULESET_BEHAVIOR_VERSION_KEYS[number]>> {
  return Object.freeze(Object.fromEntries(
    RULESET_BEHAVIOR_VERSION_KEYS.map((key) => [key, versions[key]]),
  )) as Readonly<Pick<VersionCatalog, typeof RULESET_BEHAVIOR_VERSION_KEYS[number]>>;
}

export function buildRulesetSnapshotJson(
  versions: Readonly<VersionCatalog> = VERSIONS,
  rules: Readonly<RulesetCatalog> = RULESET,
): string {
  return stableJson({ versions: rulesetBehaviorVersions(versions), rules });
}

export function paperRuleset(
  rules: Readonly<RulesetCatalog> = RULESET,
): Readonly<Pick<RulesetCatalog, typeof PAPER_RULESET_KEYS[number]>> {
  return Object.freeze(Object.fromEntries(
    PAPER_RULESET_KEYS.map((key) => [key, rules[key]]),
  )) as Readonly<Pick<RulesetCatalog, typeof PAPER_RULESET_KEYS[number]>>;
}

export function buildPaperRulesetSnapshotJson(
  versions: Readonly<VersionCatalog> = VERSIONS,
  rules: Readonly<RulesetCatalog> = RULESET,
): string {
  return stableJson({
    versions: Object.fromEntries(
      PAPER_RULESET_BEHAVIOR_VERSION_KEYS.map((key) => [key, versions[key]]),
    ),
    rules: paperRuleset(rules),
  });
}

export function buildArtifactProvenanceSnapshotJson(
  versions: Readonly<VersionCatalog> = VERSIONS,
  rules: Readonly<RulesetCatalog> = RULESET,
): string {
  return stableJson({ versions, rules });
}

export const RULESET_SNAPSHOT_JSON = buildRulesetSnapshotJson();
export const RULESET_HASH = createHash("sha256").update(RULESET_SNAPSHOT_JSON).digest("hex");

/** Paper Campaign reset identity; object audit provenance still uses RULESET_HASH. */
export const PAPER_RULESET_SNAPSHOT_JSON = buildPaperRulesetSnapshotJson();
export const PAPER_RULESET_HASH = createHash("sha256")
  .update(PAPER_RULESET_SNAPSHOT_JSON)
  .digest("hex");

/** Full version inventory for reports/evidence. It never gates Campaign reuse. */
export const ARTIFACT_PROVENANCE_SNAPSHOT_JSON = buildArtifactProvenanceSnapshotJson();
export const ARTIFACT_PROVENANCE_HASH = createHash("sha256")
  .update(ARTIFACT_PROVENANCE_SNAPSHOT_JSON)
  .digest("hex");
