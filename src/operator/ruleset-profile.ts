import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { stableJson } from "../domain/canonical-json.js";
import { assertOperatorMutationAllowed } from "./operator-mutation-guard.js";

export const SELECTED_RULESET_PROFILE_FILE = "data/operator/ruleset-profile.json";
export const RULESET_PROFILE_FILE_ENV = "NI_K_RULESET_PROFILE_FILE";
export const RULESET_PROFILE_SCHEMA_VERSION = 1;

type RuleValue = string | number | boolean;
export type RulesetValues = Record<string, RuleValue>;

export interface RulesetProfileDocument<T extends RulesetValues> {
  schemaVersion: 1;
  name: string;
  baseRulesetVersion: string;
  rules: T;
}

export interface RulesetProfileSelection<T extends RulesetValues> {
  source: "PROJECT_DEFAULT" | "OPERATOR_PROFILE";
  name: string;
  selectedFile: string;
  configVersion: string;
  parameterHash: string;
  rules: Readonly<T>;
}

export interface RulesetProfileContext<T extends RulesetValues> {
  defaultRules: Readonly<T>;
  defaultConfigVersion: string;
  rulesetVersion: string;
  editableKeys: readonly (keyof T & string)[];
}

const ZERO_ALLOWED_KEYS = new Set([
  "maxRetryCount",
  "buyPriceMinimumTickSteps",
  "smallFollowBuyMaxCount",
]);
const PRICE_RATIO_KEYS = new Set(["buyPriceMinRatioPpm", "buyPriceMaxRatioPpm"]);
const UNIT_RATIO_KEYS = new Set([
  "buyMaximumPricePpm",
  "waitRatioPpm",
  "followSellFullExitThresholdPpm",
  "followSellMaxSlippagePpm",
  "stopSellMaxSlippagePpm",
  "stopTriggerRatioPpm",
  "reconciliationRelativeTolerancePpm",
  "paperMaxSingleTradePpm",
  "paperMaxMarketExposurePpm",
  "paperMaxPositionExposurePpm",
  "liveMaxSingleTradePpm",
  "liveMaxMarketExposurePpm",
  "liveMaxPositionExposurePpm",
  "liveMaxTotalExposurePpm",
  "liveMaxDailyLossPpm",
  "liveStopLossRatioPpm",
]);

function parameterHash(rules: RulesetValues): string {
  return createHash("sha256").update(stableJson(rules)).digest("hex");
}

function configVersion(hash: string): string {
  return `operator-${hash.slice(0, 24)}`;
}

