import type { SourceVersion } from "../infra/source-version.js";

export interface LivePrerequisiteStatus {
  key: string;
  status: string;
  evidence: unknown;
  updatedAt: string;
}

export interface EffectiveLivePrerequisiteStatus extends LivePrerequisiteStatus {
  effectiveStatus: string;
  effectiveReason: "SOURCE_DIRTY" | "SOURCE_COMMIT_MISMATCH" | null;
}

function evidenceSourceCommit(evidence: unknown): string | null {
  if (typeof evidence !== "object" || evidence === null || Array.isArray(evidence)) return null;
  const sourceCodeCommit = (evidence as Record<string, unknown>).sourceCodeCommit;
  return typeof sourceCodeCommit === "string" && sourceCodeCommit.length > 0
    ? sourceCodeCommit
    : null;
}

export function effectiveLivePrerequisites(
  prerequisites: readonly LivePrerequisiteStatus[],
  sourceVersion: SourceVersion,
): EffectiveLivePrerequisiteStatus[] {
  return prerequisites.map((item) => {
    const sourceCodeCommit = evidenceSourceCommit(item.evidence);
    if (item.status === "PASSED" && sourceCodeCommit !== null && sourceVersion.dirty) {
      return {
        ...item,
        effectiveStatus: "STALE",
        effectiveReason: "SOURCE_DIRTY",
      };
    }
    if (
      item.status === "PASSED"
      && sourceCodeCommit !== null
      && sourceCodeCommit !== sourceVersion.commit
    ) {
      return {
        ...item,
        effectiveStatus: "STALE",
        effectiveReason: "SOURCE_COMMIT_MISMATCH",
      };
    }
    return {
      ...item,
      effectiveStatus: item.status,
      effectiveReason: null,
    };
  });
}
