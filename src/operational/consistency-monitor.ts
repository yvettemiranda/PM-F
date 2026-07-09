import type { SourceVersion } from "../infra/source-version.js";
import { CrashRecoveryValidation } from "../validation/crash-recovery-validation.js";
import { PaperConsistencyValidation } from "../validation/paper-consistency-validation.js";
import { ReconciliationValidation } from "../validation/reconciliation-validation.js";
import type { ValidationCheckResult } from "../validation/types.js";
import type { OperationalStore } from "./operational-store.js";
import type { OperationalMode } from "./types.js";

export class OperationalConsistencyMonitor {
  constructor(
    private readonly databasePath: string,
    private readonly sourceVersion: SourceVersion,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async run(input: {
    operationalRunId: string;
    mode: OperationalMode;
    store: OperationalStore;
    includeCrashRecovery?: boolean;
  }): Promise<ValidationCheckResult[]> {
    const validators = [
      new PaperConsistencyValidation(),
      new ReconciliationValidation(),
      ...(input.includeCrashRecovery ? [new CrashRecoveryValidation()] : []),
    ];
    const checks: ValidationCheckResult[] = [];
    for (const validator of validators) {
      const results = await validator.run({
        databasePath: this.databasePath,
        sourceVersion: this.sourceVersion,
        now: this.now,
      });
      for (const check of results) {
        input.store.recordConsistencyCheck(input.operationalRunId, check, this.now().toISOString());
        if (check.status === "FAIL" && check.blocking) {
          input.store.recordAnomaly({
            operationalRunId: input.operationalRunId,
            timestamp: this.now().toISOString(),
            module: input.mode,
            severity: "ERROR",
            errorCode: `CONSISTENCY_FAIL:${check.checkType}:${check.checkName}`,
            context: { reason: check.reason, metrics: check.metrics ?? {} },
          });
        }
      }
      checks.push(...results);
    }
    return checks;
  }
}

