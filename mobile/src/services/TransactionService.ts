typescript
// =============================================================================
// Custom Error Classes
// =============================================================================

export class TransactionServiceError extends Error {
  public readonly code: string;
  constructor(message: string, code: string = 'TRANSACTION_SERVICE_ERROR') {
    super(message);
    this.name = 'TransactionServiceError';
    this.code = code;
    Object.setPrototypeOf(this, TransactionServiceError.prototype);
  }
}

export class TransactionConcurrentError extends TransactionServiceError {
  constructor() {
    super('Another transaction submission is already in progress.', 'TRANSACTION_CONCURRENT_ERROR');
    this.name = 'TransactionConcurrentError';
    Object.setPrototypeOf(this, TransactionConcurrentError.prototype);
  }
}

export class TransactionValidationError extends TransactionServiceError {
  constructor(message: string) {
    super(message, 'TRANSACTION_VALIDATION_ERROR');
    this.name = 'TransactionValidationError';
    Object.setPrototypeOf(this, TransactionValidationError.prototype);
  }
}

export class TransactionTimeoutError extends TransactionServiceError {
  constructor(transactionId: string) {
    super(`Transaction ${transactionId} timed out after polling duration.`, 'TRANSACTION_TIMEOUT_ERROR');
    this.name = 'TransactionTimeoutError';
    Object.setPrototypeOf(this, TransactionTimeoutError.prototype);
  }
}

export class TransactionRejectedError extends TransactionServiceError {
  public readonly reason: string;
  constructor(reason: string) {
    super(`Transaction was rejected by the server: ${reason}`, 'TRANSACTION_REJECTED_ERROR');
    this.name = 'TransactionRejectedError';
    this.reason = reason;
    Object.setPrototypeOf(this, TransactionRejectedError.prototype);
  }
}

export class TransactionCanceledError extends TransactionServiceError {
  constructor() {
    super('Transaction submission was canceled by user.', 'TRANSACTION_CANCELED_ERROR');
    this.name = 'TransactionCanceledError';
    Object.setPrototypeOf(this, TransactionCanceledError.prototype);
  }
}

// =============================================================================
// Type Definitions
// =============================================================================

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export enum TransactionStatus {
  PENDING = 'PENDING',
  CONFIRMED = 'CONFIRMED',
  FAILED = 'FAILED',
  REJECTED = 'REJECTED',
  CANCELED = 'CANCELED',
}

export interface TransactionResult {
  transactionId: string;
  status: TransactionStatus;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface TransactionServiceConfig {
  baseUrl: string;
  apiKey?: string;
  pollingIntervalMs?: number;
  maxPollingDurationMs?: number;
  requestTimeoutMs?: number;
  maxPollingRetries?: number;
  logger?: Logger;
  getAuthToken?: () => Promise<string | null>;
}

export interface SubmitTransactionParams {
  amount: string;
  destination: string;
  memo?: string;
  idempotencyKey?: string;
}

export interface StatusResponse {
  status: TransactionStatus;
  error?: string;
  metadata?: Record<string, unknown>;
}

// Internal types
interface SubmitResponse {
  id: string;
}

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_POLLING_INTERVAL_MS = 2000;
const DEFAULT_MAX_POLLING_DURATION_MS = 12000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10000;
const DEFAULT_MAX_POLLING_RETRIES = 3;
const MAX_MEMO_LENGTH = 256;
const MAX_AMOUNT_DECIMALS = 18;
const DESTINATION_REGEX = /^[a-zA-Z0-9_.\-:]+$/;
const IDEMPOTENCY_KEY_REGEX = /^[\w-]+$/;
const AMOUNT_DECIMAL_REGEX = /^\d+(\.\d+)?$/;

// =============================================================================
// Console Logger Implementation
// =============================================================================

class ConsoleLogger implements Logger {
  public debug(message: string, meta?: Record<string, unknown>): void {
    console.debug(`[TransactionService] ${message}`, meta ?? '');
  }
  public info(message: string, meta?: Record<string, unknown>): void {
    console.info(`[TransactionService] ${message}`, meta ?? '');
  }
  public warn(message: string, meta?: Record<string, unknown>): void {
    console.warn(`[TransactionService] ${message}`, meta ?? '');
  }
  public error(message: string, meta?: Record<string, unknown>): void {
    console.error(`[TransactionService] ${message}`, meta ?? '');
  }
}

// =============================================================================
// TransactionService
// =============================================================================

export class TransactionService {
  private readonly config: Required<TransactionServiceConfig>;
  private readonly logger: Logger;

