import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { RULESET, stableJson } from "../domain/versioning.js";
import { decimalToScaled } from "../domain/fixed.js";
import {
  decodeCapturePayload,
  type CapturePayloadRow,
} from "../infra/sqlite/capture-payload.js";
import { captureIdentityFromResponseJson } from "../services/capture-manifest.js";
import type {
  PaperValidationScenario,
  ScenarioEvidence,
  SessionCoverage,
} from "./types.js";

export type ReplayValidationEvidenceSource = "REAL_SIGNAL_REPLAY" | "REAL_EXECUTION_REPLAY";

const SIGNAL_REPLAY_SCENARIOS = new Set<PaperValidationScenario>(["BUY", "SELL"]);
const EXECUTION_REPLAY_SCENARIOS = new Set<PaperValidationScenario>([
  "RISK_ALLOW",
  "ORDER",
  "FILL",
  "PARTIAL_FILL",
  "POSITION_UPDATE",
  "RESERVATION_RELEASE",
  "FEE",
  "REALIZED_PNL",
  "UNREALIZED_PNL",
]);

interface CaptureBinding {
  captureRunId: string;
  captureManifestHash: string;
  captureItemCount: number;
  captureItemSetHash: string;
  matchedCaptureId: string;
  matchedPayloadSha256: string;
  matchedPayloadRecordHash: string;
}

interface ReplayBinding {
  replayRunId: string;
  replayReportHash: string;
  replayRecordHash: string;
  replayClassificationHash: string;
}

interface SourceBinding {
  sourceEventKey: string;
  sourceEventHash: string;
  signalId: string;
  signalHash: string;
  signalType: "TARGET_BUY" | "TARGET_SELL";
  executionEligible: true;
}

interface ExecutionBinding {
  paperExecutionId: string;
  executionHash: string;
  riskDecisionHash: string;
  riskDecision: "ALLOW";
  paperOrderId: string | null;
  orderHash: string | null;
  orderState: string | null;
  orderbookSnapshotId: string;
  orderbookPayloadHash: string;
  orderbookRecordHash: string;
  orderbookPublicCaptureId: string;
  orderbookPublicCapturePayloadHash: string;
  orderbookPublicCaptureRecordHash: string;
  feeSnapshotId: string;
  feeSnapshotHash: string;
  feePublicCaptureId: string;
  feePublicCapturePayloadHash: string;
  feePublicCaptureRecordHash: string;
  fillCount: number;
  fillsHash: string;
  positionUpdateCount: number;
  positionUpdatesHash: string;
  reservationReleaseCount: number;
  reservationReleasesHash: string;
  feeEntryCount: number;
  feeEntriesHash: string;
  realizedPnlEntryCount: number;
  realizedPnlEntriesHash: string;
  unrealizedPnlSnapshotId: string | null;
  unrealizedPnlSnapshotHash: string | null;
}

export interface ReplayValidationEvidenceArtifact {
  artifactVersion: "paper-replay-evidence-v2";
  status: "PASSED";
  source: ReplayValidationEvidenceSource;
  coverage: PaperValidationScenario[];
  coreCompatibilityHash: string;
  sourceCodeCommit: string;
  generatedAt: string;
  capture: CaptureBinding;
  replay: ReplayBinding;
  sourceBinding: SourceBinding;
  execution: ExecutionBinding | null;
  artifactHash: string;
}

export interface BuildReplayValidationEvidenceInput {
  databasePath: string;
  source: ReplayValidationEvidenceSource;
  coverage: PaperValidationScenario[];
  coreCompatibilityHash: string;
  sourceCodeCommit: string;
  sourceEventKey: string;
  replayRunId: string;
  paperExecutionId?: string;
  paperOrderId?: string;
  unrealizedPnlSnapshotId?: string;
  generatedAt?: string;
}

type SqlValue = string | number | null;
type SqlRecord = Record<string, SqlValue>;

interface CaptureItemRow extends CapturePayloadRow {
  manifest_item_id: string;
  capture_id: string;
  source_endpoint: string;
  page_index: number | null;
  fetched_at: string;
  pagination_status: string;
  manifest_payload_sha256: string;
  capture_payload_sha256: string;
}

interface PublicCaptureRow extends CapturePayloadRow {
  capture_id: string;
  endpoint: string;
  request_url: string;
  fetched_at: string;
  latency_ms: number;
  http_status: number;
  schema_version: string;
}

interface PublicCaptureBinding {
  captureId: string;
  payloadSha256: string;
  recordHash: string;
  latencyMs: number;
}

type PublicMarketEndpoint = "clob-orderbook" | "clob-market-info" | "clob-fee-rate";
type PublicFeeEndpoint = Extract<PublicMarketEndpoint, "clob-market-info" | "clob-fee-rate">;

function sha256(value: unknown): string {
  return createHash("sha256").update(typeof value === "string" ? value : stableJson(value)).digest("hex");
}

function assertSha256(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`REPLAY_EVIDENCE_${label}_INVALID`);
}

function parseIso(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`REPLAY_EVIDENCE_${label}_INVALID`);
  return parsed;
}

function orderbookSourceTime(value: unknown): string {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) throw new Error("REPLAY_EVIDENCE_PUBLIC_ORDERBOOK_TIME_INVALID");
  return new Date(numeric < 1_000_000_000_000 ? numeric * 1_000 : numeric).toISOString();
}

function objectPayload(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`REPLAY_EVIDENCE_${label}_PAYLOAD_INVALID`);
  }
  return value as Record<string, unknown>;
}

function officialClobUrl(
  value: string,
  endpoint: PublicMarketEndpoint,
  assetId: string,
  conditionId: string,
): boolean {
  const expected = endpoint === "clob-orderbook"
    ? `https://clob.polymarket.com/book?token_id=${encodeURIComponent(assetId)}`
    : endpoint === "clob-fee-rate"
      ? `https://clob.polymarket.com/fee-rate?token_id=${encodeURIComponent(assetId)}`
      : `https://clob.polymarket.com/clob-markets/${encodeURIComponent(conditionId)}`;
  return value === expected;
}

