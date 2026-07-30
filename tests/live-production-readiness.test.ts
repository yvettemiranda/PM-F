import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    saveLiveProductionConfig(root, {
      walletAddress: wallet.toUpperCase(),
      network: "POLYGON",
      confirmLimits: true,
      acceptCompliance: true,
    });
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

  it("does not bind a connected session to a different configured wallet", () => {
    const root = mkdtempSync(join(tmpdir(), "ni-k-live-readiness-mismatch-"));
    roots.push(root);
    saveLiveProductionConfig(root, { walletAddress: wallet, network: "POLYGON" });
    const readiness = liveProductionReadiness(root, {
      databaseAvailable: true,
      gatePrerequisites: [],
      executionCapability: "PENDING_PREREQUISITES",
      walletSession: {
        walletAddress: "0x00000000000000000000000000000000000000cd",
        network: "POLYGON",
      },
    });

    expect(readiness.checks).toContainEqual(expect.objectContaining({
      key: "FORMAL_WALLET",
      status: "PENDING",
    }));
    expect(readiness.nextStep).toBe("CONNECT_FORMAL_WALLET");
  });

  it("persists conservative Live limits and invalidates their confirmation after a change", () => {
    const root = mkdtempSync(join(tmpdir(), "ni-k-live-readiness-limits-"));
    roots.push(root);
    const confirmed = saveLiveProductionConfig(root, {
      walletAddress: wallet,
      tradingWalletAddress: wallet,
      signatureType: "EOA",
      network: "POLYGON",
      liveBankrollMicros: "10000000",
      maxTradeSizeMicros: "1000000",
      maxExposureMicros: "3000000",
      maxDailyLossMicros: "1000000",
      confirmLimits: true,
    }, () => new Date("2026-07-28T01:00:00.000Z"));
    expect(confirmed).toMatchObject({
      schemaVersion: "live-production-config-v2",
      walletBinding: "BROWSER_EIP1193",
      limitsConfirmedAt: "2026-07-28T01:00:00.000Z",
    });

    const changed = saveLiveProductionConfig(root, {
      maxTradeSizeMicros: "900000",
    });
    expect(changed.limitsConfirmedAt).toBeNull();
    expect(changed.limitsConfirmationHash).toBeNull();
    const largerAllocation = saveLiveProductionConfig(root, {
      liveBankrollMicros: "34342000000",
      maxTradeSizeMicros: "100000000",
      maxExposureMicros: "1000000000",
      maxDailyLossMicros: "50000000",
    });
    expect(largerAllocation).toMatchObject({
      liveBankrollMicros: "34342000000",
      maxTradeSizeMicros: "100000000",
      maxExposureMicros: "1000000000",
      maxDailyLossMicros: "50000000",
      limitsConfirmedAt: null,
    });
  });

  it("allows the operator to revoke a prior compliance acknowledgement", () => {
    const root = mkdtempSync(join(tmpdir(), "ni-k-live-readiness-compliance-"));
    roots.push(root);
    saveLiveProductionConfig(root, {
      walletAddress: wallet,
      tradingWalletAddress: wallet,
      signatureType: "EOA",
      network: "POLYGON",
      confirmLimits: true,
      acceptCompliance: true,
    }, () => new Date("2026-07-28T00:00:00.000Z"));

    const revoked = saveLiveProductionConfig(root, {
      acceptCompliance: false,
    }, () => new Date("2026-07-28T00:01:00.000Z"));

    expect(revoked.complianceAcceptedAt).toBeNull();
    expect(revoked.limitsConfirmedAt).toBe("2026-07-28T00:00:00.000Z");
  });

  it("keeps a valid larger allocation but clears a forged limits confirmation", () => {
    const root = mkdtempSync(join(tmpdir(), "ni-k-live-readiness-tampered-"));
    roots.push(root);
    const path = join(root, "data/operator/live-production.json");
    mkdirSync(join(root, "data/operator"), { recursive: true });
    writeFileSync(path, JSON.stringify({
      schemaVersion: "live-production-config-v2",
      walletAddress: wallet,
      tradingWalletAddress: wallet,
      signatureType: "EOA",
      network: "POLYGON",
      walletBinding: "BROWSER_EIP1193",
      liveBankrollMicros: "100000001",
      maxTradeSizeMicros: "1000000",
      maxExposureMicros: "3000000",
      maxDailyLossMicros: "1000000",
      limitsConfirmedAt: "2026-07-28T00:00:00.000Z",
      limitsConfirmationHash: "forged",
      complianceAcceptedAt: "2026-07-28T00:00:00.000Z",
      updatedAt: "2026-07-28T00:00:00.000Z",
    }));

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

    expect(readiness.status).toBe("PENDING_PREREQUISITES");
    expect(readiness.config).toMatchObject({
      walletAddress: wallet,
      network: "POLYGON",
      liveBankrollMicros: "100000001",
      limitsConfirmedAt: null,
      complianceAcceptedAt: "2026-07-28T00:00:00.000Z",
    });
  });
});
