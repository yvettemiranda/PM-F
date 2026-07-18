import { createHash } from "node:crypto";
import { stableJson } from "../domain/versioning.js";
import type { PaperAcceptanceSummary } from "../paper/paper-acceptance-summary.js";
import type {
  PaperValidationScenario,
  ScenarioEvidence,
  SessionCoverage,
  ValidationAcceptanceStatus,
} from "./types.js";
import {
  replayEvidenceCoverage,
  type ReplayValidationEvidenceArtifact,
} from "./replay-evidence.js";
import {
  isolatedVerificationProofsAreWellFormed,
  type IsolatedVerificationProofs,
} from "./isolated-proof.js";
import { PAPER_CAMPAIGN_ISOLATED_TEST_FILES } from "./core-compatibility.js";
export { PAPER_CAMPAIGN_ISOLATED_TEST_FILES } from "./core-compatibility.js";

export interface ObserveCampaignReport {
  mode: "OBSERVE_ONLY";
  sourceCodeCommit: string;
  sourceCodeDirty: boolean;
  campaignId: string | null;
  sessionId: string | null;
  marketClockOffsetMs: number;
  baselineRunId: string;
  metrics: {
    observeRunId: string;
    baselineRunId: string;
    activeRuntimeMs: number;
    processedEvents: number;
    emittedSignals: number;
    successfulPolls: number;
    failedPolls: number;
    gapEvents: number;
    duplicateEvents: number;
    reconciliationCount: number;
    majorDesyncCount: number;
    minorDiffCount: number;
    schedulingGapCount: number;
    finalSyncStatus: string | null;
    unrecoveredConnectionGap: boolean;
    checkpointProjectionHashMismatch: boolean;
    checkpointRecovered: boolean;
  };
  acceptance: { observeStatus: string };
  safety: { privateKeyLoaded: boolean; ordersCreated: number };
}

export interface PaperCampaignReport {
  mode: "PAPER";
  status: string;
  shutdownMode: string;
  sourceCodeCommit: string;
  sourceCodeDirty: boolean;
  campaignId: string | null;
  sessionId: string | null;
  marketClockOffsetMs: number;
  finalDrainConsumedSignals: number;
  cancelledWaitingBuyCount?: number;
  report: {
    startedAt: string;
    stoppedAt: string;
    errorCount: number;
    account: { valuationStatus: string; unpricedPositionCount: number };
    acceptance: PaperAcceptanceSummary;
  };
  safety: {
    privateKeyLoaded: boolean;
    authenticatedTradingClientPresent: boolean;
    realOrdersCreated: number;
    chainWrites: number;
    liveExecutorPresent: boolean;
  };
}

export interface IsolatedVerificationEvidence {
  status: "PASSED" | "FAILED";
  coreCompatibilityHash: string;
  verificationSuiteHash: string;
  sourceCodeCommit: string;
  artifactHash: string;
  generatedAt: string;
  coverage: PaperValidationScenario[];
  testFiles: string[];
  replayStatus: "PASSED" | "INCOMPLETE_KNOWN_LIMITATIONS";
  proofs: IsolatedVerificationProofs;
  safety: {
    executionMode: "PAPER";
    liveGateState: "LIVE_DISABLED";
    privateKeyLoaded: false;
    authenticatedTradingClientPresent: false;
    realOrdersCreated: 0;
    chainWrites: 0;
  };
}

export type IsolatedVerificationEvidenceInput = Omit<IsolatedVerificationEvidence, "artifactHash">;

