import { DatabaseSync } from "node:sqlite";
import type { PaperAcceptanceSummary } from "../paper/paper-acceptance-summary.js";
import {
  checkScopedInvariants,
  type ScopedInvariantEvidence,
  type ValidationScope,
} from "../validation/scoped-invariants.js";

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
  scopedInvariants: ScopedInvariantEvidence;
}

function countDuplicates(database: DatabaseSync, sql: string, accountId: string): number {
  const row = database.prepare(`SELECT count(*) count FROM (${sql})`).get(accountId) as {
    count: number | bigint;
  };
  return Number(row.count);
}

/** Final fail-closed integrity boundary used by normal stop and crash recovery. */
export function validateFinalCampaignIntegrity(input: {
  databasePath: string;
  scope: ValidationScope;
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
    const scopedInvariants = checkScopedInvariants(database, input.scope);
    const gapExecutionViolationCount = Number((database.prepare(
      `SELECT count(*) count
       FROM paper_signal_consumptions c
       JOIN signals s ON s.signal_id=c.signal_id
       WHERE c.paper_account_id=? AND s.execution_eligible=0
         AND s.execution_block_reason='GAP_EVENT'
         AND (c.result<>'REJECTED' OR c.paper_execution_id IS NOT NULL)`,
    ).get(input.scope.accountId) as { count: number | bigint }).count);
    const duplicateConsumptionCount = countDuplicates(
      database,
      `SELECT signal_id FROM paper_signal_consumptions
       WHERE paper_account_id=? GROUP BY signal_id HAVING count(*)>1`,
      input.scope.accountId,
    );
    const duplicateOrderIdempotencyCount = countDuplicates(
      database,
      `SELECT o.paper_execution_id,o.attempt_sequence FROM paper_orders o
       JOIN paper_executions e ON e.paper_execution_id=o.paper_execution_id
       WHERE e.paper_account_id=?
       GROUP BY o.paper_execution_id,o.attempt_sequence HAVING count(*)>1`,
      input.scope.accountId,
    );
    const duplicateFillIdempotencyCount = countDuplicates(
      database,
      `SELECT f.paper_order_id,f.level_sequence,f.side FROM paper_fill_ledger f
       JOIN paper_executions e ON e.paper_execution_id=f.paper_execution_id
       WHERE e.paper_account_id=?
       GROUP BY f.paper_order_id,f.level_sequence,f.side HAVING count(*)>1`,
      input.scope.accountId,
    );
    const blockers = [
      ...(integrityCheck === "ok" ? [] : [`DATABASE_INTEGRITY:${integrityCheck}`]),
      ...(foreignKeyIssueCount === 0 ? [] : [`FOREIGN_KEY_ISSUES:${foreignKeyIssueCount}`]),
      ...(input.acceptance.consistency.passed ? [] : ["PAPER_CONSISTENCY_FAILED"]),
      ...(gapExecutionViolationCount === 0 ? [] : [`GAP_EXECUTION_VIOLATIONS:${gapExecutionViolationCount}`]),
      ...(duplicateConsumptionCount === 0 ? [] : [`DUPLICATE_SIGNAL_CONSUMPTIONS:${duplicateConsumptionCount}`]),
      ...(duplicateOrderIdempotencyCount === 0 ? [] : [`DUPLICATE_ORDERS:${duplicateOrderIdempotencyCount}`]),
      ...(duplicateFillIdempotencyCount === 0 ? [] : [`DUPLICATE_FILLS:${duplicateFillIdempotencyCount}`]),
      ...scopedInvariants.blockers,
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
      scopedInvariants,
    };
  } finally {
    database.close();
  }
}
