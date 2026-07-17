import {
  appendFileSync,
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ARTIFACT_PROVENANCE_HASH,
  ARTIFACT_PROVENANCE_SNAPSHOT_JSON,
  PAPER_RULESET_HASH,
  PAPER_RULESET_KEYS,
  PAPER_RULESET_SNAPSHOT_JSON,
  RULESET,
  RULESET_HASH,
  RULESET_SNAPSHOT_JSON,
  VERSIONS,
  buildArtifactProvenanceSnapshotJson,
  buildPaperRulesetSnapshotJson,
  buildRulesetSnapshotJson,
} from "../src/domain/versioning.js";
import {
  buildCurrentCompatibilityEvidence,
  buildCurrentCoreCompatibilityManifest,
  CORE_COMPATIBILITY_CAMPAIGN_RUNTIME_FILES,
  CORE_COMPATIBILITY_PAPER_FILES,
  computeCoreCompatibilityHash,
  computeOperatorBuildHash,
  computeValidationPolicyHash,
  runtimeCompatibilityDescriptor,
} from "../src/paper-validation/core-compatibility.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function createProjectFixture(): string {
  const fixture = mkdtempSync(join(tmpdir(), "ni-k-core-compatibility-"));
  cpSync(join(projectRoot, "src"), join(fixture, "src"), { recursive: true });
  cpSync(join(projectRoot, "操作入口"), join(fixture, "操作入口"), { recursive: true });
  cpSync(join(projectRoot, "package.json"), join(fixture, "package.json"));
  return fixture;
}

