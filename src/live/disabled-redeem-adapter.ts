import type { RedeemAdapter, RedeemResult } from "./redeem-adapter.js";

export class DisabledRedeemAdapter implements RedeemAdapter {
  readonly adapterType = "DISABLED" as const;

  async redeem(): Promise<RedeemResult> {
    return { adapterType: this.adapterType, status: "DISABLED", raw: { reason: "REDEEM_DISABLED" } };
  }
}
