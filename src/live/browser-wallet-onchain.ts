import {
  AssetType,
  type BalanceAllowanceResponse,
} from "@polymarket/clob-client-v2";
import { encodeFunctionData, parseAbi, zeroHash, type Hex } from "viem";
import { stableJson } from "../domain/versioning.js";
import type { LiveWalletRequestBroker } from "../operator/live-wallet-request-broker.js";
import type { LiveWalletRuntimeBinding } from "../operator/live-wallet-session.js";
import type { ConfirmedRedemptionEvidence, RedeemAdapter, RedeemInput, RedeemResult } from "./redeem-adapter.js";
import { PublicMarketRouteProvider, marketRoute, validateMarketRoute, type MarketRouteProvider, type PolymarketMarketRoute } from "./market-protocol.js";
import { RpcPolygonChainReader, type PolygonChainReader } from "./polygon-chain-reader.js";
import { walletTransactionRoute, type ExecutableWalletType } from "./wallet-transaction-route.js";
import { RedemptionJournal } from "./redemption-journal.js";
import { verifyRedemptionReceipt } from "./redemption-evidence.js";

type TransactionBroker = Pick<LiveWalletRequestBroker, "requestTransaction">;

const ERC20_ABI = [{
  type: "function",
  name: "approve",
  stateMutability: "nonpayable",
  inputs: [
    { name: "spender", type: "address" },
    { name: "amount", type: "uint256" },
  ],
  outputs: [{ name: "", type: "bool" }],
}] as const;

const ERC1155_ABI = [{
  type: "function",
  name: "setApprovalForAll",
  stateMutability: "nonpayable",
  inputs: [
    { name: "operator", type: "address" },
    { name: "approved", type: "bool" },
  ],
  outputs: [],
}] as const;

const CONDITIONAL_TOKENS_ABI = [{
  type: "function",
  name: "redeemPositions",
  stateMutability: "nonpayable",
  inputs: [
    { name: "collateralToken", type: "address" },
    { name: "parentCollectionId", type: "bytes32" },
    { name: "conditionId", type: "bytes32" },
    { name: "indexSets", type: "uint256[]" },
  ],
  outputs: [],
}] as const;

function integer(value: unknown, code: string): bigint {
  const text = String(value);
  if (!/^(?:0|[1-9][0-9]*)$/.test(text)) throw new Error(code);
  return BigInt(text);
}

function requiredAllowance(
  response: BalanceAllowanceResponse,
  spender: string,
  code: string,
): bigint {
  const entry = Object.entries(response.allowances).find(
    ([address]) => address.toLowerCase() === spender.toLowerCase(),
  );
  return entry ? integer(entry[1], code) : 0n;
}

export interface TransactionReceiptResult {
  transactionHash: string;
  blockNumber: bigint;
  confirmations: number;
  from?: string;
  to?: string;
  logs?: Array<{ address: string; data: Hex; topics: [Hex, ...Hex[]]; removed?: boolean }>;
}

export interface TransactionReceiptProvider {
  waitForSuccess(transactionHash: string): Promise<TransactionReceiptResult>;
  /** One bounded read for maintenance loops; null means not yet confirmed. */
  confirmedReceipt?(transactionHash: string): Promise<TransactionReceiptResult | null>;
}

export class PolygonTransactionReceiptProvider implements TransactionReceiptProvider {
  constructor(
    private readonly rpcUrl = "https://polygon.drpc.org",
    private readonly options: {
      fetchImpl?: typeof fetch;
      pollIntervalMs?: number;
      timeoutMs?: number;
      confirmations?: number;
      nowMs?: () => number;
      wait?: (milliseconds: number) => Promise<void>;
    } = {},
  ) {
    const url = new URL(rpcUrl);
    if (url.protocol !== "https:") throw new Error("LIVE_TRANSACTION_RPC_URL_INVALID");
  }

