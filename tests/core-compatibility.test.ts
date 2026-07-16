import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildCurrentCoreCompatibilityManifest,
  CORE_COMPATIBILITY_CAMPAIGN_RUNTIME_FILES,
  CORE_COMPATIBILITY_PAPER_FILES,
  computeCoreCompatibilityHash,
} from "../src/paper-validation/core-compatibility.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("Paper Campaign core compatibility", () => {
  it("captures the complete current core and frozen runtime as stable component hashes", () => {
    const first = buildCurrentCoreCompatibilityManifest(projectRoot);
    const second = buildCurrentCoreCompatibilityManifest(projectRoot);
    expect(first).toEqual(second);
    expect(first.components.runtimeEnvironment).toMatch(/^[a-f0-9]{64}$/);
    for (const value of Object.values(first.components)) {
      expect(value).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(computeCoreCompatibilityHash(first)).toBe(computeCoreCompatibilityHash(second));
  });

  it("keeps reports and operator presentation outside the runtime compatibility boundary", () => {
    expect(CORE_COMPATIBILITY_PAPER_FILES).toContain("src/paper/paper-executor.ts");
    expect(CORE_COMPATIBILITY_PAPER_FILES).not.toContain("src/paper/paper-acceptance-summary.ts");
    expect(CORE_COMPATIBILITY_PAPER_FILES).not.toContain("src/paper/paper-execution-funnel.ts");
    expect(CORE_COMPATIBILITY_PAPER_FILES).not.toContain("src/paper/paper-gate-evaluator.ts");
    expect(CORE_COMPATIBILITY_CAMPAIGN_RUNTIME_FILES).toContain("src/paper-validation/crash-recovery.ts");
    expect(CORE_COMPATIBILITY_CAMPAIGN_RUNTIME_FILES).toContain("src/paper-validation/service.ts");
    expect(CORE_COMPATIBILITY_CAMPAIGN_RUNTIME_FILES).not.toContain("src/cli/paper-campaign-status.ts");
  });
});
