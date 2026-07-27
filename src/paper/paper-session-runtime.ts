import type { DatabaseSync } from "node:sqlite";
import type { SourceVersion } from "../infra/source-version.js";
import type { PaperAccountSnapshot, PaperSignalConsumptionScope } from "./types.js";
import type { ConsumerCutoffResult, PaperExecutor } from "./paper-executor.js";
import type { PaperRunner, PaperRunnerOptions, PaperRunnerReport } from "./paper-runner.js";
import {
  recoverIncompleteValuation,
  type ValuationRecoveryPolicy,
} from "../execution/valuation-recovery.js";

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
  valuationRecovery: {
    attempts: number;
    recovered: boolean;
    status: "COMPLETE" | "INCOMPLETE";
  };
  finalDrainRecovery: {
    attempts: number;
    recovered: boolean;
    status: "COMPLETE" | "INCOMPLETE";
  };
}

export interface PaperFinalDrainRecoveryPolicy {
  maxAttempts?: number;
  backoffMs?: readonly number[];
  attemptTimeoutMs?: number;
  wait?: (milliseconds: number) => Promise<void>;
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
  valuationRecovery?: Omit<ValuationRecoveryPolicy, "signal">;
  finalDrainRecovery?: PaperFinalDrainRecoveryPolicy;
  now?: () => Date;
}): Promise<FinalizedPaperSession> {
  const now = input.now ?? (() => new Date());
  const finalDrainPolicy = input.finalDrainRecovery ?? {};
  const maxDrainAttempts = finalDrainPolicy.maxAttempts ?? 3;
  if (!Number.isSafeInteger(maxDrainAttempts) || maxDrainAttempts <= 0) {
    throw new Error("FINAL_DRAIN_RECOVERY_MAX_ATTEMPTS_INVALID");
  }
  const drainBackoffMs = finalDrainPolicy.backoffMs ?? [1_000, 3_000];
  if (drainBackoffMs.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new Error("FINAL_DRAIN_RECOVERY_BACKOFF_INVALID");
  }
  const attemptTimeoutMs = finalDrainPolicy.attemptTimeoutMs ?? 30_000;
  if (!Number.isSafeInteger(attemptTimeoutMs) || attemptTimeoutMs <= 0) {
    throw new Error("FINAL_DRAIN_RECOVERY_TIMEOUT_INVALID");
  }
  const wait = finalDrainPolicy.wait ?? ((milliseconds: number) => (
    new Promise((resolve) => setTimeout(resolve, milliseconds))
  ));
  let finalDrainConsumedSignals = 0;
  let finalDrainAttempts = 0;
  let finalDrainError: unknown = null;
  for (let attempt = 1; attempt <= maxDrainAttempts; attempt += 1) {
    if (input.signal.aborted) throw input.signal.reason ?? new Error("FINAL_DRAIN_RECOVERY_ABORTED");
    finalDrainAttempts = attempt;
    const attemptSignal = AbortSignal.any([
      input.signal,
      AbortSignal.timeout(attemptTimeoutMs),
    ]);
    try {
      finalDrainConsumedSignals = await input.runner.finalDrain(attemptSignal);
      finalDrainError = null;
      break;
    } catch (error) {
      finalDrainError = error;
      if (input.signal.aborted) throw input.signal.reason ?? error;
      if (attempt < maxDrainAttempts) {
        const delay = drainBackoffMs[Math.min(attempt - 1, drainBackoffMs.length - 1)] ?? 0;
        if (delay > 0) await wait(delay);
      }
    }
  }
  const cancelledWaitingBuyCount = await input.executor.cancelWaitingBuys(
    input.accountId,
    PAPER_SESSION_END_REASON,
  );
  const valuationRecovery = await recoverIncompleteValuation(
    () => input.executor.accountSnapshot(
      input.accountId,
      AbortSignal.any([input.signal, AbortSignal.timeout(attemptTimeoutMs)]),
    ),
    {
      ...input.valuationRecovery,
      signal: input.signal,
    },
  );
  const account = valuationRecovery.value;
  const stoppedAt = now().toISOString();
  const finalDrainRecovery = {
    attempts: finalDrainAttempts,
    recovered: finalDrainError === null && finalDrainAttempts > 1,
    status: finalDrainError === null ? "COMPLETE" as const : "INCOMPLETE" as const,
  };
  const finalDrainMessage = finalDrainError instanceof Error
    ? finalDrainError.message
    : String(finalDrainError);
  return {
    finalDrainConsumedSignals,
    cancelledWaitingBuyCount,
    account,
    valuationRecovery: {
      attempts: valuationRecovery.attempts,
      recovered: valuationRecovery.recovered,
      status: valuationRecovery.status,
    },
    finalDrainRecovery,
    report: {
      ...input.report,
      stoppedAt,
      cycles: input.report.cycles + 1,
      consumedSignals: input.report.consumedSignals + finalDrainConsumedSignals,
      ...(finalDrainError === null ? {} : {
        errorCount: input.report.errorCount + 1,
        errors: [
          ...input.report.errors,
          { time: stoppedAt, message: `FINAL_DRAIN_RECOVERY_EXHAUSTED:${finalDrainMessage}` },
        ],
      }),
      account,
      acceptance: input.executor.acceptanceSummary(input.accountId, {
        startAt: input.report.startedAt,
        endAt: stoppedAt,
      }),
    },
  };
}
