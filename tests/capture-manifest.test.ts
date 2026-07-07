import { describe, expect, it } from "vitest";
import { buildCaptureManifest } from "../src/services/capture-manifest.js";

describe("capture manifest", () => {
  it("is deterministic and records endpoint range, pagination, payload hash, and source version", () => {
    const input = {
      walletAddress: "0x0000000000000000000000000000000000000001",
      sampleRole: "TARGET" as const,
      purpose: "TEST",
      sourceVersion: { commit: "abc", dirty: false },
      sources: [
        {
          endpoint: "data-trades",
          pageIndex: 0,
          paginationStatus: "END_OF_DATA",
          capture: {
            url: "https://example.test/trades",
            fetchedAt: "2026-07-07T00:00:00.000Z",
            latencyMs: 10,
            status: 200,
            data: [{ timestamp: 100 }, { timestamp: 200 }],
          },
        },
      ],
    };
    const first = buildCaptureManifest(input);
    const second = buildCaptureManifest(input);
    expect(first.manifestHash).toBe(second.manifestHash);
    expect(first.captureRunId).toBe(second.captureRunId);
    expect(first.sourceCodeCommit).toBe("abc");
    expect(first.sourceCodeDirty).toBe(false);
    expect(first.endpointSummaries[0]).toMatchObject({ rowCount: 2, sourceTimeFrom: 100, sourceTimeTo: 200 });
  });
});
