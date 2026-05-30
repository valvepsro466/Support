typescript
// mobile/src/services/AuthenticationService.ts

import { v4 as uuidv4 } from 'uuid';

// ---------- Logger Interface ----------
interface Logger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  debug(...args: unknown[]): void;
}

class ConsoleLogger implements Logger {
  private enabled: boolean;

  constructor(enabled: boolean) {
    this.enabled = enabled;
  }

  info(...args: unknown[]): void {
    if (this.enabled) console.info('[AuthService]', ...args);
  }

  warn(...args: unknown[]): void {
    if (this.enabled) console.warn('[AuthService]', ...args);
  }

  error(...args: unknown[]): void {
    if (this.enabled) console.error('[AuthService]', ...args);
  }

  debug(...args: unknown[]): void {
    if (this.enabled) console.debug('[AuthService]', ...args);
  }
}

// ---------- Errors ----------
export class AuthenticationError extends Error {
  public readonly code: string;
  public readonly retryable: boolean;

  constructor(message: string, code: string, retryable: boolean) {
    super(message);
    this.name = 'AuthenticationError';
    this.code = code;
    this.retryable = retryable;
  }
}

export class NetworkError extends AuthenticationError {
  constructor(message: string, retryable = true) {
    super(message, 'NETWORK', retryable);
    this.name = 'NetworkError';
  }
}

export class ServerError extends AuthenticationError {
  public readonly httpStatus: number;

  constructor(message: string, httpStatus: number) {
    super(message, 'SERVER', httpStatus >= 500 || httpStatus === 429);
    this.name = 'ServerError';
    this.httpStatus = httpStatus;
  }
}

export class AuthFailedError extends AuthenticationError {
  constructor(message: string) {
    super(message, 'AUTH_FAILED', false);
    this.name = 'AuthFailedError';
  }
}

export class TimeoutError extends AuthenticationError {
  constructor(message = 'Request timed out') {
    super(message, 'TIMEOUT', true);
    this.name = 'TimeoutError';
  }
}

export class CancelledError extends AuthenticationError {
  constructor(message = 'Login cancelled') {
    super(message, 'CANCELLED', false);
    this.name = 'CancelledError';
  }
}

// ---------- Configuration ----------
export interface AuthServiceConfig {
  readonly baseUrl: string;
  readonly maxRetries: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly backoffFactor: number;
  readonly timeoutMs: number;
  readonly logEnabled: boolean;
}

const DEFAULT_CONFIG: AuthServiceConfig = {
  baseUrl: 'https://api.example.com',
  maxRetries: 3,
  baseDelayMs: 500,
  maxDelayMs: 5000,
  backoffFactor: 2,
  timeoutMs: 15000,
  logEnabled: typeof __DEV__ !== 'undefined' ? __DEV__ : false,
};

// ---------- Public Types ----------
export interface MePassCredentials {
  /** Unique identifier for the Me Pass device */
  passId: string;
  /** Optional password if not using biometrics */
  password?: string;
}

export interface LoginSuccess {
  readonly success: true;
  readonly token: string;
  readonly userId: string;
  readonly sessionExpiry: number;
}

export interface LoginFailure {
  readonly success: false;
  readonly error: string;
  readonly code: 'NETWORK' | 'SERVER' | 'AUTH_FAILED' | 'TIMEOUT' | 'CANCELLED';
  readonly retryable: boolean;
}

export type LoginResult = LoginSuccess | LoginFailure;

/**
 * Callback to trigger QR code login as fallback.
 */
export type QRLoginTrigger = () => void;

// ---------- Idempotency ----------
const generateIdempotencyKey = (): string => uuidv4();

// ---------- Exponential Backoff ----------
const calculateDelay = (
  attempt: number,
  baseDelay: number,
  maxDelay: number,
  factor: number,
): number => {
  const delay = baseDelay * Math.pow(factor, attempt);
  return Math.min(delay, maxDelay);
};

