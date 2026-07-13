ALTER TABLE api_captures
  ADD COLUMN response_encoding TEXT NOT NULL DEFAULT 'INLINE_JSON';

CREATE TABLE api_capture_payloads (
  payload_sha256 TEXT PRIMARY KEY,
  compression TEXT NOT NULL CHECK(compression IN ('GZIP')),
  payload_blob BLOB NOT NULL,
  uncompressed_bytes INTEGER NOT NULL CHECK(uncompressed_bytes >= 0),
  compressed_bytes INTEGER NOT NULL CHECK(compressed_bytes >= 0),
  created_at TEXT NOT NULL
);
