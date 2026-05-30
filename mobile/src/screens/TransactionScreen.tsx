typescript
// mobile/src/screens/TransactionScreen.tsx
import React, {
  useState,
  useEffect,
  useCallback,
  useRef,
  useMemo,
  ReactNode,
} from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ActivityIndicator,
  StyleSheet,
  Alert,
  Modal,
  BackHandler,
  Platform,
  ScrollView,
} from 'react-native';

// ---------------------------------------------------------------------------
// Types – must match backend contract exactly
// ---------------------------------------------------------------------------
export type TransactionStatus =
  | 'pending'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface Transaction {
  id: string;
  idempotencyKey: string;
  status: TransactionStatus;
  progress: number; // 0–100
  createdAt: string;
  updatedAt: string;
  errorMessage?: string;
  assetAmount?: string;
  assetType?: string;
  destinationAddress?: string;
}

export interface ApiResponse<T> {
  success: boolean;
  data: T;
  message?: string;
  errorCode?: string;
}

// ---------------------------------------------------------------------------
// Constants & Configuration
// ---------------------------------------------------------------------------
const API_BASE = '/api/v1/transactions';
const POLL_INTERVAL_MS = 3000;
const MAX_POLL_ATTEMPTS = 120; // 6 minutes
const REQUEST_TIMEOUT_MS = 10000; // 10 seconds per fetch
const IDEMPOTENCY_HEADER = 'X-Idempotency-Key';

// ---------------------------------------------------------------------------
// Logger (simple – replace with proper logging library in production)
// ---------------------------------------------------------------------------
const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
type LogLevel = (typeof LOG_LEVELS)[number];
const currentLogLevel: LogLevel = __DEV__ ? 'debug' : 'warn';

function log(level: LogLevel, message: string, meta?: unknown): void {
  if (LOG_LEVELS.indexOf(level) < LOG_LEVELS.indexOf(currentLogLevel)) return;
  const timestamp = new Date().toISOString();
  const prefix = `[${timestamp}] [${level.toUpperCase()}] [TransactionScreen]`;
  const output = meta ? `${prefix} ${message} ${JSON.stringify(meta)}` : `${prefix} ${message}`;
  switch (level) {
    case 'error':
      console.error(output);
      break;
    case 'warn':
      console.warn(output);
      break;
    case 'info':
      console.log(output);
      break;
    case 'debug':
    default:
      console.debug(output);
  }
}

