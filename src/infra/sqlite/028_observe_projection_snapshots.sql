-- Store each Observe position projection once. Historical checkpoint payloads
-- remain untouched; new checkpoints reference this content-addressed table.

-- The pre-migration writer serialized a projection deterministically. The
-- same content hash with two different payloads therefore indicates corrupt
-- historical evidence and must stop the migration instead of choosing one
-- payload arbitrarily through GROUP BY.
CREATE TABLE observe_projection_snapshot_migration_guard (
  invalid_count INTEGER NOT NULL CHECK(invalid_count = 0)
);

INSERT INTO observe_projection_snapshot_migration_guard(invalid_count)
SELECT count(*) FROM (
  SELECT position_projection_hash
  FROM observe_checkpoints
  GROUP BY position_projection_hash
  HAVING count(DISTINCT position_projection_json) <> 1
);

DROP TABLE observe_projection_snapshot_migration_guard;

CREATE TABLE observe_projection_snapshots (
  projection_snapshot_hash TEXT PRIMARY KEY,
  projection_json TEXT NOT NULL CHECK(length(projection_json) > 0),
  created_at TEXT NOT NULL
);

INSERT OR IGNORE INTO observe_projection_snapshots(
  projection_snapshot_hash,projection_json,created_at
)
SELECT position_projection_hash,position_projection_json,min(created_at)
FROM observe_checkpoints
GROUP BY position_projection_hash;

ALTER TABLE observe_checkpoints
  ADD COLUMN projection_snapshot_hash TEXT REFERENCES observe_projection_snapshots(projection_snapshot_hash);

UPDATE observe_checkpoints
SET projection_snapshot_hash=position_projection_hash;

CREATE INDEX observe_checkpoints_projection_snapshot_idx
ON observe_checkpoints(projection_snapshot_hash);

CREATE TRIGGER observe_projection_snapshots_no_update
BEFORE UPDATE ON observe_projection_snapshots
BEGIN
  SELECT RAISE(ABORT, 'observe_projection_snapshots is immutable');
END;

CREATE TRIGGER observe_projection_snapshots_no_delete
BEFORE DELETE ON observe_projection_snapshots
BEGIN
  SELECT RAISE(ABORT, 'observe_projection_snapshots is immutable');
END;

CREATE TRIGGER observe_checkpoints_projection_snapshot_required
BEFORE INSERT ON observe_checkpoints
WHEN NEW.projection_snapshot_hash IS NULL
  OR NEW.projection_snapshot_hash <> NEW.position_projection_hash
BEGIN
  SELECT RAISE(ABORT, 'observe checkpoint projection snapshot mismatch');
END;
