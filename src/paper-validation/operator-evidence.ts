import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { stableJson } from "../domain/versioning.js";
import type { PaperAcceptanceSummary } from "../paper/paper-acceptance-summary.js";
import type {
  CheckpointEvidence,
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

export interface ObserveCampaignReport {
  mode: "OBSERVE_ONLY";
  sourceCodeCommit: string;
  sourceCodeDirty: boolean;
  campaignId: string | null;
  sessionId: string | null;
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
  sourceCodeCommit: string;
  artifactHash: string;
  generatedAt: string;
  coverage: PaperValidationScenario[];
  testFiles: string[];
  replayStatus: "PASSED";
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

export const PAPER_CAMPAIGN_ISOLATED_TEST_FILES = [
  "tests/core-compatibility.test.ts",
  "tests/capital-sizing.test.ts",
  "tests/market-order-constraints.test.ts",
  "tests/execution-market-data.test.ts",
  "tests/live-executor.test.ts",
  "tests/paper-executor.test.ts",
  "tests/paper-runner-options.test.ts",
  "tests/paper-acceptance-summary.test.ts",
  "tests/paper-gate-evaluator.test.ts",
  "tests/paper-validation-campaign.test.ts",
  "tests/paper-campaign-operator-evidence.test.ts",
  "tests/paper-campaign-operator-policy.test.ts",
  "tests/operator-paper-campaign-shell.test.ts",
  "tests/observe-runner.test.ts",
  "tests/runtime-database-preparation.test.ts",
  "tests/replay-engine.test.ts",
  "tests/diagnostic-redaction.test.ts",
  "tests/isolated-proof.test.ts",
  "tests/paper-replay-evidence.test.ts",
] as const;

export type IsolatedVerificationEvidenceInput = Omit<IsolatedVerificationEvidence, "artifactHash">;

export interface FinalIntegrityEvidence {
  passed: boolean;
  blockers: string[];
  integrityCheck: string;
  foreignKeyIssueCount: number;
  gapExecutionViolationCount: number;
  duplicateConsumptionCount: number;
  duplicateOrderIdempotencyCount: number;
  duplicateFillIdempotencyCount: number;
  executionMode: string;
  liveGateState: string;
}

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
): boolean {
  const { artifactHash, ...payload } = evidence;
  return evidence.status === "PASSED"
    && evidence.coreCompatibilityHash === expectedCoreCompatibilityHash
    && evidence.sourceCodeCommit.trim().length > 0
    && evidence.replayStatus === "PASSED"
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

function countDuplicates(database: DatabaseSync, sql: string, accountId: string): number {
  const row = database.prepare(`SELECT count(*) count FROM (${sql})`).get(accountId) as {
    count: number | bigint;
  };
  return Number(row.count);
}

export function collectCheckpointEvidence(input: {
  databasePath: string;
  targetId: string;
  paperAccountId: string;
  observeActive: boolean;
  paperActive: boolean;
  detail?: Record<string, unknown>;
}): CheckpointEvidence {
  const database = new DatabaseSync(input.databasePath, { readOnly: true });
  database.exec("PRAGMA query_only=ON; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
  try {
    const observe = database.prepare(
      `SELECT checkpoint_id,last_processed_event_id,replay_state,position_projection_hash,
              capital_snapshot_id
       FROM observe_checkpoints WHERE target_id=?
       ORDER BY created_at DESC,checkpoint_id DESC LIMIT 1`,
    ).get(input.targetId) as {
      checkpoint_id: string;
      last_processed_event_id: string | null;
      replay_state: string;
      position_projection_hash: string;
      capital_snapshot_id: string;
    } | undefined;
    const consumer = database.prepare(
      `SELECT last_signal_created_at,last_signal_id
       FROM paper_consumer_checkpoints WHERE paper_account_id=?`,
    ).get(input.paperAccountId) as {
      last_signal_created_at: string | null;
      last_signal_id: string | null;
    } | undefined;
    const portfolio = database.prepare(
      `SELECT portfolio_snapshot_id,cash_balance_micros,reserved_balance_micros,
              position_value_micros,realized_pnl_micros,unrealized_pnl_micros,
              total_equity_micros,valuation_status,unpriced_position_count,created_at
       FROM paper_portfolio_snapshots WHERE paper_account_id=?
       ORDER BY created_at DESC,portfolio_snapshot_id DESC LIMIT 1`,
    ).get(input.paperAccountId) as Record<string, unknown> | undefined;
    const account = database.prepare(
      `SELECT status,cash_balance_micros,reserved_balance_micros
       FROM paper_accounts WHERE paper_account_id=?`,
    ).get(input.paperAccountId) as {
      status: string;
      cash_balance_micros: string;
      reserved_balance_micros: string;
    } | undefined;
    const reconciliation = database.prepare(
      `SELECT sync_status FROM reconciliation_reports WHERE target_id=?
       ORDER BY created_at DESC,reconciliation_report_id DESC LIMIT 1`,
    ).get(input.targetId) as { sync_status: string } | undefined;
    const consistencySafe = Boolean(account)
      && account!.status === "ACTIVE"
      && BigInt(account!.cash_balance_micros) >= 0n
      && BigInt(account!.reserved_balance_micros) >= 0n
      && reconciliation?.sync_status !== "MAJOR_DESYNC";
    return {
      observeActive: input.observeActive,
      paperActive: input.paperActive,
      consistencySafe,
      observeCheckpointId: observe?.checkpoint_id ?? null,
      paperConsumerCreatedAt: consumer?.last_signal_created_at ?? null,
      paperConsumerSignalId: consumer?.last_signal_id ?? null,
      positionProjectionHash: observe?.position_projection_hash ?? null,
      portfolioProjectionHash: portfolio ? sha256(portfolio) : null,
      replayState: observe?.replay_state ?? null,
      capitalSnapshotId: observe?.capital_snapshot_id ?? null,
      lastProcessedEventId: observe?.last_processed_event_id ?? null,
      detail: {
        latestReconciliationStatus: reconciliation?.sync_status ?? null,
        accountStatus: account?.status ?? null,
        ...input.detail,
      },
    };
  } finally {
    database.close();
  }
}

export function validateFinalCampaignIntegrity(input: {
  databasePath: string;
  paperAccountId: string;
  acceptance: PaperAcceptanceSummary;
}): FinalIntegrityEvidence {
  const database = new DatabaseSync(input.databasePath, { readOnly: true });
  database.exec("PRAGMA query_only=ON; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
  try {
    const integrityCheck = (database.prepare("PRAGMA integrity_check").get() as {
      integrity_check: string;
    }).integrity_check;
    const foreignKeyIssueCount = database.prepare("PRAGMA foreign_key_check").all().length;
    const safety = database.prepare(
      `SELECT execution_mode,live_gate_state FROM live_gate_state WHERE state_id='default'`,
    ).get() as { execution_mode: string; live_gate_state: string } | undefined;
    const gapExecutionViolationCount = Number((database.prepare(
      `SELECT count(*) count
       FROM paper_signal_consumptions c
       JOIN signals s ON s.signal_id=c.signal_id
       WHERE c.paper_account_id=? AND s.execution_eligible=0
         AND s.execution_block_reason='GAP_EVENT'
         AND (c.result<>'REJECTED' OR c.paper_execution_id IS NOT NULL)`,
    ).get(input.paperAccountId) as { count: number | bigint }).count);
    const duplicateConsumptionCount = countDuplicates(
      database,
      `SELECT signal_id FROM paper_signal_consumptions
       WHERE paper_account_id=? GROUP BY signal_id HAVING count(*)>1`,
      input.paperAccountId,
    );
    const duplicateOrderIdempotencyCount = countDuplicates(
      database,
      `SELECT o.paper_execution_id,o.attempt_sequence FROM paper_orders o
       JOIN paper_executions e ON e.paper_execution_id=o.paper_execution_id
       WHERE e.paper_account_id=?
       GROUP BY o.paper_execution_id,o.attempt_sequence HAVING count(*)>1`,
      input.paperAccountId,
    );
    const duplicateFillIdempotencyCount = countDuplicates(
      database,
      `SELECT f.paper_order_id,f.level_sequence,f.side FROM paper_fill_ledger f
       JOIN paper_executions e ON e.paper_execution_id=f.paper_execution_id
       WHERE e.paper_account_id=?
       GROUP BY f.paper_order_id,f.level_sequence,f.side HAVING count(*)>1`,
      input.paperAccountId,
    );
    const blockers = [
      ...(integrityCheck === "ok" ? [] : [`DATABASE_INTEGRITY:${integrityCheck}`]),
      ...(foreignKeyIssueCount === 0 ? [] : [`FOREIGN_KEY_ISSUES:${foreignKeyIssueCount}`]),
      ...(input.acceptance.consistency.passed ? [] : ["PAPER_CONSISTENCY_FAILED"]),
      ...(gapExecutionViolationCount === 0 ? [] : [`GAP_EXECUTION_VIOLATIONS:${gapExecutionViolationCount}`]),
      ...(duplicateConsumptionCount === 0 ? [] : [`DUPLICATE_SIGNAL_CONSUMPTIONS:${duplicateConsumptionCount}`]),
      ...(duplicateOrderIdempotencyCount === 0 ? [] : [`DUPLICATE_ORDERS:${duplicateOrderIdempotencyCount}`]),
      ...(duplicateFillIdempotencyCount === 0 ? [] : [`DUPLICATE_FILLS:${duplicateFillIdempotencyCount}`]),
      ...(safety?.execution_mode === "PAPER" ? [] : [`EXECUTION_MODE:${safety?.execution_mode ?? "MISSING"}`]),
      ...(safety?.live_gate_state === "LIVE_DISABLED" ? [] : [`LIVE_GATE_STATE:${safety?.live_gate_state ?? "MISSING"}`]),
    ];
    return {
      passed: blockers.length === 0,
      blockers,
      integrityCheck,
      foreignKeyIssueCount,
      gapExecutionViolationCount,
      duplicateConsumptionCount,
      duplicateOrderIdempotencyCount,
      duplicateFillIdempotencyCount,
      executionMode: safety?.execution_mode ?? "MISSING",
      liveGateState: safety?.live_gate_state ?? "MISSING",
    };
  } finally {
    database.close();
  }
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