function validProfileName(value: unknown): value is string {
  return typeof value === "string"
    && value.trim() === value
    && value.length >= 1
    && value.length <= 64
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function assertRulesetSemantics(rules: RulesetValues): void {
  for (const [key, value] of Object.entries(rules)) {
    if (typeof value !== "number") continue;
    if (!Number.isSafeInteger(value)) throw new Error(`RULESET_PROFILE_NUMBER_INVALID:${key}`);
    if (ZERO_ALLOWED_KEYS.has(key) ? value < 0 : value <= 0) {
      throw new Error(`RULESET_PROFILE_NUMBER_OUT_OF_RANGE:${key}`);
    }
    if (PRICE_RATIO_KEYS.has(key) && value >= 2_000_000) {
      throw new Error(`RULESET_PROFILE_RATIO_OUT_OF_RANGE:${key}`);
    }
    if (UNIT_RATIO_KEYS.has(key) && value > 1_000_000) {
      throw new Error(`RULESET_PROFILE_RATIO_OUT_OF_RANGE:${key}`);
    }
  }
  if (rules.buyExecutionMode !== "FAK") throw new Error("RULESET_PROFILE_BUY_EXECUTION_MODE_UNSUPPORTED");
  if (rules.capitalMode !== "PROPORTIONAL_WITH_FIXED_FALLBACK") {
    throw new Error("RULESET_PROFILE_CAPITAL_MODE_UNSUPPORTED");
  }
  if (rules.liveKellyEnabled !== false) throw new Error("RULESET_PROFILE_LIVE_KELLY_UNSUPPORTED");
  if (Number(rules.buyPriceMinRatioPpm) >= Number(rules.buyPriceMaxRatioPpm)) {
    throw new Error("RULESET_PROFILE_BUY_PRICE_RANGE_INVALID");
  }
  if (Number(rules.buyMarketMinimumAutoLiftCapMicros) < Number(rules.buyFirstEntryMinimumAmountMicros)) {
    throw new Error("RULESET_PROFILE_BUY_AUTO_LIFT_CAP_BELOW_FIRST_ENTRY_MINIMUM");
  }
  if (Number(rules.paperMarketDataMaxBackoffMs) < Number(rules.paperMarketDataInitialBackoffMs)) {
    throw new Error("RULESET_PROFILE_MARKET_DATA_BACKOFF_RANGE_INVALID");
  }
  if (Number(rules.maxBackoffMs) < Number(rules.requestTimeoutMs)) {
    throw new Error("RULESET_PROFILE_REQUEST_BACKOFF_RANGE_INVALID");
  }
  if (Number(rules.liveMaxTradeSizeMicros) > Number(rules.liveBankrollMicros)
    || Number(rules.liveMaxExposureMicros) > Number(rules.liveBankrollMicros)
    || Number(rules.liveMaxDailyLossMicros) > Number(rules.liveBankrollMicros)) {
    throw new Error("RULESET_PROFILE_LIVE_ABSOLUTE_LIMIT_EXCEEDS_BANKROLL");
  }
}

function parseProfile<T extends RulesetValues>(
  value: unknown,
  context: RulesetProfileContext<T>,
): RulesetProfileDocument<T> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("RULESET_PROFILE_DOCUMENT_INVALID");
  }
  const document = value as Record<string, unknown>;
  if (document.schemaVersion !== RULESET_PROFILE_SCHEMA_VERSION) {
    throw new Error("RULESET_PROFILE_SCHEMA_VERSION_UNSUPPORTED");
  }
  if (!validProfileName(document.name)) throw new Error("RULESET_PROFILE_NAME_INVALID");
  if (document.baseRulesetVersion !== context.rulesetVersion) {
    throw new Error("RULESET_PROFILE_BASE_VERSION_MISMATCH");
  }
  if (!document.rules || typeof document.rules !== "object" || Array.isArray(document.rules)) {
    throw new Error("RULESET_PROFILE_RULES_INVALID");
  }
  const candidate = document.rules as Record<string, unknown>;
  const defaultKeys = Object.keys(context.defaultRules).sort();
  const candidateKeys = Object.keys(candidate).sort();
  if (stableJson(defaultKeys) !== stableJson(candidateKeys)) {
    throw new Error("RULESET_PROFILE_RULE_KEY_SET_MISMATCH");
  }
  const editable = new Set<string>(context.editableKeys);
  const rules: RulesetValues = {};
  for (const key of defaultKeys) {
    const defaultValue = context.defaultRules[key];
    const candidateValue = candidate[key];
    if (typeof candidateValue !== typeof defaultValue) {
      throw new Error(`RULESET_PROFILE_RULE_TYPE_MISMATCH:${key}`);
    }
    if (!editable.has(key) && candidateValue !== defaultValue) {
      throw new Error(`RULESET_PROFILE_RULE_NOT_EDITABLE:${key}`);
    }
    rules[key] = candidateValue as RuleValue;
  }
  assertRulesetSemantics(rules);
  return {
    schemaVersion: RULESET_PROFILE_SCHEMA_VERSION,
    name: document.name,
    baseRulesetVersion: context.rulesetVersion,
    rules: rules as T,
  };
}

function selectionFromDocument<T extends RulesetValues>(
  document: RulesetProfileDocument<T>,
): RulesetProfileSelection<T> {
  const hash = parameterHash(document.rules);
  return {
    source: "OPERATOR_PROFILE",
    name: document.name,
    selectedFile: SELECTED_RULESET_PROFILE_FILE,
    configVersion: configVersion(hash),
    parameterHash: hash,
    rules: Object.freeze({ ...document.rules }),
  };
}

