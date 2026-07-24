import type {
  ObserveCampaignReport,
  PaperCampaignReport,
} from "./operator-evidence.js";

export interface PaperCampaignChildFailure {
  mode: "PAPER";
  status: "FAILED";
  failedAt: string;
  error: string;
}

export type ParsedPaperCampaignChildResult =
  | { kind: "REPORT"; report: PaperCampaignReport }
  | { kind: "FAILURE"; failure: PaperCampaignChildFailure }
  | { kind: "INVALID"; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPaperCampaignReport(value: unknown): value is PaperCampaignReport {
  if (!isRecord(value) || value.mode !== "PAPER") return false;
  if (typeof value.status !== "string" || typeof value.shutdownMode !== "string") return false;
  if (typeof value.sourceCodeCommit !== "string" || typeof value.sourceCodeDirty !== "boolean") return false;
  if (!isRecord(value.report) || !isRecord(value.report.account) || !isRecord(value.report.acceptance)) {
    return false;
  }
  return typeof value.report.startedAt === "string"
    && typeof value.report.stoppedAt === "string"
    && typeof value.report.errorCount === "number"
    && typeof value.report.account.valuationStatus === "string"
    && typeof value.report.account.unpricedPositionCount === "number"
    && isRecord(value.safety);
}

function isPaperCampaignChildFailure(value: unknown): value is PaperCampaignChildFailure {
  return isRecord(value)
    && value.mode === "PAPER"
    && value.status === "FAILED"
    && typeof value.failedAt === "string"
    && typeof value.error === "string";
}

/**
 * Distinguishes the normal Paper report from the deliberately smaller failure
 * payload written by paper-run.ts. A failure payload must enter the Campaign
 * failure finalization path; treating it as a report causes a second,
 * misleading exception while reading report.acceptance.
 */
export function parsePaperCampaignChildResult(value: unknown): ParsedPaperCampaignChildResult {
  if (isPaperCampaignReport(value)) return { kind: "REPORT", report: value };
  if (isPaperCampaignChildFailure(value)) return {
    kind: "FAILURE",
    failure: {
      mode: "PAPER",
      status: "FAILED",
      failedAt: value.failedAt,
      error: value.error,
    },
  };
  return { kind: "INVALID", reason: "PAPER_REPORT_MISSING_OR_INVALID" };
}

export function isObserveCampaignReport(value: unknown): value is ObserveCampaignReport {
  if (!isRecord(value) || value.mode !== "OBSERVE_ONLY") return false;
  if (typeof value.sourceCodeCommit !== "string" || typeof value.sourceCodeDirty !== "boolean") return false;
  if (!isRecord(value.metrics) || !isRecord(value.acceptance)) return false;
  return typeof value.metrics.observeRunId === "string"
    && typeof value.metrics.baselineRunId === "string"
    && typeof value.metrics.activeRuntimeMs === "number"
    && typeof value.metrics.successfulPolls === "number"
    && typeof value.metrics.failedPolls === "number"
    && typeof value.metrics.finalSyncStatus === "string"
    && typeof value.acceptance.observeStatus === "string";
}
