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
  target?: string;
  captureRunId?: string;
  sourceCodeCommit?: string;
  sourceCodeDirty?: boolean;
  identityStatus?: string;
  captureStatus?: string;
  apiContractStatus?: string;
  apiSchemaErrorCount?: number;
  apiWarnings?: string[];
  tradeHistoryComplete?: boolean;
  activityHistoryComplete?: boolean;
  positionHistoryComplete?: boolean;
  tradeHistoryStopCategory?: string;
  activityHistoryStopCategory?: string;
  positionHistoryStopCategory?: string;
  replayStatus?: string;
  replayIncompleteReasons?: string[];
  ambiguousEvents?: number;
  replayHash?: string;
}

interface CaptureReplayResult {
  captureRunId?: string;
  sourceCodeCommit?: string;
  sourceCodeDirty?: boolean;
  identityStatus?: string;
  tradeHistoryComplete?: boolean;
  activityHistoryComplete?: boolean;
  positionHistoryComplete?: boolean;
  replayStatus?: string;
  replayIncompleteReasons?: string[];
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
  targetWallet: string;
  phase0ReplayStatus: "PASSED" | "INCOMPLETE_KNOWN_LIMITATIONS";
  acceptedIncompleteReasons: string[];
  passedTestFileCount: number;
  passedTestCount: number;
}

const DESIGN_LIMITATIONS = [
  "HISTORICAL_CAPITAL_SNAPSHOTS_MISSING",
  "GOLDEN_EXPECTATIONS_MISSING",
  "STARTING_POSITION_BASELINE_MISSING",
] as const;
const TRADE_TRUNCATION_REASON = "TRADE_HISTORY_TRUNCATED";
const ACTIVITY_TRUNCATION_REASON = "ACTIVITY_HISTORY_TRUNCATED";
const TRADE_TRUNCATION_WARNING = "TRADE_HISTORY_TRUNCATED_BY_SOURCE_OFFSET_LIMIT";
const ACTIVITY_TRUNCATION_WARNING = "ACTIVITY_HISTORY_TRUNCATED_BY_SOURCE_OFFSET_LIMIT";
const KNOWN_OFFSET_LIMIT_STOP_CATEGORIES = new Set([
  "SOURCE_OFFSET_LIMIT",
  "CLIENT_OFFSET_LIMIT",
]);

function exactStringSet(actual: unknown, expected: readonly string[]): boolean {
  return Array.isArray(actual)
    && actual.every((item) => typeof item === "string")
    && new Set(actual).size === actual.length
    && JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());
}

function proofReasonShapeIsValid(proofs: IsolatedVerificationProofs): boolean {
  if (proofs.phase0ReplayStatus === "PASSED") {
    return exactStringSet(proofs.acceptedIncompleteReasons, []);
  }
  return [
    [...DESIGN_LIMITATIONS],
    [...DESIGN_LIMITATIONS, TRADE_TRUNCATION_REASON],
    [...DESIGN_LIMITATIONS, ACTIVITY_TRUNCATION_REASON],
    [...DESIGN_LIMITATIONS, TRADE_TRUNCATION_REASON, ACTIVITY_TRUNCATION_REASON],
  ].some((expected) => exactStringSet(proofs.acceptedIncompleteReasons, expected));
}

