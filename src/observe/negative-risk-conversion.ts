import { createHash } from "node:crypto";
import { decodeAbiParameters, type Hex } from "viem";
import type { ApiCapture } from "../adapters/polymarket-public.js";
import type {
  PolygonTransactionReceiptResponse,
} from "../adapters/polygon-receipt.js";
export type {
  PolygonReceiptLog,
  PolygonTransactionReceipt,
  PolygonTransactionReceiptResponse,
} from "../adapters/polygon-receipt.js";
import { decimalToScaled, SHARE_SCALE_DIGITS } from "../domain/fixed.js";
import type { PublicActivity, PublicPosition } from "../domain/models.js";
import { stableJson } from "../domain/versioning.js";

export const POLYMARKET_CTF_ADDRESS = "0x4d97dcd97ec945f40cf65f87097ace5ea0476045";
export const NEGATIVE_RISK_ADAPTER_ADDRESS = "0xd91e80cf2e7be2e162c6513ced06f1dd0da35296";
export const ERC1155_TRANSFER_BATCH_TOPIC = "0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb";
export const NEGATIVE_RISK_CONVERSION_TOPIC = "0xb03d19dddbc72a87e735ff0ea3b57bef133ebe44e1894284916a84044deb367e";

const HASH_RE = /^0x[0-9a-f]{64}$/;
const ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const HEX_RE = /^0x(?:[0-9a-f]{2})*$/;

export interface NegativeRiskConversionDestination {
  asset: string;
  conditionId: string;
  amountMicros: string;
}

export interface VerifiedNegativeRiskConversion {
  transactionHash: string;
  groupConditionId: string;
  eventSlug: string;
  sourceAsset: string;
  destinationAssets: NegativeRiskConversionDestination[];
  amountMicros: string;
  receiptBlockNumber: string | null;
  receiptPayloadHash: string;
  evidenceHash: string;
}

export interface NegativeRiskConversionReceiptProvider {
  transactionReceipt(
    transactionHash: string,
    signal?: AbortSignal,
  ): Promise<ApiCapture<PolygonTransactionReceiptResponse>>;
}

function normalizedAddress(value: string, reason: string): string {
  const normalized = value.toLowerCase();
  if (!ADDRESS_RE.test(normalized)) throw new Error(reason);
  return normalized;
}

function normalizedHash(value: string, reason: string): string {
  const normalized = value.toLowerCase();
  if (!HASH_RE.test(normalized)) throw new Error(reason);
  return normalized;
}

function topicAddress(
  topic: string,
  reason = "NEGATIVE_RISK_CONVERSION_TRANSFER_TOPIC_INVALID",
): string {
  const normalized = normalizedHash(topic, reason);
  return `0x${normalized.slice(-40)}`;
}

function addDelta(deltas: Map<string, bigint>, asset: bigint, delta: bigint): void {
  const key = asset.toString();
  deltas.set(key, (deltas.get(key) ?? 0n) + delta);
}

function receiptPayloadHash(receipt: ApiCapture<PolygonTransactionReceiptResponse>): string {
  return createHash("sha256").update(JSON.stringify(receipt.data)).digest("hex");
}

export function negativeRiskConversionEvidenceHash(
  value: Omit<VerifiedNegativeRiskConversion, "evidenceHash">,
): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

/**
 * Verifies a Data API CONVERSION against the Polygon receipt and the current
 * public Positions metadata. TransferBatch legs are netted from the target
 * wallet's perspective because the adapter may temporarily transfer both
 * outcome sets through the wallet inside one transaction.
 */
