-- Migration: 001_create_idempotency_keys.sql
-- Description: Creates the idempotency_keys table with unique constraint on key and endpoint.

BEGIN;

CREATE TABLE IF NOT EXISTS idempotency_keys (
    id              BIGSERIAL       PRIMARY KEY,
    idempotency_key TEXT            NOT NULL,
    endpoint        TEXT            NOT NULL,
    response_body   JSONB,
    response_status INTEGER,
    created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    expires_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW() + INTERVAL '24 hours'
);

-- Unique constraint ensures idempotency per key+endpoint combination
CREATE UNIQUE INDEX IF NOT EXISTS idx_idempotency_keys_unique
    ON idempotency_keys (idempotency_key, endpoint);

-- Index for fast lookups by key (common query pattern)
CREATE INDEX IF NOT EXISTS idx_idempotency_keys_key
    ON idempotency_keys (idempotency_key);

-- Index for cleanup of expired entries
CREATE INDEX IF NOT EXISTS idx_idempotency_keys_expires_at
    ON idempotency_keys (expires_at);

COMMENT ON TABLE idempotency_keys IS 'Stores idempotency keys for deduplication of API requests.';
COMMENT ON COLUMN idempotency_keys.idempotency_key IS 'Client-provided idempotency key';
COMMENT ON COLUMN idempotency_keys.endpoint IS 'API endpoint path (e.g. /api/withdraw)';
COMMENT ON COLUMN idempotency_keys.response_body IS 'Cached response body to return on duplicate request';
COMMENT ON COLUMN idempotency_keys.response_status IS 'HTTP status code of the original response';
COMMENT ON COLUMN idempotency_keys.expires_at IS 'Time after which the record can be purged (default 24h)';

COMMIT;