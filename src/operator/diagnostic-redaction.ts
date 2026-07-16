import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
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

function isValidPublicId(key: string, value: string): boolean {
  const prefix = PUBLIC_ID_PREFIX_BY_KEY.get(key);
  return prefix !== undefined && new RegExp(`^${prefix}-[A-Z0-9]+(?:-[A-Z0-9]+)*$`).test(value);
}

export function redactDiagnosticValue(value: unknown, options: DiagnosticRedactionOptions): unknown {
  const visit = (current: unknown, key = ""): unknown => {
    if (ACCOUNT_KEYS.has(key)) return "[REDACTED_PAPER_ACCOUNT_ID]";
    if (Array.isArray(current)) return current.map((item) => visit(item, key));
    if (current && typeof current === "object") {
      return Object.fromEntries(Object.entries(current).map(([childKey, childValue]) => [childKey, visit(childValue, childKey)]));
    }
    if (typeof current !== "string") return current;
    let result = current
      .split(options.projectRoot).join("[PROJECT_ROOT]")
      .split(options.homeDirectory).join("[HOME]");
    if (isValidPublicId(key, result)) return result;
    result = result.replace(UUID_PATTERN, (match) => stableInternalAlias(match));
    return result;
  };
  return visit(value);
}

export function redactDiagnosticLog(content: string, options: DiagnosticRedactionOptions): string {
  return content
    .split(options.projectRoot).join("[PROJECT_ROOT]")
    .split(options.homeDirectory).join("[HOME]")
    .replace(UUID_PATTERN, (match) => stableInternalAlias(match));
}

export interface DiagnosticBundleManifest {
  manifestVersion: "1.0.0";
  campaignId: string | null;
  sessionId: string | null;
  reportId: string | null;
  sourceCommit: string;
  schemaVersion: string;
  rulesetHash: string | null;
  configVersion: string;
  generatedAt: string;
  files: Array<{ name: string; bytes: number; sha256: string }>;
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
      return {
        name,
        bytes: stat.size,
        sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
  return { manifestVersion: "1.0.0", ...metadata, files };
}
