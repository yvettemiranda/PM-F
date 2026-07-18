import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveSourceVersion } from "../infra/source-version.js";
import {
  buildCurrentCoreCompatibilityManifest,
  computeCoreCompatibilityHash,
} from "../paper-validation/core-compatibility.js";
import { checkPaperCampaignClockSafety } from "../paper-validation/clock-safety.js";
import { paperCampaignReplacementAuthorized } from "../paper-validation/operator-policy.js";
import {
  assertPaperCampaignPreMigrationCompatible,
  freezePaperCampaignPreMigrationMismatch,
} from "../paper-validation/preflight.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sourceVersion = resolveSourceVersion(projectRoot);
if (sourceVersion.dirty) throw new Error("PAPER_CAMPAIGN_REQUIRES_CLEAN_SOURCE");
const manifest = buildCurrentCoreCompatibilityManifest(projectRoot);
const coreCompatibilityHash = computeCoreCompatibilityHash(manifest);
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
let result: ReturnType<typeof assertPaperCampaignPreMigrationCompatible>;
try {
  result = assertPaperCampaignPreMigrationCompatible({ databasePath, manifest });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (!message.startsWith("ACTIVE_CAMPAIGN_CORE_MISMATCH_BEFORE_MIGRATION:")) throw error;
  const frozen = freezePaperCampaignPreMigrationMismatch({
    databasePath,
    manifest,
    sourceVersion,
    now: new Date().toISOString(),
  });
  console.error(JSON.stringify({
    status: "FROZEN",
    reason: "CORE_COMPATIBILITY_MISMATCH_BEFORE_MIGRATION",
    ...frozen,
    sourceCodeCommit: sourceVersion.commit,
    coreCompatibilityHash,
    safety: { executionMode: "PAPER", liveGateState: "LIVE_DISABLED", liveAllowed: false },
  }));
  throw new Error(`PAPER_CAMPAIGN_FROZEN_BEFORE_MIGRATION:${frozen.campaignId ?? "UNKNOWN"}`);
}
console.log(JSON.stringify({
  status: "PASSED",
  ...result,
  replacementRequired: result.campaignId !== null
    && result.campaignCoreCompatibilityHash !== null
    && paperCampaignReplacementAuthorized({
      campaignState: result.campaignState ?? "UNKNOWN",
      blockers: result.campaignBlockers,
      previousCoreCompatibilityHash: result.campaignCoreCompatibilityHash,
      currentCoreCompatibilityHash: coreCompatibilityHash,
    }),
  sourceCodeCommit: sourceVersion.commit,
  coreCompatibilityHash,
  clockSafety,
  safety: { executionMode: "PAPER", liveGateState: "LIVE_DISABLED", liveAllowed: false },
}));
