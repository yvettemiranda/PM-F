import { createHash } from "node:crypto";
import { activityEventKey, sourceEventKey } from "../domain/idempotency.js";
import type { PublicActivity, PublicTrade } from "../domain/models.js";
import { stableJson } from "../domain/versioning.js";
import type { ReplayReport } from "../replay/replay-engine.js";
import type { CaptureManifest, CaptureSampleRole } from "./capture-manifest.js";

export type GoldenCaseType = "NORMAL_BUY" | "NORMAL_SELL" | "HISTORICAL_SELL" | "COMBO" | "UNRECOGNIZED";
export type GoldenStatus = "CANDIDATE" | "APPROVED" | "REJECTED";

export interface GoldenExpectation {
  goldenCaseId: string;
  captureRunId: string;
  sampleWallet: string;
  sampleRole: CaptureSampleRole;
  caseType: GoldenCaseType;
  sourceEventKey: string | null;
  sourceTransactionHash: string | null;
  expectedSignalType: "TARGET_BUY" | "TARGET_SELL" | null;
  expectedSignalPresent: boolean;
  expectedExecutionEligible: boolean | null;
  expectedEventClassification: string;
  expectedReason: string;
  evidence: Record<string, unknown>;
  status: GoldenStatus;
}

export interface GoldenResult {
  goldenCaseId: string;
  resultStatus: "MATCH" | "DIFF" | "NOT_EVALUATED";
  actualSignalType: string | null;
  actualSignalPresent: boolean;
  actualExecutionEligible: boolean | null;
  actualEventClassification: string | null;
  diff: Record<string, { expected: unknown; actual: unknown }>;
}

function candidate(input: Omit<GoldenExpectation, "goldenCaseId" | "status">): GoldenExpectation {
  return {
    goldenCaseId: createHash("sha256").update(stableJson(input)).digest("hex"),
    status: "CANDIDATE",
    ...input,
  };
}

export function generateGoldenCandidates(input: {
  manifest: CaptureManifest;
  sampleRole: CaptureSampleRole;
  trades: PublicTrade[];
  activity: PublicActivity[];
  replay: ReplayReport;
}): GoldenExpectation[] {
  const candidates: GoldenExpectation[] = [];
  const tradeByEventKey = new Map(input.trades.map((trade) => [sourceEventKey(trade), trade]));

  for (const type of ["TARGET_BUY", "TARGET_SELL"] as const) {
    const signal = input.replay.signals.find((item) => item.signalType === type && item.executionEligible);
    if (!signal) continue;
    const trade = tradeByEventKey.get(signal.sourceEventKey);
    candidates.push(candidate({
      captureRunId: input.manifest.captureRunId,
      sampleWallet: input.manifest.walletAddress,
      sampleRole: input.sampleRole,
      caseType: type === "TARGET_BUY" ? "NORMAL_BUY" : "NORMAL_SELL",
      sourceEventKey: signal.sourceEventKey,
      sourceTransactionHash: trade?.transactionHash ?? null,
      expectedSignalType: type,
      expectedSignalPresent: true,
      expectedExecutionEligible: true,
      expectedEventClassification: "STANDARD_TRADE",
      expectedReason: type === "TARGET_BUY" ? "POST_BASELINE_BUY" : "RECOGNIZED_POSITION_SELL",
      evidence: { trade: trade ?? null, replaySignal: signal },
    }));
  }

  const historicalEntry = Object.entries(input.replay.eventOutcomes)
    .find(([, outcome]) => outcome.eventClassification === "HISTORICAL_POSITION_SELL");
  if (historicalEntry) {
    const [sourceEventKey, outcome] = historicalEntry;
    const trade = tradeByEventKey.get(sourceEventKey);
    candidates.push(candidate({
      captureRunId: input.manifest.captureRunId,
      sampleWallet: input.manifest.walletAddress,
      sampleRole: input.sampleRole,
      caseType: "HISTORICAL_SELL",
      sourceEventKey,
      sourceTransactionHash: trade?.transactionHash ?? null,
      expectedSignalType: null,
      expectedSignalPresent: false,
      expectedExecutionEligible: null,
      expectedEventClassification: outcome.eventClassification,
      expectedReason: "NO_POST_BASELINE_POSITION",
      evidence: { trade: trade ?? null, replayOutcome: outcome },
    }));
  }

  const comboActivity = input.activity.find((item) => ["SPLIT", "MERGE", "CONVERSION"].includes(item.type));
  if (comboActivity) {
    candidates.push(candidate({
      captureRunId: input.manifest.captureRunId,
      sampleWallet: input.manifest.walletAddress,
      sampleRole: input.sampleRole,
      caseType: "COMBO",
      sourceEventKey: activityEventKey(comboActivity),
      sourceTransactionHash: comboActivity.transactionHash,
      expectedSignalType: null,
      expectedSignalPresent: false,
      expectedExecutionEligible: null,
      expectedEventClassification: "COMBO_ACTIVITY",
      expectedReason: `${comboActivity.type}_RECORDED_WITHOUT_SIGNAL`,
      evidence: { activity: comboActivity },
    }));
  }

  const documentedActivityTypes = new Set(["TRADE", "SPLIT", "MERGE", "REDEEM", "REWARD", "CONVERSION", "MAKER_REBATE", "REFERRAL_REWARD"]);
  const unrecognizedActivity = input.activity.find((item) => !documentedActivityTypes.has(item.type));
  if (unrecognizedActivity) {
    candidates.push(candidate({
      captureRunId: input.manifest.captureRunId,
      sampleWallet: input.manifest.walletAddress,
      sampleRole: input.sampleRole,
      caseType: "UNRECOGNIZED",
      sourceEventKey: activityEventKey(unrecognizedActivity),
      sourceTransactionHash: unrecognizedActivity.transactionHash,
      expectedSignalType: null,
      expectedSignalPresent: false,
      expectedExecutionEligible: null,
      expectedEventClassification: "UNRECOGNIZED",
      expectedReason: `UNRECOGNIZED_ACTIVITY_TYPE:${unrecognizedActivity.type}`,
      evidence: { activity: unrecognizedActivity },
    }));
  }

  return candidates;
}