function readSelectedProfile<T extends RulesetValues>(
  path: string,
  context: RulesetProfileContext<T>,
): RulesetProfileSelection<T> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`RULESET_PROFILE_FILE_INVALID:${SELECTED_RULESET_PROFILE_FILE}`, { cause: error });
  }
  return selectionFromDocument(parseProfile(parsed, context));
}

export function defaultRulesetProfile<T extends RulesetValues>(
  context: RulesetProfileContext<T>,
): RulesetProfileSelection<T> {
  const rules = Object.freeze({ ...context.defaultRules }) as Readonly<T>;
  return {
    source: "PROJECT_DEFAULT",
    name: "Project Default",
    selectedFile: SELECTED_RULESET_PROFILE_FILE,
    configVersion: context.defaultConfigVersion,
    parameterHash: parameterHash(rules),
    rules,
  };
}

export function selectedRulesetProfile<T extends RulesetValues>(
  projectRoot: string,
  context: RulesetProfileContext<T>,
): RulesetProfileSelection<T> {
  const path = resolve(projectRoot, SELECTED_RULESET_PROFILE_FILE);
  return existsSync(path) ? readSelectedProfile(path, context) : defaultRulesetProfile(context);
}

export function rulesetProfileFromEnvironment<T extends RulesetValues>(
  context: RulesetProfileContext<T>,
  environment: NodeJS.ProcessEnv = process.env,
  projectRoot = process.cwd(),
): RulesetProfileSelection<T> {
  const configured = environment[RULESET_PROFILE_FILE_ENV];
  if (configured === undefined) return defaultRulesetProfile(context);
  const expected = resolve(projectRoot, SELECTED_RULESET_PROFILE_FILE);
  const configuredPath = resolve(configured);
  const samePath = configuredPath === expected
    || (existsSync(configuredPath) && existsSync(expected)
      && realpathSync(configuredPath) === realpathSync(expected));
  if (!samePath) throw new Error("RULESET_PROFILE_ENV_PATH_INVALID");
  if (!existsSync(expected)) throw new Error("RULESET_PROFILE_ENV_FILE_MISSING");
  return readSelectedProfile(expected, context);
}

export function saveSelectedRulesetProfile<T extends RulesetValues>(
  projectRoot: string,
  context: RulesetProfileContext<T>,
  input: { name: string; overrides: Partial<T> },
): RulesetProfileSelection<T> {
  if (!validProfileName(input.name)) throw new Error("RULESET_PROFILE_NAME_INVALID");
  const editable = new Set<string>(context.editableKeys);
  for (const key of Object.keys(input.overrides)) {
    if (!(key in context.defaultRules)) throw new Error(`RULESET_PROFILE_RULE_UNKNOWN:${key}`);
    if (!editable.has(key)) throw new Error(`RULESET_PROFILE_RULE_NOT_EDITABLE:${key}`);
  }
  assertOperatorMutationAllowed(projectRoot, "RULESET_PROFILE_CHANGE");
  const document = parseProfile({
    schemaVersion: RULESET_PROFILE_SCHEMA_VERSION,
    name: input.name,
    baseRulesetVersion: context.rulesetVersion,
    rules: { ...context.defaultRules, ...input.overrides },
  }, context);
  if (stableJson(document.rules) === stableJson(context.defaultRules)) {
    throw new Error("RULESET_PROFILE_NO_EFFECTIVE_CHANGE");
  }
  const path = resolve(projectRoot, SELECTED_RULESET_PROFILE_FILE);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  return selectedRulesetProfile(projectRoot, context);
}

export function resetSelectedRulesetProfile(projectRoot: string): boolean {
  assertOperatorMutationAllowed(projectRoot, "RULESET_PROFILE_CHANGE");
  const path = resolve(projectRoot, SELECTED_RULESET_PROFILE_FILE);
  if (!existsSync(path)) return false;
  rmSync(path);
  return true;
}
