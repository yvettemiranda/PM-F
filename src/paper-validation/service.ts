import { createHash, randomBytes } from "node:crypto";
import { RULESET, RULESET_HASH, VERSIONS, stableJson } from "../domain/versioning.js";
import type { SourceVersion } from "../infra/source-version.js";
import { buildPaperExecutionFunnel } from "../paper/paper-execution-funnel.js";
import { assertCoreCompatibility, computeCoreCompatibilityHash } from "./core-compatibility.js";
import {
  calculateSessionRuntime,
  deriveCampaignState,
  mergeCampaignCoverage,
  missingCoverageScenarios,
  validationReportHash,
} from "./report.js";
import { PaperValidationStore } from "./store.js";
import { paperCampaignStartDisposition } from "./operator-policy.js";
import {
  PAPER_VALIDATION_CHECKPOINT_INTERVAL_MS,
  PAPER_VALIDATION_MAX_CHECKPOINT_GAP_MS,
  PAPER_VALIDATION_QUALIFYING_MS,
  PAPER_VALIDATION_REQUIRED_ACTIVE_MS,
  PAPER_VALIDATION_REQUIRED_CONTINUOUS_MS,
  type CampaignDefinition,
  type CampaignSnapshot,
  type CampaignValidationReport,
  type CheckpointEvidence,
  type CoreCompatibilityManifest,
  type FinalizeSessionInput,
  type FinalizeSessionResult,
  type ObserveOperationalMetrics,
  type SessionCoverage,
  type SessionValidationReport,
  type ValidationAcceptanceStatus,
  type ValidationCheckpoint,
  type ValidationCheckpointKind,
  type ValidationSessionDefinition,
  type ValidationSessionState,
} from "./types.js";

const LONG_SESSION_MS = 12 * 60 * 60 * 1_000;

export interface CreateCampaignInput {
  targetId: string;
  baselineRunId: string;
  paperAccountId: string;
  coreManifest: CoreCompatibilityManifest;
  sourceVersion: SourceVersion;
  now: string;
  campaignId?: string;
  supersedesCampaignId?: string;
  replacementReason?: "CORE_REPAIR_MARKET_DATA" | "CORE_VERSION_REPLACEMENT";
  requiredActiveRuntimeMs?: number;
  requiredContinuousRuntimeMs?: number;
  qualifyingRuntimeMs?: number;
  checkpointIntervalMs?: number;
  maxCheckpointGapMs?: number;
}

export interface StartSessionInput {
  campaignId: string;
  coreManifest: CoreCompatibilityManifest;
  sourceVersion: SourceVersion;
  now: string;
  sessionId?: string;
  plannedDurationMs?: number;
}

export interface RecordCheckpointInput {
  sessionId: string;
  checkpointKind: ValidationCheckpointKind;
  observedAt: string;
  idempotencyKey: string;
  evidence: CheckpointEvidence;
}

export interface RecoverInterruptedSessionInput {
  campaignId: string;
  coreManifest: CoreCompatibilityManifest;
  sourceVersion: SourceVersion;
  observedAt: string;
  recoveryConfirmed: boolean;
  consistencyPassed: boolean;
  blockers: string[];
  coverage?: SessionCoverage;
  checkpointEvidence: CheckpointEvidence;
}

function hash(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function publicId(prefix: "PC" | "PS" | "PR"): string {
  return `${prefix}-${randomBytes(10).toString("hex").toUpperCase()}`;
}

function parseTime(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label}_INVALID:${value}`);
  return parsed;
}

function assertPositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label}_MUST_BE_POSITIVE_SAFE_INTEGER`);
}

function normalizedBlockers(blockers: string[]): string[] {
  return [...new Set(blockers.map((blocker) => blocker.trim()).filter(Boolean))].sort();
}

function emptyObserveMetrics(): ObserveOperationalMetrics {
  return {
    successfulPolls: 0,
    failedPolls: 0,
    processedEvents: 0,
    emittedSignals: 0,
    duplicateEvents: 0,
    gapEvents: 0,
    reconciliationCount: 0,
    minorDiffCount: 0,
    majorDesyncCount: 0,
    schedulingGapCount: 0,
    recoveredApiFailureSessions: 0,
    checkpointRecoveredSessions: 0,
    unrecoveredConnectionGapSessions: 0,
  };
}

function aggregateObserveMetrics(reports: readonly SessionValidationReport[]): ObserveOperationalMetrics {
  const total = emptyObserveMetrics();
  for (const metrics of reports.map((report) => report.observeMetrics).filter(
    (value): value is ObserveOperationalMetrics => value !== null,
  )) {
    for (const key of Object.keys(total) as Array<keyof ObserveOperationalMetrics>) {
      total[key] += metrics[key];
    }
  }
  return total;
}

function qualifyingAcceptance(status: ValidationAcceptanceStatus): boolean {
  return status === "PASSED_NATURAL" || status === "PASSED_WITH_SUPPLEMENTAL_EVIDENCE";
}

