import { Pool } from 'pg';
import { logger } from '../utils/logger'; // adjust path as needed

// Environment-based configuration with sensible defaults
const DB_CONNECTION_STRING = process.env.DATABASE_URL!;
const AUTO_CANCEL_TIMEOUT_MINUTES = parseInt(process.env.AUTO_CANCEL_TIMEOUT_MINUTES || '30', 10);
const BATCH_SIZE = parseInt(process.env.AUTO_CANCEL_BATCH_SIZE || '100', 10);
const SCHEDULE_INTERVAL_MS = parseInt(process.env.AUTO_CANCEL_INTERVAL_MS || '60000', 10); // 1 minute

const pool = new Pool({ connectionString: DB_CONNECTION_STRING });

/**
 * Cancels pending transactions that have exceeded the configured timeout.
 * Operates in batches to minimize lock contention and handle large volumes.
 * @returns The total number of transactions cancelled.
 */
export async function autoCancelPendingTransactions(): Promise<number> {
  let totalCancelled = 0;
  const timeoutAge = `${AUTO_CANCEL_TIMEOUT_MINUTES} minutes`;

  logger.info(`Starting auto-cancel for pending transactions older than ${timeoutAge}`);

  while (true) {
    const query = `
      UPDATE transactions
      SET status = 'cancelled',
          updated_at = NOW(),
          cancellation_reason = 'Auto-cancelled due to timeout (> ${timeoutAge})'
      WHERE id IN (
        SELECT id FROM transactions
        WHERE status = 'pending'
          AND (created_at < NOW() - INTERVAL '${timeoutAge}')
        ORDER BY created_at ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id;
    `;

    try {
      const result = await pool.query(query, [BATCH_SIZE]);

      if (result.rowCount === 0) {
        break; // No more pending transactions to cancel
      }

      totalCancelled += result.rowCount;
      logger.info(`Cancelled batch of ${result.rowCount} pending transactions (total: ${totalCancelled})`);
    } catch (err) {
      logger.error('Error during auto-cancel batch:', err);
      break; // Stop processing on DB error to avoid infinite retries
    }
  }

  logger.info(`Auto-cancel completed. Total cancelled: ${totalCancelled}`);
  return totalCancelled;
}

/**
 * Main entry point when script is run directly (e.g., via cron).
 * For use in a scheduled job, call `autoCancelPendingTransactions()` directly.
 */
if (require.main === module) {
  (async () => {
    try {
      await autoCancelPendingTransactions();
    } catch (err) {
      logger.error('Fatal error in auto-cancel script:', err);
      process.exit(1);
    } finally {
      await pool.end();
    }
  })();
}