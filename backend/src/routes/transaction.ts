import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod'; // For runtime validation
import { prisma } from '../lib/prisma'; // Example Prisma client (adjust to your DB lib)
import { AuthenticatedRequest } from '../middleware/auth'; // Custom auth middleware type
import { idempotencyMiddleware } from '../middleware/idempotency'; // Custom idempotency middleware

const router = Router();

// --- Schemas ---
const submitSchema = z.object({
  amount: z.number().positive('Amount must be positive'),
  currency: z.string().length(3, 'Currency must be 3-letter code'),
  recipient: z.string().min(1, 'Recipient required'),
  metadata: z.record(z.string()).optional(),
});

const cancelSchema = z.object({});

// --- Helper: Transaction state machine transitions ---
type TransactionState = 'pending' | 'completed' | 'failed' | 'cancelled';
const allowedTransitions: Record<TransactionState, TransactionState[]> = {
  pending: ['completed', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
};

// --- POST /transaction ---
router.post(
  '/',
  idempotencyMiddleware, // Ensures idempotency key is present and deduplicates
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const parsed = submitSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          error: 'Validation failed',
          details: parsed.error.flatten().fieldErrors,
        });
      }

      const { amount, currency, recipient, metadata } = parsed.data;
      const idempotencyKey = req.idempotencyKey; // Set by middleware

      // Check if idempotency key already processed (handled by middleware partially)
      // Here we rely on the middleware to have either returned cached response or allowed through.

      const transaction = await prisma.transaction.create({
        data: {
          id: uuidv4(),
          userId: req.user.id,
          amount,
          currency,
          recipient,
          status: 'pending',
          idempotencyKey,
          metadata: metadata || {},
        },
      });

      // Schedule auto-cancel after 30 minutes if still pending
      setTimeout(async () => {
        const current = await prisma.transaction.findUnique({ where: { id: transaction.id } });
        if (current && current.status === 'pending') {
          await prisma.transaction.update({
            where: { id: transaction.id },
            data: { status: 'cancelled' },
          });
        }
      }, 30 * 60 * 1000);

      return res.status(201).json(transaction);
    } catch (error) {
      console.error('POST /transaction error:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// --- GET /transaction/:id ---
router.get('/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;

    const transaction = await prisma.transaction.findUnique({
      where: { id, userId: req.user.id },
    });

    if (!transaction) {
      return res.status(404).json({ error: 'Transaction not found' });
    }

    return res.status(200).json(transaction);
  } catch (error) {
    console.error('GET /transaction/:id error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// --- POST /transaction/:id/cancel ---
router.post('/:id/cancel', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;

    const transaction = await prisma.transaction.findUnique({
      where: { id, userId: req.user.id },
    });

    if (!transaction) {
      return res.status(404).json({ error: 'Transaction not found' });
    }

    if (!allowedTransitions[transaction.status as TransactionState]?.includes('cancelled')) {
      return res.status(409).json({
        error: `Cannot cancel transaction in status '${transaction.status}'`,
      });
    }

    const updated = await prisma.transaction.update({
      where: { id },
      data: { status: 'cancelled' },
    });

    return res.status(200).json(updated);
  } catch (error) {
    console.error('POST /transaction/:id/cancel error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;