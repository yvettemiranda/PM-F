import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { prepareRuntimeDatabase } from "../src/infra/sqlite/runtime-database-preparation.js";
import {
  ProductionLivePrerequisiteManager,
  liveProductionValidationArtifactPath,
  liveProductionEvidencePathsFromArguments,
  readLiveProductionValidationEvidence,
} from "../src/operator/production-live-prerequisites.js";
import {
  computeLiveProductionRuntimeHash,
  resolveLiveProductionRuntimeIdentity,
} from "../src/operator/live-production-build.js";

import { copyProductionEvidenceTestSources, writeProductionEvidenceTestArtifacts } from "./fixtures/production-live-evidence.js";

const roots: string[] = [];
const sourceVersion = { commit: "b".repeat(40), dirty: false };
const wallet = "0x0000000000000000000000000000000000000001";

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ni-k-live-prerequisites-"));
  roots.push(root);
  copyProductionEvidenceTestSources(root);
  const databasePath = join(root, "data/runtime/ni-k.sqlite");
  await prepareRuntimeDatabase({ databasePath, sourceVersion });
  const artifacts = writeProductionEvidenceTestArtifacts(root, sourceVersion.commit);
  const artifactPath = liveProductionValidationArtifactPath(root);
  mkdirSync(dirname(artifactPath), { recursive: true });
  writeFileSync(artifactPath, JSON.stringify({
    schemaVersion: "live-production-validation-v3",
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
    ...artifacts.evidence,
  }));
  return { root, databasePath, ...artifacts };
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

function managerFor(env: Awaited<ReturnType<typeof fixture>>) {
  return new ProductionLivePrerequisiteManager({ projectRoot: env.root, databasePath: env.databasePath,
    sourceVersion, walletAddress: wallet, geoblockProvider: { providerType: "LIVE_READONLY",
      check: async () => ({ status: "UNAVAILABLE", checkedAt: null, source: null, reason: "ISOLATED_TEST" }) } });
}

function writeJson(root: string, path: string, value: unknown): void {
  writeFileSync(join(root, path), JSON.stringify(value));
}

