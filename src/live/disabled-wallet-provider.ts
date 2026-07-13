import type { WalletProvider } from "./wallet-provider.js";
import type { WalletAllowance, WalletBalance, WalletOutcomePositions, WalletStatus } from "./live-types.js";

export class DisabledWalletProvider implements WalletProvider {
  readonly providerType = "DISABLED" as const;

  async getAddress(): Promise<string> {
    throw new Error("WALLET_PROVIDER_DISABLED");
  }

  async getBalance(): Promise<WalletBalance> {
    return { status: "UNAVAILABLE", balanceMicros: null, reason: "WALLET_PROVIDER_DISABLED" };
  }

  async getAllowance(): Promise<WalletAllowance> {
    return { status: "UNAVAILABLE", allowanceMicros: null, reason: "WALLET_PROVIDER_DISABLED" };
  }

  async getOutcomeBalance(_assetId: string): Promise<WalletBalance> {
    return { status: "UNAVAILABLE", balanceMicros: null, reason: "WALLET_PROVIDER_DISABLED" };
  }

  async getOutcomeAllowance(_assetId: string): Promise<WalletAllowance> {
    return { status: "UNAVAILABLE", allowanceMicros: null, reason: "WALLET_PROVIDER_DISABLED" };
  }

  async getOutcomePositions(): Promise<WalletOutcomePositions> {
    return { status: "UNAVAILABLE", positions: [], reason: "WALLET_PROVIDER_DISABLED" };
  }

  async getStatus(): Promise<WalletStatus> {
    return { status: "DISABLED", reason: "WALLET_PROVIDER_DISABLED" };
  }
}
