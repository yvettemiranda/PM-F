import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { RULESET_HASH, stableJson, VERSIONS } from "../domain/versioning.js";
import type { SourceVersion } from "../infra/source-version.js";
import type { PaperSignalEnvelope } from "../paper/types.js";
import { RiskManager } from "../risk/risk-manager.js";
import type { LiveExecutor } from "./live-executor.js";
import {
  calculateBuyCapitalSizing,
  type BuyCapitalSizingDecision,
  type ExactCapitalRatioSnapshot,
} from "../execution/capital-sizing.js";

export interface LiveSignalConsumptionResult {
  signalId: string;
  riskDecisionId: string | null;
  executionId: string | null;
  state: string;
}

interface LoadedLiveSignal {
  signal: PaperSignalEnvelope;
  signalSequence: number;
  rulesetHash: string;
}

interface ConsumerCheckpoint {
  signal_cutoff_at: string;
  cutoff_signal_sequence: number;
  activation_transition_id: string | null;
}

function hash(parts: string[]): string {
  return createHash("sha256").update(parts.join("|")).digest("hex");
}

const PRICE_SCALE = 1_000_000_000_000_000_000n;

export class LiveSignalConsumer {
  private readonly database: DatabaseSync;
  private readonly riskManager: RiskManager;

  constructor(
    databasePath: string,
    private readonly executor: LiveExecutor,
    private readonly sourceVersion: SourceVersion,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.database = new DatabaseSync(databasePath);
    this.database.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;");
    this.riskManager = new RiskManager(this.database, sourceVersion);
  }

