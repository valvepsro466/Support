typescript
import { v4 as uuidv4, validate as uuidValidate, version as uuidVersion } from 'uuid';

// ---------------------------------------------------------------------------
// Configuration & Logging (production-grade)
// ---------------------------------------------------------------------------

/**
 * Supported logging levels.
 */
export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

/**
 * Priority mapping – higher number = more verbose.
 */
const LOG_PRIORITY: Readonly<Record<LogLevel, number>> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
} as const;

/**
 * Retrieves the configured log level from the environment.
 * Defaults to 'warn' if not set or invalid.
 */
function getLogLevel(): LogLevel {
  const raw: string = (process.env.LOG_LEVEL ?? 'warn').trim().toLowerCase() as LogLevel;
  if ((Object.keys(LOG_PRIORITY) as LogLevel[]).includes(raw as LogLevel)) {
    return raw as LogLevel;
  }
  return 'warn';
}

const CURRENT_LOG_LEVEL: LogLevel = getLogLevel();

/**
 * Structured logger.
 * In production, consider replacing with Winston/Pino – this is a compliant stand-in.
 */
export const logger = {
  log(level: LogLevel, message: string, context?: Record<string, unknown>): void {
    if (LOG_PRIORITY[level] > LOG_PRIORITY[CURRENT_LOG_LEVEL]) {
      return;
    }
    const entry: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...(context ?? {}),
    };
    const output: string = JSON.stringify(entry);
    switch (level) {
      case 'error':
        console.error(output);
        break;
      case 'warn':
        console.warn(output);
        break;
      default:
        console.log(output);
    }
  },

  error(message: string, context?: Record<string, unknown>): void {
    this.log('error', message, context);
  },
  warn(message: string, context?: Record<string, unknown>): void {
    this.log('warn', message, context);
  },
  info(message: string, context?: Record<string, unknown>): void {
    this.log('info', message, context);
  },
  debug(message: string, context?: Record<string, unknown>): void {
    this.log('debug', message, context);
  },
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * HTTP header name for transmitting the idempotency key.
 */
export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key' as const;

// ---------------------------------------------------------------------------
// Interfaces & Types
// ---------------------------------------------------------------------------

/**
 * Result of an idempotency key generation attempt.
 */
export interface IdempotencyKeyResult {
  /** The generated UUID v4 string. */
  readonly key: string;
  /** Whether generation succeeded. */
  readonly success: boolean;
  /** Error message if generation failed, otherwise `null`. */
  readonly error: string | null;
}

/**
 * Options for generating an idempotency key.
 */
export interface GenerateIdempotencyKeyOptions {
  /**
   * If `true`, throw an `IdempotencyKeyGenerationError` on failure.
   * If `false` (default), return a result object with success flag.
   */
  readonly throwOnError?: boolean;
}

// ---------------------------------------------------------------------------
// Custom Errors
// ---------------------------------------------------------------------------

/**
 * Error thrown when idempotency key generation fails (if `throwOnError` is set).
 */
export class IdempotencyKeyGenerationError extends Error {
  public readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'IdempotencyKeyGenerationError';
    this.cause = cause;

    // Proper stack trace in V8 environments
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, IdempotencyKeyGenerationError);
    }
  }
}

// ---------------------------------------------------------------------------
// Idempotency Key Utilities
// ---------------------------------------------------------------------------

/**
 * Generates a new unique idempotency key (UUID v4).
 *
 * This function is safe for concurrent usage – it does not mutate any external state.
 * The generated key is a valid, non-nil UUID v4.
 *
 * @param options - Optional configuration to control error behaviour.
 * @returns An `IdempotencyKeyResult` containing the key, success flag, and any error.
 *          Throws `IdempotencyKeyGenerationError` if `throwOnError` is `true` and generation fails.
 *
 * @example
 *