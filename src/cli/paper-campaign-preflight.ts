import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveSourceVersion } from "../infra/source-version.js";
import {
  buildCurrentCoreCompatibilityManifest,
  computeCoreCompatibilityHash,
} from "../paper-validation/core-compatibility.js";
import {
  assertPaperCampaignPreMigrationCompatible,
  freezePaperCampaignPreMigrationMismatch,
} from "../paper-validation/preflight.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sourceVersion = resolveSourceVersion(projectRoot);
if (sourceVersion.dirty) throw new Error("PAPER_CAMPAIGN_REQUIRES_CLEAN_SOURCE");
const manifest = buildCurrentCoreCompatibilityManifest(projectRoot);
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
    coreCompatibilityHash: computeCoreCompatibilityHash(manifest),
    safety: { executionMode: "PAPER", liveGateState: "LIVE_DISABLED", liveAllowed: false },
  }));
  throw new Error(`PAPER_CAMPAIGN_FROZEN_BEFORE_MIGRATION:${frozen.campaignId ?? "UNKNOWN"}`);
}
console.log(JSON.stringify({
  status: "PASSED",
  ...result,
  sourceCodeCommit: sourceVersion.commit,
  coreCompatibilityHash: computeCoreCompatibilityHash(manifest),
  safety: { executionMode: "PAPER", liveGateState: "LIVE_DISABLED", liveAllowed: false },
}));
