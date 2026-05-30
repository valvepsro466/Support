import { Request, Response, NextFunction } from 'express';

/**
 * Interface for a generic idempotency store.
 * Implementations can be built on top of Redis, in-memory maps, databases, etc.
 */
export interface IdempotencyStore {
  /**
   * Atomically check if a key exists and if not, store the value.
   * Returns the stored value if the key already existed, or `null` if the key was newly stored.
   * The `value` parameter should be a serializable object representing the response.
   */
  setIfNotExists(key: string, value: CachedResponse): Promise<CachedResponse | null>;

  /**
   * Retrieve the cached response for a given key.
   */
  get(key: string): Promise<CachedResponse | null>;

  /**
   * Remove a key (optional, for cleanup).
   */
  delete(key: string): Promise<void>;
}

/**
 * Shape of a cached response.
 */
export interface CachedResponse {
  statusCode: number;
  headers: Record<string, string | string[] | number>;
  body: unknown;
}

/**
 * Options for the idempotency middleware.
 */
export interface IdempotencyOptions {
  /**
   * Header name to read the idempotency key from. Default: 'Idempotency-Key'.
   */
  headerName?: string;
  /**
   * Whether to require the idempotency key for all requests (return 400 if missing).
   * Default: false.
   */
  required?: boolean;
  /**
   * List of methods that should be idempotent (i.e., keys are checked).
   * Default: ['POST', 'PUT', 'PATCH'].
   */
  methods?: string[];
  /**
   * Optional prefix for store keys (e.g., namespace).
   */
  keyPrefix?: string;
}

/**
 * Creates an Express middleware that enforces idempotency based on a request header.
 * The first response for a given key is stored and returned for all subsequent identical keys.
 *
 * @param store - An implementation of IdempotencyStore (e.g., Redis, in-memory).
 * @param options - Configuration options.
 * @returns Express middleware function.
 */
