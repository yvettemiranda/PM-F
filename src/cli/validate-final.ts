import { resolve } from "node:path";
import { ValidationRunner } from "../validation/validation-runner.js";
import type { ValidationType } from "../validation/types.js";

const args = process.argv.slice(2);
const valueArg = (name: string): string | undefined => args.find((item) => item.startsWith(`--${name}=`))?.split("=")[1];
const flag = (name: string): boolean => args.includes(`--${name}`);

const type = (valueArg("type") ?? "all").toUpperCase() as ValidationType;
const allowedTypes: ValidationType[] = [
  "ALL",
  "PAPER_REPLAY",
  "PAPER_CONSISTENCY",
  "CRASH_RECOVERY",
  "RECONCILIATION",
  "LIVE_GATE",
  "OBSERVE_ONLY",
];
if (!allowedTypes.includes(type)) {
  throw new Error(`Invalid --type: ${type}. Allowed: ${allowedTypes.join(", ")}`);
}

const databasePath = resolve(valueArg("database") ?? "data/phase0/phase0.sqlite");
const outputDirectory = resolve(valueArg("output-directory") ?? "data/validation");
const useSnapshot = !flag("no-snapshot");

const result = await new ValidationRunner().run({
  sourceDatabasePath: databasePath,
  outputDirectory,
  validationType: type,
  useSnapshot,
});

console.log(JSON.stringify({
  status: result.report.finalResult.status,
  frameworkSessionStatus: result.report.session.status,
  finalReadinessStatus: result.report.finalResult.finalReadinessStatus,
  liveAllowed: result.report.finalResult.liveAllowed,
  blockingFailures: result.report.finalResult.blockingFailures,
  warnings: result.report.finalResult.warnings,
  jsonReportPath: result.jsonReportPath,
  markdownReportPath: result.markdownReportPath,
  workingDatabasePath: result.workingDatabasePath,
}, null, 2));

if (result.report.session.status === "FAILED" || result.report.finalResult.blockingFailures.length > 0) {
  process.exitCode = 1;
}
