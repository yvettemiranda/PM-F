import { mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RULESET, RULESET_HASH, RULESET_SNAPSHOT_JSON, stableJson, VERSIONS } from "../src/domain/versioning.js";
import { Phase0Database } from "../src/infra/sqlite/database.js";
import type { SourceVersion } from "../src/infra/source-version.js";
import { LiveAccountRegistry } from "../src/live/live-account-registry.js";
import { LiveExecutor } from "../src/live/live-executor.js";
import { LiveIdentityBinding } from "../src/live/live-identity-binding.js";
import { LiveRuntime } from "../src/live/live-runtime.js";
import { assembleLiveRuntime } from "../src/live/live-runtime-assembly.js";
import { LiveStore } from "../src/live/live-store.js";
import { FakeOrderAdapter } from "../src/live/fake-order-adapter.js";
import { FakeSigner } from "../src/live/fake-signer.js";
import { FakeWalletProvider } from "../src/live/fake-wallet-provider.js";
import { FakeLiveMarketDataProvider } from "../src/live/fake-live-market-data.js";
import { FakeRedeemAdapter } from "../src/live/fake-redeem-adapter.js";
import { LiveGateService, defaultLiveGateConfig } from "../src/live/live-gate-service.js";
import {
  FakeClockSafetyProvider,
  FakeComplianceProvider,
  FakeGeoblockProvider,
} from "../src/live/live-safety-provider.js";
import { MockBalanceProvider } from "../src/live/mock-balance-provider.js";
import { OrderSubmissionOutcomeUnknownError, type OrderAdapter } from "../src/live/order-adapter.js";
import type { RedeemAdapter, RedeemResult } from "../src/live/redeem-adapter.js";
import type { Signer } from "../src/live/signer.js";
import type { LiveExecutionGate } from "../src/live/live-types.js";
import type {
  CancelResult,
  LiveFillEvent,
  LiveOrderRequest,
  OrderStatus,
  OrderSubmitResult,
  SignedPayload,
} from "../src/live/live-types.js";
import type { PaperSignalEnvelope, SignalExecutionContext } from "../src/paper/types.js";
import { RiskManager } from "../src/risk/risk-manager.js";
import {
  LiveSignalConsumer,
  type LiveSignalConsumptionScope,
} from "../src/live/live-signal-consumer.js";
import { LiveRunner } from "../src/live/live-runner.js";

const directories: string[] = [];
const sourceVersion: SourceVersion = { commit: "phase3-live-test", dirty: false };
const wallet = "0x0000000000000000000000000000000000000001";
const conditionId = `0x${"3".repeat(64)}`;
const assetId = "asset-live-executor";
const accountId = "live-account-test";
const now = "2026-07-09T00:00:00.000Z";

interface TestRuleset {
  hash: string;
  snapshotJson: string;
  configVersion: string;
}

class FakeGate implements LiveExecutionGate {
  readonly gateType = "FAKE" as const;
  readonly runtimeEnvironment = "TEST" as const;
  readonly emergencyDisableReasons: string[] = [];

  constructor(private readonly allowed = true, private readonly reason = "FAKE_GATE_BLOCKED") {}

  async checkExecution(): Promise<{ allowed: boolean; checks: []; blockedReasons: string[]; runId: string }> {
    return { allowed: this.allowed, checks: [], blockedReasons: this.allowed ? [] : [this.reason], runId: "fake-live-gate-run" };
  }

  async checkAccountAction(): Promise<{ allowed: boolean; checks: []; blockedReasons: string[]; runId: string }> {
    return { allowed: this.allowed, checks: [], blockedReasons: this.allowed ? [] : [this.reason], runId: "fake-live-action-gate-run" };
  }

  async recoverOnStartup(): Promise<{ allowed: boolean; checks: []; blockedReasons: string[]; runId: string }> {
    return { allowed: this.allowed, checks: [], blockedReasons: this.allowed ? [] : [this.reason], runId: "fake-live-startup-run" };
  }

  async requestLiveActivation(): Promise<{ allowed: boolean; checks: []; blockedReasons: string[]; runId: string }> {
    return { allowed: this.allowed, checks: [], blockedReasons: this.allowed ? [] : [this.reason], runId: "fake-live-arm-run" };
  }

  async confirmLiveActivation(): Promise<{ allowed: boolean; checks: []; blockedReasons: string[]; runId: string }> {
    return { allowed: this.allowed, checks: [], blockedReasons: this.allowed ? [] : [this.reason], runId: "fake-live-confirm-run" };
  }

  async emergencyDisable(input: { reason: string }): Promise<void> {
    this.emergencyDisableReasons.push(input.reason);
  }
}

class ThrowingOrderAdapter extends FakeOrderAdapter {
  override async submitOrder(_order: LiveOrderRequest): Promise<OrderSubmitResult> {
    throw new Error("TEST_SUBMIT_FAILED");
  }
}

class CountingOrderAdapter extends FakeOrderAdapter {
  submitCount = 0;

  override async submitOrder(order: LiveOrderRequest): Promise<OrderSubmitResult> {
    this.submitCount += 1;
    return super.submitOrder(order);
  }
}

class FlippingGate implements LiveExecutionGate {
  readonly gateType = "FAKE" as const;
  readonly runtimeEnvironment = "TEST" as const;
  private calls = 0;

  async checkExecution(): Promise<{ allowed: boolean; checks: []; blockedReasons: string[]; runId: string }> {
    this.calls += 1;
    const allowed = this.calls === 1;
    return {
      allowed,
      checks: [],
      blockedReasons: allowed ? [] : ["TEST_GATE_BECAME_UNSAFE"],
      runId: `fake-gate-${this.calls}`,
    };
  }

  async checkAccountAction(): Promise<{ allowed: boolean; checks: []; blockedReasons: string[]; runId: string }> {
    return { allowed: true, checks: [], blockedReasons: [], runId: "fake-action-gate" };
  }
}

class FailingLiveSignalConsumer extends LiveSignalConsumer {
  override async consumeAvailableSignals(): Promise<never> {
    throw new Error("TEST_SIGNAL_CONSUMER_FAILURE");
  }
}

class FinalStageFailingLiveSignalConsumer extends LiveSignalConsumer {
  override async consumeAvailableSignals(
    accountId: string,
    limit = 1_000,
    scope: LiveSignalConsumptionScope = "ALL",
  ) {
    if (scope === "ALL") throw new Error("TEST_ORDERED_SIGNAL_CONSUMER_FAILURE");
    return super.consumeAvailableSignals(accountId, limit, scope);
  }
}

class ProductionRuntimeFakeGate implements LiveExecutionGate {
  readonly gateType = "FAKE" as const;
  readonly runtimeEnvironment = "PRODUCTION" as const;

  async checkExecution(): Promise<{ allowed: true; checks: []; blockedReasons: []; runId: string }> {
    return { allowed: true, checks: [], blockedReasons: [], runId: "fake-production-runtime-gate" };
  }

  async checkAccountAction(): Promise<{ allowed: true; checks: []; blockedReasons: []; runId: string }> {
    return { allowed: true, checks: [], blockedReasons: [], runId: "fake-production-runtime-action-gate" };
  }
}

class UnpersistedProductionGate implements LiveExecutionGate {
  readonly gateType = "PRODUCTION" as const;
  readonly runtimeEnvironment = "PRODUCTION" as const;

  constructor(private readonly runId = "not-persisted-production-run") {}

  async checkExecution(): Promise<{ allowed: true; checks: []; blockedReasons: []; runId: string }> {
    return { allowed: true, checks: [], blockedReasons: [], runId: this.runId };
  }

  async checkAccountAction(): Promise<{ allowed: true; checks: []; blockedReasons: []; runId: string }> {
    return { allowed: true, checks: [], blockedReasons: [], runId: "not-persisted-production-action-run" };
  }
}

class FeeAwareFakeSigner implements Signer {
  readonly signerType = "FAKE" as const;

  async address(): Promise<string> {
    return wallet;
  }

  async signOrder(payload: Record<string, unknown>): Promise<SignedPayload> {
    const budget = BigInt(String(payload.budgetMicros));
    const amount = budget - 200_000n;
    const price = BigInt(String(payload.priceUnits));
    return {
      signerAddress: wallet,
      signature: "fake-fee-aware-signature",
      payloadHash: "fake-fee-aware-payload",
      orderAmountMicros: amount.toString(),
      orderSizeMicros: ((amount * 1_000_000_000_000_000_000n) / price).toString(),
      maxTotalCostMicros: budget.toString(),
      feeModelVersion: "fake-fee-model-v1",
    };
  }
}

class MutatingFakeSigner implements Signer {
  readonly signerType = "FAKE" as const;

  constructor(
    private readonly mutate: (payload: Record<string, unknown>) => {
      orderAmountMicros: string;
      orderSizeMicros: string;
    },
    private readonly signerAddress = wallet,
  ) {}

  async address(): Promise<string> {
    return this.signerAddress;
  }

  async signOrder(payload: Record<string, unknown>): Promise<SignedPayload> {
    return {
      signerAddress: this.signerAddress,
      signature: "mutating-fake-signature",
      payloadHash: "mutating-fake-payload",
      ...this.mutate(payload),
    };
  }
}

class RecordingFakeSigner extends FakeSigner {
  readonly payloads: Array<Record<string, unknown>> = [];

  override async signOrder(payload: Record<string, unknown>): Promise<SignedPayload> {
    this.payloads.push({ ...payload });
    return super.signOrder(payload);
  }
}

class BlockingFakeSigner implements Signer {
  readonly signerType = "FAKE" as const;
  readonly started: Promise<void>;
  private markStarted!: () => void;
  private releaseSigning!: () => void;
  private readonly released: Promise<void>;

  constructor() {
    this.started = new Promise((resolve) => { this.markStarted = resolve; });
    this.released = new Promise((resolve) => { this.releaseSigning = resolve; });
  }

  release(): void {
    this.releaseSigning();
  }

  async address(): Promise<string> {
    return wallet;
  }

  async signOrder(payload: Record<string, unknown>): Promise<SignedPayload> {
    this.markStarted();
    await this.released;
    return {
      signerAddress: wallet,
      signature: "blocking-fake-signature",
      payloadHash: "blocking-fake-payload",
      orderAmountMicros: String(payload.amountMicros),
      orderSizeMicros: String(payload.sizeMicros),
    };
  }
}

class UnderstatingFeeSigner implements Signer {
  readonly signerType = "FAKE" as const;

  async address(): Promise<string> {
    return wallet;
  }

  async signOrder(payload: Record<string, unknown>): Promise<SignedPayload> {
    return {
      signerAddress: wallet,
      signature: "understated-fee-signature",
      payloadHash: "understated-fee-payload",
      orderAmountMicros: String(payload.amountMicros),
      orderSizeMicros: String(payload.sizeMicros),
      maxTotalCostMicros: String(payload.amountMicros),
      feeModelVersion: VERSIONS.feeModelVersion,
    };
  }
}

class NonZeroFeeMarketDataProvider extends FakeLiveMarketDataProvider {
  override async fee(asset: string, condition: string) {
    return {
      ...await super.fee(asset, condition),
      baseFee: 700,
      feeRatePpm: "70000",
      exponent: 2,
    };
  }
}

class BlockingSubmitAdapter extends FakeOrderAdapter {
  readonly started: Promise<void>;
  private markStarted!: () => void;
  private releaseSubmit!: () => void;
  private readonly released: Promise<void>;

  constructor() {
    super();
    this.started = new Promise((resolve) => { this.markStarted = resolve; });
    this.released = new Promise((resolve) => { this.releaseSubmit = resolve; });
  }

  release(): void {
    this.releaseSubmit();
  }

  override async submitOrder(order: LiveOrderRequest): Promise<OrderSubmitResult> {
    this.markStarted();
    await this.released;
    return super.submitOrder(order);
  }
}

class FeeChargingOrderAdapter extends FakeOrderAdapter {
  override async submitOrder(order: LiveOrderRequest): Promise<OrderSubmitResult> {
    const fee = BigInt(order.budgetMicros) - BigInt(order.amountMicros);
    return {
      adapterType: this.adapterType,
      externalOrderId: `fake-${order.liveOrderId}`,
      status: "FILLED",
      confirmationPending: false,
      terminal: true,
      fills: [{
        externalFillId: `fake-${order.liveOrderId}-fee-fill`,
        priceUnits: order.priceUnits,
        sizeMicros: order.sizeMicros,
        notionalMicros: order.amountMicros,
        feeMicros: fee.toString(),
        timestamp: now,
        raw: { fake: true, fee: true },
      }],
      raw: { fake: true, fee: true },
    };
  }
}

class FeeChargingSellOrderAdapter extends FakeOrderAdapter {
  override async submitOrder(order: LiveOrderRequest): Promise<OrderSubmitResult> {
    const notional = (BigInt(order.sizeMicros) * BigInt(order.quoteVwapPriceUnits))
      / 1_000_000_000_000_000_000n;
    return {
      adapterType: this.adapterType,
      externalOrderId: `fake-${order.liveOrderId}`,
      status: "FILLED",
      confirmationPending: false,
      terminal: true,
      fills: [{
        externalFillId: `fake-${order.liveOrderId}-sell-fee-fill`,
        priceUnits: order.quoteVwapPriceUnits,
        sizeMicros: order.sizeMicros,
        notionalMicros: notional.toString(),
        feeMicros: "1",
        timestamp: now,
        raw: { fake: true, sellFee: true },
      }],
      raw: { fake: true, sellFee: true },
    };
  }
}

class UnknownSubmissionOutcomeAdapter extends FakeOrderAdapter {
  override async submitOrder(_order: LiveOrderRequest): Promise<OrderSubmitResult> {
    throw new OrderSubmissionOutcomeUnknownError("TEST_RESPONSE_LOST");
  }
}

class HangingSubmissionAdapter extends FakeOrderAdapter {
  override async submitOrder(_order: LiveOrderRequest): Promise<OrderSubmitResult> {
    return new Promise<OrderSubmitResult>(() => undefined);
  }
}

class TimeoutOnceOpenOrdersAdapter extends FakeOrderAdapter {
  openOrderReads = 0;

  override async getOpenOrders(): Promise<OrderStatus[]> {
    this.openOrderReads += 1;
    if (this.openOrderReads === 1) return new Promise<OrderStatus[]>(() => undefined);
    return super.getOpenOrders();
  }
}

class HangingOpenOrdersAdapter extends FakeOrderAdapter {
  openOrderReads = 0;

  override async getOpenOrders(): Promise<OrderStatus[]> {
    this.openOrderReads += 1;
    return new Promise<OrderStatus[]>(() => undefined);
  }
}

class ThrowingBalanceWalletProvider extends FakeWalletProvider {
  override async getBalance(): Promise<never> {
    throw new Error("TEST_BALANCE_NETWORK_DOWN");
  }
}

class FilledWithoutFillsOrderAdapter extends FakeOrderAdapter {
  override async submitOrder(order: LiveOrderRequest): Promise<OrderSubmitResult> {
    return {
      adapterType: this.adapterType,
      externalOrderId: `fake-${order.liveOrderId}`,
      status: "FILLED",
      fills: [],
      raw: { fake: true, inconsistent: true },
    };
  }
}

class OversellingOrderAdapter extends FakeOrderAdapter implements OrderAdapter {
  override async submitOrder(order: LiveOrderRequest): Promise<OrderSubmitResult> {
    const fillSizeMicros = (BigInt(order.sizeMicros) + 1n).toString();
    return {
      adapterType: this.adapterType,
      externalOrderId: `fake-${order.liveOrderId}`,
      status: "FILLED",
      fills: [{
        externalFillId: `fake-${order.liveOrderId}-overfill`,
        priceUnits: order.priceUnits,
        sizeMicros: fillSizeMicros,
        notionalMicros: "5000001",
        feeMicros: "0",
        timestamp: now,
        raw: { fake: true, overfill: true },
      }],
      raw: { fake: true, overfill: true },
    };
  }
}

class SplitFillOrderAdapter extends FakeOrderAdapter {
  override async submitOrder(order: LiveOrderRequest): Promise<OrderSubmitResult> {
    const totalSize = BigInt(order.sizeMicros);
    const totalNotional = BigInt(order.amountMicros);
    const firstSize = totalSize / 2n;
    const firstNotional = totalNotional / 2n;
    const fills = [
      { size: firstSize, notional: firstNotional, suffix: "1" },
      { size: totalSize - firstSize, notional: totalNotional - firstNotional, suffix: "2" },
    ].map(({ size, notional, suffix }) => ({
      externalFillId: `fake-${order.liveOrderId}-fill-${suffix}`,
      priceUnits: order.priceUnits,
      sizeMicros: size.toString(),
      notionalMicros: notional.toString(),
      feeMicros: "0",
      timestamp: now,
      raw: { fake: true, split: true },
    }));
    return {
      adapterType: this.adapterType,
      externalOrderId: `fake-${order.liveOrderId}`,
      status: "FILLED",
      confirmationPending: false,
      terminal: true,
      fills,
      raw: { fake: true, split: true },
    };
  }
}

class DeferredRecoveryOrderAdapter implements OrderAdapter {
  readonly adapterType = "FAKE" as const;
  private order: LiveOrderRequest | null = null;
  private status: OrderStatus | null = null;
  private fills: LiveFillEvent[] = [];

  async submitOrder(order: LiveOrderRequest): Promise<OrderSubmitResult> {
    this.order = order;
    this.status = {
      adapterType: this.adapterType,
      externalOrderId: `deferred-${order.liveOrderId}`,
      status: "ACKNOWLEDGED",
      filledSizeMicros: "0",
      raw: { deferred: true },
    };
    return {
      adapterType: this.adapterType,
      externalOrderId: this.status.externalOrderId,
      status: this.status.status,
      fills: [],
      raw: this.status.raw,
    };
  }

  complete(overrides: Partial<LiveFillEvent> = {}): void {
    if (!this.order || !this.status) throw new Error("DEFERRED_ORDER_NOT_SUBMITTED");
    this.fills = [{
      externalFillId: `${this.status.externalOrderId}-fill-1`,
      priceUnits: this.order.priceUnits,
      sizeMicros: this.order.sizeMicros,
      notionalMicros: this.order.amountMicros,
      feeMicros: "0",
      timestamp: now,
      raw: { recovered: true },
      ...overrides,
    }];
    this.status = {
      ...this.status,
      status: "FILLED",
      filledSizeMicros: this.order.sizeMicros,
      raw: { recovered: true },
    };
  }

  async cancelOrder(orderId: string, _idempotencyKey: string): Promise<CancelResult> {
    if (!this.status || this.status.externalOrderId !== orderId) throw new Error("DEFERRED_ORDER_NOT_FOUND");
    this.status = { ...this.status, status: "CANCELLED" };
    return { adapterType: this.adapterType, cancelled: true, status: "CANCELLED", raw: { deferred: true } };
  }

  async getOrder(orderId: string): Promise<OrderStatus> {
    if (!this.status || this.status.externalOrderId !== orderId) throw new Error("DEFERRED_ORDER_NOT_FOUND");
    return this.status;
  }

  async getOpenOrders(): Promise<OrderStatus[]> {
    if (!this.status || !["CREATED", "SUBMITTED", "ACKNOWLEDGED", "PARTIALLY_FILLED"].includes(this.status.status)) return [];
    return [this.status];
  }

  async getFills(orderId: string): Promise<LiveFillEvent[]> {
    if (!this.status || this.status.externalOrderId !== orderId) throw new Error("DEFERRED_ORDER_NOT_FOUND");
    return this.fills;
  }
}

class UnknownExternalOrderAdapter extends FakeOrderAdapter {
  override async getOpenOrders(): Promise<OrderStatus[]> {
    return [{
      adapterType: this.adapterType,
      externalOrderId: "unknown-external-order",
      status: "ACKNOWLEDGED",
      filledSizeMicros: "0",
      raw: { unknown: true },
    }];
  }
}

class CancelFailureOrderAdapter extends FakeOrderAdapter {
  override async cancelOrder(_orderId: string, _idempotencyKey: string): Promise<CancelResult> {
    throw new Error("TEST_CANCEL_FAILED");
  }
}

class ThrowingRedeemAdapter implements RedeemAdapter {
  readonly adapterType = "FAKE" as const;

  async redeem(): Promise<RedeemResult> {
    throw new Error("TEST_REDEEM_STATUS_UNKNOWN");
  }
}

class FailedRedeemAdapter implements RedeemAdapter {
  readonly adapterType = "FAKE" as const;

  async redeem(): Promise<RedeemResult> {
    return { adapterType: this.adapterType, status: "FAILED", raw: { failed: true } };
  }
}

class PendingClobTradeAdapter implements OrderAdapter {
  readonly adapterType = "POLYMARKET_CLOB" as const;
  private request: LiveOrderRequest | null = null;

  async submitOrder(order: LiveOrderRequest): Promise<OrderSubmitResult> {
    this.request = order;
    return {
      adapterType: this.adapterType,
      externalOrderId: `clob-${order.liveOrderId}`,
      status: "FILLED",
      fills: this.pendingFills(),
      raw: { status: "MATCHED" },
    };
  }

  async cancelOrder(orderId: string, _idempotencyKey: string): Promise<CancelResult> {
    return { adapterType: this.adapterType, cancelled: true, status: "CANCELLED", raw: { orderId } };
  }

  async getOrder(orderId: string): Promise<OrderStatus> {
    if (!this.request || orderId !== `clob-${this.request.liveOrderId}`) throw new Error("CLOB_TEST_ORDER_NOT_FOUND");
    return {
      adapterType: this.adapterType,
      externalOrderId: orderId,
      status: "FILLED",
      filledSizeMicros: this.request.sizeMicros,
      raw: { status: "MATCHED" },
    };
  }

  async getOpenOrders(): Promise<OrderStatus[]> {
    return [];
  }

  async getFills(orderId: string): Promise<LiveFillEvent[]> {
    if (!this.request || orderId !== `clob-${this.request.liveOrderId}`) throw new Error("CLOB_TEST_ORDER_NOT_FOUND");
    return this.pendingFills();
  }

  private pendingFills(): LiveFillEvent[] {
    if (!this.request) return [];
    return [{
      externalFillId: `clob-${this.request.liveOrderId}-trade`,
      priceUnits: this.request.priceUnits,
      sizeMicros: this.request.sizeMicros,
      notionalMicros: this.request.amountMicros,
      feeMicros: "0",
      timestamp: now,
      raw: { status: "MATCHED" },
    }];
  }
}

function setup(options: {
  marketEndTime?: string;
  capitalRatioPpm?: string;
  historicalStopRules?: { triggerRatioPpm: number; maxSlippagePpm: number };
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), "ni-k-live-executor-"));
  directories.push(directory);
  const databasePath = join(directory, "phase0.sqlite");
  const phase0 = new Phase0Database(databasePath, sourceVersion);
  phase0.initialize();
  const targetId = phase0.ensureTarget(wallet, "IDENTITY_CONFIRMED");
  phase0.close();
  const ruleset = options.historicalStopRules
    ? installHistoricalStopRuleset(databasePath, options.historicalStopRules)
    : undefined;
  insertAccount(databasePath);
  const inserted = insertSignalAndRisk(databasePath, targetId, {
    signalId: "live-buy",
    riskDecisionId: "risk-live-buy",
    decision: "ALLOW",
    ...(options.marketEndTime ? { marketEndTime: options.marketEndTime } : {}),
    ...(options.capitalRatioPpm ? { capitalRatioPpm: options.capitalRatioPpm } : {}),
    ...(ruleset ? { ruleset } : {}),
  });
  return { databasePath, targetId, ruleset, ...inserted };
}

