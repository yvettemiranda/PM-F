import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { stableJson } from "../domain/versioning.js";
import type { PaperSignalEnvelope, SignalExecutionContext } from "../paper/types.js";

interface SignalIntegrityRow {
  signal_type: string;
  status: string;
  execution_eligible: number;
  execution_block_reason: string | null;
  asset_id: string;
  condition_id: string;
  target_price_units: string;
  target_size_micros: string;
  sell_ratio_numerator: string | null;
  sell_ratio_denominator: string | null;
  created_at: string;
  signal_ruleset_hash: string;
  signal_source_code_commit: string;
  signal_source_code_dirty: number;
  capital_estimate_id: string | null;
  context_id: string;
  context_signal_id: string;
  capital_decision_id: string | null;
  target_trade_capital_ratio_ppm: string | null;
  target_trade_timestamp: string;
  market_end_time: string;
  market_metadata_snapshot_json: string;
  market_metadata_hash: string;
  context_ruleset_hash: string;
  context_source_code_commit: string;
  context_source_code_dirty: number;
  config_version: string;
  context_created_at: string;
}

/**
 * Verifies the exact immutable Signal + Execution Context that an executor is
 * about to consume. IDs alone are insufficient: a caller must not be able to
 * reuse an ALLOW Risk Decision with an in-memory price, asset or ratio change.
 */
export function executionEnvelopeIntegrityError(
  database: DatabaseSync,
  signal: PaperSignalEnvelope,
  context: SignalExecutionContext,
): string | null {
  if (!signal.context || signal.context.contextId !== context.contextId) return "SIGNAL_CONTEXT_INPUT_MISMATCH";
  if (signal.signalId !== context.signalId) return "SIGNAL_CONTEXT_SIGNAL_ID_MISMATCH";
  const row = database.prepare(
    `SELECT s.signal_type,s.status,s.execution_eligible,s.execution_block_reason,
            s.asset_id,s.condition_id,s.target_price_units,s.target_size_micros,
            s.sell_ratio_numerator,s.sell_ratio_denominator,s.created_at,
            s.ruleset_hash signal_ruleset_hash,s.source_code_commit signal_source_code_commit,
            s.source_code_dirty signal_source_code_dirty,s.capital_estimate_id,
            c.context_id,c.signal_id context_signal_id,c.capital_decision_id,
            c.target_trade_capital_ratio_ppm,c.target_trade_timestamp,c.market_end_time,
            c.market_metadata_snapshot_json,c.market_metadata_hash,
            c.ruleset_hash context_ruleset_hash,c.source_code_commit context_source_code_commit,
            c.source_code_dirty context_source_code_dirty,c.config_version,c.created_at context_created_at
     FROM signals s
     JOIN signal_execution_contexts c ON c.signal_id=s.signal_id
     WHERE s.signal_id=?`,
  ).get(signal.signalId) as SignalIntegrityRow | undefined;
  if (!row) return "SIGNAL_OR_CONTEXT_NOT_FOUND";
  const signalMatches = row.signal_type === signal.signalType
    && row.status === signal.status
    && (row.execution_eligible === 1) === signal.executionEligible
    && row.execution_block_reason === signal.executionBlockReason
    && row.asset_id === signal.assetId
    && row.condition_id === signal.conditionId
    && row.target_price_units === signal.targetPriceUnits
    && row.target_size_micros === signal.targetSizeMicros
    && row.sell_ratio_numerator === signal.sellRatioNumerator
    && row.sell_ratio_denominator === signal.sellRatioDenominator
    && row.created_at === signal.createdAt
    && row.signal_ruleset_hash === context.rulesetHash
    && row.capital_estimate_id === context.capitalDecisionId;
  if (!signalMatches) return "SIGNAL_IMMUTABLE_FIELDS_MISMATCH";
  let metadataMatches = false;
  let metadataHashMatches = false;
  try {
    const canonicalMetadata = stableJson(JSON.parse(row.market_metadata_snapshot_json));
    metadataMatches = canonicalMetadata === stableJson(context.marketMetadataSnapshot);
    metadataHashMatches = createHash("sha256").update(canonicalMetadata).digest("hex") === row.market_metadata_hash;
  } catch {
    return "EXECUTION_CONTEXT_METADATA_INVALID";
  }
  const contextMatches = row.context_id === context.contextId
    && row.context_signal_id === context.signalId
    && row.capital_decision_id === context.capitalDecisionId
    && row.target_trade_capital_ratio_ppm === context.targetTradeCapitalRatioPpm
    && row.target_trade_timestamp === context.targetTradeTimestamp
    && row.market_end_time === context.marketEndTime
    && metadataMatches
    && metadataHashMatches
    && row.market_metadata_hash === context.marketMetadataHash
    && row.context_ruleset_hash === context.rulesetHash
    && row.context_source_code_commit === context.sourceCodeCommit
    && (row.context_source_code_dirty === 1) === context.sourceCodeDirty
    && row.config_version === context.configVersion
    && row.context_created_at === context.createdAt;
  if (!contextMatches) return "EXECUTION_CONTEXT_IMMUTABLE_FIELDS_MISMATCH";
  if (
    row.signal_source_code_commit !== row.context_source_code_commit
    || row.signal_source_code_dirty !== row.context_source_code_dirty
  ) return "SIGNAL_CONTEXT_PRODUCER_VERSION_MISMATCH";
  if (row.capital_decision_id === null) {
    if (signal.capitalDecision !== null) return "SIGNAL_CAPITAL_DECISION_MISMATCH";
  } else {
    const capital = database.prepare(
      `SELECT capital_estimate_status,capital_confidence,target_trade_capital_ratio_ppm,
              fallback_amount_micros
       FROM capital_estimates WHERE capital_estimate_id=?`,
    ).get(row.capital_decision_id) as {
      capital_estimate_status: string;
      capital_confidence: string;
      target_trade_capital_ratio_ppm: string | null;
      fallback_amount_micros: string;
    } | undefined;
    if (
      !capital
      || !signal.capitalDecision
      || capital.capital_estimate_status !== signal.capitalDecision.status
      || capital.capital_confidence !== signal.capitalDecision.confidence
      || capital.target_trade_capital_ratio_ppm !== signal.capitalDecision.ratioPpm
      || capital.fallback_amount_micros !== signal.capitalDecision.fallbackAmountMicros
    ) return "SIGNAL_CAPITAL_DECISION_MISMATCH";
  }
  return null;
}

export function assertExecutionEnvelopeIntegrity(
  database: DatabaseSync,
  signal: PaperSignalEnvelope,
  context: SignalExecutionContext,
): void {
  const failure = executionEnvelopeIntegrityError(database, signal, context);
  if (failure) throw new Error(failure);
}
