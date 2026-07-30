import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
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
import {
  computeLiveProductionRuntimeHash,
  resolveLiveProductionRuntimeIdentity,
} from "../src/operator/live-production-build.js";

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
    schemaVersion: "live-production-validation-v2",
    status: "PASSED",
    sourceCodeCommit: sourceVersion.commit,
    sourceCodeDirty: false,
    liveRuntimeHash: computeLiveProductionRuntimeHash(root),
    runtimeSourceDirty: false,
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
  it("binds validation to runtime behavior while ignoring docs and presentation-only styling", () => {
    const root = mkdtempSync(join(tmpdir(), "ni-k-live-runtime-hash-"));
    roots.push(root);
    mkdirSync(join(root, "src/live"), { recursive: true });
    mkdirSync(join(root, "tests"), { recursive: true });
    mkdirSync(join(root, "prototype/live-ui"), { recursive: true });
    mkdirSync(join(root, "scripts"), { recursive: true });
    writeFileSync(join(root, "src/live/runtime.ts"), "export const runtime = 1;\n");
    writeFileSync(join(root, "tests/runtime.test.ts"), "export const testRuntime = 1;\n");
    writeFileSync(join(root, "prototype/live-ui/app.js"), "window.runtime = 1;\n");
    writeFileSync(join(root, "prototype/live-ui/styles.css"), "body { color: blue; }\n");
    writeFileSync(join(root, "README.md"), "first\n");
    writeFileSync(join(root, "scripts/launch-hecatonchires-ui.command"), "#!/bin/zsh\n");
    writeFileSync(join(root, "package.json"), "{}\n");
    writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    writeFileSync(join(root, "tsconfig.json"), "{}\n");

    const baseline = computeLiveProductionRuntimeHash(root);
    writeFileSync(join(root, "prototype/live-ui/styles.css"), "body { color: green; }\n");
    writeFileSync(join(root, "README.md"), "second\n");
    expect(computeLiveProductionRuntimeHash(root)).toBe(baseline);

    writeFileSync(join(root, "src/live/runtime.ts"), "export const runtime = 2;\n");
    expect(computeLiveProductionRuntimeHash(root)).not.toBe(baseline);

    writeFileSync(join(root, "src/live/runtime.ts"), "export const runtime = 1;\n");
    writeFileSync(join(root, "tests/runtime.test.ts"), "export const testRuntime = 2;\n");
    expect(computeLiveProductionRuntimeHash(root)).not.toBe(baseline);
  });

  it("treats documentation and pure styling as non-runtime dirtiness", () => {
    const root = mkdtempSync(join(tmpdir(), "ni-k-live-runtime-dirty-"));
    roots.push(root);
    mkdirSync(join(root, "src/live"), { recursive: true });
    mkdirSync(join(root, "tests"), { recursive: true });
    mkdirSync(join(root, "prototype/live-ui"), { recursive: true });
    writeFileSync(join(root, "src/live/runtime.ts"), "export const runtime = 1;\n");
    writeFileSync(join(root, "tests/runtime.test.ts"), "export const testRuntime = 1;\n");
    writeFileSync(join(root, "prototype/live-ui/styles.css"), "body { color: blue; }\n");
    writeFileSync(join(root, "README.md"), "first\n");
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "-qm", "fixture"], { cwd: root });
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();

    writeFileSync(join(root, "prototype/live-ui/styles.css"), "body { color: green; }\n");
    writeFileSync(join(root, "README.md"), "second\n");
    expect(resolveLiveProductionRuntimeIdentity(root, { commit, dirty: true })).toMatchObject({
      runtimeSourceDirty: false,
      runtimeDirtyPaths: [],
    });

    writeFileSync(join(root, "src/live/runtime.ts"), "export const runtime = 2;\n");
    expect(resolveLiveProductionRuntimeIdentity(root, { commit, dirty: true })).toMatchObject({
      runtimeSourceDirty: true,
      runtimeDirtyPaths: ["src/live/runtime.ts"],
    });

    writeFileSync(join(root, "src/live/runtime.ts"), "export const runtime = 1;\n");
    writeFileSync(join(root, "tests/runtime.test.ts"), "export const testRuntime = 2;\n");
    expect(resolveLiveProductionRuntimeIdentity(root, { commit, dirty: true })).toMatchObject({
      runtimeSourceDirty: true,
      runtimeDirtyPaths: ["tests/runtime.test.ts"],
    });
  });

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

  it("accepts a documentation-only commit change but rejects changed runtime behavior", async () => {
    const env = await fixture();
    const manager = new ProductionLivePrerequisiteManager({
      projectRoot: env.root,
      databasePath: env.databasePath,
      sourceVersion: { commit: "c".repeat(40), dirty: false },
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
    });

    manager.refreshStaticEvidence();
    mkdirSync(join(env.root, "src/live"), { recursive: true });
    writeFileSync(join(env.root, "src/live/new-runtime.ts"), "export const changed = true;\n");
    expect(() => manager.refreshStaticEvidence()).toThrow("LIVE_PRODUCTION_RUNTIME_HASH_MISMATCH");
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
