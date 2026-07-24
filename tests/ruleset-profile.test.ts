import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_RULESET,
  OPERATOR_RULESET_PROFILE_CONTEXT,
} from "../src/domain/versioning.js";
import {
  OPERATOR_ACTIVE_LOCK,
} from "../src/operator/target-wallet.js";
import {
  RULESET_PROFILE_FILE_ENV,
  SELECTED_RULESET_PROFILE_FILE,
  resetSelectedRulesetProfile,
  rulesetProfileFromEnvironment,
  saveSelectedRulesetProfile,
  selectedRulesetProfile,
} from "../src/operator/ruleset-profile.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "ni-k-ruleset-profile-"));
  directories.push(root);
  return root;
}

describe("operator ruleset profile", () => {
  it("uses the immutable project default when no profile is selected", () => {
    const selected = selectedRulesetProfile(project(), OPERATOR_RULESET_PROFILE_CONTEXT);
    expect(selected).toMatchObject({
      source: "PROJECT_DEFAULT",
      name: "Project Default",
      configVersion: "v1.7.0",
      rules: DEFAULT_RULESET,
    });
    expect(selected.parameterHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("persists a complete canonical profile from validated Paper overrides", () => {
    const root = project();
    const selected = saveSelectedRulesetProfile(root, OPERATOR_RULESET_PROFILE_CONTEXT, {
      name: "Lower buy ceiling",
      overrides: { buyMaximumPricePpm: 940_000, stopTriggerRatioPpm: 450_000 },
    });
    expect(selected).toMatchObject({
      source: "OPERATOR_PROFILE",
      name: "Lower buy ceiling",
      rules: { buyMaximumPricePpm: 940_000, stopTriggerRatioPpm: 450_000 },
    });
    expect(selected.configVersion).toMatch(/^operator-[a-f0-9]{24}$/);
    const document = JSON.parse(readFileSync(join(root, SELECTED_RULESET_PROFILE_FILE), "utf8")) as {
      schemaVersion: number;
      baseRulesetVersion: string;
      rules: Record<string, unknown>;
    };
    expect(document.schemaVersion).toBe(1);
    expect(document.baseRulesetVersion).toBe("v1.11.0");
    expect(Object.keys(document.rules).sort()).toEqual(Object.keys(DEFAULT_RULESET).sort());
  });

  it("rejects unknown, Live-only, mistyped, no-op, and unsafe overrides", () => {
    const root = project();
    expect(() => saveSelectedRulesetProfile(root, OPERATOR_RULESET_PROFILE_CONTEXT, {
      name: "Unknown",
      overrides: { imaginaryRule: 1 } as never,
    })).toThrow("RULESET_PROFILE_RULE_UNKNOWN:imaginaryRule");
    expect(() => saveSelectedRulesetProfile(root, OPERATOR_RULESET_PROFILE_CONTEXT, {
      name: "Live change",
      overrides: { liveMaxDailyLossPpm: 40_000 },
    })).toThrow("RULESET_PROFILE_RULE_NOT_EDITABLE:liveMaxDailyLossPpm");
    expect(() => saveSelectedRulesetProfile(root, OPERATOR_RULESET_PROFILE_CONTEXT, {
      name: "Wrong type",
      overrides: { buyMaximumPricePpm: "940000" } as never,
    })).toThrow("RULESET_PROFILE_RULE_TYPE_MISMATCH:buyMaximumPricePpm");
    expect(() => saveSelectedRulesetProfile(root, OPERATOR_RULESET_PROFILE_CONTEXT, {
      name: "No change",
      overrides: {},
    })).toThrow("RULESET_PROFILE_NO_EFFECTIVE_CHANGE");
    expect(() => saveSelectedRulesetProfile(root, OPERATOR_RULESET_PROFILE_CONTEXT, {
      name: "Invalid range",
      overrides: { buyPriceMinRatioPpm: 1_100_000, buyPriceMaxRatioPpm: 1_000_000 },
    })).toThrow("RULESET_PROFILE_BUY_PRICE_RANGE_INVALID");
  });

  it("blocks profile changes and reset while any operator lock is present", () => {
    const root = project();
    mkdirSync(join(root, OPERATOR_ACTIVE_LOCK), { recursive: true });
    expect(() => saveSelectedRulesetProfile(root, OPERATOR_RULESET_PROFILE_CONTEXT, {
      name: "Blocked",
      overrides: { buyMaximumPricePpm: 940_000 },
    })).toThrow(`RULESET_PROFILE_CHANGE_BLOCKED_BY_OPERATOR_LOCK:${OPERATOR_ACTIVE_LOCK}`);
    expect(() => resetSelectedRulesetProfile(root))
      .toThrow(`RULESET_PROFILE_CHANGE_BLOCKED_BY_OPERATOR_LOCK:${OPERATOR_ACTIVE_LOCK}`);
  });

  it("requires the environment path to be the selected public profile file", () => {
    const root = project();
    expect(() => rulesetProfileFromEnvironment(
      OPERATOR_RULESET_PROFILE_CONTEXT,
      { [RULESET_PROFILE_FILE_ENV]: join(root, "elsewhere.json") },
      root,
    )).toThrow("RULESET_PROFILE_ENV_PATH_INVALID");
    expect(() => rulesetProfileFromEnvironment(
      OPERATOR_RULESET_PROFILE_CONTEXT,
      { [RULESET_PROFILE_FILE_ENV]: join(root, SELECTED_RULESET_PROFILE_FILE) },
      root,
    )).toThrow("RULESET_PROFILE_ENV_FILE_MISSING");
  });

  it("changes the process-frozen ruleset and Paper identity when explicitly activated", () => {
    const root = project();
    symlinkSync(resolve("node_modules"), join(root, "node_modules"), "dir");
    saveSelectedRulesetProfile(root, OPERATOR_RULESET_PROFILE_CONTEXT, {
      name: "Subprocess profile",
      overrides: { buyMaximumPricePpm: 940_000 },
    });
    const versioningUrl = pathToFileURL(resolve("src/domain/versioning.ts")).href;
    const compatibilityUrl = pathToFileURL(resolve("src/paper-validation/core-compatibility.ts")).href;
    const sourceRoot = resolve(".");
    const defaultEnvironment = { ...process.env };
    delete defaultEnvironment[RULESET_PROFILE_FILE_ENV];
    const defaultChild = spawnSync(process.execPath, ["--import", "tsx", "-e", [
      `import { buildCurrentCoreCompatibilityManifest, computeCoreCompatibilityHash } from ${JSON.stringify(compatibilityUrl)};`,
      `console.log(computeCoreCompatibilityHash(buildCurrentCoreCompatibilityManifest(${JSON.stringify(sourceRoot)})));`,
    ].join("")], {
      cwd: sourceRoot,
      encoding: "utf8",
      env: defaultEnvironment,
    });
    expect(defaultChild.status, defaultChild.stderr).toBe(0);
    const defaultCoreHash = defaultChild.stdout.trim();
    const code = [
      `import { RULESET, RULESET_HASH, PAPER_RULESET_HASH, RULESET_PROFILE } from ${JSON.stringify(versioningUrl)};`,
      `import { buildCurrentCoreCompatibilityManifest, computeCoreCompatibilityHash } from ${JSON.stringify(compatibilityUrl)};`,
      `const coreHash=computeCoreCompatibilityHash(buildCurrentCoreCompatibilityManifest(${JSON.stringify(sourceRoot)}));`,
      "console.log(JSON.stringify({buyMaximumPricePpm:RULESET.buyMaximumPricePpm,rulesetHash:RULESET_HASH,paperRulesetHash:PAPER_RULESET_HASH,coreHash,source:RULESET_PROFILE.source}));",
    ].join("");
    const child = spawnSync(process.execPath, ["--import", "tsx", "-e", code], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        [RULESET_PROFILE_FILE_ENV]: join(root, SELECTED_RULESET_PROFILE_FILE),
      },
    });
    expect(child.status, child.stderr).toBe(0);
    const value = JSON.parse(child.stdout) as Record<string, unknown>;
    expect(value).toMatchObject({ buyMaximumPricePpm: 940_000, source: "OPERATOR_PROFILE" });
    expect(value.rulesetHash).not.toBe("e8b3eede381b889562d51ed39d692d9f106a37b7d220ad28c412a72cdd8daa75");
    expect(value.paperRulesetHash).not.toBe("6c8547d4e526878a1d3d696ad60dd77dd7a32c08937013729018fad0cb9492b7");
    expect(value.coreHash).not.toBe(defaultCoreHash);
  });

  it("fails closed on a corrupt persisted profile and supports an explicit reset", () => {
    const root = project();
    const path = join(root, SELECTED_RULESET_PROFILE_FILE);
    mkdirSync(join(root, "data/operator"), { recursive: true });
    writeFileSync(path, "{}\n");
    expect(() => selectedRulesetProfile(root, OPERATOR_RULESET_PROFILE_CONTEXT))
      .toThrow("RULESET_PROFILE_SCHEMA_VERSION_UNSUPPORTED");
    expect(resetSelectedRulesetProfile(root)).toBe(true);
    expect(resetSelectedRulesetProfile(root)).toBe(false);
  });
});
