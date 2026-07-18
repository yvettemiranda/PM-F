import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RULESET } from "../domain/versioning.js";
import { prepareRuntimeDatabase } from "../infra/sqlite/runtime-database-preparation.js";
import { resolveSourceVersion, type SourceVersion } from "../infra/source-version.js";
import { buildSafeChildEnvironment } from "../operator/safe-child-environment.js";
import { PaperExecutor } from "../paper/paper-executor.js";
import { evaluatePaperShortGate } from "../paper/paper-gate-evaluator.js";
import { PublicPaperMarketDataProvider } from "../paper/public-market-data.js";
import {
  buildCurrentCompatibilityEvidence,
  buildCurrentCoreCompatibilityManifest,
  computeCoreCompatibilityHash,
} from "../paper-validation/core-compatibility.js";
import {
  checkPaperCampaignClockSafety,
  type PaperCampaignClockSafetyEvidence,
} from "../paper-validation/clock-safety.js";
import {
  assertPaperChildReadyBinding,
  buildFinalizationOutcome,
  buildObserveChildSpec,
  buildPaperChildSpec,
  campaignCheckpointEvidenceInput,
  classifyCampaignChildExit,
  deriveCampaignStopPlan,
  qualificationMilestoneReached,
  type CampaignRuntimeBinding,
} from "../paper-validation/campaign-session-runtime.js";
import {
  deriveSessionCoverage,
  sessionAcceptanceStatus,
  verifyIsolatedVerificationEvidence,
  type IsolatedVerificationEvidence,
  type ObserveCampaignReport,
  type PaperCampaignReport,
} from "../paper-validation/operator-evidence.js";
import { collectCheckpointEvidence } from "../paper-validation/checkpoint-evidence.js";
import { validateFinalCampaignIntegrity } from "../paper-validation/final-integrity.js";
import {
  paperCampaignReplacementReason,
  paperCampaignPlannedDurationOverride,
  paperCampaignStartDisposition,
  paperQualifyingFinalizationPolicy,
} from "../paper-validation/operator-policy.js";
import { prepareInterruptedRuntimeRecovery } from "../paper-validation/runtime-recovery.js";
import {
  assertReplayValidationEvidenceArtifactAgainstDatabase,
  type ReplayValidationEvidenceArtifact,
} from "../paper-validation/replay-evidence.js";
import { PaperValidationCampaignService } from "../paper-validation/service.js";
import {
  assertPaperCampaignPreMigrationCompatible,
  freezePaperCampaignPreMigrationMismatch,
} from "../paper-validation/preflight.js";
import type {
  CampaignSnapshot,
  CoreCompatibilityManifest,
  FinalizeSessionResult,
  ObserveOperationalMetrics,
  ScenarioEvidence,
  SessionCoverage,
  ValidationSessionDefinition,
} from "../paper-validation/types.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const databasePath = resolve(projectRoot, "data/phase0/phase0.sqlite");
const isolatedEvidencePath = resolve(projectRoot, "data/operator/paper-campaign-isolated-verification.json");
const replayEvidenceDirectory = resolve(projectRoot, "data/operator/paper-campaign-replay-evidence");
const latestPointerPath = resolve(projectRoot, "data/operator/paper-campaign-latest.json");
const targetWallet = "0x0c0e270cf879583d6a0142fc817e05b768d0434e";
const operatorOwnerToken = process.argv
  .find((argument) => argument.startsWith("--operator-owner-token="))
  ?.slice("--operator-owner-token=".length) ?? null;
if (operatorOwnerToken !== null && !/^[A-Za-z0-9._-]+$/.test(operatorOwnerToken)) {
  throw new Error("PAPER_CAMPAIGN_OPERATOR_OWNER_TOKEN_INVALID");
}
const CHILD_STOP_TIMEOUT_MS = 90_000;
const READY_TIMEOUT_MS = 30_000;

interface ChildExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  forced: boolean;
}

interface ManagedChild {
  child: ChildProcess;
  exited: Promise<ChildExit>;
  result: ChildExit | null;
}

interface PaperReady {
  status: string;
  mode: string;
  accountId: string;
  accountSource: string;
  targetId: string | null;
  targetWallet: string | null;
  campaignId: string | null;
  sessionId: string | null;
  marketClockOffsetMs: number;
}

interface SessionOutputPaths {
  sessionDirectory: string;
  paperReportFile: string;
  observeReportFile: string;
  sessionReportFile: string;
  campaignReportFile: string;
  runResultFile: string;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function loadReplayEvidence(
  coreCompatibilityHash: string,
): Promise<ReplayValidationEvidenceArtifact[]> {
  if (!existsSync(replayEvidenceDirectory)) return [];
  const artifacts: ReplayValidationEvidenceArtifact[] = [];
  const seen = new Set<string>();
  for (const name of (await readdir(replayEvidenceDirectory)).filter((item) => item.endsWith(".json")).sort()) {
    const artifact = await readJson<ReplayValidationEvidenceArtifact>(join(replayEvidenceDirectory, name));
    assertReplayValidationEvidenceArtifactAgainstDatabase(
      artifact,
      databasePath,
      coreCompatibilityHash,
      artifact.sourceCodeCommit,
    );
    if (seen.has(artifact.artifactHash)) throw new Error(`PAPER_REPLAY_EVIDENCE_DUPLICATED:${artifact.artifactHash}`);
    seen.add(artifact.artifactHash);
    artifacts.push(artifact);
  }
  return artifacts;
}

function sessionOutputPaths(campaignId: string, sessionId: string): SessionOutputPaths {
  const sessionDirectory = resolve(
    projectRoot,
    "data/paper-validation/campaigns",
    campaignId,
    "sessions",
    sessionId,
  );
  return {
    sessionDirectory,
    paperReportFile: join(sessionDirectory, "paper-internal.json"),
    observeReportFile: join(sessionDirectory, "observe-internal.json"),
    sessionReportFile: join(sessionDirectory, "paper-session-report.json"),
    campaignReportFile: resolve(
      projectRoot,
      "data/paper-validation/campaigns",
      campaignId,
      "paper-campaign-report.json",
    ),
    runResultFile: join(sessionDirectory, "run-result.json"),
  };
}

function startChild(script: string, args: string[]): ManagedChild {
  const child = spawn(process.execPath, ["--import", "tsx", script, ...args], {
    cwd: projectRoot,
    env: buildSafeChildEnvironment(),
    stdio: "inherit",
  });
  const managed: ManagedChild = { child, result: null, exited: Promise.resolve({ code: null, signal: null, forced: false }) };
  managed.exited = new Promise<ChildExit>((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      const result = { code, signal, forced: false };
      managed.result = result;
      resolvePromise(result);
    });
  });
  return managed;
}

