import { Request, Response, NextFunction } from 'express';
import { IdempotencyMiddleware } from '../middleware/idempotency';
import { IdempotencyService } from '../services/idempotency.service';

jest.mock('../services/idempotency.service');

const MockIdempotencyService = IdempotencyService as jest.MockedClass<typeof IdempotencyService>;

describe('Idempotency Middleware', () => {
  let middleware: ReturnType<typeof IdempotencyMiddleware>;
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let mockNext: jest.MockedFunction<NextFunction>;
  let mockService: jest.Mocked<IdempotencyService>;

  const idempotencyKey = 'test-key-123';
  const cachedResponse = { status: 201, body: { id: 'txn-1', amount: 100 } };

  beforeEach(() => {
    mockService = new MockIdempotencyService() as jest.Mocked<IdempotencyService>;
    mockReq = {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      path: '/api/transactions',
      body: { amount: 100, currency: 'USD' },
    };
    mockRes = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
      send: jest.fn().mockReturnThis(),
      setHeader: jest.fn(),
    };
    mockNext = jest.fn();
    middleware = IdempotencyMiddleware({ service: mockService });
  });

  it('should call next() and cache response for new idempotency key', async () => {
    mockService.getCachedResponse.mockResolvedValue(null);
    mockService.lockIdempotencyKey.mockResolvedValue(true);
    mockService.cacheResponse.mockResolvedValue(undefined);

    // Simulate the response being set by downstream handler
    const originalJson = mockRes.json!.bind(mockRes);
    mockRes.json = jest.fn((body) => {
      originalJson(body);
      return mockRes;
    });

    await middleware(mockReq as Request, mockRes as Response, mockNext);

    expect(mockService.getCachedResponse).toHaveBeenCalledWith(idempotencyKey);
    expect(mockService.lockIdempotencyKey).toHaveBeenCalledWith(idempotencyKey, expect.any(Number));
    expect(mockNext).toHaveBeenCalled();

    // Simulate downstream handler responding
    mockRes.status(201).json({ id: 'txn-1', amount: 100 });

    // After response is sent, middleware should intercept and cache
    expect(mockService.cacheResponse).toHaveBeenCalledWith(
      idempotencyKey,
      { status: 201, body: { id: 'txn-1', amount: 100 } },
      expect.any(Number)
    );
  });

  it('should return cached response for duplicate idempotency key', async () => {
    mockService.getCachedResponse.mockResolvedValue(cachedResponse);
    mockService.lockIdempotencyKey.mockResolvedValue(false); // lock already held

    await middleware(mockReq as Request, mockRes as Response, mockNext);

    expect(mockService.getCachedResponse).toHaveBeenCalledWith(idempotencyKey);
    expect(mockNext).not.toHaveBeenCalled();
    expect(mockRes.status).toHaveBeenCalledWith(201);
    expect(mockRes.json).toHaveBeenCalledWith({ id: 'txn-1', amount: 100 });
  });

  it('should return 409 Conflict for duplicate key with different request body', async () => {
    mockService.getCachedResponse.mockResolvedValue(cachedResponse);
    // Simulate different request body
    mockReq.body = { amount: 200, currency: 'EUR' };

    await middleware(mockReq as Request, mockRes as Response, mockNext);

    expect(mockService.getCachedResponse).toHaveBeenCalledWith(idempotencyKey);
    expect(mockNext).not.toHaveBeenCalled();
    expect(mockRes.status).toHaveBeenCalledWith(409);
    expect(mockRes.json).toHaveBeenCalledWith({
      error: 'Idempotency key already used with different request parameters',
    });
  });

  it('should wait for lock if another request holds the idempotency key and then return cached response', async () => {
    mockService.getCachedResponse
      .mockResolvedValueOnce(null) // first call still processing
      .mockResolvedValueOnce(cachedResponse); // second call after lock released
    mockService.lockIdempotencyKey.mockResolvedValueOnce(false); // lock held by first request
    mockService.waitForLock.mockResolvedValue(undefined);

    await middleware(mockReq as Request, mockRes as Response, mockNext);

    expect(mockService.getCachedResponse).toHaveBeenCalledTimes(2);
    expect(mockService.waitForLock).toHaveBeenCalledWith(idempotencyKey, expect.any(Number));
    expect(mockNext).not.toHaveBeenCalled();
    expect(mockRes.status).toHaveBeenCalledWith(201);
    expect(mockRes.json).toHaveBeenCalledWith(cachedResponse.body);
  });

  it('should handle expired idempotency key (TTL passed) as new request', async () => {
    mockService.getCachedResponse.mockResolvedValue(null); // expired ensures null
    mockService.lockIdempotencyKey.mockResolvedValue(true);
    mockService.cacheResponse.mockResolvedValue(undefined);

    await middleware(mockReq as Request, mockRes as Response, mockNext);

    expect(mockService.getCachedResponse).toHaveBeenCalledWith(idempotencyKey);
    expect(mockService.lockIdempotencyKey).toHaveBeenCalled();
    expect(mockNext).toHaveBeenCalled();
  });

  it('should skip idempotency check for non-mutating methods (GET, HEAD, OPTIONS)', async () => {
    mockReq.method = 'GET';
    await middleware(mockReq as Request, mockRes as Response, mockNext);

    expect(mockService.getCachedResponse).not.toHaveBeenCalled();
    expect(mockService.lockIdempotencyKey).not.toHaveBeenCalled();
    expect(mockNext).toHaveBeenCalled();
  });

  it('should skip idempotency check if no idempotency key header present', async () => {
    delete mockReq.headers!['Idempotency-Key'];
    await middleware(mockReq as Request, mockRes as Response, mockNext);

    expect(mockService.getCachedResponse).not.toHaveBeenCalled();
    expect(mockService.lockIdempotencyKey).not.toHaveBeenCalled();
    expect(mockNext).toHaveBeenCalled();
  });

  it('should call next with error if service throws', async () => {
    mockService.getCachedResponse.mockRejectedValue(new Error('Database error'));
    await expect(middleware(mockReq as Request, mockRes as Response, mockNext)).rejects.toThrow('Database error');
  });
});