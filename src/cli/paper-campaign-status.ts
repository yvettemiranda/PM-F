import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PaperValidationCampaignService } from "../paper-validation/service.js";
import { normalizeTargetWallet } from "../operator/target-wallet.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const databasePath = resolve(projectRoot, "data/phase0/phase0.sqlite");
const latestPointerPath = resolve(projectRoot, "data/operator/paper-campaign-latest.json");
const targetWallet = normalizeTargetWallet(process.argv.slice(2)
  .find((argument) => argument.startsWith("--target-wallet="))
  ?.slice("--target-wallet=".length));

function formatHours(milliseconds: number): string {
  return (milliseconds / 3_600_000).toFixed(2);
}

if (!existsSync(databasePath)) {
  console.log("还没有初始化数据库，也没有 Paper 累计验证记录。");
  process.exit(0);
}

const lookup = new DatabaseSync(databasePath, { readOnly: true });
lookup.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=5000;");
const table = lookup.prepare(
  "SELECT 1 ok FROM sqlite_master WHERE type='table' AND name='paper_validation_campaigns'",
).get();
if (!table) {
  lookup.close();
  console.log("当前数据库还没有 Paper 累计验证框架。请先运行环境检查和开始按钮。");
  process.exit(0);
}
const latest = lookup.prepare(
  `SELECT c.campaign_id FROM paper_validation_campaigns c
   JOIN monitor_targets t ON t.target_id=c.target_id
   WHERE lower(t.wallet_address)=?
   ORDER BY c.created_at DESC,c.campaign_id DESC LIMIT 1`,
).get(targetWallet) as { campaign_id: string } | undefined;
lookup.close();
if (!latest) {
  console.log(`目标钱包 ${targetWallet} 还没有 Paper Campaign。第一次双击开始按钮时会自动创建。`);
  process.exit(0);
}

const service = new PaperValidationCampaignService(databasePath);
try {
  const snapshot = service.campaignSnapshot(latest.campaign_id);
  const latestReport = service.store.latestCampaignReport(snapshot.campaignId);
  const pointer = existsSync(latestPointerPath)
    ? JSON.parse(await readFile(latestPointerPath, "utf8")) as Record<string, unknown>
    : null;
  const currentPointer = pointer?.campaignId === snapshot.campaignId ? pointer : null;
  const output = {
    targetWallet,
    campaignId: snapshot.campaignId,
    state: snapshot.state,
    qualified: snapshot.qualified,
    accumulatedActiveRuntimeMs: snapshot.accumulatedActiveRuntimeMs,
    accumulatedHours: formatHours(snapshot.accumulatedActiveRuntimeMs),
    requiredHours: formatHours(snapshot.requiredActiveRuntimeMs),
    longestContinuousRuntimeMs: snapshot.longestContinuousRuntimeMs,
    longestContinuousHours: formatHours(snapshot.longestContinuousRuntimeMs),
    requiredContinuousHours: formatHours(snapshot.requiredContinuousRuntimeMs),
    completedSessionCount: snapshot.completedSessionCount,
    coverageStatus: snapshot.coverageStatus,
    missingScenarios: snapshot.missingScenarios,
    blockers: snapshot.blockers,
    canContinue: snapshot.canContinue,
    latestSessionId: snapshot.latestSessionId,
    latestReportId: snapshot.latestReportId,
    currentRun: currentPointer,
    operationalMetrics: latestReport?.operationalMetrics ?? null,
    safety: {
      executionMode: "PAPER",
      liveGateState: "LIVE_DISABLED",
      liveAllowed: false,
    },
  };
  console.log(JSON.stringify(output, null, 2));
  console.log("");
  console.log(`当前 Campaign：${snapshot.campaignId}`);
  console.log(`状态：${snapshot.state}`);
  console.log(`累计有效运行：${output.accumulatedHours} / ${output.requiredHours} 小时`);
  console.log(`最长单次连续：${output.longestContinuousHours} / ${output.requiredContinuousHours} 小时`);
  console.log(`已完成 Session：${snapshot.completedSessionCount}`);
  console.log(`未覆盖关键场景：${snapshot.missingScenarios.length === 0 ? "无" : snapshot.missingScenarios.join("、")}`);
  console.log(`当前阻断项：${snapshot.blockers.length === 0 ? "无" : snapshot.blockers.join("、")}`);
  if (latestReport) {
    const metrics = latestReport.operationalMetrics;
    console.log(
      `累计业务：轮询成功 ${metrics.observe.successfulPolls}，失败 ${metrics.observe.failedPolls}；`
      + `BUY Signal ${metrics.paper.signals.buy}，SELL Signal ${metrics.paper.signals.sell}，Gap ${metrics.paper.signals.gap}；`
      + `Order ${metrics.paper.execution.orders}，Fill ${metrics.paper.execution.fills}。`,
    );
  }
  console.log("安全状态：PAPER + LIVE_DISABLED；当前不允许实盘。");
} finally {
  service.close();
}
