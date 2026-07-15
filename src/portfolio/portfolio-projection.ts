import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { RULESET, stableJson, RULESET_HASH, VERSIONS } from "../domain/versioning.js";
import type { SourceVersion } from "../infra/source-version.js";
import { calculateUnrealizedPnl } from "../pnl/pnl-model.js";
import { isOrderbookUnavailableError } from "../execution/market-data.js";
import { matchPaperSell } from "../paper/matching.js";
import type {
  PaperAccountSnapshot,
  PaperFeeSnapshot,
  PaperMarketDataProvider,
  PaperOrderbookSnapshot,
} from "../paper/types.js";

interface AccountRow {
  initial_balance_micros: string;
}

interface CashLedgerRow {
  cash_delta_micros: string;
  reserved_delta_micros: string;
}

interface PnlLedgerRow {
  pnl_micros: string;
}

interface ProjectionPositionRow {
  paper_position_id: string;
  asset_id: string;
  condition_id: string;
  current_size_micros: string;
  remaining_cost_micros: string;
}

export interface PaperProjectionMarketHealth {
  shouldAttempt(accountId: string, assetId: string, conditionId: string): boolean;
  onUnavailable(
    accountId: string,
    assetId: string,
    conditionId: string,
    error: unknown,
    signal?: AbortSignal,
  ): Promise<void>;
  onFailure(accountId: string, assetId: string, conditionId: string, code: string, message: string): void;
  onSuccess(accountId: string, assetId: string, conditionId: string): boolean;
}

function hash(parts: Array<string | number>): string {
  return createHash("sha256").update(parts.join("|")).digest("hex");
}

function sumMicros<T>(rows: T[], value: (row: T) => string): bigint {
  return rows.reduce((total, row) => total + BigInt(value(row)), 0n);
}

export class PortfolioProjectionService {
  constructor(
    private readonly database: DatabaseSync,
    private readonly marketData: PaperMarketDataProvider,
    private readonly sourceVersion: SourceVersion,
    private readonly now: () => Date,
    private readonly marketHealth?: PaperProjectionMarketHealth,
  ) {}

