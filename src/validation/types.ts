export type ValidationType =
  | "ALL"
  | "PAPER_REPLAY"
  | "PAPER_CONSISTENCY"
  | "CRASH_RECOVERY"
  | "RECONCILIATION"
  | "LIVE_GATE"
  | "OBSERVE_ONLY";

export type ValidationSessionStatus = "RUNNING" | "PASSED" | "FAILED";

export type ValidationCheckStatus = "PASS" | "FAIL" | "WARN" | "SKIPPED" | "NOT_RUN";

export type FinalReadinessStatus =
  | "VALIDATION_RUNNING"
  | "VALIDATION_FRAMEWORK_READY"
  | "VALIDATION_FAILED"
  | "VALIDATION_SKIPPED"
  | "LIVE_NOT_AUTHORIZED";

export interface ValidationCheckResult {
  checkType: ValidationType;
  checkName: string;
  status: ValidationCheckStatus;
  blocking: boolean;
  reason: string;
  metrics?: Record<string, unknown>;
  error?: Record<string, unknown>;
  startedAt?: string;
  finishedAt?: string;
}

export interface ValidationValidatorContext {
  databasePath: string;
  sourceVersion: SourceVersion;
  now: () => Date;
}

export interface ValidationValidator {
  readonly type: Exclude<ValidationType, "ALL">;
  run(context: ValidationValidatorContext): Promise<ValidationCheckResult[]>;
}

export interface ValidationArtifact {
  artifactType: string;
  artifactPath: string;
  artifactSha256: string;
  contentType: string;
}

export interface ValidationRunOptions {
  sourceDatabasePath: string;
  outputDirectory?: string;
  validationType?: ValidationType;
  useSnapshot?: boolean;
}

export interface ValidationRunReport {
  session: {
    id: string;
    validationType: ValidationType;
    status: ValidationSessionStatus;
    startedAt: string;
    finishedAt: string;
  };
  system: {
    sourceCommit: string;
    sourceDirty: boolean;
    schemaVersion: string;
    configVersion: string;
    rulesetHash: string;
    validationVersion: string;
    inputSnapshotHash: string;
    dbSnapshotHash: string;
    reportHash: string;
  };
  checks: ValidationCheckResult[];
  monitoring: Record<string, unknown>;
  execution: Record<string, unknown>;
  risk: Record<string, unknown>;
  consistency: Record<string, unknown>;
  recovery: Record<string, unknown>;
  liveGate: Record<string, unknown>;
  finalResult: {
    status: "PASS" | "FAIL";
    finalReadinessStatus: FinalReadinessStatus;
    liveAllowed: false;
    blockingFailures: string[];
    warnings: string[];
  };
}
import type { SourceVersion } from "../infra/source-version.js";
