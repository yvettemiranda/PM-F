import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { SourceVersion } from "../infra/source-version.js";
import { prepareRuntimeDatabase } from "../infra/sqlite/runtime-database-preparation.js";
import { LiveAccountRegistry } from "../live/live-account-registry.js";
import type { LiveProductionConfig } from "./live-production-readiness.js";

export interface ProductionLiveAccount {
  accountId: string;
  walletId: string;
}

function id(prefix: string, value: string): string {
  return `${prefix}-${createHash("sha256").update(value).digest("hex").slice(0, 24).toUpperCase()}`;
}

function deactivateSupersededAccounts(
  database: DatabaseSync,
  registry: LiveAccountRegistry,
  currentAccountId: string,
): void {
  const accounts = database.prepare(
    `SELECT live_account_id
     FROM live_accounts
     WHERE status='ACTIVE' AND live_account_id<>?
     ORDER BY created_at,live_account_id`,
  ).all(currentAccountId) as unknown as Array<{ live_account_id: string }>;
  if (accounts.length === 0) return;

  const blockers: string[] = [];
  for (const account of accounts) {
    const pendingOrder = database.prepare(
      `SELECT o.live_order_id,o.status
       FROM live_orders o
       JOIN live_executions e ON e.live_execution_id=o.live_execution_id
       WHERE e.live_account_id=? AND o.is_terminal=0
       LIMIT 1`,
    ).get(account.live_account_id) as { live_order_id: string; status: string } | undefined;
    if (pendingOrder) {
      blockers.push(`LIVE_ACCOUNT_OTHER_ACTIVE_ORDER:${account.live_account_id}:${pendingOrder.live_order_id}:${pendingOrder.status}`);
      continue;
    }
    const pendingReservation = database.prepare(
      `SELECT live_execution_id
       FROM live_reservation_ledger
       WHERE live_execution_id IN (
         SELECT live_execution_id FROM live_executions WHERE live_account_id=?
       )
       GROUP BY live_execution_id
       HAVING SUM(delta_micros)<>0
       LIMIT 1`,
    ).get(account.live_account_id) as { live_execution_id: string } | undefined;
    if (pendingReservation) {
      blockers.push(`LIVE_ACCOUNT_OTHER_ACTIVE_RESERVATION:${account.live_account_id}:${pendingReservation.live_execution_id}`);
      continue;
    }
    const pendingAssetReservation = database.prepare(
      `SELECT live_execution_id
       FROM live_asset_reservation_ledger
       WHERE live_execution_id IN (
         SELECT live_execution_id FROM live_executions WHERE live_account_id=?
       )
       GROUP BY live_execution_id
       HAVING SUM(delta_size_micros)<>0
       LIMIT 1`,
    ).get(account.live_account_id) as { live_execution_id: string } | undefined;
    if (pendingAssetReservation) {
      blockers.push(`LIVE_ACCOUNT_OTHER_ACTIVE_ASSET_RESERVATION:${account.live_account_id}:${pendingAssetReservation.live_execution_id}`);
      continue;
    }
    const activeExecution = database.prepare(
      `SELECT live_execution_id,state
       FROM live_executions
       WHERE live_account_id=?
         AND state NOT IN ('EXECUTED','EXPIRED','REJECTED','CANCELLED','FAILED','FROZEN')
       ORDER BY created_at,live_execution_id
       LIMIT 1`,
    ).get(account.live_account_id) as { live_execution_id: string; state: string } | undefined;
    if (activeExecution) {
      blockers.push(`LIVE_ACCOUNT_OTHER_ACTIVE_EXECUTION:${account.live_account_id}:${activeExecution.live_execution_id}:${activeExecution.state}`);
      continue;
    }
    const openPosition = database.prepare(
      `SELECT live_position_id
       FROM live_positions
       WHERE live_account_id=?
         AND status IN ('OPEN','PARTIALLY_CLOSED','SETTLEMENT_PENDING','FROZEN')
         AND current_size_micros<>'0'
       LIMIT 1`,
    ).get(account.live_account_id) as { live_position_id: string } | undefined;
    if (openPosition) {
      blockers.push(`LIVE_ACCOUNT_OTHER_OPEN_POSITION:${account.live_account_id}:${openPosition.live_position_id}`);
    }
  }
  if (blockers.length > 0) {
    throw new Error(blockers[0]);
  }
  for (const account of accounts) {
    registry.disable({
      liveAccountId: account.live_account_id,
      actor: "PRODUCTION_RUNTIME",
      reason: "SUPERSEDED_BY_CURRENT_TRADING_WALLET",
    });
  }
}

/**
 * Registers only public wallet/account metadata for the connected production
 * runtime. It never changes the global Live Gate. Saved allocation changes
 * update the account's future risk envelope while every prior execution and
 * ledger row remains immutable and independently auditable.
 */
