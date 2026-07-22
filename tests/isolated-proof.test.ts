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
const targetWallet = "0x0000000000000000000000000000000000000001";

function artifacts() {
  return {
    projectRoot,
    sourceCodeCommit: commit,
    targetWallet,
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
      target: targetWallet,
      captureRunId,
      sourceCodeCommit: commit,
      sourceCodeDirty: false,
      identityStatus: "IDENTITY_CONFIRMED",
      captureStatus: "COMPLETE",
      apiContractStatus: "PASSED",
      apiSchemaErrorCount: 0,
      apiWarnings: [],
      tradeHistoryComplete: true,
      activityHistoryComplete: true,
      positionHistoryComplete: true,
      tradeHistoryStopCategory: "END_OF_DATA",
      activityHistoryStopCategory: "END_OF_DATA",
      positionHistoryStopCategory: "END_OF_DATA",
      replayStatus: "PASSED",
      replayIncompleteReasons: [],
      ambiguousEvents: 0,
      replayHash,
    })}`,
    replayResultContent: `replay output\n${JSON.stringify({
      captureRunId,
      sourceCodeCommit: commit,
      sourceCodeDirty: false,
      identityStatus: "IDENTITY_CONFIRMED",
      tradeHistoryComplete: true,
      activityHistoryComplete: true,
      positionHistoryComplete: true,
      replayStatus: "PASSED",
      replayIncompleteReasons: [],
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
      phase0ReplayStatus: "PASSED",
      acceptedIncompleteReasons: [],
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
      sourceCodeDirty: false,
      replayHash: "d".repeat(64),
      storedReplayHashes: ["d".repeat(64)],
      stable: true,
    });
    expect(() => verifyIsolatedProofArtifacts(mismatchedReplay)).toThrow("CAPTURE_REPLAY_PROOF_INVALID");

    const mismatchedTarget = artifacts();
    mismatchedTarget.targetWallet = "0x0000000000000000000000000000000000000002";
    expect(() => verifyIsolatedProofArtifacts(mismatchedTarget)).toThrow("PHASE0_VALIDATION_PROOF_INVALID");
  });

  it("accepts only the exact stable Phase 0 limitations produced by source offset caps", () => {
    const reasons = [
      "HISTORICAL_CAPITAL_SNAPSHOTS_MISSING",
      "GOLDEN_EXPECTATIONS_MISSING",
      "STARTING_POSITION_BASELINE_MISSING",
      "TRADE_HISTORY_TRUNCATED",
      "ACTIVITY_HISTORY_TRUNCATED",
    ];
    const phase0 = {
      target: targetWallet,
      captureRunId,
      sourceCodeCommit: commit,
      sourceCodeDirty: false,
      identityStatus: "IDENTITY_CONFIRMED",
      captureStatus: "COMPLETE",
      apiContractStatus: "INCOMPLETE",
      apiSchemaErrorCount: 0,
      apiWarnings: [
        "TRADE_HISTORY_TRUNCATED_BY_SOURCE_OFFSET_LIMIT",
        "ACTIVITY_HISTORY_TRUNCATED_BY_SOURCE_OFFSET_LIMIT",
      ],
      tradeHistoryComplete: false,
      activityHistoryComplete: false,
      positionHistoryComplete: true,
      tradeHistoryStopCategory: "SOURCE_OFFSET_LIMIT",
      activityHistoryStopCategory: "SOURCE_OFFSET_LIMIT",
      positionHistoryStopCategory: "END_OF_DATA",
      replayStatus: "INCOMPLETE",
      replayIncompleteReasons: reasons,
      ambiguousEvents: 0,
      replayHash,
    };
    const replay = {
      captureRunId,
      sourceCodeCommit: commit,
      sourceCodeDirty: false,
      identityStatus: "IDENTITY_CONFIRMED",
      tradeHistoryComplete: false,
      activityHistoryComplete: false,
      positionHistoryComplete: true,
      replayStatus: "INCOMPLETE",
      replayIncompleteReasons: reasons,
      replayHash,
      storedReplayHashes: [replayHash],
      stable: true,
    };

    for (const [tradeHistoryStopCategory, activityHistoryStopCategory] of [
      ["SOURCE_OFFSET_LIMIT", "SOURCE_OFFSET_LIMIT"],
      ["CLIENT_OFFSET_LIMIT", "SOURCE_OFFSET_LIMIT"],
      ["SOURCE_OFFSET_LIMIT", "CLIENT_OFFSET_LIMIT"],
    ] as const) {
      const limited = artifacts();
      limited.phase0ResultContent = `phase0 output\n${JSON.stringify({
        ...phase0,
        tradeHistoryStopCategory,
        activityHistoryStopCategory,
      })}`;
      limited.replayResultContent = `replay output\n${JSON.stringify(replay)}`;

      expect(verifyIsolatedProofArtifacts(limited)).toMatchObject({
        phase0ReplayStatus: "INCOMPLETE_KNOWN_LIMITATIONS",
        acceptedIncompleteReasons: reasons,
      });
    }
  });

  it("rejects unknown limitations, schema failures, pagination mismatches, or replay disagreement", () => {
    const phase0 = {
      target: targetWallet,
      captureRunId,
      sourceCodeCommit: commit,
      sourceCodeDirty: false,
      identityStatus: "IDENTITY_CONFIRMED",
      captureStatus: "COMPLETE",
      apiContractStatus: "INCOMPLETE",
      apiSchemaErrorCount: 0,
      apiWarnings: ["TRADE_HISTORY_TRUNCATED_BY_SOURCE_OFFSET_LIMIT"],
      tradeHistoryComplete: false,
      activityHistoryComplete: true,
      positionHistoryComplete: true,
      tradeHistoryStopCategory: "SOURCE_OFFSET_LIMIT",
      activityHistoryStopCategory: "END_OF_DATA",
      positionHistoryStopCategory: "END_OF_DATA",
      replayStatus: "INCOMPLETE",
      replayIncompleteReasons: [
        "HISTORICAL_CAPITAL_SNAPSHOTS_MISSING",
        "GOLDEN_EXPECTATIONS_MISSING",
        "STARTING_POSITION_BASELINE_MISSING",
        "TRADE_HISTORY_TRUNCATED",
      ],
      ambiguousEvents: 0,
      replayHash,
    };
    const replay = {
      captureRunId,
      sourceCodeCommit: commit,
      sourceCodeDirty: false,
      identityStatus: "IDENTITY_CONFIRMED",
      tradeHistoryComplete: false,
      activityHistoryComplete: true,
      positionHistoryComplete: true,
      replayStatus: "INCOMPLETE",
      replayIncompleteReasons: phase0.replayIncompleteReasons,
      replayHash,
      storedReplayHashes: [replayHash],
      stable: true,
    };

    for (const mutate of [
      (value: typeof phase0) => ({ ...value, replayIncompleteReasons: [...value.replayIncompleteReasons, "AMBIGUOUS_DUPLICATE_EVENTS"] }),
      (value: typeof phase0) => ({ ...value, apiContractStatus: "FAILED", apiSchemaErrorCount: 1 }),
      (value: typeof phase0) => ({ ...value, tradeHistoryStopCategory: "HTTP_400" }),
      (value: typeof phase0) => ({ ...value, apiWarnings: [] }),
      (value: typeof phase0) => ({ ...value, positionHistoryComplete: false, positionHistoryStopCategory: "SOURCE_OFFSET_LIMIT" }),
    ]) {
      const invalid = artifacts();
      invalid.phase0ResultContent = JSON.stringify(mutate(phase0));
      invalid.replayResultContent = JSON.stringify(replay);
      expect(() => verifyIsolatedProofArtifacts(invalid)).toThrow("PHASE0_VALIDATION_PROOF_INVALID");
    }

    const mismatch = artifacts();
    mismatch.phase0ResultContent = JSON.stringify(phase0);
    mismatch.replayResultContent = JSON.stringify({ ...replay, replayIncompleteReasons: [] });
    expect(() => verifyIsolatedProofArtifacts(mismatch)).toThrow("CAPTURE_REPLAY_PROOF_INVALID");
  });
});
