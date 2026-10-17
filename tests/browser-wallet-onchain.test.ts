import { AssetType } from "@polymarket/clob-client-v2";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { concatHex, decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionResult, keccak256, parseAbi, zeroAddress, type Hex } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserWalletAllowanceManager, BrowserWalletRedeemAdapter, PolygonTransactionReceiptProvider, type TransactionReceiptResult } from "../src/live/browser-wallet-onchain.js";
import { marketRoute, type PolymarketMarketRoute } from "../src/live/market-protocol.js";
import { RpcPolygonChainReader, type PolygonChainReader } from "../src/live/polygon-chain-reader.js";
import { RedemptionJournal } from "../src/live/redemption-journal.js";
import type { RedeemInput } from "../src/live/redeem-adapter.js";
import type { LiveWalletRuntimeBinding } from "../src/operator/live-wallet-session.js";

const wallet = "0x0000000000000000000000000000000000000001";
const safe = "0x0000000000000000000000000000000000000002";
const tx = `0x${"1".repeat(64)}`;
const approveAbi = parseAbi(["function approve(address spender,uint256 amount) returns(bool)"]);
const operatorAbi = parseAbi(["function setApprovalForAll(address operator,bool approved)"]);
const safeAbi = parseAbi(["function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) returns(bool)"]);
function binding(): LiveWalletRuntimeBinding {
  return { session: { sessionId: "session-1", status: "CONNECTED", walletAddress: wallet, chainId: 137,
    network: "POLYGON", walletType: "EIP1193", connectedAt: "2026-07-28T00:00:00.000Z",
    lastSeenAt: "2026-07-28T00:00:00.000Z", expiresAt: "2026-07-28T00:30:00.000Z" },
    assertCurrent: vi.fn(), onInvalidated: vi.fn(() => () => undefined) };
}
function chain(ready = false): PolygonChainReader {
  return { balanceOf: vi.fn(async () => 1n), ctfIndexSet: vi.fn(async () => "1" as const),
    ctfPositions: vi.fn(async () => ["123", "456"] as [string, string]),
    isApprovedForAll: vi.fn().mockResolvedValueOnce(ready).mockResolvedValue(true),
    safeOwners: vi.fn(async () => ({ threshold: 1n, owners: [wallet] })) };
}
const routes = [
  marketRoute({ assetId: "123", conditionId: `0x${"a".repeat(64)}`, neg_risk: false }),
  marketRoute({ assetId: "123", conditionId: `0x${"a".repeat(64)}`, neg_risk: true }),
  marketRoute({ assetId: (BigInt(`0x${"a".repeat(62)}`) << 8n).toString(), conditionId: `0x${"a".repeat(62)}`, version: "v2" }),
];