function childRunning(child: ManagedChild | null): boolean {
  return Boolean(child && child.result === null && child.child.pid);
}

async function stopChild(
  managed: ManagedChild | null,
  signal: NodeJS.Signals,
  timeoutMs = CHILD_STOP_TIMEOUT_MS,
): Promise<ChildExit | null> {
  if (!managed) return null;
  if (managed.result) return managed.result;
  managed.child.kill(signal);
  const result = await Promise.race([
    managed.exited,
    delay(timeoutMs).then(() => null),
  ]);
  if (result) return result;
  managed.child.kill("SIGKILL");
  const forced = await managed.exited;
  const final = { ...forced, forced: true };
  managed.result = final;
  return final;
}

async function waitForReady(path: string, paper: ManagedChild): Promise<PaperReady> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (paper.result) throw new Error(`PAPER_EXITED_BEFORE_READY:${paper.result.code ?? paper.result.signal}`);
    if (existsSync(path)) return await readJson<PaperReady>(path);
    await delay(100);
  }
  throw new Error("PAPER_READY_TIMEOUT");
}

function findTargetAndBaseline(): { targetId: string; baselineRunId: string } {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  database.exec("PRAGMA query_only=ON; PRAGMA foreign_keys=ON;");
  try {
    const target = database.prepare(
      `SELECT target_id FROM monitor_targets
       WHERE lower(wallet_address)=? AND identity_status='IDENTITY_CONFIRMED'`,
    ).get(targetWallet) as { target_id: string } | undefined;
    if (!target) throw new Error(`PAPER_CAMPAIGN_TARGET_NOT_CONFIRMED:${targetWallet}`);
    const baseline = database.prepare(
      `SELECT baseline_run_id FROM position_baseline_runs
       WHERE target_id=? AND status='READY'
       ORDER BY snapshot_time DESC,created_at DESC,baseline_run_id DESC LIMIT 1`,
    ).get(target.target_id) as { baseline_run_id: string } | undefined;
    if (!baseline) throw new Error(`PAPER_CAMPAIGN_BASELINE_NOT_READY:${target.target_id}`);
    return { targetId: target.target_id, baselineRunId: baseline.baseline_run_id };
  } finally {
    database.close();
  }
}

function campaignIds(): string[] {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  database.exec("PRAGMA query_only=ON;");
  try {
    return (database.prepare(
      "SELECT campaign_id FROM paper_validation_campaigns ORDER BY created_at,campaign_id",
    ).all() as Array<{ campaign_id: string }>).map((row) => row.campaign_id);
  } finally {
    database.close();
  }
}

function createCampaign(
  service: PaperValidationCampaignService,
  manifest: CoreCompatibilityManifest,
  sourceVersion: SourceVersion,
  superseded?: CampaignSnapshot,
): CampaignSnapshot {
  const { targetId, baselineRunId } = findTargetAndBaseline();
  const replacementReason = superseded === undefined
    ? undefined
    : paperCampaignReplacementReason(
      superseded,
      computeCoreCompatibilityHash(manifest),
    );
  if (superseded !== undefined && replacementReason === null) {
    throw new Error(`PAPER_CAMPAIGN_REPLACEMENT_REASON_UNAVAILABLE:${superseded.campaignId}`);
  }
  const executor = new PaperExecutor(databasePath, new PublicPaperMarketDataProvider(), { sourceVersion });
  try {
    const accountId = executor.createAccount(
      "Paper 累计验证固定账户",
      BigInt(RULESET.paperInitialBalanceMicros),
      targetId,
    );
    return service.createCampaign({
      targetId,
      baselineRunId,
      paperAccountId: accountId,
      coreManifest: manifest,
      sourceVersion,
      now: new Date().toISOString(),
      ...(superseded === undefined ? {} : {
        supersedesCampaignId: superseded.campaignId,
        replacementReason: replacementReason!,
      }),
    });
  } finally {
    executor.close();
  }
}

function recoveryCoverage(isolated: IsolatedVerificationEvidence): SessionCoverage {
  const controlled = (scenario: "CRASH_RECOVERY" | "RESTART_RECOVERY" | "RECONCILIATION"): ScenarioEvidence => ({
    covered: true,
    source: "ISOLATED_CONTROLLED",
    evidenceId: isolated.artifactHash,
    reason: `ISOLATED_${scenario}`,
  });
  return {
    ...(isolated.coverage.includes("CRASH_RECOVERY") ? { CRASH_RECOVERY: controlled("CRASH_RECOVERY") } : {}),
    ...(isolated.coverage.includes("RESTART_RECOVERY") ? { RESTART_RECOVERY: controlled("RESTART_RECOVERY") } : {}),
    ...(isolated.coverage.includes("RECONCILIATION")
      ? { RECONCILIATION: controlled("RECONCILIATION") }
      : {}),
  };
}

