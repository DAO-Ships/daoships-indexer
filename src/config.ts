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

// ── Fetch mode (unfiltered topic0 scaling) ───────────────────────
// `scoped`     — every topic goes through the address-chunked getLogs
//                path. Safe; caps DAO count at ~1000 before RPC budget is
//                exhausted (see docs/PERF_BATCH_DB_ROUNDTRIPS.md §0.3).
// `unfiltered` — every topic is fetched chain-wide by topic0 and
//                filtered in-process. Lowest RPC cost but requires
//                byte/count caps (U1/U6) to guard against response-size
//                DoS on collision-prone topics (Transfer, Paused, etc.).
// `hybrid`     — each handler's registration decides via the
//                `unfiltered` flag on `registerHandler`. Default.
const VALID_FETCH_MODES = ['scoped', 'unfiltered', 'hybrid'] as const;
type FetchMode = typeof VALID_FETCH_MODES[number];

function validateFetchMode(value: string): FetchMode {
  if (!VALID_FETCH_MODES.includes(value as FetchMode)) {
    throw new Error(`Invalid FETCH_MODE "${value}". Valid modes: ${VALID_FETCH_MODES.join(', ')}`);
  }
  return value as FetchMode;
}

function validateTopicHashList(raw: string): string[] {
  if (!raw.trim()) return [];
  const hashes = raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  for (const h of hashes) {
    if (!/^0x[0-9a-f]{64}$/.test(h)) {
      throw new Error(`Invalid topic0 hash in UNFILTERED_TOPICS: "${h}" (expected 0x + 64 hex chars)`);
    }
  }
  return hashes;
}

// Mirrors the whitelist in supabase/migrations/schema.sql create_ds_schema().
// Prevents a misconfigured env from pointing at an arbitrary schema (including
// system schemas like pg_catalog) or cross-writing dev data into mainnet.
const VALID_SCHEMAS = ['testnet', 'mainnet', 'dev', 'public'] as const;

function validateSupabaseSchema(value: string): string {
  if (!VALID_SCHEMAS.includes(value as typeof VALID_SCHEMAS[number])) {
    throw new Error(`Invalid SUPABASE_SCHEMA "${value}". Valid schemas: ${VALID_SCHEMAS.join(', ')}`);
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

/**
 * Navigator types that hold NO on-chain permission and are NEVER registered via
 * `setNavigators()` (so they emit no `NavigatorSet`). They are discovered and
 * DAO-bound from `NavigatorDeployed` alone, and their DAO association is
 * self-asserted until endorsed by a vault `daoships.dao.navigators` post.
 *
 * IMPORTANT: keep this in sync with the hard-coded `navigator_type NOT IN (...)`
 * list in `ds_prune_orphaned_navigators` (supabase/migrations/schema.sql) — both
 * must agree on which types are read-only so neither path ever prunes them.
 */
export const READ_ONLY_NAVIGATOR_TYPES: ReadonlySet<string> = new Set(['SignalNavigator']);

/**
 * Navigator types that hold NO DAOShip permission (so emit no `NavigatorSet`) AND are NOT
 * read-only — their authority is being an enabled Zodiac MODULE on the DAO's vault. Trust is
 * driven by the vault's authenticated `EnabledModule`/`DisabledModule` events (NOT by
 * NavigatorSet and NOT by the read-only Poster `daoships.dao.navigators` sanction path).
 *
 * They are born `self_asserted` + `is_active=false` at `NavigatorDeployed` and only become
 * `sanctioned` + `is_active=true` once the vault emits `EnabledModule`. Like read-only
 * navigators their events defer-and-backfill (materialize only while sanctioned), but the
 * sanctioning signal is different — see src/handlers/vault-modules.ts.
 *
 * IMPORTANT: keep this in sync with the per-type prune branches in `ds_prune_orphaned_navigators`
 * (supabase/migrations/schema.sql). A module navigator never gets a permission grant, so it is NOT
 * reaped on the plain permission_ever_granted=false path; it is reaped ONLY when its self-asserted
 * DAO never materialized (no real vault can enable it) AND it has no vault-module feed events — a
 * pending budget nav against a real, launched DAO is kept (it does not self-heal after prune).
 */
export const MODULE_NAVIGATOR_TYPES: ReadonlySet<string> = new Set(['BudgetNavigator']);

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
  supabaseSchema: validateSupabaseSchema(process.env.SUPABASE_SCHEMA || 'public'),

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

  // Orphan record pruning (navigator.allowlist records with no DAO)
  orphanRetentionDays: parseIntWithBounds(process.env.ORPHAN_RETENTION_DAYS, 90, 7, 365, 'ORPHAN_RETENTION_DAYS'),

  // Logging
  logLevel: validateLogLevel(process.env.LOG_LEVEL || 'info'),

  // Health check
  health: {
    enabled: process.env.HEALTH_CHECK_ENABLED !== 'false',
    host: process.env.HEALTH_CHECK_HOST || '0.0.0.0',
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

  // Fetch strategy (unfiltered topic0 scaling — docs/PERF_BATCH_DB_ROUNDTRIPS.md)
  fetch: {
    mode: validateFetchMode(process.env.FETCH_MODE || 'hybrid'),
    // Per-topic override: force-flip these topic0 hashes to unfiltered
    // regardless of the handler's `unfiltered` registration flag. Empty = no
    // overrides.
    unfilteredTopics: validateTopicHashList(process.env.UNFILTERED_TOPICS || ''),
    // U1 — hard cap on the raw log count returned by a single getLogs call.
    // On breach the blockchain layer throws a transient oversize error and
    // the processor bisects the block range. Calibrated against the
    // bench-filter budget (≤100k logs = ≤500 ms filter, ≤200 MB heap).
    maxLogsPerCall: parseIntWithBounds(process.env.FETCH_MAX_LOGS_PER_CALL, 100000, 1000, 10_000_000, 'FETCH_MAX_LOGS_PER_CALL'),
    // U1 — hard cap on approximate response bytes (topics × 32 + data / 2).
    // 50 MB = ~1.5k events of modest size; protects against OOM on chains
    // with cheap large-data events.
    maxBytesPerCall: parseIntWithBounds(process.env.FETCH_MAX_BYTES_PER_CALL, 50 * 1024 * 1024, 1024 * 1024, 1024 * 1024 * 1024, 'FETCH_MAX_BYTES_PER_CALL'),
    // Minimum block range the bisect loop will attempt before giving up.
    // Setting to 1 means we'll bisect all the way to a single block before
    // surfacing the oversize as a hard error.
    minBisectRange: parseIntWithBounds(process.env.FETCH_MIN_BISECT_RANGE, 1, 1, 100, 'FETCH_MIN_BISECT_RANGE'),
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