describe("browser wallet protocol approvals", () => {
  it("performs one receipt read without sleeping when maintenance is not yet confirmed", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: null })));
    const wait = vi.fn(async () => undefined);
    const provider = new PolygonTransactionReceiptProvider("https://example.invalid", { fetchImpl, wait });
    await expect(provider.confirmedReceipt(tx)).resolves.toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });

  it("distinguishes malformed receipt status from a proven revert", async () => {
    const provider = new PolygonTransactionReceiptProvider("https://example.invalid", {
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({ result: { status: "missing" } }))),
    });
    await expect(provider.confirmedReceipt(tx)).rejects.toThrow("LIVE_TRANSACTION_RECEIPT_INVALID");
  });
  it.each(routes)("approves $protocol collateral and its actual outcome ledger", async (route) => {
    let allowance = "0";
    const requestTransaction = vi.fn(async (_binding: unknown, _input: unknown) => tx);
    const getBalanceAllowance = vi.fn(async (_input: { asset_type: AssetType }) => ({ balance: "10000000", allowances: { [route.exchange]: allowance } }));
    const updateBalanceAllowance = vi.fn(async () => { allowance = "10000000"; });
    const reader = chain();
    const manager = new BrowserWalletAllowanceManager({ walletBinding: binding(), requestBroker: { requestTransaction },
      receiptProvider: { waitForSuccess: vi.fn(async () => ({ transactionHash: tx, blockNumber: 1n, confirmations: 2 })) },
      clobClient: { getBalanceAllowance, updateBalanceAllowance }, bankrollMicros: "10000000", signatureType: "EOA",
      tradingWalletAddress: wallet, chainReader: reader, routes: [route] });
    await expect(manager.prepare()).resolves.toEqual({ collateralApprovalTransaction: tx, outcomeApprovalTransaction: tx, ready: true });
    const collateral = requestTransaction.mock.calls[0]?.[1] as unknown as { to: string; data: `0x${string}` };
    const outcome = requestTransaction.mock.calls[1]?.[1] as unknown as { to: string; data: `0x${string}` };
    expect(collateral.to).toBe(route.collateral);
    expect(decodeFunctionData({ abi: approveAbi, data: collateral.data }).args).toEqual([route.exchange, 10000000n]);
    expect(outcome.to).toBe(route.outcomeToken);
    expect(decodeFunctionData({ abi: operatorAbi, data: outcome.data }).args).toEqual([route.exchange, true]);
    expect(reader.isApprovedForAll).toHaveBeenCalledWith(route.outcomeToken, wallet, route.exchange);
    expect(getBalanceAllowance.mock.calls.every(call => (call[0] as unknown as { asset_type: AssetType } | undefined)?.asset_type !== AssetType.CONDITIONAL)).toBe(true);
  });

  it("routes Safe approvals through its verified single owner executor", async () => {
    const route = routes[0]!;
    let allowance = "0";
    const requestTransaction = vi.fn(async (_binding: unknown, _input: unknown) => tx);
    const manager = new BrowserWalletAllowanceManager({ walletBinding: binding(), requestBroker: { requestTransaction },
      receiptProvider: { waitForSuccess: vi.fn(async () => ({ transactionHash: tx, blockNumber: 1n, confirmations: 2 })) },
      clobClient: { getBalanceAllowance: vi.fn(async () => ({ balance: "100", allowances: { [route.exchange]: allowance } })),
        updateBalanceAllowance: vi.fn(async () => { allowance = "100"; }) },
      bankrollMicros: "100", signatureType: "POLY_GNOSIS_SAFE", tradingWalletAddress: safe, chainReader: chain(), routes: [route] });
    await expect(manager.prepare()).resolves.toMatchObject({ ready: true });
    for (const call of requestTransaction.mock.calls) expect((call[1] as { to: string }).to).toBe(safe);
    const outer = requestTransaction.mock.calls[0]![1] as { data: `0x${string}` };
    const decoded = decodeFunctionData({ abi: safeAbi, data: outer.data });
    expect(decoded.args[0]).toBe(route.collateral);
    expect(decoded.args[1]).toBe(0n);
    expect(decoded.args[9]).toBe(`0x${wallet.slice(2).padStart(64, "0")}${"0".repeat(64)}01`);
  });

  it("refuses a Safe requiring additional owners before requesting any transaction", async () => {
    const reader = chain();
    reader.safeOwners = vi.fn(async () => ({ threshold: 2n, owners: [wallet, safe] }));
    const requestTransaction = vi.fn();
    const manager = new BrowserWalletAllowanceManager({ walletBinding: binding(), requestBroker: { requestTransaction },
      receiptProvider: { waitForSuccess: vi.fn() }, clobClient: {
        getBalanceAllowance: vi.fn(async () => ({ balance: "100", allowances: {} })), updateBalanceAllowance: vi.fn() },
      bankrollMicros: "100", signatureType: "POLY_GNOSIS_SAFE", tradingWalletAddress: safe, chainReader: reader, routes: [routes[0]!] });
    await expect(manager.prepare()).rejects.toThrow("LIVE_SAFE_SINGLE_OWNER_REQUIRED");
    expect(requestTransaction).not.toHaveBeenCalled();
  });

  it("does not claim ready when a successful Safe outer receipt did not approve", async () => {
    const requestTransaction = vi.fn(async () => tx);
    const manager = new BrowserWalletAllowanceManager({ walletBinding: binding(), requestBroker: { requestTransaction },
      receiptProvider: { waitForSuccess: vi.fn(async () => ({ transactionHash: tx, blockNumber: 1n, confirmations: 2 })) },
      clobClient: { getBalanceAllowance: vi.fn(async () => ({ balance: "100", allowances: {} })), updateBalanceAllowance: vi.fn() },
      bankrollMicros: "100", signatureType: "POLY_GNOSIS_SAFE", tradingWalletAddress: safe, chainReader: chain(), routes: [routes[0]!] });
    await expect(manager.prepare()).rejects.toThrow("LIVE_COLLATERAL_APPROVAL_NOT_EFFECTIVE");
  });

  it("defers unfunded setup without tokenless conditional calls", async () => {
    const requestTransaction = vi.fn();
    const getBalanceAllowance = vi.fn(async (_input: { asset_type: AssetType }) => ({ balance: "0", allowances: {} }));
    const reader = chain();
    const manager = new BrowserWalletAllowanceManager({ walletBinding: binding(), requestBroker: { requestTransaction },
      receiptProvider: { waitForSuccess: vi.fn() }, clobClient: { getBalanceAllowance, updateBalanceAllowance: vi.fn() },
      bankrollMicros: "100", signatureType: "POLY_GNOSIS_SAFE", tradingWalletAddress: safe, chainReader: reader });
    await expect(manager.prepare()).resolves.toMatchObject({ ready: false, reason: "LIVE_WALLET_SETUP_DEFERRED_NO_COLLATERAL" });
    expect(getBalanceAllowance).toHaveBeenCalledExactlyOnceWith({ asset_type: AssetType.COLLATERAL });
    expect(reader.isApprovedForAll).not.toHaveBeenCalled();
    expect(requestTransaction).not.toHaveBeenCalled();
  });
});

