import { resolve } from "node:path";
import { OperationalRunner } from "../operational/operational-runner.js";
import type { OperationalMode, OperationalRunOptions } from "../operational/types.js";
import { resolveValidationScopeFromDatabase } from "../validation/scoped-invariants.js";

const args = process.argv.slice(2);
const valueArg = (name: string): string | undefined => args.find((item) => item.startsWith(`--${name}=`))?.split("=")[1];
const flag = (name: string): boolean => args.includes(`--${name}`);

const modeMap: Record<string, OperationalMode> = {
  observe_only: "OBSERVE_ONLY_OPERATIONAL",
  paper_validation: "PAPER_VALIDATION_OPERATIONAL",
  health_monitor: "HEALTH_MONITOR_ONLY",
  consistency_monitor: "CONSISTENCY_MONITOR_ONLY",
  crash_recovery: "CRASH_RECOVERY_OPERATIONAL",
};

const rawMode = (valueArg("mode") ?? "health_monitor").toLowerCase();
const mode = modeMap[rawMode];
if (!mode) {
  throw new Error(`Invalid --mode: ${rawMode}. Allowed: ${Object.keys(modeMap).join(", ")}`);
}

const numberArg = (name: string, fallback: number): number => {
  const raw = valueArg(name);
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid --${name}: ${raw}`);
  return value;
};

const databasePath = resolve(valueArg("database") ?? "data/phase0/phase0.sqlite");
const outputDirectory = resolve(valueArg("output-directory") ?? "data/operational");
const durationMs = numberArg("duration-seconds", 0) * 1_000;
const pollIntervalMs = numberArg("poll-seconds", 1) * 1_000;
if (pollIntervalMs <= 0) throw new Error("Invalid --poll-seconds: value must be greater than 0");

const runOptions: OperationalRunOptions = {
  sourceDatabasePath: databasePath,
  outputDirectory,
  mode,
  durationMs,
  pollIntervalMs,
  useSnapshot: !flag("no-snapshot"),
};
const targetWallet = valueArg("target-wallet");
const paperAccountId = valueArg("paper-account-id");
if (targetWallet) runOptions.targetWallet = targetWallet;
if (paperAccountId) runOptions.paperAccountId = paperAccountId;
const campaignId = valueArg("campaign-id");
const campaignSessionId = valueArg("session-id");
if ((campaignId && !campaignSessionId) || (!campaignId && campaignSessionId)) {
  throw new Error("OPERATIONAL_SCOPE_INCOMPLETE:--campaign-id and --session-id must both be provided");
}
if (campaignId && campaignSessionId) {
  runOptions.validationScope = resolveValidationScopeFromDatabase(
    databasePath,
    campaignId,
    campaignSessionId,
  );
}

const result = await new OperationalRunner().run(runOptions);

console.log(JSON.stringify({
  status: result.resultStatus,
  runStatus: result.status,
  finalStatus: result.finalStatus,
  liveAllowed: result.liveAllowed,
  blockingFailures: result.blockingFailures,
  warnings: result.warnings,
  jsonReportPath: result.jsonReportPath,
  markdownReportPath: result.markdownReportPath,
  workingDatabasePath: result.workingDatabasePath,
  sourceDatabasePath: result.sourceDatabasePath,
  paperAccountId: result.paperAccountId,
}, null, 2));

if (result.status === "FAILED" || result.blockingFailures.length > 0) process.exitCode = 1;
