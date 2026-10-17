-- Chain coordinates are immutable evidence, separate from legacy raw payloads.
CREATE TABLE observe_event_order_evidence (
  source_event_key TEXT PRIMARY KEY REFERENCES raw_events(source_event_key),
  chain_order_json TEXT NOT NULL CHECK(json_valid(chain_order_json)),
  evidence_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TRIGGER observe_event_order_no_update BEFORE UPDATE ON observe_event_order_evidence
BEGIN SELECT RAISE(ABORT, 'observe event order is immutable'); END;
CREATE TRIGGER observe_event_order_no_delete BEFORE DELETE ON observe_event_order_evidence
BEGIN SELECT RAISE(ABORT, 'observe event order is immutable'); END;

-- Old published Signals/checkpoint hashes cannot be silently rewritten. A new
-- verified baseline is required when their same-second chronology is unknown.
CREATE TABLE observe_ordering_blocks (
  baseline_run_id TEXT PRIMARY KEY REFERENCES position_baseline_runs(baseline_run_id),
  target_id TEXT NOT NULL REFERENCES monitor_targets(target_id),
  reason TEXT NOT NULL,
  detail_json TEXT NOT NULL CHECK(json_valid(detail_json)),
  created_at TEXT NOT NULL
);
CREATE TRIGGER observe_ordering_blocks_no_update BEFORE UPDATE ON observe_ordering_blocks
BEGIN SELECT RAISE(ABORT, 'observe ordering block is immutable'); END;
CREATE TRIGGER observe_ordering_blocks_no_delete BEFORE DELETE ON observe_ordering_blocks
BEGIN SELECT RAISE(ABORT, 'observe ordering block is immutable'); END;

WITH observed AS (
  SELECT o.baseline_run_id,o.source_timestamp,r.*,
    CASE WHEN r.side IN ('BUY','SELL') AND coalesce(json_extract(r.raw_json,'$.type'),'TRADE')='TRADE'
      THEN r.source_transaction_hash||char(31)||r.asset_id||char(31)||r.side
        ||char(31)||r.price_units||char(31)||r.size_micros
      ELSE r.source_event_key END economic_identity
  FROM observe_events o JOIN raw_events r ON r.source_event_key=o.source_event_key
  WHERE r.side IN ('BUY','SELL')
    OR json_extract(r.raw_json,'$.type') IN ('MERGE','SPLIT','REDEEM','CONVERSION')
), asset_conditions AS (
  SELECT baseline_run_id,asset_id,lower(condition_id) condition_id FROM position_baseline_items
  UNION
  SELECT baseline_run_id,asset_id,lower(condition_id) FROM observed WHERE side IN ('BUY','SELL')
  UNION
  SELECT o.baseline_run_id,json_extract(leg.value,'$.asset'),lower(json_extract(leg.value,'$.conditionId'))
  FROM observed o JOIN negative_risk_conversion_evidence c ON c.source_event_key=o.source_event_key,
    json_each(c.destination_legs_json) leg
), affected_conditions AS (
  SELECT baseline_run_id,source_timestamp,economic_identity,lower(condition_id) condition_id FROM observed
  UNION
  SELECT o.baseline_run_id,o.source_timestamp,o.economic_identity,a.condition_id
  FROM observed o JOIN negative_risk_conversion_evidence c ON c.source_event_key=o.source_event_key
    JOIN asset_conditions a ON a.baseline_run_id=o.baseline_run_id AND a.asset_id=c.source_asset_id
  UNION
  SELECT o.baseline_run_id,o.source_timestamp,o.economic_identity,lower(json_extract(leg.value,'$.conditionId'))
  FROM observed o JOIN negative_risk_conversion_evidence c ON c.source_event_key=o.source_event_key,
    json_each(c.destination_legs_json) leg
), ambiguous AS (
  SELECT baseline_run_id,source_timestamp,condition_id FROM affected_conditions
  WHERE condition_id IS NOT NULL AND condition_id<>''
  GROUP BY baseline_run_id,source_timestamp,condition_id
  HAVING COUNT(DISTINCT economic_identity)>1
)
INSERT INTO observe_ordering_blocks(baseline_run_id,target_id,reason,detail_json,created_at)
SELECT DISTINCT ambiguous.baseline_run_id,b.target_id,'LEGACY_SAME_SECOND_ORDER_UNVERIFIED',
  '{"requiredAction":"CREATE_VERIFIED_BASELINE","preservedEvidence":true}',strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM ambiguous JOIN position_baseline_runs b ON b.baseline_run_id=ambiguous.baseline_run_id;
UPDATE monitor_targets SET sync_status='MAJOR_DESYNC'
WHERE target_id IN (SELECT target_id FROM observe_ordering_blocks);