  async consumeAvailableSignals(accountId: string, limit = 100): Promise<LiveSignalConsumptionResult[]> {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 1_000) throw new Error("LIVE_SIGNAL_CONSUMER_LIMIT_INVALID");
    const checkpoint = this.ensureCheckpoint(accountId);
    const rows = this.database.prepare(
      `SELECT s.signal_id,q.signal_sequence
       FROM signals s
       JOIN signal_ingest_sequences q ON q.signal_id=s.signal_id
       LEFT JOIN live_signal_consumptions c
         ON c.live_account_id=? AND c.signal_id=s.signal_id
       LEFT JOIN live_signal_quarantines x
         ON x.live_account_id=? AND x.signal_id=s.signal_id
       WHERE s.status='PUBLISHED' AND s.execution_eligible=1
         AND q.signal_sequence>? AND c.signal_id IS NULL AND x.signal_id IS NULL
       ORDER BY q.signal_sequence
       LIMIT ?`,
    ).all(accountId, accountId, checkpoint.cutoff_signal_sequence, limit) as unknown as Array<{
      signal_id: string;
      signal_sequence: number;
    }>;
    const results: LiveSignalConsumptionResult[] = [];
    for (const row of rows) {
      let loaded: LoadedLiveSignal;
      let requested: { amount: bigint | null; size: bigint | null; capitalSizingDecision: BuyCapitalSizingDecision | null };
      try {
        loaded = this.loadSignal(row.signal_id, row.signal_sequence);
        requested = loaded.signal.signalType === "TARGET_BUY"
          ? { ...this.buyAmount(accountId, loaded.signal), size: null }
          : { amount: null, size: this.sellSize(accountId, loaded.signal), capitalSizingDecision: null };
      } catch (error) {
        const reason = error instanceof Error ? error.message : "LIVE_SIGNAL_PREPARATION_FAILED";
        this.recordQuarantine(accountId, row.signal_id, row.signal_sequence, "PRE_RISK_VALIDATION", reason);
        results.push({
          signalId: row.signal_id,
          riskDecisionId: null,
          executionId: null,
          state: "QUARANTINED",
        });
        continue;
      }
      const signal = loaded.signal;
      const risk = this.riskManager.evaluate({
        mode: "LIVE",
        accountId,
        signal,
        requestedAmountMicros: requested.amount,
        requestedSizeMicros: requested.size,
        capitalSizingDecision: requested.capitalSizingDecision,
        now: this.now().toISOString(),
      });
      let result: { executionId: string; state: string };
      if (risk.decision === "REJECT") {
        result = await this.executor.recordRiskRejectedSignal({
          accountId,
          signal,
          riskDecisionId: risk.riskDecisionId,
        });
      } else {
        if (!signal.context) {
          this.recordQuarantine(
            accountId,
            signal.signalId,
            loaded.signalSequence,
            "POST_RISK_INVARIANT",
            "RISK_ALLOW_WITHOUT_EXECUTION_CONTEXT",
            risk.riskDecisionId,
          );
          results.push({
            signalId: signal.signalId,
            riskDecisionId: risk.riskDecisionId,
            executionId: null,
            state: "QUARANTINED",
          });
          continue;
        }
        result = signal.signalType === "TARGET_BUY"
          ? await this.executor.executeBuy({
            accountId,
            signal,
            context: signal.context,
            riskDecisionId: risk.riskDecisionId,
          })
          : await this.executor.executeSell({
            accountId,
            signal,
            context: signal.context,
            riskDecisionId: risk.riskDecisionId,
          });
      }
      this.recordConsumption(
        accountId,
        loaded,
        risk.riskDecisionId,
        result.executionId,
        result.state,
      );
      results.push({
        signalId: signal.signalId,
        riskDecisionId: risk.riskDecisionId,
        executionId: result.executionId,
        state: result.state,
      });
    }
    return results;
  }

  /** Synchronizes the consumer with the exact boundary captured by the latest
   * successful LIVE_ACTIVE gate transition. */
  syncActiveGateBoundary(accountId: string): {
    transitionId: string;
    activatedAt: string;
    signalBoundarySequence: number;
  } {
    const state = this.database.prepare(
      "SELECT execution_mode,live_gate_state FROM live_gate_state WHERE state_id='default'",
    ).get() as { execution_mode: string; live_gate_state: string } | undefined;
    if (state?.execution_mode !== "LIVE" || state.live_gate_state !== "LIVE_ACTIVE") {
      throw new Error("LIVE_SIGNAL_BOUNDARY_GATE_NOT_ACTIVE");
    }
    const activation = this.database.prepare(
      `SELECT transition_id,created_at,signal_boundary_sequence
       FROM live_gate_state_transitions
       WHERE to_execution_mode='LIVE' AND to_live_gate_state='LIVE_ACTIVE'
         AND signal_boundary_sequence IS NOT NULL
       ORDER BY rowid DESC LIMIT 1`,
    ).get() as {
      transition_id: string;
      created_at: string;
      signal_boundary_sequence: number;
    } | undefined;
    if (!activation) throw new Error("LIVE_ACTIVATION_SIGNAL_BOUNDARY_MISSING");
    this.advanceBoundary({
      accountId,
      cutoffAt: activation.created_at,
      cutoffSignalSequence: activation.signal_boundary_sequence,
      activationTransitionId: activation.transition_id,
      reason: "LIVE_GATE_BECAME_ACTIVE",
    });
    return {
      transitionId: activation.transition_id,
      activatedAt: activation.created_at,
      signalBoundarySequence: activation.signal_boundary_sequence,
    };
  }

  /** Backwards-compatible administrative cutoff. Runtime activation must use
   * syncActiveGateBoundary() so it cannot invent a boundary from poll time. */
  advanceCutoff(accountId: string, cutoffAt: string, reason: string): void {
    const parsed = Date.parse(cutoffAt);
    if (!Number.isFinite(parsed)) throw new Error("LIVE_SIGNAL_CUTOFF_INVALID");
    const boundary = this.database.prepare(
      `SELECT COALESCE(MAX(q.signal_sequence),0) value
       FROM signal_ingest_sequences q
       JOIN signals s ON s.signal_id=q.signal_id
       WHERE s.created_at<?`,
    ).get(cutoffAt) as { value: number };
    this.advanceBoundary({
      accountId,
      cutoffAt,
      cutoffSignalSequence: boundary.value,
      activationTransitionId: null,
      reason,
    });
  }

  recordRuntimeError(accountId: string, operation: string, message: string): void {
    const now = this.now().toISOString();
    this.database.prepare(
      `INSERT INTO audit_log(
        audit_id,timestamp,entity_type,entity_id,action,reason,ruleset_hash,
        source_code_commit,source_code_dirty,config_version,metadata_json
      ) VALUES (?, ?, 'LIVE_RUNNER', ?, 'RUNTIME_ERROR', ?, ?, ?, ?, ?, ?)`,
    ).run(
      hash(["AUDIT", "LIVE_RUNNER", accountId, operation, now, randomUUID()]),
      now,
      accountId,
      message,
      RULESET_HASH,
      this.sourceVersion.commit,
      this.sourceVersion.dirty ? 1 : 0,
      VERSIONS.configVersion,
      stableJson({ operation }),
    );
  }

  close(): void {
    this.database.close();
  }

  private ensureCheckpoint(accountId: string): ConsumerCheckpoint {
    const account = this.database.prepare(
      "SELECT signal_cutoff_at FROM live_accounts WHERE live_account_id=? AND status='ACTIVE'",
    ).get(accountId) as { signal_cutoff_at: string } | undefined;
    if (!account) throw new Error(`LIVE_ACCOUNT_NOT_ACTIVE:${accountId}`);
    const existing = this.database.prepare(
      `SELECT signal_cutoff_at,cutoff_signal_sequence,activation_transition_id
       FROM live_consumer_checkpoints WHERE live_account_id=?`,
    ).get(accountId) as ConsumerCheckpoint | undefined;
    if (existing) return existing;
    const boundary = this.database.prepare(
      `SELECT COALESCE(MAX(q.signal_sequence),0) value
       FROM signal_ingest_sequences q
       JOIN signals s ON s.signal_id=q.signal_id
       WHERE s.created_at<?`,
    ).get(account.signal_cutoff_at) as { value: number };
    const now = this.now().toISOString();
    this.database.prepare(
      `INSERT INTO live_consumer_checkpoints(
        live_account_id,signal_cutoff_at,last_signal_created_at,last_signal_id,updated_at,
        cutoff_signal_sequence,activation_transition_id,last_signal_sequence
      ) VALUES (?, ?, NULL, NULL, ?, ?, NULL, NULL)`,
    ).run(accountId, account.signal_cutoff_at, now, boundary.value);
    return {
      signal_cutoff_at: account.signal_cutoff_at,
      cutoff_signal_sequence: boundary.value,
      activation_transition_id: null,
    };
  }

  private advanceBoundary(input: {
    accountId: string;
    cutoffAt: string;
    cutoffSignalSequence: number;
    activationTransitionId: string | null;
    reason: string;
  }): void {
    if (!Number.isSafeInteger(input.cutoffSignalSequence) || input.cutoffSignalSequence < 0) {
      throw new Error("LIVE_SIGNAL_BOUNDARY_SEQUENCE_INVALID");
    }
    const account = this.database.prepare(
      "SELECT signal_cutoff_at FROM live_accounts WHERE live_account_id=? AND status='ACTIVE'",
    ).get(input.accountId) as { signal_cutoff_at: string } | undefined;
    if (!account) throw new Error(`LIVE_ACCOUNT_NOT_ACTIVE:${input.accountId}`);
    const current = this.ensureCheckpoint(input.accountId);
    if (
      input.activationTransitionId !== null
      && current.activation_transition_id === input.activationTransitionId
    ) return;
    const effectiveSequence = Math.max(current.cutoff_signal_sequence, input.cutoffSignalSequence);
    const effectiveAt = Date.parse(current.signal_cutoff_at) > Date.parse(input.cutoffAt)
      ? current.signal_cutoff_at
      : input.cutoffAt;
    const skipped = this.database.prepare(
      `SELECT count(*) count
       FROM signal_ingest_sequences q
       JOIN signals s ON s.signal_id=q.signal_id
       LEFT JOIN live_signal_consumptions c
         ON c.live_account_id=? AND c.signal_id=s.signal_id
       LEFT JOIN live_signal_quarantines x
         ON x.live_account_id=? AND x.signal_id=s.signal_id
       WHERE s.status='PUBLISHED' AND s.execution_eligible=1
         AND q.signal_sequence>? AND q.signal_sequence<=?
         AND c.signal_id IS NULL AND x.signal_id IS NULL`,
    ).get(
      input.accountId,
      input.accountId,
      current.cutoff_signal_sequence,
      effectiveSequence,
    ) as { count: number };
    const now = this.now().toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(
        `UPDATE live_consumer_checkpoints
         SET signal_cutoff_at=?,cutoff_signal_sequence=?,activation_transition_id=?,updated_at=?
         WHERE live_account_id=?`,
      ).run(
        effectiveAt,
        effectiveSequence,
        input.activationTransitionId,
        now,
        input.accountId,
      );
      this.database.prepare(
        `INSERT INTO audit_log(
          audit_id,timestamp,entity_type,entity_id,action,reason,ruleset_hash,
          source_code_commit,source_code_dirty,config_version,metadata_json
        ) VALUES (?, ?, 'LIVE_CONSUMER_CHECKPOINT', ?, 'CUTOFF_ADVANCED', ?, ?, ?, ?, ?, ?)`,
      ).run(
        hash([
          "AUDIT",
          "LIVE_CONSUMER_CHECKPOINT",
          input.accountId,
          effectiveSequence.toString(),
          input.activationTransitionId ?? "MANUAL",
          now,
          randomUUID(),
        ]),
        now,
        input.accountId,
        input.reason,
        RULESET_HASH,
        this.sourceVersion.commit,
        this.sourceVersion.dirty ? 1 : 0,
        VERSIONS.configVersion,
        stableJson({
          previousCutoffAt: current.signal_cutoff_at,
          cutoffAt: effectiveAt,
          previousSignalBoundarySequence: current.cutoff_signal_sequence,
          signalBoundarySequence: effectiveSequence,
          activationTransitionId: input.activationTransitionId,
          skippedSignals: skipped.count,
        }),
      );
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private buyAmount(accountId: string, signal: PaperSignalEnvelope): {
    amount: bigint | null;
    capitalSizingDecision: BuyCapitalSizingDecision;
  } {
    const account = this.database.prepare(
      "SELECT initial_bankroll_micros FROM live_accounts WHERE live_account_id=?",
    ).get(accountId) as { initial_bankroll_micros: string } | undefined;
    if (!account) throw new Error(`LIVE_ACCOUNT_NOT_FOUND:${accountId}`);
    const cashRows = this.database.prepare(
      "SELECT cash_delta_micros,reserved_delta_micros FROM live_cash_ledger WHERE live_account_id=?",
    ).all(accountId) as unknown as Array<{ cash_delta_micros: string; reserved_delta_micros: string }>;
    const projection = cashRows.reduce((total, row) => ({
      cash: total.cash + BigInt(row.cash_delta_micros),
      reserved: total.reserved + BigInt(row.reserved_delta_micros),
    }), { cash: BigInt(account.initial_bankroll_micros), reserved: 0n });
    const available = projection.cash > projection.reserved ? projection.cash - projection.reserved : 0n;
    const capitalSizingDecision = calculateBuyCapitalSizing({
      accountCapitalMicros: available,
      capitalDecision: signal.capitalDecision,
      exactRatio: signal.context?.capitalSizingRatio ?? null,
      exactRatioHash: signal.context?.capitalSizingRatioHash ?? null,
    });
    return {
      amount: capitalSizingDecision.result === "CALCULATED"
        && capitalSizingDecision.calculatedAmountMicros !== null
        ? BigInt(capitalSizingDecision.calculatedAmountMicros)
        : null,
      capitalSizingDecision,
    };
  }

  private sellSize(accountId: string, signal: PaperSignalEnvelope): bigint | null {
    if (
      signal.sellRatioNumerator === null
      || signal.sellRatioDenominator === null
      || !/^\d+$/.test(signal.sellRatioNumerator)
      || !/^\d+$/.test(signal.sellRatioDenominator)
    ) return null;
    const numerator = BigInt(signal.sellRatioNumerator);
    const denominator = BigInt(signal.sellRatioDenominator);
    if (denominator <= 0n || numerator <= 0n) return null;
    const rows = this.database.prepare(
      `SELECT current_size_micros FROM live_positions
       WHERE live_account_id=? AND asset_id=? AND status IN ('OPEN','PARTIALLY_CLOSED')
       ORDER BY created_at,live_position_id`,
    ).all(accountId, signal.assetId) as unknown as Array<{ current_size_micros: string }>;
    const total = rows.reduce((sum, row) => sum + BigInt(row.current_size_micros), 0n);
    if (total <= 0n) return null;
    const requested = (total * numerator) / denominator;
    if (requested <= 0n) return null;
    return requested < total ? requested : total;
  }

  private recordConsumption(
    accountId: string,
    loaded: LoadedLiveSignal,
    riskDecisionId: string,
    executionId: string,
    state: string,
  ): void {
    const { signal } = loaded;
    const now = this.now().toISOString();
    const result = state === "REJECTED" ? "REJECTED" : "ACCEPTED";
    const execution = this.database.prepare(
      "SELECT reason FROM live_executions WHERE live_execution_id=?",
    ).get(executionId) as { reason: string } | undefined;
    const idempotencyKey = `LIVE_SIGNAL_CONSUMPTION:${accountId}:${signal.signalId}`;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(
        `INSERT OR IGNORE INTO live_signal_consumptions(
          live_account_id,signal_id,risk_decision_id,live_execution_id,consumption_result,
          reason,idempotency_key,ruleset_hash,source_code_commit,source_code_dirty,
          config_version,created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        accountId,
        signal.signalId,
        riskDecisionId,
        executionId,
        result,
        execution?.reason ?? state,
        idempotencyKey,
        loaded.rulesetHash,
        this.sourceVersion.commit,
        this.sourceVersion.dirty ? 1 : 0,
        VERSIONS.configVersion,
        now,
      );
      this.database.prepare(
        `UPDATE live_consumer_checkpoints
         SET last_signal_created_at=CASE
               WHEN last_signal_sequence IS NULL OR last_signal_sequence<?
               THEN ? ELSE last_signal_created_at END,
             last_signal_id=CASE
               WHEN last_signal_sequence IS NULL OR last_signal_sequence<?
               THEN ? ELSE last_signal_id END,
             last_signal_sequence=CASE
               WHEN last_signal_sequence IS NULL OR last_signal_sequence<?
               THEN ? ELSE last_signal_sequence END,
             updated_at=?
         WHERE live_account_id=?`,
      ).run(
        loaded.signalSequence,
        signal.createdAt,
        loaded.signalSequence,
        signal.signalId,
        loaded.signalSequence,
        loaded.signalSequence,
        now,
        accountId,
      );
      this.database.prepare(
        `INSERT INTO audit_log(
          audit_id,timestamp,entity_type,entity_id,action,reason,ruleset_hash,
          source_code_commit,source_code_dirty,config_version,metadata_json
        ) VALUES (?, ?, 'LIVE_SIGNAL_CONSUMPTION', ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        hash(["AUDIT", "LIVE_SIGNAL_CONSUMPTION", accountId, signal.signalId, now, randomUUID()]),
        now,
        `${accountId}:${signal.signalId}`,
        result,
        execution?.reason ?? state,
        loaded.rulesetHash,
        this.sourceVersion.commit,
        this.sourceVersion.dirty ? 1 : 0,
        VERSIONS.configVersion,
        stableJson({ riskDecisionId, executionId, state }),
      );
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private recordQuarantine(
    accountId: string,
    signalId: string,
    signalSequence: number,
    failureStage: string,
    reason: string,
    riskDecisionId: string | null = null,
    executionId: string | null = null,
  ): void {
    const signal = this.database.prepare(
      "SELECT created_at,ruleset_hash FROM signals WHERE signal_id=?",
    ).get(signalId) as { created_at: string; ruleset_hash: string } | undefined;
    if (!signal) throw new Error(`SIGNAL_NOT_FOUND:${signalId}`);
    const registered = this.database.prepare(
      "SELECT 1 ok FROM ruleset_registry WHERE ruleset_hash=?",
    ).get(signal.ruleset_hash);
    const rulesetHash = registered ? signal.ruleset_hash : RULESET_HASH;
    const safeReason = reason.slice(0, 2_000);
    const now = this.now().toISOString();
    const idempotencyKey = `LIVE_SIGNAL_QUARANTINE:${accountId}:${signalId}`;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(
        `INSERT OR IGNORE INTO live_signal_quarantines(
          live_account_id,signal_id,signal_sequence,failure_stage,reason,risk_decision_id,
          live_execution_id,idempotency_key,ruleset_hash,source_code_commit,
          source_code_dirty,config_version,created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        accountId,
        signalId,
        signalSequence,
        failureStage,
        safeReason,
        riskDecisionId,
        executionId,
        idempotencyKey,
        rulesetHash,
        this.sourceVersion.commit,
        this.sourceVersion.dirty ? 1 : 0,
        VERSIONS.configVersion,
        now,
      );
      this.database.prepare(
        `UPDATE live_consumer_checkpoints
         SET last_signal_created_at=CASE
               WHEN last_signal_sequence IS NULL OR last_signal_sequence<?
               THEN ? ELSE last_signal_created_at END,
             last_signal_id=CASE
               WHEN last_signal_sequence IS NULL OR last_signal_sequence<?
               THEN ? ELSE last_signal_id END,
             last_signal_sequence=CASE
               WHEN last_signal_sequence IS NULL OR last_signal_sequence<?
               THEN ? ELSE last_signal_sequence END,
             updated_at=?
         WHERE live_account_id=?`,
      ).run(
        signalSequence,
        signal.created_at,
        signalSequence,
        signalId,
        signalSequence,
        signalSequence,
        now,
        accountId,
      );
      this.database.prepare(
        `INSERT INTO audit_log(
          audit_id,timestamp,entity_type,entity_id,action,reason,ruleset_hash,
          source_code_commit,source_code_dirty,config_version,metadata_json
        ) VALUES (?, ?, 'LIVE_SIGNAL_QUARANTINE', ?, 'QUARANTINED', ?, ?, ?, ?, ?, ?)`,
      ).run(
        hash(["AUDIT", "LIVE_SIGNAL_QUARANTINE", accountId, signalId, now, randomUUID()]),
        now,
        `${accountId}:${signalId}`,
        safeReason,
        rulesetHash,
        this.sourceVersion.commit,
        this.sourceVersion.dirty ? 1 : 0,
        VERSIONS.configVersion,
        stableJson({
          failureStage,
          signalSequence,
          riskDecisionId,
          executionId,
          originalRulesetHash: signal.ruleset_hash,
        }),
      );
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private loadSignal(signalId: string, signalSequence: number): LoadedLiveSignal {
    const row = this.database.prepare(
      `SELECT s.signal_id,s.signal_type,s.status,s.execution_eligible,s.execution_block_reason,
              s.asset_id,s.condition_id,s.target_price_units,s.target_size_micros,
              s.sell_ratio_numerator,s.sell_ratio_denominator,s.created_at,
              s.ruleset_hash signal_ruleset_hash,
              c.context_id,c.signal_id context_signal_id,c.capital_decision_id,c.target_trade_capital_ratio_ppm,
              c.capital_sizing_ratio_json,c.capital_sizing_ratio_hash,
              c.target_trade_timestamp,c.market_end_time,c.market_metadata_snapshot_json,
              c.market_metadata_hash,c.ruleset_hash context_ruleset_hash,
              c.source_code_commit context_source_code_commit,
              c.source_code_dirty context_source_code_dirty,
              c.config_version context_config_version,c.created_at context_created_at,
              ce.capital_estimate_status,ce.capital_confidence,
              ce.target_trade_capital_ratio_ppm capital_ratio_ppm,ce.fallback_amount_micros
       FROM signals s
       LEFT JOIN signal_execution_contexts c ON c.signal_id=s.signal_id
       LEFT JOIN capital_estimates ce ON ce.capital_estimate_id=c.capital_decision_id
       WHERE s.signal_id=?`,
    ).get(signalId) as Record<string, unknown> | undefined;
    if (!row) throw new Error(`SIGNAL_NOT_FOUND:${signalId}`);
    if (row.signal_type !== "TARGET_BUY" && row.signal_type !== "TARGET_SELL") {
      throw new Error("SIGNAL_TYPE_INVALID");
    }
    const priceText = row.target_price_units as string;
    const sizeText = row.target_size_micros as string;
    if (!/^\d+$/.test(priceText) || BigInt(priceText) <= 0n || BigInt(priceText) >= PRICE_SCALE) {
      throw new Error("SIGNAL_TARGET_PRICE_INVALID");
    }
    if (!/^\d+$/.test(sizeText) || BigInt(sizeText) <= 0n) {
      throw new Error("SIGNAL_TARGET_SIZE_INVALID");
    }
    if (!Number.isFinite(Date.parse(row.created_at as string))) throw new Error("SIGNAL_CREATED_AT_INVALID");
    let metadata: Record<string, unknown> | null = null;
    if (row.context_id) {
      const parsed = JSON.parse(row.market_metadata_snapshot_json as string) as unknown;
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("EXECUTION_CONTEXT_METADATA_INVALID");
      }
      metadata = parsed as Record<string, unknown>;
      if (
        row.context_signal_id !== undefined
        && row.context_signal_id !== row.signal_id
      ) throw new Error("EXECUTION_CONTEXT_SIGNAL_MISMATCH");
      if (!Number.isFinite(Date.parse(row.target_trade_timestamp as string))) {
        throw new Error("EXECUTION_CONTEXT_TARGET_TIME_INVALID");
      }
      if (!Number.isFinite(Date.parse(row.market_end_time as string))) {
        throw new Error("EXECUTION_CONTEXT_MARKET_END_INVALID");
      }
      const metadataHash = createHash("sha256").update(stableJson(metadata)).digest("hex");
      if (metadataHash !== row.market_metadata_hash) throw new Error("EXECUTION_CONTEXT_METADATA_HASH_MISMATCH");
    }
    const context = row.context_id ? {
      contextId: row.context_id as string,
      signalId: row.signal_id as string,
      capitalDecisionId: row.capital_decision_id as string | null,
      targetTradeCapitalRatioPpm: row.target_trade_capital_ratio_ppm as string | null,
      capitalSizingRatio: row.capital_sizing_ratio_json
        ? JSON.parse(row.capital_sizing_ratio_json as string) as ExactCapitalRatioSnapshot
        : null,
      capitalSizingRatioHash: row.capital_sizing_ratio_hash as string | null,
      targetTradeTimestamp: row.target_trade_timestamp as string,
      marketEndTime: row.market_end_time as string,
      marketMetadataSnapshot: metadata!,
      marketMetadataHash: row.market_metadata_hash as string,
      rulesetHash: row.context_ruleset_hash as string,
      sourceCodeCommit: row.context_source_code_commit as string,
      sourceCodeDirty: (row.context_source_code_dirty as number) !== 0,
      configVersion: row.context_config_version as string,
      createdAt: row.context_created_at as string,
    } : null;
    const signal: PaperSignalEnvelope = {
      signalId: row.signal_id as string,
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
      context,
      capitalDecision: row.capital_estimate_status ? {
        status: row.capital_estimate_status as "COMPLETE" | "INCOMPLETE" | "FAILED",
        confidence: row.capital_confidence as "HIGH" | "MEDIUM" | "LOW",
        ratioPpm: row.capital_ratio_ppm as string | null,
        fallbackAmountMicros: row.fallback_amount_micros as string,
      } : null,
    };
    return {
      signal,
      signalSequence,
      rulesetHash: row.context_ruleset_hash
        ? row.context_ruleset_hash as string
        : row.signal_ruleset_hash as string,
    };
  }
}
