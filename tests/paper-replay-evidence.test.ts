import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { ApiCapture } from "../src/adapters/polymarket-public.js";
import type { PublicTrade } from "../src/domain/models.js";
import { RULESET_HASH, RULESET_SNAPSHOT_JSON, stableJson, VERSIONS } from "../src/domain/versioning.js";
import { Phase0Database } from "../src/infra/sqlite/database.js";
import { storeCompressedCapturePayload } from "../src/infra/sqlite/capture-payload.js";
import type { SourceVersion } from "../src/infra/source-version.js";
import {
  assertReplayValidationEvidenceArtifactAgainstDatabase,
  buildReplayValidationEvidenceArtifact,
  replayEvidenceCoverage,
  verifyReplayValidationEvidenceArtifact,
} from "../src/paper-validation/replay-evidence.js";
import { ReplayEngine } from "../src/replay/replay-engine.js";
import { buildCaptureManifest } from "../src/services/capture-manifest.js";
import { captureIdentityFromResponseJson } from "../src/services/capture-manifest.js";

const sourceVersion: SourceVersion = { commit: "real-replay-evidence-test", dirty: false };
const wallet = "0x0000000000000000000000000000000000000001";
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "ni-k-real-replay-evidence-"));
  directories.push(directory);
  const databasePath = join(directory, "phase0.sqlite");
  const database = new Phase0Database(databasePath, sourceVersion);
  database.initialize();
  const targetId = database.ensureTarget(wallet, "IDENTITY_CONFIRMED");
  const trade: PublicTrade = {
    proxyWallet: wallet,
    transactionHash: `0x${"1".repeat(64)}`,
    conditionId: `0x${"2".repeat(64)}`,
    asset: "asset-replay-1",
    side: "BUY",
    price: "0.5",
    size: "10",
    timestamp: Math.floor(Date.parse("2026-07-16T00:00:00.000Z") / 1_000),
  };
  const capture: ApiCapture<PublicTrade[]> = {
    url: `https://data-api.polymarket.com/trades?user=${wallet}`,
    fetchedAt: "2026-07-16T00:00:01.000Z",
    latencyMs: 10,
    status: 200,
    data: [trade],
  };
  database.saveCapture("data-trades", capture);
  const manifest = buildCaptureManifest({
    walletAddress: wallet,
    sampleRole: "TARGET",
    purpose: "REAL_REPLAY_EVIDENCE_TEST",
    sourceVersion,
    sources: [{ endpoint: "data-trades", capture, pageIndex: 0, paginationStatus: "END_OF_DATA" }],
  });
  database.saveCaptureManifest(targetId, manifest);
  const report = new ReplayEngine().run({
    walletAddress: wallet,
    identityStatus: "IDENTITY_CONFIRMED",
    trades: [trade],
    activity: [],
    hasCapitalSnapshots: true,
    hasGoldenExpectations: true,
    hasPositionBaseline: true,
    sourceCodeCommit: sourceVersion.commit,
    sourceCodeDirty: false,
  });
  expect(report.status).toBe("PASSED");
  const replayRunId = database.saveReplay(targetId, [trade], [], report, {
    captureRunId: manifest.captureRunId,
  });
  database.close();
  return {
    databasePath,
    targetId,
    replayRunId,
    sourceEventKey: report.signals[0]!.sourceEventKey,
  };
}

