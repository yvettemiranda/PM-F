import { decodeEventLog, parseAbi, zeroAddress } from "viem";
import type { TransactionReceiptResult } from "./browser-wallet-onchain.js";
import type { PolymarketMarketRoute } from "./market-protocol.js";
import type { ConfirmedRedemptionEvidence, RedeemCustody } from "./redeem-adapter.js";

const EVENTS = parseAbi([
  "event Transfer(address indexed from,address indexed to,uint256 value)",
  "event TransferSingle(address indexed operator,address indexed from,address indexed to,uint256 id,uint256 value)",
  "event TransferBatch(address indexed operator,address indexed from,address indexed to,uint256[] ids,uint256[] values)",
]);

export function verifyRedemptionReceipt(input: {
  receipt: TransactionReceiptResult;
  transactionHash: string;
  transactionTo: string;
  transactionFrom: string;
  route: PolymarketMarketRoute;
  custody: RedeemCustody;
}): ConfirmedRedemptionEvidence {
  const { receipt, route, custody } = input;
  const wallet = custody.walletAddress.toLowerCase();
  if (receipt.transactionHash.toLowerCase() !== input.transactionHash.toLowerCase()
    || receipt.to?.toLowerCase() !== input.transactionTo.toLowerCase()
    || receipt.from?.toLowerCase() !== input.transactionFrom.toLowerCase()
    || receipt.confirmations < 2 || receipt.logs === undefined) throw new Error("LIVE_REDEEM_RECEIPT_IDENTITY_INVALID");
  let payout = 0n;
  const rights = new Map<string, bigint>();
  const debited = new Map<string, bigint>();
  const burned = new Map<string, bigint>();
  for (const lot of custody.lots) {
    const asset = lot.assetId ?? route.assetId;
    if (!/^(?:0|[1-9][0-9]*)$/.test(asset) || !/^[1-9][0-9]*$/.test(lot.sizeMicros)) throw new Error("LIVE_REDEEM_CUSTODY_INVALID");
    rights.set(asset, (rights.get(asset) ?? 0n) + BigInt(lot.sizeMicros));
  }
  if (route.protocol === "POLY_V2" && (rights.size !== 1 || !rights.has(route.assetId))) {
    throw new Error("LIVE_REDEEM_V2_MULTIPLE_ASSETS_UNSUPPORTED");
  }
  if ([...rights.values()].reduce((sum, size) => sum + size, 0n) !== BigInt(custody.managedSizeMicros)) {
    throw new Error("LIVE_REDEEM_CUSTODY_INVALID");
  }
  for (const log of receipt.logs) {
    if (log.removed) throw new Error("LIVE_REDEEM_RECEIPT_REORG");
    const address = log.address.toLowerCase();
    if (![route.collateral.toLowerCase(), route.outcomeToken.toLowerCase()].includes(address)) continue;
    let event;
    try { event = decodeEventLog({ abi: EVENTS, data: log.data, topics: log.topics }); } catch { continue; }
    if (address === route.collateral.toLowerCase() && event.eventName === "Transfer") {
      if (event.args.to.toLowerCase() === wallet) payout += event.args.value;
      if (event.args.from.toLowerCase() === wallet) payout -= event.args.value;
    }
    if (address !== route.outcomeToken.toLowerCase() || event.eventName === "Transfer") continue;
    const args = event.args;
    const entries = event.eventName === "TransferSingle"
      ? [[event.args.id, event.args.value] as const]
      : event.args.ids.map((id, index) => [id, event.args.values[index]!] as const);
    for (const [id, amount] of entries) {
      const asset = id.toString();
      const fromWallet = args.from.toLowerCase() === wallet;
      const toWallet = args.to.toLowerCase() === wallet;
      const burn = args.to.toLowerCase() === zeroAddress;
      if (!rights.has(asset)) {
        // CTF adapters transfer both IDs, including an allowed zero amount
        // for an unowned outcome. A nonzero outside debit/burn is never ours.
        if (amount > 0n && (fromWallet || burn)) throw new Error("LIVE_REDEEM_UNAUTHORIZED_ASSET_DEBIT");
        continue;
      }
      if (fromWallet) debited.set(asset, (debited.get(asset) ?? 0n) + amount);
      if (toWallet) debited.set(asset, (debited.get(asset) ?? 0n) - amount);
      if (burn) burned.set(asset, (burned.get(asset) ?? 0n) + amount);
    }
  }
  const managed = BigInt(custody.managedSizeMicros);
  for (const [asset, expected] of rights) {
    if ((debited.get(asset) ?? 0n) !== expected || (burned.get(asset) ?? 0n) !== expected) {
      throw new Error("LIVE_REDEEM_BURN_EVIDENCE_MISMATCH");
    }
  }
  if (payout < 0n || (BigInt(custody.expectedPayoutMicros) > 0n && payout === 0n)) {
    throw new Error("LIVE_REDEEM_PAYOUT_NOT_RECEIVED");
  }
  return {
    transactionHash: receipt.transactionHash.toLowerCase(), walletAddress: wallet,
    assetId: route.assetId, burnedSizeMicros: managed.toString(), actualPayoutMicros: payout.toString(),
    burnedAssets: [...rights.entries()].sort(([left], [right]) => left.localeCompare(right))
      .map(([assetId, size]) => ({ assetId, sizeMicros: size.toString() })),
    blockNumber: receipt.blockNumber.toString(), confirmations: receipt.confirmations,
  };
}