export function verifyNegativeRiskConversion(input: {
  activity: PublicActivity;
  walletAddress: string;
  positions: readonly PublicPosition[];
  receipt: ApiCapture<PolygonTransactionReceiptResponse>;
}): VerifiedNegativeRiskConversion {
  const walletAddress = normalizedAddress(
    input.walletAddress,
    "NEGATIVE_RISK_CONVERSION_WALLET_INVALID",
  );
  if (input.activity.type !== "CONVERSION") {
    throw new Error("NEGATIVE_RISK_CONVERSION_ACTIVITY_TYPE_INVALID");
  }
  if (normalizedAddress(
    input.activity.proxyWallet,
    "NEGATIVE_RISK_CONVERSION_ACTIVITY_WALLET_INVALID",
  ) !== walletAddress) {
    throw new Error("NEGATIVE_RISK_CONVERSION_ACTIVITY_WALLET_MISMATCH");
  }
  const transactionHash = normalizedHash(
    input.activity.transactionHash,
    "NEGATIVE_RISK_CONVERSION_TRANSACTION_HASH_INVALID",
  );
  const groupConditionId = normalizedHash(
    input.activity.conditionId ?? "",
    "NEGATIVE_RISK_CONVERSION_GROUP_CONDITION_MISSING",
  );
  const activityEventSlug = input.activity.eventSlug?.trim() || null;
  if (input.activity.size === undefined) {
    throw new Error("NEGATIVE_RISK_CONVERSION_AMOUNT_MISSING");
  }
  const amountMicros = decimalToScaled(input.activity.size, SHARE_SCALE_DIGITS);
  if (amountMicros <= 0n) throw new Error("NEGATIVE_RISK_CONVERSION_AMOUNT_INVALID");

  const receipt = input.receipt.data.result;
  if (!receipt) throw new Error("NEGATIVE_RISK_CONVERSION_RECEIPT_NOT_FOUND");
  if (normalizedHash(
    receipt.transactionHash,
    "NEGATIVE_RISK_CONVERSION_RECEIPT_HASH_INVALID",
  ) !== transactionHash) {
    throw new Error("NEGATIVE_RISK_CONVERSION_RECEIPT_HASH_MISMATCH");
  }
  if (receipt.status.toLowerCase() !== "0x1") {
    throw new Error("NEGATIVE_RISK_CONVERSION_RECEIPT_NOT_SUCCESSFUL");
  }

  const deltas = new Map<string, bigint>();
  let adapterProofCount = 0;
  for (const log of receipt.logs) {
    const address = log.address.toLowerCase();
    const topics = log.topics.map((topic) => topic.toLowerCase());
    if (
      address === POLYMARKET_CTF_ADDRESS
      && topics[0] === ERC1155_TRANSFER_BATCH_TOPIC
    ) {
      if (topics.length !== 4 || !HEX_RE.test(log.data.toLowerCase())) {
        throw new Error("NEGATIVE_RISK_CONVERSION_TRANSFER_LOG_INVALID");
      }
      let ids: readonly bigint[];
      let values: readonly bigint[];
      try {
        [ids, values] = decodeAbiParameters(
          [{ type: "uint256[]" }, { type: "uint256[]" }],
          log.data as Hex,
        );
      } catch {
        throw new Error("NEGATIVE_RISK_CONVERSION_TRANSFER_DATA_INVALID");
      }
      if (ids.length === 0 || ids.length !== values.length) {
        throw new Error("NEGATIVE_RISK_CONVERSION_TRANSFER_LENGTH_MISMATCH");
      }
      const from = topicAddress(topics[2]!);
      const to = topicAddress(topics[3]!);
      for (let index = 0; index < ids.length; index += 1) {
        const value = values[index]!;
        if (value <= 0n) throw new Error("NEGATIVE_RISK_CONVERSION_TRANSFER_AMOUNT_INVALID");
        if (from === walletAddress) addDelta(deltas, ids[index]!, -value);
        if (to === walletAddress) addDelta(deltas, ids[index]!, value);
      }
      continue;
    }
    if (
      address === NEGATIVE_RISK_ADAPTER_ADDRESS
      && topics[0] === NEGATIVE_RISK_CONVERSION_TOPIC
      && topics[2] === groupConditionId
    ) {
      if (topics.length !== 4 || !HEX_RE.test(log.data.toLowerCase())) {
        throw new Error("NEGATIVE_RISK_CONVERSION_ADAPTER_LOG_INVALID");
      }
      const stakeholder = topicAddress(
        topics[1]!,
        "NEGATIVE_RISK_CONVERSION_ADAPTER_STAKEHOLDER_INVALID",
      );
      if (stakeholder !== walletAddress) continue;
      try {
        const [loggedAmount] = decodeAbiParameters([{ type: "uint256" }], log.data as Hex);
        if (loggedAmount === amountMicros) adapterProofCount += 1;
      } catch {
        throw new Error("NEGATIVE_RISK_CONVERSION_ADAPTER_LOG_INVALID");
      }
    }
  }
  if (adapterProofCount === 0) {
    throw new Error("NEGATIVE_RISK_CONVERSION_ADAPTER_PROOF_MISSING");
  }
  if (adapterProofCount !== 1) {
    throw new Error("NEGATIVE_RISK_CONVERSION_ADAPTER_PROOF_AMBIGUOUS");
  }

  const negative = [...deltas.entries()].filter(([, delta]) => delta < 0n);
  const positive = [...deltas.entries()].filter(([, delta]) => delta > 0n);
  if (negative.length !== 1 || negative[0]![1] !== -amountMicros) {
    throw new Error("NEGATIVE_RISK_CONVERSION_SOURCE_DELTA_INVALID");
  }
  if (positive.length < 2 || positive.some(([, delta]) => delta !== amountMicros)) {
    throw new Error("NEGATIVE_RISK_CONVERSION_DESTINATION_DELTAS_INVALID");
  }
  const sourceAsset = negative[0]![0];
  const positionsByAsset = new Map(input.positions.map((position) => [position.asset, position]));
  const destinationEventSlugs = new Set<string>();
  const destinationAssets = positive
    .map(([asset, delta]): NegativeRiskConversionDestination => {
      const position = positionsByAsset.get(asset);
      if (!position) throw new Error(`NEGATIVE_RISK_CONVERSION_DESTINATION_POSITION_MISSING:${asset}`);
      if (position.negativeRisk !== true) {
        throw new Error(`NEGATIVE_RISK_CONVERSION_DESTINATION_NOT_NEGATIVE_RISK:${asset}`);
      }
      const positionEventSlug = position.eventSlug?.trim();
      if (!positionEventSlug) throw new Error(`NEGATIVE_RISK_CONVERSION_DESTINATION_EVENT_MISSING:${asset}`);
      destinationEventSlugs.add(positionEventSlug);
      return {
        asset,
        conditionId: normalizedHash(
          position.conditionId,
          `NEGATIVE_RISK_CONVERSION_DESTINATION_CONDITION_INVALID:${asset}`,
        ),
        amountMicros: delta.toString(),
      };
    })
    .sort((a, b) => a.asset.localeCompare(b.asset));
  if (destinationEventSlugs.size !== 1) {
    throw new Error("NEGATIVE_RISK_CONVERSION_DESTINATION_EVENT_MISMATCH");
  }
  const eventSlug = [...destinationEventSlugs][0]!;
  if (activityEventSlug !== null && activityEventSlug !== eventSlug) {
    throw new Error("NEGATIVE_RISK_CONVERSION_ACTIVITY_EVENT_MISMATCH");
  }
  const withoutHash = {
    transactionHash,
    groupConditionId,
    eventSlug,
    sourceAsset,
    destinationAssets,
    amountMicros: amountMicros.toString(),
    receiptBlockNumber: receipt.blockNumber?.toLowerCase() ?? null,
    receiptPayloadHash: receiptPayloadHash(input.receipt),
  };
  return {
    ...withoutHash,
    evidenceHash: negativeRiskConversionEvidenceHash(withoutHash),
  };
}
