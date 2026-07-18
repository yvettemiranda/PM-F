-- Mutable projection for Paper settlement polling. Immutable state-change
-- evidence remains in audit_log; this row only controls when the next public
-- resolution probe is due and therefore may be updated or removed.
CREATE TABLE paper_settlement_retry_state (
  paper_position_id TEXT PRIMARY KEY REFERENCES paper_positions(paper_position_id),
  paper_account_id TEXT NOT NULL REFERENCES paper_accounts(paper_account_id),
  condition_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('UNRESOLVED','ERROR')),
  consecutive_attempts INTEGER NOT NULL CHECK(consecutive_attempts > 0),
  next_retry_at TEXT NOT NULL,
  last_error_code TEXT,
  last_error_message TEXT,
  last_attempt_at TEXT NOT NULL,
  last_success_at TEXT,
  ruleset_hash TEXT NOT NULL REFERENCES rulesets(ruleset_hash),
  source_code_commit TEXT NOT NULL,
  source_code_dirty INTEGER NOT NULL,
  config_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX paper_settlement_retry_due_idx
ON paper_settlement_retry_state(paper_account_id,next_retry_at,paper_position_id);

-- Every new Session binds the acceptance policy, isolated verification suite,
-- operator build and artifact provenance used to interpret its evidence.
-- Legacy rows are nullable because their Campaign core is replaced rather than
-- silently inheriting into the new schema.
ALTER TABLE paper_validation_sessions ADD COLUMN validation_policy_hash TEXT;
ALTER TABLE paper_validation_sessions ADD COLUMN verification_suite_hash TEXT;
ALTER TABLE paper_validation_sessions ADD COLUMN operator_build_hash TEXT;
ALTER TABLE paper_validation_sessions ADD COLUMN artifact_provenance_hash TEXT;

CREATE TRIGGER paper_validation_sessions_compatibility_identity_required
BEFORE INSERT ON paper_validation_sessions
WHEN NEW.validation_policy_hash IS NULL
  OR length(NEW.validation_policy_hash) <> 64
  OR NEW.validation_policy_hash GLOB '*[^0-9a-f]*'
  OR NEW.verification_suite_hash IS NULL
  OR length(NEW.verification_suite_hash) <> 64
  OR NEW.verification_suite_hash GLOB '*[^0-9a-f]*'
  OR NEW.operator_build_hash IS NULL
  OR length(NEW.operator_build_hash) <> 64
  OR NEW.operator_build_hash GLOB '*[^0-9a-f]*'
  OR NEW.artifact_provenance_hash IS NULL
  OR length(NEW.artifact_provenance_hash) <> 64
  OR NEW.artifact_provenance_hash GLOB '*[^0-9a-f]*'
BEGIN
  SELECT RAISE(ABORT, 'paper validation session compatibility identity required');
END;

-- Append-only decisions explain exactly how evidence from an earlier Session
-- is treated after a non-core validation/tooling change.
CREATE TABLE paper_validation_evidence_adjudications (
  adjudication_id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES paper_validation_campaigns(campaign_id),
  session_id TEXT NOT NULL REFERENCES paper_validation_sessions(session_id),
  decision TEXT NOT NULL CHECK(decision IN (
    'KEEP_ALL',
    'KEEP_RUNTIME_REFRESH_ISOLATED',
    'KEEP_RUNTIME_REJUDGE_COVERAGE'
  )),
  previous_validation_policy_hash TEXT,
  current_validation_policy_hash TEXT NOT NULL,
  previous_verification_suite_hash TEXT,
  current_verification_suite_hash TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  evidence_hash TEXT NOT NULL,
  source_code_commit TEXT NOT NULL,
  source_code_dirty INTEGER NOT NULL CHECK(source_code_dirty IN (0, 1)),
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  FOREIGN KEY(campaign_id,session_id)
    REFERENCES paper_validation_sessions(campaign_id,session_id)
);

CREATE INDEX paper_validation_evidence_adjudications_campaign_idx
ON paper_validation_evidence_adjudications(campaign_id,session_id,created_at);

-- A PASSED Campaign may be reopened only by the service's policy/suite
-- revalidation guard. The database state machine allows that audited edge;
-- BLOCKED and FROZEN remain terminal for the same core.
DROP TRIGGER paper_validation_campaign_transition_insert_guard;

CREATE TRIGGER paper_validation_campaign_transition_insert_guard
BEFORE INSERT ON paper_validation_transitions
WHEN NEW.entity_type = 'CAMPAIGN'
BEGIN
  SELECT RAISE(ABORT, 'paper validation campaign transition sequence mismatch')
  WHERE NEW.sequence <> (
    SELECT coalesce(max(sequence), 0) + 1
    FROM paper_validation_transitions
    WHERE entity_type = 'CAMPAIGN' AND campaign_id = NEW.campaign_id
  );

  SELECT RAISE(ABORT, 'paper validation campaign transition from_state mismatch')
  WHERE NEW.from_state IS NOT (
    SELECT to_state
    FROM paper_validation_transitions
    WHERE entity_type = 'CAMPAIGN' AND campaign_id = NEW.campaign_id
    ORDER BY sequence DESC
    LIMIT 1
  );

  SELECT RAISE(ABORT, 'paper validation campaign transition is illegal')
  WHERE NOT (
    (NEW.from_state IS NULL AND NEW.to_state = 'QUALIFYING')
    OR (NEW.from_state = 'QUALIFYING' AND NEW.to_state IN ('RUNNING', 'BLOCKED', 'FROZEN'))
    OR (NEW.from_state = 'RUNNING' AND NEW.to_state IN (
      'PAUSED', 'INCOMPLETE_COVERAGE', 'PASSED', 'BLOCKED', 'FROZEN'
    ))
    OR (NEW.from_state = 'PAUSED' AND NEW.to_state IN ('RUNNING', 'BLOCKED', 'FROZEN'))
    OR (NEW.from_state = 'INCOMPLETE_COVERAGE' AND NEW.to_state IN ('RUNNING', 'BLOCKED', 'FROZEN'))
    OR (NEW.from_state = 'PASSED' AND NEW.to_state = 'RUNNING')
  );
END;

CREATE TRIGGER paper_validation_evidence_adjudications_no_update
BEFORE UPDATE ON paper_validation_evidence_adjudications
BEGIN
  SELECT RAISE(ABORT, 'paper_validation_evidence_adjudications is immutable');
END;

CREATE TRIGGER paper_validation_evidence_adjudications_no_delete
BEFORE DELETE ON paper_validation_evidence_adjudications
BEGIN
  SELECT RAISE(ABORT, 'paper_validation_evidence_adjudications is immutable');
END;
