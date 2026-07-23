import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { stableJson } from "../domain/versioning.js";
import type { SourceVersion } from "../infra/source-version.js";
import { normalizeTargetWallet } from "../operator/target-wallet.js";
import { computeCoreCompatibilityHash } from "./core-compatibility.js";
import type { CompatibilityIdentity, CoreCompatibilityManifest } from "./types.js";

const ACTIVE_CAMPAIGN_STATES = new Set(["QUALIFYING", "RUNNING", "PAUSED", "INCOMPLETE_COVERAGE"]);
const TERMINAL_CAMPAIGN_STATES = new Set(["PASSED", "BLOCKED", "FROZEN"]);

interface PreMigrationCampaignRow {
  campaign_id: string;
  core_compatibility_hash: string;
  config_version: string;
  created_at: string;
  state: string | null;
  latest_report_json: string | null;
  latest_session_report_json: string | null;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

/**
 * A safely paused same-core Campaign may refresh its isolated proof when the
 * validation policy or verification suite changes. RUNNING/crash-recovery
 * states stay blocked so Phase 0 refresh cannot move evidence underneath an
 * unfinished Session; terminal same-core revalidation remains supported.
 */
export function paperCompatibilityEvidenceRefreshRequired(input: {
  campaignState: string;
  previousCoreCompatibilityHash: string;
  currentCoreCompatibilityHash: string;
  previousCompatibilityIdentity: CompatibilityIdentity | null;
  currentCompatibilityIdentity: CompatibilityIdentity;
}): boolean {
  return ["PAUSED", "PASSED"].includes(input.campaignState)
    && input.previousCoreCompatibilityHash === input.currentCoreCompatibilityHash
    && (
      input.previousCompatibilityIdentity?.validationPolicyHash
        !== input.currentCompatibilityIdentity.validationPolicyHash
      || input.previousCompatibilityIdentity?.verificationSuiteHash
        !== input.currentCompatibilityIdentity.verificationSuiteHash
    );
}

function tableExists(database: DatabaseSync, tableName: string): boolean {
  return Boolean(database.prepare(
    "SELECT 1 ok FROM sqlite_master WHERE type='table' AND name=?",
  ).get(tableName));
}

function assertSafeDatabase(database: DatabaseSync): void {
  const safety = database.prepare(
    "SELECT execution_mode,live_gate_state FROM live_gate_state WHERE state_id='default'",
  ).get() as { execution_mode: string; live_gate_state: string } | undefined;
  if (!safety || safety.execution_mode !== "PAPER" || safety.live_gate_state !== "LIVE_DISABLED") {
    throw new Error(
      `PAPER_CAMPAIGN_UNSAFE_DATABASE:${safety?.execution_mode ?? "MISSING"}:${safety?.live_gate_state ?? "MISSING"}`,
    );
  }
}

function campaignRows(database: DatabaseSync, targetWallet: string): PreMigrationCampaignRow[] {
  return database.prepare(
    `SELECT c.campaign_id,c.core_compatibility_hash,c.config_version,c.created_at,
            (SELECT t.to_state FROM paper_validation_transitions t
             WHERE t.entity_type='CAMPAIGN' AND t.campaign_id=c.campaign_id
             ORDER BY t.sequence DESC LIMIT 1) state,
            (SELECT r.report_json FROM paper_validation_reports r
             WHERE r.campaign_id=c.campaign_id AND r.report_scope='CAMPAIGN'
             ORDER BY r.created_at DESC,r.report_id DESC LIMIT 1) latest_report_json,
            (SELECT r.report_json FROM paper_validation_reports r
             WHERE r.campaign_id=c.campaign_id AND r.report_scope='SESSION'
             ORDER BY r.created_at DESC,r.report_id DESC LIMIT 1) latest_session_report_json
     FROM paper_validation_campaigns c
     JOIN monitor_targets m ON m.target_id=c.target_id
     WHERE lower(m.wallet_address)=?
     ORDER BY c.created_at DESC,c.campaign_id DESC`,
  ).all(targetWallet) as unknown as PreMigrationCampaignRow[];
}

function selectedCampaign(database: DatabaseSync, targetWallet: string): PreMigrationCampaignRow | null {
  const rows = campaignRows(database, targetWallet);
  const active = rows.filter((candidate) => candidate.state && ACTIVE_CAMPAIGN_STATES.has(candidate.state));
  if (active.length > 1) throw new Error("MULTIPLE_ACTIVE_PAPER_CAMPAIGNS_BEFORE_MIGRATION");
  return active[0] ?? rows[0] ?? null;
}

function assertKnownCampaignState(row: PreMigrationCampaignRow): asserts row is PreMigrationCampaignRow & { state: string } {
  if (!row.state || (!ACTIVE_CAMPAIGN_STATES.has(row.state) && !TERMINAL_CAMPAIGN_STATES.has(row.state))) {
    throw new Error(`PAPER_CAMPAIGN_STATE_INVALID_BEFORE_MIGRATION:${row.campaign_id}:${row.state ?? "MISSING"}`);
  }
}

function insertFreezeTransition(database: DatabaseSync, input: {
  entityType: "CAMPAIGN" | "SESSION";
  campaignId: string;
  sessionId: string | null;
  fromState: string;
  toState: "FROZEN" | "BLOCKED";
  reason: string;
  evidence: Record<string, unknown>;
  coreCompatibilityHash: string;
  configVersion: string;
  sourceVersion: SourceVersion;
  idempotencyKey: string;
  now: string;
}): void {
  const existing = database.prepare(
    `SELECT entity_type,campaign_id,session_id,from_state,to_state,reason,evidence_json,
            core_compatibility_hash,source_code_commit,source_code_dirty,config_version,created_at
     FROM paper_validation_transitions WHERE idempotency_key=?`,
  ).get(input.idempotencyKey) as {
    entity_type: string;
    campaign_id: string;
    session_id: string | null;
    from_state: string | null;
    to_state: string;
    reason: string;
    evidence_json: string;
    core_compatibility_hash: string;
    source_code_commit: string;
    source_code_dirty: number;
    config_version: string;
    created_at: string;
  } | undefined;
  const evidenceJson = stableJson(input.evidence);
  const semanticPayload = {
    entityType: input.entityType,
    campaignId: input.campaignId,
    sessionId: input.sessionId,
    fromState: input.fromState,
    toState: input.toState,
    reason: input.reason,
    evidenceJson,
    coreCompatibilityHash: input.coreCompatibilityHash,
    sourceCodeCommit: input.sourceVersion.commit,
    sourceCodeDirty: input.sourceVersion.dirty,
    configVersion: input.configVersion,
    createdAt: input.now,
  };
  if (existing) {
    const existingPayload = {
      entityType: existing.entity_type,
      campaignId: existing.campaign_id,
      sessionId: existing.session_id,
      fromState: existing.from_state,
      toState: existing.to_state,
      reason: existing.reason,
      evidenceJson: existing.evidence_json,
      coreCompatibilityHash: existing.core_compatibility_hash,
      sourceCodeCommit: existing.source_code_commit,
      sourceCodeDirty: existing.source_code_dirty === 1,
      configVersion: existing.config_version,
      createdAt: existing.created_at,
    };
    if (stableJson(existingPayload) !== stableJson(semanticPayload)) {
      throw new Error("PAPER_CAMPAIGN_PRE_MIGRATION_FREEZE_IDEMPOTENCY_CONFLICT");
    }
    return;
  }
  const sequenceColumn = input.entityType === "CAMPAIGN" ? "campaign_id" : "session_id";
  const sequenceValue = input.entityType === "CAMPAIGN" ? input.campaignId : input.sessionId;
  const next = database.prepare(
    `SELECT coalesce(max(sequence),0)+1 next FROM paper_validation_transitions
     WHERE entity_type=? AND ${sequenceColumn}=?`,
  ).get(input.entityType, sequenceValue) as { next: number };
  const evidenceHash = sha256(input.evidence);
  const transitionId = `pvt-${sha256([input.idempotencyKey, semanticPayload]).slice(0, 32)}`;
  database.prepare(
    `INSERT INTO paper_validation_transitions(
      transition_id,entity_type,campaign_id,session_id,from_state,to_state,reason,
      sequence,evidence_json,evidence_hash,core_compatibility_hash,source_code_commit,
      source_code_dirty,config_version,idempotency_key,created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    transitionId,
    input.entityType,
    input.campaignId,
    input.sessionId,
    input.fromState,
    input.toState,
    input.reason,
    next.next,
    evidenceJson,
    evidenceHash,
    input.coreCompatibilityHash,
    input.sourceVersion.commit,
    input.sourceVersion.dirty ? 1 : 0,
    input.configVersion,
    input.idempotencyKey,
    input.now,
  );
}

/** Read-only guard that must run before any migration or evidence refresh. */
export function assertPaperCampaignPreMigrationCompatible(input: {
  databasePath: string;
  manifest: CoreCompatibilityManifest;
  targetWallet: string;
}): {
  campaignId: string | null;
  campaignState: string | null;
  campaignCoreCompatibilityHash: string | null;
  campaignBlockers: string[];
  latestCompatibilityIdentity: CompatibilityIdentity | null;
} {
  const targetWallet = normalizeTargetWallet(input.targetWallet);
  if (!existsSync(input.databasePath)) {
    return {
      campaignId: null,
      campaignState: null,
      campaignCoreCompatibilityHash: null,
      campaignBlockers: [],
      latestCompatibilityIdentity: null,
    };
  }
  const database = new DatabaseSync(input.databasePath, { readOnly: true });
  database.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=5000;");
  try {
    const safetyTableExists = tableExists(database, "live_gate_state");
    if (safetyTableExists) assertSafeDatabase(database);
    if (!tableExists(database, "paper_validation_campaigns")) {
      return {
        campaignId: null,
        campaignState: null,
        campaignCoreCompatibilityHash: null,
        campaignBlockers: [],
        latestCompatibilityIdentity: null,
      };
    }
    if (!safetyTableExists) throw new Error("PAPER_CAMPAIGN_UNSAFE_DATABASE:MISSING:MISSING");
    if (!tableExists(database, "monitor_targets")) {
      throw new Error("PAPER_CAMPAIGN_PRE_MIGRATION_SCHEMA_INCOMPLETE:monitor_targets");
    }
    const row = selectedCampaign(database, targetWallet);
    if (!row) {
      return {
        campaignId: null,
        campaignState: null,
        campaignCoreCompatibilityHash: null,
        campaignBlockers: [],
        latestCompatibilityIdentity: null,
      };
    }
    assertKnownCampaignState(row);
    const currentHash = computeCoreCompatibilityHash(input.manifest);
    if (ACTIVE_CAMPAIGN_STATES.has(row.state) && row.core_compatibility_hash !== currentHash) {
      throw new Error(`ACTIVE_CAMPAIGN_CORE_MISMATCH_BEFORE_MIGRATION:${row.campaign_id}`);
    }
    let campaignBlockers: string[] = [];
    if (row.latest_report_json !== null) {
      const parsed = JSON.parse(row.latest_report_json) as { blockers?: unknown };
      if (!Array.isArray(parsed.blockers) || parsed.blockers.some((blocker) => typeof blocker !== "string")) {
        throw new Error(`PAPER_CAMPAIGN_BLOCKERS_INVALID_BEFORE_MIGRATION:${row.campaign_id}`);
      }
      campaignBlockers = [...new Set(parsed.blockers)].sort();
    }
    let latestCompatibilityIdentity: CompatibilityIdentity | null = null;
    if (row.latest_session_report_json !== null) {
      const parsed = JSON.parse(row.latest_session_report_json) as {
        compatibilityIdentity?: Partial<CompatibilityIdentity> | null;
      };
      if (parsed.compatibilityIdentity !== undefined && parsed.compatibilityIdentity !== null) {
        const identity = parsed.compatibilityIdentity;
        const values = [
          identity.validationPolicyHash,
          identity.verificationSuiteHash,
          identity.operatorBuildHash,
          identity.artifactProvenanceHash,
        ];
        if (values.some((value) => typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))) {
          throw new Error(`PAPER_CAMPAIGN_COMPATIBILITY_IDENTITY_INVALID_BEFORE_MIGRATION:${row.campaign_id}`);
        }
        latestCompatibilityIdentity = identity as CompatibilityIdentity;
      }
    }
    return {
      campaignId: row.campaign_id,
      campaignState: row.state,
      campaignCoreCompatibilityHash: row.core_compatibility_hash,
      campaignBlockers,
      latestCompatibilityIdentity,
    };
  } finally {
    database.close();
  }
}

/**
 * Explicitly freezes an incompatible Campaign using only the already-installed
 * Campaign tables. It intentionally does not initialize the database or run a
 * migration, so callers can preserve old evidence before preparing a new core.
 */
export function freezePaperCampaignPreMigrationMismatch(input: {
  databasePath: string;
  manifest: CoreCompatibilityManifest;
  sourceVersion: SourceVersion;
  now: string;
  targetWallet: string;
}): { campaignId: string | null; campaignState: string | null; frozen: boolean } {
  const targetWallet = normalizeTargetWallet(input.targetWallet);
  if (!existsSync(input.databasePath)) return { campaignId: null, campaignState: null, frozen: false };
  if (input.sourceVersion.dirty || !input.sourceVersion.commit.trim() || input.sourceVersion.commit === "UNCOMMITTED") {
    throw new Error("PAPER_CAMPAIGN_PRE_MIGRATION_FREEZE_REQUIRES_CLEAN_SOURCE");
  }
  if (!Number.isFinite(Date.parse(input.now))) throw new Error("PAPER_CAMPAIGN_PRE_MIGRATION_FREEZE_TIME_INVALID");
  const database = new DatabaseSync(input.databasePath);
  database.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
  try {
    if (!tableExists(database, "paper_validation_campaigns")) {
      return { campaignId: null, campaignState: null, frozen: false };
    }
    for (const requiredTable of [
      "live_gate_state",
      "paper_validation_sessions",
      "paper_validation_transitions",
      "monitor_targets",
    ]) {
      if (!tableExists(database, requiredTable)) {
        throw new Error(`PAPER_CAMPAIGN_PRE_MIGRATION_FREEZE_SCHEMA_INCOMPLETE:${requiredTable}`);
      }
    }
    const currentHash = computeCoreCompatibilityHash(input.manifest);
    database.exec("BEGIN IMMEDIATE");
    try {
      assertSafeDatabase(database);
      const row = selectedCampaign(database, targetWallet);
      if (!row) {
        database.exec("COMMIT");
        return { campaignId: null, campaignState: null, frozen: false };
      }
      assertKnownCampaignState(row);
      if (!ACTIVE_CAMPAIGN_STATES.has(row.state) || row.core_compatibility_hash === currentHash) {
        database.exec("COMMIT");
        return { campaignId: row.campaign_id, campaignState: row.state, frozen: false };
      }
      const evidence = {
        expected: row.core_compatibility_hash,
        actual: currentHash,
        preMigration: true,
        targetWallet,
      };
      if (row.state === "RUNNING") {
        const runningSessions = database.prepare(
          `SELECT s.session_id,
                  (SELECT t.to_state FROM paper_validation_transitions t
                   WHERE t.entity_type='SESSION' AND t.session_id=s.session_id
                   ORDER BY t.sequence DESC LIMIT 1) state
           FROM paper_validation_sessions s WHERE s.campaign_id=?`,
        ).all(row.campaign_id) as unknown as Array<{ session_id: string; state: string }>;
        const running = runningSessions.filter((session) => session.state === "RUNNING");
        if (running.length !== 1) {
          throw new Error("PAPER_CAMPAIGN_PRE_MIGRATION_RUNNING_SESSION_INVALID");
        }
        insertFreezeTransition(database, {
          entityType: "SESSION",
          campaignId: row.campaign_id,
          sessionId: running[0]!.session_id,
          fromState: "RUNNING",
          toState: "BLOCKED",
          reason: "CORE_COMPATIBILITY_MISMATCH_BEFORE_MIGRATION",
          evidence,
          coreCompatibilityHash: row.core_compatibility_hash,
          configVersion: row.config_version,
          sourceVersion: input.sourceVersion,
          idempotencyKey: `SESSION:${running[0]!.session_id}:PRE_MIGRATION_CORE_MISMATCH:${currentHash}`,
          now: input.now,
        });
      }
      insertFreezeTransition(database, {
        entityType: "CAMPAIGN",
        campaignId: row.campaign_id,
        sessionId: null,
        fromState: row.state,
        toState: "FROZEN",
        reason: "CORE_COMPATIBILITY_MISMATCH_BEFORE_MIGRATION",
        evidence,
        coreCompatibilityHash: row.core_compatibility_hash,
        configVersion: row.config_version,
        sourceVersion: input.sourceVersion,
        idempotencyKey: `CAMPAIGN:${row.campaign_id}:PRE_MIGRATION_CORE_MISMATCH:${currentHash}`,
        now: input.now,
      });
      database.exec("COMMIT");
      return { campaignId: row.campaign_id, campaignState: "FROZEN", frozen: true };
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.close();
  }
}

export function preparePaperCampaignPreMigration(input: {
  databasePath: string;
  manifest: CoreCompatibilityManifest;
  sourceVersion: SourceVersion;
  now: string;
  targetWallet: string;
}): ReturnType<typeof assertPaperCampaignPreMigrationCompatible> & {
  mismatchFrozen: boolean;
} {
  try {
    return {
      ...assertPaperCampaignPreMigrationCompatible(input),
      mismatchFrozen: false,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.startsWith("ACTIVE_CAMPAIGN_CORE_MISMATCH_BEFORE_MIGRATION:")) throw error;
    const frozen = freezePaperCampaignPreMigrationMismatch(input);
    if (!frozen.frozen || frozen.campaignState !== "FROZEN") {
      throw new Error(`PAPER_CAMPAIGN_PRE_MIGRATION_FREEZE_NOT_CONFIRMED:${frozen.campaignId ?? "UNKNOWN"}`);
    }
    return {
      ...assertPaperCampaignPreMigrationCompatible(input),
      mismatchFrozen: true,
    };
  }
}