const cleanup: Array<() => void> = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });
const redeemEvents = parseAbi([
  "event Transfer(address indexed from,address indexed to,uint256 value)",
  "event TransferBatch(address indexed operator,address indexed from,address indexed to,uint256[] ids,uint256[] values)",
]);
function redemptionReceipt(route: PolymarketMarketRoute, amounts: Array<[string, bigint]>): TransactionReceiptResult {
  const move = (from: string, to: string) => ({ address: route.outcomeToken,
    topics: encodeEventTopics({ abi: redeemEvents, eventName: "TransferBatch", args: {
      operator: route.redemptionTarget, from: from as Hex, to: to as Hex,
    } }) as [Hex, ...Hex[]],
    data: encodeAbiParameters([{ type: "uint256[]" }, { type: "uint256[]" }], [amounts.map(([id]) => BigInt(id)), amounts.map(([, size]) => size)]),
  });
  return { transactionHash: tx, blockNumber: 100n, confirmations: 2, from: wallet, to: route.redemptionTarget,
    logs: [move(wallet, route.redemptionTarget), move(route.redemptionTarget, zeroAddress), {
      address: route.collateral,
      topics: encodeEventTopics({ abi: redeemEvents, eventName: "Transfer", args: { from: zeroAddress, to: wallet } }) as [Hex, ...Hex[]],
      data: encodeAbiParameters([{ type: "uint256" }], [5_000_000n]),
    }] };
}
function redeemFixture(both = true, route = routes[0]!) {
  const directory = mkdtempSync(join(tmpdir(), "pmf-ctf-condition-"));
  const path = join(directory, "redemption.sqlite");
  const db = new DatabaseSync(path);
  db.exec(readFileSync(new URL("../src/infra/sqlite/039_live_redemption_journal.sql", import.meta.url), "utf8"));
  db.close();
  const journal = new RedemptionJournal(path);
  cleanup.push(() => { journal.close(); rmSync(directory, { recursive: true, force: true }); });
  const balances = new Map([["123", 10_000_000n], ["456", both ? 7_000_000n : 0n]]);
  const reader = chain(true);
  reader.balanceOf = vi.fn(async (_token, _wallet, asset) => balances.get(asset) ?? 0n);
  reader.balancesOf = vi.fn(async (_token: string, _wallet: string, assets: readonly string[]) => assets.map(asset => balances.get(asset) ?? 0n));
  const requestTransaction = vi.fn(async (_binding: unknown, _input: unknown) => tx);
  const waitForSuccess = vi.fn(async () => redemptionReceipt(route, [...balances.entries()]));
  const adapter = new BrowserWalletRedeemAdapter({ walletBinding: binding(), requestBroker: { requestTransaction },
    receiptProvider: { waitForSuccess }, signatureType: "EOA", tradingWalletAddress: wallet,
    chainReader: reader, journal, routeProvider: { resolve: vi.fn(async () => route) } });
  const input: RedeemInput = { positionId: "yes-lot", conditionId: route.conditionId, assetId: route.assetId,
    idempotencyKey: "condition-claim", marketRoute: route,
    custody: { walletAddress: wallet, managedSizeMicros: both ? "17000000" : "10000000", expectedPayoutMicros: "5000000",
      lots: [{ positionId: "yes-lot", sizeMicros: "10000000", assetId: "123" },
        ...(both ? [{ positionId: "no-lot", sizeMicros: "7000000", assetId: "456" }] : [])] } };
  return { adapter, input, journal, reader, balances, requestTransaction, waitForSuccess, route };
}

