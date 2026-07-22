import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { resolveSourceVersion } from "../infra/source-version.js";
import {
  buildCurrentCoreCompatibilityManifest,
  computeCoreCompatibilityHash,
  computeVerificationSuiteHash,
} from "../paper-validation/core-compatibility.js";
import {
  buildIsolatedVerificationEvidence,
  PAPER_CAMPAIGN_ISOLATED_TEST_FILES,
  verifyIsolatedVerificationEvidence,
  type IsolatedVerificationEvidence,
} from "../paper-validation/operator-evidence.js";
import type { PaperValidationScenario } from "../paper-validation/types.js";
import { verifyIsolatedProofArtifacts } from "../paper-validation/isolated-proof.js";
import { normalizeTargetWallet } from "../operator/target-wallet.js";

const projectRoot = resolve(new URL("../..", import.meta.url).pathname);
const args = process.argv.slice(2);
const command = args[0] ?? "verify";
const valueArg = (name: string): string | undefined => args
  .find((argument) => argument.startsWith(`--${name}=`))
  ?.slice(name.length + 3);
const output = resolve(valueArg("file") ?? "data/operator/paper-campaign-isolated-verification.json");

async function writeAtomically(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

const deterministicCoverage: PaperValidationScenario[] = [
  "BUY",
  "SELL",
  "RISK_ALLOW",
  "RISK_REJECT",
  "MIN_ORDER_REJECT",
  "PARTIAL_FILL",
  "RESERVATION_RELEASE",
  "STOP_LOSS",
  "SETTLEMENT",
  "NO_ORDERBOOK_RECOVERY",
  "SAFE_STOP",
  "RESTART_RECOVERY",
  "CRASH_RECOVERY",
  "RECONCILIATION",
];

if (command === "list-tests") {
  console.log(PAPER_CAMPAIGN_ISOLATED_TEST_FILES.join("\n"));
  process.exit(0);
}
const targetWallet = normalizeTargetWallet(valueArg("target-wallet"));

function currentCompatibilityHashes(): {
  coreCompatibilityHash: string;
  verificationSuiteHash: string;
} {
  const manifest = buildCurrentCoreCompatibilityManifest(projectRoot);
  return {
    coreCompatibilityHash: computeCoreCompatibilityHash(manifest),
    verificationSuiteHash: computeVerificationSuiteHash(projectRoot),
  };
}

if (command === "write-passed") {
  const { coreCompatibilityHash, verificationSuiteHash } = currentCompatibilityHashes();
  const sourceVersion = resolveSourceVersion(projectRoot);
  if (sourceVersion.dirty) throw new Error("ISOLATED_EVIDENCE_REQUIRES_CLEAN_SOURCE");
  const testResultsPath = valueArg("test-results");
  const phase0ResultsPath = valueArg("phase0-results");
  const replayResultsPath = valueArg("replay-results");
  if (!testResultsPath || !phase0ResultsPath || !replayResultsPath) {
    throw new Error("ISOLATED_EVIDENCE_PROOF_ARTIFACTS_REQUIRED");
  }
  const proofs = verifyIsolatedProofArtifacts({
    projectRoot,
    sourceCodeCommit: sourceVersion.commit,
    targetWallet,
    expectedTestFiles: PAPER_CAMPAIGN_ISOLATED_TEST_FILES,
    vitestResultContent: await readFile(resolve(testResultsPath), "utf8"),
    phase0ResultContent: await readFile(resolve(phase0ResultsPath), "utf8"),
    replayResultContent: await readFile(resolve(replayResultsPath), "utf8"),
  });
  const evidence = buildIsolatedVerificationEvidence({
    status: "PASSED",
    targetWallet,
    coreCompatibilityHash,
    verificationSuiteHash,
    sourceCodeCommit: sourceVersion.commit,
    generatedAt: new Date().toISOString(),
    coverage: deterministicCoverage,
    testFiles: [...PAPER_CAMPAIGN_ISOLATED_TEST_FILES],
    replayStatus: proofs.phase0ReplayStatus,
    proofs,
    safety: {
      executionMode: "PAPER",
      liveGateState: "LIVE_DISABLED",
      privateKeyLoaded: false,
      authenticatedTradingClientPresent: false,
      realOrdersCreated: 0,
      chainWrites: 0,
    },
  });
  await writeAtomically(output, evidence);
  console.log(JSON.stringify({
    status: "PASSED",
    output,
    artifactHash: evidence.artifactHash,
    phase0ReplayStatus: evidence.proofs.phase0ReplayStatus,
    acceptedIncompleteReasons: evidence.proofs.acceptedIncompleteReasons,
  }));
} else if (command === "verify") {
  const { coreCompatibilityHash, verificationSuiteHash } = currentCompatibilityHashes();
  const evidence = JSON.parse(await readFile(output, "utf8")) as IsolatedVerificationEvidence;
  if (!verifyIsolatedVerificationEvidence(
    evidence,
    coreCompatibilityHash,
    verificationSuiteHash,
    targetWallet,
  )) {
    throw new Error("ISOLATED_EVIDENCE_INVALID_OR_CORE_MISMATCH");
  }
  console.log(JSON.stringify({
    status: "PASSED",
    output,
    targetWallet: evidence.targetWallet,
    artifactHash: evidence.artifactHash,
    phase0ReplayStatus: evidence.proofs.phase0ReplayStatus,
    acceptedIncompleteReasons: evidence.proofs.acceptedIncompleteReasons,
  }));
} else if (command === "verify-for-bundle") {
  const expectedSourceCommit = valueArg("source-commit");
  const expectedCoreCompatibilityHash = valueArg("core-compatibility-hash");
  if (!expectedSourceCommit || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(expectedSourceCommit)) {
    throw new Error("BUNDLE_SOURCE_COMMIT_REQUIRED");
  }
  if (!expectedCoreCompatibilityHash || !/^[0-9a-f]{64}$/i.test(expectedCoreCompatibilityHash)) {
    throw new Error("BUNDLE_CORE_COMPATIBILITY_HASH_REQUIRED");
  }
  const evidence = JSON.parse(await readFile(output, "utf8")) as IsolatedVerificationEvidence;
  if (
    evidence.sourceCodeCommit !== expectedSourceCommit
    || evidence.coreCompatibilityHash !== expectedCoreCompatibilityHash
  ) {
    throw new Error("ISOLATED_EVIDENCE_NOT_COMPATIBLE_WITH_BUNDLE");
  }
  const { coreCompatibilityHash, verificationSuiteHash } = currentCompatibilityHashes();
  if (
    !verifyIsolatedVerificationEvidence(
      evidence,
      coreCompatibilityHash,
      verificationSuiteHash,
      targetWallet,
    )
  ) {
    throw new Error("ISOLATED_EVIDENCE_NOT_COMPATIBLE_WITH_BUNDLE");
  }
  console.log(JSON.stringify({
    status: "PASSED",
    output,
    targetWallet: evidence.targetWallet,
    sourceCodeCommit: evidence.sourceCodeCommit,
    coreCompatibilityHash: evidence.coreCompatibilityHash,
    artifactHash: evidence.artifactHash,
  }));
} else {
  throw new Error(`UNKNOWN_PAPER_CAMPAIGN_EVIDENCE_COMMAND:${command}`);
}