function installHistoricalStopRuleset(
  databasePath: string,
  input: { triggerRatioPpm: number; maxSlippagePpm: number },
): TestRuleset {
  const snapshot = JSON.parse(RULESET_SNAPSHOT_JSON) as {
    versions: Record<string, unknown>;
    rules: Record<string, unknown>;
  };
  snapshot.versions.rulesetVersion = "test-historical-stop-v1";
  snapshot.versions.configVersion = "test-historical-config-v1";
  snapshot.rules.buyPriceMinRatioPpm = 980_000;
  snapshot.rules.buyPriceMaxRatioPpm = 1_020_000;
  snapshot.rules.buyPriceImprovementAllowed = true;
  snapshot.rules.buyPriceMinimumTickSteps = 2;
  snapshot.rules.stopTriggerRatioPpm = input.triggerRatioPpm;
  snapshot.rules.liveStopLossRatioPpm = input.triggerRatioPpm;
  snapshot.rules.stopSellMaxSlippagePpm = input.maxSlippagePpm;
  delete snapshot.rules.smallFollowBuyMaxCount;
  const snapshotJson = stableJson(snapshot);
  const rulesetHash = createHash("sha256").update(snapshotJson).digest("hex");
  const configVersion = "test-historical-config-v1";
  const db = new DatabaseSync(databasePath);
  db.exec("PRAGMA foreign_keys=ON");
  db.prepare(
    `INSERT INTO rulesets(
      ruleset_hash,schema_version,signal_version,strategy_version,risk_version,
      replay_version,ruleset_snapshot_json,source_code_commit,source_code_dirty,
      config_version,created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
  ).run(
    rulesetHash,
    VERSIONS.schemaVersion,
    VERSIONS.signalVersion,
    VERSIONS.strategyVersion,
    VERSIONS.riskVersion,
    VERSIONS.replayVersion,
    snapshotJson,
    sourceVersion.commit,
    configVersion,
    now,
  );
  db.prepare(
    `INSERT INTO ruleset_registry(
      ruleset_hash,ruleset_version,buy_price_lower_ratio_ppm,buy_price_upper_ratio_ppm,
      stop_loss_ratio_ppm,wait_ratio_ppm,max_wait_time_ms,capital_mode,
      fee_model_version,ruleset_snapshot_json,source_code_commit,source_code_dirty,
      config_version,created_at
    ) VALUES (?, 'test-historical-stop-v1', ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
  ).run(
    rulesetHash,
    980_000,
    1_020_000,
    input.triggerRatioPpm,
    RULESET.waitRatioPpm,
    RULESET.maxWaitMs,
    RULESET.capitalMode,
    VERSIONS.feeModelVersion,
    snapshotJson,
    sourceVersion.commit,
    configVersion,
    now,
  );
  db.close();
  return { hash: rulesetHash, snapshotJson, configVersion };
}

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
}): { signal: PaperSignalEnvelope; context: SignalExecutionContext } {
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

function liveExecutor(databasePath: string, overrides: Partial<ConstructorParameters<typeof LiveExecutor>[0]> = {}) {
  return new LiveExecutor({
    databasePath,
    liveGate: new FakeGate(),
    orderAdapter: new FakeOrderAdapter(),
    walletProvider: new FakeWalletProvider(),
    signer: new FakeSigner(),
    marketDataProvider: new FakeLiveMarketDataProvider({ now: () => new Date(now) }),
    sourceVersion,
    now: () => new Date(now),
    environment: "TEST",
    ...overrides,
  });
}

function liveExecutorAt(
  databasePath: string,
  instant: string,
  overrides: Partial<ConstructorParameters<typeof LiveExecutor>[0]> = {},
) {
  return liveExecutor(databasePath, {
    now: () => new Date(instant),
    marketDataProvider: new FakeLiveMarketDataProvider({ now: () => new Date(instant) }),
    ...overrides,
  });
}

function count(databasePath: string, table: string): number {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  const row = db.prepare(`SELECT count(*) count FROM ${table}`).get() as { count: number };
  db.close();
  return row.count;
}

function cloneRiskDecision(databasePath: string, fromId: string, toId: string): void {
  const db = new DatabaseSync(databasePath);
  db.prepare(
    `INSERT INTO risk_decisions(
      risk_decision_id,executor_mode,paper_account_id,account_id,signal_id,context_id,decision,
      risk_reject_reason,requested_amount_micros,requested_size_micros,checks_json,
      schema_version,strategy_version,risk_version,ruleset_hash,source_code_commit,
      source_code_dirty,config_version,created_at,risk_reason
    )
    SELECT ?,executor_mode,paper_account_id,account_id,signal_id,context_id,decision,
      risk_reject_reason,requested_amount_micros,requested_size_micros,checks_json,
      schema_version,strategy_version,risk_version,ruleset_hash,source_code_commit,
      source_code_dirty,config_version,created_at,risk_reason
    FROM risk_decisions WHERE risk_decision_id=?`,
  ).run(toId, fromId);
  db.close();
}

function activateLiveGate(databasePath: string): void {
  const db = new DatabaseSync(databasePath);
  const previous = db.prepare(
    "SELECT execution_mode,live_gate_state FROM live_gate_state WHERE state_id='default'",
  ).get() as { execution_mode: string; live_gate_state: string };
  const boundary = (db.prepare(
    "SELECT COALESCE(MAX(signal_sequence),0) value FROM signal_ingest_sequences",
  ).get() as { value: number }).value;
  const transitionId = `test-live-activation-${Date.now()}-${Math.random()}`;
  db.exec("BEGIN IMMEDIATE");
  db.prepare(
    `UPDATE live_gate_state
     SET execution_mode='LIVE',live_gate_state='LIVE_ACTIVE',requested_execution_mode='LIVE',
         state_reason='TEST_LIVE_ACTIVE',updated_at=?
     WHERE state_id='default'`,
  ).run(now);
  db.prepare(
    `INSERT INTO live_gate_state_transitions(
      transition_id,from_execution_mode,to_execution_mode,from_live_gate_state,to_live_gate_state,
      reason,actor,metadata_json,source_code_commit,source_code_dirty,config_version,created_at,
      signal_boundary_sequence
    ) VALUES (?, ?, 'LIVE', ?, 'LIVE_ACTIVE', 'TEST_LIVE_ACTIVE', 'TEST', '{}', ?, 0, ?, ?, ?)`,
  ).run(
    transitionId,
    previous.execution_mode,
    previous.live_gate_state,
    sourceVersion.commit,
    VERSIONS.configVersion,
    now,
    boundary,
  );
  db.exec("COMMIT");
  db.close();
}

function insertPublishedSignalWithoutContext(
  databasePath: string,
  targetId: string,
  signalId: string,
  targetSizeMicros = "10000000",
): void {
  const db = new DatabaseSync(databasePath);
  db.exec("PRAGMA foreign_keys=ON");
  const sourceKey = `source-${signalId}`;
  db.prepare(
    `INSERT INTO raw_events(
      source_event_key,target_id,identity_version,source_type,source_transaction_hash,
      source_timestamp,asset_id,condition_id,side,price_units,size_micros,gap_event,
      is_combo,raw_json,created_at,event_classification
    ) VALUES (?, ?, 'test', 'DATA_API_TRADE', ?, 1773014400, ?, ?, 'BUY',
      '500000000000000000', '10000000', 0, 0, '{}', ?, 'STANDARD_TRADE')`,
  ).run(sourceKey, targetId, `tx-${signalId}`, assetId, conditionId, now);
  db.prepare(
    `INSERT INTO signals(
      signal_id,target_id,signal_idempotency_key,source_event_key,signal_type,status,asset_id,
      condition_id,target_price_units,target_size_micros,sell_ratio_numerator,
      sell_ratio_denominator,reason,schema_version,signal_version,strategy_version,
      risk_version,replay_version,ruleset_snapshot_json,ruleset_hash,source_code_commit,
      created_at,execution_eligible,execution_block_reason,event_classification,
      capital_estimate_id,source_code_dirty,producer_mode
    ) VALUES (?, ?, ?, ?, 'TARGET_BUY', 'PUBLISHED', ?, ?, '500000000000000000',
      ?, NULL, NULL, 'TEST_NO_CONTEXT', ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL,
      'STANDARD_TRADE', NULL, 0, 'OBSERVE_ONLY')`,
  ).run(
    signalId,
    targetId,
    `idem-${signalId}`,
    sourceKey,
    assetId,
    conditionId,
    targetSizeMicros,
    VERSIONS.schemaVersion,
    VERSIONS.signalVersion,
    VERSIONS.strategyVersion,
    VERSIONS.riskVersion,
    VERSIONS.replayVersion,
    RULESET_SNAPSHOT_JSON,
    RULESET_HASH,
    sourceVersion.commit,
    now,
  );
  db.close();
}

function insertBlockingConversionSignal(
  databasePath: string,
  targetId: string,
  signalId: string,
): void {
  const db = new DatabaseSync(databasePath);
  db.exec("PRAGMA foreign_keys=ON");
  const sourceKey = `source-${signalId}`;
  db.prepare(
    `INSERT INTO raw_events(
      source_event_key,target_id,identity_version,source_type,source_transaction_hash,
      source_timestamp,asset_id,condition_id,side,price_units,size_micros,gap_event,
      is_combo,raw_json,created_at,event_classification
    ) VALUES (?, ?, 'activity-v1', 'DATA_API_ACTIVITY', ?, 1773014401, ?, ?, 'NONE',
      '0', '0', 0, 1, '{}', ?, 'COMBO_ACTIVITY')`,
  ).run(sourceKey, targetId, `tx-${signalId}`, assetId, conditionId, now);
  db.prepare(
    `INSERT INTO signals(
      signal_id,target_id,signal_idempotency_key,source_event_key,signal_type,status,asset_id,
      condition_id,target_price_units,target_size_micros,sell_ratio_numerator,
      sell_ratio_denominator,reason,schema_version,signal_version,strategy_version,
      risk_version,replay_version,ruleset_snapshot_json,ruleset_hash,source_code_commit,
      created_at,execution_eligible,execution_block_reason,event_classification,
      capital_estimate_id,source_code_dirty,producer_mode
    ) VALUES (?, ?, ?, ?, 'TARGET_CONVERSION', 'PUBLISHED', ?, ?, '0', '10000000',
      '6000000', '6000000', 'TRACKED_NEGATIVE_RISK_CONVERSION_RECORDED', ?, ?, ?, ?, ?, ?, ?, ?, ?,
      0, 'NEGATIVE_RISK_CONVERSION_EXECUTION_UNAVAILABLE', 'NEGATIVE_RISK_CONVERSION',
      NULL, 0, 'OBSERVE_ONLY')`,
  ).run(
    signalId,
    targetId,
    `idem-${signalId}`,
    sourceKey,
    assetId,
    conditionId,
    VERSIONS.schemaVersion,
    VERSIONS.signalVersion,
    VERSIONS.strategyVersion,
    VERSIONS.riskVersion,
    VERSIONS.replayVersion,
    RULESET_SNAPSHOT_JSON,
    RULESET_HASH,
    sourceVersion.commit,
    now,
  );
  db.close();
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("LiveExecutor", () => {
  it("forbids fake execution components unless TEST is explicit", () => {
    const env = setup();
    expect(() => new LiveExecutor({
      databasePath: env.databasePath,
      liveGate: new FakeGate(),
      orderAdapter: new FakeOrderAdapter(),
      walletProvider: new FakeWalletProvider(),
      signer: new FakeSigner(),
      sourceVersion,
    })).toThrow("FAKE_LIVE_COMPONENT_FORBIDDEN_IN_PRODUCTION");
  });

  it("forbids a fake Live market-data provider in production even when all mutation adapters are disabled", () => {
    const env = setup();
    expect(() => new LiveExecutor({
      databasePath: env.databasePath,
      liveGate: new FakeGate(),
      marketDataProvider: new FakeLiveMarketDataProvider({ now: () => new Date(now) }),
      sourceVersion,
    })).toThrow("FAKE_LIVE_COMPONENT_FORBIDDEN_IN_PRODUCTION");
  });

  it("requires a production-attested Gate in PRODUCTION", () => {
    const env = setup();
    expect(() => new LiveExecutor({
      databasePath: env.databasePath,
      liveGate: new ProductionRuntimeFakeGate(),
      sourceVersion,
    })).toThrow("PRODUCTION_LIVE_GATE_REQUIRED");
  });

  it("allows only Fake or Disabled mutation components in TEST", () => {
    const env = setup();
    const fakeWallet = new FakeWalletProvider();
    const liveWalletProvider = {
      providerType: "LIVE_READONLY" as const,
      getAddress: () => fakeWallet.getAddress(),
      getBalance: () => fakeWallet.getBalance(),
      getAllowance: () => fakeWallet.getAllowance(),
      getOutcomeBalance: (tokenId: string) => fakeWallet.getOutcomeBalance(tokenId),
      getOutcomeAllowance: (tokenId: string) => fakeWallet.getOutcomeAllowance(tokenId),
      getOutcomePositions: () => fakeWallet.getOutcomePositions(),
      getStatus: () => fakeWallet.getStatus(),
    };
    const liveSigner: Signer = {
      signerType: "LIVE",
      address: async () => wallet,
      signOrder: async () => ({ signerAddress: wallet, signature: "test", payloadHash: "test" }),
    };
    const liveRedeemAdapter: RedeemAdapter = {
      adapterType: "LIVE",
      redeem: async () => ({ adapterType: "LIVE", status: "DISABLED", raw: {} }),
    };
    const cases: Array<Partial<ConstructorParameters<typeof LiveExecutor>[0]>> = [
      { walletProvider: liveWalletProvider },
      { signer: liveSigner },
      { redeemAdapter: liveRedeemAdapter },
    ];
    for (const overrides of cases) {
      expect(() => liveExecutor(env.databasePath, overrides))
        .toThrow("REAL_LIVE_COMPONENT_FORBIDDEN_IN_TEST");
    }
  });

  it("rejects an allowed PRODUCTION Gate result that has no matching persisted EXECUTION_CHECK", async () => {
    const env = setup();
    const executor = new LiveExecutor({
      databasePath: env.databasePath,
      liveGate: new UnpersistedProductionGate(),
      sourceVersion,
      environment: "PRODUCTION",
    });
    const result = await executor.executeBuy({
      accountId,
      signal: env.signal,
      context: env.context,
      riskDecisionId: "risk-live-buy",
    });
    const db = new DatabaseSync(env.databasePath, { readOnly: true });
    const row = db.prepare("SELECT reason FROM live_executions WHERE live_execution_id=?")
      .get(result.executionId) as { reason: string };
    expect(result.state).toBe("REJECTED");
    expect(row.reason).toBe("LIVE_GATE_ALLOWED_RUN_NOT_PERSISTED");
    expect(count(env.databasePath, "live_orders")).toBe(0);
    db.close();
    executor.close();
  });

  it("rejects a persisted PRODUCTION Gate run whose attestation does not match an EXECUTION_CHECK", async () => {
    const env = setup();
    const runId = "mismatched-production-run";
    const writer = new DatabaseSync(env.databasePath);
    writer.prepare(
      `INSERT INTO live_gate_runs(
        live_gate_run_id,run_type,allowed,blocked_reasons_json,checks_json,
        requested_execution_mode,execution_mode,live_gate_state,risk_decision_id,
        signal_id,ruleset_hash,source_code_commit,source_code_dirty,config_version,created_at
      ) VALUES (?, 'PREFLIGHT', 1, '[]', '[]', 'LIVE', 'LIVE', 'LIVE_ACTIVE',
        ?, ?, ?, ?, 0, ?, ?)`,
    ).run(
      runId,
      "risk-live-buy",
      env.signal.signalId,
      RULESET_HASH,
      sourceVersion.commit,
      VERSIONS.configVersion,
      now,
    );
    writer.close();
    const executor = new LiveExecutor({
      databasePath: env.databasePath,
      liveGate: new UnpersistedProductionGate(runId),
      sourceVersion,
      environment: "PRODUCTION",
    });
    const result = await executor.executeBuy({
      accountId,
      signal: env.signal,
      context: env.context,
      riskDecisionId: "risk-live-buy",
    });
    const db = new DatabaseSync(env.databasePath, { readOnly: true });
    const row = db.prepare("SELECT reason FROM live_executions WHERE live_execution_id=?")
      .get(result.executionId) as { reason: string };
    expect(result.state).toBe("REJECTED");
    expect(row.reason).toBe("LIVE_GATE_ALLOWED_RUN_ATTESTATION_MISMATCH");
    expect(count(env.databasePath, "live_orders")).toBe(0);
    db.close();
    executor.close();
  });

  it("rejects by default through the real Live Gate when execution mode is PAPER", async () => {
    const env = setup();
    const gate = new LiveGateService(
      env.databasePath,
      new MockBalanceProvider({ status: "AVAILABLE", balanceMicros: "1000000000", reason: null }),
      { ...defaultLiveGateConfig(), runtimeEnvironment: "TEST" },
      {
        sourceVersion,
        now: () => new Date(now),
        geoblockProvider: new FakeGeoblockProvider({
          status: "ALLOWED",
          checkedAt: now,
          source: "TEST_FIXTURE",
          reason: null,
        }),
        clockProvider: new FakeClockSafetyProvider({
          status: "SAFE",
          offsetMs: 0,
          checkedAt: now,
          source: "TEST_FIXTURE",
          reason: null,
        }),
      },
    );
    const executor = liveExecutor(env.databasePath, { liveGate: gate });
    const result = await executor.executeBuy({ accountId, signal: env.signal, context: env.context, riskDecisionId: "risk-live-buy" });
    expect(result.state).toBe("REJECTED");
    const db = new DatabaseSync(env.databasePath);
    const reason = (db.prepare("SELECT reason FROM live_executions WHERE live_execution_id=?").get(result.executionId) as { reason: string }).reason;
    expect(reason).toContain("NOT_LIVE_ACTIVE:PAPER:LIVE_DISABLED");
    db.close();
    executor.close();
    gate.close();
  });

  it("rejects when the Live Gate blocks execution", async () => {
    const env = setup();
    const executor = liveExecutor(env.databasePath, { liveGate: new FakeGate(false, "FAKE_BLOCK") });
    const result = await executor.executeBuy({ accountId, signal: env.signal, context: env.context, riskDecisionId: "risk-live-buy" });
    expect(result.state).toBe("REJECTED");
    expect(count(env.databasePath, "live_orders")).toBe(0);
    executor.close();
  });

  it("rechecks the complete Live Gate immediately before creating an order intent", async () => {
    const env = setup();
    const executor = liveExecutor(env.databasePath, { liveGate: new FlippingGate() });
    const result = await executor.executeBuy({
      accountId,
      signal: env.signal,
      context: env.context,
      riskDecisionId: "risk-live-buy",
    });
    expect(result.state).toBe("REJECTED");
    expect(count(env.databasePath, "live_orders")).toBe(0);
    const db = new DatabaseSync(env.databasePath);
    const reason = db.prepare("SELECT reason FROM live_executions WHERE live_execution_id=?")
      .get(result.executionId) as { reason: string };
    expect(reason.reason).toContain("LIVE_GATE_RECHECK_BLOCKED:TEST_GATE_BECAME_UNSAFE");
    db.close();
    executor.close();
  });

  it("keeps a BUY reserved and retryable while the orderbook is stale, then executes once on fresh evidence", async () => {
    const env = setup();
    const stale = liveExecutor(env.databasePath, {
      marketDataProvider: new FakeLiveMarketDataProvider({
        now: () => new Date(now),
        marketSnapshotTime: "2026-07-08T23:59:55.000Z",
        receivedAt: "2026-07-08T23:59:55.000Z",
      }),
    });
    const first = await stale.executeBuy({
      accountId,
      signal: env.signal,
      context: env.context,
      riskDecisionId: "risk-live-buy",
    });
    expect(first.state).toBe("WAITING_EXECUTION");
    expect(count(env.databasePath, "live_orders")).toBe(0);
    const pending = new DatabaseSync(env.databasePath, { readOnly: true });
    expect((pending.prepare("SELECT outcome,reason FROM live_market_checks").get() as { outcome: string; reason: string }))
      .toEqual({ outcome: "WAIT", reason: "ORDERBOOK_STALE" });
    expect((pending.prepare("SELECT remaining_after_micros FROM live_reservation_ledger ORDER BY created_at DESC LIMIT 1").get() as { remaining_after_micros: string }).remaining_after_micros)
      .toBe("5000000");
    pending.close();
    stale.close();

    const fresh = liveExecutor(env.databasePath);
    const second = await fresh.executeBuy({
      accountId,
      signal: env.signal,
      context: env.context,
      riskDecisionId: "risk-live-buy",
    });
    expect(second).toMatchObject({ executionId: first.executionId, state: "EXECUTED" });
    expect(count(env.databasePath, "live_executions")).toBe(1);
    expect(count(env.databasePath, "live_orders")).toBe(1);
    expect(count(env.databasePath, "live_market_checks")).toBe(2);
    fresh.close();
  });

  it("does not submit a BUY when the best ask is above the asymmetric limit", async () => {
    const env = setup();
    const executor = liveExecutor(env.databasePath, {
      marketDataProvider: new FakeLiveMarketDataProvider({
        now: () => new Date(now),
        asks: [{ price: "0.6", size: "1000" }],
      }),
    });
    const result = await executor.executeBuy({
      accountId,
      signal: env.signal,
      context: env.context,
      riskDecisionId: "risk-live-buy",
    });
    expect(result.state).toBe("WAITING_EXECUTION");
    expect(count(env.databasePath, "live_orders")).toBe(0);
    const db = new DatabaseSync(env.databasePath, { readOnly: true });
    expect((db.prepare("SELECT reason FROM live_market_checks").get() as { reason: string }).reason)
      .toBe("BUY_BEST_ASK_ABOVE_LIMIT");
    db.close();
    executor.close();
  });

  it("uses the same 105 percent BUY ceiling as Paper", async () => {
    const env = setup();
    const signal = insertSignalAndRisk(env.databasePath, env.targetId, {
      signalId: "live-buy-two-ticks-above-target",
      riskDecisionId: "risk-live-buy-two-ticks-above-target",
      decision: "ALLOW",
      requestedAmountMicros: "5000000",
      requestedSizeMicros: null,
      targetPriceUnits: "120000000000000000",
    });
    const executor = liveExecutor(env.databasePath, {
      marketDataProvider: new FakeLiveMarketDataProvider({
        now: () => new Date(now),
        asks: [{ price: "0.14", size: "1000" }],
        bids: [{ price: "0.12", size: "1000" }],
        tickSize: "0.01",
      }),
    });

    const result = await executor.executeBuy({
      accountId,
      signal: signal.signal,
      context: signal.context,
      riskDecisionId: "risk-live-buy-two-ticks-above-target",
    });

    expect(result).toMatchObject({ state: "WAITING_EXECUTION" });
    executor.close();
  });

  it("does not apply the current fee-inclusive price band to a historical Live BUY", async () => {
    const env = setup({
      historicalStopRules: { triggerRatioPpm: 600_000, maxSlippagePpm: 200_000 },
    });
    const executor = liveExecutor(env.databasePath, {
      signer: new MutatingFakeSigner((payload) => {
        const size = (BigInt(String(payload.sizeMicros)) * 99n) / 100n;
        const amount = (size * BigInt(String(payload.priceUnits))) / 1_000_000_000_000_000_000n;
        return { orderAmountMicros: amount.toString(), orderSizeMicros: size.toString() };
      }),
      marketDataProvider: new NonZeroFeeMarketDataProvider({
        now: () => new Date(now),
        asks: [{ price: "0.52", size: "1000" }],
        bids: [{ price: "0.51", size: "1000" }],
      }),
    });

    const result = await executor.executeBuy({
      accountId,
      signal: env.signal,
      context: env.context,
      riskDecisionId: "risk-live-buy",
    });

    expect(result.state).toBe("EXECUTED");
    const database = new DatabaseSync(env.databasePath, { readOnly: true });
    expect(database.prepare(
      "SELECT outcome,reason FROM live_market_checks WHERE live_execution_id=?",
    ).get(result.executionId)).toEqual({
      outcome: "ALLOW",
      reason: "LIVE_BUY_MARKET_CHECK_ALLOW",
    });
    database.close();
    executor.close();
  });

  it("waits when fees push the current Live BUY VWAP above the inclusive 105-percent boundary", async () => {
    const env = setup();
    const executor = liveExecutor(env.databasePath, {
      marketDataProvider: new NonZeroFeeMarketDataProvider({
        now: () => new Date(now),
        asks: [{ price: "0.525", size: "1000" }],
        bids: [{ price: "0.51", size: "1000" }],
        tickSize: "0.001",
      }),
    });

    const result = await executor.executeBuy({
      accountId,
      signal: env.signal,
      context: env.context,
      riskDecisionId: "risk-live-buy",
    });

    expect(result.state).toBe("WAITING_EXECUTION");
    const database = new DatabaseSync(env.databasePath, { readOnly: true });
    expect(database.prepare(
      "SELECT outcome,reason FROM live_market_checks WHERE live_execution_id=?",
    ).get(result.executionId)).toEqual({
      outcome: "WAIT",
      reason: "BUY_EXECUTION_VWAP_ABOVE_LIMIT",
    });
    expect(database.prepare(
      "SELECT count(*) count FROM live_orders WHERE live_execution_id=?",
    ).get(result.executionId)).toEqual({ count: 0 });
    database.close();
    executor.close();
  });

  it("uses the tick-rounded BUY ceiling for the Live market-minimum precheck", async () => {
    const env = setup();
    const signal = insertSignalAndRisk(env.databasePath, env.targetId, {
      signalId: "live-tick-rounded-market-minimum",
      riskDecisionId: "risk-live-tick-rounded-market-minimum",
      decision: "ALLOW",
      requestedAmountMicros: "5000000",
      requestedSizeMicros: null,
      targetPriceUnits: "100000000000000000",
    });
    const executor = liveExecutor(env.databasePath, {
      marketDataProvider: new FakeLiveMarketDataProvider({
        now: () => new Date(now),
        asks: [{ price: "0.10", size: "4" }, { price: "0.105", size: "6" }],
        bids: [{ price: "0.09", size: "1000" }],
        minOrderSize: "10",
        tickSize: "0.01",
      }),
    });
    const result = await executor.executeBuy({
      accountId,
      signal: signal.signal,
      context: signal.context,
      riskDecisionId: "risk-live-tick-rounded-market-minimum",
    });
    expect(result.state).toBe("WAITING_EXECUTION");
    const database = new DatabaseSync(env.databasePath, { readOnly: true });
    expect(database.prepare(
      "SELECT reason FROM live_market_checks WHERE live_execution_id=?",
    ).get(result.executionId)).toEqual({ reason: "BUY_MARKET_MINIMUM_LIQUIDITY_UNAVAILABLE" });
    expect(database.prepare("SELECT count(*) count FROM live_orders").get()).toEqual({ count: 0 });
    database.close();
    executor.close();
  });

  it("abandons the same below-90-percent BUY as Paper", async () => {
    const env = setup();
    const signal = insertSignalAndRisk(env.databasePath, env.targetId, {
      signalId: "live-buy-below-target",
      riskDecisionId: "risk-live-buy-below-target",
      decision: "ALLOW",
      requestedAmountMicros: "5000000",
      requestedSizeMicros: null,
      targetPriceUnits: "120000000000000000",
    });
    const executor = liveExecutor(env.databasePath, {
      marketDataProvider: new FakeLiveMarketDataProvider({
        now: () => new Date(now),
        asks: [{ price: "0.10", size: "1000" }],
        bids: [{ price: "0.09", size: "1000" }],
        tickSize: "0.01",
      }),
    });

    const result = await executor.executeBuy({
      accountId,
      signal: signal.signal,
      context: signal.context,
      riskDecisionId: "risk-live-buy-below-target",
    });

    expect(result).toMatchObject({ state: "REJECTED" });
    executor.close();
  });

  it("caps the Live BUY band at 0.95 and rejects when the current best ask is higher", async () => {
    const env = setup();
    const capped = insertSignalAndRisk(env.databasePath, env.targetId, {
      signalId: "live-current-price-over-cap",
      riskDecisionId: "risk-live-current-price-over-cap",
      decision: "ALLOW",
      requestedAmountMicros: "5000000",
      requestedSizeMicros: null,
      targetPriceUnits: "940000000000000000",
    });
    const executor = liveExecutor(env.databasePath, {
      marketDataProvider: new FakeLiveMarketDataProvider({
        now: () => new Date(now),
        asks: [{ price: "0.96", size: "1000" }],
      }),
    });
    const result = await executor.executeBuy({
      accountId,
      signal: capped.signal,
      context: capped.context,
      riskDecisionId: "risk-live-current-price-over-cap",
    });
    expect(result.state).toBe("REJECTED");
    const db = new DatabaseSync(env.databasePath, { readOnly: true });
    expect(db.prepare("SELECT outcome,reason,upper_price_units FROM live_market_checks WHERE live_execution_id=?").get(result.executionId))
      .toEqual({
        outcome: "REJECT",
        reason: "BUY_EXECUTION_PRICE_ABOVE_MAX",
        upper_price_units: ((BigInt(RULESET.buyMaximumPricePpm) * 10n ** 18n) / 1_000_000n).toString(),
      });
    expect(db.prepare("SELECT count(*) count FROM live_orders WHERE live_execution_id=?").get(result.executionId))
      .toEqual({ count: 0 });
    db.close();
    executor.close();
  });

  it("checks the 0.95 executable-price cap before applying a Live market-minimum lift", async () => {
    const env = setup({ capitalRatioPpm: "1" });
    const executor = liveExecutor(env.databasePath, {
      marketDataProvider: new FakeLiveMarketDataProvider({
        now: () => new Date(now),
        asks: [{ price: "0.96", size: "1000" }],
        minOrderSize: "5",
        tickSize: "0.01",
      }),
    });
    const consumer = new LiveSignalConsumer(env.databasePath, executor, sourceVersion, () => new Date(now));

    const [result] = await consumer.consumeAvailableSignals(accountId);

    expect(result).toMatchObject({ state: "REJECTED" });
    const db = new DatabaseSync(env.databasePath, { readOnly: true });
    expect(db.prepare(
      `SELECT e.reason,e.requested_amount_micros,r.requested_amount_micros risk_amount
       FROM live_executions e JOIN risk_decisions r ON r.risk_decision_id=e.risk_decision_id
       WHERE e.live_execution_id=?`,
    ).get(result!.executionId)).toEqual({
      reason: "BUY_EXECUTION_PRICE_ABOVE_MAX",
      requested_amount_micros: "1000000",
      risk_amount: "1000000",
    });
    db.close();
    expect(await executor.getPosition({ accountId, assetId })).toEqual([]);
    consumer.close();
    executor.close();
  });

  it("allows a target reference above 0.95 when the actual Live execution is at or below 0.95", async () => {
    const env = setup();
    const high = insertSignalAndRisk(env.databasePath, env.targetId, {
      signalId: "live-target-price-over-cap",
      riskDecisionId: "risk-live-target-price-over-cap",
      decision: "ALLOW",
      requestedAmountMicros: "5000000",
      requestedSizeMicros: null,
      targetPriceUnits: "951000000000000000",
    });
    const executor = liveExecutor(env.databasePath, {
      marketDataProvider: new FakeLiveMarketDataProvider({
        now: () => new Date(now),
        asks: [{ price: "0.94", size: "1000" }],
        bids: [{ price: "0.93", size: "1000" }],
      }),
    });
    const result = await executor.executeBuy({
      accountId,
      signal: high.signal,
      context: high.context,
      riskDecisionId: "risk-live-target-price-over-cap",
    });
    expect(result.state).toBe("EXECUTED");
    const db = new DatabaseSync(env.databasePath, { readOnly: true });
    expect(db.prepare("SELECT reason FROM live_executions WHERE live_execution_id=?").get(result.executionId))
      .toEqual({ reason: "FAK_FILLED" });
    expect(db.prepare("SELECT count(*) count FROM live_orders WHERE live_execution_id=?").get(result.executionId))
      .toEqual({ count: 1 });
    db.close();
    executor.close();
  });

  it("keeps a TARGET_SELL in EXIT_PENDING when full-depth bids breach the 10% slippage floor", async () => {
    const env = setup();
    const buyer = liveExecutor(env.databasePath);
    await buyer.executeBuy({ accountId, signal: env.signal, context: env.context, riskDecisionId: "risk-live-buy" });
    buyer.close();
    const sell = insertSignalAndRisk(env.databasePath, env.targetId, {
      signalId: "live-sell-slippage-pending",
      riskDecisionId: "risk-live-sell-slippage-pending",
      decision: "ALLOW",
      signalType: "TARGET_SELL",
      requestedAmountMicros: null,
      requestedSizeMicros: "10000000",
    });
    const seller = liveExecutor(env.databasePath, {
      marketDataProvider: new FakeLiveMarketDataProvider({
        now: () => new Date(now),
        bids: [{ price: "0.44", size: "1000" }],
      }),
    });
    const result = await seller.executeSell({
      accountId,
      signal: sell.signal,
      context: sell.context,
      riskDecisionId: "risk-live-sell-slippage-pending",
    });
    expect(result.state).toBe("EXIT_PENDING");
    const db = new DatabaseSync(env.databasePath, { readOnly: true });
    expect((db.prepare("SELECT reason FROM live_market_checks WHERE signal_id=?").get(sell.signal.signalId) as { reason: string }).reason)
      .toBe("SELL_SLIPPAGE_OR_LIQUIDITY_WAIT");
    expect((db.prepare("SELECT count(*) count FROM live_orders o JOIN live_executions e ON e.live_execution_id=o.live_execution_id WHERE e.signal_id=?").get(sell.signal.signalId) as { count: number }).count)
      .toBe(0);
    db.close();
    seller.close();
  });

  it("executes an independent same-asset BUY while an older target exit remains pending", async () => {
    const env = setup();
    const opener = liveExecutor(env.databasePath);
    await opener.executeBuy({
      accountId,
      signal: env.signal,
      context: env.context,
      riskDecisionId: "risk-live-buy",
    });
    opener.close();

    const sell = insertSignalAndRisk(env.databasePath, env.targetId, {
      signalId: "live-sell-pending-before-independent-buy",
      riskDecisionId: "risk-live-sell-pending-before-independent-buy",
      decision: "ALLOW",
      signalType: "TARGET_SELL",
      requestedAmountMicros: null,
      requestedSizeMicros: "10000000",
      createdAt: "2026-07-09T00:00:01.000Z",
    });
    const seller = liveExecutor(env.databasePath, {
      marketDataProvider: new FakeLiveMarketDataProvider({
        now: () => new Date(now),
        bids: [{ price: "0.44", size: "1000" }],
      }),
    });
    const pendingExit = await seller.executeSell({
      accountId,
      signal: sell.signal,
      context: sell.context,
      riskDecisionId: "risk-live-sell-pending-before-independent-buy",
    });
    expect(pendingExit.state).toBe("EXIT_PENDING");
    seller.close();

    const rebuy = insertSignalAndRisk(env.databasePath, env.targetId, {
      signalId: "live-independent-buy-after-pending-sell",
      riskDecisionId: "risk-live-independent-buy-after-pending-sell",
      decision: "ALLOW",
      requestedAmountMicros: "5000000",
      requestedSizeMicros: null,
      createdAt: "2026-07-09T00:00:02.000Z",
    });
    const buyer = liveExecutor(env.databasePath);
    const result = await buyer.executeBuy({
      accountId,
      signal: rebuy.signal,
      context: rebuy.context,
      riskDecisionId: "risk-live-independent-buy-after-pending-sell",
    });

    expect(result.state).toBe("EXECUTED");
    const db = new DatabaseSync(env.databasePath, { readOnly: true });
    expect(db.prepare(
      "SELECT state FROM live_executions WHERE live_execution_id=?",
    ).get(pendingExit.executionId)).toEqual({ state: "EXIT_PENDING" });
    expect(db.prepare(
      "SELECT count(*) count FROM live_positions WHERE live_account_id=? AND status='OPEN'",
    ).get(accountId)).toEqual({ count: 2 });
    db.close();
    buyer.close();
  });

  it("retains the remaining asset reservation after a terminal partial FAK SELL and completes on retry", async () => {
    const env = setup();
    const buyer = liveExecutor(env.databasePath);
    await buyer.executeBuy({ accountId, signal: env.signal, context: env.context, riskDecisionId: "risk-live-buy" });
    buyer.close();
    const sell = insertSignalAndRisk(env.databasePath, env.targetId, {
      signalId: "live-sell-partial-retry",
      riskDecisionId: "risk-live-sell-partial-retry",
      decision: "ALLOW",
      signalType: "TARGET_SELL",
      requestedAmountMicros: null,
      requestedSizeMicros: "10000000",
    });
    const partial = liveExecutor(env.databasePath, { orderAdapter: new FakeOrderAdapter({ fillRatioPpm: 500_000 }) });
    const first = await partial.executeSell({
      accountId,
      signal: sell.signal,
      context: sell.context,
      riskDecisionId: "risk-live-sell-partial-retry",
    });
    expect(first.state).toBe("EXIT_PENDING");
    partial.close();
    const afterPartial = new DatabaseSync(env.databasePath, { readOnly: true });
    expect((afterPartial.prepare("SELECT remaining_after_micros FROM live_asset_reservation_ledger WHERE live_execution_id=? ORDER BY created_at DESC LIMIT 1").get(first.executionId) as { remaining_after_micros: string }).remaining_after_micros)
      .toBe("5000000");
    expect((afterPartial.prepare("SELECT is_terminal FROM live_orders WHERE live_execution_id=?").get(first.executionId) as { is_terminal: number }).is_terminal)
      .toBe(1);
    afterPartial.close();

    const retry = liveExecutor(env.databasePath);
    const second = await retry.executeSell({
      accountId,
      signal: sell.signal,
      context: sell.context,
      riskDecisionId: "risk-live-sell-partial-retry",
    });
    expect(second).toMatchObject({ executionId: first.executionId, state: "EXECUTED" });
    const completed = new DatabaseSync(env.databasePath, { readOnly: true });
    expect((completed.prepare("SELECT count(*) count FROM live_orders WHERE live_execution_id=?").get(first.executionId) as { count: number }).count)
      .toBe(2);
    expect((completed.prepare("SELECT remaining_after_micros FROM live_asset_reservation_ledger WHERE live_execution_id=? ORDER BY created_at DESC LIMIT 1").get(first.executionId) as { remaining_after_micros: string }).remaining_after_micros)
      .toBe("0");
    completed.close();
    retry.close();
  });

  it("triggers Live stop loss from full-position executable VWAP and exits through Risk, Gate, Ledger and Audit", async () => {
    const env = setup();
    const buyer = liveExecutor(env.databasePath);
    await buyer.executeBuy({ accountId, signal: env.signal, context: env.context, riskDecisionId: "risk-live-buy" });
    buyer.close();
    const stop = liveExecutor(env.databasePath, {
      marketDataProvider: new FakeLiveMarketDataProvider({
        now: () => new Date(now),
        bids: [{ price: "0.23", size: "1000" }],
      }),
    });
    const { executionIds: executions, healthy, blockers } = await stop.checkStopLosses(accountId);
    expect(healthy).toBe(true);
    expect(blockers).toEqual([]);
    expect(executions).toHaveLength(1);
    const stopExecutionId = executions[0]!;
    const db = new DatabaseSync(env.databasePath, { readOnly: true });
    const execution = db.prepare(
      "SELECT execution_type,state,target_price_units,risk_decision_id FROM live_executions WHERE live_execution_id=?",
    ).get(stopExecutionId) as { execution_type: string; state: string; target_price_units: string; risk_decision_id: string };
    expect(execution).toMatchObject({
      execution_type: "STOP_LOSS",
      state: "EXECUTED",
      target_price_units: "250000000000000000",
    });
    expect((db.prepare("SELECT risk_reason FROM risk_decisions WHERE risk_decision_id=?").get(execution.risk_decision_id) as { risk_reason: string }).risk_reason)
      .toBe("STOP_LOSS_TRIGGERED");
    expect((db.prepare("SELECT status,current_size_micros FROM live_positions").get() as { status: string; current_size_micros: string }))
      .toEqual({ status: "CLOSED", current_size_micros: "0" });
    expect((db.prepare("SELECT count(*) count FROM live_pnl_ledger WHERE live_execution_id=?").get(stopExecutionId) as { count: number }).count)
      .toBe(1);
    expect((db.prepare("SELECT count(*) count FROM audit_log WHERE entity_type='LIVE_POSITION' AND action='stop_loss_checked'").get() as { count: number }).count)
      .toBe(1);
    db.close();
    stop.close();
  });

  it("keeps a triggered stop loss in STOP_EXIT_PENDING when the 15% extreme-price floor has no liquidity", async () => {
    const env = setup();
    const buyer = liveExecutor(env.databasePath);
    await buyer.executeBuy({ accountId, signal: env.signal, context: env.context, riskDecisionId: "risk-live-buy" });
    buyer.close();
    const stop = liveExecutor(env.databasePath, {
      marketDataProvider: new FakeLiveMarketDataProvider({
        now: () => new Date(now),
        bids: [{ price: "0.2", size: "1000" }],
      }),
    });
    const { executionIds: executions, healthy, blockers } = await stop.checkStopLosses(accountId);
    expect(healthy).toBe(true);
    expect(blockers).toEqual([]);
    expect(executions).toHaveLength(1);
    const stopExecutionId = executions[0]!;
    const db = new DatabaseSync(env.databasePath, { readOnly: true });
    expect((db.prepare("SELECT state FROM live_executions WHERE live_execution_id=?").get(stopExecutionId) as { state: string }).state)
      .toBe("STOP_EXIT_PENDING");
    expect((db.prepare("SELECT reason,lower_price_units FROM live_market_checks WHERE live_execution_id=?").get(stopExecutionId) as { reason: string; lower_price_units: string }))
      .toEqual({ reason: "SELL_SLIPPAGE_OR_LIQUIDITY_WAIT", lower_price_units: "212500000000000000" });
    expect((db.prepare("SELECT count(*) count FROM live_orders WHERE live_execution_id=?").get(stopExecutionId) as { count: number }).count)
      .toBe(0);
    db.close();
    stop.close();
  });

  it("executes an existing Position's stop loss with its immutable historical ruleset after a rules upgrade", async () => {
    const env = setup({
      historicalStopRules: { triggerRatioPpm: 600_000, maxSlippagePpm: 200_000 },
    });
    const buyer = liveExecutor(env.databasePath);
    await buyer.executeBuy({
      accountId,
      signal: env.signal,
      context: env.context,
      riskDecisionId: "risk-live-buy",
    });
    buyer.close();
    const stop = liveExecutor(env.databasePath, {
      marketDataProvider: new FakeLiveMarketDataProvider({
        now: () => new Date(now),
        bids: [{ price: "0.29", size: "1000" }],
      }),
    });

    const { executionIds: executions, healthy, blockers } = await stop.checkStopLosses(accountId);
    expect(healthy).toBe(true);
    expect(blockers).toEqual([]);

    expect(executions).toHaveLength(1);
    const db = new DatabaseSync(env.databasePath, { readOnly: true });
    const execution = db.prepare(
      `SELECT e.state,e.target_price_units,e.ruleset_hash,r.ruleset_hash risk_ruleset,
              r.config_version risk_config
       FROM live_executions e
       JOIN risk_decisions r ON r.risk_decision_id=e.risk_decision_id
       WHERE e.live_execution_id=?`,
    ).get(executions[0]!) as Record<string, string>;
    expect(execution).toMatchObject({
      state: "EXECUTED",
      target_price_units: "300000000000000000",
      ruleset_hash: env.ruleset!.hash,
      risk_ruleset: env.ruleset!.hash,
      risk_config: env.ruleset!.configVersion,
    });
    const marketCheck = db.prepare(
      "SELECT lower_price_units,ruleset_hash,config_version FROM live_market_checks WHERE live_execution_id=?",
    ).get(executions[0]!) as Record<string, string>;
    expect(marketCheck).toEqual({
      lower_price_units: "240000000000000000",
      ruleset_hash: env.ruleset!.hash,
      config_version: env.ruleset!.configVersion,
    });
    const audit = db.prepare(
      `SELECT ruleset_hash,config_version FROM audit_log
       WHERE entity_type='LIVE_POSITION' AND action='stop_loss_checked'
       ORDER BY timestamp DESC LIMIT 1`,
    ).get() as Record<string, string>;
    expect(audit).toEqual({
      ruleset_hash: env.ruleset!.hash,
      config_version: env.ruleset!.configVersion,
    });
    db.close();
    stop.close();
  });

  it("rejects Risk Decision REJECT through the real Live Gate", async () => {
    const env = setup();
    const rejected = insertSignalAndRisk(env.databasePath, env.targetId, { signalId: "live-reject", riskDecisionId: "risk-live-reject", decision: "REJECT" });
    const db = new DatabaseSync(env.databasePath);
    db.prepare("UPDATE live_gate_state SET execution_mode='LIVE',live_gate_state='LIVE_ACTIVE',requested_execution_mode='LIVE' WHERE state_id='default'").run();
    db.close();
    const gate = new LiveGateService(
      env.databasePath,
      new MockBalanceProvider({ status: "AVAILABLE", balanceMicros: "1000000000", reason: null }),
      { ...defaultLiveGateConfig(), runtimeEnvironment: "TEST" },
      {
        sourceVersion,
        now: () => new Date(now),
        geoblockProvider: new FakeGeoblockProvider({
          status: "ALLOWED",
          checkedAt: now,
          source: "TEST_FIXTURE",
          reason: null,
        }),
        clockProvider: new FakeClockSafetyProvider({
          status: "SAFE",
          offsetMs: 0,
          checkedAt: now,
          source: "TEST_FIXTURE",
          reason: null,
        }),
      },
    );
    const executor = liveExecutor(env.databasePath, { liveGate: gate });
    const result = await executor.executeBuy({ accountId, signal: rejected.signal, context: rejected.context, riskDecisionId: "risk-live-reject" });
    expect(result.state).toBe("REJECTED");
    executor.close();
    gate.close();
  });

  it("consumes only Signal + immutable Execution Context and deterministically derives Live BUY capital and SELL ratio", async () => {
    const env = setup({ capitalRatioPpm: "100000" });
    const executor = liveExecutor(env.databasePath);
    const consumer = new LiveSignalConsumer(env.databasePath, executor, sourceVersion, () => new Date(now));
    const buys = await consumer.consumeAvailableSignals(accountId);
    expect(buys).toHaveLength(1);
    expect(buys[0]).toMatchObject({ signalId: env.signal.signalId, state: "EXECUTED" });
    expect(await consumer.consumeAvailableSignals(accountId)).toEqual([]);
    const buyCheck = new DatabaseSync(env.databasePath, { readOnly: true });
    const buy = buyCheck.prepare(
      `SELECT e.requested_amount_micros execution_amount,r.requested_amount_micros risk_amount
       FROM live_executions e JOIN risk_decisions r ON r.risk_decision_id=e.risk_decision_id
       WHERE e.live_execution_id=?`,
    ).get(buys[0]!.executionId) as Record<string, string>;
    expect(buy).toEqual({ execution_amount: "100000000", risk_amount: "100000000" });
    buyCheck.close();

    const sell = insertSignalAndRisk(env.databasePath, env.targetId, {
      signalId: "live-consumer-half-sell",
      riskDecisionId: "unused-prebuilt-sell-risk",
      decision: "ALLOW",
      signalType: "TARGET_SELL",
      sellRatioNumerator: "1",
      sellRatioDenominator: "2",
      requestedAmountMicros: null,
      requestedSizeMicros: "1",
    });
    const sells = await consumer.consumeAvailableSignals(accountId);
    expect(sells).toHaveLength(1);
    expect(sells[0]).toMatchObject({ signalId: sell.signal.signalId, state: "EXECUTED" });
    const db = new DatabaseSync(env.databasePath, { readOnly: true });
    const sellExecution = db.prepare(
      "SELECT requested_size_micros FROM live_executions WHERE live_execution_id=?",
    ).get(sells[0]!.executionId) as { requested_size_micros: string };
    expect(sellExecution.requested_size_micros).toBe("100000000");
    expect((db.prepare("SELECT count(*) count FROM live_signal_consumptions").get() as { count: number }).count)
      .toBe(2);
    const checkpoint = db.prepare(
      "SELECT last_signal_id FROM live_consumer_checkpoints WHERE live_account_id=?",
    ).get(accountId) as { last_signal_id: string };
    expect(checkpoint.last_signal_id).toBe(sell.signal.signalId);
    db.close();
    consumer.close();
    executor.close();
  });

  it("sizes a later proportional Live BUY from complete total equity while keeping available cash as the payment cap", async () => {
    const env = setup({ capitalRatioPpm: "100000" });
    const openingExecutor = liveExecutor(env.databasePath);
    const openingConsumer = new LiveSignalConsumer(
      env.databasePath,
      openingExecutor,
      sourceVersion,
      () => new Date(now),
    );
    expect((await openingConsumer.consumeAvailableSignals(accountId))[0]).toMatchObject({ state: "EXECUTED" });
    openingConsumer.close();
    openingExecutor.close();

    const later = insertSignalAndRisk(env.databasePath, env.targetId, {
      signalId: "live-proportional-buy-from-total-equity",
      riskDecisionId: "unused-live-total-equity-risk",
      decision: "ALLOW",
      capitalRatioPpm: "50000",
    });
    const executor = liveExecutor(env.databasePath, {
      walletProvider: new FakeWalletProvider({ balanceMicros: "900000000" }),
      marketDataProvider: new FakeLiveMarketDataProvider({
        now: () => new Date(now),
        bids: [{ price: "0.75", size: "1000" }],
        asks: [{ price: "0.5", size: "1000" }],
      }),
    });
    const consumer = new LiveSignalConsumer(env.databasePath, executor, sourceVersion, () => new Date(now));

    const [result] = await consumer.consumeAvailableSignals(accountId);

    expect(result).toMatchObject({ signalId: later.signal.signalId, state: "EXECUTED" });
    const db = new DatabaseSync(env.databasePath, { readOnly: true });
    expect(db.prepare(
      `SELECT requested_amount_micros FROM live_executions WHERE signal_id=?`,
    ).get(later.signal.signalId)).toEqual({ requested_amount_micros: "52500000" });
    const sizing = db.prepare(
      `SELECT capital_sizing_decision_json FROM risk_decisions WHERE risk_decision_id=?`,
    ).get(result!.riskDecisionId!) as { capital_sizing_decision_json: string };
    expect(JSON.parse(sizing.capital_sizing_decision_json)).toMatchObject({
      accountCapitalMicros: "1050000000",
      calculatedAmountMicros: "52500000",
    });
    db.close();
    consumer.close();
    executor.close();
  });

  it("derives the configurable 1 pUSD first-entry minimum before Live risk and reservation", async () => {
    const env = setup({ capitalRatioPpm: "1" });
    const executor = liveExecutor(env.databasePath);
    const consumer = new LiveSignalConsumer(env.databasePath, executor, sourceVersion, () => new Date(now));
    const [result] = await consumer.consumeAvailableSignals(accountId);
    expect(result).toMatchObject({ state: "EXECUTED" });
    const db = new DatabaseSync(env.databasePath, { readOnly: true });
    expect(db.prepare(
      `SELECT e.requested_amount_micros execution_amount,r.requested_amount_micros risk_amount
       FROM live_executions e JOIN risk_decisions r ON r.risk_decision_id=e.risk_decision_id
       WHERE e.live_execution_id=?`,
    ).get(result!.executionId)).toEqual({ execution_amount: "1000000", risk_amount: "1000000" });
    const checks = JSON.parse((db.prepare(
      `SELECT checks_json FROM risk_decisions WHERE risk_decision_id=?`,
    ).get(result!.riskDecisionId) as { checks_json: string }).checks_json) as Array<{ name: string; detail?: string }>;
    expect(checks.find((check) => check.name === "buy_amount_policy")?.detail).toContain("SMALL_BUY_MINIMUM_APPLIED");
    db.close();
    consumer.close();
    executor.close();
  });

  it("applies the same market-minimum auto-lift in Live before signing a first-entry BUY", async () => {
    const env = setup({ capitalRatioPpm: "1" });
    const signer = new RecordingFakeSigner();
    const executor = liveExecutor(env.databasePath, {
      signer,
      marketDataProvider: new FakeLiveMarketDataProvider({
        now: () => new Date(now),
        minOrderSize: "5",
        tickSize: "0.01",
      }),
    });
    const consumer = new LiveSignalConsumer(env.databasePath, executor, sourceVersion, () => new Date(now));

    const [result] = await consumer.consumeAvailableSignals(accountId);

    expect(result).toMatchObject({ state: "EXECUTED" });
    const positions = await executor.getPosition({ accountId, assetId }) as Array<{
      current_size_micros: string;
      remaining_cost_micros: string;
    }>;
    expect(positions).toHaveLength(1);
    expect(positions[0]).toMatchObject({
      current_size_micros: "5000000",
      remaining_cost_micros: "2500000",
    });
    expect(await executor.getBalance({ accountId })).toMatchObject({
      reservedBalanceMicros: "0",
    });
    expect(signer.payloads).toHaveLength(1);
    expect(signer.payloads[0]).toMatchObject({
      riskDecisionId: result!.riskDecisionId,
      budgetMicros: "2500000",
    });
    const db = new DatabaseSync(env.databasePath, { readOnly: true });
    expect(db.prepare(
      `SELECT e.requested_amount_micros execution_amount,r.requested_amount_micros risk_amount,
              c.risk_decision_id consumption_risk,o.budget_micros order_budget
       FROM live_executions e
       JOIN risk_decisions r ON r.risk_decision_id=e.risk_decision_id
       JOIN live_signal_consumptions c ON c.live_execution_id=e.live_execution_id
       JOIN live_orders o ON o.live_execution_id=e.live_execution_id
       WHERE e.live_execution_id=?`,
    ).get(result!.executionId)).toEqual({
      execution_amount: "2500000",
      risk_amount: "2500000",
      consumption_risk: result!.riskDecisionId,
      order_budget: "2500000",
    });
    const reservationTotal = db.prepare(
      `SELECT COALESCE(SUM(CAST(delta_micros AS INTEGER)),0) total
       FROM live_reservation_ledger WHERE live_execution_id=?`,
    ).get(result!.executionId) as { total: number };
    expect(BigInt(reservationTotal.total)).toBe(0n);
    db.close();
    consumer.close();
    executor.close();
  });

  it("rechecks the Live Gate for the final lifted Risk Decision before signing", async () => {
    const env = setup({ capitalRatioPpm: "1" });
    let signed = 0;
    const executor = liveExecutor(env.databasePath, {
      liveGate: new FlippingGate(),
      signer: new MutatingFakeSigner((payload) => {
        signed += 1;
        return {
          orderAmountMicros: String(payload.amountMicros),
          orderSizeMicros: String(payload.sizeMicros),
        };
      }),
      marketDataProvider: new FakeLiveMarketDataProvider({
        now: () => new Date(now),
        minOrderSize: "5",
        tickSize: "0.01",
      }),
    });
    const consumer = new LiveSignalConsumer(env.databasePath, executor, sourceVersion, () => new Date(now));

    const [result] = await consumer.consumeAvailableSignals(accountId);

    expect(result).toMatchObject({ state: "REJECTED" });
    expect(signed).toBe(0);
    expect(await executor.getPosition({ accountId, assetId })).toEqual([]);
    expect(await executor.getBalance({ accountId })).toMatchObject({ reservedBalanceMicros: "0" });
    consumer.close();
    executor.close();
  });

  it("rejects a Live first entry when the market minimum is above the configured 5 pUSD cap", async () => {
    const env = setup({ capitalRatioPpm: "1" });
    const signer = new RecordingFakeSigner();
    const executor = liveExecutor(env.databasePath, {
      signer,
      marketDataProvider: new FakeLiveMarketDataProvider({
        now: () => new Date(now),
        minOrderSize: "11",
        tickSize: "0.01",
      }),
    });
    const consumer = new LiveSignalConsumer(env.databasePath, executor, sourceVersion, () => new Date(now));

    const [result] = await consumer.consumeAvailableSignals(accountId);

    expect(result).toMatchObject({ state: "REJECTED" });
    expect(signer.payloads).toHaveLength(0);
    expect(await executor.getPosition({ accountId, assetId })).toEqual([]);
    expect(await executor.getBalance({ accountId })).toMatchObject({ reservedBalanceMicros: "0" });
    const db = new DatabaseSync(env.databasePath, { readOnly: true });
    expect(db.prepare("SELECT reason,requested_amount_micros FROM live_executions WHERE live_execution_id=?")
      .get(result!.executionId)).toEqual({
      reason: "BUY_MARKET_MINIMUM_ABOVE_AUTO_LIFT_CAP",
      requested_amount_micros: "1000000",
    });
    db.close();
    consumer.close();
    executor.close();
  });

  it("rechecks the external wallet allowance against the final Live lifted amount", async () => {
    const env = setup({ capitalRatioPpm: "1" });
    const signer = new RecordingFakeSigner();
    const executor = liveExecutor(env.databasePath, {
      signer,
      walletProvider: new FakeWalletProvider({ allowanceMicros: "2000000" }),
      marketDataProvider: new FakeLiveMarketDataProvider({
        now: () => new Date(now),
        minOrderSize: "5",
        tickSize: "0.01",
      }),
    });
    const consumer = new LiveSignalConsumer(env.databasePath, executor, sourceVersion, () => new Date(now));

    const [result] = await consumer.consumeAvailableSignals(accountId);

    expect(result).toMatchObject({ state: "REJECTED" });
    expect(signer.payloads).toHaveLength(0);
    expect(await executor.getPosition({ accountId, assetId })).toEqual([]);
    expect(await executor.getBalance({ accountId })).toMatchObject({ reservedBalanceMicros: "0" });
    const db = new DatabaseSync(env.databasePath, { readOnly: true });
    expect(db.prepare(
      `SELECT e.reason,e.requested_amount_micros,r.requested_amount_micros risk_amount
       FROM live_executions e JOIN risk_decisions r ON r.risk_decision_id=e.risk_decision_id
       WHERE e.live_execution_id=?`,
    ).get(result!.executionId)).toEqual({
      reason: "ALLOWANCE_INSUFFICIENT",
      requested_amount_micros: "2500000",
      risk_amount: "2500000",
    });
    db.close();
    consumer.close();
    executor.close();
  });

  it("rejects and releases the original reservation when final Live re-risk disallows the lift", async () => {
    const env = setup({ capitalRatioPpm: "1" });
    const writer = new DatabaseSync(env.databasePath);
    writer.prepare("UPDATE live_accounts SET risk_budget_micros='2000000' WHERE live_account_id=?")
      .run(accountId);
    writer.close();
    const signer = new RecordingFakeSigner();
    const executor = liveExecutor(env.databasePath, {
      signer,
      marketDataProvider: new FakeLiveMarketDataProvider({
        now: () => new Date(now),
        minOrderSize: "5",
        tickSize: "0.01",
      }),
    });
    const consumer = new LiveSignalConsumer(env.databasePath, executor, sourceVersion, () => new Date(now));

    const [result] = await consumer.consumeAvailableSignals(accountId);

    expect(result).toMatchObject({ state: "REJECTED" });
    expect(signer.payloads).toHaveLength(0);
    expect(await executor.getBalance({ accountId })).toMatchObject({ reservedBalanceMicros: "0" });
    const db = new DatabaseSync(env.databasePath, { readOnly: true });
    expect(db.prepare(
      `SELECT e.reason,e.requested_amount_micros,r.requested_amount_micros risk_amount,
              r.decision,c.risk_decision_id consumption_risk
       FROM live_executions e
       JOIN risk_decisions r ON r.risk_decision_id=e.risk_decision_id
       JOIN live_signal_consumptions c ON c.live_execution_id=e.live_execution_id
       WHERE e.live_execution_id=?`,
    ).get(result!.executionId)).toEqual({
      reason: "LIVE_SINGLE_TRADE_LIMIT_EXCEEDED",
      requested_amount_micros: "2500000",
      risk_amount: "2500000",
      decision: "REJECT",
      consumption_risk: result!.riskDecisionId,
    });
    db.close();
    consumer.close();
    executor.close();
  });

  it("applies the small-BUY minimum after a proportional opening Live BUY", async () => {
    const env = setup({ capitalRatioPpm: "100000" });
    const executor = liveExecutor(env.databasePath, {
      marketDataProvider: new FakeLiveMarketDataProvider({
        now: () => new Date(now),
        minOrderSize: "5",
        tickSize: "0.01",
      }),
    });
    const consumer = new LiveSignalConsumer(env.databasePath, executor, sourceVersion, () => new Date(now));
    expect((await consumer.consumeAvailableSignals(accountId))[0]).toMatchObject({ state: "EXECUTED" });
    const later = insertSignalAndRisk(env.databasePath, env.targetId, {
      signalId: "live-existing-position-tiny-buy",
      riskDecisionId: "unused-live-existing-position-risk",
      decision: "ALLOW",
      capitalRatioPpm: "1",
      createdAt: "2026-07-09T00:00:01.000Z",
    });

    const [result] = await consumer.consumeAvailableSignals(accountId);

    expect(result).toMatchObject({ signalId: later.signal.signalId, state: "EXECUTED" });
    const positions = await executor.getPosition({ accountId, assetId }) as unknown[];
    expect(positions).toHaveLength(2);
    consumer.close();
    executor.close();
  });

  it("applies the 1-to-5 pUSD policy to every small Live follow BUY", async () => {
    const env = setup({ capitalRatioPpm: "1" });
    const executor = liveExecutor(env.databasePath, {
      marketDataProvider: new FakeLiveMarketDataProvider({
        now: () => new Date(now),
        minOrderSize: "5",
        tickSize: "0.01",
      }),
    });
    const consumer = new LiveSignalConsumer(env.databasePath, executor, sourceVersion, () => new Date(now));
    expect((await consumer.consumeAvailableSignals(accountId))[0]).toMatchObject({ state: "EXECUTED" });
    const later = insertSignalAndRisk(env.databasePath, env.targetId, {
      signalId: "live-amplified-lineage-follow-up",
      riskDecisionId: "unused-live-amplified-lineage-risk",
      decision: "ALLOW",
      capitalRatioPpm: "1",
      createdAt: "2026-07-09T00:00:01.000Z",
    });

    const [result] = await consumer.consumeAvailableSignals(accountId);

    expect(result).toMatchObject({ signalId: later.signal.signalId, state: "EXECUTED" });
    const db = new DatabaseSync(env.databasePath, { readOnly: true });
    expect(db.prepare(
      "SELECT requested_amount_micros FROM live_executions WHERE live_execution_id=?",
    ).get(result!.executionId)).toEqual({ requested_amount_micros: "2500000" });
    const checks = JSON.parse((db.prepare(
      "SELECT checks_json FROM risk_decisions WHERE risk_decision_id=?",
    ).get(result!.riskDecisionId) as { checks_json: string }).checks_json) as Array<{ name: string; detail?: string }>;
    const policy = JSON.parse(checks.find((check) => check.name === "buy_amount_policy")!.detail!);
    expect(policy).toMatchObject({
      result: "LIFTED",
      policyClass: "SMALL_BUY",
      finalAmountMicros: "2500000",
    });
    expect(await executor.getPosition({ accountId, assetId })).toHaveLength(2);
    db.close();
    consumer.close();
    executor.close();
  });

  it("allows nine small Live follow BUY fills and rejects the tenth", async () => {
    const env = setup({ capitalRatioPpm: "1" });
    const executor = liveExecutor(env.databasePath, {
      marketDataProvider: new FakeLiveMarketDataProvider({
        now: () => new Date(now),
        minOrderSize: "1",
        tickSize: "0.01",
      }),
    });
    const consumer = new LiveSignalConsumer(env.databasePath, executor, sourceVersion, () => new Date(now));
    expect((await consumer.consumeAvailableSignals(accountId))[0]).toMatchObject({ state: "EXECUTED" });

    for (let index = 1; index <= 10; index += 1) {
      const inserted = insertSignalAndRisk(env.databasePath, env.targetId, {
        signalId: `live-small-follow-limit-${index}`,
        riskDecisionId: `unused-live-small-follow-limit-${index}`,
        decision: "ALLOW",
        capitalRatioPpm: "1",
        createdAt: `2026-07-09T00:00:${String(index).padStart(2, "0")}.000Z`,
      });
      const [result] = await consumer.consumeAvailableSignals(accountId);
      expect(result).toMatchObject({
        signalId: inserted.signal.signalId,
        state: index <= 9 ? "EXECUTED" : "REJECTED",
      });
      if (index === 10) {
        const database = new DatabaseSync(env.databasePath, { readOnly: true });
        expect(database.prepare(
          "SELECT reason FROM live_executions WHERE live_execution_id=?",
        ).get(result!.executionId)).toEqual({ reason: "SMALL_FOLLOW_BUY_LIMIT_REACHED" });
        database.close();
      }
    }

    const positions = await executor.getPosition({ accountId, assetId }) as unknown[];
    expect(positions).toHaveLength(10);
    consumer.close();
    executor.close();
  });

  it("keeps a second small Live BUY independent while the first remains pending", async () => {
    const env = setup({ capitalRatioPpm: "1" });
    const executor = liveExecutor(env.databasePath, {
      marketDataProvider: new FakeLiveMarketDataProvider({
        now: () => new Date(now),
        asks: [],
        minOrderSize: "5",
        tickSize: "0.01",
      }),
    });
    const consumer = new LiveSignalConsumer(env.databasePath, executor, sourceVersion, () => new Date(now));
    expect((await consumer.consumeAvailableSignals(accountId))[0]).toMatchObject({ state: "WAITING_EXECUTION" });
    const second = insertSignalAndRisk(env.databasePath, env.targetId, {
      signalId: "live-pending-second-entry",
      riskDecisionId: "unused-live-pending-second-risk",
      decision: "ALLOW",
      capitalRatioPpm: "1",
      createdAt: "2026-07-09T00:00:01.000Z",
    });

    const [result] = await consumer.consumeAvailableSignals(accountId);

    expect(result).toMatchObject({ signalId: second.signal.signalId, state: "WAITING_EXECUTION" });
    expect(await executor.getPosition({ accountId, assetId })).toEqual([]);
    expect(await executor.getBalance({ accountId })).toMatchObject({
      reservedBalanceMicros: "2000000",
    });
    consumer.close();
    executor.close();
  });

  it("restores Live first-entry auto-lift eligibility after a 95% close", async () => {
    const env = setup({ capitalRatioPpm: "100000" });
    const executor = liveExecutor(env.databasePath, {
      marketDataProvider: new FakeLiveMarketDataProvider({
        now: () => new Date(now),
        minOrderSize: "5",
        tickSize: "0.01",
      }),
    });
    const consumer = new LiveSignalConsumer(env.databasePath, executor, sourceVersion, () => new Date(now));
    expect((await consumer.consumeAvailableSignals(accountId))[0]).toMatchObject({ state: "EXECUTED" });
    const close = insertSignalAndRisk(env.databasePath, env.targetId, {
      signalId: "live-close-before-reopen",
      riskDecisionId: "unused-live-close-risk",
      decision: "ALLOW",
      signalType: "TARGET_SELL",
      sellRatioNumerator: "95",
      sellRatioDenominator: "100",
      createdAt: "2026-07-09T00:00:01.000Z",
    });
    expect((await consumer.consumeAvailableSignals(accountId))[0])
      .toMatchObject({ signalId: close.signal.signalId, state: "EXECUTED" });
    const reopen = insertSignalAndRisk(env.databasePath, env.targetId, {
      signalId: "live-reopen-tiny-buy",
      riskDecisionId: "unused-live-reopen-risk",
      decision: "ALLOW",
      capitalRatioPpm: "1",
      createdAt: "2026-07-09T00:00:02.000Z",
    });

    const [result] = await consumer.consumeAvailableSignals(accountId);

    expect(result).toMatchObject({ signalId: reopen.signal.signalId, state: "EXECUTED" });
    const positions = await executor.getPosition({ accountId, assetId }) as Array<{
      remaining_cost_micros: string;
    }>;
    expect(positions).toHaveLength(1);
    expect(positions[0]).toMatchObject({ remaining_cost_micros: "2500000" });
    consumer.close();
    executor.close();
  });

  it("keeps a 95% MERGE-equivalent TARGET_SELL proportional in Live", async () => {
    const env = setup({ capitalRatioPpm: "100000" });
    const executor = liveExecutor(env.databasePath, {
      marketDataProvider: new FakeLiveMarketDataProvider({
        now: () => new Date(now),
        minOrderSize: "5",
        tickSize: "0.01",
      }),
    });
    const consumer = new LiveSignalConsumer(env.databasePath, executor, sourceVersion, () => new Date(now));
    expect((await consumer.consumeAvailableSignals(accountId))[0]).toMatchObject({ state: "EXECUTED" });
    const mergeExit = insertSignalAndRisk(env.databasePath, env.targetId, {
      signalId: "live-merge-equivalent-sell-95-percent",
      riskDecisionId: "unused-live-merge-equivalent-sell-risk",
      decision: "ALLOW",
      signalType: "TARGET_SELL",
      eventClassification: "COMBO_ACTIVITY",
      sellRatioNumerator: "95",
      sellRatioDenominator: "100",
      createdAt: "2026-07-09T00:00:01.000Z",
    });

    const [result] = await consumer.consumeAvailableSignals(accountId);

    expect(result).toMatchObject({ signalId: mergeExit.signal.signalId, state: "EXECUTED" });
    const db = new DatabaseSync(env.databasePath, { readOnly: true });
    expect(db.prepare(
      "SELECT requested_size_micros,filled_size_micros FROM live_executions WHERE live_execution_id=?",
    ).get(result!.executionId!)).toEqual({
      requested_size_micros: "190000000",
      filled_size_micros: "190000000",
    });
    expect(db.prepare(
      "SELECT current_size_micros,status FROM live_positions WHERE live_account_id=?",
    ).get(accountId)).toEqual({ current_size_micros: "10000000", status: "PARTIALLY_CLOSED" });
    db.close();
    consumer.close();
    executor.close();
  });

  it("cancels a waiting Live BUY before applying a 95% target exit", async () => {
    const env = setup({ capitalRatioPpm: "1" });
    const executor = liveExecutor(env.databasePath, {
      marketDataProvider: new FakeLiveMarketDataProvider({
        now: () => new Date(now),
        asks: [],
      }),
    });
    const consumer = new LiveSignalConsumer(env.databasePath, executor, sourceVersion, () => new Date(now));

    const [waitingBuy] = await consumer.consumeAvailableSignals(accountId);
    expect(waitingBuy).toMatchObject({ signalId: env.signal.signalId, state: "WAITING_EXECUTION" });
    const exit = insertSignalAndRisk(env.databasePath, env.targetId, {
      signalId: "live-full-exit-cancels-waiting-buy",
      riskDecisionId: "unused-live-full-exit-risk",
      decision: "ALLOW",
      signalType: "TARGET_SELL",
      sellRatioNumerator: "95",
      sellRatioDenominator: "100",
      requestedAmountMicros: null,
      requestedSizeMicros: null,
      createdAt: "2026-07-09T00:00:01.000Z",
    });

    const [result] = await consumer.consumeAvailableSignals(accountId);

    expect(result).toMatchObject({ signalId: exit.signal.signalId, state: "EXECUTED" });
    const db = new DatabaseSync(env.databasePath, { readOnly: true });
    expect(db.prepare(
      "SELECT state,requested_amount_micros,reason FROM live_executions WHERE live_execution_id=?",
    ).get(waitingBuy!.executionId!)).toEqual({
      state: "CANCELLED",
      requested_amount_micros: "0",
      reason: "TARGET_SELL_SUPERSEDED_WAITING_BUY",
    });
    expect(db.prepare(
      "SELECT state,requested_size_micros,reason FROM live_executions WHERE live_execution_id=?",
    ).get(result!.executionId!)).toEqual({
      state: "EXECUTED",
      requested_size_micros: null,
      reason: "TARGET_EXIT_APPLIED_TO_WAITING_BUY",
    });
    expect(db.prepare(
      "SELECT COALESCE(SUM(CAST(delta_micros AS INTEGER)),0) remaining FROM live_reservation_ledger WHERE live_execution_id=?",
    ).get(waitingBuy!.executionId!)).toEqual({ remaining: 0 });
    expect(db.prepare(
      "SELECT COALESCE(SUM(CAST(reserved_delta_micros AS INTEGER)),0) remaining FROM live_cash_ledger WHERE live_execution_id=?",
    ).get(waitingBuy!.executionId!)).toEqual({ remaining: 0 });
    expect((db.prepare("SELECT COUNT(*) count FROM live_orders").get() as { count: number }).count).toBe(0);
    db.close();
    consumer.close();
    executor.close();
  });

  it("reduces rather than cancels a waiting Live BUY for a 95% MERGE-equivalent exit", async () => {
    const env = setup({ capitalRatioPpm: "1" });
    const executor = liveExecutor(env.databasePath, {
      marketDataProvider: new FakeLiveMarketDataProvider({
        now: () => new Date(now),
        asks: [],
      }),
    });
    const consumer = new LiveSignalConsumer(env.databasePath, executor, sourceVersion, () => new Date(now));
    const [waitingBuy] = await consumer.consumeAvailableSignals(accountId);
    expect(waitingBuy).toMatchObject({ state: "WAITING_EXECUTION" });
    const mergeExit = insertSignalAndRisk(env.databasePath, env.targetId, {
      signalId: "live-merge-exit-reduces-waiting-buy",
      riskDecisionId: "unused-live-merge-exit-waiting-risk",
      decision: "ALLOW",
      signalType: "TARGET_SELL",
      eventClassification: "COMBO_ACTIVITY",
      sellRatioNumerator: "95",
      sellRatioDenominator: "100",
      requestedAmountMicros: null,
      requestedSizeMicros: null,
      createdAt: "2026-07-09T00:00:01.000Z",
    });

    const [result] = await consumer.consumeAvailableSignals(accountId);

    expect(result).toMatchObject({ signalId: mergeExit.signal.signalId, state: "EXECUTED" });
    const db = new DatabaseSync(env.databasePath, { readOnly: true });
    expect(db.prepare(
      "SELECT state,requested_amount_micros,reason FROM live_executions WHERE live_execution_id=?",
    ).get(waitingBuy!.executionId!)).toEqual({
      state: "WAITING_EXECUTION",
      requested_amount_micros: "50000",
      reason: "TARGET_SELL_REDUCED_WAITING_BUY",
    });
    expect(db.prepare(
      "SELECT COALESCE(SUM(CAST(delta_micros AS INTEGER)),0) remaining FROM live_reservation_ledger WHERE live_execution_id=?",
    ).get(waitingBuy!.executionId!)).toEqual({ remaining: 50000 });
    expect(db.prepare(
      "SELECT state,requested_size_micros,reason FROM live_executions WHERE live_execution_id=?",
    ).get(result!.executionId!)).toEqual({
      state: "EXECUTED",
      requested_size_micros: null,
      reason: "TARGET_EXIT_APPLIED_TO_WAITING_BUY",
    });
    db.close();
    consumer.close();
    executor.close();
  });

  it("rolls back a waiting Live BUY adjustment when the matching target exit cannot be recorded", async () => {
    const env = setup({ capitalRatioPpm: "1" });
    const executor = liveExecutor(env.databasePath, {
      marketDataProvider: new FakeLiveMarketDataProvider({
        now: () => new Date(now),
        asks: [],
      }),
    });
    const consumer = new LiveSignalConsumer(env.databasePath, executor, sourceVersion, () => new Date(now));
    const [waitingBuy] = await consumer.consumeAvailableSignals(accountId);
    expect(waitingBuy).toMatchObject({ state: "WAITING_EXECUTION" });
    const exit = insertSignalAndRisk(env.databasePath, env.targetId, {
      signalId: "live-target-exit-recording-failure",
      riskDecisionId: "unused-live-target-exit-recording-failure-risk",
      decision: "ALLOW",
      signalType: "TARGET_SELL",
      sellRatioNumerator: "1",
      sellRatioDenominator: "1",
      requestedAmountMicros: null,
      requestedSizeMicros: null,
      createdAt: "2026-07-09T00:00:01.000Z",
    });
    const fault = new DatabaseSync(env.databasePath);
    fault.exec(`CREATE TRIGGER fail_target_exit_recording
      BEFORE INSERT ON live_executions
      WHEN NEW.signal_id='${exit.signal.signalId}'
      BEGIN SELECT RAISE(ABORT, 'TARGET_EXIT_RECORDING_FAULT'); END;`);
    fault.close();

    await expect(consumer.consumeAvailableSignals(accountId)).rejects.toThrow("TARGET_EXIT_RECORDING_FAULT");

    const db = new DatabaseSync(env.databasePath, { readOnly: true });
    expect(db.prepare(
      "SELECT state,requested_amount_micros,reason FROM live_executions WHERE live_execution_id=?",
    ).get(waitingBuy!.executionId!)).toEqual({
      state: "WAITING_EXECUTION",
      requested_amount_micros: "1000000",
      reason: "LIVE_BUY_WAITING_MARKET",
    });
    expect(db.prepare(
      "SELECT COUNT(*) count FROM live_reservation_ledger WHERE live_execution_id=? AND entry_type='RELEASE'",
    ).get(waitingBuy!.executionId!)).toEqual({ count: 0 });
    expect(db.prepare(
      "SELECT COUNT(*) count FROM live_executions WHERE signal_id=?",
    ).get(exit.signal.signalId)).toEqual({ count: 0 });
    db.close();
    consumer.close();
    executor.close();
  });

  it("disables the Live Gate before a target exit can touch a corrupt waiting BUY reservation", async () => {
    const env = setup({ capitalRatioPpm: "1" });
    const executor = liveExecutor(env.databasePath, {
      marketDataProvider: new FakeLiveMarketDataProvider({
        now: () => new Date(now),
        asks: [],
      }),
    });
    const consumer = new LiveSignalConsumer(env.databasePath, executor, sourceVersion, () => new Date(now));
    const [waitingBuy] = await consumer.consumeAvailableSignals(accountId);
    expect(waitingBuy).toMatchObject({ state: "WAITING_EXECUTION" });
    const corrupt = new DatabaseSync(env.databasePath);
    corrupt.prepare(
      "UPDATE live_executions SET requested_amount_micros='999999' WHERE live_execution_id=?",
    ).run(waitingBuy!.executionId!);
    corrupt.close();
    const exit = insertSignalAndRisk(env.databasePath, env.targetId, {
      signalId: "live-target-exit-corrupt-waiting-reservation",
      riskDecisionId: "unused-live-target-exit-corrupt-waiting-reservation-risk",
      decision: "ALLOW",
      signalType: "TARGET_SELL",
      sellRatioNumerator: "1",
      sellRatioDenominator: "1",
      requestedAmountMicros: null,
      requestedSizeMicros: null,
      createdAt: "2026-07-09T00:00:01.000Z",
    });

    await expect(consumer.consumeAvailableSignals(accountId))
      .rejects.toThrow("LIVE_WAITING_BUY_RESERVATION_MISMATCH");

    const db = new DatabaseSync(env.databasePath, { readOnly: true });
    expect(db.prepare(
      "SELECT state,requested_amount_micros FROM live_executions WHERE live_execution_id=?",
    ).get(waitingBuy!.executionId!)).toEqual({
      state: "WAITING_EXECUTION",
      requested_amount_micros: "999999",
    });
    expect(db.prepare(
      "SELECT COUNT(*) count FROM live_reservation_ledger WHERE live_execution_id=? AND entry_type='RELEASE'",
    ).get(waitingBuy!.executionId!)).toEqual({ count: 0 });
    expect(db.prepare(
      "SELECT COUNT(*) count FROM live_executions WHERE signal_id=?",
    ).get(exit.signal.signalId)).toEqual({ count: 0 });
    expect(db.prepare(
      "SELECT execution_mode,live_gate_state,state_reason FROM live_gate_state WHERE state_id='default'",
    ).get()).toEqual({
      execution_mode: "PAPER",
      live_gate_state: "LIVE_DISABLED",
      state_reason: "LIVE_WAITING_BUY_TARGET_EXIT_ADJUSTMENT_FAILED:LIVE_WAITING_BUY_RESERVATION_MISMATCH",
    });
    db.close();
    consumer.close();
    executor.close();
  });

  it("reduces a waiting Live BUY before selling the same ratio of an open position", async () => {
    const env = setup();
    const openingExecutor = liveExecutor(env.databasePath);
    const openingConsumer = new LiveSignalConsumer(
      env.databasePath,
      openingExecutor,
      sourceVersion,
      () => new Date(now),
    );
    const [opening] = await openingConsumer.consumeAvailableSignals(accountId);
    expect(opening).toMatchObject({ state: "EXECUTED" });
    openingConsumer.close();
    openingExecutor.close();

    const pending = insertSignalAndRisk(env.databasePath, env.targetId, {
      signalId: "live-pending-buy-before-partial-exit",
      riskDecisionId: "unused-live-pending-buy-risk",
      decision: "ALLOW",
      capitalRatioPpm: "1",
      createdAt: "2026-07-09T00:00:01.000Z",
    });
    const waitingExecutor = liveExecutor(env.databasePath, {
      marketDataProvider: new FakeLiveMarketDataProvider({
        now: () => new Date(now),
        asks: [],
      }),
    });
    const waitingConsumer = new LiveSignalConsumer(
      env.databasePath,
      waitingExecutor,
      sourceVersion,
      () => new Date(now),
    );
    const [waitingBuy] = await waitingConsumer.consumeAvailableSignals(accountId);
    expect(waitingBuy).toMatchObject({ signalId: pending.signal.signalId, state: "WAITING_EXECUTION" });
    waitingConsumer.close();
    waitingExecutor.close();

    const exit = insertSignalAndRisk(env.databasePath, env.targetId, {
      signalId: "live-half-exit-reduces-waiting-buy",
      riskDecisionId: "unused-live-half-exit-risk",
      decision: "ALLOW",
      signalType: "TARGET_SELL",
      sellRatioNumerator: "1",
      sellRatioDenominator: "2",
      createdAt: "2026-07-09T00:00:02.000Z",
    });
    const sellingExecutor = liveExecutor(env.databasePath);
    const sellingConsumer = new LiveSignalConsumer(
      env.databasePath,
      sellingExecutor,
      sourceVersion,
      () => new Date(now),
    );

    const [result] = await sellingConsumer.consumeAvailableSignals(accountId);

    expect(result).toMatchObject({ signalId: exit.signal.signalId, state: "EXECUTED" });
    expect(await sellingExecutor.executeSell({
      accountId,
      signal: exit.signal,
      context: exit.context,
      riskDecisionId: result!.riskDecisionId!,
    })).toMatchObject({ executionId: result!.executionId, state: "EXECUTED" });
    const db = new DatabaseSync(env.databasePath, { readOnly: true });
    expect(db.prepare(
      "SELECT state,requested_amount_micros,reason FROM live_executions WHERE live_execution_id=?",
    ).get(waitingBuy!.executionId!)).toEqual({
      state: "WAITING_EXECUTION",
      requested_amount_micros: "500000",
      reason: "TARGET_SELL_REDUCED_WAITING_BUY",
    });
    expect(db.prepare(
      "SELECT COALESCE(SUM(CAST(delta_micros AS INTEGER)),0) remaining FROM live_reservation_ledger WHERE live_execution_id=?",
    ).get(waitingBuy!.executionId!)).toEqual({ remaining: 500000 });
    expect(db.prepare(
      "SELECT COUNT(*) count FROM live_reservation_ledger WHERE live_execution_id=? AND entry_type='RELEASE'",
    ).get(waitingBuy!.executionId!)).toEqual({ count: 1 });
    expect(db.prepare(
      "SELECT requested_size_micros FROM live_executions WHERE live_execution_id=?",
    ).get(result!.executionId!)).toEqual({ requested_size_micros: "100000000" });
    expect(db.prepare(
      "SELECT current_size_micros,status FROM live_positions WHERE live_account_id=? AND asset_id=?",
    ).get(accountId, assetId)).toEqual({ current_size_micros: "100000000", status: "PARTIALLY_CLOSED" });
    const adjustmentTransition = db.prepare(
      `SELECT rowid FROM live_state_transitions
       WHERE entity_id=? AND reason='TARGET_SELL_REDUCED_WAITING_BUY'
       ORDER BY rowid DESC LIMIT 1`,
    ).get(waitingBuy!.executionId!) as { rowid: number };
    const sellTransition = db.prepare(
      `SELECT rowid FROM live_state_transitions
       WHERE entity_id=? ORDER BY rowid LIMIT 1`,
    ).get(result!.executionId!) as { rowid: number };
    expect(adjustmentTransition.rowid).toBeLessThan(sellTransition.rowid);
    db.close();
    sellingConsumer.close();
    sellingExecutor.close();

    const retryExecutor = liveExecutor(env.databasePath, {
      marketDataProvider: new FakeLiveMarketDataProvider({
        now: () => new Date(now),
        minOrderSize: "5",
        tickSize: "0.01",
      }),
    });
    expect(await retryExecutor.retryPending(accountId, "BUYS_ONLY"))
      .toContain(waitingBuy!.executionId!);
    const retryCheck = new DatabaseSync(env.databasePath, { readOnly: true });
    expect(retryCheck.prepare(
      "SELECT state,requested_amount_micros,reason FROM live_executions WHERE live_execution_id=?",
    ).get(waitingBuy!.executionId!)).toEqual({
      state: "REJECTED",
      requested_amount_micros: "500000",
      reason: "BELOW_MARKET_MIN_ORDER_SIZE",
    });
    expect(retryCheck.prepare(
      "SELECT COUNT(*) count FROM live_reservation_ledger WHERE live_execution_id=? AND entry_type='RELEASE'",
    ).get(waitingBuy!.executionId!)).toEqual({ count: 2 });
    retryCheck.close();
    retryExecutor.close();
  });

  it("does not adjust a waiting Live BUY when the target exit fails the Live Gate", async () => {
    const env = setup({ capitalRatioPpm: "1" });
    const waitingExecutor = liveExecutor(env.databasePath, {
      marketDataProvider: new FakeLiveMarketDataProvider({
        now: () => new Date(now),
        asks: [],
      }),
    });
    const waitingConsumer = new LiveSignalConsumer(
      env.databasePath,
      waitingExecutor,
      sourceVersion,
      () => new Date(now),
    );
    const [waitingBuy] = await waitingConsumer.consumeAvailableSignals(accountId);
    expect(waitingBuy).toMatchObject({ state: "WAITING_EXECUTION" });
    waitingConsumer.close();
    waitingExecutor.close();

    const exit = insertSignalAndRisk(env.databasePath, env.targetId, {
      signalId: "live-gate-blocked-exit-keeps-waiting-buy",
      riskDecisionId: "unused-live-gate-blocked-exit-risk",
      decision: "ALLOW",
      signalType: "TARGET_SELL",
      sellRatioNumerator: "1",
      sellRatioDenominator: "1",
      requestedAmountMicros: null,
      requestedSizeMicros: null,
      createdAt: "2026-07-09T00:00:01.000Z",
    });
    const blockedExecutor = liveExecutor(env.databasePath, { liveGate: new FakeGate(false) });
    const blockedConsumer = new LiveSignalConsumer(
      env.databasePath,
      blockedExecutor,
      sourceVersion,
      () => new Date(now),
    );

    const [result] = await blockedConsumer.consumeAvailableSignals(accountId);

    expect(result).toMatchObject({ signalId: exit.signal.signalId, state: "REJECTED" });
    const db = new DatabaseSync(env.databasePath, { readOnly: true });
    expect(db.prepare(
      "SELECT state,requested_amount_micros,reason FROM live_executions WHERE live_execution_id=?",
    ).get(waitingBuy!.executionId!)).toEqual({
      state: "WAITING_EXECUTION",
      requested_amount_micros: "1000000",
      reason: "LIVE_BUY_WAITING_MARKET",
    });
    expect(db.prepare(
      "SELECT COUNT(*) count FROM live_reservation_ledger WHERE live_execution_id=? AND entry_type='RELEASE'",
    ).get(waitingBuy!.executionId!)).toEqual({ count: 0 });
    db.close();
    blockedConsumer.close();
    blockedExecutor.close();
  });

  it("keeps a sufficient proportional Live BUY unchanged even when it is above the auto-lift cap", async () => {
    const env = setup({ capitalRatioPpm: "100000" });
    const executor = liveExecutor(env.databasePath, {
      marketDataProvider: new FakeLiveMarketDataProvider({
        now: () => new Date(now),
        minOrderSize: "11",
        tickSize: "0.01",
      }),
    });
    const consumer = new LiveSignalConsumer(env.databasePath, executor, sourceVersion, () => new Date(now));

    const [result] = await consumer.consumeAvailableSignals(accountId);

    expect(result).toMatchObject({ state: "EXECUTED" });
    const positions = await executor.getPosition({ accountId, assetId }) as Array<{
      remaining_cost_micros: string;
    }>;
    expect(positions[0]).toMatchObject({ remaining_cost_micros: "100000000" });
    consumer.close();
    executor.close();
  });

  it("lifts a pending Live BUY after book recovery and re-risks exactly once", async () => {
    const env = setup({ capitalRatioPpm: "1" });
    const waiting = liveExecutor(env.databasePath, {
      marketDataProvider: new FakeLiveMarketDataProvider({
        now: () => new Date(now),
        asks: [],
        minOrderSize: "5",
        tickSize: "0.01",
      }),
    });
    const consumer = new LiveSignalConsumer(env.databasePath, waiting, sourceVersion, () => new Date(now));

    const [first] = await consumer.consumeAvailableSignals(accountId);

    expect(first).toMatchObject({ state: "WAITING_EXECUTION" });
    const beforeRestart = new DatabaseSync(env.databasePath, { readOnly: true });
    expect(beforeRestart.prepare(
      `SELECT requested_amount_micros,risk_decision_id FROM live_executions
       WHERE live_execution_id=?`,
    ).get(first!.executionId)).toEqual({
      requested_amount_micros: "1000000",
      risk_decision_id: first!.riskDecisionId,
    });
    expect((beforeRestart.prepare(
      `SELECT COALESCE(SUM(CAST(delta_micros AS INTEGER)),0) total
       FROM live_reservation_ledger WHERE live_execution_id=?`,
    ).get(first!.executionId) as { total: number }).total).toBe(1_000_000);
    const riskCount = (beforeRestart.prepare(
      "SELECT count(*) count FROM risk_decisions WHERE signal_id=?",
    ).get(env.signal.signalId) as { count: number }).count;
    beforeRestart.close();
    consumer.close();
    waiting.close();

    const signer = new RecordingFakeSigner();
    const resumed = liveExecutor(env.databasePath, {
      signer,
      marketDataProvider: new FakeLiveMarketDataProvider({
        now: () => new Date(now),
        minOrderSize: "5",
        tickSize: "0.01",
      }),
    });
    expect(await resumed.retryPending(accountId, "BUYS_ONLY")).toEqual([first!.executionId]);

    const afterRestart = new DatabaseSync(env.databasePath, { readOnly: true });
    expect(afterRestart.prepare(
      `SELECT outcome,reason FROM live_market_checks
       WHERE live_execution_id=? ORDER BY rowid`,
    ).all(first!.executionId)).toEqual([
      { outcome: "WAIT", reason: "BUY_NO_ASK" },
      { outcome: "ALLOW", reason: "LIVE_BUY_MARKET_CHECK_ALLOW" },
    ]);
    const finalExecution = afterRestart.prepare(
      `SELECT state,requested_amount_micros,risk_decision_id FROM live_executions
       WHERE live_execution_id=?`,
    ).get(first!.executionId) as {
      state: string;
      requested_amount_micros: string;
      risk_decision_id: string;
    };
    expect(finalExecution).toMatchObject({
      state: "EXECUTED",
      requested_amount_micros: "2500000",
    });
    expect(finalExecution.risk_decision_id).not.toBe(first!.riskDecisionId);
    expect((afterRestart.prepare(
      "SELECT count(*) count FROM risk_decisions WHERE signal_id=?",
    ).get(env.signal.signalId) as { count: number }).count).toBe(riskCount + 1);
    const reservationTotal = afterRestart.prepare(
      `SELECT COALESCE(SUM(CAST(delta_micros AS INTEGER)),0) total
       FROM live_reservation_ledger WHERE live_execution_id=?`,
    ).get(first!.executionId) as { total: number };
    expect(BigInt(reservationTotal.total)).toBe(0n);
    expect(signer.payloads).toHaveLength(1);
    expect(signer.payloads[0]).toMatchObject({
      riskDecisionId: finalExecution.risk_decision_id,
      budgetMicros: "2500000",
    });
    afterRestart.close();
    resumed.close();
  });

  it("recovers a pending execution and re-risks once when the exact market minimum becomes known", async () => {
    const env = setup({ capitalRatioPpm: "1" });
    const waiting = liveExecutor(env.databasePath, {
      marketDataProvider: new FakeLiveMarketDataProvider({
        now: () => new Date(now),
        asks: [],
        minOrderSize: "5",
        tickSize: "0.01",
      }),
    });
    const crashAfterExecution = new Proxy(waiting, {
      get(target, property, receiver) {
        if (property === "executeBuy") {
          return async (input: Parameters<LiveExecutor["executeBuy"]>[0]) => {
            await target.executeBuy(input);
            throw new Error("TEST_CRASH_BEFORE_CONSUMPTION");
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const interrupted = new LiveSignalConsumer(
      env.databasePath,
      crashAfterExecution,
      sourceVersion,
      () => new Date(now),
    );

    await expect(interrupted.consumeAvailableSignals(accountId)).rejects
      .toThrow("TEST_CRASH_BEFORE_CONSUMPTION");

    const beforeRestart = new DatabaseSync(env.databasePath, { readOnly: true });
    const execution = beforeRestart.prepare(
      `SELECT live_execution_id,risk_decision_id,requested_amount_micros,state
       FROM live_executions WHERE signal_id=?`,
    ).get(env.signal.signalId) as {
      live_execution_id: string;
      risk_decision_id: string;
      requested_amount_micros: string;
      state: string;
    };
    expect(execution).toMatchObject({ requested_amount_micros: "1000000", state: "WAITING_EXECUTION" });
    expect((beforeRestart.prepare(
      "SELECT count(*) count FROM live_signal_consumptions WHERE signal_id=?",
    ).get(env.signal.signalId) as { count: number }).count).toBe(0);
    const riskCount = (beforeRestart.prepare(
      "SELECT count(*) count FROM risk_decisions WHERE signal_id=?",
    ).get(env.signal.signalId) as { count: number }).count;
    beforeRestart.close();
    interrupted.close();
    waiting.close();

    const signer = new RecordingFakeSigner();
    const resumed = liveExecutor(env.databasePath, {
      signer,
      marketDataProvider: new FakeLiveMarketDataProvider({
        now: () => new Date(now),
        minOrderSize: "5",
        tickSize: "0.01",
      }),
    });
    const consumer = new LiveSignalConsumer(env.databasePath, resumed, sourceVersion, () => new Date(now));
    const [result] = await consumer.consumeAvailableSignals(accountId);

    expect(result).toMatchObject({
      signalId: env.signal.signalId,
      executionId: execution.live_execution_id,
      state: "EXECUTED",
    });
    expect(result!.riskDecisionId).not.toBe(execution.risk_decision_id);
    const afterRestart = new DatabaseSync(env.databasePath, { readOnly: true });
    expect((afterRestart.prepare(
      "SELECT count(*) count FROM risk_decisions WHERE signal_id=?",
    ).get(env.signal.signalId) as { count: number }).count).toBe(riskCount + 1);
    expect((afterRestart.prepare(
      "SELECT count(*) count FROM live_signal_consumptions WHERE signal_id=?",
    ).get(env.signal.signalId) as { count: number }).count).toBe(1);
    expect(signer.payloads).toHaveLength(1);
    expect(signer.payloads[0]).toMatchObject({
      riskDecisionId: result!.riskDecisionId,
      budgetMicros: "2500000",
    });
    afterRestart.close();
    consumer.close();
    resumed.close();
  });

  it("rolls back final Risk rebinding when rejection cleanup cannot commit atomically", async () => {
    const env = setup({ capitalRatioPpm: "1" });
    const writer = new DatabaseSync(env.databasePath);
    writer.prepare("UPDATE live_accounts SET risk_budget_micros='2000000' WHERE live_account_id=?")
      .run(accountId);
    writer.exec(
      `CREATE TRIGGER test_atomic_rejection_abort
       BEFORE UPDATE OF state ON live_executions
       WHEN NEW.state='REJECTED'
       BEGIN
         SELECT RAISE(ABORT, 'TEST_ATOMIC_REJECTION_ABORT');
       END`,
    );
    writer.close();
    const executor = liveExecutor(env.databasePath, {
      marketDataProvider: new FakeLiveMarketDataProvider({
        now: () => new Date(now),
        minOrderSize: "5",
        tickSize: "0.01",
      }),
    });
    const consumer = new LiveSignalConsumer(env.databasePath, executor, sourceVersion, () => new Date(now));

    await expect(consumer.consumeAvailableSignals(accountId)).rejects
      .toThrow("TEST_ATOMIC_REJECTION_ABORT");

    const db = new DatabaseSync(env.databasePath, { readOnly: true });
    const row = db.prepare(
      `SELECT e.state,e.requested_amount_micros,r.requested_amount_micros risk_amount,r.decision
       FROM live_executions e JOIN risk_decisions r ON r.risk_decision_id=e.risk_decision_id
       WHERE e.signal_id=?`,
    ).get(env.signal.signalId);
    expect(row).toEqual({
      state: "WAITING_EXECUTION",
      requested_amount_micros: "1000000",
      risk_amount: "1000000",
      decision: "ALLOW",
    });
    expect((db.prepare(
      `SELECT COALESCE(SUM(CAST(delta_micros AS INTEGER)),0) total
       FROM live_reservation_ledger WHERE live_execution_id=(
         SELECT live_execution_id FROM live_executions WHERE signal_id=?
       )`,
    ).get(env.signal.signalId) as { total: number }).total).toBe(1_000_000);
    db.close();
    consumer.close();
    executor.close();
  });

  it("isolates malformed and missing-context Signals so later valid Signals are not head-of-line blocked", async () => {
    const env = setup({ capitalRatioPpm: "100000" });
    const openingExecutor = liveExecutor(env.databasePath);
    const openingConsumer = new LiveSignalConsumer(
      env.databasePath,
      openingExecutor,
      sourceVersion,
      () => new Date(now),
    );
    expect(await openingConsumer.consumeAvailableSignals(accountId)).toHaveLength(1);
    openingConsumer.close();
    openingExecutor.close();

    const executor = liveExecutor(env.databasePath, {
      walletProvider: new FakeWalletProvider({ balanceMicros: "900000000" }),
    });
    const consumer = new LiveSignalConsumer(env.databasePath, executor, sourceVersion, () => new Date(now));

    insertPublishedSignalWithoutContext(env.databasePath, env.targetId, "live-poison-invalid-size", "not-an-integer");
    insertPublishedSignalWithoutContext(env.databasePath, env.targetId, "live-missing-context");
    const valid = insertSignalAndRisk(env.databasePath, env.targetId, {
      signalId: "live-after-poison",
      riskDecisionId: "unused-after-poison-risk",
      decision: "ALLOW",
      capitalRatioPpm: "100000",
    });

    const results = await consumer.consumeAvailableSignals(accountId);
    expect(results.map((result) => ({ signalId: result.signalId, state: result.state }))).toEqual([
      { signalId: "live-poison-invalid-size", state: "QUARANTINED" },
      { signalId: "live-missing-context", state: "QUARANTINED" },
      { signalId: valid.signal.signalId, state: "EXECUTED" },
    ]);
    expect(await consumer.consumeAvailableSignals(accountId)).toEqual([]);
    const db = new DatabaseSync(env.databasePath, { readOnly: true });
    expect((db.prepare(
      "SELECT reason FROM live_signal_quarantines WHERE signal_id='live-poison-invalid-size'",
    ).get() as { reason: string }).reason).toBe("SIGNAL_TARGET_SIZE_INVALID");
    expect((db.prepare(
      "SELECT reason FROM live_signal_quarantines WHERE signal_id='live-missing-context'",
    ).get() as { reason: string }).reason).toBe("BUY_FOLLOW_RATIO_EVIDENCE_UNAVAILABLE:live-missing-context");
    expect(db.prepare(
      "SELECT state FROM live_executions WHERE signal_id='live-missing-context'",
    ).get()).toBeUndefined();
    db.close();
    consumer.close();
    executor.close();
  });

  it("emergency-disables Live before a tracked conversion can be skipped", async () => {
    const env = setup({ capitalRatioPpm: "100000" });
    const executor = liveExecutor(env.databasePath);
    const consumer = new LiveSignalConsumer(env.databasePath, executor, sourceVersion, () => new Date(now));
    expect(await consumer.consumeAvailableSignals(accountId)).toHaveLength(1);

    insertBlockingConversionSignal(env.databasePath, env.targetId, "live-tracked-conversion");
    const later = insertSignalAndRisk(env.databasePath, env.targetId, {
      signalId: "live-after-conversion",
      riskDecisionId: "unused-after-conversion-risk",
      decision: "ALLOW",
      capitalRatioPpm: "100000",
    });

    await expect(consumer.consumeAvailableSignals(accountId)).rejects.toThrow(
      "LIVE_TARGET_CONVERSION_BLOCKED:NEGATIVE_RISK_CONVERSION_EXECUTION_UNAVAILABLE:live-tracked-conversion",
    );

    const db = new DatabaseSync(env.databasePath, { readOnly: true });
    expect(db.prepare(
      "SELECT execution_mode,live_gate_state,state_reason FROM live_gate_state WHERE state_id='default'",
    ).get()).toEqual({
      execution_mode: "PAPER",
      live_gate_state: "LIVE_DISABLED",
      state_reason: "EMERGENCY_STOP:TARGET_CONVERSION_BLOCKED:NEGATIVE_RISK_CONVERSION_EXECUTION_UNAVAILABLE:live-tracked-conversion",
    });
    expect((db.prepare(
      "SELECT count(*) count FROM live_signal_consumptions WHERE signal_id=?",
    ).get(later.signal.signalId) as { count: number }).count).toBe(0);
    expect((db.prepare(
      "SELECT count(*) count FROM live_executions WHERE signal_id=?",
    ).get(later.signal.signalId) as { count: number }).count).toBe(0);
    db.close();
    consumer.close();
    executor.close();
  });

  it("rechecks conversion blockers after selecting eligible Live candidates", async () => {
    const env = setup({ capitalRatioPpm: "100000" });
    const executor = liveExecutor(env.databasePath);
    const consumer = new LiveSignalConsumer(env.databasePath, executor, sourceVersion, () => new Date(now));
    const originalAssert = consumer.assertNoBlockingTargetConversion.bind(consumer);
    let checks = 0;
    consumer.assertNoBlockingTargetConversion = async (requestedAccountId, checkpoint) => {
      checks += 1;
      if (checks === 2) {
        insertBlockingConversionSignal(env.databasePath, env.targetId, "live-conversion-in-race-window");
      }
      await originalAssert(requestedAccountId, checkpoint);
    };

    await expect(consumer.consumeAvailableSignals(accountId)).rejects.toThrow(
      "LIVE_TARGET_CONVERSION_BLOCKED:",
    );

    expect(checks).toBe(2);
    const db = new DatabaseSync(env.databasePath, { readOnly: true });
    expect((db.prepare(
      "SELECT count(*) count FROM live_executions WHERE signal_id=?",
    ).get(env.signal.signalId) as { count: number }).count).toBe(0);
    expect(db.prepare(
      "SELECT execution_mode,live_gate_state FROM live_gate_state WHERE state_id='default'",
    ).get()).toEqual({ execution_mode: "PAPER", live_gate_state: "LIVE_DISABLED" });
    db.close();
    consumer.close();
    executor.close();
  });

  it("defers and later resumes a Live BUY while portfolio valuation is incomplete", async () => {
    const env = setup({ capitalRatioPpm: "100000" });
    const executor = liveExecutor(env.databasePath);
    const complete = {
      paperAccountId: accountId,
      initialBalanceMicros: "1000000000",
      cashBalanceMicros: "1000000000",
      reservedBalanceMicros: "0",
      availableBalanceMicros: "1000000000",
      positionValueMicros: "0",
      realizedPnlMicros: "0",
      unrealizedPnlMicros: "0",
      totalEquityMicros: "1000000000",
      valuationStatus: "COMPLETE",
      unpricedPositionCount: 0,
      priceSource: "ORDERBOOK_EXIT_VWAP",
      priceTimestamp: now,
    } as const;
    vi.spyOn(executor, "getBalance")
      .mockResolvedValueOnce({
        ...complete,
        valuationStatus: "INCOMPLETE",
        unpricedPositionCount: 1,
      })
      .mockResolvedValue(complete);
    const consumer = new LiveSignalConsumer(env.databasePath, executor, sourceVersion, () => new Date(now));

    expect(await consumer.consumeAvailableSignals(accountId)).toEqual([]);
    let database = new DatabaseSync(env.databasePath, { readOnly: true });
    expect((database.prepare(
      "SELECT count(*) count FROM live_signal_quarantines WHERE signal_id=?",
    ).get(env.signal.signalId) as { count: number }).count).toBe(0);
    expect((database.prepare(
      "SELECT count(*) count FROM live_signal_consumptions WHERE signal_id=?",
    ).get(env.signal.signalId) as { count: number }).count).toBe(0);
    database.close();

    expect(await consumer.consumeAvailableSignals(accountId)).toHaveLength(1);
    database = new DatabaseSync(env.databasePath, { readOnly: true });
    expect((database.prepare(
      "SELECT count(*) count FROM live_signal_consumptions WHERE signal_id=?",
    ).get(env.signal.signalId) as { count: number }).count).toBe(1);
    database.close();
    consumer.close();
    executor.close();
  });

  it("runs startup recovery before activation and never backfills signals from the disabled interval", async () => {
    const env = setup({ capitalRatioPpm: "100000" });
    let clockMs = Date.parse(now);
    const clock = () => new Date(clockMs);
    const executor = liveExecutor(env.databasePath, {
      now: clock,
      marketDataProvider: new FakeLiveMarketDataProvider({ now: clock }),
    });
    const consumer = new LiveSignalConsumer(env.databasePath, executor, sourceVersion, clock);
    activateLiveGate(env.databasePath);
    let activationInserted = false;
    const runner = new LiveRunner(executor, consumer, {
      accountId,
      intervalMs: 1_000,
      durationMs: 2_200,
      reconciliationEveryCycles: 1,
      now: clock,
      wait: async (milliseconds) => {
        clockMs += milliseconds;
        if (!activationInserted) {
          activateLiveGate(env.databasePath);
          insertSignalAndRisk(env.databasePath, env.targetId, {
            signalId: "live-runner-post-activation-buy",
            riskDecisionId: "unused-runner-prebuilt-risk",
            decision: "ALLOW",
            capitalRatioPpm: "100000",
            createdAt: clock().toISOString(),
          });
          activationInserted = true;
        }
      },
    });
    const report = await runner.run();
    expect(report.recovery.passed).toBe(true);
    expect(report).toMatchObject({
      activationCount: 1,
      consumedSignals: 1,
      activeCycles: 2,
      errors: [],
    });
    const db = new DatabaseSync(env.databasePath, { readOnly: true });
    const consumed = db.prepare(
      "SELECT signal_id FROM live_signal_consumptions ORDER BY created_at,signal_id",
    ).all() as unknown as Array<{ signal_id: string }>;
    expect(consumed).toEqual([{ signal_id: "live-runner-post-activation-buy" }]);
    const cutoffAudit = db.prepare(
      `SELECT metadata_json FROM audit_log
       WHERE entity_type='LIVE_CONSUMER_CHECKPOINT' AND action='CUTOFF_ADVANCED'
       ORDER BY timestamp DESC LIMIT 1`,
    ).get() as { metadata_json: string };
    expect(JSON.parse(cutoffAudit.metadata_json)).toMatchObject({ skippedSignals: 1 });
    db.close();
    consumer.close();
    executor.close();
  });

  it("retries only the final Live valuation when public data recovers", async () => {
    const env = setup({ capitalRatioPpm: "100000" });
    let clockMs = Date.parse(now);
    const clock = () => new Date(clockMs);
    const executor = liveExecutor(env.databasePath, { now: clock });
    const consumer = new LiveSignalConsumer(env.databasePath, executor, sourceVersion, clock);
    const incomplete = {
      paperAccountId: accountId,
      valuationStatus: "INCOMPLETE",
      unpricedPositionCount: 1,
    };
    const complete = {
      paperAccountId: accountId,
      valuationStatus: "COMPLETE",
      unpricedPositionCount: 0,
    };
    const getBalance = vi.spyOn(executor, "getBalance")
      .mockResolvedValueOnce(incomplete as never)
      .mockResolvedValueOnce(complete as never);
    const runner = new LiveRunner(executor, consumer, {
      accountId,
      intervalMs: 1,
      durationMs: 1,
      reconciliationEveryCycles: 100,
      now: clock,
      wait: async (milliseconds) => { clockMs += milliseconds; },
      valuationRecovery: {
        maxAttempts: 2,
        wait: async () => undefined,
      },
    });

    const report = await runner.run();

    expect(getBalance).toHaveBeenCalledTimes(2);
    expect(report.account).toBe(complete);
    expect(report.valuationRecovery).toEqual({
      attempts: 2,
      recovered: true,
      status: "COMPLETE",
    });
    consumer.close();
    executor.close();
  });

  it("checks stop losses and exits before consuming a new BUY Signal", async () => {
    const env = setup({ capitalRatioPpm: "100000" });
    const buyer = liveExecutor(env.databasePath);
    await buyer.executeBuy({
      accountId,
      signal: env.signal,
      context: env.context,
      riskDecisionId: "risk-live-buy",
    });
    buyer.close();

    let clockMs = Date.parse(now);
    const clock = () => new Date(clockMs);
    const executor = liveExecutor(env.databasePath, {
      now: clock,
      marketDataProvider: new FakeLiveMarketDataProvider({
        now: clock,
        bids: [{ price: "0.23", size: "1000" }],
        asks: [{ price: "0.5", size: "1000" }],
      }),
    });
    const consumer = new LiveSignalConsumer(env.databasePath, executor, sourceVersion, clock);
    activateLiveGate(env.databasePath);
    let activated = false;
    const runner = new LiveRunner(executor, consumer, {
      accountId,
      intervalMs: 1_000,
      durationMs: 1_200,
      reconciliationEveryCycles: 100,
      now: clock,
      wait: async (milliseconds) => {
        clockMs += milliseconds;
        if (!activated) {
          activateLiveGate(env.databasePath);
          insertSignalAndRisk(env.databasePath, env.targetId, {
            signalId: "live-runner-buy-after-stop",
            riskDecisionId: "unused-runner-buy-after-stop",
            decision: "ALLOW",
            capitalRatioPpm: "100000",
            createdAt: clock().toISOString(),
          });
          activated = true;
        }
      },
    });

    const report = await runner.run();

    expect(report).toMatchObject({
      stopLossExecutions: 1,
      stopLossUnsafeCycles: 0,
      skippedBuyCycles: 0,
      consumedSignals: 1,
      errors: [],
    });
    const db = new DatabaseSync(env.databasePath, { readOnly: true });
    const positions = db.prepare(
      "SELECT signal_id,status,current_size_micros FROM live_positions ORDER BY created_at,live_position_id",
    ).all() as unknown as Array<{ signal_id: string; status: string; current_size_micros: string }>;
    expect(positions[0]).toEqual({ signal_id: "live-buy", status: "CLOSED", current_size_micros: "0" });
    expect(positions).toHaveLength(1);
    expect(db.prepare(
      "SELECT state,reason FROM live_executions WHERE signal_id='live-runner-buy-after-stop'",
    ).get()).toEqual({ state: "REJECTED", reason: "STOP_LOSS_REENTRY_BLOCKED" });
    db.close();
    consumer.close();
    executor.close();
  });

  it("applies a newly arrived target SELL before retrying an older waiting BUY in the same Live cycle", async () => {
    const env = setup({ capitalRatioPpm: "1" });
    const waitingExecutor = liveExecutor(env.databasePath, {
      marketDataProvider: new FakeLiveMarketDataProvider({
        now: () => new Date(now),
        asks: [],
      }),
    });
    const waitingConsumer = new LiveSignalConsumer(
      env.databasePath,
      waitingExecutor,
      sourceVersion,
      () => new Date(now),
    );
    const [waitingBuy] = await waitingConsumer.consumeAvailableSignals(accountId);
    expect(waitingBuy).toMatchObject({ state: "WAITING_EXECUTION" });
    waitingConsumer.close();
    waitingExecutor.close();

    let clockMs = Date.parse(now);
    const clock = () => new Date(clockMs);
    const executor = liveExecutor(env.databasePath, {
      now: clock,
      marketDataProvider: new FakeLiveMarketDataProvider({ now: clock }),
    });
    const consumer = new LiveSignalConsumer(env.databasePath, executor, sourceVersion, clock);
    activateLiveGate(env.databasePath);
    let activated = false;
    const runner = new LiveRunner(executor, consumer, {
      accountId,
      intervalMs: 1_000,
      durationMs: 1_200,
      reconciliationEveryCycles: 100,
      now: clock,
      wait: async (milliseconds) => {
        clockMs += milliseconds;
        if (!activated) {
          activateLiveGate(env.databasePath);
          insertSignalAndRisk(env.databasePath, env.targetId, {
            signalId: "live-runner-sell-before-waiting-buy-retry",
            riskDecisionId: "unused-live-runner-target-sell-risk",
            decision: "ALLOW",
            signalType: "TARGET_SELL",
            sellRatioNumerator: "1",
            sellRatioDenominator: "1",
            requestedAmountMicros: null,
            requestedSizeMicros: "1",
            createdAt: clock().toISOString(),
          });
          activated = true;
        }
      },
    });

    const report = await runner.run();

    expect(report.errors).toEqual([]);
    const db = new DatabaseSync(env.databasePath, { readOnly: true });
    expect(db.prepare(
      "SELECT state,reason FROM live_executions WHERE live_execution_id=?",
    ).get(waitingBuy!.executionId!)).toEqual({
      state: "CANCELLED",
      reason: "TARGET_SELL_SUPERSEDED_WAITING_BUY",
    });
    expect(db.prepare("SELECT count(*) count FROM live_orders").get()).toEqual({ count: 0 });
    expect(db.prepare(
      "SELECT state,reason FROM live_executions WHERE signal_id='live-runner-sell-before-waiting-buy-retry'",
    ).get()).toEqual({
      state: "EXECUTED",
      reason: "TARGET_EXIT_APPLIED_TO_WAITING_BUY",
    });
    db.close();
    consumer.close();
    executor.close();
  });

  it("preserves target chronology when a new BUY and its later SELL arrive in the same Live cycle", async () => {
    const env = setup({ capitalRatioPpm: "10000" });
    let clockMs = Date.parse(now);
    const clock = () => new Date(clockMs);
    const executor = liveExecutor(env.databasePath, {
      now: clock,
      marketDataProvider: new FakeLiveMarketDataProvider({ now: clock }),
    });
    const consumer = new LiveSignalConsumer(env.databasePath, executor, sourceVersion, clock);
    activateLiveGate(env.databasePath);
    let inserted = false;
    const runner = new LiveRunner(executor, consumer, {
      accountId,
      intervalMs: 1_000,
      durationMs: 1_200,
      reconciliationEveryCycles: 100,
      now: clock,
      wait: async (milliseconds) => {
        clockMs += milliseconds;
        if (inserted) return;
        activateLiveGate(env.databasePath);
        insertSignalAndRisk(env.databasePath, env.targetId, {
          signalId: "live-runner-chronological-buy",
          riskDecisionId: "unused-live-runner-chronological-buy-risk",
          decision: "ALLOW",
          capitalRatioPpm: "10000",
          createdAt: clock().toISOString(),
        });
        insertSignalAndRisk(env.databasePath, env.targetId, {
          signalId: "live-runner-chronological-sell",
          riskDecisionId: "unused-live-runner-chronological-sell-risk",
          decision: "ALLOW",
          signalType: "TARGET_SELL",
          sellRatioNumerator: "1",
          sellRatioDenominator: "1",
          requestedAmountMicros: null,
          requestedSizeMicros: "1",
          createdAt: clock().toISOString(),
        });
        inserted = true;
      },
    });

    const report = await runner.run();

    expect(report.errors).toEqual([]);
    expect(report.consumedSignals).toBe(2);
    const db = new DatabaseSync(env.databasePath, { readOnly: true });
    expect(db.prepare(
      `SELECT status,current_size_micros FROM live_positions
       WHERE signal_id='live-runner-chronological-buy'`,
    ).get()).toEqual({ status: "CLOSED", current_size_micros: "0" });
    expect(db.prepare(
      "SELECT state FROM live_executions WHERE signal_id='live-runner-chronological-sell'",
    ).get()).toEqual({ state: "EXECUTED" });
    expect(db.prepare("SELECT count(*) count FROM live_orders").get()).toEqual({ count: 2 });
    db.close();
    consumer.close();
    executor.close();
  });

  it("does not retry an older waiting BUY when ordered Signal consumption fails", async () => {
    const env = setup({ capitalRatioPpm: "1" });
    const waitingExecutor = liveExecutor(env.databasePath, {
      marketDataProvider: new FakeLiveMarketDataProvider({
        now: () => new Date(now),
        asks: [],
      }),
    });
    const waitingConsumer = new LiveSignalConsumer(
      env.databasePath,
      waitingExecutor,
      sourceVersion,
      () => new Date(now),
    );
    const [waitingBuy] = await waitingConsumer.consumeAvailableSignals(accountId);
    expect(waitingBuy).toMatchObject({ state: "WAITING_EXECUTION" });
    waitingConsumer.close();
    waitingExecutor.close();

    let clockMs = Date.parse(now);
    const clock = () => new Date(clockMs);
    const executor = liveExecutor(env.databasePath, {
      now: clock,
      marketDataProvider: new FakeLiveMarketDataProvider({ now: clock }),
    });
    const consumer = new FinalStageFailingLiveSignalConsumer(
      env.databasePath,
      executor,
      sourceVersion,
      clock,
    );
    activateLiveGate(env.databasePath);
    let reactivated = false;
    const runner = new LiveRunner(executor, consumer, {
      accountId,
      intervalMs: 1_000,
      durationMs: 1_200,
      reconciliationEveryCycles: 100,
      now: clock,
      wait: async (milliseconds) => {
        clockMs += milliseconds;
        if (!reactivated) {
          activateLiveGate(env.databasePath);
          reactivated = true;
        }
      },
    });

    const report = await runner.run();

    expect(report.errors).toEqual([
      expect.objectContaining({
        operation: "CONSUME_SIGNALS_IN_ORDER",
        message: "TEST_ORDERED_SIGNAL_CONSUMER_FAILURE",
      }),
    ]);
    expect(report.skippedBuyCycles).toBe(1);
    const db = new DatabaseSync(env.databasePath, { readOnly: true });
    expect(db.prepare(
      "SELECT state,reason FROM live_executions WHERE live_execution_id=?",
    ).get(waitingBuy!.executionId!)).toEqual({
      state: "WAITING_EXECUTION",
      reason: "LIVE_BUY_WAITING_MARKET",
    });
    expect(db.prepare("SELECT count(*) count FROM live_orders").get()).toEqual({ count: 0 });
    db.close();
    consumer.close();
    executor.close();
  });

  it("blocks current-cycle BUY consumption and persists Audit when stop-loss market data is stale", async () => {
    const env = setup({ capitalRatioPpm: "100000" });
    const buyer = liveExecutor(env.databasePath);
    await buyer.executeBuy({
      accountId,
      signal: env.signal,
      context: env.context,
      riskDecisionId: "risk-live-buy",
    });
    buyer.close();

    let clockMs = Date.parse(now);
    const clock = () => new Date(clockMs);
    const executor = liveExecutor(env.databasePath, {
      now: clock,
      marketDataProvider: new FakeLiveMarketDataProvider({
        now: clock,
        marketSnapshotTime: "2026-07-08T23:59:00.000Z",
        receivedAt: "2026-07-08T23:59:00.000Z",
      }),
    });
    const consumer = new LiveSignalConsumer(env.databasePath, executor, sourceVersion, clock);
    activateLiveGate(env.databasePath);
    let activated = false;
    const runner = new LiveRunner(executor, consumer, {
      accountId,
      intervalMs: 1_000,
      durationMs: 1_200,
      reconciliationEveryCycles: 100,
      now: clock,
      wait: async (milliseconds) => {
        clockMs += milliseconds;
        if (!activated) {
          activateLiveGate(env.databasePath);
          insertSignalAndRisk(env.databasePath, env.targetId, {
            signalId: "live-runner-blocked-by-stale-stop-check",
            riskDecisionId: "unused-runner-stale-stop-risk",
            decision: "ALLOW",
            capitalRatioPpm: "100000",
            createdAt: clock().toISOString(),
          });
          activated = true;
        }
      },
    });

    const report = await runner.run();

    expect(report).toMatchObject({
      stopLossExecutions: 0,
      stopLossUnsafeCycles: 1,
      skippedBuyCycles: 1,
      consumedSignals: 0,
      errors: [],
    });
    const db = new DatabaseSync(env.databasePath, { readOnly: true });
    expect((db.prepare(
      "SELECT count(*) count FROM live_signal_consumptions WHERE signal_id='live-runner-blocked-by-stale-stop-check'",
    ).get() as { count: number }).count).toBe(0);
    const audit = db.prepare(
      `SELECT reason,metadata_json FROM audit_log
       WHERE entity_type='LIVE_ACCOUNT' AND entity_id=?
         AND action='stop_loss_health_blocked_new_signals'
       ORDER BY timestamp DESC LIMIT 1`,
    ).get(accountId) as { reason: string; metadata_json: string };
    expect(audit.reason).toBe("STOP_LOSS_HEALTH_UNSAFE");
    expect(JSON.parse(audit.metadata_json)).toMatchObject({
      blockers: [{ reason: "ORDERBOOK_STALE" }],
    });
    db.close();
    consumer.close();
    executor.close();
  });

  it("keeps long-running error and settlement report details bounded while retaining total counts", async () => {
    const env = setup({ marketEndTime: "2026-07-09T00:00:01.000Z" });
    const buyer = liveExecutor(env.databasePath);
    await buyer.executeBuy({
      accountId,
      signal: env.signal,
      context: env.context,
      riskDecisionId: "risk-live-buy",
    });
    buyer.close();

    let clockMs = Date.parse("2026-07-09T00:00:02.000Z");
    const clock = () => new Date(clockMs);
    const executor = liveExecutor(env.databasePath, {
      now: clock,
      marketDataProvider: new FakeLiveMarketDataProvider({ now: clock }),
    });
    const consumer = new FailingLiveSignalConsumer(env.databasePath, executor, sourceVersion, clock);
    activateLiveGate(env.databasePath);
    let reactivated = false;
    const runner = new LiveRunner(executor, consumer, {
      accountId,
      intervalMs: 1_000,
      durationMs: 3_200,
      reconciliationEveryCycles: 100,
      reportDetailLimit: 2,
      now: clock,
      wait: async (milliseconds) => {
        clockMs += milliseconds;
        if (!reactivated) {
          activateLiveGate(env.databasePath);
          reactivated = true;
        }
      },
    });

    const report = await runner.run();

    expect(report).toMatchObject({
      cycles: 4,
      activeCycles: 3,
      errorCount: 3,
      droppedErrorCount: 1,
      settlementCounts: {
        pendingObservations: 4,
        resolvedObservations: 0,
        failureObservations: 0,
      },
    });
    expect(report.errors).toHaveLength(2);
    expect(report.errors.every((error) => error.operation === "CONSUME_TARGET_EXITS")).toBe(true);
    expect(report.settlements).toEqual({
      pendingPositionIds: [expect.any(String)],
      resolvedPositionIds: [],
      failures: [],
    });
    consumer.close();
    executor.close();
  });

  it("executes a BUY through fake signer/order adapter and writes order, fill, position, ledger and audit records", async () => {
    const env = setup();
    const executor = liveExecutor(env.databasePath);
    const result = await executor.executeBuy({ accountId, signal: env.signal, context: env.context, riskDecisionId: "risk-live-buy" });
    expect(result.state).toBe("EXECUTED");
    expect(count(env.databasePath, "live_orders")).toBe(1);
    expect(count(env.databasePath, "live_fills")).toBe(1);
    expect(count(env.databasePath, "live_positions")).toBe(1);
    expect(count(env.databasePath, "live_cash_ledger")).toBeGreaterThan(0);
    expect(count(env.databasePath, "live_reservation_ledger")).toBeGreaterThan(0);
    expect(count(env.databasePath, "live_fill_ledger")).toBe(1);
    expect(count(env.databasePath, "live_fee_ledger")).toBe(1);
    expect(count(env.databasePath, "live_state_transitions")).toBeGreaterThan(0);
    expect(count(env.databasePath, "audit_log")).toBeGreaterThan(0);
    const db = new DatabaseSync(env.databasePath);
    const reservation = db.prepare(
      "SELECT COALESCE(SUM(CAST(delta_micros AS INTEGER)),0) total FROM live_reservation_ledger WHERE live_execution_id=?",
    ).get(result.executionId) as { total: number };
    const reservedCash = db.prepare(
      "SELECT COALESCE(SUM(CAST(reserved_delta_micros AS INTEGER)),0) total FROM live_cash_ledger WHERE live_execution_id=?",
    ).get(result.executionId) as { total: number };
    const attempt = db.prepare(
      "SELECT status FROM live_order_attempts WHERE live_order_id=(SELECT live_order_id FROM live_orders WHERE live_execution_id=?)",
    ).get(result.executionId) as { status: string };
    const intent = db.prepare(
      `SELECT amount_micros,budget_micros,registered_wallet_address,authorized_signer_address,
              fee_rate_bps,fee_exponent,fee_model_version,signed_payload_json,
              order_request_sha256,ruleset_hash,source_code_commit,config_version
       FROM live_orders WHERE live_execution_id=?`,
    ).get(result.executionId) as Record<string, string | number>;
    expect(BigInt(reservation.total)).toBe(0n);
    expect(BigInt(reservedCash.total)).toBe(0n);
    expect(attempt.status).toBe("SUCCEEDED");
    expect(intent).toMatchObject({
      amount_micros: "5000000",
      budget_micros: "5000000",
      registered_wallet_address: wallet,
      authorized_signer_address: wallet,
      fee_rate_bps: "0",
      fee_exponent: 1,
      fee_model_version: VERSIONS.feeModelVersion,
      ruleset_hash: RULESET_HASH,
      source_code_commit: sourceVersion.commit,
      config_version: VERSIONS.configVersion,
    });
    expect(String(intent.signed_payload_json)).toContain("fake-signature");
    expect(String(intent.order_request_sha256)).toMatch(/^[0-9a-f]{64}$/);
    expect(() => db.prepare("UPDATE live_orders SET amount_micros='1' WHERE live_execution_id=?")
      .run(result.executionId)).toThrow("live_order intent is immutable");
    db.close();
    executor.close();
  });

  it("refuses an in-memory Signal or capital mutation even when IDs reuse an ALLOW Risk Decision", async () => {
    for (const signal of [
      (base: PaperSignalEnvelope) => ({ ...base, targetPriceUnits: "490000000000000000" }),
      (base: PaperSignalEnvelope) => ({
        ...base,
        capitalDecision: { ...base.capitalDecision!, ratioPpm: "999999" },
      }),
    ]) {
      const env = setup();
      const executor = liveExecutor(env.databasePath);
      const result = await executor.executeBuy({
        accountId,
        signal: signal(env.signal),
        context: env.context,
        riskDecisionId: "risk-live-buy",
      });
      expect(result.state).toBe("REJECTED");
      const db = new DatabaseSync(env.databasePath, { readOnly: true });
      expect((db.prepare("SELECT reason FROM live_executions WHERE live_execution_id=?")
        .get(result.executionId) as { reason: string }).reason)
        .toMatch(/SIGNAL_(?:IMMUTABLE_FIELDS|CAPITAL_DECISION)_MISMATCH/);
      expect((db.prepare("SELECT count(*) count FROM live_orders").get() as { count: number }).count).toBe(0);
      db.close();
      executor.close();
    }
  });

  it("supports partial fills", async () => {
    const env = setup();
    const executor = liveExecutor(env.databasePath, { orderAdapter: new FakeOrderAdapter({ fillRatioPpm: 500_000 }) });
    const result = await executor.executeBuy({ accountId, signal: env.signal, context: env.context, riskDecisionId: "risk-live-buy" });
    expect(result.state).toBe("PARTIALLY_EXECUTED");
    const db = new DatabaseSync(env.databasePath, { readOnly: true });
    const position = db.prepare("SELECT current_size_micros FROM live_positions").get() as { current_size_micros: string };
    expect(position.current_size_micros).toBe("5000000");
    const reservation = db.prepare(
      "SELECT COALESCE(SUM(CAST(delta_micros AS INTEGER)),0) total FROM live_reservation_ledger WHERE live_execution_id=?",
    ).get(result.executionId) as { total: number };
    expect(BigInt(reservation.total)).toBe(0n);
    db.close();
    executor.close();
  });

  it("keeps notional plus fee inside the immutable approved BUY budget", async () => {
    const env = setup();
    const executor = liveExecutor(env.databasePath, {
      signer: new FeeAwareFakeSigner(),
      orderAdapter: new FeeChargingOrderAdapter(),
    });
    const result = await executor.executeBuy({
      accountId,
      signal: env.signal,
      context: env.context,
      riskDecisionId: "risk-live-buy",
    });
    expect(result.state).toBe("EXECUTED");
    const db = new DatabaseSync(env.databasePath, { readOnly: true });
    const execution = db.prepare(
      `SELECT requested_amount_micros,filled_notional_micros,fee_micros
       FROM live_executions WHERE live_execution_id=?`,
    ).get(result.executionId) as {
      requested_amount_micros: string;
      filled_notional_micros: string;
      fee_micros: string;
    };
    const cashRows = db.prepare(
      "SELECT cash_delta_micros FROM live_cash_ledger WHERE live_execution_id=? AND entry_type='BUY_FILL'",
    ).all(result.executionId) as unknown as Array<{ cash_delta_micros: string }>;
    const reservationRows = db.prepare(
      "SELECT delta_micros FROM live_reservation_ledger WHERE live_execution_id=?",
    ).all(result.executionId) as unknown as Array<{ delta_micros: string }>;
    expect(execution).toEqual({
      requested_amount_micros: "5000000",
      filled_notional_micros: "4800000",
      fee_micros: "200000",
    });
    expect(cashRows.reduce((total, row) => total + BigInt(row.cash_delta_micros), 0n)).toBe(-5_000_000n);
    expect(reservationRows.reduce((total, row) => total + BigInt(row.delta_micros), 0n)).toBe(0n);
    db.close();
    executor.close();
  });

  it("rejects a signer that understates the independently derived non-zero fee", async () => {
    const env = setup();
    const executor = liveExecutor(env.databasePath, {
      signer: new UnderstatingFeeSigner(),
      marketDataProvider: new NonZeroFeeMarketDataProvider({ now: () => new Date(now) }),
    });
    const result = await executor.executeBuy({
      accountId,
      signal: env.signal,
      context: env.context,
      riskDecisionId: "risk-live-buy",
    });

    expect(result.state).toBe("FAILED");
    const db = new DatabaseSync(env.databasePath, { readOnly: true });
    const execution = db.prepare("SELECT reason FROM live_executions WHERE live_execution_id=?")
      .get(result.executionId) as { reason: string };
    expect(execution.reason).toContain("SIGNED_ORDER_MAX_COST_UNDERSTATES_DERIVED_FEE");
    expect((db.prepare("SELECT count(*) count FROM live_orders").get() as { count: number }).count).toBe(0);
    db.close();
    executor.close();
  });

  it("binds the runtime wallet provider and signer to the registered Live account", async () => {
    const other = "0x0000000000000000000000000000000000000002";
    for (const overrides of [
      { walletProvider: new FakeWalletProvider({ address: other }) },
      { signer: new FakeSigner(other) },
    ]) {
      const env = setup();
      const executor = liveExecutor(env.databasePath, overrides);
      const result = await executor.executeBuy({
        accountId,
        signal: env.signal,
        context: env.context,
        riskDecisionId: "risk-live-buy",
      });
      expect(result.state).toBe("REJECTED");
      const db = new DatabaseSync(env.databasePath, { readOnly: true });
      const execution = db.prepare("SELECT reason FROM live_executions WHERE live_execution_id=?")
        .get(result.executionId) as { reason: string };
      expect(execution.reason).toMatch(/(?:WALLET_PROVIDER|SIGNER)_ACCOUNT_MISMATCH/);
      expect((db.prepare("SELECT count(*) count FROM live_orders").get() as { count: number }).count).toBe(0);
      db.close();
      executor.close();
    }
  });

  it("rejects signer changes that exceed the approved size or BUY limit price", async () => {
    const mutations = [
      {
        reason: "SIGNED_ORDER_SIZE_EXCEEDS_EXECUTION_PLAN",
        signer: new MutatingFakeSigner((payload) => ({
          orderAmountMicros: String(payload.amountMicros),
          orderSizeMicros: (BigInt(String(payload.sizeMicros)) + 1n).toString(),
        })),
      },
      {
        reason: "SIGNED_ORDER_BUY_PRICE_EXCEEDS_LIMIT",
        signer: new MutatingFakeSigner((payload) => ({
          orderAmountMicros: String(payload.amountMicros),
          orderSizeMicros: (BigInt(String(payload.sizeMicros)) - 1n).toString(),
        })),
      },
    ];
    for (const mutation of mutations) {
      const env = setup();
      const executor = liveExecutor(env.databasePath, { signer: mutation.signer });
      const result = await executor.executeBuy({
        accountId,
        signal: env.signal,
        context: env.context,
        riskDecisionId: "risk-live-buy",
      });
      expect(result.state).toBe("FAILED");
      const db = new DatabaseSync(env.databasePath, { readOnly: true });
      const execution = db.prepare("SELECT reason FROM live_executions WHERE live_execution_id=?")
        .get(result.executionId) as { reason: string };
      expect(execution.reason).toContain(mutation.reason);
      expect((db.prepare("SELECT count(*) count FROM live_orders").get() as { count: number }).count).toBe(0);
      db.close();
      executor.close();
    }
  });

  it("records a failed submit attempt and releases the BUY reservation exactly once", async () => {
    const env = setup();
    const executor = liveExecutor(env.databasePath, { orderAdapter: new ThrowingOrderAdapter() });
    const result = await executor.executeBuy({ accountId, signal: env.signal, context: env.context, riskDecisionId: "risk-live-buy" });
    expect(result.state).toBe("FAILED");
    const db = new DatabaseSync(env.databasePath, { readOnly: true });
    const attempt = db.prepare("SELECT status,error_reason FROM live_order_attempts").get() as { status: string; error_reason: string };
    const reservation = db.prepare(
      "SELECT COALESCE(SUM(CAST(delta_micros AS INTEGER)),0) total FROM live_reservation_ledger WHERE live_execution_id=?",
    ).get(result.executionId) as { total: number };
    expect(attempt).toMatchObject({ status: "FAILED", error_reason: "TEST_SUBMIT_FAILED" });
    expect(BigInt(reservation.total)).toBe(0n);
    db.close();
    executor.close();
  });

  it("never retries or releases reservation when the external submit outcome is unknown", async () => {
    const env = setup();
    const executor = liveExecutor(env.databasePath, { orderAdapter: new UnknownSubmissionOutcomeAdapter() });
    const input = { accountId, signal: env.signal, context: env.context, riskDecisionId: "risk-live-buy" };
    const first = await executor.executeBuy(input);
    const second = await executor.executeBuy(input);
    expect(first.state).toBe("FROZEN");
    expect(second).toEqual(first);

    const db = new DatabaseSync(env.databasePath, { readOnly: true });
    const order = db.prepare("SELECT status,external_order_id FROM live_orders").get() as {
      status: string;
      external_order_id: string | null;
    };
    const reservation = db.prepare(
      "SELECT COALESCE(SUM(CAST(delta_micros AS INTEGER)),0) total FROM live_reservation_ledger",
    ).get() as { total: number };
    const attempts = db.prepare("SELECT count(*) count FROM live_order_attempts").get() as { count: number };
    expect(order).toEqual({ status: "SUBMITTED", external_order_id: null });
    expect(BigInt(reservation.total)).toBe(5_000_000n);
    expect(attempts.count).toBe(1);
    db.close();
    executor.close();
  });

  it("treats a submit timeout as outcome-unknown, freezes state and preserves reservation for reconciliation", async () => {
    const env = setup();
    activateLiveGate(env.databasePath);
    const executor = liveExecutor(env.databasePath, {
      orderAdapter: new HangingSubmissionAdapter(),
      externalCallTimeoutMs: 5,
    });
    const result = await executor.executeBuy({
      accountId,
      signal: env.signal,
      context: env.context,
      riskDecisionId: "risk-live-buy",
    });
    expect(result.state).toBe("FROZEN");
    const db = new DatabaseSync(env.databasePath, { readOnly: true });
    expect((db.prepare("SELECT execution_mode,live_gate_state FROM live_gate_state WHERE state_id='default'").get() as { execution_mode: string; live_gate_state: string }))
      .toEqual({ execution_mode: "PAPER", live_gate_state: "LIVE_DISABLED" });
    expect((db.prepare("SELECT status,confirmation_pending,is_terminal FROM live_orders").get() as { status: string; confirmation_pending: number; is_terminal: number }))
      .toEqual({ status: "SUBMITTED", confirmation_pending: 1, is_terminal: 0 });
    const reservation = db.prepare(
      "SELECT delta_micros FROM live_reservation_ledger WHERE live_execution_id=?",
    ).all(result.executionId) as unknown as Array<{ delta_micros: string }>;
    expect(reservation.reduce((sum, row) => sum + BigInt(row.delta_micros), 0n)).toBe(5_000_000n);
    expect((db.prepare("SELECT error_reason FROM live_order_attempts WHERE action='SUBMIT'").get() as { error_reason: string }).error_reason)
      .toContain("LIVE_EXTERNAL_TIMEOUT:SUBMIT_ORDER:5");
    db.close();
    executor.close();
  });

  it("freezes an externally identified order when FILLED has no trustworthy fills", async () => {
    const env = setup();
    const executor = liveExecutor(env.databasePath, { orderAdapter: new FilledWithoutFillsOrderAdapter() });
    const result = await executor.executeBuy({ accountId, signal: env.signal, context: env.context, riskDecisionId: "risk-live-buy" });
    expect(result.state).toBe("FROZEN");
    expect(count(env.databasePath, "live_fills")).toBe(0);
    expect(count(env.databasePath, "live_positions")).toBe(0);
    const db = new DatabaseSync(env.databasePath, { readOnly: true });
    const order = db.prepare("SELECT status,external_order_id FROM live_orders").get() as {
      status: string;
      external_order_id: string | null;
    };
    const reservation = db.prepare(
      "SELECT COALESCE(SUM(CAST(delta_micros AS INTEGER)),0) total FROM live_reservation_ledger",
    ).get() as { total: number };
    const gate = db.prepare("SELECT execution_mode,live_gate_state FROM live_gate_state WHERE state_id='default'")
      .get() as { execution_mode: string; live_gate_state: string };
    expect(order.status).toBe("SUBMITTED");
    expect(order.external_order_id).toBeTruthy();
    expect(BigInt(reservation.total)).toBe(5_000_000n);
    expect(gate).toEqual({ execution_mode: "PAPER", live_gate_state: "LIVE_DISABLED" });
    db.close();
    executor.close();
  });

  it("uses the Risk Decision approved BUY amount instead of the target wallet size", async () => {
    const env = setup();
    const approved = insertSignalAndRisk(env.databasePath, env.targetId, {
      signalId: "live-buy-approved-amount",
      riskDecisionId: "risk-live-buy-approved-amount",
      decision: "ALLOW",
      requestedAmountMicros: "2000000",
      requestedSizeMicros: null,
    });
    const executor = liveExecutor(env.databasePath);
    const result = await executor.executeBuy({
      accountId,
      signal: approved.signal,
      context: approved.context,
      riskDecisionId: "risk-live-buy-approved-amount",
    });
    expect(result.state).toBe("EXECUTED");
    const check = new DatabaseSync(env.databasePath, { readOnly: true });
    const order = check.prepare("SELECT size_micros,filled_notional_micros FROM live_orders").get() as {
      size_micros: string;
      filled_notional_micros: string;
    };
    expect(order.size_micros).toBe("4000000");
    expect(order.filled_notional_micros).toBe("2000000");
    check.close();
    executor.close();
  });

  it("uses the shared CLOB precision/minimum preflight before the fake Live order path", async () => {
    const env = setup();
    const approved = insertSignalAndRisk(env.databasePath, env.targetId, {
      signalId: "live-buy-below-clob-precision",
      riskDecisionId: "risk-live-buy-below-clob-precision",
      decision: "ALLOW",
      requestedAmountMicros: "974",
      requestedSizeMicros: null,
    });
    const executor = liveExecutor(env.databasePath, {
      marketDataProvider: new FakeLiveMarketDataProvider({
        now: () => new Date(now),
        minOrderSize: "5",
        tickSize: "0.01",
      }),
    });
    const result = await executor.executeBuy({
      accountId,
      signal: approved.signal,
      context: approved.context,
      riskDecisionId: "risk-live-buy-below-clob-precision",
    });
    expect(result.state).toBe("REJECTED");
    const check = new DatabaseSync(env.databasePath, { readOnly: true });
    expect(check.prepare("SELECT count(*) count FROM live_orders").get()).toEqual({ count: 0 });
    expect(check.prepare("SELECT state,reason FROM live_executions WHERE live_execution_id=?").get(result.executionId))
      .toEqual({ state: "REJECTED", reason: "ORDER_AMOUNT_BELOW_EXECUTOR_PRECISION" });
    expect(check.prepare(
      `SELECT entry_type,remaining_after_micros FROM live_reservation_ledger
       WHERE live_execution_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1`,
    ).get(result.executionId)).toEqual({ entry_type: "RELEASE", remaining_after_micros: "0" });
    check.close();
    executor.close();
  });

  it("fails closed before the fake Live adapter for an SDK-unsupported tick size", async () => {
    const env = setup();
    const approvedAmount = "5000000";
    const large = insertSignalAndRisk(env.databasePath, env.targetId, {
      signalId: "live-buy-large-integer",
      riskDecisionId: "risk-live-buy-large-integer",
      decision: "ALLOW",
      requestedAmountMicros: approvedAmount,
      requestedSizeMicros: null,
      targetPriceUnits: "1",
    });
    const executor = liveExecutor(env.databasePath, {
      orderAdapter: new SplitFillOrderAdapter(),
      marketDataProvider: new FakeLiveMarketDataProvider({
        now: () => new Date(now),
        minOrderSize: "1",
        tickSize: "0.000000000000000001",
        bids: [{ price: "0.000000000000000001", size: "10000000000000000000" }],
        asks: [{ price: "0.000000000000000001", size: "10000000000000000000" }],
      }),
    });
    const result = await executor.executeBuy({
      accountId,
      signal: large.signal,
      context: large.context,
      riskDecisionId: "risk-live-buy-large-integer",
    });

    expect(result.state).toBe("REJECTED");
    const check = new DatabaseSync(env.databasePath, { readOnly: true });
    expect(check.prepare(
      "SELECT state,reason FROM live_executions WHERE live_execution_id=?",
    ).get(result.executionId)).toEqual({
      state: "REJECTED",
      reason: "TICK_SIZE_UNSUPPORTED_BY_CLOB_SDK",
    });
    expect(check.prepare("SELECT count(*) count FROM live_orders").get()).toEqual({ count: 0 });
    check.close();
    executor.close();
  });

  it("rolls back and freezes the execution and positions when a SELL fill exceeds the local position", async () => {
    const env = setup();
    const executor = liveExecutor(env.databasePath);
    await executor.executeBuy({ accountId, signal: env.signal, context: env.context, riskDecisionId: "risk-live-buy" });
    const sell = insertSignalAndRisk(env.databasePath, env.targetId, {
      signalId: "live-sell-overfill",
      riskDecisionId: "risk-live-sell-overfill",
      decision: "ALLOW",
      signalType: "TARGET_SELL",
      sellRatioNumerator: "1",
      sellRatioDenominator: "1",
      requestedAmountMicros: null,
      requestedSizeMicros: "10000000",
    });
    executor.close();

    const overselling = liveExecutor(env.databasePath, { orderAdapter: new OversellingOrderAdapter() });
    const result = await overselling.executeSell({
      accountId,
      signal: sell.signal,
      context: sell.context,
      riskDecisionId: "risk-live-sell-overfill",
    });
    expect(result.state).toBe("FROZEN");
    const db = new DatabaseSync(env.databasePath, { readOnly: true });
    const position = db.prepare("SELECT status,current_size_micros FROM live_positions").get() as {
      status: string;
      current_size_micros: string;
    };
    const sellCash = db.prepare(
      "SELECT count(*) count FROM live_cash_ledger WHERE live_execution_id=? AND entry_type='SELL_FILL'",
    ).get(result.executionId) as { count: number };
    const sellFills = db.prepare("SELECT count(*) count FROM live_fills WHERE live_execution_id=?")
      .get(result.executionId) as { count: number };
    const sellOrder = db.prepare("SELECT status,external_order_id FROM live_orders WHERE live_execution_id=?")
      .get(result.executionId) as { status: string; external_order_id: string | null };
    const gate = db.prepare("SELECT execution_mode,live_gate_state FROM live_gate_state WHERE state_id='default'")
      .get() as { execution_mode: string; live_gate_state: string };
    expect(position).toEqual({ status: "FROZEN", current_size_micros: "10000000" });
    expect(sellCash.count).toBe(0);
    expect(sellFills.count).toBe(0);
    expect(sellOrder.status).toBe("SUBMITTED");
    expect(sellOrder.external_order_id).toBeTruthy();
    expect(gate).toEqual({ execution_mode: "PAPER", live_gate_state: "LIVE_DISABLED" });
    db.close();
    overselling.close();
  });

  it("allocates SELL proceeds and fee remainders exactly across multiple positions", async () => {
    const env = setup();
    const secondBuy = insertSignalAndRisk(env.databasePath, env.targetId, {
      signalId: "live-buy-second-position",
      riskDecisionId: "risk-live-buy-second-position",
      decision: "ALLOW",
    });
    const buyer = liveExecutor(env.databasePath);
    await buyer.executeBuy({ accountId, signal: env.signal, context: env.context, riskDecisionId: "risk-live-buy" });
    await buyer.executeBuy({
      accountId,
      signal: secondBuy.signal,
      context: secondBuy.context,
      riskDecisionId: "risk-live-buy-second-position",
    });
    buyer.close();
    const sell = insertSignalAndRisk(env.databasePath, env.targetId, {
      signalId: "live-sell-two-positions",
      riskDecisionId: "risk-live-sell-two-positions",
      decision: "ALLOW",
      signalType: "TARGET_SELL",
      requestedAmountMicros: null,
      requestedSizeMicros: "20000000",
    });
    const seller = liveExecutor(env.databasePath, { orderAdapter: new FeeChargingSellOrderAdapter() });
    const result = await seller.executeSell({
      accountId,
      signal: sell.signal,
      context: sell.context,
      riskDecisionId: "risk-live-sell-two-positions",
    });
    expect(result.state).toBe("EXECUTED");
    const db = new DatabaseSync(env.databasePath, { readOnly: true });
    const pnlRows = db.prepare(
      "SELECT proceeds_micros,fee_micros,pnl_micros FROM live_pnl_ledger WHERE live_execution_id=?",
    ).all(result.executionId) as unknown as Array<{
      proceeds_micros: string;
      fee_micros: string;
      pnl_micros: string;
    }>;
    expect(pnlRows).toHaveLength(2);
    expect(pnlRows.reduce((total, row) => total + BigInt(row.proceeds_micros), 0n)).toBe(10_000_000n);
    expect(pnlRows.reduce((total, row) => total + BigInt(row.fee_micros), 0n)).toBe(1n);
    expect(pnlRows.reduce((total, row) => total + BigInt(row.pnl_micros), 0n)).toBe(-1n);
    db.close();
    seller.close();
  });

  it("serializes concurrent SELL signals so one position cannot be sold twice", async () => {
    const env = setup();
    const buyer = liveExecutor(env.databasePath);
    await buyer.executeBuy({ accountId, signal: env.signal, context: env.context, riskDecisionId: "risk-live-buy" });
    buyer.close();
    const firstSell = insertSignalAndRisk(env.databasePath, env.targetId, {
      signalId: "live-sell-concurrent-1",
      riskDecisionId: "risk-live-sell-concurrent-1",
      decision: "ALLOW",
      signalType: "TARGET_SELL",
      requestedAmountMicros: null,
      requestedSizeMicros: "10000000",
    });
    const secondSell = insertSignalAndRisk(env.databasePath, env.targetId, {
      signalId: "live-sell-concurrent-2",
      riskDecisionId: "risk-live-sell-concurrent-2",
      decision: "ALLOW",
      signalType: "TARGET_SELL",
      requestedAmountMicros: null,
      requestedSizeMicros: "10000000",
    });
    const adapter = new CountingOrderAdapter();
    const seller = liveExecutor(env.databasePath, { orderAdapter: adapter });
    const results = await Promise.allSettled([
      seller.executeSell({
        accountId,
        signal: firstSell.signal,
        context: firstSell.context,
        riskDecisionId: "risk-live-sell-concurrent-1",
      }),
      seller.executeSell({
        accountId,
        signal: secondSell.signal,
        context: secondSell.context,
        riskDecisionId: "risk-live-sell-concurrent-2",
      }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(String(rejected?.reason)).toContain("LIVE_ASSET_RESERVATION_LOCAL_POSITION_INSUFFICIENT");
    expect(adapter.submitCount).toBe(1);
    const db = new DatabaseSync(env.databasePath, { readOnly: true });
    const reservationRows = db.prepare("SELECT delta_size_micros FROM live_asset_reservation_ledger")
      .all() as unknown as Array<{ delta_size_micros: string }>;
    expect(reservationRows.reduce((total, row) => total + BigInt(row.delta_size_micros), 0n)).toBe(0n);
    db.close();
    seller.close();
  });

  it("does not duplicate execution or fills for the same signal and risk decision", async () => {
    const env = setup();
    const executor = liveExecutor(env.databasePath);
    const input = { accountId, signal: env.signal, context: env.context, riskDecisionId: "risk-live-buy" };
    const first = await executor.executeBuy(input);
    const second = await executor.executeBuy(input);
    expect(second.executionId).toBe(first.executionId);
    expect(count(env.databasePath, "live_fills")).toBe(1);
    expect(count(env.databasePath, "live_positions")).toBe(1);
    executor.close();
  });

  it("consumes one Signal only once even if a second ALLOW Risk Decision is created", async () => {
    const env = setup();
    cloneRiskDecision(env.databasePath, "risk-live-buy", "risk-live-buy-second");
    const adapter = new CountingOrderAdapter();
    const executor = liveExecutor(env.databasePath, { orderAdapter: adapter });
    const first = await executor.executeBuy({
      accountId,
      signal: env.signal,
      context: env.context,
      riskDecisionId: "risk-live-buy",
    });
    const second = await executor.executeBuy({
      accountId,
      signal: env.signal,
      context: env.context,
      riskDecisionId: "risk-live-buy-second",
    });
    expect(second).toEqual(first);
    expect(adapter.submitCount).toBe(1);
    expect(count(env.databasePath, "live_executions")).toBe(1);
    expect(count(env.databasePath, "live_orders")).toBe(1);
    executor.close();
  });

  it("serializes concurrent consumption and submits the external order exactly once", async () => {
    const env = setup();
    const adapter = new CountingOrderAdapter();
    const executor = liveExecutor(env.databasePath, { orderAdapter: adapter });
    const input = { accountId, signal: env.signal, context: env.context, riskDecisionId: "risk-live-buy" };
    const [first, second] = await Promise.all([executor.executeBuy(input), executor.executeBuy(input)]);
    expect(second.executionId).toBe(first.executionId);
    expect(adapter.submitCount).toBe(1);
    expect(count(env.databasePath, "live_orders")).toBe(1);
    executor.close();
  });

  it("rolls back execution, order and reservation together when the atomic capital invariant fails", async () => {
    const env = setup();
    const oversized = insertSignalAndRisk(env.databasePath, env.targetId, {
      signalId: "live-buy-oversized-atomic",
      riskDecisionId: "risk-live-buy-oversized-atomic",
      decision: "ALLOW",
      requestedAmountMicros: "200000001",
      requestedSizeMicros: null,
    });
    const executor = liveExecutor(env.databasePath, {
      walletProvider: new FakeWalletProvider({ balanceMicros: "1000000000", allowanceMicros: "1000000000" }),
    });
    await expect(executor.executeBuy({
      accountId,
      signal: oversized.signal,
      context: oversized.context,
      riskDecisionId: "risk-live-buy-oversized-atomic",
    })).rejects.toThrow("LIVE_RESERVATION_SINGLE_TRADE_LIMIT");
    const db = new DatabaseSync(env.databasePath, { readOnly: true });
    const executions = db.prepare("SELECT count(*) count FROM live_executions WHERE signal_id=?")
      .get(oversized.signal.signalId) as { count: number };
    expect(executions.count).toBe(0);
    expect(count(env.databasePath, "live_orders")).toBe(0);
    expect(count(env.databasePath, "live_reservation_ledger")).toBe(0);
    db.close();
    executor.close();
  });

  it("uses the operator-approved limits in the transactional reservation guard", () => {
    const env = setup();
    const approved = insertSignalAndRisk(env.databasePath, env.targetId, {
      signalId: "live-buy-operator-reservation-limit",
      riskDecisionId: "risk-live-buy-operator-reservation-limit",
      decision: "ALLOW",
      requestedAmountMicros: "250000000",
      requestedSizeMicros: null,
    });
    const database = new DatabaseSync(env.databasePath);
    const store = new LiveStore(database, sourceVersion, () => new Date(now), {
      maxTradeSizeMicros: "300000000",
      maxExposureMicros: "500000000",
      maxDailyLossMicros: "100000000",
    });

    store.transaction(() => {
      const execution = store.createExecution({
        liveAccountId: accountId,
        signalId: approved.signal.signalId,
        contextId: approved.context.contextId,
        riskDecisionId: "risk-live-buy-operator-reservation-limit",
        liveGateRunId: null,
        executionIdempotencyKey: "LIVE_EXECUTION:operator-reservation-limit",
        executionType: "TARGET_BUY",
        state: "WAITING_EXECUTION",
        assetId,
        conditionId,
        requestedAmountMicros: "250000000",
        requestedSizeMicros: null,
        targetPriceUnits: approved.signal.targetPriceUnits,
        reason: "TEST_OPERATOR_LIMIT",
        rulesetHash: RULESET_HASH,
      });
      store.reserveChecked(execution, 250_000_000n, {
        walletBalanceMicros: 1_000_000_000n,
        walletAllowanceMicros: 1_000_000_000n,
      });
    });

    expect(database.prepare(
      "SELECT SUM(delta_micros) reserved FROM live_reservation_ledger",
    ).get()).toEqual({ reserved: 250_000_000 });
    database.close();
  });

  it("blocks when allowance is insufficient and does not approve", async () => {
    const env = setup();
    const executor = liveExecutor(env.databasePath, {
      walletProvider: new FakeWalletProvider({ balanceMicros: "1000000000", allowanceMicros: "1" }),
    });
    const result = await executor.executeBuy({ accountId, signal: env.signal, context: env.context, riskDecisionId: "risk-live-buy" });
    expect(result.state).toBe("REJECTED");
    const db = new DatabaseSync(env.databasePath, { readOnly: true });
    const reason = (db.prepare("SELECT reason FROM live_executions WHERE live_execution_id=?").get(result.executionId) as { reason: string }).reason;
    expect(reason).toBe("ALLOWANCE_INSUFFICIENT");
    expect(count(env.databasePath, "live_orders")).toBe(0);
    db.close();
    executor.close();
  });

  it("checks outcome-token balance and allowance before a SELL", async () => {
    const env = setup();
    const buyer = liveExecutor(env.databasePath);
    await buyer.executeBuy({ accountId, signal: env.signal, context: env.context, riskDecisionId: "risk-live-buy" });
    buyer.close();
    const sell = insertSignalAndRisk(env.databasePath, env.targetId, {
      signalId: "live-sell-token-check",
      riskDecisionId: "risk-live-sell-token-check",
      decision: "ALLOW",
      signalType: "TARGET_SELL",
      requestedAmountMicros: null,
      requestedSizeMicros: "10000000",
    });
    const adapter = new CountingOrderAdapter();
    const seller = liveExecutor(env.databasePath, {
      orderAdapter: adapter,
      walletProvider: new FakeWalletProvider({ outcomeBalanceMicros: "1", outcomeAllowanceMicros: "10000000" }),
    });
    const result = await seller.executeSell({
      accountId,
      signal: sell.signal,
      context: sell.context,
      riskDecisionId: "risk-live-sell-token-check",
    });
    expect(result.state).toBe("REJECTED");
    expect(adapter.submitCount).toBe(0);
    const db = new DatabaseSync(env.databasePath, { readOnly: true });
    const row = db.prepare("SELECT reason FROM live_executions WHERE live_execution_id=?")
      .get(result.executionId) as { reason: string };
    expect(row.reason).toBe("OUTCOME_BALANCE_INSUFFICIENT");
    db.close();
    seller.close();
  });

  it("blocks execution when live reconciliation fails", async () => {
    const env = setup();
    const db = new DatabaseSync(env.databasePath);
    db.prepare(
      `INSERT INTO live_executions(
        live_execution_id,live_account_id,signal_id,context_id,risk_decision_id,live_gate_run_id,
        execution_idempotency_key,execution_type,state,asset_id,condition_id,requested_amount_micros,
        requested_size_micros,filled_size_micros,filled_notional_micros,fee_micros,target_price_units,
        reason,schema_version,strategy_version,risk_version,live_version,ruleset_hash,source_code_commit,
        source_code_dirty,config_version,created_at,updated_at
      ) VALUES ('bad-live-exec', ?, NULL, NULL, 'risk-live-buy', NULL, 'bad-key', 'TARGET_BUY', 'EXECUTED',
        ?, ?, '1', '1', '0', '0', '0', '1', 'BAD', ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    ).run(accountId, assetId, conditionId, VERSIONS.schemaVersion, VERSIONS.strategyVersion, VERSIONS.riskVersion, VERSIONS.liveVersion, RULESET_HASH, sourceVersion.commit, VERSIONS.configVersion, now, now);
    db.prepare(
      `INSERT INTO live_orders(
        live_order_id,live_execution_id,live_order_idempotency_key,external_order_id,market_id,asset_id,
        condition_id,side,order_type,price_units,size_micros,filled_size_micros,filled_notional_micros,
        fee_micros,status,adapter_type,raw_response_json,created_at,updated_at
      ) VALUES ('bad-order','bad-live-exec','bad-order-key','external-bad',?, ?, ?, 'BUY','FAK','1','1','1','0','0','FILLED','FAKE','{}',?, ?)`,
    ).run(conditionId, assetId, conditionId, now, now);
    db.close();
    activateLiveGate(env.databasePath);
    const executor = liveExecutor(env.databasePath);
    const result = await executor.executeBuy({ accountId, signal: env.signal, context: env.context, riskDecisionId: "risk-live-buy" });
    expect(result.state).toBe("REJECTED");
    const check = new DatabaseSync(env.databasePath, { readOnly: true });
    const reason = (check.prepare("SELECT reason FROM live_executions WHERE live_execution_id=?").get(result.executionId) as { reason: string }).reason;
    const gate = check.prepare("SELECT execution_mode,live_gate_state,state_reason FROM live_gate_state WHERE state_id='default'")
      .get() as { execution_mode: string; live_gate_state: string; state_reason: string };
    expect(reason).toBe("LIVE_RECONCILIATION_FAILED");
    expect(gate).toMatchObject({ execution_mode: "PAPER", live_gate_state: "LIVE_DISABLED" });
    expect(gate.state_reason).toContain("LIVE_RECONCILIATION_FAILED");
    check.close();
    executor.close();
  });

  it("retries one transient read-only reconciliation timeout without disabling Live", async () => {
    const env = setup();
    activateLiveGate(env.databasePath);
    const adapter = new TimeoutOnceOpenOrdersAdapter();
    const executor = liveExecutor(env.databasePath, {
      orderAdapter: adapter,
      externalCallTimeoutMs: 5,
    });
    const result = await executor.reconcile({
      accountId,
      reason: "TEST_TRANSIENT_EXTERNAL_TIMEOUT",
    });
    expect(result).toMatchObject({
      mode: "LIVE",
      frozenPositionCount: 0,
      reason: "LIVE_RECONCILED",
    });
    expect(adapter.openOrderReads).toBe(2);
    const db = new DatabaseSync(env.databasePath, { readOnly: true });
    expect(db.prepare(
      "SELECT execution_mode,live_gate_state FROM live_gate_state WHERE state_id='default'",
    ).get()).toEqual({ execution_mode: "LIVE", live_gate_state: "LIVE_ACTIVE" });
    db.close();
    executor.close();
  });

  it("still disables Live after repeated read-only reconciliation timeouts", async () => {
    const env = setup();
    activateLiveGate(env.databasePath);
    const adapter = new HangingOpenOrdersAdapter();
    const executor = liveExecutor(env.databasePath, {
      orderAdapter: adapter,
      externalCallTimeoutMs: 5,
    });
    const result = await executor.reconcile({
      accountId,
      reason: "TEST_REPEATED_EXTERNAL_TIMEOUT",
    });
    expect(result.reason).toBe("LIVE_RECONCILIATION_FAILED");
    expect(adapter.openOrderReads).toBe(2);
    const db = new DatabaseSync(env.databasePath, { readOnly: true });
    expect(db.prepare(
      "SELECT execution_mode,live_gate_state FROM live_gate_state WHERE state_id='default'",
    ).get()).toEqual({ execution_mode: "PAPER", live_gate_state: "LIVE_DISABLED" });
    db.close();
    executor.close();
  });

  it("recovers an externally-filled order into fills, position, ledger and checkpoint exactly once", async () => {
    const env = setup();
    const adapter = new DeferredRecoveryOrderAdapter();
    const executor = liveExecutor(env.databasePath, { orderAdapter: adapter });
    const execution = await executor.executeBuy({
      accountId,
      signal: env.signal,
      context: env.context,
      riskDecisionId: "risk-live-buy",
    });
    expect(execution.state).toBe("WAITING_EXECUTION");
    expect(count(env.databasePath, "live_fills")).toBe(0);

    adapter.complete();
    const first = await executor.recoverOnStartup(accountId);
    const second = await executor.recoverOnStartup(accountId);
    expect(first).toMatchObject({ passed: true, reason: "RECOVERY_RECONCILED" });
    expect(second).toMatchObject({ passed: true, reason: "RECOVERY_RECONCILED" });

    const db = new DatabaseSync(env.databasePath, { readOnly: true });
    const localExecution = db.prepare("SELECT state,filled_size_micros FROM live_executions WHERE live_execution_id=?")
      .get(execution.executionId) as { state: string; filled_size_micros: string };
    const order = db.prepare("SELECT status,filled_size_micros FROM live_orders WHERE live_execution_id=?")
      .get(execution.executionId) as { status: string; filled_size_micros: string };
    const checkpoint = db.prepare("SELECT last_fill_id,last_order_id FROM live_execution_checkpoints WHERE live_account_id=?")
      .get(accountId) as { last_fill_id: string | null; last_order_id: string | null };
    const reservation = db.prepare(
      "SELECT COALESCE(SUM(CAST(delta_micros AS INTEGER)),0) total FROM live_reservation_ledger WHERE live_execution_id=?",
    ).get(execution.executionId) as { total: number };
    expect(localExecution).toEqual({ state: "EXECUTED", filled_size_micros: "10000000" });
    expect(order).toEqual({ status: "FILLED", filled_size_micros: "10000000" });
    expect(checkpoint.last_fill_id).toBeTruthy();
    expect(checkpoint.last_order_id).toBeTruthy();
    expect(BigInt(reservation.total)).toBe(0n);
    expect(count(env.databasePath, "live_fills")).toBe(1);
    expect(count(env.databasePath, "live_positions")).toBe(1);
    expect(count(env.databasePath, "live_fill_ledger")).toBe(1);
    expect(count(env.databasePath, "live_recovery_runs")).toBe(2);
    db.close();
    executor.close();
  });

  it("fails closed when a recoverable external order lacks immutable intent evidence", async () => {
    const env = setup();
    const adapter = new DeferredRecoveryOrderAdapter();
    const executor = liveExecutor(env.databasePath, { orderAdapter: adapter });
    const execution = await executor.executeBuy({
      accountId,
      signal: env.signal,
      context: env.context,
      riskDecisionId: "risk-live-buy",
    });
    expect(execution.state).toBe("WAITING_EXECUTION");
    const database = new DatabaseSync(env.databasePath);
    database.exec("DROP TRIGGER live_orders_immutable_intent_no_update");
    database.prepare("UPDATE live_orders SET order_request_sha256=NULL WHERE live_execution_id=?")
      .run(execution.executionId);
    database.close();

    const recovery = await executor.recoverOnStartup(accountId);
    expect(recovery.passed).toBe(false);
    expect(recovery.reason).toContain("RECOVERY_ORDER_INTENT_EVIDENCE_MISSING");
    const check = new DatabaseSync(env.databasePath, { readOnly: true });
    expect((check.prepare("SELECT state FROM live_executions WHERE live_execution_id=?")
      .get(execution.executionId) as { state: string }).state).toBe("FROZEN");
    check.close();
    executor.close();
  });

  it("fails closed when immutable order intent evidence is tampered before recovery", async () => {
    const env = setup();
    const adapter = new DeferredRecoveryOrderAdapter();
    const executor = liveExecutor(env.databasePath, { orderAdapter: adapter });
    const execution = await executor.executeBuy({
      accountId,
      signal: env.signal,
      context: env.context,
      riskDecisionId: "risk-live-buy",
    });
    expect(execution.state).toBe("WAITING_EXECUTION");

    const database = new DatabaseSync(env.databasePath);
    database.exec("DROP TRIGGER live_orders_immutable_intent_no_update");
    database.prepare("UPDATE live_orders SET amount_micros='1' WHERE live_execution_id=?")
      .run(execution.executionId);
    database.close();

    const recovery = await executor.recoverOnStartup(accountId);
    expect(recovery.passed).toBe(false);
    expect(recovery.reason).toContain("RECOVERY_ORDER_INTENT_HASH_MISMATCH");
    const check = new DatabaseSync(env.databasePath, { readOnly: true });
    expect((check.prepare("SELECT state FROM live_executions WHERE live_execution_id=?")
      .get(execution.executionId) as { state: string }).state).toBe("FROZEN");
    check.close();
    executor.close();
  });

  it("keeps a recovered fully-filled FAK child BUY partial when it did not consume the approved budget", async () => {
    const env = setup();
    const adapter = new DeferredRecoveryOrderAdapter();
    const executor = liveExecutor(env.databasePath, {
      orderAdapter: adapter,
      marketDataProvider: new FakeLiveMarketDataProvider({
        now: () => new Date(now),
        asks: [{ price: "0.5", size: "5" }],
      }),
    });
    const execution = await executor.executeBuy({
      accountId,
      signal: env.signal,
      context: env.context,
      riskDecisionId: "risk-live-buy",
    });
    expect(execution.state).toBe("WAITING_EXECUTION");

    let database = new DatabaseSync(env.databasePath, { readOnly: true });
    expect(database.prepare(
      "SELECT size_micros,buy_budget_complete FROM live_orders WHERE live_execution_id=?",
    ).get(execution.executionId)).toEqual({ size_micros: "5000000", buy_budget_complete: 0 });
    database.close();

    adapter.complete();
    const recovery = await executor.recoverOnStartup(accountId);
    expect(recovery).toMatchObject({ passed: true, reason: "RECOVERY_RECONCILED" });

    database = new DatabaseSync(env.databasePath);
    expect(database.prepare(
      "SELECT state,filled_size_micros FROM live_executions WHERE live_execution_id=?",
    ).get(execution.executionId)).toEqual({ state: "PARTIALLY_EXECUTED", filled_size_micros: "5000000" });
    expect(database.prepare(
      "SELECT current_size_micros FROM live_positions WHERE opening_execution_id=?",
    ).get(execution.executionId)).toEqual({ current_size_micros: "5000000" });
    expect(() => database.prepare(
      "UPDATE live_orders SET buy_budget_complete=1 WHERE live_execution_id=?",
    ).run(execution.executionId)).toThrow("live_order buy_budget_complete is immutable");
    database.close();
    executor.close();
  });

  it.each([
    {
      name: "notional mismatch",
      fill: { notionalMicros: "1" },
      reason: "ORDER_FILL_NOTIONAL_MISMATCH",
    },
    {
      name: "BUY limit breach",
      fill: { priceUnits: "600000000000000000", notionalMicros: "6000000" },
      reason: "BUY_FILL_LIMIT_PRICE_BREACH",
    },
    {
      name: "BUY risk budget breach",
      fill: { feeMicros: "1" },
      reason: "BUY_FILL_EXCEEDS_RISK_BUDGET",
    },
  ])("rejects a recovered fill with $name before writing any financial ledger", async ({ fill, reason }) => {
    const env = setup();
    const adapter = new DeferredRecoveryOrderAdapter();
    const executor = liveExecutor(env.databasePath, { orderAdapter: adapter });
    const execution = await executor.executeBuy({
      accountId,
      signal: env.signal,
      context: env.context,
      riskDecisionId: "risk-live-buy",
    });
    expect(execution.state).toBe("WAITING_EXECUTION");
    adapter.complete(fill);

    const recovery = await executor.recoverOnStartup(accountId);

    expect(recovery).toMatchObject({ passed: false, reason });
    const db = new DatabaseSync(env.databasePath, { readOnly: true });
    expect((db.prepare("SELECT count(*) count FROM live_fills").get() as { count: number }).count).toBe(0);
    expect((db.prepare("SELECT count(*) count FROM live_fill_ledger").get() as { count: number }).count).toBe(0);
    expect((db.prepare("SELECT count(*) count FROM live_positions").get() as { count: number }).count).toBe(0);
    expect((db.prepare(
      "SELECT state FROM live_executions WHERE live_execution_id=?",
    ).get(execution.executionId) as { state: string }).state).toBe("FROZEN");
    db.close();
    executor.close();
  });

  it("reports pending Live BUY reservations instead of overstating available balance", async () => {
    const env = setup();
    const executor = liveExecutor(env.databasePath, { orderAdapter: new DeferredRecoveryOrderAdapter() });
    const execution = await executor.executeBuy({
      accountId,
      signal: env.signal,
      context: env.context,
      riskDecisionId: "risk-live-buy",
    });
    expect(execution.state).toBe("WAITING_EXECUTION");
    const balance = await executor.getBalance({ accountId });
    expect(balance).toMatchObject({
      initialBalanceMicros: "1000000000",
      cashBalanceMicros: "1000000000",
      reservedBalanceMicros: "5000000",
      availableBalanceMicros: "995000000",
    });
    executor.close();
  });

  it("values Live positions only from fresh full-depth exit VWAP and records an immutable PnL snapshot", async () => {
    const env = setup();
    const buyer = liveExecutor(env.databasePath);
    await buyer.executeBuy({ accountId, signal: env.signal, context: env.context, riskDecisionId: "risk-live-buy" });
    buyer.close();
    const valuation = liveExecutor(env.databasePath, {
      marketDataProvider: new FakeLiveMarketDataProvider({
        now: () => new Date(now),
        bids: [{ price: "0.4", size: "1000" }],
      }),
    });
    expect(await valuation.getBalance({ accountId })).toMatchObject({
      cashBalanceMicros: "1000000000",
      positionValueMicros: "4000000",
      realizedPnlMicros: "0",
      unrealizedPnlMicros: "-1000000",
      totalEquityMicros: "1004000000",
      valuationStatus: "COMPLETE",
      unpricedPositionCount: 0,
      priceSource: "ORDERBOOK_EXIT_VWAP",
    });
    const db = new DatabaseSync(env.databasePath);
    const snapshot = db.prepare(
      `SELECT position_value_micros,unrealized_pnl_micros,valuation_status,
              unpriced_position_count,price_source
       FROM live_valuation_snapshots`,
    ).get() as Record<string, string | number>;
    expect(snapshot).toEqual({
      position_value_micros: "4000000",
      unrealized_pnl_micros: "-1000000",
      valuation_status: "COMPLETE",
      unpriced_position_count: 0,
      price_source: "ORDERBOOK_EXIT_VWAP",
    });
    expect(() => db.prepare("UPDATE live_valuation_snapshots SET valuation_status='INCOMPLETE'").run())
      .toThrow("live_valuation_snapshots is immutable");
    db.close();
    valuation.close();
  });

  it("marks Live valuation incomplete instead of using Last Price when full exit depth is unavailable", async () => {
    const env = setup();
    const buyer = liveExecutor(env.databasePath);
    await buyer.executeBuy({ accountId, signal: env.signal, context: env.context, riskDecisionId: "risk-live-buy" });
    buyer.close();
    const valuation = liveExecutor(env.databasePath, {
      marketDataProvider: new FakeLiveMarketDataProvider({
        now: () => new Date(now),
        bids: [{ price: "0.4", size: "1" }],
      }),
    });
    expect(await valuation.getBalance({ accountId })).toMatchObject({
      positionValueMicros: "0",
      unrealizedPnlMicros: "0",
      valuationStatus: "INCOMPLETE",
      unpricedPositionCount: 1,
    });
    valuation.close();
  });

  it("generates an INCOMPLETE valuation snapshot when the external wallet balance is unavailable", async () => {
    const env = setup();
    const valuation = liveExecutor(env.databasePath, {
      walletProvider: new ThrowingBalanceWalletProvider(),
    });

    expect(await valuation.getBalance({ accountId })).toMatchObject({
      cashBalanceMicros: "0",
      valuationStatus: "INCOMPLETE",
      unpricedPositionCount: 0,
    });
    const db = new DatabaseSync(env.databasePath, { readOnly: true });
    const row = db.prepare(
      "SELECT valuation_status,position_evidence_json FROM live_valuation_snapshots",
    ).get() as { valuation_status: string; position_evidence_json: string };
    expect(row.valuation_status).toBe("INCOMPLETE");
    expect(JSON.parse(row.position_evidence_json)).toContainEqual(expect.objectContaining({
      evidenceType: "WALLET_BALANCE",
      status: "UNAVAILABLE",
      reason: "TEST_BALANCE_NETWORK_DOWN",
    }));
    db.close();
    valuation.close();
  });

  it("safely abandons a crash-persisted order intent that never crossed the submit boundary", async () => {
    const env = setup();
    const database = new DatabaseSync(env.databasePath);
    const store = new LiveStore(database, sourceVersion, () => new Date(now));
    const executionKey = "LIVE_EXECUTION:crash-before-submit";
    store.transaction(() => {
      const execution = store.createExecution({
        liveAccountId: accountId,
        signalId: env.signal.signalId,
        contextId: env.context.contextId,
        riskDecisionId: "risk-live-buy",
        liveGateRunId: null,
        executionIdempotencyKey: executionKey,
        executionType: "TARGET_BUY",
        state: "WAITING_EXECUTION",
        assetId,
        conditionId,
        requestedAmountMicros: "5000000",
        requestedSizeMicros: "10000000",
        targetPriceUnits: "500000000000000000",
        reason: "TEST_CRASH_BEFORE_SUBMIT",
        rulesetHash: RULESET_HASH,
      });
      const orderInput = {
        liveOrderId: "live-order-crash-before-submit",
        idempotencyKey: "live-order-crash-before-submit-key",
        marketId: conditionId,
        conditionId,
        assetId,
        side: "BUY",
        orderType: "FAK",
        priceUnits: "500000000000000000",
        quoteVwapPriceUnits: "500000000000000000",
        sizeMicros: "10000000",
        amountMicros: "5000000",
        budgetMicros: "5000000",
        registeredWalletAddress: wallet,
        authorizedSignerAddress: wallet,
        feeRateBps: "0",
        feeExponent: 1,
        feeModelVersion: VERSIONS.feeModelVersion,
        signedPayload: null,
      } as const;
      expect(store.createOrder(orderInput, execution.live_execution_id, "FAKE", true)).toBe(true);
      expect(store.createOrder(orderInput, execution.live_execution_id, "FAKE", true)).toBe(false);
      store.reserveChecked(execution, 5_000_000n, {
        walletBalanceMicros: 1_000_000_000n,
        walletAllowanceMicros: 1_000_000_000n,
      });
    });
    expect((database.prepare("SELECT count(*) count FROM live_orders").get() as { count: number }).count).toBe(1);
    expect((database.prepare("SELECT attempt_count FROM live_executions WHERE execution_idempotency_key=?")
      .get(executionKey) as { attempt_count: number }).attempt_count).toBe(1);
    database.close();

    const executor = liveExecutor(env.databasePath);
    const recovery = await executor.recoverOnStartup(accountId);
    expect(recovery).toMatchObject({ passed: true, reason: "RECOVERY_RECONCILED" });
    const check = new DatabaseSync(env.databasePath, { readOnly: true });
    const order = check.prepare("SELECT status,external_order_id FROM live_orders WHERE live_order_id=?")
      .get("live-order-crash-before-submit") as { status: string; external_order_id: string | null };
    const execution = check.prepare("SELECT state FROM live_executions WHERE execution_idempotency_key=?")
      .get(executionKey) as { state: string };
    const reservationRows = check.prepare(
      "SELECT delta_micros FROM live_reservation_ledger WHERE live_execution_id=(SELECT live_execution_id FROM live_orders WHERE live_order_id=?)",
    ).all("live-order-crash-before-submit") as unknown as Array<{ delta_micros: string }>;
    expect(order).toEqual({ status: "FAILED", external_order_id: null });
    expect(execution.state).toBe("FAILED");
    expect(reservationRows.reduce((total, row) => total + BigInt(row.delta_micros), 0n)).toBe(0n);
    check.close();
    executor.close();
  });

  it("fails closed when recovery discovers an external open order that has no local intent", async () => {
    const env = setup();
    const executor = liveExecutor(env.databasePath, { orderAdapter: new UnknownExternalOrderAdapter() });
    const recovery = await executor.recoverOnStartup(accountId);
    expect(recovery.passed).toBe(false);
    expect(recovery.reason).toContain("EXTERNAL_ORDER_NOT_LOCAL");
    const db = new DatabaseSync(env.databasePath, { readOnly: true });
    const run = db.prepare("SELECT status,reason FROM live_recovery_runs ORDER BY created_at DESC LIMIT 1")
      .get() as { status: string; reason: string };
    expect(run.status).toBe("FAILED");
    expect(run.reason).toContain("EXTERNAL_ORDER_NOT_LOCAL");
    db.close();
    executor.close();
  });

  it("fails closed when external outcome-token balances drift from local Live positions", async () => {
    const env = setup();
    const buyer = liveExecutor(env.databasePath);
    await buyer.executeBuy({ accountId, signal: env.signal, context: env.context, riskDecisionId: "risk-live-buy" });
    buyer.close();

    const checker = liveExecutor(env.databasePath, {
      walletProvider: new FakeWalletProvider({ outcomePositions: { [assetId]: "9999999" } }),
      requireExternalPositionReconciliation: true,
    });
    const recovery = await checker.recoverOnStartup(accountId);
    expect(recovery.passed).toBe(false);
    expect(recovery.reason).toContain("RECOVERY_RECONCILIATION_FAILED");
    const db = new DatabaseSync(env.databasePath, { readOnly: true });
    const check = db.prepare(
      `SELECT checks_json FROM live_reconciliation_runs
       WHERE live_account_id=? AND checks_json LIKE '%EXTERNAL_WALLET_POSITION_MISMATCH%'
       LIMIT 1`,
    ).get(accountId) as { checks_json: string } | undefined;
    expect(check?.checks_json).toContain("EXTERNAL_WALLET_POSITION_MISMATCH");
    db.close();
    checker.close();
  });

  it("captures pre-existing wallet positions as an immutable baseline for a pristine Live account", async () => {
    const env = setup();
    const legacyAssetId = "legacy-wallet-asset";
    const initial = liveExecutor(env.databasePath, {
      walletProvider: new FakeWalletProvider({
        outcomePositions: { [legacyAssetId]: "8521100" },
      }),
      requireExternalPositionReconciliation: true,
    });

    await expect(initial.recoverOnStartup(accountId)).resolves.toMatchObject({
      passed: true,
      reason: "RECOVERY_RECONCILED",
    });
    initial.close();

    const baselineDatabase = new DatabaseSync(env.databasePath, { readOnly: true });
    expect(baselineDatabase.prepare(
      `SELECT status,position_count FROM live_wallet_position_baselines
       WHERE live_account_id=?`,
    ).get(accountId)).toEqual({ status: "CAPTURED", position_count: 1 });
    expect(baselineDatabase.prepare(
      `SELECT asset_id,balance_micros FROM live_wallet_position_baseline_items
       WHERE live_account_id=?`,
    ).get(accountId)).toEqual({ asset_id: legacyAssetId, balance_micros: "8521100" });
    expect((baselineDatabase.prepare(
      "SELECT count(*) count FROM live_positions WHERE live_account_id=?",
    ).get(accountId) as { count: number }).count).toBe(0);
    baselineDatabase.close();

    const unchanged = liveExecutor(env.databasePath, {
      walletProvider: new FakeWalletProvider({
        outcomePositions: { [legacyAssetId]: "8521100" },
      }),
      requireExternalPositionReconciliation: true,
    });
    await expect(unchanged.recoverOnStartup(accountId)).resolves.toMatchObject({ passed: true });
    unchanged.close();

    const drifted = liveExecutor(env.databasePath, {
      walletProvider: new FakeWalletProvider({
        outcomePositions: { [legacyAssetId]: "8521101" },
      }),
      requireExternalPositionReconciliation: true,
    });
    await expect(drifted.recoverOnStartup(accountId)).resolves.toMatchObject({
      passed: false,
      reason: "RECOVERY_RECONCILIATION_FAILED",
    });
    drifted.close();
  });

  it("reconciles the immutable wallet baseline plus positions managed by this Live account", async () => {
    const env = setup();
    const initial = liveExecutor(env.databasePath, {
      walletProvider: new FakeWalletProvider({
        outcomePositions: { [assetId]: "8521100" },
      }),
      requireExternalPositionReconciliation: true,
    });
    await expect(initial.recoverOnStartup(accountId)).resolves.toMatchObject({ passed: true });
    initial.close();

    const buyer = liveExecutor(env.databasePath);
    await buyer.executeBuy({
      accountId,
      signal: env.signal,
      context: env.context,
      riskDecisionId: "risk-live-buy",
    });
    buyer.close();

    const positionDatabase = new DatabaseSync(env.databasePath, { readOnly: true });
    const managedSize = (positionDatabase.prepare(
      `SELECT current_size_micros FROM live_positions
       WHERE live_account_id=? AND asset_id=?`,
    ).get(accountId, assetId) as { current_size_micros: string }).current_size_micros;
    positionDatabase.close();

    const checker = liveExecutor(env.databasePath, {
      walletProvider: new FakeWalletProvider({
        outcomePositions: {
          [assetId]: (8_521_100n + BigInt(managedSize)).toString(),
        },
      }),
      requireExternalPositionReconciliation: true,
    });
    await expect(checker.recoverOnStartup(accountId)).resolves.toMatchObject({
      passed: true,
      reason: "RECOVERY_RECONCILED",
    });
    checker.close();
  });

  it("records external pUSD cash without treating the configured risk allocation as wallet truth", async () => {
    const env = setup();
    const checker = liveExecutor(env.databasePath, {
      walletProvider: new FakeWalletProvider({
        balanceMicros: "999000000",
        outcomePositions: {},
      }),
      requireExternalPositionReconciliation: true,
    });

    const recovery = await checker.recoverOnStartup(accountId);

    expect(recovery.passed).toBe(true);
    const db = new DatabaseSync(env.databasePath, { readOnly: true });
    const check = db.prepare(
      `SELECT checks_json FROM live_reconciliation_runs
       WHERE live_account_id=? AND checks_json LIKE '%EXTERNAL_WALLET_CASH_OBSERVED%'
       ORDER BY created_at DESC LIMIT 1`,
    ).get(accountId) as { checks_json: string } | undefined;
    expect(check?.checks_json).toContain("EXTERNAL_WALLET_CASH_OBSERVED:999000000");
    db.close();
    checker.close();
  });

  it("restores only reconciliation-frozen positions after a clean reconciliation", async () => {
    const env = setup();
    const executor = liveExecutor(env.databasePath);
    await executor.executeBuy({ accountId, signal: env.signal, context: env.context, riskDecisionId: "risk-live-buy" });
    const database = new DatabaseSync(env.databasePath);
    const store = new LiveStore(database, sourceVersion, () => new Date(now));
    store.transaction(() => store.freezeOpenPositions(accountId, "RECONCILIATION:TEST_DRIFT"));
    database.close();

    const result = await executor.reconcile({ accountId, reason: "TEST_RECOVERED" });
    expect(result.frozenPositionCount).toBe(0);
    const check = new DatabaseSync(env.databasePath, { readOnly: true });
    const position = check.prepare("SELECT status,frozen_reason FROM live_positions").get() as {
      status: string;
      frozen_reason: string | null;
    };
    expect(position).toEqual({ status: "OPEN", frozen_reason: null });
    check.close();
    executor.close();
  });

  it("atomically persists Live Execution state, transition and audit across nested callers", () => {
    const env = setup();
    const database = new DatabaseSync(env.databasePath);
    const store = new LiveStore(database, sourceVersion, () => new Date(now));
    const executionInput = {
      liveAccountId: accountId,
      signalId: env.signal.signalId,
      contextId: env.context.contextId,
      riskDecisionId: "risk-live-buy",
      liveGateRunId: null,
      executionIdempotencyKey: "LIVE_EXECUTION:atomic-state-test",
      executionType: "TARGET_BUY" as const,
      state: "WAITING_EXECUTION" as const,
      assetId,
      conditionId,
      requestedAmountMicros: "5000000",
      requestedSizeMicros: "10000000",
      targetPriceUnits: "500000000000000000",
      reason: "ATOMIC_STATE_TEST",
      rulesetHash: RULESET_HASH,
    };

    database.exec(
      `CREATE TRIGGER fail_execution_create_audit
       BEFORE INSERT ON audit_log
       WHEN NEW.entity_type='LIVE_EXECUTION' AND NEW.action='created'
       BEGIN SELECT RAISE(ABORT, 'TEST_EXECUTION_AUDIT_FAILURE'); END`,
    );
    expect(() => store.createExecution(executionInput)).toThrow("TEST_EXECUTION_AUDIT_FAILURE");
    expect((database.prepare(
      "SELECT count(*) count FROM live_executions WHERE execution_idempotency_key=?",
    ).get(executionInput.executionIdempotencyKey) as { count: number }).count).toBe(0);
    expect((database.prepare(
      "SELECT count(*) count FROM live_state_transitions WHERE entity_type='LIVE_EXECUTION'",
    ).get() as { count: number }).count).toBe(0);
    database.exec("DROP TRIGGER fail_execution_create_audit");

    const execution = store.createExecution(executionInput);
    const baselineTransitions = (database.prepare(
      "SELECT count(*) count FROM live_state_transitions WHERE entity_type='LIVE_EXECUTION' AND entity_id=?",
    ).get(execution.live_execution_id) as { count: number }).count;
    const baselineAudits = (database.prepare(
      "SELECT count(*) count FROM audit_log WHERE entity_type='LIVE_EXECUTION' AND entity_id=?",
    ).get(execution.live_execution_id) as { count: number }).count;

    database.exec(
      `CREATE TRIGGER fail_execution_update_audit
       BEFORE INSERT ON audit_log
       WHEN NEW.entity_type='LIVE_EXECUTION' AND NEW.action='failed'
       BEGIN SELECT RAISE(ABORT, 'TEST_EXECUTION_AUDIT_FAILURE'); END`,
    );
    expect(() => store.updateExecutionState(
      execution.live_execution_id,
      "FAILED",
      "ATOMIC_UPDATE_TEST",
      RULESET_HASH,
    )).toThrow("TEST_EXECUTION_AUDIT_FAILURE");
    expect(database.prepare("SELECT state FROM live_executions WHERE live_execution_id=?")
      .get(execution.live_execution_id)).toEqual({ state: "WAITING_EXECUTION" });
    database.exec("DROP TRIGGER fail_execution_update_audit");

    database.exec(
      `CREATE TRIGGER fail_execution_freeze_audit
       BEFORE INSERT ON audit_log
       WHEN NEW.entity_type='LIVE_EXECUTION' AND NEW.action='frozen'
       BEGIN SELECT RAISE(ABORT, 'TEST_EXECUTION_AUDIT_FAILURE'); END`,
    );
    expect(() => store.freezeExecution(execution.live_execution_id, "ATOMIC_FREEZE_TEST"))
      .toThrow("TEST_EXECUTION_AUDIT_FAILURE");
    expect(database.prepare("SELECT state FROM live_executions WHERE live_execution_id=?")
      .get(execution.live_execution_id)).toEqual({ state: "WAITING_EXECUTION" });
    expect((database.prepare(
      "SELECT count(*) count FROM live_state_transitions WHERE entity_type='LIVE_EXECUTION' AND entity_id=?",
    ).get(execution.live_execution_id) as { count: number }).count).toBe(baselineTransitions);
    expect((database.prepare(
      "SELECT count(*) count FROM audit_log WHERE entity_type='LIVE_EXECUTION' AND entity_id=?",
    ).get(execution.live_execution_id) as { count: number }).count).toBe(baselineAudits);
    database.exec("DROP TRIGGER fail_execution_freeze_audit");

    const nestedKey = "LIVE_EXECUTION:nested-outer-rollback";
    expect(() => store.transaction(() => {
      store.createExecution({ ...executionInput, executionIdempotencyKey: nestedKey });
      throw new Error("TEST_OUTER_ROLLBACK");
    })).toThrow("TEST_OUTER_ROLLBACK");
    expect((database.prepare(
      "SELECT count(*) count FROM live_executions WHERE execution_idempotency_key=?",
    ).get(nestedKey) as { count: number }).count).toBe(0);
    database.close();
  });

  it("rolls back every position when one transition fails during a multi-position freeze", async () => {
    const env = setup();
    const second = insertSignalAndRisk(env.databasePath, env.targetId, {
      signalId: "live-buy-second-freeze",
      riskDecisionId: "risk-live-buy-second-freeze",
      decision: "ALLOW",
    });
    const executor = liveExecutor(env.databasePath);
    await executor.executeBuy({
      accountId,
      signal: env.signal,
      context: env.context,
      riskDecisionId: "risk-live-buy",
    });
    await executor.executeBuy({
      accountId,
      signal: second.signal,
      context: second.context,
      riskDecisionId: "risk-live-buy-second-freeze",
    });
    executor.close();

    const database = new DatabaseSync(env.databasePath);
    const store = new LiveStore(database, sourceVersion, () => new Date(now));
    database.exec(
      `CREATE TRIGGER fail_second_position_freeze_transition
       BEFORE INSERT ON live_state_transitions
       WHEN NEW.entity_type='LIVE_POSITION' AND NEW.to_state='FROZEN'
        AND (SELECT count(*) FROM live_state_transitions
             WHERE entity_type='LIVE_POSITION' AND to_state='FROZEN') >= 1
       BEGIN SELECT RAISE(ABORT, 'TEST_SECOND_POSITION_FREEZE_FAILURE'); END`,
    );

    expect(() => store.freezeOpenPositions(accountId, "ATOMIC_MULTI_POSITION_FREEZE"))
      .toThrow("TEST_SECOND_POSITION_FREEZE_FAILURE");
    expect(database.prepare(
      "SELECT status,frozen_reason FROM live_positions ORDER BY live_position_id",
    ).all()).toEqual([
      { status: "OPEN", frozen_reason: null },
      { status: "OPEN", frozen_reason: null },
    ]);
    expect((database.prepare(
      "SELECT count(*) count FROM live_state_transitions WHERE entity_type='LIVE_POSITION' AND to_state='FROZEN'",
    ).get() as { count: number }).count).toBe(0);
    database.close();
  });

  it("rejects an illegal terminal Live Execution state transition", async () => {
    const env = setup();
    const executor = liveExecutor(env.databasePath);
    const result = await executor.executeBuy({
      accountId,
      signal: env.signal,
      context: env.context,
      riskDecisionId: "risk-live-buy",
    });
    executor.close();
    const database = new DatabaseSync(env.databasePath);
    const store = new LiveStore(database, sourceVersion, () => new Date(now));
    expect(() => store.updateExecutionState(
      result.executionId,
      "WAITING_EXECUTION",
      "ILLEGAL_TEST",
      RULESET_HASH,
    )).toThrow("Illegal transition: EXECUTED -> WAITING_EXECUTION");
    const state = database.prepare("SELECT state FROM live_executions WHERE live_execution_id=?")
      .get(result.executionId) as { state: string };
    expect(state.state).toBe("EXECUTED");
    database.close();
  });

  it("forbids a POLYMARKET_CLOB mutation adapter in TEST", () => {
    const env = setup();
    const adapter = new PendingClobTradeAdapter();
    expect(() => liveExecutor(env.databasePath, { orderAdapter: adapter }))
      .toThrow("REAL_LIVE_COMPONENT_FORBIDDEN_IN_TEST");
  });

  it("emergency stop disables the persisted Live Gate before cancelling and freezing", async () => {
    const env = setup();
    const executor = liveExecutor(env.databasePath, { orderAdapter: new FakeOrderAdapter({ fillRatioPpm: 500_000 }) });
    await executor.executeBuy({ accountId, signal: env.signal, context: env.context, riskDecisionId: "risk-live-buy" });
    activateLiveGate(env.databasePath);
    await executor.emergencyStop(accountId, "test");
    const db = new DatabaseSync(env.databasePath, { readOnly: true });
    const position = db.prepare("SELECT status FROM live_positions").get() as { status: string };
    const gate = db.prepare("SELECT execution_mode,live_gate_state,state_reason FROM live_gate_state WHERE state_id='default'")
      .get() as { execution_mode: string; live_gate_state: string; state_reason: string };
    const order = db.prepare("SELECT status FROM live_orders").get() as { status: string };
    expect(position.status).toBe("FROZEN");
    expect(gate).toMatchObject({ execution_mode: "PAPER", live_gate_state: "LIVE_DISABLED" });
    expect(gate.state_reason).toContain("EMERGENCY_STOP:test");
    expect(order.status).toBe("CANCELLED");
    db.close();
    executor.close();
  });

  it("blocks submit when emergency stop races with asynchronous signing", async () => {
    const env = setup();
    const signer = new BlockingFakeSigner();
    const adapter = new CountingOrderAdapter();
    const executor = liveExecutor(env.databasePath, { signer, orderAdapter: adapter });
    const executionPromise = executor.executeBuy({
      accountId,
      signal: env.signal,
      context: env.context,
      riskDecisionId: "risk-live-buy",
    });
    await signer.started;
    const stopPromise = executor.emergencyStop(accountId, "SIGNING_RACE");
    signer.release();
    const execution = await executionPromise;
    await stopPromise;
    expect(execution.state).toBe("REJECTED");
    expect(adapter.submitCount).toBe(0);
    const db = new DatabaseSync(env.databasePath, { readOnly: true });
    expect((db.prepare("SELECT count(*) count FROM live_orders").get() as { count: number }).count).toBe(0);
    expect((db.prepare("SELECT reason FROM live_executions WHERE live_execution_id=?")
      .get(execution.executionId) as { reason: string }).reason).toBe("LIVE_ACCOUNT_EMERGENCY_HALTED");
    expect((db.prepare("SELECT execution_mode,live_gate_state FROM live_gate_state WHERE state_id='default'")
      .get() as { execution_mode: string; live_gate_state: string }))
      .toEqual({ execution_mode: "PAPER", live_gate_state: "LIVE_DISABLED" });
    db.close();
    executor.close();
  });

  it("reports an incomplete emergency stop while another executor owns a durable SUBMITTING claim", async () => {
    const env = setup();
    const adapter = new BlockingSubmitAdapter();
    const submittingExecutor = liveExecutor(env.databasePath, { orderAdapter: adapter });
    const emergencyExecutor = liveExecutor(env.databasePath);
    const executionPromise = submittingExecutor.executeBuy({
      accountId,
      signal: env.signal,
      context: env.context,
      riskDecisionId: "risk-live-buy",
    });

    await adapter.started;
    await expect(emergencyExecutor.emergencyStop(accountId, "CROSS_PROCESS_SUBMITTING"))
      .rejects.toThrow("EMERGENCY_STOP_INCOMPLETE");

    const duringEmergency = new DatabaseSync(env.databasePath, { readOnly: true });
    expect(duringEmergency.prepare(
      `SELECT a.status FROM live_order_attempts a
       JOIN live_orders o ON o.live_order_id=a.live_order_id
       JOIN live_executions e ON e.live_execution_id=o.live_execution_id
       WHERE e.live_account_id=? AND a.action='SUBMIT'`,
    ).get(accountId)).toEqual({ status: "STARTED" });
    expect(duringEmergency.prepare(
      "SELECT execution_mode,live_gate_state FROM live_gate_state WHERE state_id='default'",
    ).get()).toEqual({ execution_mode: "PAPER", live_gate_state: "LIVE_DISABLED" });
    duringEmergency.close();

    adapter.release();
    const result = await executionPromise;
    expect(result.state).toBe("FROZEN");
    const reconciled = new DatabaseSync(env.databasePath, { readOnly: true });
    expect(reconciled.prepare(
      "SELECT status FROM live_order_attempts WHERE action='SUBMIT'",
    ).get()).toEqual({ status: "SUCCEEDED" });
    expect((reconciled.prepare("SELECT count(*) count FROM live_fills").get() as { count: number }).count).toBe(1);
    expect(reconciled.prepare("SELECT status FROM live_positions").get()).toEqual({ status: "FROZEN" });
    reconciled.close();
    submittingExecutor.close();
    emergencyExecutor.close();
  });

  it("reconciles a fill that races with cancellation before terminalizing the local order", async () => {
    const env = setup();
    const adapter = new DeferredRecoveryOrderAdapter();
    const executor = liveExecutor(env.databasePath, { orderAdapter: adapter });
    const execution = await executor.executeBuy({
      accountId,
      signal: env.signal,
      context: env.context,
      riskDecisionId: "risk-live-buy",
    });
    expect(execution.state).toBe("WAITING_EXECUTION");

    adapter.complete();
    await executor.cancelExecution(execution.executionId, "TEST_CANCEL_RACE");

    const db = new DatabaseSync(env.databasePath, { readOnly: true });
    const synchronizedExecution = db.prepare(
      "SELECT state,filled_size_micros FROM live_executions WHERE live_execution_id=?",
    ).get(execution.executionId) as { state: string; filled_size_micros: string };
    const order = db.prepare("SELECT status,filled_size_micros FROM live_orders WHERE live_execution_id=?")
      .get(execution.executionId) as { status: string; filled_size_micros: string };
    const reservation = db.prepare(
      "SELECT COALESCE(SUM(CAST(delta_micros AS INTEGER)),0) total FROM live_reservation_ledger WHERE live_execution_id=?",
    ).get(execution.executionId) as { total: number };
    expect(synchronizedExecution).toEqual({ state: "EXECUTED", filled_size_micros: "10000000" });
    expect(order).toEqual({ status: "CANCELLED", filled_size_micros: "10000000" });
    expect(BigInt(reservation.total)).toBe(0n);
    expect(count(env.databasePath, "live_fills")).toBe(1);
    expect(count(env.databasePath, "live_positions")).toBe(1);
    db.close();
    executor.close();
  });

  it("keeps the system fail-closed when an emergency cancellation cannot be confirmed", async () => {
    const env = setup();
    const executor = liveExecutor(env.databasePath, {
      orderAdapter: new CancelFailureOrderAdapter({ fillRatioPpm: 500_000 }),
    });
    await executor.executeBuy({ accountId, signal: env.signal, context: env.context, riskDecisionId: "risk-live-buy" });
    activateLiveGate(env.databasePath);
    await expect(executor.emergencyStop(accountId, "cancel-failure")).rejects.toThrow("EMERGENCY_STOP_INCOMPLETE");
    const db = new DatabaseSync(env.databasePath, { readOnly: true });
    const gate = db.prepare("SELECT execution_mode,live_gate_state FROM live_gate_state WHERE state_id='default'")
      .get() as { execution_mode: string; live_gate_state: string };
    const position = db.prepare("SELECT status FROM live_positions").get() as { status: string };
    const execution = db.prepare("SELECT state FROM live_executions ORDER BY created_at DESC LIMIT 1")
      .get() as { state: string };
    const order = db.prepare("SELECT status FROM live_orders ORDER BY created_at DESC LIMIT 1")
      .get() as { status: string };
    expect(gate).toEqual({ execution_mode: "PAPER", live_gate_state: "LIVE_DISABLED" });
    expect(position.status).toBe("FROZEN");
    expect(execution.state).toBe("FROZEN");
    expect(order.status).toBe("CANCEL_PENDING");
    db.close();
    executor.close();
  });

  it("does not accept a settlement confirmation before the immutable market end time", async () => {
    const env = setup();
    const executor = liveExecutor(env.databasePath);
    await executor.executeBuy({ accountId, signal: env.signal, context: env.context, riskDecisionId: "risk-live-buy" });
    const db = new DatabaseSync(env.databasePath, { readOnly: true });
    const position = db.prepare("SELECT live_position_id FROM live_positions").get() as { live_position_id: string };
    db.close();
    expect(() => executor.confirmSettlement({
      positionId: position.live_position_id,
      resolved: true,
      payoutNumerator: "1",
      payoutDenominator: "1",
      confirmedAt: now,
      resolutionSnapshot: { source: "TEST_CONFIRMED_RESULT" },
    })).toThrow("LIVE_SETTLEMENT_CONFIRMATION_TIME_INVALID");
    expect(count(env.databasePath, "live_settlement_ledger")).toBe(0);
    executor.close();
  });

  it("moves ended Live positions from result-pending to resolved using only public settlement evidence", async () => {
    const env = setup();
    const buyer = liveExecutor(env.databasePath);
    await buyer.executeBuy({ accountId, signal: env.signal, context: env.context, riskDecisionId: "risk-live-buy" });
    buyer.close();
    const pending = liveExecutorAt(env.databasePath, "2026-07-11T00:00:00.000Z", {
      marketDataProvider: new FakeLiveMarketDataProvider({
        now: () => new Date("2026-07-11T00:00:00.000Z"),
        resolution: { resolved: false, payoutNumerator: null, payoutDenominator: null },
      }),
    });
    const pendingResult = await pending.processSettlements(accountId);
    expect(pendingResult).toMatchObject({ resolvedPositionIds: [], failures: [] });
    expect(pendingResult.pendingPositionIds).toHaveLength(1);
    pending.close();

    const resolved = liveExecutorAt(env.databasePath, "2026-07-11T00:01:00.000Z", {
      marketDataProvider: new FakeLiveMarketDataProvider({
        now: () => new Date("2026-07-11T00:01:00.000Z"),
        resolution: { resolved: true, payoutNumerator: "1", payoutDenominator: "1" },
      }),
    });
    const resolvedResult = await resolved.processSettlements(accountId);
    expect(resolvedResult).toMatchObject({ pendingPositionIds: [], failures: [] });
    expect(resolvedResult.resolvedPositionIds).toEqual(pendingResult.pendingPositionIds);
    const db = new DatabaseSync(env.databasePath, { readOnly: true });
    expect((db.prepare("SELECT status FROM live_positions").get() as { status: string }).status)
      .toBe("SETTLEMENT_PENDING");
    expect((db.prepare("SELECT settlement_status,redeem_amount_micros FROM live_settlement_ledger").get() as { settlement_status: string; redeem_amount_micros: string }))
      .toEqual({ settlement_status: "RESOLVED", redeem_amount_micros: "10000000" });
    const events = db.prepare(
      `SELECT event_sequence,from_status,to_status,redeem_amount_micros,
              resolution_evidence_json,redeem_evidence_json,ruleset_hash,
              source_code_commit,config_version
       FROM live_settlement_events ORDER BY event_sequence`,
    ).all() as unknown as Array<{
      event_sequence: number;
      from_status: string | null;
      to_status: string;
      redeem_amount_micros: string | null;
      resolution_evidence_json: string;
      redeem_evidence_json: string;
      ruleset_hash: string;
      source_code_commit: string;
      config_version: string;
    }>;
    expect(events.map((event) => [event.event_sequence, event.from_status, event.to_status]))
      .toEqual([[1, null, "PENDING"], [2, "PENDING", "RESOLVED"]]);
    expect(events[1]).toMatchObject({
      redeem_amount_micros: "10000000",
      ruleset_hash: RULESET_HASH,
      source_code_commit: sourceVersion.commit,
      config_version: VERSIONS.configVersion,
    });
    expect(JSON.parse(events[1]!.resolution_evidence_json)).toMatchObject({
      resolved: true,
      payoutNumerator: "1",
      payoutDenominator: "1",
    });
    expect(JSON.parse(events[1]!.redeem_evidence_json)).toEqual({});
    expect(count(env.databasePath, "live_redeems")).toBe(0);
    expect((db.prepare("SELECT count(*) count FROM live_cash_ledger WHERE entry_type='REDEEM'").get() as { count: number }).count)
      .toBe(0);
    db.close();
    resolved.close();
  });

  it("backfills legacy settlement projections as migration-time snapshots", async () => {
    const env = setup();
    const buyer = liveExecutor(env.databasePath);
    await buyer.executeBuy({
      accountId,
      signal: env.signal,
      context: env.context,
      riskDecisionId: "risk-live-buy",
    });
    buyer.close();
    const resolver = liveExecutorAt(env.databasePath, "2026-07-11T00:00:00.000Z");
    const positionDatabase = new DatabaseSync(env.databasePath, { readOnly: true });
    const position = positionDatabase.prepare("SELECT live_position_id FROM live_positions").get() as {
      live_position_id: string;
    };
    positionDatabase.close();
    resolver.confirmSettlement({
      positionId: position.live_position_id,
      resolved: true,
      payoutNumerator: "1",
      payoutDenominator: "1",
      confirmedAt: "2026-07-11T00:00:00.000Z",
      resolutionSnapshot: { source: "TEST_CONFIRMED_RESULT" },
    });
    resolver.close();

    const legacy = new DatabaseSync(env.databasePath);
    const projectionCreatedAt = (legacy.prepare(
      "SELECT created_at FROM live_settlement_ledger WHERE live_position_id=?",
    ).get(position.live_position_id) as { created_at: string }).created_at;
    legacy.exec("DROP TABLE live_settlement_events");
    legacy.prepare("DELETE FROM schema_migrations WHERE version='2.18.0'").run();
    legacy.close();
    const migrationStartedAt = Date.now();

    const migrated = new Phase0Database(env.databasePath, sourceVersion);
    migrated.initialize();
    migrated.close();
    const check = new DatabaseSync(env.databasePath, { readOnly: true });
    const event = check.prepare(
      `SELECT to_status,reason,created_at FROM live_settlement_events
       WHERE live_position_id=?`,
    ).get(position.live_position_id) as { to_status: string; reason: string; created_at: string };
    expect(event).toMatchObject({
      to_status: "RESOLVED",
      reason: "MIGRATION_SNAPSHOT_CURRENT_PROJECTION",
    });
    expect(event.created_at).not.toBe(projectionCreatedAt);
    expect(Date.parse(event.created_at)).toBeGreaterThanOrEqual(migrationStartedAt - 1_000);
    check.close();
  });

  it("rolls back settlement projection, event and transition when audit persistence fails", async () => {
    const env = setup();
    const buyer = liveExecutor(env.databasePath);
    await buyer.executeBuy({ accountId, signal: env.signal, context: env.context, riskDecisionId: "risk-live-buy" });
    buyer.close();
    const pending = liveExecutorAt(env.databasePath, "2026-07-11T00:00:00.000Z", {
      marketDataProvider: new FakeLiveMarketDataProvider({
        now: () => new Date("2026-07-11T00:00:00.000Z"),
        resolution: { resolved: false, payoutNumerator: null, payoutDenominator: null },
      }),
    });
    const pendingResult = await pending.processSettlements(accountId);
    const positionId = pendingResult.pendingPositionIds[0]!;
    pending.close();

    const fault = new DatabaseSync(env.databasePath);
    fault.exec(
      `CREATE TRIGGER fail_settlement_resolved_audit
       BEFORE INSERT ON audit_log
       WHEN NEW.entity_type='LIVE_SETTLEMENT' AND NEW.action='resolved'
       BEGIN SELECT RAISE(ABORT, 'TEST_SETTLEMENT_AUDIT_FAILURE'); END`,
    );
    fault.close();
    const resolver = liveExecutorAt(env.databasePath, "2026-07-11T00:01:00.000Z");
    expect(() => resolver.confirmSettlement({
      positionId,
      resolved: true,
      payoutNumerator: "1",
      payoutDenominator: "1",
      confirmedAt: "2026-07-11T00:01:00.000Z",
      resolutionSnapshot: { source: "TEST_CONFIRMED_RESULT" },
    })).toThrow("TEST_SETTLEMENT_AUDIT_FAILURE");
    resolver.close();

    const check = new DatabaseSync(env.databasePath, { readOnly: true });
    expect(check.prepare("SELECT settlement_status FROM live_settlement_ledger WHERE live_position_id=?")
      .get(positionId)).toEqual({ settlement_status: "PENDING" });
    expect(check.prepare(
      "SELECT event_sequence,from_status,to_status FROM live_settlement_events WHERE live_position_id=?",
    ).all(positionId)).toEqual([{ event_sequence: 1, from_status: null, to_status: "PENDING" }]);
    expect((check.prepare(
      "SELECT count(*) count FROM live_state_transitions WHERE entity_type='LIVE_SETTLEMENT' AND entity_id=?",
    ).get(positionId) as { count: number }).count).toBe(1);
    expect((check.prepare(
      "SELECT count(*) count FROM audit_log WHERE entity_type='LIVE_SETTLEMENT' AND entity_id=? AND action='resolved'",
    ).get(positionId) as { count: number }).count).toBe(0);
    check.close();
  });

  it("rejects redeem unless settlement, Live Gate and an independent ALLOW Risk Decision all agree", async () => {
    const env = setup();
    const buyer = liveExecutor(env.databasePath);
    await buyer.executeBuy({ accountId, signal: env.signal, context: env.context, riskDecisionId: "risk-live-buy" });
    buyer.close();
    const executor = liveExecutorAt(env.databasePath, "2026-07-11T00:00:00.000Z");
    const db = new DatabaseSync(env.databasePath, { readOnly: true });
    const position = db.prepare("SELECT live_position_id FROM live_positions").get() as { live_position_id: string };
    db.close();

    await expect(executor.redeemPosition(position.live_position_id, "risk-live-buy"))
      .rejects.toThrow("LIVE_SETTLEMENT_NOT_CONFIRMED");
    const settlement = executor.confirmSettlement({
      positionId: position.live_position_id,
      resolved: true,
      payoutNumerator: "1",
      payoutDenominator: "1",
      confirmedAt: "2026-07-11T00:00:00.000Z",
      resolutionSnapshot: { source: "TEST_CONFIRMED_RESULT" },
    });
    await expect(executor.redeemPosition(position.live_position_id, "risk-live-buy"))
      .rejects.toThrow("LIVE_GATE_NOT_ACTIVE");

    activateLiveGate(env.databasePath);
    await expect(executor.redeemPosition(position.live_position_id, "risk-live-buy"))
      .rejects.toThrow("REDEEM_RISK_REASON_MISMATCH");
    const riskDatabase = new DatabaseSync(env.databasePath);
    const risk = new RiskManager(riskDatabase, sourceVersion).recordSystemDecision({
      mode: "LIVE",
      accountId,
      signalId: null,
      contextId: null,
      entityId: position.live_position_id,
      executionType: "REDEEM",
      decision: "ALLOW",
      reason: "REDEEM_CONFIRMED",
      requestedAmountMicros: BigInt(settlement.redeemAmountMicros),
      requestedSizeMicros: 10_000_000n,
      now,
    });
    riskDatabase.close();
    const blockedAction = liveExecutor(env.databasePath, { liveGate: new FakeGate(false, "FAKE_REDEEM_BLOCK") });
    await expect(blockedAction.redeemPosition(position.live_position_id, risk.riskDecisionId))
      .rejects.toThrow("LIVE_ACCOUNT_ACTION_GATE_BLOCKED:FAKE_REDEEM_BLOCK");
    blockedAction.close();
    expect(await executor.redeemPosition(position.live_position_id, risk.riskDecisionId))
      .toEqual({ status: "DISABLED" });
    const disabledCheck = new DatabaseSync(env.databasePath, { readOnly: true });
    expect((disabledCheck.prepare("SELECT status FROM live_positions").get() as { status: string }).status)
      .toBe("SETTLEMENT_PENDING");
    expect((disabledCheck.prepare("SELECT count(*) count FROM live_cash_ledger WHERE entry_type='REDEEM'").get() as { count: number }).count)
      .toBe(0);
    expect((disabledCheck.prepare(
      "SELECT group_concat(to_status, ',') statuses FROM live_settlement_events ORDER BY event_sequence",
    ).get() as { statuses: string }).statuses).toBe("RESOLVED,REDEEM_PENDING,DISABLED");
    disabledCheck.close();
    executor.close();
  });

  it("records failed redeem evidence while returning every settlement lifecycle view to resolved", async () => {
    const env = setup();
    const buyer = liveExecutor(env.databasePath);
    await buyer.executeBuy({ accountId, signal: env.signal, context: env.context, riskDecisionId: "risk-live-buy" });
    buyer.close();
    const settlementExecutor = liveExecutorAt(env.databasePath, "2026-07-11T00:00:00.000Z");
    const positionDatabase = new DatabaseSync(env.databasePath, { readOnly: true });
    const position = positionDatabase.prepare("SELECT live_position_id,current_size_micros FROM live_positions").get() as {
      live_position_id: string;
      current_size_micros: string;
    };
    positionDatabase.close();
    const settlement = settlementExecutor.confirmSettlement({
      positionId: position.live_position_id,
      resolved: true,
      payoutNumerator: "1",
      payoutDenominator: "1",
      confirmedAt: "2026-07-11T00:00:00.000Z",
      resolutionSnapshot: { source: "TEST_CONFIRMED_RESULT" },
    });
    settlementExecutor.close();
    activateLiveGate(env.databasePath);
    const riskDatabase = new DatabaseSync(env.databasePath);
    const risk = new RiskManager(riskDatabase, sourceVersion).recordSystemDecision({
      mode: "LIVE",
      accountId,
      signalId: null,
      contextId: null,
      entityId: position.live_position_id,
      executionType: "REDEEM",
      decision: "ALLOW",
      reason: "REDEEM_CONFIRMED",
      requestedAmountMicros: BigInt(settlement.redeemAmountMicros),
      requestedSizeMicros: BigInt(position.current_size_micros),
      now,
    });
    riskDatabase.close();

    const failedExecutor = liveExecutor(env.databasePath, { redeemAdapter: new FailedRedeemAdapter() });
    expect(await failedExecutor.redeemPosition(position.live_position_id, risk.riskDecisionId))
      .toEqual({ status: "FAILED" });
    failedExecutor.close();

    const check = new DatabaseSync(env.databasePath, { readOnly: true });
    expect(check.prepare("SELECT settlement_status FROM live_settlement_ledger").get())
      .toEqual({ settlement_status: "RESOLVED" });
    const events = check.prepare(
      `SELECT event_sequence,from_status,to_status,redeem_evidence_json
       FROM live_settlement_events ORDER BY event_sequence`,
    ).all() as unknown as Array<{
      event_sequence: number;
      from_status: string | null;
      to_status: string;
      redeem_evidence_json: string;
    }>;
    expect(events.map((event) => [event.event_sequence, event.from_status, event.to_status]))
      .toEqual([
        [1, null, "RESOLVED"],
        [2, "RESOLVED", "REDEEM_PENDING"],
        [3, "REDEEM_PENDING", "RESOLVED"],
      ]);
    expect(JSON.parse(events[2]!.redeem_evidence_json)).toMatchObject({
      status: "FAILED",
      adapterType: "FAKE",
      raw: { failed: true },
    });
    expect(check.prepare(
      `SELECT from_state,to_state FROM live_state_transitions
       WHERE entity_type='LIVE_SETTLEMENT' ORDER BY sequence DESC LIMIT 1`,
    ).get()).toEqual({ from_state: "REDEEM_PENDING", to_state: "RESOLVED" });
    check.close();
  });

  it("finalizes a fake confirmed redeem exactly once through settlement, ledger and audit", async () => {
    const env = setup();
    const buyer = liveExecutor(env.databasePath);
    await buyer.executeBuy({ accountId, signal: env.signal, context: env.context, riskDecisionId: "risk-live-buy" });
    buyer.close();
    const executor = liveExecutorAt(env.databasePath, "2026-07-11T00:00:00.000Z");
    const db = new DatabaseSync(env.databasePath);
    const position = db.prepare("SELECT live_position_id,current_size_micros FROM live_positions").get() as {
      live_position_id: string;
      current_size_micros: string;
    };
    db.prepare("UPDATE live_positions SET realized_pnl_micros='9007199254740993' WHERE live_position_id=?")
      .run(position.live_position_id);
    db.close();
    const settlement = executor.confirmSettlement({
      positionId: position.live_position_id,
      resolved: true,
      payoutNumerator: "1",
      payoutDenominator: "1",
      confirmedAt: "2026-07-11T00:00:00.000Z",
      resolutionSnapshot: { source: "TEST_CONFIRMED_RESULT" },
    });
    activateLiveGate(env.databasePath);
    const riskDatabase = new DatabaseSync(env.databasePath);
    const risk = new RiskManager(riskDatabase, sourceVersion).recordSystemDecision({
      mode: "LIVE",
      accountId,
      signalId: null,
      contextId: null,
      entityId: position.live_position_id,
      executionType: "REDEEM",
      decision: "ALLOW",
      reason: "REDEEM_CONFIRMED",
      requestedAmountMicros: BigInt(settlement.redeemAmountMicros),
      requestedSizeMicros: BigInt(position.current_size_micros),
      now,
    });
    riskDatabase.close();
    const fakeRedeemExecutor = liveExecutor(env.databasePath, { redeemAdapter: new FakeRedeemAdapter() });
    expect((await fakeRedeemExecutor.redeemPosition(position.live_position_id, risk.riskDecisionId)).status).toBe("CONFIRMED");
    expect((await fakeRedeemExecutor.redeemPosition(position.live_position_id, risk.riskDecisionId)).status).toBe("CONFIRMED");
    expect(await fakeRedeemExecutor.reconcile({ accountId, reason: "POST_REDEEM_CHECK" }))
      .toMatchObject({ mode: "LIVE", frozenPositionCount: 0, reason: "LIVE_RECONCILED" });

    const check = new DatabaseSync(env.databasePath, { readOnly: true });
    const closed = check.prepare(
      "SELECT status,current_size_micros,remaining_cost_micros,realized_pnl_micros FROM live_positions WHERE live_position_id=?",
    ).get(position.live_position_id) as {
      status: string;
      current_size_micros: string;
      remaining_cost_micros: string;
      realized_pnl_micros: string;
    };
    const settlementRow = check.prepare("SELECT settlement_status,redeem_amount_micros FROM live_settlement_ledger WHERE live_position_id=?")
      .get(position.live_position_id) as { settlement_status: string; redeem_amount_micros: string };
    expect(closed).toEqual({
      status: "REDEEMED",
      current_size_micros: "0",
      remaining_cost_micros: "0",
      realized_pnl_micros: "9007199259740993",
    });
    expect(settlementRow).toEqual({ settlement_status: "REDEEMED", redeem_amount_micros: "10000000" });
    const settlementEvents = check.prepare(
      `SELECT event_sequence,from_status,to_status,redeem_amount_micros,pnl_micros,
              resolution_evidence_json,redeem_evidence_json
       FROM live_settlement_events ORDER BY event_sequence`,
    ).all() as unknown as Array<{
      event_sequence: number;
      from_status: string | null;
      to_status: string;
      redeem_amount_micros: string | null;
      pnl_micros: string | null;
      resolution_evidence_json: string;
      redeem_evidence_json: string;
    }>;
    expect(settlementEvents.map((event) => [event.event_sequence, event.from_status, event.to_status]))
      .toEqual([
        [1, null, "RESOLVED"],
        [2, "RESOLVED", "REDEEM_PENDING"],
        [3, "REDEEM_PENDING", "REDEEMED"],
      ]);
    expect(settlementEvents[2]).toMatchObject({
      redeem_amount_micros: "10000000",
      pnl_micros: "5000000",
    });
    expect(JSON.parse(settlementEvents[2]!.resolution_evidence_json)).toMatchObject({ resolved: true });
    expect(JSON.parse(settlementEvents[2]!.redeem_evidence_json)).toMatchObject({ status: "CONFIRMED" });
    expect(count(env.databasePath, "live_redeems")).toBe(1);
    expect(count(env.databasePath, "live_pnl_ledger")).toBe(1);
    expect((check.prepare("SELECT count(*) count FROM live_cash_ledger WHERE entry_type='REDEEM'").get() as { count: number }).count).toBe(1);
    expect((check.prepare("SELECT count(*) count FROM live_executions WHERE execution_type='REDEEM'").get() as { count: number }).count).toBe(1);
    check.close();
    fakeRedeemExecutor.close();
    executor.close();
  });

  it("does not resubmit a redeem whose external outcome became unknown after the durable intent", async () => {
    const env = setup();
    const buyer = liveExecutor(env.databasePath);
    await buyer.executeBuy({ accountId, signal: env.signal, context: env.context, riskDecisionId: "risk-live-buy" });
    buyer.close();
    const executor = liveExecutorAt(env.databasePath, "2026-07-11T00:00:00.000Z");
    const db = new DatabaseSync(env.databasePath, { readOnly: true });
    const position = db.prepare("SELECT live_position_id,current_size_micros FROM live_positions").get() as {
      live_position_id: string;
      current_size_micros: string;
    };
    db.close();
    const settlement = executor.confirmSettlement({
      positionId: position.live_position_id,
      resolved: true,
      payoutNumerator: "1",
      payoutDenominator: "1",
      confirmedAt: "2026-07-11T00:00:00.000Z",
      resolutionSnapshot: { source: "TEST_CONFIRMED_RESULT" },
    });
    activateLiveGate(env.databasePath);
    const riskDatabase = new DatabaseSync(env.databasePath);
    const risk = new RiskManager(riskDatabase, sourceVersion).recordSystemDecision({
      mode: "LIVE",
      accountId,
      signalId: null,
      contextId: null,
      entityId: position.live_position_id,
      executionType: "REDEEM",
      decision: "ALLOW",
      reason: "REDEEM_CONFIRMED",
      requestedAmountMicros: BigInt(settlement.redeemAmountMicros),
      requestedSizeMicros: BigInt(position.current_size_micros),
      now,
    });
    riskDatabase.close();
    executor.close();

    const uncertain = liveExecutor(env.databasePath, { redeemAdapter: new ThrowingRedeemAdapter() });
    await expect(uncertain.redeemPosition(position.live_position_id, risk.riskDecisionId))
      .rejects.toThrow("TEST_REDEEM_STATUS_UNKNOWN");
    const failed = new DatabaseSync(env.databasePath, { readOnly: true });
    expect((failed.prepare("SELECT status FROM live_positions").get() as { status: string }).status).toBe("FROZEN");
    expect(failed.prepare("SELECT execution_mode,live_gate_state FROM live_gate_state WHERE state_id='default'").get())
      .toEqual({ execution_mode: "PAPER", live_gate_state: "LIVE_DISABLED" });
    failed.close();
    uncertain.close();

    const retry = liveExecutor(env.databasePath, { redeemAdapter: new FakeRedeemAdapter() });
    const recovery = await retry.recoverOnStartup(accountId);
    expect(recovery).toMatchObject({ passed: false, reason: "RECOVERY_RECONCILIATION_FAILED" });
    await expect(retry.redeemPosition(position.live_position_id, risk.riskDecisionId))
      .rejects.toThrow("LIVE_REDEEM_STATUS_UNKNOWN:CREATED");
    const check = new DatabaseSync(env.databasePath, { readOnly: true });
    expect((check.prepare("SELECT status FROM live_redeems").get() as { status: string }).status).toBe("CREATED");
    expect((check.prepare("SELECT settlement_status FROM live_settlement_ledger").get() as { settlement_status: string }).settlement_status)
      .toBe("REDEEM_PENDING");
    expect((check.prepare("SELECT state FROM live_executions WHERE execution_type='REDEEM'").get() as { state: string }).state)
      .toBe("FROZEN");
    expect((check.prepare("SELECT status FROM live_positions").get() as { status: string }).status).toBe("FROZEN");
    expect((check.prepare("SELECT count(*) count FROM live_cash_ledger WHERE entry_type='REDEEM'").get() as { count: number }).count)
      .toBe(0);
    check.close();
    retry.close();
  });
});

describe("LiveIdentityBinding", () => {
  it("accepts only the registered fake wallet and signer identities in isolated tests", async () => {
    const env = setup();
    const binding = new LiveIdentityBinding(
      env.databasePath,
      new FakeWalletProvider({ address: wallet }),
      new FakeSigner(wallet),
      "TEST",
      sourceVersion,
    );
    await expect(binding.check(accountId)).resolves.toMatchObject({
      accountId,
      ready: true,
      walletAddress: wallet,
      signerAddress: wallet,
    });
    binding.close();
  });

  it("fails closed when the runtime wallet identity drifts from the registered account", async () => {
    const env = setup();
    const binding = new LiveIdentityBinding(
      env.databasePath,
      new FakeWalletProvider({ address: "0x0000000000000000000000000000000000000002" }),
      new FakeSigner(wallet),
      "TEST",
      sourceVersion,
    );
    const result = await binding.check(accountId);
    expect(result.ready).toBe(false);
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "runtime_wallet_address", reason: "RUNTIME_WALLET_IDENTITY_MISMATCH" }),
    ]));
    binding.close();
  });
});

describe("LiveRuntime", () => {
  it("runs startup recovery and leaves Live disabled until an explicit arming path", async () => {
    const env = setup();
    const executor = liveExecutor(env.databasePath);
    const consumer = new LiveSignalConsumer(env.databasePath, executor, sourceVersion, () => new Date(now));
    const binding = new LiveIdentityBinding(
      env.databasePath,
      new FakeWalletProvider({ address: wallet }),
      new FakeSigner(wallet),
      "TEST",
      sourceVersion,
    );
    const runtime = new LiveRuntime(new FakeGate(false, "LIVE_DISABLED_IN_TEST"), executor, consumer, binding);
    const recovery = await runtime.recoverOnStartup(accountId);
    expect(recovery.ready).toBe(false);
    expect(recovery.identity?.ready).toBe(true);
    expect(recovery.execution.passed).toBe(true);
    const database = new DatabaseSync(env.databasePath, { readOnly: true });
    expect(database.prepare(
      "SELECT execution_mode,live_gate_state FROM live_gate_state WHERE state_id='default'",
    ).get()).toEqual({ execution_mode: "PAPER", live_gate_state: "LIVE_DISABLED" });
    database.close();
    runtime.close();
  });

  it("marks successful startup recovery ready while the Gate is still waiting for explicit confirmation", async () => {
    const env = setup();
    const executor = liveExecutor(env.databasePath);
    const consumer = new LiveSignalConsumer(env.databasePath, executor, sourceVersion, () => new Date(now));
    const binding = new LiveIdentityBinding(
      env.databasePath,
      new FakeWalletProvider({ address: wallet }),
      new FakeSigner(wallet),
      "TEST",
      sourceVersion,
    );
    const runtime = new LiveRuntime(new FakeGate(true), executor, consumer, binding);
    const recovery = await runtime.recoverOnStartup(accountId);
    expect(recovery.ready).toBe(true);
    expect(recovery.gate.allowed).toBe(true);
    expect(recovery.execution.passed).toBe(true);
    expect(recovery.identity.ready).toBe(true);
    let currentTime = new Date(now).valueOf();
    const run = await runtime.runAfterRecovery({
      accountId,
      durationMs: 1,
      now: () => new Date(currentTime++),
      wait: async () => {},
    });
    expect(run.report.recovery).toEqual(recovery.execution);
    await expect(runtime.runAfterRecovery({
      accountId,
      durationMs: 1,
      now: () => new Date(currentTime++),
      wait: async () => {},
    })).rejects.toThrow("LIVE_RUNTIME_STARTUP_RECOVERY_REQUIRED");
    runtime.close();
  });

  it("rechecks identity at the polling entrypoint and disables the Gate on drift", async () => {
    const env = setup();
    const gate = new FakeGate(false, "LIVE_DISABLED_IN_TEST");
    const executor = liveExecutor(env.databasePath);
    const consumer = new LiveSignalConsumer(env.databasePath, executor, sourceVersion, () => new Date(now));
    const binding = new LiveIdentityBinding(
      env.databasePath,
      new FakeWalletProvider({ address: "0x0000000000000000000000000000000000000002" }),
      new FakeSigner(wallet),
      "TEST",
      sourceVersion,
    );
    const runtime = new LiveRuntime(gate, executor, consumer, binding);
    let currentTime = new Date(now).valueOf();
    const result = await runtime.run({
      accountId,
      durationMs: 1,
      now: () => new Date(currentTime++),
      wait: async () => {},
    });
    expect(result.identity?.ready).toBe(false);
    expect(gate.emergencyDisableReasons).toEqual([
      expect.stringContaining("LIVE_IDENTITY_BINDING_FAILED:RUNTIME_WALLET_IDENTITY_MISMATCH"),
    ]);
    runtime.close();
  });

  it("blocks arming before the Gate when the wallet identity has drifted", async () => {
    const env = setup();
    const gate = new FakeGate(true);
    const executor = liveExecutor(env.databasePath);
    const consumer = new LiveSignalConsumer(env.databasePath, executor, sourceVersion, () => new Date(now));
    const binding = new LiveIdentityBinding(
      env.databasePath,
      new FakeWalletProvider({ address: "0x0000000000000000000000000000000000000002" }),
      new FakeSigner(wallet),
      "TEST",
      sourceVersion,
    );
    const runtime = new LiveRuntime(gate, executor, consumer, binding);
    await expect(runtime.requestActivation(accountId, {
      actor: "TEST",
      reason: "identity drift probe",
    })).rejects.toThrow("LIVE_IDENTITY_BINDING_FAILED:RUNTIME_WALLET_IDENTITY_MISMATCH");
    expect(gate.emergencyDisableReasons).toHaveLength(1);
    runtime.close();
  });

  it("assembles the complete isolated backend graph without credentials or real adapters", async () => {
    const env = setup();
    const assembly = assembleLiveRuntime({
      databasePath: env.databasePath,
      sourceVersion,
      now: () => new Date(now),
      environment: "TEST",
      balanceProvider: new MockBalanceProvider({
        status: "AVAILABLE",
        balanceMicros: "1000000000",
        reason: null,
        checkedAt: now,
        source: "TEST_FIXTURE",
      }),
      geoblockProvider: new FakeGeoblockProvider({
        status: "ALLOWED",
        checkedAt: now,
        source: "TEST_FIXTURE",
        reason: null,
      }),
      complianceProvider: new FakeComplianceProvider({
        status: "ALLOWED",
        checkedAt: now,
        source: "TEST_FIXTURE",
        policyVersion: "TEST_POLICY",
        reason: null,
      }),
      clockProvider: new FakeClockSafetyProvider({
        status: "SAFE",
        offsetMs: 0,
        checkedAt: now,
        source: "TEST_FIXTURE",
        reason: null,
      }),
      orderAdapter: new FakeOrderAdapter(),
      walletProvider: new FakeWalletProvider({ address: wallet }),
      signer: new FakeSigner(wallet),
      redeemAdapter: new FakeRedeemAdapter(),
      marketDataProvider: new FakeLiveMarketDataProvider(),
      requireExternalPositionReconciliation: false,
    });
    const recovery = await assembly.runtime.recoverOnStartup(accountId);
    expect(recovery).toMatchObject({
      ready: false,
      execution: { passed: true },
      identity: { ready: true },
    });
    const database = new DatabaseSync(env.databasePath, { readOnly: true });
    expect(database.prepare(
      "SELECT execution_mode,live_gate_state FROM live_gate_state WHERE state_id='default'",
    ).get()).toEqual({ execution_mode: "PAPER", live_gate_state: "LIVE_DISABLED" });
    database.close();
    assembly.close();
  });
});
