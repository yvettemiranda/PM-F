import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, parseAbi, zeroAddress, type Hex } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RULESET_HASH, RULESET_SNAPSHOT_JSON, stableJson, VERSIONS } from "../src/domain/versioning.js";
import { LiveAccountRegistry } from "../src/live/live-account-registry.js";
import { LiveStore } from "../src/live/live-store.js";
import { LiveExecutor } from "../src/live/live-executor.js";
import { LiveCrashRecovery } from "../src/live/live-crash-recovery.js";
import type { LiveExecutionGate, LiveFillEvent, LiveOrderRequest } from "../src/live/live-types.js";
import type { LiveAccountActionGateInput } from "../src/live/live-gate-types.js";
import type { PaperSignalEnvelope, SignalExecutionContext } from "../src/paper/types.js";
import { Phase0Database } from "../src/infra/sqlite/database.js";
import { BrowserWalletRedeemAdapter, type TransactionReceiptResult, type TransactionReceiptProvider } from "../src/live/browser-wallet-onchain.js";
import { RedemptionJournal } from "../src/live/redemption-journal.js";
import { marketRoute, type PolymarketMarketRoute } from "../src/live/market-protocol.js";
import type { PolygonChainReader } from "../src/live/polygon-chain-reader.js";
import type { RedeemInput } from "../src/live/redeem-adapter.js";
import type { LiveWalletRuntimeBinding } from "../src/operator/live-wallet-session.js";

const directories: string[] = [];
const sourceVersion = { commit: "redemption-integration-test", dirty: false };
const wallet = "0x0000000000000000000000000000000000000001";
const transactionHash = `0x${"1".repeat(64)}`;
const now = "2026-07-11T00:00:00.000Z";
const events = parseAbi([
  "event Transfer(address indexed from,address indexed to,uint256 value)",
  "event TransferSingle(address indexed operator,address indexed from,address indexed to,uint256 id,uint256 value)",
]);
const v2Condition = `0x${"a".repeat(62)}`;
const v2Asset = ((BigInt(v2Condition) << 8n) | 1n).toString();
const v2Route = marketRoute({ assetId: v2Asset, conditionId: v2Condition, version: "v2" });
const accountId = "redemption-managed-account";
interface TestRuleset { hash: string; snapshotJson: string; configVersion: string }

function binding() : LiveWalletRuntimeBinding {
  return {
    session: { sessionId: "isolated-session", status: "CONNECTED", walletAddress: wallet,
      chainId: 137, network: "POLYGON", walletType: "EIP1193", connectedAt: now,
      lastSeenAt: now, expiresAt: "2026-07-11T01:00:00.000Z" },
    assertCurrent: vi.fn(), onInvalidated: vi.fn(() => () => undefined),
  };
}

function inputFor(route = v2Route): RedeemInput {
  return { positionId: "lot-one", assetId: route.assetId, conditionId: route.conditionId,
    idempotencyKey: "redeem-managed-group", marketRoute: route,
    custody: { walletAddress: wallet, managedSizeMicros: "10000000", expectedPayoutMicros: "5000000",
      lots: [{ positionId: "lot-one", sizeMicros: "3333333" }, { positionId: "lot-two", sizeMicros: "6666667" }] } };
}