function feeEndpointFromSourceUrl(
  value: string,
  assetId: string,
  conditionId: string,
): PublicFeeEndpoint {
  if (officialClobUrl(value, "clob-fee-rate", assetId, conditionId)) return "clob-fee-rate";
  if (officialClobUrl(value, "clob-market-info", assetId, conditionId)) return "clob-market-info";
  throw new Error("REPLAY_EVIDENCE_PUBLIC_MARKET_CAPTURE_SOURCE_INVALID");
}

function publicMarketCaptureBinding(input: {
  database: DatabaseSync;
  captureId: string | null;
  endpoint: PublicMarketEndpoint;
  requestUrl: string;
  fetchedAt: string;
  assetId: string;
  conditionId: string;
  book?: SqlRecord;
  fee?: SqlRecord;
}): PublicCaptureBinding {
  if (!officialClobUrl(input.requestUrl, input.endpoint, input.assetId, input.conditionId)) {
    throw new Error("REPLAY_EVIDENCE_PUBLIC_MARKET_CAPTURE_SOURCE_INVALID");
  }
  if (!input.captureId) {
    throw new Error("REPLAY_EVIDENCE_PUBLIC_MARKET_CAPTURE_BINDING_MISSING");
  }
  const captures = input.database.prepare(
    `SELECT c.capture_id,c.endpoint,c.request_url,c.fetched_at,c.latency_ms,c.http_status,
            c.payload_sha256,c.response_json,c.response_encoding,c.schema_version,
            p.payload_blob,p.uncompressed_bytes
     FROM api_captures c
     LEFT JOIN api_capture_payloads p ON p.payload_sha256=c.payload_sha256
     WHERE c.capture_id=? AND c.endpoint=? AND c.request_url=? AND c.fetched_at=?
     ORDER BY c.capture_id`,
  ).all(input.captureId, input.endpoint, input.requestUrl, input.fetchedAt) as unknown as PublicCaptureRow[];
  if (captures.length !== 1) {
    throw new Error("REPLAY_EVIDENCE_PUBLIC_MARKET_CAPTURE_MISSING_OR_AMBIGUOUS");
  }
  const capture = captures[0]!;
  if (
    capture.http_status !== 200
    || !Number.isFinite(capture.latency_ms)
    || capture.latency_ms < 0
    || capture.response_encoding !== "GZIP_SHA256"
  ) {
    throw new Error("REPLAY_EVIDENCE_PUBLIC_MARKET_CAPTURE_METADATA_INVALID");
  }
  const payload = decodeCapturePayload(capture);
  const responseJson = JSON.stringify(payload);
  const identity = captureIdentityFromResponseJson(capture.request_url, capture.fetched_at, responseJson);
  if (identity.captureId !== capture.capture_id || identity.payloadSha256 !== capture.payload_sha256) {
    throw new Error("REPLAY_EVIDENCE_PUBLIC_MARKET_CAPTURE_IDENTITY_INVALID");
  }
  const raw = objectPayload(payload, "PUBLIC_MARKET_CAPTURE");
  if (input.endpoint === "clob-orderbook") {
    const book = input.book!;
    if (
      raw.asset_id !== input.assetId
      || String(raw.market).toLowerCase() !== input.conditionId.toLowerCase()
      || orderbookSourceTime(raw.timestamp) !== book.market_snapshot_time
      || stableJson(raw.bids) !== stableJson(JSON.parse(String(book.bids_json)) as unknown)
      || stableJson(raw.asks) !== stableJson(JSON.parse(String(book.asks_json)) as unknown)
      || (raw.min_order_size === undefined ? null : String(raw.min_order_size)) !== book.min_order_size
      || (raw.tick_size === undefined ? null : String(raw.tick_size)) !== book.tick_size
    ) {
      throw new Error("REPLAY_EVIDENCE_PUBLIC_ORDERBOOK_CAPTURE_MISMATCH");
    }
  } else if (input.endpoint === "clob-market-info") {
    const fee = input.fee!;
    const tokens = Array.isArray(raw.t) ? raw.t : [];
    if (!tokens.some((token) => token && typeof token === "object" && (token as { t?: unknown }).t === input.assetId)) {
      throw new Error("REPLAY_EVIDENCE_PUBLIC_FEE_CAPTURE_ASSET_MISMATCH");
    }
    const baseFee = Number(raw.tbf);
    const detail = raw.fd && typeof raw.fd === "object" && !Array.isArray(raw.fd)
      ? raw.fd as Record<string, unknown>
      : null;
    const exponent = detail ? Number(detail.e) : 1;
    let feeRatePpm: string | null = null;
    try {
      feeRatePpm = detail
        ? decimalToScaled(String(detail.r), 6).toString()
        : baseFee === 0 ? "0" : null;
    } catch {
      feeRatePpm = null;
    }
    if (
      !Number.isSafeInteger(baseFee)
      || baseFee < 0
      || !Number.isSafeInteger(exponent)
      || exponent < 1
      || exponent > 4
      || feeRatePpm === null
      || baseFee !== fee.base_fee
      || exponent !== fee.fee_exponent
      || feeRatePpm !== fee.fee_rate_ppm
    ) {
      throw new Error("REPLAY_EVIDENCE_PUBLIC_FEE_CAPTURE_MISMATCH");
    }
  } else {
    const fee = input.fee!;
    const keys = Object.keys(raw).sort();
    if (
      keys.length !== 1
      || keys[0] !== "base_fee"
      || typeof raw.base_fee !== "number"
      || raw.base_fee !== 0
      || fee.base_fee !== 0
      || fee.fee_rate_ppm !== "0"
      || fee.fee_exponent !== 1
      || fee.status !== "AVAILABLE"
    ) {
      throw new Error("REPLAY_EVIDENCE_PUBLIC_FEE_CAPTURE_MISMATCH");
    }
  }
  return {
    captureId: capture.capture_id,
    payloadSha256: capture.payload_sha256,
    latencyMs: capture.latency_ms,
    recordHash: sha256({
      captureId: capture.capture_id,
      endpoint: capture.endpoint,
      requestUrl: capture.request_url,
      fetchedAt: capture.fetched_at,
      latencyMs: capture.latency_ms,
      httpStatus: capture.http_status,
      payloadSha256: capture.payload_sha256,
      schemaVersion: capture.schema_version,
      responseEncoding: capture.response_encoding,
    }),
  };
}