  // Polling lifecycle
  private pollingTimer: ReturnType<typeof setInterval> | null = null;
  private pollingStartTime: number = 0;
  private pollingAttempts: number = 0;
  private requestAbortController: AbortController | null = null;
  private activeIdempotencyKey: string | null = null;
  private isSubmitting: boolean = false;
  private isCanceled: boolean = false;

  // Resolve / reject for the pending promise (if any)
  private pendingResolver: ((result: TransactionResult) => void) | null = null;
  private pendingRejecter: ((error: TransactionServiceError) => void) | null = null;

  /**
   * Creates a new TransactionService instance.
   * @param config - Configuration for the service.
   */
  constructor(config: TransactionServiceConfig) {
    const defaults: Required<Omit<TransactionServiceConfig, 'baseUrl' | 'apiKey' | 'getAuthToken'>> & {
      getAuthToken: (() => Promise<string | null>) | undefined;
    } = {
      pollingIntervalMs: DEFAULT_POLLING_INTERVAL_MS,
      maxPollingDurationMs: DEFAULT_MAX_POLLING_DURATION_MS,
      requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
      maxPollingRetries: DEFAULT_MAX_POLLING_RETRIES,
      logger: new ConsoleLogger(),
      getAuthToken: undefined,
    };

    const merged: Required<TransactionServiceConfig> = {
      ...defaults,
      ...config,
      logger: config.logger ?? new ConsoleLogger(),
      getAuthToken: config.getAuthToken ?? defaults.getAuthToken!,
    };
    this.config = merged;
    this.logger = merged.logger;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Submits a transaction to the backend with an idempotency key and monitors
   * its status until resolution or timeout.
   *
   * **Concurrency guard:** Only one `submitTransaction` call can be active at a
   * time. Inflight submissions will throw `TransactionConcurrentError`.
   *
   * @param params - Transaction input parameters (amount, destination, etc.).
   * @param onStatusChange - Optional callback invoked on each status poll
   *                         response (useful for UI progress).
   * @throws {TransactionConcurrentError} If another submission is already in progress.
   * @throws {TransactionValidationError} If input validation fails.
   * @throws {TransactionTimeoutError} If the transaction times out.
   * @throws {TransactionRejectedError} If the server explicitly rejects the request.
   * @throws {TransactionCanceledError} If the transaction is canceled via cancelTransaction.
   * @throws {TransactionServiceError} For network or unexpected errors.
   * @returns The final transaction result.
   */
  public async submitTransaction(
    params: SubmitTransactionParams,
    onStatusChange?: (status: TransactionStatus, details?: string) => void,
  ): Promise<TransactionResult> {
    // Guard against concurrent operations
    if (this.isSubmitting) {
      this.logger.warn('Concurrent submission attempt blocked');
      throw new TransactionConcurrentError();
    }

    this.isSubmitting = true;
    this.isCanceled = false;

    try {
      this.validateParams(params);
      const idempotencyKey = params.idempotencyKey ?? this.generateIdempotencyKey();
      this.activeIdempotencyKey = idempotencyKey;

      this.logger.info('Submitting transaction', { idempotencyKey, destination: params.destination, amount: params.amount });

      const transactionId = await this.sendTransactionRequest(
        idempotencyKey,
        params.amount,
        params.destination,
        params.memo,
      );

      this.logger.info('Transaction submitted successfully', { transactionId, idempotencyKey });

      // Poll for status
      const result = await this.pollForStatus(transactionId, idempotencyKey, onStatusChange);

      this.logger.info('Transaction completed', { transactionId, status: result.status });

      return result;
    } finally {
      this.cleanup();
    }
  }

  /**
   * Cancels an ongoing transaction submission. Has no effect if no submission
   * is active. The pending promise will reject with `TransactionCanceledError`.
   */
  public cancelTransaction(): void {
    if (!this.isSubmitting) {
      this.logger.warn('Cancel called while no submission active');
      return;
    }

    this.isCanceled = true;
    this.logger.info('Transaction cancellation requested');

    if (this.requestAbortController) {
      this.requestAbortController.abort();
      this.requestAbortController = null;
    }

    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = null;
    }

    if (this.pendingRejecter) {
      this.pendingRejecter(new TransactionCanceledError());
      this.pendingResolver = null;
      this.pendingRejecter = null;
    }
  }

