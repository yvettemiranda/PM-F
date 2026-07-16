import { createHash } from "node:crypto";
import { resolve } from "node:path";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

interface VitestJsonResult {
  success?: boolean;
  numTotalTests?: number;
  numPassedTests?: number;
  numFailedTests?: number;
  numFailedTestSuites?: number;
  testResults?: Array<{ name?: string; status?: string }>;
}

interface Phase0ValidationResult {
  captureRunId?: string;
  sourceCodeCommit?: string;
  sourceCodeDirty?: boolean;
  replayStatus?: string;
  replayHash?: string;
}

interface CaptureReplayResult {
  captureRunId?: string;
  sourceCodeCommit?: string;
  replayHash?: string;
  storedReplayHashes?: string[];
  stable?: boolean;
}

export interface IsolatedVerificationProofs {
  vitestResultSha256: string;
  phase0ResultSha256: string;
  replayResultSha256: string;
  captureRunId: string;
  replayHash: string;
  passedTestFileCount: number;
  passedTestCount: number;
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function parseJsonOutput<T>(content: string, label: string): T {
  const start = content.indexOf("{");
  if (start < 0) throw new Error(`${label}_JSON_MISSING`);
  try {
    return JSON.parse(content.slice(start)) as T;
  } catch {
    throw new Error(`${label}_JSON_INVALID`);
  }
}

function relativeTestName(projectRoot: string, name: string): string {
  const absoluteRoot = `${resolve(projectRoot)}/`;
  return name.startsWith(absoluteRoot) ? name.slice(absoluteRoot.length) : name;
}

export function verifyIsolatedProofArtifacts(input: {
  projectRoot: string;
  sourceCodeCommit: string;
  expectedTestFiles: readonly string[];
  vitestResultContent: string;
  phase0ResultContent: string;
  replayResultContent: string;
}): IsolatedVerificationProofs {
  const vitest = parseJsonOutput<VitestJsonResult>(input.vitestResultContent, "VITEST_RESULT");
  if (
    vitest.success !== true
    || vitest.numFailedTests !== 0
    || vitest.numFailedTestSuites !== 0
    || !Number.isInteger(vitest.numTotalTests)
    || !Number.isInteger(vitest.numPassedTests)
    || vitest.numTotalTests! <= 0
    || vitest.numPassedTests !== vitest.numTotalTests
    || !Array.isArray(vitest.testResults)
  ) {
    throw new Error("ISOLATED_VITEST_RESULT_NOT_PASSED");
  }
  const actualFiles = vitest.testResults.map((result) => {
    if (result.status !== "passed" || typeof result.name !== "string") {
      throw new Error("ISOLATED_VITEST_FILE_NOT_PASSED");
    }
    return relativeTestName(input.projectRoot, result.name);
  }).sort();
  const expectedFiles = [...input.expectedTestFiles].sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error("ISOLATED_VITEST_FILE_SET_MISMATCH");
  }

  const phase0 = parseJsonOutput<Phase0ValidationResult>(input.phase0ResultContent, "PHASE0_RESULT");
  if (
    !phase0.captureRunId?.match(SHA256_PATTERN)
    || phase0.sourceCodeCommit !== input.sourceCodeCommit
    || phase0.sourceCodeDirty !== false
    || phase0.replayStatus !== "PASSED"
    || !phase0.replayHash?.match(SHA256_PATTERN)
  ) {
    throw new Error("PHASE0_VALIDATION_PROOF_INVALID");
  }

  const replay = parseJsonOutput<CaptureReplayResult>(input.replayResultContent, "CAPTURE_REPLAY_RESULT");
  if (
    replay.captureRunId !== phase0.captureRunId
    || replay.sourceCodeCommit !== input.sourceCodeCommit
    || replay.replayHash !== phase0.replayHash
    || replay.stable !== true
    || !Array.isArray(replay.storedReplayHashes)
    || replay.storedReplayHashes.length === 0
    || replay.storedReplayHashes.some((hash) => hash !== replay.replayHash)
  ) {
    throw new Error("CAPTURE_REPLAY_PROOF_INVALID");
  }

  return {
    vitestResultSha256: sha256(input.vitestResultContent),
    phase0ResultSha256: sha256(input.phase0ResultContent),
    replayResultSha256: sha256(input.replayResultContent),
    captureRunId: phase0.captureRunId,
    replayHash: phase0.replayHash,
    passedTestFileCount: actualFiles.length,
    passedTestCount: vitest.numPassedTests!,
  };
}

export function isolatedVerificationProofsAreWellFormed(
  proofs: IsolatedVerificationProofs | undefined,
): boolean {
  return Boolean(
    proofs
    && SHA256_PATTERN.test(proofs.vitestResultSha256)
    && SHA256_PATTERN.test(proofs.phase0ResultSha256)
    && SHA256_PATTERN.test(proofs.replayResultSha256)
    && SHA256_PATTERN.test(proofs.captureRunId)
    && SHA256_PATTERN.test(proofs.replayHash)
    && Number.isInteger(proofs.passedTestFileCount)
    && proofs.passedTestFileCount > 0
    && Number.isInteger(proofs.passedTestCount)
    && proofs.passedTestCount > 0,
  );
}
