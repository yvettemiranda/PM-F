import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { RULESET_HASH, VERSIONS } from "../src/domain/versioning.js";
import { ensureProductionLiveAccount } from "../src/operator/production-live-account.js";
import { saveLiveProductionConfig } from "../src/operator/live-production-readiness.js";
import { RiskManager } from "../src/risk/risk-manager.js";

const roots: string[] = [];
const wallet = "0x0000000000000000000000000000000000000001";
const alternateWallet = "0x0000000000000000000000000000000000000002";
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

  it("updates confirmed limits without discarding immutable account history", async () => {
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
    const history = new DatabaseSync(databasePath);
    history.prepare(
      `INSERT INTO live_cash_ledger(
        cash_ledger_id,live_account_id,live_execution_id,entry_type,cash_delta_micros,
        reserved_delta_micros,cash_after_micros,reserved_after_micros,idempotency_key,created_at
      ) VALUES ('historical-cash', ?, NULL, 'TEST_HISTORY', '-1000000', '0',
        '9000000', '0', 'historical-cash', '2026-07-28T04:01:00.000Z')`,
    ).run(identity.accountId);
    history.close();
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
      expect(database.prepare(
        "SELECT COUNT(*) count FROM live_cash_ledger WHERE live_account_id=?",
      ).get(identity.accountId)).toEqual({ count: 1 });
    } finally {
      database.close();
    }
  });

  it("deactivates an empty superseded wallet account without touching its history", async () => {
    const root = mkdtempSync(join(tmpdir(), "ni-k-production-account-switch-"));
    roots.push(root);
    const databasePath = join(root, "data/runtime/ni-k.sqlite");
    const first = saveLiveProductionConfig(root, {
      walletAddress: wallet,
      tradingWalletAddress: wallet,
      signatureType: "EOA",
      network: "POLYGON",
      confirmLimits: true,
    });
    const oldAccount = await ensureProductionLiveAccount({
      projectRoot: root,
      databasePath,
      config: first,
      sourceVersion,
    });
    const second: typeof first = {
      ...first,
      walletAddress: alternateWallet,
      tradingWalletAddress: alternateWallet,
      limitsConfirmedAt: first.limitsConfirmedAt,
      updatedAt: first.updatedAt,
    };
    await ensureProductionLiveAccount({
      projectRoot: root,
      databasePath,
      config: second,
      sourceVersion,
    });
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(database.prepare(
        "SELECT status FROM live_accounts WHERE live_account_id=?",
      ).get(oldAccount.accountId)).toEqual({ status: "DISABLED" });
      expect(database.prepare(
        `SELECT w.status
         FROM live_wallets w
         JOIN live_accounts a ON a.live_wallet_id=w.live_wallet_id
         WHERE a.live_account_id=?`,
      ).get(oldAccount.accountId)).toEqual({ status: "DISABLED" });
      expect(database.prepare(
        "SELECT COUNT(*) count FROM live_wallets WHERE status='ACTIVE'",
      ).get()).toEqual({ count: 1 });
      expect(database.prepare(
        "SELECT COUNT(*) count FROM audit_log WHERE entity_id=? AND action='disabled'",
      ).get(oldAccount.accountId)).toEqual({ count: 1 });
    } finally {
      database.close();
    }
  });

  it("refuses to supersede a wallet account that still has an open position", async () => {
    const root = mkdtempSync(join(tmpdir(), "ni-k-production-account-switch-blocked-"));
    roots.push(root);
    const databasePath = join(root, "data/runtime/ni-k.sqlite");
    const first = saveLiveProductionConfig(root, {
      walletAddress: wallet,
      tradingWalletAddress: wallet,
      signatureType: "EOA",
      network: "POLYGON",
      confirmLimits: true,
    });
    const oldAccount = await ensureProductionLiveAccount({
      projectRoot: root,
      databasePath,
      config: first,
      sourceVersion,
    });
    const database = new DatabaseSync(databasePath);
    const risk = new RiskManager(database, sourceVersion).recordSystemDecision({
      mode: "LIVE",
      accountId: oldAccount.accountId,
      signalId: null,
      contextId: null,
      entityId: "open-position",
      executionType: "TARGET_BUY",
      decision: "ALLOW",
      reason: "TEST_OPEN_POSITION",
      requestedAmountMicros: 500_000n,
      requestedSizeMicros: 1_000_000n,
      now: "2026-07-28T04:00:00.000Z",
    });
    database.prepare(
      `INSERT INTO live_executions(
        live_execution_id,live_account_id,signal_id,context_id,risk_decision_id,live_gate_run_id,
        execution_idempotency_key,execution_type,state,asset_id,condition_id,requested_amount_micros,
        requested_size_micros,filled_size_micros,filled_notional_micros,fee_micros,target_price_units,
        reason,schema_version,strategy_version,risk_version,live_version,ruleset_hash,source_code_commit,
        source_code_dirty,config_version,created_at,updated_at
      ) VALUES ('open-execution', ?, NULL, NULL, ?, NULL, 'open-execution-key', 'TARGET_BUY',
        'EXECUTED', '1', '0x${"0".repeat(64)}', '500000', '1000000', '1000000', '500000', '0',
        '500000000000000000', 'TEST_OPEN_POSITION', ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    ).run(
      oldAccount.accountId,
      risk.riskDecisionId,
      VERSIONS.schemaVersion,
      VERSIONS.strategyVersion,
      VERSIONS.riskVersion,
      VERSIONS.liveVersion,
      RULESET_HASH,
      sourceVersion.commit,
      VERSIONS.configVersion,
      "2026-07-28T04:00:00.000Z",
      "2026-07-28T04:00:00.000Z",
    );
    database.prepare(
      `INSERT INTO live_positions(
        live_position_id,live_account_id,opening_execution_id,signal_id,asset_id,condition_id,outcome,
        entry_price_units,entry_size_micros,entry_notional_micros,entry_fee_micros,current_size_micros,
        remaining_cost_micros,status,frozen_from_status,frozen_reason,frozen_at,realized_pnl_micros,
        ruleset_hash,source_code_commit,source_code_dirty,config_version,created_at,updated_at
      ) VALUES ('open-position', ?, 'open-execution', NULL, '1', '0x${"0".repeat(64)}', NULL,
        '500000000000000000', '1000000', '500000', '0', '1000000', '500000', 'OPEN',
        NULL, NULL, NULL, '0', ?, ?, 0, ?, ?, ?)`,
    ).run(
      oldAccount.accountId,
      RULESET_HASH,
      sourceVersion.commit,
      VERSIONS.configVersion,
      "2026-07-28T04:00:00.000Z",
      "2026-07-28T04:00:00.000Z",
    );
    database.close();
    const second: typeof first = {
      ...first,
      walletAddress: alternateWallet,
      tradingWalletAddress: alternateWallet,
    };
    await expect(ensureProductionLiveAccount({
      projectRoot: root,
      databasePath,
      config: second,
      sourceVersion,
    })).rejects.toThrow(`LIVE_ACCOUNT_OTHER_OPEN_POSITION:${oldAccount.accountId}:open-position`);
  });
});
