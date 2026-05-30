// backend/src/__tests__/transactionService.test.ts

import { TransactionService } from '../services/TransactionService';
import { TransactionRepository } from '../repositories/TransactionRepository';
import { Logger } from '../lib/logger';

// ---------------------------------------------------------------------------
// Types & enums matching domain model
// ---------------------------------------------------------------------------
export enum TransactionState {
  PENDING = 'pending',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
}

export interface Transaction {
  id: string;
  userId: string;
  amount: number;
  currency: string;
  status: TransactionState;
  idempotencyKey: string;
  createdAt: Date;
  updatedAt: Date;
  timeoutAt: Date | null;
}

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
const mockDb: Map<string, Transaction> = new Map();
const mockLogger: jest.Mocked<Logger> = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
} as any;

const mockRepo: jest.Mocked<TransactionRepository> = {
  findById: jest.fn(),
  findByKey: jest.fn(),
  create: jest.fn(),
  updateStatus: jest.fn(),
  findExpired: jest.fn(),
};

let service: TransactionService;

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers({ doNotFake: ['nextTick'] });
  mockDb.clear();

  // Wire mocks to an in‑memory store for integration feel
  mockRepo.findById.mockImplementation(async (id: string) => {
    return mockDb.get(id) ?? null;
  });
  mockRepo.findByKey.mockImplementation(async (key: string) => {
    for (const txn of mockDb.values()) {
      if (txn.idempotencyKey === key) return txn;
    }
    return null;
  });
  mockRepo.create.mockImplementation(async (txn: Transaction) => {
    mockDb.set(txn.id, txn);
    return txn;
  });
  mockRepo.updateStatus.mockImplementation(async (id: string, status: TransactionState) => {
    const txn = mockDb.get(id);
    if (txn) {
      txn.status = status;
      txn.updatedAt = new Date();
      mockDb.set(id, txn);
    }
  });
  mockRepo.findExpired.mockImplementation(async (cutoff: Date) => {
    const expired: Transaction[] = [];
    for (const txn of mockDb.values()) {
      if (
        txn.status === TransactionState.PENDING &&
        txn.timeoutAt &&
        txn.timeoutAt <= cutoff
      ) {
        expired.push(txn);
      }
    }
    return expired;
  });

  service = new TransactionService(mockRepo, mockLogger);
});

