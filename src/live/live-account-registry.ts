import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { RULESET_HASH, stableJson, VERSIONS } from "../domain/versioning.js";
import type { SourceVersion } from "../infra/source-version.js";

export type LiveAccountStatus = "DISABLED" | "ACTIVE" | "CLOSED";

export interface LiveAccount {
  liveAccountId: string;
  liveWalletId: string;
  walletStatus: "REGISTERED" | "ACTIVE" | "DISABLED";
  authorizedSignerAddress: string | null;
  name: string;
  status: LiveAccountStatus;
  initialBankrollMicros: string;
  riskBudgetMicros: string;
  signalCutoffAt: string;
  activatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RegisterLiveAccountInput {
  liveAccountId: string;
  liveWalletId: string;
  name: string;
  initialBankrollMicros: bigint;
  riskBudgetMicros: bigint;
  signalCutoffAt: string;
  authorizedSignerAddress?: string;
  actor: string;
  reason: string;
}

export interface ChangeLiveAccountStateInput {
  liveAccountId: string;
  actor: string;
  reason: string;
}

interface LiveAccountRow {
  live_account_id: string;
  live_wallet_id: string;
  wallet_status: "REGISTERED" | "ACTIVE" | "DISABLED";
  authorized_signer_address: string | null;
  name: string;
  status: LiveAccountStatus;
  initial_bankroll_micros: string;
  risk_budget_micros: string;
  signal_cutoff_at: string;
  activated_at: string | null;
  created_at: string;
  updated_at: string;
}

function hash(parts: string[]): string {
  return createHash("sha256").update(parts.join("|")).digest("hex");
}

function required(value: string, reason: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(reason);
  return normalized;
}

function validTimestamp(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error("LIVE_ACCOUNT_SIGNAL_CUTOFF_INVALID");
  return new Date(timestamp).toISOString();
}

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

function validAddress(value: string, reason: string): string {
  const normalized = value.trim();
  if (!EVM_ADDRESS_RE.test(normalized)) throw new Error(reason);
  return normalized.toLowerCase();
}

/**
 * Persists Live risk-account and public signer identity metadata only. This
 * registry intentionally has no credential, private-key, allowance, or
 * authenticated CLOB capability.
 */
export class LiveAccountRegistry {
  constructor(
    private readonly database: DatabaseSync,
    private readonly sourceVersion: SourceVersion,
    private readonly now: () => Date = () => new Date(),
  ) {}

