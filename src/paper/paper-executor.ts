import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  PAPER_EXECUTION_TRANSITIONS,
  PAPER_MARKET_DATA_TRANSITIONS,
  PAPER_POSITION_TRANSITIONS,
  transition,
} from "../domain/state-machine.js";
import { RULESET, RULESET_HASH, RULESET_SNAPSHOT_JSON, stableJson, VERSIONS } from "../domain/versioning.js";
import { registeredExecutionRules } from "../domain/ruleset-registry.js";
import {
  assessExecutableOrderbookTiming,
  executableOrderbookTimingFailure,
  isOrderbookUnavailableError,
  loadFeeThenOrderbook,
  marketClockOffsetIsValid,
} from "../execution/market-data.js";
import {
  evaluateBuyMarketConstraint,
  evaluateSellMarketConstraint,
  orderbookConstraintAvailability,
  parseMarketOrderConstraints,
  type MarketOrderConstraintEvidence,
} from "../execution/market-order-constraints.js";
import {
  calculateBuyCapitalSizing,
  type BuyCapitalSizingDecision,
  type ExactCapitalRatioSnapshot,
} from "../execution/capital-sizing.js";
import type {
  ExecutorBalanceQuery,
  ExecutorExecutionResult,
  ExecutorInterface,
  ExecutorPositionQuery,
  ExecutorReconcileInput,
  ExecutorReconcileResult,
  ExecutorSignalInput,
} from "../execution/types.js";
import { assertExecutionEnvelopeIntegrity } from "../execution/signal-integrity.js";
import type { SourceVersion } from "../infra/source-version.js";
import { resolveSourceVersion } from "../infra/source-version.js";
import {
  assertPaperMarketSnapshotCaptureBinding,
  persistPublicMarketCapture,
  publicFeeCaptureEndpoint,
} from "../infra/sqlite/public-market-capture.js";
import { calculateRealizedPnl } from "../pnl/pnl-model.js";
import { PortfolioProjectionService } from "../portfolio/portfolio-projection.js";
import { PaperAcceptanceSummaryService, type PaperAcceptanceSummary } from "./paper-acceptance-summary.js";
import { RiskManager, type RiskDecision } from "../risk/risk-manager.js";
import { SettlementService, type SettlementCandidate, type SettlementStore } from "../settlement/settlement-service.js";
import { executableSellVwap, matchPaperBuy, matchPaperSell } from "./matching.js";
import type {
  PaperAccountSnapshot,
  PaperExecutionState,
  PaperFeeSnapshot,
  PaperMarketDataProvider,
  PaperSignalConsumptionScope,
  PaperMarketDataHealthSnapshot,
  PaperMarketDataHealthState,
  PaperOrderbookSnapshot,
  PaperPositionState,
  PaperResolutionSnapshot,
  PaperSignalEnvelope,
} from "./types.js";

export const PAPER_CONSUMER_CUTOFF_SIGNAL_SENTINEL = "\u{10FFFF}";

const PPM = 1_000_000n;

export type PaperTransactionBarrier =
  | "RESERVATION_BEFORE_COMMIT"
  | "BUY_FILL_BEFORE_COMMIT"
  | "SETTLEMENT_BEFORE_COMMIT";

type ExecutionType = "TARGET_BUY" | "TARGET_SELL" | "STOP_LOSS" | "SETTLEMENT";

interface ExecutionRow {
  paper_execution_id: string;
  paper_account_id: string;
  signal_id: string | null;
  execution_type: ExecutionType;
  state: PaperExecutionState;
  asset_id: string;
  condition_id: string;
  requested_amount_micros: string | null;
  requested_size_micros: string | null;
  filled_size_micros: string;
  filled_notional_micros: string;
  fee_micros: string;
  target_price_units: string | null;
  deadline_at: string | null;
  attempt_count: number;
  risk_decision_id: string | null;
  risk_reject_reason: string | null;
  ruleset_hash: string;
  config_version: string;
}

interface PositionRow {
  paper_position_id: string;
  paper_account_id: string;
  signal_id: string;
  asset_id: string;
  condition_id: string;
  outcome: string | null;
  entry_price_units: string;
  entry_size_micros: string;
  entry_notional_micros: string;
  entry_fee_micros: string;
  current_size_micros: string;
  remaining_cost_micros: string;
  stop_loss_price_units: string;
  status: PaperPositionState;
  frozen_from_status: PaperPositionState | null;
  frozen_reason: string | null;
  frozen_at: string | null;
  realized_pnl_micros: string;
  created_at: string;
  ruleset_hash: string;
  config_version: string;
}

interface RiskDecisionRow {
  risk_decision_id: string;
  paper_account_id: string | null;
  signal_id: string | null;
  context_id: string | null;
  decision: "ALLOW" | "REJECT";
  risk_reason: string | null;
  risk_reject_reason: string | null;
  checks_json: string;
}

interface MarketDataHealthRow {
  paper_account_id: string;
  asset_id: string;
  condition_id: string;
  state: PaperMarketDataHealthState;
  consecutive_failures: number;
  consecutive_successes: number;
  next_retry_at: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  last_failure_at: string | null;
  last_success_at: string | null;
  frozen_at: string | null;
}

export interface ConsumerCutoffResult {
  accountId: string;
  cutoffAt: string;
  previousCreatedAt: string | null;
  previousSignalId: string | null;
  advanced: boolean;
  skippedSignalCount: number;
}

function hash(parts: Array<string | number>): string {
  return createHash("sha256").update(parts.join("|")).digest("hex");
}

function ratio(value: bigint, ppm: number): bigint {
  return (value * BigInt(ppm)) / PPM;
}

export class PaperExecutor implements ExecutorInterface, SettlementStore {
  readonly mode = "PAPER" as const;
  private readonly database: DatabaseSync;
  private readonly sourceVersion: SourceVersion;
  private readonly now: () => Date;
  private readonly marketClockOffsetMs: number;
  private readonly riskManager: RiskManager;
  private readonly transactionBarrier: ((barrier: PaperTransactionBarrier) => void) | undefined;

  constructor(
    private readonly databasePath: string,
    private readonly marketData: PaperMarketDataProvider,
    options: {
      sourceVersion?: SourceVersion;
      now?: () => Date;
      transactionBarrier?: (barrier: PaperTransactionBarrier) => void;
      marketClockOffsetMs?: number;
    } = {},
  ) {
    this.database = new DatabaseSync(databasePath);
    this.database.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;");
    this.sourceVersion = options.sourceVersion ?? resolveSourceVersion();
    this.now = options.now ?? (() => new Date());
    this.marketClockOffsetMs = options.marketClockOffsetMs ?? 0;
    if (!marketClockOffsetIsValid(this.marketClockOffsetMs)) {
      throw new Error("PAPER_MARKET_CLOCK_OFFSET_INVALID");
    }
    this.transactionBarrier = options.transactionBarrier;
    this.riskManager = new RiskManager(this.database, this.sourceVersion);
  }

