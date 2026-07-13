import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "node:path";
import { prepareRuntimeDatabase } from "../infra/sqlite/runtime-database-preparation.js";
import { resolveSourceVersion } from "../infra/source-version.js";
import { selectPaperAccount } from "../paper/paper-account-selection.js";
import { PaperExecutor } from "../paper/paper-executor.js";
import { PublicPaperMarketDataProvider } from "../paper/public-market-data.js";
import { PaperRunner } from "../paper/paper-runner.js";

const args = process.argv.slice(2);
const valueArg = (name: string): string | undefined => args.find((item) => item.startsWith(`--${name}=`))?.split("=")[1];
const hasFlag = (name: string): boolean => args.includes(`--${name}`);
const numberArg = (name: string, fallback: number, allowZero: boolean): number => {
  const raw = valueArg(name);
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isFinite(value) || (allowZero ? value < 0 : value <= 0)) {
    throw new Error(`Invalid --${name}: ${raw ?? String(value)}`);
  }
  return value;
};

const readOptionalText = async (path: string): Promise<string | undefined> => {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
};

const writeTextAtomically = async (path: string, content: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, content, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, path);
};

const outputDirectory = resolve("data/paper");

const main = async (): Promise<void> => {
  const defaultDatabasePath = resolve("data/phase0/phase0.sqlite");
  const databasePath = resolve(valueArg("database") ?? defaultDatabasePath);
  const durationSeconds = numberArg("duration-seconds", 0, true);
  const intervalSeconds = numberArg("interval-seconds", 1, false);
  const accountIdFile = resolve(
    valueArg("account-id-file")
      ?? (databasePath === defaultDatabasePath
        ? "data/operator/paper-account-id.txt"
        : `${databasePath}.paper-account-id`),
  );
  const readyFile = valueArg("ready-file") ? resolve(valueArg("ready-file")!) : undefined;
  const sourceVersion = resolveSourceVersion();
  const databasePreparation = await prepareRuntimeDatabase({ databasePath, sourceVersion });
  console.log(JSON.stringify({ event: "RUNTIME_DATABASE_READY", ...databasePreparation }));

  const executor = new PaperExecutor(databasePath, new PublicPaperMarketDataProvider(), { sourceVersion });
  const accountLookup = new DatabaseSync(databasePath, { readOnly: true });
  accountLookup.exec("PRAGMA busy_timeout=5000;");
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());

  try {
    const persistedAccountId = await readOptionalText(accountIdFile);
    const explicitAccountId = valueArg("account-id");
    const selection = selectPaperAccount({
      ...(explicitAccountId ? { explicitAccountId } : {}),
      ...(persistedAccountId ? { persistedAccountId } : {}),
      forceNew: hasFlag("new-account"),
      accountExists: (accountId) => Boolean(accountLookup.prepare(
        "SELECT 1 present FROM paper_accounts WHERE paper_account_id=? AND status='ACTIVE'",
      ).get(accountId)),
      createAccount: () => executor.createAccount(valueArg("account-name") ?? "Default Paper"),
    });
    accountLookup.close();
    await writeTextAtomically(accountIdFile, `${selection.accountId}\n`);
    const consumerCutoff = executor.advanceConsumerCutoff(
      selection.accountId,
      new Date().toISOString(),
      "PAPER_RUNNER_SESSION_START",
    );

    const ready = {
      status: "READY",
      mode: "PAPER",
      processId: process.pid,
      accountId: selection.accountId,
      accountSource: selection.source,
      replacedStalePersistedAccount: selection.replacedStalePersistedAccount,
      consumerCutoff,
      accountIdFile,
      databasePath,
      databasePreparation,
      readyAt: new Date().toISOString(),
    };
    if (readyFile) await writeTextAtomically(readyFile, `${JSON.stringify(ready, null, 2)}\n`);
    console.log(JSON.stringify({ event: "PAPER_RUNNER_READY", ...ready }));

    const report = await new PaperRunner(executor, {
      accountId: selection.accountId,
      intervalMs: intervalSeconds * 1_000,
      ...(durationSeconds > 0 ? { durationMs: durationSeconds * 1_000 } : {}),
    }).run(controller.signal);
    await mkdir(outputDirectory, { recursive: true });
    const output = resolve(outputDirectory, `paper-${selection.accountId}-${Date.now()}.json`);
    const payload = {
      mode: "PAPER",
      status: report.errors.length === 0 ? "COMPLETED" : "COMPLETED_WITH_ERRORS",
      sourceCodeCommit: sourceVersion.commit,
      sourceCodeDirty: sourceVersion.dirty,
      accountSelection: selection,
      consumerCutoff,
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
    if (report.errors.length > 0) {
      console.error(`PAPER_RUN_COMPLETED_WITH_ERRORS:${report.errors.length}; report=${output}`);
      process.exitCode = 1;
    }
  } finally {
    try {
      accountLookup.close();
    } catch {
      // It may already be closed after account selection.
    }
    executor.close();
  }
};

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  await mkdir(outputDirectory, { recursive: true });
  const output = resolve(outputDirectory, `paper-failed-${Date.now()}.json`);
  const failure = {
    mode: "PAPER",
    status: "FAILED",
    failedAt: new Date().toISOString(),
    error: message,
    safety: {
      privateKeyLoaded: false,
      authenticatedTradingClientPresent: false,
      realOrdersCreated: 0,
      chainWrites: 0,
    },
  };
  await writeFile(output, JSON.stringify(failure, null, 2));
  console.error(JSON.stringify({ ...failure, output }, null, 2));
  process.exitCode = 1;
}
