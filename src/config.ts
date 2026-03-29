import 'dotenv/config';
import { isValidAddress } from './utils/validation.js';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function parseIntWithBounds(
  value: string | undefined,
  defaultValue: number,
  min: number,
  max: number,
  name: string,
): number {
  const parsed = parseInt(value || String(defaultValue), 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid ${name}: expected integer, got "${value}"`);
  }
  if (parsed < min || parsed > max) {
    throw new Error(`Invalid ${name}: ${parsed} outside range [${min}, ${max}]`);
  }
  return parsed;
}

function validateAddress(value: string, name: string): string {
  const lower = value.toLowerCase();
  if (!isValidAddress(lower)) {
    throw new Error(`Invalid ${name}: "${value}" is not a valid Quai address`);
  }
  return lower;
}

const VALID_LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

function validateLogLevel(value: string): string {
  if (!VALID_LOG_LEVELS.includes(value as typeof VALID_LOG_LEVELS[number])) {
    throw new Error(`Invalid LOG_LEVEL "${value}". Valid levels: ${VALID_LOG_LEVELS.join(', ')}`);
  }
  return value;
}

function validateCorsOrigins(raw: string): string[] {
  const origins = raw.split(',').map(s => s.trim()).filter(Boolean);
  for (const origin of origins) {
    if (!origin.startsWith('http://') && !origin.startsWith('https://')) {
      throw new Error(`Invalid CORS origin "${origin}": must start with http:// or https://`);
    }
  }
  return origins;
}

export const config = {
  // Quai Network
  rpcUrl: process.env.RPC_URL || 'https://rpc.orchard.quai.network',
  chainId: parseIntWithBounds(process.env.CHAIN_ID, 15000, 1, 2147483647, 'CHAIN_ID'),

  // Polling
  pollIntervalMs: parseIntWithBounds(process.env.POLL_INTERVAL_MS, 5000, 1000, 60000, 'POLL_INTERVAL_MS'),
  maxBlockRange: parseIntWithBounds(process.env.MAX_BLOCK_RANGE, 500, 10, 10000, 'MAX_BLOCK_RANGE'),
  confirmationBlocks: parseIntWithBounds(process.env.CONFIRMATION_BLOCKS, 3, 0, 100, 'CONFIRMATION_BLOCKS'),

  // Supabase
  supabaseUrl: requireEnv('SUPABASE_URL'),
  supabaseServiceRoleKey: requireEnv('SUPABASE_SERVICE_ROLE_KEY'),
  supabaseSchema: process.env.SUPABASE_SCHEMA || 'public',

  // Contract Addresses (validated + lowercase)
  contracts: {
    daoShipAndVaultLauncher: validateAddress(process.env.DAOSHIP_AND_VAULT_LAUNCHER || '0x000C1a179eDcc61cfFA099649f16e3c1F9cF5642', 'DAOSHIP_AND_VAULT_LAUNCHER'),
    daoShipLauncher: validateAddress(process.env.DAOSHIP_LAUNCHER || '0x00027146063E11792cfE69c14621A0B4f244a78D', 'DAOSHIP_LAUNCHER'),
    poster: validateAddress(process.env.POSTER || '0x004aC3218Df2dA55a16d039834bBffD080EcEC28', 'POSTER'),
    // Navigator addresses are per-DAO — discovered dynamically via NavigatorSet events.
    // No static config needed.
  },

  // Start block (block where contracts were first deployed)
  startBlock: parseIntWithBounds(process.env.START_BLOCK, 0, 0, Number.MAX_SAFE_INTEGER, 'START_BLOCK'),

  // Reorg detection
  reorgWalkBack: parseIntWithBounds(process.env.REORG_WALK_BACK, 10, 1, 1000, 'REORG_WALK_BACK'),

  // Logging
  logLevel: validateLogLevel(process.env.LOG_LEVEL || 'info'),

  // Health check
  health: {
    enabled: process.env.HEALTH_CHECK_ENABLED !== 'false',
    port: parseIntWithBounds(process.env.HEALTH_CHECK_PORT, 8080, 1, 65535, 'HEALTH_CHECK_PORT'),
    maxBlocksBehind: parseIntWithBounds(process.env.HEALTH_MAX_BLOCKS_BEHIND, 100, 1, 10000, 'HEALTH_MAX_BLOCKS_BEHIND'),
    checkTimeoutMs: parseIntWithBounds(process.env.HEALTH_CHECK_TIMEOUT_MS, 10000, 1000, 60000, 'HEALTH_CHECK_TIMEOUT_MS'),
    corsOrigins: validateCorsOrigins(
      process.env.CORS_ALLOWED_ORIGINS || 'http://localhost:5173,https://testnet.daoships.quaidao.org,https://daoships.quaidao.org',
    ),
    // Only trust x-forwarded-for when running behind a known reverse proxy.
    // Default false to prevent IP spoofing in rate limiting.
    trustProxy: process.env.HEALTH_TRUST_PROXY === 'true',
  },

  // RPC rate limiting
  rateLimit: {
    requestsPerWindow: parseIntWithBounds(process.env.RATE_LIMIT_REQUESTS, 50, 1, 1000, 'RATE_LIMIT_REQUESTS'),
    windowMs: parseIntWithBounds(process.env.RATE_LIMIT_WINDOW_MS, 1000, 100, 60000, 'RATE_LIMIT_WINDOW_MS'),
  },

  // Caching
  cache: {
    timestampCacheSize: parseIntWithBounds(process.env.TIMESTAMP_CACHE_SIZE, 1000, 10, 100000, 'TIMESTAMP_CACHE_SIZE'),
  },

  // Retry settings
  retry: {
    maxRetries: parseIntWithBounds(process.env.RETRY_MAX_RETRIES, 5, 1, 20, 'RETRY_MAX_RETRIES'),
    baseDelayMs: parseIntWithBounds(process.env.RETRY_BASE_DELAY_MS, 1000, 100, 30000, 'RETRY_BASE_DELAY_MS'),
    maxDelayMs: parseIntWithBounds(process.env.RETRY_MAX_DELAY_MS, 60000, 1000, 300000, 'RETRY_MAX_DELAY_MS'),
    errorThreshold: parseIntWithBounds(process.env.RETRY_ERROR_THRESHOLD, 3, 1, 10, 'RETRY_ERROR_THRESHOLD'),
  },
};

// Cross-field validation
if (config.retry.baseDelayMs > config.retry.maxDelayMs) {
  throw new Error(
    `RETRY_BASE_DELAY_MS (${config.retry.baseDelayMs}) must be <= RETRY_MAX_DELAY_MS (${config.retry.maxDelayMs})`,
  );
}

// Make supabaseServiceRoleKey non-enumerable before freezing so it is not
// exposed by JSON.stringify(config) or Object.keys(config).
Object.defineProperty(config, 'supabaseServiceRoleKey', {
  value: config.supabaseServiceRoleKey,
  writable: false,
  enumerable: false,
  configurable: false,
});

// Deep freeze config to prevent accidental runtime mutations
function deepFreeze<T extends object>(obj: T): T {
  Object.freeze(obj);
  for (const value of Object.values(obj)) {
    if (value && typeof value === 'object') {
      deepFreeze(value);
    }
  }
  return obj;
}
deepFreeze(config);
