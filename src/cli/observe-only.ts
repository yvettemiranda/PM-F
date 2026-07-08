import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Phase0Database } from "../infra/sqlite/database.js";
import { resolveSourceVersion } from "../infra/source-version.js";
import { ObserveOnlyRunner } from "../observe/observe-runner.js";
import { ObserveStore } from "../observe/observe-store.js";
import { PublicObserveDataSource } from "../observe/public-data-source.js";
import { PublicSignalMarketMetadataProvider } from "../signal-context/public-market-metadata.js";

const args = process.argv.slice(2);
const address = args.find((argument) => /^0x[a-fA-F0-9]{40}$/.test(argument))?.toLowerCase();
if (!address) throw new Error("Usage: pnpm observe:run -- 0x<address> [--duration-seconds=300] [--poll-seconds=15]");
const numberArg = (name: string, fallback: number): number => {
  const value = args.find((argument) => argument.startsWith(`--${name}=`))?.split("=")[1];
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`Invalid --${name}: ${value}`);
  return parsed;
};
const durationSeconds = numberArg("duration-seconds", 0);
const pollSeconds = numberArg("poll-seconds", 15);
const minimumSoakSeconds = numberArg("minimum-soak-seconds", 24 * 60 * 60);
const databasePath = resolve("data/phase0/phase0.sqlite");
const sourceVersion = resolveSourceVersion();
const migrations = new Phase0Database(databasePath, sourceVersion);
migrations.initialize();
migrations.close();

const store = new ObserveStore(databasePath, sourceVersion);
const runner = new ObserveOnlyRunner(store, new PublicObserveDataSource(), {
  walletAddress: address,
  pollIntervalMs: pollSeconds * 1_000,
  ...(durationSeconds > 0 ? { durationMs: durationSeconds * 1_000 } : {}),
  signalMarketMetadataProvider: new PublicSignalMarketMetadataProvider(),
});
const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());

try {
  const metrics = await runner.run(controller.signal);
  const shortSoakPassed = !sourceVersion.dirty
    && metrics.majorDesyncCount === 0
    && !metrics.unrecoveredConnectionGap
    && !metrics.checkpointProjectionHashMismatch
    && metrics.finalSyncStatus === "SYNCED"
    && metrics.successfulPolls > 0;
  const liveStabilityEligible = metrics.durationMs >= minimumSoakSeconds * 1_000
    && !sourceVersion.dirty
    && metrics.majorDesyncCount === 0
    && !metrics.unrecoveredConnectionGap
    && !metrics.checkpointProjectionHashMismatch
    && metrics.finalSyncStatus === "SYNCED"
    && metrics.successfulPolls > 0;
  const report = {
    generatedAt: new Date().toISOString(),
    target: address,
    sourceCodeCommit: sourceVersion.commit,
    sourceCodeDirty: sourceVersion.dirty,
    mode: "OBSERVE_ONLY",
    metrics,
    acceptance: {
      observeStatus: shortSoakPassed ? "SHORT_SOAK_PASSED" : "SHORT_SOAK_FAILED",
      paperDevelopmentEligible: shortSoakPassed,
      minimumSoakSeconds,
      liveStabilityEligible,
      liveStabilityBlockers: [
        ...(metrics.durationMs < minimumSoakSeconds * 1_000 ? ["MINIMUM_SOAK_NOT_REACHED"] : []),
        ...(sourceVersion.dirty ? ["SOURCE_CODE_DIRTY"] : []),
        ...(metrics.majorDesyncCount > 0 ? ["MAJOR_DESYNC_OBSERVED"] : []),
        ...(metrics.unrecoveredConnectionGap ? ["UNRECOVERED_CONNECTION_GAP"] : []),
        ...(metrics.checkpointProjectionHashMismatch ? ["CHECKPOINT_PROJECTION_HASH_MISMATCH"] : []),
        ...(metrics.finalSyncStatus !== "SYNCED" ? [`FINAL_SYNC_STATUS:${metrics.finalSyncStatus ?? "NONE"}`] : []),
      ],
      warnings: [
        ...(metrics.failedPolls > 0 && !metrics.unrecoveredConnectionGap ? ["RECOVERED_API_FAILURES_OBSERVED"] : []),
        ...(metrics.minorDiffCount > 0 && metrics.finalSyncStatus === "SYNCED" ? ["TRANSIENT_MINOR_DIFF_OBSERVED"] : []),
      ],
    },
    safety: {
      privateKeyLoaded: false,
      orderLogicPresent: false,
      ordersCreated: 0,
      executionMode: null,
    },
  };
  const outputDirectory = resolve("data/observe");
  await mkdir(outputDirectory, { recursive: true });
  const output = resolve(outputDirectory, `observe-${metrics.observeRunId}.json`);
  await writeFile(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, output }, null, 2));
} finally {
  store.close();
}