function observeOperationalMetrics(report: ObserveCampaignReport): ObserveOperationalMetrics {
  return {
    successfulPolls: report.metrics.successfulPolls,
    failedPolls: report.metrics.failedPolls,
    processedEvents: report.metrics.processedEvents,
    emittedSignals: report.metrics.emittedSignals,
    duplicateEvents: report.metrics.duplicateEvents,
    gapEvents: report.metrics.gapEvents,
    reconciliationCount: report.metrics.reconciliationCount,
    minorDiffCount: report.metrics.minorDiffCount,
    majorDesyncCount: report.metrics.majorDesyncCount,
    schedulingGapCount: report.metrics.schedulingGapCount,
    recoveredApiFailureSessions: report.metrics.failedPolls > 0 && !report.metrics.unrecoveredConnectionGap ? 1 : 0,
    checkpointRecoveredSessions: report.metrics.checkpointRecovered ? 1 : 0,
    unrecoveredConnectionGapSessions: report.metrics.unrecoveredConnectionGap ? 1 : 0,
  };
}

function summarizeIsolatedEvidence(isolated: IsolatedVerificationEvidence) {
  return {
    verificationStatus: isolated.status,
    phase0ReplayStatus: isolated.proofs.phase0ReplayStatus,
    acceptedIncompleteReasons: isolated.proofs.acceptedIncompleteReasons,
    artifactHash: isolated.artifactHash,
    sourceCodeCommit: isolated.sourceCodeCommit,
    coreCompatibilityHash: isolated.coreCompatibilityHash,
  };
}

async function recoverInterrupted(
  service: PaperValidationCampaignService,
  snapshot: CampaignSnapshot,
  manifest: CoreCompatibilityManifest,
  sourceVersion: SourceVersion,
  isolated: IsolatedVerificationEvidence,
): Promise<FinalizeSessionResult | null> {
  const running = service.store.runningSession(snapshot.campaignId);
  if (!running) return null;
  const checkpoints = service.store.checkpoints(running.sessionId);
  const recoveryObservedAt = new Date().toISOString();
  const prepared = await prepareInterruptedRuntimeRecovery({
    databasePath,
    snapshot,
    session: running,
    checkpoints,
    sourceVersion,
    observedAt: recoveryObservedAt,
  });
  const { acceptance, integrity, decision, continuity, cleanup, checkpointEvidence } = prepared;
  const coverage = recoveryCoverage(isolated);
  const finalized = service.recoverInterruptedSession({
    campaignId: snapshot.campaignId,
    coreManifest: manifest,
    sourceVersion,
    observedAt: recoveryObservedAt,
    recoveryConfirmed: decision.confirmed,
    consistencyPassed: integrity.passed && acceptance.consistency.passed && checkpointEvidence.consistencySafe,
    blockers: decision.blockers,
    coverage,
    checkpointEvidence,
  });
  if (!finalized) return null;

  const existingRecoveryCheckpoint = checkpoints.at(-1)?.checkpointKind === "CRASH_RECOVERY"
    ? checkpoints.at(-1)!
    : null;
  const frozenDetail = existingRecoveryCheckpoint?.evidence.detail ?? null;
  const frozenDecision = frozenDetail?.recoveryDecision;
  const reportDecision = frozenDecision && typeof frozenDecision === "object" && !Array.isArray(frozenDecision)
    ? {
      ...(frozenDecision as Record<string, unknown>),
      confirmed: finalized.session.recoveryConfirmed,
      blockers: finalized.session.blockers,
    }
    : {
      ...decision,
      confirmed: finalized.session.recoveryConfirmed,
      blockers: finalized.session.blockers,
    };
  const reportContinuity = frozenDetail?.databaseContinuity ?? continuity;
  const reportCleanup = frozenDetail?.cleanup ?? cleanup;
  const reportCheckpointEvidence = existingRecoveryCheckpoint?.evidence ?? checkpointEvidence;

  const paths = sessionOutputPaths(snapshot.campaignId, running.sessionId);
  await mkdir(paths.sessionDirectory, { recursive: true });
  await writeJsonAtomically(paths.sessionReportFile, {
    reportId: finalized.session.reportId,
    campaignId: snapshot.campaignId,
    sessionId: running.sessionId,
    sourceCodeCommit: sourceVersion.commit,
    coreCompatibilityHash: computeCoreCompatibilityHash(manifest),
    recovery: true,
    session: finalized.session,
    shortGate: null,
    paper: null,
    observe: null,
    paperAcceptance: acceptance,
    integrity,
    recoveryDecision: reportDecision,
    databaseContinuity: reportContinuity,
    recoveryCleanup: reportCleanup,
    coverage,
    isolatedEvidence: summarizeIsolatedEvidence(isolated),
    checkpointEvidence: reportCheckpointEvidence,
    safety: {
      executionMode: "PAPER",
      liveGateState: "LIVE_DISABLED",
      liveAllowed: false,
      privateKeyLoaded: false,
      authenticatedTradingClientPresent: false,
      realOrdersCreated: 0,
      chainWrites: 0,
    },
  });
  await writeJsonAtomically(paths.campaignReportFile, {
    reportId: finalized.campaign.reportId,
    campaignId: snapshot.campaignId,
    sourceCodeCommit: sourceVersion.commit,
    coreCompatibilityHash: computeCoreCompatibilityHash(manifest),
    campaign: finalized.campaign,
    latestSessionReportId: finalized.session.reportId,
    currentFunnel: acceptance.funnel,
    cumulativeOperationalMetrics: finalized.campaign.operationalMetrics,
    latestIntegrity: integrity,
    latestPaperAcceptance: acceptance,
    isolatedEvidence: summarizeIsolatedEvidence(isolated),
    safety: { executionMode: "PAPER", liveGateState: "LIVE_DISABLED", liveAllowed: false },
  });
  const stoppedAt = finalized.session.stoppedAt;
  await writeJsonAtomically(paths.runResultFile, {
    status: finalized.campaign.campaignState,
    recovery: true,
    campaignId: snapshot.campaignId,
    sessionId: running.sessionId,
    sessionReportId: finalized.session.reportId,
    campaignReportId: finalized.campaign.reportId,
    sessionReportFile: paths.sessionReportFile,
    campaignReportFile: paths.campaignReportFile,
    paperReportFile: null,
    observeReportFile: null,
    stoppedAt,
    safety: { executionMode: "PAPER", liveGateState: "LIVE_DISABLED", liveAllowed: false },
  });
  await writeJsonAtomically(latestPointerPath, {
    campaignId: snapshot.campaignId,
    sessionId: running.sessionId,
    reportId: finalized.campaign.reportId,
    state: finalized.campaign.campaignState,
    recovery: true,
    supervisorPid: process.pid,
    operatorOwnerToken,
    ...paths,
    updatedAt: stoppedAt,
  });
  console.log(JSON.stringify({
    event: finalized.session.recoveryConfirmed
      ? "PAPER_CAMPAIGN_INTERRUPTED_SESSION_RECOVERED"
      : "PAPER_CAMPAIGN_INTERRUPTED_SESSION_BLOCKED",
    campaignId: snapshot.campaignId,
    sessionId: running.sessionId,
    sessionReportFile: paths.sessionReportFile,
    campaignReportFile: paths.campaignReportFile,
    campaignState: finalized.campaign.campaignState,
  }));
  return finalized;
}

