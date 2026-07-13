import { resolve } from "node:path";
import type { PublicActivity, PublicPosition, PublicProfile, PublicTrade } from "../domain/models.js";
import { Phase0Database } from "../infra/sqlite/database.js";
import { resolveSourceVersion } from "../infra/source-version.js";
import { ReplayEngine } from "../replay/replay-engine.js";
import { buildWalletIdentityReport } from "../services/wallet-identity.js";

const captureRunId = process.argv.slice(2).find((argument) => /^[a-f0-9]{64}$/.test(argument));
if (!captureRunId) throw new Error("Usage: pnpm phase05:replay-capture -- <capture-run-id>");

const sourceVersion = resolveSourceVersion();
const database = new Phase0Database(resolve("data/phase0/phase0.sqlite"), sourceVersion);
database.initialize();
try {
  const captureRun = database.loadCaptureRun(captureRunId);
  if (sourceVersion.dirty) throw new Error("Current source tree is dirty; deterministic capture replay is blocked");
  if (captureRun.sourceCodeDirty) throw new Error("Capture was produced by a dirty source tree; deterministic verification is blocked");
  if (captureRun.sourceCodeCommit !== sourceVersion.commit) {
    throw new Error(`Source commit mismatch: capture=${captureRun.sourceCodeCommit} current=${sourceVersion.commit}`);
  }

  const flatten = <T>(endpoint: string): T[] => database.loadCapturePayloads(captureRunId, endpoint)
    .flatMap((payload) => Array.isArray(payload) ? payload as T[] : []);
  const single = <T>(endpoint: string): T => {
    const payload = database.loadCapturePayloads(captureRunId, endpoint)[0];
    if (payload === undefined) throw new Error(`Capture endpoint missing: ${endpoint}`);
    return payload as T;
  };
  const trades = flatten<PublicTrade>("data-trades");
  const activity = flatten<PublicActivity>("data-activity");
  const positions = flatten<PublicPosition>("data-positions");
  const profile = single<PublicProfile>("gamma-public-profile");
  const code = single<{ result?: string }>("polygon-eth-get-code");
  const safePayloads = database.loadCapturePayloads(captureRunId, "relayer-safe");
  const walletPayloads = database.loadCapturePayloads(captureRunId, "relayer-wallet");
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
  const replay = new ReplayEngine().run({
    walletAddress: captureRun.walletAddress,
    identityStatus: identity.status,
    trades,
    activity,
    hasCapitalSnapshots: false,
    hasGoldenExpectations: false,
    hasPositionBaseline: false,
    tradeHistoryComplete: database.captureEndpointWasComplete(captureRunId, "data-trades"),
    activityHistoryComplete: database.captureEndpointWasComplete(captureRunId, "data-activity"),
    sourceCodeCommit: sourceVersion.commit,
    sourceCodeDirty: sourceVersion.dirty,
  });
  const storedHashes = database.loadReplayHashes(captureRunId);
  const stable = storedHashes.length > 0 && storedHashes.every((hash) => hash === replay.reportHash);
  console.log(JSON.stringify({
    captureRunId,
    manifestHash: captureRun.manifestHash,
    sourceCodeCommit: sourceVersion.commit,
    replayHash: replay.reportHash,
    storedReplayHashes: storedHashes,
    stable,
  }, null, 2));
  if (!stable) process.exitCode = 2;
} finally {
  database.close();
}
