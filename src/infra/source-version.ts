import { execFileSync } from "node:child_process";

export interface SourceVersion {
  commit: string;
  dirty: boolean;
}

export function resolveSourceVersion(
  cwd = process.cwd(),
  environment: NodeJS.ProcessEnv = process.env,
): SourceVersion {
  const environmentCommit = environment.SOURCE_CODE_COMMIT?.trim();
  try {
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
    const status = execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" }).trim();
    const environmentMismatch = environmentCommit !== undefined && environmentCommit !== commit;
    const environmentMarksDirty = environment.SOURCE_CODE_DIRTY !== undefined
      && environment.SOURCE_CODE_DIRTY !== "0";
    return {
      commit,
      dirty: status.length > 0 || environmentMismatch || environmentMarksDirty,
    };
  } catch {
    // An environment value is useful provenance when Git metadata was omitted
    // from a packaged artifact, but it is never proof of a clean build.
    return { commit: environmentCommit || "UNCOMMITTED", dirty: true };
  }
}
