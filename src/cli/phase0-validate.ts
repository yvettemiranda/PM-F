import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PolymarketPublicApi, type ApiCapture } from "../adapters/polymarket-public.js";
import { preparePhase0ValidationDatabase } from "../infra/sqlite/phase0-validation-database.js";
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
import { resolvedSourceEventTradeMap } from "../domain/idempotency.js";
import { activityAsTrade } from "../domain/activity-trade.js";
import { collectTradeMultiplicityEvidence } from "../services/trade-multiplicity-evidence.js";
import { verifiedBinaryMarketOutcomeAssets } from "../signal-context/market-outcome-set.js";

const address = process.argv.slice(2).find((argument) => /^0x[a-fA-F0-9]{40}$/.test(argument))?.toLowerCase();
if (!address || !/^0x[a-f0-9]{40}$/.test(address)) {
  throw new Error("Usage: pnpm phase0:validate -- 0x<40-hex-address>");
}

const outputDirectory = resolve("data/phase0");
await mkdir(outputDirectory, { recursive: true });
const sourceVersion = resolveSourceVersion();

const api = new PolymarketPublicApi();
const [profile, trades, activity, positionHistory, code, pUsdBalance, safe, wallet, clobTime] = await Promise.all([
  api.profile(address),
  api.trades(address),
  api.activity(address),
  api.allPositions(address),
  api.contractCode(address),
  api.pUsdBalance(address),
  api.relayerDeployed(address, "SAFE"),
  api.relayerDeployed(address, "WALLET"),
  api.clobTime(),
]);
const positions = positionHistory.merged;
const activityPaginationBoundaryOverlaps = activity.boundaryOverlapRows.flatMap((item) => {
  const trade = activityAsTrade(item);
  return trade ? [trade] : [];
});
const mergeConditionIds = [...new Set(activity.rows
  .filter((item) => item.type === "MERGE" && item.conditionId)
  .map((item) => item.conditionId!.toLowerCase()))].sort();
