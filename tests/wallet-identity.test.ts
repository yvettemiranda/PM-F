import { describe, expect, it } from "vitest";
import { buildWalletIdentityReport } from "../src/services/wallet-identity.js";

const address = "0x0c0e270cf879583d6a0142fc817e05b768d0434e";
const proxyCode =
  "0x363d3d373d3d3d363d7344e999d5c2f66ef0861317f9a4805ac2e90aeb4f5af43d82803e903d91602b57fd5bf3";

describe("wallet identity", () => {
  it("confirms the known legacy proxy evidence chain", () => {
    const report = buildWalletIdentityReport({
      address,
      profile: { proxyWallet: address, createdAt: "2021-08-04T16:00:41.524Z" },
      trades: [
        {
          proxyWallet: address,
          transactionHash: "0x1",
          conditionId: "0x2",
          asset: "1",
          side: "BUY",
          price: 0.5,
          size: 10,
          timestamp: 1_700_000_000,
        },
      ],
      positions: [],
      contractCode: proxyCode,
      relayerSafeDeployed: null,
      relayerWalletDeployed: null,
      tradeHistoryComplete: false,
      observedAt: new Date("2026-07-07T00:00:00Z"),
    });
    expect(report.status).toBe("IDENTITY_CONFIRMED");
    expect(report.walletType).toBe("PROXY_WALLET");
    expect(report.implementationAddress).toBe("0x44e999d5c2f66ef0861317f9a4805ac2e90aeb4f");
  });

  it("does not guess an unknown contract wallet", () => {
    const report = buildWalletIdentityReport({
      address,
      profile: { proxyWallet: address },
      trades: [],
      positions: [],
      contractCode: "0x60006000",
      relayerSafeDeployed: null,
      relayerWalletDeployed: null,
      tradeHistoryComplete: false,
    });
    expect(report.status).toBe("IDENTITY_UNKNOWN");
    expect(report.walletType).toBe("UNKNOWN");
  });

  it("does not treat relayer deployment checks as mutually exclusive type evidence", () => {
    const report = buildWalletIdentityReport({
      address,
      profile: { proxyWallet: address, createdAt: "2021-08-04T16:00:41.524Z" },
      trades: [
        {
          proxyWallet: address,
          transactionHash: "0x1",
          conditionId: "0x2",
          asset: "1",
          side: "BUY",
          price: 0.5,
          size: 10,
          timestamp: 1_700_000_000,
        },
      ],
      positions: [],
      contractCode: proxyCode,
      relayerSafeDeployed: true,
      relayerWalletDeployed: true,
      tradeHistoryComplete: false,
    });

    expect(report.status).toBe("IDENTITY_CONFIRMED");
    expect(report.walletType).toBe("PROXY_WALLET");
    expect(report.evidence.filter((item) => item.source.includes("RELAYER"))).toHaveLength(2);
  });

  it("reports a conflict when profile identity and contract address disagree", () => {
    const report = buildWalletIdentityReport({
      address,
      profile: { proxyWallet: "0x0000000000000000000000000000000000000002" },
      trades: [],
      positions: [],
      contractCode: proxyCode,
      relayerSafeDeployed: null,
      relayerWalletDeployed: null,
      tradeHistoryComplete: false,
    });

    expect(report.status).toBe("IDENTITY_CONFLICT");
    expect(report.walletType).toBe("UNKNOWN");
  });
});