function row(database: DatabaseSync, sql: string, values: SqlValue[], label: string): SqlRecord {
  const result = database.prepare(sql).get(...values) as SqlRecord | undefined;
  if (!result) throw new Error(`REPLAY_EVIDENCE_${label}_MISSING`);
  return result;
}

function rows(database: DatabaseSync, sql: string, values: SqlValue[] = []): SqlRecord[] {
  return database.prepare(sql).all(...values) as SqlRecord[];
}

function sortedUniqueCoverage(
  source: ReplayValidationEvidenceSource,
  coverage: readonly PaperValidationScenario[],
): PaperValidationScenario[] {
  if (coverage.length === 0) throw new Error("REPLAY_EVIDENCE_COVERAGE_EMPTY");
  const unique = [...new Set(coverage)].sort();
  if (unique.length !== coverage.length) throw new Error("REPLAY_EVIDENCE_COVERAGE_DUPLICATED");
  const allowed = source === "REAL_SIGNAL_REPLAY" ? SIGNAL_REPLAY_SCENARIOS : EXECUTION_REPLAY_SCENARIOS;
  for (const scenario of unique) {
    if (!allowed.has(scenario)) throw new Error(`REPLAY_EVIDENCE_SCENARIO_NOT_ALLOWED:${source}:${scenario}`);
  }
  return unique;
}

function payloadRows(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object") {
    const object = payload as Record<string, unknown>;
    for (const key of ["data", "trades", "activity", "results"]) {
      if (Array.isArray(object[key])) return object[key] as unknown[];
    }
  }
  return [payload];
}

function captureBinding(
  database: DatabaseSync,
  captureRunId: string,
  targetId: string,
  rawJson: string,
): CaptureBinding {
  const run = row(
    database,
    `SELECT capture_run_id,target_id,status,manifest_hash,item_count
     FROM capture_runs WHERE capture_run_id=?`,
    [captureRunId],
    "CAPTURE_RUN",
  );
  if (run.target_id !== targetId) throw new Error("REPLAY_EVIDENCE_CAPTURE_TARGET_MISMATCH");
  if (run.status !== "COMPLETE") throw new Error("REPLAY_EVIDENCE_CAPTURE_NOT_COMPLETE");
  if (typeof run.manifest_hash !== "string") throw new Error("REPLAY_EVIDENCE_CAPTURE_MANIFEST_HASH_MISSING");
  assertSha256(run.manifest_hash, "CAPTURE_MANIFEST_HASH");

  const items = database.prepare(
    `SELECT i.manifest_item_id,i.capture_id,i.source_endpoint,i.page_index,i.fetched_at,
            i.pagination_status,i.payload_sha256 manifest_payload_sha256,
            c.payload_sha256 capture_payload_sha256,c.response_json,c.response_encoding,
            p.payload_blob,p.uncompressed_bytes
     FROM capture_manifest_items i
     JOIN api_captures c ON c.capture_id=i.capture_id
     LEFT JOIN api_capture_payloads p ON p.payload_sha256=c.payload_sha256
     WHERE i.capture_run_id=?
     ORDER BY i.source_endpoint,coalesce(i.page_index,0),i.fetched_at,i.manifest_item_id`,
  ).all(captureRunId) as unknown as CaptureItemRow[];
  if (items.length !== Number(run.item_count) || items.length === 0) {
    throw new Error("REPLAY_EVIDENCE_CAPTURE_ITEM_COUNT_MISMATCH");
  }
  const wanted = stableJson(JSON.parse(rawJson) as unknown);
  let matched: { item: CaptureItemRow; recordHash: string } | null = null;
  const itemEvidence: Array<Record<string, SqlValue>> = [];
  for (const item of items) {
    if (item.manifest_payload_sha256 !== item.capture_payload_sha256) {
      throw new Error("REPLAY_EVIDENCE_CAPTURE_PAYLOAD_HASH_MISMATCH");
    }
    const payload = decodeCapturePayload({
      payload_sha256: item.capture_payload_sha256,
      response_json: item.response_json,
      response_encoding: item.response_encoding,
      payload_blob: item.payload_blob,
      uncompressed_bytes: item.uncompressed_bytes,
    });
    itemEvidence.push({
      manifestItemId: item.manifest_item_id,
      captureId: item.capture_id,
      endpoint: item.source_endpoint,
      pageIndex: item.page_index,
      fetchedAt: item.fetched_at,
      paginationStatus: item.pagination_status,
      payloadSha256: item.capture_payload_sha256,
    });
    if (!matched) {
      const payloadRecord = payloadRows(payload).find((candidate) => stableJson(candidate) === wanted);
      if (payloadRecord !== undefined) matched = { item, recordHash: sha256(payloadRecord) };
    }
  }
  if (!matched) throw new Error("REPLAY_EVIDENCE_SOURCE_EVENT_NOT_IN_CAPTURE_PAYLOAD");
  return {
    captureRunId,
    captureManifestHash: run.manifest_hash,
    captureItemCount: items.length,
    captureItemSetHash: sha256(itemEvidence),
    matchedCaptureId: matched.item.capture_id,
    matchedPayloadSha256: matched.item.capture_payload_sha256,
    matchedPayloadRecordHash: matched.recordHash,
  };
}

