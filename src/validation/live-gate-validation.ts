import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { RULESET_HASH, RULESET_SNAPSHOT_JSON, VERSIONS } from "../domain/versioning.js";
import {
  LIVE_ACTIVATION_CONFIRMATION_TEXT,
  LiveGateService,
  defaultLiveGateConfig,
} from "../live/live-gate-service.js";
import {
  FakeClockSafetyProvider,
  FakeComplianceProvider,
  FakeGeoblockProvider,
} from "../live/live-safety-provider.js";
import { MockBalanceProvider } from "../live/mock-balance-provider.js";
import { Phase0Database } from "../infra/sqlite/database.js";
import { check, errorCheck } from "./checks.js";
import type { ValidationCheckResult, ValidationValidator, ValidationValidatorContext } from "./types.js";

const WALLET = "0x0000000000000000000000000000000000000001";
const CONDITION_ID = `0x${"4".repeat(64)}`;
const ASSET_ID = "validation-live-asset";
const LIVE_ACCOUNT_ID = "validation-live-account";
const BAD_PAPER_ACCOUNT_ID = "validation-bad-paper-account";

function executionInput(signalId: string, riskDecisionId: string) {
  return {
    signalId,
    riskDecisionId,
    rulesetHash: RULESET_HASH,
    accountId: LIVE_ACCOUNT_ID,
    contextId: `context-${signalId}`,
    side: "BUY" as const,
    assetId: ASSET_ID,
    conditionId: CONDITION_ID,
    targetPriceUnits: "500000000000000000",
    targetSizeMicros: "10000000",
  };
}

export class LiveGateValidation implements ValidationValidator {
  readonly type = "LIVE_GATE" as const;

