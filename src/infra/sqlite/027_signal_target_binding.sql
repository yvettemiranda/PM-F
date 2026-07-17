-- Make target ownership an immutable part of the executable Signal contract.
-- raw_events remains linked for provenance only; execution paths must not use
-- it to infer which monitored target owns a Signal.

DROP TRIGGER IF EXISTS signals_no_update;
DROP TRIGGER IF EXISTS signal_execution_contexts_no_update;

ALTER TABLE signals
ADD COLUMN target_id TEXT REFERENCES monitor_targets(target_id);

UPDATE signals
SET target_id = (
  SELECT raw_events.target_id
  FROM raw_events
  WHERE raw_events.source_event_key = signals.source_event_key
);

ALTER TABLE signal_execution_contexts
ADD COLUMN target_id TEXT REFERENCES monitor_targets(target_id);

UPDATE signal_execution_contexts
SET target_id = (
  SELECT signals.target_id
  FROM signals
  WHERE signals.signal_id = signal_execution_contexts.signal_id
);

-- Abort the migration if any historical executable identity could not be
-- reconstructed exactly. A CHECK table works outside trigger bodies and rolls
-- back with the migration transaction.
CREATE TABLE signal_target_binding_migration_guard (
  invalid_count INTEGER NOT NULL CHECK(invalid_count = 0)
);

INSERT INTO signal_target_binding_migration_guard(invalid_count)
SELECT count(*) FROM signals WHERE target_id IS NULL;

INSERT INTO signal_target_binding_migration_guard(invalid_count)
SELECT count(*)
FROM signals s
JOIN raw_events r ON r.source_event_key = s.source_event_key
WHERE s.target_id <> r.target_id;

INSERT INTO signal_target_binding_migration_guard(invalid_count)
SELECT count(*) FROM signal_execution_contexts WHERE target_id IS NULL;

INSERT INTO signal_target_binding_migration_guard(invalid_count)
SELECT count(*)
FROM signal_execution_contexts c
JOIN signals s ON s.signal_id = c.signal_id
WHERE c.target_id <> s.target_id;

-- A historical capital estimate with a source event must belong to that
-- source event's target. Estimates without a source event are account-level
-- snapshots and are valid as long as later Signal links match their target.
INSERT INTO signal_target_binding_migration_guard(invalid_count)
SELECT count(*)
FROM capital_estimates c
LEFT JOIN raw_events r ON r.source_event_key = c.source_event_key
WHERE c.source_event_key IS NOT NULL
  AND (r.source_event_key IS NULL OR c.target_id <> r.target_id);

-- A Signal may have no capital estimate, but a referenced estimate must
-- exist, belong to the same target, and (when event-scoped) describe the same
-- source event.
INSERT INTO signal_target_binding_migration_guard(invalid_count)
SELECT count(*)
FROM signals s
LEFT JOIN capital_estimates c ON c.capital_estimate_id = s.capital_estimate_id
WHERE s.capital_estimate_id IS NOT NULL
  AND (
    c.capital_estimate_id IS NULL
    OR c.target_id <> s.target_id
    OR (c.source_event_key IS NOT NULL AND c.source_event_key <> s.source_event_key)
  );

-- Execution Context is an immutable snapshot of its Signal's capital
-- decision. It must reference the same estimate (including NULL), and that
-- estimate must preserve the Signal target/source relationship.
INSERT INTO signal_target_binding_migration_guard(invalid_count)
SELECT count(*)
FROM signal_execution_contexts x
LEFT JOIN signals s ON s.signal_id = x.signal_id
LEFT JOIN capital_estimates c ON c.capital_estimate_id = x.capital_decision_id
WHERE s.signal_id IS NULL
  OR x.capital_decision_id IS NOT s.capital_estimate_id
  OR (
    x.capital_decision_id IS NOT NULL
    AND (
      c.capital_estimate_id IS NULL
      OR c.target_id <> x.target_id
      OR (c.source_event_key IS NOT NULL AND c.source_event_key <> s.source_event_key)
    )
  );

DROP TABLE signal_target_binding_migration_guard;

CREATE INDEX signals_target_created_idx
ON signals(target_id, created_at, signal_id);

CREATE INDEX signal_execution_contexts_target_idx
ON signal_execution_contexts(target_id, created_at, context_id);

CREATE TRIGGER signals_target_id_required
BEFORE INSERT ON signals
WHEN NEW.target_id IS NULL OR trim(NEW.target_id) = ''
BEGIN
  SELECT RAISE(ABORT, 'signal target_id is required');
