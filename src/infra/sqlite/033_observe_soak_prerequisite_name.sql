INSERT INTO live_gate_prerequisites(prerequisite_key,status,evidence_json,updated_at)
SELECT 'OBSERVE_ONLY_8H_SOAK',status,evidence_json,updated_at
FROM live_gate_prerequisites
WHERE prerequisite_key='OBSERVE_ONLY_24H_SOAK'
ON CONFLICT(prerequisite_key) DO NOTHING;

INSERT OR IGNORE INTO live_gate_prerequisites(prerequisite_key,status,evidence_json,updated_at)
VALUES ('OBSERVE_ONLY_8H_SOAK','PENDING','{}',datetime('now'));

DELETE FROM live_gate_prerequisites
WHERE prerequisite_key='OBSERVE_ONLY_24H_SOAK';