  async projectPaperAccount(accountId: string, signal?: AbortSignal): Promise<PaperAccountSnapshot> {
    const account = this.account(accountId);
    const ledgerBalances = this.ledgerBalances(accountId);
    let positionValue = 0n;
    let unrealizedPnl = 0n;
    let unpricedPositionCount = 0;
    let pricedPositionCount = 0;
    const priceTimestamp = this.now().toISOString();
    const positions = this.positions(accountId).filter((position) => BigInt(position.current_size_micros) > 0n);
    const positionsByMarket = new Map<string, ProjectionPositionRow[]>();
    for (const position of positions) {
      const marketKey = `${position.asset_id}\u0000${position.condition_id.toLowerCase()}`;
      const group = positionsByMarket.get(marketKey) ?? [];
      group.push(position);
      positionsByMarket.set(marketKey, group);
    }

    for (const group of positionsByMarket.values()) {
      if (signal?.aborted) {
        unpricedPositionCount += group.length;
        continue;
      }
      const first = group[0]!;
      if (this.marketHealth && !this.marketHealth.shouldAttempt(accountId, first.asset_id, first.condition_id)) {
        unpricedPositionCount += group.length;
        continue;
      }
      try {
        const [book, fee] = await Promise.all([
          this.marketData.orderbook(first.asset_id, first.condition_id, signal),
          this.marketData.fee(first.asset_id, first.condition_id, signal),
        ]);
        if (signal?.aborted) {
          unpricedPositionCount += group.length;
          continue;
        }
        if (book.assetId !== first.asset_id || book.conditionId.toLowerCase() !== first.condition_id.toLowerCase()) {
          this.marketHealth?.onFailure(
            accountId,
            first.asset_id,
            first.condition_id,
            "ORDERBOOK_IDENTITY_MISMATCH",
            "Orderbook identity does not match the requested market",
          );
          unpricedPositionCount += group.length;
          continue;
        }
        if (fee.assetId !== first.asset_id) {
          this.marketHealth?.onFailure(
            accountId,
            first.asset_id,
            first.condition_id,
            "FEE_ASSET_IDENTITY_MISMATCH",
            "Fee identity does not match the requested asset",
          );
          unpricedPositionCount += group.length;
          continue;
        }
        if (fee.status !== "AVAILABLE" || fee.feeRatePpm === null || fee.exponent === null) {
          this.marketHealth?.onFailure(
            accountId,
            first.asset_id,
            first.condition_id,
            "FEE_MODEL_UNAVAILABLE",
            "Fee model unavailable during portfolio valuation",
          );
          unpricedPositionCount += group.length;
          continue;
        }
        const age = this.now().valueOf() - Date.parse(book.marketSnapshotTime);
        if (!Number.isFinite(age) || age < 0 || age > RULESET.orderbookMaxAgeMs) {
          this.marketHealth?.onFailure(
            accountId,
            first.asset_id,
            first.condition_id,
            "ORDERBOOK_STALE",
            `Orderbook age ${String(age)}ms`,
          );
          unpricedPositionCount += group.length;
          continue;
        }
        if (this.marketHealth && !this.marketHealth.onSuccess(accountId, first.asset_id, first.condition_id)) {
          unpricedPositionCount += group.length;
          continue;
        }
        const totalSize = group.reduce(
          (total, position) => total + BigInt(position.current_size_micros),
          0n,
        );
        const matched = matchPaperSell({
          bids: book.bids,
          requestedSizeMicros: totalSize,
          minimumPriceUnits: 0n,
          feeRatePpm: BigInt(fee.feeRatePpm),
          feeExponent: fee.exponent,
        });
        if (!matched.complete || matched.vwapPriceUnits === null) {
          unpricedPositionCount += group.length;
          continue;
        }
        const bookId = this.orderbookId(book);
        const feeId = this.feeId(fee);
        this.saveMarketSnapshots(book, fee, age);
        const exitValue = BigInt(matched.filledNotionalMicros);
        const exitFee = BigInt(matched.feeMicros);
        positionValue += exitValue - exitFee;
        let allocatedExitValue = 0n;
        let allocatedExitFee = 0n;
        group.forEach((position, index) => {
          const size = BigInt(position.current_size_micros);
          const isLast = index === group.length - 1;
          const positionExitValue = isLast
            ? exitValue - allocatedExitValue
            : (exitValue * size) / totalSize;
          const positionExitFee = isLast
            ? exitFee - allocatedExitFee
            : (exitFee * size) / totalSize;
          allocatedExitValue += positionExitValue;
          allocatedExitFee += positionExitFee;
          const positionUnrealized = calculateUnrealizedPnl({
            exitValueMicros: positionExitValue,
            estimatedExitFeeMicros: positionExitFee,
            remainingCostMicros: BigInt(position.remaining_cost_micros),
          });
          unrealizedPnl += positionUnrealized;
          this.database.prepare(
            `INSERT OR IGNORE INTO paper_unrealized_pnl_snapshots(
              unrealized_pnl_snapshot_id,paper_account_id,paper_position_id,position_value_micros,
              remaining_cost_micros,fee_micros,unrealized_pnl_micros,price_source,price_timestamp,
              orderbook_snapshot_id,fee_snapshot_id,ruleset_hash,source_code_commit,source_code_dirty,
              config_version,created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'ORDERBOOK_EXIT_VWAP', ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            hash([accountId, position.paper_position_id, bookId, feeId, priceTimestamp]),
            accountId,
            position.paper_position_id,
            (positionExitValue - positionExitFee).toString(),
            position.remaining_cost_micros,
            positionExitFee.toString(),
            positionUnrealized.toString(),
            book.marketSnapshotTime,
            bookId,
            feeId,
            RULESET_HASH,
            this.sourceVersion.commit,
            this.sourceVersion.dirty ? 1 : 0,
            VERSIONS.configVersion,
            priceTimestamp,
          );
        });
        pricedPositionCount += group.length;
      } catch (error) {
        const first = group[0]!;
        if (this.marketHealth) {
          if (isOrderbookUnavailableError(error)) {
            await this.marketHealth.onUnavailable(accountId, first.asset_id, first.condition_id, error, signal);
          } else if (!signal?.aborted) {
            this.marketHealth.onFailure(
              accountId,
              first.asset_id,
              first.condition_id,
              "MARKET_DATA_REQUEST_FAILED",
              error instanceof Error ? error.message : String(error),
            );
          }
        }
        unpricedPositionCount += group.length;
      }
    }

    const priceSource: PaperAccountSnapshot["priceSource"] = unpricedPositionCount === 0
      ? "ORDERBOOK_EXIT_VWAP"
      : pricedPositionCount === 0
        ? "UNAVAILABLE"
        : "PARTIAL_ORDERBOOK_EXIT_VWAP";

    const snapshot: PaperAccountSnapshot = {
      paperAccountId: accountId,
      initialBalanceMicros: account.initial_balance_micros,
      cashBalanceMicros: ledgerBalances.cash.toString(),
      reservedBalanceMicros: ledgerBalances.reserved.toString(),
      availableBalanceMicros: (ledgerBalances.cash - ledgerBalances.reserved).toString(),
      positionValueMicros: positionValue.toString(),
      realizedPnlMicros: ledgerBalances.realizedPnl.toString(),
      unrealizedPnlMicros: unrealizedPnl.toString(),
      totalEquityMicros: (ledgerBalances.cash + positionValue).toString(),
      valuationStatus: unpricedPositionCount === 0 ? "COMPLETE" : "INCOMPLETE",
      unpricedPositionCount,
      priceSource,
      priceTimestamp,
    };
    this.saveProjection(snapshot);
    return snapshot;
  }

  private account(accountId: string): AccountRow {
    const row = this.database.prepare(
      "SELECT initial_balance_micros FROM paper_accounts WHERE paper_account_id=?",
    ).get(accountId) as AccountRow | undefined;
    if (!row) throw new Error(`PAPER_ACCOUNT_NOT_FOUND:${accountId}`);
    return row;
  }

  private ledgerBalances(accountId: string): { cash: bigint; reserved: bigint; realizedPnl: bigint } {
    const cashRows = this.database.prepare(
      "SELECT cash_delta_micros,reserved_delta_micros FROM paper_cash_ledger WHERE paper_account_id=?",
    ).all(accountId) as unknown as CashLedgerRow[];
    const pnlRows = this.database.prepare(
      "SELECT pnl_micros FROM paper_pnl_ledger WHERE paper_account_id=?",
    ).all(accountId) as unknown as PnlLedgerRow[];
    return {
      cash: sumMicros(cashRows, (row) => row.cash_delta_micros),
      reserved: sumMicros(cashRows, (row) => row.reserved_delta_micros),
      realizedPnl: sumMicros(pnlRows, (row) => row.pnl_micros),
    };
  }

  private positions(accountId: string): ProjectionPositionRow[] {
    return this.database.prepare(
      `SELECT paper_position_id,asset_id,condition_id,current_size_micros,remaining_cost_micros
       FROM paper_positions
       WHERE paper_account_id=? AND status IN ('OPEN','PARTIALLY_CLOSED','SETTLEMENT_PENDING','FROZEN')
       ORDER BY created_at,paper_position_id`,
    ).all(accountId) as unknown as ProjectionPositionRow[];
  }

  private saveProjection(snapshot: PaperAccountSnapshot): void {
    const createdAt = this.now().toISOString();
    const projectionId = hash([
      "PORTFOLIO_PROJECTION",
      snapshot.paperAccountId,
      createdAt,
      snapshot.cashBalanceMicros,
      snapshot.reservedBalanceMicros,
      snapshot.positionValueMicros,
      snapshot.unrealizedPnlMicros,
    ]);
    this.database.prepare(
      `INSERT OR IGNORE INTO portfolio_projection_runs(
        projection_id,paper_account_id,cash_balance_micros,reserved_balance_micros,
        available_balance_micros,position_value_micros,realized_pnl_micros,
        unrealized_pnl_micros,total_equity_micros,valuation_status,
        unpriced_position_count,price_source,price_timestamp,ruleset_hash,
        source_code_commit,source_code_dirty,config_version,created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      projectionId,
      snapshot.paperAccountId,
      snapshot.cashBalanceMicros,
      snapshot.reservedBalanceMicros,
      snapshot.availableBalanceMicros,
      snapshot.positionValueMicros,
      snapshot.realizedPnlMicros,
      snapshot.unrealizedPnlMicros,
      snapshot.totalEquityMicros,
      snapshot.valuationStatus,
      snapshot.unpricedPositionCount,
      snapshot.priceSource,
      snapshot.priceTimestamp,
      RULESET_HASH,
      this.sourceVersion.commit,
      this.sourceVersion.dirty ? 1 : 0,
      VERSIONS.configVersion,
      createdAt,
    );
    this.database.prepare(
      `INSERT OR IGNORE INTO paper_portfolio_snapshots(
        portfolio_snapshot_id,paper_account_id,cash_balance_micros,reserved_balance_micros,
        available_balance_micros,position_value_micros,realized_pnl_micros,
        unrealized_pnl_micros,total_equity_micros,valuation_status,
        unpriced_position_count,ruleset_hash,price_source,price_timestamp,
        source_code_commit,source_code_dirty,config_version,created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      hash(["PAPER_PORTFOLIO_SNAPSHOT", projectionId]),
      snapshot.paperAccountId,
      snapshot.cashBalanceMicros,
      snapshot.reservedBalanceMicros,
      snapshot.availableBalanceMicros,
      snapshot.positionValueMicros,
      snapshot.realizedPnlMicros,
      snapshot.unrealizedPnlMicros,
      snapshot.totalEquityMicros,
      snapshot.valuationStatus,
      snapshot.unpricedPositionCount,
      RULESET_HASH,
      snapshot.priceSource,
      snapshot.priceTimestamp,
      this.sourceVersion.commit,
      this.sourceVersion.dirty ? 1 : 0,
      VERSIONS.configVersion,
      createdAt,
    );
  }

  private saveMarketSnapshots(book: PaperOrderbookSnapshot, fee: PaperFeeSnapshot, age: number): void {
    const payload = { bids: book.bids, asks: book.asks };
    this.database.prepare(
      `INSERT OR IGNORE INTO paper_orderbook_snapshots(
        orderbook_snapshot_id,asset_id,condition_id,market_snapshot_time,received_at,
        data_age_ms,payload_hash,bids_json,asks_json,source_url,created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      this.orderbookId(book),
      book.assetId,
      book.conditionId,
      book.marketSnapshotTime,
      book.receivedAt,
      age,
      createHash("sha256").update(stableJson(payload)).digest("hex"),
      JSON.stringify(book.bids),
      JSON.stringify(book.asks),
      book.sourceUrl,
      this.now().toISOString(),
    );
    this.database.prepare(
      `INSERT OR IGNORE INTO paper_fee_snapshots(
        fee_snapshot_id,asset_id,fee_rate_ppm,base_fee,fee_exponent,status,source_url,snapshot_time,created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      this.feeId(fee),
      fee.assetId,
      fee.feeRatePpm,
      fee.baseFee,
      fee.exponent,
      fee.status,
      fee.sourceUrl,
      fee.snapshotTime,
      this.now().toISOString(),
    );
  }

  private orderbookId(book: PaperOrderbookSnapshot): string {
    return hash([book.assetId, book.marketSnapshotTime, stableJson({ bids: book.bids, asks: book.asks })]);
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
}
