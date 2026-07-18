import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import {
  ARTIFACT_PROVENANCE_HASH,
  ARTIFACT_PROVENANCE_SNAPSHOT_JSON,
  PAPER_RULESET_HASH,
  RULESET_HASH,
  VERSIONS,
  stableJson,
} from "../domain/versioning.js";
import type { CompatibilityIdentity, CoreCompatibilityManifest } from "./types.js";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const CORE_COMPONENT_NAMES = [
  "amountCalculation",
  "signalContext",
  "risk",
  "paperExecution",
  "observeRecovery",
  "settlementPnl",
  "schema",
  "runtimeEnvironment",
  "paperRules",
] as const;

/** Runtime files whose bytes can change Paper execution semantics. */
export const CORE_COMPATIBILITY_PAPER_FILES = [
  "src/paper/matching.ts",
  "src/paper/paper-account-selection.ts",
  "src/paper/paper-executor.ts",
  "src/paper/paper-runner.ts",
  "src/paper/paper-session-runtime.ts",
  "src/paper/public-market-data.ts",
  "src/paper/types.ts",
] as const;

/** Paper execution surface; Live-only CLOB fee/order construction is excluded. */
export const CORE_COMPATIBILITY_EXECUTION_FILES = [
  "src/execution/capital-sizing.ts",
  "src/execution/market-data.ts",
  "src/execution/market-order-constraints.ts",
  "src/execution/orderbook-matching.ts",
  "src/execution/signal-integrity.ts",
  "src/execution/types.ts",
] as const;

/** Campaign persistence and crash recovery, excluding acceptance/report policy. */
export const CORE_COMPATIBILITY_CAMPAIGN_RUNTIME_FILES = [
  "src/cli/observe-only.ts",
  "src/cli/paper-campaign-run.ts",
  "src/cli/paper-run.ts",
  "src/infra/source-version.ts",
  "src/operator/safe-child-environment.ts",
  "src/live/clob-clock-safety-provider.ts",
  "src/paper-validation/campaign-session-runtime.ts",
  "src/paper-validation/checkpoint-evidence.ts",
  "src/paper-validation/clock-safety.ts",
  "src/paper-validation/crash-recovery.ts",
  "src/paper-validation/final-integrity.ts",
  "src/paper-validation/operator-policy.ts",
  "src/paper-validation/report.ts",
  "src/paper-validation/runtime-recovery.ts",
  "src/paper-validation/service.ts",
  "src/paper-validation/store.ts",
  "src/validation/scoped-invariants.ts",
] as const;

/** Runtime domain implementation. versioning.ts rules are represented by paperRules. */
export const CORE_COMPATIBILITY_DOMAIN_FILES = [
  "src/domain/activity-trade.ts",
  "src/domain/canonical-json.ts",
  "src/domain/fixed.ts",
  "src/domain/idempotency.ts",
  "src/domain/models.ts",
  "src/domain/ruleset-registry.ts",
  "src/domain/state-machine.ts",
] as const;

/**
 * Only migrations which define Paper, Observe, recovery or their safety state.
 * Live-only and report/validation-only migrations remain in full artifact
 * provenance, but do not invalidate accumulated Paper runtime.
 */
export const CORE_COMPATIBILITY_SCHEMA_FILES = [
  "src/infra/sqlite/migration-preflight.ts",
  "src/infra/sqlite/paper-runtime-schema-contract.ts",
  "src/infra/sqlite/001_phase0.sql",
  "src/infra/sqlite/002_phase05.sql",
  "src/infra/sqlite/003_replay_event_classifications.sql",
  "src/infra/sqlite/004_observe_only.sql",
  "src/infra/sqlite/005_paper_executor.sql",
  "src/infra/sqlite/006_phase1a_architecture.sql",
  "src/infra/sqlite/007_ruleset_portfolio_projection.sql",
  "src/infra/sqlite/008_live_gate_safety.sql",
  "src/infra/sqlite/012_capture_payload_storage.sql",
  "src/infra/sqlite/014_observe_activity_confirmation.sql",
  "src/infra/sqlite/015_append_only_evidence.sql",
  "src/infra/sqlite/024_paper_market_data_health.sql",
  "src/infra/sqlite/025_exact_sizing_and_market_constraints.sql",
  "src/infra/sqlite/026_paper_validation_campaign.sql",
  "src/infra/sqlite/027_signal_target_binding.sql",
  "src/infra/sqlite/028_observe_projection_snapshots.sql",
  "src/infra/sqlite/029_observe_campaign_binding.sql",
  "src/infra/sqlite/030_paper_runtime_resilience.sql",
] as const;

