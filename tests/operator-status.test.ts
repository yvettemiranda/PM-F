import { describe, expect, it } from "vitest";
import { effectiveLivePrerequisites } from "../src/operator/operator-status.js";

describe("operator status projection", () => {
  it("marks previously passed evidence stale when it belongs to another source commit", () => {
    const [item] = effectiveLivePrerequisites([
      {
        key: "PAPER_STABILITY",
        status: "PASSED",
        evidence: { sourceCodeCommit: "old-commit" },
        updatedAt: "2026-07-29T03:35:59.463Z",
      },
    ], { commit: "current-commit", dirty: false });

    expect(item).toMatchObject({
      status: "PASSED",
      effectiveStatus: "STALE",
      effectiveReason: "SOURCE_COMMIT_MISMATCH",
    });
  });

  it("marks passed evidence stale while the running source is dirty", () => {
    const [item] = effectiveLivePrerequisites([
      {
        key: "PAPER_STABILITY",
        status: "PASSED",
        evidence: { sourceCodeCommit: "current-commit" },
        updatedAt: "2026-07-29T03:35:59.463Z",
      },
    ], { commit: "current-commit", dirty: true });

    expect(item).toMatchObject({
      effectiveStatus: "STALE",
      effectiveReason: "SOURCE_DIRTY",
    });
  });

  it("keeps current and pending evidence truthful", () => {
    const items = effectiveLivePrerequisites([
      {
        key: "PAPER_STABILITY",
        status: "PASSED",
        evidence: { sourceCodeCommit: "current-commit" },
        updatedAt: "2026-07-29T03:35:59.463Z",
      },
      {
        key: "USER_EXPLICIT_AUTHORIZATION",
        status: "PENDING",
        evidence: {},
        updatedAt: "2026-07-29T03:35:59.463Z",
      },
    ], { commit: "current-commit", dirty: false });

    expect(items.map((item) => item.effectiveStatus)).toEqual(["PASSED", "PENDING"]);
  });
});