END;

CREATE TRIGGER signals_target_source_consistency
BEFORE INSERT ON signals
WHEN NOT EXISTS (
  SELECT 1 FROM raw_events r
  WHERE r.source_event_key = NEW.source_event_key
    AND r.target_id = NEW.target_id
)
BEGIN
  SELECT RAISE(ABORT, 'signal target_id does not match source event');
END;

CREATE TRIGGER signals_target_capital_consistency
BEFORE INSERT ON signals
WHEN NEW.capital_estimate_id IS NOT NULL
 AND NOT EXISTS (
  SELECT 1 FROM capital_estimates c
  WHERE c.capital_estimate_id = NEW.capital_estimate_id
    AND c.target_id = NEW.target_id
    AND (c.source_event_key IS NULL OR c.source_event_key = NEW.source_event_key)
)
BEGIN
  SELECT RAISE(ABORT, 'signal target_id does not match capital estimate');
END;

CREATE TRIGGER signal_execution_contexts_target_id_required
BEFORE INSERT ON signal_execution_contexts
WHEN NEW.target_id IS NULL OR trim(NEW.target_id) = ''
BEGIN
  SELECT RAISE(ABORT, 'signal execution context target_id is required');
END;

CREATE TRIGGER signal_execution_contexts_target_signal_consistency
BEFORE INSERT ON signal_execution_contexts
WHEN NOT EXISTS (
  SELECT 1 FROM signals s
  WHERE s.signal_id = NEW.signal_id
    AND s.target_id = NEW.target_id
)
BEGIN
  SELECT RAISE(ABORT, 'signal execution context target_id does not match signal');
END;

CREATE TRIGGER signal_execution_contexts_target_capital_consistency
BEFORE INSERT ON signal_execution_contexts
WHEN NOT EXISTS (
  SELECT 1
  FROM signals s
  LEFT JOIN capital_estimates c
    ON c.capital_estimate_id = NEW.capital_decision_id
  WHERE s.signal_id = NEW.signal_id
    AND NEW.capital_decision_id IS s.capital_estimate_id
    AND (
      NEW.capital_decision_id IS NULL
      OR (
        c.target_id = NEW.target_id
        AND (c.source_event_key IS NULL OR c.source_event_key = s.source_event_key)
      )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'signal execution context does not match Signal capital decision');
END;

-- SQLite evaluates same-timing triggers in reverse creation order. Recreate
-- the required guards last so a missing identity reports the precise failure
-- instead of a secondary consistency error.
DROP TRIGGER signals_target_id_required;
CREATE TRIGGER signals_target_id_required
BEFORE INSERT ON signals
WHEN NEW.target_id IS NULL OR trim(NEW.target_id) = ''
BEGIN
  SELECT RAISE(ABORT, 'signal target_id is required');
END;

DROP TRIGGER signal_execution_contexts_target_id_required;
CREATE TRIGGER signal_execution_contexts_target_id_required
BEFORE INSERT ON signal_execution_contexts
WHEN NEW.target_id IS NULL OR trim(NEW.target_id) = ''
BEGIN
  SELECT RAISE(ABORT, 'signal execution context target_id is required');
END;

CREATE TRIGGER raw_events_target_id_immutable
BEFORE UPDATE OF target_id ON raw_events
WHEN OLD.target_id IS NOT NEW.target_id
BEGIN
  SELECT RAISE(ABORT, 'raw event target_id is immutable');
END;

CREATE TRIGGER signals_target_id_immutable
BEFORE UPDATE OF target_id ON signals
WHEN OLD.target_id IS NOT NEW.target_id
BEGIN
  SELECT RAISE(ABORT, 'signal target_id is immutable');
END;

CREATE TRIGGER signal_execution_contexts_target_id_immutable
BEFORE UPDATE OF target_id ON signal_execution_contexts
WHEN OLD.target_id IS NOT NEW.target_id
BEGIN
  SELECT RAISE(ABORT, 'signal execution context target_id is immutable');
END;

CREATE TRIGGER signals_no_update
BEFORE UPDATE ON signals
BEGIN
  SELECT RAISE(ABORT, 'signals is immutable');
END;

CREATE TRIGGER signal_execution_contexts_no_update
BEFORE UPDATE ON signal_execution_contexts
BEGIN
  SELECT RAISE(ABORT, 'signal_execution_context is immutable');
END;
