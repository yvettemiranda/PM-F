import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const HTTP_URL_PATTERN = /\bhttps?:\/\/[^\s"'<>\\]+/gi;
const LOCAL_ROOT = "(?:Users|private|tmp|var|Volumes|home|root|opt|usr|etc|Library|System|Applications|workspace|workspaces|mnt|srv|dev)";
const FILE_URL_PATTERN = new RegExp(
  `\\bfile:\\/\\/(?:localhost)?\\/${LOCAL_ROOT}(?:\\/[^\\s"'<>\\\\)\\]},;&?#]*)?`,
  "gi",
);
const LOCAL_PATH_PATTERN = new RegExp(
  `\\/${LOCAL_ROOT}(?:\\/[^\\s"'<>\\\\)\\]},;&?#]*)?`,
  "gi",
);
const ENCODED_FILE_URL_PATTERN = new RegExp(
  `file%3a(?:%2f){3}${LOCAL_ROOT}(?:%2f[^\\s"'<>\\\\)\\]},;&?#]*)?`,
  "gi",
);
const ENCODED_LOCAL_PATH_PATTERN = new RegExp(
  `%2f${LOCAL_ROOT}(?:%2f[^\\s"'<>\\\\)\\]},;&?#]*)?`,
  "gi",
);
const PUBLIC_ID_PREFIX_BY_KEY = new Map<string, "PC" | "PS" | "PR">([
  ["campaignId", "PC"], ["campaign_id", "PC"], ["publicCampaignId", "PC"], ["public_campaign_id", "PC"],
  ["sessionId", "PS"], ["session_id", "PS"], ["publicSessionId", "PS"], ["public_session_id", "PS"],
  ["reportId", "PR"], ["report_id", "PR"], ["publicReportId", "PR"], ["public_report_id", "PR"],
]);
const ACCOUNT_KEYS = new Set(["accountId", "account_id", "paperAccountId", "paper_account_id", "accountIdFile"]);

export interface DiagnosticRedactionOptions {
  projectRoot: string;
  homeDirectory: string;
}

function stableInternalAlias(raw: string): string {
  const suffix = createHash("sha256")
    .update("ni-k-diagnostic-internal-id-v1\0")
    .update(raw.toLowerCase())
    .digest("hex")
    .slice(0, 16);
  return `internal_id_${suffix}`;
}

function stableLocalPathAlias(raw: string): string {
  const suffix = createHash("sha256")
    .update("ni-k-diagnostic-local-path-v1\0")
    .update(raw)
    .digest("hex")
    .slice(0, 16);
  return `[LOCAL_PATH_${suffix}]`;
}

function withoutHttpUrls<T>(value: string, transform: (protectedValue: string) => T): T {
  const urls: string[] = [];
  const protectedValue = value.replace(HTTP_URL_PATTERN, (url) => {
    const suffixIndex = url.search(/[?#]/);
    const protectedPart = suffixIndex < 0 ? url : url.slice(0, suffixIndex);
    const inspectableSuffix = suffixIndex < 0 ? "" : url.slice(suffixIndex);
    const index = urls.push(protectedPart) - 1;
    return `\u0000NI_K_HTTP_URL_${index}\u0000${inspectableSuffix}`;
  });
  const transformed = transform(protectedValue);
  if (typeof transformed !== "string") return transformed;
  return transformed.replace(/\u0000NI_K_HTTP_URL_(\d+)\u0000/g, (_, rawIndex: string) => (
    urls[Number(rawIndex)] ?? "[INVALID_HTTP_URL_PLACEHOLDER]"
  )) as T;
}

function redactLocalPaths(value: string, options: DiagnosticRedactionOptions): string {
  return withoutHttpUrls(value, (protectedValue) => protectedValue
    .replace(FILE_URL_PATTERN, (path) => stableLocalPathAlias(path))
    .replace(ENCODED_FILE_URL_PATTERN, (path) => stableLocalPathAlias(path))
    .split(options.projectRoot).join("[PROJECT_ROOT]")
    .split(options.homeDirectory).join("[HOME]")
    .replace(LOCAL_PATH_PATTERN, (path) => stableLocalPathAlias(path))
    .replace(ENCODED_LOCAL_PATH_PATTERN, (path) => stableLocalPathAlias(path)));
}

export function diagnosticLocalPathLeakCount(content: string): number {
  return withoutHttpUrls(content, (protectedValue) => {
    const fileUrls = protectedValue.match(FILE_URL_PATTERN)?.length ?? 0;
    const encodedFileUrls = protectedValue.match(ENCODED_FILE_URL_PATTERN)?.length ?? 0;
    const withoutFileUrls = protectedValue
      .replace(FILE_URL_PATTERN, "")
      .replace(ENCODED_FILE_URL_PATTERN, "");
    return fileUrls
      + encodedFileUrls
      + (withoutFileUrls.match(LOCAL_PATH_PATTERN)?.length ?? 0)
      + (withoutFileUrls.match(ENCODED_LOCAL_PATH_PATTERN)?.length ?? 0);
  });
}

function isValidPublicId(key: string, value: string): boolean {
  const prefix = PUBLIC_ID_PREFIX_BY_KEY.get(key);
  return prefix !== undefined && new RegExp(`^${prefix}-[A-Z0-9]+(?:-[A-Z0-9]+)*$`).test(value);
}

export function redactDiagnosticValue(value: unknown, options: DiagnosticRedactionOptions): unknown {
  const visit = (current: unknown, key = ""): unknown => {
    if (ACCOUNT_KEYS.has(key)) return "[REDACTED_PAPER_ACCOUNT_ID]";
    if (Array.isArray(current)) return current.map((item) => visit(item, key));
    if (current && typeof current === "object") {
      return Object.fromEntries(Object.entries(current).map(([childKey, childValue]) => [
        redactLocalPaths(childKey, options),
        visit(childValue, childKey),
      ]));
    }
    if (typeof current !== "string") return current;
    let result = redactLocalPaths(current, options);
    if (isValidPublicId(key, result)) return result;
    result = result.replace(UUID_PATTERN, (match) => stableInternalAlias(match));
    return result;
  };
  return visit(value);
}

export function redactDiagnosticLog(content: string, options: DiagnosticRedactionOptions): string {
  return redactLocalPaths(content, options)
    .replace(UUID_PATTERN, (match) => stableInternalAlias(match));
}

export interface DiagnosticBundleManifest {
  manifestVersion: "1.1.0";
  campaignId: string | null;
  sessionId: string | null;
  reportId: string | null;
  sourceCommit: string | null;
  sourceCodeDirty: boolean | null;
  coreCompatibilityHash: string | null;
  schemaVersion: string;
  rulesetHash: string | null;
  configVersion: string;
  generatedAt: string;
  files: Array<{ name: string; bytes: number; sha256: string }>;
}

export interface DiagnosticSourceProvenance {
  sourceCommit: string | null;
  sourceCodeDirty: boolean | null;
  coreCompatibilityHash: string | null;
}

const SOURCE_COMMIT_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;

function uniqueValid<T>(values: unknown[], valid: (value: unknown) => value is T): T | null {
  const unique = [...new Set(values.filter(valid))];
  return unique.length === 1 ? unique[0]! : null;
}

export function diagnosticSourceProvenanceFromReports(reports: unknown[]): DiagnosticSourceProvenance {
  const roots = reports.filter((report): report is Record<string, unknown> => (
    report !== null && typeof report === "object" && !Array.isArray(report)
  ));
  const objects = roots.flatMap((root) => [root, root.session, root.campaign])
    .filter((value): value is Record<string, unknown> => (
      value !== null && typeof value === "object" && !Array.isArray(value)
    ));
  const sourceVersions = objects.map((value) => value.sourceVersion)
    .filter((value): value is Record<string, unknown> => (
      value !== null && typeof value === "object" && !Array.isArray(value)
    ));
  return {
    sourceCommit: uniqueValid(
      [
        ...objects.map((value) => value.sourceCommit),
        ...objects.map((value) => value.sourceCodeCommit),
        ...sourceVersions.map((value) => value.commit),
      ],
      (value): value is string => typeof value === "string" && SOURCE_COMMIT_PATTERN.test(value),
    ),
    sourceCodeDirty: uniqueValid(
      [...objects.map((value) => value.sourceCodeDirty), ...sourceVersions.map((value) => value.dirty)],
      (value): value is boolean => typeof value === "boolean",
    ),
    coreCompatibilityHash: uniqueValid(
      objects.map((value) => value.coreCompatibilityHash),
      (value): value is string => typeof value === "string" && SHA256_PATTERN.test(value),
    ),
  };
}

export function buildDiagnosticBundleManifest(
  directory: string,
  metadata: Omit<DiagnosticBundleManifest, "manifestVersion" | "files">,
): DiagnosticBundleManifest {
  const files = readdirSync(directory)
    .filter((name) => name !== "bundle-manifest.json")
    .map((name) => {
      const path = join(directory, name);
      const stat = statSync(path);
      if (!stat.isFile()) throw new Error(`DIAGNOSTIC_BUNDLE_NON_FILE:${basename(path)}`);
      const content = readFileSync(path);
      if (diagnosticLocalPathLeakCount(content.toString("utf8")) > 0) {
        throw new Error(`DIAGNOSTIC_BUNDLE_LOCAL_PATH_LEAK:${basename(path)}`);
      }
      return {
        name,
        bytes: stat.size,
        sha256: createHash("sha256").update(content).digest("hex"),
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
  const provenance = diagnosticSourceProvenanceFromReports([metadata]);
  return { manifestVersion: "1.1.0", ...metadata, ...provenance, files };
}