export const VALIDATION_POLICY_FILES = [
  "src/infra/sqlite/010_validation_framework.sql",
  "src/infra/sqlite/011_operational_validation.sql",
  "src/infra/sqlite/phase0-validation-database.ts",
  "src/paper/paper-acceptance-summary.ts",
  "src/paper/paper-execution-funnel.ts",
  "src/paper/paper-gate-evaluator.ts",
  "src/paper-validation/isolated-proof.ts",
  "src/paper-validation/operator-evidence.ts",
  "src/paper-validation/operator-policy.ts",
  "src/paper-validation/replay-evidence.ts",
  "src/paper-validation/report.ts",
  "src/paper-validation/types.ts",
] as const;

export const OPERATOR_BUILD_FILES = [
  "src/cli/observe-only.ts",
  "src/cli/paper-campaign-evidence.ts",
  "src/cli/paper-campaign-preflight.ts",
  "src/cli/paper-campaign-run.ts",
  "src/cli/paper-campaign-status.ts",
  "src/cli/paper-run.ts",
  "src/cli/paper-replay-evidence.ts",
  "src/cli/redact-diagnostic.ts",
  "src/operator/diagnostic-redaction.ts",
  "src/operator/safe-child-environment.ts",
  "src/paper-validation/preflight.ts",
] as const;

