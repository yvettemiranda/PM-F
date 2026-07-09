import type { RedeemAdapter, RedeemResult } from "./redeem-adapter.js";

export class FakeRedeemAdapter implements RedeemAdapter {
  readonly adapterType = "FAKE" as const;

  async redeem(input: { positionId: string; conditionId: string; assetId: string; idempotencyKey: string }): Promise<RedeemResult> {
    return { adapterType: this.adapterType, status: "CONFIRMED", raw: { fake: true, ...input } };
  }
}
