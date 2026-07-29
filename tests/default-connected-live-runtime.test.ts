import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assembleDefaultConnectedLiveRuntime,
  PRODUCTION_LIVE_EXTERNAL_TIMEOUT_MS,
} from "../src/operator/default-connected-live-runtime.js";
import { saveLiveProductionConfig } from "../src/operator/live-production-readiness.js";
import { LiveWalletRequestBroker } from "../src/operator/live-wallet-request-broker.js";
import {
  liveProductionValidationArtifactPath,
} from "../src/operator/production-live-prerequisites.js";
import type { LiveWalletRuntimeBinding } from "../src/operator/live-wallet-session.js";

const roots: string[] = [];
const wallet = "0x0000000000000000000000000000000000000001";

afterEach(() => {
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function binding(): LiveWalletRuntimeBinding {
  return {
    session: {
      sessionId: "session-1",
      status: "CONNECTED",
      walletAddress: wallet,
      chainId: 137,
      network: "POLYGON",
      walletType: "EIP1193",
      connectedAt: "2026-07-28T00:00:00.000Z",
      lastSeenAt: "2026-07-28T00:00:00.000Z",
      expiresAt: "2026-07-28T00:30:00.000Z",
    },
    assertCurrent: vi.fn(),
    onInvalidated: vi.fn(() => () => undefined),
  };
}

describe("assembleDefaultConnectedLiveRuntime", () => {
  it("allows production reconciliation enough time for bounded API retries", () => {
    expect(PRODUCTION_LIVE_EXTERNAL_TIMEOUT_MS).toBe(30_000);
  });

  it("builds the complete production runtime without deriving credentials or sending a transaction", async () => {
    const root = mkdtempSync(join(tmpdir(), "ni-k-default-live-runtime-"));
    roots.push(root);
    writeFileSync(join(root, ".gitignore"), "data/\n");
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
    execFileSync("git", ["add", ".gitignore"], { cwd: root });
    execFileSync("git", ["commit", "-qm", "fixture"], { cwd: root });
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();

    saveLiveProductionConfig(root, {
      walletAddress: wallet,
      tradingWalletAddress: wallet,
      signatureType: "EOA",
      network: "POLYGON",
      confirmLimits: true,
      acceptCompliance: true,
    });
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
    writeFileSync(artifactPath, JSON.stringify({
      schemaVersion: "live-production-validation-v1",
      status: "PASSED",
      sourceCodeCommit: commit,
      sourceCodeDirty: false,
      generatedAt: "2026-07-28T06:00:00.000Z",
      typecheckPassed: true,
      fullTestPassed: true,
      testFileCount: 70,
      testCount: 900,
      diffCheckPassed: true,
      finalPaperReportSha256: sha256(finalReport),
      isolatedVerificationSha256: sha256(isolated),
    }));
    vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { method: string };
      if (request.method !== "eth_chainId") throw new Error(`UNEXPECTED_RPC:${request.method}`);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x89" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));
    const broker = new LiveWalletRequestBroker();
    const walletBinding = binding();

    const result = await assembleDefaultConnectedLiveRuntime({
      projectRoot: root,
      walletSession: walletBinding.session,
      walletSessionBinding: walletBinding,
      walletRequestBroker: broker,
      now: () => new Date("2026-07-28T06:01:00.000Z"),
    });
    try {
      expect(result.runtimeActions.capability).toMatchObject({
        execution: "AVAILABLE",
        orderManagement: "AVAILABLE",
        walletSetup: "AVAILABLE",
        production: {
          FORMAL_WALLET: true,
          SECURE_SIGNER: true,
          READONLY_BALANCE: true,
          AUTHENTICATED_CLOB: true,
          COMPLIANCE: true,
          GEOBLOCK: true,
          CLOCK_SAFETY: true,
        },
      });
      expect(broker.next("session-1")).toBeNull();
    } finally {
      result.dispose();
    }
  });
});