describe("portable production evidence", () => {
  it("uses native report paths without a fixed date or exact duration and persists their bindings", async () => {
    const env = await fixture();
    const evidence = readLiveProductionValidationEvidence({ projectRoot: env.root, sourceCodeCommit: sourceVersion.commit, ...env.paths });
    expect(evidence).toMatchObject(env.evidence);
    expect(evidence.finalPaperReportPath).toBe("data/operator/campaigns/current/campaign-report.json");
    expect(evidence.observeReportPath).toBe("data/observe/current-eight-hour-report.json");
    managerFor(env).refreshStaticEvidence();
    const db = new DatabaseSync(env.databasePath, { readOnly: true });
    const row = db.prepare("SELECT evidence_json FROM live_gate_prerequisites WHERE prerequisite_key='OBSERVE_ONLY_8H_SOAK'").get() as { evidence_json: string };
    expect(JSON.parse(row.evidence_json)).toMatchObject({ coreCompatibilityHash: evidence.coreCompatibilityHash,
      observeReportSha256: evidence.observeReportSha256, evidencePaths: { observe: evidence.observeReportPath } });
    db.close();
  });

  it("accepts exactly 24 hours of Paper and 8 uninterrupted hours of Observe", async () => {
    const env = await fixture();
    env.paper.campaign.accumulatedActiveRuntimeMs = 86_400_000;
    env.observe.metrics.activeRuntimeMs = 28_800_000;
    env.observe.metrics.durationMs = 28_800_000;
    env.observe.metrics.startedAt = "2026-07-27T20:00:00.000Z";
    writeJson(env.root, env.paths.finalPaperReportPath, env.paper);
    writeJson(env.root, env.paths.observeReportPath, env.observe);
    expect(() => readLiveProductionValidationEvidence({ projectRoot: env.root, sourceCodeCommit: sourceVersion.commit, ...env.paths })).not.toThrow();
  });

  it.each([
    { name: "Paper duration one millisecond short", target: "paper", mutate: (env: Awaited<ReturnType<typeof fixture>>) => { env.paper.campaign.accumulatedActiveRuntimeMs = 86_399_999; } },
    { name: "Observe duration one millisecond short", target: "observe", mutate: (env: Awaited<ReturnType<typeof fixture>>) => { env.observe.metrics.activeRuntimeMs = 28_799_999; } },
    { name: "Observe wall duration shorter than credited runtime", target: "observe", mutate: (env: Awaited<ReturnType<typeof fixture>>) => { env.observe.metrics.startedAt = "2026-07-28T03:59:59.000Z"; } },
    { name: "Observe scheduling gap", target: "observe", mutate: (env: Awaited<ReturnType<typeof fixture>>) => { env.observe.metrics.schedulingGapCount = 1; } },
    { name: "unrecovered connection gap", target: "observe", mutate: (env: Awaited<ReturnType<typeof fixture>>) => { env.observe.metrics.unrecoveredConnectionGap = true; } },
    { name: "Paper incomplete coverage", target: "paper", mutate: (env: Awaited<ReturnType<typeof fixture>>) => { env.paper.campaign.missingScenarios = ["BUY"]; } },
    { name: "Paper false coverage detail", target: "paper", mutate: (env: Awaited<ReturnType<typeof fixture>>) => { env.paper.campaign.coverage.BUY!.covered = false; } },
    { name: "Paper failed integrity", target: "paper", mutate: (env: Awaited<ReturnType<typeof fixture>>) => { env.paper.latestIntegrity.foreignKeyIssueCount = 1; } },
    { name: "Paper stale core", target: "paper", mutate: (env: Awaited<ReturnType<typeof fixture>>) => { env.paper.coreCompatibilityHash = "0".repeat(64); } },
    { name: "Paper stale source", target: "paper", mutate: (env: Awaited<ReturnType<typeof fixture>>) => { env.paper.campaign.sourceVersion.commit = "c".repeat(40); } },
    { name: "Observe dirty source", target: "observe", mutate: (env: Awaited<ReturnType<typeof fixture>>) => { env.observe.sourceCodeDirty = true; } },
    { name: "Observe order created", target: "observe", mutate: (env: Awaited<ReturnType<typeof fixture>>) => { env.observe.safety.ordersCreated = 1; } },
  ])("rejects $name before writing any prerequisite pass", async ({ target, mutate }) => {
    const env = await fixture();
    mutate(env);
    writeJson(env.root, target === "paper" ? env.paths.finalPaperReportPath : env.paths.observeReportPath, target === "paper" ? env.paper : env.observe);
    expect(() => managerFor(env).refreshStaticEvidence()).toThrow(target === "paper" ? "LIVE_PRODUCTION_FINAL_PAPER_EVIDENCE_INVALID" : "LIVE_PRODUCTION_OBSERVE_EVIDENCE_INVALID");
    const db = new DatabaseSync(env.databasePath, { readOnly: true });
    expect(db.prepare("SELECT count(*) count FROM live_gate_prerequisites WHERE status='PASSED'").get()).toEqual({ count: 0 });
    db.close();
  });

  it.each(["bare status", "missing replay proofs", "stale suite", "chain write", "other target"])("rejects isolated evidence with %s", async (name) => {
    const env = await fixture();
    const value = env.read(env.paths.isolatedVerificationPath);
    if (name === "bare status") {
      writeJson(env.root, env.paths.isolatedVerificationPath, { status: "PASSED", safety: { realOrdersCreated: 0, chainWrites: 0 } });
    } else {
      if (name === "missing replay proofs") delete value.proofs;
      if (name === "stale suite") value.verificationSuiteHash = "0".repeat(64);
      if (name === "chain write") (value.safety as Record<string, unknown>).chainWrites = 1;
      if (name === "other target") value.targetWallet = `0x${"2".repeat(40)}`;
      writeJson(env.root, env.paths.isolatedVerificationPath, value);
    }
    expect(() => readLiveProductionValidationEvidence({ projectRoot: env.root, sourceCodeCommit: sourceVersion.commit, ...env.paths })).toThrow("LIVE_PRODUCTION_ISOLATED_EVIDENCE_INVALID");
  });

  it("rejects legacy prose-only v2 artifacts and verifies current file hashes", async () => {
    const env = await fixture();
    const artifactPath = liveProductionValidationArtifactPath(env.root);
    const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as Record<string, unknown>;
    writeJson(env.root, env.paths.observeReportPath, env.observe); // identical JSON bytes still bind correctly
    managerFor(env).refreshStaticEvidence();
    writeFileSync(join(env.root, env.paths.observeReportPath), `${JSON.stringify(env.observe, null, 2)}\n`);
    expect(() => managerFor(env).refreshStaticEvidence()).toThrow("LIVE_PRODUCTION_EVIDENCE_BINDING_MISMATCH");
    artifact.schemaVersion = "live-production-validation-v2";
    writeFileSync(artifactPath, JSON.stringify(artifact));
    expect(() => managerFor(env).refreshStaticEvidence()).toThrow("LIVE_PRODUCTION_VALIDATION_ARTIFACT_INVALID");
  });

  it("rejects report references that escape the project", async () => {
    const env = await fixture();
    expect(() => readLiveProductionValidationEvidence({ projectRoot: env.root, sourceCodeCommit: sourceVersion.commit,
      ...env.paths, finalPaperReportPath: "../outside-report.json" })).toThrow("LIVE_PRODUCTION_EVIDENCE_PATH_OUTSIDE_PROJECT");
  });

  it("requires explicit current Paper/Observe paths in the validation CLI", () => {
    expect(liveProductionEvidencePathsFromArguments(["--paper-report=data/current.json", "--observe-report=data/observe.json"])).toEqual({
      finalPaperReportPath: "data/current.json", observeReportPath: "data/observe.json",
      isolatedVerificationPath: "data/operator/paper-campaign-isolated-verification.json",
    });
    expect(() => liveProductionEvidencePathsFromArguments([])).toThrow("LIVE_PRODUCTION_VALIDATION_EVIDENCE_PATHS_REQUIRED");
    expect(() => liveProductionEvidencePathsFromArguments(["--paper-report=a", "--paper-report=b"])).toThrow("LIVE_PRODUCTION_VALIDATION_ARGUMENT_INVALID");
    expect(() => liveProductionEvidencePathsFromArguments(["--paper-report=", "--observe-report=b"])).toThrow("LIVE_PRODUCTION_VALIDATION_ARGUMENT_INVALID");
  });
});