export function createIdempotencyMiddleware(
  store: IdempotencyStore,
  options: IdempotencyOptions = {},
): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  const {
    headerName = 'Idempotency-Key',
    required = false,
    methods = ['POST', 'PUT', 'PATCH'],
    keyPrefix = '',
  } = options;

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // Only apply to specified methods
    if (!methods.includes(req.method.toUpperCase())) {
      next();
      return;
    }

    const rawKey = req.headers[headerName.toLowerCase()];

    if (!rawKey) {
      if (required) {
        res.status(400).json({
          error: 'Bad Request',
          message: `Missing required header: ${headerName}`,
        });
        return;
      }
      next();
      return;
    }

    const key = Array.isArray(rawKey) ? rawKey[0] : rawKey;
    const storeKey = keyPrefix ? `${keyPrefix}:${key}` : key;

    try {
      // Attempt to store a placeholder to claim the key (atomic operation)
      const existing = await store.setIfNotExists(storeKey, {
        statusCode: 202, // temporary placeholder, will be overwritten
        headers: {},
        body: null,
      });

      if (existing) {
        // Key already exists – return the cached response
        const cached: CachedResponse = existing;
        // Remove any previously set Content-Length to avoid mismatch
        if (cached.headers['content-length']) {
          delete cached.headers['content-length'];
        }
        res.status(cached.statusCode).set(cached.headers).json(cached.body);
        return;
      }

      // Key is newly claimed – proceed with the request and capture the response
      const originalJson = res.json.bind(res);
      const originalSend = res.send.bind(res);
      const originalEnd = res.end.bind(res);
      const originalStatus = res.status.bind(res);

      let statusCode = 200;
      let responseHeaders: Record<string, string | string[] | number> = {};
      let responseBody: unknown = null;
      let responseSent = false;

      // Override res.status to capture final status code
      res.status = (code: number) => {
        statusCode = code;
        return originalStatus(code);
      };

      // Override res.set/res.header to capture response headers
      const originalSet = res.set.bind(res);
      res.set = (field: string | Record<string, string | string[] | number>, val?: string | string[] | number) => {
        if (typeof field === 'object') {
          Object.assign(responseHeaders, field);
        } else if (val !== undefined) {
          responseHeaders[field] = val;
        }
        return originalSet(field, val);
      };
      // Also alias res.header
      res.header = res.set;

      // Override res.json to capture body and send
      res.json = (body: unknown) => {
        if (responseSent) return res;
        responseSent = true;
        responseBody = body;
        // Ensure Content-Type is set
        responseHeaders['content-type'] = responseHeaders['content-type'] || 'application/json';
        const finalBody = JSON.stringify(body);
        // Store the final response
        store.setIfNotExists(storeKey, {
          statusCode,
          headers: responseHeaders,
          body,
        }).catch((err) => {
          // Log but don't break the request
          console.error('Idempotency store error:', err);
        });
        return originalJson(body);
      };

      // Override res.send for non-JSON responses
      res.send = (body: unknown) => {
        if (responseSent) return res;
        responseSent = true;
        responseBody = body;
        // Infer content type from headers
        const finalBody = typeof body === 'string' ? body : JSON.stringify(body);
        store.setIfNotExists(storeKey, {
          statusCode,
          headers: responseHeaders,
          body,
        }).catch((err) => {
          console.error('Idempotency store error:', err);
        });
        return originalSend(body);
      };

      // Override res.end to capture cases where no explicit body was sent
      res.end = (chunk?: unknown, encoding?: string) => {
        if (!responseSent) {
          responseSent = true;
          responseBody = chunk || '';
          store.setIfNotExists(storeKey, {
            statusCode,
            headers: responseHeaders,
            body: chunk,
          }).catch((err) => {
            console.error('Idempotency store error:', err);
          });
        }
        return originalEnd(chunk, encoding);
      };

      // Continue processing
      next();

      // After next() we can't easily detect if an error occurred
      // If an error is thrown, the error handler should clean up the key
      // For now we rely on the fact that an error will not call json/send/end,
      // so the placeholder remains and subsequent requests will still get the placeholder (202)
      // Better approach: in error handling middleware, delete the key.
      // We can add a cleanup hook, but that's beyond this simple middleware.

    } catch (err) {
      // If error during store operation, abort and let the request proceed without idempotency
      console.error('Idempotency middleware error:', err);
      next();
    }
  };
}

// ----------------------------------------------------------------------
// Optional: Basic in-memory implementation of IdempotencyStore
// ----------------------------------------------------------------------

/**
 * In-memory idempotency store with optional TTL.
 * Uses a simple mutex per key to avoid race conditions.
 */
export class InMemoryIdempotencyStore implements IdempotencyStore {
  private store = new Map<string, CachedResponse>();
  private locks = new Map<string, Promise<void>>();
  private readonly ttlMs: number;

  constructor(ttlMs: number = 24 * 60 * 60 * 1000) { // default 24h
    this.ttlMs = ttlMs;
  }

  /**
   * Atomically check-and-set. Returns existing value if key exists, otherwise stores and returns null.
   */
  async setIfNotExists(key: string, value: CachedResponse): Promise<CachedResponse | null> {
    // Ensure sequential access per key
    let lock = this.locks.get(key);
    if (!lock) {
      lock = Promise.resolve();
    }

    this.locks.set(key, lock.then(async () => {
      // Check if key already has a permanent value (placeholder is allowed to be overwritten)
      const existing = this.store.get(key);
      if (existing && existing.statusCode !== 202) {
        // Already has a real response, return it
        return existing;
      }
      // Store the value (or overwrite placeholder)
      this.store.set(key, value);
      // Set TTL to auto-expire
      setTimeout(() => {
        this.store.delete(key);
      }, this.ttlMs).unref();
      return null;
    }));

    const result = await this.locks.get(key)!;
    return result ?? null;
  }

  async get(key: string): Promise<CachedResponse | null> {
    return this.store.get(key) ?? null;
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}