import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Prevent dotenv from loading .env file during config tests
vi.mock('dotenv/config', () => ({}));

// Save original env so we can restore after each test
const originalEnv = { ...process.env };

function setRequiredEnv(): void {
  process.env.SUPABASE_URL = 'https://test.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
}

/** Delete all env vars that config.ts reads */
function clearConfigEnvVars(): void {
  const configKeys = [
    'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SCHEMA',
    'RPC_URL', 'CHAIN_ID',
    'POLL_INTERVAL_MS', 'MAX_BLOCK_RANGE', 'CONFIRMATION_BLOCKS', 'START_BLOCK',
    'LOG_LEVEL', 'LOG_DIR',
    'HEALTH_CHECK_ENABLED', 'HEALTH_CHECK_PORT', 'HEALTH_MAX_BLOCKS_BEHIND',
    'RATE_LIMIT_REQUESTS', 'RATE_LIMIT_WINDOW_MS',
    'TIMESTAMP_CACHE_SIZE',
    'RETRY_MAX_RETRIES', 'RETRY_BASE_DELAY_MS', 'RETRY_MAX_DELAY_MS', 'RETRY_ERROR_THRESHOLD',
    'DAOSHIP_AND_VAULT_LAUNCHER', 'DAOSHIP_LAUNCHER', 'POSTER',
  ];
  for (const key of configKeys) {
    delete process.env[key];
  }
}

async function loadConfig() {
  const mod = await import('../../src/config.js');
  return mod.config;
}

describe('config', () => {
  beforeEach(() => {
    vi.resetModules();
    clearConfigEnvVars();
  });

  afterEach(() => {
    clearConfigEnvVars();
    Object.assign(process.env, originalEnv);
  });

  // ── Required env vars ──────────────────────────────────────────

  it('throws when SUPABASE_URL is missing', async () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
    await expect(loadConfig()).rejects.toThrow('Missing required environment variable: SUPABASE_URL');
  });

  it('throws when SUPABASE_SERVICE_ROLE_KEY is missing', async () => {
    process.env.SUPABASE_URL = 'https://test.supabase.co';
    await expect(loadConfig()).rejects.toThrow('Missing required environment variable: SUPABASE_SERVICE_ROLE_KEY');
  });

  // ── Defaults ───────────────────────────────────────────────────

  it('uses sensible defaults when optional env vars are absent', async () => {
    setRequiredEnv();
    const config = await loadConfig();

    expect(config.pollIntervalMs).toBe(5000);
    expect(config.maxBlockRange).toBe(500);
    expect(config.confirmationBlocks).toBe(3);
    expect(config.startBlock).toBe(0);
    expect(config.logLevel).toBe('info');
    expect(config.health.enabled).toBe(true);
    expect(config.health.port).toBe(8080);
    expect(config.health.maxBlocksBehind).toBe(100);
    expect(config.rateLimit.requestsPerWindow).toBe(50);
    expect(config.rateLimit.windowMs).toBe(1000);
    expect(config.cache.timestampCacheSize).toBe(1000);
    expect(config.retry.maxRetries).toBe(5);
    expect(config.retry.baseDelayMs).toBe(1000);
    expect(config.retry.maxDelayMs).toBe(60000);
    expect(config.retry.errorThreshold).toBe(3);
    expect(config.supabaseSchema).toBe('public');
  });

  // ── Bounds validation ──────────────────────────────────────────

  it('rejects POLL_INTERVAL_MS below minimum', async () => {
    setRequiredEnv();
    process.env.POLL_INTERVAL_MS = '500';
    await expect(loadConfig()).rejects.toThrow('outside range [1000, 60000]');
  });

  it('rejects POLL_INTERVAL_MS above maximum', async () => {
    setRequiredEnv();
    process.env.POLL_INTERVAL_MS = '100000';
    await expect(loadConfig()).rejects.toThrow('outside range [1000, 60000]');
  });

  it('rejects MAX_BLOCK_RANGE below minimum', async () => {
    setRequiredEnv();
    process.env.MAX_BLOCK_RANGE = '5';
    await expect(loadConfig()).rejects.toThrow('outside range [10, 10000]');
  });

  it('rejects non-numeric bounded values', async () => {
    setRequiredEnv();
    process.env.POLL_INTERVAL_MS = 'not-a-number';
    await expect(loadConfig()).rejects.toThrow('expected integer');
  });

  it('accepts valid bounded values', async () => {
    setRequiredEnv();
    process.env.POLL_INTERVAL_MS = '2000';
    process.env.MAX_BLOCK_RANGE = '1000';
    process.env.CONFIRMATION_BLOCKS = '5';
    const config = await loadConfig();

    expect(config.pollIntervalMs).toBe(2000);
    expect(config.maxBlockRange).toBe(1000);
    expect(config.confirmationBlocks).toBe(5);
  });

  // ── Custom env var values ──────────────────────────────────────

  it('reads custom RPC_URL', async () => {
    setRequiredEnv();
    process.env.RPC_URL = 'https://custom-rpc.example.com';
    const config = await loadConfig();
    expect(config.rpcUrl).toBe('https://custom-rpc.example.com');
  });

  it('reads custom SUPABASE_SCHEMA', async () => {
    setRequiredEnv();
    process.env.SUPABASE_SCHEMA = 'testnet';
    const config = await loadConfig();
    expect(config.supabaseSchema).toBe('testnet');
  });

  it('lowercases contract addresses', async () => {
    setRequiredEnv();
    // Must be a valid Quai address (Cyprus1 shard prefix 0x00)
    process.env.DAOSHIP_AND_VAULT_LAUNCHER = '0x00026AfF6745B459fdF79790e9B43619c6856464';
    const config = await loadConfig();
    expect(config.contracts.daoShipAndVaultLauncher).toBe(
      '0x00026aff6745b459fdf79790e9b43619c6856464',
    );
  });

  it('disables health check when HEALTH_CHECK_ENABLED=false', async () => {
    setRequiredEnv();
    process.env.HEALTH_CHECK_ENABLED = 'false';
    const config = await loadConfig();
    expect(config.health.enabled).toBe(false);
  });

  // ── Deep freeze ────────────────────────────────────────────────

  it('config object is deeply frozen', async () => {
    setRequiredEnv();
    const config = await loadConfig();

    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.contracts)).toBe(true);
    expect(Object.isFrozen(config.health)).toBe(true);
    expect(Object.isFrozen(config.rateLimit)).toBe(true);
    expect(Object.isFrozen(config.cache)).toBe(true);
    expect(Object.isFrozen(config.retry)).toBe(true);
  });

  it('throws on mutation attempt', async () => {
    setRequiredEnv();
    const config = await loadConfig();

    expect(() => {
      (config as any).pollIntervalMs = 9999;
    }).toThrow();
  });
});