function seedExecutionEvidence(input: {
  databasePath: string;
  targetId: string;
  sourceEventKey: string;
}, sourceMode: "OFFICIAL" | "OFFICIAL_MISSING" | "FAKE" = "OFFICIAL"): {
  executionId: string;
  orderId: string;
  feeSnapshotId: string;
  orderbookSnapshotId: string;
} {
  const database = new DatabaseSync(input.databasePath);
  database.exec("PRAGMA foreign_keys=ON");
  const signal = database.prepare(
    "SELECT signal_id,asset_id,condition_id,target_price_units FROM signals WHERE source_event_key=?",
  ).get(input.sourceEventKey) as {
    signal_id: string;
    asset_id: string;
    condition_id: string;
    target_price_units: string;
  };
  const accountId = "paper-replay-account";
  const contextId = "paper-replay-context";
  const riskDecisionId = "paper-replay-risk";
  const executionId = "paper-replay-execution";
  const orderId = "paper-replay-order";
  const positionId = "paper-replay-position";
  const orderbookId = "paper-replay-orderbook";
  const feeSnapshotId = "paper-replay-fee";
  const targetTime = "2026-07-16T00:00:00.000Z";
  const orderTime = "2026-07-16T00:00:02.000Z";
  const deadline = "2026-07-16T00:30:00.000Z";
  const metadata = stableJson({ tokens: [{ token_id: signal.asset_id, outcome: "Yes" }] });
  const metadataHash = createHash("sha256").update(metadata).digest("hex");
  const bids = [{ price: "0.49", size: "100" }];
  const asks = [{ price: "0.5", size: "100" }];
  const payloadHash = createHash("sha256").update(stableJson({
    bids,
    asks,
    minOrderSize: "1",
    tickSize: "0.01",
  })).digest("hex");
  const bookUrl = sourceMode !== "FAKE"
    ? `https://clob.polymarket.com/book?token_id=${encodeURIComponent(signal.asset_id)}`
    : "https://clob.test/book";
  const feeUrl = sourceMode !== "FAKE"
    ? `https://clob.polymarket.com/clob-markets/${encodeURIComponent(signal.condition_id)}`
    : "https://clob.test/fee";
  let bookCaptureId: string | null = null;
  let feeCaptureId: string | null = null;

  if (sourceMode === "OFFICIAL") {
    for (const capture of [
      {
        endpoint: "clob-orderbook",
        url: bookUrl,
        data: {
          market: signal.condition_id,
          asset_id: signal.asset_id,
          timestamp: String(Date.parse(orderTime)),
          hash: "fixture-book-hash",
          bids,
          asks,
          min_order_size: "1",
          tick_size: "0.01",
        },
      },
      {
        endpoint: "clob-market-info",
        url: feeUrl,
        data: {
          tbf: 0,
          mbf: 0,
          t: [{ t: signal.asset_id, o: "Yes" }],
          mts: 1,
          mos: 1,
        },
      },
    ]) {
      const responseJson = JSON.stringify(capture.data);
      const identity = captureIdentityFromResponseJson(capture.url, orderTime, responseJson);
      if (capture.endpoint === "clob-orderbook") bookCaptureId = identity.captureId;
      if (capture.endpoint === "clob-market-info") feeCaptureId = identity.captureId;
      storeCompressedCapturePayload(database, identity.payloadSha256, responseJson, orderTime);
      database.prepare(
        `INSERT INTO api_captures(
          capture_id,endpoint,request_url,fetched_at,latency_ms,http_status,
          payload_sha256,response_json,schema_version,response_encoding
        ) VALUES (?, ?, ?, ?, 10, 200, ?, '', ?, 'GZIP_SHA256')`,
      ).run(
        identity.captureId,
        capture.endpoint,
        capture.url,
        orderTime,
        identity.payloadSha256,
        VERSIONS.schemaVersion,
      );
    }
  }

  database.prepare(
    `INSERT INTO signal_execution_contexts(
      context_id,signal_id,capital_decision_id,target_trade_capital_ratio_ppm,
      target_trade_timestamp,market_end_time,market_metadata_snapshot_json,
      market_metadata_hash,ruleset_hash,schema_version,signal_version,strategy_version,
      source_code_commit,source_code_dirty,config_version,created_at
    ) VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
  ).run(
    contextId, signal.signal_id, targetTime, "2026-07-16T01:00:00.000Z", metadata,
    metadataHash, RULESET_HASH, VERSIONS.schemaVersion, VERSIONS.signalVersion,
    VERSIONS.strategyVersion, sourceVersion.commit, VERSIONS.configVersion, orderTime,
  );
  database.prepare(
    `INSERT INTO paper_accounts(
      paper_account_id,name,status,initial_balance_micros,cash_balance_micros,
      reserved_balance_micros,realized_pnl_micros,signal_cutoff_at,schema_version,
      strategy_version,risk_version,paper_version,ruleset_snapshot_json,ruleset_hash,
      source_code_commit,source_code_dirty,created_at,updated_at,target_id
    ) VALUES (?, 'Replay evidence', 'ACTIVE', '1000000000', '990000000', '0', '0',
      ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
  ).run(
    accountId, "2026-07-15T00:00:00.000Z", VERSIONS.schemaVersion,
    VERSIONS.strategyVersion, VERSIONS.riskVersion, VERSIONS.paperVersion,
    RULESET_SNAPSHOT_JSON, RULESET_HASH, sourceVersion.commit, orderTime, orderTime,
    input.targetId,
  );
  database.prepare(
    `INSERT INTO risk_decisions(
      risk_decision_id,executor_mode,paper_account_id,signal_id,context_id,decision,
      risk_reject_reason,requested_amount_micros,requested_size_micros,checks_json,
      schema_version,strategy_version,risk_version,ruleset_hash,source_code_commit,
      source_code_dirty,config_version,created_at,risk_reason,account_id
    ) VALUES (?, 'PAPER', ?, ?, ?, 'ALLOW', NULL, '10000000', NULL, '{}',
      ?, ?, ?, ?, ?, 0, ?, ?, 'ALLOW', ?)`,
  ).run(
    riskDecisionId, accountId, signal.signal_id, contextId, VERSIONS.schemaVersion,
    VERSIONS.strategyVersion, VERSIONS.riskVersion, RULESET_HASH, sourceVersion.commit,
    VERSIONS.configVersion, orderTime, accountId,
  );
  database.prepare(
    `INSERT INTO paper_executions(
      paper_execution_id,paper_account_id,signal_id,execution_idempotency_key,
      execution_type,state,asset_id,condition_id,requested_amount_micros,
      requested_size_micros,filled_size_micros,filled_notional_micros,fee_micros,
      target_price_units,price_limit_lower_units,price_limit_upper_units,capital_mode,
      deadline_at,attempt_count,reason,context_id,schema_version,strategy_version,
      risk_version,paper_version,ruleset_hash,risk_decision_id,risk_reject_reason,
      source_code_commit,source_code_dirty,config_version,created_at,updated_at
    ) VALUES (?, ?, ?, 'replay-execution-idempotency', 'TARGET_BUY', 'EXECUTED', ?, ?,
      '10000000', NULL, '20000000', '10000000', '0', ?, '490000000000000000',
      '510000000000000000', 'FIXED_FALLBACK', ?, 1, 'FAK_FILLED', ?, ?, ?, ?, ?, ?, ?,
      NULL, ?, 0, ?, ?, ?)`,
  ).run(
    executionId, accountId, signal.signal_id, signal.asset_id, signal.condition_id,
    signal.target_price_units, deadline, contextId, VERSIONS.schemaVersion,
    VERSIONS.strategyVersion, VERSIONS.riskVersion, VERSIONS.paperVersion, RULESET_HASH,
    riskDecisionId, sourceVersion.commit, VERSIONS.configVersion, orderTime, orderTime,
  );
  database.prepare(
    `INSERT INTO paper_orderbook_snapshots(
      orderbook_snapshot_id,asset_id,condition_id,market_snapshot_time,received_at,
      data_age_ms,payload_hash,bids_json,asks_json,source_url,min_order_size,
      min_order_size_micros,tick_size,tick_size_units,source_capture_id,created_at
    ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, '1', '1000000',
      '0.01', '10000000000000000', ?, ?)`,
  ).run(
    orderbookId, signal.asset_id, signal.condition_id, orderTime, orderTime, payloadHash,
    JSON.stringify(bids), JSON.stringify(asks), bookUrl, bookCaptureId, orderTime,
  );
  database.prepare(
    `INSERT INTO paper_fee_snapshots(
      fee_snapshot_id,asset_id,fee_rate_ppm,base_fee,fee_exponent,status,source_url,
      snapshot_time,source_capture_id,created_at
    ) VALUES (?, ?, '0', 0, 1, 'AVAILABLE', ?, ?, ?, ?)`,
  ).run(feeSnapshotId, signal.asset_id, feeUrl, orderTime, feeCaptureId, orderTime);
  database.prepare(
    `INSERT INTO paper_orders(
      paper_order_id,paper_execution_id,attempt_sequence,side,order_type,state,
      requested_size_micros,requested_amount_micros,filled_size_micros,
      filled_notional_micros,vwap_price_units,fee_micros,reject_reason,
      orderbook_snapshot_id,fee_snapshot_id,created_at
    ) VALUES (?, ?, 1, 'BUY', 'FAK', 'FILLED', NULL, '10000000', '20000000',
      '10000000', '500000000000000000', '0', NULL, ?, ?, ?)`,
  ).run(orderId, executionId, orderbookId, feeSnapshotId, orderTime);
  database.prepare(
    `INSERT INTO paper_positions(
      paper_position_id,paper_account_id,opening_execution_id,signal_id,asset_id,
      condition_id,outcome,entry_price_units,entry_size_micros,entry_notional_micros,
      entry_fee_micros,current_size_micros,remaining_cost_micros,stop_loss_price_units,
      status,frozen_from_status,frozen_reason,frozen_at,realized_pnl_micros,ruleset_hash,
      source_code_commit,source_code_dirty,config_version,created_at,updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'Yes', '500000000000000000', '20000000', '10000000',
      '0', '20000000', '10000000', '250000000000000000', 'OPEN', NULL, NULL, NULL,
      '0', ?, ?, 0, ?, ?, ?)`,
  ).run(
    positionId, accountId, executionId, signal.signal_id, signal.asset_id,
    signal.condition_id, RULESET_HASH, sourceVersion.commit, VERSIONS.configVersion,
    orderTime, orderTime,
  );
  database.prepare(
    `INSERT INTO paper_execution_positions(
      paper_execution_id,paper_position_id,requested_size_micros,filled_size_micros,created_at
    ) VALUES (?, ?, '20000000', '20000000', ?)`,
  ).run(executionId, positionId, orderTime);
  database.prepare(
    `INSERT INTO paper_fill_ledger(
      fill_id,paper_order_id,paper_execution_id,paper_position_id,side,price_units,
      size_micros,notional_micros,fee_micros,level_sequence,created_at
    ) VALUES ('paper-replay-fill', ?, ?, ?, 'BUY', '500000000000000000',
      '20000000', '10000000', '0', 0, ?)`,
  ).run(orderId, executionId, positionId, orderTime);
  database.prepare(
    `INSERT INTO paper_fee_ledger(
      fee_ledger_id,paper_execution_id,paper_order_id,fee_snapshot_id,fee_micros,created_at
    ) VALUES ('paper-replay-fee-ledger', ?, ?, ?, '0', ?)`,
  ).run(executionId, orderId, feeSnapshotId, orderTime);
  database.close();
  return { executionId, orderId, feeSnapshotId, orderbookSnapshotId: orderbookId };
}

describe("real replay validation evidence", () => {
  it("imports a capture-bound real Signal replay and rejects artifact tampering", () => {
    const env = fixture();
    const coreHash = "a".repeat(64);
    const artifact = buildReplayValidationEvidenceArtifact({
      databasePath: env.databasePath,
      source: "REAL_SIGNAL_REPLAY",
      coverage: ["BUY"],
      coreCompatibilityHash: coreHash,
      sourceCodeCommit: sourceVersion.commit,
      sourceEventKey: env.sourceEventKey,
      replayRunId: env.replayRunId,
      generatedAt: "2026-09-08T00:10:00.000Z",
    });

    expect(artifact).toMatchObject({
      status: "PASSED",
      source: "REAL_SIGNAL_REPLAY",
      coverage: ["BUY"],
      execution: null,
      capture: {
        captureItemCount: 1,
        matchedPayloadSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
      replay: { replayReportHash: expect.stringMatching(/^[a-f0-9]{64}$/) },
    });
    expect(verifyReplayValidationEvidenceArtifact(artifact, coreHash, sourceVersion.commit)).toBe(true);
    expect(verifyReplayValidationEvidenceArtifact(
      { ...artifact, coverage: ["SELL"] },
      coreHash,
      sourceVersion.commit,
    )).toBe(false);
    expect(replayEvidenceCoverage([artifact]).BUY).toMatchObject({
      source: "REAL_SIGNAL_REPLAY",
      evidenceId: artifact.artifactHash,
    });
  });

  it("does not let real Signal replay claim execution coverage", () => {
    const env = fixture();
    expect(() => buildReplayValidationEvidenceArtifact({
      databasePath: env.databasePath,
      source: "REAL_SIGNAL_REPLAY",
      coverage: ["FILL"],
      coreCompatibilityHash: "b".repeat(64),
      sourceCodeCommit: sourceVersion.commit,
      sourceEventKey: env.sourceEventKey,
      replayRunId: env.replayRunId,
    })).toThrow("REPLAY_EVIDENCE_SCENARIO_NOT_ALLOWED:REAL_SIGNAL_REPLAY:FILL");
  });

  it("imports database-revalidated execution evidence and keeps its market snapshots immutable", () => {
    const env = fixture();
    const seeded = seedExecutionEvidence(env);
    const coreHash = "c".repeat(64);
    const artifact = buildReplayValidationEvidenceArtifact({
      databasePath: env.databasePath,
      source: "REAL_EXECUTION_REPLAY",
      coverage: ["FEE", "FILL", "ORDER", "POSITION_UPDATE", "RISK_ALLOW"],
      coreCompatibilityHash: coreHash,
      sourceCodeCommit: sourceVersion.commit,
      sourceEventKey: env.sourceEventKey,
      replayRunId: env.replayRunId,
      paperExecutionId: seeded.executionId,
      paperOrderId: seeded.orderId,
      generatedAt: "2026-07-16T00:10:00.000Z",
    });
    expect(artifact).toMatchObject({
      source: "REAL_EXECUTION_REPLAY",
      execution: {
        orderState: "FILLED",
        fillCount: 1,
        positionUpdateCount: 1,
        feeEntryCount: 1,
      },
    });
    expect(() => assertReplayValidationEvidenceArtifactAgainstDatabase(
      artifact,
      env.databasePath,
      coreHash,
      sourceVersion.commit,
    )).not.toThrow();

    const database = new DatabaseSync(env.databasePath);
    expect(() => database.prepare(
      "UPDATE paper_fee_snapshots SET source_capture_id=NULL WHERE fee_snapshot_id=?",
    ).run(seeded.feeSnapshotId)).toThrow("paper fee snapshots is immutable");
    expect(() => database.prepare(
      "DELETE FROM paper_fee_snapshots WHERE fee_snapshot_id=?",
    ).run(seeded.feeSnapshotId)).toThrow("paper fee snapshots is immutable");
    expect(() => database.prepare(
      "UPDATE paper_orderbook_snapshots SET source_capture_id=NULL WHERE orderbook_snapshot_id=?",
    ).run(seeded.orderbookSnapshotId)).toThrow("paper orderbook snapshots is immutable");
    expect(() => database.prepare(
      "DELETE FROM paper_orderbook_snapshots WHERE orderbook_snapshot_id=?",
    ).run(seeded.orderbookSnapshotId)).toThrow("paper orderbook snapshots is immutable");
    database.close();
    expect(() => assertReplayValidationEvidenceArtifactAgainstDatabase(
      artifact,
      env.databasePath,
      coreHash,
      sourceVersion.commit,
    )).not.toThrow();
  });

  it("rejects fake market sources before they can qualify as real execution replay", () => {
    const env = fixture();
    const seeded = seedExecutionEvidence(env, "FAKE");
    expect(() => buildReplayValidationEvidenceArtifact({
      databasePath: env.databasePath,
      source: "REAL_EXECUTION_REPLAY",
      coverage: ["FILL"],
      coreCompatibilityHash: "d".repeat(64),
      sourceCodeCommit: sourceVersion.commit,
      sourceEventKey: env.sourceEventKey,
      replayRunId: env.replayRunId,
      paperExecutionId: seeded.executionId,
      paperOrderId: seeded.orderId,
    })).toThrow("REPLAY_EVIDENCE_PUBLIC_MARKET_CAPTURE_SOURCE_INVALID");
  });

  it("rejects official-looking snapshot URLs without an immutable capture binding", () => {
    const env = fixture();
    const seeded = seedExecutionEvidence(env, "OFFICIAL_MISSING");
    expect(() => buildReplayValidationEvidenceArtifact({
      databasePath: env.databasePath,
      source: "REAL_EXECUTION_REPLAY",
      coverage: ["FILL"],
      coreCompatibilityHash: "f".repeat(64),
      sourceCodeCommit: sourceVersion.commit,
      sourceEventKey: env.sourceEventKey,
      replayRunId: env.replayRunId,
      paperExecutionId: seeded.executionId,
      paperOrderId: seeded.orderId,
    })).toThrow("REPLAY_EVIDENCE_PUBLIC_MARKET_CAPTURE_BINDING_MISSING");
  });

  it("rejects a fresh-at-capture book that is stale when the Paper order is created", () => {
    const env = fixture();
    const seeded = seedExecutionEvidence(env);
    const database = new DatabaseSync(env.databasePath);
    database.prepare("UPDATE paper_orders SET created_at=? WHERE paper_order_id=?")
      .run("2026-07-16T00:00:10.000Z", seeded.orderId);
    database.close();
    expect(() => buildReplayValidationEvidenceArtifact({
      databasePath: env.databasePath,
      source: "REAL_EXECUTION_REPLAY",
      coverage: ["FILL"],
      coreCompatibilityHash: "e".repeat(64),
      sourceCodeCommit: sourceVersion.commit,
      sourceEventKey: env.sourceEventKey,
      replayRunId: env.replayRunId,
      paperExecutionId: seeded.executionId,
      paperOrderId: seeded.orderId,
    })).toThrow("REPLAY_EVIDENCE_ORDERBOOK_STALE_AT_ORDER_TIME");
  });
});
