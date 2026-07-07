import { createHash } from "node:crypto";
import type { ApiCapture } from "../adapters/polymarket-public.js";
import { stableJson, VERSIONS } from "../domain/versioning.js";
import type { SourceVersion } from "../infra/source-version.js";

export type CaptureSampleRole = "TARGET" | "FIXTURE";

export interface CaptureManifestSource {
  endpoint: string;
  capture: ApiCapture<unknown>;
  pageIndex?: number;
  paginationStatus: string;
}

export interface CaptureManifestItem {
  manifestItemId: string;
  captureId: string;
  endpoint: string;
  requestUrl: string;
  pageIndex: number | null;
  fetchedAt: string;
  sourceTimeFrom: number | null;
  sourceTimeTo: number | null;
  rowCount: number;
  paginationStatus: string;
  payloadSha256: string;
}

export interface CaptureManifest {
  captureRunId: string;
  manifestHash: string;
  walletAddress: string;
  sampleRole: CaptureSampleRole;
  purpose: string;
  status: "COMPLETE";
  startedAt: string;
  completedAt: string;
  sourceCodeCommit: string;
  sourceCodeDirty: boolean;
  versions: typeof VERSIONS;
  items: CaptureManifestItem[];
  endpointSummaries: Array<{
    endpoint: string;
    itemCount: number;
    rowCount: number;
    sourceTimeFrom: number | null;
    sourceTimeTo: number | null;
    paginationStatuses: string[];
  }>;
}

export function captureIdentity(capture: ApiCapture<unknown>): { captureId: string; payloadSha256: string } {
  const responseJson = JSON.stringify(capture.data);
  const payloadSha256 = createHash("sha256").update(responseJson).digest("hex");
  const captureId = createHash("sha256")
    .update(`${capture.url}|${capture.fetchedAt}|${payloadSha256}`)
    .digest("hex");
  return { captureId, payloadSha256 };
}

function sourceRange(data: unknown): { from: number | null; to: number | null; rowCount: number } {
  if (!Array.isArray(data)) return { from: null, to: null, rowCount: 1 };
  const timestamps = data
    .map((row) => (row && typeof row === "object" ? Number((row as { timestamp?: unknown }).timestamp) : Number.NaN))
    .filter(Number.isFinite);
  return {
    from: timestamps.length === 0 ? null : Math.min(...timestamps),
    to: timestamps.length === 0 ? null : Math.max(...timestamps),
    rowCount: data.length,
  };
}

export function buildCaptureManifest(input: {
  walletAddress: string;
  sampleRole: CaptureSampleRole;
  purpose: string;
  sourceVersion: SourceVersion;
  sources: CaptureManifestSource[];
}): CaptureManifest {
  if (input.sources.length === 0) throw new Error("Capture manifest requires at least one source");
  const items = input.sources.map((source) => {
    const identity = captureIdentity(source.capture);
    const range = sourceRange(source.capture.data);
    const base = {
      captureId: identity.captureId,
      endpoint: source.endpoint,
      requestUrl: source.capture.url,
      pageIndex: source.pageIndex ?? null,
      fetchedAt: source.capture.fetchedAt,
      sourceTimeFrom: range.from,
      sourceTimeTo: range.to,
      rowCount: range.rowCount,
      paginationStatus: source.paginationStatus,
      payloadSha256: identity.payloadSha256,
    };
    return {
      manifestItemId: createHash("sha256").update(stableJson(base)).digest("hex"),
      ...base,
    };
  });
  const endpointMap = new Map<string, CaptureManifest["endpointSummaries"][number]>();
  for (const item of items) {
    const current = endpointMap.get(item.endpoint) ?? {
      endpoint: item.endpoint,
      itemCount: 0,
      rowCount: 0,
      sourceTimeFrom: null,
      sourceTimeTo: null,
      paginationStatuses: [],
    };
    current.itemCount += 1;
    current.rowCount += item.rowCount;
    if (item.sourceTimeFrom !== null) current.sourceTimeFrom = current.sourceTimeFrom === null
      ? item.sourceTimeFrom
      : Math.min(current.sourceTimeFrom, item.sourceTimeFrom);
    if (item.sourceTimeTo !== null) current.sourceTimeTo = current.sourceTimeTo === null
      ? item.sourceTimeTo
      : Math.max(current.sourceTimeTo, item.sourceTimeTo);
    if (!current.paginationStatuses.includes(item.paginationStatus)) current.paginationStatuses.push(item.paginationStatus);
    endpointMap.set(item.endpoint, current);
  }
  const fetchedTimes = items.map((item) => Date.parse(item.fetchedAt));
  const body = {
    walletAddress: input.walletAddress.toLowerCase(),
    sampleRole: input.sampleRole,
    purpose: input.purpose,
    status: "COMPLETE" as const,
    startedAt: new Date(Math.min(...fetchedTimes)).toISOString(),
    completedAt: new Date(Math.max(...fetchedTimes)).toISOString(),
    sourceCodeCommit: input.sourceVersion.commit,
    sourceCodeDirty: input.sourceVersion.dirty,
    versions: VERSIONS,
    items,
    endpointSummaries: [...endpointMap.values()].sort((a, b) => a.endpoint.localeCompare(b.endpoint)),
  };
  const manifestHash = createHash("sha256").update(stableJson(body)).digest("hex");
  return {
    captureRunId: createHash("sha256")
      .update(`${body.walletAddress}|${body.startedAt}|${manifestHash}`)
      .digest("hex"),
    manifestHash,
    ...body,
  };
}
