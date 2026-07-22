import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveSourceVersion } from "../infra/source-version.js";
import {
  buildCurrentCompatibilityEvidence,
  buildCurrentCoreCompatibilityManifest,
  computeCoreCompatibilityHash,
} from "../paper-validation/core-compatibility.js";
import { checkPaperCampaignClockSafety } from "../paper-validation/clock-safety.js";
import { normalizeTargetWallet } from "../operator/target-wallet.js";
import {
  paperCampaignReplacementAuthorized,
  paperCompatibilityRevalidationRequired,
} from "../paper-validation/operator-policy.js";
import {
  preparePaperCampaignPreMigration,
} from "../paper-validation/preflight.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const targetWallet = normalizeTargetWallet(process.argv.slice(2)
  .find((argument) => argument.startsWith("--target-wallet="))
  ?.slice("--target-wallet=".length));
const sourceVersion = resolveSourceVersion(projectRoot);
if (sourceVersion.dirty) throw new Error("PAPER_CAMPAIGN_REQUIRES_CLEAN_SOURCE");
const manifest = buildCurrentCoreCompatibilityManifest(projectRoot);
const coreCompatibilityHash = computeCoreCompatibilityHash(manifest);
const compatibilityEvidence = buildCurrentCompatibilityEvidence(projectRoot);
const clockSafety = await checkPaperCampaignClockSafety();
if (clockSafety.status !== "PASSED") {
  console.error(JSON.stringify({
    status: "BLOCKED",
    reason: "CLOCK_SAFETY_FAILED",
    clockSafety,
    sourceCodeCommit: sourceVersion.commit,
    coreCompatibilityHash,
    safety: { executionMode: "PAPER", liveGateState: "LIVE_DISABLED", liveAllowed: false },
  }));
  throw new Error(`PAPER_CAMPAIGN_CLOCK_SAFETY_BLOCKED:${clockSafety.reason ?? "UNKNOWN"}`);
}
const databasePath = resolve(projectRoot, "data/phase0/phase0.sqlite");
const result = preparePaperCampaignPreMigration({
  databasePath,
  manifest,
  sourceVersion,
  now: new Date().toISOString(),
  targetWallet,
});
if (result.mismatchFrozen) {
  console.error(JSON.stringify({
    status: "CONTINUING",
    event: "OLD_CORE_CAMPAIGN_FROZEN_FOR_REPLACEMENT",
    campaignId: result.campaignId,
    campaignState: result.campaignState,
    sourceCodeCommit: sourceVersion.commit,
    coreCompatibilityHash,
    safety: { executionMode: "PAPER", liveGateState: "LIVE_DISABLED", liveAllowed: false },
  }));
}
console.log(JSON.stringify({
  status: "PASSED",
  ...result,
  replacementRequired: result.campaignId !== null
    && result.campaignCoreCompatibilityHash !== null
    && paperCampaignReplacementAuthorized({
      campaignState: result.campaignState ?? "UNKNOWN",
      previousCoreCompatibilityHash: result.campaignCoreCompatibilityHash,
      currentCoreCompatibilityHash: coreCompatibilityHash,
    }),
  terminalRevalidationRequired: result.campaignState === "PASSED"
    && result.campaignCoreCompatibilityHash === coreCompatibilityHash
    && paperCompatibilityRevalidationRequired(
      result.latestCompatibilityIdentity,
      compatibilityEvidence,
    ),
  sourceCodeCommit: sourceVersion.commit,
  coreCompatibilityHash,
  targetWallet,
  clockSafety,
  safety: { executionMode: "PAPER", liveGateState: "LIVE_DISABLED", liveAllowed: false },
}));