function assertScenarioFacts(
  source: ReplayValidationEvidenceSource,
  coverage: readonly PaperValidationScenario[],
  signal: SourceBinding,
  execution: ExecutionBinding | null,
): void {
  if (source === "REAL_SIGNAL_REPLAY") {
    if (execution !== null) throw new Error("REPLAY_EVIDENCE_SIGNAL_SOURCE_HAS_EXECUTION");
    if (coverage.includes("BUY") !== (signal.signalType === "TARGET_BUY")) {
      throw new Error("REPLAY_EVIDENCE_BUY_SIGNAL_MISMATCH");
    }
    if (coverage.includes("SELL") !== (signal.signalType === "TARGET_SELL")) {
      throw new Error("REPLAY_EVIDENCE_SELL_SIGNAL_MISMATCH");
    }
    return;
  }
  if (!execution) throw new Error("REPLAY_EVIDENCE_EXECUTION_BINDING_MISSING");
  if (coverage.includes("RISK_ALLOW") && execution.riskDecision !== "ALLOW") {
    throw new Error("REPLAY_EVIDENCE_RISK_ALLOW_NOT_PROVEN");
  }
  if (coverage.includes("ORDER") && execution.paperOrderId === null) {
    throw new Error("REPLAY_EVIDENCE_ORDER_NOT_PROVEN");
  }
  if (coverage.includes("FILL") && execution.fillCount <= 0) {
    throw new Error("REPLAY_EVIDENCE_FILL_NOT_PROVEN");
  }
  if (coverage.includes("PARTIAL_FILL") && execution.orderState !== "PARTIALLY_FILLED") {
    throw new Error("REPLAY_EVIDENCE_PARTIAL_FILL_NOT_PROVEN");
  }
  if (coverage.includes("POSITION_UPDATE") && execution.positionUpdateCount <= 0) {
    throw new Error("REPLAY_EVIDENCE_POSITION_UPDATE_NOT_PROVEN");
  }
  if (coverage.includes("RESERVATION_RELEASE") && execution.reservationReleaseCount <= 0) {
    throw new Error("REPLAY_EVIDENCE_RESERVATION_RELEASE_NOT_PROVEN");
  }
  if (coverage.includes("FEE") && execution.feeEntryCount <= 0) {
    throw new Error("REPLAY_EVIDENCE_FEE_NOT_PROVEN");
  }
  if (coverage.includes("REALIZED_PNL") && execution.realizedPnlEntryCount <= 0) {
    throw new Error("REPLAY_EVIDENCE_REALIZED_PNL_NOT_PROVEN");
  }
  if (coverage.includes("UNREALIZED_PNL") && execution.unrealizedPnlSnapshotId === null) {
    throw new Error("REPLAY_EVIDENCE_UNREALIZED_PNL_NOT_PROVEN");
  }
}