interface PackageDefinition {
  packageManager?: string;
  engines?: Record<string, string>;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

export interface RuntimeCompatibilityDescriptor {
  nodeMajor: number | null;
  nodeEngine: string | null;
  packageManagerMajor: string | null;
  runtimeDependencies: Record<string, string> | null;
}

export interface CompatibilityEvidenceHashes extends CompatibilityIdentity {
  artifactProvenanceSnapshotJson: string;
}

export const PAPER_CAMPAIGN_ISOLATED_TEST_FILES = [
  "tests/api-contract.test.ts",
  "tests/campaign-session-runtime.test.ts",
  "tests/capital-estimator.test.ts",
  "tests/capital-sizing.test.ts",
  "tests/capture-manifest.test.ts",
  "tests/capture-payload-storage.test.ts",
  "tests/core-compatibility.test.ts",
  "tests/database-immutability.test.ts",
  "tests/database.test.ts",
  "tests/diagnostic-redaction.test.ts",
  "tests/execution-market-data.test.ts",
  "tests/fixed.test.ts",
  "tests/golden-expectations.test.ts",
  "tests/idempotency.test.ts",
  "tests/isolated-proof.test.ts",
  "tests/live-executor.test.ts",
  "tests/live-gate.test.ts",
  "tests/live-risk-manager.test.ts",
  "tests/market-order-constraints.test.ts",
  "tests/observe-runner.test.ts",
  "tests/operational-validation.test.ts",
  "tests/operator-paper-campaign-shell.test.ts",
  "tests/operator-process-lifecycle.test.ts",
  "tests/paper-acceptance-summary.test.ts",
  "tests/paper-account-selection.test.ts",
  "tests/paper-campaign-clock-safety.test.ts",
  "tests/paper-campaign-operator-evidence.test.ts",
  "tests/paper-campaign-operator-policy.test.ts",
  "tests/paper-executor.test.ts",
  "tests/paper-gate-evaluator.test.ts",
  "tests/paper-replay-evidence.test.ts",
  "tests/paper-runner-options.test.ts",
  "tests/paper-session-runtime.test.ts",
  "tests/paper-validation-campaign.test.ts",
  "tests/polymarket-clob-adapter.test.ts",
  "tests/position-baseline.test.ts",
  "tests/public-api-pagination.test.ts",
  "tests/public-api-safety.test.ts",
  "tests/replay-engine.test.ts",
  "tests/run-snapshot-retention.test.ts",
  "tests/runtime-database-preparation.test.ts",
  "tests/safe-child-environment.test.ts",
  "tests/settlement-service.test.ts",
  "tests/signal-target-binding.test.ts",
  "tests/source-version.test.ts",
  "tests/state-machine.test.ts",
  "tests/validation-framework.test.ts",
  "tests/wallet-identity.test.ts",
] as const;

function semanticTypeScript(source: string, relativePath: string): string {
  const sourceFile = ts.createSourceFile(
    relativePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  return ts.createPrinter({
    newLine: ts.NewLineKind.LineFeed,
    removeComments: true,
  }).printFile(sourceFile);
}

function hashFiles(projectRoot: string, relativePaths: readonly string[]): string {
  const digest = createHash("sha256");
  for (const relativePath of [...new Set(relativePaths)].sort()) {
    const content = readFileSync(join(projectRoot, relativePath));
    digest.update(relativePath);
    digest.update("\0");
    digest.update(relativePath.endsWith(".ts")
      ? semanticTypeScript(content.toString("utf8"), relativePath)
      : content);
    digest.update("\0");
  }
  return digest.digest("hex");
}

function filesUnder(
  projectRoot: string,
  relativeDirectory: string,
  include: (name: string) => boolean,
): string[] {
  const files: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(join(projectRoot, directory), { withFileTypes: true })) {
      const relativePath = join(directory, entry.name);
      if (entry.isDirectory()) walk(relativePath);
      else if (entry.isFile() && include(entry.name)) files.push(relativePath);
    }
  };
  walk(relativeDirectory);
  return files;
}

function sourceFiles(projectRoot: string, relativeDirectory: string): string[] {
  return filesUnder(projectRoot, relativeDirectory, (name) => name.endsWith(".ts"));
}