function reportQualifiesCampaign(
  report: SessionValidationReport,
  campaign: CampaignDefinition,
): boolean {
  return report.sessionKind === "QUALIFYING"
    && report.countsTowardCampaign
    && report.consistencyPassed
    && report.recoveryConfirmed
    && ["SAFE_STOP", "AUTO_STOP"].includes(report.outcome)
    && qualifyingAcceptance(report.acceptanceStatus)
    && report.runtime.effectiveActiveRuntimeMs >= campaign.qualifyingRuntimeMs;
}

function frozenRecoveryFinalization(checkpoint: ValidationCheckpoint): FinalizeSessionInput {
  const candidate = checkpoint.evidence.detail?.recoveryFinalizationInput;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new Error("PAPER_VALIDATION_RECOVERY_FINALIZATION_EVIDENCE_MISSING");
  }
  const value = candidate as Partial<FinalizeSessionInput>;
  if (
    value.sessionId !== checkpoint.sessionId
    || !["CRASH_RECOVERED", "CRASH_UNVERIFIED"].includes(value.outcome ?? "")
    || !["INCOMPLETE_COVERAGE", "FAILED"].includes(value.acceptanceStatus ?? "")
    || typeof value.consistencyPassed !== "boolean"
    || typeof value.recoveryConfirmed !== "boolean"
    || typeof value.stopReason !== "string"
    || !Array.isArray(value.blockers)
    || value.blockers.some((blocker) => typeof blocker !== "string")
    || !value.coverage
    || typeof value.coverage !== "object"
    || typeof value.stoppedAt !== "string"
  ) {
    throw new Error("PAPER_VALIDATION_RECOVERY_FINALIZATION_EVIDENCE_INVALID");
  }
  parseTime(value.stoppedAt, "RECOVERY_FINALIZATION_STOPPED_AT");
  return value as FinalizeSessionInput;
}

export class PaperValidationCampaignService {
  readonly store: PaperValidationStore;

  constructor(databasePath: string) {
    this.store = new PaperValidationStore(databasePath);
  }