describe("CTF condition redemption custody", () => {
  it.each([false, true])("proves and burns both managed outcomes, negRisk=%s", async (negRisk) => {
    const env = redeemFixture(true, routes[negRisk ? 1 : 0]!);
    const result = await env.adapter.redeem(env.input);
    expect(result).toMatchObject({ status: "CONFIRMED", evidence: { burnedSizeMicros: "17000000",
      actualPayoutMicros: "5000000", burnedAssets: [{ assetId: "123", sizeMicros: "10000000" }, { assetId: "456", sizeMicros: "7000000" }] } });
    expect(env.requestTransaction).toHaveBeenCalledTimes(1);
    const sent = env.requestTransaction.mock.calls[0]![1] as { to: string; data: Hex };
    expect(sent.to).toBe(env.route.redemptionTarget);
    const abi = parseAbi(["function redeemPositions(address collateralToken,bytes32 parent,bytes32 condition,uint256[] indexSets)"]);
    expect(decodeFunctionData({ abi, data: sent.data }).args[3]).toEqual([1n, 2n]);
    expect(env.reader.balancesOf).toHaveBeenCalledTimes(2);
    expect(env.reader.balancesOf).toHaveBeenCalledWith(env.route.outcomeToken, wallet, ["123", "456"]);
  });

  it("rejects a manual opposite balance before any transaction", async () => {
    const env = redeemFixture(false);
    env.balances.set("456", 7_000_000n);
    await expect(env.adapter.redeem(env.input)).rejects.toThrow("LIVE_REDEEM_CUSTODY_BALANCE_MISMATCH");
    expect(env.requestTransaction).not.toHaveBeenCalled();
    expect(env.journal.get(env.input.idempotencyKey)).toBeNull();
  });

  it("rechecks the complete condition immediately before requesting the transaction", async () => {
    const env = redeemFixture(false);
    vi.mocked(env.reader.balancesOf!).mockResolvedValueOnce([10_000_000n, 0n]).mockResolvedValueOnce([10_000_000n, 1n]);
    await expect(env.adapter.redeem(env.input)).rejects.toThrow("LIVE_REDEEM_CUSTODY_BALANCE_MISMATCH");
    expect(env.requestTransaction).not.toHaveBeenCalled();
    expect(env.journal.get(env.input.idempotencyKey)?.state).toBe("PREPARED");
  });

  it("refuses unverified lot asset IDs even when the total balance matches", async () => {
    const env = redeemFixture(true);
    env.input.custody!.lots[1]!.assetId = "789";
    await expect(env.adapter.redeem(env.input)).rejects.toThrow("LIVE_REDEEM_CTF_ASSET_NOT_VERIFIED");
    expect(env.requestTransaction).not.toHaveBeenCalled();
  });

  it("does not confirm when the receipt burned an undeclared opposite asset", async () => {
    const env = redeemFixture(false);
    env.waitForSuccess.mockResolvedValue(redemptionReceipt(env.route, [["123", 10_000_000n], ["456", 7_000_000n]]));
    await expect(env.adapter.redeem(env.input)).resolves.toMatchObject({ status: "SUBMITTED",
      raw: { reason: "LIVE_REDEEM_UNAUTHORIZED_ASSET_DEBIT" } });
    expect(env.journal.get(env.input.idempotencyKey)?.state).toBe("SUBMITTED");
  });

  it("requires each asset's exact burn, even if total burned shares are unchanged", async () => {
    const env = redeemFixture(true);
    env.waitForSuccess.mockResolvedValue(redemptionReceipt(env.route, [["123", 9_000_000n], ["456", 8_000_000n]]));
    await expect(env.adapter.redeem(env.input)).resolves.toMatchObject({ status: "SUBMITTED",
      raw: { reason: "LIVE_REDEEM_BURN_EVIDENCE_MISMATCH" } });
  });

  it("allows the adapter's zero transfer of an unowned opposite outcome", async () => {
    const env = redeemFixture(false);
    await expect(env.adapter.redeem(env.input)).resolves.toMatchObject({ status: "CONFIRMED",
      evidence: { burnedSizeMicros: "10000000", burnedAssets: [{ assetId: "123", sizeMicros: "10000000" }] } });
  });

  it("keeps Protocol V2 exact-amount custody restricted to one asset", async () => {
    const env = redeemFixture(true, routes[2]!);
    env.input.custody!.lots[0]!.assetId = routes[2]!.assetId;
    await expect(env.adapter.redeem(env.input)).rejects.toThrow("LIVE_REDEEM_V2_MULTIPLE_ASSETS_UNSUPPORTED");
    expect(env.requestTransaction).not.toHaveBeenCalled();
  });
});

