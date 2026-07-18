import { resolve } from "node:path";

export interface CampaignRuntimeBinding {
  campaignId: string;
  sessionId: string;
  paperAccountId: string;
  targetId: string;
  targetWallet: string;
  baselineRunId: string;
  marketClockOffsetMs: number;
}

export interface CampaignChildSpec {
  script: string;
  args: string[];
}

export function buildPaperChildSpec(input: {
  projectRoot: string;
  binding: CampaignRuntimeBinding;
  accountFile: string;
  readyFile: string;
  resultFile: string;
}): CampaignChildSpec {
  return {
    script: resolve(input.projectRoot, "src/cli/paper-run.ts"),
    args: [
      "--duration-seconds=0",
      "--interval-seconds=1",
      `--account-id=${input.binding.paperAccountId}`,
      `--account-id-file=${input.accountFile}`,
      `--target-wallet=${input.binding.targetWallet}`,
      `--ready-file=${input.readyFile}`,
      `--result-file=${input.resultFile}`,
      `--campaign-id=${input.binding.campaignId}`,
      `--session-id=${input.binding.sessionId}`,
      `--market-clock-offset-ms=${input.binding.marketClockOffsetMs}`,
    ],
  };
}

export function buildObserveChildSpec(input: {
  projectRoot: string;
  binding: CampaignRuntimeBinding;
  resultFile: string;
  minimumSoakSeconds: number;
}): CampaignChildSpec {
  if (!Number.isSafeInteger(input.minimumSoakSeconds) || input.minimumSoakSeconds < 1) {
    throw new Error("OBSERVE_MINIMUM_SOAK_SECONDS_INVALID");
  }
  return {
    script: resolve(input.projectRoot, "src/cli/observe-only.ts"),
    args: [
      input.binding.targetWallet,
      "--duration-seconds=0",
      "--poll-seconds=15",
      `--minimum-soak-seconds=${input.minimumSoakSeconds}`,
      `--result-file=${input.resultFile}`,
      `--campaign-id=${input.binding.campaignId}`,
      `--session-id=${input.binding.sessionId}`,
      `--baseline-run-id=${input.binding.baselineRunId}`,
    ],
  };
}

export interface PaperChildReadyBinding {
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

export function assertPaperChildReadyBinding(
  ready: PaperChildReadyBinding,
  binding: CampaignRuntimeBinding,
): void {
  if (ready.status !== "READY"
    || ready.mode !== "PAPER"
    || ready.accountId !== binding.paperAccountId
    || ready.accountSource !== "EXPLICIT"
    || ready.targetId !== binding.targetId
    || ready.targetWallet !== binding.targetWallet
    || ready.campaignId !== binding.campaignId
    || ready.sessionId !== binding.sessionId
    || ready.marketClockOffsetMs !== binding.marketClockOffsetMs) {
    throw new Error("PAPER_CAMPAIGN_READY_EVIDENCE_INVALID");
  }
}

export interface CampaignChildExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  forced: boolean;
}

export type CampaignChildRole = "PAPER" | "OBSERVE";

export function classifyCampaignChildExit(
  role: CampaignChildRole,
  exit: CampaignChildExit | null,
): string[] {
  if (exit === null) return [];
  return [
    ...(exit.forced ? [`${role}_FORCED_STOP`] : []),
    ...(exit.code === 0 ? [] : [`${role}_EXIT_CODE:${exit.code ?? exit.signal}`]),
  ];
}

export function deriveCampaignStopPlan(input: {
  observeRunning: boolean;
  paperRunning: boolean;
  finalValuation: boolean;
}): Array<{ role: CampaignChildRole; signal: NodeJS.Signals }> {
  return [
    ...(input.observeRunning ? [{ role: "OBSERVE" as const, signal: "SIGTERM" as const }] : []),
    ...(input.paperRunning
      ? [{ role: "PAPER" as const, signal: input.finalValuation ? "SIGUSR1" as const : "SIGTERM" as const }]
      : []),
  ];
}

export function qualificationMilestoneReached(input: {
  alreadyRecorded: boolean;
  sessionKind: string;
  nowMs: number;
  activeStartedAtMs: number;
  qualifyingRuntimeMs: number;
}): boolean {
  return input.sessionKind === "QUALIFYING"
    && !input.alreadyRecorded
    && input.nowMs - input.activeStartedAtMs >= input.qualifyingRuntimeMs;
}

export function campaignCheckpointEvidenceInput(input: {
  databasePath: string;
  binding: CampaignRuntimeBinding;
  observeActive: boolean;
  paperActive: boolean;
  detail: Record<string, unknown>;
}) {
  return {
    databasePath: input.databasePath,
    targetId: input.binding.targetId,
    paperAccountId: input.binding.paperAccountId,
    scope: {
      campaignId: input.binding.campaignId,
      sessionId: input.binding.sessionId,
      baselineRunId: input.binding.baselineRunId,
    },
    observeActive: input.observeActive,
    paperActive: input.paperActive,
    detail: input.detail,
  };
}

export function buildFinalizationOutcome(input: {
  processBlockerCount: number;
  finalizationBlockerCount: number;
  autoStopped: boolean;
}): "FAILED" | "AUTO_STOP" | "SAFE_STOP" {
  if (input.processBlockerCount > 0 || input.finalizationBlockerCount > 0) return "FAILED";
  return input.autoStopped ? "AUTO_STOP" : "SAFE_STOP";
}