function sha256(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

export function buildIsolatedVerificationEvidence(
  input: IsolatedVerificationEvidenceInput,
): IsolatedVerificationEvidence {
  return { ...input, artifactHash: sha256(input) };
}

export function verifyIsolatedVerificationEvidence(
  evidence: IsolatedVerificationEvidence,
  expectedCoreCompatibilityHash: string,
  expectedVerificationSuiteHash: string,
): boolean {
  const { artifactHash, ...payload } = evidence;
  return evidence.status === "PASSED"
    && evidence.coreCompatibilityHash === expectedCoreCompatibilityHash
    && evidence.verificationSuiteHash === expectedVerificationSuiteHash
    && evidence.sourceCodeCommit.trim().length > 0
    && evidence.replayStatus === evidence.proofs.phase0ReplayStatus
    && evidence.testFiles.length === PAPER_CAMPAIGN_ISOLATED_TEST_FILES.length
    && evidence.testFiles.every((file, index) => file === PAPER_CAMPAIGN_ISOLATED_TEST_FILES[index])
    && isolatedVerificationProofsAreWellFormed(evidence.proofs)
    && evidence.proofs.passedTestFileCount === PAPER_CAMPAIGN_ISOLATED_TEST_FILES.length
    && artifactHash === sha256(payload)
    && evidence.safety.executionMode === "PAPER"
    && evidence.safety.liveGateState === "LIVE_DISABLED"
    && evidence.safety.privateKeyLoaded === false
    && evidence.safety.authenticatedTradingClientPresent === false
    && evidence.safety.realOrdersCreated === 0
    && evidence.safety.chainWrites === 0;
}

function scenario(
  source: ScenarioEvidence["source"],
  evidenceId: string,
  reason: string,
): ScenarioEvidence {
  return { covered: true, source, evidenceId, reason };
}

export function deriveSessionCoverage(input: {
  sessionId: string;
  sequence: number;
  paper: PaperCampaignReport;
  observe: ObserveCampaignReport;
  replayEvidence?: ReplayValidationEvidenceArtifact[];
  isolated: IsolatedVerificationEvidence | null;
}): SessionCoverage {
  const funnel = input.paper.report.acceptance.funnel;
  const naturalId = `${input.sessionId}:NATURAL`;
  const coverage: SessionCoverage = {};
  const add = (name: PaperValidationScenario, covered: boolean, reason: string): void => {
    if (covered) coverage[name] = scenario("NATURAL", naturalId, reason);
  };
  add("BUY", funnel.signals.buy > 0, "BUY_SIGNAL_OBSERVED");
  add("SELL", funnel.signals.sell > 0, "SELL_SIGNAL_OBSERVED");
  add("RISK_ALLOW", funnel.risk.allow > 0, "RISK_ALLOW_OBSERVED");
  add("RISK_REJECT", funnel.risk.reject > 0, "RISK_REJECT_OBSERVED");
  add(
    "MIN_ORDER_REJECT",
    Object.keys(funnel.risk.rejectReasons).some((reason) => reason.includes("MIN_ORDER"))
      || Object.keys(funnel.execution.marketConstraintRejectReasons).some((reason) => reason.includes("MIN_ORDER")),
    "EXECUTION_PRECONDITION_REJECT_OBSERVED",
  );
  add("ORDER", funnel.execution.orders > 0, "PAPER_ORDER_OBSERVED");
  add("FILL", funnel.execution.fills > 0, "PAPER_FILL_OBSERVED");
  add("PARTIAL_FILL", funnel.execution.partialFillOrders > 0, "PARTIAL_FILL_OBSERVED");
  add("POSITION_UPDATE", funnel.positions.total > 0, "POSITION_OBSERVED");
  add("RESERVATION_RELEASE", funnel.reservations.released > 0, "RESERVATION_RELEASE_OBSERVED");
  add("FEE", funnel.fees.entries > 0, "FEE_LEDGER_OBSERVED");
  add("REALIZED_PNL", funnel.pnl.realizedEntries > 0, "REALIZED_PNL_OBSERVED");
  add("UNREALIZED_PNL", funnel.positions.total > 0, "UNREALIZED_PNL_VALUATION_OBSERVED");
  add("STOP_LOSS", funnel.lifecycle.stopLossExecutions > 0, "STOP_LOSS_OBSERVED");
  add("SETTLEMENT", funnel.lifecycle.settlementExecutions > 0, "SETTLEMENT_OBSERVED");
  add(
    "NO_ORDERBOOK_RECOVERY",
    input.paper.report.acceptance.marketData.records.some(
      (record) => record.lastFailureAt !== null && record.lastSuccessAt !== null && record.state === "HEALTHY",
    ),
    "MARKET_DATA_RECOVERY_OBSERVED",
  );
  add("API_RECOVERY", input.observe.metrics.failedPolls > 0 && !input.observe.metrics.unrecoveredConnectionGap, "API_RECOVERY_OBSERVED");
  add("SAFE_STOP", input.paper.shutdownMode === "FINAL_VALUATION", "SAFE_STOP_FINAL_VALUATION");
  add(
    "RESTART_RECOVERY",
    input.sequence > 1 && input.observe.metrics.checkpointRecovered,
    "CAMPAIGN_RESUMED_WITH_OBSERVE_CHECKPOINT",
  );
  add("RECONCILIATION", input.observe.metrics.finalSyncStatus === "SYNCED", "FINAL_RECONCILIATION_SYNCED");

  for (const [name, evidence] of Object.entries(replayEvidenceCoverage(input.replayEvidence ?? []))) {
    if (evidence && !coverage[name as PaperValidationScenario]) {
      coverage[name as PaperValidationScenario] = evidence;
    }
  }

  if (input.isolated?.status === "PASSED") {
    for (const name of input.isolated.coverage) {
      if (coverage[name]) continue;
      coverage[name] = scenario(
        "ISOLATED_CONTROLLED",
        input.isolated.artifactHash,
        "SAME_CORE_ISOLATED_VERIFICATION",
      );
    }
  }
  return coverage;
}

export function sessionAcceptanceStatus(input: {
  qualifying: boolean;
  hardBlockers: string[];
  naturalFullFill: boolean;
  supplementalEvidenceValid: boolean;
}): ValidationAcceptanceStatus {
  if (input.hardBlockers.length > 0) return "FAILED";
  if (!input.qualifying) return "INCOMPLETE_COVERAGE";
  if (input.naturalFullFill) return "PASSED_NATURAL";
  return input.supplementalEvidenceValid ? "PASSED_WITH_SUPPLEMENTAL_EVIDENCE" : "FAILED";
}