  createCampaign(input: CreateCampaignInput): CampaignSnapshot {
    this.assertCleanSource(input.sourceVersion);
    this.assertCurrentManifest(input.coreManifest);
    const requiredActiveRuntimeMs = input.requiredActiveRuntimeMs ?? PAPER_VALIDATION_REQUIRED_ACTIVE_MS;
    const requiredContinuousRuntimeMs = input.requiredContinuousRuntimeMs ?? PAPER_VALIDATION_REQUIRED_CONTINUOUS_MS;
    const qualifyingRuntimeMs = input.qualifyingRuntimeMs ?? PAPER_VALIDATION_QUALIFYING_MS;
    const checkpointIntervalMs = input.checkpointIntervalMs ?? PAPER_VALIDATION_CHECKPOINT_INTERVAL_MS;
    const maxCheckpointGapMs = input.maxCheckpointGapMs ?? PAPER_VALIDATION_MAX_CHECKPOINT_GAP_MS;
    for (const [label, value] of Object.entries({
      requiredActiveRuntimeMs,
      requiredContinuousRuntimeMs,
      qualifyingRuntimeMs,
      checkpointIntervalMs,
      maxCheckpointGapMs,
    })) assertPositiveSafeInteger(value, label.toUpperCase());
    if (requiredActiveRuntimeMs < PAPER_VALIDATION_REQUIRED_ACTIVE_MS) {
      throw new Error("PAPER_VALIDATION_ACTIVE_RUNTIME_BELOW_HARD_MINIMUM");
    }
    if (requiredContinuousRuntimeMs < PAPER_VALIDATION_REQUIRED_CONTINUOUS_MS) {
      throw new Error("PAPER_VALIDATION_CONTINUOUS_RUNTIME_BELOW_HARD_MINIMUM");
    }
    if (qualifyingRuntimeMs < PAPER_VALIDATION_QUALIFYING_MS) {
      throw new Error("PAPER_VALIDATION_QUALIFYING_RUNTIME_BELOW_HARD_MINIMUM");
    }
    if (checkpointIntervalMs !== PAPER_VALIDATION_CHECKPOINT_INTERVAL_MS
      || maxCheckpointGapMs !== PAPER_VALIDATION_MAX_CHECKPOINT_GAP_MS) {
      throw new Error("PAPER_VALIDATION_CHECKPOINT_POLICY_MISMATCH");
    }
    parseTime(input.now, "CAMPAIGN_CREATED_AT");
    const campaignId = input.campaignId ?? publicId("PC");
    const coreCompatibilityHash = computeCoreCompatibilityHash(input.coreManifest);
    const hasSupersededCampaign = input.supersedesCampaignId !== undefined;
    const hasReplacementReason = input.replacementReason !== undefined;
    if (hasSupersededCampaign !== hasReplacementReason) {
      throw new Error("PAPER_VALIDATION_REPLACEMENT_LINK_INCOMPLETE");
    }
    const definition: CampaignDefinition = {
      campaignId,
      targetId: input.targetId,
      baselineRunId: input.baselineRunId,
      paperAccountId: input.paperAccountId,
      initialBalanceMicros: String(RULESET.paperInitialBalanceMicros),
      requiredActiveRuntimeMs,
      requiredContinuousRuntimeMs,
      qualifyingRuntimeMs,
      checkpointIntervalMs,
      maxCheckpointGapMs,
      coreCompatibilityHash,
      coreManifest: input.coreManifest,
      sourceVersion: input.sourceVersion,
      createdAt: input.now,
    };
    this.store.transaction(() => {
      this.store.assertPaperSafetyState();
      const activeCampaign = this.store.campaignIdsForTarget(input.targetId).find((existingId) =>
        ["QUALIFYING", "RUNNING", "PAUSED", "INCOMPLETE_COVERAGE"].includes(this.store.campaignState(existingId))
      );
      if (activeCampaign) {
        throw new Error(`PAPER_VALIDATION_ACTIVE_CAMPAIGN_EXISTS:${activeCampaign}`);
      }
      const existingCampaignIds = this.store.campaignIdsForTarget(input.targetId);
      const latestCampaignId = existingCampaignIds.at(-1) ?? null;
      let replacementEvidence: Record<string, unknown> = {};
      if (latestCampaignId !== null) {
        if (!input.supersedesCampaignId || !input.replacementReason) {
          throw new Error(`PAPER_VALIDATION_REPLACEMENT_LINK_REQUIRED:${latestCampaignId}`);
        }
        if (input.supersedesCampaignId !== latestCampaignId) {
          throw new Error(`PAPER_VALIDATION_REPLACEMENT_NOT_LATEST:${input.supersedesCampaignId}:${latestCampaignId}`);
        }
        const previous = this.campaignSnapshot(input.supersedesCampaignId);
        const expectedReplacementReason = previous.state === "BLOCKED"
          ? "CORE_REPAIR_MARKET_DATA"
          : "CORE_VERSION_REPLACEMENT";
        if (
          previous.targetId !== input.targetId
          || input.replacementReason !== expectedReplacementReason
          || paperCampaignStartDisposition(previous, coreCompatibilityHash) !== "CREATE_REPLACEMENT"
        ) {
          throw new Error(`PAPER_VALIDATION_REPLACEMENT_NOT_AUTHORIZED:${input.supersedesCampaignId}`);
        }
        replacementEvidence = {
          supersedesCampaignId: previous.campaignId,
          supersededCampaignState: previous.state,
          supersededCoreCompatibilityHash: previous.coreCompatibilityHash,
          replacementReason: input.replacementReason,
        };
      } else if (input.supersedesCampaignId || input.replacementReason) {
        throw new Error("PAPER_VALIDATION_REPLACEMENT_SOURCE_NOT_FOUND");
      }
      this.store.assertCampaignBindings({
        targetId: input.targetId,
        baselineRunId: input.baselineRunId,
        paperAccountId: input.paperAccountId,
        initialBalanceMicros: definition.initialBalanceMicros,
        sourceVersion: input.sourceVersion,
        schemaVersion: input.coreManifest.schemaVersion,
        strategyVersion: input.coreManifest.strategyVersion,
        riskVersion: input.coreManifest.riskVersion,
        paperVersion: input.coreManifest.paperVersion,
        rulesetHash: input.coreManifest.rulesetHash,
      });
      this.store.insertCampaign({
        ...definition,
        schemaVersion: input.coreManifest.schemaVersion,
        signalVersion: input.coreManifest.signalVersion,
        strategyVersion: input.coreManifest.strategyVersion,
        riskVersion: input.coreManifest.riskVersion,
        paperVersion: input.coreManifest.paperVersion,
        rulesetHash: input.coreManifest.rulesetHash,
        configVersion: input.coreManifest.configVersion,
      });
      this.store.insertTransition({
        entityType: "CAMPAIGN",
        campaignId,
        fromState: null,
        toState: "QUALIFYING",
        reason: latestCampaignId === null
          ? "CAMPAIGN_CREATED"
          : "CAMPAIGN_CREATED_AFTER_CORE_REPAIR",
        evidence: {
          targetId: input.targetId,
          baselineRunId: input.baselineRunId,
          paperAccountId: input.paperAccountId,
          executionMode: "PAPER",
          liveGateState: "LIVE_DISABLED",
          ...replacementEvidence,
        },
        coreCompatibilityHash,
        sourceVersion: input.sourceVersion,
        configVersion: input.coreManifest.configVersion,
        idempotencyKey: `CAMPAIGN:${campaignId}:CREATE`,
        now: input.now,
      });
    });
    return this.campaignSnapshot(campaignId);
  }

