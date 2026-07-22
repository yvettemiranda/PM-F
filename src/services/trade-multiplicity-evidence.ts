import { createHash } from "node:crypto";
import { decodeAbiParameters } from "viem";
import type { PolygonTransactionReceiptResponse } from "../adapters/polygon-receipt.js";
import type { ApiCapture } from "../adapters/polymarket-public.js";
import {
  resolveSourceEventMultiplicity,
  sourceEventKey,
} from "../domain/idempotency.js";
import { activityAsTrade } from "../domain/activity-trade.js";
import { decimalToScaled, PRICE_SCALE_DIGITS, SHARE_SCALE_DIGITS } from "../domain/fixed.js";
import type { PublicActivity, PublicTrade } from "../domain/models.js";
import { stableJson } from "../domain/versioning.js";

export const TRADE_MULTIPLICITY_EVIDENCE_VERSION = "v1.0.0";

const ORDER_FILLED_TOPIC = "0xd543adfd945773f1a62f74f0ee55a5e3b9b1a28262980ba90b1a89f2ea84d8ee";
const POLYGON_V2_EXCHANGES = new Set([
  "0xe111180000d2663c0091e4f400237545b87b996b",
  "0xe2222d279d744050d28e00520010520000310f59",
]);
const HASH_RE = /^0x[0-9a-f]{64}$/;
const ADDRESS_TOPIC_RE = /^0x0{24}[0-9a-f]{40}$/;
const PRICE_SCALE = 10n ** BigInt(PRICE_SCALE_DIGITS);

export interface TradeMultiplicityProof {
  evidenceVersion: typeof TRADE_MULTIPLICITY_EVIDENCE_VERSION;
  sourceEventKey: string;
  transactionHash: string;
  walletAddress: string;
  asset: string;
  side: "BUY" | "SELL";
  priceUnits: string;
  sizeMicros: string;
  notionalMicros: string;
  occurrenceCount: number;
  exchangeAddress: string;
  orderHashes: string[];
  receiptBlockNumber: string;
  receiptPayloadSha256: string;
  evidenceHash: string;
}

export interface TradeMultiplicityEvidence {
  confirmedOccurrenceCounts: Record<string, number>;
  proofs: TradeMultiplicityProof[];
}

export interface TradeMultiplicityProofDocument extends TradeMultiplicityEvidence {
  evidenceVersion: typeof TRADE_MULTIPLICITY_EVIDENCE_VERSION;
  walletAddress: string;
}

export interface TradeMultiplicityReceiptProvider {
  transactionReceipt(transactionHash: string): Promise<ApiCapture<PolygonTransactionReceiptResponse>>;
}

export interface CollectedTradeMultiplicityEvidence extends TradeMultiplicityEvidence {
  receiptCaptures: Array<ApiCapture<PolygonTransactionReceiptResponse>>;
  proofCapture: ApiCapture<TradeMultiplicityProofDocument> | null;
}

export interface TradeMultiplicityEvidenceInput {
  walletAddress: string;
  trades: PublicTrade[];
  activity: PublicActivity[];
  receipts: Array<ApiCapture<PolygonTransactionReceiptResponse>>;
  tradePaginationBoundaryOverlaps?: PublicTrade[];
  activityPaginationBoundaryOverlaps?: PublicTrade[];
}

export function tradeMultiplicityProofDocument(
  walletAddress: string,
  evidence: TradeMultiplicityEvidence,
): TradeMultiplicityProofDocument {
  return {
    evidenceVersion: TRADE_MULTIPLICITY_EVIDENCE_VERSION,
    walletAddress: walletAddress.toLowerCase(),
    confirmedOccurrenceCounts: evidence.confirmedOccurrenceCounts,
    proofs: evidence.proofs,
  };
}

export function assertStoredTradeMultiplicityProofDocument(
  walletAddress: string,
  evidence: TradeMultiplicityEvidence,
  storedPayloads: readonly unknown[],
): void {
  if (evidence.proofs.length === 0) {
    if (storedPayloads.length !== 0) throw new Error("TRADE_MULTIPLICITY_PROOF_UNEXPECTED");
    return;
  }
  if (storedPayloads.length !== 1) throw new Error("TRADE_MULTIPLICITY_PROOF_COUNT_INVALID");
  const expected = tradeMultiplicityProofDocument(walletAddress, evidence);
  if (stableJson(storedPayloads[0]) !== stableJson(expected)) {
    throw new Error("TRADE_MULTIPLICITY_PROOF_MISMATCH");
  }
}

interface AmbiguousTradeGroup {
  sample: PublicTrade;
  sourceEventKey: string;
  occurrenceCount: number;
  allRowsBelongToWallet: boolean;
}

function receiptPayloadSha256(capture: ApiCapture<PolygonTransactionReceiptResponse>): string {
  return createHash("sha256").update(JSON.stringify(capture.data)).digest("hex");
}

