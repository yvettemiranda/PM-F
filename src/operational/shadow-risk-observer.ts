import { DatabaseSync } from "node:sqlite";
import type { OperationalStore } from "./operational-store.js";

interface SignalRow {
  signal_id: string;
  status: string;
  execution_eligible: number;
  execution_block_reason: string | null;
  signal_type: string;
  created_at: string;
}

export class ShadowRiskObserver {
  constructor(
    private readonly databasePath: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  observe(input: {
    operationalRunId: string;
    store: OperationalStore;
    limit?: number;
  }): number {
    const database = new DatabaseSync(this.databasePath, { readOnly: true });
    try {
      const rows = database.prepare(
        `SELECT signal_id,status,execution_eligible,execution_block_reason,signal_type,created_at
         FROM signals
         ORDER BY created_at DESC,signal_id DESC
         LIMIT ?`,
      ).all(input.limit ?? 100) as unknown as SignalRow[];
      for (const signal of rows) {
        const executable = signal.status === "PUBLISHED" && signal.execution_eligible !== 0;
        input.store.recordShadowRiskObservation({
          operationalRunId: input.operationalRunId,
          signalId: signal.signal_id,
          result: executable ? "OBSERVED_ONLY" : "NOT_EXECUTABLE",
          reason: executable ? "OBSERVE_ONLY_NO_EXECUTION" : (signal.execution_block_reason ?? `SIGNAL_${signal.status}`),
          checks: {
            signalStatus: signal.status,
            executionEligible: signal.execution_eligible !== 0,
            signalType: signal.signal_type,
            observedOnly: true,
            formalRiskDecisionCreated: false,
          },
          now: this.now().toISOString(),
        });
      }
      return rows.length;
    } finally {
      database.close();
    }
  }
}