export function evaluateGoldenExpectations(expectations: GoldenExpectation[], replay: ReplayReport): GoldenResult[] {
  return expectations.map((expectation) => {
    const actual = expectation.sourceEventKey ? replay.eventOutcomes[expectation.sourceEventKey] : undefined;
    const actualSignalPresent = actual?.signalId !== undefined;
    const fields = {
      signalType: { expected: expectation.expectedSignalType, actual: actual?.signalType ?? null },
      signalPresent: { expected: expectation.expectedSignalPresent, actual: actualSignalPresent },
      executionEligible: { expected: expectation.expectedExecutionEligible, actual: actual?.executionEligible ?? null },
      eventClassification: { expected: expectation.expectedEventClassification, actual: actual?.eventClassification ?? null },
      reason: { expected: expectation.expectedReason, actual: actual?.reason ?? null },
    };
    const diff = Object.fromEntries(Object.entries(fields).filter(([, value]) => value.expected !== value.actual));
    return {
      goldenCaseId: expectation.goldenCaseId,
      resultStatus: expectation.status !== "APPROVED" ? "NOT_EVALUATED" : Object.keys(diff).length === 0 ? "MATCH" : "DIFF",
      actualSignalType: actual?.signalType ?? null,
      actualSignalPresent,
      actualExecutionEligible: actual?.executionEligible ?? null,
      actualEventClassification: actual?.eventClassification ?? null,
      diff,
    };
  });
}

export function renderGoldenCandidatesMarkdown(candidates: GoldenExpectation[]): string {
  const rows = candidates.map((item, index) => [
    String(index + 1),
    item.caseType,
    item.sourceTransactionHash ?? "—",
    item.expectedSignalPresent ? item.expectedSignalType ?? "YES" : "NO",
    item.expectedExecutionEligible === null ? "—" : String(item.expectedExecutionEligible),
    item.expectedEventClassification,
    item.status,
  ]);
  const details = candidates.flatMap((item, index) => {
    const evidence = (item.evidence.trade ?? item.evidence.activity ?? null) as Record<string, unknown> | null;
    const timestamp = evidence && typeof evidence.timestamp === "number"
      ? new Date(evidence.timestamp * 1_000).toISOString()
      : "—";
    return [
      `## ${index + 1}. ${item.caseType}`,
      "",
      `- Golden Case ID: \`${item.goldenCaseId}\``,
      `- Transaction: \`${item.sourceTransactionHash ?? "NONE"}\``,
      `- Source Event Key: \`${item.sourceEventKey ?? "NONE"}\``,
      `- Time: \`${timestamp}\``,
      `- Activity/Side: \`${String(evidence?.type ?? evidence?.side ?? "—")}\``,
      `- Market: ${String(evidence?.title ?? evidence?.slug ?? evidence?.conditionId ?? "—")}`,
      `- Outcome: ${String(evidence?.outcome ?? "—")}`,
      `- Price / Size: \`${String(evidence?.price ?? "—")} / ${String(evidence?.size ?? "—")}\``,
      `- Expected Signal: \`${item.expectedSignalPresent ? item.expectedSignalType : "NONE"}\``,
      `- Expected executionEligible: \`${item.expectedExecutionEligible ?? "N/A"}\``,
      `- Expected Classification: \`${item.expectedEventClassification}\``,
      `- Expected Reason: \`${item.expectedReason}\``,
      `- Approval Status: \`${item.status}\``,
      "",
    ];
  });
  return [
    "# Candidate Golden Cases",
    "",
    "这些案例由真实公开数据自动筛选，当前全部为 `CANDIDATE`。只有用户确认后才能改为 `APPROVED` 并参与 Golden Passed 判定。",
    "",
    "| # | Case | Transaction | Expected Signal | executionEligible | Classification | Status |",
    "|---:|---|---|---|---|---|---|",
    ...rows.map((row) => `| ${row.join(" | ")} |`),
    "",
    ...details,
    "## 用户确认方式",
    "",
    "请逐项确认或指出需要修改的预期。未经明确确认，系统不会把任何案例改为 `APPROVED`，Golden 状态保持 `NOT_EVALUATED`。",
    "",
  ].join("\n");
}
