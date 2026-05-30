// backend/src/models/transaction.ts

import { v4 as uuidv4 } from 'uuid';

/**
 * Possible states in the transaction lifecycle.
 */
export enum TransactionStatus {
  PENDING = 'pending',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
}

/**
 * Core transaction data model used throughout the system.
 * All fields are readonly after creation to enforce immutability.
 */
export interface Transaction {
  /** Unique identifier (UUIDv4) */
  readonly id: string;
  /** The user who initiated the transaction */
  readonly userId: string;
  /** Transaction amount (stored as a number; use decimal for precision-sensitive cases) */
  readonly amount: number;
  /** Current lifecycle status */
  readonly status: TransactionStatus;
  /** Idempotency key for at-most-once guarantees */
  readonly idempotencyKey: string;
  /** Creation timestamp (set by the server) */
  readonly createdAt: Date;
  /** Timestamp after which a pending transaction is auto-cancelled */
  readonly timeoutAt: Date;
}

/**
 * Input type for creating a new transaction.
 * All fields are required except as noted; defaults are applied intelligently.
 */
export type CreateTransactionInput = {
  /** If omitted, a UUIDv4 is generated automatically */
  id?: string;
  userId: string;
  amount: number;
  status: TransactionStatus;
  idempotencyKey: string;
  /** If omitted, defaults to `new Date()` */
  createdAt?: Date;
  /** If omitted and `ttlMs` is given, computed as `createdAt + ttlMs`; otherwise uses `DEFAULT_TIMEOUT_MS` */
  timeoutAt?: Date;
  /** Time-to-live in milliseconds (ignored if `timeoutAt` is provided) */
  ttlMs?: number;
};

/** Default timeout for pending transactions: 5 minutes */
export const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Factory function that builds a `Transaction` from user input, filling in defaults.
 *
 * @param input - The creation parameters.
 * @returns A complete, immutable Transaction object.
 */
export function createTransaction(input: CreateTransactionInput): Transaction {
  const now = input.createdAt ?? new Date();

  let timeoutAt = input.timeoutAt;
  if (!timeoutAt) {
    const ttl = input.ttlMs ?? DEFAULT_TIMEOUT_MS;
    timeoutAt = new Date(now.getTime() + ttl);
  }

  return {
    id: input.id ?? uuidv4(),
    userId: input.userId,
    amount: input.amount,
    status: input.status,
    idempotencyKey: input.idempotencyKey,
    createdAt: now,
    timeoutAt,
  };
}