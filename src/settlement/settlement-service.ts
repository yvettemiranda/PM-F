import type { PaperMarketDataProvider, PaperResolutionSnapshot } from "../paper/types.js";

export interface SettlementCandidate {
  positionId: string;
  accountId: string;
  status: string;
  conditionId: string;
  assetId: string;
  marketEndTime: string;
}

export interface SettlementStore {
  settlementCandidates(accountId: string): SettlementCandidate[];
  markSettlementPending(positionId: string, reason: string): void;
  redeemSettledPosition(positionId: string, resolution: PaperResolutionSnapshot): string;
}

export class SettlementService {
  constructor(
    private readonly marketData: PaperMarketDataProvider,
    private readonly store: SettlementStore,
    private readonly now: () => Date,
  ) {}

  async process(accountId: string): Promise<string[]> {
    const completed: string[] = [];
    for (const candidate of this.store.settlementCandidates(accountId)) {
      if (this.now().valueOf() < Date.parse(candidate.marketEndTime)) continue;
      if (candidate.status !== "SETTLEMENT_PENDING") {
        this.store.markSettlementPending(candidate.positionId, "MARKET_END_REACHED");
      }
      const resolution = await this.marketData.resolution(candidate.conditionId, candidate.assetId);
      if (!resolution.resolved || resolution.payoutNumerator === null || resolution.payoutDenominator === null) continue;
      completed.push(this.store.redeemSettledPosition(candidate.positionId, resolution));
    }
    return completed;
  }
}
