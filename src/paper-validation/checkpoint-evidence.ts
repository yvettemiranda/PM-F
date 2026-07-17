import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { stableJson } from "../domain/versioning.js";
import type { ValidationScope } from "../validation/scoped-invariants.js";
import type { CheckpointEvidence } from "./types.js";

function sha256(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

/** Runtime heartbeat evidence used by stop decisions and crash recovery. */
export function collectCheckpointEvidence(input: {
  databasePath: string;
  targetId: string;
  paperAccountId: string;
  scope?: Pick<ValidationScope, "campaignId" | "sessionId" | "baselineRunId">;
  observeActive: boolean;
  paperActive: boolean;
  detail?: Record<string, unknown>;
}): CheckpointEvidence {
  const database = new DatabaseSync(input.databasePath, { readOnly: true });
  database.exec("PRAGMA query_only=ON; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
  try {
    const observe = database.prepare(
      `SELECT c.checkpoint_id,c.last_processed_event_id,c.replay_state,c.position_projection_hash,
              c.capital_snapshot_id
       FROM observe_checkpoints c
       JOIN observe_runs o ON o.observe_run_id=c.observe_run_id
       WHERE c.target_id=?
         AND (? IS NULL OR (
           c.baseline_run_id=? AND o.campaign_id=? AND o.campaign_session_id=?
         ))
       ORDER BY c.created_at DESC,c.checkpoint_id DESC LIMIT 1`,
    ).get(
      input.targetId,
      input.scope?.campaignId ?? null,
      input.scope?.baselineRunId ?? null,
      input.scope?.campaignId ?? null,
      input.scope?.sessionId ?? null,
    ) as {
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
      `SELECT r.sync_status
       FROM reconciliation_reports r
       JOIN observe_runs o ON o.observe_run_id=r.observe_run_id
       WHERE r.target_id=?
         AND (? IS NULL OR (
           r.baseline_run_id=? AND o.campaign_id=? AND o.campaign_session_id=?
         ))
       ORDER BY r.created_at DESC,r.reconciliation_report_id DESC LIMIT 1`,
    ).get(
      input.targetId,
      input.scope?.campaignId ?? null,
      input.scope?.baselineRunId ?? null,
      input.scope?.campaignId ?? null,
      input.scope?.sessionId ?? null,
    ) as { sync_status: string } | undefined;
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
