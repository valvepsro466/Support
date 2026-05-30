import { AuthenticationService } from '../services/AuthenticationService';
import { AuthMode } from '../types/auth.types';
import { apiClient } from '../api/apiClient';

jest.mock('../api/apiClient');
const mockedApiClient = apiClient as jest.Mocked<typeof apiClient>;

describe('AuthenticationService', () => {
  let authService: AuthenticationService;

  beforeEach(() => {
    jest.clearAllMocks();
    authService = new AuthenticationService();
  });

  describe('retry logic', () => {
    it('should retry authentication on transient error up to maxAttempts', async () => {
      const maxAttempts = 3;
      const credentials = { userId: 'test-user' };
      const error = new Error('Network timeout');
      
      mockedApiClient.post
        .mockRejectedValueOnce(error)
        .mockRejectedValueOnce(error)
        .mockResolvedValueOnce({ token: 'valid', expiresIn: 3600 });

      const result = await authService.authenticate(credentials, AuthMode.ME_PASS, maxAttempts);

      expect(mockedApiClient.post).toHaveBeenCalledTimes(3);
      expect(result.token).toBe('valid');
    });

    it('should fail after exhausting all retries', async () => {
      const maxAttempts = 2;
      const credentials = { userId: 'test-user' };
      
      mockedApiClient.post.mockRejectedValue(new Error('Server error'));

      await expect(authService.authenticate(credentials, AuthMode.QR_CODE, maxAttempts))
        .rejects.toThrow('Authentication failed after 2 attempts');
      expect(mockedApiClient.post).toHaveBeenCalledTimes(2);
    });

    it('should not retry on non-transient errors', async () => {
      const credentials = { userId: 'test-user' };
      const authError = new Error('Invalid credentials');
      authError.name = 'AuthError';
      
      mockedApiClient.post.mockRejectedValueOnce(authError);

      await expect(authService.authenticate(credentials, AuthMode.ME_PASS))
        .rejects.toThrow('Invalid credentials');
      expect(mockedApiClient.post).toHaveBeenCalledTimes(1);
    });
  });

  describe('fallback modes', () => {
    it('should fallback to QR code when Me pass fails', async () => {
      const credentials = { userId: 'test-user' };
      
      mockedApiClient.post
        .mockRejectedValueOnce(new Error('Me pass unavailable'))
        .mockResolvedValueOnce({ token: 'qr-valid', expiresIn: 3600 });

      const result = await authService.authenticateWithFallback(credentials, AuthMode.ME_PASS);

      expect(mockedApiClient.post).toHaveBeenNthCalledWith(1, '/auth/me-pass', credentials);
      expect(mockedApiClient.post).toHaveBeenNthCalledWith(2, '/auth/qr-code', credentials);
      expect(result.token).toBe('qr-valid');
    });

    it('should raise error when all fallback modes fail', async () => {
      const credentials = { userId: 'test-user' };
      
      mockedApiClient.post.mockRejectedValue(new Error('Auth service down'));

      await expect(authService.authenticateWithFallback(credentials, AuthMode.ME_PASS))
        .rejects.toThrow('All authentication methods failed');
    });

    it('should succeed on first attempt and not call fallback', async () => {
      const credentials = { userId: 'test-user' };
      
      mockedApiClient.post.mockResolvedValueOnce({ token: 'me-pass-valid', expiresIn: 3600 });

      const result = await authService.authenticateWithFallback(credentials, AuthMode.ME_PASS);

      expect(mockedApiClient.post).toHaveBeenCalledTimes(1);
      expect(mockedApiClient.post).toHaveBeenCalledWith('/auth/me-pass', credentials);
      expect(result.token).toBe('me-pass-valid');
    });
  });

  describe('idempotency handling', () => {
    it('should include idempotency key in retry requests', async () => {
      const credentials = { userId: 'test-user' };
      const maxAttempts = 3;
      
      mockedApiClient.post.mockRejectedValue(new Error('Timeout'));

      await expect(
        authService.authenticate(credentials, AuthMode.QR_CODE, maxAttempts)
      ).rejects.toThrow();

      const calls = mockedApiClient.post.mock.calls;
      const idempotencyKeys = calls.map(([_, __, config]) => config?.headers?.['X-Idempotency-Key']);
      
      // All requests should use the same idempotency key
      expect(new Set(idempotencyKeys).size).toBe(1);
      expect(idempotencyKeys[0]).toBeDefined();
    });
  });
});