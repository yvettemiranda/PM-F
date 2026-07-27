import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { operatorDashboardSnapshot } from "../src/operator/operator-dashboard.js";

const directories: string[] = [];
const wallet = "0x00000000000000000000000000000000000000ab";
const targetId = "target-1";
const accountId = "paper-account-1";
const signalId = "signal-1";
const now = "2026-07-27T08:00:00.000Z";

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "ni-k-operator-dashboard-"));
  directories.push(root);
  mkdirSync(join(root, "config"), { recursive: true });
  writeFileSync(join(root, "config/default-target-wallet.txt"), `${wallet}\n`);
  return root;
}

function installDatabase(root: string): void {
  const directory = join(root, "data/phase0");
  mkdirSync(directory, { recursive: true });
  const database = new DatabaseSync(join(directory, "phase0.sqlite"));
  database.exec(`
    CREATE TABLE monitor_targets (
      target_id TEXT PRIMARY KEY,
      wallet_address TEXT NOT NULL,
      identity_status TEXT NOT NULL,
      runtime_mode TEXT NOT NULL,
      sync_status TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO monitor_targets VALUES (
      '${targetId}','${wallet}','IDENTITY_CONFIRMED','OBSERVE_ONLY','SYNCED','${now}'
    );

    CREATE TABLE live_gate_state (
      state_id TEXT PRIMARY KEY,
      execution_mode TEXT NOT NULL,
      live_gate_state TEXT NOT NULL,
      requested_execution_mode TEXT,
      last_preflight_id TEXT,
      state_reason TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO live_gate_state VALUES (
      'default','PAPER','LIVE_DISABLED',NULL,NULL,'DEFAULT_DISABLED','${now}'
    );
    CREATE TABLE live_gate_prerequisites (
      prerequisite_key TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO live_gate_prerequisites VALUES (
      'USER_EXPLICIT_AUTHORIZATION','MISSING','{}','${now}'
    );

    CREATE TABLE observe_runs (
      observe_run_id TEXT PRIMARY KEY,
      target_id TEXT NOT NULL,
      state TEXT NOT NULL,
      recovered_from_checkpoint INTEGER NOT NULL,
      started_at TEXT NOT NULL,
      last_heartbeat_at TEXT NOT NULL,
      stopped_at TEXT,
      stop_reason TEXT,
      successful_polls INTEGER NOT NULL,
      failed_polls INTEGER NOT NULL,
      processed_events INTEGER NOT NULL,
      emitted_signals INTEGER NOT NULL,
      gap_events INTEGER NOT NULL,
      reconciliation_count INTEGER NOT NULL,
      campaign_id TEXT,
      campaign_session_id TEXT
    );
    INSERT INTO observe_runs VALUES (
      'observe-1','${targetId}','COMPLETED',0,'${now}','${now}','${now}','SAFE_STOP',
      20,0,1,1,0,4,'campaign-1','session-1'
    );
    CREATE TABLE observe_polls (
      poll_id TEXT PRIMARY KEY,
      observe_run_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      status TEXT NOT NULL,
      completed_at TEXT NOT NULL,
      trades_received INTEGER NOT NULL,
      activity_received INTEGER NOT NULL,
      positions_received INTEGER NOT NULL,
      new_events INTEGER NOT NULL,
      signals_emitted INTEGER NOT NULL,
      gap_events INTEGER NOT NULL,
      reconciliation_count INTEGER NOT NULL,
      error_detail TEXT,
      signal_enrichment_failures INTEGER NOT NULL,
      warning_detail TEXT
    );
    INSERT INTO observe_polls VALUES (
      'poll-1','observe-1',20,'SUCCESS','${now}',1,0,1,1,1,0,1,NULL,0,NULL
    );

    CREATE TABLE paper_accounts (
      paper_account_id TEXT PRIMARY KEY,
      target_id TEXT NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      initial_balance_micros TEXT NOT NULL,
      cash_balance_micros TEXT NOT NULL,
      reserved_balance_micros TEXT NOT NULL,
      realized_pnl_micros TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO paper_accounts VALUES (
      '${accountId}','${targetId}','Paper','ACTIVE','1000000000','742800000','0','18420000','${now}'
    );
    CREATE TABLE portfolio_projection_runs (
      projection_id TEXT PRIMARY KEY,
      paper_account_id TEXT NOT NULL,
      cash_balance_micros TEXT NOT NULL,
      reserved_balance_micros TEXT NOT NULL,
      available_balance_micros TEXT NOT NULL,
      position_value_micros TEXT NOT NULL,
      realized_pnl_micros TEXT NOT NULL,
      unrealized_pnl_micros TEXT NOT NULL,
      total_equity_micros TEXT NOT NULL,
      valuation_status TEXT NOT NULL,
      unpriced_position_count INTEGER NOT NULL,
      price_source TEXT,
      price_timestamp TEXT,
      created_at TEXT NOT NULL
    );
    INSERT INTO portfolio_projection_runs VALUES (
      'projection-1','${accountId}','742800000','0','742800000','257200000',
      '18420000','1000000','1000000000','COMPLETE',0,'ORDERBOOK_EXIT_VWAP','${now}','${now}'
    );

    CREATE TABLE signals (
      signal_id TEXT PRIMARY KEY,
      target_id TEXT NOT NULL,
      signal_type TEXT NOT NULL,
      status TEXT NOT NULL,
      asset_id TEXT NOT NULL,
      condition_id TEXT NOT NULL,
      target_price_units TEXT NOT NULL,
      target_size_micros TEXT NOT NULL,
      sell_ratio_numerator TEXT,
      sell_ratio_denominator TEXT,
      reason TEXT NOT NULL,
      execution_eligible INTEGER NOT NULL,
      execution_block_reason TEXT,
      event_classification TEXT NOT NULL,
      producer_mode TEXT NOT NULL,
      observe_run_id TEXT,
      created_at TEXT NOT NULL
    );
    INSERT INTO signals VALUES (
      '${signalId}','${targetId}','TARGET_BUY','PUBLISHED','asset-yes','condition-1',
      '520000000000000000','120000000',NULL,NULL,'POST_BASELINE_BUY',1,NULL,
      'STANDARD_TRADE','OBSERVE_ONLY','observe-1','${now}'
    );
    CREATE TABLE signal_execution_contexts (
      signal_id TEXT PRIMARY KEY,
      target_trade_capital_ratio_ppm TEXT,
      target_trade_timestamp TEXT NOT NULL,
      market_end_time TEXT NOT NULL,
      market_metadata_snapshot_json TEXT NOT NULL,
      market_end_time_status TEXT NOT NULL,
      execution_deadline_at TEXT
    );
    INSERT INTO signal_execution_contexts VALUES (
      '${signalId}','62400','${now}','2026-09-30T00:00:00.000Z',
      '{"question":"Will the Fed cut rates in September?","marketSlug":"fed-rates","tokens":[{"token_id":"asset-yes","outcome":"Yes"}]}',
      'VERIFIED','2026-07-27T08:30:00.000Z'
    );
    CREATE TABLE risk_decisions (
      risk_decision_id TEXT PRIMARY KEY,
      signal_id TEXT,
      executor_mode TEXT NOT NULL,
      account_id TEXT,
      decision TEXT NOT NULL,
      risk_reject_reason TEXT,
      risk_reason TEXT,
      requested_amount_micros TEXT,
      requested_size_micros TEXT,
      checks_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    INSERT INTO risk_decisions VALUES (
      'risk-1','${signalId}','PAPER','${accountId}','ALLOW',NULL,'ALL_CHECKS_PASSED',
      '25000000',NULL,'[]','${now}'
    );
    CREATE TABLE paper_executions (
      paper_execution_id TEXT PRIMARY KEY,
      paper_account_id TEXT NOT NULL,
      signal_id TEXT,
      risk_decision_id TEXT,
      execution_type TEXT NOT NULL,
      state TEXT NOT NULL,
      requested_amount_micros TEXT,
      requested_size_micros TEXT,
      filled_size_micros TEXT NOT NULL,
      filled_notional_micros TEXT NOT NULL,
      fee_micros TEXT NOT NULL,
      target_price_units TEXT,
      reason TEXT NOT NULL,
      attempt_count INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO paper_executions VALUES (
      'execution-1','${accountId}','${signalId}','risk-1','TARGET_BUY','EXECUTED',
      '25000000',NULL,'47700000','24947100','10000','520000000000000000',
      'FILLED','1','${now}','${now}'
    );
    CREATE TABLE paper_orders (
      paper_order_id TEXT PRIMARY KEY,
      paper_execution_id TEXT NOT NULL,
      side TEXT NOT NULL,
      state TEXT NOT NULL,
      requested_size_micros TEXT,
      requested_amount_micros TEXT,
      filled_size_micros TEXT NOT NULL,
      filled_notional_micros TEXT NOT NULL,
      vwap_price_units TEXT,
      fee_micros TEXT NOT NULL,
      reject_reason TEXT,
      created_at TEXT NOT NULL
    );
    INSERT INTO paper_orders VALUES (
      'order-1','execution-1','BUY','FILLED',NULL,'25000000','47700000',
      '24947100','523000000000000000','10000',NULL,'${now}'
    );
    CREATE TABLE paper_fill_ledger (
      fill_id TEXT PRIMARY KEY,
      paper_order_id TEXT NOT NULL,
      paper_execution_id TEXT NOT NULL,
      paper_position_id TEXT,
      side TEXT NOT NULL,
      price_units TEXT NOT NULL,
      size_micros TEXT NOT NULL,
      notional_micros TEXT NOT NULL,
      fee_micros TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    INSERT INTO paper_fill_ledger VALUES (
      'fill-1','order-1','execution-1','position-1','BUY','523000000000000000',
      '47700000','24947100','10000','${now}'
    );
    CREATE TABLE paper_positions (
      paper_position_id TEXT PRIMARY KEY,
      paper_account_id TEXT NOT NULL,
      signal_id TEXT NOT NULL,
      asset_id TEXT NOT NULL,
      condition_id TEXT NOT NULL,
      outcome TEXT,
      entry_price_units TEXT NOT NULL,
      current_size_micros TEXT NOT NULL,
      remaining_cost_micros TEXT NOT NULL,
      status TEXT NOT NULL,
      realized_pnl_micros TEXT NOT NULL,
      frozen_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO paper_positions VALUES (
      'position-1','${accountId}','${signalId}','asset-yes','condition-1','Yes',
      '523000000000000000','47700000','24947100','OPEN','0',NULL,'${now}','${now}'
    );

    CREATE TABLE reconciliation_issues (
      issue_id TEXT PRIMARY KEY,
      target_id TEXT NOT NULL,
      asset_id TEXT,
      issue_type TEXT NOT NULL,
      sync_status TEXT NOT NULL,
      status TEXT NOT NULL,
      detail_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      resolved_at TEXT
    );
    INSERT INTO reconciliation_issues VALUES (
      'issue-1','${targetId}',NULL,'TRANSIENT','MINOR_DIFF','RESOLVED','{}','${now}','${now}'
    );

    CREATE TABLE live_accounts (
      live_account_id TEXT PRIMARY KEY,
      live_wallet_id TEXT NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      initial_bankroll_micros TEXT NOT NULL,
      risk_budget_micros TEXT NOT NULL,
      authorized_signer_address TEXT,
      activated_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO live_accounts VALUES (
      'live-account-1','wallet-1','Live','DISABLED','1000000000','100000000',
      '${wallet}',NULL,'${now}','${now}'
    );
    CREATE TABLE live_executions (
      live_execution_id TEXT PRIMARY KEY,
      live_account_id TEXT NOT NULL,
      signal_id TEXT,
      risk_decision_id TEXT,
      live_gate_run_id TEXT,
      execution_type TEXT NOT NULL,
      state TEXT NOT NULL,
      requested_amount_micros TEXT,
      requested_size_micros TEXT,
      filled_size_micros TEXT NOT NULL,
      filled_notional_micros TEXT NOT NULL,
      fee_micros TEXT NOT NULL,
      target_price_units TEXT,
      reason TEXT NOT NULL,
      attempt_count INTEGER NOT NULL,
      deadline_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO live_executions VALUES (
      'live-execution-1','live-account-1','${signalId}','risk-1',NULL,'TARGET_BUY',
      'FAILED','1000000',NULL,'0','0','0','520000000000000000',
      'ADAPTER_UNAVAILABLE',1,NULL,'${now}','${now}'
    );
    CREATE TABLE live_orders (
      live_order_id TEXT PRIMARY KEY,
      live_execution_id TEXT NOT NULL,
      external_order_id TEXT,
      side TEXT NOT NULL,
      order_type TEXT NOT NULL,
      price_units TEXT NOT NULL,
      size_micros TEXT NOT NULL,
      filled_size_micros TEXT NOT NULL,
      filled_notional_micros TEXT NOT NULL,
      fee_micros TEXT NOT NULL,
      status TEXT NOT NULL,
      is_terminal INTEGER NOT NULL,
      confirmation_pending INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO live_orders VALUES (
      'live-order-1','live-execution-1',NULL,'BUY','FAK','520000000000000000',
      '1000000','0','0','0','FAILED',1,0,'${now}','${now}'
    );
    CREATE TABLE live_order_attempts (
      attempt_id TEXT PRIMARY KEY,
      live_order_id TEXT NOT NULL,
      attempt_sequence INTEGER NOT NULL,
      action TEXT NOT NULL,
      status TEXT NOT NULL,
      error_reason TEXT,
      request_json TEXT NOT NULL,
      response_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    INSERT INTO live_order_attempts VALUES (
      'attempt-1','live-order-1',1,'SUBMIT','FAILED','ADAPTER_UNAVAILABLE',
      '{"Authorization":"Bearer should-never-reach-ui"}',
      '{"apiKey":"should-never-reach-ui"}','${now}'
    );
  `);
  database.close();
}

