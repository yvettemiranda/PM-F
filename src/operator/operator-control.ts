import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  selectedTargetWallet,
  type TargetWalletSelection,
} from "./target-wallet.js";
import {
  DEFAULT_VERSIONS,
  OPERATOR_RULESET_PROFILE_CONTEXT,
  buildPaperRulesetSnapshotJson,
  buildRulesetSnapshotJson,
} from "../domain/versioning.js";
import { selectedRulesetProfile } from "./ruleset-profile.js";
import {
  OPERATOR_DATABASE_FILE,
  operatorRuntimeSafety,
} from "./operator-mutation-guard.js";

export interface OperatorControlSnapshot {
  target: TargetWalletSelection;
  runtime: {
    operatorLocked: boolean;
    databaseAvailable: boolean;
  };
  safety: {
    executionMode: string | null;
    liveGateState: string | null;
    liveAllowed: false;
  };
  campaign: {
    latestCampaignId: string | null;
  };
  ruleset: {
    source: "PROJECT_DEFAULT" | "OPERATOR_PROFILE";
    name: string;
    configVersion: string;
    parameterHash: string;
    rulesetHash: string;
    paperRulesetHash: string;
    rules: Readonly<Record<string, string | number | boolean>>;
  };
  controls: {
    targetWallet: { available: boolean; blockedReason: string | null };
    paper: { available: boolean; blockedReason: string | null };
    live: { available: false; blockedReason: "LIVE_UI_NOT_IMPLEMENTED" };
    parameters: {
      available: boolean;
      blockedReason: string | null;
      appliesOnNextCampaign: true;
      editableKeys: readonly string[];
    };
  };
}

function tableExists(database: DatabaseSync, table: string): boolean {
  return database.prepare(
    "SELECT 1 ok FROM sqlite_master WHERE type='table' AND name=?",
  ).get(table) !== undefined;
}

/**
 * Read-only control-plane projection intended for the future localhost UI.
 * It reports unavailable controls honestly; it never initializes the database,
 * transitions the Live Gate, or derives account balances.
 */
export function operatorControlSnapshot(projectRoot: string): OperatorControlSnapshot {
  const target = selectedTargetWallet(projectRoot);
  const ruleset = selectedRulesetProfile(projectRoot, OPERATOR_RULESET_PROFILE_CONTEXT);
  const versions = { ...DEFAULT_VERSIONS, configVersion: ruleset.configVersion };
  const rulesetHash = createHash("sha256")
    .update(buildRulesetSnapshotJson(versions, ruleset.rules))
    .digest("hex");
  const paperRulesetHash = createHash("sha256")
    .update(buildPaperRulesetSnapshotJson(versions, ruleset.rules))
    .digest("hex");
  const runtimeSafety = operatorRuntimeSafety(projectRoot);
  const databasePath = resolve(projectRoot, OPERATOR_DATABASE_FILE);
  let latestCampaignId: string | null = null;
  if (runtimeSafety.databaseAvailable) {
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      database.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=5000;");
      if (tableExists(database, "paper_validation_campaigns") && tableExists(database, "monitor_targets")) {
        const row = database.prepare(
          `SELECT c.campaign_id
           FROM paper_validation_campaigns c
           JOIN monitor_targets t ON t.target_id=c.target_id
           WHERE lower(t.wallet_address)=?
           ORDER BY c.created_at DESC,c.campaign_id DESC LIMIT 1`,
        ).get(target.walletAddress) as { campaign_id: string } | undefined;
        latestCampaignId = row?.campaign_id ?? null;
      }
    } finally {
      database.close();
    }
  }
  const paperAvailable = !runtimeSafety.databaseAvailable
    || (runtimeSafety.executionMode === "PAPER" && runtimeSafety.liveGateState === "LIVE_DISABLED");
  const mutationAvailable = runtimeSafety.mutationBlockedReason === null;
  return {
    target,
    runtime: {
      operatorLocked: runtimeSafety.operatorLocked,
      databaseAvailable: runtimeSafety.databaseAvailable,
    },
    safety: {
      executionMode: runtimeSafety.executionMode,
      liveGateState: runtimeSafety.liveGateState,
      liveAllowed: false,
    },
    campaign: { latestCampaignId },
    ruleset: {
      source: ruleset.source,
      name: ruleset.name,
      configVersion: ruleset.configVersion,
      parameterHash: ruleset.parameterHash,
      rulesetHash,
      paperRulesetHash,
      rules: ruleset.rules,
    },
    controls: {
      targetWallet: {
        available: mutationAvailable,
        blockedReason: runtimeSafety.mutationBlockedReason,
      },
      paper: {
        available: paperAvailable,
        blockedReason: paperAvailable ? null : "DATABASE_NOT_PAPER_LIVE_DISABLED",
      },
      live: { available: false, blockedReason: "LIVE_UI_NOT_IMPLEMENTED" },
      parameters: {
        available: mutationAvailable,
        blockedReason: runtimeSafety.mutationBlockedReason,
        appliesOnNextCampaign: true,
        editableKeys: OPERATOR_RULESET_PROFILE_CONTEXT.editableKeys,
      },
    },
  };
}