  async waitForSuccess(transactionHash: string): Promise<TransactionReceiptResult> {
    if (!/^0x[0-9a-fA-F]{64}$/.test(transactionHash)) {
      throw new Error("LIVE_TRANSACTION_HASH_INVALID");
    }
    const pollIntervalMs = this.options.pollIntervalMs ?? 1_500;
    const timeoutMs = this.options.timeoutMs ?? 120_000;
    const nowMs = this.options.nowMs ?? Date.now;
    const wait = this.options.wait ?? ((milliseconds) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
    const startedAt = nowMs();
    while (nowMs() - startedAt <= timeoutMs) {
      const receipt = await this.confirmedReceipt(transactionHash);
      if (receipt) return receipt;
      await wait(pollIntervalMs);
    }
    throw new Error("LIVE_TRANSACTION_CONFIRMATION_TIMEOUT");
  }

  async confirmedReceipt(transactionHash: string): Promise<TransactionReceiptResult | null> {
    if (!/^0x[0-9a-fA-F]{64}$/.test(transactionHash)) throw new Error("LIVE_TRANSACTION_HASH_INVALID");
    const confirmationsRequired = this.options.confirmations ?? 2;
    const receipt = await this.rpc("eth_getTransactionReceipt", [transactionHash]) as {
        status?: string;
        blockNumber?: string;
        transactionHash?: string;
        from?: string;
        to?: string;
        logs?: TransactionReceiptResult["logs"];
      } | null;
      if (receipt !== null) {
        if (receipt.status === "0x0") throw new Error("LIVE_TRANSACTION_REVERTED");
        if (receipt.status !== "0x1") throw new Error("LIVE_TRANSACTION_RECEIPT_INVALID");
        if (
          typeof receipt.blockNumber !== "string"
          || !/^0x[0-9a-f]+$/i.test(receipt.blockNumber)
          || receipt.transactionHash?.toLowerCase() !== transactionHash.toLowerCase()
        ) {
          throw new Error("LIVE_TRANSACTION_RECEIPT_INVALID");
        }
        const receiptBlock = BigInt(receipt.blockNumber);
        const latestHex = await this.rpc("eth_blockNumber", []);
        if (typeof latestHex !== "string" || !/^0x[0-9a-f]+$/i.test(latestHex)) {
          throw new Error("LIVE_TRANSACTION_BLOCK_INVALID");
        }
        const latest = BigInt(latestHex);
        const confirmations = latest >= receiptBlock ? Number(latest - receiptBlock + 1n) : 0;
        if (confirmations >= confirmationsRequired) {
          return {
            transactionHash: transactionHash.toLowerCase(),
            blockNumber: receiptBlock,
            confirmations,
            ...(receipt.from === undefined ? {} : { from: receipt.from }),
            ...(receipt.to === undefined ? {} : { to: receipt.to }),
            ...(receipt.logs === undefined ? {} : { logs: receipt.logs }),
          };
        }
      }
    return null;
  }

  private async rpc(method: string, params: readonly unknown[]): Promise<unknown> {
    const response = await (this.options.fetchImpl ?? fetch)(this.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`LIVE_TRANSACTION_RPC_HTTP_${response.status}`);
    const body = await response.json() as { result?: unknown; error?: unknown };
    if (body.error !== undefined) throw new Error("LIVE_TRANSACTION_RPC_ERROR");
    return body.result;
  }
}

export interface WalletAllowancePreparationResult {
  collateralApprovalTransaction: string | null;
  outcomeApprovalTransaction: string | null;
  ready: boolean;
  reason?: string;
}

export class BrowserWalletAllowanceManager {
  private readonly chain: PolygonChainReader;
  constructor(private readonly options: {
    walletBinding: LiveWalletRuntimeBinding;
    requestBroker: TransactionBroker;
    receiptProvider: TransactionReceiptProvider;
    clobClient: {
      getBalanceAllowance(params: { asset_type: AssetType; token_id?: string }): Promise<BalanceAllowanceResponse>;
      updateBalanceAllowance(params: { asset_type: AssetType; token_id?: string }): Promise<void>;
    };
    bankrollMicros: string;
    signatureType: ExecutableWalletType;
    tradingWalletAddress: string;
    chainReader?: PolygonChainReader;
    routes?: PolymarketMarketRoute[];
  }) { this.chain = options.chainReader ?? new RpcPolygonChainReader(); }

