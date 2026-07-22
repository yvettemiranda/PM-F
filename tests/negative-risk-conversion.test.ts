import { encodeAbiParameters, encodeEventTopics, parseAbiItem, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import type { ApiCapture } from "../src/adapters/polymarket-public.js";
import type { PublicActivity, PublicPosition } from "../src/domain/models.js";
import {
  NEGATIVE_RISK_ADAPTER_ADDRESS,
  NEGATIVE_RISK_CONVERSION_TOPIC,
  POLYMARKET_CTF_ADDRESS,
  type PolygonTransactionReceiptResponse,
  verifyNegativeRiskConversion,
} from "../src/observe/negative-risk-conversion.js";
import { projectObserveEvents } from "../src/observe/position-projector.js";
import type { ObserveBaseline, ObserveEvent } from "../src/observe/types.js";

const wallet = "0x00000000000000000000000000000000000000aa";
const intermediary = "0x00000000000000000000000000000000000000bb";
const operator = NEGATIVE_RISK_ADAPTER_ADDRESS;
const transactionHash = `0x${"31".repeat(32)}`;
const groupConditionId = `0x${"40".repeat(32)}`;
const eventSlug = "fed-decision-in-july-test";
const amount = 10_000_000n;
const sourceAsset = "100";
const destinationAssets = ["201", "202", "203", "204"];
const neutralAssets = ["301", "302", "303", "304"];

const transferBatch = parseAbiItem(
  "event TransferBatch(address indexed operator,address indexed from,address indexed to,uint256[] ids,uint256[] values)",
);

function batch(
  from: `0x${string}`,
  to: `0x${string}`,
  ids: readonly string[],
  values: readonly bigint[],
): PolygonTransactionReceiptResponse["result"] extends infer Receipt
  ? Receipt extends { logs: infer Logs }
    ? Logs extends Array<infer Log> ? Log : never
    : never
  : never {
  return {
    address: POLYMARKET_CTF_ADDRESS,
    topics: encodeEventTopics({
      abi: [transferBatch],
      eventName: "TransferBatch",
      args: { operator, from, to },
    }) as unknown as Hex[],
    data: encodeAbiParameters(
      [{ type: "uint256[]" }, { type: "uint256[]" }],
      [ids.map(BigInt), [...values]],
    ),
  };
}

function conversionLog() {
  return {
    address: NEGATIVE_RISK_ADAPTER_ADDRESS,
    topics: [
      NEGATIVE_RISK_CONVERSION_TOPIC,
      `0x${"0".repeat(24)}${wallet.slice(2)}`,
      groupConditionId,
      `0x${"0".repeat(63)}8`,
    ] as Hex[],
    data: encodeAbiParameters([{ type: "uint256" }], [amount]),
  };
}

function receiptCapture(): ApiCapture<PolygonTransactionReceiptResponse> {
  const equalAmounts = destinationAssets.map(() => amount);
  return {
    url: "https://polygon.example.test",
    fetchedAt: "2026-07-21T22:00:01.000Z",
    latencyMs: 10,
    status: 200,
    data: {
      jsonrpc: "2.0",
      id: 3,
      result: {
        transactionHash,
        status: "0x1",
        blockNumber: "0x123",
        logs: [
          // The real adapter transaction temporarily sends both outcome sets
          // to the wallet, then removes one set again. Only net wallet deltas
          // describe the public Positions change.
          batch(wallet, intermediary, [sourceAsset], [amount]),
          batch(operator, wallet, destinationAssets, equalAmounts),
          batch(operator, wallet, neutralAssets, equalAmounts),
          batch(wallet, intermediary, neutralAssets, equalAmounts),
          conversionLog(),
        ],
      },
    },
  };
}

function conversionActivity(overrides: Partial<PublicActivity> = {}): PublicActivity {
  return {
    proxyWallet: wallet,
    transactionHash,
    timestamp: 1_784_640_000,
    conditionId: groupConditionId,
    type: "CONVERSION",
    size: "10",
    eventSlug,
    ...overrides,
  };
}

function position(asset: string, conditionSuffix: string): PublicPosition {
  return {
    proxyWallet: wallet,
    asset,
    conditionId: `0x${conditionSuffix.repeat(64).slice(0, 64)}`,
    size: "10",
    avgPrice: "0.25",
    currentValue: "2.5",
    title: "Fed Decision in July?",
    slug: `market-${conditionSuffix}`,
    eventSlug,
    outcome: "Yes",
    negativeRisk: true,
  };
}

function positions(): PublicPosition[] {
  return destinationAssets.map((asset, index) => position(asset, String(index + 1)));
}

function baseline(sizeMicros = amount): ObserveBaseline {
  return {
    baselineRunId: "baseline-conversion",
    targetId: "target-conversion",
    walletAddress: wallet,
    snapshotTime: "2026-07-21T21:59:00.000Z",
    items: [{ asset: sourceAsset, conditionId: `0x${"9".repeat(64)}`, sizeMicros: sizeMicros.toString() }],
  };
}

describe("negative-risk conversion", () => {
  it("derives the exact source and destination legs from net wallet receipt deltas", () => {
    const verified = verifyNegativeRiskConversion({
      activity: conversionActivity(),
      walletAddress: wallet,
      positions: positions(),
      receipt: receiptCapture(),
    });

    expect(verified).toMatchObject({
      transactionHash,
      groupConditionId,
      sourceAsset,
      amountMicros: amount.toString(),
      receiptBlockNumber: "0x123",
    });
    expect(verified.destinationAssets.map((leg) => leg.asset)).toEqual(destinationAssets);
    expect(verified.destinationAssets.every((leg) => leg.amountMicros === amount.toString())).toBe(true);
    expect(verified.evidenceHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("derives event identity from consistent Positions when sparse Activity has no eventSlug", () => {
    const sparseActivity = conversionActivity();
    delete sparseActivity.eventSlug;
    const verified = verifyNegativeRiskConversion({
      activity: sparseActivity,
      walletAddress: wallet,
      positions: positions(),
      receipt: receiptCapture(),
    });
    expect(verified.eventSlug).toBe(eventSlug);
  });

  it("rejects a receipt whose adapter amount does not match Activity", () => {
    const receipt = receiptCapture();
    receipt.data.result!.logs.at(-1)!.data = encodeAbiParameters([{ type: "uint256" }], [amount - 1n]);
    expect(() => verifyNegativeRiskConversion({
      activity: conversionActivity(),
      walletAddress: wallet,
      positions: positions(),
      receipt,
    })).toThrow("NEGATIVE_RISK_CONVERSION_ADAPTER_PROOF_MISSING");
  });

  it("rejects adapter proof for a stakeholder other than the target wallet", () => {
    const receipt = receiptCapture();
    const proof = receipt.data.result!.logs.at(-1)!;
    receipt.data.result!.logs[receipt.data.result!.logs.length - 1] = {
      ...proof,
      topics: proof.topics.map((topic, index) => (
        index === 1 ? `0x${"0".repeat(24)}${intermediary.slice(2)}` : topic
      )),
    };
    expect(() => verifyNegativeRiskConversion({
      activity: conversionActivity(),
      walletAddress: wallet,
      positions: positions(),
      receipt,
    })).toThrow("NEGATIVE_RISK_CONVERSION_ADAPTER_PROOF_MISSING");
  });

  it("rejects ambiguous duplicate adapter proofs", () => {
    const receipt = receiptCapture();
    receipt.data.result!.logs.push(conversionLog());
    expect(() => verifyNegativeRiskConversion({
      activity: conversionActivity(),
      walletAddress: wallet,
      positions: positions(),
      receipt,
    })).toThrow("NEGATIVE_RISK_CONVERSION_ADAPTER_PROOF_AMBIGUOUS");
  });

  it("rejects destination metadata that is not in the same negative-risk event", () => {
    const invalidPositions = positions();
    invalidPositions[0] = { ...invalidPositions[0]!, eventSlug: "different-event" };
    expect(() => verifyNegativeRiskConversion({
      activity: conversionActivity(),
      walletAddress: wallet,
      positions: invalidPositions,
      receipt: receiptCapture(),
    })).toThrow("NEGATIVE_RISK_CONVERSION_DESTINATION_EVENT_MISMATCH");
  });

  it("re-buckets a fully historical conversion without creating an execution signal", () => {
    const conversion = verifyNegativeRiskConversion({
      activity: conversionActivity(),
      walletAddress: wallet,
      positions: positions(),
      receipt: receiptCapture(),
    });
    const events: ObserveEvent[] = [{
      sourceEventKey: "conversion-event",
      sourceType: "DATA_API_ACTIVITY",
      sourceTimestamp: conversionActivity().timestamp,
      isGap: false,
      isCombo: true,
      activityConfirmed: true,
      activity: conversionActivity(),
      conversion,
    }];

    const result = projectObserveEvents(baseline(), events, { requireVerifiedConversions: true });
    expect(result.signals).toEqual([]);
    expect(result.projection).toEqual(destinationAssets.map((asset) => ({
      asset,
      historicalMicros: amount.toString(),
      trackedMicros: "0",
      expectedTotalMicros: amount.toString(),
      lastSourceEventKey: "conversion-event",
    })));
  });

  it("preserves historical/tracked buckets and emits a fail-closed tracked conversion obligation", () => {
    const conversion = verifyNegativeRiskConversion({
      activity: conversionActivity(),
      walletAddress: wallet,
      positions: positions(),
      receipt: receiptCapture(),
    });
    const events: ObserveEvent[] = [
      {
        sourceEventKey: "tracked-buy",
        sourceType: "DATA_API_TRADE",
        sourceTimestamp: conversionActivity().timestamp - 1,
        isGap: false,
        isCombo: false,
        activityConfirmed: true,
        trade: {
          proxyWallet: wallet,
          transactionHash: `0x${"32".repeat(32)}`,
          conditionId: `0x${"9".repeat(64)}`,
          asset: sourceAsset,
          side: "BUY",
          price: "0.5",
          size: "6",
          timestamp: conversionActivity().timestamp - 1,
        },
      },
      {
        sourceEventKey: "conversion-event",
        sourceType: "DATA_API_ACTIVITY",
        sourceTimestamp: conversionActivity().timestamp,
        isGap: false,
        isCombo: true,
        activityConfirmed: true,
        activity: conversionActivity(),
        conversion,
      },
    ];

    const result = projectObserveEvents(baseline(4_000_000n), events, { requireVerifiedConversions: true });
    expect(result.projection.every((entry) => (
      entry.historicalMicros === "4000000" && entry.trackedMicros === "6000000"
    ))).toBe(true);
    expect(result.signals).toHaveLength(2);
    expect(result.signals[1]).toMatchObject({
      signalType: "TARGET_CONVERSION",
      asset: sourceAsset,
      targetSizeMicros: amount.toString(),
      sellRatioNumerator: "6000000",
      sellRatioDenominator: "6000000",
      executionEligible: false,
      executionBlockReason: "NEGATIVE_RISK_CONVERSION_EXECUTION_UNAVAILABLE",
      eventClassification: "NEGATIVE_RISK_CONVERSION",
    });
  });
});
