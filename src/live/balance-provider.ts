export interface BalanceProviderInput {
  walletAddress: string;
  network: string;
}

export interface BalanceResult {
  status: "AVAILABLE" | "UNAVAILABLE";
  balanceMicros: string | null;
  reason: string | null;
}

export interface BalanceProvider {
  readonly providerType: "MOCK" | "PAPER";
  getBalance(input: BalanceProviderInput): Promise<BalanceResult>;
}
