import type { OrderAdapter } from "./order-adapter.js";
import { LiveReconciliation } from "./live-reconciliation.js";
import type { LiveStore } from "./live-store.js";

export class LiveCrashRecovery {
  constructor(
    private readonly orderAdapter: OrderAdapter,
    private readonly reconciliation: LiveReconciliation,
    private readonly store: LiveStore,
  ) {}

  async recover(accountId: string): Promise<{ passed: boolean; reason: string; recoveryRunId: string }> {
    try {
      const openOrders = await this.orderAdapter.getOpenOrders();
      let fillCount = 0;
      for (const order of openOrders) {
        const fills = await this.orderAdapter.getFills(order.externalOrderId);
        fillCount += fills.length;
      }
      const reconciliation = this.reconciliation.run(accountId);
      const status = reconciliation.passed ? "PASSED" : "FAILED";
      const recoveryRunId = this.store.saveRecoveryRun({
        accountId,
        status,
        openOrders: openOrders.length,
        fills: fillCount,
        positions: 0,
        reason: reconciliation.passed ? "RECOVERY_RECONCILED" : "RECOVERY_RECONCILIATION_FAILED",
        checks: reconciliation.checks,
      });
      this.store.updateCheckpoint(accountId, { reconciliationRunId: reconciliation.runId });
      if (!reconciliation.passed) this.store.freezeOpenPositions(accountId, "RECOVERY_RECONCILIATION_FAILED");
      return { passed: reconciliation.passed, reason: reconciliation.passed ? "RECOVERY_RECONCILED" : "RECOVERY_RECONCILIATION_FAILED", recoveryRunId };
    } catch (error) {
      const reason = error instanceof Error ? error.message : "RECOVERY_UNKNOWN_ERROR";
      const recoveryRunId = this.store.saveRecoveryRun({
        accountId,
        status: "FAILED",
        openOrders: 0,
        fills: 0,
        positions: 0,
        reason,
        checks: [{ name: "adapter_recovery", passed: false, reason }],
      });
      this.store.freezeOpenPositions(accountId, reason);
      return { passed: false, reason, recoveryRunId };
    }
  }
}
