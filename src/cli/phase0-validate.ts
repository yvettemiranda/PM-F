import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PolymarketPublicApi, type ApiCapture } from "../adapters/polymarket-public.js";
import { Phase0Database } from "../infra/sqlite/database.js";
import { ReplayEngine } from "../replay/replay-engine.js";
import { buildWalletIdentityReport } from "../services/wallet-identity.js";
import { validateApiContract } from "../services/api-contract.js";
import { RULESET_HASH, RULESET_SNAPSHOT_JSON, VERSIONS } from "../domain/versioning.js";
import { resolveSourceVersion } from "../infra/source-version.js";
import { buildCaptureManifest, captureIdentity, type CaptureManifestSource } from "../services/capture-manifest.js";
import { buildPositionBaseline } from "../services/position-baseline.js";
import { estimateTargetCapital } from "../services/capital-estimator.js";
import {
  evaluateGoldenExpectations,
  generateGoldenCandidates,
  renderGoldenCandidatesMarkdown,
} from "../services/golden-expectations.js";
import { sourceEventKey } from "../domain/idempotency.js";

const address = process.argv.slice(2).find((argument) => /^0x[a-fA-F0-9]{40}$/.test(argument))?.toLowerCase();
if (!address || !/^0x[a-f0-9]{40}$/.test(address)) {
  throw new Error("Usage: pnpm phase0:validate -- 0x<40-hex-address>");
}

const outputDirectory = resolve("data/phase0");
await mkdir(outputDirectory, { recursive: true });
const sourceVersion = resolveSourceVersion();

const api = new PolymarketPublicApi();
const [profile, trades, activity, positions, code, pUsdBalance, safe, wallet, clobTime] = await Promise.all([
  api.profile(address),
  api.trades(address),
  api.activity(address),
  api.positions(address),
  api.contractCode(address),
  api.pUsdBalance(address),
  api.relayerDeployed(address, "SAFE"),
  api.relayerDeployed(address, "WALLET"),
  api.clobTime(),
]);

const identity = buildWalletIdentityReport({
  address,
  profile: profile.data,
  trades: trades.rows,
  positions: positions.data,
  contractCode: code.data.result ?? null,
  relayerSafeDeployed: safe?.data.deployed ?? null,
  relayerWalletDeployed: wallet?.data.deployed ?? null,
  tradeHistoryComplete: trades.historyComplete,
});

const contractCaptures: ApiCapture<unknown>[] = [
  profile,
  positions,
  code,
  pUsdBalance,
  clobTime,
  ...trades.captures,
  ...activity.captures,
  ...(safe ? [safe] : []),
  ...(wallet ? [wallet] : []),
];
const apiContractReport = validateApiContract({
  trades: trades.rows,
  activity: activity.rows,
  positions: positions.data,
  tradeHistoryComplete: trades.historyComplete,
  activityHistoryComplete: activity.historyComplete,
  clobTime,
  captures: contractCaptures,
});

const finalPaginationStatus = (historyComplete: boolean, stopReason: string): string => {
  if (historyComplete) return "END_OF_DATA";
  if (stopReason.includes("max historical activity offset")) return "SOURCE_OFFSET_LIMIT";
  return stopReason;
};

