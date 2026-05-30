-- backend/db/migrations/002_add_transaction_timeout.sql
-- Up Migration: Add timeout and auto-cancel tracking columns

ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS timeout_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS auto_canceled BOOLEAN NOT NULL DEFAULT FALSE;

-- Efficient lookup for pending timeouts that need cancellation
CREATE INDEX IF NOT EXISTS idx_transactions_timeout_cancel
  ON transactions (timeout_at)
  WHERE auto_canceled = FALSE AND timeout_at IS NOT NULL;

-- Down Migration: Revert changes
-- DROP INDEX IF EXISTS idx_transactions_timeout_cancel;
-- ALTER TABLE transactions DROP COLUMN IF EXISTS auto_canceled;
-- ALTER TABLE transactions DROP COLUMN IF EXISTS timeout_at;