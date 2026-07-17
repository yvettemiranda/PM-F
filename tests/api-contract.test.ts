import { describe, expect, it } from "vitest";
import { validateApiContract } from "../src/services/api-contract.js";

const wallet = "0x0000000000000000000000000000000000000001";

describe("API contract validation", () => {
  it("records precision, ordering pressure, history limits, and clock offset", () => {
    const report = validateApiContract({
      trades: [
        {
          proxyWallet: wallet,
          transactionHash: "0x1",
          conditionId: "0x2",
          asset: "1",
          side: "BUY",
          price: "0.2049999109",
          size: "10.123456",
          timestamp: 1_700_000_000,
        },
        {
          proxyWallet: wallet,
          transactionHash: "0x1",
          conditionId: "0x2",
          asset: "1",
          side: "BUY",
          price: "0.2",
          size: "1",
          timestamp: 1_700_000_000,
        },
      ],
      activity: [],
      positions: [],
      tradeHistoryComplete: false,
      activityHistoryComplete: false,
      clobTime: {
        url: "https://clob.polymarket.com/time",
        fetchedAt: "2023-11-14T22:13:20.100Z",
        latencyMs: 200,
        status: 200,
        data: 1_700_000_000,
      },
      captures: [],
    });

    expect(report.status).toBe("INCOMPLETE");
    expect(report.schemaErrors).toEqual([]);
    expect(report.observations.maxPriceFractionDigits).toBe(10);
    expect(report.observations.maxSizeFractionDigits).toBe(6);
    expect(report.observations.sameSecondGroups).toBe(1);
    expect(report.observations.multiRowTransactions).toBe(1);
    expect(report.observations.clockOffsetMs).toBe(0);
  });

  it("fails malformed trade fields", () => {
    const report = validateApiContract({
      trades: [
        {
          proxyWallet: "bad",
          transactionHash: "",
          conditionId: "",
          asset: "",
          side: "BUY",
          price: "2",
          size: "-1",
          timestamp: 0,
        },
      ],
      activity: [],
      positions: [],
      tradeHistoryComplete: true,
      activityHistoryComplete: true,
      clobTime: { url: "time", fetchedAt: "2023-11-14T22:13:20.000Z", latencyMs: 0, status: 200, data: 1_700_000_000 },
      captures: [],
    });

    expect(report.status).toBe("FAILED");
    expect(report.schemaErrors.length).toBeGreaterThan(0);
  });

  it("distinguishes confirmed identical fill multiplicity from an ambiguous extra row", () => {
    const fill = {
      proxyWallet: wallet,
      transactionHash: "0x1",
      conditionId: "0x2",
      asset: "1",
      side: "BUY" as const,
      price: "0.5",
      size: "10",
      timestamp: 1_700_000_000,
    };
    const common = {
      positions: [],
      tradeHistoryComplete: true,
      activityHistoryComplete: true,
      clobTime: { url: "time", fetchedAt: "2023-11-14T22:13:20.000Z", latencyMs: 0, status: 200, data: 1_700_000_000 },
      captures: [],
    };
    const confirmed = validateApiContract({
      ...common,
      trades: [fill, { ...fill }],
      activity: [{ ...fill, type: "TRADE" }, { ...fill, type: "TRADE" }],
    });
    expect(confirmed.status).toBe("PASSED");
    expect(confirmed.observations).toMatchObject({
      exactDuplicateRows: 1,
      confirmedDuplicateRows: 1,
      ambiguousDuplicateRows: 0,
    });

    const ambiguous = validateApiContract({
      ...common,
      trades: [fill, { ...fill }],
      activity: [{ ...fill, type: "TRADE" }],
    });
    expect(ambiguous.status).toBe("INCOMPLETE");
    expect(ambiguous.observations.ambiguousDuplicateRows).toBe(1);
    expect(ambiguous.warnings).toContain("EXACT_DUPLICATE_TRADE_ROWS_REQUIRE_RECONCILIATION");

    const reconciledBoundaryOverlap = validateApiContract({
      ...common,
      trades: [fill, { ...fill }],
      activity: [{ ...fill, type: "TRADE" }],
      tradePaginationBoundaryOverlaps: [{ ...fill }],
    });
    expect(reconciledBoundaryOverlap.status).toBe("PASSED");
    expect(reconciledBoundaryOverlap.warnings).toEqual([]);
    expect(reconciledBoundaryOverlap.observations).toMatchObject({
      exactDuplicateRows: 1,
      confirmedDuplicateRows: 0,
      reconciledPaginationOverlapRows: 1,
      ambiguousDuplicateRows: 0,
    });
  });
});
