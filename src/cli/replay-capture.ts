import { resolve } from "node:path";
import { exactPaginationBoundaryOverlaps } from "../adapters/polymarket-public.js";
import type { PublicActivity, PublicPosition, PublicProfile, PublicTrade } from "../domain/models.js";
import { activityAsTrade } from "../domain/activity-trade.js";
import { preparePhase0ValidationDatabase } from "../infra/sqlite/phase0-validation-database.js";
import { resolveSourceVersion } from "../infra/source-version.js";
import { ReplayEngine } from "../replay/replay-engine.js";
import { buildWalletIdentityReport } from "../services/wallet-identity.js";
import type { PolygonTransactionReceiptResponse } from "../adapters/polygon-receipt.js";
import {
  assertStoredTradeMultiplicityProofDocument,
  verifyTradeMultiplicityEvidence,
} from "../services/trade-multiplicity-evidence.js";

const captureRunId = process.argv.slice(2).find((argument) => /^[a-f0-9]{64}$/.test(argument));
if (!captureRunId) throw new Error("Usage: pnpm phase05:replay-capture -- <capture-run-id>");

const sourceVersion = resolveSourceVersion();
const { database } = await preparePhase0ValidationDatabase({
  databasePath: resolve("data/phase0/phase0.sqlite"),
  sourceVersion,
});
try {
  const captureRun = database.loadCaptureRun(captureRunId);
  if (sourceVersion.dirty) throw new Error("Current source tree is dirty; deterministic capture replay is blocked");
  if (captureRun.sourceCodeDirty) throw new Error("Capture was produced by a dirty source tree; deterministic verification is blocked");
  if (captureRun.sourceCodeCommit !== sourceVersion.commit) {
    throw new Error(`Source commit mismatch: capture=${captureRun.sourceCodeCommit} current=${sourceVersion.commit}`);
  }

  const pages = <T>(endpoint: string): T[][] => database.loadCapturePayloads(captureRunId, endpoint)
    .flatMap((payload) => Array.isArray(payload) ? [payload as T[]] : []);
  const flatten = <T>(endpoint: string): T[] => pages<T>(endpoint).flat();
  const single = <T>(endpoint: string): T => {
    const payload = database.loadCapturePayloads(captureRunId, endpoint)[0];
    if (payload === undefined) throw new Error(`Capture endpoint missing: ${endpoint}`);
    return payload as T;
  };
  const tradePages = pages<PublicTrade>("data-trades");
  const activityPages = pages<PublicActivity>("data-activity");
  const trades = tradePages.flat();
  const activity = activityPages.flat();
  const tradePaginationBoundaryOverlaps = exactPaginationBoundaryOverlaps(tradePages);
  const activityPaginationBoundaryOverlaps = exactPaginationBoundaryOverlaps(activityPages).flatMap((item) => {
    const trade = activityAsTrade(item);
    return trade ? [trade] : [];
  });
  const positions = flatten<PublicPosition>("data-positions");
  const profile = single<PublicProfile>("gamma-public-profile");
  const code = single<{ result?: string }>("polygon-eth-get-code");
  const safePayloads = database.loadCapturePayloads(captureRunId, "relayer-safe");
  const walletPayloads = database.loadCapturePayloads(captureRunId, "relayer-wallet");
  const receiptCaptures = database
    .loadCapturePayloads(captureRunId, "polygon-transaction-receipt")
    .map((data, index) => ({
      url: `captured://polygon-transaction-receipt/${index}`,
      fetchedAt: "1970-01-01T00:00:00.000Z",
      latencyMs: 0,
      status: 200,
      data: data as PolygonTransactionReceiptResponse,
    }));
  const tradeMultiplicityEvidence = verifyTradeMultiplicityEvidence({
    walletAddress: captureRun.walletAddress,
    trades,
    activity,
    receipts: receiptCaptures,
    tradePaginationBoundaryOverlaps,
    activityPaginationBoundaryOverlaps,
  });
  assertStoredTradeMultiplicityProofDocument(
    captureRun.walletAddress,
    tradeMultiplicityEvidence,
    database.loadCapturePayloads(captureRunId, "derived-trade-multiplicity-evidence"),
  );
  const identity = buildWalletIdentityReport({
    address: captureRun.walletAddress,
    profile,
    trades,
    positions,
    contractCode: code.result ?? null,
    relayerSafeDeployed: (safePayloads[0] as { deployed?: boolean } | undefined)?.deployed ?? null,
    relayerWalletDeployed: (walletPayloads[0] as { deployed?: boolean } | undefined)?.deployed ?? null,
    tradeHistoryComplete: database.captureEndpointWasComplete(captureRunId, "data-trades"),
  });
  const tradeHistoryComplete = database.captureEndpointWasComplete(captureRunId, "data-trades");
  const activityHistoryComplete = database.captureEndpointWasComplete(captureRunId, "data-activity");
  const positionHistoryComplete = database.captureEndpointWasComplete(captureRunId, "data-positions");
  const replay = new ReplayEngine().run({
    targetId: captureRun.targetId,
    walletAddress: captureRun.walletAddress,
    identityStatus: identity.status,
    trades,
    activity,
    hasCapitalSnapshots: false,
    hasGoldenExpectations: false,
    hasPositionBaseline: false,
    tradeHistoryComplete,
    activityHistoryComplete,
    tradePaginationBoundaryOverlaps,
    activityPaginationBoundaryOverlaps,
    confirmedTradeOccurrenceCounts: tradeMultiplicityEvidence.confirmedOccurrenceCounts,
    sourceCodeCommit: sourceVersion.commit,
    sourceCodeDirty: sourceVersion.dirty,
  });
  const storedHashes = database.loadReplayHashes(captureRunId);
  const stable = storedHashes.length > 0 && storedHashes.every((hash) => hash === replay.reportHash);
  console.log(JSON.stringify({
    captureRunId,
    manifestHash: captureRun.manifestHash,
    sourceCodeCommit: sourceVersion.commit,
    sourceCodeDirty: sourceVersion.dirty,
    identityStatus: identity.status,
    tradeHistoryComplete,
    activityHistoryComplete,
    positionHistoryComplete,
    replayStatus: replay.status,
    replayIncompleteReasons: replay.incompleteReasons,
    reconciledPaginationOverlapRows: replay.metrics.reconciledPaginationOverlapRows,
    onChainMultiplicityProofs: tradeMultiplicityEvidence.proofs.length,
    replayHash: replay.reportHash,
    storedReplayHashes: storedHashes,
    stable,
  }, null, 2));
  if (!stable) process.exitCode = 2;
} finally {
  database.close();
}