function hashValue(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function normalizedPackageManagerMajor(packageManager: string | undefined): string | null {
  if (!packageManager) return null;
  const match = /^([^@]+)@(\d+)(?:\.|$)/.exec(packageManager);
  return match ? `${match[1]}@${match[2]}` : packageManager;
}

/** Node patch releases and package-manager patch releases are operational provenance, not behavior. */
export function runtimeCompatibilityDescriptor(
  packageDefinition: PackageDefinition,
  nodeVersion = process.versions.node,
  dependencyNames: readonly string[] = Object.keys(packageDefinition.dependencies ?? {}),
): RuntimeCompatibilityDescriptor {
  const nodeMajorText = /^(\d+)(?:\.|$)/.exec(nodeVersion)?.[1];
  const runtimeDependencies = Object.fromEntries(
    [...new Set(dependencyNames)].sort().flatMap((name) => {
      const version = packageDefinition.dependencies?.[name];
      return version === undefined ? [] : [[name, version]];
    }),
  );
  return {
    nodeMajor: nodeMajorText ? Number(nodeMajorText) : null,
    nodeEngine: packageDefinition.engines?.node ?? null,
    packageManagerMajor: normalizedPackageManagerMajor(packageDefinition.packageManager),
    runtimeDependencies: Object.keys(runtimeDependencies).length > 0 ? runtimeDependencies : null,
  };
}

function readPackageDefinition(projectRoot: string): PackageDefinition {
  return JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8")) as PackageDefinition;
}

function importedPackageNames(projectRoot: string, relativePaths: readonly string[]): string[] {
  const names = new Set<string>();
  for (const relativePath of [...new Set(relativePaths)]) {
    if (!relativePath.endsWith(".ts")) continue;
    const source = readFileSync(join(projectRoot, relativePath), "utf8");
    const importPattern = /\b(?:from\s*|import\s*(?:\(\s*)?)["']([^"']+)["']/g;
    for (const match of source.matchAll(importPattern)) {
      const specifier = match[1];
      if (!specifier || specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("node:")) {
        continue;
      }
      const segments = specifier.split("/");
      const packageName = specifier.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0];
      if (packageName) names.add(packageName);
    }
  }
  return [...names].sort();
}

export function buildCurrentCoreCompatibilityManifest(projectRoot: string): CoreCompatibilityManifest {
  const domain = [...CORE_COMPATIBILITY_DOMAIN_FILES];
  const execution = [...CORE_COMPATIBILITY_EXECUTION_FILES];
  const observe = sourceFiles(projectRoot, "src/observe");
  const signalContext = sourceFiles(projectRoot, "src/signal-context");
  const adapters = sourceFiles(projectRoot, "src/adapters");
  const risk = sourceFiles(projectRoot, "src/risk");
  const packageDefinition = readPackageDefinition(projectRoot);
  const runtimeSourceFiles = [
    ...domain,
    ...execution,
    ...observe,
    ...signalContext,
    ...adapters,
    ...risk,
    ...CORE_COMPATIBILITY_PAPER_FILES,
    ...CORE_COMPATIBILITY_CAMPAIGN_RUNTIME_FILES,
    ...sourceFiles(projectRoot, "src/settlement"),
    ...sourceFiles(projectRoot, "src/pnl"),
    ...sourceFiles(projectRoot, "src/portfolio"),
    "src/services/capital-estimator.ts",
    "src/services/capture-manifest.ts",
    "src/services/position-baseline.ts",
    "src/services/wallet-identity.ts",
    "src/infra/sqlite/capture-payload.ts",
    "src/infra/sqlite/public-market-capture.ts",
    "src/infra/sqlite/database.ts",
    "src/infra/sqlite/runtime-database-preparation.ts",
  ];

  return {
    // These fields are complete report provenance. computeCoreCompatibilityHash
    // deliberately selects only the behavioral contract below.
    schemaVersion: VERSIONS.schemaVersion,
    signalVersion: VERSIONS.signalVersion,
    strategyVersion: VERSIONS.strategyVersion,
    riskVersion: VERSIONS.riskVersion,
    paperVersion: VERSIONS.paperVersion,
    rulesetHash: RULESET_HASH,
    configVersion: VERSIONS.configVersion,
    components: {
      amountCalculation: hashFiles(projectRoot, [
        "src/domain/fixed.ts",
        "src/execution/capital-sizing.ts",
        "src/services/capital-estimator.ts",
      ]),
      signalContext: hashFiles(projectRoot, [
        ...domain,
        ...signalContext,
        "src/execution/capital-sizing.ts",
        "src/execution/signal-integrity.ts",
        "src/execution/types.ts",
        "src/observe/position-projector.ts",
        "src/observe/types.ts",
      ]),
      risk: hashFiles(projectRoot, [
        ...domain,
        ...risk,
        "src/portfolio/portfolio-projection.ts",
      ]),
      paperExecution: hashFiles(projectRoot, [
        ...domain,
        ...execution,
        ...CORE_COMPATIBILITY_PAPER_FILES,
        ...risk,
        ...signalContext,
        "src/infra/sqlite/public-market-capture.ts",
      ]),
      observeRecovery: hashFiles(projectRoot, [
        ...domain,
        ...adapters,
        ...observe,
        ...signalContext,
        "src/services/capital-estimator.ts",
        "src/services/capture-manifest.ts",
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
        ...CORE_COMPATIBILITY_SCHEMA_FILES,
        "src/infra/sqlite/capture-payload.ts",
      ]),
      runtimeEnvironment: hashValue(runtimeCompatibilityDescriptor(
        packageDefinition,
        process.versions.node,
        importedPackageNames(projectRoot, runtimeSourceFiles),
      )),
      paperRules: PAPER_RULESET_HASH,
    },
  };
}

/** Acceptance definitions may evolve without resetting accumulated runtime. */
export function computeValidationPolicyHash(projectRoot: string): string {
  const fileHash = hashFiles(projectRoot, [
    ...VALIDATION_POLICY_FILES,
    ...sourceFiles(projectRoot, "src/validation"),
    ...sourceFiles(projectRoot, "src/operational"),
  ]);
  return hashValue({
    version: "paper-validation-policy-v1",
    validationVersion: VERSIONS.validationVersion,
    operationalVersion: VERSIONS.operationalVersion,
    replayVersion: VERSIONS.replayVersion,
    fileHash,
  });
}

/** Operator UX/packaging identity; evidence-only and never a Campaign reset key. */
export function computeOperatorBuildHash(projectRoot: string): string {
  const packageDefinition = readPackageDefinition(projectRoot);
  return hashValue({
    version: "paper-operator-build-v1",
    operationalVersion: VERSIONS.operationalVersion,
    packageDefinition,
    fileHash: hashFiles(projectRoot, [
      ...OPERATOR_BUILD_FILES,
      ...filesUnder(projectRoot, "操作入口", () => true),
    ]),
  });
}

export function computeVerificationSuiteHash(projectRoot: string): string {
  const packageDefinition = readPackageDefinition(projectRoot);
  const toolchain = Object.fromEntries([
    "@types/node",
    "tsx",
    "typescript",
    "vitest",
  ].map((name) => [name, packageDefinition.devDependencies?.[name] ?? null]));
  return hashValue({
    version: "paper-verification-suite-v1",
    testFiles: PAPER_CAMPAIGN_ISOLATED_TEST_FILES,
    toolchain,
    fileHash: hashFiles(projectRoot, [
      ...filesUnder(projectRoot, "tests", (name) => name.endsWith(".ts")),
      "tsconfig.json",
      "pnpm-lock.yaml",
    ]),
  });
}

export function buildCurrentCompatibilityEvidence(projectRoot: string): CompatibilityEvidenceHashes {
  return {
    validationPolicyHash: computeValidationPolicyHash(projectRoot),
    operatorBuildHash: computeOperatorBuildHash(projectRoot),
    verificationSuiteHash: computeVerificationSuiteHash(projectRoot),
    artifactProvenanceHash: ARTIFACT_PROVENANCE_HASH,
    artifactProvenanceSnapshotJson: ARTIFACT_PROVENANCE_SNAPSHOT_JSON,
  };
}

export function computeCoreCompatibilityHash(manifest: CoreCompatibilityManifest): string {
  const componentNames = Object.keys(manifest.components).sort();
  const expectedComponentNames = [...CORE_COMPONENT_NAMES].sort();
  if (stableJson(componentNames) !== stableJson(expectedComponentNames)) {
    throw new Error("INVALID_CORE_COMPONENT_SET");
  }
  for (const name of CORE_COMPONENT_NAMES) {
    const componentHash = manifest.components[name];
    if (!SHA256_PATTERN.test(componentHash)) {
      throw new Error(`INVALID_CORE_COMPONENT_HASH:${name}`);
    }
  }
  if (!SHA256_PATTERN.test(manifest.rulesetHash)) {
    throw new Error("INVALID_CORE_RULESET_HASH");
  }
  const behavioralContract = {
    signalVersion: manifest.signalVersion,
    strategyVersion: manifest.strategyVersion,
    riskVersion: manifest.riskVersion,
    paperVersion: manifest.paperVersion,
    components: manifest.components,
  };
  return createHash("sha256")
    .update(stableJson({ version: "paper-validation-core-v4", behavioralContract }))
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