// ---------- Abort Signal Combiner ----------
/**
 * Combines multiple AbortSignals into one. Cleans up listeners to avoid memory leaks.
 * @param signals AbortSignals to combine
 * @returns A combined AbortSignal
 */
const combineAbortSignals = (...signals: AbortSignal[]): AbortSignal => {
  const controller = new AbortController();
  const cleanup: Array<() => void> = [];

  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      return controller.signal;
    }
    const handler = () => controller.abort(signal.reason);
    signal.addEventListener('abort', handler);
    cleanup.push(() => signal.removeEventListener('abort', handler));
  }

  const originalAbort = controller.abort.bind(controller);
  controller.abort = (reason?: unknown) => {
    cleanup.forEach((fn) => fn());
    originalAbort(reason);
  };

  return controller.signal;
};

// ---------- Sleep with Abort ----------
/**
 * Sleeps for a given number of milliseconds, with optional cancellation via AbortSignal.
 * @param ms Milliseconds to sleep
 * @param signal Optional AbortSignal to cancel the sleep
 * @returns Promise that resolves on completion, rejects on abort
 */
const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new CancelledError('Sleep cancelled'));
      return;
    }

    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new CancelledError('Sleep cancelled'));
    };

    signal?.addEventListener('abort', onAbort, { once: true });
  });

// ---------- Input Validation ----------
/**
 * Validates MePassCredentials.
 * @param credentials Credentials to validate
 * @throws AuthFailedError if validation fails
 */
const validateCredentials = (credentials: MePassCredentials): void => {
  if (!credentials || typeof credentials !== 'object') {
    throw new AuthFailedError('Invalid credentials object');
  }
  if (typeof credentials.passId !== 'string' || credentials.passId.trim().length === 0) {
    throw new AuthFailedError('passId must be a non-empty string');
  }
  if (credentials.password !== undefined && typeof credentials.password !== 'string') {
    throw new AuthFailedError('password must be a string if provided');
  }
};

// ---------- Response type from server ----------
interface ServerLoginResponse {
  token: string;
  userId: string;
  sessionExpiry: number;
}

// ---------- Core Auth Service ----------
export class AuthenticationService {
  private readonly config: AuthServiceConfig;
  private readonly logger: Logger;
  private qrFallback: QRLoginTrigger | null = null;

  /**
   * Creates an instance of AuthenticationService.
   * @param config Partial configuration; missing fields use defaults
   */
  constructor(config: Partial<AuthServiceConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.logger = new ConsoleLogger(this.config.logEnabled);
  }

  /**
   * Registers a fallback for QR login when Me Pass login fails.
   * @param trigger Function to initiate QR login
   */
  setQRFallback(trigger: QRLoginTrigger): void {
    this.qrFallback = trigger;
    this.logger.info('QR fallback registered');
  }