const manifestSources: CaptureManifestSource[] = [
  { endpoint: "gamma-public-profile", capture: profile, paginationStatus: "NOT_PAGED" },
  { endpoint: "data-positions", capture: positions, paginationStatus: positions.data.length < 500 ? "END_OF_DATA" : "PAGE_FULL" },
  { endpoint: "polygon-eth-get-code", capture: code, paginationStatus: "NOT_PAGED" },
  { endpoint: "polygon-pusd-balance", capture: pUsdBalance, paginationStatus: "NOT_PAGED" },
  { endpoint: "clob-time", capture: clobTime, paginationStatus: "NOT_PAGED" },
  ...trades.captures.map((capture, pageIndex): CaptureManifestSource => ({
    endpoint: "data-trades",
    capture,
    pageIndex,
    paginationStatus: pageIndex === trades.captures.length - 1
      ? finalPaginationStatus(trades.historyComplete, trades.stopReason)
      : "PAGE_FULL",
  })),
  ...activity.captures.map((capture, pageIndex): CaptureManifestSource => ({
    endpoint: "data-activity",
    capture,
    pageIndex,
    paginationStatus: pageIndex === activity.captures.length - 1
      ? finalPaginationStatus(activity.historyComplete, activity.stopReason)
      : "PAGE_FULL",
  })),
  ...(safe ? [{ endpoint: "relayer-safe", capture: safe, paginationStatus: "NOT_PAGED" }] : []),
  ...(wallet ? [{ endpoint: "relayer-wallet", capture: wallet, paginationStatus: "NOT_PAGED" }] : []),
];
const manifest = buildCaptureManifest({
  walletAddress: address,
  sampleRole: "TARGET",
  purpose: "PHASE_0_5_VALIDATION",
  sourceVersion,
  sources: manifestSources,
});

const database = new Phase0Database(resolve(outputDirectory, "phase0.sqlite"), sourceVersion);
database.initialize();
database.saveIdentity(identity);

const captures: Array<[string, ApiCapture<unknown>]> = [
  ["gamma-public-profile", profile],
  ["data-positions", positions],
  ["polygon-eth-get-code", code],
  ["polygon-pusd-balance", pUsdBalance],
  ["clob-time", clobTime],
  ...trades.captures.map((capture): [string, ApiCapture<unknown>] => ["data-trades", capture]),
  ...activity.captures.map((capture): [string, ApiCapture<unknown>] => ["data-activity", capture]),
];
if (safe) captures.push(["relayer-safe", safe]);
if (wallet) captures.push(["relayer-wallet", wallet]);
for (const [endpoint, capture] of captures) database.saveCapture(endpoint, capture);

const targetId = database.ensureTarget(address, identity.status);
database.saveCaptureManifest(targetId, manifest);
const baseline = buildPositionBaseline({
  captureRunId: manifest.captureRunId,
  targetId,
  walletAddress: address,
  positionCaptureId: captureIdentity(positions).captureId,
  fetchedAt: positions.fetchedAt,
  latencyMs: positions.latencyMs,
  positions: positions.data,
});
database.savePositionBaseline(baseline);
const walletBalanceMicros = pUsdBalance.data.result && /^0x[0-9a-f]+$/i.test(pUsdBalance.data.result)
  ? BigInt(pUsdBalance.data.result)
  : null;
const capitalEstimate = estimateTargetCapital({
  walletAddress: address,
  identityStatus: identity.status,
  syncStatus: "SYNCED",
  positions: positions.data,
  positionSnapshotTime: positions.fetchedAt,
  walletBalanceMicros,
  walletBalanceSnapshotTime: pUsdBalance.fetchedAt,
});
database.saveCapitalEstimate(targetId, null, capitalEstimate);
const interruptedJobs = database.recoverInterruptedReplayJobs(new Date(Date.now() - 5 * 60_000).toISOString());
const replayJobId = database.beginReplayJob(manifest.captureRunId);
let replay;
let replayRunId: string;
let goldenCandidates;
let goldenResults;
try {
  replay = new ReplayEngine().run({
    walletAddress: address,
    identityStatus: identity.status,
    trades: trades.rows,
    activity: activity.rows,
    hasCapitalSnapshots: false,
    hasGoldenExpectations: false,
    hasPositionBaseline: false,
    tradeHistoryComplete: trades.historyComplete,
    activityHistoryComplete: activity.historyComplete,
    sourceCodeCommit: sourceVersion.commit,
    sourceCodeDirty: sourceVersion.dirty,
  });
  goldenCandidates = generateGoldenCandidates({
    manifest,
    sampleRole: "TARGET",
    trades: trades.rows,
    activity: activity.rows,
    replay,
  });
  const tradeByEventKey = new Map(trades.rows.map((trade) => [
    sourceEventKey(trade),
    trade,
  ]));
  const capitalEstimatesBySourceEventKey = Object.fromEntries(
    replay.signals
      .filter((signal) => signal.signalType === "TARGET_BUY" && signal.executionEligible)
      .map((signal) => {
        const trade = tradeByEventKey.get(signal.sourceEventKey);
        if (!trade) throw new Error(`Trade missing for buy signal: ${signal.sourceEventKey}`);
        const estimate = estimateTargetCapital({
          walletAddress: address,
          sourceEventKey: signal.sourceEventKey,
          identityStatus: identity.status,
          syncStatus: "SYNCED",
          positions: positions.data,
          positionSnapshotTime: positions.fetchedAt,
          walletBalanceMicros,
          walletBalanceSnapshotTime: pUsdBalance.fetchedAt,
          targetTrade: { price: trade.price, size: trade.size, timestamp: trade.timestamp },
        });
        return [signal.sourceEventKey, estimate];
      }),
  );
  replayRunId = database.saveReplay(targetId, trades.rows, activity.rows, replay, {
    captureRunId: manifest.captureRunId,
    goldenEvaluationStatus: "NOT_EVALUATED",
    capitalEstimatesBySourceEventKey,
  });
  database.saveGoldenCandidates(goldenCandidates);
  goldenResults = evaluateGoldenExpectations(goldenCandidates, replay);
  database.saveGoldenResults(replayRunId, goldenResults);
  database.completeReplayJob(replayJobId, replayRunId);
} catch (error) {
  database.failReplayJob(replayJobId, error);
  database.close();
  throw error;
}
database.close();