  async run(context: ValidationValidatorContext): Promise<ValidationCheckResult[]> {
    const fixtureDatabasePath = join(
      dirname(context.databasePath),
      `.live-gate-validation-${randomUUID()}.sqlite`,
    );
    const phase0 = new Phase0Database(fixtureDatabasePath, context.sourceVersion);
    phase0.initialize();
    phase0.close();
    const database = new DatabaseSync(fixtureDatabasePath);
    database.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;");
    const checkedAt = context.now().toISOString();
    const gate = new LiveGateService(
      fixtureDatabasePath,
      new MockBalanceProvider({
        status: "AVAILABLE",
        balanceMicros: "1000000000",
        reason: null,
        checkedAt,
        source: "VALIDATION_TEST_FIXTURE",
      }),
      { ...defaultLiveGateConfig(), runtimeEnvironment: "TEST" },
      {
        sourceVersion: context.sourceVersion,
        now: context.now,
        geoblockProvider: new FakeGeoblockProvider({
          status: "ALLOWED",
          checkedAt,
          source: "VALIDATION_TEST_FIXTURE",
          reason: null,
        }),
        complianceProvider: new FakeComplianceProvider({
          status: "ALLOWED",
          checkedAt,
          source: "VALIDATION_TEST_FIXTURE",
          policyVersion: "VALIDATION_TEST_POLICY",
          reason: null,
        }),
        clockProvider: new FakeClockSafetyProvider({
          status: "SAFE",
          offsetMs: 0,
          checkedAt,
          source: "VALIDATION_TEST_FIXTURE",
          reason: null,
        }),
      },
    );
    try {
      const results: ValidationCheckResult[] = [];
      this.insertWallet(database, checkedAt);
      this.insertLiveAccount(database, context, checkedAt);
      this.ensureSignal(database, context, "validation-allow", "validation-risk-allow", "ALLOW");
      this.ensureSignal(database, context, "validation-reject", "validation-risk-reject", "REJECT");

      const defaultReject = await gate.checkExecution(executionInput("validation-allow", "validation-risk-allow"));
      results.push(check({
        checkType: this.type,
        checkName: "default_live_disabled_rejects",
        status: !defaultReject.allowed && defaultReject.blockedReasons.some((reason) => reason.startsWith("NOT_LIVE_ACTIVE")) ? "PASS" : "FAIL",
        reason: !defaultReject.allowed ? defaultReject.blockedReasons.join(",") : "LIVE_ALLOWED_IN_DEFAULT_STATE",
        metrics: { allowed: defaultReject.allowed, blockedReasons: defaultReject.blockedReasons },
        now: context.now,
      }));

      const unauthorized = await gate.requestLiveActivation({ actor: "validation", reason: "unauthorized validation probe" });
      results.push(check({
        checkType: this.type,
        checkName: "no_authorization_rejects",
        status: unauthorized.allowed ? "FAIL" : "PASS",
        reason: unauthorized.allowed ? "UNAUTHORIZED_REQUEST_ALLOWED" : unauthorized.blockedReasons.join(","),
        metrics: { allowed: unauthorized.allowed, blockedReasons: unauthorized.blockedReasons },
        now: context.now,
      }));

      this.passPrerequisites(database, context);
      const request = await gate.requestLiveActivation({ actor: "validation", reason: "fake live path validation" });
      const confirm = request.allowed
        ? await gate.confirmLiveActivation({ actor: "validation", confirmationText: LIVE_ACTIVATION_CONFIRMATION_TEXT })
        : request;
      const fakeAllow = await gate.checkExecution(executionInput("validation-allow", "validation-risk-allow"));
      results.push(check({
        checkType: this.type,
        checkName: "fake_live_path_allows_only_in_validation_db",
        status: confirm.allowed && fakeAllow.allowed ? "PASS" : "FAIL",
        reason: confirm.allowed && fakeAllow.allowed ? "OK" : [...confirm.blockedReasons, ...fakeAllow.blockedReasons].join(","),
        metrics: { requestAllowed: request.allowed, confirmAllowed: confirm.allowed, executionAllowed: fakeAllow.allowed },
        now: context.now,
      }));

      const riskReject = await gate.checkExecution(executionInput("validation-reject", "validation-risk-reject"));
      results.push(check({
        checkType: this.type,
        checkName: "risk_reject_blocks_live",
        status: !riskReject.allowed && riskReject.blockedReasons.some((reason) => reason.startsWith("RISK_DECISION_NOT_ALLOW")) ? "PASS" : "FAIL",
        reason: !riskReject.allowed ? riskReject.blockedReasons.join(",") : "RISK_REJECT_ALLOWED",
        metrics: { allowed: riskReject.allowed, blockedReasons: riskReject.blockedReasons },
        now: context.now,
      }));

      this.insertBadPaperAccount(database, context);
      const reconciliationReject = await gate.preflight({ requestedExecutionMode: "LIVE" });
      database.prepare("DELETE FROM paper_accounts WHERE paper_account_id=?").run(BAD_PAPER_ACCOUNT_ID);
      results.push(check({
        checkType: this.type,
        checkName: "reconciliation_failure_blocks_live",
        status: !reconciliationReject.allowed && reconciliationReject.blockedReasons.some((reason) => reason.includes("CASH_LEDGER_MISMATCH")) ? "PASS" : "FAIL",
        reason: !reconciliationReject.allowed ? reconciliationReject.blockedReasons.join(",") : "RECONCILIATION_FAILURE_ALLOWED",
        metrics: { allowed: reconciliationReject.allowed, blockedReasons: reconciliationReject.blockedReasons },
        now: context.now,
      }));

      await gate.emergencyDisable({ actor: "validation", reason: "restore validation gate state" });
      const state = database.prepare("SELECT execution_mode,live_gate_state FROM live_gate_state WHERE state_id='default'")
        .get() as { execution_mode: string; live_gate_state: string };
      results.push(check({
        checkType: this.type,
        checkName: "final_live_gate_state_restored",
        status: state.execution_mode === "PAPER" && state.live_gate_state === "LIVE_DISABLED" ? "PASS" : "FAIL",
        reason: `${state.execution_mode}:${state.live_gate_state}`,
        metrics: state,
        now: context.now,
      }));
      return results.map((result) => ({
        ...result,
        metrics: {
          ...(result.metrics ?? {}),
          evidenceLevel: "CONTROLLED_ISOLATED_FAKE_LIVE",
          campaignBusinessEvidence: false,
        },
      }));
    } catch (error) {
      return [errorCheck({ checkType: this.type, checkName: "live_gate_exception", reason: "LIVE_GATE_VALIDATION_FAILED", error, now: context.now })];
    } finally {
      gate.close();
      database.close();
      rmSync(fixtureDatabasePath, { force: true });
      rmSync(`${fixtureDatabasePath}-wal`, { force: true });
      rmSync(`${fixtureDatabasePath}-shm`, { force: true });
    }
  }