function buildExecutionBinding(input: {
  database: DatabaseSync;
  paperExecutionId: string;
  paperOrderId?: string;
  unrealizedPnlSnapshotId?: string;
  signalId: string;
  sourceCodeCommit: string;
  targetTradeTimestamp: string;
  marketEndTime: string;
  marketEndTimeStatus: "VERIFIED" | "UNAVAILABLE";
  executionDeadlineAt: string | null;
}): ExecutionBinding {
  const execution = row(
    input.database,
    "SELECT * FROM paper_executions WHERE paper_execution_id=?",
    [input.paperExecutionId],
    "PAPER_EXECUTION",
  );
  if (execution.signal_id !== input.signalId) throw new Error("REPLAY_EVIDENCE_EXECUTION_SIGNAL_MISMATCH");
  if (execution.source_code_commit !== input.sourceCodeCommit || execution.source_code_dirty !== 0) {
    throw new Error("REPLAY_EVIDENCE_EXECUTION_SOURCE_VERSION_MISMATCH");
  }
  if (typeof execution.deadline_at !== "string") {
    throw new Error("REPLAY_EVIDENCE_EXECUTION_DEADLINE_MISSING");
  }
  if (typeof execution.risk_decision_id !== "string") throw new Error("REPLAY_EVIDENCE_RISK_DECISION_MISSING");
  const risk = row(
    input.database,
    "SELECT * FROM risk_decisions WHERE risk_decision_id=?",
    [execution.risk_decision_id],
    "RISK_DECISION",
  );
  if (
    risk.decision !== "ALLOW"
    || risk.signal_id !== input.signalId
    || risk.context_id !== execution.context_id
    || risk.paper_account_id !== execution.paper_account_id
    || risk.account_id !== execution.paper_account_id
    || risk.source_code_commit !== input.sourceCodeCommit
    || risk.source_code_dirty !== 0
  ) {
    throw new Error("REPLAY_EVIDENCE_RISK_DECISION_INVALID");
  }

  const order = input.paperOrderId
    ? row(
      input.database,
      "SELECT * FROM paper_orders WHERE paper_order_id=?",
      [input.paperOrderId],
      "PAPER_ORDER",
    )
    : null;
  if (order && order.paper_execution_id !== input.paperExecutionId) {
    throw new Error("REPLAY_EVIDENCE_ORDER_EXECUTION_MISMATCH");
  }

  const unrealized = input.unrealizedPnlSnapshotId
    ? row(
      input.database,
      `SELECT u.*,p.opening_execution_id
       FROM paper_unrealized_pnl_snapshots u
       JOIN paper_positions p ON p.paper_position_id=u.paper_position_id
       WHERE u.unrealized_pnl_snapshot_id=?`,
      [input.unrealizedPnlSnapshotId],
      "UNREALIZED_PNL_SNAPSHOT",
    )
    : null;
  if (unrealized && unrealized.opening_execution_id !== input.paperExecutionId) {
    throw new Error("REPLAY_EVIDENCE_UNREALIZED_EXECUTION_MISMATCH");
  }
  const orderbookSnapshotId = (order?.orderbook_snapshot_id ?? unrealized?.orderbook_snapshot_id) as string | undefined;
  const feeSnapshotId = (order?.fee_snapshot_id ?? unrealized?.fee_snapshot_id) as string | undefined;
  if (!orderbookSnapshotId || !feeSnapshotId) {
    throw new Error("REPLAY_EVIDENCE_MARKET_SNAPSHOT_BINDING_MISSING");
  }
  const book = row(
    input.database,
    "SELECT * FROM paper_orderbook_snapshots WHERE orderbook_snapshot_id=?",
    [orderbookSnapshotId],
    "ORDERBOOK_SNAPSHOT",
  );
  const fee = row(
    input.database,
    "SELECT * FROM paper_fee_snapshots WHERE fee_snapshot_id=?",
    [feeSnapshotId],
    "FEE_SNAPSHOT",
  );
  if (book.asset_id !== execution.asset_id || book.condition_id !== execution.condition_id) {
    throw new Error("REPLAY_EVIDENCE_ORDERBOOK_MARKET_MISMATCH");
  }
  if (fee.asset_id !== execution.asset_id || fee.status !== "AVAILABLE") {
    throw new Error("REPLAY_EVIDENCE_FEE_SNAPSHOT_INVALID");
  }
  const orderbookPublicCapture = publicMarketCaptureBinding({
    database: input.database,
    captureId: typeof book.source_capture_id === "string" ? book.source_capture_id : null,
    endpoint: "clob-orderbook",
    requestUrl: String(book.source_url),
    fetchedAt: String(book.received_at),
    assetId: String(execution.asset_id),
    conditionId: String(execution.condition_id),
    book,
  });
  const feePublicCapture = publicMarketCaptureBinding({
    database: input.database,
    captureId: typeof fee.source_capture_id === "string" ? fee.source_capture_id : null,
    endpoint: feeEndpointFromSourceUrl(
      String(fee.source_url),
      String(execution.asset_id),
      String(execution.condition_id),
    ),
    requestUrl: String(fee.source_url),
    fetchedAt: String(fee.snapshot_time),
    assetId: String(execution.asset_id),
    conditionId: String(execution.condition_id),
    fee,
  });
  const bookPayload = {
    bids: JSON.parse(String(book.bids_json)) as unknown,
    asks: JSON.parse(String(book.asks_json)) as unknown,
    minOrderSize: book.min_order_size,
    tickSize: book.tick_size,
  };
  const calculatedBookPayloadHash = sha256(bookPayload);
  if (book.payload_hash !== calculatedBookPayloadHash) {
    throw new Error("REPLAY_EVIDENCE_ORDERBOOK_PAYLOAD_HASH_MISMATCH");
  }
  const age = Number(book.data_age_ms);
  if (
    !Number.isSafeInteger(age)
    || age < Math.ceil(orderbookPublicCapture.latencyMs)
    || age > RULESET.orderbookMaxAgeMs
  ) {
    throw new Error("REPLAY_EVIDENCE_ORDERBOOK_STALE");
  }
  const targetTime = parseIso(input.targetTradeTimestamp, "TARGET_TRADE_TIME");
  const deadline = parseIso(execution.deadline_at, "EXECUTION_DEADLINE");
  const contextDeadline = input.executionDeadlineAt === null
    ? deadline
    : parseIso(input.executionDeadlineAt, "CONTEXT_EXECUTION_DEADLINE");
  if (deadline !== contextDeadline) {
    throw new Error("REPLAY_EVIDENCE_EXECUTION_DEADLINE_CONTEXT_MISMATCH");
  }
  const deadlineOutsideWindow = input.marketEndTimeStatus === "VERIFIED"
    ? deadline > parseIso(input.marketEndTime, "MARKET_END_TIME")
    : input.marketEndTime !== "" || deadline - targetTime > RULESET.maxWaitMs;
  if (deadline < targetTime || deadlineOutsideWindow) {
    throw new Error("REPLAY_EVIDENCE_EXECUTION_DEADLINE_OUTSIDE_MARKET_WINDOW");
  }
  const bookTime = parseIso(String(book.market_snapshot_time), "ORDERBOOK_TIME");
  const bookReceivedAt = parseIso(String(book.received_at), "ORDERBOOK_RECEIVED_AT");
  const feeTime = parseIso(String(fee.snapshot_time), "FEE_SNAPSHOT_TIME");
  if (bookTime > deadline) {
    throw new Error("REPLAY_EVIDENCE_ORDERBOOK_OUTSIDE_EXECUTION_WINDOW");
  }
  if (bookReceivedAt < targetTime || bookReceivedAt > deadline) {
    throw new Error("REPLAY_EVIDENCE_ORDERBOOK_CAPTURE_OUTSIDE_EXECUTION_WINDOW");
  }
  if (feeTime < targetTime - RULESET.orderbookMaxAgeMs || feeTime > deadline) {
    throw new Error("REPLAY_EVIDENCE_FEE_SNAPSHOT_OUTSIDE_EXECUTION_WINDOW");
  }
  if (order) {
    const orderTime = parseIso(String(order.created_at), "ORDER_TIME");
    if (orderTime < targetTime || orderTime > deadline) {
      throw new Error("REPLAY_EVIDENCE_ORDER_OUTSIDE_EXECUTION_WINDOW");
    }
    if (
      orderTime < bookTime
      || orderTime < bookReceivedAt
      || orderTime - bookReceivedAt + orderbookPublicCapture.latencyMs > RULESET.orderbookMaxAgeMs
    ) {
      throw new Error("REPLAY_EVIDENCE_ORDERBOOK_STALE_AT_ORDER_TIME");
    }
    if (orderTime < feeTime || orderTime - feeTime > RULESET.orderbookMaxAgeMs) {
      throw new Error("REPLAY_EVIDENCE_FEE_SNAPSHOT_STALE_AT_ORDER_TIME");
    }
  }

  const fills = order
    ? rows(
      input.database,
      `SELECT * FROM paper_fill_ledger WHERE paper_execution_id=? AND paper_order_id=?
       ORDER BY level_sequence,fill_id`,
      [input.paperExecutionId, String(order.paper_order_id)],
    )
    : [];
  if (order) {
    const filledSize = fills.reduce((sum, fill) => sum + BigInt(String(fill.size_micros)), 0n);
    const filledNotional = fills.reduce((sum, fill) => sum + BigInt(String(fill.notional_micros)), 0n);
    const filledFee = fills.reduce((sum, fill) => sum + BigInt(String(fill.fee_micros)), 0n);
    if (
      filledSize !== BigInt(String(order.filled_size_micros))
      || filledNotional !== BigInt(String(order.filled_notional_micros))
      || filledFee !== BigInt(String(order.fee_micros))
    ) {
      throw new Error("REPLAY_EVIDENCE_ORDER_FILL_TOTAL_MISMATCH");
    }
  }
  const positionUpdates = rows(
    input.database,
    `SELECT * FROM paper_execution_positions WHERE paper_execution_id=?
     ORDER BY paper_position_id`,
    [input.paperExecutionId],
  );
  const reservationReleases = rows(
    input.database,
    `SELECT * FROM paper_reservation_ledger
     WHERE paper_execution_id=? AND entry_type='RELEASE'
     ORDER BY created_at,reservation_ledger_id`,
    [input.paperExecutionId],
  );
  const feeEntries = rows(
    input.database,
    `SELECT * FROM paper_fee_ledger WHERE paper_execution_id=?
     ORDER BY created_at,fee_ledger_id`,
    [input.paperExecutionId],
  );
  if (order && feeEntries.some((entry) => entry.fee_snapshot_id !== feeSnapshotId)) {
    throw new Error("REPLAY_EVIDENCE_FEE_LEDGER_SNAPSHOT_MISMATCH");
  }
  const realizedPnl = rows(
    input.database,
    `SELECT * FROM paper_pnl_ledger WHERE paper_execution_id=?
     ORDER BY created_at,pnl_ledger_id`,
    [input.paperExecutionId],
  );

  return {
    paperExecutionId: input.paperExecutionId,
    executionHash: sha256(execution),
    riskDecisionHash: sha256(risk),
    riskDecision: "ALLOW",
    paperOrderId: order ? String(order.paper_order_id) : null,
    orderHash: order ? sha256(order) : null,
    orderState: order ? String(order.state) : null,
    orderbookSnapshotId,
    orderbookPayloadHash: calculatedBookPayloadHash,
    orderbookRecordHash: sha256(book),
    orderbookPublicCaptureId: orderbookPublicCapture.captureId,
    orderbookPublicCapturePayloadHash: orderbookPublicCapture.payloadSha256,
    orderbookPublicCaptureRecordHash: orderbookPublicCapture.recordHash,
    feeSnapshotId,
    feeSnapshotHash: sha256(fee),
    feePublicCaptureId: feePublicCapture.captureId,
    feePublicCapturePayloadHash: feePublicCapture.payloadSha256,
    feePublicCaptureRecordHash: feePublicCapture.recordHash,
    fillCount: fills.length,
    fillsHash: sha256(fills),
    positionUpdateCount: positionUpdates.length,
    positionUpdatesHash: sha256(positionUpdates),
    reservationReleaseCount: reservationReleases.length,
    reservationReleasesHash: sha256(reservationReleases),
    feeEntryCount: feeEntries.length,
    feeEntriesHash: sha256(feeEntries),
    realizedPnlEntryCount: realizedPnl.length,
    realizedPnlEntriesHash: sha256(realizedPnl),
    unrealizedPnlSnapshotId: unrealized ? String(unrealized.unrealized_pnl_snapshot_id) : null,
    unrealizedPnlSnapshotHash: unrealized ? sha256(unrealized) : null,
  };
}