function topicAddress(topic: string): string | null {
  const normalized = topic.toLowerCase();
  return ADDRESS_TOPIC_RE.test(normalized) ? `0x${normalized.slice(-40)}` : null;
}

function allInputRowsBelongToWallet(
  input: Pick<TradeMultiplicityEvidenceInput, "walletAddress" | "trades" | "activity">,
): boolean {
  const walletAddress = input.walletAddress.toLowerCase();
  return [...input.trades, ...input.activity]
    .every((row) => row.proxyWallet.toLowerCase() === walletAddress);
}

function ambiguousTradeGroups(input: TradeMultiplicityEvidenceInput): AmbiguousTradeGroup[] {
  const walletAddress = input.walletAddress.toLowerCase();
  const activityTrades = input.activity.flatMap((item) => {
    const trade = activityAsTrade(item);
    return trade ? [trade] : [];
  });
  const resolution = resolveSourceEventMultiplicity(input.trades, activityTrades, {
    ...(input.tradePaginationBoundaryOverlaps === undefined
      ? {}
      : { tradePaginationBoundaryOverlaps: input.tradePaginationBoundaryOverlaps }),
    ...(input.activityPaginationBoundaryOverlaps === undefined
      ? {}
      : { activityPaginationBoundaryOverlaps: input.activityPaginationBoundaryOverlaps }),
  });
  const ambiguousKeys = new Set(resolution.ambiguousRepeatedKeys);
  const groups = new Map<string, AmbiguousTradeGroup>();
  for (const occurrence of [...resolution.trades, ...resolution.activityTrades]) {
    const baseKey = sourceEventKey(occurrence.trade);
    const existing = groups.get(baseKey);
    const belongsToWallet = occurrence.trade.proxyWallet.toLowerCase() === walletAddress;
    if (!existing) {
      groups.set(baseKey, {
        sample: occurrence.trade,
        sourceEventKey: baseKey,
        occurrenceCount: occurrence.occurrenceIndex + 1,
        allRowsBelongToWallet: belongsToWallet,
      });
      continue;
    }
    existing.occurrenceCount = Math.max(existing.occurrenceCount, occurrence.occurrenceIndex + 1);
    existing.allRowsBelongToWallet &&= belongsToWallet;
  }
  return [...groups.values()]
    .filter((group) => group.occurrenceCount > 1 && [...Array(group.occurrenceCount).keys()]
      .slice(1)
      .some((index) => ambiguousKeys.has(sourceEventKey(group.sample, index))))
    .sort((a, b) => a.sourceEventKey.localeCompare(b.sourceEventKey));
}

export function ambiguousTradeTransactionHashes(input: Omit<TradeMultiplicityEvidenceInput, "receipts">): string[] {
  if (!allInputRowsBelongToWallet(input)) return [];
  return [...new Set(ambiguousTradeGroups({ ...input, receipts: [] })
    .filter((group) => group.allRowsBelongToWallet)
    .map((group) => group.sample.transactionHash.toLowerCase()))].sort();
}

export async function collectTradeMultiplicityEvidence(
  input: Omit<TradeMultiplicityEvidenceInput, "receipts"> & {
    receiptProvider: TradeMultiplicityReceiptProvider;
  },
): Promise<CollectedTradeMultiplicityEvidence> {
  const { receiptProvider, ...evidenceInput } = input;
  const transactionHashes = ambiguousTradeTransactionHashes(evidenceInput);
  const receiptCaptures = await Promise.all(
    transactionHashes.map((transactionHash) => receiptProvider.transactionReceipt(transactionHash)),
  );
  const evidence = verifyTradeMultiplicityEvidence({ ...evidenceInput, receipts: receiptCaptures });
  const proofDocument = tradeMultiplicityProofDocument(input.walletAddress, evidence);
  const latestFetchedAt = receiptCaptures
    .map((capture) => capture.fetchedAt)
    .sort()
    .at(-1);
  const proofCapture = evidence.proofs.length === 0 || latestFetchedAt === undefined
    ? null
    : {
      url: `ni-k://phase0/trade-multiplicity-evidence/${input.walletAddress.toLowerCase()}`,
      fetchedAt: latestFetchedAt,
      latencyMs: 0,
      status: 200,
      data: proofDocument,
    };
  return { ...evidence, receiptCaptures, proofCapture };
}

