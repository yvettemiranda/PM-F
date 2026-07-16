import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { RULESET_HASH, VERSIONS, stableJson } from "../domain/versioning.js";
import type { CoreCompatibilityManifest } from "./types.js";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
export const CORE_COMPATIBILITY_PAPER_FILES = [
  "src/paper/matching.ts",
  "src/paper/paper-account-selection.ts",
  "src/paper/paper-executor.ts",
  "src/paper/paper-runner.ts",
  "src/paper/public-market-data.ts",
  "src/paper/types.ts",
] as const;

export const CORE_COMPATIBILITY_CAMPAIGN_RUNTIME_FILES = [
  "src/cli/paper-campaign-run.ts",
  "src/paper-validation/crash-recovery.ts",
  "src/paper-validation/operator-evidence.ts",
  "src/paper-validation/operator-policy.ts",
  "src/paper-validation/preflight.ts",
  "src/paper-validation/report.ts",
  "src/paper-validation/service.ts",
  "src/paper-validation/store.ts",
  "src/paper-validation/types.ts",
] as const;

function hashFiles(projectRoot: string, relativePaths: string[]): string {
  const digest = createHash("sha256");
  for (const relativePath of [...new Set(relativePaths)].sort()) {
    digest.update(relativePath);
    digest.update("\0");
    digest.update(readFileSync(join(projectRoot, relativePath)));
    digest.update("\0");
  }
  return digest.digest("hex");
}

function sourceFiles(projectRoot: string, relativeDirectory: string): string[] {
  const files: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(join(projectRoot, directory), { withFileTypes: true })) {
      const relativePath = join(directory, entry.name);
      if (entry.isDirectory()) walk(relativePath);
      else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(relativePath);
    }
  };
  walk(relativeDirectory);
  return files;
}

function hashValue(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

export function buildCurrentCoreCompatibilityManifest(projectRoot: string): CoreCompatibilityManifest {
  const migrationDirectory = join(projectRoot, "src/infra/sqlite");
  const migrations = readdirSync(migrationDirectory)
    .filter((name) => /^\d+_[a-z0-9_]+\.sql$/.test(name))
    .map((name) => `src/infra/sqlite/${name}`);
  const domain = sourceFiles(projectRoot, "src/domain");
  const execution = sourceFiles(projectRoot, "src/execution");
  // Only runtime trading behavior belongs in the compatibility boundary.
  // Acceptance reports, operator copy and Campaign presentation may evolve
  // without invalidating already accumulated Paper runtime.
  const paperCore = [...CORE_COMPATIBILITY_PAPER_FILES];
  const observe = sourceFiles(projectRoot, "src/observe");
  const signalContext = sourceFiles(projectRoot, "src/signal-context");
  const adapters = sourceFiles(projectRoot, "src/adapters");
  const packageDefinition = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8")) as {
    packageManager?: string;
    engines?: Record<string, string>;
    dependencies?: Record<string, string>;
  };
  return {
    schemaVersion: VERSIONS.schemaVersion,
    signalVersion: VERSIONS.signalVersion,
    strategyVersion: VERSIONS.strategyVersion,
    riskVersion: VERSIONS.riskVersion,
    paperVersion: VERSIONS.paperVersion,
    rulesetHash: RULESET_HASH,
    configVersion: VERSIONS.configVersion,
    components: {
      amountCalculation: hashFiles(projectRoot, [
        "package.json",
        "pnpm-lock.yaml",
        ...domain,
        ...execution,
        "src/services/capital-estimator.ts",
      ]),
      signalContext: hashFiles(projectRoot, [
        ...domain,
        ...signalContext,
        ...execution,
        "src/observe/position-projector.ts",
        "src/observe/types.ts",
      ]),
      risk: hashFiles(projectRoot, [...domain, ...sourceFiles(projectRoot, "src/risk")]),
      paperExecution: hashFiles(projectRoot, [
        ...domain,
        ...execution,
        ...paperCore,
        ...sourceFiles(projectRoot, "src/risk"),
        ...signalContext,
        "src/cli/paper-run.ts",
        "src/infra/sqlite/public-market-capture.ts",
      ]),
      observeRecovery: hashFiles(projectRoot, [
        ...domain,
        ...adapters,
        ...observe,
        ...signalContext,
        "src/services/capital-estimator.ts",
        "src/services/position-baseline.ts",
        "src/services/wallet-identity.ts",
        ...CORE_COMPATIBILITY_CAMPAIGN_RUNTIME_FILES,
      ]),
      settlementPnl: hashFiles(projectRoot, [
        ...domain,
        ...execution,
        ...sourceFiles(projectRoot, "src/settlement"),
        ...sourceFiles(projectRoot, "src/pnl"),
        ...sourceFiles(projectRoot, "src/portfolio"),
      ]),
      schema: hashFiles(projectRoot, [
        ...migrations,
        "src/infra/sqlite/capture-payload.ts",
        "src/infra/sqlite/database.ts",
        "src/infra/sqlite/phase0-validation-database.ts",
        "src/infra/sqlite/runtime-database-preparation.ts",
      ]),
      runtimeEnvironment: hashValue({
        nodeVersion: process.versions.node,
        packageManager: packageDefinition.packageManager ?? null,
        engines: packageDefinition.engines ?? null,
        runtimeDependencies: packageDefinition.dependencies ?? null,
      }),
    },
  };
}

export function computeCoreCompatibilityHash(manifest: CoreCompatibilityManifest): string {
  for (const [name, componentHash] of Object.entries(manifest.components)) {
    if (!SHA256_PATTERN.test(componentHash)) {
      throw new Error(`INVALID_CORE_COMPONENT_HASH:${name}`);
    }
  }
  if (!SHA256_PATTERN.test(manifest.rulesetHash)) {
    throw new Error("INVALID_CORE_RULESET_HASH");
  }
  return createHash("sha256")
    .update(stableJson({ version: "paper-validation-core-v2", manifest }))
    .digest("hex");
}

export function assertCoreCompatibility(
  expectedHash: string,
  manifest: CoreCompatibilityManifest,
): void {
  const actualHash = computeCoreCompatibilityHash(manifest);
  if (actualHash !== expectedHash) {
    throw new Error(`CORE_COMPATIBILITY_HASH_MISMATCH:expected=${expectedHash}:actual=${actualHash}`);
  }
}