export function buildReplayValidationEvidenceArtifact(
  input: BuildReplayValidationEvidenceInput,
): ReplayValidationEvidenceArtifact {
  assertSha256(input.coreCompatibilityHash, "CORE_COMPATIBILITY_HASH");
  if (!input.sourceCodeCommit.trim()) throw new Error("REPLAY_EVIDENCE_SOURCE_COMMIT_MISSING");
  const coverage = sortedUniqueCoverage(input.source, input.coverage);
  const database = new DatabaseSync(input.databasePath, { readOnly: true });
  database.exec("PRAGMA query_only=ON; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
  try {
    const integrity = row(database, "PRAGMA integrity_check", [], "DATABASE_INTEGRITY");
    if (integrity.integrity_check !== "ok" || database.prepare("PRAGMA foreign_key_check").all().length !== 0) {
      throw new Error("REPLAY_EVIDENCE_DATABASE_INTEGRITY_FAILED");
    }
    const event = row(
      database,
      "SELECT * FROM raw_events WHERE source_event_key=?",
      [input.sourceEventKey],
      "SOURCE_EVENT",
    );
    if (event.gap_event !== 0 || event.is_combo !== 0 || event.event_classification !== "STANDARD_TRADE") {
      throw new Error("REPLAY_EVIDENCE_SOURCE_EVENT_NOT_EXECUTABLE_STANDARD_TRADE");
    }
    if (typeof event.capture_run_id !== "string") throw new Error("REPLAY_EVIDENCE_SOURCE_CAPTURE_MISSING");
    const capture = captureBinding(
      database,
      event.capture_run_id,
      String(event.target_id),
      String(event.raw_json),
    );
    const replay = row(
      database,
      "SELECT * FROM replay_runs WHERE replay_run_id=?",
      [input.replayRunId],
      "REPLAY_RUN",
    );
    if (
      replay.status !== "PASSED"
      || replay.capture_run_id !== event.capture_run_id
      || replay.target_id !== event.target_id
      || replay.source_code_commit !== input.sourceCodeCommit
      || replay.source_code_dirty !== 0
    ) {
      throw new Error("REPLAY_EVIDENCE_REPLAY_BINDING_INVALID");
    }
    const classification = row(
      database,
      `SELECT * FROM replay_event_classifications
       WHERE replay_run_id=? AND source_event_key=?`,
      [input.replayRunId, input.sourceEventKey],
      "REPLAY_CLASSIFICATION",
    );
    if (classification.execution_eligible !== 1 || typeof classification.signal_id !== "string") {
      throw new Error("REPLAY_EVIDENCE_REPLAY_CLASSIFICATION_INELIGIBLE");
    }
    const signalId = String(classification.signal_id);
    const signal = row(
      database,
      "SELECT * FROM signals WHERE signal_id=?",
      [signalId],
      "SIGNAL",
    );
    if (
      signal.source_event_key !== input.sourceEventKey
      || signal.target_id !== event.target_id
      || signal.capture_run_id !== event.capture_run_id
      || signal.status !== "PUBLISHED"
      || signal.execution_eligible !== 1
      || signal.source_code_commit !== input.sourceCodeCommit
      || signal.source_code_dirty !== 0
      || !["TARGET_BUY", "TARGET_SELL"].includes(String(signal.signal_type))
    ) {
      throw new Error("REPLAY_EVIDENCE_SIGNAL_BINDING_INVALID");
    }
    const context = input.source === "REAL_EXECUTION_REPLAY"
      ? row(
        database,
        "SELECT * FROM signal_execution_contexts WHERE signal_id=?",
        [String(signal.signal_id)],
        "EXECUTION_CONTEXT",
      )
      : null;
    if (context && (
      context.target_id !== signal.target_id
      || context.source_code_commit !== input.sourceCodeCommit
      || context.source_code_dirty !== 0
    )) {
      throw new Error("REPLAY_EVIDENCE_CONTEXT_SOURCE_VERSION_MISMATCH");
    }
    const sourceBinding: SourceBinding = {
      sourceEventKey: input.sourceEventKey,
      sourceEventHash: sha256(event),
      signalId: String(signal.signal_id),
      signalHash: sha256(signal),
      signalType: signal.signal_type as "TARGET_BUY" | "TARGET_SELL",
      executionEligible: true,
    };
    const execution = input.source === "REAL_EXECUTION_REPLAY"
      ? buildExecutionBinding({
        database,
        paperExecutionId: input.paperExecutionId
          ?? (() => { throw new Error("REPLAY_EVIDENCE_EXECUTION_ID_MISSING"); })(),
        ...(input.paperOrderId === undefined ? {} : { paperOrderId: input.paperOrderId }),
        ...(input.unrealizedPnlSnapshotId === undefined
          ? {}
          : { unrealizedPnlSnapshotId: input.unrealizedPnlSnapshotId }),
        signalId: sourceBinding.signalId,
        sourceCodeCommit: input.sourceCodeCommit,
        targetTradeTimestamp: String(context?.target_trade_timestamp),
        marketEndTime: String(context?.market_end_time),
        marketEndTimeStatus: context?.market_end_time_status === "UNAVAILABLE" ? "UNAVAILABLE" : "VERIFIED",
        executionDeadlineAt: typeof context?.execution_deadline_at === "string"
          ? context.execution_deadline_at
          : null,
      })
      : null;
    assertScenarioFacts(input.source, coverage, sourceBinding, execution);
    const payload = {
      artifactVersion: "paper-replay-evidence-v2" as const,
      status: "PASSED" as const,
      source: input.source,
      coverage,
      coreCompatibilityHash: input.coreCompatibilityHash,
      sourceCodeCommit: input.sourceCodeCommit,
      generatedAt: input.generatedAt ?? new Date().toISOString(),
      capture,
      replay: {
        replayRunId: input.replayRunId,
        replayReportHash: String(replay.report_hash),
        replayRecordHash: sha256(replay),
        replayClassificationHash: sha256(classification),
      },
      sourceBinding,
      execution,
    };
    assertSha256(payload.replay.replayReportHash, "REPLAY_REPORT_HASH");
    return { ...payload, artifactHash: sha256(payload) };
  } finally {
    database.close();
  }
}

export function assertReplayValidationEvidenceArtifact(
  artifact: ReplayValidationEvidenceArtifact,
  expectedCoreCompatibilityHash: string,
  expectedSourceCodeCommit: string,
): void {
  if (artifact.artifactVersion !== "paper-replay-evidence-v2" || artifact.status !== "PASSED") {
    throw new Error("REPLAY_EVIDENCE_ARTIFACT_VERSION_OR_STATUS_INVALID");
  }
  parseIso(artifact.generatedAt, "GENERATED_AT");
  if (artifact.coreCompatibilityHash !== expectedCoreCompatibilityHash) {
    throw new Error("REPLAY_EVIDENCE_CORE_COMPATIBILITY_MISMATCH");
  }
  if (artifact.sourceCodeCommit !== expectedSourceCodeCommit) {
    throw new Error("REPLAY_EVIDENCE_SOURCE_COMMIT_MISMATCH");
  }
  const coverage = sortedUniqueCoverage(artifact.source, artifact.coverage);
  if (stableJson(coverage) !== stableJson(artifact.coverage)) {
    throw new Error("REPLAY_EVIDENCE_COVERAGE_NOT_CANONICAL");
  }
  assertSha256(artifact.capture.captureManifestHash, "CAPTURE_MANIFEST_HASH");
  assertSha256(artifact.capture.captureItemSetHash, "CAPTURE_ITEM_SET_HASH");
  assertSha256(artifact.capture.matchedPayloadSha256, "CAPTURE_PAYLOAD_HASH");
  assertSha256(artifact.capture.matchedPayloadRecordHash, "CAPTURE_RECORD_HASH");
  assertSha256(artifact.replay.replayReportHash, "REPLAY_REPORT_HASH");
  assertSha256(artifact.replay.replayRecordHash, "REPLAY_RECORD_HASH");
  assertSha256(artifact.replay.replayClassificationHash, "REPLAY_CLASSIFICATION_HASH");
  assertSha256(artifact.sourceBinding.sourceEventHash, "SOURCE_EVENT_HASH");
  assertSha256(artifact.sourceBinding.signalHash, "SIGNAL_HASH");
  if (artifact.capture.captureItemCount <= 0 || !Number.isSafeInteger(artifact.capture.captureItemCount)) {
    throw new Error("REPLAY_EVIDENCE_CAPTURE_ITEM_COUNT_INVALID");
  }
  if (artifact.sourceBinding.executionEligible !== true) {
    throw new Error("REPLAY_EVIDENCE_SIGNAL_INELIGIBLE");
  }
  if (artifact.source === "REAL_EXECUTION_REPLAY") {
    if (!artifact.execution) throw new Error("REPLAY_EVIDENCE_EXECUTION_BINDING_MISSING");
    for (const [label, value] of Object.entries({
      EXECUTION_HASH: artifact.execution.executionHash,
      RISK_DECISION_HASH: artifact.execution.riskDecisionHash,
      ORDERBOOK_PAYLOAD_HASH: artifact.execution.orderbookPayloadHash,
      ORDERBOOK_RECORD_HASH: artifact.execution.orderbookRecordHash,
      ORDERBOOK_PUBLIC_CAPTURE_PAYLOAD_HASH: artifact.execution.orderbookPublicCapturePayloadHash,
      ORDERBOOK_PUBLIC_CAPTURE_RECORD_HASH: artifact.execution.orderbookPublicCaptureRecordHash,
      FEE_SNAPSHOT_HASH: artifact.execution.feeSnapshotHash,
      FEE_PUBLIC_CAPTURE_PAYLOAD_HASH: artifact.execution.feePublicCapturePayloadHash,
      FEE_PUBLIC_CAPTURE_RECORD_HASH: artifact.execution.feePublicCaptureRecordHash,
      FILLS_HASH: artifact.execution.fillsHash,
      POSITION_UPDATES_HASH: artifact.execution.positionUpdatesHash,
      RESERVATION_RELEASES_HASH: artifact.execution.reservationReleasesHash,
      FEE_ENTRIES_HASH: artifact.execution.feeEntriesHash,
      REALIZED_PNL_HASH: artifact.execution.realizedPnlEntriesHash,
    })) assertSha256(value, label);
    assertSha256(artifact.execution.orderbookPublicCaptureId, "ORDERBOOK_PUBLIC_CAPTURE_ID");
    assertSha256(artifact.execution.feePublicCaptureId, "FEE_PUBLIC_CAPTURE_ID");
    if (artifact.execution.paperOrderId === null && artifact.execution.unrealizedPnlSnapshotId === null) {
      throw new Error("REPLAY_EVIDENCE_MARKET_SNAPSHOT_PROVENANCE_MISSING");
    }
    if ((artifact.execution.orderHash === null) !== (artifact.execution.paperOrderId === null)) {
      throw new Error("REPLAY_EVIDENCE_ORDER_HASH_PAIR_INVALID");
    }
    if (artifact.execution.orderHash) assertSha256(artifact.execution.orderHash, "ORDER_HASH");
    if ((artifact.execution.unrealizedPnlSnapshotHash === null)
      !== (artifact.execution.unrealizedPnlSnapshotId === null)) {
      throw new Error("REPLAY_EVIDENCE_UNREALIZED_HASH_PAIR_INVALID");
    }
    if (artifact.execution.unrealizedPnlSnapshotHash) {
      assertSha256(artifact.execution.unrealizedPnlSnapshotHash, "UNREALIZED_PNL_HASH");
    }
  } else if (artifact.execution !== null) {
    throw new Error("REPLAY_EVIDENCE_SIGNAL_SOURCE_HAS_EXECUTION");
  }
  assertScenarioFacts(artifact.source, coverage, artifact.sourceBinding, artifact.execution);
  const { artifactHash, ...payload } = artifact;
  assertSha256(artifactHash, "ARTIFACT_HASH");
  if (artifactHash !== sha256(payload)) throw new Error("REPLAY_EVIDENCE_ARTIFACT_HASH_MISMATCH");
}

export function verifyReplayValidationEvidenceArtifact(
  artifact: ReplayValidationEvidenceArtifact,
  expectedCoreCompatibilityHash: string,
  expectedSourceCodeCommit: string,
): boolean {
  try {
    assertReplayValidationEvidenceArtifact(
      artifact,
      expectedCoreCompatibilityHash,
      expectedSourceCodeCommit,
    );
    return true;
  } catch {
    return false;
  }
}

export function assertReplayValidationEvidenceArtifactAgainstDatabase(
  artifact: ReplayValidationEvidenceArtifact,
  databasePath: string,
  expectedCoreCompatibilityHash: string,
  expectedSourceCodeCommit: string,
): void {
  assertReplayValidationEvidenceArtifact(
    artifact,
    expectedCoreCompatibilityHash,
    expectedSourceCodeCommit,
  );
  const rebuilt = buildReplayValidationEvidenceArtifact({
    databasePath,
    source: artifact.source,
    coverage: artifact.coverage,
    coreCompatibilityHash: expectedCoreCompatibilityHash,
    sourceCodeCommit: expectedSourceCodeCommit,
    sourceEventKey: artifact.sourceBinding.sourceEventKey,
    replayRunId: artifact.replay.replayRunId,
    ...(artifact.execution
      ? {
        paperExecutionId: artifact.execution.paperExecutionId,
        ...(artifact.execution.paperOrderId === null
          ? {}
          : { paperOrderId: artifact.execution.paperOrderId }),
        ...(artifact.execution.unrealizedPnlSnapshotId === null
          ? {}
          : { unrealizedPnlSnapshotId: artifact.execution.unrealizedPnlSnapshotId }),
      }
      : {}),
    generatedAt: artifact.generatedAt,
  });
  if (stableJson(rebuilt) !== stableJson(artifact)) {
    throw new Error("REPLAY_EVIDENCE_DATABASE_RECONSTRUCTION_MISMATCH");
  }
}

export function replayEvidenceCoverage(
  artifacts: readonly ReplayValidationEvidenceArtifact[],
): SessionCoverage {
  const coverage: SessionCoverage = {};
  for (const artifact of [...artifacts].sort((left, right) => left.artifactHash.localeCompare(right.artifactHash))) {
    for (const scenario of artifact.coverage) {
      if (coverage[scenario]) continue;
      const evidence: ScenarioEvidence = {
        covered: true,
        source: artifact.source,
        evidenceId: artifact.artifactHash,
        reason: artifact.source === "REAL_SIGNAL_REPLAY"
          ? "CAPTURE_BOUND_REAL_SIGNAL_REPLAY"
          : "ORDERBOOK_AND_FEE_BOUND_REAL_EXECUTION_REPLAY",
      };
      coverage[scenario] = evidence;
    }
  }
  return coverage;
}