describe("Paper Campaign core compatibility", () => {
  it("captures the complete current core as stable component hashes", () => {
    const first = buildCurrentCoreCompatibilityManifest(projectRoot);
    const second = buildCurrentCoreCompatibilityManifest(projectRoot);
    expect(first).toEqual(second);
    expect(first.components.runtimeEnvironment).toMatch(/^[a-f0-9]{64}$/);
    for (const value of Object.values(first.components)) {
      expect(value).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(computeCoreCompatibilityHash(first)).toBe(computeCoreCompatibilityHash(second));
    const missingPaperRules = {
      ...first,
      components: { ...first.components } as Record<string, string>,
    };
    delete missingPaperRules.components.paperRules;
    expect(() => computeCoreCompatibilityHash(missingPaperRules as typeof first))
      .toThrow("INVALID_CORE_COMPONENT_SET");
  });

  it("separates executable ruleset identity from full artifact provenance", () => {
    const rulesetSnapshot = JSON.parse(RULESET_SNAPSHOT_JSON) as {
      versions: Record<string, string>;
    };
    const provenanceSnapshot = JSON.parse(ARTIFACT_PROVENANCE_SNAPSHOT_JSON) as {
      versions: Record<string, string>;
    };

    expect(rulesetSnapshot.versions.strategyVersion).toBe(VERSIONS.strategyVersion);
    expect(rulesetSnapshot.versions.configVersion).toBe(VERSIONS.configVersion);
    expect(rulesetSnapshot.versions.schemaVersion).toBeUndefined();
    expect(rulesetSnapshot.versions.liveVersion).toBeUndefined();
    expect(rulesetSnapshot.versions.validationVersion).toBeUndefined();
    expect(rulesetSnapshot.versions.operationalVersion).toBeUndefined();
    expect(rulesetSnapshot.versions.replayVersion).toBeUndefined();
    expect(provenanceSnapshot.versions).toEqual(VERSIONS);

    const validationOnlyChange = { ...VERSIONS, validationVersion: "validation-test-only" };
    expect(buildRulesetSnapshotJson(validationOnlyChange)).toBe(RULESET_SNAPSHOT_JSON);
    expect(buildArtifactProvenanceSnapshotJson(validationOnlyChange))
      .not.toBe(ARTIFACT_PROVENANCE_SNAPSHOT_JSON);

    const strategyChange = { ...VERSIONS, strategyVersion: "strategy-test-change" };
    expect(buildRulesetSnapshotJson(strategyChange)).not.toBe(RULESET_SNAPSHOT_JSON);
    expect(RULESET_HASH).toMatch(/^[a-f0-9]{64}$/);
    expect(PAPER_RULESET_HASH).toMatch(/^[a-f0-9]{64}$/);
    expect(PAPER_RULESET_SNAPSHOT_JSON).not.toBe(RULESET_SNAPSHOT_JSON);
    expect(ARTIFACT_PROVENANCE_HASH).toMatch(/^[a-f0-9]{64}$/);
  });

  it("uses only Paper-relevant rules for the Campaign reset identity", () => {
    expect(PAPER_RULESET_KEYS.some((key) => key.startsWith("live"))).toBe(false);
    expect(PAPER_RULESET_KEYS).toContain("reconciliationGraceMs");
    expect(PAPER_RULESET_KEYS).not.toContain("clockUnsafeThresholdMs");
    expect(PAPER_RULESET_KEYS).not.toContain("reconciliationCashAbsToleranceMicros");
    expect(PAPER_RULESET_KEYS).not.toContain("requestTimeoutMs");
    const liveOnlyVersionChange = {
      ...VERSIONS,
      liveVersion: "live-test-only",
      rulesetVersion: "ruleset-provenance-only",
      configVersion: "config-provenance-only",
    };
    expect(buildPaperRulesetSnapshotJson(liveOnlyVersionChange))
      .toBe(PAPER_RULESET_SNAPSHOT_JSON);
    expect(buildRulesetSnapshotJson(liveOnlyVersionChange))
      .not.toBe(RULESET_SNAPSHOT_JSON);

    const liveOnlyChange = {
      ...RULESET,
      liveMaxSingleTradePpm: RULESET.liveMaxSingleTradePpm + 1,
      liveKellyEnabled: !RULESET.liveKellyEnabled,
    };
    expect(buildPaperRulesetSnapshotJson(VERSIONS, liveOnlyChange))
      .toBe(PAPER_RULESET_SNAPSHOT_JSON);
    expect(buildRulesetSnapshotJson(VERSIONS, liveOnlyChange))
      .not.toBe(RULESET_SNAPSHOT_JSON);

    const paperChange = {
      ...RULESET,
      buyPriceMinRatioPpm: RULESET.buyPriceMinRatioPpm - 1,
    };
    expect(buildPaperRulesetSnapshotJson(VERSIONS, paperChange))
      .not.toBe(PAPER_RULESET_SNAPSHOT_JSON);

    const manifest = buildCurrentCoreCompatibilityManifest(projectRoot);
    const baseline = computeCoreCompatibilityHash(manifest);
    expect(computeCoreCompatibilityHash({
      ...manifest,
      rulesetHash: "f".repeat(64),
    })).toBe(baseline);
    expect(computeCoreCompatibilityHash({
      ...manifest,
      components: { ...manifest.components, paperRules: "e".repeat(64) },
    })).not.toBe(baseline);
  });

  it("normalizes Node and package-manager patch releases", () => {
    const packageDefinition = {
      packageManager: "pnpm@11.9.0",
      engines: { node: ">=24.14.0 <25" },
      dependencies: { runtime: "1.0.0" },
    };
    const initial = runtimeCompatibilityDescriptor(packageDefinition, "24.14.0");
    expect(runtimeCompatibilityDescriptor(packageDefinition, "24.99.7")).toEqual(initial);
    expect(runtimeCompatibilityDescriptor(
      { ...packageDefinition, packageManager: "pnpm@11.99.0" },
      "24.14.0",
    )).toEqual(initial);
    expect(runtimeCompatibilityDescriptor(packageDefinition, "25.0.0")).not.toEqual(initial);
  });

  it("keeps top-level provenance out of the reset key while retaining behavior versions", () => {
    const manifest = buildCurrentCoreCompatibilityManifest(projectRoot);
    const baseline = computeCoreCompatibilityHash(manifest);
    expect(computeCoreCompatibilityHash({
      ...manifest,
      schemaVersion: "artifact-schema-only-change",
      configVersion: "artifact-config-field-only-change",
    })).toBe(baseline);
    expect(computeCoreCompatibilityHash({
      ...manifest,
      strategyVersion: "behavior-change",
    })).not.toBe(baseline);
  });

  it("keeps presentation and dev-tool drift out while detecting runtime mutations", () => {
    const fixture = createProjectFixture();
    try {
      const baselineManifest = buildCurrentCoreCompatibilityManifest(fixture);
      const baselineCore = computeCoreCompatibilityHash(baselineManifest);
      const baselinePolicy = computeValidationPolicyHash(fixture);
      const baselineOperator = computeOperatorBuildHash(fixture);

      appendFileSync(join(fixture, "src/paper/paper-acceptance-summary.ts"), "\n// validation-policy-mutation\n");
      expect(computeCoreCompatibilityHash(buildCurrentCoreCompatibilityManifest(fixture))).toBe(baselineCore);
      expect(computeValidationPolicyHash(fixture)).not.toBe(baselinePolicy);
      expect(computeOperatorBuildHash(fixture)).toBe(baselineOperator);

      const policyBeforeOperatorEvidence = computeValidationPolicyHash(fixture);
      appendFileSync(join(fixture, "src/paper-validation/operator-evidence.ts"), "\n// evidence-report-mutation\n");
      expect(computeCoreCompatibilityHash(buildCurrentCoreCompatibilityManifest(fixture))).toBe(baselineCore);
      expect(computeValidationPolicyHash(fixture)).not.toBe(policyBeforeOperatorEvidence);

      appendFileSync(join(fixture, "操作入口/README_只需看这里.txt"), "\noperator-presentation-mutation\n");
      expect(computeCoreCompatibilityHash(buildCurrentCoreCompatibilityManifest(fixture))).toBe(baselineCore);
      expect(computeOperatorBuildHash(fixture)).not.toBe(baselineOperator);

      const operatorBeforeCliMutation = computeOperatorBuildHash(fixture);
      appendFileSync(join(fixture, "src/cli/paper-campaign-run.ts"), "\n// operator-orchestration-mutation\n");
      expect(computeCoreCompatibilityHash(buildCurrentCoreCompatibilityManifest(fixture))).toBe(baselineCore);
      expect(computeOperatorBuildHash(fixture)).not.toBe(operatorBeforeCliMutation);

      appendFileSync(join(fixture, "src/infra/sqlite/database.ts"), "\n// non-paper-migration-registration\n");
      appendFileSync(
        join(fixture, "src/infra/sqlite/runtime-database-preparation.ts"),
        "\n// non-paper-runtime-registry\n",
      );
      expect(computeCoreCompatibilityHash(buildCurrentCoreCompatibilityManifest(fixture))).toBe(baselineCore);

      const schemaContractPath = join(fixture, "src/infra/sqlite/paper-runtime-schema-contract.ts");
      const schemaContractSource = readFileSync(schemaContractPath, "utf8");
      appendFileSync(schemaContractPath, "\n// paper-schema-contract-mutation\n");
      expect(computeCoreCompatibilityHash(buildCurrentCoreCompatibilityManifest(fixture))).not.toBe(baselineCore);
      writeFileSync(schemaContractPath, schemaContractSource);

      const recoveryPath = join(fixture, "src/paper-validation/runtime-recovery.ts");
      const recoverySource = readFileSync(recoveryPath, "utf8");
      appendFileSync(recoveryPath, "\n// recovery-mutation\n");
      expect(computeCoreCompatibilityHash(buildCurrentCoreCompatibilityManifest(fixture))).not.toBe(baselineCore);
      writeFileSync(recoveryPath, recoverySource);

      for (const runtimeBoundaryPath of [
        "src/infra/source-version.ts",
        "src/operator/safe-child-environment.ts",
        "src/paper-validation/campaign-session-runtime.ts",
        "src/paper-validation/checkpoint-evidence.ts",
        "src/paper-validation/final-integrity.ts",
        "src/paper-validation/operator-policy.ts",
        "src/paper-validation/report.ts",
        "src/paper/paper-session-runtime.ts",
        "src/domain/canonical-json.ts",
      ]) {
        const path = join(fixture, runtimeBoundaryPath);
        const source = readFileSync(path, "utf8");
        appendFileSync(path, "\n// runtime-boundary-mutation\n");
        expect(computeCoreCompatibilityHash(buildCurrentCoreCompatibilityManifest(fixture))).not.toBe(baselineCore);
        writeFileSync(path, source);
      }

      const packagePath = join(fixture, "package.json");
      const originalPackage = readFileSync(packagePath, "utf8");
      const devOnlyPackage = JSON.parse(originalPackage) as {
        devDependencies: Record<string, string>;
      };
      devOnlyPackage.devDependencies.vitest = "999.0.0";
      writeFileSync(packagePath, `${JSON.stringify(devOnlyPackage, null, 2)}\n`);
      expect(computeCoreCompatibilityHash(buildCurrentCoreCompatibilityManifest(fixture))).toBe(baselineCore);

      const runtimePackage = JSON.parse(originalPackage) as {
        dependencies: Record<string, string>;
      };
      runtimePackage.dependencies.viem = "999.0.0";
      writeFileSync(packagePath, `${JSON.stringify(runtimePackage, null, 2)}\n`);
      // viem is currently Live-only, so its version must not reset Paper.
      expect(computeCoreCompatibilityHash(buildCurrentCoreCompatibilityManifest(fixture))).toBe(baselineCore);
      writeFileSync(packagePath, originalPackage);

      appendFileSync(
        join(fixture, "src/paper/paper-executor.ts"),
        "\nimport type { Address } from \"viem\";\n// runtime-behavior-mutation\n",
      );
      const dependencyNowUsed = computeCoreCompatibilityHash(buildCurrentCoreCompatibilityManifest(fixture));
      expect(dependencyNowUsed).not.toBe(baselineCore);
      writeFileSync(packagePath, `${JSON.stringify(runtimePackage, null, 2)}\n`);
      expect(computeCoreCompatibilityHash(buildCurrentCoreCompatibilityManifest(fixture)))
        .not.toBe(dependencyNowUsed);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("records validation and operator identities without adding them to Campaign reset", () => {
    const manifest = buildCurrentCoreCompatibilityManifest(projectRoot);
    const evidence = buildCurrentCompatibilityEvidence(projectRoot);
    expect(evidence.validationPolicyHash).toMatch(/^[a-f0-9]{64}$/);
    expect(evidence.operatorBuildHash).toMatch(/^[a-f0-9]{64}$/);
    expect(evidence.artifactProvenanceHash).toBe(ARTIFACT_PROVENANCE_HASH);
    expect(evidence.artifactProvenanceSnapshotJson).toBe(ARTIFACT_PROVENANCE_SNAPSHOT_JSON);
    expect(computeCoreCompatibilityHash(manifest)).not.toBe(evidence.validationPolicyHash);
    expect(computeCoreCompatibilityHash(manifest)).not.toBe(evidence.operatorBuildHash);
  });

  it("keeps presentation reports outside while retaining runtime accounting and orchestration", () => {
    expect(CORE_COMPATIBILITY_PAPER_FILES).toContain("src/paper/paper-executor.ts");
    expect(CORE_COMPATIBILITY_PAPER_FILES).not.toContain("src/paper/paper-acceptance-summary.ts");
    expect(CORE_COMPATIBILITY_PAPER_FILES).not.toContain("src/paper/paper-execution-funnel.ts");
    expect(CORE_COMPATIBILITY_PAPER_FILES).not.toContain("src/paper/paper-gate-evaluator.ts");
    expect(CORE_COMPATIBILITY_CAMPAIGN_RUNTIME_FILES).toContain("src/paper-validation/crash-recovery.ts");
    expect(CORE_COMPATIBILITY_CAMPAIGN_RUNTIME_FILES).toContain("src/paper-validation/runtime-recovery.ts");
    expect(CORE_COMPATIBILITY_CAMPAIGN_RUNTIME_FILES).toContain("src/paper-validation/service.ts");
    expect(CORE_COMPATIBILITY_CAMPAIGN_RUNTIME_FILES).toContain("src/paper-validation/final-integrity.ts");
    expect(CORE_COMPATIBILITY_CAMPAIGN_RUNTIME_FILES).toContain("src/paper-validation/operator-policy.ts");
    expect(CORE_COMPATIBILITY_CAMPAIGN_RUNTIME_FILES).not.toContain("src/cli/observe-only.ts");
    expect(CORE_COMPATIBILITY_CAMPAIGN_RUNTIME_FILES).not.toContain("src/cli/paper-campaign-run.ts");
    expect(CORE_COMPATIBILITY_CAMPAIGN_RUNTIME_FILES).not.toContain("src/cli/paper-run.ts");
    expect(CORE_COMPATIBILITY_CAMPAIGN_RUNTIME_FILES).not.toContain("src/paper-validation/operator-evidence.ts");
    expect(CORE_COMPATIBILITY_CAMPAIGN_RUNTIME_FILES).not.toContain("src/paper-validation/preflight.ts");
    expect(CORE_COMPATIBILITY_CAMPAIGN_RUNTIME_FILES).toContain("src/paper-validation/report.ts");
  });
});
