export interface BalanceProviderInput {
  walletAddress: string;
  network: string;
}

export interface BalanceResult {
  status: "AVAILABLE" | "UNAVAILABLE";
  balanceMicros: string | null;
  reason: string | null;
  checkedAt?: string;
  source?: string;
}

export interface BalanceProvider {
  readonly providerType: "MOCK" | "PAPER" | "LIVE_READONLY";
  getBalance(input: BalanceProviderInput): Promise<BalanceResult>;
}

export interface LiveReadonlyBalanceProvider extends BalanceProvider {
  readonly providerType: "LIVE_READONLY";
}
