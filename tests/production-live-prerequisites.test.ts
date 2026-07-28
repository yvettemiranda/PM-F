import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { prepareRuntimeDatabase } from "../src/infra/sqlite/runtime-database-preparation.js";
import {
  ProductionLivePrerequisiteManager,
  liveProductionValidationArtifactPath,
} from "../src/operator/production-live-prerequisites.js";

const roots: string[] = [];
const sourceVersion = { commit: "b".repeat(40), dirty: false };
const wallet = "0x0000000000000000000000000000000000000001";

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ni-k-live-prerequisites-"));
  roots.push(root);
  const databasePath = join(root, "data/runtime/ni-k.sqlite");
  await prepareRuntimeDatabase({ databasePath, sourceVersion });
  const finalReport = [
    "OWNER_AUTHORIZED_MIXED_CORE_AGGREGATION",
    "86,400,012 ms",
    "live_gate_state=LIVE_DISABLED",
  ].join("\n");
  const isolated = JSON.stringify({
    status: "PASSED",
    safety: { realOrdersCreated: 0, chainWrites: 0 },
  });
  const finalPath = join(
    root,
    "data/operator/final-reports/ni-k-paper-mixed-core-24h-final-20260727-0300.md",
  );
  const isolatedPath = join(root, "data/operator/paper-campaign-isolated-verification.json");
  mkdirSync(dirname(finalPath), { recursive: true });
  writeFileSync(finalPath, finalReport);
  writeFileSync(isolatedPath, isolated);
  const artifactPath = liveProductionValidationArtifactPath(root);
  mkdirSync(dirname(artifactPath), { recursive: true });
  writeFileSync(artifactPath, JSON.stringify({
    schemaVersion: "live-production-validation-v1",
    status: "PASSED",
    sourceCodeCommit: sourceVersion.commit,
    sourceCodeDirty: false,
    generatedAt: "2026-07-28T05:00:00.000Z",
    typecheckPassed: true,
    fullTestPassed: true,
    testFileCount: 70,
    testCount: 900,
    diffCheckPassed: true,
    finalPaperReportSha256: sha256(finalReport),
    isolatedVerificationSha256: sha256(isolated),
  }));
  return { root, databasePath };
}

describe("ProductionLivePrerequisiteManager", () => {
  it("imports only verified current-code Paper evidence and keeps user authorization pending", async () => {
    const env = await fixture();
    const manager = new ProductionLivePrerequisiteManager({
      projectRoot: env.root,
      databasePath: env.databasePath,
      sourceVersion,
      geoblockProvider: {
        providerType: "LIVE_READONLY",
        check: async () => ({
          status: "ALLOWED",
          checkedAt: "2026-07-28T05:01:00.000Z",
          source: "https://polymarket.com/api/geoblock",
          reason: null,
        }),
      },
      walletAddress: wallet,
      now: () => new Date("2026-07-28T05:01:00.000Z"),
    });

    manager.refreshStaticEvidence();

    const database = new DatabaseSync(env.databasePath, { readOnly: true });
    try {
      expect(database.prepare(
        "SELECT status FROM live_gate_prerequisites WHERE prerequisite_key='PAPER_STABILITY'",
      ).get()).toEqual({ status: "PASSED" });
      expect(database.prepare(
        "SELECT status FROM live_gate_prerequisites WHERE prerequisite_key='USER_EXPLICIT_AUTHORIZATION'",
      ).get()).toEqual({ status: "PENDING" });
    } finally {
      database.close();
    }
  });

  it("records fresh official geoblock and explicit user authorization only on activation request", async () => {
    const env = await fixture();
    const manager = new ProductionLivePrerequisiteManager({
      projectRoot: env.root,
      databasePath: env.databasePath,
      sourceVersion,
      geoblockProvider: {
        providerType: "LIVE_READONLY",
        check: async () => ({
          status: "ALLOWED",
          checkedAt: "2026-07-28T05:01:00.000Z",
          source: "https://polymarket.com/api/geoblock",
          reason: null,
          ip: "203.0.113.1",
          country: "XX",
          region: "TEST",
        }),
      },
      walletAddress: wallet,
      now: () => new Date("2026-07-28T05:01:00.000Z"),
    });

    await manager.authorizeActivation({ actor: "LOCAL_OPERATOR", reason: "FINAL_SMALL_LIVE_REQUEST" });

    const database = new DatabaseSync(env.databasePath, { readOnly: true });
    try {
      for (const key of ["GEOBLOCK_COMPLIANCE", "USER_EXPLICIT_AUTHORIZATION"]) {
        const row = database.prepare(
          "SELECT status,evidence_json FROM live_gate_prerequisites WHERE prerequisite_key=?",
        ).get(key) as { status: string; evidence_json: string };
        expect(row.status).toBe("PASSED");
        expect(JSON.parse(row.evidence_json)).toMatchObject({
          sourceCodeCommit: sourceVersion.commit,
          environment: "PRODUCTION",
          testOnly: false,
        });
      }
    } finally {
      database.close();
    }
  });
});