function receipt(route: PolymarketMarketRoute, payout = 4_000_001n, includePayout = true): TransactionReceiptResult {
  const burn = { address: route.outcomeToken,
    topics: encodeEventTopics({ abi: events, eventName: "TransferSingle", args: {
      operator: route.redemptionTarget, from: wallet, to: zeroAddress,
    } }) as [Hex, ...Hex[]],
    data: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [BigInt(route.assetId), 10_000_000n]),
  };
  const payment = { address: route.collateral,
    topics: encodeEventTopics({ abi: events, eventName: "Transfer", args: { from: route.redemptionTarget, to: wallet } }) as [Hex, ...Hex[]],
    data: encodeAbiParameters([{ type: "uint256" }], [payout]),
  };
  return { transactionHash, from: wallet, to: route.redemptionTarget,
    blockNumber: 123n, confirmations: 2, logs: includePayout ? [burn, payment] : [burn] };
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "pmf-redemption-integration-"));
  directories.push(directory);
  const databasePath = join(directory, "runtime.sqlite");
  const phase0 = new Phase0Database(databasePath, sourceVersion);
  phase0.initialize();
  const targetId = phase0.ensureTarget(wallet, "IDENTITY_CONFIRMED");
  phase0.close();
  const chain: PolygonChainReader = {
    balanceOf: vi.fn(async () => 10_000_000n), isApprovedForAll: vi.fn(async () => true),
    safeOwners: vi.fn(async () => ({ threshold: 1n, owners: [wallet] })), ctfIndexSet: vi.fn(async () => "2" as const),
    ctfPositions: vi.fn(async () => ["123", "456"] as [string, string]),
  };
  const requestTransaction = vi.fn(async (_binding: LiveWalletRuntimeBinding, _request: { to: string; data: string; purpose: string }) => transactionHash);
  const waitForSuccess = vi.fn(async () => receipt(v2Route));
  const journals: RedemptionJournal[] = [];
  const adapter = (walletBinding = binding(), receiptProvider: TransactionReceiptProvider = { waitForSuccess }) => {
    const journal = new RedemptionJournal(databasePath, () => new Date(now));
    journals.push(journal);
    return new BrowserWalletRedeemAdapter({ walletBinding, requestBroker: { requestTransaction },
      receiptProvider, signatureType: "EOA", tradingWalletAddress: wallet,
      journal, chainReader: chain, routeProvider: { resolve: vi.fn(async () => v2Route) } });
  };
  return { databasePath, targetId, chain, requestTransaction, waitForSuccess, adapter,
    close() { for (const journal of journals.splice(0)) journal.close(); } };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("durable managed redemption integration", () => {
  it("checks a pending receipt once per maintenance cycle without entering the blocking poller", async () => {
    const env = fixture();
    const waitForSuccess = vi.fn(async () => { throw new Error("BLOCKING_POLLER_MUST_NOT_RUN"); });
    const confirmedReceipt = vi.fn<() => Promise<TransactionReceiptResult | null>>(async () => null);
    const adapter = env.adapter(binding(), { waitForSuccess, confirmedReceipt });
    expect(await adapter.redeem(inputFor())).toMatchObject({ status: "SUBMITTED", raw: { reason: "LIVE_REDEEM_CONFIRMATION_PENDING" } });
    expect(confirmedReceipt).toHaveBeenCalledTimes(1);
    expect(waitForSuccess).not.toHaveBeenCalled();
    confirmedReceipt.mockResolvedValue(receipt(v2Route));
    expect(await adapter.redeem(inputFor(), { recoverOnly: true })).toMatchObject({ status: "CONFIRMED" });
    expect(env.requestTransaction).toHaveBeenCalledTimes(1);
    env.close();
  });

  it("honors an emergency guard before claiming the wallet send boundary", async () => {
    const env = fixture();
    await expect(env.adapter().redeem(inputFor(), { beforeSubmit() { throw new Error("EMERGENCY_DISABLED"); } }))
      .rejects.toThrow("EMERGENCY_DISABLED");
    expect(env.requestTransaction).not.toHaveBeenCalled();
    const db = new DatabaseSync(env.databasePath, { readOnly: true });
    expect(db.prepare("SELECT state,transaction_hash FROM live_redemption_journal").get())
      .toEqual({ state: "PREPARED", transaction_hash: null });
    db.close(); env.close();
  });
  it("redeems two managed V2 lots once, using exact size and actual received pUSD while preserving extra wallet shares", async () => {
    const env = fixture();
    vi.mocked(env.chain.balanceOf).mockResolvedValue(15_000_000n);
    const adapter = env.adapter();
    const result = await adapter.redeem(inputFor());
    expect(result).toMatchObject({ status: "CONFIRMED", evidence: {
      burnedSizeMicros: "10000000", actualPayoutMicros: "4000001", walletAddress: wallet,
    } });
    expect(await adapter.redeem(inputFor())).toMatchObject({ status: "CONFIRMED" });
    expect(env.requestTransaction).toHaveBeenCalledTimes(1);
    const sent = env.requestTransaction.mock.calls[0]![1] as { to: string; data: Hex };
    expect(sent.to).toBe(v2Route.redemptionTarget);
    expect(decodeFunctionData({ abi: parseAbi(["function redeem(bytes31 conditionId,uint256 outcomeIndex,uint256 amount)"]), data: sent.data }).args).toEqual([v2Condition, 1n, 10_000_000n]);
    env.close();
  });

  it("rejects a whole-balance CTF redemption when extra baseline shares would be touched", async () => {
    const env = fixture();
    const route = marketRoute({ assetId: "123", conditionId: `0x${"a".repeat(64)}`, neg_risk: false });
    vi.mocked(env.chain.balanceOf).mockResolvedValue(10_000_001n);
    await expect(env.adapter().redeem(inputFor(route))).rejects.toThrow("LIVE_REDEEM_CUSTODY_BALANCE_MISMATCH");
    expect(env.requestTransaction).not.toHaveBeenCalled();
    env.close();
  });

  it("keeps a burned position pending without crediting theoretical payout when receipt has no pUSD transfer", async () => {
    const env = fixture();
    env.waitForSuccess.mockResolvedValue(receipt(v2Route, 0n, false));
    expect(await env.adapter().redeem(inputFor())).toMatchObject({ status: "SUBMITTED", raw: { reason: "LIVE_REDEEM_PAYOUT_NOT_RECEIVED" } });
    const db = new DatabaseSync(env.databasePath, { readOnly: true });
    expect(db.prepare("SELECT state,transaction_hash,evidence_json FROM live_redemption_journal").get()).toMatchObject({ state: "SUBMITTED", transaction_hash: transactionHash, evidence_json: null });
    expect(db.prepare("SELECT count(*) count FROM live_cash_ledger").get()).toEqual({ count: 0 });
    db.close(); env.close();
  });

  it("persists a returned transaction hash before receipt failure and resumes with an expired wallet session", async () => {
    const env = fixture();
    env.waitForSuccess.mockRejectedValueOnce(new Error("receipt temporarily unavailable"));
    expect(await env.adapter().redeem(inputFor())).toMatchObject({ status: "SUBMITTED", raw: { transactionHash } });
    env.close();
    const expired = binding();
    vi.mocked(expired.assertCurrent).mockImplementation(() => { throw new Error("SESSION_EXPIRED"); });
    expect(await env.adapter(expired).redeem(inputFor(), { recoverOnly: true })).toMatchObject({ status: "CONFIRMED", evidence: { actualPayoutMicros: "4000001" } });
    expect(env.requestTransaction).toHaveBeenCalledTimes(1);
    expect(expired.assertCurrent).not.toHaveBeenCalled();
    env.close();
  });

  it("never re-sends after an unknown browser submission with no returned transaction hash", async () => {
    const env = fixture();
    env.requestTransaction.mockRejectedValueOnce(new Error("browser disconnected after sending"));
    expect(await env.adapter().redeem(inputFor())).toMatchObject({ status: "SUBMITTED" });
    env.close();
    const resumed = env.adapter();
    expect(await resumed.redeem(inputFor(), { recoverOnly: true })).toMatchObject({ status: "SUBMITTED", raw: { reason: "LIVE_REDEEM_SUBMISSION_UNKNOWN" } });
    expect(await resumed.redeem(inputFor())).toMatchObject({ status: "SUBMITTED" });
    expect(env.requestTransaction).toHaveBeenCalledTimes(1);
    expect(env.waitForSuccess).not.toHaveBeenCalled();
    env.close();
  });

  it("performs no wallet or receipt work during recovery without a durable submission", async () => {
    const env = fixture();
    expect(await env.adapter().redeem(inputFor(), { recoverOnly: true })).toMatchObject({ status: "SUBMITTED", raw: { reason: "LIVE_REDEEM_RECOVERY_NO_SUBMISSION" } });
    expect(env.requestTransaction).not.toHaveBeenCalled();
    expect(env.waitForSuccess).not.toHaveBeenCalled();
    expect(env.chain.balanceOf).not.toHaveBeenCalled();
    env.close();
  });
});


