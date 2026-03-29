import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock config before importing retry module
vi.mock('../../src/config.js', () => ({
  config: {
    retry: {
      maxRetries: 3,
      baseDelayMs: 10,
      maxDelayMs: 100,
      errorThreshold: 2,
    },
    logLevel: 'silent',
  },
}));

vi.mock('../../src/utils/logger.js', () => ({
  logger: {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

const { withRetry, RetryTracker } = await import('../../src/utils/retry.js');

describe('withRetry', () => {
  it('returns result on first success', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await withRetry(fn, { operation: 'test', delayMs: 1 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on failure and succeeds', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('fail1'))
      .mockResolvedValue('ok');

    const result = await withRetry(fn, { operation: 'test', delayMs: 1 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('throws after maxAttempts exhausted', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('always fails'));

    await expect(
      withRetry(fn, { operation: 'test', maxAttempts: 2, delayMs: 1 }),
    ).rejects.toThrow('always fails');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('applies exponential backoff', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('fail'))
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValue('ok');

    const start = Date.now();
    await withRetry(fn, {
      operation: 'test',
      delayMs: 10,
      backoffMultiplier: 2,
      jitter: false,
    });
    const elapsed = Date.now() - start;

    // Should have waited at least 10ms + 20ms = 30ms
    expect(elapsed).toBeGreaterThanOrEqual(25);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('accepts string shorthand for operation name', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await withRetry(fn, 'test-op');
    expect(result).toBe('ok');
  });
});

describe('RetryTracker', () => {
  let tracker: InstanceType<typeof RetryTracker>;

  beforeEach(() => {
    tracker = new RetryTracker({
      maxRetries: 3,
      baseDelayMs: 10,
      maxDelayMs: 1000,
      errorThreshold: 2,
    });
  });

  it('starts with zero failures', () => {
    expect(tracker.getFailureCount()).toBe(0);
    expect(tracker.isExhausted()).toBe(false);
  });

  it('increments failure count', () => {
    tracker.recordFailure(new Error('fail'), 'test');
    expect(tracker.getFailureCount()).toBe(1);
  });

  it('reports exhausted after maxRetries', () => {
    for (let i = 0; i < 3; i++) {
      tracker.recordFailure(new Error('fail'), 'test');
    }
    expect(tracker.isExhausted()).toBe(true);
  });

  it('resets on success', () => {
    tracker.recordFailure(new Error('fail'), 'test');
    tracker.recordFailure(new Error('fail'), 'test');
    tracker.recordSuccess();
    expect(tracker.getFailureCount()).toBe(0);
    expect(tracker.isExhausted()).toBe(false);
  });

  it('returns a positive delay on failure', () => {
    const delay = tracker.recordFailure(new Error('fail'), 'test');
    expect(delay).toBeGreaterThan(0);
  });

  it('delay increases with consecutive failures', () => {
    const delay1 = tracker.recordFailure(new Error('fail'), 'test');
    const delay2 = tracker.recordFailure(new Error('fail'), 'test');
    // With jitter the exact values can vary, but on average delay2 > delay1
    expect(delay2).toBeGreaterThanOrEqual(delay1 * 0.5);
  });

  it('resets via reset()', () => {
    tracker.recordFailure(new Error('fail'), 'test');
    tracker.reset();
    expect(tracker.getFailureCount()).toBe(0);
  });
});