const envelope = {
  generatedAt: new Date().toISOString(),
  versions: VERSIONS,
  rulesetHash: RULESET_HASH,
  rulesetSnapshotJson: RULESET_SNAPSHOT_JSON,
  sourceCodeCommit: sourceVersion.commit,
  sourceCodeDirty: sourceVersion.dirty,
  target: address,
  contract: {
    tradesHistoryComplete: trades.historyComplete,
    tradesStopReason: trades.stopReason,
    activityHistoryComplete: activity.historyComplete,
    activityStopReason: activity.stopReason,
    clobServerTime: clobTime.data,
  },
  walletIdentityReport: identity,
  apiContractReport,
  captureManifest: manifest,
  positionBaseline: {
    baselineRunId: baseline.baselineRunId,
    snapshotTime: baseline.snapshotTime,
    itemCount: baseline.items.length,
  },
  capitalEstimate,
  interruptedJobs,
  replayJobId,
  replayRunId,
  replay,
  goldenCandidates,
  goldenResults,
};

await writeFile(resolve(outputDirectory, `phase0-${address}.json`), JSON.stringify(envelope, null, 2));
await writeFile(resolve(outputDirectory, `capture-manifest-${manifest.captureRunId}.json`), JSON.stringify(manifest, null, 2));
await writeFile(resolve(outputDirectory, `candidate-golden-${manifest.captureRunId}.json`), JSON.stringify(goldenCandidates, null, 2));
await writeFile(resolve(outputDirectory, `candidate-golden-${manifest.captureRunId}.md`), renderGoldenCandidatesMarkdown(goldenCandidates));

console.log(
  JSON.stringify(
    {
      target: address,
      identityStatus: identity.status,
      walletType: identity.walletType,
      apiContractStatus: apiContractReport.status,
      captureRunId: manifest.captureRunId,
      sourceCodeCommit: sourceVersion.commit,
      sourceCodeDirty: sourceVersion.dirty,
      baselineItems: baseline.items.length,
      capitalConfidence: capitalEstimate.capitalConfidence,
      goldenCandidateCount: goldenCandidates.length,
      goldenEvaluationStatus: "NOT_EVALUATED",
      trades: trades.rows.length,
      activity: activity.rows.length,
      positions: positions.data.length,
      replayStatus: replay.status,
      replayHash: replay.reportHash,
      duplicateRows: replay.metrics.duplicateRows,
      buySignals: replay.metrics.buySignals,
      sellSignals: replay.metrics.sellSignals,
      historicalSells: replay.metrics.historicalSells,
      output: resolve(outputDirectory, `phase0-${address}.json`),
    },
    null,
    2,
  ),
);