function insertAccount(databasePath: string): void {
  const db = new DatabaseSync(databasePath);
  db.prepare(
    `INSERT INTO live_wallets(
      live_wallet_id,wallet_address,wallet_type,network,status,created_at,updated_at
    ) VALUES ('wallet-live-executor', ?, 'EOA', 'POLYGON', 'ACTIVE', ?, ?)`,
  ).run(wallet, now, now);
  const registry = new LiveAccountRegistry(db, sourceVersion, () => new Date(now));
  registry.register({
    liveAccountId: accountId,
    liveWalletId: "wallet-live-executor",
    name: "Live Executor Test Account",
    initialBankrollMicros: 1_000_000_000n,
    riskBudgetMicros: 500_000_000n,
    signalCutoffAt: now,
    actor: "TEST",
    reason: "TEST_SETUP",
  });
  registry.activate({ liveAccountId: accountId, actor: "TEST", reason: "TEST_SETUP" });
  db.close();
}

function insertSignalAndRisk(databasePath: string, targetId: string, input: {
  signalId: string;
  riskDecisionId: string;
  decision: "ALLOW" | "REJECT";
  signalType?: "TARGET_BUY" | "TARGET_SELL";
  eventClassification?: "STANDARD_TRADE" | "COMBO_ACTIVITY";
  sellRatioNumerator?: string | null;
  sellRatioDenominator?: string | null;
  requestedAmountMicros?: string | null;
  requestedSizeMicros?: string | null;
  marketEndTime?: string;
  capitalRatioPpm?: string;
  targetPriceUnits?: string;
  createdAt?: string;
  ruleset?: TestRuleset;
  marketRoute?: PolymarketMarketRoute;
}): { signal: PaperSignalEnvelope; context: SignalExecutionContext } {
  const assetId = input.marketRoute?.assetId ?? v2Asset;
  const conditionId = input.marketRoute?.conditionId ?? v2Condition;
  const db = new DatabaseSync(databasePath);
  db.exec("PRAGMA foreign_keys=ON");
  const sourceKey = `source-${input.signalId}`;
  const createdAt = input.createdAt ?? now;
  const rulesetHash = input.ruleset?.hash ?? RULESET_HASH;
  const rulesetSnapshotJson = input.ruleset?.snapshotJson ?? RULESET_SNAPSHOT_JSON;
  const configVersion = input.ruleset?.configVersion ?? VERSIONS.configVersion;
  const targetPriceUnits = input.targetPriceUnits ?? "500000000000000000";
  const eventClassification = input.eventClassification ?? "STANDARD_TRADE";
  const isCombo = eventClassification === "COMBO_ACTIVITY" ? 1 : 0;
  db.prepare(
    `INSERT INTO raw_events(
      source_event_key,target_id,identity_version,source_type,source_transaction_hash,
      source_timestamp,asset_id,condition_id,side,price_units,size_micros,gap_event,
      is_combo,raw_json,created_at,event_classification
    ) VALUES (?, ?, 'test', 'DATA_API_TRADE', ?, 1773014400, ?, ?, 'BUY',
      '500000000000000000', '10000000', 0, ?, '{}', ?, ?)`,
  ).run(sourceKey, targetId, `tx-${input.signalId}`, assetId, conditionId, isCombo, createdAt, eventClassification);
  const effectiveCapitalRatio = input.capitalRatioPpm
    ?? ((input.signalType ?? "TARGET_BUY") === "TARGET_BUY" ? "100000" : null);
  const capitalId = effectiveCapitalRatio ? `capital-${input.signalId}` : null;
  if (capitalId !== null) {
    db.prepare(
      `INSERT INTO capital_estimates(
        capital_estimate_id,target_id,source_event_key,position_value_micros,wallet_balance_micros,
        target_visible_capital_micros,target_trade_amount_micros,target_trade_capital_ratio_ppm,
        capital_estimate_status,capital_confidence,capital_estimate_reason,position_snapshot_time,
        wallet_balance_snapshot_time,target_trade_timestamp,fallback_amount_micros,schema_version,
        strategy_version,risk_version,ruleset_snapshot_json,ruleset_hash,source_code_commit,
        source_code_dirty,created_at
      ) VALUES (?, ?, ?, '500000000', '500000000', '1000000000', '100000000', ?,
        'COMPLETE', 'HIGH', 'TEST_COMPLETE', ?, ?, ?, '10000000', ?, ?, ?, ?, ?, ?, 0, ?)`,
    ).run(
      capitalId,
      targetId,
      sourceKey,
      effectiveCapitalRatio!,
      createdAt,
      createdAt,
      createdAt,
      VERSIONS.schemaVersion,
      VERSIONS.strategyVersion,
      VERSIONS.riskVersion,
      rulesetSnapshotJson,
      rulesetHash,
      sourceVersion.commit,
      createdAt,
    );
  }
  db.prepare(
    `INSERT INTO signals(
      signal_id,target_id,signal_idempotency_key,source_event_key,signal_type,status,asset_id,
      condition_id,target_price_units,target_size_micros,sell_ratio_numerator,
      sell_ratio_denominator,reason,schema_version,signal_version,strategy_version,
      risk_version,replay_version,ruleset_snapshot_json,ruleset_hash,source_code_commit,
      created_at,execution_eligible,execution_block_reason,event_classification,
      capital_estimate_id,source_code_dirty,producer_mode
    ) VALUES (?, ?, ?, ?, ?, 'PUBLISHED', ?, ?, ?,
      '10000000', ?, ?, 'TEST', ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL,
      ?, ?, 0, 'OBSERVE_ONLY')`,
  ).run(
    input.signalId,
    targetId,
    `idem-${input.signalId}`,
    sourceKey,
    input.signalType ?? "TARGET_BUY",
    assetId,
    conditionId,
    targetPriceUnits,
    input.sellRatioNumerator ?? null,
    input.sellRatioDenominator ?? null,
    VERSIONS.schemaVersion,
    VERSIONS.signalVersion,
    VERSIONS.strategyVersion,
    VERSIONS.riskVersion,
    VERSIONS.replayVersion,
    rulesetSnapshotJson,
    rulesetHash,
    sourceVersion.commit,
    createdAt,
    eventClassification,
    capitalId,
  );
  const contextId = `context-${input.signalId}`;
  const metadataHash = createHash("sha256").update(stableJson({})).digest("hex");
  db.prepare(
    `INSERT INTO signal_execution_contexts(
      context_id,target_id,signal_id,capital_decision_id,target_trade_capital_ratio_ppm,
      target_trade_timestamp,market_end_time,market_metadata_snapshot_json,
      market_metadata_hash,ruleset_hash,schema_version,signal_version,strategy_version,
      source_code_commit,source_code_dirty,config_version,created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
  ).run(
    contextId,
    targetId,
    input.signalId,
    capitalId,
    effectiveCapitalRatio,
    createdAt,
    input.marketEndTime ?? "2026-07-10T00:00:00.000Z",
    metadataHash,
    rulesetHash,
    VERSIONS.schemaVersion,
    VERSIONS.signalVersion,
    VERSIONS.strategyVersion,
    sourceVersion.commit,
    configVersion,
    createdAt,
  );
  db.prepare(
    `INSERT INTO risk_decisions(
      risk_decision_id,executor_mode,paper_account_id,account_id,signal_id,context_id,decision,
      risk_reject_reason,requested_amount_micros,requested_size_micros,checks_json,
      schema_version,strategy_version,risk_version,ruleset_hash,source_code_commit,
      source_code_dirty,config_version,created_at,risk_reason
    ) VALUES (?, 'LIVE', NULL, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
  ).run(
    input.riskDecisionId,
    accountId,
    input.signalId,
    contextId,
    input.decision,
    input.decision === "REJECT" ? "TEST_REJECT" : null,
    input.requestedAmountMicros === undefined
      ? (input.signalType === "TARGET_SELL" ? null : "5000000")
      : input.requestedAmountMicros,
    input.requestedSizeMicros === undefined
      ? (input.signalType === "TARGET_SELL" ? "10000000" : null)
      : input.requestedSizeMicros,
    VERSIONS.schemaVersion,
    VERSIONS.strategyVersion,
    VERSIONS.riskVersion,
    rulesetHash,
    sourceVersion.commit,
    configVersion,
    createdAt,
    input.decision,
  );
  db.close();
  const context: SignalExecutionContext = {
    contextId,
    targetId,
    signalId: input.signalId,
    capitalDecisionId: capitalId,
    targetTradeCapitalRatioPpm: effectiveCapitalRatio,
    targetTradeTimestamp: createdAt,
    marketEndTime: input.marketEndTime ?? "2026-07-10T00:00:00.000Z",
    marketMetadataSnapshot: {},
    marketMetadataHash: metadataHash,
    rulesetHash,
    sourceCodeCommit: sourceVersion.commit,
    sourceCodeDirty: false,
    configVersion,
    createdAt,
  };
  const signal: PaperSignalEnvelope = {
    signalId: input.signalId,
    targetId,
    signalType: input.signalType ?? "TARGET_BUY",
    eventClassification,
    status: "PUBLISHED",
    executionEligible: true,
    executionBlockReason: null,
    assetId,
    conditionId,
    targetPriceUnits,
    targetSizeMicros: "10000000",
    sellRatioNumerator: input.sellRatioNumerator ?? null,
    sellRatioDenominator: input.sellRatioDenominator ?? null,
    createdAt,
    context,
    capitalDecision: effectiveCapitalRatio === null ? null : {
      status: "COMPLETE",
      confidence: "HIGH",
      ratioPpm: effectiveCapitalRatio,
      fallbackAmountMicros: "10000000",
    },
  };
  return { signal, context };
}



function seedResolvedLots(databasePath: string, targetId: string,
  routes: PolymarketMarketRoute[] = [v2Route, v2Route], payouts: Array<[string, string]> = [["1", "2"], ["1", "2"]],
): string[] {
  insertAccount(databasePath);
  const db = new DatabaseSync(databasePath);
  db.exec("PRAGMA foreign_keys=ON");
  const store = new LiveStore(db, sourceVersion, () => new Date(now));
  const positions: string[] = [];
  for (const [index, size] of [3_333_333n, 6_666_667n].entries()) {
    const route = routes[index]!;
    const { assetId, conditionId } = route;
    const signalId = `group-opening-${index}`;
    const riskId = `group-risk-${index}`;
    const amount = (size * 3n) / 10n;
    insertSignalAndRisk(databasePath, targetId, { signalId, riskDecisionId: riskId, decision: "ALLOW",
      requestedAmountMicros: amount.toString(), createdAt: "2026-07-10T00:00:00.000Z", marketEndTime: "2026-07-10T01:00:00.000Z", marketRoute: route });
    const execution = store.createExecution({ liveAccountId: accountId, signalId, contextId: `context-${signalId}`,
      riskDecisionId: riskId, liveGateRunId: null, executionIdempotencyKey: `opening:${index}`,
      executionType: "TARGET_BUY", state: "WAITING_EXECUTION", assetId, conditionId,
      requestedAmountMicros: amount.toString(), requestedSizeMicros: null, targetPriceUnits: "300000000000000000",
      reason: "INDEPENDENT_FILLED_FIXTURE", rulesetHash: RULESET_HASH });
    const order: LiveOrderRequest = { liveOrderId: `group-order-${index}`, idempotencyKey: `group-order:${index}`,
      marketId: conditionId, conditionId, assetId, side: "BUY", orderType: "FAK", priceUnits: "300000000000000000",
      quoteVwapPriceUnits: "300000000000000000", sizeMicros: size.toString(), amountMicros: amount.toString(),
      budgetMicros: amount.toString(), registeredWalletAddress: wallet, authorizedSignerAddress: wallet,
      feeRateBps: "0", feeExponent: 1, feeModelVersion: VERSIONS.feeModelVersion,
      signedPayload: { signerAddress: wallet, signature: "isolated-historical-fill", payloadHash: "isolated", marketRoute: route } };
    const fill: LiveFillEvent = { externalFillId: `group-fill-${index}`, priceUnits: order.priceUnits,
      sizeMicros: size.toString(), notionalMicros: amount.toString(), feeMicros: "0", timestamp: now, raw: { isolated: true } };
    store.transaction(() => {
      store.reserve(execution, amount);
      store.createOrder(order, execution.live_execution_id, "FAKE", true);
      store.recordFill({ execution, liveOrderId: order.liveOrderId, side: "BUY", fill });
      positions.push(store.applyBuyFill(execution, fill));
      store.updateOrderFromSubmit(order.liveOrderId, { adapterType: "FAKE", externalOrderId: `external-${index}`,
        status: "FILLED", fills: [fill], terminal: true, confirmationPending: false, raw: { isolated: true } });
      store.updateExecutionTotals(execution.live_execution_id);
      store.updateExecutionState(execution.live_execution_id, "EXECUTED", "FAK_FILLED", RULESET_HASH);
    });
    store.confirmSettlement({ positionId: positions[index]!, resolved: true, payoutNumerator: payouts[index]![0], payoutDenominator: payouts[index]![1],
      confirmedAt: now, resolutionSnapshot: { resolved: true, isolated: true } });
  }
  db.close();
  return positions;
}

/** Isolated production attestation contract; every allowed action has a real matching SQLite run. */
class AttestedProductionGate implements LiveExecutionGate {
  readonly gateType = "PRODUCTION" as const;
  readonly runtimeEnvironment = "PRODUCTION" as const;
  private sequence = 0;
  constructor(private readonly path: string) {}
  async checkExecution() { return { allowed: false, checks: [], blockedReasons: ["NO_ORDERS_IN_REDEMPTION_FIXTURE"], runId: "never-order" }; }
  async checkAccountAction(input: LiveAccountActionGateInput) {
    const runId = `isolated-redeem-gate-${++this.sequence}`;
    const db = new DatabaseSync(this.path);
    db.prepare(`INSERT INTO live_gate_runs(live_gate_run_id,run_type,allowed,blocked_reasons_json,checks_json,
      requested_execution_mode,execution_mode,live_gate_state,risk_decision_id,signal_id,ruleset_hash,
      source_code_commit,source_code_dirty,config_version,created_at)
      VALUES (?,'EXECUTION_CHECK',1,'[]','[]','LIVE','LIVE','LIVE_ACTIVE',?,NULL,?,?,0,?,?)`)
      .run(runId, input.riskDecisionId, input.rulesetHash, sourceVersion.commit, VERSIONS.configVersion, now);
    db.close();
    return { allowed: true, checks: [], blockedReasons: [], runId };
  }
}

function gateActive(path: string, active: boolean): void {
  const db = new DatabaseSync(path);
  db.prepare("UPDATE live_gate_state SET execution_mode=?,live_gate_state=?,requested_execution_mode=?,state_reason='ISOLATED_TEST' WHERE state_id='default'")
    .run(active ? "LIVE" : "PAPER", active ? "LIVE_ACTIVE" : "LIVE_DISABLED", active ? "LIVE" : null);
  db.close();
}

function productionExecutor(path: string, adapter: BrowserWalletRedeemAdapter): LiveExecutor {
  return new LiveExecutor({ databasePath: path, environment: "PRODUCTION", sourceVersion,
    now: () => new Date(now), redeemAdapter: adapter, liveGate: new AttestedProductionGate(path) });
}

describe("production managed redemption ledger", () => {
  it.each([{ negRisk: false, approvalPending: false }, { negRisk: true, approvalPending: false },
    { negRisk: false, approvalPending: true }])(
    "redeems both managed CTF outcomes with payout entitlement allocation; negRisk=$negRisk approvalPending=$approvalPending", async ({ negRisk, approvalPending }) => {
    const env = fixture();
    const routes = ["123", "456"].map(assetId => marketRoute({ assetId,
      conditionId: `0x${"a".repeat(64)}`, neg_risk: negRisk }));
    const positions = seedResolvedLots(env.databasePath, env.targetId, routes, [["1", "1"], ["0", "1"]]);
    vi.mocked(env.chain.balanceOf).mockImplementation(async (_token, _wallet, asset) => asset === "123" ? 3_333_333n : 6_666_667n);
    const chainReceipt = receipt(routes[0]!, 3_333_333n);
    const burns = [3_333_333n, 6_666_667n].map((size, index) => ({
      ...chainReceipt.logs![0]!, data: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [BigInt(routes[index]!.assetId), size]),
    }));
    const redeemHash = approvalPending ? `0x${"2".repeat(64)}` : transactionHash;
    env.waitForSuccess.mockResolvedValue({ ...chainReceipt, transactionHash: redeemHash, logs: [...burns, chainReceipt.logs![1]!] });
    if (approvalPending) {
      vi.mocked(env.chain.isApprovedForAll).mockResolvedValueOnce(false).mockResolvedValue(true);
      env.requestTransaction.mockResolvedValueOnce(transactionHash).mockResolvedValueOnce(redeemHash);
      env.waitForSuccess.mockRejectedValueOnce(new Error("APPROVAL_NOT_MINED_YET"))
        .mockResolvedValueOnce({ transactionHash, from: wallet, to: routes[0]!.outcomeToken, blockNumber: 120n, confirmations: 2, logs: [] });
    }
    gateActive(env.databasePath, true);
    const executor = productionExecutor(env.databasePath, env.adapter());
    try {
      if (approvalPending) {
        expect((await executor.processRedemptions(accountId)).pendingPositionIds.sort()).toEqual([...positions].sort());
      }
      const result = await executor.processRedemptions(accountId);
      expect({ ...result, confirmedPositionIds: result.confirmedPositionIds.sort() }).toEqual({ confirmedPositionIds: [...positions].sort(), pendingPositionIds: [], failures: [] });
      expect(env.requestTransaction).toHaveBeenCalledTimes(approvalPending ? 2 : 1);
      const db = new DatabaseSync(env.databasePath, { readOnly: true });
      const rows = db.prepare(`SELECT p.asset_id,c.cash_delta_micros FROM live_cash_ledger c
        JOIN live_settlement_ledger s ON s.live_execution_id=c.live_execution_id
        JOIN live_positions p ON p.live_position_id=s.live_position_id WHERE c.entry_type='REDEEM' ORDER BY p.asset_id`)
        .all();
      expect(rows).toEqual([{ asset_id: "123", cash_delta_micros: "3333333" }, { asset_id: "456", cash_delta_micros: "0" }]);
      expect(db.prepare("SELECT count(*) n FROM live_positions WHERE status='REDEEMED'").get()).toEqual({ n: 2 });
      db.close();
      expect((await executor.processRedemptions(accountId)).confirmedPositionIds).toEqual([]);
      expect(env.requestTransaction).toHaveBeenCalledTimes(approvalPending ? 2 : 1);
    } finally { executor.close(); env.close(); }
  });

  it("leaves no half-group intents on custody failure and succeeds when the read recovers", async () => {
    const env = fixture();
    const positions = seedResolvedLots(env.databasePath, env.targetId);
    gateActive(env.databasePath, true);
    vi.mocked(env.chain.balanceOf).mockRejectedValueOnce(new Error("CUSTODY_READ_FAILED"));
    const executor = productionExecutor(env.databasePath, env.adapter());
    expect((await executor.processRedemptions(accountId)).failures).toHaveLength(1);
    const db = new DatabaseSync(env.databasePath, { readOnly: true });
    expect(db.prepare("SELECT count(*) n FROM live_redeems").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT count(*) n FROM live_executions WHERE execution_type='REDEEM'").get()).toEqual({ n: 0 });
    expect(env.requestTransaction).not.toHaveBeenCalled();
    expect((await executor.processRedemptions(accountId)).confirmedPositionIds.sort()).toEqual(positions.sort());
    expect(env.requestTransaction).toHaveBeenCalledTimes(1);
    db.close(); executor.close(); env.close();
  });

  it("recovers an approval hash, then submits the prepared redemption once", async () => {
    const env = fixture();
    const positions = seedResolvedLots(env.databasePath, env.targetId);
    gateActive(env.databasePath, true);
    const redeemHash = `0x${"2".repeat(64)}`;
    vi.mocked(env.chain.isApprovedForAll).mockResolvedValueOnce(false).mockResolvedValue(true);
    env.requestTransaction.mockResolvedValueOnce(transactionHash).mockResolvedValueOnce(redeemHash);
    env.waitForSuccess.mockRejectedValueOnce(new Error("APPROVAL_NOT_MINED_YET"))
      .mockResolvedValueOnce({ transactionHash, from: wallet, to: v2Route.outcomeToken, blockNumber: 120n, confirmations: 2, logs: [] })
      .mockResolvedValue({ ...receipt(v2Route), transactionHash: redeemHash });
    const executor = productionExecutor(env.databasePath, env.adapter());
    expect((await executor.processRedemptions(accountId)).pendingPositionIds.sort()).toEqual(positions.sort());
    expect(executor.hasUnresolvedRedemption(accountId)).toBe(true);
    expect((await executor.processRedemptions(accountId)).confirmedPositionIds.sort()).toEqual(positions.sort());
    expect(executor.hasUnresolvedRedemption(accountId)).toBe(false);
    expect(env.requestTransaction).toHaveBeenCalledTimes(2);
    const db = new DatabaseSync(env.databasePath, { readOnly: true });
    expect(db.prepare("SELECT count(*) n FROM live_redemption_journal WHERE state='CONFIRMED'").get()).toEqual({ n: 2 });
    db.close(); executor.close(); env.close();
  });
  it("submits one asset redemption for two resolved lots and conserves actual cash/PnL atomically", async () => {
    const env = fixture();
    const positions = seedResolvedLots(env.databasePath, env.targetId);
    gateActive(env.databasePath, true);
    const executor = productionExecutor(env.databasePath, env.adapter());
    expect(await executor.processRedemptions(accountId)).toEqual({ confirmedPositionIds: [...positions].sort(), pendingPositionIds: [], failures: [] });
    expect(env.requestTransaction).toHaveBeenCalledTimes(1);
    const db = new DatabaseSync(env.databasePath, { readOnly: true });
    const cash = db.prepare("SELECT cash_delta_micros FROM live_cash_ledger WHERE entry_type='REDEEM'").all() as Array<{ cash_delta_micros: string }>;
    expect(cash.reduce((sum, row) => sum + BigInt(row.cash_delta_micros), 0n)).toBe(4_000_001n);
    const pnl = db.prepare("SELECT proceeds_micros,cost_basis_micros,pnl_micros FROM live_pnl_ledger WHERE pnl_type='SETTLEMENT'").all() as Array<{ proceeds_micros: string; cost_basis_micros: string; pnl_micros: string }>;
    expect(pnl).toHaveLength(2);
    expect(pnl.reduce((sum, row) => sum + BigInt(row.proceeds_micros), 0n)).toBe(4_000_001n);
    expect(pnl.reduce((sum, row) => sum + BigInt(row.pnl_micros), 0n)).toBe(1_000_002n);
    expect((db.prepare("SELECT status,current_size_micros,remaining_cost_micros FROM live_positions").all() as Array<Record<string, string>>)).toEqual([
      { status: "REDEEMED", current_size_micros: "0", remaining_cost_micros: "0" },
      { status: "REDEEMED", current_size_micros: "0", remaining_cost_micros: "0" },
    ]);
    expect(await executor.processRedemptions(accountId)).toEqual({ confirmedPositionIds: [], pendingPositionIds: [], failures: [] });
    expect(env.requestTransaction).toHaveBeenCalledTimes(1);
    expect(db.prepare("SELECT count(*) count FROM live_cash_ledger WHERE entry_type='REDEEM'").get()).toEqual({ count: 2 });
    db.close(); executor.close(); env.close();
  });

  it("does not post a resolved estimate when the receipt cannot prove actual payout", async () => {
    const env = fixture();
    const positions = seedResolvedLots(env.databasePath, env.targetId);
    gateActive(env.databasePath, true);
    env.waitForSuccess.mockResolvedValue(receipt(v2Route, 0n, false));
    const executor = productionExecutor(env.databasePath, env.adapter());
    const result = await executor.processRedemptions(accountId);
    expect(result).toEqual({ confirmedPositionIds: [], pendingPositionIds: [...positions].sort(), failures: [] });
    const db = new DatabaseSync(env.databasePath, { readOnly: true });
    expect(db.prepare("SELECT count(*) count FROM live_cash_ledger WHERE entry_type='REDEEM'").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT count(*) count FROM live_pnl_ledger").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT count(*) count FROM live_positions WHERE current_size_micros!='0' AND remaining_cost_micros!='0'").get()).toEqual({ count: 2 });
    db.close(); executor.close(); env.close();
  });

  it.each([false, true])("recovers a submitted hash with Gate closed and emergency frozen=%s without sending again", async (frozen) => {
    const env = fixture();
    const positions = seedResolvedLots(env.databasePath, env.targetId);
    gateActive(env.databasePath, true);
    env.waitForSuccess.mockRejectedValueOnce(new Error("receipt temporarily unavailable"));
    const first = productionExecutor(env.databasePath, env.adapter());
    expect((await first.processRedemptions(accountId)).pendingPositionIds.sort()).toEqual([...positions].sort());
    if (frozen) await first.emergencyStop(accountId, "CONFIRM_PENDING_REDEEM_AFTER_STOP");
    first.close(); env.close();
    gateActive(env.databasePath, false);
    const expired = binding();
    vi.mocked(expired.assertCurrent).mockImplementation(() => { throw new Error("SESSION_EXPIRED"); });
    const recoveredBeforeReconciliation = vi.spyOn(LiveCrashRecovery.prototype, "recover").mockImplementation(async () => {
      const db = new DatabaseSync(env.databasePath, { readOnly: true });
      expect(db.prepare("SELECT count(*) count FROM live_positions WHERE status='REDEEMED'").get()).toEqual({ count: 2 });
      db.close();
      return { passed: true, reason: "RECONCILED_AFTER_REDEMPTION", recoveryRunId: "isolated-recovery" };
    });
    const restarted = productionExecutor(env.databasePath, env.adapter(expired));
    expect(await restarted.recoverOnStartup(accountId)).toMatchObject({ passed: true, reason: "RECONCILED_AFTER_REDEMPTION" });
    expect(recoveredBeforeReconciliation).toHaveBeenCalledTimes(1);
    expect(env.requestTransaction).toHaveBeenCalledTimes(1);
    expect(expired.assertCurrent).not.toHaveBeenCalled();
    expect(restarted.isGateActive()).toBe(false);
    const db = new DatabaseSync(env.databasePath, { readOnly: true });
    expect(db.prepare("SELECT count(*) count FROM live_orders").get()).toEqual({ count: 2 });
    expect(db.prepare("SELECT count(*) count FROM live_cash_ledger WHERE entry_type='REDEEM'").get()).toEqual({ count: 2 });
    db.close(); restarted.close(); env.close();
  });
});