  async prepare(): Promise<WalletAllowancePreparationResult> {
    this.options.walletBinding.assertCurrent();
    // Set up each declared market protocol on its actual token ledger. The
    // conditional allowance API requires a token ID; operator approvals are
    // therefore read directly from that ledger instead of a tokenless request.
    const routes = this.options.routes ?? [
      marketRoute({ assetId: "0", conditionId: `0x${"0".repeat(64)}`, neg_risk: false }),
      marketRoute({ assetId: "0", conditionId: `0x${"0".repeat(64)}`, neg_risk: true }),
      marketRoute({ assetId: "0", conditionId: `0x${"0".repeat(62)}`, version: "v2" }),
    ];
    const collateral = await this.options.clobClient.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
    this.options.walletBinding.assertCurrent();
    const cap = integer(this.options.bankrollMicros, "LIVE_BANKROLL_INVALID");
    const balance = integer(collateral.balance, "LIVE_COLLATERAL_BALANCE_INVALID");
    const required = balance < cap ? balance : cap;
    if (required === 0n) return { collateralApprovalTransaction: null, outcomeApprovalTransaction: null,
      ready: false, reason: "LIVE_WALLET_SETUP_DEFERRED_NO_COLLATERAL" };
    let collateralApprovalTransaction: string | null = null;
    let outcomeApprovalTransaction: string | null = null;
    for (const route of routes) {
      if (requiredAllowance(collateral, route.exchange, "LIVE_COLLATERAL_ALLOWANCE_INVALID") < required) {
        collateralApprovalTransaction = await this.send(route.collateral, encodeFunctionData({
          abi: ERC20_ABI, functionName: "approve", args: [route.exchange, required],
        }), `授权 ${route.protocol} Exchange 最多使用 ${required} 个 pUSD 基础单位`);
        await this.options.clobClient.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL });
        const refreshed = await this.options.clobClient.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
        if (requiredAllowance(refreshed, route.exchange, "LIVE_COLLATERAL_ALLOWANCE_INVALID") < required) throw new Error("LIVE_COLLATERAL_APPROVAL_NOT_EFFECTIVE");
      }
      if (!await this.chain.isApprovedForAll(route.outcomeToken, this.options.tradingWalletAddress, route.exchange)) {
        outcomeApprovalTransaction = await this.send(route.outcomeToken, encodeFunctionData({
          abi: ERC1155_ABI, functionName: "setApprovalForAll", args: [route.exchange, true],
        }), `允许 ${route.protocol} Exchange 卖出对应协议的预测市场仓位`);
        if (!await this.chain.isApprovedForAll(route.outcomeToken, this.options.tradingWalletAddress, route.exchange)) throw new Error("LIVE_OUTCOME_APPROVAL_NOT_EFFECTIVE");
      }
    }
    return { collateralApprovalTransaction, outcomeApprovalTransaction, ready: true };
  }
  private async send(target: `0x${string}`, data: `0x${string}`, purpose: string): Promise<string> {
    const transaction = await walletTransactionRoute({ signatureType: this.options.signatureType,
      tradingWallet: this.options.tradingWalletAddress, signerAddress: this.options.walletBinding.session.walletAddress,
      target, data, chain: this.chain });
    this.options.walletBinding.assertCurrent();
    const hash = await this.options.requestBroker.requestTransaction(this.options.walletBinding, { ...transaction, purpose });
    await this.options.receiptProvider.waitForSuccess(hash);
    this.options.walletBinding.assertCurrent();
    return hash;
  }
}

interface DurableRedeemIntent {
  kind: "REDEEM" | "APPROVAL";
  input: RedeemInput;
  route: PolymarketMarketRoute;
  transaction: { to: string; data: string };
  sender: string;
}
const ROUTER_ABI = parseAbi(["function redeem(bytes31 conditionId,uint256 outcomeIndex,uint256 amount)"]);

export class BrowserWalletRedeemAdapter implements RedeemAdapter {
  readonly adapterType = "LIVE" as const;
  private readonly chain: PolygonChainReader;
  private readonly routes: MarketRouteProvider;
  constructor(private readonly options: {
    walletBinding: LiveWalletRuntimeBinding;
    requestBroker: TransactionBroker;
    receiptProvider: TransactionReceiptProvider;
    signatureType: ExecutableWalletType;
    tradingWalletAddress: string;
    journal?: RedemptionJournal;
    chainReader?: PolygonChainReader;
    routeProvider?: MarketRouteProvider;
  }) {
    this.chain = options.chainReader ?? new RpcPolygonChainReader();
    this.routes = options.routeProvider ?? new PublicMarketRouteProvider();
  }