// ---------------------------------------------------------------------------
// Utility: generate a unique idempotency key
// ---------------------------------------------------------------------------
function generateIdempotencyKey(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 10)}-${Platform.OS}-${Platform.Version}`;
}

// ---------------------------------------------------------------------------
// Utility: validate transaction ID format (example – adapt to actual pattern)
// ---------------------------------------------------------------------------
function validateTransactionId(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

// ---------------------------------------------------------------------------
// Utility: timeout wrapper for fetch
// ---------------------------------------------------------------------------
async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

// ---------------------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------------------
const TERMINAL_STATUSES: ReadonlySet<TransactionStatus> = new Set([
  'completed',
  'failed',
  'cancelled',
]);

function isTerminalStatus(status: TransactionStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

function statusLabel(status: TransactionStatus): string {
  const map: Record<TransactionStatus, string> = {
    pending: 'Pending',
    processing: 'Processing',
    completed: 'Completed',
    failed: 'Failed',
    cancelled: 'Cancelled',
  };
  return map[status] ?? 'Unknown';
}

// ---------------------------------------------------------------------------
// API calls with full error handling, timeout, idempotency
// ---------------------------------------------------------------------------
/**
 * Generic API request with timeout, error handling, and idempotency support.
 * @param endpoint - Relative path (e.g., `/${id}/status`)
 * @param method - HTTP method
 * @param idempotencyKey - Optional idempotency key for write operations
 * @returns Parsed API response
 */
async function apiRequest<T>(
  endpoint: string,
  method: 'GET' | 'POST',
  idempotencyKey?: string,
): Promise<ApiResponse<T>> {
  const url = `${API_BASE}${endpoint}`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };
  if (idempotencyKey) {
    headers[IDEMPOTENCY_HEADER] = idempotencyKey;
  }

  log('debug', 'API request', { url, method, idempotencyKey });

  let response: Response;
  try {
    response = await fetchWithTimeout(url, {
      method,
      headers,
    });
  } catch (error: unknown) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      log('error', 'Request timed out', { url });
      throw new Error('Request timed out. Please check your connection and try again.');
    }
    log('error', 'Network error', { url, error });
    throw new Error('Network error. Please check your connection.');
  }

  if (!response.ok) {
    let errorBody: { message?: string; errorCode?: string } = {};
    try {
      errorBody = await response.json();
    } catch {
      // Ignore JSON parse failure
    }
    const message = errorBody.message ?? `HTTP ${response.status} ${response.statusText}`;
    log('warn', 'API error response', { status: response.status, message, errorCode: errorBody.errorCode });
    throw new Error(message);
  }

  let json: ApiResponse<T>;
  try {
    json = await response.json();
  } catch {
    log('error', 'Failed to parse API response JSON');
    throw new Error('Invalid response from server.');
  }
  return json;
}

/**
 * Fetch transaction status from backend.
 */
async function fetchTransactionStatus(transactionId: string): Promise<ApiResponse<Transaction>> {
  return apiRequest<Transaction>(`/${transactionId}/status`, 'GET');
}

/**
 * Cancel a transaction (idempotent).
 */
async function cancelTransaction(transactionId: string): Promise<ApiResponse<Transaction>> {
  const idempotencyKey = generateIdempotencyKey();
  return apiRequest<Transaction>(`/${transactionId}/cancel`, 'POST', idempotencyKey);
}

/**
 * Retry a failed transaction (idempotent).
 */
async function retryTransaction(transactionId: string): Promise<ApiResponse<Transaction>> {
  const idempotencyKey = generateIdempotencyKey();
  return apiRequest<Transaction>(`/${transactionId}/retry`, 'POST', idempotencyKey);
}

// ---------------------------------------------------------------------------
// Custom hook for polling with automatic cleanup and graceful stopping
// ---------------------------------------------------------------------------
interface UseTransactionPollingOptions {
  transactionId: string;
  enabled: boolean;
  onTerminal?: (transaction: Transaction) => void;
  onError?: (error: string) => void;
}

interface UseTransactionPollingReturn {
  transaction: Transaction | null;
  loading: boolean;
  error: string | null;
  startPolling: () => void;
  stopPolling: () => void;
}

/**
 * Polls transaction status at a fixed interval until a terminal status is reached.
 * Automatically cleans up on unmount, and respects `enabled` and max attempts.
 */
function useTransactionPolling({
  transactionId,
  enabled,
  onTerminal,
  onError,
}: UseTransactionPollingOptions): UseTransactionPollingReturn {
  const [transaction, setTransaction] = useState<Transaction | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const attemptsRef = useRef<number>(0);
  const isMountedRef = useRef<boolean>(true);
  const enabledRef = useRef<boolean>(enabled);
  const transactionIdRef = useRef<string>(transactionId);

  // Keep refs in sync
  useEffect(() => {
    enabledRef.current = enabled;
    transactionIdRef.current = transactionId;
  }, [enabled, transactionId]);

  const clearPolling = useCallback(() => {
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
  }, []);

  const stopPolling = useCallback(() => {
    log('info', 'Polling stopped explicitly');
    clearPolling();
  }, [clearPolling]);

  const startPolling = useCallback(() => {
    if (!enabledRef.current) return;
    log('info', 'Polling started', { transactionId: transactionIdRef.current });

    const poll = async () => {
      if (!isMountedRef.current) return;
      if (attemptsRef.current >= MAX_POLL_ATTEMPTS) {
        stopPolling();
        const timeoutError = 'Transaction polling timed out. Please check status manually.';
        setError(timeoutError);
        onError?.(timeoutError);
        return;
      }

      try {
        const response = await fetchTransactionStatus(transactionIdRef.current);
        if (!response.success) {
          throw new Error(response.message ?? 'Failed to fetch status');
        }

        if (!isMountedRef.current) return;
        setTransaction(response.data);
        setError(null);
        setLoading(false);
        attemptsRef.current++;

        if (isTerminalStatus(response.data.status)) {
          log('info', 'Terminal status reached', { status: response.data.status });
          stopPolling();
          onTerminal?.(response.data);
        }
      } catch (err: unknown) {
        if (!isMountedRef.current) return;
        const message = err instanceof Error ? err.message : 'Unknown error';
        log('warn', 'Polling attempt failed', { attempt: attemptsRef.current, error: message });
        // Only set error after multiple failures to avoid flickering
        if (attemptsRef.current > 3) {
          setError(message);
          onError?.(message);
        }
        attemptsRef.current++;
      }
    };

    // Immediate first poll
    poll();
    pollingRef.current = setInterval(poll, POLL_INTERVAL_MS);
  }, [onTerminal, onError, stopPolling]);

  // Start/stop based on enabled
  useEffect(() => {
    if (enabled) {
      startPolling();
    } else {
      stopPolling();
    }

    return () => {
      stopPolling();
      isMountedRef.current = false;
    };
  }, [enabled, startPolling, stopPolling]);

  // Reset state when transactionId changes
  useEffect(() => {
    setTransaction(null);
    setLoading(true);
    setError(null);
    attemptsRef.current = 0;
  }, [transactionId]);

  return {
    transaction,
    loading,
    error,
    startPolling,
    stopPolling,
  };
}

// ---------------------------------------------------------------------------
// ConfirmDialog Component (simple modal for idempotent actions)
// ---------------------------------------------------------------------------
interface ConfirmDialogProps {
  visible: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  loading?: boolean;
}

const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  visible,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  onConfirm,
  onCancel,
  loading = false,
}) => {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <View style={styles.modalOverlay}>
        <View style={styles.modalContainer}>
          <Text style={styles.modalTitle}>{title}</Text>
          <Text style={styles.modalMessage}>{message}</Text>
          <View style={styles.modalActions}>
            <TouchableOpacity
              style={[styles.modalButton, styles.modalCancelButton]}
              onPress={onCancel}
              disabled={loading}
            >
              <Text style={styles.modalButtonText}>{cancelLabel}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.modalButton, styles.modalConfirmButton]}
              onPress={onConfirm}
              disabled={loading}
            >
              {loading ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Text style={styles.modalButtonText}>{confirmLabel}</Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
};

// ---------------------------------------------------------------------------
// Main TransactionScreen Component
// ---------------------------------------------------------------------------
interface TransactionScreenProps {
  transactionId: string;
  onBack?: () => void;
}

/**
 * Displays current transaction status, progress, and allows cancel/retry actions.
 * Uses polling to track status until completion.
 */
const TransactionScreen: React.FC<TransactionScreenProps> = ({ transactionId, onBack }) => {
  // Input validation
  if (!validateTransactionId(transactionId)) {
    return (
      <View style={styles.container}>
        <Text style={styles.errorText}>Invalid transaction ID format.</Text>
      </View>
    );
  }

  const [confirmDialogVisible, setConfirmDialogVisible] = useState(false);
  const [confirmAction, setConfirmAction] = useState<'cancel' | 'retry' | null>(null);
  const [actionLoading, setActionLoading] = useState(false);

  const handleTerminal = useCallback((transaction: Transaction) => {
    log('info', 'Transaction reached terminal state', {
      id: transaction.id,
      status: transaction.status,
    });
    // Could trigger navigation or analytics
  }, []);

  const handlePollError = useCallback((error: string) => {
    log('error', 'Polling error callback', { error });
  }, []);

  const {
    transaction,
    loading,
    error,
    startPolling,
    stopPolling,
  } = useTransactionPolling({
    transactionId,
    enabled: true,
    onTerminal: handleTerminal,
    onError: handlePollError,
  });

  // Physical back button handling
  useEffect(() => {
    const backHandler = BackHandler.addEventListener('hardwareBackPress', () => {
      if (confirmDialogVisible) {
        setConfirmDialogVisible(false);
        return true;
      }
      if (onBack) {
        onBack();
        return true;
      }
      return false;
    });
    return () => backHandler.remove();
  }, [confirmDialogVisible, onBack]);

  // Memoized action handlers
  const handleCancel = useCallback(() => {
    setConfirmAction('cancel');
    setConfirmDialogVisible(true);
  }, []);

  const handleRetry = useCallback(() => {
    setConfirmAction('retry');
    setConfirmDialogVisible(true);
  }, []);

  const executeAction = useCallback(async () => {
    if (!transaction) return;
    setActionLoading(true);
    try {
      let response: ApiResponse<Transaction>;
      if (confirmAction === 'cancel') {
        response = await cancelTransaction(transaction.id);
      } else {
        response = await retryTransaction(transaction.id);
      }
      if (response.success) {
        log('info', 'Action executed successfully', { action: confirmAction });
        setConfirmDialogVisible(false);
        // Polling will automatically pick up new status
        startPolling();
      } else {
        Alert.alert('Action failed', response.message ?? 'Please try again.');
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Action failed';
      Alert.alert('Error', message);
    } finally {
      setActionLoading(false);
    }
  }, [transaction, confirmAction, startPolling]);

  // Derived state for UI
  const progress = transaction?.progress ?? 0;
  const status = transaction?.status ?? 'pending';
  const isTerminal = isTerminalStatus(status);
  const showCancel = status === 'pending' || status === 'processing';
  const showRetry = status === 'failed';

  // Render
  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.contentContainer}
    >
      {/* Back button */}
      {onBack && (
        <TouchableOpacity style={styles.backButton} onPress={onBack}>
          <Text style={styles.backButtonText}>{'< Back'}</Text>
        </TouchableOpacity>
      )}

      {/* Transaction ID */}
      <Text style={styles.sectionTitle}>Transaction</Text>
      <Text style={styles.transactionId}>{transactionId}</Text>

      {/* Status indicator */}
      <View style={styles.statusContainer}>
        <Text style={styles.statusLabel}>Status:</Text>
        <View
          style={[
            styles.statusBadge,
            status === 'completed' && styles.statusCompleted,
            status === 'failed' && styles.statusFailed,
            status === 'cancelled' && styles.statusCancelled,
            status === 'processing' && styles.statusProcessing,
            status === 'pending' && styles.statusPending,
          ]}
        >
          <Text style={styles.statusText}>{statusLabel(status)}</Text>
        </View>
      </View>

      {/* Progress bar */}
      {!isTerminal && (
        <View style={styles.progressContainer}>
          <Text style={styles.progressLabel}>Progress: {progress}%</Text>
          <View style={styles.progressBarBackground}>
            <View style={[styles.progressBarFill, { width: `${progress}%` }]} />
          </View>
        </View>
      )}

      {/* Loading indicator */}
      {loading && (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color="#007AFF" />
          <Text style={styles.loadingText}>Fetching status...</Text>
        </View>
      )}

      {/* Error display */}
      {error && (
        <View style={styles.errorContainer}>
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity style={styles.retryFetchButton} onPress={startPolling}>
            <Text style={styles.retryFetchButtonText}>Retry Fetch</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Transaction details (if available) */}
      {transaction && (
        <View style={styles.detailsContainer}>
          <Text style={styles.detailsTitle}>Details</Text>
          <Text>Created: {new Date(transaction.createdAt).toLocaleString()}</Text>
          <Text>Updated: {new Date(transaction.updatedAt).toLocaleString()}</Text>
          {transaction.assetAmount && (
            <Text>Amount: {transaction.assetAmount} {transaction.assetType ?? ''}</Text>
          )}
          {transaction.destinationAddress && (
            <Text>Destination: {transaction.destinationAddress}</Text>
          )}
          {transaction.errorMessage && (
            <Text style={styles.errorText}>Error: {transaction.errorMessage}</Text>
          )}
        </View>
      )}

      {/* Action buttons */}
      <View style={styles.actionsContainer}>
        {showCancel && (
          <TouchableOpacity
            style={[styles.actionButton, styles.cancelButton]}
            onPress={handleCancel}
          >
            <Text style={styles.actionButtonText}>Cancel Transaction</Text>
          </TouchableOpacity>
        )}
        {showRetry && (
          <TouchableOpacity
            style={[styles.actionButton, styles.retryButton]}
            onPress={handleRetry}
          >
            <Text style={styles.actionButtonText}>Retry Transaction</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Confirm Dialog */}
      <ConfirmDialog
        visible={confirmDialogVisible}
        title={confirmAction === 'cancel' ? 'Cancel Transaction' : 'Retry Transaction'}
        message={
          confirmAction === 'cancel'
            ? 'Are you sure you want to cancel this transaction? This action cannot be undone.'
            : 'Are you sure you want to retry this transaction?'
        }
        confirmLabel={confirmAction === 'cancel' ? 'Yes, Cancel' : 'Yes, Retry'}
        onConfirm={executeAction}
        onCancel={() => setConfirmDialogVisible(false)}
        loading={actionLoading}
      />
    </ScrollView>
  );
};

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------
const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F5F5F5',
  },
  contentContainer: {
    padding: 16,
  },
  backButton: {
    marginBottom: 12,
  },
  backButtonText: {
    fontSize: 16,
    color: '#007AFF',
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 4,
    color: '#333',
  },
  transactionId: {
    fontSize: 14,
    color: '#666',
    marginBottom: 16,
  },
  statusContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 16,
  },
  statusLabel: {
    fontSize: 16,
    fontWeight: '500',
    color: '#333',
    marginRight: 8,
  },
  statusBadge: {
    paddingVertical: 4,
    paddingHorizontal: 12,
    borderRadius: 12,
  },
  statusCompleted: {
    backgroundColor: '#4CAF50',
  },
  statusFailed: {
    backgroundColor: '#F44336',
  },
  statusCancelled: {
    backgroundColor: '#FF9800',
  },
  statusProcessing: {
    backgroundColor: '#2196F3',
  },
  statusPending: {
    backgroundColor: '#9E9E9E',
  },
  statusText: {
    color: '#fff',
    fontWeight: '600',
    fontSize: 14,
  },
  progressContainer: {
    marginBottom: 16,
  },
  progressLabel: {
    fontSize: 14,
    color: '#333',
    marginBottom: 4,
  },
  progressBarBackground: {
    height: 8,
    backgroundColor: '#E0E0E0',
    borderRadius: 4,
    overflow: 'hidden',
  },
  progressBarFill: {
    height: '100%',
    backgroundColor: '#007AFF',
    borderRadius: 4,
  },
  loadingContainer: {
    alignItems: 'center',
    marginVertical: 16,
  },
  loadingText: {
    marginTop: 8,
    color: '#666',
  },
  errorContainer: {
    backgroundColor: '#FFEBEE',
    padding: 12,
    borderRadius: 8,
    marginVertical: 8,
    alignItems: 'center',
  },
  errorText: {
    color: '#D32F2F',
    fontSize: 14,
    marginBottom: 8,
  },
  retryFetchButton: {
    paddingVertical: 6,
    paddingHorizontal: 16,
    backgroundColor: '#D32F2F',
    borderRadius: 4,
  },
  retryFetchButtonText: {
    color: '#fff',
    fontWeight: '600',
  },
  detailsContainer: {
    backgroundColor: '#fff',
    padding: 12,
    borderRadius: 8,
    marginVertical: 8,
  },
  detailsTitle: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 8,
    color: '#333',
  },
  actionsContainer: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    marginVertical: 16,
  },
  actionButton: {
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 8,
    minWidth: 140,
    alignItems: 'center',
  },
  cancelButton: {
    backgroundColor: '#FF9800',
  },
  retryButton: {
    backgroundColor: '#2196F3',
  },
  actionButtonText: {
    color: '#fff',
    fontWeight: '600',
    fontSize: 16,
  },
  // Modal styles
  modalOverlay: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
  },
  modalContainer: {
    width: '80%',
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 20,
    elevation: 5,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 8,
    color: '#333',
  },
  modalMessage: {
    fontSize: 14,
    color: '#666',
    marginBottom: 20,
  },
  modalActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
  },
  modalButton: {
    paddingVertical: 10,
    paddingHorizontal: 20,
    borderRadius: 8,
    marginLeft: 12,
  },
  modalCancelButton: {
    backgroundColor: '#E0E0E0',
  },
  modalConfirmButton: {
    backgroundColor: '#007AFF',
  },
  modalButtonText: {
    color: '#fff',
    fontWeight: '600',
  },
});

export default TransactionScreen;