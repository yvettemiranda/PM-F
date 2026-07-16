import { describe, expect, it } from "vitest";
import {
  isolatedVerificationProofsAreWellFormed,
  verifyIsolatedProofArtifacts,
} from "../src/paper-validation/isolated-proof.js";

const commit = "a".repeat(40);
const captureRunId = "b".repeat(64);
const replayHash = "c".repeat(64);
const projectRoot = "/tmp/ni-k";
const expectedTestFiles = ["tests/one.test.ts", "tests/two.test.ts"];

function artifacts() {
  return {
    projectRoot,
    sourceCodeCommit: commit,
    expectedTestFiles,
    vitestResultContent: JSON.stringify({
      success: true,
      numTotalTests: 3,
      numPassedTests: 3,
      numFailedTests: 0,
      numFailedTestSuites: 0,
      testResults: expectedTestFiles.map((name) => ({ name: `${projectRoot}/${name}`, status: "passed" })),
    }),
    phase0ResultContent: `phase0 output\n${JSON.stringify({
      captureRunId,
      sourceCodeCommit: commit,
      sourceCodeDirty: false,
      replayStatus: "PASSED",
      replayHash,
    })}`,
    replayResultContent: `replay output\n${JSON.stringify({
      captureRunId,
      sourceCodeCommit: commit,
      replayHash,
      storedReplayHashes: [replayHash, replayHash],
      stable: true,
    })}`,
  };
}

describe("isolated verification proof artifacts", () => {
  it("binds passed Vitest files and a stable saved-data replay into immutable hashes", () => {
    const proofs = verifyIsolatedProofArtifacts(artifacts());
    expect(proofs).toMatchObject({
      captureRunId,
      replayHash,
      passedTestFileCount: 2,
      passedTestCount: 3,
    });
    expect(isolatedVerificationProofsAreWellFormed(proofs)).toBe(true);
  });

  it("rejects a missing test file or replay hash mismatch", () => {
    const missingTest = artifacts();
    missingTest.vitestResultContent = JSON.stringify({
      success: true,
      numTotalTests: 1,
      numPassedTests: 1,
      numFailedTests: 0,
      numFailedTestSuites: 0,
      testResults: [{ name: `${projectRoot}/tests/one.test.ts`, status: "passed" }],
    });
    expect(() => verifyIsolatedProofArtifacts(missingTest)).toThrow("ISOLATED_VITEST_FILE_SET_MISMATCH");

    const mismatchedReplay = artifacts();
    mismatchedReplay.replayResultContent = JSON.stringify({
      captureRunId,
      sourceCodeCommit: commit,
      replayHash: "d".repeat(64),
      storedReplayHashes: ["d".repeat(64)],
      stable: true,
    });
    expect(() => verifyIsolatedProofArtifacts(mismatchedReplay)).toThrow("CAPTURE_REPLAY_PROOF_INVALID");
  });
});
