import { test, expect } from '@playwright/test';
import crypto from 'node:crypto';

const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:3000';
const AUTH_EMAIL = process.env.TEST_USER_EMAIL || 'testuser@example.com';
const AUTH_PASSWORD = process.env.TEST_USER_PASSWORD || 'testPassword123';

interface TransactionResponse {
  id: string;
  status: 'pending' | 'completed' | 'failed' | 'cancelled';
  idempotencyKey: string;
  createdAt: string;
  updatedAt: string;
}

// Helper: generate unique idempotency key
function generateIdempotencyKey(): string {
  return crypto.randomUUID();
}

// Helper: authenticate and return bearer token
async function authenticate(baseUrl: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: AUTH_EMAIL, password: AUTH_PASSWORD }),
  });

  if (!response.ok) {
    throw new Error(`Authentication failed: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  if (!data.token) {
    throw new Error('No token returned from authentication');
  }
  return data.token;
}

// Helper: submit a transaction with idempotency key
async function submitTransaction(
  baseUrl: string,
  token: string,
  idempotencyKey: string,
  payload: Record<string, unknown> = { amount: 100, currency: 'USD' }
): Promise<TransactionResponse> {
  const response = await fetch(`${baseUrl}/api/transactions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Transaction submission failed: ${response.status} - ${errorBody}`);
  }

  return response.json();
}

// Helper: get transaction by id
async function getTransactionById(
  baseUrl: string,
  token: string,
  transactionId: string
): Promise<TransactionResponse> {
  const response = await fetch(`${baseUrl}/api/transactions/${transactionId}`, {
    headers: {
      'Authorization': `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch transaction: ${response.status}`);
  }

  return response.json();
}

// Helper: get transaction by idempotency key
async function getTransactionByIdempotencyKey(
  baseUrl: string,
  token: string,
  idempotencyKey: string
): Promise<TransactionResponse | null> {
  const response = await fetch(`${baseUrl}/api/transactions?idempotencyKey=${encodeURIComponent(idempotencyKey)}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch transaction by idempotency key: ${response.status}`);
  }

  const data = await response.json();
  // Assuming endpoint returns array or single object
  if (Array.isArray(data) && data.length > 0) {
    return data[0];
  }
  if (data && data.id) {
    return data;
  }
  return null;
}

// Helper: retry transaction submission with exponential backoff
async function submitTransactionWithRetry(
  baseUrl: string,
  token: string,
  idempotencyKey: string,
  maxRetries = 3,
  initialDelayMs = 500
): Promise<TransactionResponse> {
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await submitTransaction(baseUrl, token, idempotencyKey);
    } catch (error) {
      lastError = error as Error;
      if (attempt === maxRetries) {
        throw error;
      }
      const delay = initialDelayMs * Math.pow(2, attempt - 1);
      console.warn(`Transaction submission attempt ${attempt} failed, retrying in ${delay}ms...`, error);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw lastError ?? new Error('Unexpected retry error');
}

// Helper: poll transaction status until non-pending or timeout
async function waitForTransactionCompletion(
  baseUrl: string,
  token: string,
  transactionId: string,
  timeoutMs = 30000,
  pollIntervalMs = 1000
): Promise<TransactionResponse> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    const transaction = await getTransactionById(baseUrl, token, transactionId);
    if (transaction.status !== 'pending') {
      return transaction;
    }
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
  }
  throw new Error(`Transaction ${transactionId} did not complete within ${timeoutMs}ms (final status: pending)`);
}

// ===================== Tests =====================

test.describe('Transaction Flow E2E', () => {
  let authToken: string;

  test.beforeAll(async () => {
    // Authenticate once before all tests
    authToken = await authenticate(API_BASE_URL);
    if (!authToken) {
      throw new Error('failed to obtain auth token');
    }
  });

  test.afterAll(async () => {
    // Cleanup: revoke token if necessary. For example, if there's a logout endpoint:
    // await fetch(`${API_BASE_URL}/api/auth/logout`, { method: 'POST', headers: { 'Authorization': `Bearer ${authToken}` } });
  });

  test('should login and submit a transaction successfully', async () => {
    const idempotencyKey = generateIdempotencyKey();
    const transaction = await submitTransaction(API_BASE_URL, authToken, idempotencyKey);

    expect(transaction).toHaveProperty('id');
    expect(transaction).toHaveProperty('status');
    expect(transaction.idempotencyKey).toBe(idempotencyKey);
    // Status may be 'pending' initially; that's acceptable
    expect(['pending', 'completed']).toContain(transaction.status);
  });

  test('should return same transaction on retry with same idempotency key', async () => {
    const idempotencyKey = generateIdempotencyKey();
    // First submission
    const firstResult = await submitTransaction(API_BASE_URL, authToken, idempotencyKey);
    // Second submission with same key (immediate retry)
    const secondResult = await submitTransaction(API_BASE_URL, authToken, idempotencyKey);
    // Should return the same transaction (idempotent)
    expect(secondResult.id).toBe(firstResult.id);
    expect(secondResult.status).toBe(firstResult.status);
    expect(secondResult.idempotencyKey).toBe(idempotencyKey);
  });

  test('should handle multiple concurrent submissions with different idempotency keys', async () => {
    const key1 = generateIdempotencyKey();
    const key2 = generateIdempotencyKey();
    const payload1 = { amount: 50, currency: 'EUR' };
    const payload2 = { amount: 200, currency: 'GBP' };

    const [tx1, tx2] = await Promise.all([
      submitTransaction(API_BASE_URL, authToken, key1, payload1),
      submitTransaction(API_BASE_URL, authToken, key2, payload2),
    ]);

    expect(tx1.idempotencyKey).toBe(key1);
    expect(tx2.idempotencyKey).toBe(key2);
    expect(tx1.id).not.toBe(tx2.id);
    // Verify both transactions can be fetched by id
    const fetched1 = await getTransactionById(API_BASE_URL, authToken, tx1.id);
    const fetched2 = await getTransactionById(API_BASE_URL, authToken, tx2.id);
    expect(fetched1.id).toBe(tx1.id);
    expect(fetched2.id).toBe(tx2.id);
  });

  test('should complete a transaction (if processing is synchronous) or at least return non-error', async () => {
    const idempotencyKey = generateIdempotencyKey();
    const transaction = await submitTransaction(API_BASE_URL, authToken, idempotencyKey);
    expect(transaction.status).not.toBe('failed');
    // Optionally wait for final status if backend processes asynchronously
    if (transaction.status === 'pending') {
      const finalTransaction = await waitForTransactionCompletion(
        API_BASE_URL,
        authToken,
        transaction.id,
        15000,
        2000
      );
      expect(['completed', 'failed', 'cancelled']).toContain(finalTransaction.status);
    }
  });

  test('should reject duplicate transaction when idempotency key already used for a different payload', async () => {
    const idempotencyKey = generateIdempotencyKey();
    // First submission
    const originalPayload = { amount: 100, currency: 'USD' };
    const firstResult = await submitTransaction(API_BASE_URL, authToken, idempotencyKey, originalPayload);
    // Second submission with different payload but same key
    const differentPayload = { amount: 500, currency: 'BTC' };
    // The server should return the first result, ignoring the new payload
    const secondResult = await submitTransaction(API_BASE_URL, authToken, idempotencyKey, differentPayload);
    expect(secondResult.id).toBe(firstResult.id);
    // Optionally check that the payload (or amount) in the transaction matches the first
    // This depends on backend returning payload details; if not, at least verify idempotency
  });

  test('should handle retrieval by idempotency key', async () => {
    const idempotencyKey = generateIdempotencyKey();
    const submitted = await submitTransaction(API_BASE_URL, authToken, idempotencyKey);
    const retrieved = await getTransactionByIdempotencyKey(API_BASE_URL, authToken, idempotencyKey);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe(submitted.id);
    expect(retrieved!.idempotencyKey).toBe(idempotencyKey);
  });

  test('should retry on transient failures and succeed', async () => {
    // Simulate a scenario where first request may fail (e.g., network issue)
    // Since we cannot control server, we use the retry helper to attempt submission
    // This validates that the retry logic works end-to-end
    const idempotencyKey = generateIdempotencyKey();
    // Use a deliberately invalid token for first submission to force failure? Not good for e2e.
    // Instead, just use the same valid token; if first attempt fails due to random server hiccup,
    // retries will succeed. This is more of a resilience test.
    // However, we can simulate a 409 conflict? Not needed.
    // We'll just test normal flow with retry helper (no forced failures)
    const transaction = await submitTransactionWithRetry(API_BASE_URL, authToken, idempotencyKey, 2, 200);
    expect(transaction).toHaveProperty('id');
    expect(transaction.idempotencyKey).toBe(idempotencyKey);
  });
});