describe("operator dashboard", () => {
  it("returns explicit empty states without creating a database", () => {
    const root = project();
    const snapshot = operatorDashboardSnapshot(root, { now: () => new Date(now) });

    expect(snapshot).toMatchObject({
      schemaVersion: "operator-dashboard-v1",
      generatedAt: now,
      database: { status: "NOT_INITIALIZED" },
      runtime: { state: "STOPPED" },
      paper: { account: null, portfolio: null },
      live: {
        gate: null,
        capability: {
          activation: "GATE_AVAILABLE_AFTER_DATABASE_INITIALIZATION",
          execution: "PENDING_PREREQUISITES",
        },
        production: {
          path: "PRODUCTION_LIVE",
          status: "PENDING_PREREQUISITES",
          nextStep: "CONNECT_FORMAL_WALLET",
        },
      },
      comparisons: [],
      signals: [],
    });
  });

  it("projects target, runtime, portfolio and target-versus-me events from SQLite", () => {
    const root = project();
    installDatabase(root);
    mkdirSync(join(root, "data/operator/logs"), { recursive: true });
    writeFileSync(
      join(root, "data/operator/logs/operator.log"),
      "Authorization: Bearer should-never-reach-ui\n",
    );

    const snapshot = operatorDashboardSnapshot(root, { now: () => new Date(now) });

    expect(snapshot.database, snapshot.database.error ?? "").toMatchObject({
      status: "AVAILABLE",
      error: null,
    });
    expect(snapshot.targetRuntime).toMatchObject({
      targetId,
      walletAddress: wallet,
      identityStatus: "IDENTITY_CONFIRMED",
      syncStatus: "SYNCED",
    });
    expect(snapshot.paper.account).toMatchObject({
      accountId,
      cash: { micros: "742800000", display: "742.80" },
    });
    expect(snapshot.paper.portfolio).toMatchObject({
      totalEquity: { micros: "1000000000", display: "1,000.00" },
      availableBalance: { display: "742.80" },
      positionValue: { display: "257.20" },
      valuationStatus: "COMPLETE",
    });
    expect(snapshot.comparisons).toHaveLength(1);
    expect(snapshot.comparisons[0]).toMatchObject({
      signalId,
      action: "BUY",
      outcome: "YES",
      market: { question: "Will the Fed cut rates in September?", slug: "fed-rates" },
      target: {
        price: { display: "0.520" },
        amount: { display: "62.40" },
        capitalRatio: { display: "6.24%" },
      },
      mine: {
        mode: "PAPER",
        decision: "FOLLOWED",
        executionState: "EXECUTED",
        averagePrice: { display: "0.523" },
        amount: { display: "24.95" },
      },
    });
    expect(snapshot.paper.orders).toHaveLength(1);
    expect(snapshot.paper.fills).toHaveLength(1);
    expect(snapshot.paper.positions).toHaveLength(1);
    expect(snapshot.live.gate).toMatchObject({
      executionMode: "PAPER",
      state: "LIVE_DISABLED",
      reason: "DEFAULT_DISABLED",
    });
    expect(snapshot.live.prerequisites).toEqual([
      expect.objectContaining({
        key: "USER_EXPLICIT_AUTHORIZATION",
        status: "MISSING",
      }),
    ]);
    expect(snapshot.live.attempts).toEqual([
      expect.objectContaining({
        attempt_id: "attempt-1",
        status: "FAILED",
        error_reason: "ADAPTER_UNAVAILABLE",
      }),
    ]);
    expect(snapshot.live.attempts[0]).not.toHaveProperty("request_json");
    expect(snapshot.live.attempts[0]).not.toHaveProperty("response_json");
    expect(snapshot.runtime.logs).toEqual([
      expect.objectContaining({
        name: "operator.log",
        sizeBytes: expect.any(Number),
      }),
    ]);
    expect(JSON.stringify(snapshot)).not.toContain("should-never-reach-ui");
  });
});
