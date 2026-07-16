import { execFileSync } from "node:child_process";
import type { SourceVersion } from "../infra/source-version.js";
import { ObserveStore } from "../observe/observe-store.js";
import { PaperAcceptanceSummaryService, type PaperAcceptanceSummary } from "../paper/paper-acceptance-summary.js";
import { PaperExecutor } from "../paper/paper-executor.js";
import { PublicPaperMarketDataProvider } from "../paper/public-market-data.js";
import type { PaperMarketDataProvider } from "../paper/types.js";
import {
  evaluateInterruptedSessionRecovery,
  findCampaignRuntimeProcesses,
  inspectInterruptedDatabaseContinuity,
  validationCheckpointChainBlockers,
  type InterruptedDatabaseContinuity,
  type InterruptedSessionRecoveryDecision,
} from "./crash-recovery.js";
import {
  collectCheckpointEvidence,
  validateFinalCampaignIntegrity,
  type FinalIntegrityEvidence,
} from "./operator-evidence.js";
import type {
  CampaignSnapshot,
  CheckpointEvidence,
  ValidationCheckpoint,
  ValidationSessionDefinition,
} from "./types.js";

export interface InterruptedRuntimeCleanupEvidence {
  permitted: boolean;
  prerequisiteBlockers: string[];
  cancelledWaitingBuyCount: number;
  interruptedObserveRunIds: string[];
  blockers: string[];
}

export interface PreparedInterruptedRuntimeRecovery {
  acceptance: PaperAcceptanceSummary;
  integrity: FinalIntegrityEvidence;
  decision: InterruptedSessionRecoveryDecision;
  continuity: InterruptedDatabaseContinuity;
  cleanup: InterruptedRuntimeCleanupEvidence;
  checkpointEvidence: CheckpointEvidence;
}

/**
 * Production recovery preparation shared by the operator CLI and integration
 * tests. It never finalizes a Campaign: it proves process quiescence, performs
 * only the normal transactional waiting-BUY cleanup, refreshes the Portfolio
 * projection, interrupts the exact abandoned Observe run and returns immutable
 * evidence for PaperValidationCampaignService.
 */
