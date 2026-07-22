import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  OPERATOR_ACTIVE_LOCK,
  selectedTargetWallet,
  type TargetWalletSelection,
} from "./target-wallet.js";

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
  controls: {
    targetWallet: { available: boolean; blockedReason: string | null };
    paper: { available: boolean; blockedReason: string | null };
    live: { available: false; blockedReason: "LIVE_RUNTIME_NOT_WIRED" };
    parameters: { available: false; blockedReason: "COMPILE_TIME_RULESET" };
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
  const operatorLocked = existsSync(resolve(projectRoot, OPERATOR_ACTIVE_LOCK));
  const databasePath = resolve(projectRoot, "data/phase0/phase0.sqlite");
  let executionMode: string | null = null;
  let liveGateState: string | null = null;
  let latestCampaignId: string | null = null;
  if (existsSync(databasePath)) {
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      database.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=5000;");
      if (tableExists(database, "live_gate_state")) {
        const row = database.prepare(
          "SELECT execution_mode,live_gate_state FROM live_gate_state WHERE state_id='default'",
        ).get() as { execution_mode: string; live_gate_state: string } | undefined;
        executionMode = row?.execution_mode ?? null;
        liveGateState = row?.live_gate_state ?? null;
      }
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
  const paperAvailable = executionMode === null
    || (executionMode === "PAPER" && liveGateState === "LIVE_DISABLED");
  return {
    target,
    runtime: {
      operatorLocked,
      databaseAvailable: existsSync(databasePath),
    },
    safety: {
      executionMode,
      liveGateState,
      liveAllowed: false,
    },
    campaign: { latestCampaignId },
    controls: {
      targetWallet: {
        available: !operatorLocked,
        blockedReason: operatorLocked ? "OPERATOR_LOCK_PRESENT" : null,
      },
      paper: {
        available: paperAvailable,
        blockedReason: paperAvailable ? null : "DATABASE_NOT_PAPER_LIVE_DISABLED",
      },
      live: { available: false, blockedReason: "LIVE_RUNTIME_NOT_WIRED" },
      parameters: { available: false, blockedReason: "COMPILE_TIME_RULESET" },
    },
  };
}
