import { describe, expect, it } from "vitest";
import type { PaperAcceptanceSummary } from "../src/paper/paper-acceptance-summary.js";
import { evaluatePaperShortGate } from "../src/paper/paper-gate-evaluator.js";

function acceptance(stage: PaperAcceptanceSummary["funnel"]["stage"]["BUY"]): PaperAcceptanceSummary {
  return {
    paperAccountId: "account-internal",
    targetId: "target",
    generatedAt: "2026-07-16T00:00:00.000Z",
    evidenceWindow: {
      startAt: "2026-07-16T00:00:00.000Z",
      endAt: "2026-07-16T02:00:00.000Z",
    },
    consistency: {
      passed: true,
      cash: { accountCashMicros: "1", cashLedgerMicros: "1", accountReservedMicros: "0", cashLedgerReservedMicros: "0", matches: true },
      reservations: { accountReservedMicros: "0", activeReservationsMicros: "0", reservationLedgerMicros: "0", cashLedgerReservedMicros: "0", matches: true, reservationIssues: [] },
      negativeValues: { count: 0, details: [] },
      orphans: { total: 0, details: [] },
      aggregates: { total: 0, details: [] },
    },
    coverage: { BUY: "NOT_OBSERVED", SELL: "NOT_OBSERVED", STOP_LOSS: "NOT_OBSERVED", SETTLEMENT: "NOT_OBSERVED", REALIZED_PNL: "NOT_OBSERVED" },
    funnel: {
      signals: { buy: 1, sell: 0, conversion: 0, published: 1, executionEligible: 1, ineligible: 0, gap: 0, unconsumedEligible: 0, ineligibleReasons: {} },
      capital: { high: 1, medium: 0, low: 0, unknown: 0, sizingDecisionCount: 0, sizingRejectReasons: {}, sizingEvidence: [] },
      risk: { allow: 1, reject: 0, rejectReasons: {} },
      copy: { targetBuyNotionalMicros: "0", desiredBuyAmountMicros: "0", requestedBuyAmountMicros: "0", filledBuySpendMicros: "0", buyRequestedCoveragePpm: null, buyFillCoveragePpm: null, requestedSellSizeMicros: "0", filledSellSizeMicros: "0", sellFillCoveragePpm: null },
      execution: { total: 1, waiting: 0, rejectedBeforeOrder: 0, rejectedBeforeOrderReasons: {}, marketConstraintRejects: 0, marketConstraintRejectReasons: {}, expired: 0, cancelled: 0, exitPending: 0, stopExitPending: 0, orders: 1, zeroFillOrders: 0, partialFillOrders: 0, fullFillOrders: stage === "FULL_FILL" ? 1 : 0, fills: stage === "FULL_FILL" ? 1 : 0 },
      positions: { total: 0, open: 0, partiallyClosed: 0, frozen: 0, settlementPending: 0, closed: 0, redeemed: 0 },
      reservations: { total: 0, active: 0, consumed: 0, released: 0, activeMicros: "0", releasedMicros: "0" },
      fees: { entries: 0, totalMicros: "0" },
      pnl: { realizedEntries: 0, settlementEntries: 0, realizedMicros: "0", unrealizedMicros: "0" },
      lifecycle: { stopLossExecutions: 0, settlementExecutions: 0, redeemedPositions: 0 },
      stage: { BUY: stage, SELL: "NO_SIGNAL" },
    },
    marketData: { blockerCount: 0, blockers: [], quarantineCount: 0, quarantined: [], records: [] },
  };
}

const safe = {
  executionMode: "PAPER" as const,
  liveGateState: "LIVE_DISABLED" as const,
  privateKeyLoaded: false,
  authenticatedTradingClientPresent: false,
  realOrdersCreated: 0,
  chainWrites: 0,
};