  createAccount(
    name = "Default Paper",
    initialBalanceMicros = BigInt(RULESET.paperInitialBalanceMicros),
    targetId?: string,
  ): string {
    if (initialBalanceMicros <= 0n) throw new Error("PAPER_INITIAL_BALANCE_MUST_BE_POSITIVE");
    const boundTargetId = this.resolvePaperTarget(targetId);
    const now = this.now().toISOString();
    const accountId = randomUUID();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(
        `INSERT INTO paper_accounts(
          paper_account_id,name,target_id,status,initial_balance_micros,cash_balance_micros,
          reserved_balance_micros,realized_pnl_micros,signal_cutoff_at,schema_version,
          strategy_version,risk_version,paper_version,ruleset_snapshot_json,ruleset_hash,
          source_code_commit,source_code_dirty,created_at,updated_at
        ) VALUES (?, ?, ?, 'ACTIVE', ?, ?, '0', '0', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        accountId,
        name,
        boundTargetId,
        initialBalanceMicros.toString(),
        initialBalanceMicros.toString(),
        now,
        VERSIONS.schemaVersion,
        VERSIONS.strategyVersion,
        VERSIONS.riskVersion,
        VERSIONS.paperVersion,
        RULESET_SNAPSHOT_JSON,
        RULESET_HASH,
        this.sourceVersion.commit,
        this.sourceVersion.dirty ? 1 : 0,
        now,
        now,
      );
      this.database.prepare(
        `INSERT INTO paper_cash_ledger(
          cash_ledger_id,paper_account_id,paper_execution_id,entry_type,cash_delta_micros,
          reserved_delta_micros,cash_after_micros,reserved_after_micros,idempotency_key,created_at
        ) VALUES (?, ?, NULL, 'INITIAL_DEPOSIT', ?, '0', ?, '0', ?, ?)`,
      ).run(hash([accountId, "INITIAL_DEPOSIT"]), accountId, initialBalanceMicros.toString(), initialBalanceMicros.toString(), hash([accountId, "INITIAL_DEPOSIT"]), now);
      this.database.prepare(
        "INSERT INTO paper_consumer_checkpoints(paper_account_id,last_signal_created_at,last_signal_id,updated_at) VALUES (?, NULL, NULL, ?)",
      ).run(accountId, now);
      this.transition("PAPER_ACCOUNT", accountId, null, "ACTIVE", "ACCOUNT_CREATED", now);
      this.database.exec("COMMIT");
      return accountId;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  async consumeSignal(accountId: string, signalId: string, signal?: AbortSignal): Promise<string> {
    const existing = this.database.prepare(
      "SELECT paper_execution_id FROM paper_signal_consumptions WHERE paper_account_id=? AND signal_id=?",
    ).get(accountId, signalId) as { paper_execution_id: string | null } | undefined;
    if (existing?.paper_execution_id) return existing.paper_execution_id;
    const envelope = this.loadSignal(signalId);
    if (envelope.status !== "PUBLISHED") throw new Error("SIGNAL_NOT_PUBLISHED");
    if (!envelope.executionEligible) {
      throw new Error(envelope.executionBlockReason ?? "SIGNAL_NOT_EXECUTION_ELIGIBLE");
    }
    const executionId = this.createExecutionForSignal(accountId, envelope);
    const row = this.execution(executionId);
    if (!signal?.aborted && ["WAITING_EXECUTION", "EXIT_PENDING", "STOP_EXIT_PENDING"].includes(row.state)) {
      await this.attemptExecution(executionId, signal);
    }
    return executionId;
  }

  async consumeAvailableSignals(
    accountId: string,
    signal?: AbortSignal,
    scope?: PaperSignalConsumptionScope,
  ): Promise<string[]> {
    const account = this.accountRow(accountId);
    if (!account.target_id) throw new Error(`PAPER_ACCOUNT_TARGET_NOT_BOUND:${accountId}`);
    if (scope) this.assertSignalConsumptionScope(accountId, account.target_id, scope);
    const checkpoint = this.database.prepare(
      "SELECT last_signal_created_at,last_signal_id FROM paper_consumer_checkpoints WHERE paper_account_id=?",
    ).get(accountId) as { last_signal_created_at: string | null; last_signal_id: string | null };
    const scopeFilter = scope
      ? `AND EXISTS (
           SELECT 1 FROM observe_runs o
           WHERE o.observe_run_id=s.observe_run_id
             AND o.campaign_id=? AND o.campaign_session_id=?
         )`
      : "";
    const statement = this.database.prepare(
      `SELECT s.signal_id FROM signals s
       WHERE s.target_id=? AND s.created_at>=? AND s.status='PUBLISHED'
         AND s.execution_eligible=1
         ${scopeFilter}
         AND s.created_at<=?
         AND (? IS NULL OR s.created_at>? OR (s.created_at=? AND s.signal_id>?))
       ORDER BY s.created_at,s.signal_id`,
    );
    const trailingParameters = [
      this.now().toISOString(),
      checkpoint.last_signal_created_at,
      checkpoint.last_signal_created_at,
      checkpoint.last_signal_created_at,
      checkpoint.last_signal_id,
    ] as const;
    const rows = (scope
      ? statement.all(
        account.target_id,
        account.signal_cutoff_at,
        scope.campaignId,
        scope.sessionId,
        ...trailingParameters,
      )
      : statement.all(account.target_id, account.signal_cutoff_at, ...trailingParameters)) as Array<{ signal_id: string }>;
    const executions: string[] = [];
    for (const row of rows) {
      if (signal?.aborted) break;
      executions.push(await this.consumeSignal(accountId, row.signal_id, signal));
    }
    return executions;
  }

  private assertSignalConsumptionScope(
    accountId: string,
    targetId: string,
    scope: PaperSignalConsumptionScope,
  ): void {
    if (this.sourceVersion.dirty || !/^[a-f0-9]{64}$/.test(scope.coreCompatibilityHash)) {
      throw new Error("PAPER_SIGNAL_CONSUMPTION_SCOPE_INVALID");
    }
    const binding = this.database.prepare(
      `SELECT 1 valid
       FROM paper_validation_sessions s
       JOIN paper_validation_campaigns c ON c.campaign_id=s.campaign_id
       WHERE s.campaign_id=? AND s.session_id=?
         AND c.paper_account_id=? AND c.target_id=?
         AND c.core_compatibility_hash=? AND s.core_compatibility_hash=?
         AND length(trim(s.source_code_commit))>0 AND s.source_code_dirty=0
         AND (SELECT t.to_state FROM paper_validation_transitions t
              WHERE t.entity_type='SESSION' AND t.session_id=s.session_id
              ORDER BY t.sequence DESC LIMIT 1)='RUNNING'
         AND (SELECT t.to_state FROM paper_validation_transitions t
              WHERE t.entity_type='CAMPAIGN' AND t.campaign_id=c.campaign_id
                AND t.session_id IS NULL
              ORDER BY t.sequence DESC LIMIT 1)='RUNNING'`,
    ).get(
      scope.campaignId,
      scope.sessionId,
      accountId,
      targetId,
      scope.coreCompatibilityHash,
      scope.coreCompatibilityHash,
    );
    if (!binding) throw new Error("PAPER_SIGNAL_CONSUMPTION_SCOPE_INVALID");
  }

  /**
   * Starts a new Paper consumer session without replaying Signals that arrived
   * while the consumer was offline. Pending executions are intentionally left
   * untouched and will still be recovered by retryPending().
   */
  advanceConsumerCutoff(accountId: string, cutoffAt: string, reason: string): ConsumerCutoffResult {
    const cutoffTime = new Date(cutoffAt);
    if (!Number.isFinite(cutoffTime.valueOf())) throw new Error(`INVALID_PAPER_CONSUMER_CUTOFF:${cutoffAt}`);
    const normalizedCutoff = cutoffTime.toISOString();
    const normalizedReason = reason.trim();
    if (!normalizedReason) throw new Error("PAPER_CONSUMER_CUTOFF_REASON_REQUIRED");
    const account = this.accountRow(accountId);
    if (account.status !== "ACTIVE") throw new Error(`PAPER_ACCOUNT_NOT_ACTIVE:${accountId}`);
    const checkpointSignalSentinel = PAPER_CONSUMER_CUTOFF_SIGNAL_SENTINEL;
    const auditedAt = this.now().toISOString();

    this.database.exec("BEGIN IMMEDIATE");
    try {
      const checkpoint = this.database.prepare(
        `SELECT last_signal_created_at,last_signal_id
         FROM paper_consumer_checkpoints WHERE paper_account_id=?`,
      ).get(accountId) as { last_signal_created_at: string | null; last_signal_id: string | null } | undefined;
      if (!checkpoint) throw new Error(`PAPER_CONSUMER_CHECKPOINT_NOT_FOUND:${accountId}`);
      const previousCreatedAt = checkpoint.last_signal_created_at;
      const previousSignalId = checkpoint.last_signal_id;
      const advanced = previousCreatedAt === null
        || previousCreatedAt < normalizedCutoff
        || (previousCreatedAt === normalizedCutoff && (previousSignalId ?? "") < checkpointSignalSentinel);
      const skippedSignalCount = advanced
        ? Number((this.database.prepare(
          `SELECT count(*) count FROM signals s
           WHERE s.target_id=? AND s.status='PUBLISHED' AND s.created_at<=?
             AND (? IS NULL OR s.created_at>? OR (s.created_at=? AND s.signal_id>?))`,
        ).get(
          account.target_id,
          normalizedCutoff,
          previousCreatedAt,
          previousCreatedAt,
          previousCreatedAt,
          previousSignalId ?? "",
        ) as { count: number | bigint }).count)
        : 0;

      if (advanced) {
        this.database.prepare(
          `UPDATE paper_consumer_checkpoints
           SET last_signal_created_at=?,last_signal_id=?,updated_at=?
           WHERE paper_account_id=?`,
        ).run(normalizedCutoff, checkpointSignalSentinel, auditedAt, accountId);
      }
      this.audit(
        "PAPER_CONSUMER_CHECKPOINT",
        accountId,
        advanced ? "CHECKPOINT_ADVANCED" : "CHECKPOINT_RETAINED",
        normalizedReason,
        auditedAt,
        {
          cutoffAt: normalizedCutoff,
          previousCreatedAt,
          previousSignalId,
          skippedSignalCount,
        },
      );
      this.database.exec("COMMIT");
      return {
        accountId,
        cutoffAt: normalizedCutoff,
        previousCreatedAt,
        previousSignalId,
        advanced,
        skippedSignalCount,
      };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  async executeBuy(input: ExecutorSignalInput): Promise<ExecutorExecutionResult> {
    if (input.signal.signalType !== "TARGET_BUY") throw new Error("EXECUTOR_INPUT_NOT_BUY");
    const executionId = this.createExecutionForSignal(input.accountId, input.signal, this.approvedRisk(input));
    return { mode: this.mode, executionId, state: this.executionState(executionId) };
  }

  async executeSell(input: ExecutorSignalInput): Promise<ExecutorExecutionResult> {
    if (input.signal.signalType !== "TARGET_SELL") throw new Error("EXECUTOR_INPUT_NOT_SELL");
    const executionId = this.createExecutionForSignal(input.accountId, input.signal, this.approvedRisk(input));
    return { mode: this.mode, executionId, state: this.executionState(executionId) };
  }

  async cancelExecution(executionId: string, reason: string): Promise<void> {
    const execution = this.execution(executionId);
    if (["EXECUTED", "PARTIALLY_EXECUTED", "EXPIRED", "REJECTED", "CANCELLED"].includes(execution.state)) return;
    const now = this.now().toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      if (execution.execution_type === "TARGET_BUY") this.releaseReservation(execution, reason, now);
      this.database.prepare("UPDATE paper_executions SET state='CANCELLED',reason=?,updated_at=? WHERE paper_execution_id=?")
        .run(reason, now, executionId);
      this.transition("PAPER_EXECUTION", executionId, execution.state, "CANCELLED", reason, now);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Safe Session shutdown boundary: waiting BUYs are not carried across an
   * offline gap. Each cancellation uses the normal transactional Reservation
   * release path; existing Positions and pending exits are intentionally kept.
   */
  async cancelWaitingBuys(accountId: string, reason: string): Promise<number> {
    const rows = this.database.prepare(
      `SELECT paper_execution_id FROM paper_executions
       WHERE paper_account_id=? AND execution_type='TARGET_BUY'
         AND state='WAITING_EXECUTION'
       ORDER BY created_at,paper_execution_id`,
    ).all(accountId) as Array<{ paper_execution_id: string }>;
    for (const row of rows) await this.cancelExecution(row.paper_execution_id, reason);
    return rows.length;
  }

  async getPosition(query: ExecutorPositionQuery): Promise<unknown> {
    if (query.positionId) return this.position(query.positionId);
    return this.database.prepare(
      `SELECT * FROM paper_positions
       WHERE paper_account_id=? AND (? IS NULL OR asset_id=?)
       ORDER BY created_at,paper_position_id`,
    ).all(query.accountId, query.assetId ?? null, query.assetId ?? null);
  }

  async getBalance(query: ExecutorBalanceQuery): Promise<PaperAccountSnapshot> {
    return this.accountSnapshot(query.accountId);
  }

  async reconcile(input: ExecutorReconcileInput): Promise<ExecutorReconcileResult> {
    const frozenPositionCount = input.reason === "RECONCILIATION_SUCCESS"
      ? this.unfreezePositions(input.accountId, input.reason)
      : this.freezePositions(input.accountId, input.reason);
    return { mode: this.mode, frozenPositionCount, reason: input.reason };
  }

  getMarketDataHealth(accountId: string, assetId: string, conditionId: string): PaperMarketDataHealthSnapshot {
    const row = this.marketDataHealthRow(accountId, assetId, conditionId);
    if (!row) {
      return {
        paperAccountId: accountId,
        assetId,
        conditionId,
        state: "HEALTHY",
        consecutiveFailures: 0,
        consecutiveSuccesses: 0,
        nextRetryAt: null,
        lastErrorCode: null,
        lastErrorMessage: null,
        lastFailureAt: null,
        lastSuccessAt: null,
        frozenAt: null,
      };
    }
    return this.marketDataHealthSnapshot(row);
  }

  acceptanceSummary(
    accountId: string,
    window: { startAt?: string; endAt?: string } = {},
  ): PaperAcceptanceSummary {
    return new PaperAcceptanceSummaryService(this.databasePath, { now: this.now }).summarize(accountId, window);
  }

  async recoverMarketData(accountId: string, signal?: AbortSignal): Promise<void> {
    const rows = this.database.prepare(
      `SELECT paper_account_id,asset_id,condition_id,state,consecutive_failures,
              consecutive_successes,next_retry_at,last_error_code,last_error_message,
              last_failure_at,last_success_at,frozen_at
       FROM paper_market_data_health
       WHERE paper_account_id=? AND state IN ('DEGRADED','FROZEN')
         AND (next_retry_at IS NULL OR next_retry_at<=?)
       ORDER BY next_retry_at,asset_id,condition_id`,
    ).all(accountId, this.now().toISOString()) as unknown as MarketDataHealthRow[];
    for (const row of rows) {
      if (signal?.aborted) break;
      try {
        const { book, fee } = await loadFeeThenOrderbook(
          this.marketData,
          row.asset_id,
          row.condition_id,
          signal,
        );
        if (signal?.aborted) break;
        const identityError = this.marketDataIdentityError(row.asset_id, row.condition_id, book, fee);
        if (identityError) {
          this.recordMarketDataFailure(accountId, row.asset_id, row.condition_id, identityError, identityError);
          continue;
        }
        const timing = assessExecutableOrderbookTiming(
          book,
          this.now().valueOf(),
          this.marketClockOffsetMs,
        );
        const timingFailure = executableOrderbookTimingFailure(timing);
        const age = timing.ageMs;
        if (timingFailure || !Number.isFinite(age) || age < 0 || age > RULESET.orderbookMaxAgeMs) {
          this.recordMarketDataFailure(
            accountId,
            row.asset_id,
            row.condition_id,
            timingFailure?.code ?? "ORDERBOOK_STALE",
            timingFailure?.message ?? `Orderbook age ${String(age)}ms`,
          );
          continue;
        }
        const constraintError = orderbookConstraintAvailability({
          minOrderSize: book.minOrderSize,
          tickSize: book.tickSize,
        });
        if (constraintError) {
          this.recordMarketDataFailure(accountId, row.asset_id, row.condition_id, constraintError, constraintError);
          continue;
        }
        if (fee.status !== "AVAILABLE" || fee.feeRatePpm === null || fee.exponent === null) {
          this.recordMarketDataFailure(accountId, row.asset_id, row.condition_id, "FEE_MODEL_UNAVAILABLE", "Fee model unavailable during market recovery");
          continue;
        }
        this.recordMarketDataSuccess(accountId, row.asset_id, row.condition_id);
      } catch (error) {
        if (signal?.aborted) break;
        if (isOrderbookUnavailableError(error)) {
          await this.handleMarketOrderbookUnavailable(accountId, row.asset_id, row.condition_id, error, signal);
          continue;
        }
        this.recordMarketDataFailure(
          accountId,
          row.asset_id,
          row.condition_id,
          "MARKET_DATA_RECOVERY_ERROR",
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }

  async attemptExecution(executionId: string, signal?: AbortSignal): Promise<PaperExecutionState> {
    const execution = this.execution(executionId);
    if (!["WAITING_EXECUTION", "EXIT_PENDING", "STOP_EXIT_PENDING"].includes(execution.state)) return execution.state;
    if (signal?.aborted) return execution.state;
    if (execution.execution_type === "TARGET_BUY" && execution.deadline_at && this.now().valueOf() > Date.parse(execution.deadline_at)) {
      this.expireBuy(execution);
      return "EXPIRED";
    }
    if (!this.marketDataRetryDue(execution.paper_account_id, execution.asset_id, execution.condition_id)) {
      return execution.state;
    }
    let book: PaperOrderbookSnapshot;
    let fee: PaperFeeSnapshot;
    try {
      ({ book, fee } = await loadFeeThenOrderbook(
        this.marketData,
        execution.asset_id,
        execution.condition_id,
        signal,
      ));
    } catch (error) {
      if (isOrderbookUnavailableError(error)) {
        await this.handleOrderbookUnavailable(execution, error, signal);
        return this.executionState(executionId);
      }
      if (signal?.aborted) return execution.state;
      this.recordMarketDataFailure(
        execution.paper_account_id,
        execution.asset_id,
        execution.condition_id,
        "MARKET_DATA_REQUEST_FAILED",
        error instanceof Error ? error.message : String(error),
      );
      return execution.state;
    }
    if (signal?.aborted) return execution.state;
    if (fee.status !== "AVAILABLE" || fee.feeRatePpm === null || fee.exponent === null) {
      this.recordMarketDataFailure(
        execution.paper_account_id,
        execution.asset_id,
        execution.condition_id,
        "FEE_MODEL_UNAVAILABLE",
        "Fee model unavailable for Paper execution",
      );
      if (execution.execution_type === "TARGET_BUY") this.rejectAndRelease(execution, "FEE_MODEL_UNAVAILABLE");
      else this.updatePendingReason(execution, "FEE_MODEL_UNAVAILABLE");
      return execution.execution_type === "TARGET_BUY" ? "REJECTED" : execution.state;
    }
    const identityError = this.marketDataIdentityError(execution.asset_id, execution.condition_id, book, fee);
    if (identityError) {
      this.recordMarketDataFailure(execution.paper_account_id, execution.asset_id, execution.condition_id, identityError, identityError);
      return execution.state;
    }
    const timing = assessExecutableOrderbookTiming(
      book,
      this.now().valueOf(),
      this.marketClockOffsetMs,
    );
    const timingFailure = executableOrderbookTimingFailure(timing);
    const age = timing.ageMs;
    if (timingFailure || !Number.isFinite(age) || age < 0 || age > RULESET.orderbookMaxAgeMs) {
      this.recordMarketDataFailure(
        execution.paper_account_id,
        execution.asset_id,
        execution.condition_id,
        timingFailure?.code ?? "ORDERBOOK_STALE",
        timingFailure?.message ?? `Orderbook age ${String(age)}ms`,
      );
      this.updatePendingReason(execution, timingFailure?.code ?? "ORDERBOOK_STALE");
      return execution.state;
    }
    const constraintError = orderbookConstraintAvailability({
      minOrderSize: book.minOrderSize,
      tickSize: book.tickSize,
    });
    if (constraintError) {
      this.recordMarketDataFailure(
        execution.paper_account_id,
        execution.asset_id,
        execution.condition_id,
        constraintError,
        constraintError,
      );
      this.recordUnavailableMarketConstraint(execution, book, fee, age, constraintError);
      return execution.state;
    }
    if (!this.recordMarketDataSuccess(execution.paper_account_id, execution.asset_id, execution.condition_id)) {
      return execution.state;
    }
    return execution.execution_type === "TARGET_BUY"
      ? this.attemptBuy(execution, book, fee, age)
      : this.attemptSell(execution, book, fee, age);
  }

  async retryPending(accountId: string, signal?: AbortSignal): Promise<void> {
    const rows = this.database.prepare(
      `SELECT paper_execution_id FROM paper_executions
       WHERE paper_account_id=? AND state IN ('WAITING_EXECUTION','EXIT_PENDING','STOP_EXIT_PENDING')
       ORDER BY CASE state
         WHEN 'STOP_EXIT_PENDING' THEN 0
         WHEN 'EXIT_PENDING' THEN 1
         ELSE 2
       END,created_at,paper_execution_id`,
    ).all(accountId) as Array<{ paper_execution_id: string }>;
    for (const row of rows) {
      if (signal?.aborted) break;
      await this.attemptExecution(row.paper_execution_id, signal);
    }
  }

  async checkStopLosses(accountId: string, signal?: AbortSignal): Promise<string[]> {
    const positions = this.openPositions(accountId);
    const created: string[] = [];
    const positionsByMarket = new Map<string, PositionRow[]>();
    for (const position of positions) {
      const marketKey = `${position.asset_id}\u0000${position.condition_id.toLowerCase()}`;
      const group = positionsByMarket.get(marketKey) ?? [];
      group.push(position);
      positionsByMarket.set(marketKey, group);
    }
    for (const group of positionsByMarket.values()) {
      if (signal?.aborted) break;
      const first = group[0]!;
      if (!this.marketDataRetryDue(accountId, first.asset_id, first.condition_id)) continue;
      let book: PaperOrderbookSnapshot;
      try {
        book = await this.marketData.orderbook(first.asset_id, first.condition_id, signal);
      } catch (error) {
        if (signal?.aborted) break;
        if (isOrderbookUnavailableError(error)) {
          await this.handleMarketOrderbookUnavailable(accountId, first.asset_id, first.condition_id, error, signal);
        } else {
          this.recordMarketDataFailure(
            accountId,
            first.asset_id,
            first.condition_id,
            "MARKET_DATA_REQUEST_FAILED",
            error instanceof Error ? error.message : String(error),
          );
        }
        continue;
      }
      if (signal?.aborted) break;
      const identityError = this.orderbookIdentityError(first.asset_id, first.condition_id, book);
      if (identityError) {
        this.recordMarketDataFailure(accountId, first.asset_id, first.condition_id, identityError, identityError);
        continue;
      }
      const timing = assessExecutableOrderbookTiming(
        book,
        this.now().valueOf(),
        this.marketClockOffsetMs,
      );
      const timingFailure = executableOrderbookTimingFailure(timing);
      const age = timing.ageMs;
      if (timingFailure || !Number.isFinite(age) || age < 0 || age > RULESET.orderbookMaxAgeMs) {
        this.recordMarketDataFailure(
          accountId,
          first.asset_id,
          first.condition_id,
          timingFailure?.code ?? "ORDERBOOK_STALE",
          timingFailure?.message ?? `Orderbook age ${String(age)}ms during stop-loss check`,
        );
        continue;
      }
      const constraintError = orderbookConstraintAvailability({
        minOrderSize: book.minOrderSize,
        tickSize: book.tickSize,
      });
      if (constraintError) {
        this.recordMarketDataFailure(accountId, first.asset_id, first.condition_id, constraintError, constraintError);
        continue;
      }
      for (const position of group) {
        const currentSize = BigInt(position.current_size_micros);
        const vwap = executableSellVwap(book.bids, currentSize);
        if (vwap === null || vwap > BigInt(position.stop_loss_price_units)) continue;
        const idempotency = hash(["PAPER", accountId, "STOP_LOSS", position.paper_position_id]);
        const prior = this.database.prepare("SELECT paper_execution_id FROM paper_executions WHERE execution_idempotency_key=?")
          .get(idempotency) as { paper_execution_id: string } | undefined;
        if (prior) continue;
        const executionId = hash([idempotency, position.ruleset_hash]);
        const now = this.now().toISOString();
        const positionSignal = this.loadSignal(position.signal_id);
        this.database.exec("BEGIN IMMEDIATE");
        try {
          const risk = this.riskManager.recordSystemDecision({
            mode: this.mode,
            accountId,
            signalId: position.signal_id,
            contextId: positionSignal.context?.contextId ?? null,
            entityId: position.paper_position_id,
            executionType: "STOP_LOSS",
            decision: "ALLOW",
            reason: "STOP_LOSS_TRIGGERED",
            requestedAmountMicros: null,
            requestedSizeMicros: currentSize,
            rulesetHash: position.ruleset_hash,
            now,
          });
          this.supersedePendingTargetExit(position.paper_position_id, now);
          this.insertExecution({
            executionId,
            accountId,
            signalId: position.signal_id,
            idempotency,
            type: "STOP_LOSS",
            state: "STOP_EXIT_PENDING",
            assetId: position.asset_id,
            conditionId: position.condition_id,
            requestedAmount: null,
            requestedSize: currentSize,
            targetPrice: BigInt(position.stop_loss_price_units),
            lower: null,
            upper: null,
            capitalMode: null,
            deadline: null,
            reason: "STOP_LOSS_TRIGGERED",
            contextId: positionSignal.context?.contextId ?? null,
            riskDecisionId: risk.riskDecisionId,
            riskRejectReason: risk.riskRejectReason,
            rulesetHash: position.ruleset_hash,
            configVersion: position.config_version,
            now,
          });
          this.database.prepare(
            `INSERT INTO paper_execution_positions(
              paper_execution_id,paper_position_id,requested_size_micros,filled_size_micros,created_at
            ) VALUES (?, ?, ?, '0', ?)`,
          ).run(executionId, position.paper_position_id, currentSize.toString(), now);
          this.transition("PAPER_EXECUTION", executionId, null, "STOP_EXIT_PENDING", "STOP_LOSS_TRIGGERED", now);
          this.database.exec("COMMIT");
        } catch (error) {
          this.database.exec("ROLLBACK");
          throw error;
        }
        created.push(executionId);
        await this.attemptExecution(executionId, signal);
      }
    }
    return created;
  }

  async processSettlements(accountId: string, signal?: AbortSignal): Promise<string[]> {
    return new SettlementService(this.marketData, this, this.now).process(accountId, signal);
  }

  async accountSnapshot(accountId: string, signal?: AbortSignal): Promise<PaperAccountSnapshot> {
    return new PortfolioProjectionService(
      this.database,
      this.marketData,
      this.sourceVersion,
      this.now,
      {
        shouldAttempt: (candidateAccountId, assetId, conditionId) => (
          this.marketDataRetryDue(candidateAccountId, assetId, conditionId)
        ),
        onUnavailable: async (candidateAccountId, assetId, conditionId, error, candidateSignal) => {
          await this.handleMarketOrderbookUnavailable(
            candidateAccountId,
            assetId,
            conditionId,
            error,
            candidateSignal,
          );
        },
        onFailure: (candidateAccountId, assetId, conditionId, code, message) => {
          this.recordMarketDataFailure(candidateAccountId, assetId, conditionId, code, message);
        },
        onSuccess: (candidateAccountId, assetId, conditionId) => (
          this.recordMarketDataSuccess(candidateAccountId, assetId, conditionId)
        ),
      },
      this.marketClockOffsetMs,
    ).projectPaperAccount(accountId, signal);
  }

  settlementCandidates(accountId: string): SettlementCandidate[] {
    return this.openPositions(accountId, true)
      .filter((position) => position.status !== "FROZEN" && BigInt(position.current_size_micros) > 0n)
      .flatMap((position) => {
        const signal = this.loadSignal(position.signal_id);
        if (!signal.context) return [];
        return [{
          positionId: position.paper_position_id,
          accountId: position.paper_account_id,
          status: position.status,
          conditionId: position.condition_id,
          assetId: position.asset_id,
          marketEndTime: signal.context.marketEndTime,
        }];
      });
  }

  markSettlementPending(positionId: string, reason: string): void {
    const position = this.position(positionId);
    this.markPositionSettlementPending(position, reason);
  }

  redeemSettledPosition(positionId: string, resolution: PaperResolutionSnapshot): string {
    return this.settle(positionId, resolution);
  }

  recordSettlementError(candidate: SettlementCandidate, error: unknown): void {
    const now = this.now().toISOString();
    this.audit(
      "PAPER_POSITION",
      candidate.positionId,
      "SETTLEMENT_DEFERRED",
      error instanceof Error ? error.message : String(error),
      now,
      {
        accountId: candidate.accountId,
        assetId: candidate.assetId,
        conditionId: candidate.conditionId,
      },
    );
  }

  recordSettlementSuccess(candidate: SettlementCandidate): void {
    const latest = this.database.prepare(
      `SELECT action FROM audit_log
       WHERE entity_type='PAPER_POSITION' AND entity_id=?
         AND action IN ('SETTLEMENT_DEFERRED','SETTLEMENT_RECOVERED')
       ORDER BY timestamp DESC,audit_id DESC LIMIT 1`,
    ).get(candidate.positionId) as { action: string } | undefined;
    if (latest?.action !== "SETTLEMENT_DEFERRED") return;
    this.audit(
      "PAPER_POSITION",
      candidate.positionId,
      "SETTLEMENT_RECOVERED",
      "SETTLEMENT_DATA_SOURCE_RECOVERED",
      this.now().toISOString(),
      {
        accountId: candidate.accountId,
        assetId: candidate.assetId,
        conditionId: candidate.conditionId,
      },
    );
  }

  executionState(executionId: string): PaperExecutionState {
    return this.execution(executionId).state;
  }

  close(): void {
    this.database.close();
  }

  private createExecutionForSignal(accountId: string, signal: PaperSignalEnvelope, preapprovedRisk?: RiskDecision): string {
    const account = this.accountRow(accountId);
    if (!account.target_id) throw new Error(`PAPER_ACCOUNT_TARGET_NOT_BOUND:${accountId}`);
    const signalTargetId = this.signalTargetId(signal.signalId);
    if (signal.targetId !== signalTargetId) throw new Error(`PAPER_SIGNAL_ENVELOPE_TARGET_MISMATCH:${signal.signalId}`);
    if (signal.context && signal.context.targetId !== signal.targetId) {
      throw new Error(`PAPER_SIGNAL_CONTEXT_TARGET_MISMATCH:${signal.signalId}`);
    }
    if (signalTargetId !== account.target_id) throw new Error(`PAPER_SIGNAL_TARGET_MISMATCH:${signal.signalId}`);
    const idempotency = hash(["PAPER", accountId, signal.signalId]);
    const executionId = hash([idempotency, signal.context?.rulesetHash ?? this.signalRulesetHash(signal.signalId)]);
    const now = this.now().toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const duplicate = this.database.prepare(
        "SELECT paper_execution_id FROM paper_signal_consumptions WHERE paper_account_id=? AND signal_id=?",
      ).get(accountId, signal.signalId) as { paper_execution_id: string | null } | undefined;
      if (duplicate?.paper_execution_id) {
        this.database.exec("COMMIT");
        return duplicate.paper_execution_id;
      }
      this.audit("SIGNAL", signal.signalId, "RECEIVED", "PAPER_CONSUME_SIGNAL", now, { accountId });
      if (signal.signalType === "TARGET_BUY") {
        const capital = this.buyCapitalDecision(account, signal);
        const risk = preapprovedRisk ?? this.riskManager.evaluate({
          mode: this.mode,
          accountId,
          signal,
          requestedAmountMicros: capital.amount,
          requestedSizeMicros: null,
          capitalSizingDecision: capital.evidence,
          now,
        });
        if (risk.decision === "REJECT") {
          const reason = risk.riskRejectReason ?? "RISK_REJECTED";
          this.insertRejectedExecution(accountId, signal, executionId, idempotency, reason, now, risk);
          this.insertConsumption(accountId, signal.signalId, executionId, idempotency, "REJECTED", reason, now);
          this.audit("SIGNAL", signal.signalId, "REJECTED", reason, now, { accountId, riskDecisionId: risk.riskDecisionId });
        } else {
          const amount = capital.amount!;
          const deadline = this.buyDeadline(signal);
          if (this.now().valueOf() >= Date.parse(deadline)) {
            this.insertExecutionFromSignal(accountId, signal, executionId, idempotency, "EXPIRED", amount, null, capital.mode, deadline, "WAIT_TIMEOUT", now, risk);
          } else {
            this.reserve(accountId, executionId, signal, idempotency, amount, capital.mode!, deadline, now, risk);
          }
          this.insertConsumption(accountId, signal.signalId, executionId, idempotency, "ACCEPTED", null, now);
          this.audit("SIGNAL", signal.signalId, "ACCEPTED", "RISK_ALLOW", now, { accountId, riskDecisionId: risk.riskDecisionId });
        }
      } else {
        const allocations = this.sellAllocations(accountId, signal);
        const requested = allocations.reduce((sum, item) => sum + item.size, 0n);
        const risk = preapprovedRisk ?? this.riskManager.evaluate({
          mode: this.mode,
          accountId,
          signal,
          requestedAmountMicros: null,
          requestedSizeMicros: requested > 0n ? requested : null,
          now,
        });
        if (risk.decision === "REJECT") {
          const reason = risk.riskRejectReason ?? "RISK_REJECTED";
          this.insertRejectedExecution(accountId, signal, executionId, idempotency, reason, now, risk);
          this.insertConsumption(accountId, signal.signalId, executionId, idempotency, "REJECTED", reason, now);
          this.audit("SIGNAL", signal.signalId, "REJECTED", reason, now, { accountId, riskDecisionId: risk.riskDecisionId });
        } else if (allocations.length === 0) {
          this.insertRejectedExecution(accountId, signal, executionId, idempotency, "NO_TRACKED_PAPER_POSITION", now, risk);
          this.insertConsumption(accountId, signal.signalId, executionId, idempotency, "REJECTED", "NO_TRACKED_PAPER_POSITION", now);
          this.audit("SIGNAL", signal.signalId, "REJECTED", "NO_TRACKED_PAPER_POSITION", now, { accountId, riskDecisionId: risk.riskDecisionId });
        } else {
          this.insertExecutionFromSignal(accountId, signal, executionId, idempotency, "EXIT_PENDING", null, requested, null, null, "TARGET_SELL_RECEIVED", now, risk);
          const insert = this.database.prepare(
            `INSERT INTO paper_execution_positions(
              paper_execution_id,paper_position_id,requested_size_micros,filled_size_micros,created_at
            ) VALUES (?, ?, ?, '0', ?)`,
          );
          for (const item of allocations) insert.run(executionId, item.positionId, item.size.toString(), now);
          this.insertConsumption(accountId, signal.signalId, executionId, idempotency, "ACCEPTED", null, now);
          this.audit("SIGNAL", signal.signalId, "ACCEPTED", "RISK_ALLOW", now, { accountId, riskDecisionId: risk.riskDecisionId });
        }
      }
      this.updateCheckpoint(accountId, signal, now);
      this.database.exec("COMMIT");
      return executionId;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private buyCapitalDecision(account: ReturnType<PaperExecutor["accountRow"]>, signal: PaperSignalEnvelope): {
    amount: bigint | null;
    mode: "PROPORTIONAL" | "FIXED_FALLBACK" | null;
    rejectReason: string | null;
    evidence: BuyCapitalSizingDecision;
  } {
    const capital = signal.capitalDecision;
    const available = BigInt(account.cash_balance_micros) - BigInt(account.reserved_balance_micros);
    const evidence = calculateBuyCapitalSizing({
      accountCapitalMicros: available,
      capitalDecision: capital,
      exactRatio: signal.context?.capitalSizingRatio ?? null,
      exactRatioHash: signal.context?.capitalSizingRatioHash ?? null,
    });
    const amount = evidence.result === "CALCULATED" && evidence.calculatedAmountMicros !== null
      ? BigInt(evidence.calculatedAmountMicros)
      : null;
    return {
      amount,
      mode: evidence.capitalMode,
      rejectReason: evidence.reason,
      evidence,
    };
  }

  private buyDeadline(signal: PaperSignalEnvelope): string {
    const context = signal.context!;
    const target = Date.parse(context.targetTradeTimestamp);
    const end = Date.parse(context.marketEndTime);
    const rules = registeredExecutionRules(this.database, context.rulesetHash);
    if (!rules) throw new Error(`PAPER_RULESET_UNAVAILABLE:${context.rulesetHash}`);
    const remaining = Math.max(0, end - target);
    const wait = Math.min((remaining * rules.waitRatioPpm) / 1_000_000, rules.maxWaitMs);
    return new Date(target + wait).toISOString();
  }

  private reserve(
    accountId: string,
    executionId: string,
    signal: PaperSignalEnvelope,
    idempotency: string,
    amount: bigint,
    mode: "PROPORTIONAL" | "FIXED_FALLBACK",
    deadline: string,
    now: string,
    risk: RiskDecision,
  ): void {
    const rules = registeredExecutionRules(this.database, signal.context!.rulesetHash);
    if (!rules) throw new Error(`PAPER_RULESET_UNAVAILABLE:${signal.context!.rulesetHash}`);
    const lower = ratio(BigInt(signal.targetPriceUnits), rules.buyPriceMinRatioPpm);
    const upper = ratio(BigInt(signal.targetPriceUnits), rules.buyPriceMaxRatioPpm);
    this.insertExecution({
      executionId,
      accountId,
      signalId: signal.signalId,
      idempotency,
      type: "TARGET_BUY",
      state: "WAITING_EXECUTION",
      assetId: signal.assetId,
      conditionId: signal.conditionId,
      requestedAmount: amount,
      requestedSize: null,
      targetPrice: BigInt(signal.targetPriceUnits),
      lower,
      upper,
      capitalMode: mode,
      deadline,
      reason: "BUY_RESERVED",
      contextId: signal.context!.contextId,
      riskDecisionId: risk.riskDecisionId,
      riskRejectReason: risk.riskRejectReason,
      rulesetHash: rules.rulesetHash,
      configVersion: rules.configVersion,
      now,
    });
    const reservationId = hash([executionId, "RESERVATION"]);
    this.database.prepare(
      `INSERT INTO paper_reservations(
        reservation_id,paper_account_id,paper_execution_id,original_amount_micros,
        remaining_amount_micros,status,created_at,updated_at
      ) VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?, ?)`,
    ).run(reservationId, accountId, executionId, amount.toString(), amount.toString(), now, now);
    const account = this.accountRow(accountId);
    const reservedAfter = BigInt(account.reserved_balance_micros) + amount;
    this.database.prepare("UPDATE paper_accounts SET reserved_balance_micros=?,updated_at=? WHERE paper_account_id=?")
      .run(reservedAfter.toString(), now, accountId);
    this.database.prepare(
      `INSERT INTO paper_cash_ledger(
        cash_ledger_id,paper_account_id,paper_execution_id,entry_type,cash_delta_micros,
        reserved_delta_micros,cash_after_micros,reserved_after_micros,idempotency_key,created_at
      ) VALUES (?, ?, ?, 'RESERVE', '0', ?, ?, ?, ?, ?)`,
    ).run(hash([executionId, "CASH_RESERVE"]), accountId, executionId, amount.toString(), account.cash_balance_micros, reservedAfter.toString(), hash([executionId, "CASH_RESERVE"]), now);
    this.database.prepare(
      `INSERT INTO paper_reservation_ledger(
        reservation_ledger_id,reservation_id,paper_execution_id,entry_type,delta_micros,
        remaining_after_micros,idempotency_key,created_at
      ) VALUES (?, ?, ?, 'RESERVE', ?, ?, ?, ?)`,
    ).run(hash([reservationId, "RESERVE"]), reservationId, executionId, amount.toString(), amount.toString(), hash([reservationId, "RESERVE"]), now);
    this.transition("PAPER_EXECUTION", executionId, null, "WAITING_EXECUTION", "BUY_RESERVED", now);
    this.transactionBarrier?.("RESERVATION_BEFORE_COMMIT");
  }

  private attemptBuy(execution: ExecutionRow, book: PaperOrderbookSnapshot, fee: PaperFeeSnapshot, age: number): PaperExecutionState {
    const reservation = this.database.prepare(
      "SELECT reservation_id,original_amount_micros,remaining_amount_micros FROM paper_reservations WHERE paper_execution_id=? AND status='ACTIVE'",
    ).get(execution.paper_execution_id) as { reservation_id: string; original_amount_micros: string; remaining_amount_micros: string } | undefined;
    if (!reservation) throw new Error("ACTIVE_RESERVATION_NOT_FOUND");
    const bounds = this.database.prepare(
      "SELECT price_limit_lower_units,price_limit_upper_units FROM paper_executions WHERE paper_execution_id=?",
    ).get(execution.paper_execution_id) as { price_limit_lower_units: string; price_limit_upper_units: string };
    const constraint = evaluateBuyMarketConstraint({
      minOrderSize: book.minOrderSize,
      tickSize: book.tickSize,
      requestedAmountMicros: BigInt(reservation.remaining_amount_micros),
      upperPriceUnits: BigInt(bounds.price_limit_upper_units),
    });
    if (constraint.result !== "PASS") {
      this.rejectBuyForMarketConstraint(execution, book, fee, age, constraint);
      return "REJECTED";
    }
    const matched = matchPaperBuy({
      asks: book.asks,
      reservationMicros: BigInt(constraint.normalizedOrderAmountMicros!),
      lowerPriceUnits: BigInt(bounds.price_limit_lower_units),
      upperPriceUnits: BigInt(constraint.effectivePriceUnits!),
      feeRatePpm: BigInt(fee.feeRatePpm!),
      feeExponent: fee.exponent!,
    });
    if (BigInt(matched.filledSizeMicros) === 0n) {
      this.recordNoFillAttempt(execution, book, fee, "PRICE_OUT_OF_RANGE_OR_ZERO_LIQUIDITY", age, constraint);
      return "WAITING_EXECUTION";
    }
    const now = this.now().toISOString();
    const finalState: PaperExecutionState = matched.complete ? "EXECUTED" : "PARTIALLY_EXECUTED";
    const orderId = hash([execution.paper_execution_id, execution.attempt_count + 1, "FAK"]);
    const bookId = this.orderbookId(book);
    const feeId = this.feeId(fee);
    const spent = BigInt(matched.filledNotionalMicros) + BigInt(matched.feeMicros);
    const rules = registeredExecutionRules(this.database, execution.ruleset_hash);
    if (!rules) throw new Error(`PAPER_RULESET_UNAVAILABLE:${execution.ruleset_hash}`);
    const original = BigInt(reservation.original_amount_micros);
    const positionId = hash([execution.paper_execution_id, "POSITION"]);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.saveMarketSnapshots(book, fee, age);
      this.insertMarketConstraintEvidence(execution, book, constraint, now);
      this.insertOrder(orderId, execution, "BUY", matched.complete ? "FILLED" : "PARTIALLY_FILLED", matched, bookId, feeId, null, now);
      this.database.prepare(
        `INSERT INTO paper_positions(
          paper_position_id,paper_account_id,opening_execution_id,signal_id,asset_id,
          condition_id,outcome,entry_price_units,entry_size_micros,entry_notional_micros,
          entry_fee_micros,current_size_micros,remaining_cost_micros,stop_loss_price_units,
          status,frozen_from_status,frozen_reason,frozen_at,realized_pnl_micros,
          ruleset_hash,source_code_commit,source_code_dirty,config_version,created_at,updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', NULL, NULL, NULL, '0', ?, ?, ?, ?, ?, ?)`,
      ).run(
        positionId,
        execution.paper_account_id,
        execution.paper_execution_id,
        execution.signal_id,
        execution.asset_id,
        execution.condition_id,
        this.signalOutcome(execution.signal_id!, execution.asset_id),
        matched.vwapPriceUnits,
        matched.filledSizeMicros,
        matched.filledNotionalMicros,
        matched.feeMicros,
        matched.filledSizeMicros,
        spent.toString(),
        ratio(BigInt(matched.vwapPriceUnits!), rules.triggerRatioPpm).toString(),
        execution.ruleset_hash,
        this.sourceVersion.commit,
        this.sourceVersion.dirty ? 1 : 0,
        execution.config_version,
        now,
        now,
      );
      this.insertFills(orderId, execution.paper_execution_id, positionId, "BUY", matched, now);
      this.insertFeeLedger(execution.paper_execution_id, orderId, feeId, matched.feeMicros, now);
      const account = this.accountRow(execution.paper_account_id);
      const cashAfter = BigInt(account.cash_balance_micros) - spent;
      const reservedAfter = BigInt(account.reserved_balance_micros) - original;
      const released = original - spent;
      if (cashAfter < 0n || reservedAfter < 0n) throw new Error("PAPER_BALANCE_INVARIANT");
      if (released < 0n) throw new Error("PAPER_RESERVATION_OVERSPENT");
      this.database.prepare(
        "UPDATE paper_accounts SET cash_balance_micros=?,reserved_balance_micros=?,updated_at=? WHERE paper_account_id=?",
      ).run(cashAfter.toString(), reservedAfter.toString(), now, execution.paper_account_id);
      this.database.prepare(
        `UPDATE paper_reservations SET remaining_amount_micros='0',status=?,updated_at=? WHERE reservation_id=?`,
      ).run(released === 0n ? "CONSUMED" : "RELEASED", now, reservation.reservation_id);
      this.database.prepare(
        `INSERT INTO paper_cash_ledger(
          cash_ledger_id,paper_account_id,paper_execution_id,entry_type,cash_delta_micros,
          reserved_delta_micros,cash_after_micros,reserved_after_micros,idempotency_key,created_at
        ) VALUES (?, ?, ?, 'BUY_FILL', ?, ?, ?, ?, ?, ?)`,
      ).run(hash([execution.paper_execution_id, "BUY_FILL"]), execution.paper_account_id, execution.paper_execution_id, (-spent).toString(), (-original).toString(), cashAfter.toString(), reservedAfter.toString(), hash([execution.paper_execution_id, "BUY_FILL"]), now);
      this.database.prepare(
        `INSERT INTO paper_reservation_ledger(
          reservation_ledger_id,reservation_id,paper_execution_id,entry_type,delta_micros,
          remaining_after_micros,idempotency_key,created_at
        ) VALUES (?, ?, ?, 'CONSUME', ?, ?, ?, ?)`,
      ).run(
        hash([reservation.reservation_id, "CONSUME"]),
        reservation.reservation_id,
        execution.paper_execution_id,
        (-spent).toString(),
        released.toString(),
        hash([reservation.reservation_id, "CONSUME"]),
        now,
      );
      if (released > 0n) {
        this.database.prepare(
          `INSERT INTO paper_reservation_ledger(
            reservation_ledger_id,reservation_id,paper_execution_id,entry_type,delta_micros,
            remaining_after_micros,idempotency_key,created_at
          ) VALUES (?, ?, ?, 'RELEASE', ?, '0', ?, ?)`,
        ).run(
          hash([reservation.reservation_id, "RELEASE_REMAINDER"]),
          reservation.reservation_id,
          execution.paper_execution_id,
          (-released).toString(),
          hash([reservation.reservation_id, "RELEASE_REMAINDER"]),
          now,
        );
      }
      this.database.prepare(
        `UPDATE paper_executions SET state=?,filled_size_micros=?,filled_notional_micros=?,
          fee_micros=?,attempt_count=attempt_count+1,reason=?,updated_at=? WHERE paper_execution_id=?`,
      ).run(finalState, matched.filledSizeMicros, matched.filledNotionalMicros, matched.feeMicros, matched.complete ? "FAK_FILLED" : "FAK_PARTIAL_CANCEL_REMAINDER", now, execution.paper_execution_id);
      this.transition("PAPER_EXECUTION", execution.paper_execution_id, execution.state, finalState, matched.complete ? "FAK_FILLED" : "FAK_PARTIAL_CANCEL_REMAINDER", now);
      this.transition("PAPER_POSITION", positionId, null, "OPEN", "BUY_FILL", now);
      this.transactionBarrier?.("BUY_FILL_BEFORE_COMMIT");
      this.database.exec("COMMIT");
      return finalState;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private attemptSell(execution: ExecutionRow, book: PaperOrderbookSnapshot, fee: PaperFeeSnapshot, age: number): PaperExecutionState {
    const requested = BigInt(execution.requested_size_micros ?? "0");
    const alreadyFilled = BigInt(execution.filled_size_micros);
    const remaining = requested - alreadyFilled;
    if (remaining <= 0n) return "EXECUTED";
    const target = BigInt(execution.target_price_units ?? "0");
    const rules = registeredExecutionRules(this.database, execution.ruleset_hash);
    if (!rules) throw new Error(`PAPER_RULESET_UNAVAILABLE:${execution.ruleset_hash}`);
    const slippage = execution.execution_type === "STOP_LOSS"
      ? rules.maxSlippagePpm
      : rules.followSellMaxSlippagePpm;
    const minimum = ratio(target, 1_000_000 - slippage);
    const constraint = evaluateSellMarketConstraint({
      minOrderSize: book.minOrderSize,
      tickSize: book.tickSize,
      requestedSizeMicros: remaining,
      minimumPriceUnits: minimum,
    });
    if (constraint.result !== "PASS") {
      this.keepSellPendingForMarketConstraint(execution, book, fee, age, constraint);
      return execution.state;
    }
    const matched = matchPaperSell({
      bids: book.bids,
      requestedSizeMicros: BigInt(constraint.normalizedOrderSizeMicros!),
      minimumPriceUnits: BigInt(constraint.effectivePriceUnits!),
      feeRatePpm: BigInt(fee.feeRatePpm!),
      feeExponent: fee.exponent!,
    });
    if (BigInt(matched.filledSizeMicros) === 0n) {
      this.recordNoFillAttempt(execution, book, fee, "SLIPPAGE_OR_LIQUIDITY_LIMIT", age, constraint);
      return execution.state;
    }
    const now = this.now().toISOString();
    const executionComplete = alreadyFilled + BigInt(matched.filledSizeMicros) >= requested;
    const finalState: PaperExecutionState = executionComplete ? "EXECUTED"
      : execution.execution_type === "STOP_LOSS" ? "STOP_EXIT_PENDING" : "EXIT_PENDING";
    const orderId = hash([execution.paper_execution_id, execution.attempt_count + 1, "FAK"]);
    const bookId = this.orderbookId(book);
    const feeId = this.feeId(fee);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.saveMarketSnapshots(book, fee, age);
      this.insertMarketConstraintEvidence(execution, book, constraint, now);
      this.insertOrder(orderId, execution, "SELL", matched.complete ? "FILLED" : "PARTIALLY_FILLED", matched, bookId, feeId, null, now);
      this.insertFills(orderId, execution.paper_execution_id, null, "SELL", matched, now);
      this.insertFeeLedger(execution.paper_execution_id, orderId, feeId, matched.feeMicros, now);
      this.applySellToPositions(execution, BigInt(matched.filledSizeMicros), BigInt(matched.filledNotionalMicros), BigInt(matched.feeMicros), feeId, book.marketSnapshotTime, now);
      this.database.prepare(
        `UPDATE paper_executions SET state=?,filled_size_micros=?,filled_notional_micros=?,fee_micros=?,
          attempt_count=attempt_count+1,reason=?,updated_at=? WHERE paper_execution_id=?`,
      ).run(
        finalState,
        (alreadyFilled + BigInt(matched.filledSizeMicros)).toString(),
        (BigInt(execution.filled_notional_micros) + BigInt(matched.filledNotionalMicros)).toString(),
        (BigInt(execution.fee_micros) + BigInt(matched.feeMicros)).toString(),
        executionComplete ? "SELL_COMPLETED" : "SELL_PARTIAL_PENDING",
        now,
        execution.paper_execution_id,
      );
      this.transition("PAPER_EXECUTION", execution.paper_execution_id, execution.state, finalState, executionComplete ? "SELL_COMPLETED" : "SELL_PARTIAL_PENDING", now);
      this.database.exec("COMMIT");
      return finalState;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private applySellToPositions(
    execution: ExecutionRow,
    fillSize: bigint,
    proceeds: bigint,
    fee: bigint,
    feeSnapshotId: string,
    priceTimestamp: string,
    now: string,
  ): void {
    const allocations = this.database.prepare(
      `SELECT ep.paper_position_id,ep.requested_size_micros,ep.filled_size_micros,
              p.current_size_micros,p.remaining_cost_micros,p.realized_pnl_micros,p.status
       FROM paper_execution_positions ep JOIN paper_positions p ON p.paper_position_id=ep.paper_position_id
       WHERE ep.paper_execution_id=? ORDER BY p.created_at,p.paper_position_id`,
    ).all(execution.paper_execution_id) as Array<{
      paper_position_id: string;
      requested_size_micros: string;
      filled_size_micros: string;
      current_size_micros: string;
      remaining_cost_micros: string;
      realized_pnl_micros: string;
      status: string;
    }>;
    const pendingAllocations = allocations
      .map((item) => ({
        item,
        pending: BigInt(item.requested_size_micros) - BigInt(item.filled_size_micros),
      }))
      .filter(({ pending }) => pending > 0n);
    const totalPending = pendingAllocations.reduce((total, item) => total + item.pending, 0n);
    if (fillSize <= 0n || fillSize > totalPending) throw new Error("SELL_ALLOCATION_INVARIANT");
    let remainingFill = fillSize;
    let remainingPending = totalPending;
    const planned = pendingAllocations.map(({ item, pending }, index) => {
      const size = index === pendingAllocations.length - 1
        ? remainingFill
        : (remainingFill * pending) / remainingPending;
      if (size < 0n || size > pending) throw new Error("SELL_ALLOCATION_INVARIANT");
      remainingFill -= size;
      remainingPending -= pending;
      return { item, size };
    }).filter(({ size }) => size > 0n);
    if (remainingFill !== 0n) throw new Error("SELL_ALLOCATION_INVARIANT");
    let assignedProceeds = 0n;
    let assignedFee = 0n;
    let totalPnl = 0n;
    for (let index = 0; index < planned.length; index += 1) {
      const { item, size } = planned[index]!;
      const last = index === planned.length - 1;
      const itemProceeds = last ? proceeds - assignedProceeds : (proceeds * size) / fillSize;
      const itemFee = last ? fee - assignedFee : (fee * size) / fillSize;
      assignedProceeds += itemProceeds;
      assignedFee += itemFee;
      const beforeSize = BigInt(item.current_size_micros);
      if (size > beforeSize) throw new Error("PAPER_POSITION_OVERSELL");
      const beforeCost = BigInt(item.remaining_cost_micros);
      const costBasis = size === beforeSize ? beforeCost : (beforeCost * size) / beforeSize;
      const pnl = calculateRealizedPnl({ proceedsMicros: itemProceeds, feeMicros: itemFee, costBasisMicros: costBasis });
      totalPnl += pnl;
      const afterSize = beforeSize - size;
      const afterCost = beforeCost - costBasis;
      const status = afterSize === 0n ? "CLOSED" : "PARTIALLY_CLOSED";
      this.database.prepare(
        `UPDATE paper_positions SET current_size_micros=?,remaining_cost_micros=?,status=?,
          realized_pnl_micros=?,updated_at=? WHERE paper_position_id=?`,
      ).run(afterSize.toString(), afterCost.toString(), status, (BigInt(item.realized_pnl_micros) + pnl).toString(), now, item.paper_position_id);
      this.database.prepare(
        "UPDATE paper_execution_positions SET filled_size_micros=? WHERE paper_execution_id=? AND paper_position_id=?",
      ).run((BigInt(item.filled_size_micros) + size).toString(), execution.paper_execution_id, item.paper_position_id);
      this.database.prepare(
        `INSERT INTO paper_pnl_ledger(
          pnl_ledger_id,paper_account_id,paper_position_id,paper_execution_id,pnl_type,
          proceeds_micros,cost_basis_micros,fee_micros,pnl_micros,price_source,price_timestamp,
          fee_snapshot_id,ruleset_hash,source_code_commit,source_code_dirty,config_version,created_at
        ) VALUES (?, ?, ?, ?, 'REALIZED', ?, ?, ?, ?, 'EXECUTION_FILL', ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        randomUUID(),
        execution.paper_account_id,
        item.paper_position_id,
        execution.paper_execution_id,
        itemProceeds.toString(),
        costBasis.toString(),
        itemFee.toString(),
        pnl.toString(),
        priceTimestamp,
        feeSnapshotId,
        execution.ruleset_hash,
        this.sourceVersion.commit,
        this.sourceVersion.dirty ? 1 : 0,
        execution.config_version,
        now,
      );
      this.transition("PAPER_POSITION", item.paper_position_id, item.status, status, execution.execution_type, now);
    }
    const account = this.accountRow(execution.paper_account_id);
    const cashDelta = proceeds - fee;
    const cashAfter = BigInt(account.cash_balance_micros) + cashDelta;
    const pnlAfter = BigInt(account.realized_pnl_micros) + totalPnl;
    this.database.prepare(
      "UPDATE paper_accounts SET cash_balance_micros=?,realized_pnl_micros=?,updated_at=? WHERE paper_account_id=?",
    ).run(cashAfter.toString(), pnlAfter.toString(), now, execution.paper_account_id);
    this.database.prepare(
      `INSERT INTO paper_cash_ledger(
        cash_ledger_id,paper_account_id,paper_execution_id,entry_type,cash_delta_micros,
        reserved_delta_micros,cash_after_micros,reserved_after_micros,idempotency_key,created_at
      ) VALUES (?, ?, ?, 'SELL_FILL', ?, '0', ?, ?, ?, ?)`,
    ).run(randomUUID(), execution.paper_account_id, execution.paper_execution_id, cashDelta.toString(), cashAfter.toString(), account.reserved_balance_micros, hash([execution.paper_execution_id, execution.attempt_count + 1, "SELL_CASH"]), now);
  }

  private settle(positionId: string, resolution: PaperResolutionSnapshot): string {
    const position = this.position(positionId);
    if (!resolution.resolved || resolution.payoutNumerator === null || resolution.payoutDenominator === null) {
      throw new Error("SETTLEMENT_RESOLUTION_NOT_CONFIRMED");
    }
    if (resolution.assetId !== position.asset_id) throw new Error("SETTLEMENT_ASSET_IDENTITY_MISMATCH");
    if (resolution.conditionId.toLowerCase() !== position.condition_id.toLowerCase()) {
      throw new Error("SETTLEMENT_CONDITION_IDENTITY_MISMATCH");
    }
    if (!Number.isFinite(Date.parse(resolution.snapshotTime))) throw new Error("SETTLEMENT_SNAPSHOT_TIME_INVALID");
    const idempotency = hash(["PAPER", position.paper_account_id, "SETTLEMENT", positionId]);
    const existing = this.database.prepare("SELECT paper_execution_id FROM paper_executions WHERE execution_idempotency_key=?")
      .get(idempotency) as { paper_execution_id: string } | undefined;
    if (existing) return existing.paper_execution_id;
    const executionId = hash([idempotency, position.ruleset_hash]);
    const now = this.now().toISOString();
    const numerator = BigInt(resolution.payoutNumerator!);
    const denominator = BigInt(resolution.payoutDenominator!);
    if (denominator <= 0n || numerator < 0n || numerator > denominator) throw new Error("INVALID_SETTLEMENT_PAYOUT");
    const redeem = (BigInt(position.current_size_micros) * numerator) / denominator;
    const cost = BigInt(position.remaining_cost_micros);
    const pnl = calculateRealizedPnl({ proceedsMicros: redeem, costBasisMicros: cost, feeMicros: 0n });
    const signal = this.loadSignal(position.signal_id);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const risk = this.riskManager.recordSystemDecision({
        mode: this.mode,
        accountId: position.paper_account_id,
        signalId: position.signal_id,
        contextId: signal.context?.contextId ?? null,
        entityId: positionId,
        executionType: "SETTLEMENT",
        decision: "ALLOW",
        reason: "SETTLEMENT_CONFIRMED",
        requestedAmountMicros: null,
        requestedSizeMicros: BigInt(position.current_size_micros),
        rulesetHash: position.ruleset_hash,
        now,
      });
      this.insertExecution({
        executionId,
        accountId: position.paper_account_id,
        signalId: position.signal_id,
        idempotency,
        type: "SETTLEMENT",
        state: "EXECUTED",
        assetId: position.asset_id,
        conditionId: position.condition_id,
        requestedAmount: null,
        requestedSize: BigInt(position.current_size_micros),
        targetPrice: null,
        lower: null,
        upper: null,
        capitalMode: null,
        deadline: null,
        reason: "SETTLEMENT_CONFIRMED",
        contextId: signal.context?.contextId ?? null,
        riskDecisionId: risk.riskDecisionId,
        riskRejectReason: risk.riskRejectReason,
        rulesetHash: position.ruleset_hash,
        configVersion: position.config_version,
        now,
      });
      this.database.prepare(
        `UPDATE paper_positions SET current_size_micros='0',remaining_cost_micros='0',status='REDEEMED',
          realized_pnl_micros=?,updated_at=? WHERE paper_position_id=?`,
      ).run((BigInt(position.realized_pnl_micros) + pnl).toString(), now, positionId);
      const account = this.accountRow(position.paper_account_id);
      const cashAfter = BigInt(account.cash_balance_micros) + redeem;
      const pnlAfter = BigInt(account.realized_pnl_micros) + pnl;
      this.database.prepare(
        "UPDATE paper_accounts SET cash_balance_micros=?,realized_pnl_micros=?,updated_at=? WHERE paper_account_id=?",
      ).run(cashAfter.toString(), pnlAfter.toString(), now, position.paper_account_id);
      const resolutionJson = stableJson({
        conditionId: resolution.conditionId,
        assetId: resolution.assetId,
        resolved: resolution.resolved,
        payoutNumerator: resolution.payoutNumerator,
        payoutDenominator: resolution.payoutDenominator,
        sourceUrl: resolution.sourceUrl,
        snapshotTime: resolution.snapshotTime,
        raw: resolution.raw,
      });
      const resolutionHash = createHash("sha256").update(resolutionJson).digest("hex");
      this.database.prepare(
        `INSERT INTO paper_settlements(
          paper_settlement_id,paper_position_id,paper_execution_id,condition_id,payout_numerator,
          payout_denominator,redeem_amount_micros,pnl_micros,resolution_snapshot_json,resolution_hash,
          ruleset_hash,source_code_commit,source_code_dirty,config_version,created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        randomUUID(),
        positionId,
        executionId,
        position.condition_id,
        numerator.toString(),
        denominator.toString(),
        redeem.toString(),
        pnl.toString(),
        resolutionJson,
        resolutionHash,
        position.ruleset_hash,
        this.sourceVersion.commit,
        this.sourceVersion.dirty ? 1 : 0,
        position.config_version,
        now,
      );
      this.database.prepare(
        `INSERT INTO paper_pnl_ledger(
          pnl_ledger_id,paper_account_id,paper_position_id,paper_execution_id,pnl_type,
          proceeds_micros,cost_basis_micros,fee_micros,pnl_micros,price_source,price_timestamp,
          fee_snapshot_id,ruleset_hash,source_code_commit,source_code_dirty,config_version,created_at
        ) VALUES (?, ?, ?, ?, 'SETTLEMENT', ?, ?, '0', ?, 'SETTLEMENT_RESOLUTION', ?, NULL, ?, ?, ?, ?, ?)`,
      ).run(
        randomUUID(),
        position.paper_account_id,
        positionId,
        executionId,
        redeem.toString(),
        cost.toString(),
        pnl.toString(),
        resolution.snapshotTime,
        position.ruleset_hash,
        this.sourceVersion.commit,
        this.sourceVersion.dirty ? 1 : 0,
        position.config_version,
        now,
      );
      this.database.prepare(
        `INSERT INTO paper_cash_ledger(
          cash_ledger_id,paper_account_id,paper_execution_id,entry_type,cash_delta_micros,
          reserved_delta_micros,cash_after_micros,reserved_after_micros,idempotency_key,created_at
        ) VALUES (?, ?, ?, 'SETTLEMENT', ?, '0', ?, ?, ?, ?)`,
      ).run(randomUUID(), position.paper_account_id, executionId, redeem.toString(), cashAfter.toString(), account.reserved_balance_micros, hash([executionId, "SETTLEMENT_CASH"]), now);
      this.transition("PAPER_EXECUTION", executionId, null, "EXECUTED", "SETTLEMENT_CONFIRMED", now);
      this.transition("PAPER_POSITION", positionId, position.status, "REDEEMED", "SETTLEMENT_CONFIRMED", now);
      this.transactionBarrier?.("SETTLEMENT_BEFORE_COMMIT");
      this.database.exec("COMMIT");
      return executionId;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private markPositionSettlementPending(position: PositionRow, reason: string): void {
    const now = this.now().toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.cancelPendingExitAllocationsForSettlement(position.paper_position_id, now);
      this.database.prepare(
        `UPDATE paper_positions
         SET status='SETTLEMENT_PENDING',frozen_from_status=NULL,frozen_reason=NULL,
             frozen_at=NULL,updated_at=?
         WHERE paper_position_id=?`,
      )
        .run(now, position.paper_position_id);
      this.transition("PAPER_POSITION", position.paper_position_id, position.status, "SETTLEMENT_PENDING", reason, now);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private cancelPendingExitAllocationsForSettlement(positionId: string, now: string): void {
    const rows = this.database.prepare(
      `SELECT e.paper_execution_id,e.state,e.requested_size_micros,e.filled_size_micros,
              ep.requested_size_micros position_requested,ep.filled_size_micros position_filled
       FROM paper_execution_positions ep
       JOIN paper_executions e ON e.paper_execution_id=ep.paper_execution_id
       WHERE ep.paper_position_id=? AND e.state IN ('EXIT_PENDING','STOP_EXIT_PENDING')
       ORDER BY e.created_at,e.paper_execution_id`,
    ).all(positionId) as Array<{
      paper_execution_id: string;
      state: "EXIT_PENDING" | "STOP_EXIT_PENDING";
      requested_size_micros: string;
      filled_size_micros: string;
      position_requested: string;
      position_filled: string;
    }>;
    for (const row of rows) {
      const removed = BigInt(row.position_requested) - BigInt(row.position_filled);
      if (removed <= 0n) continue;
      const filled = BigInt(row.filled_size_micros);
      const newRequested = BigInt(row.requested_size_micros) - removed;
      if (newRequested < filled) throw new Error("SETTLEMENT_EXIT_ALLOCATION_INVARIANT");
      this.database.prepare(
        `UPDATE paper_execution_positions
         SET requested_size_micros=filled_size_micros
         WHERE paper_execution_id=? AND paper_position_id=?`,
      ).run(row.paper_execution_id, positionId);
      if (newRequested === filled) {
        this.database.prepare(
          `UPDATE paper_executions
           SET requested_size_micros=?,state='CANCELLED',reason='SETTLEMENT_SUPERSEDED',updated_at=?
           WHERE paper_execution_id=?`,
        ).run(newRequested.toString(), now, row.paper_execution_id);
        this.transition(
          "PAPER_EXECUTION",
          row.paper_execution_id,
          row.state,
          "CANCELLED",
          "SETTLEMENT_SUPERSEDED",
          now,
        );
      } else {
        this.database.prepare(
          `UPDATE paper_executions
           SET requested_size_micros=?,reason='POSITION_SUPERSEDED_BY_SETTLEMENT',updated_at=?
           WHERE paper_execution_id=?`,
        ).run(newRequested.toString(), now, row.paper_execution_id);
        this.transition(
          "PAPER_EXECUTION",
          row.paper_execution_id,
          row.state,
          row.state,
          "POSITION_SUPERSEDED_BY_SETTLEMENT",
          now,
        );
      }
    }
  }

  private expireBuy(execution: ExecutionRow): void {
    const now = this.now().toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.releaseReservation(execution, "WAIT_TIMEOUT", now);
      this.database.prepare("UPDATE paper_executions SET state='EXPIRED',reason='WAIT_TIMEOUT',updated_at=? WHERE paper_execution_id=?")
        .run(now, execution.paper_execution_id);
      this.transition("PAPER_EXECUTION", execution.paper_execution_id, execution.state, "EXPIRED", "WAIT_TIMEOUT", now);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private rejectAndRelease(execution: ExecutionRow, reason: string): void {
    const now = this.now().toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.releaseReservation(execution, reason, now);
      this.database.prepare("UPDATE paper_executions SET state='REJECTED',reason=?,updated_at=? WHERE paper_execution_id=?")
        .run(reason, now, execution.paper_execution_id);
      this.transition("PAPER_EXECUTION", execution.paper_execution_id, execution.state, "REJECTED", reason, now);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private rejectBuyForMarketConstraint(
    execution: ExecutionRow,
    book: PaperOrderbookSnapshot,
    fee: PaperFeeSnapshot,
    age: number,
    evidence: MarketOrderConstraintEvidence,
  ): void {
    const now = this.now().toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.saveMarketSnapshots(book, fee, age);
      this.insertMarketConstraintEvidence(execution, book, evidence, now);
      this.releaseReservation(execution, evidence.reason, now);
      this.database.prepare(
        "UPDATE paper_executions SET state='REJECTED',reason=?,updated_at=? WHERE paper_execution_id=?",
      ).run(evidence.reason, now, execution.paper_execution_id);
      this.transition("PAPER_EXECUTION", execution.paper_execution_id, execution.state, "REJECTED", evidence.reason, now);
      this.audit("PAPER_EXECUTION", execution.paper_execution_id, "REJECTED", evidence.reason, now, {
        marketConstraintEvidenceHash: evidence.evidenceHash,
        requestedAmountMicros: evidence.proposedAmountMicros,
        normalizedOrderAmountMicros: evidence.normalizedOrderAmountMicros,
        minOrderSizeMicros: evidence.minOrderSizeMicros,
      });
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private keepSellPendingForMarketConstraint(
    execution: ExecutionRow,
    book: PaperOrderbookSnapshot,
    fee: PaperFeeSnapshot,
    age: number,
    evidence: MarketOrderConstraintEvidence,
  ): void {
    const now = this.now().toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.saveMarketSnapshots(book, fee, age);
      this.insertMarketConstraintEvidence(execution, book, evidence, now);
      this.database.prepare("UPDATE paper_executions SET reason=?,updated_at=? WHERE paper_execution_id=?")
        .run(evidence.reason, now, execution.paper_execution_id);
      this.transition("PAPER_EXECUTION", execution.paper_execution_id, execution.state, execution.state, evidence.reason, now);
      this.audit("PAPER_EXECUTION", execution.paper_execution_id, "EXIT_WAITING", evidence.reason, now, {
        marketConstraintEvidenceHash: evidence.evidenceHash,
        requestedSizeMicros: evidence.proposedSizeMicros,
        minOrderSizeMicros: evidence.minOrderSizeMicros,
      });
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private recordUnavailableMarketConstraint(
    execution: ExecutionRow,
    book: PaperOrderbookSnapshot,
    fee: PaperFeeSnapshot,
    age: number,
    reason: string,
  ): void {
    let evidence: MarketOrderConstraintEvidence;
    if (execution.execution_type === "TARGET_BUY") {
      const reservation = this.database.prepare(
        "SELECT remaining_amount_micros FROM paper_reservations WHERE paper_execution_id=? AND status='ACTIVE'",
      ).get(execution.paper_execution_id) as { remaining_amount_micros: string } | undefined;
      const bounds = this.database.prepare(
        "SELECT price_limit_upper_units FROM paper_executions WHERE paper_execution_id=?",
      ).get(execution.paper_execution_id) as { price_limit_upper_units: string | null } | undefined;
      if (!reservation || !bounds?.price_limit_upper_units) {
        throw new Error("PAPER_MARKET_CONSTRAINT_CONTEXT_UNAVAILABLE");
      }
      evidence = evaluateBuyMarketConstraint({
        minOrderSize: book.minOrderSize,
        tickSize: book.tickSize,
        requestedAmountMicros: BigInt(reservation.remaining_amount_micros),
        upperPriceUnits: BigInt(bounds.price_limit_upper_units),
      });
    } else {
      const requested = BigInt(execution.requested_size_micros ?? "0");
      const remaining = requested - BigInt(execution.filled_size_micros);
      const target = BigInt(execution.target_price_units ?? "0");
      const rules = registeredExecutionRules(this.database, execution.ruleset_hash);
      if (!rules) throw new Error(`PAPER_RULESET_UNAVAILABLE:${execution.ruleset_hash}`);
      const slippage = execution.execution_type === "STOP_LOSS"
        ? rules.maxSlippagePpm
        : rules.followSellMaxSlippagePpm;
      evidence = evaluateSellMarketConstraint({
        minOrderSize: book.minOrderSize,
        tickSize: book.tickSize,
        requestedSizeMicros: remaining,
        minimumPriceUnits: ratio(target, 1_000_000 - slippage),
      });
    }
    if (evidence.result !== "UNAVAILABLE" || evidence.reason !== reason) {
      throw new Error(`PAPER_MARKET_CONSTRAINT_EVIDENCE_MISMATCH:${reason}:${evidence.reason}`);
    }
    const now = this.now().toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.saveMarketSnapshots(book, fee, age);
      this.insertMarketConstraintEvidence(execution, book, evidence, now);
      this.database.prepare("UPDATE paper_executions SET reason=?,updated_at=? WHERE paper_execution_id=?")
        .run(reason, now, execution.paper_execution_id);
      this.transition("PAPER_EXECUTION", execution.paper_execution_id, execution.state, execution.state, reason, now);
      this.audit("PAPER_EXECUTION", execution.paper_execution_id, "MARKET_CONSTRAINT_UNAVAILABLE", reason, now, {
        marketConstraintEvidenceHash: evidence.evidenceHash,
        marketDataState: this.getMarketDataHealth(
          execution.paper_account_id,
          execution.asset_id,
          execution.condition_id,
        ).state,
      });
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private releaseReservation(execution: ExecutionRow, reason: string, now: string): void {
    const reservation = this.database.prepare(
      "SELECT reservation_id,remaining_amount_micros FROM paper_reservations WHERE paper_execution_id=? AND status='ACTIVE'",
    ).get(execution.paper_execution_id) as { reservation_id: string; remaining_amount_micros: string } | undefined;
    if (!reservation) return;
    const amount = BigInt(reservation.remaining_amount_micros);
    const account = this.accountRow(execution.paper_account_id);
    const reservedAfter = BigInt(account.reserved_balance_micros) - amount;
    if (reservedAfter < 0n) throw new Error("PAPER_RESERVATION_INVARIANT");
    this.database.prepare("UPDATE paper_accounts SET reserved_balance_micros=?,updated_at=? WHERE paper_account_id=?")
      .run(reservedAfter.toString(), now, execution.paper_account_id);
    this.database.prepare("UPDATE paper_reservations SET remaining_amount_micros='0',status='RELEASED',updated_at=? WHERE reservation_id=?")
      .run(now, reservation.reservation_id);
    this.database.prepare(
      `INSERT INTO paper_reservation_ledger(
        reservation_ledger_id,reservation_id,paper_execution_id,entry_type,delta_micros,
        remaining_after_micros,idempotency_key,created_at
      ) VALUES (?, ?, ?, 'RELEASE', ?, '0', ?, ?)`,
    ).run(randomUUID(), reservation.reservation_id, execution.paper_execution_id, (-amount).toString(), hash([reservation.reservation_id, "RELEASE", reason]), now);
    this.database.prepare(
      `INSERT INTO paper_cash_ledger(
        cash_ledger_id,paper_account_id,paper_execution_id,entry_type,cash_delta_micros,
        reserved_delta_micros,cash_after_micros,reserved_after_micros,idempotency_key,created_at
      ) VALUES (?, ?, ?, 'RESERVATION_RELEASE', '0', ?, ?, ?, ?, ?)`,
    ).run(randomUUID(), execution.paper_account_id, execution.paper_execution_id, (-amount).toString(), account.cash_balance_micros, reservedAfter.toString(), hash([execution.paper_execution_id, "RELEASE", reason]), now);
  }

  private recordNoFillAttempt(
    execution: ExecutionRow,
    book: PaperOrderbookSnapshot,
    fee: PaperFeeSnapshot,
    reason: string,
    age: number,
    constraint?: MarketOrderConstraintEvidence,
  ): void {
    const now = this.now().toISOString();
    const bookId = this.orderbookId(book);
    const feeId = this.feeId(fee);
    const orderId = hash([execution.paper_execution_id, execution.attempt_count + 1, "FAK"]);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.saveMarketSnapshots(book, fee, age);
      if (constraint) this.insertMarketConstraintEvidence(execution, book, constraint, now);
      const empty = { levels: [], filledSizeMicros: "0", filledNotionalMicros: "0", feeMicros: "0", vwapPriceUnits: null, complete: false };
      this.insertOrder(orderId, execution, execution.execution_type === "TARGET_BUY" ? "BUY" : "SELL", "NO_FILL", empty, bookId, feeId, reason, now);
      this.database.prepare("UPDATE paper_executions SET attempt_count=attempt_count+1,reason=?,updated_at=? WHERE paper_execution_id=?")
        .run(reason, now, execution.paper_execution_id);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private updatePendingReason(execution: ExecutionRow, reason: string): void {
    this.database.prepare("UPDATE paper_executions SET reason=?,updated_at=? WHERE paper_execution_id=?")
      .run(reason, this.now().toISOString(), execution.paper_execution_id);
  }

  private saveMarketSnapshots(book: PaperOrderbookSnapshot, fee: PaperFeeSnapshot, age: number): void {
    const orderbookCaptureId = persistPublicMarketCapture(this.database, book.publicCapture, {
      endpoint: "clob-orderbook",
      requestUrl: book.sourceUrl,
      fetchedAt: book.receivedAt,
    });
    const feeCaptureId = persistPublicMarketCapture(this.database, fee.publicCapture, {
      endpoint: publicFeeCaptureEndpoint(fee.publicCapture),
      requestUrl: fee.sourceUrl,
      fetchedAt: fee.snapshotTime,
    });
    const payload = {
      bids: book.bids,
      asks: book.asks,
      minOrderSize: book.minOrderSize ?? null,
      tickSize: book.tickSize ?? null,
    };
    const parsed = parseMarketOrderConstraints({
      minOrderSize: book.minOrderSize,
      tickSize: book.tickSize,
    });
    const orderbookSnapshotId = this.orderbookId(book);
    this.database.prepare(
      `INSERT OR IGNORE INTO paper_orderbook_snapshots(
        orderbook_snapshot_id,asset_id,condition_id,market_snapshot_time,received_at,
        data_age_ms,payload_hash,bids_json,asks_json,source_url,min_order_size,
        min_order_size_micros,tick_size,tick_size_units,source_capture_id,created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      orderbookSnapshotId,
      book.assetId,
      book.conditionId,
      book.marketSnapshotTime,
      book.receivedAt,
      age,
      createHash("sha256").update(stableJson(payload)).digest("hex"),
      JSON.stringify(book.bids),
      JSON.stringify(book.asks),
      book.sourceUrl,
      book.minOrderSize ?? null,
      "error" in parsed ? null : parsed.minOrderSizeMicros.toString(),
      book.tickSize ?? null,
      "error" in parsed ? null : parsed.tickSizeUnits.toString(),
      orderbookCaptureId,
      this.now().toISOString(),
    );
    assertPaperMarketSnapshotCaptureBinding(
      this.database,
      "paper_orderbook_snapshots",
      "orderbook_snapshot_id",
      orderbookSnapshotId,
      orderbookCaptureId,
    );
    const feeSnapshotId = this.feeId(fee);
    this.database.prepare(
      `INSERT OR IGNORE INTO paper_fee_snapshots(
        fee_snapshot_id,asset_id,fee_rate_ppm,base_fee,fee_exponent,status,source_url,
        snapshot_time,source_capture_id,created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      feeSnapshotId, fee.assetId, fee.feeRatePpm, fee.baseFee, fee.exponent,
      fee.status, fee.sourceUrl, fee.snapshotTime, feeCaptureId, this.now().toISOString(),
    );
    assertPaperMarketSnapshotCaptureBinding(
      this.database,
      "paper_fee_snapshots",
      "fee_snapshot_id",
      feeSnapshotId,
      feeCaptureId,
    );
  }

  private orderbookId(book: PaperOrderbookSnapshot): string {
    return hash([book.assetId, book.marketSnapshotTime, book.receivedAt, book.sourceUrl, stableJson({
      bids: book.bids,
      asks: book.asks,
      minOrderSize: book.minOrderSize ?? null,
      tickSize: book.tickSize ?? null,
    })]);
  }

  private insertMarketConstraintEvidence(
    execution: ExecutionRow,
    book: PaperOrderbookSnapshot,
    evidence: MarketOrderConstraintEvidence,
    now: string,
  ): void {
    const evidenceJson = stableJson(evidence);
    const evidenceId = hash([
      execution.paper_execution_id,
      this.orderbookId(book),
      evidence.side,
      evidence.evidenceHash,
    ]);
    const inserted = this.database.prepare(
      `INSERT OR IGNORE INTO paper_market_constraint_evidence(
        market_constraint_evidence_id,paper_execution_id,orderbook_snapshot_id,attempt_sequence,side,
        check_result,reason,min_order_size,min_order_size_micros,tick_size,tick_size_units,
        proposed_amount_micros,normalized_order_amount_micros,proposed_size_micros,
        normalized_order_size_micros,
        effective_price_units,derived_min_notional_micros,price_rounding,evidence_json,
        evidence_hash,ruleset_hash,source_code_commit,source_code_dirty,config_version,created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      evidenceId,
      execution.paper_execution_id,
      this.orderbookId(book),
      execution.attempt_count + 1,
      evidence.side,
      evidence.result,
      evidence.reason,
      evidence.minOrderSize,
      evidence.minOrderSizeMicros,
      evidence.tickSize,
      evidence.tickSizeUnits,
      evidence.proposedAmountMicros,
      evidence.normalizedOrderAmountMicros,
      evidence.proposedSizeMicros,
      evidence.normalizedOrderSizeMicros,
      evidence.effectivePriceUnits,
      evidence.derivedMinNotionalMicros,
      evidence.priceRounding,
      evidenceJson,
      evidence.evidenceHash,
      execution.ruleset_hash,
      this.sourceVersion.commit,
      this.sourceVersion.dirty ? 1 : 0,
      execution.config_version,
      now,
    );
    if (Number(inserted.changes) === 0) {
      const existing = this.database.prepare(
        `SELECT market_constraint_evidence_id,evidence_json,evidence_hash
         FROM paper_market_constraint_evidence
         WHERE paper_execution_id=? AND attempt_sequence=? AND orderbook_snapshot_id=? AND side=?`,
      ).get(
        execution.paper_execution_id,
        execution.attempt_count + 1,
        this.orderbookId(book),
        evidence.side,
      ) as {
        market_constraint_evidence_id: string;
        evidence_json: string;
        evidence_hash: string;
      } | undefined;
      if (
        !existing
        || existing.market_constraint_evidence_id !== evidenceId
        || existing.evidence_json !== evidenceJson
        || existing.evidence_hash !== evidence.evidenceHash
      ) {
        throw new Error(`PAPER_MARKET_CONSTRAINT_EVIDENCE_CONFLICT:${execution.paper_execution_id}`);
      }
    }
  }

  private feeId(fee: PaperFeeSnapshot): string {
    return hash([
      fee.assetId,
      fee.snapshotTime,
      fee.status,
      fee.baseFee ?? "NONE",
      fee.feeRatePpm ?? "NONE",
      fee.exponent ?? "NONE",
      fee.sourceUrl,
    ]);
  }

  private insertOrder(
    orderId: string,
    execution: ExecutionRow,
    side: "BUY" | "SELL",
    state: "NO_FILL" | "PARTIALLY_FILLED" | "FILLED",
    matched: { filledSizeMicros: string; filledNotionalMicros: string; vwapPriceUnits: string | null; feeMicros: string },
    bookId: string,
    feeId: string,
    rejectReason: string | null,
    now: string,
  ): void {
    this.database.prepare(
      `INSERT INTO paper_orders(
        paper_order_id,paper_execution_id,attempt_sequence,side,order_type,state,
        requested_size_micros,requested_amount_micros,filled_size_micros,
        filled_notional_micros,vwap_price_units,fee_micros,reject_reason,
        orderbook_snapshot_id,fee_snapshot_id,created_at
      ) VALUES (?, ?, ?, ?, 'FAK', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(orderId, execution.paper_execution_id, execution.attempt_count + 1, side, state, execution.requested_size_micros, execution.requested_amount_micros, matched.filledSizeMicros, matched.filledNotionalMicros, matched.vwapPriceUnits, matched.feeMicros, rejectReason, bookId, feeId, now);
  }

  private insertFills(
    orderId: string,
    executionId: string,
    positionId: string | null,
    side: "BUY" | "SELL",
    matched: { levels: Array<{ priceUnits: string; sizeMicros: string; notionalMicros: string }>; feeMicros: string },
    now: string,
  ): void {
    const totalNotional = matched.levels.reduce((sum, level) => sum + BigInt(level.notionalMicros), 0n);
    let allocatedFee = 0n;
    matched.levels.forEach((level, index) => {
      const fee = index === matched.levels.length - 1
        ? BigInt(matched.feeMicros) - allocatedFee
        : totalNotional === 0n ? 0n : (BigInt(matched.feeMicros) * BigInt(level.notionalMicros)) / totalNotional;
      allocatedFee += fee;
      this.database.prepare(
        `INSERT INTO paper_fill_ledger(
          fill_id,paper_order_id,paper_execution_id,paper_position_id,side,price_units,
          size_micros,notional_micros,fee_micros,level_sequence,created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(hash([orderId, index]), orderId, executionId, positionId, side, level.priceUnits, level.sizeMicros, level.notionalMicros, fee.toString(), index, now);
    });
  }

  private insertFeeLedger(executionId: string, orderId: string, feeId: string, feeMicros: string, now: string): void {
    this.database.prepare(
      `INSERT INTO paper_fee_ledger(
        fee_ledger_id,paper_execution_id,paper_order_id,fee_snapshot_id,fee_micros,created_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(hash([orderId, "FEE"]), executionId, orderId, feeId, feeMicros, now);
  }

  private insertRejectedExecution(
    accountId: string,
    signal: PaperSignalEnvelope,
    executionId: string,
    idempotency: string,
    reason: string,
    now: string,
    risk: RiskDecision,
  ): void {
    this.insertExecutionFromSignal(accountId, signal, executionId, idempotency, "REJECTED", null, null, null, null, reason, now, risk);
  }

  private insertExecutionFromSignal(
    accountId: string,
    signal: PaperSignalEnvelope,
    executionId: string,
    idempotency: string,
    state: PaperExecutionState,
    requestedAmount: bigint | null,
    requestedSize: bigint | null,
    capitalMode: "PROPORTIONAL" | "FIXED_FALLBACK" | null,
    deadline: string | null,
    reason: string,
    now: string,
    risk: RiskDecision,
  ): void {
    const target = BigInt(signal.targetPriceUnits);
    const rulesetHash = signal.context?.rulesetHash ?? this.signalRulesetHash(signal.signalId);
    const rules = registeredExecutionRules(this.database, rulesetHash);
    if (!rules) throw new Error(`PAPER_RULESET_UNAVAILABLE:${rulesetHash}`);
    this.insertExecution({
      executionId,
      accountId,
      signalId: signal.signalId,
      idempotency,
      type: signal.signalType,
      state,
      assetId: signal.assetId,
      conditionId: signal.conditionId,
      requestedAmount,
      requestedSize,
      targetPrice: target,
      lower: signal.signalType === "TARGET_BUY" ? ratio(target, rules.buyPriceMinRatioPpm) : null,
      upper: signal.signalType === "TARGET_BUY" ? ratio(target, rules.buyPriceMaxRatioPpm) : null,
      capitalMode,
      deadline,
      reason,
      contextId: signal.context?.contextId ?? null,
      riskDecisionId: risk.riskDecisionId,
      riskRejectReason: risk.riskRejectReason,
      rulesetHash: rules.rulesetHash,
      configVersion: rules.configVersion,
      now,
    });
    this.transition("PAPER_EXECUTION", executionId, null, state, reason, now);
  }

  private insertExecution(input: {
    executionId: string;
    accountId: string;
    signalId: string | null;
    idempotency: string;
    type: ExecutionType;
    state: PaperExecutionState;
    assetId: string;
    conditionId: string;
    requestedAmount: bigint | null;
    requestedSize: bigint | null;
    targetPrice: bigint | null;
    lower: bigint | null;
    upper: bigint | null;
    capitalMode: "PROPORTIONAL" | "FIXED_FALLBACK" | null;
    deadline: string | null;
    reason: string;
    contextId: string | null;
    riskDecisionId: string;
    riskRejectReason: string | null;
    rulesetHash: string;
    configVersion: string;
    now: string;
  }): void {
    this.database.prepare(
      `INSERT INTO paper_executions(
        paper_execution_id,paper_account_id,signal_id,execution_idempotency_key,
        execution_type,state,asset_id,condition_id,requested_amount_micros,
        requested_size_micros,filled_size_micros,filled_notional_micros,fee_micros,
        target_price_units,price_limit_lower_units,price_limit_upper_units,capital_mode,
        deadline_at,attempt_count,reason,context_id,schema_version,strategy_version,
        risk_version,paper_version,ruleset_hash,risk_decision_id,risk_reject_reason,
        source_code_commit,source_code_dirty,config_version,created_at,updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '0', '0', '0', ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.executionId,
      input.accountId,
      input.signalId,
      input.idempotency,
      input.type,
      input.state,
      input.assetId,
      input.conditionId,
      input.requestedAmount?.toString() ?? null,
      input.requestedSize?.toString() ?? null,
      input.targetPrice?.toString() ?? null,
      input.lower?.toString() ?? null,
      input.upper?.toString() ?? null,
      input.capitalMode,
      input.deadline,
      input.reason,
      input.contextId,
      VERSIONS.schemaVersion,
      VERSIONS.strategyVersion,
      VERSIONS.riskVersion,
      VERSIONS.paperVersion,
      input.rulesetHash,
      input.riskDecisionId,
      input.riskRejectReason,
      this.sourceVersion.commit,
      this.sourceVersion.dirty ? 1 : 0,
      input.configVersion,
      input.now,
      input.now,
    );
    this.audit("EXECUTION", input.executionId, "CREATED", input.reason, input.now, {
      executionType: input.type,
      signalId: input.signalId,
      riskDecisionId: input.riskDecisionId,
    });
  }

  private insertConsumption(
    accountId: string,
    signalId: string,
    executionId: string,
    idempotency: string,
    result: "ACCEPTED" | "REJECTED",
    rejectReason: string | null,
    now: string,
  ): void {
    this.database.prepare(
      `INSERT INTO paper_signal_consumptions(
        consumption_id,paper_account_id,signal_id,execution_idempotency_key,result,
        reject_reason,paper_execution_id,consumed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(hash([accountId, signalId, "CONSUMPTION"]), accountId, signalId, idempotency, result, rejectReason, executionId, now);
  }

  private sellAllocations(accountId: string, signal: PaperSignalEnvelope): Array<{ positionId: string; size: bigint }> {
    if (!signal.sellRatioNumerator || !signal.sellRatioDenominator) return [];
    const numerator = BigInt(signal.sellRatioNumerator);
    const denominator = BigInt(signal.sellRatioDenominator);
    if (numerator <= 0n || denominator <= 0n || numerator > denominator) return [];
    const positions = this.database.prepare(
      `SELECT * FROM paper_positions
       WHERE paper_account_id=? AND asset_id=? AND condition_id=?
         AND (
           status IN ('OPEN','PARTIALLY_CLOSED')
           OR (status='FROZEN' AND frozen_reason LIKE 'MARKET_DATA:%')
         )
       ORDER BY created_at,paper_position_id`,
    ).all(accountId, signal.assetId, signal.conditionId) as unknown as PositionRow[];
    return positions
      .map((position) => {
        const current = BigInt(position.current_size_micros);
        const desired = (current * numerator) / denominator;
        const pendingRows = this.database.prepare(
          `SELECT ep.requested_size_micros,ep.filled_size_micros
           FROM paper_execution_positions ep
           JOIN paper_executions e ON e.paper_execution_id=ep.paper_execution_id
           WHERE ep.paper_position_id=?
             AND e.state IN ('EXIT_PENDING','STOP_EXIT_PENDING')`,
        ).all(position.paper_position_id) as unknown as Array<{
          requested_size_micros: string;
          filled_size_micros: string;
        }>;
        const pending = pendingRows.reduce(
          (total, row) => total + BigInt(row.requested_size_micros) - BigInt(row.filled_size_micros),
          0n,
        );
        const available = current > pending ? current - pending : 0n;
        return {
          positionId: position.paper_position_id,
          size: desired < available ? desired : available,
        };
      })
      .filter((item) => item.size > 0n);
  }

  private updateCheckpoint(accountId: string, signal: PaperSignalEnvelope, now: string): void {
    this.database.prepare(
      `UPDATE paper_consumer_checkpoints SET last_signal_created_at=?,last_signal_id=?,updated_at=?
       WHERE paper_account_id=?`,
    ).run(signal.createdAt, signal.signalId, now, accountId);
  }

  private supersedePendingTargetExit(positionId: string, now: string): void {
    const rows = this.database.prepare(
      `SELECT e.paper_execution_id,e.requested_size_micros,e.filled_size_micros,
              ep.requested_size_micros position_requested,ep.filled_size_micros position_filled
       FROM paper_execution_positions ep
       JOIN paper_executions e ON e.paper_execution_id=ep.paper_execution_id
       WHERE ep.paper_position_id=? AND e.execution_type='TARGET_SELL' AND e.state='EXIT_PENDING'`,
    ).all(positionId) as Array<{
      paper_execution_id: string;
      requested_size_micros: string;
      filled_size_micros: string;
      position_requested: string;
      position_filled: string;
    }>;
    for (const row of rows) {
      const removed = BigInt(row.position_requested) - BigInt(row.position_filled);
      if (removed <= 0n) continue;
      const newRequested = BigInt(row.requested_size_micros) - removed;
      this.database.prepare(
        "UPDATE paper_execution_positions SET requested_size_micros=filled_size_micros WHERE paper_execution_id=? AND paper_position_id=?",
      ).run(row.paper_execution_id, positionId);
      if (newRequested <= BigInt(row.filled_size_micros)) {
        this.database.prepare(
          "UPDATE paper_executions SET requested_size_micros=?,state='CANCELLED',reason='STOP_LOSS_SUPERSEDED',updated_at=? WHERE paper_execution_id=?",
        ).run(newRequested.toString(), now, row.paper_execution_id);
        this.transition("PAPER_EXECUTION", row.paper_execution_id, "EXIT_PENDING", "CANCELLED", "STOP_LOSS_SUPERSEDED", now);
      } else {
        this.database.prepare(
          "UPDATE paper_executions SET requested_size_micros=?,reason='POSITION_SUPERSEDED_BY_STOP',updated_at=? WHERE paper_execution_id=?",
        ).run(newRequested.toString(), now, row.paper_execution_id);
        this.transition(
          "PAPER_EXECUTION",
          row.paper_execution_id,
          "EXIT_PENDING",
          "EXIT_PENDING",
          "POSITION_SUPERSEDED_BY_STOP",
          now,
        );
      }
    }
  }

  private transition(entityType: string, entityId: string, from: string | null, to: string, reason: string, now: string): void {
    if (from !== null && entityType === "PAPER_EXECUTION") {
      transition(PAPER_EXECUTION_TRANSITIONS, from as PaperExecutionState, to as PaperExecutionState);
    }
    if (from !== null && entityType === "PAPER_POSITION") {
      transition(PAPER_POSITION_TRANSITIONS, from as keyof typeof PAPER_POSITION_TRANSITIONS, to as keyof typeof PAPER_POSITION_TRANSITIONS);
    }
    if (from !== null && entityType === "PAPER_MARKET_DATA") {
      transition(PAPER_MARKET_DATA_TRANSITIONS, from as PaperMarketDataHealthState, to as PaperMarketDataHealthState);
    }
    const row = this.database.prepare(
      "SELECT COALESCE(MAX(sequence),-1)+1 sequence FROM paper_state_transitions WHERE entity_type=? AND entity_id=?",
    ).get(entityType, entityId) as { sequence: number };
    const version = this.entityRuleset(entityType, entityId);
    this.database.prepare(
      `INSERT INTO paper_state_transitions(
        transition_id,entity_type,entity_id,from_state,to_state,reason,sequence,ruleset_hash,
        source_code_commit,source_code_dirty,config_version,created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      hash([entityType, entityId, row.sequence, to]),
      entityType,
      entityId,
      from,
      to,
      reason,
      row.sequence,
      version.rulesetHash,
      this.sourceVersion.commit,
      this.sourceVersion.dirty ? 1 : 0,
      version.configVersion,
      now,
    );
    this.audit(entityType, entityId, this.auditAction(entityType, from, to), reason, now, { from, to, sequence: row.sequence });
  }

  private auditAction(entityType: string, from: string | null, to: string): string {
    if (entityType === "PAPER_EXECUTION") {
      if (from === null) return "CREATED";
      if (to === "EXECUTED" || to === "PARTIALLY_EXECUTED") return "FILLED";
      if (to === "CANCELLED") return "CANCELLED";
      if (to === "EXPIRED") return "EXPIRED";
      if (to === "REJECTED") return "REJECTED";
    }
    if (entityType === "PAPER_POSITION") {
      if (from === null && to === "OPEN") return "OPENED";
      if (to === "FROZEN") return "FROZEN";
      if (to === "CLOSED") return "CLOSED";
      if (to === "SETTLEMENT_PENDING") return "SETTLEMENT_PENDING";
      if (to === "REDEEMED") return "REDEEMED";
    }
    if (entityType === "PAPER_ACCOUNT" && to === "ACTIVE") return "CREATED";
    return "STATE_CHANGED";
  }

  private audit(
    entityType: string,
    entityId: string,
    action: string,
    reason: string | null,
    now: string,
    metadata: Record<string, unknown> = {},
  ): void {
    const version = this.entityRuleset(entityType, entityId);
    this.database.prepare(
      `INSERT INTO audit_log(
        audit_id,timestamp,entity_type,entity_id,action,reason,ruleset_hash,
        source_code_commit,source_code_dirty,config_version,metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      hash(["AUDIT", entityType, entityId, action, reason ?? "NONE", now, randomUUID()]),
      now,
      entityType,
      entityId,
      action,
      reason,
      version.rulesetHash,
      this.sourceVersion.commit,
      this.sourceVersion.dirty ? 1 : 0,
      version.configVersion,
      stableJson(metadata),
    );
  }

  private entityRuleset(entityType: string, entityId: string): {
    rulesetHash: string;
    configVersion: string;
  } {
    let row: { ruleset_hash: string; config_version: string } | undefined;
    if (entityType === "PAPER_EXECUTION" || entityType === "EXECUTION") {
      row = this.database.prepare(
        "SELECT ruleset_hash,config_version FROM paper_executions WHERE paper_execution_id=?",
      ).get(entityId) as { ruleset_hash: string; config_version: string } | undefined;
    } else if (entityType === "PAPER_POSITION" || entityType === "POSITION") {
      row = this.database.prepare(
        "SELECT ruleset_hash,config_version FROM paper_positions WHERE paper_position_id=?",
      ).get(entityId) as { ruleset_hash: string; config_version: string } | undefined;
    } else if (entityType === "SIGNAL") {
      row = this.database.prepare(
        `SELECT s.ruleset_hash,r.config_version
         FROM signals s
         JOIN ruleset_registry r ON r.ruleset_hash=s.ruleset_hash
         WHERE s.signal_id=?`,
      ).get(entityId) as { ruleset_hash: string; config_version: string } | undefined;
    }
    return row
      ? { rulesetHash: row.ruleset_hash, configVersion: row.config_version }
      : { rulesetHash: RULESET_HASH, configVersion: VERSIONS.configVersion };
  }

  private signalRulesetHash(signalId: string): string {
    const row = this.database.prepare(
      "SELECT ruleset_hash FROM signals WHERE signal_id=?",
    ).get(signalId) as { ruleset_hash: string } | undefined;
    return row?.ruleset_hash ?? RULESET_HASH;
  }

  private approvedRisk(input: ExecutorSignalInput): RiskDecision {
    if (input.signal.status !== "PUBLISHED") throw new Error("SIGNAL_NOT_PUBLISHED");
    if (!input.signal.executionEligible) {
      throw new Error(input.signal.executionBlockReason ?? "SIGNAL_NOT_EXECUTION_ELIGIBLE");
    }
    if (input.signal.context?.contextId !== input.context.contextId) {
      throw new Error("EXECUTOR_CONTEXT_MISMATCH");
    }
    assertExecutionEnvelopeIntegrity(this.database, input.signal, input.context);
    const row = this.database.prepare(
      `SELECT risk_decision_id,paper_account_id,signal_id,context_id,decision,risk_reason,
              risk_reject_reason,checks_json
       FROM risk_decisions WHERE risk_decision_id=?`,
    ).get(input.riskDecisionId) as RiskDecisionRow | undefined;
    if (!row) throw new Error(`RISK_DECISION_NOT_FOUND:${input.riskDecisionId}`);
    if (row.decision !== "ALLOW") throw new Error(`RISK_DECISION_NOT_ALLOW:${input.riskDecisionId}`);
    if (row.paper_account_id !== input.accountId) throw new Error("RISK_DECISION_ACCOUNT_MISMATCH");
    if (row.signal_id !== input.signal.signalId) throw new Error("RISK_DECISION_SIGNAL_MISMATCH");
    if (row.context_id !== input.context.contextId) throw new Error("RISK_DECISION_CONTEXT_MISMATCH");
    return {
      riskDecisionId: row.risk_decision_id,
      decision: row.decision,
      riskReason: row.risk_reason ?? "ALLOW",
      riskRejectReason: row.risk_reject_reason,
      checks: JSON.parse(row.checks_json) as RiskDecision["checks"],
    };
  }

  private loadSignal(signalId: string): PaperSignalEnvelope {
    const row = this.database.prepare(
      `SELECT s.signal_id,s.signal_type,s.status,s.execution_eligible,s.execution_block_reason,
              s.target_id,s.asset_id,s.condition_id,s.target_price_units,s.target_size_micros,
              s.sell_ratio_numerator,s.sell_ratio_denominator,s.created_at,
              c.context_id,c.target_id context_target_id,c.capital_decision_id,c.target_trade_capital_ratio_ppm,
              c.capital_sizing_ratio_json,c.capital_sizing_ratio_hash,
              c.target_trade_timestamp,c.market_end_time,c.market_metadata_snapshot_json,
              c.market_metadata_hash,c.ruleset_hash context_ruleset_hash,
              c.source_code_commit context_source_code_commit,
              c.source_code_dirty context_source_code_dirty,
              c.config_version context_config_version,
              c.created_at context_created_at,
              ce.capital_estimate_status,ce.capital_confidence,
              ce.target_trade_capital_ratio_ppm capital_ratio_ppm,ce.fallback_amount_micros
       FROM signals s
       LEFT JOIN signal_execution_contexts c ON c.signal_id=s.signal_id
       LEFT JOIN capital_estimates ce ON ce.capital_estimate_id=c.capital_decision_id
       WHERE s.signal_id=?`,
    ).get(signalId) as Record<string, unknown> | undefined;
    if (!row) throw new Error(`SIGNAL_NOT_FOUND:${signalId}`);
    return {
      signalId: row.signal_id as string,
      targetId: row.target_id as string,
      signalType: row.signal_type as "TARGET_BUY" | "TARGET_SELL",
      status: row.status as string,
      executionEligible: (row.execution_eligible as number) !== 0,
      executionBlockReason: row.execution_block_reason as string | null,
      assetId: row.asset_id as string,
      conditionId: row.condition_id as string,
      targetPriceUnits: row.target_price_units as string,
      targetSizeMicros: row.target_size_micros as string,
      sellRatioNumerator: row.sell_ratio_numerator as string | null,
      sellRatioDenominator: row.sell_ratio_denominator as string | null,
      createdAt: row.created_at as string,
      context: row.context_id ? {
        contextId: row.context_id as string,
        targetId: row.context_target_id as string,
        signalId: row.signal_id as string,
        capitalDecisionId: row.capital_decision_id as string | null,
        targetTradeCapitalRatioPpm: row.target_trade_capital_ratio_ppm as string | null,
        capitalSizingRatio: row.capital_sizing_ratio_json
          ? JSON.parse(row.capital_sizing_ratio_json as string) as ExactCapitalRatioSnapshot
          : null,
        capitalSizingRatioHash: row.capital_sizing_ratio_hash as string | null,
        targetTradeTimestamp: row.target_trade_timestamp as string,
        marketEndTime: row.market_end_time as string,
        marketMetadataSnapshot: JSON.parse(row.market_metadata_snapshot_json as string),
        marketMetadataHash: row.market_metadata_hash as string,
        rulesetHash: row.context_ruleset_hash as string,
        sourceCodeCommit: row.context_source_code_commit as string,
        sourceCodeDirty: (row.context_source_code_dirty as number) !== 0,
        configVersion: row.context_config_version as string,
        createdAt: row.context_created_at as string,
      } : null,
      capitalDecision: row.capital_estimate_status ? {
        status: row.capital_estimate_status as "COMPLETE" | "INCOMPLETE" | "FAILED",
        confidence: row.capital_confidence as "HIGH" | "MEDIUM" | "LOW",
        ratioPpm: row.capital_ratio_ppm as string | null,
        fallbackAmountMicros: row.fallback_amount_micros as string,
      } : null,
    };
  }

  private signalOutcome(signalId: string, assetId: string): string | null {
    const context = this.database.prepare("SELECT market_metadata_snapshot_json FROM signal_execution_contexts WHERE signal_id=?")
      .get(signalId) as { market_metadata_snapshot_json: string } | undefined;
    if (!context) return null;
    const metadata = JSON.parse(context.market_metadata_snapshot_json) as { tokens?: Array<{ token_id: string; outcome: string }> };
    return metadata.tokens?.find((token) => token.token_id === assetId)?.outcome ?? null;
  }

  private execution(executionId: string): ExecutionRow {
    const row = this.database.prepare("SELECT * FROM paper_executions WHERE paper_execution_id=?").get(executionId) as unknown as ExecutionRow | undefined;
    if (!row) throw new Error(`PAPER_EXECUTION_NOT_FOUND:${executionId}`);
    return row;
  }

  private position(positionId: string): PositionRow {
    const row = this.database.prepare("SELECT * FROM paper_positions WHERE paper_position_id=?").get(positionId) as unknown as PositionRow | undefined;
    if (!row) throw new Error(`PAPER_POSITION_NOT_FOUND:${positionId}`);
    return row;
  }

  private accountRow(accountId: string): {
    status: string;
    target_id: string | null;
    initial_balance_micros: string;
    cash_balance_micros: string;
    reserved_balance_micros: string;
    realized_pnl_micros: string;
    signal_cutoff_at: string;
  } {
    const row = this.database.prepare(
      `SELECT status,target_id,initial_balance_micros,cash_balance_micros,reserved_balance_micros,
              realized_pnl_micros,signal_cutoff_at FROM paper_accounts WHERE paper_account_id=?`,
    ).get(accountId) as ReturnType<PaperExecutor["accountRow"]> | undefined;
    if (!row) throw new Error(`PAPER_ACCOUNT_NOT_FOUND:${accountId}`);
    return row;
  }

  private resolvePaperTarget(targetId?: string): string {
    if (targetId) {
      const row = this.database.prepare(
        "SELECT target_id FROM monitor_targets WHERE target_id=? AND identity_status='IDENTITY_CONFIRMED'",
      ).get(targetId) as { target_id: string } | undefined;
      if (!row) throw new Error(`PAPER_TARGET_NOT_CONFIRMED:${targetId}`);
      return row.target_id;
    }
    const rows = this.database.prepare(
      `SELECT target_id FROM monitor_targets
       WHERE identity_status='IDENTITY_CONFIRMED'
       ORDER BY created_at,target_id`,
    ).all() as unknown as Array<{ target_id: string }>;
    if (rows.length !== 1) throw new Error(`PAPER_TARGET_REQUIRED:confirmed_targets=${rows.length}`);
    return rows[0]!.target_id;
  }

  private signalTargetId(signalId: string): string {
    const row = this.database.prepare(
      "SELECT target_id FROM signals WHERE signal_id=?",
    ).get(signalId) as { target_id: string } | undefined;
    if (!row) throw new Error(`PAPER_SIGNAL_TARGET_NOT_FOUND:${signalId}`);
    return row.target_id;
  }

  private freezePositions(accountId: string, reason: string): number {
    const positions = this.openPositions(accountId, true);
    const now = this.now().toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      for (const position of positions) {
        this.database.prepare(
          `UPDATE paper_positions
           SET status='FROZEN',frozen_from_status=?,frozen_reason=?,frozen_at=?,updated_at=?
           WHERE paper_position_id=? AND status!='FROZEN'`,
        ).run(position.status, reason, now, now, position.paper_position_id);
        this.transition("PAPER_POSITION", position.paper_position_id, position.status, "FROZEN", reason, now);
      }
      this.database.exec("COMMIT");
      return positions.length;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private marketDataHealthRow(accountId: string, assetId: string, conditionId: string): MarketDataHealthRow | undefined {
    return this.database.prepare(
      `SELECT paper_account_id,asset_id,condition_id,state,consecutive_failures,
              consecutive_successes,next_retry_at,last_error_code,last_error_message,
              last_failure_at,last_success_at,frozen_at
       FROM paper_market_data_health
       WHERE paper_account_id=? AND asset_id=? AND condition_id=?`,
    ).get(accountId, assetId, conditionId) as MarketDataHealthRow | undefined;
  }

  private marketDataHealthSnapshot(row: MarketDataHealthRow): PaperMarketDataHealthSnapshot {
    return {
      paperAccountId: row.paper_account_id,
      assetId: row.asset_id,
      conditionId: row.condition_id,
      state: row.state,
      consecutiveFailures: row.consecutive_failures,
      consecutiveSuccesses: row.consecutive_successes,
      nextRetryAt: row.next_retry_at,
      lastErrorCode: row.last_error_code,
      lastErrorMessage: row.last_error_message,
      lastFailureAt: row.last_failure_at,
      lastSuccessAt: row.last_success_at,
      frozenAt: row.frozen_at,
    };
  }

  private marketDataRetryDue(accountId: string, assetId: string, conditionId: string): boolean {
    const health = this.marketDataHealthRow(accountId, assetId, conditionId);
    if (!health || health.state === "HEALTHY") return true;
    if (health.state === "SETTLEMENT_ONLY") return false;
    return health.next_retry_at === null || Date.parse(health.next_retry_at) <= this.now().valueOf();
  }

  private recordMarketDataFailure(
    accountId: string,
    assetId: string,
    conditionId: string,
    errorCode: string,
    errorMessage: string,
  ): PaperMarketDataHealthSnapshot {
    const previous = this.marketDataHealthRow(accountId, assetId, conditionId);
    const failures = (previous?.consecutive_failures ?? 0) + 1;
    const nextState: PaperMarketDataHealthState = failures >= RULESET.paperMarketDataFreezeThreshold
      ? "FROZEN"
      : "DEGRADED";
    const exponent = Math.min(30, failures - 1);
    const delayMs = Math.min(
      RULESET.paperMarketDataMaxBackoffMs,
      RULESET.paperMarketDataInitialBackoffMs * 2 ** exponent,
    );
    const now = this.now().toISOString();
    const nextRetryAt = new Date(this.now().valueOf() + delayMs).toISOString();
    const entityId = hash(["PAPER_MARKET_DATA", accountId, assetId, conditionId.toLowerCase()]);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(
        `INSERT INTO paper_market_data_health(
          paper_account_id,asset_id,condition_id,state,consecutive_failures,
          consecutive_successes,next_retry_at,last_error_code,last_error_message,
          last_failure_at,last_success_at,frozen_at,ruleset_hash,source_code_commit,
          source_code_dirty,config_version,created_at,updated_at
        ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(paper_account_id,asset_id,condition_id) DO UPDATE SET
          state=excluded.state,
          consecutive_failures=excluded.consecutive_failures,
          consecutive_successes=0,
          next_retry_at=excluded.next_retry_at,
          last_error_code=excluded.last_error_code,
          last_error_message=excluded.last_error_message,
          last_failure_at=excluded.last_failure_at,
          frozen_at=COALESCE(paper_market_data_health.frozen_at,excluded.frozen_at),
          source_code_commit=excluded.source_code_commit,
          source_code_dirty=excluded.source_code_dirty,
          config_version=excluded.config_version,
          updated_at=excluded.updated_at`,
      ).run(
        accountId,
        assetId,
        conditionId,
        nextState,
        failures,
        nextRetryAt,
        errorCode,
        errorMessage.slice(0, 500),
        now,
        nextState === "FROZEN" ? now : null,
        RULESET_HASH,
        this.sourceVersion.commit,
        this.sourceVersion.dirty ? 1 : 0,
        VERSIONS.configVersion,
        now,
        now,
      );
      if (nextState === "FROZEN") {
        this.freezeMarketPositionsInTransaction(accountId, assetId, conditionId, `MARKET_DATA:${errorCode}`, now);
      }
      this.transition("PAPER_MARKET_DATA", entityId, previous?.state ?? null, nextState, errorCode, now);
      this.audit("PAPER_MARKET_DATA", entityId, "MARKET_DATA_UNAVAILABLE", errorCode, now, {
        accountId,
        assetId,
        conditionId,
        consecutiveFailures: failures,
        nextRetryAt,
        errorMessage: errorMessage.slice(0, 500),
      });
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getMarketDataHealth(accountId, assetId, conditionId);
  }

  private recordMarketDataSuccess(accountId: string, assetId: string, conditionId: string): boolean {
    const previous = this.marketDataHealthRow(accountId, assetId, conditionId);
    if (!previous || previous.state === "HEALTHY") return true;
    if (previous.state === "SETTLEMENT_ONLY") return false;
    const successes = previous.consecutive_successes + 1;
    const recovered = successes >= RULESET.paperMarketDataRecoverySuccesses;
    const now = this.now().toISOString();
    const nextRetryAt = recovered
      ? null
      : new Date(this.now().valueOf() + RULESET.paperMarketDataInitialBackoffMs).toISOString();
    const nextState: PaperMarketDataHealthState = recovered ? "HEALTHY" : previous.state;
    const entityId = hash(["PAPER_MARKET_DATA", accountId, assetId, conditionId.toLowerCase()]);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(
        `UPDATE paper_market_data_health
         SET state=?,consecutive_failures=?,consecutive_successes=?,next_retry_at=?,
             last_error_code=?,last_error_message=?,last_success_at=?,frozen_at=?,
             source_code_commit=?,source_code_dirty=?,config_version=?,updated_at=?
         WHERE paper_account_id=? AND asset_id=? AND condition_id=?`,
      ).run(
        nextState,
        recovered ? 0 : previous.consecutive_failures,
        recovered ? 0 : successes,
        nextRetryAt,
        recovered ? null : previous.last_error_code,
        recovered ? null : previous.last_error_message,
        now,
        recovered ? null : previous.frozen_at,
        this.sourceVersion.commit,
        this.sourceVersion.dirty ? 1 : 0,
        VERSIONS.configVersion,
        now,
        accountId,
        assetId,
        conditionId,
      );
      if (recovered) {
        this.unfreezeMarketPositionsInTransaction(accountId, assetId, conditionId, "MARKET_DATA_RECOVERED", now);
      }
      this.transition("PAPER_MARKET_DATA", entityId, previous.state, nextState, recovered ? "MARKET_DATA_RECOVERED" : "MARKET_DATA_RECOVERY_PROBE", now);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return recovered;
  }

  private async handleOrderbookUnavailable(
    execution: ExecutionRow,
    error: unknown,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.handleMarketOrderbookUnavailable(
      execution.paper_account_id,
      execution.asset_id,
      execution.condition_id,
      error,
      signal,
    );
  }

  private async handleMarketOrderbookUnavailable(
    accountId: string,
    assetId: string,
    conditionId: string,
    error: unknown,
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      const resolution = await this.marketData.resolution(conditionId, assetId, signal);
      if (resolution.assetId !== assetId || resolution.conditionId.toLowerCase() !== conditionId.toLowerCase()) {
        this.recordMarketDataFailure(
          accountId,
          assetId,
          conditionId,
          "MARKET_ASSET_IDENTITY_MISMATCH",
          "Resolution identity does not match the requested market",
        );
        return;
      }
      if (resolution.raw.closed === true) {
        this.markMarketSettlementOnly(accountId, assetId, conditionId, "MARKET_CLOSED_NO_ORDERBOOK");
        return;
      }
    } catch (resolutionError) {
      if (signal?.aborted) throw resolutionError;
    }
    const message = error instanceof Error ? error.message : String(error);
    this.recordMarketDataFailure(
      accountId,
      assetId,
      conditionId,
      "NO_ORDERBOOK_EXISTS",
      message,
    );
  }

  private orderbookIdentityError(
    assetId: string,
    conditionId: string,
    book: PaperOrderbookSnapshot,
  ): string | null {
    if (book.assetId !== assetId) return "ORDERBOOK_ASSET_IDENTITY_MISMATCH";
    if (book.conditionId.toLowerCase() !== conditionId.toLowerCase()) return "ORDERBOOK_CONDITION_IDENTITY_MISMATCH";
    return null;
  }

  private marketDataIdentityError(
    assetId: string,
    conditionId: string,
    book: PaperOrderbookSnapshot,
    fee: PaperFeeSnapshot,
  ): string | null {
    return this.orderbookIdentityError(assetId, conditionId, book)
      ?? (fee.assetId === assetId ? null : "FEE_ASSET_IDENTITY_MISMATCH");
  }

  private markMarketSettlementOnly(accountId: string, assetId: string, conditionId: string, reason: string): void {
    const previous = this.marketDataHealthRow(accountId, assetId, conditionId);
    const now = this.now().toISOString();
    const entityId = hash(["PAPER_MARKET_DATA", accountId, assetId, conditionId.toLowerCase()]);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(
        `INSERT INTO paper_market_data_health(
          paper_account_id,asset_id,condition_id,state,consecutive_failures,
          consecutive_successes,next_retry_at,last_error_code,last_error_message,
          last_failure_at,last_success_at,frozen_at,ruleset_hash,source_code_commit,
          source_code_dirty,config_version,created_at,updated_at
        ) VALUES (?, ?, ?, 'SETTLEMENT_ONLY', 0, 0, NULL, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(paper_account_id,asset_id,condition_id) DO UPDATE SET
          state='SETTLEMENT_ONLY',consecutive_failures=0,consecutive_successes=0,
          next_retry_at=NULL,last_error_code=excluded.last_error_code,
          last_error_message=excluded.last_error_message,last_failure_at=excluded.last_failure_at,
          frozen_at=NULL,source_code_commit=excluded.source_code_commit,
          source_code_dirty=excluded.source_code_dirty,config_version=excluded.config_version,
          updated_at=excluded.updated_at`,
      ).run(
        accountId,
        assetId,
        conditionId,
        reason,
        reason,
        now,
        RULESET_HASH,
        this.sourceVersion.commit,
        this.sourceVersion.dirty ? 1 : 0,
        VERSIONS.configVersion,
        now,
        now,
      );
      this.cancelMarketPendingExecutionsInTransaction(accountId, assetId, conditionId, reason, now);
      this.unfreezeMarketPositionsInTransaction(accountId, assetId, conditionId, reason, now);
      this.transition("PAPER_MARKET_DATA", entityId, previous?.state ?? null, "SETTLEMENT_ONLY", reason, now);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private cancelMarketPendingExecutionsInTransaction(
    accountId: string,
    assetId: string,
    conditionId: string,
    reason: string,
    now: string,
  ): void {
    const executions = this.database.prepare(
      `SELECT * FROM paper_executions
       WHERE paper_account_id=? AND asset_id=? AND condition_id=?
         AND state IN ('WAITING_EXECUTION','EXIT_PENDING','STOP_EXIT_PENDING')
       ORDER BY created_at,paper_execution_id`,
    ).all(accountId, assetId, conditionId) as unknown as ExecutionRow[];
    for (const execution of executions) {
      const nextState: PaperExecutionState = execution.execution_type === "TARGET_BUY" ? "REJECTED" : "CANCELLED";
      if (execution.execution_type === "TARGET_BUY") this.releaseReservation(execution, reason, now);
      this.database.prepare(
        "UPDATE paper_executions SET state=?,reason=?,updated_at=? WHERE paper_execution_id=?",
      ).run(nextState, reason, now, execution.paper_execution_id);
      this.transition("PAPER_EXECUTION", execution.paper_execution_id, execution.state, nextState, reason, now);
    }
  }

  private freezeMarketPositionsInTransaction(
    accountId: string,
    assetId: string,
    conditionId: string,
    reason: string,
    now: string,
  ): number {
    const positions = this.database.prepare(
      `SELECT * FROM paper_positions
       WHERE paper_account_id=? AND asset_id=? AND condition_id=?
         AND status IN ('OPEN','PARTIALLY_CLOSED','SETTLEMENT_PENDING')
       ORDER BY created_at,paper_position_id`,
    ).all(accountId, assetId, conditionId) as unknown as PositionRow[];
    for (const position of positions) {
      this.database.prepare(
        `UPDATE paper_positions
         SET status='FROZEN',frozen_from_status=?,frozen_reason=?,frozen_at=?,updated_at=?
         WHERE paper_position_id=? AND status!='FROZEN'`,
      ).run(position.status, reason, now, now, position.paper_position_id);
      this.transition("PAPER_POSITION", position.paper_position_id, position.status, "FROZEN", reason, now);
    }
    return positions.length;
  }

  private unfreezeMarketPositionsInTransaction(
    accountId: string,
    assetId: string,
    conditionId: string,
    reason: string,
    now: string,
  ): number {
    const positions = this.database.prepare(
      `SELECT * FROM paper_positions
       WHERE paper_account_id=? AND asset_id=? AND condition_id=?
         AND status='FROZEN' AND frozen_reason LIKE 'MARKET_DATA:%'
       ORDER BY created_at,paper_position_id`,
    ).all(accountId, assetId, conditionId) as unknown as PositionRow[];
    for (const position of positions) {
      if (this.hasUnresolvedMajorReconciliation(position)) continue;
      const next = position.frozen_from_status ?? "OPEN";
      this.database.prepare(
        `UPDATE paper_positions
         SET status=?,frozen_from_status=NULL,frozen_reason=NULL,frozen_at=NULL,updated_at=?
         WHERE paper_position_id=? AND status='FROZEN'`,
      ).run(next, now, position.paper_position_id);
      this.transition("PAPER_POSITION", position.paper_position_id, "FROZEN", next, reason, now);
    }
    return positions.length;
  }

  private unfreezePositions(accountId: string, reason: string): number {
    const positions = this.database.prepare(
      `SELECT * FROM paper_positions
       WHERE paper_account_id=? AND status='FROZEN'
       ORDER BY created_at,paper_position_id`,
    ).all(accountId) as unknown as PositionRow[];
    const now = this.now().toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      for (const position of positions) {
        const marketHealth = this.marketDataHealthRow(
          position.paper_account_id,
          position.asset_id,
          position.condition_id,
        );
        if (marketHealth && ["DEGRADED", "FROZEN"].includes(marketHealth.state)) continue;
        const next = position.frozen_from_status ?? "OPEN";
        this.database.prepare(
          `UPDATE paper_positions
           SET status=?,frozen_from_status=NULL,frozen_reason=NULL,frozen_at=NULL,updated_at=?
           WHERE paper_position_id=? AND status='FROZEN'`,
        ).run(next, now, position.paper_position_id);
        this.transition("PAPER_POSITION", position.paper_position_id, "FROZEN", next, reason, now);
      }
      this.database.exec("COMMIT");
      return positions.length;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private openPositions(accountId: string, includeSettlementPending = false): PositionRow[] {
    return this.database.prepare(
      `SELECT * FROM paper_positions WHERE paper_account_id=? AND status IN (${includeSettlementPending ? "'OPEN','PARTIALLY_CLOSED','SETTLEMENT_PENDING'" : "'OPEN','PARTIALLY_CLOSED'"})
       ORDER BY created_at,paper_position_id`,
    ).all(accountId) as unknown as PositionRow[];
  }

  private hasUnresolvedMajorReconciliation(position: PositionRow): boolean {
    const row = this.database.prepare(
      `SELECT 1 blocker
       FROM signals s
       JOIN reconciliation_issues i ON i.target_id=s.target_id
       WHERE s.signal_id=?
         AND (i.asset_id IS NULL OR i.asset_id=?)
         AND i.sync_status='MAJOR_DESYNC' AND i.status!='RESOLVED'
       LIMIT 1`,
    ).get(position.signal_id, position.asset_id) as { blocker: number } | undefined;
    return row !== undefined;
  }
}
