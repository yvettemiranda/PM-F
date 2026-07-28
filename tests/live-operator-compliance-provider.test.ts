import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LiveOperatorComplianceProvider } from "../src/operator/live-operator-compliance-provider.js";
import { saveLiveProductionConfig } from "../src/operator/live-production-readiness.js";

const roots: string[] = [];
const signer = "0x0000000000000000000000000000000000000001";

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("LiveOperatorComplianceProvider", () => {
  it("returns fresh allowed evidence only for the exact accepted wallet binding", async () => {
    const root = mkdtempSync(join(tmpdir(), "ni-k-live-compliance-"));
    roots.push(root);
    saveLiveProductionConfig(root, {
      walletAddress: signer,
      tradingWalletAddress: signer,
      signatureType: "EOA",
      network: "POLYGON",
      acceptCompliance: true,
      confirmLimits: true,
    });
    const provider = new LiveOperatorComplianceProvider(
      root,
      () => new Date("2026-07-28T03:00:00.000Z"),
    );

    await expect(provider.check({
      walletAddress: signer,
      walletType: "EOA",
      network: "POLYGON",
      authorizedSignerAddress: signer,
    })).resolves.toEqual({
      status: "ALLOWED",
      checkedAt: "2026-07-28T03:00:00.000Z",
      source: "HECATONCHIRES_OPERATOR_ATTESTATION",
      policyVersion: "operator-attestation-v1",
      reason: null,
    });
  });

  it("fails closed when the signer, wallet type, or attestation differs", async () => {
    const root = mkdtempSync(join(tmpdir(), "ni-k-live-compliance-blocked-"));
    roots.push(root);
    saveLiveProductionConfig(root, {
      walletAddress: signer,
      tradingWalletAddress: signer,
      signatureType: "EOA",
      network: "POLYGON",
    });
    const provider = new LiveOperatorComplianceProvider(root);

    await expect(provider.check({
      walletAddress: signer,
      walletType: "EOA",
      network: "POLYGON",
      authorizedSignerAddress: signer,
    })).resolves.toMatchObject({
      status: "BLOCKED",
      reason: "OPERATOR_COMPLIANCE_ATTESTATION_MISSING_OR_MISMATCHED",
    });
  });
});
