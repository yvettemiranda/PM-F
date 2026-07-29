import {
  AssetType,
  Chain,
  getContractConfig,
  type BalanceAllowanceResponse,
} from "@polymarket/clob-client-v2";
import { encodeFunctionData, zeroHash } from "viem";
import type { LiveWalletRequestBroker } from "../operator/live-wallet-request-broker.js";
import type { LiveWalletRuntimeBinding } from "../operator/live-wallet-session.js";
import type { RedeemAdapter, RedeemResult } from "./redeem-adapter.js";

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
}

export interface TransactionReceiptProvider {
  waitForSuccess(transactionHash: string): Promise<TransactionReceiptResult>;
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
    const confirmationsRequired = this.options.confirmations ?? 2;
    const nowMs = this.options.nowMs ?? Date.now;
    const wait = this.options.wait ?? ((milliseconds) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
    const startedAt = nowMs();
    while (nowMs() - startedAt <= timeoutMs) {
      const receipt = await this.rpc("eth_getTransactionReceipt", [transactionHash]) as {
        status?: string;
        blockNumber?: string;
        transactionHash?: string;
      } | null;
      if (receipt !== null) {
        if (receipt.status !== "0x1") throw new Error("LIVE_TRANSACTION_REVERTED");
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
          };
        }
      }
      await wait(pollIntervalMs);
    }
    throw new Error("LIVE_TRANSACTION_CONFIRMATION_TIMEOUT");
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
  private readonly contracts = getContractConfig(Chain.POLYGON);

  constructor(private readonly options: {
    walletBinding: LiveWalletRuntimeBinding;
    requestBroker: TransactionBroker;
    receiptProvider: TransactionReceiptProvider;
    clobClient: {
      getBalanceAllowance(
        params: { asset_type: AssetType; token_id?: string },
      ): Promise<BalanceAllowanceResponse>;
      updateBalanceAllowance(
        params: { asset_type: AssetType; token_id?: string },
      ): Promise<void>;
    };
    bankrollMicros: string;
    signatureType: "EOA" | "POLY_PROXY" | "POLY_GNOSIS_SAFE" | "POLY_1271";
    tradingWalletAddress: string;
  }) {}

  async prepare(): Promise<WalletAllowancePreparationResult> {
    this.options.walletBinding.assertCurrent();
    const directEoa = this.options.signatureType === "EOA"
      && this.options.tradingWalletAddress === this.options.walletBinding.session.walletAddress;
    const configuredCap = integer(this.options.bankrollMicros, "LIVE_BANKROLL_INVALID");
    const collateral = await this.options.clobClient.getBalanceAllowance({
      asset_type: AssetType.COLLATERAL,
    });
    const outcome = await this.options.clobClient.getBalanceAllowance({
      asset_type: AssetType.CONDITIONAL,
    });
    const actualCollateral = integer(collateral.balance, "LIVE_COLLATERAL_BALANCE_INVALID");
    const requiredCollateral = actualCollateral < configuredCap ? actualCollateral : configuredCap;
    if (requiredCollateral === 0n) {
      return {
        collateralApprovalTransaction: null,
        outcomeApprovalTransaction: null,
        ready: false,
        reason: "LIVE_WALLET_SETUP_DEFERRED_NO_COLLATERAL",
      };
    }
    const collateralReady = requiredAllowance(
      collateral,
      this.contracts.exchangeV3,
      "LIVE_COLLATERAL_ALLOWANCE_INVALID",
    ) >= requiredCollateral;
    const outcomeReady = requiredAllowance(
      outcome,
      this.contracts.exchangeV3,
      "LIVE_OUTCOME_ALLOWANCE_INVALID",
    ) > 0n;
    if (!directEoa && (!collateralReady || !outcomeReady)) {
      return {
        collateralApprovalTransaction: null,
        outcomeApprovalTransaction: null,
        ready: false,
        reason: "LIVE_SMART_WALLET_ALLOWANCE_DEFERRED",
      };
    }
    let collateralApprovalTransaction: string | null = null;
    let outcomeApprovalTransaction: string | null = null;
    if (!collateralReady) {
      const data = encodeFunctionData({
        abi: ERC20_ABI,
        functionName: "approve",
        args: [this.contracts.exchangeV3 as `0x${string}`, requiredCollateral],
      });
      collateralApprovalTransaction = await this.options.requestBroker.requestTransaction(
        this.options.walletBinding,
        {
          to: this.contracts.collateral,
          data,
          purpose: `授权 Exchange V3 最多使用 ${requiredCollateral} 个 pUSD 基础单位`,
        },
      );
      await this.options.receiptProvider.waitForSuccess(collateralApprovalTransaction);
      await this.options.clobClient.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL });
    }
    if (!outcomeReady) {
      const data = encodeFunctionData({
        abi: ERC1155_ABI,
        functionName: "setApprovalForAll",
        args: [this.contracts.exchangeV3 as `0x${string}`, true],
      });
      outcomeApprovalTransaction = await this.options.requestBroker.requestTransaction(
        this.options.walletBinding,
        {
          to: this.contracts.conditionalTokens,
          data,
          purpose: "允许 Exchange V3 卖出本钱包持有的预测市场仓位",
        },
      );
      await this.options.receiptProvider.waitForSuccess(outcomeApprovalTransaction);
      await this.options.clobClient.updateBalanceAllowance({ asset_type: AssetType.CONDITIONAL });
    }
    return {
      collateralApprovalTransaction,
      outcomeApprovalTransaction,
      ready: true,
    };
  }
}

