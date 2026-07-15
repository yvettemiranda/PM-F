import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { RULESET_HASH, RULESET_SNAPSHOT_JSON, VERSIONS } from "../src/domain/versioning.js";
import { Phase0Database } from "../src/infra/sqlite/database.js";
import type { SourceVersion } from "../src/infra/source-version.js";
import { PaperAcceptanceSummaryService } from "../src/paper/paper-acceptance-summary.js";

const sourceVersion: SourceVersion = { commit: "paper-acceptance-test", dirty: false };
const timestamp = "2026-07-15T00:00:00.000Z";
const directories: string[] = [];

function setup() {
  const directory = mkdtempSync(join(tmpdir(), "ni-k-paper-acceptance-"));
  directories.push(directory);
  const databasePath = join(directory, "phase0.sqlite");
  const phase0 = new Phase0Database(databasePath, sourceVersion);
  phase0.initialize();
  const targetId = phase0.ensureTarget("0x0000000000000000000000000000000000000001", "IDENTITY_CONFIRMED");
  phase0.close();

  const database = new DatabaseSync(databasePath);
  database.prepare(
    `INSERT INTO paper_accounts(
      paper_account_id,name,target_id,status,initial_balance_micros,cash_balance_micros,
      reserved_balance_micros,realized_pnl_micros,signal_cutoff_at,schema_version,
      strategy_version,risk_version,paper_version,ruleset_snapshot_json,ruleset_hash,
      source_code_commit,source_code_dirty,created_at,updated_at
    ) VALUES ('paper-acceptance','Acceptance',?,'ACTIVE','1000000000','1000000000','0','0',
      ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
  ).run(
    targetId,
    timestamp,
    VERSIONS.schemaVersion,
    VERSIONS.strategyVersion,
    VERSIONS.riskVersion,
    VERSIONS.paperVersion,
    RULESET_SNAPSHOT_JSON,
    RULESET_HASH,
    sourceVersion.commit,
    timestamp,
    timestamp,
  );
  database.prepare(
    `INSERT INTO paper_cash_ledger(
      cash_ledger_id,paper_account_id,paper_execution_id,entry_type,cash_delta_micros,
      reserved_delta_micros,cash_after_micros,reserved_after_micros,idempotency_key,created_at
    ) VALUES ('cash-initial','paper-acceptance',NULL,'INITIAL_DEPOSIT','1000000000','0',
      '1000000000','0','cash-initial',?)`,
  ).run(timestamp);
  database.close();
  return { databasePath, accountId: "paper-acceptance", targetId };
}

function insertExecution(
  database: DatabaseSync,
  executionId: string,
  type: "TARGET_BUY" | "TARGET_SELL" | "STOP_LOSS" | "SETTLEMENT",
  filledSize = "0",
  filledNotional = "0",
): void {
  database.prepare(
    `INSERT INTO paper_executions(
      paper_execution_id,paper_account_id,signal_id,execution_idempotency_key,
      execution_type,state,asset_id,condition_id,requested_amount_micros,
      requested_size_micros,filled_size_micros,filled_notional_micros,fee_micros,
      target_price_units,price_limit_lower_units,price_limit_upper_units,capital_mode,
      deadline_at,attempt_count,reason,context_id,schema_version,strategy_version,
      risk_version,paper_version,ruleset_hash,created_at,updated_at
    ) VALUES (?, 'paper-acceptance', NULL, ?, ?, 'EXECUTED', 'asset-acceptance',
      'condition-acceptance', NULL, ?, ?, ?, '0', NULL, NULL, NULL, NULL, NULL, 1,
      'ACCEPTANCE_TEST', NULL, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    executionId,
    `idem-${executionId}`,
    type,
    filledSize === "0" ? null : filledSize,
    filledSize,
    filledNotional,
    VERSIONS.schemaVersion,
    VERSIONS.strategyVersion,
    VERSIONS.riskVersion,
    VERSIONS.paperVersion,
    RULESET_HASH,
    timestamp,
    timestamp,
  );
}

function insertFill(
  database: DatabaseSync,
  executionId: string,
  side: "BUY" | "SELL",
  positionId: string | null = null,
): void {
  const orderId = `order-${executionId}`;
  database.prepare(
    `INSERT INTO paper_orders(
      paper_order_id,paper_execution_id,attempt_sequence,side,order_type,state,
      requested_size_micros,requested_amount_micros,filled_size_micros,
      filled_notional_micros,vwap_price_units,fee_micros,reject_reason,
      orderbook_snapshot_id,fee_snapshot_id,created_at
    ) VALUES (?, ?, 1, ?, 'FAK', 'FILLED', '100', NULL, '100', '50',
      '500000000000000000', '0', NULL, 'book-test', 'fee-test', ?)`,
  ).run(orderId, executionId, side, timestamp);
  database.prepare(
    `INSERT INTO paper_fill_ledger(
      fill_id,paper_order_id,paper_execution_id,paper_position_id,side,price_units,
      size_micros,notional_micros,fee_micros,level_sequence,created_at
    ) VALUES (?, ?, ?, ?, ?, '500000000000000000', '100', '50', '0', 0, ?)`,
  ).run(`fill-${executionId}`, orderId, executionId, positionId, side, timestamp);
}

function insertPosition(database: DatabaseSync): void {
  database.prepare(
    `INSERT INTO paper_positions(
      paper_position_id,paper_account_id,opening_execution_id,signal_id,asset_id,
      condition_id,outcome,entry_price_units,entry_size_micros,entry_notional_micros,
      entry_fee_micros,current_size_micros,remaining_cost_micros,stop_loss_price_units,
      status,frozen_from_status,frozen_reason,frozen_at,realized_pnl_micros,ruleset_hash,
      source_code_commit,source_code_dirty,config_version,created_at,updated_at
    ) VALUES ('position-test','paper-acceptance','buy-execution','signal-test',
      'asset-acceptance','condition-acceptance','Yes','500000000000000000','100','50',
      '0','100','50','250000000000000000','OPEN',NULL,NULL,NULL,'0',?,?,0,?,?,?)`,
  ).run(RULESET_HASH, sourceVersion.commit, VERSIONS.configVersion, timestamp, timestamp);
}

function insertPublishedSignalForTarget(
  database: DatabaseSync,
  targetId: string,
  signalId: string,
): void {
  const sourceKey = `source-${signalId}`;
  database.prepare(
    `INSERT INTO raw_events(
      source_event_key,target_id,identity_version,source_type,source_transaction_hash,
      source_timestamp,asset_id,condition_id,side,price_units,size_micros,gap_event,
      is_combo,raw_json,created_at,event_classification
    ) VALUES (?,?,'identity-v1','DATA_API_TRADE',?,1773014400,'asset-acceptance',
      'condition-acceptance','BUY','500000000000000000','100',0,0,'{}',?,
      'STANDARD_TRADE')`,
  ).run(sourceKey, targetId, `tx-${signalId}`, timestamp);
  database.prepare(
    `INSERT INTO signals(
      signal_id,signal_idempotency_key,source_event_key,signal_type,status,asset_id,
      condition_id,target_price_units,target_size_micros,sell_ratio_numerator,
      sell_ratio_denominator,reason,schema_version,signal_version,strategy_version,
      risk_version,replay_version,ruleset_snapshot_json,ruleset_hash,source_code_commit,
      created_at,execution_eligible,execution_block_reason,event_classification,
      capital_estimate_id,source_code_dirty,producer_mode
    ) VALUES (?,?,?,'TARGET_BUY','PUBLISHED','asset-acceptance','condition-acceptance',
      '500000000000000000','100',NULL,NULL,'ACCEPTANCE_TEST',?,?,?,?,?,?,?,?,?,1,NULL,
      'STANDARD_TRADE',NULL,0,'OBSERVE_ONLY')`,
  ).run(
    signalId,
    `idem-${signalId}`,
    sourceKey,
    VERSIONS.schemaVersion,
    VERSIONS.signalVersion,
    VERSIONS.strategyVersion,
    VERSIONS.riskVersion,
    VERSIONS.replayVersion,
    RULESET_SNAPSHOT_JSON,
    RULESET_HASH,
    sourceVersion.commit,
    timestamp,
  );
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("PaperAcceptanceSummaryService", () => {
  it("summarizes a clean account without mutating business data", () => {
    const env = setup();
    const before = new DatabaseSync(env.databasePath, { readOnly: true });
    const ledgerRowsBefore = (before.prepare("SELECT count(*) count FROM paper_cash_ledger").get() as { count: number }).count;
    before.close();

    const summary = new PaperAcceptanceSummaryService(env.databasePath, { now: () => new Date(timestamp) })
      .summarize(env.accountId);

    expect(summary.paperAccountId).toBe(env.accountId);
    expect(summary.targetId).toBe(env.targetId);
    expect(summary.consistency.passed).toBe(true);
    expect(summary.consistency.cash).toEqual({
      accountCashMicros: "1000000000",
      cashLedgerMicros: "1000000000",
      accountReservedMicros: "0",
      cashLedgerReservedMicros: "0",
      matches: true,
    });
    expect(summary.consistency.reservations).toMatchObject({
      accountReservedMicros: "0",
      activeReservationsMicros: "0",
      reservationLedgerMicros: "0",
      cashLedgerReservedMicros: "0",
      matches: true,
      reservationIssues: [],
    });
    expect(summary.consistency.negativeValues).toEqual({ count: 0, details: [] });
    expect(summary.consistency.orphans.total).toBe(0);
    expect(summary.consistency.aggregates.total).toBe(0);
    expect(summary.coverage).toEqual({
      BUY: "NOT_OBSERVED",
      SELL: "NOT_OBSERVED",
      STOP_LOSS: "NOT_OBSERVED",
      SETTLEMENT: "NOT_OBSERVED",
      REALIZED_PNL: "NOT_OBSERVED",
    });
    expect(summary.marketData).toEqual({ blockerCount: 0, blockers: [], records: [] });

    const after = new DatabaseSync(env.databasePath, { readOnly: true });
    expect((after.prepare("SELECT count(*) count FROM paper_cash_ledger").get() as { count: number }).count)
      .toBe(ledgerRowsBefore);
    after.close();
  });

  it("reports account-scoped ledger, reservation, negative-value, and market-data blockers", () => {
    const env = setup();
    const database = new DatabaseSync(env.databasePath);
    database.exec("PRAGMA foreign_keys=OFF");
    database.prepare(
      "UPDATE paper_accounts SET cash_balance_micros='999999999',reserved_balance_micros='10' WHERE paper_account_id=?",
    ).run(env.accountId);
    database.prepare(
      `INSERT INTO paper_reservations(
        reservation_id,paper_account_id,paper_execution_id,original_amount_micros,
        remaining_amount_micros,status,created_at,updated_at
      ) VALUES ('orphan-reservation',?, 'missing-execution','20','-1','ACTIVE',?,?)`,
    ).run(env.accountId, timestamp, timestamp);
    database.prepare(
      `INSERT INTO paper_market_data_health(
        paper_account_id,asset_id,condition_id,state,consecutive_failures,
        consecutive_successes,next_retry_at,last_error_code,last_error_message,
        last_failure_at,last_success_at,frozen_at,ruleset_hash,source_code_commit,
        source_code_dirty,config_version,created_at,updated_at
      ) VALUES (?, 'asset-bad','condition-bad','FROZEN',3,0,?,'NO_ORDERBOOK_EXISTS',
        'No orderbook exists',?,NULL,?,?,?,0,?,?,?)`,
    ).run(
      env.accountId,
      "2026-07-15T00:01:00.000Z",
      timestamp,
      timestamp,
      RULESET_HASH,
      sourceVersion.commit,
      VERSIONS.configVersion,
      timestamp,
      timestamp,
    );
    database.close();

    const summary = new PaperAcceptanceSummaryService(env.databasePath).summarize(env.accountId);

    expect(summary.consistency.passed).toBe(false);
    expect(summary.consistency.cash.matches).toBe(false);
    expect(summary.consistency.reservations.matches).toBe(false);
    expect(summary.consistency.negativeValues.details).toContain("paper_reservations:orphan-reservation:remaining_amount_micros");
    expect(summary.consistency.orphans.details).toContain("paper_reservations:orphan-reservation:execution");
    expect(summary.marketData.blockerCount).toBe(1);
    expect(summary.marketData.blockers[0]).toMatchObject({
      assetId: "asset-bad",
      conditionId: "condition-bad",
      state: "FROZEN",
      lastErrorCode: "NO_ORDERBOOK_EXISTS",
    });
  });

  it("rejects a cash ledger whose totals match but its recorded running balance does not", () => {
    const env = setup();
    const database = new DatabaseSync(env.databasePath);
    database.prepare(
      `INSERT INTO paper_cash_ledger(
        cash_ledger_id,paper_account_id,paper_execution_id,entry_type,cash_delta_micros,
        reserved_delta_micros,cash_after_micros,reserved_after_micros,idempotency_key,created_at
      ) VALUES ('cash-bad-after',?,NULL,'TEST','0','0','999999999','0',
        'cash-bad-after','2026-07-15T00:00:01.000Z')`,
    ).run(env.accountId);
    database.close();

    const summary = new PaperAcceptanceSummaryService(env.databasePath).summarize(env.accountId);

    expect(summary.consistency.cash.matches).toBe(true);
    expect(summary.consistency.passed).toBe(false);
    expect(summary.consistency.aggregates.details.some((issue) => issue.startsWith("CASH_LEDGER_AFTER:")))
      .toBe(true);
  });

  it("accepts a non-zero reservation only when account and both ledgers agree", () => {
    const env = setup();
    const database = new DatabaseSync(env.databasePath);
    insertExecution(database, "waiting-buy", "TARGET_BUY");
    database.prepare(
      "UPDATE paper_executions SET state='WAITING_EXECUTION' WHERE paper_execution_id='waiting-buy'",
    ).run();
    database.prepare(
      "UPDATE paper_accounts SET reserved_balance_micros='100' WHERE paper_account_id=?",
    ).run(env.accountId);
    database.prepare(
      `INSERT INTO paper_reservations(
        reservation_id,paper_account_id,paper_execution_id,original_amount_micros,
        remaining_amount_micros,status,created_at,updated_at
      ) VALUES ('reservation-active',?,'waiting-buy','100','100','ACTIVE',?,?)`,
    ).run(env.accountId, timestamp, timestamp);
    database.prepare(
      `INSERT INTO paper_reservation_ledger(
        reservation_ledger_id,reservation_id,paper_execution_id,entry_type,delta_micros,
        remaining_after_micros,idempotency_key,created_at
      ) VALUES ('reservation-ledger-active','reservation-active','waiting-buy','RESERVE',
        '100','100','reservation-ledger-active',?)`,
    ).run(timestamp);
    database.prepare(
      `INSERT INTO paper_cash_ledger(
        cash_ledger_id,paper_account_id,paper_execution_id,entry_type,cash_delta_micros,
        reserved_delta_micros,cash_after_micros,reserved_after_micros,idempotency_key,created_at
      ) VALUES ('cash-reserve',?,'waiting-buy','RESERVE','0','100','1000000000','100',
        'cash-reserve',?)`,
    ).run(env.accountId, timestamp);
    database.close();

    const summary = new PaperAcceptanceSummaryService(env.databasePath).summarize(env.accountId);

    expect(summary.consistency.passed).toBe(true);
    expect(summary.consistency.reservations).toMatchObject({
      accountReservedMicros: "100",
      activeReservationsMicros: "100",
      reservationLedgerMicros: "100",
      cashLedgerReservedMicros: "100",
      matches: true,
    });
  });

  it("rejects a reservation ledger whose totals match but row-by-row balances do not", () => {
    const env = setup();
    const database = new DatabaseSync(env.databasePath);
    insertExecution(database, "waiting-buy-chain", "TARGET_BUY");
    database.prepare(
      "UPDATE paper_executions SET state='WAITING_EXECUTION' WHERE paper_execution_id='waiting-buy-chain'",
    ).run();
    database.prepare(
      "UPDATE paper_accounts SET reserved_balance_micros='100' WHERE paper_account_id=?",
    ).run(env.accountId);
    database.prepare(
      `INSERT INTO paper_reservations(
        reservation_id,paper_account_id,paper_execution_id,original_amount_micros,
        remaining_amount_micros,status,created_at,updated_at
      ) VALUES ('reservation-chain',?,'waiting-buy-chain','100','100','ACTIVE',?,?)`,
    ).run(env.accountId, timestamp, timestamp);
    database.prepare(
      `INSERT INTO paper_reservation_ledger(
        reservation_ledger_id,reservation_id,paper_execution_id,entry_type,delta_micros,
        remaining_after_micros,idempotency_key,created_at
      ) VALUES ('reservation-chain-1','reservation-chain','waiting-buy-chain','RESERVE',
        '50','40','reservation-chain-1',?)`,
    ).run(timestamp);
    database.prepare(
      `INSERT INTO paper_reservation_ledger(
        reservation_ledger_id,reservation_id,paper_execution_id,entry_type,delta_micros,
        remaining_after_micros,idempotency_key,created_at
      ) VALUES ('reservation-chain-2','reservation-chain','waiting-buy-chain','RESERVE',
        '50','100','reservation-chain-2',?)`,
    ).run("2026-07-15T00:00:01.000Z");
    database.prepare(
      `INSERT INTO paper_cash_ledger(
        cash_ledger_id,paper_account_id,paper_execution_id,entry_type,cash_delta_micros,
        reserved_delta_micros,cash_after_micros,reserved_after_micros,idempotency_key,created_at
      ) VALUES ('cash-reserve-chain',?,'waiting-buy-chain','RESERVE','0','100',
        '1000000000','100','cash-reserve-chain',?)`,
    ).run(env.accountId, timestamp);
    database.close();

    const summary = new PaperAcceptanceSummaryService(env.databasePath).summarize(env.accountId);

    expect(summary.consistency.reservations.matches).toBe(false);
    expect(summary.consistency.reservations.reservationIssues)
      .toContain("AFTER_BALANCE:reservation-chain:0");
  });

  it("marks lifecycle coverage only when durable execution evidence exists", () => {
    const env = setup();
    const database = new DatabaseSync(env.databasePath);
    database.exec("PRAGMA foreign_keys=OFF");
    insertExecution(database, "buy-execution", "TARGET_BUY", "100", "50");
    insertPosition(database);
    insertFill(database, "buy-execution", "BUY", "position-test");
    insertExecution(database, "sell-execution", "TARGET_SELL", "100", "50");
    insertFill(database, "sell-execution", "SELL");
    database.prepare(
      `INSERT INTO paper_execution_positions(
        paper_execution_id,paper_position_id,requested_size_micros,filled_size_micros,created_at
      ) VALUES ('sell-execution','position-test','100','100',?)`,
    ).run(timestamp);
    insertExecution(database, "stop-execution", "STOP_LOSS", "100", "50");
    insertFill(database, "stop-execution", "SELL");
    database.prepare(
      `INSERT INTO paper_execution_positions(
        paper_execution_id,paper_position_id,requested_size_micros,filled_size_micros,created_at
      ) VALUES ('stop-execution','position-test','100','100',?)`,
    ).run(timestamp);
    insertExecution(database, "settlement-execution", "SETTLEMENT");
    database.prepare(
      "UPDATE paper_positions SET status='REDEEMED',current_size_micros='0',remaining_cost_micros='0' WHERE paper_position_id='position-test'",
    ).run();
    database.prepare(
      `INSERT INTO paper_settlements(
        paper_settlement_id,paper_position_id,paper_execution_id,condition_id,
        payout_numerator,payout_denominator,redeem_amount_micros,pnl_micros,
        resolution_snapshot_json,resolution_hash,created_at
      ) VALUES ('settlement-observed','position-test','settlement-execution',
        'condition-acceptance','1','1','100','10','{}','resolution-test',?)`,
    ).run(timestamp);
    database.prepare(
      `INSERT INTO paper_pnl_ledger(
        pnl_ledger_id,paper_account_id,paper_position_id,paper_execution_id,pnl_type,
        proceeds_micros,cost_basis_micros,fee_micros,pnl_micros,created_at
      ) VALUES ('pnl-observed',?,'position-test','sell-execution','REALIZED','50','40','0','10',?)`,
    ).run(env.accountId, timestamp);
    database.close();

    const summary = new PaperAcceptanceSummaryService(env.databasePath).summarize(env.accountId);

    expect(summary.coverage).toEqual({
      BUY: "OBSERVED_REAL",
      SELL: "OBSERVED_REAL",
      STOP_LOSS: "OBSERVED_REAL",
      SETTLEMENT: "OBSERVED_REAL",
      REALIZED_PNL: "OBSERVED_REAL",
    });
    expect(summary.consistency.aggregates.details).toContain("FEE_EVIDENCE:order-buy-execution");
  });

  it("keeps the account target immutable and reports historical execution target drift", () => {
    const env = setup();
    const database = new DatabaseSync(env.databasePath);
    expect(() => database.prepare(
      "UPDATE paper_accounts SET target_id=NULL WHERE paper_account_id=?",
    ).run(env.accountId)).toThrow("paper account target binding is immutable");
    database.exec("PRAGMA foreign_keys=OFF");
    database.prepare(
      `INSERT INTO monitor_targets(
        target_id,wallet_address,identity_status,baseline_at,runtime_mode,sync_status,
        created_at,updated_at
      ) VALUES ('other-target','0x0000000000000000000000000000000000000002',
        'IDENTITY_CONFIRMED',?,'OBSERVE_ONLY','SYNCED',?,?)`,
    ).run(timestamp, timestamp, timestamp);
    insertPublishedSignalForTarget(database, "other-target", "other-target-signal");
    insertExecution(database, "wrong-target-execution", "TARGET_BUY");
    database.prepare(
      "UPDATE paper_executions SET signal_id='other-target-signal' WHERE paper_execution_id='wrong-target-execution'",
    ).run();
    database.close();

    const summary = new PaperAcceptanceSummaryService(env.databasePath).summarize(env.accountId);

    expect(summary.consistency.passed).toBe(false);
    expect(summary.consistency.aggregates.details)
      .toContain("EXECUTION_TARGET:wrong-target-execution");
  });

  it("blocks an unresolved settlement error and clears it only after recovery evidence", () => {
    const env = setup();
    const database = new DatabaseSync(env.databasePath);
    database.exec("PRAGMA foreign_keys=OFF");
    insertExecution(database, "buy-execution", "TARGET_BUY");
    insertPosition(database);
    database.prepare(
      `INSERT INTO audit_log(
        audit_id,timestamp,entity_type,entity_id,action,reason,ruleset_hash,
        source_code_commit,source_code_dirty,config_version,metadata_json
      ) VALUES ('settlement-deferred',?,'PAPER_POSITION','position-test',
        'SETTLEMENT_DEFERRED','RESOLUTION_API_DOWN',?,?,0,?,'{}')`,
    ).run(timestamp, RULESET_HASH, sourceVersion.commit, VERSIONS.configVersion);
    database.close();

    const blocked = new PaperAcceptanceSummaryService(env.databasePath).summarize(env.accountId);
    expect(blocked.consistency.aggregates.details).toContain("SETTLEMENT_ISSUE:position-test");

    const recoveredDatabase = new DatabaseSync(env.databasePath);
    recoveredDatabase.prepare(
      `INSERT INTO audit_log(
        audit_id,timestamp,entity_type,entity_id,action,reason,ruleset_hash,
        source_code_commit,source_code_dirty,config_version,metadata_json
      ) VALUES ('settlement-recovered','2026-07-15T00:00:01.000Z','PAPER_POSITION',
        'position-test','SETTLEMENT_RECOVERED','SETTLEMENT_DATA_SOURCE_RECOVERED',
        ?,?,0,?,'{}')`,
    ).run(RULESET_HASH, sourceVersion.commit, VERSIONS.configVersion);
    recoveredDatabase.close();

    const recovered = new PaperAcceptanceSummaryService(env.databasePath).summarize(env.accountId);
    expect(recovered.consistency.aggregates.details).not.toContain("SETTLEMENT_ISSUE:position-test");
  });

  it("does not classify an orphan BUY fill as observed lifecycle coverage", () => {
    const env = setup();
    const database = new DatabaseSync(env.databasePath);
    database.exec("PRAGMA foreign_keys=OFF");
    insertExecution(database, "orphan-buy", "TARGET_BUY", "100", "50");
    insertFill(database, "orphan-buy", "BUY");
    database.close();

    const summary = new PaperAcceptanceSummaryService(env.databasePath).summarize(env.accountId);

    expect(summary.coverage.BUY).toBe("NOT_OBSERVED");
    expect(summary.consistency.orphans.details).toContain("paper_fill_ledger:fill-orphan-buy:order_or_execution");
  });

  it("fails clearly when the requested paper account does not exist", () => {
    const env = setup();
    expect(() => new PaperAcceptanceSummaryService(env.databasePath).summarize("missing-account"))
      .toThrow("PAPER_ACCOUNT_NOT_FOUND:missing-account");
  });
});
