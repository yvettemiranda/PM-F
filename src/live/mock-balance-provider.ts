import type { BalanceProvider, BalanceProviderInput, BalanceResult } from "./balance-provider.js";

export class MockBalanceProvider implements BalanceProvider {
  readonly providerType = "MOCK" as const;

  constructor(private readonly result: BalanceResult) {}

  async getBalance(_input: BalanceProviderInput): Promise<BalanceResult> {
    return this.result;
  }
}
