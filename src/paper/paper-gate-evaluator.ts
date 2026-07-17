import type { PaperAcceptanceSummary } from "./paper-acceptance-summary.js";

export type PaperEvidenceSource =
  | "NATURAL"
  | "REAL_SIGNAL_REPLAY"
  | "REAL_EXECUTION_REPLAY"
  | "ISOLATED_CONTROLLED";

export type PaperShortGateStatus =
  | "SHORT_RUNTIME_PASSED_NATURAL"
  | "SHORT_RUNTIME_PASSED_WITH_SUPPLEMENTAL_EVIDENCE"
  | "SHORT_RUNTIME_FAILED";

export interface PaperShortGateInput {
  durationMs: number;
  minimumDurationMs: number;
  finalValuationComplete: boolean;
  runnerErrorCount: number;
  versionsMatch: boolean;
  safety: {
    executionMode: string;
    liveGateState: string;
    privateKeyLoaded: boolean;
    authenticatedTradingClientPresent: boolean;
    realOrdersCreated: number;
    chainWrites: number;
  };
  acceptance: PaperAcceptanceSummary;
  hardFailures?: string[];
  supplementalEvidence?: Array<{
    source: Exclude<PaperEvidenceSource, "NATURAL">;
    status: "PASSED" | "FAILED" | "NOT_AVAILABLE";
    artifactHash: string | null;
    versionsMatch: boolean;
  }>;
}

export interface PaperShortGateDecision {
  status: PaperShortGateStatus;
  runtimePassed: boolean;
  naturalCoveragePassed: boolean;
  supplementalCoveragePassed: boolean;
  longRunAllowed: boolean;
  liveAllowed: false;
  blockingReasons: string[];
  evidenceSources: PaperEvidenceSource[];
}

const GENERIC_REJECT_REASONS = new Set([
  "BUY_AMOUNT_UNAVAILABLE",
  "UNSPECIFIED",
  "UNKNOWN",
  "INTERNAL_ERROR",
]);

const SIZING_OR_INTEGRITY_FAILURES = new Set([
  "ACCOUNT_CAPITAL_UNAVAILABLE",
  "FALLBACK_AMOUNT_UNAVAILABLE",
  "CAPITAL_DECISION_UNSUPPORTED",
  "CAPITAL_RATIO_UNAVAILABLE",
  "CAPITAL_SIZING_VERSION_UNSUPPORTED",
  "CAPITAL_SIZING_HASH_MISMATCH",
  "CAPITAL_SIZING_EVIDENCE_HASH_MISMATCH",
  "CAPITAL_SIZING_AMOUNT_MISMATCH",
  "RULESET_UNREGISTERED_OR_INVALID",
]);

function isSizingOrIntegrityFailure(reason: string): boolean {
  return SIZING_OR_INTEGRITY_FAILURES.has(reason)
    || reason.startsWith("EXECUTION_CONTEXT_")
    || reason.startsWith("SIGNAL_CAPITAL_")
    || reason.endsWith("_HASH_MISMATCH")
    || reason.endsWith("_CONTENT_MISMATCH");
}