  register(input: RegisterLiveAccountInput): LiveAccount {
    const liveAccountId = required(input.liveAccountId, "LIVE_ACCOUNT_ID_REQUIRED");
    const liveWalletId = required(input.liveWalletId, "LIVE_WALLET_ID_REQUIRED");
    const name = required(input.name, "LIVE_ACCOUNT_NAME_REQUIRED");
    const actor = required(input.actor, "LIVE_ACCOUNT_ACTOR_REQUIRED");
    const reason = required(input.reason, "LIVE_ACCOUNT_REASON_REQUIRED");
    const signalCutoffAt = validTimestamp(input.signalCutoffAt);
    if (input.initialBankrollMicros <= 0n) throw new Error("LIVE_ACCOUNT_BANKROLL_INVALID");
    if (input.riskBudgetMicros <= 0n || input.riskBudgetMicros > input.initialBankrollMicros) {
      throw new Error("LIVE_ACCOUNT_RISK_BUDGET_INVALID");
    }
    const wallet = this.database.prepare(
      "SELECT wallet_address,wallet_type,status FROM live_wallets WHERE live_wallet_id=?",
    ).get(liveWalletId) as { wallet_address: string; wallet_type: string; status: string } | undefined;
    if (!wallet) throw new Error(`LIVE_WALLET_NOT_FOUND:${liveWalletId}`);
    const walletAddress = validAddress(wallet.wallet_address, "LIVE_WALLET_ADDRESS_INVALID");
    const authorizedSignerAddress = input.authorizedSignerAddress === undefined
      ? wallet.wallet_type === "EOA"
        ? walletAddress
        : null
      : validAddress(input.authorizedSignerAddress, "LIVE_ACCOUNT_AUTHORIZED_SIGNER_INVALID");
    if (!authorizedSignerAddress) throw new Error("LIVE_ACCOUNT_AUTHORIZED_SIGNER_REQUIRED");
    if (wallet.wallet_type === "EOA" && authorizedSignerAddress !== walletAddress) {
      throw new Error("LIVE_ACCOUNT_EOA_SIGNER_MISMATCH");
    }
    if (this.get(liveAccountId)) throw new Error(`LIVE_ACCOUNT_ALREADY_EXISTS:${liveAccountId}`);
    const now = this.now().toISOString();

    this.transaction(() => {
      this.database.prepare(
        `INSERT INTO live_accounts(
          live_account_id,live_wallet_id,name,status,initial_bankroll_micros,risk_budget_micros,
          signal_cutoff_at,schema_version,strategy_version,risk_version,live_version,ruleset_hash,
          source_code_commit,source_code_dirty,config_version,activated_at,created_at,updated_at,
          authorized_signer_address
        ) VALUES (?, ?, ?, 'DISABLED', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
      ).run(
        liveAccountId,
        liveWalletId,
        name,
        input.initialBankrollMicros.toString(),
        input.riskBudgetMicros.toString(),
        signalCutoffAt,
        VERSIONS.schemaVersion,
        VERSIONS.strategyVersion,
        VERSIONS.riskVersion,
        VERSIONS.liveVersion,
        RULESET_HASH,
        this.sourceVersion.commit,
        this.sourceVersion.dirty ? 1 : 0,
        VERSIONS.configVersion,
        now,
        now,
        authorizedSignerAddress,
      );
      this.recordTransition(liveAccountId, null, "DISABLED", reason, actor, now);
      this.audit(liveAccountId, "registered", reason, actor, now, {
        liveWalletId,
        authorizedSignerAddress,
        initialBankrollMicros: input.initialBankrollMicros.toString(),
        riskBudgetMicros: input.riskBudgetMicros.toString(),
      });
    });
    return this.require(liveAccountId);
  }

  activate(input: ChangeLiveAccountStateInput): LiveAccount {
    const account = this.require(input.liveAccountId);
    const actor = required(input.actor, "LIVE_ACCOUNT_ACTOR_REQUIRED");
    const reason = required(input.reason, "LIVE_ACCOUNT_REASON_REQUIRED");
    if (account.status === "CLOSED") throw new Error("LIVE_ACCOUNT_CLOSED");
    if (account.walletStatus !== "ACTIVE") throw new Error("LIVE_WALLET_NOT_ACTIVE");
    if (account.status === "ACTIVE") return account;
    const now = this.now().toISOString();
    this.transaction(() => {
      this.database.prepare(
        `UPDATE live_accounts
         SET status='ACTIVE',activated_at=?,source_code_commit=?,source_code_dirty=?,config_version=?,updated_at=?
         WHERE live_account_id=? AND status='DISABLED'`,
      ).run(
        now,
        this.sourceVersion.commit,
        this.sourceVersion.dirty ? 1 : 0,
        VERSIONS.configVersion,
        now,
        account.liveAccountId,
      );
      this.recordTransition(account.liveAccountId, "DISABLED", "ACTIVE", reason, actor, now);
      this.audit(account.liveAccountId, "activated", reason, actor, now, { liveWalletId: account.liveWalletId });
    });
    return this.require(account.liveAccountId);
  }

  disable(input: ChangeLiveAccountStateInput): LiveAccount {
    const account = this.require(input.liveAccountId);
    const actor = required(input.actor, "LIVE_ACCOUNT_ACTOR_REQUIRED");
    const reason = required(input.reason, "LIVE_ACCOUNT_REASON_REQUIRED");
    if (account.status === "CLOSED") throw new Error("LIVE_ACCOUNT_CLOSED");
    if (account.status === "DISABLED") return account;
    const now = this.now().toISOString();
    this.transaction(() => {
      this.database.prepare(
        `UPDATE live_accounts
         SET status='DISABLED',source_code_commit=?,source_code_dirty=?,config_version=?,updated_at=?
         WHERE live_account_id=? AND status='ACTIVE'`,
      ).run(
        this.sourceVersion.commit,
        this.sourceVersion.dirty ? 1 : 0,
        VERSIONS.configVersion,
        now,
        account.liveAccountId,
      );
      this.recordTransition(account.liveAccountId, "ACTIVE", "DISABLED", reason, actor, now);
      this.audit(account.liveAccountId, "disabled", reason, actor, now, { liveWalletId: account.liveWalletId });
    });
    return this.require(account.liveAccountId);
  }

  /**
   * Rebinds the durable Live portfolio container to the current runtime while
   * leaving every historical execution and Position ruleset untouched.
   * Handoff is allowed only while both the account and global Live gate are
   * disabled; startup recovery remains responsible for pending external orders.
   */
  handoffRuntime(input: ChangeLiveAccountStateInput): LiveAccount {
    if (this.sourceVersion.dirty) throw new Error("LIVE_ACCOUNT_HANDOFF_SOURCE_DIRTY");
    const account = this.require(input.liveAccountId);
    const actor = required(input.actor, "LIVE_ACCOUNT_ACTOR_REQUIRED");
    const reason = required(input.reason, "LIVE_ACCOUNT_REASON_REQUIRED");
    if (account.status !== "DISABLED") {
      throw new Error(`LIVE_ACCOUNT_HANDOFF_REQUIRES_DISABLED:${account.status}`);
    }
    const gate = this.database.prepare(
      "SELECT execution_mode,live_gate_state FROM live_gate_state WHERE state_id='default'",
    ).get() as { execution_mode: string; live_gate_state: string } | undefined;
    if (!gate || gate.execution_mode !== "PAPER" || gate.live_gate_state !== "LIVE_DISABLED") {
      throw new Error(
        `LIVE_ACCOUNT_HANDOFF_GATE_UNSAFE:${gate?.execution_mode ?? "MISSING"}:${gate?.live_gate_state ?? "MISSING"}`,
      );
    }
    const pendingOrder = this.database.prepare(
      `SELECT o.live_order_id,o.status
       FROM live_orders o
       JOIN live_executions e ON e.live_execution_id=o.live_execution_id
       WHERE e.live_account_id=? AND o.is_terminal=0
       ORDER BY o.created_at,o.live_order_id LIMIT 1`,
    ).get(account.liveAccountId) as { live_order_id: string; status: string } | undefined;
    if (pendingOrder) {
      throw new Error(`LIVE_ACCOUNT_HANDOFF_PENDING_ORDER:${pendingOrder.live_order_id}:${pendingOrder.status}`);
    }
    const pendingReservation = this.database.prepare(
      `SELECT e.live_execution_id,SUM(r.delta_micros) reserved_micros
       FROM live_reservation_ledger r
       JOIN live_executions e ON e.live_execution_id=r.live_execution_id
       WHERE e.live_account_id=?
       GROUP BY e.live_execution_id
       HAVING SUM(r.delta_micros)<>0
       ORDER BY e.live_execution_id LIMIT 1`,
    ).get(account.liveAccountId) as { live_execution_id: string; reserved_micros: string } | undefined;
    if (pendingReservation) {
      throw new Error(
        `LIVE_ACCOUNT_HANDOFF_ACTIVE_RESERVATION:${pendingReservation.live_execution_id}:${pendingReservation.reserved_micros}`,
      );
    }
    const pendingAssetReservation = this.database.prepare(
      `SELECT e.live_execution_id,SUM(r.delta_size_micros) reserved_size_micros
       FROM live_asset_reservation_ledger r
       JOIN live_executions e ON e.live_execution_id=r.live_execution_id
       WHERE e.live_account_id=?
       GROUP BY e.live_execution_id
       HAVING SUM(r.delta_size_micros)<>0
       ORDER BY e.live_execution_id LIMIT 1`,
    ).get(account.liveAccountId) as { live_execution_id: string; reserved_size_micros: string } | undefined;
    if (pendingAssetReservation) {
      throw new Error(
        `LIVE_ACCOUNT_HANDOFF_ACTIVE_ASSET_RESERVATION:${pendingAssetReservation.live_execution_id}:${pendingAssetReservation.reserved_size_micros}`,
      );
    }
    const cashLedger = this.database.prepare(
      `SELECT initial_bankroll_micros,
              COALESCE((SELECT SUM(cash_delta_micros) FROM live_cash_ledger WHERE live_account_id=?),0) cash_delta_micros,
              COALESCE((SELECT SUM(reserved_delta_micros) FROM live_cash_ledger WHERE live_account_id=?),0) reserved_delta_micros
       FROM live_accounts WHERE live_account_id=?`,
    ).get(account.liveAccountId, account.liveAccountId, account.liveAccountId) as {
      initial_bankroll_micros: string;
      cash_delta_micros: string;
      reserved_delta_micros: string;
    } | undefined;
    if (!cashLedger) throw new Error(`LIVE_ACCOUNT_NOT_FOUND:${account.liveAccountId}`);
    const expectedCash = BigInt(cashLedger.initial_bankroll_micros) + BigInt(cashLedger.cash_delta_micros);
    const reserved = BigInt(cashLedger.reserved_delta_micros);
    if (expectedCash < 0n || reserved < 0n) {
      throw new Error(`LIVE_ACCOUNT_HANDOFF_LEDGER_INCONSISTENT:${account.liveAccountId}`);
    }
    const frozenPosition = this.database.prepare(
      `SELECT live_position_id
       FROM live_positions
       WHERE live_account_id=? AND status='FROZEN' AND current_size_micros<>'0'
       ORDER BY created_at,live_position_id LIMIT 1`,
    ).get(account.liveAccountId) as { live_position_id: string } | undefined;
    if (frozenPosition) {
      throw new Error(`LIVE_ACCOUNT_HANDOFF_FROZEN_POSITION:${frozenPosition.live_position_id}`);
    }
    const previous = this.database.prepare(
      `SELECT schema_version,strategy_version,risk_version,live_version,ruleset_hash,
              source_code_commit,source_code_dirty,config_version
       FROM live_accounts WHERE live_account_id=?`,
    ).get(account.liveAccountId) as {
      schema_version: string;
      strategy_version: string;
      risk_version: string;
      live_version: string;
      ruleset_hash: string;
      source_code_commit: string;
      source_code_dirty: number;
      config_version: string;
    };
    const now = this.now().toISOString();
    this.transaction(() => {
      this.database.prepare(
        `UPDATE live_accounts
         SET schema_version=?,strategy_version=?,risk_version=?,live_version=?,
             ruleset_hash=?,source_code_commit=?,source_code_dirty=0,config_version=?,updated_at=?
         WHERE live_account_id=? AND status='DISABLED'`,
      ).run(
        VERSIONS.schemaVersion,
        VERSIONS.strategyVersion,
        VERSIONS.riskVersion,
        VERSIONS.liveVersion,
        RULESET_HASH,
        this.sourceVersion.commit,
        VERSIONS.configVersion,
        now,
        account.liveAccountId,
      );
      this.audit(account.liveAccountId, "runtime_handoff", reason, actor, now, {
        previousSchemaVersion: previous.schema_version,
        currentSchemaVersion: VERSIONS.schemaVersion,
        previousLiveVersion: previous.live_version,
        currentLiveVersion: VERSIONS.liveVersion,
        previousRulesetHash: previous.ruleset_hash,
        currentRulesetHash: RULESET_HASH,
        previousSourceCodeCommit: previous.source_code_commit,
        currentSourceCodeCommit: this.sourceVersion.commit,
        executionMode: gate.execution_mode,
        liveGateState: gate.live_gate_state,
        expectedCashMicros: expectedCash.toString(),
        reservedMicros: reserved.toString(),
      });
    });
    return this.require(account.liveAccountId);
  }

  get(liveAccountId: string): LiveAccount | null {
    const row = this.database.prepare(
      `SELECT a.live_account_id,a.live_wallet_id,w.status wallet_status,a.name,a.status,
              a.initial_bankroll_micros,a.risk_budget_micros,a.signal_cutoff_at,
              a.authorized_signer_address,a.activated_at,a.created_at,a.updated_at
       FROM live_accounts a
       JOIN live_wallets w ON w.live_wallet_id=a.live_wallet_id
       WHERE a.live_account_id=?`,
    ).get(liveAccountId) as LiveAccountRow | undefined;
    return row ? this.map(row) : null;
  }

  private require(liveAccountId: string): LiveAccount {
    const account = this.get(liveAccountId);
    if (!account) throw new Error(`LIVE_ACCOUNT_NOT_FOUND:${liveAccountId}`);
    return account;
  }

  private map(row: LiveAccountRow): LiveAccount {
    return {
      liveAccountId: row.live_account_id,
      liveWalletId: row.live_wallet_id,
      walletStatus: row.wallet_status,
      authorizedSignerAddress: row.authorized_signer_address,
      name: row.name,
      status: row.status,
      initialBankrollMicros: row.initial_bankroll_micros,
      riskBudgetMicros: row.risk_budget_micros,
      signalCutoffAt: row.signal_cutoff_at,
      activatedAt: row.activated_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private recordTransition(
    liveAccountId: string,
    fromState: LiveAccountStatus | null,
    toState: LiveAccountStatus,
    reason: string,
    actor: string,
    now: string,
  ): void {
    this.database.prepare(
      `INSERT INTO live_account_state_transitions(
        transition_id,live_account_id,from_state,to_state,reason,actor,ruleset_hash,
        source_code_commit,source_code_dirty,config_version,created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      hash(["LIVE_ACCOUNT_TRANSITION", liveAccountId, fromState ?? "NONE", toState, reason, actor, now]),
      liveAccountId,
      fromState,
      toState,
      reason,
      actor,
      RULESET_HASH,
      this.sourceVersion.commit,
      this.sourceVersion.dirty ? 1 : 0,
      VERSIONS.configVersion,
      now,
    );
  }

  private audit(
    liveAccountId: string,
    action: string,
    reason: string,
    actor: string,
    now: string,
    metadata: Record<string, unknown>,
  ): void {
    this.database.prepare(
      `INSERT INTO audit_log(
        audit_id,timestamp,entity_type,entity_id,action,reason,ruleset_hash,
        source_code_commit,source_code_dirty,config_version,metadata_json
      ) VALUES (?, ?, 'LIVE_ACCOUNT', ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      hash(["AUDIT", "LIVE_ACCOUNT", liveAccountId, action, reason, actor, now, randomUUID()]),
      now,
      liveAccountId,
      action,
      reason,
      RULESET_HASH,
      this.sourceVersion.commit,
      this.sourceVersion.dirty ? 1 : 0,
      VERSIONS.configVersion,
      stableJson({ actor, ...metadata }),
    );
  }

  private transaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}