  /**
   * Attempts to log in using Me Pass credentials with automatic retry and exponential backoff.
   * Uses idempotency key to prevent duplicate transaction processing on the server side.
   * On final failure, triggers the QR fallback (if set).
   *
   * @param credentials - The Me Pass device credentials
   * @param signal - Optional AbortSignal to cancel the operation externally
   * @returns A promise resolving to either a successful login result or a structured failure
   */
  async loginWithMePass(
    credentials: MePassCredentials,
    signal?: AbortSignal,
  ): Promise<LoginResult> {
    try {
      validateCredentials(credentials);
    } catch (err) {
      if (err instanceof AuthFailedError) {
        return this.buildFailure(err.message, 'AUTH_FAILED', false);
      }
      throw err;
    }

    const idempotencyKey = generateIdempotencyKey();
    const url = `${this.config.baseUrl}/auth/me-pass`;
    let lastError: AuthenticationError | null = null;

    // Timeout controller
    const timeoutController = new AbortController();
    const timeoutId = setTimeout(() => {
      timeoutController.abort(new DOMException('Timeout', 'TimeoutError'));
    }, this.config.timeoutMs);

    const combinedSignal = signal
      ? combineAbortSignals(signal, timeoutController.signal)
      : timeoutController.signal;

    try {
      for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
        if (combinedSignal.aborted) {
          throw new CancelledError('Login aborted');
        }

        try {
          this.logger.debug(`Login attempt ${attempt + 1}/${this.config.maxRetries + 1}`);
          const result = await this.performLoginRequest(credentials, idempotencyKey, combinedSignal);
          this.logger.info('Login successful');
          return result;
        } catch (err) {
          if (err instanceof CancelledError) {
            throw err;
          }

          if (err instanceof AuthenticationError) {
            lastError = err;
            if (!err.retryable || attempt >= this.config.maxRetries) {
              this.logger.warn(`Login failed (attempt ${attempt + 1}): ${err.message}`);
              break;
            }
            // Retryable error, calculate delay
            const delay = calculateDelay(
              attempt,
              this.config.baseDelayMs,
              this.config.maxDelayMs,
              this.config.backoffFactor,
            );
            this.logger.warn(
              `Retryable error (attempt ${attempt + 1}), retrying in ${delay}ms: ${err.message}`,
            );
            await sleep(delay, combinedSignal);
          } else {
            // Unknown error – treat as non-retryable
            lastError = new NetworkError(`Unexpected error: ${(err as Error).message}`, false);
            break;
          }
        }
      }

      // All retries exhausted or non-retryable error
      this.logger.error(`Login failed after ${this.config.maxRetries + 1} attempts`);
      this.triggerQRFallback();
      return this.buildFailure(
        lastError?.message ?? 'Authentication failed',
        (lastError?.code as LoginFailure['code']) ?? 'AUTH_FAILED',
        lastError?.retryable ?? false,
      );
    } catch (err) {
      if (err instanceof CancelledError || err instanceof DOMException) {
        this.logger.warn('Login cancelled');
        return this.buildFailure('Login cancelled', 'CANCELLED', false);
      }
      this.logger.error('Unexpected error during login:', err);
      return this.buildFailure('Unexpected error', 'AUTH_FAILED', false);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Performs the actual login HTTP request.
   * @param credentials Validated credentials
   * @param idempotencyKey Key for idempotency
   * @param signal AbortSignal for cancellation
   * @returns LoginSuccess on success
   * @throws AuthenticationError on failure
   */
  private async performLoginRequest(
    credentials: MePassCredentials,
    idempotencyKey: string,
    signal: AbortSignal,
  ): Promise<LoginSuccess> {
    const body = {
      passId: credentials.passId,
      ...(credentials.password ? { password: credentials.password } : {}),
      idempotencyKey,
    };

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new TimeoutError('Request timed out');
      }
      throw new NetworkError(`Network error: ${(err as Error).message}`);
    }

    if (!response.ok) {
      let errorMessage = 'Server error';
      try {
        const errorBody = (await response.json()) as { message?: string };
        errorMessage = errorBody.message ?? errorMessage;
      } catch {
        // ignore parse error
      }
      throw new ServerError(errorMessage, response.status);
    }

    let data: ServerLoginResponse;
    try {
      data = (await response.json()) as ServerLoginResponse;
    } catch {
      throw new ServerError('Failed to parse server response', 0);
    }

    if (!data.token || !data.userId || typeof data.sessionExpiry !== 'number') {
      throw new ServerError('Invalid server response structure', response.status);
    }

    return {
      success: true,
      token: data.token,
      userId: data.userId,
      sessionExpiry: data.sessionExpiry,
    };
  }

  /**
   * Builds a LoginFailure result.
   * @param error Error message
   * @param code Error code
   * @param retryable Whether the operation can be retried
   * @returns LoginFailure object
   */
  private buildFailure(
    error: string,
    code: LoginFailure['code'],
    retryable: boolean,
  ): LoginFailure {
    return {
      success: false,
      error,
      code,
      retryable,
    };
  }

  /**
   * Triggers the QR fallback if it is set.
   */
  private triggerQRFallback(): void {
    if (this.qrFallback) {
      this.logger.info('Triggering QR fallback');
      this.qrFallback();
    } else {
      this.logger.info('No QR fallback registered');
    }
  }
}