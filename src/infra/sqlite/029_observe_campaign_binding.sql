-- Campaign Observe runs must carry an explicit, immutable Campaign/Session
-- identity. Standalone Observe remains valid with both fields NULL.

ALTER TABLE observe_runs
  ADD COLUMN campaign_id TEXT REFERENCES paper_validation_campaigns(campaign_id);

ALTER TABLE observe_runs
  ADD COLUMN campaign_session_id TEXT REFERENCES paper_validation_sessions(session_id);

CREATE INDEX observe_runs_campaign_session_idx
ON observe_runs(campaign_id,campaign_session_id,started_at,observe_run_id);

CREATE TRIGGER observe_runs_campaign_binding_pair
BEFORE INSERT ON observe_runs
WHEN (NEW.campaign_id IS NULL) <> (NEW.campaign_session_id IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'observe campaign and session must be provided together');
END;

CREATE TRIGGER observe_runs_campaign_binding_consistency
BEFORE INSERT ON observe_runs
WHEN NEW.campaign_id IS NOT NULL
 AND NOT EXISTS (
   SELECT 1
   FROM paper_validation_sessions s
   JOIN paper_validation_campaigns c ON c.campaign_id=s.campaign_id
   WHERE s.campaign_id=NEW.campaign_id
     AND s.session_id=NEW.campaign_session_id
     AND c.target_id=NEW.target_id
     AND c.baseline_run_id=NEW.baseline_run_id
     AND s.schema_version=NEW.schema_version
     AND s.ruleset_hash=NEW.ruleset_hash
     AND s.source_code_commit=NEW.source_code_commit
     AND s.source_code_dirty=NEW.source_code_dirty
 )
BEGIN
  SELECT RAISE(ABORT, 'observe campaign session binding is invalid');
END;

CREATE TRIGGER observe_runs_campaign_binding_immutable
BEFORE UPDATE OF campaign_id,campaign_session_id,target_id,baseline_run_id,
  schema_version,ruleset_hash,source_code_commit,source_code_dirty ON observe_runs
WHEN OLD.campaign_id IS NOT NEW.campaign_id
  OR OLD.campaign_session_id IS NOT NEW.campaign_session_id
  OR OLD.target_id IS NOT NEW.target_id
  OR OLD.baseline_run_id IS NOT NEW.baseline_run_id
  OR OLD.schema_version IS NOT NEW.schema_version
  OR OLD.ruleset_hash IS NOT NEW.ruleset_hash
  OR OLD.source_code_commit IS NOT NEW.source_code_commit
  OR OLD.source_code_dirty IS NOT NEW.source_code_dirty
BEGIN
  SELECT RAISE(ABORT, 'observe campaign binding is immutable');
END;

-- Checkpoints are append-only evidence. New rows keep the legacy JSON column
-- empty and resolve the content through the immutable snapshot reference.
DROP TRIGGER observe_checkpoints_projection_snapshot_required;

CREATE TRIGGER observe_checkpoints_projection_snapshot_required
BEFORE INSERT ON observe_checkpoints
WHEN NEW.position_projection_json <> ''
  OR NEW.projection_snapshot_hash IS NULL
  OR NEW.projection_snapshot_hash <> NEW.position_projection_hash
  OR NOT EXISTS (
    SELECT 1 FROM observe_projection_snapshots p
    WHERE p.projection_snapshot_hash=NEW.projection_snapshot_hash
  )
BEGIN
  SELECT RAISE(ABORT, 'observe checkpoint projection snapshot mismatch');
END;

CREATE TRIGGER observe_checkpoints_no_update
BEFORE UPDATE ON observe_checkpoints
BEGIN
  SELECT RAISE(ABORT, 'observe_checkpoints is immutable');
END;

CREATE TRIGGER observe_checkpoints_no_delete
BEFORE DELETE ON observe_checkpoints
BEGIN
  SELECT RAISE(ABORT, 'observe_checkpoints is immutable');
END;