function acceptedPhase0ReplayStatus(phase0: Phase0ValidationResult):
  "PASSED" | "INCOMPLETE_KNOWN_LIMITATIONS" | null {
  if (
    phase0.identityStatus !== "IDENTITY_CONFIRMED"
    || phase0.captureStatus !== "COMPLETE"
    || phase0.apiSchemaErrorCount !== 0
    || phase0.ambiguousEvents !== 0
    || phase0.positionHistoryComplete !== true
    || phase0.positionHistoryStopCategory !== "END_OF_DATA"
  ) return null;

  if (phase0.replayStatus === "PASSED") {
    return phase0.apiContractStatus === "PASSED"
      && phase0.tradeHistoryComplete === true
      && phase0.activityHistoryComplete === true
      && phase0.tradeHistoryStopCategory === "END_OF_DATA"
      && phase0.activityHistoryStopCategory === "END_OF_DATA"
      && exactStringSet(phase0.apiWarnings, [])
      && exactStringSet(phase0.replayIncompleteReasons, [])
      ? "PASSED"
      : null;
  }
  if (phase0.replayStatus !== "INCOMPLETE") return null;

  const tradeTruncated = phase0.tradeHistoryComplete === false;
  const activityTruncated = phase0.activityHistoryComplete === false;
  const expectedReasons = [
    ...DESIGN_LIMITATIONS,
    ...(tradeTruncated ? [TRADE_TRUNCATION_REASON] : []),
    ...(activityTruncated ? [ACTIVITY_TRUNCATION_REASON] : []),
  ];
  const expectedWarnings = [
    ...(tradeTruncated ? [TRADE_TRUNCATION_WARNING] : []),
    ...(activityTruncated ? [ACTIVITY_TRUNCATION_WARNING] : []),
  ];
  const paginationMatches = phase0.tradeHistoryComplete === true
    ? phase0.tradeHistoryStopCategory === "END_OF_DATA"
    : KNOWN_OFFSET_LIMIT_STOP_CATEGORIES.has(phase0.tradeHistoryStopCategory ?? "");
  const activityPaginationMatches = phase0.activityHistoryComplete === true
    ? phase0.activityHistoryStopCategory === "END_OF_DATA"
    : KNOWN_OFFSET_LIMIT_STOP_CATEGORIES.has(phase0.activityHistoryStopCategory ?? "");
  const expectedApiStatus = expectedWarnings.length === 0 ? "PASSED" : "INCOMPLETE";
  return phase0.apiContractStatus === expectedApiStatus
    && paginationMatches
    && activityPaginationMatches
    && exactStringSet(phase0.apiWarnings, expectedWarnings)
    && exactStringSet(phase0.replayIncompleteReasons, expectedReasons)
    ? "INCOMPLETE_KNOWN_LIMITATIONS"
    : null;
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
  targetWallet: string;
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
  const targetWallet = input.targetWallet.toLowerCase();
  const phase0ReplayStatus = acceptedPhase0ReplayStatus(phase0);
  if (
    !/^0x[0-9a-f]{40}$/.test(targetWallet)
    || phase0.target?.toLowerCase() !== targetWallet
    || !phase0.captureRunId?.match(SHA256_PATTERN)
    || phase0.sourceCodeCommit !== input.sourceCodeCommit
    || phase0.sourceCodeDirty !== false
    || phase0ReplayStatus === null
    || !phase0.replayHash?.match(SHA256_PATTERN)
  ) {
    throw new Error("PHASE0_VALIDATION_PROOF_INVALID");
  }

  const replay = parseJsonOutput<CaptureReplayResult>(input.replayResultContent, "CAPTURE_REPLAY_RESULT");
  if (
    replay.captureRunId !== phase0.captureRunId
    || replay.sourceCodeCommit !== input.sourceCodeCommit
    || replay.sourceCodeDirty !== false
    || replay.identityStatus !== phase0.identityStatus
    || replay.tradeHistoryComplete !== phase0.tradeHistoryComplete
    || replay.activityHistoryComplete !== phase0.activityHistoryComplete
    || replay.positionHistoryComplete !== phase0.positionHistoryComplete
    || replay.replayStatus !== phase0.replayStatus
    || !exactStringSet(replay.replayIncompleteReasons, phase0.replayIncompleteReasons ?? [])
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
    targetWallet,
    phase0ReplayStatus,
    acceptedIncompleteReasons: phase0.replayIncompleteReasons ?? [],
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
    && /^0x[0-9a-f]{40}$/.test(proofs.targetWallet)
    && (proofs.phase0ReplayStatus === "PASSED" || proofs.phase0ReplayStatus === "INCOMPLETE_KNOWN_LIMITATIONS")
    && Array.isArray(proofs.acceptedIncompleteReasons)
    && proofs.acceptedIncompleteReasons.every((reason) => typeof reason === "string")
    && new Set(proofs.acceptedIncompleteReasons).size === proofs.acceptedIncompleteReasons.length
    && proofReasonShapeIsValid(proofs)
    && Number.isInteger(proofs.passedTestFileCount)
    && proofs.passedTestFileCount > 0
    && Number.isInteger(proofs.passedTestCount)
    && proofs.passedTestCount > 0,
  );
}
