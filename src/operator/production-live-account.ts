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

function count(database: DatabaseSync, query: string, accountId: string): number {
  const row = database.prepare(query).get(accountId) as { count: number };
  return Number(row.count);
}

/**
 * Registers only public wallet/account metadata for the connected production
 * runtime. It never changes the global Live Gate. Existing accounts can absorb
 * new limits only before they have any execution, position or ledger history;
 * otherwise the immutable portfolio history wins and the change fails closed.
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
    const account = registry.get(accountId);
    if (account === null) {
      registry.register({
        liveAccountId: accountId,
        liveWalletId: walletId,
        name: "Hecatonchires Small Live",
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
        const historyCount = [
          count(database, "SELECT COUNT(*) count FROM live_executions WHERE live_account_id=?", accountId),
          count(database, "SELECT COUNT(*) count FROM live_positions WHERE live_account_id=?", accountId),
          count(database, "SELECT COUNT(*) count FROM live_cash_ledger WHERE live_account_id=?", accountId),
        ].reduce((total, value) => total + value, 0);
        if (historyCount > 0) throw new Error("LIVE_ACCOUNT_LIMIT_CHANGE_REQUIRES_NEW_PORTFOLIO");
        if (account.status === "ACTIVE") {
          registry.disable({
            liveAccountId: accountId,
            actor: "PRODUCTION_RUNTIME",
            reason: "PREPARE_SMALL_LIMIT_UPDATE",
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
          SELECT ?,?,'LIVE_ACCOUNT',?,'small_live_limits_updated',
                 'OPERATOR_CONFIRMED_SMALL_LIMITS',ruleset_hash,?,?,config_version,?
          FROM live_accounts WHERE live_account_id=?`,
        ).run(
          randomUUID(),
          timestamp,
          accountId,
          input.sourceVersion.commit,
          input.sourceVersion.dirty ? 1 : 0,
          JSON.stringify({
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
