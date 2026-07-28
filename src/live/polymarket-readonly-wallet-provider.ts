import { AssetType, type BalanceAllowanceResponse } from "@polymarket/clob-client-v2";
import { PolymarketPublicApi } from "../adapters/polymarket-public.js";
import { decimalToScaled, SHARE_SCALE_DIGITS } from "../domain/fixed.js";
import type { LiveWalletRuntimeBinding } from "../operator/live-wallet-session.js";
import type { BalanceProvider, BalanceProviderInput, BalanceResult } from "./balance-provider.js";
import type {
  WalletAllowance,
  WalletBalance,
  WalletOutcomePositions,
  WalletStatus,
} from "./live-types.js";
import type { SessionAuthenticatedClobClient } from "./session-authenticated-clob-client.js";
import type { WalletProvider } from "./wallet-provider.js";

type BalanceClient = Pick<
  SessionAuthenticatedClobClient,
  "getBalanceAllowance" | "getClosedOnlyMode"
>;
type PositionsApi = Pick<PolymarketPublicApi, "allPositions">;

const INTEGER_RE = /^(?:0|[1-9][0-9]*)$/;
const ADDRESS_RE = /^0x[0-9a-f]{40}$/;

function normalizedAddress(value: string, code: string): string {
  const normalized = value.trim().toLowerCase();
  if (!ADDRESS_RE.test(normalized)) throw new Error(code);
  return normalized;
}

function unsigned(value: unknown, code: string): bigint {
  const text = String(value);
  if (!INTEGER_RE.test(text)) throw new Error(code);
  return BigInt(text);
}

function availableBalance(response: BalanceAllowanceResponse): WalletBalance {
  return {
    status: "AVAILABLE",
    balanceMicros: unsigned(response.balance, "LIVE_WALLET_BALANCE_INVALID").toString(),
    reason: null,
  };
}

function availableAllowance(
  response: BalanceAllowanceResponse,
  requiredSpenders?: readonly string[],
): WalletAllowance {
  const entries = Object.entries(response.allowances);
  const values = requiredSpenders === undefined
    ? entries.map(([, value]) => unsigned(value, "LIVE_WALLET_ALLOWANCE_INVALID"))
    : requiredSpenders.map((spender) => {
      const entry = entries.find(([address]) => address.toLowerCase() === spender.toLowerCase());
      return entry === undefined ? 0n : unsigned(entry[1], "LIVE_WALLET_ALLOWANCE_INVALID");
    });
  if (values.length === 0) {
    return {
      status: "UNAVAILABLE",
      allowanceMicros: null,
      reason: "LIVE_WALLET_ALLOWANCE_MISSING",
    };
  }
  return {
    status: "AVAILABLE",
    allowanceMicros: values.reduce((lowest, value) => value < lowest ? value : lowest).toString(),
    reason: null,
  };
}

async function polygonChainId(rpcUrl: string): Promise<number> {
  let url: URL;
  try {
    url = new URL(rpcUrl);
  } catch {
    throw new Error("LIVE_WALLET_RPC_URL_INVALID");
  }
  if (url.protocol !== "https:") throw new Error("LIVE_WALLET_RPC_URL_INVALID");
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_chainId",
      params: [],
    }),
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`LIVE_WALLET_RPC_HTTP_${response.status}`);
  const body = await response.json() as { result?: unknown; error?: unknown };
  if (body.error !== undefined || typeof body.result !== "string" || !/^0x[0-9a-f]+$/i.test(body.result)) {
    throw new Error("LIVE_WALLET_RPC_CHAIN_INVALID");
  }
  const chainId = Number.parseInt(body.result, 16);
  if (!Number.isSafeInteger(chainId)) throw new Error("LIVE_WALLET_RPC_CHAIN_INVALID");
  return chainId;
}

export interface PolymarketReadonlyWalletProviderOptions {
  walletBinding: LiveWalletRuntimeBinding;
  funderAddress: string;
  clobClient: BalanceClient;
  positionsApi?: PositionsApi;
  polygonRpcUrl?: string;
  chainIdProvider?: () => Promise<number>;
  /** Exact exchange contracts used by the configured order signer. */
  allowanceSpenders?: readonly string[];
}

/**
 * Read-only production wallet projection used by Live safety gates,
 * reconciliation and sizing. It never signs or submits a transaction.
 */
export class PolymarketReadonlyWalletProvider implements WalletProvider {
  readonly providerType = "LIVE_READONLY" as const;
  private readonly funderAddress: string;
  private readonly positionsApi: PositionsApi;
  private readonly chainIdProvider: () => Promise<number>;

  constructor(private readonly options: PolymarketReadonlyWalletProviderOptions) {
    options.walletBinding.assertCurrent();
    this.funderAddress = normalizedAddress(options.funderAddress, "LIVE_WALLET_FUNDER_ADDRESS_INVALID");
    this.positionsApi = options.positionsApi ?? new PolymarketPublicApi();
    this.chainIdProvider = options.chainIdProvider
      ?? (() => polygonChainId(options.polygonRpcUrl ?? "https://polygon.drpc.org"));
  }

