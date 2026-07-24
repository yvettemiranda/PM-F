import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { ApiCapture } from "../../adapters/polymarket-public.js";
import {
  ACTIVITY_IDENTITY_VERSION,
  activityEventKey,
  resolveSourceEventMultiplicity,
  type SourceEventMultiplicityEvidence,
  SOURCE_IDENTITY_VERSION,
} from "../../domain/idempotency.js";
import type { PublicActivity, PublicTrade, WalletIdentityReport } from "../../domain/models.js";
import { activityAsTrade } from "../../domain/activity-trade.js";
import { decimalToScaled, PRICE_SCALE_DIGITS, SHARE_SCALE_DIGITS } from "../../domain/fixed.js";
import {
  RULESET,
  RULESET_HASH,
  RULESET_SNAPSHOT_JSON,
  stableJson,
  VERSIONS,
} from "../../domain/versioning.js";
import type { ReplayReport } from "../../replay/replay-engine.js";
import { resolveSourceVersion, type SourceVersion } from "../source-version.js";
import { captureIdentityFromResponseJson, type CaptureManifest } from "../../services/capture-manifest.js";
import type { PositionBaseline } from "../../services/position-baseline.js";
import type { CapitalEstimate } from "../../services/capital-estimator.js";
import type { GoldenExpectation, GoldenResult } from "../../services/golden-expectations.js";
import { decodeCapturePayload, storeCompressedCapturePayload, type CapturePayloadRow } from "./capture-payload.js";
import { capitalSizingHash } from "../../execution/capital-sizing.js";
import { assertObserveProjectionSnapshotMigrationPreflight } from "./migration-preflight.js";

export class Phase0Database {
  private readonly database: DatabaseSync;
  private readonly sourceVersion: SourceVersion;

  constructor(path: string, sourceVersion = resolveSourceVersion()) {
    this.database = new DatabaseSync(path);
    this.database.exec("PRAGMA foreign_keys=ON; PRAGMA recursive_triggers=ON; PRAGMA busy_timeout=5000;");
    this.sourceVersion = sourceVersion;
  }

