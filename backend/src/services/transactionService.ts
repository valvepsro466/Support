// backend/src/services/transactionService.ts

import { v4 as uuidv4 } from 'uuid';
import { db } from '../lib/database'; // assumed Prisma or similar
import { logger } from '../lib/logger';

// ---------- Types ----------

export enum TransactionStatus {
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  CANCELLED = 'CANCELLED',
}

export interface Transaction {
  id: string;
  idempotencyKey: string;
  status: TransactionStatus;
  buyerId: string;
  sellerId: string;
  amount: number;
  currency: string;
  payload: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date;
  failureReason?: string;
}

export interface CreateTransactionInput {
  buyerId: string;
  sellerId: string;
  amount: number;
  currency: string;
  payload?: Record<string, unknown>;
}

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

// ---------- Constants ----------

const BUYER_UNAVAILABLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// ---------- State Transitions ----------

const ALLOWED_TRANSITIONS: Record<TransactionStatus, TransactionStatus[]> = {
  [TransactionStatus.PENDING]: [TransactionStatus.PROCESSING, TransactionStatus.CANCELLED],
  [TransactionStatus.PROCESSING]: [TransactionStatus.COMPLETED, TransactionStatus.FAILED],
  [TransactionStatus.COMPLETED]: [],
  [TransactionStatus.FAILED]: [],
  [TransactionStatus.CANCELLED]: [],
};

// ---------- Validation ----------

export function validateTransaction(input: CreateTransactionInput): ValidationResult {
  if (!input.buyerId || typeof input.buyerId !== 'string') {
    return { valid: false, error: 'buyerId is required and must be a string' };
  }
  if (!input.sellerId || typeof input.sellerId !== 'string') {
    return { valid: false, error: 'sellerId is required and must be a string' };
  }
  if (typeof input.amount !== 'number' || input.amount <= 0) {
    return { valid: false, error: 'amount must be a positive number' };
  }
  if (!input.currency || typeof input.currency !== 'string' || input.currency.length !== 3) {
    return { valid: false, error: 'currency must be a 3-letter ISO code' };
  }
  return { valid: true };
}

// ---------- Core Service ----------

/**
 * Creates a new transaction with idempotency key deduplication.
 * If an idempotency key is provided and already exists, returns the existing transaction.
 */
export async function createTransaction(
  input: CreateTransactionInput,
  idempotencyKey?: string
): Promise<Transaction> {
  const validation = validateTransaction(input);
  if (!validation.valid) {
    throw new Error(`Validation failed: ${validation.error}`);
  }

  const key = idempotencyKey || uuidv4();

  // Check idempotency
  const existing = await db.transaction.findUnique({
    where: { idempotencyKey: key },
  });
  if (existing) {
    logger.info(`Idempotency key ${key} hit, returning existing transaction ${existing.id}`);
    return existing;
  }

  // Create transaction with idempotency key
  const transaction = await db.transaction.create({
    data: {
      id: uuidv4(),
      idempotencyKey: key,
      status: TransactionStatus.PENDING,
      buyerId: input.buyerId,
      sellerId: input.sellerId,
      amount: input.amount,
      currency: input.currency,
      payload: input.payload || {},
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  });

  logger.info(`Transaction ${transaction.id} created with status PENDING`);
  return transaction;
}

/**
 * Processes a transaction: transitions from PENDING -> PROCESSING,
 * performs business logic, then transitions to COMPLETED or FAILED.
 */
export async function processTransaction(transactionId: string): Promise<Transaction> {
  // Lock and fetch transaction
  const transaction = await db.transaction.findUnique({
    where: { id: transactionId },
  });
  if (!transaction) {
    throw new Error(`Transaction ${transactionId} not found`);
  }

  // Validate state transition
  if (!ALLOWED_TRANSITIONS[transaction.status].includes(TransactionStatus.PROCESSING)) {
    throw new Error(
      `Cannot process transaction ${transactionId} in status ${transaction.status}`
    );
  }

  // Update status to PROCESSING
  const processing = await db.transaction.update({
    where: { id: transactionId },
    data: { status: TransactionStatus.PROCESSING, updatedAt: new Date() },
  });

  try {
    // Perform business logic (e.g., call payment gateway, escrow, etc.)
    // For demonstration, we simulate work with a delay
    const result = await executePaymentLogic(processing);

    if (result.success) {
      return await db.transaction.update({
        where: { id: transactionId },
        data: {
          status: TransactionStatus.COMPLETED,
          completedAt: new Date(),
          updatedAt: new Date(),
        },
      });
    } else {
      return await db.transaction.update({
        where: { id: transactionId },
        data: {
          status: TransactionStatus.FAILED,
          failureReason: result.error,
          updatedAt: new Date(),
        },
      });
    }
  } catch (error) {
    logger.error(`Transaction ${transactionId} processing error`, error);
    return await db.transaction.update({
      where: { id: transactionId },
      data: {
        status: TransactionStatus.FAILED,
        failureReason: error instanceof Error ? error.message : 'Unknown error',
        updatedAt: new Date(),
      },
    });
  }
}

/**
 * Cancels transactions that have been in PENDING status longer than the buyer-unavailable timeout.
 * Returns number of cancelled transactions.
 */
export async function cancelExpiredTransactions(): Promise<number> {
  const cutoff = new Date(Date.now() - BUYER_UNAVAILABLE_TIMEOUT_MS);

  const expired = await db.transaction.findMany({
    where: {
      status: TransactionStatus.PENDING,
      createdAt: { lt: cutoff },
    },
  });

  let cancelledCount = 0;
  for (const tx of expired) {
    try {
      await db.transaction.update({
        where: { id: tx.id },
        data: {
          status: TransactionStatus.CANCELLED,
          failureReason: 'Buyer unavailable – transaction auto-cancelled after timeout',
          updatedAt: new Date(),
        },
      });
      cancelledCount++;
      logger.info(`Auto-cancelled transaction ${tx.id} due to buyer unavailability`);
    } catch (error) {
      logger.error(`Failed to auto-cancel transaction ${tx.id}`, error);
    }
  }

  return cancelledCount;
}

// ---------- Private Helpers ----------

interface PaymentResult {
  success: boolean;
  error?: string;
}

async function executePaymentLogic(transaction: Transaction): Promise<PaymentResult> {
  // Replace with real payment gateway / smart contract call
  // This is a placeholder that always succeeds.
  await new Promise((resolve) => setTimeout(resolve, 100));
  return { success: true };
}

// ---------- Exported utilities ----------

export function generateIdempotencyKey(): string {
  return uuidv4();
}