afterEach(() => {
  jest.useRealTimers();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function buildTransaction(overrides: Partial<Transaction> = {}): Transaction {
  const now = new Date();
  return {
    id: 'txn-' + Math.random().toString(36).substring(2, 10),
    userId: 'user-1',
    amount: 100,
    currency: 'USD',
    status: TransactionState.PENDING,
    idempotencyKey: `idem-${Date.now()}`,
    createdAt: now,
    updatedAt: now,
    timeoutAt: new Date(now.getTime() + 5 * 60 * 1000), // 5 minutes
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests: State Machine
// ---------------------------------------------------------------------------
describe('Transaction state machine', () => {
  describe('allowed transitions', () => {
    it('transitions from pending to completed', async () => {
      const txn = buildTransaction({ status: TransactionState.PENDING });
      mockRepo.create(txn);

      await service.completeTransaction(txn.id);
      const updated = mockDb.get(txn.id)!;
      expect(updated.status).toBe(TransactionState.COMPLETED);
      expect(mockRepo.updateStatus).toHaveBeenCalledWith(
        txn.id,
        TransactionState.COMPLETED
      );
    });

    it('transitions from pending to failed', async () => {
      const txn = buildTransaction({ status: TransactionState.PENDING });
      mockRepo.create(txn);

      await service.failTransaction(txn.id, 'Insufficient balance');
      const updated = mockDb.get(txn.id)!;
      expect(updated.status).toBe(TransactionState.FAILED);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Transaction failed'),
        expect.any(Object)
      );
    });

    it('transitions from pending to cancelled', async () => {
      const txn = buildTransaction({ status: TransactionState.PENDING });
      mockRepo.create(txn);

      await service.cancelTransaction(txn.id);
      const updated = mockDb.get(txn.id)!;
      expect(updated.status).toBe(TransactionState.CANCELLED);
    });
  });

  describe('forbidden transitions', () => {
    it.each([
      [TransactionState.COMPLETED, 'complete' as const],
      [TransactionState.FAILED, 'fail' as const],
      [TransactionState.CANCELLED, 'cancel' as const],
    ])('rejects attempt to %s a %s transaction', async (initialStatus, action) => {
      const txn = buildTransaction({ status: initialStatus });
      mockRepo.create(txn);

      const methodMap: Record<string, (id: string) => Promise<void>> = {
        complete: (id) => service.completeTransaction(id),
        fail: (id) => service.failTransaction(id, 'reason'),
        cancel: (id) => service.cancelTransaction(id),
      };

      const method = methodMap[action];
      await expect(method(txn.id)).rejects.toThrow(
        /Cannot transition from.*/i
      );

      // Verify no update occurred
      const stored = mockDb.get(txn.id)!;
      expect(stored.status).toBe(initialStatus);
    });
  });

  it('throws when transaction does not exist', async () => {
    await expect(
      service.completeTransaction('nonexistent')
    ).rejects.toThrow(/Transaction not found/i);
  });
});

// ---------------------------------------------------------------------------
// Tests: Auto‑cancel logic (timeout)
// ---------------------------------------------------------------------------
describe('Auto‑cancel logic', () => {
  it('cancels pending transactions that have exceeded timeout', async () => {
    const now = new Date();
    const past = new Date(now.getTime() - 10 * 60 * 1000); // 10 min ago
    const txn1 = buildTransaction({
      id: 'txn-expired-1',
      status: TransactionState.PENDING,
      timeoutAt: past,
    });
    const txn2 = buildTransaction({
      id: 'txn-expired-2',
      status: TransactionState.PENDING,
      timeoutAt: past,
    });
    const txn3 = buildTransaction({
      id: 'txn-future',
      status: TransactionState.PENDING,
      timeoutAt: new Date(now.getTime() + 10 * 60 * 1000),
    });

    mockRepo.create(txn1);
    mockRepo.create(txn2);
    mockRepo.create(txn3);

    // Override findExpired to return only past ones
    mockRepo.findExpired.mockResolvedValueOnce([txn1, txn2]);

    await service.autoCancelExpired();
    // After auto‑cancel, txn1 and txn2 should be cancelled
    expect(mockDb.get('txn-expired-1')!.status).toBe(TransactionState.CANCELLED);
    expect(mockDb.get('txn-expired-2')!.status).toBe(TransactionState.CANCELLED);
    // txn3 remains pending
    expect(mockDb.get('txn-future')!.status).toBe(TransactionState.PENDING);
  });

  it('does not cancel already non‑pending transactions', async () => {
    const now = new Date();
    const past = new Date(now.getTime() - 10 * 60 * 1000);
    const txn = buildTransaction({
      id: 'txn-completed',
      status: TransactionState.COMPLETED,
      timeoutAt: past,
    });
    mockRepo.create(txn);

    mockRepo.findExpired.mockResolvedValueOnce([]); // no pending expired
    await service.autoCancelExpired();

    // Should not have been cancelled because it's not pending
    // findExpired only returns pending ones, so no change
    expect(mockRepo.updateStatus).not.toHaveBeenCalled();
  });

  it('handles concurrent cancellations gracefully (idempotency)', async () => {
    const now = new Date();
    const past = new Date(now.getTime() - 10 * 60 * 1000);
    const txn = buildTransaction({
      id: 'txn-concurrent',
      status: TransactionState.PENDING,
      timeoutAt: past,
    });
    mockRepo.create(txn);

    // Double cancellation attempt
    mockRepo.findExpired.mockResolvedValueOnce([txn]);
    mockRepo.findExpired.mockResolvedValueOnce([txn]);

    await service.autoCancelExpired();
    await service.autoCancelExpired();

    // Status should be cancelled, not failed
    expect(mockDb.get('txn-concurrent')!.status).toBe(TransactionState.CANCELLED);
    // updateStatus should only be called once because second attempt finds already cancelled
    // (depending on implementation we can check)
  });
});

// ---------------------------------------------------------------------------
// Tests: Timeout handling (scheduled cancellation)
// ---------------------------------------------------------------------------
describe('Timeout handling', () => {
  it('schedules auto‑cancel when transaction is created with timeout', () => {
    const scheduleSpy = jest.spyOn(global, 'setTimeout');
    const txn = buildTransaction({
      timeoutAt: new Date(Date.now() + 5 * 60 * 1000),
    });

    service.createTransaction(txn);
    expect(scheduleSpy).toHaveBeenCalledWith(
      expect.any(Function),
      5 * 60 * 1000 // 5 minutes in milliseconds
    );
  });

  it('executes scheduled cancellation after timeout', async () => {
    const txn = buildTransaction({
      id: 'txn-scheduled',
      status: TransactionState.PENDING,
      timeoutAt: new Date(Date.now() + 60 * 1000), // 1 minute
    });
    mockRepo.create(txn);

    service.createTransaction(txn);

    // Fast‑forward exactly to timeout
    jest.advanceTimersByTime(60 * 1000);
    await Promise.resolve(); // let scheduled callback run

    const updated = mockDb.get('txn-scheduled')!;
    expect(updated.status).toBe(TransactionState.CANCELLED);
  });

  it('does not cancel if transaction already completed before timeout', async () => {
    const txn = buildTransaction({
      id: 'txn-completed-before',
      status: TransactionState.PENDING,
      timeoutAt: new Date(Date.now() + 60 * 1000),
    });
    mockRepo.create(txn);

    service.createTransaction(txn);

    // Complete before timeout
    await service.completeTransaction(txn.id);

    // Fast‑forward past timeout
    jest.advanceTimersByTime(120 * 1000);
    await Promise.resolve();

    const updated = mockDb.get('txn-completed-before')!;
    expect(updated.status).toBe(TransactionState.COMPLETED); // unchanged
  });
});

// ---------------------------------------------------------------------------
// Tests: Idempotency key handling
// ---------------------------------------------------------------------------
describe('Idempotency key handling', () => {
  it('returns existing transaction when idempotency key is reused', async () => {
    const txn = buildTransaction({ status: TransactionState.COMPLETED });
    mockRepo.create(txn);

    mockRepo.findByKey.mockResolvedValueOnce(txn);

    const result = await service.createTransactionIfNew({
      amount: txn.amount,
      currency: txn.currency,
      idempotencyKey: txn.idempotencyKey,
      userId: txn.userId,
    });

    expect(result).toEqual(txn);
    expect(mockRepo.create).not.toHaveBeenCalled();
  });

  it('creates new transaction when idempotency key is fresh', async () => {
    mockRepo.findByKey.mockResolvedValueOnce(null);

    const result = await service.createTransactionIfNew({
      amount: 200,
      currency: 'EUR',
      idempotencyKey: 'fresh-key-001',
      userId: 'user-2',
    });

    expect(result).toBeDefined();
    expect(mockRepo.create).toHaveBeenCalledTimes(1);
    expect(result!.idempotencyKey).toBe('fresh-key-001');
    expect(result!.status).toBe(TransactionState.PENDING);
  });

  it('prevents duplicate creation with same key even if first failed', async () => {
    const key = 'dup-key';
    // First attempt fails after creation (simulate race)
    mockRepo.findByKey.mockResolvedValueOnce(null);
    const txnCreated = buildTransaction({ idempotencyKey: key, status: TransactionState.FAILED });
    mockRepo.create.mockResolvedValueOnce(txnCreated);

    const first = await service.createTransactionIfNew({
      amount: 100,
      currency: 'USD',
      idempotencyKey: key,
      userId: 'user-1',
    });
    // Second attempt
    mockRepo.findByKey.mockResolvedValueOnce(txnCreated);
    const second = await service.createTransactionIfNew({
      amount: 100,
      currency: 'USD',
      idempotencyKey: key,
      userId: 'user-1',
    });

    expect(first!.id).toBe(second!.id);
    expect(mockRepo.create).toHaveBeenCalledTimes(1);
  });
});