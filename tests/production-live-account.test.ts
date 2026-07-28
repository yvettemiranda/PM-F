import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { ensureProductionLiveAccount } from "../src/operator/production-live-account.js";
import { saveLiveProductionConfig } from "../src/operator/live-production-readiness.js";

const roots: string[] = [];
const wallet = "0x0000000000000000000000000000000000000001";
const sourceVersion = { commit: "a".repeat(40), dirty: false };

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("ensureProductionLiveAccount", () => {
  it("creates an active public-identity account without changing the Live Gate", async () => {
    const root = mkdtempSync(join(tmpdir(), "ni-k-production-account-"));
    roots.push(root);
    const databasePath = join(root, "data/runtime/ni-k.sqlite");
    const config = saveLiveProductionConfig(root, {
      walletAddress: wallet,
      tradingWalletAddress: wallet,
      signatureType: "EOA",
      network: "POLYGON",
      confirmLimits: true,
    });
    const result = await ensureProductionLiveAccount({
      projectRoot: root,
      databasePath,
      config,
      sourceVersion,
      now: () => new Date("2026-07-28T04:00:00.000Z"),
    });
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(database.prepare(
        `SELECT a.status,a.initial_bankroll_micros,a.risk_budget_micros,
                a.authorized_signer_address,w.wallet_address,w.status wallet_status
         FROM live_accounts a JOIN live_wallets w ON w.live_wallet_id=a.live_wallet_id
         WHERE a.live_account_id=?`,
      ).get(result.accountId)).toMatchObject({
        status: "ACTIVE",
        initial_bankroll_micros: "10000000",
        risk_budget_micros: "3000000",
        authorized_signer_address: wallet,
        wallet_address: wallet,
        wallet_status: "ACTIVE",
      });
      const gate = database.prepare(
        "SELECT execution_mode,live_gate_state FROM live_gate_state WHERE state_id='default'",
      ).get() as { execution_mode: string; live_gate_state: string } | undefined;
      expect(gate).toEqual({
        execution_mode: "PAPER",
        live_gate_state: "LIVE_DISABLED",
      });
    } finally {
      database.close();
    }
  });

  it("updates confirmed limits only while the account has no trading history", async () => {
    const root = mkdtempSync(join(tmpdir(), "ni-k-production-account-limits-"));
    roots.push(root);
    const databasePath = join(root, "data/runtime/ni-k.sqlite");
    const first = saveLiveProductionConfig(root, {
      walletAddress: wallet,
      network: "POLYGON",
      confirmLimits: true,
    });
    const identity = await ensureProductionLiveAccount({
      projectRoot: root,
      databasePath,
      config: first,
      sourceVersion,
    });
    const second = saveLiveProductionConfig(root, {
      liveBankrollMicros: "9000000",
      maxExposureMicros: "2500000",
      confirmLimits: true,
    });
    await ensureProductionLiveAccount({
      projectRoot: root,
      databasePath,
      config: second,
      sourceVersion,
    });
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(database.prepare(
        "SELECT initial_bankroll_micros,risk_budget_micros,status FROM live_accounts WHERE live_account_id=?",
      ).get(identity.accountId)).toMatchObject({
        initial_bankroll_micros: "9000000",
        risk_budget_micros: "2500000",
        status: "ACTIVE",
      });
    } finally {
      database.close();
    }
  });
});