  startSession(input: StartSessionInput): ValidationSessionDefinition {
    this.assertCleanSource(input.sourceVersion);
    this.assertCurrentManifest(input.coreManifest);
    parseTime(input.now, "SESSION_STARTED_AT");
    const actualCoreHash = computeCoreCompatibilityHash(input.coreManifest);
    const initialSnapshot = this.campaignSnapshot(input.campaignId);
    if (!["QUALIFYING", "PAUSED", "INCOMPLETE_COVERAGE"].includes(initialSnapshot.state)) {
      throw new Error(`PAPER_VALIDATION_CAMPAIGN_NOT_STARTABLE:${initialSnapshot.state}`);
    }
    this.freezeAndThrowIfIncompatible(input.campaignId, actualCoreHash, input.sourceVersion, input.now);

    const snapshot = this.campaignSnapshot(input.campaignId);
    const sessionKind = snapshot.qualified ? "LONG_RUNNING" : "QUALIFYING";
    const defaultDuration = sessionKind === "QUALIFYING"
      ? snapshot.qualifyingRuntimeMs
      : this.defaultLongSessionDuration(snapshot);
    const plannedDurationMs = input.plannedDurationMs ?? defaultDuration;
    assertPositiveSafeInteger(plannedDurationMs, "PLANNED_DURATION_MS");
    const sessionId = input.sessionId ?? publicId("PS");

    this.store.transaction(() => {
      const safety = this.store.assertPaperSafetyState();
      if (this.store.runningSession(input.campaignId)) {
        throw new Error(`PAPER_VALIDATION_SESSION_ALREADY_RUNNING:${input.campaignId}`);
      }
      const currentState = this.store.campaignState(input.campaignId);
      if (!["QUALIFYING", "PAUSED", "INCOMPLETE_COVERAGE"].includes(currentState)) {
        throw new Error(`PAPER_VALIDATION_CAMPAIGN_NOT_STARTABLE:${currentState}`);
      }
      const sequence = this.store.nextSessionSequence(input.campaignId);
      this.store.insertSession({
        sessionId,
        campaignId: input.campaignId,
        sequence,
        sessionKind,
        plannedDurationMs,
        coreCompatibilityHash: actualCoreHash,
        schemaVersion: input.coreManifest.schemaVersion,
        rulesetHash: input.coreManifest.rulesetHash,
        configVersion: input.coreManifest.configVersion,
        sourceVersion: input.sourceVersion,
        liveGateTransitionCountAtStart: safety.transitionCount,
        startedAt: input.now,
      });
      this.store.insertTransition({
        entityType: "SESSION",
        campaignId: input.campaignId,
        sessionId,
        fromState: null,
        toState: "RUNNING",
        reason: "SESSION_STARTED",
        evidence: {
          sessionKind,
          plannedDurationMs,
          sequence,
          liveGateTransitionCountAtStart: safety.transitionCount,
        },
        coreCompatibilityHash: actualCoreHash,
        sourceVersion: input.sourceVersion,
        configVersion: input.coreManifest.configVersion,
        idempotencyKey: `SESSION:${sessionId}:START`,
        now: input.now,
      });
      this.store.insertTransition({
        entityType: "CAMPAIGN",
        campaignId: input.campaignId,
        fromState: currentState,
        toState: "RUNNING",
        reason: "SESSION_STARTED",
        evidence: {
          sessionId,
          sessionKind,
          plannedDurationMs,
          sequence,
          liveGateTransitionCountAtStart: safety.transitionCount,
        },
        coreCompatibilityHash: actualCoreHash,
        sourceVersion: input.sourceVersion,
        configVersion: input.coreManifest.configVersion,
        idempotencyKey: `CAMPAIGN:${input.campaignId}:SESSION:${sessionId}:START`,
        now: input.now,
      });
    });
    return this.store.session(sessionId);
  }

  recordCheckpoint(input: RecordCheckpointInput): ValidationCheckpoint {
    parseTime(input.observedAt, "CHECKPOINT_OBSERVED_AT");
    return this.store.transaction(() => {
      const session = this.store.session(input.sessionId);
      const safety = this.store.assertPaperSafetyState();
      const liveGateTransitionDetected = safety.transitionCount !== session.liveGateTransitionCountAtStart;
      const evidence: CheckpointEvidence = {
        ...input.evidence,
        consistencySafe: input.evidence.consistencySafe && !liveGateTransitionDetected,
        detail: {
          ...(input.evidence.detail ?? {}),
          liveGateTransitionCountAtStart: session.liveGateTransitionCountAtStart,
          liveGateTransitionCount: safety.transitionCount,
          liveGateTransitionDetected,
        },
      };
      const checkpointPayload = {
        sessionId: input.sessionId,
        checkpointKind: input.checkpointKind,
        observedAt: input.observedAt,
        executionMode: safety.executionMode,
        liveGateState: safety.liveGateState,
        liveGateTransitionCount: safety.transitionCount,
        evidence,
      };
      const checkpointHash = hash(checkpointPayload);
      const existing = this.store.checkpointByIdempotencyKey(input.idempotencyKey);
      if (existing) {
        if (existing.checkpointHash !== checkpointHash) {
          throw new Error("PAPER_VALIDATION_CHECKPOINT_IDEMPOTENCY_CONFLICT");
        }
        return existing;
      }
      if (session.state !== "RUNNING") throw new Error(`PAPER_VALIDATION_SESSION_NOT_RUNNING:${session.state}`);
      if (this.store.campaignState(session.campaignId) !== "RUNNING") {
        throw new Error("PAPER_VALIDATION_CAMPAIGN_NOT_RUNNING");
      }
      const observedMs = parseTime(input.observedAt, "CHECKPOINT_OBSERVED_AT");
      const startedMs = parseTime(session.startedAt, "SESSION_STARTED_AT");
      if (observedMs < startedMs) throw new Error("PAPER_VALIDATION_CHECKPOINT_BEFORE_SESSION");
      const previous = this.store.latestCheckpoint(input.sessionId);
      if (previous && parseTime(previous.observedAt, "PREVIOUS_CHECKPOINT_AT") > observedMs) {
        throw new Error("PAPER_VALIDATION_CHECKPOINT_OUT_OF_ORDER");
      }
      if (!previous && input.checkpointKind !== "START") {
        throw new Error("PAPER_VALIDATION_FIRST_CHECKPOINT_MUST_BE_START");
      }
      if (previous && input.checkpointKind === "START") {
        throw new Error("PAPER_VALIDATION_START_CHECKPOINT_ALREADY_RECORDED");
      }
      const sequence = this.store.nextCheckpointSequence(input.sessionId);
      const checkpointId = `pvc-${hash([input.idempotencyKey, checkpointHash]).slice(0, 32)}`;
      this.store.insertCheckpoint({
        checkpointId,
        campaignId: session.campaignId,
        sessionId: input.sessionId,
        sequence,
        checkpointKind: input.checkpointKind,
        observedAt: input.observedAt,
        elapsedRuntimeMs: observedMs - startedMs,
        liveGateTransitionCount: safety.transitionCount,
        evidence,
        checkpointHash,
        idempotencyKey: input.idempotencyKey,
      });
      return this.store.checkpointByIdempotencyKey(input.idempotencyKey)!;
    });
  }