  async getChainId(): Promise<number> {
    this.options.walletBinding.assertCurrent();
    const chainId = await this.chainIdProvider();
    this.options.walletBinding.assertCurrent();
    return chainId;
  }

  async getAddress(): Promise<string> {
    this.options.walletBinding.assertCurrent();
    return this.funderAddress;
  }

  async getBalance(): Promise<WalletBalance> {
    return this.readBalance({ asset_type: AssetType.COLLATERAL });
  }

  async getAllowance(): Promise<WalletAllowance> {
    return this.readAllowance({ asset_type: AssetType.COLLATERAL });
  }

  async getOutcomeBalance(assetId: string): Promise<WalletBalance> {
    const tokenId = this.tokenId(assetId);
    return this.readBalance({ asset_type: AssetType.CONDITIONAL, token_id: tokenId });
  }

  async getOutcomeAllowance(assetId: string): Promise<WalletAllowance> {
    const tokenId = this.tokenId(assetId);
    return this.readAllowance({ asset_type: AssetType.CONDITIONAL, token_id: tokenId });
  }

  async getOutcomePositions(): Promise<WalletOutcomePositions> {
    this.options.walletBinding.assertCurrent();
    try {
      const response = await this.positionsApi.allPositions(this.funderAddress);
      this.options.walletBinding.assertCurrent();
      const positions = response.rows
        .map((position) => ({
          assetId: this.tokenId(position.asset),
          balanceMicros: decimalToScaled(position.size, SHARE_SCALE_DIGITS).toString(),
        }))
        .filter((position) => BigInt(position.balanceMicros) > 0n)
        .sort((left, right) => left.assetId.localeCompare(right.assetId));
      return { status: "AVAILABLE", positions, reason: null };
    } catch (error) {
      return {
        status: "UNAVAILABLE",
        positions: [],
        reason: error instanceof Error ? error.message : "LIVE_WALLET_POSITIONS_UNAVAILABLE",
      };
    }
  }

  async getStatus(): Promise<WalletStatus> {
    this.options.walletBinding.assertCurrent();
    try {
      const result = await this.options.clobClient.getClosedOnlyMode();
      this.options.walletBinding.assertCurrent();
      return result.closed_only
        ? { status: "DISABLED", reason: "CLOB_ACCOUNT_CLOSED_ONLY" }
        : { status: "ACTIVE", reason: null };
    } catch (error) {
      return {
        status: "UNKNOWN",
        reason: error instanceof Error ? error.message : "LIVE_WALLET_STATUS_UNAVAILABLE",
      };
    }
  }

  private async readBalance(
    params: Parameters<BalanceClient["getBalanceAllowance"]>[0],
  ): Promise<WalletBalance> {
    this.options.walletBinding.assertCurrent();
    try {
      const response = await this.options.clobClient.getBalanceAllowance(params);
      this.options.walletBinding.assertCurrent();
      return availableBalance(response);
    } catch (error) {
      return {
        status: "UNAVAILABLE",
        balanceMicros: null,
        reason: error instanceof Error ? error.message : "LIVE_WALLET_BALANCE_UNAVAILABLE",
      };
    }
  }

  private async readAllowance(
    params: Parameters<BalanceClient["getBalanceAllowance"]>[0],
  ): Promise<WalletAllowance> {
    this.options.walletBinding.assertCurrent();
    try {
      const response = await this.options.clobClient.getBalanceAllowance(params);
      this.options.walletBinding.assertCurrent();
      return availableAllowance(response, this.options.allowanceSpenders);
    } catch (error) {
      return {
        status: "UNAVAILABLE",
        allowanceMicros: null,
        reason: error instanceof Error ? error.message : "LIVE_WALLET_ALLOWANCE_UNAVAILABLE",
      };
    }
  }

  private tokenId(value: string): string {
    const tokenId = value.trim();
    if (!/^[0-9]+$/.test(tokenId)) throw new Error("LIVE_WALLET_TOKEN_ID_INVALID");
    return tokenId;
  }
}

export class PolymarketReadonlyBalanceProvider implements BalanceProvider {
  readonly providerType = "LIVE_READONLY" as const;

  constructor(private readonly walletProvider: PolymarketReadonlyWalletProvider) {}

  async getBalance(input: BalanceProviderInput): Promise<BalanceResult> {
    const expectedAddress = normalizedAddress(input.walletAddress, "LIVE_BALANCE_ADDRESS_INVALID");
    const actualAddress = await this.walletProvider.getAddress();
    if (actualAddress !== expectedAddress) {
      return { status: "UNAVAILABLE", balanceMicros: null, reason: "LIVE_BALANCE_WALLET_MISMATCH" };
    }
    if (input.network !== "POLYGON" && input.network !== "polygon:137") {
      return { status: "UNAVAILABLE", balanceMicros: null, reason: "LIVE_BALANCE_NETWORK_MISMATCH" };
    }
    const result = await this.walletProvider.getBalance();
    return {
      ...result,
      checkedAt: new Date().toISOString(),
      source: "POLYMARKET_CLOB_BALANCE_ALLOWANCE",
    };
  }
}
