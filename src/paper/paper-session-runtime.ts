import type { DatabaseSync } from "node:sqlite";
import type { SourceVersion } from "../infra/source-version.js";
import type { PaperAccountSnapshot, PaperSignalConsumptionScope } from "./types.js";
import type { ConsumerCutoffResult, PaperExecutor } from "./paper-executor.js";
import type { PaperRunner, PaperRunnerOptions, PaperRunnerReport } from "./paper-runner.js";

export const PAPER_SESSION_CUTOFF_REASON = "PAPER_RUNNER_SESSION_START";
export const PAPER_SESSION_END_REASON = "PAPER_CAMPAIGN_SESSION_END";

export interface PaperCampaignScope {
  campaignId: string;
  sessionId: string;
  coreCompatibilityHash: string;
}

export function paperCampaignScope(
  campaignId: string | null,
  sessionId: string | null,
  coreCompatibilityHash: string,
): PaperCampaignScope | null {
  if ((campaignId === null) !== (sessionId === null)) {
    throw new Error("PAPER_CAMPAIGN_SCOPE_INCOMPLETE:--campaign-id and --session-id must both be provided");
  }
  if (campaignId === null || sessionId === null) return null;
  if (!campaignId.trim() || !sessionId.trim()) throw new Error("PAPER_CAMPAIGN_SCOPE_EMPTY");
  if (!/^[a-f0-9]{64}$/.test(coreCompatibilityHash)) {
    throw new Error("PAPER_CAMPAIGN_CORE_HASH_INVALID");
  }
  return { campaignId, sessionId, coreCompatibilityHash };
}

export interface PaperCampaignRuntimeBinding {
  campaignId: string;
  sessionId: string;
  paperAccountId: string;
  targetId: string;
  baselineRunId: string;
}

/** Must run before account selection and before advancing the consumer cutoff. */
export function assertPaperCampaignRuntimeBinding(
  database: DatabaseSync,
  scope: PaperCampaignScope,
  sourceVersion: SourceVersion,
): PaperCampaignRuntimeBinding {
  if (sourceVersion.dirty) throw new Error("PAPER_CAMPAIGN_SESSION_SOURCE_DIRTY");
  const row = database.prepare(
    `SELECT c.campaign_id,s.session_id,c.paper_account_id,c.target_id,c.baseline_run_id
     FROM paper_validation_campaigns c
     JOIN paper_validation_sessions s ON s.campaign_id=c.campaign_id
     JOIN paper_accounts a ON a.paper_account_id=c.paper_account_id
     JOIN position_baseline_runs b ON b.baseline_run_id=c.baseline_run_id
     WHERE c.campaign_id=? AND s.session_id=?
       AND c.core_compatibility_hash=? AND s.core_compatibility_hash=?
       AND s.source_code_commit=? AND s.source_code_dirty=0
       AND c.execution_mode='PAPER' AND c.live_gate_state='LIVE_DISABLED'
       AND a.status='ACTIVE' AND a.target_id=c.target_id
       AND b.target_id=c.target_id AND b.status='READY'
       AND (SELECT t.to_state FROM paper_validation_transitions t
            WHERE t.entity_type='CAMPAIGN' AND t.campaign_id=c.campaign_id
              AND t.session_id IS NULL
            ORDER BY t.sequence DESC LIMIT 1)='RUNNING'
       AND (SELECT t.to_state FROM paper_validation_transitions t
            WHERE t.entity_type='SESSION' AND t.campaign_id=c.campaign_id
              AND t.session_id=s.session_id
            ORDER BY t.sequence DESC LIMIT 1)='RUNNING'`,
  ).get(
    scope.campaignId,
    scope.sessionId,
    scope.coreCompatibilityHash,
    scope.coreCompatibilityHash,
    sourceVersion.commit,
  ) as {
    campaign_id: string;
    session_id: string;
    paper_account_id: string;
    target_id: string;
    baseline_run_id: string;
  } | undefined;
  if (!row) throw new Error("PAPER_CAMPAIGN_SESSION_RUNTIME_BINDING_INVALID");
  return {
    campaignId: row.campaign_id,
    sessionId: row.session_id,
    paperAccountId: row.paper_account_id,
    targetId: row.target_id,
    baselineRunId: row.baseline_run_id,
  };
}

export function paperRunnerOptions(input: {
  accountId: string;
  intervalMs: number;
  durationMs?: number;
  campaignScope: PaperCampaignScope | null;
}): PaperRunnerOptions {
  const signalScope: PaperSignalConsumptionScope | undefined = input.campaignScope
    ? {
      campaignId: input.campaignScope.campaignId,
      sessionId: input.campaignScope.sessionId,
      coreCompatibilityHash: input.campaignScope.coreCompatibilityHash,
    }
    : undefined;
  return {
    accountId: input.accountId,
    intervalMs: input.intervalMs,
    ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
    ...(signalScope === undefined ? {} : { signalScope }),
  };
}

export function advancePaperSessionCutoff(
  executor: Pick<PaperExecutor, "advanceConsumerCutoff">,
  accountId: string,
  cutoffAt: string,
): ConsumerCutoffResult {
  return executor.advanceConsumerCutoff(accountId, cutoffAt, PAPER_SESSION_CUTOFF_REASON);
}

export interface FinalizedPaperSession {
  report: PaperRunnerReport;
  finalDrainConsumedSignals: number;
  cancelledWaitingBuyCount: number;
  account: PaperAccountSnapshot;
}

/**
 * Safe Paper Session boundary. Drain one final cycle before cancelling every
 * waiting BUY so no reservation or executable intent crosses an offline gap.
 */
export async function finalizePaperSession(input: {
  runner: Pick<PaperRunner, "finalDrain">;
  executor: Pick<PaperExecutor, "cancelWaitingBuys" | "accountSnapshot" | "acceptanceSummary">;
  accountId: string;
  report: PaperRunnerReport;
  signal: AbortSignal;
  now?: () => Date;
}): Promise<FinalizedPaperSession> {
  const now = input.now ?? (() => new Date());
  const finalDrainConsumedSignals = await input.runner.finalDrain(input.signal);
  const cancelledWaitingBuyCount = await input.executor.cancelWaitingBuys(
    input.accountId,
    PAPER_SESSION_END_REASON,
  );
  const account = await input.executor.accountSnapshot(input.accountId, input.signal);
  const stoppedAt = now().toISOString();
  return {
    finalDrainConsumedSignals,
    cancelledWaitingBuyCount,
    account,
    report: {
      ...input.report,
      stoppedAt,
      cycles: input.report.cycles + 1,
      consumedSignals: input.report.consumedSignals + finalDrainConsumedSignals,
      account,
      acceptance: input.executor.acceptanceSummary(input.accountId, {
        startAt: input.report.startedAt,
        endAt: stoppedAt,
      }),
    },
  };
}