  finalizeSession(input: FinalizeSessionInput): FinalizeSessionResult {
    parseTime(input.stoppedAt, "SESSION_STOPPED_AT");
    const requestedBlockers = normalizedBlockers(input.blockers);
    const requestedInput = { ...input, blockers: requestedBlockers };
    const finalizationInputHash = hash(requestedInput);
    const sessionIdempotencyKey = `SESSION:${input.sessionId}:FINALIZE`;
    return this.store.transaction(() => {
      const existing = this.store.reportByIdempotencyKey<SessionValidationReport>(sessionIdempotencyKey);
      if (existing) {
        if (existing.finalizationInputHash !== finalizationInputHash) {
          throw new Error("PAPER_VALIDATION_FINALIZE_IDEMPOTENCY_CONFLICT");
        }
        const campaign = this.store.reportByIdempotencyKey<CampaignValidationReport>(
          `CAMPAIGN:${existing.campaignId}:AFTER:${input.sessionId}`,
        );
        if (!campaign) throw new Error("PAPER_VALIDATION_CAMPAIGN_REPORT_MISSING");
        return { session: existing, campaign };
      }

      const session = this.store.session(input.sessionId);
      if (session.state !== "RUNNING") throw new Error(`PAPER_VALIDATION_SESSION_NOT_RUNNING:${session.state}`);
      const safety = this.store.assertPaperSafetyState();
      const liveGateTransitionDetected = safety.transitionCount !== session.liveGateTransitionCountAtStart;
      const blockers = normalizedBlockers([
        ...requestedBlockers,
        ...(liveGateTransitionDetected ? ["LIVE_GATE_TRANSITION_DURING_SESSION"] : []),
      ]);
      const consistencyPassed = input.consistencyPassed && !liveGateTransitionDetected;
      const campaign = this.store.campaign(session.campaignId);
      const checkpoints = this.store.checkpoints(input.sessionId);
      if (checkpoints.length === 0) throw new Error("PAPER_VALIDATION_CHECKPOINTS_MISSING");
      const latestCheckpoint = checkpoints.at(-1)!;
      if (["SAFE_STOP", "AUTO_STOP"].includes(input.outcome) && latestCheckpoint.checkpointKind !== "SAFE_STOP") {
        throw new Error("PAPER_VALIDATION_SAFE_STOP_CHECKPOINT_MISSING");
      }
      if (["CRASH_RECOVERED", "CRASH_UNVERIFIED"].includes(input.outcome)
        && latestCheckpoint.checkpointKind !== "CRASH_RECOVERY") {
        throw new Error("PAPER_VALIDATION_CRASH_RECOVERY_CHECKPOINT_MISSING");
      }
      const runtime = calculateSessionRuntime({
        checkpoints,
        maxCheckpointGapMs: campaign.maxCheckpointGapMs,
        expectedLiveGateTransitionCount: session.liveGateTransitionCountAtStart,
        outcome: input.outcome,
      });
      const recoverySafe = !["CRASH_RECOVERED", "CRASH_UNVERIFIED"].includes(input.outcome)
        || input.recoveryConfirmed;
      const safetyPassed = consistencyPassed
        && recoverySafe
        && blockers.length === 0
        && input.acceptanceStatus !== "FAILED"
        && !["FAILED", "CRASH_UNVERIFIED"].includes(input.outcome);
      const previouslyQualified = this.store.sessionReports(session.campaignId)
        .some((report) => reportQualifiesCampaign(report, campaign));
      const qualifyingPassed = session.sessionKind === "QUALIFYING"
        && safetyPassed
        && ["SAFE_STOP", "AUTO_STOP"].includes(input.outcome)
        && qualifyingAcceptance(input.acceptanceStatus)
        && runtime.effectiveActiveRuntimeMs >= campaign.qualifyingRuntimeMs;
      const safePartialQualifyingRuntime = session.sessionKind === "QUALIFYING"
        && safetyPassed
        && input.outcome === "SAFE_STOP"
        && /^USER_SAFE_PAUSE_(SIGINT|SIGTERM|SIGHUP)$/.test(input.stopReason)
        && input.acceptanceStatus === "INCOMPLETE_COVERAGE"
        && runtime.effectiveActiveRuntimeMs > 0
        && runtime.effectiveActiveRuntimeMs < campaign.qualifyingRuntimeMs;
      const longRunningPassed = session.sessionKind === "LONG_RUNNING" && previouslyQualified && safetyPassed;
      const countsTowardCampaign = qualifyingPassed || safePartialQualifyingRuntime || longRunningPassed;
      const fatal = !safetyPassed;
      const sessionState: ValidationSessionState = input.outcome === "CRASH_RECOVERED" && safetyPassed
        ? "CRASH_RECOVERED"
        : fatal
          ? input.outcome === "FAILED" ? "FAILED" : "BLOCKED"
          : "COMPLETED";
      const sessionReport: SessionValidationReport = {
        reportId: publicId("PR"),
        campaignId: session.campaignId,
        sessionId: session.sessionId,
        sessionKind: session.sessionKind,
        sessionState,
        outcome: input.outcome,
        acceptanceStatus: input.acceptanceStatus,
        consistencyPassed,
        recoveryConfirmed: input.recoveryConfirmed,
        stopReason: input.stopReason,
        blockers,
        coverage: input.coverage,
        observeMetrics: input.observeMetrics ?? null,
        runtime,
        countsTowardCampaign,
        finalizationInputHash,
        sourceVersion: session.sourceVersion,
        coreCompatibilityHash: campaign.coreCompatibilityHash,
        startedAt: session.startedAt,
        stoppedAt: input.stoppedAt,
        createdAt: input.stoppedAt,
      };
      const sessionCoverage = mergeCampaignCoverage([sessionReport]);
      this.store.insertSessionReport({
        report: sessionReport,
        reportHash: validationReportHash(sessionReport),
        coverageStatus: missingCoverageScenarios(sessionCoverage).length === 0 ? "COMPLETE" : "INCOMPLETE",
        idempotencyKey: sessionIdempotencyKey,
        configVersion: campaign.coreManifest.configVersion,
      });
      this.store.insertTransition({
        entityType: "SESSION",
        campaignId: session.campaignId,
        sessionId: session.sessionId,
        fromState: "RUNNING",
        toState: sessionState,
        reason: input.stopReason,
        evidence: {
          outcome: input.outcome,
          reportId: sessionReport.reportId,
          reportHash: validationReportHash(sessionReport),
          runtime,
          countsTowardCampaign,
          blockers,
          liveGateTransitionCountAtStart: session.liveGateTransitionCountAtStart,
          liveGateTransitionCountAtStop: safety.transitionCount,
          liveGateTransitionDetected,
        },
        coreCompatibilityHash: campaign.coreCompatibilityHash,
        sourceVersion: session.sourceVersion,
        configVersion: campaign.coreManifest.configVersion,
        idempotencyKey: `SESSION:${session.sessionId}:STATE:${sessionState}`,
        now: input.stoppedAt,
      });

      const countedReports = this.store.sessionReports(session.campaignId, true);
      const allReports = this.store.sessionReports(session.campaignId);
      const accumulatedActiveRuntimeMs = countedReports.reduce(
        (total, report) => total + report.runtime.effectiveActiveRuntimeMs,
        0,
      );
      const longestContinuousRuntimeMs = countedReports.reduce(
        (longest, report) => Math.max(longest, report.runtime.qualifyingContinuousRuntimeMs),
        0,
      );
      const coverage = mergeCampaignCoverage(countedReports);
      const missingScenarios = missingCoverageScenarios(coverage);
      const campaignState = deriveCampaignState({
        blocked: fatal,
        accumulatedActiveRuntimeMs,
        longestContinuousRuntimeMs,
        requiredActiveRuntimeMs: campaign.requiredActiveRuntimeMs,
        requiredContinuousRuntimeMs: campaign.requiredContinuousRuntimeMs,
        missingScenarios,
      });
      const account = this.store.database.prepare(
        "SELECT signal_cutoff_at FROM paper_accounts WHERE paper_account_id=?",
      ).get(campaign.paperAccountId) as { signal_cutoff_at: string } | undefined;
      if (!account) throw new Error(`PAPER_ACCOUNT_NOT_FOUND:${campaign.paperAccountId}`);
      const cumulativePaperFunnel = buildPaperExecutionFunnel(
        this.store.database,
        campaign.paperAccountId,
        campaign.targetId,
        account.signal_cutoff_at,
        campaign.createdAt,
        input.stoppedAt,
      );
      const campaignReport: CampaignValidationReport = {
        reportId: publicId("PR"),
        campaignId: session.campaignId,
        afterSessionId: session.sessionId,
        campaignState,
        qualified: allReports.some((report) => reportQualifiesCampaign(report, campaign)),
        accumulatedActiveRuntimeMs,
        longestContinuousRuntimeMs,
        completedSessionCount: allReports.length,
        coverageStatus: missingScenarios.length === 0 ? "COMPLETE" : "INCOMPLETE",
        coverage,
        missingScenarios,
        blockers,
        canContinue: campaignState === "PAUSED" || campaignState === "INCOMPLETE_COVERAGE",
        operationalMetrics: {
          observe: aggregateObserveMetrics(allReports),
          paper: cumulativePaperFunnel,
          integrity: {
            finalizedSessionCount: allReports.length,
            consistencyPassedSessionCount: allReports.filter((report) => report.consistencyPassed).length,
            consistencyFailedSessionCount: allReports.filter((report) => !report.consistencyPassed).length,
            checkpointCount: allReports.reduce((total, report) => total + report.runtime.checkpointCount, 0),
            rejectedCheckpointIntervalCount: allReports.reduce(
              (total, report) => total + report.runtime.rejectedIntervalCount,
              0,
            ),
          },
        },
        sourceVersion: session.sourceVersion,
        coreCompatibilityHash: campaign.coreCompatibilityHash,
        createdAt: input.stoppedAt,
      };
      this.store.insertCampaignReport({
        report: campaignReport,
        reportHash: validationReportHash(campaignReport),
        idempotencyKey: `CAMPAIGN:${session.campaignId}:AFTER:${session.sessionId}`,
        configVersion: campaign.coreManifest.configVersion,
      });
      this.store.insertTransition({
        entityType: "CAMPAIGN",
        campaignId: session.campaignId,
        fromState: "RUNNING",
        toState: campaignState,
        reason: fatal ? "SESSION_BLOCKED" : "SESSION_FINALIZED",
        evidence: {
          sessionId: session.sessionId,
          sessionReportId: sessionReport.reportId,
          campaignReportId: campaignReport.reportId,
          accumulatedActiveRuntimeMs,
          longestContinuousRuntimeMs,
          missingScenarios,
          blockers,
        },
        coreCompatibilityHash: campaign.coreCompatibilityHash,
        sourceVersion: session.sourceVersion,
        configVersion: campaign.coreManifest.configVersion,
        idempotencyKey: `CAMPAIGN:${session.campaignId}:AFTER:${session.sessionId}:STATE`,
        now: input.stoppedAt,
      });
      return { session: sessionReport, campaign: campaignReport };
    });
  }