function hardBlockers(input: {
  paper: PaperCampaignReport;
  observe: ObserveCampaignReport;
  integrity: ReturnType<typeof validateFinalCampaignIntegrity>;
  campaignId: string;
  sessionId: string;
  baselineRunId: string;
  sourceVersion: SourceVersion;
  marketClockOffsetMs: number;
}): string[] {
  const { paper, observe, integrity } = input;
  return [...new Set([
    ...integrity.blockers,
    ...(paper.mode === "PAPER" ? [] : ["PAPER_REPORT_MODE_INVALID"]),
    ...(paper.status === "COMPLETED" ? [] : [`PAPER_STATUS:${paper.status}`]),
    ...(paper.shutdownMode === "FINAL_VALUATION" ? [] : [`PAPER_SHUTDOWN:${paper.shutdownMode}`]),
    ...(paper.sourceCodeCommit === input.sourceVersion.commit && !paper.sourceCodeDirty ? [] : ["PAPER_SOURCE_VERSION_MISMATCH"]),
    ...(paper.campaignId === input.campaignId && paper.sessionId === input.sessionId ? [] : ["PAPER_SESSION_BINDING_MISMATCH"]),
    ...(paper.marketClockOffsetMs === input.marketClockOffsetMs ? [] : ["PAPER_CLOCK_CALIBRATION_MISMATCH"]),
    ...(paper.report.errorCount === 0 ? [] : [`PAPER_RUNNER_ERRORS:${paper.report.errorCount}`]),
    ...(paper.report.account.valuationStatus === "COMPLETE" && paper.report.account.unpricedPositionCount === 0
      ? [] : ["PAPER_FINAL_VALUATION_INCOMPLETE"]),
    ...(paper.report.acceptance.consistency.passed ? [] : ["PAPER_ACCEPTANCE_INCONSISTENT"]),
    ...(paper.report.acceptance.consistency.reservations.activeReservationsMicros === "0"
      ? [] : ["ACTIVE_RESERVATION_REMAINS"]),
    ...(paper.report.acceptance.marketData.blockerCount === 0 ? [] : ["UNRECOVERED_MARKET_DATA_BLOCKER"]),
    ...(paper.report.acceptance.funnel.signals.unconsumedEligible === 0 ? [] : ["ELIGIBLE_SIGNAL_UNCONSUMED"]),
    ...(paper.safety.privateKeyLoaded ? ["PRIVATE_KEY_LOADED"] : []),
    ...(paper.safety.authenticatedTradingClientPresent ? ["AUTHENTICATED_TRADING_CLIENT_PRESENT"] : []),
    ...(paper.safety.realOrdersCreated === 0 ? [] : ["REAL_ORDER_CREATED"]),
    ...(paper.safety.chainWrites === 0 ? [] : ["CHAIN_WRITE_DETECTED"]),
    ...(paper.safety.liveExecutorPresent ? ["LIVE_EXECUTOR_PRESENT"] : []),
    ...(observe.mode === "OBSERVE_ONLY" ? [] : ["OBSERVE_REPORT_MODE_INVALID"]),
    ...(observe.sourceCodeCommit === input.sourceVersion.commit && !observe.sourceCodeDirty ? [] : ["OBSERVE_SOURCE_VERSION_MISMATCH"]),
    ...(observe.campaignId === input.campaignId && observe.sessionId === input.sessionId ? [] : ["OBSERVE_SESSION_BINDING_MISMATCH"]),
    ...(observe.baselineRunId === input.baselineRunId && observe.metrics.baselineRunId === input.baselineRunId
      ? [] : ["OBSERVE_BASELINE_BINDING_MISMATCH"]),
    ...(observe.acceptance.observeStatus === "SHORT_SOAK_PASSED" ? [] : [`OBSERVE_STATUS:${observe.acceptance.observeStatus}`]),
    ...(observe.metrics.successfulPolls > 0 ? [] : ["OBSERVE_NO_SUCCESSFUL_POLL"]),
    ...(observe.metrics.majorDesyncCount === 0 ? [] : [`MAJOR_DESYNC:${observe.metrics.majorDesyncCount}`]),
    ...(observe.metrics.finalSyncStatus === "SYNCED" ? [] : [`FINAL_SYNC:${observe.metrics.finalSyncStatus ?? "NONE"}`]),
    ...(observe.metrics.unrecoveredConnectionGap ? ["UNRECOVERED_CONNECTION_GAP"] : []),
    ...(observe.metrics.checkpointProjectionHashMismatch ? ["CHECKPOINT_PROJECTION_HASH_MISMATCH"] : []),
    ...(observe.safety.privateKeyLoaded ? ["OBSERVE_PRIVATE_KEY_LOADED"] : []),
    ...(observe.safety.ordersCreated === 0 ? [] : ["OBSERVE_ORDER_CREATED"]),
  ])].sort();
}

