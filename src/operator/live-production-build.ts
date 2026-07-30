import {
  execFileSync,
  type ExecFileSyncOptionsWithStringEncoding,
} from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { resolveSourceVersion, type SourceVersion } from "../infra/source-version.js";

const RUNTIME_HASH_SCHEMA = "hecatonchires-live-runtime-v2";
const ROOT_RUNTIME_FILES = new Set([
  "package.json",
  "pnpm-lock.yaml",
  "tsconfig.json",
  "scripts/launch-hecatonchires-ui.command",
]);

function normalizedPath(value: string): string {
  return value.split(sep).join("/").replace(/^\.\//, "");
}

/**
 * Files that can alter Live execution, wallet binding, Gate behavior, database
 * semantics, validation evidence, or the desktop launcher. Documentation,
 * reports, images, and pure presentation CSS intentionally stay outside this
 * boundary.
 */
export function isLiveProductionRuntimePath(value: string): boolean {
  const path = normalizedPath(value);
  if (ROOT_RUNTIME_FILES.has(path)) return true;
  if (path.startsWith("src/")) return path.endsWith(".ts") || path.endsWith(".sql");
  if (path.startsWith("tests/")) return path.endsWith(".ts") || path.endsWith(".sql");
  if (path.startsWith("prototype/live-ui/")) {
    return path.endsWith(".js") || path.endsWith(".mjs") || path.endsWith(".html");
  }
  if (path.startsWith("操作入口/")) return path.endsWith(".command") || path.endsWith(".sh");
  return false;
}

function walkFiles(root: string, directory: string, output: string[]): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      walkFiles(root, absolute, output);
      continue;
    }
    if (!entry.isFile()) continue;
    const path = normalizedPath(relative(root, absolute));
    if (isLiveProductionRuntimePath(path)) output.push(path);
  }
}

export function liveProductionRuntimeFiles(projectRoot: string): string[] {
  const root = resolve(projectRoot);
  const output: string[] = [];
  for (const path of ROOT_RUNTIME_FILES) {
    if (existsSync(resolve(root, path))) output.push(path);
  }
  for (const directory of ["src", "tests", "prototype/live-ui", "操作入口"]) {
    const absolute = resolve(root, directory);
    if (existsSync(absolute)) walkFiles(root, absolute, output);
  }
  return output.sort((left, right) => left.localeCompare(right, "en"));
}

export function computeLiveProductionRuntimeHash(projectRoot: string): string {
  const root = resolve(projectRoot);
  const hash = createHash("sha256");
  hash.update(`${RUNTIME_HASH_SCHEMA}\0`);
  for (const path of liveProductionRuntimeFiles(root)) {
    const absolute = resolve(root, path);
    const executable = (statSync(absolute).mode & 0o111) === 0 ? "0" : "1";
    const contents = readFileSync(absolute);
    hash.update(path);
    hash.update("\0");
    hash.update(executable);
    hash.update("\0");
    hash.update(String(contents.byteLength));
    hash.update("\0");
    hash.update(contents);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function nulSeparated(value: string): string[] {
  return value.split("\0").filter((item) => item.length > 0).map(normalizedPath);
}

function changedPaths(projectRoot: string): string[] | null {
  try {
    const options: ExecFileSyncOptionsWithStringEncoding = {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    };
    const tracked = execFileSync(
      "git",
      ["diff", "--name-only", "-z", "HEAD", "--"],
      options,
    );
    const untracked = execFileSync(
      "git",
      ["ls-files", "--others", "--exclude-standard", "-z"],
      options,
    );
    return [...new Set([...nulSeparated(tracked), ...nulSeparated(untracked)])].sort();
  } catch {
    return null;
  }
}

export interface LiveProductionRuntimeIdentity {
  sourceVersion: SourceVersion;
  liveRuntimeHash: string;
  runtimeSourceDirty: boolean;
  runtimeDirtyPaths: string[];
}

export function resolveLiveProductionRuntimeIdentity(
  projectRoot: string,
  sourceVersion: SourceVersion = resolveSourceVersion(projectRoot),
): LiveProductionRuntimeIdentity {
  const paths = changedPaths(projectRoot);
  const runtimeDirtyPaths = paths === null
    ? []
    : paths.filter(isLiveProductionRuntimePath);
  return {
    sourceVersion,
    liveRuntimeHash: computeLiveProductionRuntimeHash(projectRoot),
    runtimeSourceDirty: paths === null ? sourceVersion.dirty : runtimeDirtyPaths.length > 0,
    runtimeDirtyPaths,
  };
}