export async function prepareInterruptedRuntimeRecovery(input: {
  databasePath: string;
  snapshot: CampaignSnapshot;
  session: ValidationSessionDefinition;
  checkpoints: ValidationCheckpoint[];
  sourceVersion: SourceVersion;
  observedAt: string;
  processListing?: string;
  processInspectionError?: string | null;
  currentPid?: number;
  marketData?: PaperMarketDataProvider;
}): Promise<PreparedInterruptedRuntimeRecovery> {
  let acceptance = new PaperAcceptanceSummaryService(input.databasePath)
    .summarize(input.snapshot.paperAccountId);
  let integrity = validateFinalCampaignIntegrity({
    databasePath: input.databasePath,
    paperAccountId: input.snapshot.paperAccountId,
    acceptance,
  });
  let processInspectionError = input.processInspectionError ?? null;
  let processListing = input.processListing ?? null;
  if (processListing === null && processInspectionError === null) {
    try {
      processListing = execFileSync("/bin/ps", ["-ax", "-o", "pid=,command="], {
        encoding: "utf8",
        timeout: 5_000,
      });
    } catch (error) {
      processInspectionError = error instanceof Error ? error.message : String(error);
    }
  }
  const lingeringProcesses = processListing === null
    ? []
    : findCampaignRuntimeProcesses({
      psOutput: processListing,
      campaignId: input.snapshot.campaignId,
      sessionId: input.session.sessionId,
      currentPid: input.currentPid ?? process.pid,
    });
  let checkpointEvidence = collectCheckpointEvidence({
    databasePath: input.databasePath,
    targetId: input.snapshot.targetId,
    paperAccountId: input.snapshot.paperAccountId,
    observeActive: false,
    paperActive: false,
    detail: { recoveryForSessionId: input.session.sessionId },
  });
  let continuity = inspectInterruptedDatabaseContinuity({
    databasePath: input.databasePath,
    campaignId: input.snapshot.campaignId,
    sessionId: input.session.sessionId,
    sessionStartedAt: input.session.startedAt,
    targetId: input.snapshot.targetId,
    baselineRunId: input.snapshot.baselineRunId,
    paperAccountId: input.snapshot.paperAccountId,
    latestCheckpoint: input.checkpoints.at(-1) ?? null,
    currentEvidence: checkpointEvidence,
  });
  // Cleanup may repair only the expected stale Portfolio/account relationship
  // by releasing a waiting Reservation and persisting a fresh projection. All
  // other pre-cleanup continuity failures are evidence anomalies that must not
  // disappear merely because abandoned runtime rows were then interrupted.
  const initialContinuityBlockers = continuity.blockers.filter(
    (blocker) => blocker !== "RECOVERY_CURRENT_PORTFOLIO_ACCOUNT_MISMATCH",
  );
  const checkpointBlockers = validationCheckpointChainBlockers({
    checkpoints: input.checkpoints,
    campaignId: input.snapshot.campaignId,
    sessionId: input.session.sessionId,
    sessionStartedAt: input.session.startedAt,
    expectedLiveGateTransitionCount: input.session.liveGateTransitionCountAtStart,
  });
  const cleanupPrerequisiteBlockers = [
    ...(processInspectionError ? [`RECOVERY_PROCESS_INSPECTION_FAILED:${processInspectionError}`] : []),
    ...lingeringProcesses.map((candidate) => `RECOVERY_PROCESS_STILL_RUNNING:${candidate.role}:${candidate.pid}`),
    ...checkpointBlockers,
    ...(integrity.integrityCheck === "ok" ? [] : [`DATABASE_INTEGRITY:${integrity.integrityCheck}`]),
    ...(integrity.foreignKeyIssueCount === 0 ? [] : [`FOREIGN_KEY_ISSUES:${integrity.foreignKeyIssueCount}`]),
    ...(integrity.executionMode === "PAPER" ? [] : [`EXECUTION_MODE:${integrity.executionMode}`]),
    ...(integrity.liveGateState === "LIVE_DISABLED" ? [] : [`LIVE_GATE_STATE:${integrity.liveGateState}`]),
  ];
  let cancelledWaitingBuyCount = 0;
  const interruptedObserveRunIds: string[] = [];
  const cleanupBlockers: string[] = [];
  if (cleanupPrerequisiteBlockers.length === 0) {
    const executor = new PaperExecutor(
      input.databasePath,
      input.marketData ?? new PublicPaperMarketDataProvider(),
      { sourceVersion: input.sourceVersion, now: () => new Date(input.observedAt) },
    );
    try {
      cancelledWaitingBuyCount = await executor.cancelWaitingBuys(
        input.snapshot.paperAccountId,
        "PAPER_CAMPAIGN_CRASH_RECOVERY",
      );
      await executor.accountSnapshot(input.snapshot.paperAccountId);
    } catch (error) {
      cleanupBlockers.push(
        `RECOVERY_WAITING_BUY_CLEANUP_FAILED:${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      executor.close();
    }
    if (cancelledWaitingBuyCount !== continuity.waitingBuyCount) {
      cleanupBlockers.push("RECOVERY_WAITING_BUY_CLEANUP_COUNT_MISMATCH");
    }
    const observeStore = new ObserveStore(input.databasePath, input.sourceVersion);
    try {
      for (const observeRunId of continuity.abandonedObserveRunIds) {
        if (!observeStore.interruptAbandonedRun(
          observeRunId,
          input.observedAt,
          "PAPER_CAMPAIGN_CRASH_RECOVERY",
        )) {
          cleanupBlockers.push(`RECOVERY_OBSERVE_RUN_INTERRUPT_FAILED:${observeRunId}`);
        } else {
          interruptedObserveRunIds.push(observeRunId);
        }
      }
    } finally {
      observeStore.close();
    }

    acceptance = new PaperAcceptanceSummaryService(input.databasePath)
      .summarize(input.snapshot.paperAccountId);
    integrity = validateFinalCampaignIntegrity({
      databasePath: input.databasePath,
      paperAccountId: input.snapshot.paperAccountId,
      acceptance,
    });
    checkpointEvidence = collectCheckpointEvidence({
      databasePath: input.databasePath,
      targetId: input.snapshot.targetId,
      paperAccountId: input.snapshot.paperAccountId,
      observeActive: false,
      paperActive: false,
      detail: { recoveryForSessionId: input.session.sessionId },
    });
    const afterCleanupContinuity = inspectInterruptedDatabaseContinuity({
      databasePath: input.databasePath,
      campaignId: input.snapshot.campaignId,
      sessionId: input.session.sessionId,
      sessionStartedAt: input.session.startedAt,
      targetId: input.snapshot.targetId,
      baselineRunId: input.snapshot.baselineRunId,
      paperAccountId: input.snapshot.paperAccountId,
      latestCheckpoint: input.checkpoints.at(-1) ?? null,
      currentEvidence: checkpointEvidence,
    });
    if (afterCleanupContinuity.waitingBuyCount !== 0) {
      cleanupBlockers.push("RECOVERY_WAITING_BUY_REMAINS");
    }
    if (afterCleanupContinuity.pendingExitCount !== continuity.pendingExitCount) {
      cleanupBlockers.push("RECOVERY_PENDING_EXIT_CHANGED");
    }
    continuity = afterCleanupContinuity;
  }

  const decision = evaluateInterruptedSessionRecovery({
    checkpoints: input.checkpoints,
    currentEvidence: checkpointEvidence,
    integrity,
    acceptance,
    lingeringProcesses,
    processInspectionError,
    continuityBlockers: [
      ...checkpointBlockers,
      ...initialContinuityBlockers,
      ...continuity.blockers,
      ...cleanupBlockers,
    ],
  });
  const cleanup: InterruptedRuntimeCleanupEvidence = {
    permitted: cleanupPrerequisiteBlockers.length === 0,
    prerequisiteBlockers: cleanupPrerequisiteBlockers,
    cancelledWaitingBuyCount,
    interruptedObserveRunIds,
    blockers: cleanupBlockers,
  };
  return {
    acceptance,
    integrity,
    decision,
    continuity,
    cleanup,
    checkpointEvidence: {
      ...checkpointEvidence,
      detail: {
        ...(checkpointEvidence.detail ?? {}),
        recoveryDecision: decision,
        databaseContinuity: continuity,
        cleanup,
      },
    },
  };
}
