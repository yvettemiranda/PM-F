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

  async process(accountId: string, signal?: AbortSignal): Promise<string[]> {
    const completed: string[] = [];
    const resolutions = new Map<string, Promise<PaperResolutionSnapshot>>();
    for (const candidate of this.store.settlementCandidates(accountId)) {
      if (signal?.aborted) break;
      if (this.now().valueOf() < Date.parse(candidate.marketEndTime)) continue;
      if (candidate.status !== "SETTLEMENT_PENDING") {
        this.store.markSettlementPending(candidate.positionId, "MARKET_END_REACHED");
      }
      const marketKey = `${candidate.conditionId.toLowerCase()}\u0000${candidate.assetId}`;
      let resolutionPromise = resolutions.get(marketKey);
      if (!resolutionPromise) {
        resolutionPromise = this.marketData.resolution(candidate.conditionId, candidate.assetId, signal);
        resolutions.set(marketKey, resolutionPromise);
      }
      const resolution = await resolutionPromise;
      if (signal?.aborted) break;
      if (!resolution.resolved || resolution.payoutNumerator === null || resolution.payoutDenominator === null) continue;
      completed.push(this.store.redeemSettledPosition(candidate.positionId, resolution));
    }
    return completed;
  }
}
