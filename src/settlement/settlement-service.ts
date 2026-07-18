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
  settlementRetryDue?(candidate: SettlementCandidate): boolean;
  markSettlementPending(positionId: string, reason: string): void;
  redeemSettledPosition(positionId: string, resolution: PaperResolutionSnapshot): string;
  recordSettlementError?(candidate: SettlementCandidate, error: unknown): void;
  recordSettlementUnresolved?(candidate: SettlementCandidate, resolution: PaperResolutionSnapshot): void;
  recordSettlementSuccess?(candidate: SettlementCandidate): void;
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
      if (this.store.settlementRetryDue?.(candidate) === false) continue;
      const marketEnd = Date.parse(candidate.marketEndTime);
      if (!Number.isFinite(marketEnd)) {
        this.store.recordSettlementError?.(candidate, new Error("INVALID_MARKET_END_TIME"));
        continue;
      }
      if (this.now().valueOf() < marketEnd) continue;
      if (candidate.status !== "SETTLEMENT_PENDING") {
        this.store.markSettlementPending(candidate.positionId, "MARKET_END_REACHED");
      }
      const marketKey = `${candidate.conditionId.toLowerCase()}\u0000${candidate.assetId}`;
      let resolutionPromise = resolutions.get(marketKey);
      if (!resolutionPromise) {
        resolutionPromise = this.marketData.resolution(candidate.conditionId, candidate.assetId, signal);
        resolutions.set(marketKey, resolutionPromise);
      }
      let resolution: PaperResolutionSnapshot;
      try {
        resolution = await resolutionPromise;
      } catch (error) {
        if (signal?.aborted) break;
        this.store.recordSettlementError?.(candidate, error);
        continue;
      }
      if (signal?.aborted) break;
      if (!resolution.resolved || resolution.payoutNumerator === null || resolution.payoutDenominator === null) {
        this.store.recordSettlementUnresolved?.(candidate, resolution);
        continue;
      }
      this.store.recordSettlementSuccess?.(candidate);
      try {
        completed.push(this.store.redeemSettledPosition(candidate.positionId, resolution));
      } catch (error) {
        this.store.recordSettlementError?.(candidate, error);
      }
    }
    return completed;
  }
}
