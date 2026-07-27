import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  liveProductionReadiness,
  saveLiveProductionConfig,
} from "../src/operator/live-production-readiness.js";

const roots: string[] = [];
const wallet = "0x00000000000000000000000000000000000000ab";

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Live production readiness", () => {
  it("starts pending without a wallet and exposes no credential fields", () => {
    const root = mkdtempSync(join(tmpdir(), "ni-k-live-readiness-"));
    roots.push(root);
    const readiness = liveProductionReadiness(root, {
      databaseAvailable: false,
      gatePrerequisites: [],
      executionCapability: "PENDING_PREREQUISITES",
    }, () => new Date("2026-07-27T08:00:00.000Z"));

    expect(readiness).toMatchObject({
      path: "PRODUCTION_LIVE",
      status: "PENDING_PREREQUISITES",
      nextStep: "CONNECT_FORMAL_WALLET",
      config: { walletAddress: null, network: null },
    });
    expect(JSON.stringify(readiness)).not.toMatch(/private|seed|mnemonic|secret|apiKey/i);
  });

  it("reaches ready only after explicit host capability injection and Gate authorization", () => {
    const root = mkdtempSync(join(tmpdir(), "ni-k-live-readiness-ready-"));
    roots.push(root);
    saveLiveProductionConfig(root, { walletAddress: wallet.toUpperCase(), network: "POLYGON" });
    const readiness = liveProductionReadiness(root, {
      databaseAvailable: true,
      gatePrerequisites: [{ key: "USER_EXPLICIT_AUTHORIZATION", status: "PASSED" }],
      executionCapability: "AVAILABLE",
      injectedChecks: {
        FORMAL_WALLET: true,
        SECURE_SIGNER: true,
        READONLY_BALANCE: true,
        AUTHENTICATED_CLOB: true,
        COMPLIANCE: true,
        GEOBLOCK: true,
        CLOCK_SAFETY: true,
      },
    });

    expect(readiness.status).toBe("READY");
    expect(readiness.nextStep).toBe("RUN_PRODUCTION_PREFLIGHT");
    expect(readiness.checks.every((check) => check.status === "READY")).toBe(true);
    const persisted = readFileSync(join(root, "data/operator/live-production.json"), "utf8");
    expect(existsSync(join(root, "data/operator/live-production.json"))).toBe(true);
    expect(persisted).not.toMatch(/private|seed|mnemonic|secret|apiKey/i);
  });
});
