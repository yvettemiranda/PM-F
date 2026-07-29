import { AssetType, Chain, getContractConfig } from "@polymarket/clob-client-v2";
import { describe, expect, it, vi } from "vitest";
import {
  BrowserWalletAllowanceManager,
  BrowserWalletRedeemAdapter,
} from "../src/live/browser-wallet-onchain.js";
import type { LiveWalletRuntimeBinding } from "../src/operator/live-wallet-session.js";

const wallet = "0x0000000000000000000000000000000000000001";
const tx1 = `0x${"1".repeat(64)}`;
const tx2 = `0x${"2".repeat(64)}`;

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

describe("browser wallet on-chain operations", () => {
  it("requests exact-cap collateral approval and Exchange V3 outcome approval", async () => {
    const contracts = getContractConfig(Chain.POLYGON);
    const requestTransaction = vi.fn()
      .mockResolvedValueOnce(tx1)
      .mockResolvedValueOnce(tx2);
    const waitForSuccess = vi.fn(async (transactionHash: string) => ({
      transactionHash,
      blockNumber: 100n,
      confirmations: 2,
    }));
    const updateBalanceAllowance = vi.fn(async () => undefined);
    const getBalanceAllowance = vi.fn(async (input: { asset_type: AssetType }) => ({
      balance: "10000000",
      allowances: { [contracts.exchangeV3]: "0" },
      input,
    }));
    const manager = new BrowserWalletAllowanceManager({
      walletBinding: binding(),
      requestBroker: { requestTransaction },
      receiptProvider: { waitForSuccess },
      clobClient: { getBalanceAllowance, updateBalanceAllowance },
      bankrollMicros: "10000000",
      signatureType: "EOA",
      tradingWalletAddress: wallet,
    });

    await expect(manager.prepare()).resolves.toEqual({
      collateralApprovalTransaction: tx1,
      outcomeApprovalTransaction: tx2,
      ready: true,
    });
    expect(requestTransaction).toHaveBeenCalledTimes(2);
    expect(requestTransaction.mock.calls[0]?.[1]).toMatchObject({
      to: contracts.collateral,
      data: expect.stringMatching(/^0x[0-9a-f]+$/),
    });
    expect(requestTransaction.mock.calls[1]?.[1]).toMatchObject({
      to: contracts.conditionalTokens,
      data: expect.stringMatching(/^0x[0-9a-f]+$/),
    });
    expect(waitForSuccess).toHaveBeenCalledTimes(2);
    expect(updateBalanceAllowance).toHaveBeenCalledWith({ asset_type: AssetType.COLLATERAL });
    expect(updateBalanceAllowance).toHaveBeenCalledWith({ asset_type: AssetType.CONDITIONAL });
  });

  it("does not send approval transactions when both Exchange V3 allowances are ready", async () => {
    const contracts = getContractConfig(Chain.POLYGON);
    const requestTransaction = vi.fn();
    const manager = new BrowserWalletAllowanceManager({
      walletBinding: binding(),
      requestBroker: { requestTransaction },
      receiptProvider: { waitForSuccess: vi.fn() },
      clobClient: {
        getBalanceAllowance: vi.fn(async () => ({
          balance: "10000000",
          allowances: { [contracts.exchangeV3]: "10000000" },
        })),
        updateBalanceAllowance: vi.fn(),
      },
      bankrollMicros: "10000000",
      signatureType: "EOA",
      tradingWalletAddress: wallet,
    });

    await expect(manager.prepare()).resolves.toMatchObject({ ready: true });
    expect(requestTransaction).not.toHaveBeenCalled();
  });

  it("accepts an already-approved Gnosis Safe without asking the owner EOA to approve again", async () => {
    const contracts = getContractConfig(Chain.POLYGON);
    const requestTransaction = vi.fn();
    const manager = new BrowserWalletAllowanceManager({
      walletBinding: binding(),
      requestBroker: { requestTransaction },
      receiptProvider: { waitForSuccess: vi.fn() },
      clobClient: {
        getBalanceAllowance: vi.fn(async () => ({
          balance: "10000000",
          allowances: { [contracts.exchangeV3]: "10000000" },
        })),
        updateBalanceAllowance: vi.fn(),
      },
      bankrollMicros: "10000000",
      signatureType: "POLY_GNOSIS_SAFE",
      tradingWalletAddress: "0xfdcc2ff22afc959ed0483e55ba0f71917bc21321",
    });

    await expect(manager.prepare()).resolves.toEqual({
      collateralApprovalTransaction: null,
      outcomeApprovalTransaction: null,
      ready: true,
    });
    expect(requestTransaction).not.toHaveBeenCalled();
  });

  it("defers a Gnosis Safe allowance until an actual order needs it", async () => {
    const contracts = getContractConfig(Chain.POLYGON);
    const manager = new BrowserWalletAllowanceManager({
      walletBinding: binding(),
      requestBroker: { requestTransaction: vi.fn() },
      receiptProvider: { waitForSuccess: vi.fn() },
      clobClient: {
        getBalanceAllowance: vi.fn(async () => ({
          balance: "10000000",
          allowances: { [contracts.exchangeV3]: "0" },
        })),
        updateBalanceAllowance: vi.fn(),
      },
      bankrollMicros: "10000000",
      signatureType: "POLY_GNOSIS_SAFE",
      tradingWalletAddress: "0xfdcc2ff22afc959ed0483e55ba0f71917bc21321",
    });

    await expect(manager.prepare()).resolves.toEqual({
      collateralApprovalTransaction: null,
      outcomeApprovalTransaction: null,
      ready: false,
      reason: "LIVE_SMART_WALLET_ALLOWANCE_DEFERRED",
    });
  });

  it("does not request an EOA approval when the wallet currently has no collateral", async () => {
    const contracts = getContractConfig(Chain.POLYGON);
    const requestTransaction = vi.fn();
    const manager = new BrowserWalletAllowanceManager({
      walletBinding: binding(),
      requestBroker: { requestTransaction },
      receiptProvider: { waitForSuccess: vi.fn() },
      clobClient: {
        getBalanceAllowance: vi.fn(async () => ({
          balance: "0",
          allowances: { [contracts.exchangeV3]: "0" },
        })),
        updateBalanceAllowance: vi.fn(),
      },
      bankrollMicros: "10000000",
      signatureType: "EOA",
      tradingWalletAddress: wallet,
    });

    await expect(manager.prepare()).resolves.toEqual({
      collateralApprovalTransaction: null,
      outcomeApprovalTransaction: null,
      ready: false,
      reason: "LIVE_WALLET_SETUP_DEFERRED_NO_COLLATERAL",
    });
    expect(requestTransaction).not.toHaveBeenCalled();
  });

  it("redeems a binary resolved EOA position only after a confirmed receipt", async () => {
    const contracts = getContractConfig(Chain.POLYGON);
    const requestTransaction = vi.fn(async () => tx1);
    const adapter = new BrowserWalletRedeemAdapter({
      walletBinding: binding(),
      requestBroker: { requestTransaction },
      receiptProvider: {
        waitForSuccess: vi.fn(async () => ({
          transactionHash: tx1,
          blockNumber: 101n,
          confirmations: 2,
        })),
      },
      signatureType: "EOA",
      tradingWalletAddress: wallet,
    });
    const conditionId = `0x${"a".repeat(64)}`;

    await expect(adapter.redeem({
      positionId: "position-1",
      conditionId,
      assetId: "123",
      idempotencyKey: "redeem-1",
    })).resolves.toMatchObject({
      adapterType: "LIVE",
      status: "CONFIRMED",
      raw: { transactionHash: tx1, conditionId },
    });
    expect(requestTransaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        to: contracts.conditionalTokens,
        data: expect.stringMatching(/^0x[0-9a-f]+$/),
      }),
    );
  });
});
