import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PolymarketPublicApi, type ApiCapture } from "../adapters/polymarket-public.js";
import { Phase0Database } from "../infra/sqlite/database.js";
import { ReplayEngine } from "../replay/replay-engine.js";
import { buildWalletIdentityReport } from "../services/wallet-identity.js";
import { validateApiContract } from "../services/api-contract.js";
import { RULESET_HASH, RULESET_SNAPSHOT_JSON, VERSIONS } from "../domain/versioning.js";

const address = process.argv.slice(2).find((argument) => /^0x[a-fA-F0-9]{40}$/.test(argument))?.toLowerCase();
if (!address || !/^0x[a-f0-9]{40}$/.test(address)) {
  throw new Error("Usage: pnpm phase0:validate -- 0x<40-hex-address>");
}

const outputDirectory = resolve("data/phase0");
await mkdir(outputDirectory, { recursive: true });

const api = new PolymarketPublicApi();
const [profile, trades, activity, positions, code, safe, wallet, clobTime] = await Promise.all([
  api.profile(address),
  api.trades(address),
  api.activity(address),
  api.positions(address),
  api.contractCode(address),
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

const replay = new ReplayEngine().run({
  walletAddress: address,
  identityStatus: identity.status,
  trades: trades.rows,
  activity: activity.rows,
  hasCapitalSnapshots: false,
  hasGoldenExpectations: false,
  hasPositionBaseline: false,
  tradeHistoryComplete: trades.historyComplete,
  activityHistoryComplete: activity.historyComplete,
  sourceCodeCommit: process.env.SOURCE_CODE_COMMIT ?? "UNCOMMITTED",
});

const database = new Phase0Database(resolve(outputDirectory, "phase0.sqlite"));
database.initialize();
database.saveIdentity(identity);

const captures: Array<[string, ApiCapture<unknown>]> = [
  ["gamma-public-profile", profile],
  ["data-positions", positions],
  ["polygon-eth-get-code", code],
  ["clob-time", clobTime],
  ...trades.captures.map((capture): [string, ApiCapture<unknown>] => ["data-trades", capture]),
  ...activity.captures.map((capture): [string, ApiCapture<unknown>] => ["data-activity", capture]),
];
if (safe) captures.push(["relayer-safe", safe]);
if (wallet) captures.push(["relayer-wallet", wallet]);
for (const [endpoint, capture] of captures) database.saveCapture(endpoint, capture);

const targetId = database.ensureTarget(address, identity.status);
const replayRunId = database.saveReplay(targetId, trades.rows, replay);
database.close();

const envelope = {
  generatedAt: new Date().toISOString(),
  versions: VERSIONS,
  rulesetHash: RULESET_HASH,
  rulesetSnapshotJson: RULESET_SNAPSHOT_JSON,
  sourceCodeCommit: process.env.SOURCE_CODE_COMMIT ?? "UNCOMMITTED",
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
  replayRunId,
  replay,
};

await writeFile(resolve(outputDirectory, `phase0-${address}.json`), JSON.stringify(envelope, null, 2));

console.log(
  JSON.stringify(
    {
      target: address,
      identityStatus: identity.status,
      walletType: identity.walletType,
      apiContractStatus: apiContractReport.status,
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