export class BrowserWalletRedeemAdapter implements RedeemAdapter {
  readonly adapterType = "LIVE" as const;
  private readonly contracts = getContractConfig(Chain.POLYGON);

  constructor(private readonly options: {
    walletBinding: LiveWalletRuntimeBinding;
    requestBroker: TransactionBroker;
    receiptProvider: TransactionReceiptProvider;
    signatureType: "EOA" | "POLY_PROXY" | "POLY_GNOSIS_SAFE" | "POLY_1271";
    tradingWalletAddress: string;
  }) {}

  async redeem(input: {
    positionId: string;
    conditionId: string;
    assetId: string;
    idempotencyKey: string;
  }): Promise<RedeemResult> {
    this.options.walletBinding.assertCurrent();
    if (
      this.options.signatureType !== "EOA"
      || this.options.tradingWalletAddress !== this.options.walletBinding.session.walletAddress
    ) {
      throw new Error("LIVE_SMART_WALLET_REDEEM_REQUIRES_POLYMARKET_RELAYER");
    }
    if (!/^0x[0-9a-fA-F]{64}$/.test(input.conditionId)) {
      throw new Error("LIVE_REDEEM_CONDITION_ID_INVALID");
    }
    const data = encodeFunctionData({
      abi: CONDITIONAL_TOKENS_ABI,
      functionName: "redeemPositions",
      args: [
        this.contracts.collateral as `0x${string}`,
        zeroHash,
        input.conditionId as `0x${string}`,
        [1n, 2n],
      ],
    });
    const transactionHash = await this.options.requestBroker.requestTransaction(
      this.options.walletBinding,
      {
        to: this.contracts.conditionalTokens,
        data,
        purpose: `赎回已结算仓位 ${input.positionId}`,
      },
    );
    const receipt = await this.options.receiptProvider.waitForSuccess(transactionHash);
    return {
      adapterType: this.adapterType,
      status: "CONFIRMED",
      raw: {
        transactionHash: receipt.transactionHash,
        blockNumber: receipt.blockNumber.toString(),
        confirmations: receipt.confirmations,
        conditionId: input.conditionId,
        assetId: input.assetId,
        idempotencyKey: input.idempotencyKey,
      },
    };
  }
}
