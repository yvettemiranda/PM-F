import type { WalletProvider } from "./wallet-provider.js";
import type { WalletAllowance, WalletBalance, WalletOutcomePositions, WalletStatus } from "./live-types.js";

export class FakeWalletProvider implements WalletProvider {
  readonly providerType = "FAKE" as const;

  constructor(private readonly input: {
    address?: string;
    balanceMicros?: string;
    allowanceMicros?: string;
    outcomeBalanceMicros?: string;
    outcomeAllowanceMicros?: string;
    outcomePositions?: Record<string, string>;
    outcomePositionsStatus?: "AVAILABLE" | "UNAVAILABLE";
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

  async getOutcomeBalance(assetId: string): Promise<WalletBalance> {
    const configured = this.input.outcomePositions?.[assetId] ?? this.input.outcomeBalanceMicros;
    return { status: "AVAILABLE", balanceMicros: configured ?? "1000000000", reason: null };
  }

  async getOutcomeAllowance(_assetId: string): Promise<WalletAllowance> {
    return {
      status: "AVAILABLE",
      allowanceMicros: this.input.outcomeAllowanceMicros ?? "1000000000",
      reason: null,
    };
  }

  async getOutcomePositions(): Promise<WalletOutcomePositions> {
    if (this.input.outcomePositionsStatus === "UNAVAILABLE" || this.input.outcomePositions === undefined) {
      return { status: "UNAVAILABLE", positions: [], reason: "FAKE_OUTCOME_POSITIONS_UNAVAILABLE" };
    }
    return {
      status: "AVAILABLE",
      positions: Object.entries(this.input.outcomePositions).map(([assetId, balanceMicros]) => ({
        assetId,
        balanceMicros,
      })),
      reason: null,
    };
  }

  async getStatus(): Promise<WalletStatus> {
    return this.input.status ?? { status: "ACTIVE", reason: null };
  }
}