  async redeem(input: RedeemInput, options: {
    recoverOnly?: boolean; prepareOnly?: boolean; beforeSubmit?: () => void;
  } = {}): Promise<RedeemResult> {
    const journal = this.options.journal;
    if (!journal) throw new Error("LIVE_REDEEM_DURABLE_JOURNAL_REQUIRED");
    const custody = input.custody;
    if (!custody || custody.walletAddress.toLowerCase() !== this.options.tradingWalletAddress.toLowerCase()
      || integer(custody.managedSizeMicros, "LIVE_REDEEM_CUSTODY_INVALID") <= 0n
      || custody.lots.some(lot => !lot.positionId || integer(lot.sizeMicros, "LIVE_REDEEM_CUSTODY_INVALID") <= 0n
        || !/^(?:0|[1-9][0-9]*)$/.test(lot.assetId ?? input.assetId))
      || new Set(custody.lots.map(lot => lot.positionId)).size !== custody.lots.length
      || custody.lots.reduce((sum, lot) => sum + integer(lot.sizeMicros, "LIVE_REDEEM_CUSTODY_INVALID"), 0n) !== BigInt(custody.managedSizeMicros)) {
      throw new Error("LIVE_REDEEM_CUSTODY_INVALID");
    }
    integer(custody.expectedPayoutMicros, "LIVE_REDEEM_PAYOUT_INVALID");
    const existing = journal.get(input.idempotencyKey);
    if (existing) {
      const intent = JSON.parse(existing.intent_json) as DurableRedeemIntent;
      if (stableJson(intent.input) !== stableJson(input)) throw new Error("LIVE_REDEEM_INTENT_CONFLICT");
      if (existing.state !== "PREPARED") return this.resume(input.idempotencyKey, intent);
    }
    if (options.recoverOnly) {
      // Approval may already be on chain while the redemption itself remains
      // PREPARED. Recovery can confirm that hash without sending either call.
      const approval = journal.get(`${input.idempotencyKey}:APPROVAL`);
      if (approval && approval.state !== "PREPARED") {
        const resumed = await this.resume(approval.idempotency_key, JSON.parse(approval.intent_json) as DurableRedeemIntent);
        if (resumed.status !== "CONFIRMED") return resumed;
      }
      return { adapterType: "LIVE", status: "SUBMITTED", raw: { reason: "LIVE_REDEEM_RECOVERY_NO_SUBMISSION", idempotencyKey: input.idempotencyKey } };
    }
    this.options.walletBinding.assertCurrent();
    const route = existing ? (JSON.parse(existing.intent_json) as DurableRedeemIntent).route
      : validateMarketRoute(input.marketRoute ?? await this.routes.resolve(input.assetId, input.conditionId), input.assetId, input.conditionId);
    const managed = BigInt(custody.managedSizeMicros);
    await this.assertCustody(input, route);
    let data: `0x${string}`;
    if (route.protocol === "POLY_V2") {
      const token = BigInt(route.assetId);
      const condition = `0x${(token >> 8n).toString(16).padStart(62, "0")}`;
      const outcome = token & 255n;
      if (condition !== route.conditionId || outcome > 1n) throw new Error("LIVE_REDEEM_V2_ASSET_NOT_VERIFIED");
      data = encodeFunctionData({ abi: ROUTER_ABI, functionName: "redeem", args: [route.conditionId as Hex, outcome, managed] });
    } else {
      // The deployed adapter ignores indexSets and redeems both outcomes.
      // assertCustody proved ownership of every nonzero balance on both sides.
      data = encodeFunctionData({ abi: CONDITIONAL_TOKENS_ABI, functionName: "redeemPositions",
        args: [route.collateral, zeroHash, route.conditionId as Hex, [1n, 2n]] });
    }
    const transaction = await walletTransactionRoute({ signatureType: this.options.signatureType,
      tradingWallet: custody.walletAddress, signerAddress: this.options.walletBinding.session.walletAddress,
      target: route.redemptionTarget, data, chain: this.chain });
    const intent: DurableRedeemIntent = { kind: "REDEEM", input, route, transaction, sender: this.options.walletBinding.session.walletAddress };
    journal.prepare(input.idempotencyKey, custody.walletAddress, input.assetId, intent);
    if (options.prepareOnly) {
      return { adapterType: "LIVE", status: "SUBMITTED", raw: { reason: "LIVE_REDEEM_PREPARED", idempotencyKey: input.idempotencyKey } };
    }
    const approvalKey = `${input.idempotencyKey}:APPROVAL`;
    const priorApproval = journal.get(approvalKey);
    if (priorApproval || !await this.chain.isApprovedForAll(route.outcomeToken, custody.walletAddress, route.redemptionTarget)) {
      const approval: DurableRedeemIntent = priorApproval ? JSON.parse(priorApproval.intent_json) as DurableRedeemIntent : {
        ...intent, kind: "APPROVAL", transaction: await walletTransactionRoute({ signatureType: this.options.signatureType,
          tradingWallet: custody.walletAddress, signerAddress: intent.sender, target: route.outcomeToken,
          data: encodeFunctionData({ abi: ERC1155_ABI, functionName: "setApprovalForAll", args: [route.redemptionTarget, true] }), chain: this.chain }),
      };
      journal.prepare(approvalKey, custody.walletAddress, input.assetId, approval);
      const result = await this.sendOrResume(approvalKey, approval, options.beforeSubmit);
      if (result.status !== "CONFIRMED") return result;
      if (!await this.chain.isApprovedForAll(route.outcomeToken, custody.walletAddress, route.redemptionTarget)) {
        return { adapterType: "LIVE", status: "FAILED", raw: { reason: "LIVE_REDEEM_APPROVAL_NOT_EFFECTIVE" } };
      }
    }
    return this.sendOrResume(input.idempotencyKey, intent, options.beforeSubmit);
  }