async function main(): Promise<void> {
  const sourceVersion = resolveSourceVersion(projectRoot);
  if (sourceVersion.dirty) throw new Error("PAPER_CAMPAIGN_REQUIRES_CLEAN_SOURCE");
  const manifest = buildCurrentCoreCompatibilityManifest(projectRoot);
  const coreCompatibilityHash = computeCoreCompatibilityHash(manifest);
  const compatibilityEvidence = buildCurrentCompatibilityEvidence(projectRoot);
  const clockCalibration: PaperCampaignClockSafetyEvidence = await checkPaperCampaignClockSafety();
  if (clockCalibration.status !== "PASSED" || clockCalibration.offsetMs === null) {
    throw new Error(
      `PAPER_CAMPAIGN_CLOCK_SAFETY_BLOCKED:${clockCalibration.reason ?? "UNKNOWN"}`,
    );
  }
  const marketClockOffsetMs = clockCalibration.offsetMs;
  console.log(JSON.stringify({
    event: "PAPER_CAMPAIGN_CLOCK_CALIBRATED",
    clockCalibration,
    safety: { executionMode: "PAPER", liveGateState: "LIVE_DISABLED", liveAllowed: false },
  }));
  try {
    assertPaperCampaignPreMigrationCompatible({ databasePath, manifest });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.startsWith("ACTIVE_CAMPAIGN_CORE_MISMATCH_BEFORE_MIGRATION:")) throw error;
    const frozen = freezePaperCampaignPreMigrationMismatch({
      databasePath,
      manifest,
      sourceVersion,
      now: new Date().toISOString(),
    });
    throw new Error(`PAPER_CAMPAIGN_FROZEN_BEFORE_MIGRATION:${frozen.campaignId ?? "UNKNOWN"}`);
  }
  await prepareRuntimeDatabase({ databasePath, sourceVersion });
  const isolated = await readJson<IsolatedVerificationEvidence>(isolatedEvidencePath);
  if (!verifyIsolatedVerificationEvidence(isolated, coreCompatibilityHash)) {
    throw new Error("PAPER_CAMPAIGN_ISOLATED_EVIDENCE_INVALID_OR_CORE_MISMATCH");
  }
  const replayEvidence = await loadReplayEvidence(coreCompatibilityHash);

  const service = new PaperValidationCampaignService(databasePath);
  let paper: ManagedChild | null = null;
  let observe: ManagedChild | null = null;
  let session: ValidationSessionDefinition | null = null;
  let stopRequested = false;
  let stopReason = "AUTO_STOP";
  let autoStopped = false;
  let unexpectedChildExit = false;
  const requestStop = (reason: string): void => {
    if (stopRequested) return;
    stopRequested = true;
    stopReason = reason;
  };
  process.once("SIGINT", () => requestStop("USER_SAFE_PAUSE_SIGINT"));
  process.once("SIGTERM", () => requestStop("USER_SAFE_PAUSE_SIGTERM"));
  process.once("SIGHUP", () => requestStop("USER_SAFE_PAUSE_SIGHUP"));

  try {
    const ids = campaignIds();
    let snapshot = ids.length === 0
      ? createCampaign(service, manifest, sourceVersion)
      : service.campaignSnapshot(ids.at(-1)!);
    const startDisposition = paperCampaignStartDisposition(snapshot, coreCompatibilityHash);
    if (startDisposition === "CREATE_REPLACEMENT") {
      const previous = snapshot;
      snapshot = createCampaign(service, manifest, sourceVersion, previous);
      console.log(JSON.stringify({
        event: "PAPER_CAMPAIGN_REPLACED_AFTER_CORE_CHANGE",
        previousCampaignId: previous.campaignId,
        previousCampaignState: previous.state,
        replacementCampaignId: snapshot.campaignId,
      }));
    } else if (startDisposition === "REFUSE_TERMINAL") {
      throw new Error(`PAPER_CAMPAIGN_NOT_STARTABLE:${snapshot.state}:${snapshot.campaignId}`);
    }
    await recoverInterrupted(service, snapshot, manifest, sourceVersion, isolated);
    snapshot = service.campaignSnapshot(snapshot.campaignId);
    if (!snapshot.canContinue) throw new Error(`PAPER_CAMPAIGN_CANNOT_CONTINUE:${snapshot.state}`);
    const plannedDurationMs = paperCampaignPlannedDurationOverride(snapshot);
    session = service.startSession({
      campaignId: snapshot.campaignId,
      coreManifest: manifest,
      sourceVersion,
      now: new Date().toISOString(),
      ...(plannedDurationMs === undefined ? {} : { plannedDurationMs }),
    });
    const paths = sessionOutputPaths(snapshot.campaignId, session.sessionId);
    const {
      sessionDirectory,
      paperReportFile,
      observeReportFile,
      sessionReportFile,
      campaignReportFile,
      runResultFile,
    } = paths;
    await mkdir(sessionDirectory, { recursive: true });
    const readyFile = join(sessionDirectory, "paper-ready.json");
    const accountFile = join(sessionDirectory, "paper-account-id.txt");
    const runtimeBinding: CampaignRuntimeBinding = {
      campaignId: snapshot.campaignId,
      sessionId: session.sessionId,
      paperAccountId: snapshot.paperAccountId,
      targetId: snapshot.targetId,
      targetWallet,
      baselineRunId: snapshot.baselineRunId,
      marketClockOffsetMs,
    };
    await writeJsonAtomically(latestPointerPath, {
      campaignId: snapshot.campaignId,
      sessionId: session.sessionId,
      state: "STARTING",
      sessionDirectory,
      sessionReportFile,
      campaignReportFile,
      runResultFile,
      supervisorPid: process.pid,
      operatorOwnerToken,
      marketClockOffsetMs,
      updatedAt: new Date().toISOString(),
    });

    service.recordCheckpoint({
      sessionId: session.sessionId,
      checkpointKind: "START",
      observedAt: new Date().toISOString(),
      idempotencyKey: `SESSION:${session.sessionId}:CHECKPOINT:START`,
      evidence: collectCheckpointEvidence(campaignCheckpointEvidenceInput({
        databasePath,
        binding: runtimeBinding,
        observeActive: false,
        paperActive: false,
        detail: { stage: "STARTING", clockCalibration },
      })),
    });

    const paperSpec = buildPaperChildSpec({
      projectRoot,
      binding: runtimeBinding,
      accountFile,
      readyFile,
      resultFile: paperReportFile,
    });
    paper = startChild(paperSpec.script, paperSpec.args);
    await writeJsonAtomically(latestPointerPath, {
      campaignId: snapshot.campaignId,
      sessionId: session.sessionId,
      state: "STARTING",
      supervisorPid: process.pid,
      operatorOwnerToken,
      marketClockOffsetMs,
      paperPid: paper.child.pid,
      sessionDirectory,
      sessionReportFile,
      campaignReportFile,
      runResultFile,
      updatedAt: new Date().toISOString(),
    });
    const ready = await waitForReady(readyFile, paper);
    assertPaperChildReadyBinding(ready, runtimeBinding);
    const observeSpec = buildObserveChildSpec({
      projectRoot,
      binding: runtimeBinding,
      resultFile: observeReportFile,
      minimumSoakSeconds: session.sessionKind === "QUALIFYING"
        ? Math.ceil(snapshot.qualifyingRuntimeMs / 1_000)
        : 1,
    });
    observe = startChild(observeSpec.script, observeSpec.args);
    await delay(1_000);
    if (!childRunning(observe)) throw new Error("OBSERVE_EXITED_DURING_STARTUP");

    const activeStartedAt = Date.now();
    let checkpointSequence = 1;
    service.recordCheckpoint({
      sessionId: session.sessionId,
      checkpointKind: "HEARTBEAT",
      observedAt: new Date(activeStartedAt).toISOString(),
      idempotencyKey: `SESSION:${session.sessionId}:CHECKPOINT:ACTIVE_START`,
      evidence: collectCheckpointEvidence(campaignCheckpointEvidenceInput({
        databasePath,
        binding: runtimeBinding,
        observeActive: true,
        paperActive: true,
        detail: { stage: "ACTIVE", checkpointSequence: 0 },
      })),
    });
    let nextCheckpointAt = activeStartedAt + snapshot.checkpointIntervalMs;
    let qualificationMilestoneRecorded = session.sessionKind !== "QUALIFYING";
    const deadline = activeStartedAt + session.plannedDurationMs;
    await writeJsonAtomically(latestPointerPath, {
      campaignId: snapshot.campaignId,
      sessionId: session.sessionId,
      state: "RUNNING",
      sessionKind: session.sessionKind,
      plannedDurationMs: session.plannedDurationMs,
      activeStartedAt: new Date(activeStartedAt).toISOString(),
      plannedStopAt: new Date(deadline).toISOString(),
      paperPid: paper.child.pid,
      observePid: observe.child.pid,
      supervisorPid: process.pid,
      operatorOwnerToken,
      marketClockOffsetMs,
      sessionDirectory,
      sessionReportFile,
      campaignReportFile,
      runResultFile,
      updatedAt: new Date().toISOString(),
    });

    while (!stopRequested) {
      if (!childRunning(paper) || !childRunning(observe)) {
        unexpectedChildExit = true;
        requestStop("UNEXPECTED_CHILD_EXIT");
        break;
      }
      const now = Date.now();
      if (now >= deadline) {
        autoStopped = true;
        requestStop("PLANNED_SESSION_DURATION_REACHED");
        break;
      }
      if (now >= nextCheckpointAt) {
        const milestoneReached = qualificationMilestoneReached({
          alreadyRecorded: qualificationMilestoneRecorded,
          sessionKind: session.sessionKind,
          nowMs: now,
          activeStartedAtMs: activeStartedAt,
          qualifyingRuntimeMs: snapshot.qualifyingRuntimeMs,
        });
        const checkpointEvidence = collectCheckpointEvidence(campaignCheckpointEvidenceInput({
          databasePath,
          binding: runtimeBinding,
          observeActive: true,
          paperActive: true,
          detail: {
            stage: milestoneReached ? "QUALIFICATION_RUNTIME_REACHED" : "ACTIVE",
            checkpointSequence,
            qualificationMilestoneReached: milestoneReached,
          },
        }));
        service.recordCheckpoint({
          sessionId: session.sessionId,
          checkpointKind: "HEARTBEAT",
          observedAt: new Date(now).toISOString(),
          idempotencyKey: `SESSION:${session.sessionId}:CHECKPOINT:HEARTBEAT:${checkpointSequence}`,
          evidence: checkpointEvidence,
        });
        if (milestoneReached) qualificationMilestoneRecorded = true;
        if (!checkpointEvidence.consistencySafe) {
          requestStop("RUNTIME_CONSISTENCY_UNSAFE");
        }
        checkpointSequence += 1;
        nextCheckpointAt += snapshot.checkpointIntervalMs;
      }
      await delay(Math.min(1_000, Math.max(25, Math.min(nextCheckpointAt, deadline) - now)));
    }

    const preStopAt = new Date().toISOString();
    if (childRunning(paper) && childRunning(observe)) {
      service.recordCheckpoint({
        sessionId: session.sessionId,
        checkpointKind: "HEARTBEAT",
        observedAt: preStopAt,
        idempotencyKey: `SESSION:${session.sessionId}:CHECKPOINT:PRE_STOP`,
        evidence: collectCheckpointEvidence(campaignCheckpointEvidenceInput({
          databasePath,
          binding: runtimeBinding,
          observeActive: true,
          paperActive: true,
          detail: { stage: "PRE_STOP", stopReason },
        })),
      });
    }

    let observeExit = observe?.result ?? null;
    let paperExit = paper?.result ?? null;
    for (const step of deriveCampaignStopPlan({
      observeRunning: childRunning(observe),
      paperRunning: childRunning(paper),
      finalValuation: true,
    })) {
      if (step.role === "OBSERVE") observeExit = await stopChild(observe, step.signal);
      else paperExit = await stopChild(paper, step.signal);
    }
    const processBlockers = [
      ...classifyCampaignChildExit("OBSERVE", observeExit),
      ...classifyCampaignChildExit("PAPER", paperExit),
      ...(unexpectedChildExit ? ["UNEXPECTED_CHILD_EXIT"] : []),
    ];

    let paperReport: PaperCampaignReport | null = null;
    let observeReport: ObserveCampaignReport | null = null;
    try {
      paperReport = await readJson<PaperCampaignReport>(paperReportFile);
    } catch {
      processBlockers.push("PAPER_REPORT_MISSING_OR_INVALID");
    }
    try {
      observeReport = await readJson<ObserveCampaignReport>(observeReportFile);
    } catch {
      processBlockers.push("OBSERVE_REPORT_MISSING_OR_INVALID");
    }

    let finalized: FinalizeSessionResult;
    let coverage: SessionCoverage = {};
    let gate: ReturnType<typeof evaluatePaperShortGate> | null = null;
    let integrity: ReturnType<typeof validateFinalCampaignIntegrity> | null = null;
    const stoppedAt = new Date().toISOString();
    if (paperReport && observeReport) {
      integrity = validateFinalCampaignIntegrity({
        databasePath,
        scope: {
          campaignId: snapshot.campaignId,
          sessionId: session.sessionId,
          accountId: snapshot.paperAccountId,
          targetId: snapshot.targetId,
          baselineRunId: snapshot.baselineRunId,
          coreHash: snapshot.coreCompatibilityHash,
        },
        acceptance: paperReport.report.acceptance,
      });
      const blockers = [
        ...processBlockers,
        ...hardBlockers({
          paper: paperReport,
          observe: observeReport,
          integrity,
          campaignId: snapshot.campaignId,
          sessionId: session.sessionId,
          baselineRunId: snapshot.baselineRunId,
          sourceVersion,
          marketClockOffsetMs,
        }),
      ];
      coverage = deriveSessionCoverage({
        sessionId: session.sessionId,
        sequence: session.sequence,
        paper: paperReport,
        observe: observeReport,
        replayEvidence,
        isolated,
      });
      if (session.sessionKind === "QUALIFYING") {
        gate = evaluatePaperShortGate({
          durationMs: Math.max(0, Date.parse(preStopAt) - activeStartedAt),
          minimumDurationMs: snapshot.qualifyingRuntimeMs,
          finalValuationComplete: paperReport.status === "COMPLETED"
            && paperReport.shutdownMode === "FINAL_VALUATION"
            && paperReport.report.account.valuationStatus === "COMPLETE"
            && paperReport.report.account.unpricedPositionCount === 0,
          runnerErrorCount: paperReport.report.errorCount,
          versionsMatch: paperReport.sourceCodeCommit === sourceVersion.commit
            && observeReport.sourceCodeCommit === sourceVersion.commit
            && !paperReport.sourceCodeDirty
            && !observeReport.sourceCodeDirty,
          safety: {
            executionMode: integrity.executionMode,
            liveGateState: integrity.liveGateState,
            privateKeyLoaded: paperReport.safety.privateKeyLoaded,
            authenticatedTradingClientPresent: paperReport.safety.authenticatedTradingClientPresent,
            realOrdersCreated: paperReport.safety.realOrdersCreated,
            chainWrites: paperReport.safety.chainWrites,
          },
          acceptance: paperReport.report.acceptance,
          hardFailures: blockers,
          supplementalEvidence: [
            {
              source: "ISOLATED_CONTROLLED",
              status: isolated.status,
              artifactHash: isolated.artifactHash,
              versionsMatch: isolated.coreCompatibilityHash === coreCompatibilityHash,
            },
            ...replayEvidence
              .filter((artifact) => artifact.source === "REAL_EXECUTION_REPLAY" && artifact.coverage.includes("FILL"))
              .map((artifact) => ({
                source: "REAL_EXECUTION_REPLAY" as const,
                status: "PASSED" as const,
                artifactHash: artifact.artifactHash,
                versionsMatch: true,
              })),
          ],
        });
      }
      const qualifyingPolicy = session.sessionKind === "QUALIFYING"
        ? paperQualifyingFinalizationPolicy({
          stopReason,
          gateBlockers: gate?.blockingReasons ?? blockers,
        })
        : { blockers, qualificationDeferred: false };
      const finalizationBlockers = qualifyingPolicy.blockers;
      const acceptanceStatus = qualifyingPolicy.qualificationDeferred && finalizationBlockers.length === 0
        ? "INCOMPLETE_COVERAGE"
        : sessionAcceptanceStatus({
        qualifying: session.sessionKind === "QUALIFYING",
        hardBlockers: finalizationBlockers,
        naturalFullFill: paperReport.report.acceptance.funnel.stage.BUY === "FULL_FILL",
        supplementalEvidenceValid: verifyIsolatedVerificationEvidence(isolated, coreCompatibilityHash)
          || replayEvidence.some((artifact) => artifact.source === "REAL_EXECUTION_REPLAY" && artifact.coverage.includes("FILL")),
      });
      service.recordCheckpoint({
        sessionId: session.sessionId,
        checkpointKind: "SAFE_STOP",
        observedAt: stoppedAt,
        idempotencyKey: `SESSION:${session.sessionId}:CHECKPOINT:SAFE_STOP`,
        evidence: collectCheckpointEvidence(campaignCheckpointEvidenceInput({
          databasePath,
          binding: runtimeBinding,
          observeActive: false,
          paperActive: false,
          detail: {
            stage: "STOPPED",
            stopReason,
            blockers: finalizationBlockers,
            qualificationDeferred: qualifyingPolicy.qualificationDeferred,
          },
        })),
      });
      finalized = service.finalizeSession({
        sessionId: session.sessionId,
        outcome: buildFinalizationOutcome({
          processBlockerCount: processBlockers.length,
          finalizationBlockerCount: finalizationBlockers.length,
          autoStopped,
        }),
        acceptanceStatus,
        consistencyPassed: integrity.passed,
        recoveryConfirmed: true,
        stopReason,
        blockers: finalizationBlockers,
        coverage,
        observeMetrics: observeOperationalMetrics(observeReport),
        stoppedAt,
      });
    } else {
      service.recordCheckpoint({
        sessionId: session.sessionId,
        checkpointKind: "SAFE_STOP",
        observedAt: stoppedAt,
        idempotencyKey: `SESSION:${session.sessionId}:CHECKPOINT:SAFE_STOP`,
        evidence: collectCheckpointEvidence(campaignCheckpointEvidenceInput({
          databasePath,
          binding: runtimeBinding,
          observeActive: false,
          paperActive: false,
          detail: { stage: "FAILED", stopReason, blockers: processBlockers },
        })),
      });
      finalized = service.finalizeSession({
        sessionId: session.sessionId,
        outcome: "FAILED",
        acceptanceStatus: "FAILED",
        consistencyPassed: false,
        recoveryConfirmed: false,
        stopReason,
        blockers: processBlockers,
        coverage: {},
        stoppedAt,
      });
    }

    const sessionFilePayload = {
      reportId: finalized.session.reportId,
      campaignId: snapshot.campaignId,
      sessionId: session.sessionId,
      sourceCodeCommit: sourceVersion.commit,
      coreCompatibilityHash,
      compatibilityEvidence,
      clockCalibration,
      session: finalized.session,
      shortGate: gate,
      paper: paperReport,
      observe: observeReport,
      integrity,
      coverage,
      isolatedEvidence: summarizeIsolatedEvidence(isolated),
      replayEvidence: replayEvidence.map((artifact) => ({
        source: artifact.source,
        coverage: artifact.coverage,
        artifactHash: artifact.artifactHash,
      })),
      safety: {
        executionMode: "PAPER",
        liveGateState: "LIVE_DISABLED",
        liveAllowed: false,
        privateKeyLoaded: false,
        authenticatedTradingClientPresent: false,
        realOrdersCreated: 0,
        chainWrites: 0,
      },
    };
    const campaignFilePayload = {
      reportId: finalized.campaign.reportId,
      campaignId: snapshot.campaignId,
      sourceCodeCommit: sourceVersion.commit,
      coreCompatibilityHash,
      compatibilityEvidence,
      latestClockCalibration: clockCalibration,
      campaign: finalized.campaign,
      latestSessionReportId: finalized.session.reportId,
      currentFunnel: paperReport?.report.acceptance.funnel ?? null,
      cumulativeOperationalMetrics: finalized.campaign.operationalMetrics,
      latestIntegrity: integrity,
      latestPaperAcceptance: paperReport?.report.acceptance ?? null,
      isolatedEvidence: summarizeIsolatedEvidence(isolated),
      safety: {
        executionMode: "PAPER",
        liveGateState: "LIVE_DISABLED",
        liveAllowed: false,
      },
    };
    await writeJsonAtomically(sessionReportFile, sessionFilePayload);
    await writeJsonAtomically(campaignReportFile, campaignFilePayload);
    await writeJsonAtomically(runResultFile, {
      status: finalized.campaign.campaignState,
      campaignId: snapshot.campaignId,
      sessionId: session.sessionId,
      sessionReportId: finalized.session.reportId,
      campaignReportId: finalized.campaign.reportId,
      sessionReportFile,
      campaignReportFile,
      paperReportFile,
      observeReportFile,
      stoppedAt,
      compatibilityEvidence,
      clockCalibration,
      safety: { executionMode: "PAPER", liveGateState: "LIVE_DISABLED", liveAllowed: false },
    });
    await writeJsonAtomically(latestPointerPath, {
      campaignId: snapshot.campaignId,
      sessionId: session.sessionId,
      reportId: finalized.campaign.reportId,
      state: finalized.campaign.campaignState,
      sessionDirectory,
      sessionReportFile,
      campaignReportFile,
      runResultFile,
      supervisorPid: process.pid,
      operatorOwnerToken,
      marketClockOffsetMs,
      updatedAt: stoppedAt,
    });
    console.log(JSON.stringify({
      event: "PAPER_CAMPAIGN_SESSION_FINALIZED",
      ...finalized.campaign,
      sessionReportFile,
      campaignReportFile,
      executionMode: "PAPER",
      liveGateState: "LIVE_DISABLED",
      liveAllowed: false,
    }, null, 2));
    if (["BLOCKED", "FROZEN"].includes(finalized.campaign.campaignState)) process.exitCode = 1;
  } catch (error) {
    if (observe && childRunning(observe)) await stopChild(observe, "SIGTERM");
    if (paper && childRunning(paper)) await stopChild(paper, "SIGUSR1");
    if (session) {
      let previousPointer: Record<string, unknown> = {};
      try {
        if (existsSync(latestPointerPath)) previousPointer = await readJson<Record<string, unknown>>(latestPointerPath);
      } catch {
        // A malformed pointer is replaced, while process recovery still scans
        // command lines independently of persisted PIDs.
      }
      await writeJsonAtomically(latestPointerPath, {
        ...previousPointer,
        campaignId: session.campaignId,
        sessionId: session.sessionId,
        state: "RECOVERY_REQUIRED",
        supervisorPid: process.pid,
        operatorOwnerToken,
        error: error instanceof Error ? error.message : String(error),
        updatedAt: new Date().toISOString(),
      });
    }
    throw error;
  } finally {
    service.close();
  }
}

await main();