  initialize(): void {
    const sql = readFileSync(new URL("./001_phase0.sql", import.meta.url), "utf8");
    this.database.exec(sql);
    this.database
      .prepare(
        `INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)
         `,
      )
      .run("1.2.0", new Date().toISOString());
    const phase05Applied = this.database
      .prepare("SELECT 1 applied FROM schema_migrations WHERE version = ?")
      .get("1.3.0");
    if (!phase05Applied) {
      const phase05Sql = readFileSync(new URL("./002_phase05.sql", import.meta.url), "utf8");
      this.database.exec("BEGIN IMMEDIATE");
      try {
        this.database.exec(phase05Sql);
        this.database
          .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
          .run("1.3.0", new Date().toISOString());
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    }
    const classificationProjectionApplied = this.database
      .prepare("SELECT 1 applied FROM schema_migrations WHERE version = ?")
      .get("1.4.0");
    if (!classificationProjectionApplied) {
      const projectionSql = readFileSync(new URL("./003_replay_event_classifications.sql", import.meta.url), "utf8");
      this.database.exec("BEGIN IMMEDIATE");
      try {
        this.database.exec(projectionSql);
        this.database
          .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
          .run("1.4.0", new Date().toISOString());
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    }
    const observeOnlyApplied = this.database
      .prepare("SELECT 1 applied FROM schema_migrations WHERE version = ?")
      .get("1.5.0");
    if (!observeOnlyApplied) {
      const observeSql = readFileSync(new URL("./004_observe_only.sql", import.meta.url), "utf8");
      this.database.exec("BEGIN IMMEDIATE");
      try {
        this.database.exec(observeSql);
        this.database
          .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
          .run("1.5.0", new Date().toISOString());
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    }
    const paperApplied = this.database
      .prepare("SELECT 1 applied FROM schema_migrations WHERE version = ?")
      .get("2.0.0");
    if (!paperApplied) {
      const paperSql = readFileSync(new URL("./005_paper_executor.sql", import.meta.url), "utf8");
      this.database.exec("BEGIN IMMEDIATE");
      try {
        this.database.exec(paperSql);
        this.database
          .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
          .run("2.0.0", new Date().toISOString());
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    }
    const phase1ArchitectureApplied = this.database
      .prepare("SELECT 1 applied FROM schema_migrations WHERE version = ?")
      .get("2.1.0");
    if (!phase1ArchitectureApplied) {
      const phase1ArchitectureSql = readFileSync(new URL("./006_phase1a_architecture.sql", import.meta.url), "utf8");
      this.database.exec("BEGIN IMMEDIATE");
      try {
        this.database.exec(phase1ArchitectureSql);
        this.database
          .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
          .run("2.1.0", new Date().toISOString());
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    }
    const rulesetProjectionApplied = this.database
      .prepare("SELECT 1 applied FROM schema_migrations WHERE version = ?")
      .get("2.2.0");
    if (!rulesetProjectionApplied) {
      const rulesetProjectionSql = readFileSync(new URL("./007_ruleset_portfolio_projection.sql", import.meta.url), "utf8");
      this.database.exec("BEGIN IMMEDIATE");
      try {
        this.database.exec(rulesetProjectionSql);
        this.database
          .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
          .run("2.2.0", new Date().toISOString());
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    }
    const liveGateApplied = this.database
      .prepare("SELECT 1 applied FROM schema_migrations WHERE version = ?")
      .get("2.3.0");
    if (!liveGateApplied) {
      const liveGateSql = readFileSync(new URL("./008_live_gate_safety.sql", import.meta.url), "utf8");
      this.database.exec("BEGIN IMMEDIATE");
      try {
        this.database.exec(liveGateSql);
        this.database
          .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
          .run("2.3.0", new Date().toISOString());
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    }
    const liveExecutorApplied = this.database
      .prepare("SELECT 1 applied FROM schema_migrations WHERE version = ?")
      .get("2.4.0");
    if (!liveExecutorApplied) {
      const liveExecutorSql = readFileSync(new URL("./009_live_executor.sql", import.meta.url), "utf8");
      this.database.exec("BEGIN IMMEDIATE");
      try {
        this.database.exec(liveExecutorSql);
        this.database
          .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
          .run("2.4.0", new Date().toISOString());
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    }
    const validationFrameworkApplied = this.database
      .prepare("SELECT 1 applied FROM schema_migrations WHERE version = ?")
      .get("2.5.0");
    if (!validationFrameworkApplied) {
      const validationFrameworkSql = readFileSync(new URL("./010_validation_framework.sql", import.meta.url), "utf8");
      this.database.exec("BEGIN IMMEDIATE");
      try {
        this.database.exec(validationFrameworkSql);
        this.database
          .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
          .run("2.5.0", new Date().toISOString());
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    }
    const operationalValidationApplied = this.database
      .prepare("SELECT 1 applied FROM schema_migrations WHERE version = ?")
      .get("2.6.0");
    if (!operationalValidationApplied) {
      const operationalValidationSql = readFileSync(new URL("./011_operational_validation.sql", import.meta.url), "utf8");
      this.database.exec("BEGIN IMMEDIATE");
      try {
        this.database.exec(operationalValidationSql);
        this.database
          .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
          .run("2.6.0", new Date().toISOString());
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    }
    const capturePayloadStorageApplied = this.database
      .prepare("SELECT 1 applied FROM schema_migrations WHERE version = ?")
      .get("2.7.0");
    if (!capturePayloadStorageApplied) {
      const capturePayloadStorageSql = readFileSync(new URL("./012_capture_payload_storage.sql", import.meta.url), "utf8");
      this.database.exec("BEGIN IMMEDIATE");
      try {
        this.database.exec(capturePayloadStorageSql);
        this.database
          .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
          .run("2.7.0", new Date().toISOString());
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    }
    const liveAccountRiskIsolationApplied = this.database
      .prepare("SELECT 1 applied FROM schema_migrations WHERE version = ?")
      .get("2.8.0");
    if (!liveAccountRiskIsolationApplied) {
      const liveAccountRiskIsolationSql = readFileSync(new URL("./013_live_account_risk_isolation.sql", import.meta.url), "utf8");
      this.database.exec("BEGIN IMMEDIATE");
      try {
        this.database.exec(liveAccountRiskIsolationSql);
        this.database
          .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
          .run("2.8.0", new Date().toISOString());
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    }
    const observeActivityConfirmationApplied = this.database
      .prepare("SELECT 1 applied FROM schema_migrations WHERE version = ?")
      .get("2.9.0");
    if (!observeActivityConfirmationApplied) {
      const observeActivityConfirmationSql = readFileSync(new URL("./014_observe_activity_confirmation.sql", import.meta.url), "utf8");
      this.database.exec("BEGIN IMMEDIATE");
      try {
        this.database.exec(observeActivityConfirmationSql);
        this.database
          .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
          .run("2.9.0", new Date().toISOString());
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    }
    const appendOnlyEvidenceApplied = this.database
      .prepare("SELECT 1 applied FROM schema_migrations WHERE version = ?")
      .get("2.10.0");
    if (!appendOnlyEvidenceApplied) {
      const appendOnlyEvidenceSql = readFileSync(new URL("./015_append_only_evidence.sql", import.meta.url), "utf8");
      this.database.exec("BEGIN IMMEDIATE");
      try {
        this.database.exec(appendOnlyEvidenceSql);
        this.database
          .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
          .run("2.10.0", new Date().toISOString());
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    }
    const liveAssetReservationsApplied = this.database
      .prepare("SELECT 1 applied FROM schema_migrations WHERE version = ?")
      .get("2.11.0");
    if (!liveAssetReservationsApplied) {
      const liveAssetReservationsSql = readFileSync(new URL("./016_live_asset_reservations.sql", import.meta.url), "utf8");
      this.database.exec("BEGIN IMMEDIATE");
      try {
        this.database.exec(liveAssetReservationsSql);
        this.database
          .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
          .run("2.11.0", new Date().toISOString());
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    }
    const liveMarketExecutionSafetyApplied = this.database
      .prepare("SELECT 1 applied FROM schema_migrations WHERE version = ?")
      .get("2.12.0");
    if (!liveMarketExecutionSafetyApplied) {
      const liveMarketExecutionSafetySql = readFileSync(new URL("./017_live_market_execution_safety.sql", import.meta.url), "utf8");
      this.database.exec("BEGIN IMMEDIATE");
      try {
        this.database.exec(liveMarketExecutionSafetySql);
        this.database
          .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
          .run("2.12.0", new Date().toISOString());
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    }
    const liveSignalCursorSafetyApplied = this.database
      .prepare("SELECT 1 applied FROM schema_migrations WHERE version = ?")
      .get("2.13.0");
    if (!liveSignalCursorSafetyApplied) {
      const liveSignalCursorSafetySql = readFileSync(new URL("./018_live_signal_cursor_safety.sql", import.meta.url), "utf8");
      this.database.exec("BEGIN IMMEDIATE");
      try {
        this.database.exec(liveSignalCursorSafetySql);
        this.database
          .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
          .run("2.13.0", new Date().toISOString());
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    }
    const liveBuyBudgetCompletenessApplied = this.database
      .prepare("SELECT 1 applied FROM schema_migrations WHERE version = ?")
      .get("2.14.0");
    if (!liveBuyBudgetCompletenessApplied) {
      const liveBuyBudgetCompletenessSql = readFileSync(new URL("./019_live_buy_budget_completeness.sql", import.meta.url), "utf8");
      this.database.exec("BEGIN IMMEDIATE");
      try {
        this.database.exec(liveBuyBudgetCompletenessSql);
        this.database
          .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
          .run("2.14.0", new Date().toISOString());
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    }
    const liveAuthorizedSignerApplied = this.database
      .prepare("SELECT 1 applied FROM schema_migrations WHERE version = ?")
      .get("2.15.0");
    if (!liveAuthorizedSignerApplied) {
      const liveAuthorizedSignerSql = readFileSync(new URL("./020_live_authorized_signer.sql", import.meta.url), "utf8");
      this.database.exec("BEGIN IMMEDIATE");
      try {
        this.database.exec(liveAuthorizedSignerSql);
        this.database
          .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
          .run("2.15.0", new Date().toISOString());
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    }
    const liveOrderIntentEvidenceApplied = this.database
      .prepare("SELECT 1 applied FROM schema_migrations WHERE version = ?")
      .get("2.16.0");
    if (!liveOrderIntentEvidenceApplied) {
      const liveOrderIntentEvidenceSql = readFileSync(new URL("./021_live_order_intent_evidence.sql", import.meta.url), "utf8");
      this.database.exec("BEGIN IMMEDIATE");
      try {
        this.database.exec(liveOrderIntentEvidenceSql);
        this.database
          .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
          .run("2.16.0", new Date().toISOString());
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    }
    const liveGateTransitionImmutabilityApplied = this.database
      .prepare("SELECT 1 applied FROM schema_migrations WHERE version = ?")
      .get("2.17.0");
    if (!liveGateTransitionImmutabilityApplied) {
      const liveGateTransitionImmutabilitySql = readFileSync(new URL("./022_live_gate_transition_immutability.sql", import.meta.url), "utf8");
      this.database.exec("BEGIN IMMEDIATE");
      try {
        this.database.exec(liveGateTransitionImmutabilitySql);
        this.database
          .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
          .run("2.17.0", new Date().toISOString());
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    }
    const liveSettlementEventsApplied = this.database
      .prepare("SELECT 1 applied FROM schema_migrations WHERE version = ?")
      .get("2.18.0");
    if (!liveSettlementEventsApplied) {
      const liveSettlementEventsSql = readFileSync(new URL("./023_live_settlement_events.sql", import.meta.url), "utf8");
      this.database.exec("BEGIN IMMEDIATE");
      try {
        this.database.exec(liveSettlementEventsSql);
        this.database
          .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
          .run("2.18.0", new Date().toISOString());
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    }
    const paperMarketDataHealthApplied = this.database
      .prepare("SELECT 1 applied FROM schema_migrations WHERE version = ?")
      .get("2.19.0");
    if (!paperMarketDataHealthApplied) {
      const paperMarketDataHealthSql = readFileSync(new URL("./024_paper_market_data_health.sql", import.meta.url), "utf8");
      this.database.exec("BEGIN IMMEDIATE");
      try {
        this.database.exec(paperMarketDataHealthSql);
        this.database
          .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
          .run("2.19.0", new Date().toISOString());
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    }
    const exactSizingAndMarketConstraintsApplied = this.database
      .prepare("SELECT 1 applied FROM schema_migrations WHERE version = ?")
      .get("2.20.0");
    if (!exactSizingAndMarketConstraintsApplied) {
      const exactSizingAndMarketConstraintsSql = readFileSync(
        new URL("./025_exact_sizing_and_market_constraints.sql", import.meta.url),
        "utf8",
      );
      this.database.exec("BEGIN IMMEDIATE");
      try {
        this.database.exec(exactSizingAndMarketConstraintsSql);
        this.database
          .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
          .run("2.20.0", new Date().toISOString());
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    }
    const paperValidationCampaignApplied = this.database
      .prepare("SELECT 1 applied FROM schema_migrations WHERE version = ?")
      .get("2.21.0");
    if (!paperValidationCampaignApplied) {
      const paperValidationCampaignSql = readFileSync(
        new URL("./026_paper_validation_campaign.sql", import.meta.url),
        "utf8",
      );
      this.database.exec("BEGIN IMMEDIATE");
      try {
        this.database.exec(paperValidationCampaignSql);
        this.database
          .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
          .run("2.21.0", new Date().toISOString());
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    }
    const signalTargetBindingApplied = this.database
      .prepare("SELECT 1 applied FROM schema_migrations WHERE version = ?")
      .get("2.22.0");
    if (!signalTargetBindingApplied) {
      const signalTargetBindingSql = readFileSync(
        new URL("./027_signal_target_binding.sql", import.meta.url),
        "utf8",
      );
      this.database.exec("BEGIN IMMEDIATE");
      try {
        this.database.exec(signalTargetBindingSql);
        this.database
          .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
          .run("2.22.0", new Date().toISOString());
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    }
    const observeProjectionSnapshotsApplied = this.database
      .prepare("SELECT 1 applied FROM schema_migrations WHERE version = ?")
      .get("2.23.0");
    if (!observeProjectionSnapshotsApplied) {
      const observeProjectionSnapshotsSql = readFileSync(
        new URL("./028_observe_projection_snapshots.sql", import.meta.url),
        "utf8",
      );
      this.database.exec("BEGIN IMMEDIATE");
      try {
        assertObserveProjectionSnapshotMigrationPreflight(this.database);
        this.database.exec(observeProjectionSnapshotsSql);
        this.database
          .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
          .run("2.23.0", new Date().toISOString());
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    }
    const observeCampaignBindingApplied = this.database
      .prepare("SELECT 1 applied FROM schema_migrations WHERE version = ?")
      .get("2.24.0");
    if (!observeCampaignBindingApplied) {
      const observeCampaignBindingSql = readFileSync(
        new URL("./029_observe_campaign_binding.sql", import.meta.url),
        "utf8",
      );
      this.database.exec("BEGIN IMMEDIATE");
      try {
        this.database.exec(observeCampaignBindingSql);
        this.database
          .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
          .run("2.24.0", new Date().toISOString());
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    }
    const paperSettlementRetryStateApplied = this.database
      .prepare("SELECT 1 applied FROM schema_migrations WHERE version = ?")
      .get("2.25.0");
    if (!paperSettlementRetryStateApplied) {
      const paperSettlementRetryStateSql = readFileSync(
        new URL("./030_paper_runtime_resilience.sql", import.meta.url),
        "utf8",
      );
      this.database.exec("BEGIN IMMEDIATE");
      try {
        this.database.exec(paperSettlementRetryStateSql);
        this.database
          .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
          .run("2.25.0", new Date().toISOString());
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    }
    const validationDurationPolicyApplied = this.database
      .prepare("SELECT 1 applied FROM schema_migrations WHERE version = ?")
      .get("2.26.0");
    if (!validationDurationPolicyApplied) {
      const validationDurationPolicySql = readFileSync(
        new URL("./031_validation_duration_policy.sql", import.meta.url),
        "utf8",
      );
      let transactionStarted = false;
      this.database.exec("PRAGMA foreign_keys=OFF");
      try {
        this.database.exec("BEGIN IMMEDIATE");
        transactionStarted = true;
        this.database.exec(validationDurationPolicySql);
        const foreignKeyFailures = this.database.prepare("PRAGMA foreign_key_check").all();
        if (foreignKeyFailures.length > 0) {
          throw new Error("MIGRATION_031_FOREIGN_KEY_CHECK_FAILED");
        }
        this.database
          .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
          .run("2.26.0", new Date().toISOString());
        this.database.exec("COMMIT");
        transactionStarted = false;
      } catch (error) {
        if (transactionStarted) this.database.exec("ROLLBACK");
        throw error;
      } finally {
        this.database.exec("PRAGMA foreign_keys=ON");
      }
    }
    const negativeRiskConversionApplied = this.database
      .prepare("SELECT 1 applied FROM schema_migrations WHERE version = ?")
      .get("2.27.0");
    if (!negativeRiskConversionApplied) {
      const negativeRiskConversionSql = readFileSync(
        new URL("./032_negative_risk_conversion.sql", import.meta.url),
        "utf8",
      );
      this.database.exec("BEGIN IMMEDIATE");
      try {
        this.database.exec(negativeRiskConversionSql);
        this.database
          .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
          .run("2.27.0", new Date().toISOString());
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    }
    const observeSoakPrerequisiteNameApplied = this.database
      .prepare("SELECT 1 applied FROM schema_migrations WHERE version = ?")
      .get("2.28.0");
    if (!observeSoakPrerequisiteNameApplied) {
      const observeSoakPrerequisiteNameSql = readFileSync(
        new URL("./033_observe_soak_prerequisite_name.sql", import.meta.url),
        "utf8",
      );
      this.database.exec("BEGIN IMMEDIATE");
      try {
        this.database.exec(observeSoakPrerequisiteNameSql);
        this.database
          .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
          .run("2.28.0", new Date().toISOString());
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    }
    const signalEnrichmentResilienceApplied = this.database
      .prepare("SELECT 1 applied FROM schema_migrations WHERE version = ?")
      .get("2.29.0");
    if (!signalEnrichmentResilienceApplied) {
      const signalEnrichmentResilienceSql = readFileSync(
        new URL("./034_signal_enrichment_resilience.sql", import.meta.url),
        "utf8",
      );
      const requiredColumns = [
        ["observe_polls", "signal_enrichment_failures"],
        ["observe_polls", "warning_detail"],
        ["signal_execution_contexts", "market_end_time_status"],
        ["signal_execution_contexts", "execution_deadline_at"],
      ] as const;
      const existingColumnCount = requiredColumns.filter(([table, column]) => (
        (this.database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
          .some((row) => row.name === column)
      )).length;
      if (existingColumnCount !== 0 && existingColumnCount !== requiredColumns.length) {
        throw new Error("MIGRATION_034_PARTIAL_COLUMNS_PRESENT");
      }
      if (existingColumnCount === requiredColumns.length) {
        const emissionTable = this.database.prepare(
          "SELECT sql FROM sqlite_master WHERE type='table' AND name='observe_signal_emissions'",
        ).get() as { sql: string } | undefined;
        const bucketLedgerTable = this.database.prepare(
          "SELECT sql FROM sqlite_master WHERE type='table' AND name='position_bucket_ledger'",
        ).get() as { sql: string } | undefined;
        const replayClassificationTable = this.database.prepare(
          "SELECT sql FROM sqlite_master WHERE type='table' AND name='replay_event_classifications'",
        ).get() as { sql: string } | undefined;
        const sourceEventIndex = this.database.prepare(
          "SELECT 1 ok FROM sqlite_master WHERE type='index' AND name='observe_signal_emissions_source_event_idx'",
        ).get();
        const replayClassificationIndex = this.database.prepare(
          "SELECT 1 ok FROM sqlite_master WHERE type='index' AND name='replay_event_classifications_event_idx'",
        ).get();
        const rebuiltEvidenceTriggers = [
          "position_bucket_ledger_no_update",
          "position_bucket_ledger_no_delete",
          "replay_event_classifications_no_update",
          "replay_event_classifications_no_delete",
        ].every((name) => this.database.prepare(
          "SELECT 1 ok FROM sqlite_master WHERE type='trigger' AND name=?",
        ).get(name));
        const normalizedEmissionSql = emissionTable?.sql.replace(/\s+/g, " ") ?? "";
        const normalizedBucketLedgerSql = bucketLedgerTable?.sql.replace(/\s+/g, " ") ?? "";
        const normalizedReplayClassificationSql = replayClassificationTable?.sql.replace(/\s+/g, " ") ?? "";
        if (
          !sourceEventIndex
          || !replayClassificationIndex
          || !rebuiltEvidenceTriggers
          || !normalizedEmissionSql.includes("UNIQUE(baseline_run_id, signal_id)")
          || !normalizedBucketLedgerSql.includes("UNIQUE(replay_run_id, source_event_key, asset_id)")
          || !normalizedReplayClassificationSql.includes("UNIQUE(replay_run_id, source_event_key, signal_id)")
        ) {
          throw new Error("MIGRATION_034_PARTIAL_SCHEMA_PRESENT");
        }
      }
      this.database.exec("BEGIN IMMEDIATE");
      try {
        if (existingColumnCount === 0) this.database.exec(signalEnrichmentResilienceSql);
        this.database
          .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
          .run("2.29.0", new Date().toISOString());
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    }
    const specialActivityProjectionApplied = this.database
      .prepare("SELECT 1 applied FROM schema_migrations WHERE version = ?")
      .get("2.30.0");
    if (!specialActivityProjectionApplied) {
      const specialActivityProjectionSql = readFileSync(
        new URL("./035_special_activity_projection.sql", import.meta.url),
        "utf8",
      );
      const splitEvidenceTable = this.database.prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='split_projection_evidence'",
      ).get() as { sql: string } | undefined;
      const splitEvidenceIndex = this.database.prepare(
        "SELECT 1 ok FROM sqlite_master WHERE type='index' AND name='split_projection_evidence_run_idx'",
      ).get();
      const splitEvidenceTriggers = [
        "split_projection_evidence_no_update",
        "split_projection_evidence_no_delete",
      ].every((name) => this.database.prepare(
        "SELECT 1 ok FROM sqlite_master WHERE type='trigger' AND name=?",
      ).get(name));
      const splitEvidenceComplete = splitEvidenceTable !== undefined
        && splitEvidenceIndex !== undefined
        && splitEvidenceTriggers
        && splitEvidenceTable.sql.replace(/\s+/g, " ").includes("positions_snapshot_hash TEXT NOT NULL");
      if (splitEvidenceTable !== undefined && !splitEvidenceComplete) {
        throw new Error("MIGRATION_035_PARTIAL_SCHEMA_PRESENT");
      }
      this.database.exec("BEGIN IMMEDIATE");
      try {
        if (!splitEvidenceComplete) this.database.exec(specialActivityProjectionSql);
        this.database
          .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
          .run("2.30.0", new Date().toISOString());
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    }
    this.database
      .prepare(
        `INSERT OR IGNORE INTO rulesets(
          ruleset_hash, schema_version, signal_version, strategy_version, risk_version,
          replay_version, ruleset_snapshot_json, source_code_commit, source_code_dirty, config_version, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        RULESET_HASH,
        VERSIONS.schemaVersion,
        VERSIONS.signalVersion,
        VERSIONS.strategyVersion,
        VERSIONS.riskVersion,
        VERSIONS.replayVersion,
        RULESET_SNAPSHOT_JSON,
        this.sourceVersion.commit,
        this.sourceVersion.dirty ? 1 : 0,
        VERSIONS.configVersion,
        new Date().toISOString(),
      );
    const now = new Date().toISOString();
    this.database
      .prepare(
        `INSERT OR IGNORE INTO ruleset_registry(
          ruleset_hash, ruleset_version, buy_price_lower_ratio_ppm, buy_price_upper_ratio_ppm,
          stop_loss_ratio_ppm, wait_ratio_ppm, max_wait_time_ms, capital_mode,
          fee_model_version, ruleset_snapshot_json, source_code_commit, source_code_dirty,
          config_version, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        RULESET_HASH,
        VERSIONS.rulesetVersion,
        RULESET.buyPriceMinRatioPpm,
        RULESET.buyPriceMaxRatioPpm,
        RULESET.stopTriggerRatioPpm,
        RULESET.waitRatioPpm,
        RULESET.maxWaitMs,
        RULESET.capitalMode,
        VERSIONS.feeModelVersion,
        RULESET_SNAPSHOT_JSON,
        this.sourceVersion.commit,
        this.sourceVersion.dirty ? 1 : 0,
        VERSIONS.configVersion,
        now,
      );
    this.database
      .prepare(
        `INSERT OR IGNORE INTO live_gate_state(
          state_id, execution_mode, live_gate_state, requested_execution_mode, last_preflight_id,
          state_reason, source_code_commit, source_code_dirty, config_version, created_at, updated_at
        ) VALUES ('default', 'PAPER', 'LIVE_DISABLED', NULL, NULL, 'DEFAULT_DISABLED', ?, ?, ?, ?, ?)`,
      )
      .run(
        this.sourceVersion.commit,
        this.sourceVersion.dirty ? 1 : 0,
        VERSIONS.configVersion,
        now,
        now,
      );
  }

  saveIdentity(report: WalletIdentityReport): string {
    const reportId = createHash("sha256")
      .update(`${report.walletAddress}|${report.positionSnapshotTime}|${RULESET_HASH}`)
      .digest("hex");
    this.database
      .prepare(
        `INSERT OR REPLACE INTO wallet_identity_reports(
          report_id, wallet_address, wallet_type, proxy_wallet, chain, first_seen_time,
          last_activity_time, trade_count, trade_count_scope, position_count, status,
          confidence, implementation_address, evidence_json, ruleset_hash, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        reportId,
        report.walletAddress,
        report.walletType,
        report.proxyWallet,
        report.chain,
        report.firstSeenTime,
        report.lastActivityTime,
        report.tradeCount,
        report.tradeCountScope,
        report.positionCount,
        report.status,
        report.confidence,
        report.implementationAddress,
        JSON.stringify(report.evidence),
        RULESET_HASH,
        new Date().toISOString(),
      );
    return reportId;
  }

  saveCapture<T>(endpoint: string, capture: ApiCapture<T>): string {
    const responseJson = JSON.stringify(capture.data);
    const { captureId, payloadSha256: payloadHash } = captureIdentityFromResponseJson(capture.url, capture.fetchedAt, responseJson);
    storeCompressedCapturePayload(this.database, payloadHash, responseJson, capture.fetchedAt);
    this.database
      .prepare(
        `INSERT OR IGNORE INTO api_captures(
          capture_id, endpoint, request_url, fetched_at, latency_ms, http_status,
          payload_sha256, response_json, schema_version, response_encoding
        ) VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, 'GZIP_SHA256')`,
      )
      .run(
        captureId,
        endpoint,
        capture.url,
        capture.fetchedAt,
        capture.latencyMs,
        capture.status,
        payloadHash,
        VERSIONS.schemaVersion,
      );
    const serverTimestamp = endpoint === "clob-time" && typeof capture.data === "number"
      ? new Date(capture.data * 1_000).toISOString()
      : null;
    const clockOffsetMs = serverTimestamp
      ? Math.round(Date.parse(serverTimestamp) - (Date.parse(capture.fetchedAt) - capture.latencyMs / 2))
      : null;
    this.database
      .prepare(
        `INSERT OR IGNORE INTO latency_metrics(
          metric_id, component, operation, duration_ms, local_timestamp,
          server_timestamp, clock_offset_ms, success, detail_json
        ) VALUES (?, 'PUBLIC_API', ?, ?, ?, ?, ?, 1, ?)`,
      )
      .run(
        createHash("sha256").update(`latency|${captureId}`).digest("hex"),
        endpoint,
        capture.latencyMs,
        capture.fetchedAt,
        serverTimestamp,
        clockOffsetMs,
        JSON.stringify({ url: capture.url, httpStatus: capture.status }),
      );
    return captureId;
  }

  saveCaptureManifest(targetId: string | null, manifest: CaptureManifest): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database
        .prepare(
          `INSERT OR IGNORE INTO capture_runs(
            capture_run_id, target_id, wallet_address, sample_role, purpose, status,
            started_at, completed_at, manifest_hash, item_count,
            schema_version, signal_version, strategy_version, risk_version, replay_version,
            ruleset_snapshot_json, ruleset_hash, source_code_commit, source_code_dirty, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          manifest.captureRunId,
          targetId,
          manifest.walletAddress,
          manifest.sampleRole,
          manifest.purpose,
          manifest.status,
          manifest.startedAt,
          manifest.completedAt,
          manifest.manifestHash,
          manifest.items.length,
          VERSIONS.schemaVersion,
          VERSIONS.signalVersion,
          VERSIONS.strategyVersion,
          VERSIONS.riskVersion,
          VERSIONS.replayVersion,
          RULESET_SNAPSHOT_JSON,
          RULESET_HASH,
          manifest.sourceCodeCommit,
          manifest.sourceCodeDirty ? 1 : 0,
          manifest.completedAt,
        );
      const existingRun = this.database.prepare(
        `SELECT wallet_address,sample_role,purpose,status,started_at,completed_at,manifest_hash,item_count
         FROM capture_runs WHERE capture_run_id=?`,
      ).get(manifest.captureRunId) as {
        wallet_address: string;
        sample_role: string;
        purpose: string;
        status: string;
        started_at: string;
        completed_at: string | null;
        manifest_hash: string | null;
        item_count: number;
      };
      if (
        existingRun.wallet_address !== manifest.walletAddress
        || existingRun.sample_role !== manifest.sampleRole
        || existingRun.purpose !== manifest.purpose
        || existingRun.status !== manifest.status
        || existingRun.started_at !== manifest.startedAt
        || existingRun.completed_at !== manifest.completedAt
        || existingRun.manifest_hash !== manifest.manifestHash
        || existingRun.item_count !== manifest.items.length
      ) {
        throw new Error("CAPTURE_RUN_CONFLICT");
      }
      const insertItem = this.database.prepare(
        `INSERT OR IGNORE INTO capture_manifest_items(
          manifest_item_id, capture_run_id, capture_id, source_endpoint, request_url,
          page_index, fetched_at, source_time_from, source_time_to, row_count,
          pagination_status, payload_sha256, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const item of manifest.items) {
        insertItem.run(
          item.manifestItemId,
          manifest.captureRunId,
          item.captureId,
          item.endpoint,
          item.requestUrl,
          item.pageIndex,
          item.fetchedAt,
          item.sourceTimeFrom,
          item.sourceTimeTo,
          item.rowCount,
          item.paginationStatus,
          item.payloadSha256,
          manifest.completedAt,
        );
        const existingItem = this.database.prepare(
          `SELECT capture_id,source_endpoint,request_url,page_index,fetched_at,source_time_from,
                  source_time_to,row_count,pagination_status,payload_sha256
           FROM capture_manifest_items WHERE manifest_item_id=?`,
        ).get(item.manifestItemId) as {
          capture_id: string;
          source_endpoint: string;
          request_url: string;
          page_index: number | null;
          fetched_at: string;
          source_time_from: number | null;
          source_time_to: number | null;
          row_count: number;
          pagination_status: string;
          payload_sha256: string;
        };
        if (
          existingItem.capture_id !== item.captureId
          || existingItem.source_endpoint !== item.endpoint
          || existingItem.request_url !== item.requestUrl
          || existingItem.page_index !== item.pageIndex
          || existingItem.fetched_at !== item.fetchedAt
          || existingItem.source_time_from !== item.sourceTimeFrom
          || existingItem.source_time_to !== item.sourceTimeTo
          || existingItem.row_count !== item.rowCount
          || existingItem.pagination_status !== item.paginationStatus
          || existingItem.payload_sha256 !== item.payloadSha256
        ) {
          throw new Error("CAPTURE_MANIFEST_ITEM_CONFLICT");
        }
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  ensureTarget(walletAddress: string, identityStatus: string): string {
    const targetId = createHash("sha256").update(walletAddress.toLowerCase()).digest("hex");
    const now = new Date().toISOString();
    this.database
      .prepare(
        `INSERT INTO monitor_targets(
          target_id, wallet_address, identity_status, runtime_mode, sync_status, created_at, updated_at
        ) VALUES (?, ?, ?, 'OBSERVE_ONLY', 'SYNCED', ?, ?)
        ON CONFLICT(wallet_address) DO UPDATE SET identity_status=excluded.identity_status, updated_at=excluded.updated_at`,
      )
      .run(targetId, walletAddress.toLowerCase(), identityStatus, now, now);
    return targetId;
  }

  savePositionBaseline(baseline: PositionBaseline): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database
        .prepare(
          `INSERT OR IGNORE INTO position_baseline_runs(
            baseline_run_id, capture_run_id, target_id, wallet_address, status,
            cutoff_from, cutoff_to, snapshot_time, position_capture_id, item_count,
            schema_version, strategy_version, ruleset_hash, source_code_commit,
            source_code_dirty, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          baseline.baselineRunId,
          baseline.captureRunId,
          baseline.targetId,
          baseline.walletAddress,
          baseline.status,
          baseline.cutoffFrom,
          baseline.cutoffTo,
          baseline.snapshotTime,
          baseline.positionCaptureId,
          baseline.items.length,
          VERSIONS.schemaVersion,
          VERSIONS.strategyVersion,
          RULESET_HASH,
          this.sourceVersion.commit,
          this.sourceVersion.dirty ? 1 : 0,
          baseline.snapshotTime,
        );
      const existingRun = this.database.prepare(
        `SELECT capture_run_id,target_id,wallet_address,status,cutoff_from,cutoff_to,snapshot_time,
                position_capture_id,item_count
         FROM position_baseline_runs WHERE baseline_run_id=?`,
      ).get(baseline.baselineRunId) as {
        capture_run_id: string;
        target_id: string;
        wallet_address: string;
        status: string;
        cutoff_from: string;
        cutoff_to: string;
        snapshot_time: string;
        position_capture_id: string;
        item_count: number;
      };
      if (
        existingRun.capture_run_id !== baseline.captureRunId
        || existingRun.target_id !== baseline.targetId
        || existingRun.wallet_address !== baseline.walletAddress
        || existingRun.status !== baseline.status
        || existingRun.cutoff_from !== baseline.cutoffFrom
        || existingRun.cutoff_to !== baseline.cutoffTo
        || existingRun.snapshot_time !== baseline.snapshotTime
        || existingRun.position_capture_id !== baseline.positionCaptureId
        || existingRun.item_count !== baseline.items.length
      ) throw new Error("POSITION_BASELINE_RUN_CONFLICT");
      const insertItem = this.database.prepare(
        `INSERT OR IGNORE INTO position_baseline_items(
          baseline_item_id, baseline_run_id, condition_id, asset_id, market_slug,
          market_title, outcome, size_micros, average_price_units, snapshot_time
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const item of baseline.items) {
        insertItem.run(
          item.baselineItemId,
          baseline.baselineRunId,
          item.conditionId,
          item.asset,
          item.marketSlug,
          item.marketTitle,
          item.outcome,
          item.sizeMicros,
          item.averagePriceUnits,
          item.snapshotTime,
        );
        const existingItem = this.database.prepare(
          `SELECT baseline_run_id,condition_id,asset_id,market_slug,market_title,outcome,
                  size_micros,average_price_units,snapshot_time
           FROM position_baseline_items WHERE baseline_item_id=?`,
        ).get(item.baselineItemId) as {
          baseline_run_id: string;
          condition_id: string;
          asset_id: string;
          market_slug: string;
          market_title: string;
          outcome: string;
          size_micros: string;
          average_price_units: string;
          snapshot_time: string;
        };
        if (
          existingItem.baseline_run_id !== baseline.baselineRunId
          || existingItem.condition_id !== item.conditionId
          || existingItem.asset_id !== item.asset
          || existingItem.market_slug !== item.marketSlug
          || existingItem.market_title !== item.marketTitle
          || existingItem.outcome !== item.outcome
          || existingItem.size_micros !== item.sizeMicros
          || existingItem.average_price_units !== item.averagePriceUnits
          || existingItem.snapshot_time !== item.snapshotTime
        ) throw new Error("POSITION_BASELINE_ITEM_CONFLICT");
      }
      this.database
        .prepare("UPDATE monitor_targets SET baseline_at=?, updated_at=? WHERE target_id=?")
        .run(baseline.snapshotTime, baseline.snapshotTime, baseline.targetId);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  saveCapitalEstimate(targetId: string, sourceEventKeyValue: string | null, estimate: CapitalEstimate): void {
    if ((estimate.capitalSizingRatio === null) !== (estimate.capitalSizingRatioHash === null)) {
      throw new Error("CAPITAL_SIZING_RATIO_PAIR_REQUIRED");
    }
    if (estimate.capitalSizingRatio
      && capitalSizingHash(estimate.capitalSizingRatio) !== estimate.capitalSizingRatioHash) {
      throw new Error("CAPITAL_SIZING_RATIO_HASH_MISMATCH");
    }
    this.database
      .prepare(
        `INSERT OR IGNORE INTO capital_estimates(
          capital_estimate_id, target_id, source_event_key, position_value_micros,
          wallet_balance_micros, target_visible_capital_micros, target_trade_amount_micros,
          target_trade_capital_ratio_ppm, capital_sizing_ratio_json, capital_sizing_ratio_hash,
          capital_estimate_status, capital_confidence,
          capital_estimate_reason, position_snapshot_time, wallet_balance_snapshot_time,
          target_trade_timestamp, fallback_amount_micros, schema_version, strategy_version,
          risk_version, ruleset_snapshot_json, ruleset_hash, source_code_commit,
          source_code_dirty, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        estimate.capitalEstimateId,
        targetId,
        sourceEventKeyValue,
        estimate.positionValueMicros,
        estimate.walletBalanceMicros,
        estimate.targetVisibleCapitalMicros,
        estimate.targetTradeAmountMicros,
        estimate.targetTradeCapitalRatioPpm,
        estimate.capitalSizingRatio ? stableJson(estimate.capitalSizingRatio) : null,
        estimate.capitalSizingRatioHash,
        estimate.capitalEstimateStatus,
        estimate.capitalConfidence,
        estimate.capitalEstimateReason,
        estimate.positionSnapshotTime,
        estimate.walletBalanceSnapshotTime,
        estimate.targetTradeTimestamp,
        estimate.fallbackAmountMicros,
        VERSIONS.schemaVersion,
        VERSIONS.strategyVersion,
        VERSIONS.riskVersion,
        RULESET_SNAPSHOT_JSON,
        RULESET_HASH,
        this.sourceVersion.commit,
        this.sourceVersion.dirty ? 1 : 0,
        new Date().toISOString(),
      );
    const existing = this.database.prepare(
      `SELECT target_id,source_event_key,position_value_micros,wallet_balance_micros,
              target_visible_capital_micros,target_trade_amount_micros,target_trade_capital_ratio_ppm,
              capital_sizing_ratio_json,capital_sizing_ratio_hash,
              capital_estimate_status,capital_confidence,capital_estimate_reason,
              position_snapshot_time,wallet_balance_snapshot_time,target_trade_timestamp,
              fallback_amount_micros
       FROM capital_estimates WHERE capital_estimate_id=?`,
    ).get(estimate.capitalEstimateId) as Record<string, string | null>;
    const expected: Record<string, string | null> = {
      target_id: targetId,
      source_event_key: sourceEventKeyValue,
      position_value_micros: estimate.positionValueMicros,
      wallet_balance_micros: estimate.walletBalanceMicros,
      target_visible_capital_micros: estimate.targetVisibleCapitalMicros,
      target_trade_amount_micros: estimate.targetTradeAmountMicros,
      target_trade_capital_ratio_ppm: estimate.targetTradeCapitalRatioPpm,
      capital_sizing_ratio_json: estimate.capitalSizingRatio ? stableJson(estimate.capitalSizingRatio) : null,
      capital_sizing_ratio_hash: estimate.capitalSizingRatioHash,
      capital_estimate_status: estimate.capitalEstimateStatus,
      capital_confidence: estimate.capitalConfidence,
      capital_estimate_reason: estimate.capitalEstimateReason,
      position_snapshot_time: estimate.positionSnapshotTime,
      wallet_balance_snapshot_time: estimate.walletBalanceSnapshotTime,
      target_trade_timestamp: estimate.targetTradeTimestamp,
      fallback_amount_micros: estimate.fallbackAmountMicros,
    };
    if (Object.entries(expected).some(([key, value]) => existing[key] !== value)) {
      throw new Error("CAPITAL_ESTIMATE_CONFLICT");
    }
  }

  saveGoldenCandidates(candidates: GoldenExpectation[]): void {
    const insert = this.database.prepare(
      `INSERT OR IGNORE INTO golden_expectations(
        golden_case_id, capture_run_id, sample_wallet, sample_role, case_type,
        source_event_key, source_transaction_hash, expected_signal_type,
        expected_signal_present, expected_execution_eligible, expected_event_classification,
        expected_reason, evidence_json, status, schema_version, signal_version,
        replay_version, ruleset_hash, source_code_commit, source_code_dirty, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const now = new Date().toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      for (const item of candidates) {
        insert.run(
          item.goldenCaseId,
          item.captureRunId,
          item.sampleWallet,
          item.sampleRole,
          item.caseType,
          item.sourceEventKey,
          item.sourceTransactionHash,
          item.expectedSignalType,
          item.expectedSignalPresent ? 1 : 0,
          item.expectedExecutionEligible === null ? null : item.expectedExecutionEligible ? 1 : 0,
          item.expectedEventClassification,
          item.expectedReason,
          JSON.stringify(item.evidence),
          item.status,
          VERSIONS.schemaVersion,
          VERSIONS.signalVersion,
          VERSIONS.replayVersion,
          RULESET_HASH,
          this.sourceVersion.commit,
          this.sourceVersion.dirty ? 1 : 0,
          now,
        );
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  saveGoldenResults(replayRunId: string, results: GoldenResult[]): void {
    const insert = this.database.prepare(
      `INSERT OR IGNORE INTO golden_results(
        golden_result_id, replay_run_id, golden_case_id, result_status,
        actual_signal_type, actual_signal_present, actual_execution_eligible,
        actual_event_classification, diff_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const now = new Date().toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      for (const item of results) {
        const resultId = createHash("sha256").update(`${replayRunId}|${item.goldenCaseId}`).digest("hex");
        insert.run(
          resultId,
          replayRunId,
          item.goldenCaseId,
          item.resultStatus,
          item.actualSignalType,
          item.actualSignalPresent ? 1 : 0,
          item.actualExecutionEligible === null ? null : item.actualExecutionEligible ? 1 : 0,
          item.actualEventClassification,
          JSON.stringify(item.diff),
          now,
        );
        const existing = this.database.prepare(
          `SELECT result_status,actual_signal_type,actual_signal_present,actual_execution_eligible,
                  actual_event_classification,diff_json
           FROM golden_results WHERE golden_result_id=?`,
        ).get(resultId) as {
          result_status: string;
          actual_signal_type: string | null;
          actual_signal_present: number;
          actual_execution_eligible: number | null;
          actual_event_classification: string;
          diff_json: string;
        };
        if (
          existing.result_status !== item.resultStatus
          || existing.actual_signal_type !== item.actualSignalType
          || existing.actual_signal_present !== (item.actualSignalPresent ? 1 : 0)
          || existing.actual_execution_eligible !== (item.actualExecutionEligible === null ? null : item.actualExecutionEligible ? 1 : 0)
          || existing.actual_event_classification !== item.actualEventClassification
          || existing.diff_json !== JSON.stringify(item.diff)
        ) {
          throw new Error("GOLDEN_RESULT_CONFLICT");
        }
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  beginReplayJob(captureRunId: string | null, replacesJobId: string | null = null): string {
    const replayJobId = randomUUID();
    const now = new Date().toISOString();
    this.database
      .prepare(
        `INSERT INTO replay_jobs(
          replay_job_id, capture_run_id, state, replaces_job_id, started_at,
          heartbeat_at, source_code_commit, source_code_dirty, created_at
        ) VALUES (?, ?, 'RUNNING', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        replayJobId,
        captureRunId,
        replacesJobId,
        now,
        now,
        this.sourceVersion.commit,
        this.sourceVersion.dirty ? 1 : 0,
        now,
      );
    return replayJobId;
  }

  completeReplayJob(replayJobId: string, replayRunId: string): void {
    const now = new Date().toISOString();
    const result = this.database
      .prepare(
        `UPDATE replay_jobs
         SET state='COMPLETED', replay_run_id=?, heartbeat_at=?, finished_at=?
         WHERE replay_job_id=? AND state='RUNNING'`,
      )
      .run(replayRunId, now, now, replayJobId);
    if (result.changes !== 1) throw new Error(`Replay job is not RUNNING: ${replayJobId}`);
  }

  failReplayJob(replayJobId: string, error: unknown): void {
    const now = new Date().toISOString();
    this.database
      .prepare(
        `UPDATE replay_jobs
         SET state='FAILED', heartbeat_at=?, finished_at=?, error_detail=?
         WHERE replay_job_id=? AND state='RUNNING'`,
      )
      .run(now, now, error instanceof Error ? error.message : String(error), replayJobId);
  }

  recoverInterruptedReplayJobs(staleBefore: string): string[] {
    const rows = this.database
      .prepare(
        `SELECT replay_job_id FROM replay_jobs
         WHERE state='RUNNING' AND heartbeat_at < ?
         ORDER BY created_at`,
      )
      .all(staleBefore) as Array<{ replay_job_id: string }>;
    if (rows.length === 0) return [];
    const now = new Date().toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const update = this.database.prepare(
        `UPDATE replay_jobs
         SET state='INTERRUPTED', finished_at=?, error_detail='STALE_RUNNING_JOB_RECOVERED'
         WHERE replay_job_id=? AND state='RUNNING'`,
      );
      for (const row of rows) update.run(now, row.replay_job_id);
      this.database.exec("COMMIT");
      return rows.map((row) => row.replay_job_id);
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  loadCaptureRun(captureRunId: string): {
    captureRunId: string;
    targetId: string;
    walletAddress: string;
    manifestHash: string;
    sourceCodeCommit: string;
    sourceCodeDirty: boolean;
  } {
    const row = this.database
      .prepare(
        `SELECT capture_run_id, target_id, wallet_address, manifest_hash, source_code_commit, source_code_dirty
         FROM capture_runs WHERE capture_run_id=? AND status='COMPLETE'`,
      )
      .get(captureRunId) as {
        capture_run_id: string;
        target_id: string | null;
        wallet_address: string;
        manifest_hash: string;
        source_code_commit: string;
        source_code_dirty: number;
      } | undefined;
    if (!row) throw new Error(`Complete capture run not found: ${captureRunId}`);
    if (!row.target_id) throw new Error(`Capture run target missing: ${captureRunId}`);
    return {
      captureRunId: row.capture_run_id,
      targetId: row.target_id,
      walletAddress: row.wallet_address,
      manifestHash: row.manifest_hash,
      sourceCodeCommit: row.source_code_commit,
      sourceCodeDirty: row.source_code_dirty !== 0,
    };
  }

  loadCapturePayloads(captureRunId: string, endpoint: string): unknown[] {
    const rows = this.database
      .prepare(
        `SELECT c.payload_sha256,c.response_json,c.response_encoding,
                p.payload_blob,p.uncompressed_bytes
         FROM capture_manifest_items i
         JOIN api_captures c ON c.capture_id=i.capture_id
         LEFT JOIN api_capture_payloads p ON p.payload_sha256=c.payload_sha256
         WHERE i.capture_run_id=? AND i.source_endpoint=?
         ORDER BY COALESCE(i.page_index, 0), i.fetched_at`,
      )
      .all(captureRunId, endpoint) as unknown as CapturePayloadRow[];
    return rows.map(decodeCapturePayload);
  }

  captureEndpointWasComplete(captureRunId: string, endpoint: string): boolean {
    const rows = this.database
      .prepare(
        `SELECT pagination_status FROM capture_manifest_items
         WHERE capture_run_id=? AND source_endpoint=?`,
      )
      .all(captureRunId, endpoint) as Array<{ pagination_status: string }>;
    return rows.some((row) => row.pagination_status === "END_OF_DATA");
  }

  loadReplayHashes(captureRunId: string): string[] {
    const rows = this.database
      .prepare("SELECT DISTINCT report_hash FROM replay_runs WHERE capture_run_id=? ORDER BY report_hash")
      .all(captureRunId) as Array<{ report_hash: string }>;
    return rows.map((row) => row.report_hash);
  }

  saveReplay(
    targetId: string,
    trades: PublicTrade[],
    activity: PublicActivity[],
    report: ReplayReport,
    options: {
      captureRunId?: string | null;
      goldenEvaluationStatus?: string;
      capitalEstimatesBySourceEventKey?: Record<string, CapitalEstimate>;
      sourceEventMultiplicityEvidence?: SourceEventMultiplicityEvidence;
    } = {},
  ): string {
    const now = new Date().toISOString();
    const replayRunId = randomUUID();
    const activityTradeRows = activity.flatMap((item) => {
      const trade = activityAsTrade(item);
      return trade ? [{ item, trade }] : [];
    });
    const multiplicity = resolveSourceEventMultiplicity(
      trades,
      activityTradeRows.map((item) => item.trade),
      options.sourceEventMultiplicityEvidence,
    );
    const tradeOccurrenceKeys = new Set(multiplicity.trades.map((item) => item.sourceEventKey));
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const insertRaw = this.database.prepare(
        `INSERT OR IGNORE INTO raw_events(
          source_event_key, target_id, identity_version, source_type, source_transaction_hash,
          source_timestamp, asset_id, condition_id, side, price_units, size_micros,
          gap_event, is_combo, raw_json, created_at, capture_run_id, event_classification
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const { trade, sourceEventKey: eventKey } of multiplicity.trades) {
        const outcome = report.eventOutcomes[eventKey];
        insertRaw.run(
          eventKey,
          targetId,
          SOURCE_IDENTITY_VERSION,
          "DATA_API_TRADE",
          trade.transactionHash.toLowerCase(),
          trade.timestamp,
          trade.asset,
          trade.conditionId.toLowerCase(),
          trade.side,
          decimalToScaled(trade.price, PRICE_SCALE_DIGITS).toString(),
          decimalToScaled(trade.size, SHARE_SCALE_DIGITS).toString(),
          outcome?.eventClassification === "GAP_TRADE" ? 1 : 0,
          outcome?.eventClassification === "COMBO_ACTIVITY" ? 1 : 0,
          JSON.stringify(trade),
          now,
          options.captureRunId ?? null,
          outcome?.eventClassification ?? "UNRECOGNIZED",
        );
      }

      for (const [index, { trade, sourceEventKey: eventKey }] of multiplicity.activityTrades.entries()) {
        if (tradeOccurrenceKeys.has(eventKey)) continue;
        const item = activityTradeRows[index]!.item;
        const outcome = report.eventOutcomes[eventKey];
        insertRaw.run(
          eventKey,
          targetId,
          SOURCE_IDENTITY_VERSION,
          "DATA_API_ACTIVITY",
          trade.transactionHash.toLowerCase(),
          trade.timestamp,
          trade.asset,
          trade.conditionId.toLowerCase(),
          trade.side,
          decimalToScaled(trade.price, PRICE_SCALE_DIGITS).toString(),
          decimalToScaled(trade.size, SHARE_SCALE_DIGITS).toString(),
          outcome?.eventClassification === "GAP_TRADE" ? 1 : 0,
          outcome?.eventClassification === "COMBO_ACTIVITY" ? 1 : 0,
          JSON.stringify(item),
          now,
          options.captureRunId ?? null,
          outcome?.eventClassification ?? "UNRECOGNIZED",
        );
      }

      const insertActivity = this.database.prepare(
        `INSERT OR IGNORE INTO raw_events(
          source_event_key, target_id, identity_version, source_type, source_transaction_hash,
          source_timestamp, asset_id, condition_id, side, price_units, size_micros,
          gap_event, is_combo, raw_json, created_at, capture_run_id, event_classification
        ) VALUES (?, ?, ?, 'DATA_API_ACTIVITY', ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
      );
      for (const item of activity) {
        if (item.type === "TRADE") continue;
        const eventKey = activityEventKey(item);
        const outcome = report.eventOutcomes[eventKey];
        insertActivity.run(
          eventKey,
          targetId,
          ACTIVITY_IDENTITY_VERSION,
          item.transactionHash.toLowerCase(),
          item.timestamp,
          item.asset ?? "",
          item.conditionId?.toLowerCase() ?? "",
          item.side ?? "NONE",
          "0",
          "0",
          outcome?.eventClassification === "COMBO_ACTIVITY" ? 1 : 0,
          JSON.stringify(item),
          now,
          options.captureRunId ?? null,
          outcome?.eventClassification ?? "UNRECOGNIZED",
        );
      }

      for (const [eventKey, estimate] of Object.entries(options.capitalEstimatesBySourceEventKey ?? {})) {
        this.saveCapitalEstimate(targetId, eventKey, estimate);
      }

      const insertSignal = this.database.prepare(
        `INSERT OR IGNORE INTO signals(
          signal_id, target_id, signal_idempotency_key, source_event_key, signal_type, status,
          asset_id, condition_id, target_price_units, target_size_micros,
          sell_ratio_numerator, sell_ratio_denominator, reason,
          schema_version, signal_version, strategy_version, risk_version, replay_version,
          ruleset_snapshot_json, ruleset_hash, source_code_commit, created_at,
          execution_eligible, execution_block_reason, event_classification,
          capture_run_id, source_code_dirty, capital_estimate_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const signal of report.signals) {
        if (signal.targetId !== targetId) throw new Error(`REPLAY_SIGNAL_TARGET_MISMATCH:${signal.signalId}`);
        insertSignal.run(
          signal.signalId,
          signal.targetId,
          signal.signalIdempotencyKey,
          signal.sourceEventKey,
          signal.signalType,
          signal.status,
          signal.asset,
          signal.conditionId,
          signal.targetPriceUnits,
          signal.targetSizeMicros,
          signal.sellRatioNumerator ?? null,
          signal.sellRatioDenominator ?? null,
          signal.reason,
          VERSIONS.schemaVersion,
          VERSIONS.signalVersion,
          VERSIONS.strategyVersion,
          VERSIONS.riskVersion,
          VERSIONS.replayVersion,
          RULESET_SNAPSHOT_JSON,
          RULESET_HASH,
          this.sourceVersion.commit,
          now,
          signal.executionEligible ? 1 : 0,
          signal.executionBlockReason ?? null,
          signal.eventClassification,
          options.captureRunId ?? null,
          this.sourceVersion.dirty ? 1 : 0,
          options.capitalEstimatesBySourceEventKey?.[signal.sourceEventKey]?.capitalEstimateId ?? null,
        );
        this.saveTransition("SIGNAL", signal.signalId, null, "CREATED", "SOURCE_EVENT_ACCEPTED", now, 0);
        this.saveTransition("SIGNAL", signal.signalId, "CREATED", "VALIDATING", "IDENTITY_AND_SCHEMA_VALIDATION", now, 1);
        this.saveTransition("SIGNAL", signal.signalId, "VALIDATING", "READY", "SIGNAL_VALID", now, 2);
        this.saveTransition("SIGNAL", signal.signalId, "READY", "PUBLISHED", "REPLAY_PUBLISHED", now, 3);
      }

      this.database
        .prepare(
          `INSERT INTO replay_runs(
            replay_run_id, target_id, status, input_rows, unique_events, duplicate_rows,
            report_hash, metrics_json, incomplete_reasons_json, schema_version,
            signal_version, strategy_version, risk_version, replay_version,
            ruleset_snapshot_json, ruleset_hash, source_code_commit, created_at,
            capture_run_id, golden_evaluation_status, source_code_dirty
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          replayRunId,
          targetId,
          report.status,
          report.metrics.inputRows,
          report.metrics.uniqueEvents,
          report.metrics.duplicateRows,
          report.reportHash,
          JSON.stringify(report.metrics),
          JSON.stringify(report.incompleteReasons),
          VERSIONS.schemaVersion,
          VERSIONS.signalVersion,
          VERSIONS.strategyVersion,
          VERSIONS.riskVersion,
          VERSIONS.replayVersion,
          RULESET_SNAPSHOT_JSON,
          RULESET_HASH,
          this.sourceVersion.commit,
          now,
          options.captureRunId ?? null,
          options.goldenEvaluationStatus ?? "NOT_EVALUATED",
          this.sourceVersion.dirty ? 1 : 0,
        );
      const insertBucketLedger = this.database.prepare(
        `INSERT OR IGNORE INTO position_bucket_ledger(
          bucket_ledger_id, replay_run_id, source_event_key, asset_id,
          historical_before_micros, historical_after_micros,
          tracked_before_micros, tracked_after_micros, recognized_sell_micros,
          reason, ruleset_hash, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const entry of report.positionLedger) {
        insertBucketLedger.run(
          createHash("sha256").update(`${replayRunId}|${entry.sourceEventKey}|${entry.asset}`).digest("hex"),
          replayRunId,
          entry.sourceEventKey,
          entry.asset,
          entry.historicalBeforeMicros,
          entry.historicalAfterMicros,
          entry.trackedBeforeMicros,
          entry.trackedAfterMicros,
          entry.recognizedSellMicros,
          entry.reason,
          RULESET_HASH,
          now,
        );
      }
      const insertClassification = this.database.prepare(
        `INSERT OR IGNORE INTO replay_event_classifications(
          replay_classification_id, replay_run_id, source_event_key, event_classification,
          signal_id, signal_type, execution_eligible, reason, schema_version,
          signal_version, replay_version, ruleset_hash, source_code_commit,
          source_code_dirty, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const replaySignalsById = new Map(report.signals.map((signal) => [signal.signalId, signal]));
      for (const [eventKey, outcome] of Object.entries(report.eventOutcomes)) {
        const signalIds = outcome.signalIds?.length
          ? outcome.signalIds
          : outcome.signalId ? [outcome.signalId] : [null];
        for (const signalId of signalIds) {
          const replaySignal = signalId === null ? undefined : replaySignalsById.get(signalId);
          if (signalId !== null && !replaySignal) {
            throw new Error(`REPLAY_CLASSIFICATION_SIGNAL_MISSING:${eventKey}:${signalId}`);
          }
          insertClassification.run(
            createHash("sha256").update(`${replayRunId}|${eventKey}|${signalId ?? "NO_SIGNAL"}`).digest("hex"),
            replayRunId,
            eventKey,
            replaySignal?.eventClassification ?? outcome.eventClassification,
            signalId,
            replaySignal?.signalType ?? outcome.signalType ?? null,
            replaySignal === undefined
              ? outcome.executionEligible === undefined ? null : outcome.executionEligible ? 1 : 0
              : replaySignal.executionEligible ? 1 : 0,
            replaySignal?.reason ?? outcome.reason,
            VERSIONS.schemaVersion,
            VERSIONS.signalVersion,
            VERSIONS.replayVersion,
            RULESET_HASH,
            this.sourceVersion.commit,
            this.sourceVersion.dirty ? 1 : 0,
            now,
          );
        }
      }
      this.saveTransition("REPLAY", replayRunId, null, "CREATED", "REPLAY_REQUESTED", now, 0);
      this.saveTransition("REPLAY", replayRunId, "CREATED", "INPUT_VALIDATING", "INPUT_RECEIVED", now, 1);
      if (report.status === "FAILED") {
        this.saveTransition("REPLAY", replayRunId, "INPUT_VALIDATING", "FAILED", "INPUT_OR_IDENTITY_INVALID", now, 2);
      } else {
        this.saveTransition("REPLAY", replayRunId, "INPUT_VALIDATING", "RUNNING", "INPUT_VALID", now, 2);
        this.saveTransition("REPLAY", replayRunId, "RUNNING", "COMPARING", "PROJECTION_COMPLETE", now, 3);
        this.saveTransition(
          "REPLAY",
          replayRunId,
          "COMPARING",
          report.status,
          report.status === "PASSED" ? "ALL_ACCEPTANCE_CHECKS_PASSED" : "ACCEPTANCE_EVIDENCE_INCOMPLETE",
          now,
          4,
        );
      }
      this.database.exec("COMMIT");
      return replayRunId;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private saveTransition(
    entityType: string,
    entityId: string,
    fromState: string | null,
    toState: string,
    reason: string,
    createdAt: string,
    sequence: number,
  ): void {
    const transitionId = createHash("sha256")
      .update([entityType, entityId, String(sequence), fromState ?? "NONE", toState, RULESET_HASH].join("|"))
      .digest("hex");
    this.database
      .prepare(
        `INSERT OR IGNORE INTO state_transitions(
          transition_id, entity_type, entity_id, from_state, to_state, reason,
          schema_version, signal_version, strategy_version, risk_version, replay_version,
          ruleset_snapshot_json, ruleset_hash, source_code_commit, created_at, source_code_dirty
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        transitionId,
        entityType,
        entityId,
        fromState,
        toState,
        reason,
        VERSIONS.schemaVersion,
        VERSIONS.signalVersion,
        VERSIONS.strategyVersion,
        VERSIONS.riskVersion,
        VERSIONS.replayVersion,
        RULESET_SNAPSHOT_JSON,
        RULESET_HASH,
        this.sourceVersion.commit,
        createdAt,
        this.sourceVersion.dirty ? 1 : 0,
      );
  }

  close(): void {
    this.database.close();
  }
}
