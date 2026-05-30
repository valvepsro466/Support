tsx
import React, { useState, useCallback, useRef, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  StyleSheet,
  Alert,
  Platform,
} from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import { AuthenticationService } from '../services/AuthenticationService';
import { IdempotencyUtils } from '../utils/IdempotencyUtils';
import { Logger } from '../utils/Logger';
import { Metrics } from '../utils/Metrics';

// -----------------------------------------------------------------------------
// Types & Constants
// -----------------------------------------------------------------------------

type AuthMethod = 'mepass' | 'qrcode';

interface LoginResult {
  success: boolean;
  error?: string;
}

const MIN_ME_PASS_LENGTH = 6;
const MAX_ME_PASS_LENGTH = 32;
const ME_PASS_PATTERN = /^[a-zA-Z0-9@#_\-!]+$/;
const MAX_RETRIES_BEFORE_FALLBACK = 2;
const IDEMPOTENCY_KEY_LENGTH = 36;
const LOGIN_TIMEOUT_MS = 30000;
const QR_CODE_REFRESH_INTERVAL_MS = 60000; // suggest refresh after 60s

// -----------------------------------------------------------------------------
// Helper: Validate Me Pass input
// -----------------------------------------------------------------------------

/**
 * Validates the Me Pass string for format and security.
 * @param mePass - The raw Me Pass input
 * @returns {string | null} error message or null if valid
 */
function validateMePass(mePass: string): string | null {
  if (!mePass || mePass.trim().length === 0) {
    return 'Me Pass cannot be empty.';
  }
  if (mePass.trim().length < MIN_ME_PASS_LENGTH) {
    return `Me Pass must be at least ${MIN_ME_PASS_LENGTH} characters.`;
  }
  if (mePass.trim().length > MAX_ME_PASS_LENGTH) {
    return `Me Pass must be at most ${MAX_ME_PASS_LENGTH} characters.`;
  }
  if (!ME_PASS_PATTERN.test(mePass)) {
    return 'Me Pass contains invalid characters. Only letters, numbers, @, #, _, -, ! are allowed.';
  }
  return null;
}

// -----------------------------------------------------------------------------
// Helper: Extract user-friendly error message
// -----------------------------------------------------------------------------

/**
 * Parses an error into a user-friendly message and tags it with a category.
 * @param err - The caught error
 * @returns {{ message: string; category: string }}
 */
function parseError(err: unknown): { message: string; category: string } {
  if (err instanceof Error) {
    const lowerMsg = err.message.toLowerCase();
    if (lowerMsg.includes('network') || lowerMsg.includes('timeout') || lowerMsg.includes('abort')) {
      return { message: 'Connection issue. Please check your internet and try again.', category: 'network' };
    }
    if (lowerMsg.includes('invalid') || lowerMsg.includes('me pass')) {
      return { message: 'Invalid Me Pass. Please verify and try again.', category: 'validation' };
    }
    if (lowerMsg.includes('expired') || lowerMsg.includes('qr')) {
      return { message: 'QR code expired. Please request a new one.', category: 'expired' };
    }
    if (lowerMsg.includes('rate limit') || lowerMsg.includes('too many')) {
      return { message: 'Too many attempts. Please wait a moment.', category: 'rate_limited' };
    }
    return { message: err.message || 'An unexpected error occurred.', category: 'unknown' };
  }
  return { message: 'An unexpected error occurred.', category: 'unknown' };
}

// -----------------------------------------------------------------------------
// Helper: Generate secure idempotency key
// -----------------------------------------------------------------------------

/**
 * Generates a new idempotency key using a cryptographically random UUID.
 * @returns {string} UUID v4
 */
function generateSecureIdempotencyKey(): string {
  return IdempotencyUtils.generateKey();
}

// -----------------------------------------------------------------------------
// LoginScreen Component
// -----------------------------------------------------------------------------

/**
 * LoginScreen – Main authentication screen for ME Hub.
 *
 * Supports two methods: Me Pass (password-style) and QR code scanning.
 * Implements idempotency to prevent duplicate transactions, retry
 * management, and automatic fallback suggestions.
 */
const LoginScreen: React.FC = () => {
  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  const [authMethod, setAuthMethod] = useState<AuthMethod>('mepass');
  const [mePass, setMePass] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const [idempotencyKey, setIdempotencyKey] = useState(generateSecureIdempotencyKey());
  const [qrCodeData, setQrCodeData] = useState<string | null>(null); // base64 or URL
  const [qrCodeExpired, setQrCodeExpired] = useState(false);

  // Ref to abort pending network request
  const abortControllerRef = useRef<AbortController | null>(null);
  const qrRefreshTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      if (qrRefreshTimerRef.current) {
        clearInterval(qrRefreshTimerRef.current);
      }
    };
  }, []);

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Sets a user-safe error message and logs the full error.
   * @param err - The error object
   * @param context - Description of the operation that failed
   */
  const handleError = useCallback((err: unknown, context: string): void => {
    const parsed = parseError(err);
    Logger.error(`[LoginScreen] ${context}`, err, { category: parsed.category });
    Metrics.increment('auth_error', { method: authMethod, category: parsed.category });
    setError(parsed.message);
    setRetryCount((prev) => prev + 1);
  }, [authMethod]);

  /**
   * Resets error and retry state when switching methods or clearing input.
   */
  const resetErrorState = useCallback(() => {
    setError(null);
    setRetryCount(0);
  }, []);

  /**
   * Refreshes the idempotency key after any attempt (success or failure)
   * to prevent replay.
   */
  const refreshIdempotencyKey = useCallback(() => {
    setIdempotencyKey(generateSecureIdempotencyKey());
  }, []);

  // ---------------------------------------------------------------------------
  // Me Pass Login
  // ---------------------------------------------------------------------------

  /**
   * Handles login with Me Pass.
   * Validates input, performs network check, uses idempotency, handles retry logic.
   */
  const handleMePassLogin = useCallback(async (): Promise<void> => {
    // Validation
    const trimmedPass = mePass.trim();
    const validationError = validateMePass(trimmedPass);
    if (validationError) {
      setError(validationError);
      return;
    }

    // Check network
    const netState = await NetInfo.fetch();
    if (!netState.isConnected) {
      setError('No internet connection. Please connect and try again.');
      return;
    }

    // Client-side rate limit
    if (retryCount > MAX_RETRIES_BEFORE_FALLBACK) {
      setError('Too many failed attempts. Consider switching to QR code or try again later.');
      Metrics.increment('auth_rate_limited', { method: 'mepass' });
      return;
    }

    setIsLoading(true);
    setError(null);

    // Create abort controller for timeout
    const controller = new AbortController();
    abortControllerRef.current = controller;
    const timeoutId = setTimeout(() => controller.abort(), LOGIN_TIMEOUT_MS);

    try {
      Logger.info('[LoginScreen] Attempting Me Pass login', {
        method: 'mepass',
        retryCount,
        idempotencyKey: idempotencyKey.substring(0, 8) + '...', // log only prefix
      });

      const result: LoginResult = await AuthenticationService.loginWithMePass(
        trimmedPass,
        idempotencyKey,
        { signal: controller.signal }
      );

      if (result.success) {
        Logger.info('[LoginScreen] Me Pass login successful');
        Metrics.increment('auth_success', { method: 'mepass' });
        Alert.alert('Success', 'Logged in successfully.');
        refreshIdempotencyKey();
        setRetryCount(0);
        // Navigate or perform post-login actions...
      } else {
        // Business-level failure (invalid credentials, etc.)
        throw new Error(result.error || 'Login failed');
      }
    } catch (err: unknown) {
      handleError(err, 'Me Pass login failed');
      refreshIdempotencyKey();
    } finally {
      clearTimeout(timeoutId);
      abortControllerRef.current = null;
      setIsLoading(false);
    }
  }, [mePass, idempotencyKey, retryCount, handleError, refreshIdempotencyKey]);

  // ---------------------------------------------------------------------------
  // QR Code Login
  // ---------------------------------------------------------------------------

  /**
   * Simulates fetching a QR code from the server.
   * Sets a timer to mark the QR code as expired after QR_CODE_REFRESH_INTERVAL_MS.
   */
  const fetchQRCode = useCallback(async (): Promise<void> => {
    setIsLoading(true);
    setError(null);
    setQrCodeExpired(false);

    try {
      const netState = await NetInfo.fetch();
      if (!netState.isConnected) {
        setError('No internet connection. Cannot fetch QR code.');
        return;
      }

      Logger.info('[LoginScreen] Fetching QR code', { method: 'qrcode' });
      const data = await AuthenticationService.getQRCodeData();
      setQrCodeData(data);

      // Schedule expiry warning
      if (qrRefreshTimerRef.current) {
        clearInterval(qrRefreshTimerRef.current);
      }
      qrRefreshTimerRef.current = setInterval(() => {
        setQrCodeExpired(true);
        Logger.warn('[LoginScreen] QR code expired, user should refresh');
        Metrics.increment('qrcode_expired');
      }, QR_CODE_REFRESH_INTERVAL_MS);
    } catch (err: unknown) {
      handleError(err, 'Failed to fetch QR code');
    } finally {
      setIsLoading(false);
    }
  }, [handleError]);

  /**
   * Handles QR code scan result.
   * @param scannedData - The data decoded from the QR code
   */
  const handleQRCodeScanned = useCallback(async (scannedData: string): Promise<void> => {
    if (!scannedData || scannedData.trim().length === 0) {
      setError('Invalid QR code data.');
      return;
    }

    setIsLoading(true);
    setError(null);

    const controller = new AbortController();
    abortControllerRef.current = controller;
    const timeoutId = setTimeout(() => controller.abort(), LOGIN_TIMEOUT_MS);

    try {
      Logger.info('[LoginScreen] Processing QR code scan', {
        method: 'qrcode',
        idempotencyKey: idempotencyKey.substring(0, 8) + '...',
      });

      const result: LoginResult = await AuthenticationService.verifyQRCode(
        scannedData,
        idempotencyKey,
        { signal: controller.signal }
      );

      if (result.success) {
        Logger.info('[LoginScreen] QR code login successful');
        Metrics.increment('auth_success', { method: 'qrcode' });
        Alert.alert('Success', 'Logged in successfully.');
        refreshIdempotencyKey();
        // Navigate...
      } else {
        throw new Error(result.error || 'QR code verification failed');
      }
    } catch (err: unknown) {
      handleError(err, 'QR code login failed');
      refreshIdempotencyKey();
    } finally {
      clearTimeout(timeoutId);
      abortControllerRef.current = null;
      setIsLoading(false);
    }
  }, [idempotencyKey, handleError, refreshIdempotencyKey]);

  /**
   * Refreshes the QR code when expired or manually requested.
   */
  const handleRefreshQRCode = useCallback(() => {
    fetchQRCode();
  }, [fetchQRCode]);

  // ---------------------------------------------------------------------------
  // UI Handlers
  // ---------------------------------------------------------------------------

  /**
   * Clears Me Pass input and resets error.
   */
  const handleMePassChange = useCallback((text: string): void => {
    setMePass(text);
    if (error) resetErrorState();
  }, [error, resetErrorState]);

  /**
   * Switches between auth methods and resets state.
   */
  const switchAuthMethod = useCallback((method: AuthMethod): void => {
    setAuthMethod(method);
    resetErrorState();
    setMePass('');
    setQrCodeData(null);
    setQrCodeExpired(false);
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    if (qrRefreshTimerRef.current) {
      clearInterval(qrRefreshTimerRef.current);
      qrRefreshTimerRef.current = null;
    }
  }, [resetErrorState]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Login to ME Hub</Text>

      {/* Auth method selector */}
      <View style={styles.methodSelector}>
        <TouchableOpacity
          style={[styles.methodButton, authMethod === 'mepass' && styles.methodButtonActive]}
          onPress={() => switchAuthMethod('mepass')}
          accessibilityRole="tab"
          accessibilityState={{ selected: authMethod === 'mepass' }}
        >
          <Text style={[styles.methodButtonText, authMethod === 'mepass' && styles.methodButtonTextActive]}>
            Me Pass
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.methodButton, authMethod === 'qrcode' && styles.methodButtonActive]}
          onPress={() => switchAuthMethod('qrcode')}
          accessibilityRole="tab"
          accessibilityState={{ selected: authMethod === 'qrcode' }}
        >
          <Text style={[styles.methodButtonText, authMethod === 'qrcode' && styles.methodButtonTextActive]}>
            QR Code
          </Text>
        </TouchableOpacity>
      </View>

      {/* Me Pass input */}
      {authMethod === 'mepass' && (
        <View style={styles.mepassContainer}>
          <TextInput
            style={styles.input}
            placeholder="Enter your Me Pass"
            placeholderTextColor="#A9A9A9"
            value={mePass}
            onChangeText={handleMePassChange}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            maxLength={MAX_ME_PASS_LENGTH}
            editable={!isLoading}
            accessibilityLabel="Me Pass input"
          />
          <TouchableOpacity
            style={[styles.loginButton, (!mePass || isLoading) && styles.loginButtonDisabled]}
            onPress={handleMePassLogin}
            disabled={!mePass || isLoading}
            accessibilityRole="button"
            accessibilityLabel="Log in with Me Pass"
          >
            {isLoading ? (
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <Text style={styles.loginButtonText}>Log In</Text>
            )}
          </TouchableOpacity>
        </View>
      )}

      {/* QR Code section */}
      {authMethod === 'qrcode' && (
        <View style={styles.qrContainer}>
          {qrCodeData ? (
            <>
              {/* Assume we have a QR code component; replace with actual */}
              <View style={styles.qrPlaceholder}>
                <Text style={styles.qrPlaceholderText}>[QR Code Image]</Text>
              </View>
              <TouchableOpacity
                style={[styles.loginButton, isLoading && styles.loginButtonDisabled]}
                onPress={() => handleQRCodeScanned('dummy-scanned-data')} // In reality, scan from camera
                disabled={isLoading}
                accessibilityRole="button"
                accessibilityLabel="Scan QR code"
              >
                {isLoading ? (
                  <ActivityIndicator color="#FFFFFF" />
                ) : (
                  <Text style={styles.loginButtonText}>Scan QR Code</Text>
                )}
              </TouchableOpacity>
              {qrCodeExpired && (
                <View style={styles.expiredWarning}>
                  <Text style={styles.expiredWarningText}>
                    QR code expired. Please refresh.
                  </Text>
                  <TouchableOpacity
                    style={styles.refreshButton}
                    onPress={handleRefreshQRCode}
                    disabled={isLoading}
                    accessibilityRole="button"
                    accessibilityLabel="Refresh QR code"
                  >
                    <Text style={styles.refreshButtonText}>Refresh</Text>
                  </TouchableOpacity>
                </View>
              )}
            </>
          ) : (
            <TouchableOpacity
              style={[styles.loginButton, isLoading && styles.loginButtonDisabled]}
              onPress={fetchQRCode}
              disabled={isLoading}
              accessibilityRole="button"
              accessibilityLabel="Get QR code"
            >
              {isLoading ? (
                <ActivityIndicator color="#FFFFFF" />
              ) : (
                <Text style={styles.loginButtonText}>Get QR Code</Text>
              )}
            </TouchableOpacity>
          )}
        </View>
      )}

      {/* Error display */}
      {error && (
        <View style={styles.errorContainer}>
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity
            style={styles.dismissButton}
            onPress={() => setError(null)}
            accessibilityRole="button"
            accessibilityLabel="Dismiss error"
          >
            <Text style={styles.dismissButtonText}>Dismiss</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
};

// -----------------------------------------------------------------------------
// Styles
// -----------------------------------------------------------------------------

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 24,
    backgroundColor: '#F5F5F5',
  },
  title: {
    fontSize: 28,
    fontWeight: 'bold',
    textAlign: 'center',
    marginBottom: 40,
    color: '#333',
  },
  methodSelector: {
    flexDirection: 'row',
    marginBottom: 30,
    borderRadius: 8,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#DDD',
  },
  methodButton: {
    flex: 1,
    paddingVertical: 12,
    alignItems: 'center',
    backgroundColor: '#FFF',
  },
  methodButtonActive: {
    backgroundColor: '#4A90D9',
  },
  methodButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#555',
  },
  methodButtonTextActive: {
    color: '#FFF',
  },
  mepassContainer: {
    marginBottom: 20,
  },
  input: {
    height: 48,
    borderWidth: 1,
    borderColor: '#CCC',
    borderRadius: 8,
    paddingHorizontal: 16,
    fontSize: 16,
    backgroundColor: '#FFF',
    marginBottom: 16,
    color: '#333',
  },
  loginButton: {
    height: 48,
    backgroundColor: '#4A90D9',
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
    elevation: 2,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
  },
  loginButtonDisabled: {
    opacity: 0.6,
  },
  loginButtonText: {
    color: '#FFF',
    fontSize: 16,
    fontWeight: 'bold',
  },
  qrContainer: {
    alignItems: 'center',
    marginBottom: 20,
  },
  qrPlaceholder: {
    width: 200,
    height: 200,
    backgroundColor: '#E0E0E0',
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 20,
  },
  qrPlaceholderText: {
    fontSize: 14,
    color: '#888',
  },
  expiredWarning: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 16,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: '#FFF3CD',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#FFEAA7',
  },
  expiredWarningText: {
    flex: 1,
    color: '#856404',
    fontSize: 14,
  },
  refreshButton: {
    marginLeft: 12,
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: '#FFC107',
    borderRadius: 6,
  },
  refreshButtonText: {
    color: '#333',
    fontWeight: '600',
    fontSize: 14,
  },
  errorContainer: {
    marginTop: 20,
    padding: 12,
    backgroundColor: '#F8D7DA',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#F5C6CB',
    flexDirection: 'row',
    alignItems: 'center',
  },
  errorText: {
    flex: 1,
    color: '#721C24',
    fontSize: 14,
  },
  dismissButton: {
    marginLeft: 12,
    paddingHorizontal: 10,
    paddingVertical: 4,
    backgroundColor: '#721C24',
    borderRadius: 6,
  },
  dismissButtonText: {
    color: '#FFF',
    fontSize: 12,
    fontWeight: '600',
  },
});

export default LoginScreen;