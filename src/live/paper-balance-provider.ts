import type { DatabaseSync } from "node:sqlite";
import type { BalanceProvider, BalanceProviderInput, BalanceResult } from "./balance-provider.js";

export class PaperBalanceProvider implements BalanceProvider {
  readonly providerType = "PAPER" as const;

  constructor(
    private readonly database: DatabaseSync,
    private readonly paperAccountId: string,
  ) {}

  async getBalance(_input: BalanceProviderInput): Promise<BalanceResult> {
    const row = this.database.prepare(
      `SELECT cash_balance_micros,reserved_balance_micros
       FROM portfolio_projection_runs
       WHERE paper_account_id=?
       ORDER BY created_at DESC LIMIT 1`,
    ).get(this.paperAccountId) as { cash_balance_micros: string; reserved_balance_micros: string } | undefined;
    if (row) {
      return {
        status: "AVAILABLE",
        balanceMicros: (BigInt(row.cash_balance_micros) - BigInt(row.reserved_balance_micros)).toString(),
        reason: null,
      };
    }
    const account = this.database.prepare(
      "SELECT cash_balance_micros,reserved_balance_micros FROM paper_accounts WHERE paper_account_id=?",
    ).get(this.paperAccountId) as { cash_balance_micros: string; reserved_balance_micros: string } | undefined;
    if (!account) return { status: "UNAVAILABLE", balanceMicros: null, reason: "PAPER_ACCOUNT_NOT_FOUND" };
    return {
      status: "AVAILABLE",
      balanceMicros: (BigInt(account.cash_balance_micros) - BigInt(account.reserved_balance_micros)).toString(),
      reason: null,
    };
  }
}
