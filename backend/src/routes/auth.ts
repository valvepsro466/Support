// backend/src/routes/auth.ts
import { Router, Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { MePassService } from '../services/mePassService';
import { IdempotencyStore } from '../services/idempotencyStore';
import { config } from '../config';
import { AppError } from '../utils/appError';

// ---- Types ----
interface UserPayload {
  userId: string;
  email: string;
  roles: string[];
}

interface QRChallenge {
  id: string;
  nonce: string;
  userId?: string;
  createdAt: Date;
  expiresAt: Date;
}

// ---- In-memory store (replace with Redis/DB in production) ----
const qrChallengeStore = new Map<string, QRChallenge>();

// ---- Helpers ----
function generateToken(payload: UserPayload): string {
  return jwt.sign(payload, config.jwtSecret, {
    subject: payload.userId,
    algorithm: 'HS256',
    expiresIn: config.jwtExpiresIn,
    issuer: 'me-hub',
  });
}

function generateRefreshToken(payload: UserPayload): string {
  return jwt.sign(
    { type: 'refresh', ...payload },
    config.refreshSecret,
    {
      subject: payload.userId,
      algorithm: 'HS256',
      expiresIn: config.refreshExpiresIn,
      issuer: 'me-hub',
    }
  );
}

// ---- Router ----
export const authRouter = Router();

/**
 * POST /auth/login
 * Validates Me Pass and issues tokens.
 * Body: { pass: string; idempotencyKey?: string }
 */
authRouter.post('/login', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { pass, idempotencyKey } = req.body;

    if (!pass || typeof pass !== 'string' || pass.trim().length === 0) {
      throw new AppError(400, 'Missing or invalid Me Pass');
    }

    // Idempotency check (optional)
    if (idempotencyKey && config.idempotencyEnabled) {
      const existing = await IdempotencyStore.get(idempotencyKey);
      if (existing) {
        if (existing.status === 'completed') {
          return res.status(200).json(existing.response);
        }
        throw new AppError(409, 'Request already in progress');
      }
      await IdempotencyStore.set(idempotencyKey, { status: 'pending' });
    }

    // Validate Me Pass
    const user = await MePassService.validatePass(pass);
    if (!user) {
      throw new AppError(401, 'Invalid Me Pass');
    }

    const payload: UserPayload = {
      userId: user.id,
      email: user.email,
      roles: user.roles || [],
    };

    const accessToken = generateToken(payload);
    const refreshToken = generateRefreshToken(payload);

    const response = {
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        email: user.email,
        roles: user.roles,
      },
    };

    // Mark idempotency as completed
    if (idempotencyKey && config.idempotencyEnabled) {
      await IdempotencyStore.complete(idempotencyKey, response);
    }

    res.status(200).json({
      success: true,
      data: response,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /auth/qr-challenge/start
 * Generates a new QR code challenge for verification.
 * Returns: { challengeId, nonce, expiresAt }
 */
authRouter.post('/qr-challenge/start', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const nonce = crypto.randomBytes(32).toString('hex');
    const challengeId = uuidv4();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + config.qrChallengeTTL * 1000);

    const challenge: QRChallenge = {
      id: challengeId,
      nonce,
      createdAt: now,
      expiresAt,
    };

    qrChallengeStore.set(challengeId, challenge);

    // Remove expired challenges periodically (could use TTL in Redis)
    setTimeout(() => qrChallengeStore.delete(challengeId), config.qrChallengeTTL * 1000);

    res.status(201).json({
      success: true,
      data: {
        challengeId: challenge.id,
        nonce: challenge.nonce,
        expiresAt: challenge.expiresAt,
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /auth/qr-challenge/verify
 * Verifies a signed QR challenge and issues tokens.
 * Body: { challengeId: string; signature: string; publicKey?: string; idempotencyKey?: string }
 */
authRouter.post('/qr-challenge/verify', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { challengeId, signature, publicKey, idempotencyKey } = req.body;

    if (!challengeId || !signature) {
      throw new AppError(400, 'Missing challengeId or signature');
    }

    // Idempotency check
    if (idempotencyKey && config.idempotencyEnabled) {
      const existing = await IdempotencyStore.get(idempotencyKey);
      if (existing) {
        if (existing.status === 'completed') {
          return res.status(200).json(existing.response);
        }
        throw new AppError(409, 'Request already in progress');
      }
      await IdempotencyStore.set(idempotencyKey, { status: 'pending' });
    }

    // Retrieve challenge
    const challenge = qrChallengeStore.get(challengeId);
    if (!challenge) {
      throw new AppError(404, 'Challenge not found or expired');
    }

    if (new Date() > challenge.expiresAt) {
      qrChallengeStore.delete(challengeId);
      throw new AppError(410, 'Challenge expired. Please request a new one.');
    }

    // Verify signature using Me Pass service
    const user = await MePassService.verifyChallenge(challenge.nonce, signature, publicKey);
    if (!user) {
      throw new AppError(401, 'QR challenge verification failed');
    }

    // Remove used challenge
    qrChallengeStore.delete(challengeId);

    const payload: UserPayload = {
      userId: user.id,
      email: user.email,
      roles: user.roles || [],
    };

    const accessToken = generateToken(payload);
    const refreshToken = generateRefreshToken(payload);

    const response = {
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        email: user.email,
        roles: user.roles,
      },
    };

    if (idempotencyKey && config.idempotencyEnabled) {
      await IdempotencyStore.complete(idempotencyKey, response);
    }

    res.status(200).json({
      success: true,
      data: response,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /auth/refresh
 * Refreshes access token using a valid refresh token.
 * Body: { refreshToken: string }
 */
authRouter.post('/refresh', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) {
      throw new AppError(400, 'Refresh token required');
    }

    const decoded = jwt.verify(refreshToken, config.refreshSecret) as UserPayload & { type: string };
    if (decoded.type !== 'refresh') {
      throw new AppError(401, 'Invalid token type');
    }

    // Optionally check if refresh token is revoked in DB
    const payload: UserPayload = {
      userId: decoded.userId,
      email: decoded.email,
      roles: decoded.roles,
    };

    const newAccessToken = generateToken(payload);
    const newRefreshToken = generateRefreshToken(payload);

    res.status(200).json({
      success: true,
      data: {
        accessToken: newAccessToken,
        refreshToken: newRefreshToken,
      },
    });
  } catch (error) {
    if (error instanceof jwt.JsonWebTokenError || error instanceof jwt.TokenExpiredError) {
      return next(new AppError(401, 'Refresh token invalid or expired'));
    }
    next(error);
  }
});

/**
 * POST /auth/logout
 * Invalidates refresh token (optional – requires token blacklist or revocation).
 * Body: { refreshToken: string }
 */
authRouter.post('/logout', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) {
      throw new AppError(400, 'Refresh token required');
    }

    // Here you'd add the token to a blacklist or delete from DB
    // Example: await TokenRevocationStore.revoke(refreshToken);

    res.status(200).json({
      success: true,
      message: 'Logged out successfully',
    });
  } catch (error) {
    next(error);
  }
});