  recoverInterruptedSession(input: RecoverInterruptedSessionInput): FinalizeSessionResult | null {
    this.assertCleanSource(input.sourceVersion);
    this.assertCurrentManifest(input.coreManifest);
    const coreHash = computeCoreCompatibilityHash(input.coreManifest);
    this.freezeAndThrowIfIncompatible(input.campaignId, coreHash, input.sourceVersion, input.observedAt);
    const session = this.store.runningSession(input.campaignId);
    if (!session) return null;
    const finalizationInput: FinalizeSessionInput = {
      sessionId: session.sessionId,
      outcome: input.recoveryConfirmed ? "CRASH_RECOVERED" : "CRASH_UNVERIFIED",
      acceptanceStatus: input.recoveryConfirmed ? "INCOMPLETE_COVERAGE" : "FAILED",
      consistencyPassed: input.consistencyPassed,
      recoveryConfirmed: input.recoveryConfirmed,
      stopReason: input.recoveryConfirmed ? "CRASH_RECOVERY_CONFIRMED" : "CRASH_RECOVERY_UNVERIFIED",
      blockers: normalizedBlockers(input.blockers),
      coverage: input.coverage ?? {},
      stoppedAt: input.observedAt,
    };
    const recoveryIdempotencyKey = `SESSION:${session.sessionId}:CRASH_RECOVERY`;
    const existing = this.store.checkpointByIdempotencyKey(recoveryIdempotencyKey);
    const checkpoint = existing ?? this.recordCheckpoint({
      sessionId: session.sessionId,
      checkpointKind: "CRASH_RECOVERY",
      observedAt: input.observedAt,
      idempotencyKey: recoveryIdempotencyKey,
      evidence: {
        ...input.checkpointEvidence,
        observeActive: false,
        paperActive: false,
        consistencySafe: input.consistencyPassed && input.recoveryConfirmed,
        detail: {
          ...(input.checkpointEvidence.detail ?? {}),
          recoveryFinalizationInput: finalizationInput,
        },
      },
    });
    if (checkpoint.sessionId !== session.sessionId || checkpoint.checkpointKind !== "CRASH_RECOVERY") {
      throw new Error("PAPER_VALIDATION_RECOVERY_CHECKPOINT_BINDING_INVALID");
    }
    return this.finalizeSession(frozenRecoveryFinalization(checkpoint));
  }

