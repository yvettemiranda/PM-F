import type { WalletProvider } from "./wallet-provider.js";
import type { WalletAllowance, WalletBalance, WalletStatus } from "./live-types.js";

export class FakeWalletProvider implements WalletProvider {
  readonly providerType = "FAKE" as const;

  constructor(private readonly input: {
    address?: string;
    balanceMicros?: string;
    allowanceMicros?: string;
    status?: WalletStatus;
  } = {}) {}

  async getAddress(): Promise<string> {
    return this.input.address ?? "0x0000000000000000000000000000000000000001";
  }

  async getBalance(): Promise<WalletBalance> {
    return { status: "AVAILABLE", balanceMicros: this.input.balanceMicros ?? "1000000000", reason: null };
  }

  async getAllowance(): Promise<WalletAllowance> {
    return { status: "AVAILABLE", allowanceMicros: this.input.allowanceMicros ?? "1000000000", reason: null };
  }

  async getStatus(): Promise<WalletStatus> {
    return this.input.status ?? { status: "ACTIVE", reason: null };
  }
}