const ctfReadAbi = parseAbi([
  "function balanceOfBatch(address[] accounts,uint256[] ids) view returns(uint256[])",
  "function USDCE() view returns(address)", "function WRAPPED_COLLATERAL() view returns(address)",
  "function COLLATERAL_TOKEN() view returns(address)", "function CONDITIONAL_TOKENS() view returns(address)",
  "function getOutcomeSlotCount(bytes32 condition) view returns(uint256)",
  "function getCollectionId(bytes32 parent,bytes32 condition,uint256 indexSet) view returns(bytes32)",
  "function getPositionId(address collateral,bytes32 collection) view returns(uint256)",
]);

describe("deployed CTF adapter position identity", () => {
  it.each([false, true])("derives IDs only from the actual adapter backing, negRisk=%s", async (negRisk) => {
    const route = routes[negRisk ? 1 : 0]!;
    const backing = negRisk ? "0x3A3BD7bb9528E159577F7C2e685CC81A765002E2" : "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
    const calls: Array<{ name: string; target: string; args: readonly unknown[] }> = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method: string; params: [{ to: string; data: Hex }, string] };
      expect(body.method).toBe("eth_call");
      const request = body.params[0];
      const decoded = decodeFunctionData({ abi: ctfReadAbi, data: request.data });
      calls.push({ name: decoded.functionName, target: request.to, args: decoded.args ?? [] });
      let result: unknown;
      switch (decoded.functionName) {
        case "USDCE": case "WRAPPED_COLLATERAL": result = backing; break;
        case "COLLATERAL_TOKEN": result = route.collateral; break;
        case "CONDITIONAL_TOKENS": result = route.outcomeToken; break;
        case "getOutcomeSlotCount": result = 2n; break;
        case "getCollectionId": result = `0x${decoded.args[2].toString(16).padStart(64, "0")}`; break;
        case "getPositionId": result = BigInt(keccak256(concatHex([decoded.args[0], decoded.args[1]]))); break;
        case "balanceOfBatch": result = [10n, 7n]; break;
      }
      const encoded = encodeFunctionResult({ abi: ctfReadAbi, functionName: decoded.functionName, result } as Parameters<typeof encodeFunctionResult>[0]);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: encoded }));
    });
    const reader = new RpcPolygonChainReader("https://example.invalid", fetchImpl);
    const expected = [1n, 2n].map(index => BigInt(keccak256(concatHex([backing, `0x${index.toString(16).padStart(64, "0")}`]))).toString());
    await expect(reader.ctfPositions(route)).resolves.toEqual(expected);
    const identities = calls.filter(call => call.name === "getPositionId");
    expect(identities).toHaveLength(2);
    expect(identities.every(call => String(call.args[0]).toLowerCase() === backing.toLowerCase())).toBe(true);
    expect(calls.some(call => call.name === (negRisk ? "WRAPPED_COLLATERAL" : "USDCE") && call.target === route.redemptionTarget)).toBe(true);
    expect(calls.some(call => call.name === (negRisk ? "USDCE" : "WRAPPED_COLLATERAL"))).toBe(false);
    await expect(reader.ctfIndexSet({ ...route, assetId: expected[1]! })).resolves.toBe("2");
    await expect(reader.ctfIndexSet(route)).rejects.toThrow("LIVE_REDEEM_CTF_ASSET_NOT_VERIFIED");
    await expect(reader.balancesOf(route.outcomeToken, wallet, expected)).resolves.toEqual([10n, 7n]);
    const batch = calls.find(call => call.name === "balanceOfBatch")!;
    expect(batch.args).toEqual([[wallet, wallet], expected.map(BigInt)]);
  });
});
