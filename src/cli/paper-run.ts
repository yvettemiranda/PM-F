import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Phase0Database } from "../infra/sqlite/database.js";
import { resolveSourceVersion } from "../infra/source-version.js";
import { PaperExecutor } from "../paper/paper-executor.js";
import { PublicPaperMarketDataProvider } from "../paper/public-market-data.js";
import { PaperRunner } from "../paper/paper-runner.js";

const args = process.argv.slice(2);
const valueArg = (name: string): string | undefined => args.find((item) => item.startsWith(`--${name}=`))?.split("=")[1];
const numberArg = (name: string, fallback: number): number => {
  const raw = valueArg(name);
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid --${name}: ${raw}`);
  return value;
};
const databasePath = resolve(valueArg("database") ?? "data/phase0/phase0.sqlite");
const durationSeconds = numberArg("duration-seconds", 0);
const intervalSeconds = numberArg("interval-seconds", 1);
const sourceVersion = resolveSourceVersion();
const migrations = new Phase0Database(databasePath, sourceVersion);
migrations.initialize();
migrations.close();
const executor = new PaperExecutor(databasePath, new PublicPaperMarketDataProvider(), { sourceVersion });
const accountId = valueArg("account-id") ?? executor.createAccount(valueArg("account-name") ?? "Default Paper");
const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());
try {
  const report = await new PaperRunner(executor, {
    accountId,
    intervalMs: intervalSeconds * 1_000,
    ...(durationSeconds > 0 ? { durationMs: durationSeconds * 1_000 } : {}),
  }).run(controller.signal);
  const outputDirectory = resolve("data/paper");
  await mkdir(outputDirectory, { recursive: true });
  const output = resolve(outputDirectory, `paper-${accountId}-${Date.now()}.json`);
  const payload = {
    mode: "PAPER",
    sourceCodeCommit: sourceVersion.commit,
    sourceCodeDirty: sourceVersion.dirty,
    report,
    safety: {
      privateKeyLoaded: false,
      authenticatedTradingClientPresent: false,
      realOrdersCreated: 0,
      chainWrites: 0,
      liveExecutorPresent: false,
    },
  };
  await writeFile(output, JSON.stringify(payload, null, 2));
  console.log(JSON.stringify({ ...payload, output }, null, 2));
} finally {
  executor.close();
}
