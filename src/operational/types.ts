import type { ValidationCheckResult } from "../validation/types.js";
import type { ValidationScope } from "../validation/scoped-invariants.js";

export type OperationalMode =
  | "OBSERVE_ONLY_OPERATIONAL"
  | "PAPER_VALIDATION_OPERATIONAL"
  | "HEALTH_MONITOR_ONLY"
  | "CONSISTENCY_MONITOR_ONLY"
  | "CRASH_RECOVERY_OPERATIONAL";

export type OperationalRunStatus = "RUNNING" | "COMPLETED" | "FAILED" | "INTERRUPTED";

export type OperationalFinalStatus =
  | "OPERATIONAL_FRAMEWORK_READY"
  | "OPERATIONAL_RUNNING"
  | "OPERATIONAL_PASSED"
  | "OPERATIONAL_FAILED"
  | "LIVE_NOT_AUTHORIZED";

export type OperationalSeverity = "INFO" | "WARN" | "ERROR" | "CRITICAL";

export interface OperationalRunOptions {
  sourceDatabasePath: string;
  outputDirectory?: string;
  mode?: OperationalMode;
  durationMs?: number;
  pollIntervalMs?: number;
  useSnapshot?: boolean;
  targetWallet?: string;
  paperAccountId?: string;
  validationScope?: ValidationScope;
  now?: () => Date;
  wait?: (milliseconds: number) => Promise<void>;
}

export interface OperationalRunResult {
  operationalRunId: string;
  validationSessionId: string;
  mode: OperationalMode;
  status: OperationalRunStatus;
  finalStatus: OperationalFinalStatus;
  resultStatus: "PASS" | "FAIL" | "INCOMPLETE";
  liveAllowed: false;
  jsonReportPath: string;
  markdownReportPath: string;
  workingDatabasePath: string;
  sourceDatabasePath: string;
  paperAccountId: string | null;
  reportHash: string;
  blockingFailures: string[];
  warnings: string[];
}

export interface OperationalHealthSnapshot {
  uptimeMs: number;
  databaseSizeBytes: number;
  migrationVersion: string | null;
  databaseIntegrityStatus: string;
  apiFailureCount: number;
  reconnectCount: number;
  duplicateEventCount: number;
  missedEventCount: number;
}

export interface OperationalReport {
  run: {
    id: string;
    validationSessionId: string;
    mode: OperationalMode;
    status: OperationalRunStatus;
    startedAt: string;
    stoppedAt: string;
    runtimeDurationMs: number;
  };
  system: {
    sourceCommit: string;
    sourceDirty: boolean;
    schemaVersion: string;
    configVersion: string;
    rulesetHash: string;
    operationalVersion: string;
    sourceDatabasePath: string;
    workingDatabasePath: string;
    reportHash: string;
  };
  runtime: {
    heartbeatCount: number;
    anomalyCount: number;
    criticalAnomalyCount: number;
    errorAnomalyCount: number;
    checkpointCount: number;
  };
  monitoring: Record<string, unknown>;
  execution: Record<string, unknown>;
  risk: Record<string, unknown>;
  consistency: {
    checks: ValidationCheckResult[];
    counts: Record<string, number>;
  };
  recovery: Record<string, unknown>;
  finalResult: {
    status: "PASS" | "FAIL" | "INCOMPLETE";
    finalStatus: OperationalFinalStatus;
    liveAllowed: false;
    blockingFailures: string[];
    warnings: string[];
  };
}