  private passPrerequisites(database: DatabaseSync, context: ValidationValidatorContext): void {
    const now = context.now().toISOString();
    const evidence = JSON.stringify({
      evidenceType: "VALIDATION_TEST_FIXTURE",
      checkedAt: now,
      sourceCodeCommit: context.sourceVersion.commit,
      environment: "TEST",
      testOnly: true,
    });
    database.prepare("UPDATE live_gate_prerequisites SET status='PASSED',evidence_json=?,updated_at=?")
      .run(evidence, now);
  }

  private insertWallet(database: DatabaseSync, now: string): void {
    database.prepare(
      `INSERT OR IGNORE INTO live_wallets(
        live_wallet_id,wallet_address,wallet_type,network,status,created_at,updated_at
      ) VALUES ('validation-live-wallet', ?, 'EOA', 'POLYGON', 'ACTIVE', ?, ?)`,
    ).run(WALLET, now, now);
  }

  private insertLiveAccount(database: DatabaseSync, context: ValidationValidatorContext, now: string): void {
    database.prepare(
      `INSERT OR IGNORE INTO live_accounts(
        live_account_id,live_wallet_id,name,status,initial_bankroll_micros,risk_budget_micros,
        signal_cutoff_at,schema_version,strategy_version,risk_version,live_version,ruleset_hash,
        source_code_commit,source_code_dirty,config_version,activated_at,created_at,updated_at,
        authorized_signer_address
      ) VALUES (?, 'validation-live-wallet', 'Validation Live Account', 'ACTIVE',
        '1000000000', '500000000', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      LIVE_ACCOUNT_ID,
      now,
      VERSIONS.schemaVersion,
      VERSIONS.strategyVersion,
      VERSIONS.riskVersion,
      VERSIONS.liveVersion,
      RULESET_HASH,
      context.sourceVersion.commit,
      context.sourceVersion.dirty ? 1 : 0,
      VERSIONS.configVersion,
      now,
      now,
      now,
      WALLET,
    );
  }

  private ensureTarget(database: DatabaseSync, now: string): string {
    const existing = database.prepare("SELECT target_id FROM monitor_targets WHERE wallet_address=?").get(WALLET) as { target_id: string } | undefined;
    if (existing) return existing.target_id;
    database.prepare(
      `INSERT INTO monitor_targets(target_id,wallet_address,identity_status,baseline_at,runtime_mode,sync_status,created_at,updated_at)
       VALUES ('validation-target', ?, 'IDENTITY_CONFIRMED', ?, 'OBSERVE_ONLY', 'SYNCED', ?, ?)`,
    ).run(WALLET, now, now, now);
    return "validation-target";
  }

  private ensureSignal(
    database: DatabaseSync,
    context: ValidationValidatorContext,
    signalId: string,
    riskDecisionId: string,
    decision: "ALLOW" | "REJECT",
  ): void {
    const now = context.now().toISOString();
    const marketEndTime = new Date(context.now().valueOf() + 24 * 60 * 60 * 1_000).toISOString();
    const targetId = this.ensureTarget(database, now);
    const sourceKey = `source-${signalId}`;
    database.prepare(
      `INSERT OR IGNORE INTO raw_events(
        source_event_key,target_id,identity_version,source_type,source_transaction_hash,
        source_timestamp,asset_id,condition_id,side,price_units,size_micros,gap_event,
        is_combo,raw_json,created_at,event_classification
      ) VALUES (?, ?, 'validation', 'DATA_API_TRADE', ?, 1773014400, ?, ?, 'BUY',
        '500000000000000000', '10000000', 0, 0, '{}', ?, 'STANDARD_TRADE')`,
    ).run(sourceKey, targetId, `tx-${signalId}`, ASSET_ID, CONDITION_ID, now);
    database.prepare(
      `INSERT OR IGNORE INTO signals(
        signal_id,target_id,signal_idempotency_key,source_event_key,signal_type,status,asset_id,
        condition_id,target_price_units,target_size_micros,sell_ratio_numerator,
        sell_ratio_denominator,reason,schema_version,signal_version,strategy_version,
        risk_version,replay_version,ruleset_snapshot_json,ruleset_hash,source_code_commit,
        created_at,execution_eligible,execution_block_reason,event_classification,
        capital_estimate_id,source_code_dirty,producer_mode
      ) VALUES (?, ?, ?, ?, 'TARGET_BUY', 'PUBLISHED', ?, ?, '500000000000000000',
        '10000000', NULL, NULL, 'VALIDATION', ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL,
        'STANDARD_TRADE', NULL, ?, 'OBSERVE_ONLY')`,
    ).run(
      signalId,
      targetId,
      `idem-${signalId}`,
      sourceKey,
      ASSET_ID,
      CONDITION_ID,
      VERSIONS.schemaVersion,
      VERSIONS.signalVersion,
      VERSIONS.strategyVersion,
      VERSIONS.riskVersion,
      VERSIONS.replayVersion,
      RULESET_SNAPSHOT_JSON,
      RULESET_HASH,
      context.sourceVersion.commit,
      now,
      context.sourceVersion.dirty ? 1 : 0,
    );
    const contextId = `context-${signalId}`;
    database.prepare(
      `INSERT OR IGNORE INTO signal_execution_contexts(
        context_id,target_id,signal_id,capital_decision_id,target_trade_capital_ratio_ppm,
        target_trade_timestamp,market_end_time,market_metadata_snapshot_json,
        market_metadata_hash,ruleset_hash,schema_version,signal_version,strategy_version,
        source_code_commit,source_code_dirty,config_version,created_at
      ) VALUES (?, ?, ?, NULL, '100000', ?, ?, '{}', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      contextId,
      targetId,
      signalId,
      now,
      marketEndTime,
      `metadata-${signalId}`,
      RULESET_HASH,
      VERSIONS.schemaVersion,
      VERSIONS.signalVersion,
      VERSIONS.strategyVersion,
      context.sourceVersion.commit,
      context.sourceVersion.dirty ? 1 : 0,
      VERSIONS.configVersion,
      now,
    );
    database.prepare(
      `INSERT OR IGNORE INTO risk_decisions(
        risk_decision_id,executor_mode,paper_account_id,account_id,signal_id,context_id,decision,
        risk_reject_reason,requested_amount_micros,requested_size_micros,checks_json,
        schema_version,strategy_version,risk_version,ruleset_hash,source_code_commit,
        source_code_dirty,config_version,created_at,risk_reason
      ) VALUES (?, 'LIVE', NULL, ?, ?, ?, ?, ?, '5000000', '10000000', '[]', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      riskDecisionId,
      LIVE_ACCOUNT_ID,
      signalId,
      contextId,
      decision,
      decision === "REJECT" ? "VALIDATION_REJECT" : null,
      VERSIONS.schemaVersion,
      VERSIONS.strategyVersion,
      VERSIONS.riskVersion,
      RULESET_HASH,
      context.sourceVersion.commit,
      context.sourceVersion.dirty ? 1 : 0,
      VERSIONS.configVersion,
      now,
      decision,
    );
  }

  private insertBadPaperAccount(database: DatabaseSync, context: ValidationValidatorContext): void {
    const now = context.now().toISOString();
    database.prepare(
      `INSERT OR IGNORE INTO paper_accounts(
        paper_account_id,name,status,initial_balance_micros,cash_balance_micros,
        reserved_balance_micros,realized_pnl_micros,signal_cutoff_at,schema_version,
        strategy_version,risk_version,paper_version,ruleset_snapshot_json,ruleset_hash,
        source_code_commit,source_code_dirty,created_at,updated_at
      ) VALUES (?, 'Validation Bad Account', 'ACTIVE', '1000', '1000', '0', '0', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      BAD_PAPER_ACCOUNT_ID,
      now,
      VERSIONS.schemaVersion,
      VERSIONS.strategyVersion,
      VERSIONS.riskVersion,
      VERSIONS.paperVersion,
      RULESET_SNAPSHOT_JSON,
      RULESET_HASH,
      context.sourceVersion.commit,
      context.sourceVersion.dirty ? 1 : 0,
      now,
      now,
    );
  }
}
