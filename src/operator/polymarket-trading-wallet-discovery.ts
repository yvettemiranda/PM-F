import { decodeFunctionResult, encodeFunctionData } from "viem";
import { PolymarketPublicApi } from "../adapters/polymarket-public.js";
import type { LiveProductionSignatureType } from "./live-production-readiness.js";

const ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const SAFE_ABI = [{
  type: "function",
  name: "getOwners",
  stateMutability: "view",
  inputs: [],
  outputs: [{ name: "", type: "address[]" }],
}] as const;
const POLYGON_RPC_URLS = [
  "https://polygon.drpc.org",
  "https://polygon-bor-rpc.publicnode.com",
] as const;

export interface PolymarketTradingWallet {
  walletAddress: string;
  tradingWalletAddress: string;
  signatureType: LiveProductionSignatureType;
  source: "SIGNER_EOA" | "GAMMA_PROFILE_GNOSIS_SAFE";
}

export interface PolymarketTradingWalletDiscoveryOptions {
  profile?: (walletAddress: string) => Promise<{ proxyWallet?: string | null }>;
  safeOwners?: (walletAddress: string) => Promise<readonly string[]>;
}

function address(value: string, code: string): string {
  const normalized = value.trim().toLowerCase();
  if (!ADDRESS_RE.test(normalized)) throw new Error(code);
  return normalized;
}

async function defaultSafeOwners(walletAddress: string): Promise<readonly string[]> {
  const data = encodeFunctionData({ abi: SAFE_ABI, functionName: "getOwners" });
  let lastError: unknown = null;
  for (const rpcUrl of POLYGON_RPC_URLS) {
    try {
      const response = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_call",
          params: [{ to: walletAddress, data }, "latest"],
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`HTTP_${response.status}`);
      const body = await response.json() as { result?: unknown; error?: unknown };
      if (
        body.error !== undefined
        || typeof body.result !== "string"
        || !/^0x[0-9a-f]+$/i.test(body.result)
      ) {
        throw new Error("RPC_RESULT_INVALID");
      }
      const owners = decodeFunctionResult({
        abi: SAFE_ABI,
        functionName: "getOwners",
        data: body.result as `0x${string}`,
      });
      return owners.map((owner) => owner.toLowerCase());
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    `LIVE_PRODUCTION_SAFE_OWNER_LOOKUP_FAILED:${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

/**
 * Resolves the address that actually holds Polymarket collateral.
 *
 * Gamma's public profile supplies the user's trading wallet address. A
 * distinct address is accepted as an existing Gnosis Safe only after an
 * on-chain owner read proves that the connected browser EOA controls it.
 */
export async function discoverPolymarketTradingWallet(
  walletAddress: string,
  options: PolymarketTradingWalletDiscoveryOptions = {},
): Promise<PolymarketTradingWallet> {
  const signer = address(walletAddress, "LIVE_PRODUCTION_WALLET_ADDRESS_INVALID");
  const publicApi = new PolymarketPublicApi({ timeoutMs: 10_000, maxRetries: 2 });
  const profile = options.profile
    ?? (async (owner: string) => (await publicApi.profile(owner)).data);
  const safeOwners = options.safeOwners ?? defaultSafeOwners;
  const publicProfile = await profile(signer);
  if (publicProfile.proxyWallet === undefined || publicProfile.proxyWallet === null) {
    return {
      walletAddress: signer,
      tradingWalletAddress: signer,
      signatureType: "EOA",
      source: "SIGNER_EOA",
    };
  }
  const funder = address(
    publicProfile.proxyWallet,
    "LIVE_PRODUCTION_TRADING_WALLET_INVALID",
  );
  if (funder === signer) {
    return {
      walletAddress: signer,
      tradingWalletAddress: signer,
      signatureType: "EOA",
      source: "SIGNER_EOA",
    };
  }
  const owners = (await safeOwners(funder)).map((owner) => (
    address(owner, "LIVE_PRODUCTION_SAFE_OWNER_INVALID")
  ));
  if (!owners.includes(signer)) {
    throw new Error("LIVE_PRODUCTION_TRADING_WALLET_OWNER_MISMATCH");
  }
  return {
    walletAddress: signer,
    tradingWalletAddress: funder,
    signatureType: "POLY_GNOSIS_SAFE",
    source: "GAMMA_PROFILE_GNOSIS_SAFE",
  };
}