  /**
   * Checks if a transaction submission is currently in progress.
   */
  public get isActive(): boolean {
    return this.isSubmitting;
  }

  // ---------------------------------------------------------------------------
  // Private Methods
  // ---------------------------------------------------------------------------

  /**
   * Validates transaction parameters.
   * @param params - The parameters to validate.
   * @throws {TransactionValidationError} If any parameter is invalid.
   */
  private validateParams(params: SubmitTransactionParams): void {
    const { amount, destination, memo, idempotencyKey } = params;

    if (!amount || typeof amount !== 'string') {
      throw new TransactionValidationError('Amount must be a non-empty string.');
    }

    if (!AMOUNT_DECIMAL_REGEX.test(amount)) {
      throw new TransactionValidationError('Amount must be a valid decimal number.');
    }

    const decimalParts = amount.split('.');
    if (decimalParts.length === 2 && decimalParts[1].length > MAX_AMOUNT_DECIMALS) {
      throw new TransactionValidationError(`Amount must not exceed ${MAX_AMOUNT_DECIMALS} decimal places.`);
    }

    const numericAmount = parseFloat(amount);
    if (isNaN(numericAmount) || numericAmount <= 0) {
      throw new TransactionValidationError('Amount must be a positive number.');
    }

    if (!destination || typeof destination !== 'string') {
      throw new TransactionValidationError('Destination must be a non-empty string.');
    }

    if (!DESTINATION_REGEX.test(destination)) {
      throw new TransactionValidationError(
        'Destination contains invalid characters. Allowed: alphanumeric, underscore, hyphen, colon, dot.',
      );
    }

    if (memo !== undefined && typeof memo === 'string') {
      if (memo.length > MAX_MEMO_LENGTH) {
        throw new TransactionValidationError(`Memo must not exceed ${MAX_MEMO_LENGTH} characters.`);
      }
    } else if (memo !== undefined) {
      throw new TransactionValidationError('Memo must be a string if provided.');
    }

    if (idempotencyKey !== undefined) {
      if (typeof idempotencyKey !== 'string' || !IDEMPOTENCY_KEY_REGEX.test(idempotencyKey)) {
        throw new TransactionValidationError(
          'Idempotency key must be a string containing only letters, numbers, underscores, or hyphens.',
        );
      }
    }
  }

  /**
   * Generates a unique idempotency key (UUID v4).
   * @returns A UUID v4 string.
   */
  private generateIdempotencyKey(): string {
    // Use crypto.randomUUID if available, else fallback
    if (typeof globalThis.crypto?.randomUUID === 'function') {
      return globalThis.crypto.randomUUID();
    }
    // Fallback for environments without crypto.randomUUID (e.g., older Node.js)
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  /**
   * Sends the initial transaction request to the backend.
   * @param idempotencyKey - The idempotency key for the request.
   * @param amount - The transaction amount.
   * @param destination - The destination address.
   * @param memo - Optional memo.
   * @returns The transaction ID from the server.
   * @throws {TransactionRejectedError} If the server returns an error status.
   * @throws {TransactionServiceError} For network or unexpected errors.
   */
  private async sendTransactionRequest(
    idempotencyKey: string,
    amount: string,
    destination: string,
    memo?: string,
  ): Promise<string> {
    const url = `${this.config.baseUrl}/transactions/submit`;

    const abortController = new AbortController();
    this.requestAbortController = abortController;

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      };

      if (this.config.apiKey) {
        headers['X-API-Key'] = this.config.apiKey;
      }

      if (this.config.getAuthToken) {
        const token = await this.config.getAuthToken();
        if (token) {
          headers['Authorization'] = `Bearer ${token}`;
        }
      }

      const body: Record<string, unknown> = { amount, destination };
      if (memo) {
        body.memo = memo;
      }

      const timeoutMs = this.config.requestTimeoutMs;
      const timeoutId = setTimeout(() => abortController.abort(), timeoutMs);

      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: abortController.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        let errorBody: string | undefined;
        try {
          errorBody = await response.text();
        } catch {
          // ignore parse error
        }
        this.logger.error('Transaction submission rejected by server', {
          status: response.status,
          body: errorBody,
          idempotencyKey,
        });
        throw new TransactionRejectedError(
          `Server returned status ${response.status}${errorBody ? `: ${errorBody}` : ''}`,
        );
      }

