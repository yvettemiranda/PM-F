import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveSourceVersion } from "../src/infra/source-version.js";

const directories: string[] = [];

function gitRepository(): { directory: string; commit: string } {
  const directory = mkdtempSync(join(tmpdir(), "ni-k-source-version-"));
  directories.push(directory);
  execFileSync("git", ["init", "-q"], { cwd: directory });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: directory });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: directory });
  writeFileSync(join(directory, "tracked.txt"), "clean\n");
  execFileSync("git", ["add", "tracked.txt"], { cwd: directory });
  execFileSync("git", ["commit", "-qm", "test"], { cwd: directory });
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: directory, encoding: "utf8" }).trim();
  return { directory, commit };
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("resolveSourceVersion", () => {
  it("uses Git as the authoritative clean commit", () => {
    const repository = gitRepository();
    expect(resolveSourceVersion(repository.directory, {})).toEqual({
      commit: repository.commit,
      dirty: false,
    });
  });

  it("cannot be spoofed clean by a mismatched environment commit", () => {
    const repository = gitRepository();
    expect(resolveSourceVersion(repository.directory, {
      SOURCE_CODE_COMMIT: "spoofed-commit",
      SOURCE_CODE_DIRTY: "0",
    })).toEqual({ commit: repository.commit, dirty: true });
  });

  it("cannot hide a dirty worktree with SOURCE_CODE_DIRTY=0", () => {
    const repository = gitRepository();
    writeFileSync(join(repository.directory, "tracked.txt"), "dirty\n");
    expect(resolveSourceVersion(repository.directory, {
      SOURCE_CODE_COMMIT: repository.commit,
      SOURCE_CODE_DIRTY: "0",
    })).toEqual({ commit: repository.commit, dirty: true });
  });

  it("records packaged provenance but remains dirty when Git is unavailable", () => {
    const missing = join(tmpdir(), `ni-k-missing-${Date.now()}`);
    expect(resolveSourceVersion(missing, {
      SOURCE_CODE_COMMIT: "packaged-commit",
      SOURCE_CODE_DIRTY: "0",
    })).toEqual({ commit: "packaged-commit", dirty: true });
  });
});