  private async assertCustody(input: RedeemInput, route: PolymarketMarketRoute): Promise<void> {
    const custody = input.custody!;
    const rights = new Map<string, bigint>();
    for (const lot of custody.lots) {
      const asset = lot.assetId ?? input.assetId;
      rights.set(asset, (rights.get(asset) ?? 0n) + BigInt(lot.sizeMicros));
    }
    if (!rights.has(input.assetId)) throw new Error("LIVE_REDEEM_CUSTODY_ASSET_INVALID");
    if (route.protocol === "POLY_V2") {
      if (rights.size !== 1) throw new Error("LIVE_REDEEM_V2_MULTIPLE_ASSETS_UNSUPPORTED");
      const balance = await this.chain.balanceOf(route.outcomeToken, custody.walletAddress, route.assetId);
      if (balance < BigInt(custody.managedSizeMicros)) throw new Error("LIVE_REDEEM_CUSTODY_BALANCE_MISMATCH");
      return;
    }
    const assets = await this.chain.ctfPositions(route);
    if (assets.length !== 2 || assets[0] === assets[1] || !assets.includes(input.assetId)
      || [...rights.keys()].some(asset => !assets.includes(asset))) throw new Error("LIVE_REDEEM_CTF_ASSET_NOT_VERIFIED");
    const balances = this.chain.balancesOf === undefined
      ? await Promise.all(assets.map(asset => this.chain.balanceOf(route.outcomeToken, custody.walletAddress, asset)))
      : await this.chain.balancesOf(route.outcomeToken, custody.walletAddress, assets);
    if (balances.length !== 2 || balances.some((balance, index) => typeof balance !== "bigint"
      || balance < 0n || balance !== (rights.get(assets[index]!) ?? 0n))) throw new Error("LIVE_REDEEM_CUSTODY_BALANCE_MISMATCH");
  }