      const data: SubmitResponse = await response.json();

      if (!data.id || typeof data.id !== 'string') {
        throw new TransactionServiceError('Invalid response: missing transaction ID.');
      }

      return data.id;
    } catch (error: unknown) {
      if (error instanceof TransactionRejectedError || error instanceof TransactionServiceError) {
        throw error;
      }
      if (error instanceof DOMException && error.name === 'AbortError') {
        // Check if it was a user cancel or timeout
        if (this.isCanceled) {
          throw new TransactionCanceledError();
        } else {
          throw new TransactionTimeoutError('submission');
        }
      }
      // Network or other error
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error('Network error during transaction submission', { error: message, idempotencyKey });
      throw new TransactionServiceError(`Failed to submit transaction: ${message}`, 'NETWORK_ERROR');
    } finally {
      this.requestAbortController = null;
    }
  }

  /**
   * Polls the transaction status until it reaches a terminal state or timeout.
   * @param transactionId - The transaction ID to poll.
   * @param idempotencyKey - For logging purposes.
   * @param onStatusChange - Optional callback for each status update.
   * @returns The final transaction result.
   * @throws {TransactionTimeoutError} If polling exceeds max duration.
   * @throws {TransactionRejectedError} If server rejects polling.
   * @throws {TransactionCanceledError} If user cancels during polling.
   * @throws {TransactionServiceError} For network errors.
   */
  private async pollForStatus(
    transactionId: string,
    idempotencyKey: string,
    onStatusChange?: (status: TransactionStatus, details?: string) => void,
  ): Promise<TransactionResult> {
    return new Promise<TransactionResult>((resolve, reject) => {
      this.pendingResolver = resolve;
      this.pendingRejecter = reject;
      this.pollingStartTime = Date.now();
      this.pollingAttempts = 0;

      const poll = async (): Promise<void> => {
        // Check cancellation
        if (this.isCanceled) {
          reject(new TransactionCanceledError());
          return;
        }

        // Check timeout
        const elapsed = Date.now() - this.pollingStartTime;
        if (elapsed >= this.config.maxPollingDurationMs) {
          reject(new TransactionTimeoutError(transactionId));
          return;
        }

        // Check max retries
        if (this.pollingAttempts >= this.config.maxPollingRetries) {
          reject(new TransactionTimeoutError(transactionId));
          return;
        }

        this.pollingAttempts++;

        try {
          const statusResponse = await this.fetchTransactionStatus(transactionId, idempotencyKey);
          const { status, error } = statusResponse;

          // Notify on status change
          if (onStatusChange) {
            try {
              onStatusChange(status, error);
            } catch (callbackError) {
              this.logger.warn('onStatusChange callback threw an error', { callbackError });
            }
          }

          this.logger.debug('Polled transaction status', { transactionId, status, attempt: this.pollingAttempts });

          if (status === TransactionStatus.CONFIRMED) {
            resolve({
              transactionId,
              status: TransactionStatus.CONFIRMED,
              metadata: statusResponse.metadata,
            });
            return;
          }

          if (status === TransactionStatus.FAILED || status === TransactionStatus.REJECTED) {
            resolve({
              transactionId,
              status,
              error: statusResponse.error ?? 'Transaction failed without error message',
              metadata: statusResponse.metadata,
            });
            return;
          }

          if (status === TransactionStatus.CANCELED) {
            resolve({
              transactionId,
              status: TransactionStatus.CANCELED,
              error: 'Transaction was canceled by backend.',
              metadata: statusResponse.metadata,
            });
            return;
          }

          // Still pending – schedule next poll
          this.pollingTimer = setTimeout(() => {
            poll().catch((err) => reject(err));
          }, this.config.pollingIntervalMs);
        } catch (error: unknown) {
          if (error instanceof TransactionCanceledError) {
            reject(error);
            return;
          }
          if (error instanceof TransactionServiceError) {
            // Network errors: retry? We'll treat as timeout after max retries
            this.logger.warn('Polling attempt failed, will retry', { transactionId, attempt: this.pollingAttempts, error: error.message });
            this.pollingTimer = setTimeout(() => {
              poll().catch((err) => reject(err));
            }, this.config.pollingIntervalMs);
            return;
          }
          // Unexpected error
          reject(error);
        }
      };

      // Start first poll
      poll().catch((err) => reject(err));
    });
  }

  /**
   * Fetches the current status of a transaction from the backend.
   * @param transactionId - The transaction ID.
   * @param idempotencyKey - For logging.
   * @returns The status response.
   * @throws {TransactionRejectedError} If server returns error.
   * @throws {TransactionServiceError} For network issues.
   */
  private async fetchTransactionStatus(
    transactionId: string,
    idempotencyKey: string,
  ): Promise<StatusResponse> {
    const url = `${this.config.baseUrl}/transactions/${encodeURIComponent(transactionId)}/status`;

    const abortController = new AbortController();
    this.requestAbortController = abortController;

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };

      if (this.config.apiKey) {
        headers['X-API-Key'] = this.config.apiKey;
      }

      if (this.config.getAuthToken) {
        const token = await this.config.getAuthToken();
        if (token) {
          headers['Authorization'] = `Bearer ${token}`;
        }
      }

      const timeoutMs = this.config.requestTimeoutMs;
      const timeoutId = setTimeout(() => abortController.abort(), timeoutMs);

      const response = await fetch(url, {
        method: 'GET',
        headers,
        signal: abortController.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        let errorBody: string | undefined;
        try {
          errorBody = await response.text();
        } catch {
          // ignore
        }
        this.logger.error('Status request rejected by server', {
          transactionId,
          status: response.status,
          body: errorBody,
          idempotencyKey,
        });
        throw new TransactionRejectedError(
          `Failed to fetch status: server returned ${response.status}${errorBody ? `: ${errorBody}` : ''}`,
        );
      }

      const data: StatusResponse = await response.json();

      if (!data.status || !Object.values(TransactionStatus).includes(data.status)) {
        throw new TransactionServiceError('Invalid status response from server.');
      }

      return data;
    } catch (error: unknown) {
      if (error instanceof TransactionRejectedError || error instanceof TransactionServiceError) {
        throw error;
      }
      if (error instanceof DOMException && error.name === 'AbortError') {
        if (this.isCanceled) {
          throw new TransactionCanceledError();
        } else {
          throw new TransactionServiceError('Status request timed out.', 'REQUEST_TIMEOUT');
        }
      }
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error('Network error during status fetch', { transactionId, error: message, idempotencyKey });
      throw new TransactionServiceError(`Failed to fetch transaction status: ${message}`, 'NETWORK_ERROR');
    } finally {
      this.requestAbortController = null;
    }
  }

  /**
   * Cleans up internal state after transaction completion or error.
   */
  private cleanup(): void {
    if (this.pollingTimer) {
      clearTimeout(this.pollingTimer);
      this.pollingTimer = null;
    }
    if (this.requestAbortController) {
      this.requestAbortController.abort();
      this.requestAbortController = null;
    }
    this.pollingStartTime = 0;
    this.pollingAttempts = 0;
    this.activeIdempotencyKey = null;
    this.isSubmitting = false;
    this.isCanceled = false;
    this.pendingResolver = null;
    this.pendingRejecter = null;
  }
}