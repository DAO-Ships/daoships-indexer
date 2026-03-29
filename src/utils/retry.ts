import { config } from '../config.js';
import { logger } from './logger.js';

export interface RetryOptions {
  maxAttempts?: number;
  delayMs?: number;
  backoffMultiplier?: number;
  maxDelayMs?: number;
  jitter?: boolean;
  operation?: string;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions | string = {},
): Promise<T> {
  // Accept string as shorthand for operation name (backwards compat)
  const opts = typeof options === 'string' ? { operation: options } : options;
  const {
    // M23: config.retry.maxRetries is "number of retries", so total attempts = maxRetries + 1.
    // This makes withRetry semantics consistent with RetryTracker.maxRetries.
    maxAttempts = config.retry.maxRetries + 1,
    delayMs = config.retry.baseDelayMs,
    backoffMultiplier = 2,
    maxDelayMs = config.retry.maxDelayMs,
    jitter = true,
    operation = 'operation',
  } = opts;

  let lastError: Error | undefined;
  let currentDelay = delayMs;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;

      if (attempt === maxAttempts) break;

      // M22: Jitter range 0.5-1.0x (50% variance) for better thundering herd prevention
      const jitteredDelay = jitter
        ? currentDelay * (0.5 + Math.random() * 0.5)
        : currentDelay;

      logger.warn(
        {
          operation,
          attempt,
          maxAttempts,
          nextRetryMs: Math.round(jitteredDelay),
          error: lastError.message,
        },
        'Retrying after error',
      );

      await sleep(jitteredDelay);
      currentDelay = Math.min(currentDelay * backoffMultiplier, maxDelayMs);
    }
  }

  throw lastError;
}

/**
 * Retry state tracker for continuous polling loops.
 * Tracks consecutive failures and provides appropriate delays.
 */
export class RetryTracker {
  private consecutiveFailures = 0;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly errorThreshold: number;

  constructor(options: {
    maxRetries?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    errorThreshold?: number;
  } = {}) {
    this.maxRetries = options.maxRetries ?? config.retry.maxRetries;
    this.baseDelayMs = options.baseDelayMs ?? config.retry.baseDelayMs;
    this.maxDelayMs = options.maxDelayMs ?? config.retry.maxDelayMs;
    this.errorThreshold = options.errorThreshold ?? config.retry.errorThreshold;
  }

  recordSuccess(): void {
    if (this.consecutiveFailures > 0) {
      logger.info(
        { previousFailures: this.consecutiveFailures },
        'Recovered after consecutive failures',
      );
    }
    this.consecutiveFailures = 0;
  }

  recordFailure(error: Error, operation: string): number {
    this.consecutiveFailures++;
    const delay = this.getBackoffDelay();

    const logData = {
      operation,
      consecutiveFailures: this.consecutiveFailures,
      nextRetryMs: delay,
      error: error.message,
    };

    if (this.consecutiveFailures >= this.errorThreshold) {
      logger.error(logData, 'Repeated failures - may need intervention');
    } else {
      logger.warn(logData, 'Operation failed, will retry');
    }

    return delay;
  }

  isExhausted(): boolean {
    return this.consecutiveFailures >= this.maxRetries;
  }

  getFailureCount(): number {
    return this.consecutiveFailures;
  }

  private getBackoffDelay(): number {
    const exponentialDelay = this.baseDelayMs * Math.pow(2, this.consecutiveFailures - 1);
    const cappedDelay = Math.min(exponentialDelay, this.maxDelayMs);
    // M22: Jitter range 0.5-1.0x (50% variance) for better thundering herd prevention
    return Math.round(cappedDelay * (0.5 + Math.random() * 0.5));
  }

  reset(): void {
    this.consecutiveFailures = 0;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