  private async sendOrResume(key: string, intent: DurableRedeemIntent, beforeSubmit?: () => void): Promise<RedeemResult> {
    const journal = this.options.journal!;
    if (journal.get(key)?.state !== "PREPARED") return this.resume(key, intent);
    this.options.walletBinding.assertCurrent();
    if (intent.kind === "REDEEM") {
      await this.assertCustody(intent.input, intent.route);
    }
    this.options.walletBinding.assertCurrent();
    beforeSubmit?.();
    try {
      if (!journal.claim(key)) return this.resume(key, intent);
    } catch {
      return { adapterType: "LIVE", status: "SUBMITTED", raw: { reason: "LIVE_REDEEM_WALLET_TRANSACTION_INFLIGHT", idempotencyKey: key } };
    }
    try {
      const hash = await this.options.requestBroker.requestTransaction(this.options.walletBinding, {
        ...intent.transaction, purpose: intent.kind === "APPROVAL" ? "授权结算适配器赎回受管仓位" : `赎回受管仓位 ${intent.input.positionId}`,
      });
      // This durable write precedes every receipt await, including failures.
      journal.submitted(key, hash);
    } catch (error) {
      return { adapterType: "LIVE", status: "SUBMITTED", raw: { reason: error instanceof Error ? error.message : "LIVE_REDEEM_SUBMISSION_UNKNOWN", idempotencyKey: key } };
    }
    return this.resume(key, intent);
  }

  private async resume(key: string, intent: DurableRedeemIntent): Promise<RedeemResult> {
    const journal = this.options.journal!;
    const row = journal.get(key)!;
    if (row.state === "CONFIRMED") return { adapterType: "LIVE", status: "CONFIRMED",
      ...(intent.kind === "REDEEM" ? { evidence: JSON.parse(row.evidence_json!) as ConfirmedRedemptionEvidence } : {}),
      raw: { idempotencyKey: key, transactionHash: row.transaction_hash, recovered: true } };
    if (row.state === "FAILED") return { adapterType: "LIVE", status: "FAILED", raw: { idempotencyKey: key, reason: row.evidence_json } };
    if (!row.transaction_hash) return { adapterType: "LIVE", status: "SUBMITTED", raw: { idempotencyKey: key, reason: "LIVE_REDEEM_SUBMISSION_UNKNOWN" } };
    let receipt: TransactionReceiptResult;
    try {
      const provider = this.options.receiptProvider;
      const current = provider.confirmedReceipt === undefined
        ? await provider.waitForSuccess(row.transaction_hash)
        : await provider.confirmedReceipt(row.transaction_hash);
      if (current === null) return { adapterType: "LIVE", status: "SUBMITTED",
        raw: { idempotencyKey: key, transactionHash: row.transaction_hash, reason: "LIVE_REDEEM_CONFIRMATION_PENDING" } };
      receipt = current;
    }
    catch (error) {
      const reason = error instanceof Error ? error.message : "LIVE_REDEEM_RECEIPT_UNAVAILABLE";
      if (reason === "LIVE_TRANSACTION_REVERTED") journal.failed(key, reason);
      return { adapterType: "LIVE", status: reason === "LIVE_TRANSACTION_REVERTED" ? "FAILED" : "SUBMITTED", raw: { idempotencyKey: key, transactionHash: row.transaction_hash, reason } };
    }
    try {
      if (receipt.transactionHash.toLowerCase() !== row.transaction_hash.toLowerCase()
        || receipt.to?.toLowerCase() !== intent.transaction.to.toLowerCase()
        || receipt.from?.toLowerCase() !== intent.sender.toLowerCase() || receipt.confirmations < 2) {
        throw new Error("LIVE_REDEEM_RECEIPT_IDENTITY_INVALID");
      }
      const evidence = intent.kind === "APPROVAL" ? { transactionHash: receipt.transactionHash } : verifyRedemptionReceipt({
        receipt, transactionHash: row.transaction_hash, transactionTo: intent.transaction.to,
        transactionFrom: intent.sender, route: intent.route, custody: intent.input.custody!,
      });
      journal.confirmed(key, evidence);
      return { adapterType: "LIVE", status: "CONFIRMED",
        ...(intent.kind === "REDEEM" ? { evidence: evidence as ConfirmedRedemptionEvidence } : {}),
        raw: { transactionHash: row.transaction_hash, idempotencyKey: key, protocol: intent.route.protocol } };
    } catch (error) {
      return { adapterType: "LIVE", status: "SUBMITTED", raw: { transactionHash: row.transaction_hash, idempotencyKey: key,
        reason: error instanceof Error ? error.message : "LIVE_REDEEM_EVIDENCE_INVALID" } };
    }
  }
}
