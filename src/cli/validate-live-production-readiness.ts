import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveSourceVersion } from "../infra/source-version.js";
import {
  liveProductionValidationArtifactPath,
  type LiveProductionValidationArtifact,
} from "../operator/production-live-prerequisites.js";

const projectRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const node = process.execPath;
const sourceVersion = resolveSourceVersion(projectRoot);
if (sourceVersion.dirty) throw new Error("LIVE_PRODUCTION_VALIDATION_REQUIRES_CLEAN_WORKTREE");

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

const fileMatch = testOutput.match(/Test Files\s+(\d+) passed/);
const testMatch = testOutput.match(/Tests\s+(\d+) passed/);
if (!fileMatch || !testMatch) throw new Error("LIVE_PRODUCTION_TEST_SUMMARY_UNAVAILABLE");
const finalReport = readFileSync(
  resolve(projectRoot, "data/operator/final-reports/ni-k-paper-mixed-core-24h-final-20260727-0300.md"),
  "utf8",
);
const isolatedVerification = readFileSync(
  resolve(projectRoot, "data/operator/paper-campaign-isolated-verification.json"),
  "utf8",
);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const artifact: LiveProductionValidationArtifact = {
  schemaVersion: "live-production-validation-v1",
  status: "PASSED",
  sourceCodeCommit: sourceVersion.commit,
  sourceCodeDirty: false,
  generatedAt: new Date().toISOString(),
  typecheckPassed: true,
  fullTestPassed: true,
  testFileCount: Number(fileMatch[1]),
  testCount: Number(testMatch[1]),
  diffCheckPassed: true,
  finalPaperReportSha256: hash(finalReport),
  isolatedVerificationSha256: hash(isolatedVerification),
};
const outputPath = liveProductionValidationArtifactPath(projectRoot);
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, {
  encoding: "utf8",
  mode: 0o600,
});
console.log(`Live production validation artifact: ${outputPath}`);
