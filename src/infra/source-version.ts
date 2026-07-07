import { execFileSync } from "node:child_process";

export interface SourceVersion {
  commit: string;
  dirty: boolean;
}

export function resolveSourceVersion(cwd = process.cwd()): SourceVersion {
  const environmentCommit = process.env.SOURCE_CODE_COMMIT?.trim();
  if (environmentCommit) {
    return {
      commit: environmentCommit,
      dirty: process.env.SOURCE_CODE_DIRTY !== "0",
    };
  }

  try {
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
    const status = execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" }).trim();
    return { commit, dirty: status.length > 0 };
  } catch {
    return { commit: "UNCOMMITTED", dirty: true };
  }
}