export async function ensureProductionLiveAccount(input: {
  projectRoot: string;
  databasePath: string;
  config: LiveProductionConfig;
  sourceVersion: SourceVersion;
  now?: () => Date;
}): Promise<ProductionLiveAccount> {
  const now = input.now ?? (() => new Date());
  const signerAddress = input.config.walletAddress;
  const tradingWalletAddress = input.config.tradingWalletAddress;
  if (signerAddress === null || tradingWalletAddress === null || input.config.network !== "POLYGON") {
    throw new Error("LIVE_ACCOUNT_PRODUCTION_IDENTITY_INCOMPLETE");
  }
  await prepareRuntimeDatabase({
    databasePath: input.databasePath,
    sourceVersion: input.sourceVersion,
  });
  const walletId = id("LIVE-WALLET", tradingWalletAddress);
  const accountId = id("LIVE-ACCOUNT", tradingWalletAddress);
  const timestamp = now().toISOString();
  const database = new DatabaseSync(input.databasePath);
  database.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;");
  try {
    const existingWallet = database.prepare(
      "SELECT live_wallet_id,wallet_type,network FROM live_wallets WHERE wallet_address=?",
    ).get(tradingWalletAddress) as {
      live_wallet_id: string;
      wallet_type: string;
      network: string;
    } | undefined;
    if (
      existingWallet
      && (
        existingWallet.live_wallet_id !== walletId
        || existingWallet.wallet_type !== input.config.signatureType
        || existingWallet.network !== "POLYGON"
      )
    ) {
      throw new Error("LIVE_WALLET_CONFIGURATION_CONFLICT");
    }
    if (!existingWallet) {
      database.prepare(
        `INSERT INTO live_wallets(
          live_wallet_id,wallet_address,wallet_type,network,status,created_at,updated_at
        ) VALUES (?, ?, ?, 'POLYGON', 'ACTIVE', ?, ?)`,
      ).run(walletId, tradingWalletAddress, input.config.signatureType, timestamp, timestamp);
    } else {
      database.prepare(
        "UPDATE live_wallets SET status='ACTIVE',updated_at=? WHERE live_wallet_id=?",
      ).run(timestamp, walletId);
    }

    const registry = new LiveAccountRegistry(database, input.sourceVersion, now);
    deactivateSupersededAccounts(database, registry, accountId);
    const account = registry.get(accountId);
    if (account === null) {
      registry.register({
        liveAccountId: accountId,
        liveWalletId: walletId,
        name: "Hecatonchires Live",
        initialBankrollMicros: BigInt(input.config.liveBankrollMicros),
        riskBudgetMicros: BigInt(input.config.maxExposureMicros),
        signalCutoffAt: timestamp,
        authorizedSignerAddress: signerAddress,
        actor: "PRODUCTION_RUNTIME",
        reason: "CONNECTED_WALLET_ACCOUNT_REGISTRATION",
      });
    } else {
      if (account.liveWalletId !== walletId || account.authorizedSignerAddress !== signerAddress) {
        throw new Error("LIVE_ACCOUNT_CONFIGURATION_CONFLICT");
      }
      const limitsChanged = account.initialBankrollMicros !== input.config.liveBankrollMicros
        || account.riskBudgetMicros !== input.config.maxExposureMicros;
      if (limitsChanged) {
        const cashRows = database.prepare(
          "SELECT cash_delta_micros FROM live_cash_ledger WHERE live_account_id=?",
        ).all(accountId) as unknown as Array<{ cash_delta_micros: string }>;
        const cashDelta = cashRows.reduce(
          (total, row) => total + BigInt(row.cash_delta_micros),
          0n,
        );
        if (BigInt(input.config.liveBankrollMicros) + cashDelta < 0n) {
          throw new Error("LIVE_ACCOUNT_BANKROLL_BELOW_LEDGER_LOSSES");
        }
        if (account.status === "ACTIVE") {
          registry.disable({
            liveAccountId: accountId,
            actor: "PRODUCTION_RUNTIME",
            reason: "PREPARE_LIVE_LIMIT_UPDATE",
          });
        }
        database.prepare(
          `UPDATE live_accounts
           SET initial_bankroll_micros=?,risk_budget_micros=?,signal_cutoff_at=?,updated_at=?
           WHERE live_account_id=? AND status='DISABLED'`,
        ).run(
          input.config.liveBankrollMicros,
          input.config.maxExposureMicros,
          timestamp,
          timestamp,
          accountId,
        );
        database.prepare(
          `INSERT INTO audit_log(
            audit_id,timestamp,entity_type,entity_id,action,reason,ruleset_hash,
            source_code_commit,source_code_dirty,config_version,metadata_json
          )
          SELECT ?,?,'LIVE_ACCOUNT',?,'live_limits_updated',
                 'OPERATOR_CONFIRMED_LIVE_LIMITS',ruleset_hash,?,?,config_version,?
          FROM live_accounts WHERE live_account_id=?`,
        ).run(
          randomUUID(),
          timestamp,
          accountId,
          input.sourceVersion.commit,
          input.sourceVersion.dirty ? 1 : 0,
          JSON.stringify({
            previousInitialBankrollMicros: account.initialBankrollMicros,
            previousRiskBudgetMicros: account.riskBudgetMicros,
            initialBankrollMicros: input.config.liveBankrollMicros,
            riskBudgetMicros: input.config.maxExposureMicros,
          }),
          accountId,
        );
      }
    }
    registry.activate({
      liveAccountId: accountId,
      actor: "PRODUCTION_RUNTIME",
      reason: "CONNECTED_WALLET_RUNTIME_READY",
    });
    return { accountId, walletId };
  } finally {
    database.close();
  }
}