  campaignSnapshot(campaignId: string): CampaignSnapshot {
    const definition = this.store.campaign(campaignId);
    const state = this.store.campaignState(campaignId);
    const countedReports = this.store.sessionReports(campaignId, true);
    const allReports = this.store.sessionReports(campaignId);
    const latestReport = this.store.latestCampaignReport(campaignId);
    const coverage = mergeCampaignCoverage(countedReports);
    const missingScenarios = missingCoverageScenarios(coverage);
    return {
      ...definition,
      state,
      qualified: allReports.some((report) => reportQualifiesCampaign(report, definition)),
      completedSessionCount: allReports.length,
      accumulatedActiveRuntimeMs: countedReports.reduce(
        (total, report) => total + report.runtime.effectiveActiveRuntimeMs,
        0,
      ),
      longestContinuousRuntimeMs: countedReports.reduce(
        (longest, report) => Math.max(longest, report.runtime.qualifyingContinuousRuntimeMs),
        0,
      ),
      coverageStatus: missingScenarios.length === 0 ? "COMPLETE" : "INCOMPLETE",
      coverage,
      missingScenarios,
      blockers: latestReport?.blockers ?? [],
      canContinue: state === "QUALIFYING" || state === "PAUSED" || state === "INCOMPLETE_COVERAGE",
      latestSessionId: allReports.at(-1)?.sessionId ?? this.store.runningSession(campaignId)?.sessionId ?? null,
      latestReportId: latestReport?.reportId ?? null,
    };
  }

