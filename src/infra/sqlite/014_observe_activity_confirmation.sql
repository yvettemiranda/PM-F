ALTER TABLE observe_events
ADD COLUMN activity_confirmed INTEGER NOT NULL DEFAULT 0
CHECK(activity_confirmed IN (0, 1));

-- Existing emitted signals prove that the event passed the old Observe signal
-- path. Preserve that historical fact while new events require explicit
-- Activity confirmation before signal publication.
UPDATE observe_events
SET activity_confirmed=1
WHERE EXISTS (
  SELECT 1
  FROM signals s
  WHERE s.source_event_key=observe_events.source_event_key
    AND s.producer_mode='OBSERVE_ONLY'
);

CREATE INDEX observe_events_activity_confirmation_idx
ON observe_events(baseline_run_id, activity_confirmed, source_timestamp);