export function verifyTradeMultiplicityEvidence(input: TradeMultiplicityEvidenceInput): TradeMultiplicityEvidence {
  const walletAddress = input.walletAddress.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(walletAddress)) throw new Error("TRADE_MULTIPLICITY_WALLET_INVALID");
  if (!allInputRowsBelongToWallet(input)) return { confirmedOccurrenceCounts: {}, proofs: [] };

  const receiptsByTransaction = new Map<string, ApiCapture<PolygonTransactionReceiptResponse>>();
  for (const capture of input.receipts) {
    const transactionHash = capture.data.result?.transactionHash.toLowerCase();
    if (!transactionHash) continue;
    const existing = receiptsByTransaction.get(transactionHash);
    if (existing && stableJson(existing.data) !== stableJson(capture.data)) {
      throw new Error(`TRADE_MULTIPLICITY_RECEIPT_CONFLICT:${transactionHash}`);
    }
    receiptsByTransaction.set(transactionHash, capture);
  }

  const proofs: TradeMultiplicityProof[] = [];
  const confirmedOccurrenceCounts: Record<string, number> = {};
  for (const group of ambiguousTradeGroups(input)) {
    if (!group.allRowsBelongToWallet) continue;
    const trade = group.sample;
    const transactionHash = trade.transactionHash.toLowerCase();
    const capture = receiptsByTransaction.get(transactionHash);
    const receipt = capture?.data.result;
    if (
      !capture
      || !receipt
      || receipt.transactionHash.toLowerCase() !== transactionHash
      || receipt.status.toLowerCase() !== "0x1"
      || !receipt.blockNumber
    ) continue;

    const priceUnits = decimalToScaled(trade.price, PRICE_SCALE_DIGITS);
    const sizeMicros = decimalToScaled(trade.size, SHARE_SCALE_DIGITS);
    const notionalNumerator = priceUnits * sizeMicros;
    if (notionalNumerator % PRICE_SCALE !== 0n) continue;
    const notionalMicros = notionalNumerator / PRICE_SCALE;
    const expectedSide = trade.side === "BUY" ? 0 : 1;
    const matching = receipt.logs.flatMap((log) => {
      const address = log.address.toLowerCase();
      const topics = log.topics.map((topic) => topic.toLowerCase());
      if (
        !POLYGON_V2_EXCHANGES.has(address)
        || topics[0] !== ORDER_FILLED_TOPIC
      ) return [];
      if (topics.length !== 4 || !topics[1] || !HASH_RE.test(topics[1])) {
        throw new Error(`TRADE_MULTIPLICITY_ORDER_FILLED_TOPICS_INVALID:${transactionHash}`);
      }
      const maker = topics[2] ? topicAddress(topics[2]) : null;
      if (!maker || !topics[3] || !topicAddress(topics[3])) {
        throw new Error(`TRADE_MULTIPLICITY_ORDER_FILLED_ADDRESSES_INVALID:${transactionHash}`);
      }
      let decoded: readonly [number, bigint, bigint, bigint, bigint, `0x${string}`, `0x${string}`];
      try {
        decoded = decodeAbiParameters(
          [
            { type: "uint8" },
            { type: "uint256" },
            { type: "uint256" },
            { type: "uint256" },
            { type: "uint256" },
            { type: "bytes32" },
            { type: "bytes32" },
          ],
          log.data as `0x${string}`,
        );
      } catch {
        throw new Error(`TRADE_MULTIPLICITY_ORDER_FILLED_DATA_INVALID:${transactionHash}`);
      }
      const [side, tokenId, makerAmountFilled, takerAmountFilled] = decoded;
      const collateralAmount = side === 0 ? makerAmountFilled : takerAmountFilled;
      return maker === walletAddress
        && side === expectedSide
        && tokenId === BigInt(trade.asset)
        && collateralAmount === notionalMicros
        ? [{ exchangeAddress: address, orderHash: topics[1] }]
        : [];
    });
    const orderHashes = [...new Set(matching.map((item) => item.orderHash))].sort();
    const exchangeAddresses = [...new Set(matching.map((item) => item.exchangeAddress))];
    if (
      matching.length !== group.occurrenceCount
      || orderHashes.length !== group.occurrenceCount
      || exchangeAddresses.length !== 1
    ) continue;

    const proofWithoutHash: Omit<TradeMultiplicityProof, "evidenceHash"> = {
      evidenceVersion: TRADE_MULTIPLICITY_EVIDENCE_VERSION,
      sourceEventKey: group.sourceEventKey,
      transactionHash,
      walletAddress,
      asset: trade.asset,
      side: trade.side,
      priceUnits: priceUnits.toString(),
      sizeMicros: sizeMicros.toString(),
      notionalMicros: notionalMicros.toString(),
      occurrenceCount: group.occurrenceCount,
      exchangeAddress: exchangeAddresses[0]!,
      orderHashes,
      receiptBlockNumber: receipt.blockNumber.toLowerCase(),
      receiptPayloadSha256: receiptPayloadSha256(capture),
    };
    proofs.push({
      ...proofWithoutHash,
      evidenceHash: createHash("sha256").update(stableJson(proofWithoutHash)).digest("hex"),
    });
    confirmedOccurrenceCounts[group.sourceEventKey] = group.occurrenceCount;
  }

  return { confirmedOccurrenceCounts, proofs };
}