const mergeMarkets = await Promise.all(mergeConditionIds.map((conditionId) => api.clobMarket(conditionId)));
const verifiedMarketOutcomeAssetsByCondition = Object.fromEntries(
  mergeMarkets.map((capture) => [
    capture.data.condition_id.toLowerCase(),
    verifiedBinaryMarketOutcomeAssets(capture.data, capture.data.condition_id),
  ]),
);
const tradeMultiplicityEvidence = await collectTradeMultiplicityEvidence({
  walletAddress: address,
  trades: trades.rows,
  activity: activity.rows,
  tradePaginationBoundaryOverlaps: trades.boundaryOverlapRows,
  activityPaginationBoundaryOverlaps,
  receiptProvider: api,
});
const sourceEventMultiplicityEvidence = {
  tradePaginationBoundaryOverlaps: trades.boundaryOverlapRows,
  activityPaginationBoundaryOverlaps,
  confirmedOccurrenceCounts: tradeMultiplicityEvidence.confirmedOccurrenceCounts,
};

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
  ...positionHistory.captures,
  code,
  pUsdBalance,
  clobTime,
  ...trades.captures,
  ...activity.captures,
  ...tradeMultiplicityEvidence.receiptCaptures,
  ...mergeMarkets,
  ...(safe ? [safe] : []),
  ...(wallet ? [wallet] : []),
];
const apiContractReport = validateApiContract({
  trades: trades.rows,
  activity: activity.rows,
  positions: positions.data,
  tradeHistoryComplete: trades.historyComplete,
  activityHistoryComplete: activity.historyComplete,
  tradePaginationBoundaryOverlaps: trades.boundaryOverlapRows,
  activityPaginationBoundaryOverlaps,
  confirmedTradeOccurrenceCounts: tradeMultiplicityEvidence.confirmedOccurrenceCounts,
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
  ...positionHistory.captures.map((capture, pageIndex): CaptureManifestSource => ({
    endpoint: "data-positions",
    capture,
    pageIndex,
    paginationStatus: pageIndex === positionHistory.captures.length - 1
      ? finalPaginationStatus(positionHistory.historyComplete, positionHistory.stopReason)
      : "PAGE_FULL",
  })),
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
  ...tradeMultiplicityEvidence.receiptCaptures.map((capture): CaptureManifestSource => ({
    endpoint: "polygon-transaction-receipt",
    capture,
    paginationStatus: "NOT_PAGED",
  })),
  ...mergeMarkets.map((capture, pageIndex): CaptureManifestSource => ({
    endpoint: "clob-market",
    capture,
    pageIndex,
    paginationStatus: "NOT_PAGED",
  })),
  ...(tradeMultiplicityEvidence.proofCapture
    ? [{
      endpoint: "derived-trade-multiplicity-evidence",
      capture: tradeMultiplicityEvidence.proofCapture,
      paginationStatus: "DERIVED_VERIFIED",
    }]
    : []),
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

const databasePath = resolve(outputDirectory, "phase0.sqlite");
const { database, preparation: databasePreparation } = await preparePhase0ValidationDatabase({
  databasePath,
  sourceVersion,
});
database.saveIdentity(identity);

const captures: Array<[string, ApiCapture<unknown>]> = [
  ["gamma-public-profile", profile],
  ["data-positions-merged", positions],
  ["polygon-eth-get-code", code],
  ["polygon-pusd-balance", pUsdBalance],
  ["clob-time", clobTime],
  ...trades.captures.map((capture): [string, ApiCapture<unknown>] => ["data-trades", capture]),
  ...activity.captures.map((capture): [string, ApiCapture<unknown>] => ["data-activity", capture]),
  ...tradeMultiplicityEvidence.receiptCaptures.map(
    (capture): [string, ApiCapture<unknown>] => ["polygon-transaction-receipt", capture],
  ),
  ...mergeMarkets.map((capture): [string, ApiCapture<unknown>] => ["clob-market", capture]),
  ...positionHistory.captures.map((capture): [string, ApiCapture<unknown>] => ["data-positions", capture]),
];
if (tradeMultiplicityEvidence.proofCapture) {
  captures.push(["derived-trade-multiplicity-evidence", tradeMultiplicityEvidence.proofCapture]);
}
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
    targetId,
    walletAddress: address,
    identityStatus: identity.status,
    trades: trades.rows,
    activity: activity.rows,
    hasCapitalSnapshots: false,
    hasGoldenExpectations: false,
    hasPositionBaseline: false,
    tradeHistoryComplete: trades.historyComplete,
    activityHistoryComplete: activity.historyComplete,
    tradePaginationBoundaryOverlaps: trades.boundaryOverlapRows,
    activityPaginationBoundaryOverlaps,
    confirmedTradeOccurrenceCounts: tradeMultiplicityEvidence.confirmedOccurrenceCounts,
    verifiedMarketOutcomeAssetsByCondition,
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
  const activityTrades = activity.rows.flatMap((item) => {
    const trade = activityAsTrade(item);
    return trade ? [trade] : [];
  });
  const tradeByEventKey = resolvedSourceEventTradeMap(
    trades.rows,
    activityTrades,
    sourceEventMultiplicityEvidence,
  );
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
    sourceEventMultiplicityEvidence,
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
  tradeMultiplicityEvidence: {
    confirmedOccurrenceCounts: tradeMultiplicityEvidence.confirmedOccurrenceCounts,
    proofs: tradeMultiplicityEvidence.proofs,
  },
  captureManifest: manifest,
  positionBaseline: {
    baselineRunId: baseline.baselineRunId,
    snapshotTime: baseline.snapshotTime,
    itemCount: baseline.items.length,
  },
  capitalEstimate,
  databasePreparation,
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
      apiSchemaErrorCount: apiContractReport.schemaErrors.length,
      apiWarnings: apiContractReport.warnings,
      captureRunId: manifest.captureRunId,
      captureStatus: manifest.status,
      sourceCodeCommit: sourceVersion.commit,
      sourceCodeDirty: sourceVersion.dirty,
      tradeHistoryComplete: trades.historyComplete,
      activityHistoryComplete: activity.historyComplete,
      positionHistoryComplete: positionHistory.historyComplete,
      tradeHistoryStopCategory: finalPaginationStatus(trades.historyComplete, trades.stopReason),
      activityHistoryStopCategory: finalPaginationStatus(activity.historyComplete, activity.stopReason),
      positionHistoryStopCategory: finalPaginationStatus(positionHistory.historyComplete, positionHistory.stopReason),
      baselineItems: baseline.items.length,
      capitalConfidence: capitalEstimate.capitalConfidence,
      goldenCandidateCount: goldenCandidates.length,
      goldenEvaluationStatus: "NOT_EVALUATED",
      trades: trades.rows.length,
      activity: activity.rows.length,
      positions: positions.data.length,
      replayStatus: replay.status,
      replayIncompleteReasons: replay.incompleteReasons,
      ambiguousEvents: replay.metrics.ambiguousEvents,
      replayHash: replay.reportHash,
      duplicateRows: replay.metrics.duplicateRows,
      reconciledPaginationOverlapRows: replay.metrics.reconciledPaginationOverlapRows,
      onChainMultiplicityProofs: tradeMultiplicityEvidence.proofs.length,
      buySignals: replay.metrics.buySignals,
      sellSignals: replay.metrics.sellSignals,
      historicalSells: replay.metrics.historicalSells,
      output: resolve(outputDirectory, `phase0-${address}.json`),
    },
    null,
    2,
  ),
);
