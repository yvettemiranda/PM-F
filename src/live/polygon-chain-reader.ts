import { decodeFunctionResult, encodeFunctionData, parseAbi, zeroHash, type Hex } from "viem";
import type { PolymarketMarketRoute } from "./market-protocol.js";

const READ_ABI = parseAbi([
  "function balanceOf(address account,uint256 id) view returns(uint256)",
  "function balanceOfBatch(address[] accounts,uint256[] ids) view returns(uint256[])",
  "function isApprovedForAll(address owner,address operator) view returns(bool)",
  "function getThreshold() view returns(uint256)",
  "function getOwners() view returns(address[])",
  "function getCollectionId(bytes32 parent,bytes32 condition,uint256 indexSet) view returns(bytes32)",
  "function getPositionId(address collateral,bytes32 collection) view returns(uint256)",
  "function USDCE() view returns(address)",
  "function WRAPPED_COLLATERAL() view returns(address)",
  "function COLLATERAL_TOKEN() view returns(address)",
  "function CONDITIONAL_TOKENS() view returns(address)",
  "function getOutcomeSlotCount(bytes32 condition) view returns(uint256)",
]);
export interface PolygonChainReader {
  balanceOf(token: string, wallet: string, assetId: string): Promise<bigint>;
  /** One ERC-1155 call, with every requested asset anchored to the same block. */
  balancesOf?(token: string, wallet: string, assetIds: readonly string[]): Promise<bigint[]>;
  isApprovedForAll(token: string, wallet: string, operator: string): Promise<boolean>;
  safeOwners(wallet: string): Promise<{ threshold: bigint; owners: string[] }>;
  ctfIndexSet(route: PolymarketMarketRoute): Promise<"1" | "2">;
  /** Actual adapter backing, ordered by binary indexSet 1 then 2. */
  ctfPositions(route: PolymarketMarketRoute): Promise<[string, string]>;
}
export class RpcPolygonChainReader implements PolygonChainReader {
  constructor(private readonly rpcUrl = "https://polygon.drpc.org", private readonly fetchImpl: typeof fetch = fetch) {
    if (new URL(rpcUrl).protocol !== "https:") throw new Error("LIVE_TRANSACTION_RPC_URL_INVALID");
  }
  private async read(address: string, name: typeof READ_ABI[number]["name"], args: readonly unknown[]): Promise<unknown> {
    const data = encodeFunctionData({ abi: READ_ABI, functionName: name, args } as Parameters<typeof encodeFunctionData>[0]);
    const response = await this.fetchImpl(this.rpcUrl, {
      method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(5_000),
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: address, data }, "latest"] }),
    });
    if (!response.ok) throw new Error(`LIVE_CHAIN_READ_HTTP_${response.status}`);
    const value = await response.json() as { result?: Hex; error?: unknown };
    if (value.error !== undefined || typeof value.result !== "string") throw new Error("LIVE_CHAIN_READ_FAILED");
    return decodeFunctionResult({ abi: READ_ABI, functionName: name, data: value.result });
  }
  async balanceOf(token: string, wallet: string, assetId: string): Promise<bigint> {
    return await this.read(token, "balanceOf", [wallet, BigInt(assetId)]) as bigint;
  }
  async balancesOf(token: string, wallet: string, assetIds: readonly string[]): Promise<bigint[]> {
    const result = await this.read(token, "balanceOfBatch", [assetIds.map(() => wallet), assetIds.map(id => BigInt(id))]) as bigint[];
    if (result.length !== assetIds.length) throw new Error("LIVE_REDEEM_CUSTODY_BALANCE_INVALID");
    return result;
  }
  async isApprovedForAll(token: string, wallet: string, operator: string): Promise<boolean> {
    return await this.read(token, "isApprovedForAll", [wallet, operator]) as boolean;
  }
  async safeOwners(wallet: string): Promise<{ threshold: bigint; owners: string[] }> {
    const threshold = await this.read(wallet, "getThreshold", []) as bigint;
    const owners = await this.read(wallet, "getOwners", []) as string[];
    return { threshold, owners };
  }
  async ctfIndexSet(route: PolymarketMarketRoute): Promise<"1" | "2"> {
    const positions = await this.ctfPositions(route);
    const index = positions.indexOf(route.assetId);
    if (index < 0) throw new Error("LIVE_REDEEM_CTF_ASSET_NOT_VERIFIED");
    return index === 0 ? "1" : "2";
  }
  async ctfPositions(route: PolymarketMarketRoute): Promise<[string, string]> {
    if (!["CTF", "CTF_NEG_RISK"].includes(route.protocol)) throw new Error("LIVE_REDEEM_CTF_ROUTE_REQUIRED");
    // Adapter calldata retains the CTF ABI but ignores collateral/indexSets.
    // Its immutable USDCE (standard) or WRAPPED_COLLATERAL (neg-risk) selects
    // both token IDs. Derive exactly those IDs, never try several currencies.
    const [backing, collateral, ledger, slots] = await Promise.all([
      this.read(route.redemptionTarget, route.protocol === "CTF_NEG_RISK" ? "WRAPPED_COLLATERAL" : "USDCE", []),
      this.read(route.redemptionTarget, "COLLATERAL_TOKEN", []),
      this.read(route.redemptionTarget, "CONDITIONAL_TOKENS", []),
      this.read(route.outcomeToken, "getOutcomeSlotCount", [route.conditionId]),
    ]);
    if (typeof backing !== "string" || !/^0x[0-9a-f]{40}$/i.test(backing) || /^0x0{40}$/i.test(backing)
      || typeof collateral !== "string" || collateral.toLowerCase() !== route.collateral.toLowerCase()
      || typeof ledger !== "string" || ledger.toLowerCase() !== route.outcomeToken.toLowerCase()
      || slots !== 2n) throw new Error("LIVE_REDEEM_CTF_ADAPTER_IDENTITY_MISMATCH");
    const positions = await Promise.all([1n, 2n].map(async index => {
      const collection = await this.read(route.outcomeToken, "getCollectionId", [zeroHash, route.conditionId, index]);
      const id = await this.read(route.outcomeToken, "getPositionId", [backing, collection]);
      if (typeof id !== "bigint" || id < 0n || id >= 2n ** 256n) throw new Error("LIVE_REDEEM_CTF_ASSET_NOT_VERIFIED");
      return id.toString();
    }));
    if (positions[0] === positions[1]) throw new Error("LIVE_REDEEM_CTF_ASSET_NOT_VERIFIED");
    return [positions[0]!, positions[1]!];
  }
}