describe("evaluatePaperShortGate", () => {
  it("passes natural full-fill evidence without enabling Live", () => {
    expect(evaluatePaperShortGate({
      durationMs: 7_200_000,
      minimumDurationMs: 7_170_000,
      finalValuationComplete: true,
      runnerErrorCount: 0,
      versionsMatch: true,
      safety: safe,
      acceptance: acceptance("FULL_FILL"),
    })).toMatchObject({ status: "SHORT_RUNTIME_PASSED_NATURAL", longRunAllowed: true, liveAllowed: false });
  });

  it("fails a stopped Session while any reservation remains active", () => {
    const report = acceptance("FULL_FILL");
    report.consistency.reservations.activeReservationsMicros = "1";
    const decision = evaluatePaperShortGate({
      durationMs: 7_200_000,
      minimumDurationMs: 7_170_000,
      finalValuationComplete: true,
      runnerErrorCount: 0,
      versionsMatch: true,
      safety: safe,
      acceptance: report,
    });
    expect(decision.status).toBe("SHORT_RUNTIME_FAILED");
    expect(decision.blockingReasons).toContain("ACTIVE_RESERVATION_REMAINS");
  });

  it("blocks a tracked negative-risk conversion that has no safe executor", () => {
    const report = acceptance("FULL_FILL");
    report.funnel.signals.conversion = 1;
    report.funnel.signals.ineligible = 1;
    report.funnel.signals.ineligibleReasons = {
      NEGATIVE_RISK_CONVERSION_EXECUTION_UNAVAILABLE: 1,
    };
    const decision = evaluatePaperShortGate({
      durationMs: 7_200_000,
      minimumDurationMs: 7_170_000,
      finalValuationComplete: true,
      runnerErrorCount: 0,
      versionsMatch: true,
      safety: safe,
      acceptance: report,
    });
    expect(decision).toMatchObject({ status: "SHORT_RUNTIME_FAILED", longRunAllowed: false });
    expect(decision.blockingReasons).toContain("UNFOLLOWED_NEGATIVE_RISK_CONVERSION:1");
  });

  it("allows compatible controlled evidence but labels it supplemental", () => {
    expect(evaluatePaperShortGate({
      durationMs: 7_200_000,
      minimumDurationMs: 7_170_000,
      finalValuationComplete: true,
      runnerErrorCount: 0,
      versionsMatch: true,
      safety: safe,
      acceptance: acceptance("EXECUTION_PRECONDITION_REJECTED"),
      supplementalEvidence: [{ source: "ISOLATED_CONTROLLED", status: "PASSED", artifactHash: "a".repeat(64), versionsMatch: true }],
    })).toMatchObject({
      status: "SHORT_RUNTIME_PASSED_WITH_SUPPLEMENTAL_EVIDENCE",
      naturalCoveragePassed: false,
      longRunAllowed: true,
      liveAllowed: false,
    });
  });

  it("does not let supplemental evidence hide a generic amount rejection", () => {
    const report = acceptance("RISK_REJECTED");
    report.funnel.risk = { allow: 0, reject: 1, rejectReasons: { BUY_AMOUNT_UNAVAILABLE: 1 } };
    expect(evaluatePaperShortGate({
      durationMs: 7_200_000,
      minimumDurationMs: 7_170_000,
      finalValuationComplete: true,
      runnerErrorCount: 0,
      versionsMatch: true,
      safety: safe,
      acceptance: report,
      supplementalEvidence: [{ source: "ISOLATED_CONTROLLED", status: "PASSED", artifactHash: "b".repeat(64), versionsMatch: true }],
    })).toMatchObject({ status: "SHORT_RUNTIME_FAILED", longRunAllowed: false });
  });

  it("does not let supplemental evidence hide sizing hash or ratio integrity failures", () => {
    for (const reason of ["CAPITAL_SIZING_HASH_MISMATCH", "CAPITAL_RATIO_UNAVAILABLE"]) {
      const report = acceptance("RISK_REJECTED");
      report.funnel.risk = { allow: 0, reject: 1, rejectReasons: { [reason]: 1 } };
      const decision = evaluatePaperShortGate({
        durationMs: 7_200_000,
        minimumDurationMs: 7_170_000,
        finalValuationComplete: true,
        runnerErrorCount: 0,
        versionsMatch: true,
        safety: safe,
        acceptance: report,
        supplementalEvidence: [{ source: "ISOLATED_CONTROLLED", status: "PASSED", artifactHash: "b".repeat(64), versionsMatch: true }],
      });
      expect(decision).toMatchObject({ status: "SHORT_RUNTIME_FAILED", longRunAllowed: false });
      expect(decision.blockingReasons).toContain(`SIZING_OR_INTEGRITY_FAILURE:${reason}`);
    }
  });

  it("treats an internal BUY order-constraint input error as a validation blocker", () => {
    const report = acceptance("EXECUTION_PRECONDITION_REJECTED");
    report.funnel.execution.rejectedBeforeOrder = 1;
    report.funnel.execution.rejectedBeforeOrderReasons = { BUY_ORDER_CONSTRAINT_INPUT_INVALID: 1 };
    const decision = evaluatePaperShortGate({
      durationMs: 7_200_000,
      minimumDurationMs: 7_170_000,
      finalValuationComplete: true,
      runnerErrorCount: 0,
      versionsMatch: true,
      safety: safe,
      acceptance: report,
      supplementalEvidence: [{ source: "ISOLATED_CONTROLLED", status: "PASSED", artifactHash: "b".repeat(64), versionsMatch: true }],
    });
    expect(decision.status).toBe("SHORT_RUNTIME_FAILED");
    expect(decision.blockingReasons).toContain(
      "SIZING_OR_INTEGRITY_FAILURE:BUY_ORDER_CONSTRAINT_INPUT_INVALID",
    );
  });

  it("keeps an audited below-account-precision rejection eligible for supplemental coverage", () => {
    const report = acceptance("RISK_REJECTED");
    report.funnel.risk = {
      allow: 0,
      reject: 1,
      rejectReasons: { PROPORTIONAL_AMOUNT_BELOW_ACCOUNT_PRECISION: 1 },
    };
    report.funnel.capital.sizingRejectReasons = { PROPORTIONAL_AMOUNT_BELOW_ACCOUNT_PRECISION: 1 };
    expect(evaluatePaperShortGate({
      durationMs: 7_200_000,
      minimumDurationMs: 7_170_000,
      finalValuationComplete: true,
      runnerErrorCount: 0,
      versionsMatch: true,
      safety: safe,
      acceptance: report,
      supplementalEvidence: [{ source: "ISOLATED_CONTROLLED", status: "PASSED", artifactHash: "b".repeat(64), versionsMatch: true }],
    })).toMatchObject({ status: "SHORT_RUNTIME_PASSED_WITH_SUPPLEMENTAL_EVIDENCE", longRunAllowed: true });
  });

  it("fails closed when the actual execution or Live Gate state is unsafe", () => {
    expect(evaluatePaperShortGate({
      durationMs: 7_200_000,
      minimumDurationMs: 7_170_000,
      finalValuationComplete: true,
      runnerErrorCount: 0,
      versionsMatch: true,
      safety: { ...safe, executionMode: "LIVE", liveGateState: "LIVE_ACTIVE" },
      acceptance: acceptance("FULL_FILL"),
    })).toMatchObject({
      status: "SHORT_RUNTIME_FAILED",
      longRunAllowed: false,
      blockingReasons: expect.arrayContaining(["EXECUTION_MODE_NOT_PAPER", "LIVE_GATE_NOT_DISABLED"]),
    });
  });
});
