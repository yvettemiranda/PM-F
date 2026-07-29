import { describe, expect, it, vi } from "vitest";
import { discoverPolymarketTradingWallet } from "../src/operator/polymarket-trading-wallet-discovery.js";

const signer = "0xfb54e3e216afd5b1892134d499024271faae5da4";
const safe = "0xfdcc2ff22afc959ed0483e55ba0f71917bc21321";

describe("discoverPolymarketTradingWallet", () => {
  it("uses a distinct Gamma profile wallet only after its Safe owner matches the signer", async () => {
    const profile = vi.fn(async () => ({ proxyWallet: safe }));
    const safeOwners = vi.fn(async () => [signer]);

    await expect(discoverPolymarketTradingWallet(signer, {
      profile,
      safeOwners,
    })).resolves.toEqual({
      walletAddress: signer,
      tradingWalletAddress: safe,
      signatureType: "POLY_GNOSIS_SAFE",
      source: "GAMMA_PROFILE_GNOSIS_SAFE",
    });
    expect(profile).toHaveBeenCalledWith(signer);
    expect(safeOwners).toHaveBeenCalledWith(safe);
  });

  it("fails closed when the profile wallet is not owned by the connected signer", async () => {
    await expect(discoverPolymarketTradingWallet(signer, {
      profile: vi.fn(async () => ({ proxyWallet: safe })),
      safeOwners: vi.fn(async () => ["0x0000000000000000000000000000000000000002"]),
    })).rejects.toThrow("LIVE_PRODUCTION_TRADING_WALLET_OWNER_MISMATCH");
  });

  it("keeps a standalone EOA when the profile has no distinct trading wallet", async () => {
    const safeOwners = vi.fn();
    await expect(discoverPolymarketTradingWallet(signer, {
      profile: vi.fn(async () => ({ proxyWallet: null })),
      safeOwners,
    })).resolves.toEqual({
      walletAddress: signer,
      tradingWalletAddress: signer,
      signatureType: "EOA",
      source: "SIGNER_EOA",
    });
    expect(safeOwners).not.toHaveBeenCalled();
  });
});
