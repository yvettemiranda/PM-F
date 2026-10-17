import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveSourceVersion } from "../infra/source-version.js";
import {
  liveProductionValidationArtifactPath,
  liveProductionEvidencePathsFromArguments,
  readLiveProductionValidationEvidence,
  type LiveProductionValidationArtifact,
} from "../operator/production-live-prerequisites.js";
import { resolveLiveProductionRuntimeIdentity } from "../operator/live-production-build.js";

const projectRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const evidencePaths = liveProductionEvidencePathsFromArguments(process.argv.slice(2));
const node = process.execPath;
const sourceVersion = resolveSourceVersion(projectRoot);
const runtimeIdentityBefore = resolveLiveProductionRuntimeIdentity(projectRoot, sourceVersion);
if (runtimeIdentityBefore.runtimeSourceDirty) {
  throw new Error("LIVE_PRODUCTION_VALIDATION_REQUIRES_CLEAN_RUNTIME_SOURCE");
}

const evidenceBefore = readLiveProductionValidationEvidence({ projectRoot, sourceCodeCommit: sourceVersion.commit, ...evidencePaths });

execFileSync(node, ["node_modules/typescript/bin/tsc", "--noEmit"], {
  cwd: projectRoot,
  stdio: "inherit",
});
const testOutput = execFileSync(node, ["node_modules/vitest/vitest.mjs", "run"], {
  cwd: projectRoot,
  encoding: "utf8",
  env: process.env,
});
process.stdout.write(testOutput);
execFileSync("git", ["diff", "--check"], { cwd: projectRoot, stdio: "inherit" });
const runtimeIdentityAfter = resolveLiveProductionRuntimeIdentity(
  projectRoot,
  resolveSourceVersion(projectRoot),
);
if (runtimeIdentityAfter.runtimeSourceDirty) {
  throw new Error("LIVE_PRODUCTION_RUNTIME_SOURCE_CHANGED_DURING_VALIDATION");
}
if (runtimeIdentityAfter.liveRuntimeHash !== runtimeIdentityBefore.liveRuntimeHash) {
  throw new Error("LIVE_PRODUCTION_RUNTIME_HASH_CHANGED_DURING_VALIDATION");
}
if (runtimeIdentityAfter.sourceVersion.commit !== sourceVersion.commit) {
  throw new Error("LIVE_PRODUCTION_SOURCE_COMMIT_CHANGED_DURING_VALIDATION");
}

const fileMatch = testOutput.match(/Test Files\s+(\d+) passed/);
const testMatch = testOutput.match(/Tests\s+(\d+) passed/);
if (!fileMatch || !testMatch) throw new Error("LIVE_PRODUCTION_TEST_SUMMARY_UNAVAILABLE");
const evidenceAfter = readLiveProductionValidationEvidence({ projectRoot, sourceCodeCommit: sourceVersion.commit, ...evidencePaths });
if (JSON.stringify(evidenceAfter) !== JSON.stringify(evidenceBefore)) {
  throw new Error("LIVE_PRODUCTION_EVIDENCE_CHANGED_DURING_VALIDATION");
}
const artifact: LiveProductionValidationArtifact = {
  schemaVersion: "live-production-validation-v3",
  status: "PASSED",
  sourceCodeCommit: runtimeIdentityAfter.sourceVersion.commit,
  sourceCodeDirty: runtimeIdentityAfter.sourceVersion.dirty,
  liveRuntimeHash: runtimeIdentityAfter.liveRuntimeHash,
  runtimeSourceDirty: false,
  generatedAt: new Date().toISOString(),
  typecheckPassed: true,
  fullTestPassed: true,
  testFileCount: Number(fileMatch[1]),
  testCount: Number(testMatch[1]),
  diffCheckPassed: true,
  ...evidenceAfter,
};
const outputPath = liveProductionValidationArtifactPath(projectRoot);
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, {
  encoding: "utf8",
  mode: 0o600,
});
console.log(`Live production validation artifact: ${outputPath}`);
