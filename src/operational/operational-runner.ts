import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { RULESET_HASH, stableJson } from "../domain/versioning.js";
import { PaperExecutor } from "../paper/paper-executor.js";
import type {
  PaperFeeSnapshot,
  PaperMarketDataProvider,
  PaperOrderbookSnapshot,
  PaperResolutionSnapshot,
} from "../paper/types.js";
import { resolveSourceVersion, type SourceVersion } from "../infra/source-version.js";
import { pruneCompletedRunSnapshots } from "../infra/run-snapshot-retention.js";
import { prepareValidationDatabaseSnapshot } from "../validation/database-snapshot.js";
import { check } from "../validation/checks.js";
import type { ValidationCheckResult } from "../validation/types.js";
import { OperationalConsistencyMonitor } from "./consistency-monitor.js";
import { recordOperationalError } from "./error-monitor.js";
import { OperationalHealthMonitor } from "./health-monitor.js";
import { OperationalLock } from "./operational-lock.js";
import { OperationalStore } from "./operational-store.js";
import { buildOperationalReport, writeOperationalReports } from "./report-generator.js";
import { ShadowRiskObserver } from "./shadow-risk-observer.js";
import type {
  OperationalFinalStatus,
  OperationalMode,
  OperationalRunOptions,
  OperationalRunResult,
  OperationalRunStatus,
} from "./types.js";

class FakeOperationalMarketDataProvider implements PaperMarketDataProvider {
  constructor(private readonly now: () => Date) {}

  async orderbook(assetId: string, conditionId: string): Promise<PaperOrderbookSnapshot> {
    const timestamp = this.now().toISOString();
    return {
      assetId,
      conditionId,
      marketSnapshotTime: timestamp,
      receivedAt: timestamp,
      sourceUrl: "fake://operational/orderbook",
      bids: [],
      asks: [],
    };
  }

  async fee(assetId: string): Promise<PaperFeeSnapshot> {
    return {
      assetId,
      status: "UNAVAILABLE",
      baseFee: null,
      feeRatePpm: null,
      exponent: null,
      sourceUrl: "fake://operational/fee",
      snapshotTime: this.now().toISOString(),
    };
  }

  async resolution(conditionId: string, assetId: string): Promise<PaperResolutionSnapshot> {
    return {
      conditionId,
      assetId,
      resolved: false,
      payoutNumerator: null,
      payoutDenominator: null,
      sourceUrl: "fake://operational/resolution",
      snapshotTime: this.now().toISOString(),
      raw: { fake: true },
    };
  }
}

function stateHash(value: unknown): string {
  return RULESET_HASH.slice(0, 16) + ":" + Buffer.from(stableJson(value)).toString("base64url");
}

function parseOptionalTimestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export class OperationalRunner {
  constructor(
    private readonly sourceVersion: SourceVersion = resolveSourceVersion(),
    private readonly defaultNow: () => Date = () => new Date(),
  ) {}

  async run(options: OperationalRunOptions): Promise<OperationalRunResult> {
    const now = options.now ?? this.defaultNow;
    const wait = options.wait ?? ((milliseconds: number) => new Promise<void>((resolveWait) => setTimeout(resolveWait, milliseconds)));
    const mode = options.mode ?? "HEALTH_MONITOR_ONLY";
    const useSnapshot = options.useSnapshot ?? true;
    if (!useSnapshot) throw new Error("OPERATIONAL_SNAPSHOT_REQUIRED");
    const outputDirectory = resolve(options.outputDirectory ?? "data/operational");
    const operationalRunId = `operational-${randomUUID()}`;
    const validationSessionId = `operational-validation-${randomUUID()}`;
    const startedAt = now().toISOString();
    const snapshot = await prepareValidationDatabaseSnapshot({
      sourceDatabasePath: options.sourceDatabasePath,
      outputDirectory,
      sessionId: operationalRunId,
      useSnapshot,
      sourceVersion: this.sourceVersion,
    });
    const store = new OperationalStore(snapshot.workingDatabasePath);
    try {
      const lock = new OperationalLock(store, now);
      let status: OperationalRunStatus = "COMPLETED";
      let finalStatus: OperationalFinalStatus = "OPERATIONAL_FRAMEWORK_READY";
      let paperAccountId: string | null = options.paperAccountId ?? null;
      const checks: ValidationCheckResult[] = [];
      try {
        store.startRun({
        operationalRunId,
        validationSessionId,
        mode,
        startedAt,
        sourceVersion: this.sourceVersion,
        workingDatabasePath: snapshot.workingDatabasePath,
        sourceDatabasePath: snapshot.sourceDatabasePath,
        paperAccountId,
        targetWallet: options.targetWallet ?? null,
      });
        lock.acquire(`operational:${mode}`, operationalRunId);
        await this.runLoop({
        mode,
        operationalRunId,
        startedAt,
        store,
        snapshotDatabasePath: snapshot.workingDatabasePath,
        now,
        wait,
        durationMs: options.durationMs ?? 0,
        pollIntervalMs: options.pollIntervalMs ?? 1_000,
        checks,
        paperAccountId,
        setPaperAccountId: (value) => {
          paperAccountId = value;
        },
      });
        if (mode === "CRASH_RECOVERY_OPERATIONAL") {
          checks.push(...await new OperationalConsistencyMonitor(snapshot.workingDatabasePath, this.sourceVersion, now).run({
          operationalRunId,
          mode,
          store,
          includeCrashRecovery: true,
        }));
        } else if (mode !== "HEALTH_MONITOR_ONLY" && mode !== "CONSISTENCY_MONITOR_ONLY") {
          checks.push(...await new OperationalConsistencyMonitor(snapshot.workingDatabasePath, this.sourceVersion, now).run({
          operationalRunId,
          mode,
          store,
          includeCrashRecovery: false,
        }));
        }
        checks.push(...this.coverageChecks({
          databasePath: snapshot.workingDatabasePath,
          mode,
          startedAt,
          paperAccountId,
          usedSnapshot: snapshot.usedSnapshot,
          now,
        }));
      } catch (error) {
        status = "FAILED";
        finalStatus = "OPERATIONAL_FAILED";
        recordOperationalError({
          store,
          operationalRunId,
          module: mode,
          error,
          severity: "ERROR",
          now,
        });
      } finally {
        try {
          lock.release(`operational:${mode}`, operationalRunId);
        } catch {
          // Lock release failure is reported through the final consistency/anomaly counts.
        }
      }
      const stoppedAt = now().toISOString();
      const runtimeDurationMs = Math.max(0, Date.parse(stoppedAt) - Date.parse(startedAt));
      const report = buildOperationalReport({
      databasePath: snapshot.workingDatabasePath,
      operationalRunId,
      validationSessionId,
      mode,
      status,
      startedAt,
      stoppedAt,
      runtimeDurationMs,
      sourceVersion: this.sourceVersion,
      sourceDatabasePath: snapshot.sourceDatabasePath,
      workingDatabasePath: snapshot.workingDatabasePath,
      checks,
    });
      if (finalStatus !== "OPERATIONAL_FAILED") finalStatus = report.finalResult.finalStatus;
      store.finishRun({
      operationalRunId,
      status,
      stoppedAt,
      runtimeDurationMs,
      finalStatus,
      result: report.finalResult,
    });
      const written = writeOperationalReports({ outputDirectory, operationalRunId, report });
      store.recordReport({
      operationalRunId,
      reportFormat: "JSON",
      reportPath: written.jsonPath,
      reportHash: written.jsonHash,
      summary: report.finalResult,
      now: stoppedAt,
    });
      store.recordReport({
      operationalRunId,
      reportFormat: "MARKDOWN",
      reportPath: written.markdownPath,
      reportHash: written.markdownHash,
      summary: report.finalResult,
      now: stoppedAt,
    });
      if (snapshot.usedSnapshot) {
        pruneCompletedRunSnapshots({
          outputDirectory,
          currentRunId: operationalRunId,
          currentWorkingDatabasePath: snapshot.workingDatabasePath,
          runPrefix: "operational-",
          reportFileName: "operational-report.json",
        });
      }
      return {
        operationalRunId,
        validationSessionId,
        mode,
        status,
        finalStatus,
        resultStatus: report.finalResult.status,
        liveAllowed: false,
        jsonReportPath: written.jsonPath,
        markdownReportPath: written.markdownPath,
        workingDatabasePath: snapshot.workingDatabasePath,
        sourceDatabasePath: snapshot.sourceDatabasePath,
        paperAccountId,
        reportHash: report.system.reportHash,
        blockingFailures: report.finalResult.blockingFailures,
        warnings: report.finalResult.warnings,
      };
    } finally {
      store.close();
    }
  }

  private async runLoop(input: {
    mode: OperationalMode;
    operationalRunId: string;
    startedAt: string;
    store: OperationalStore;
    snapshotDatabasePath: string;
    now: () => Date;
    wait: (milliseconds: number) => Promise<void>;
    durationMs: number;
    pollIntervalMs: number;
    checks: ValidationCheckResult[];
    paperAccountId: string | null;
    setPaperAccountId: (value: string) => void;
  }): Promise<void> {
    const deadline = Date.now() + Math.max(0, input.durationMs);
    do {
      const timestamp = input.now().toISOString();
      const uptimeMs = Math.max(0, Date.parse(timestamp) - Date.parse(input.startedAt));
      input.store.recordHeartbeat({
        operationalRunId: input.operationalRunId,
        timestamp,
        uptimeMs,
      });
      await this.runCycle(input);
      if (input.durationMs <= 0 || Date.now() >= deadline) break;
      await input.wait(Math.min(input.pollIntervalMs, Math.max(0, deadline - Date.now())));
    } while (true);
  }

  private coverageChecks(input: {
    databasePath: string;
    mode: OperationalMode;
    startedAt: string;
    paperAccountId: string | null;
    usedSnapshot: boolean;
    now: () => Date;
  }): ValidationCheckResult[] {
    if (input.mode === "OBSERVE_ONLY_OPERATIONAL") {
      return [check({
        checkType: "OBSERVE_ONLY",
        checkName: "operational_observe_realtime_coverage",
        status: "NOT_RUN",
        blocking: false,
        reason: input.usedSnapshot
          ? "STATIC_SNAPSHOT_IS_NOT_REALTIME_OBSERVE_SOAK"
          : "OPERATIONAL_OBSERVER_DOES_NOT_INGEST_WALLET_EVENTS",
        metrics: { usedSnapshot: input.usedSnapshot },
        now: input.now,
      })];
    }
    if (input.mode !== "PAPER_VALIDATION_OPERATIONAL") return [];
    const database = new DatabaseSync(input.databasePath, { readOnly: true });
    try {
      const consumed = input.paperAccountId
        ? (database.prepare(
          "SELECT count(*) count FROM paper_signal_consumptions WHERE paper_account_id=? AND consumed_at>=?",
        ).get(input.paperAccountId, input.startedAt) as { count: number }).count
        : 0;
      return [check({
        checkType: "PAPER_REPLAY",
        checkName: "operational_paper_signal_coverage",
        status: consumed > 0 ? "PASS" : "NOT_RUN",
        blocking: false,
        reason: consumed > 0 ? "OK" : "NO_NEW_PAPER_SIGNAL_CONSUMED",
        metrics: { consumed, paperAccountId: input.paperAccountId, usedSnapshot: input.usedSnapshot },
        now: input.now,
      })];
    } finally {
      database.close();
    }
  }

  private async runCycle(input: {
    mode: OperationalMode;
    operationalRunId: string;
    startedAt: string;
    store: OperationalStore;
    snapshotDatabasePath: string;
    now: () => Date;
    wait: (milliseconds: number) => Promise<void>;
    durationMs: number;
    pollIntervalMs: number;
    checks: ValidationCheckResult[];
    paperAccountId: string | null;
    setPaperAccountId: (value: string) => void;
  }): Promise<void> {
    const lock = new OperationalLock(input.store, input.now);
    lock.heartbeat(`operational:${input.mode}`, input.operationalRunId);
    const nowIso = input.now().toISOString();
    if (input.mode !== "CONSISTENCY_MONITOR_ONLY") {
      const snapshot = new OperationalHealthMonitor(input.snapshotDatabasePath, input.startedAt, input.now).snapshot();
      input.store.recordHealthSnapshot({
        operationalRunId: input.operationalRunId,
        timestamp: nowIso,
        snapshot,
      });
      if (snapshot.databaseIntegrityStatus !== "OK") {
        input.store.recordAnomaly({
          operationalRunId: input.operationalRunId,
          timestamp: nowIso,
          module: "health",
          severity: "CRITICAL",
          errorCode: "DATABASE_INTEGRITY_FAILED",
          context: { ...snapshot },
        });
      }
    }
    if (input.mode === "OBSERVE_ONLY_OPERATIONAL") {
      new ShadowRiskObserver(input.snapshotDatabasePath, input.now).observe({
        operationalRunId: input.operationalRunId,
        store: input.store,
      });
      this.recordObserveCheckpoint(input.snapshotDatabasePath, input.operationalRunId, input.store, input.mode, nowIso);
    }
    if (input.mode === "PAPER_VALIDATION_OPERATIONAL") {
      const accountId = await this.runPaperSmoke(input.snapshotDatabasePath, input.store, {
        operationalRunId: input.operationalRunId,
        accountId: input.paperAccountId,
        now: input.now,
        setPaperAccountId: input.setPaperAccountId,
      });
      input.paperAccountId = accountId;
      this.recordPaperCheckpoint(input.snapshotDatabasePath, input.operationalRunId, input.store, input.mode, accountId, nowIso);
    }
    if (input.mode === "CONSISTENCY_MONITOR_ONLY") {
      const checks = await new OperationalConsistencyMonitor(input.snapshotDatabasePath, this.sourceVersion, input.now).run({
        operationalRunId: input.operationalRunId,
        mode: input.mode,
        store: input.store,
        includeCrashRecovery: false,
      });
      input.checks.splice(0, input.checks.length, ...checks);
      input.store.recordCheckpoint({
        operationalRunId: input.operationalRunId,
        mode: input.mode,
        stateHash: stateHash({ checks: checks.map((check) => [check.checkType, check.checkName, check.status, check.reason]) }),
        now: nowIso,
      });
    }
    if (input.mode === "HEALTH_MONITOR_ONLY" || input.mode === "CRASH_RECOVERY_OPERATIONAL") {
      input.store.recordCheckpoint({
        operationalRunId: input.operationalRunId,
        mode: input.mode,
        stateHash: stateHash({ mode: input.mode, timestamp: nowIso }),
        now: nowIso,
      });
    }
  }

  private async runPaperSmoke(
    databasePath: string,
    store: OperationalStore,
    input: {
      operationalRunId: string;
      accountId: string | null;
      now: () => Date;
      setPaperAccountId: (value: string) => void;
    },
  ): Promise<string> {
    const executor = new PaperExecutor(databasePath, new FakeOperationalMarketDataProvider(input.now), {
      sourceVersion: this.sourceVersion,
      now: input.now,
    });
    try {
      const accountId = input.accountId ?? executor.createAccount(
        "Operational Paper Validation",
        undefined,
        this.ensureOperationalPaperTarget(databasePath, input.operationalRunId, input.now),
      );
      input.setPaperAccountId(accountId);
      store.bindPaperAccount({
        operationalRunId: input.operationalRunId,
        paperAccountId: accountId,
        bindingReason: "OPERATIONAL_VALIDATION_DEDICATED_ACCOUNT",
        now: input.now().toISOString(),
      });
      await executor.consumeAvailableSignals(accountId);
      await executor.retryPending(accountId);
      await executor.checkStopLosses(accountId);
      await executor.processSettlements(accountId);
      await executor.accountSnapshot(accountId);
      return accountId;
    } finally {
      executor.close();
    }
  }

  private ensureOperationalPaperTarget(
    databasePath: string,
    operationalRunId: string,
    now: () => Date,
  ): string {
    const database = new DatabaseSync(databasePath);
    try {
      const targets = database.prepare(
        `SELECT target_id
         FROM monitor_targets
         WHERE identity_status='IDENTITY_CONFIRMED'
         ORDER BY created_at,target_id`,
      ).all() as Array<{ target_id: string }>;
      if (targets.length === 1) return targets[0]!.target_id;
      if (targets.length > 1) throw new Error("OPERATIONAL_PAPER_TARGET_AMBIGUOUS");

      const targetId = `operational-paper-target-${operationalRunId}`;
      const timestamp = now().toISOString();
      database.prepare(
        `INSERT INTO monitor_targets(
           target_id,wallet_address,identity_status,baseline_at,runtime_mode,
           sync_status,created_at,updated_at
         ) VALUES (?, '0x0000000000000000000000000000000000000000',
           'IDENTITY_CONFIRMED', ?, 'OBSERVE_ONLY', 'SYNCED', ?, ?)`,
      ).run(targetId, timestamp, timestamp, timestamp);
      return targetId;
    } finally {
      database.close();
    }
  }

  private recordPaperCheckpoint(
    databasePath: string,
    operationalRunId: string,
    store: OperationalStore,
    mode: OperationalMode,
    accountId: string,
    now: string,
  ): void {
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const checkpoint = database.prepare(
        "SELECT last_signal_created_at,last_signal_id FROM paper_consumer_checkpoints WHERE paper_account_id=?",
      ).get(accountId) as { last_signal_created_at: string | null; last_signal_id: string | null } | undefined;
      const projection = database.prepare(
        "SELECT projection_id FROM portfolio_projection_runs WHERE paper_account_id=? ORDER BY created_at DESC LIMIT 1",
      ).get(accountId) as { projection_id: string } | undefined;
      store.recordCheckpoint({
        operationalRunId,
        mode,
        lastProcessedTimestamp: parseOptionalTimestamp(checkpoint?.last_signal_created_at),
        lastProcessedEventId: checkpoint?.last_signal_id ?? null,
        paperConsumerCheckpoint: checkpoint ? stableJson(checkpoint) : null,
        portfolioProjectionId: projection?.projection_id ?? null,
        stateHash: stateHash({ accountId, checkpoint, projection }),
        now,
      });
    } finally {
      database.close();
    }
  }

  private recordObserveCheckpoint(
    databasePath: string,
    operationalRunId: string,
    store: OperationalStore,
    mode: OperationalMode,
    now: string,
  ): void {
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const checkpoint = database.prepare(
        `SELECT checkpoint_id,last_processed_timestamp,last_processed_event_id,
                position_projection_hash,capital_snapshot_id
         FROM observe_checkpoints ORDER BY created_at DESC LIMIT 1`,
      ).get() as {
        checkpoint_id: string;
        last_processed_timestamp: number | null;
        last_processed_event_id: string | null;
        position_projection_hash: string;
        capital_snapshot_id: string | null;
      } | undefined;
      const latestSignal = database.prepare("SELECT signal_id,created_at FROM signals ORDER BY created_at DESC LIMIT 1")
        .get() as { signal_id: string; created_at: string } | undefined;
      store.recordCheckpoint({
        operationalRunId,
        mode,
        lastProcessedTimestamp: checkpoint?.last_processed_timestamp ?? parseOptionalTimestamp(latestSignal?.created_at),
        lastProcessedEventId: checkpoint?.last_processed_event_id ?? latestSignal?.signal_id ?? null,
        observeCheckpointId: checkpoint?.checkpoint_id ?? null,
        stateHash: stateHash({ checkpoint, latestSignal }),
        now,
      });
    } finally {
      database.close();
    }
  }
}