export function evaluatePaperShortGate(input: PaperShortGateInput): PaperShortGateDecision {
  const blockers = new Set(input.hardFailures ?? []);
  const runtimePassed = input.durationMs >= input.minimumDurationMs
    && input.finalValuationComplete
    && input.runnerErrorCount === 0;
  if (input.durationMs < input.minimumDurationMs) blockers.add("MINIMUM_RUNTIME_NOT_REACHED");
  if (!input.finalValuationComplete) blockers.add("FINAL_VALUATION_INCOMPLETE");
  if (input.runnerErrorCount > 0) blockers.add("PAPER_RUNNER_ERRORS");
  if (!input.versionsMatch) blockers.add("VERSION_MISMATCH");
  if (!input.acceptance.consistency.passed) blockers.add("PAPER_CONSISTENCY_FAILED");
  if (input.acceptance.consistency.reservations.activeReservationsMicros !== "0") {
    blockers.add("ACTIVE_RESERVATION_REMAINS");
  }
  if (input.acceptance.marketData.blockerCount > 0) blockers.add("UNRECOVERED_MARKET_DATA_BLOCKER");
  if (input.acceptance.funnel.signals.unconsumedEligible > 0) blockers.add("ELIGIBLE_SIGNAL_UNCONSUMED");
  for (const reason of Object.keys(input.acceptance.funnel.risk.rejectReasons)) {
    if (GENERIC_REJECT_REASONS.has(reason)) blockers.add(`UNEXPLAINED_RISK_REJECT:${reason}`);
    if (isSizingOrIntegrityFailure(reason)) blockers.add(`SIZING_OR_INTEGRITY_FAILURE:${reason}`);
  }
  for (const reason of Object.keys(input.acceptance.funnel.capital.sizingRejectReasons)) {
    if (isSizingOrIntegrityFailure(reason)) blockers.add(`SIZING_OR_INTEGRITY_FAILURE:${reason}`);
  }
  for (const reason of Object.keys(input.acceptance.funnel.execution.rejectedBeforeOrderReasons)) {
    if (isSizingOrIntegrityFailure(reason)) blockers.add(`SIZING_OR_INTEGRITY_FAILURE:${reason}`);
  }
  if (input.safety.executionMode !== "PAPER") blockers.add("EXECUTION_MODE_NOT_PAPER");
  if (input.safety.liveGateState !== "LIVE_DISABLED") blockers.add("LIVE_GATE_NOT_DISABLED");
  if (input.safety.privateKeyLoaded) blockers.add("PRIVATE_KEY_LOADED");
  if (input.safety.authenticatedTradingClientPresent) blockers.add("AUTHENTICATED_TRADING_CLIENT_PRESENT");
  if (input.safety.realOrdersCreated !== 0) blockers.add("REAL_ORDER_CREATED");
  if (input.safety.chainWrites !== 0) blockers.add("CHAIN_WRITE_DETECTED");

  const naturalCoveragePassed = input.acceptance.funnel.stage.BUY === "FULL_FILL";
  const supplemental = input.supplementalEvidence ?? [];
  for (const evidence of supplemental) {
    if (evidence.status === "FAILED") blockers.add(`SUPPLEMENTAL_EVIDENCE_FAILED:${evidence.source}`);
    if (evidence.status === "PASSED" && !evidence.versionsMatch) {
      blockers.add(`SUPPLEMENTAL_EVIDENCE_VERSION_MISMATCH:${evidence.source}`);
    }
    if (evidence.status === "PASSED" && !evidence.artifactHash) {
      blockers.add(`SUPPLEMENTAL_EVIDENCE_HASH_MISSING:${evidence.source}`);
    }
  }
  const passedSupplemental = supplemental.filter(
    (evidence) => evidence.status === "PASSED" && evidence.versionsMatch && Boolean(evidence.artifactHash),
  );
  const supplementalCoveragePassed = passedSupplemental.length > 0;

  const blockingReasons = [...blockers].sort();
  if (blockingReasons.length > 0 || !runtimePassed) {
    return {
      status: "SHORT_RUNTIME_FAILED",
      runtimePassed,
      naturalCoveragePassed,
      supplementalCoveragePassed,
      longRunAllowed: false,
      liveAllowed: false,
      blockingReasons,
      evidenceSources: naturalCoveragePassed ? ["NATURAL"] : [],
    };
  }
  if (naturalCoveragePassed) {
    return {
      status: "SHORT_RUNTIME_PASSED_NATURAL",
      runtimePassed: true,
      naturalCoveragePassed: true,
      supplementalCoveragePassed,
      longRunAllowed: true,
      liveAllowed: false,
      blockingReasons: [],
      evidenceSources: ["NATURAL", ...passedSupplemental.map((evidence) => evidence.source)],
    };
  }
  if (supplementalCoveragePassed) {
    return {
      status: "SHORT_RUNTIME_PASSED_WITH_SUPPLEMENTAL_EVIDENCE",
      runtimePassed: true,
      naturalCoveragePassed: false,
      supplementalCoveragePassed: true,
      longRunAllowed: true,
      liveAllowed: false,
      blockingReasons: [],
      evidenceSources: passedSupplemental.map((evidence) => evidence.source),
    };
  }
  return {
    status: "SHORT_RUNTIME_FAILED",
    runtimePassed: true,
    naturalCoveragePassed: false,
    supplementalCoveragePassed: false,
    longRunAllowed: false,
    liveAllowed: false,
    blockingReasons: ["EXECUTION_COVERAGE_NOT_PROVEN"],
    evidenceSources: [],
  };
}