  close(): void {
    this.store.close();
  }

  private defaultLongSessionDuration(snapshot: CampaignSnapshot): number {
    if (snapshot.longestContinuousRuntimeMs < snapshot.requiredContinuousRuntimeMs) return LONG_SESSION_MS;
    const remaining = snapshot.requiredActiveRuntimeMs - snapshot.accumulatedActiveRuntimeMs;
    if (remaining <= 0) return LONG_SESSION_MS;
    return Math.min(LONG_SESSION_MS, remaining);
  }

  private assertCleanSource(sourceVersion: SourceVersion): void {
    if (sourceVersion.dirty) throw new Error("PAPER_VALIDATION_REQUIRES_CLEAN_SOURCE");
    if (!sourceVersion.commit.trim() || sourceVersion.commit === "UNCOMMITTED") {
      throw new Error("PAPER_VALIDATION_SOURCE_COMMIT_REQUIRED");
    }
  }

  private assertCurrentManifest(manifest: CoreCompatibilityManifest): void {
    const expected = {
      schemaVersion: VERSIONS.schemaVersion,
      signalVersion: VERSIONS.signalVersion,
      strategyVersion: VERSIONS.strategyVersion,
      riskVersion: VERSIONS.riskVersion,
      paperVersion: VERSIONS.paperVersion,
      rulesetHash: RULESET_HASH,
      configVersion: VERSIONS.configVersion,
    };
    for (const [key, expectedValue] of Object.entries(expected)) {
      const actualValue = manifest[key as keyof typeof expected];
      if (actualValue !== expectedValue) {
        throw new Error(`PAPER_VALIDATION_MANIFEST_VERSION_MISMATCH:${key}`);
      }
    }
    assertCoreCompatibility(computeCoreCompatibilityHash(manifest), manifest);
  }

  private freezeAndThrowIfIncompatible(
    campaignId: string,
    actualCoreHash: string,
    sourceVersion: SourceVersion,
    now: string,
  ): void {
    const campaign = this.store.campaign(campaignId);
    if (campaign.coreCompatibilityHash === actualCoreHash) return;
    this.store.transaction(() => {
      this.store.assertPaperSafetyState();
      const currentState = this.store.campaignState(campaignId);
      if (currentState !== "FROZEN") {
        const running = this.store.runningSession(campaignId);
        if (running) {
          this.store.insertTransition({
            entityType: "SESSION",
            campaignId,
            sessionId: running.sessionId,
            fromState: "RUNNING",
            toState: "BLOCKED",
            reason: "CORE_COMPATIBILITY_MISMATCH",
            evidence: { expected: campaign.coreCompatibilityHash, actual: actualCoreHash },
            coreCompatibilityHash: campaign.coreCompatibilityHash,
            sourceVersion,
            configVersion: campaign.coreManifest.configVersion,
            idempotencyKey: `SESSION:${running.sessionId}:CORE_MISMATCH:${actualCoreHash}`,
            now,
          });
        }
        this.store.insertTransition({
          entityType: "CAMPAIGN",
          campaignId,
          fromState: currentState,
          toState: "FROZEN",
          reason: "CORE_COMPATIBILITY_MISMATCH",
          evidence: { expected: campaign.coreCompatibilityHash, actual: actualCoreHash },
          coreCompatibilityHash: campaign.coreCompatibilityHash,
          sourceVersion,
          configVersion: campaign.coreManifest.configVersion,
          idempotencyKey: `CAMPAIGN:${campaignId}:CORE_MISMATCH:${actualCoreHash}`,
          now,
        });
      }
    });
    throw new Error(`PAPER_VALIDATION_CAMPAIGN_FROZEN:CORE_COMPATIBILITY_MISMATCH:${campaignId}`);
  }
}
