import { createHash } from "node:crypto";
import { stableJson } from "../domain/versioning.js";
import {
  PAPER_VALIDATION_SCENARIOS,
  type CampaignState,
  type CumulativeCoverage,
  type PaperValidationScenario,
  type ScenarioEvidence,
  type SessionRuntimeMetrics,
  type SessionValidationReport,
  type ValidationCheckpoint,
  type ValidationEvidenceSource,
  type ValidationSessionOutcome,
} from "./types.js";

const EXECUTION_EVIDENCE_SCENARIOS = new Set<PaperValidationScenario>([
  "ORDER",
  "FILL",
  "POSITION_UPDATE",
  "FEE",
  "REALIZED_PNL",
  "UNREALIZED_PNL",
]);

const SOURCE_RANK: Record<ValidationEvidenceSource, number> = {
  NATURAL: 4,
  REAL_EXECUTION_REPLAY: 3,
  REAL_SIGNAL_REPLAY: 2,
  ISOLATED_CONTROLLED: 1,
};

export function validationReportHash(report: unknown): string {
  return createHash("sha256").update(stableJson(report)).digest("hex");
}

export function calculateSessionRuntime(input: {
  checkpoints: ValidationCheckpoint[];
  maxCheckpointGapMs: number;
  expectedLiveGateTransitionCount: number;
  outcome: ValidationSessionOutcome;
}): SessionRuntimeMetrics {
  const ordered = [...input.checkpoints].sort((left, right) => left.sequence - right.sequence);
  const recoveryIndex = ordered.findIndex((checkpoint) => checkpoint.checkpointKind === "CRASH_RECOVERY");
  const usable = recoveryIndex === -1 ? ordered : ordered.slice(0, recoveryIndex);
  let effectiveActiveRuntimeMs = 0;
  let currentSegmentMs = 0;
  let longestHealthySegmentMs = 0;
  let acceptedIntervalCount = 0;
  let rejectedIntervalCount = 0;

  for (let index = 1; index < usable.length; index += 1) {
    const previous = usable[index - 1]!;
    const current = usable[index]!;
    const elapsed = current.elapsedRuntimeMs - previous.elapsedRuntimeMs;
    const intervalHealthy = elapsed > 0
      && elapsed <= input.maxCheckpointGapMs
      && previous.observeActive
      && previous.paperActive
      && previous.consistencySafe
      && previous.liveGateTransitionCount === input.expectedLiveGateTransitionCount
      && current.observeActive
      && current.paperActive
      && current.consistencySafe
      && current.liveGateTransitionCount === input.expectedLiveGateTransitionCount;
    if (intervalHealthy) {
      effectiveActiveRuntimeMs += elapsed;
      currentSegmentMs += elapsed;
      longestHealthySegmentMs = Math.max(longestHealthySegmentMs, currentSegmentMs);
      acceptedIntervalCount += 1;
    } else {
      currentSegmentMs = 0;
      rejectedIntervalCount += 1;
    }
  }

  return {
    effectiveActiveRuntimeMs,
    longestHealthySegmentMs,
    qualifyingContinuousRuntimeMs: input.outcome === "CRASH_RECOVERED" ? 0 : longestHealthySegmentMs,
    acceptedIntervalCount,
    rejectedIntervalCount,
    checkpointCount: ordered.length,
  };
}

function chooseEvidence(current: ScenarioEvidence | null, candidate: ScenarioEvidence): ScenarioEvidence {
  if (!current) return candidate;
  if (candidate.covered !== current.covered) return candidate.covered ? candidate : current;
  const currentRank = SOURCE_RANK[current.source];
  const candidateRank = SOURCE_RANK[candidate.source];
  if (candidateRank !== currentRank) return candidateRank > currentRank ? candidate : current;
  return candidate.evidenceId.localeCompare(current.evidenceId) < 0 ? candidate : current;
}

export function mergeCampaignCoverage(reports: SessionValidationReport[]): CumulativeCoverage {
  const result = Object.fromEntries(
    PAPER_VALIDATION_SCENARIOS.map((scenario) => [scenario, null]),
  ) as CumulativeCoverage;
  for (const report of reports.filter((item) => item.countsTowardCampaign)) {
    for (const scenario of PAPER_VALIDATION_SCENARIOS) {
      const evidence = report.coverage[scenario];
      if (evidence) result[scenario] = chooseEvidence(result[scenario], evidence);
    }
  }
  return result;
}

export function scenarioEvidenceAccepted(
  scenario: PaperValidationScenario,
  evidence: ScenarioEvidence | null,
): boolean {
  if (!evidence?.covered) return false;
  if (!EXECUTION_EVIDENCE_SCENARIOS.has(scenario)) return true;
  return evidence.source === "NATURAL" || evidence.source === "REAL_EXECUTION_REPLAY";
}

export function missingCoverageScenarios(coverage: CumulativeCoverage): PaperValidationScenario[] {
  return PAPER_VALIDATION_SCENARIOS.filter((scenario) => !scenarioEvidenceAccepted(scenario, coverage[scenario]));
}

export function deriveCampaignState(input: {
  blocked: boolean;
  accumulatedActiveRuntimeMs: number;
  longestContinuousRuntimeMs: number;
  requiredActiveRuntimeMs: number;
  requiredContinuousRuntimeMs: number;
  missingScenarios: PaperValidationScenario[];
}): CampaignState {
  if (input.blocked) return "BLOCKED";
  const timeComplete = input.accumulatedActiveRuntimeMs >= input.requiredActiveRuntimeMs
    && input.longestContinuousRuntimeMs >= input.requiredContinuousRuntimeMs;
  if (!timeComplete) return "PAUSED";
  return input.missingScenarios.length === 0 ? "PASSED" : "INCOMPLETE_COVERAGE";
}
