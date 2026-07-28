import { AssetType } from "@polymarket/clob-client-v2";
import { describe, expect, it, vi } from "vitest";
import {
  PolymarketReadonlyBalanceProvider,
  PolymarketReadonlyWalletProvider,
} from "../src/live/polymarket-readonly-wallet-provider.js";
import type { LiveWalletRuntimeBinding } from "../src/operator/live-wallet-session.js";

const wallet = "0x0000000000000000000000000000000000000001";

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

function clob(overrides: Record<string, unknown> = {}) {
  return {
    getBalanceAllowance: vi.fn(async () => ({
      balance: "12500000",
      allowances: {
        exchange: "10000000",
        negRiskExchange: "9000000",
      },
    })),
    getClosedOnlyMode: vi.fn(async () => ({ closed_only: false })),
    ...overrides,
  };
}

describe("PolymarketReadonlyWalletProvider", () => {
  it("reads exact collateral/outcome base units and uses the most conservative allowance", async () => {
    const client = clob();
    const provider = new PolymarketReadonlyWalletProvider({
      walletBinding: binding(),
      funderAddress: wallet,
      clobClient: client as never,
      positionsApi: {
        allPositions: vi.fn(async () => ({
          rows: [],
          captures: [],
          merged: {} as never,
        })),
      } as never,
      chainIdProvider: vi.fn(async () => 137),
    });

    await expect(provider.getChainId()).resolves.toBe(137);
    await expect(provider.getBalance()).resolves.toEqual({
      status: "AVAILABLE",
      balanceMicros: "12500000",
      reason: null,
    });
    await expect(provider.getAllowance()).resolves.toEqual({
      status: "AVAILABLE",
      allowanceMicros: "9000000",
      reason: null,
    });
    await provider.getOutcomeBalance("123");
    expect(client.getBalanceAllowance).toHaveBeenLastCalledWith({
      asset_type: AssetType.CONDITIONAL,
      token_id: "123",
    });
  });

  it("projects the complete public position list in micros for reconciliation", async () => {
    const provider = new PolymarketReadonlyWalletProvider({
      walletBinding: binding(),
      funderAddress: wallet,
      clobClient: clob() as never,
      positionsApi: {
        allPositions: vi.fn(async () => ({
          rows: [
            {
              proxyWallet: wallet,
              asset: "456",
              conditionId: "condition-1",
              size: "1.234567",
              avgPrice: "0.5",
              currentValue: "0.61",
            },
            {
              proxyWallet: wallet,
              asset: "123",
              conditionId: "condition-2",
              size: "0",
              avgPrice: "0",
              currentValue: "0",
            },
          ],
          captures: [],
          merged: {} as never,
        })),
      } as never,
      chainIdProvider: vi.fn(async () => 137),
    });

    await expect(provider.getOutcomePositions()).resolves.toEqual({
      status: "AVAILABLE",
      positions: [{ assetId: "456", balanceMicros: "1234567" }],
      reason: null,
    });
  });

  it("fails closed on missing allowances, closed-only status and read errors", async () => {
    const provider = new PolymarketReadonlyWalletProvider({
      walletBinding: binding(),
      funderAddress: wallet,
      clobClient: clob({
        getBalanceAllowance: vi.fn(async () => ({ balance: "1", allowances: {} })),
        getClosedOnlyMode: vi.fn(async () => ({ closed_only: true })),
      }) as never,
      positionsApi: {
        allPositions: vi.fn(async () => {
          throw new Error("POSITIONS_OFFLINE");
        }),
      } as never,
      chainIdProvider: vi.fn(async () => 137),
    });

    await expect(provider.getAllowance()).resolves.toMatchObject({
      status: "UNAVAILABLE",
      reason: "LIVE_WALLET_ALLOWANCE_MISSING",
    });
    await expect(provider.getStatus()).resolves.toEqual({
      status: "DISABLED",
      reason: "CLOB_ACCOUNT_CLOSED_ONLY",
    });
    await expect(provider.getOutcomePositions()).resolves.toEqual({
      status: "UNAVAILABLE",
      positions: [],
      reason: "POSITIONS_OFFLINE",
    });
  });

  it("binds the Live balance provider to the exact wallet and Polygon network", async () => {
    const walletProvider = new PolymarketReadonlyWalletProvider({
      walletBinding: binding(),
      funderAddress: wallet,
      clobClient: clob() as never,
      positionsApi: {
        allPositions: vi.fn(async () => ({ rows: [], captures: [], merged: {} as never })),
      } as never,
      chainIdProvider: vi.fn(async () => 137),
    });
    const provider = new PolymarketReadonlyBalanceProvider(walletProvider);

    await expect(provider.getBalance({ walletAddress: wallet, network: "POLYGON" })).resolves.toMatchObject({
      status: "AVAILABLE",
      balanceMicros: "12500000",
      source: "POLYMARKET_CLOB_BALANCE_ALLOWANCE",
    });
    await expect(provider.getBalance({
      walletAddress: "0x0000000000000000000000000000000000000002",
      network: "POLYGON",
    })).resolves.toMatchObject({
      status: "UNAVAILABLE",
      reason: "LIVE_BALANCE_WALLET_MISMATCH",
    });
  });
});
