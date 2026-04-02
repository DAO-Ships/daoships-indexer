import { Interface, Indexed, id as keccak256 } from 'quais';
import type { EventContext } from './index.js';
import { logger } from '../utils/logger.js';
import { makeMemberId } from '../utils/addresses.js';
import { validateEventArgs, validateAndNormalizeAddress } from '../utils/validation.js';

import PosterAbi from '../abis/Poster.json' with { type: 'json' };

export const posterIface = new Interface(PosterAbi);

// ── Trust Model ─────────────────────────────────────────────────

type TrustLevel = 'VERIFIED' | 'VERIFIED_INITIAL' | 'SEMI_TRUSTED' | 'ON_CHAIN_PROVISIONAL' | 'MEMBER' | 'UNTRUSTED';

/** Trust level hierarchy for minimum-trust comparisons */
const TRUST_RANK: Record<TrustLevel, number> = {
  UNTRUSTED: 0,
  MEMBER: 1,
  ON_CHAIN_PROVISIONAL: 2,
  SEMI_TRUSTED: 3,
  VERIFIED_INITIAL: 4,
  VERIFIED: 5,
};

function meetsMinTrust(actual: TrustLevel, required: TrustLevel): boolean {
  return TRUST_RANK[actual] >= TRUST_RANK[required];
}

async function determineTrustLevel(
  ctx: EventContext,
  user: string,
  daoId: string,
  tag: string,
): Promise<{ trust: TrustLevel; dao: Awaited<ReturnType<typeof ctx.db.getDao>> }> {
  const dao = await ctx.db.getDao(daoId);
  if (!dao) return { trust: 'UNTRUSTED', dao: null };
  if (user === dao.avatar) return { trust: 'VERIFIED', dao };
  if (user === dao.launcher && tag === 'daoships.dao.profile.initial') return { trust: 'VERIFIED_INITIAL', dao };
  if (user === dao.id) return { trust: 'VERIFIED', dao };
  const navigatorDaoId = ctx.registry.getDaoByNavigatorAddress(user);
  if (navigatorDaoId === daoId) return { trust: 'SEMI_TRUSTED', dao };
  const member = await ctx.db.getMember(makeMemberId(daoId, user));
  if (member && BigInt(member.shares || '0') > 0n) return { trust: 'MEMBER', dao };
  return { trust: 'UNTRUSTED', dao };
}

// ── Known Tag Hash Map ──────────────────────────────────────────
// Indexed strings in Solidity logs emit only their keccak256 hash as the
// topic value. We precompute the hashes for the tags we care about so we
// can reverse-map to human-readable tag names at runtime.

interface TagDefinition {
  tag: string;
  minTrust: TrustLevel;
  updatesDao: boolean;
}

const KNOWN_TAGS: Record<string, TagDefinition> = {};

const TAG_DEFINITIONS: TagDefinition[] = [
  { tag: 'daoships.dao.profile.initial', minTrust: 'VERIFIED_INITIAL', updatesDao: true },
  { tag: 'daoships.dao.profile', minTrust: 'VERIFIED', updatesDao: true },
  { tag: 'daoships.dao.announcement', minTrust: 'VERIFIED', updatesDao: false },
  { tag: 'daoships.member.profile', minTrust: 'MEMBER', updatesDao: false },
  { tag: 'daoships.proposal.vote.reason', minTrust: 'MEMBER', updatesDao: false },
  { tag: 'daoships.navigator.allowlist', minTrust: 'MEMBER', updatesDao: false },
];

for (const def of TAG_DEFINITIONS) {
  KNOWN_TAGS[keccak256(def.tag)] = def;
}

const TAG_VALIDATORS: Record<string, ContentValidator> = {
  'daoships.dao.profile.initial': validateDaoProfileInitial,
  'daoships.dao.profile': validateDaoProfile,
  'daoships.dao.announcement': validateDaoAnnouncement,
  'daoships.member.profile': validateMemberProfile,
  'daoships.proposal.vote.reason': validateVoteReason,
  'daoships.navigator.allowlist': validateNavigatorAllowlist,
};

// ── Helpers ─────────────────────────────────────────────────────

function isValidUrl(url: string): boolean {
  return url.startsWith('http://') || url.startsWith('https://') || url.startsWith('ipfs://');
}

// ── Schema Validation Helpers ───────────────────────────────────

/** Strip null bytes + C0/C1 control chars (except tab/newline/CR), truncate. */
function str(v: unknown, maxLen: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  let s = v.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, '');
  s = s.slice(0, maxLen);
  return s.length > 0 ? s : undefined;
}

function urlStr(v: unknown, maxLen: number): string | undefined {
  const s = str(v, maxLen);
  return s && isValidUrl(s) ? s : undefined;
}

function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'bigint') return Number(v);
  return undefined;
}

function bool(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v;
  return undefined;
}

function strArray(v: unknown, maxItems: number, maxItemLen: number): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const result = v.slice(0, maxItems)
    .map(item => str(item, maxItemLen))
    .filter((s): s is string => s !== undefined);
  return result.length > 0 ? result : undefined;
}

const BLOCKED_KEYS = new Set(['__proto__', 'constructor', 'prototype', 'toString', 'valueOf', 'hasOwnProperty']);

/** Recursively sanitize JSONB objects: strip prototype-pollution keys and cap depth. */
function sanitizeJsonb(obj: unknown, maxDepth = 5, depth = 0): unknown {
  if (depth > maxDepth) return null;
  if (typeof obj !== 'object' || obj === null) return obj;
  if (Array.isArray(obj)) return obj.map(v => sanitizeJsonb(v, maxDepth, depth + 1));
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (BLOCKED_KEYS.has(k)) continue;
    result[k] = sanitizeJsonb(v, maxDepth, depth + 1);
  }
  return result;
}
const KEY_PATTERN = /^[a-zA-Z0-9_-]+$/;

function linksObj(v: unknown, maxUrlLen: number): Record<string, string> | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const obj = v as Record<string, unknown>;
  const result: Record<string, string> = {};
  let count = 0;
  for (const key of Object.keys(obj)) {
    if (count >= 20) break;
    if (key.length > 50 || !KEY_PATTERN.test(key) || BLOCKED_KEYS.has(key)) continue;
    const url = urlStr(obj[key], maxUrlLen);
    if (url) {
      result[key] = url;
      count++;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/** Strip undefined values from result object for compact JSONB. Preserves null (for merge semantics). */
function clean(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(obj)) {
    if (val !== undefined) result[key] = val;
  }
  return Object.keys(result).length > 0 ? result : {};
}

const ETH_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;

// ── On-Chain Verification for Pre-DAO Allowlist Posts ───────────

const ALLOWLIST_ROOT_SELECTOR = keccak256('allowlistRoot()').slice(0, 10);
const DAOSHIP_SELECTOR = keccak256('daoShip()').slice(0, 10);

/**
 * Verify navigator allowlist data on-chain when the DAO doesn't exist yet.
 * Checks: contract exists, daoShip() matches claimed daoAddress, allowlistRoot() matches posted root.
 * Throws on transient RPC errors (block range will be retried by processor).
 * Returns false on deterministic failures (no code, mismatch).
 */
async function verifyAllowlistOnChain(
  ctx: EventContext,
  navigatorAddress: string,
  daoAddress: string,
  expectedRoot: string,
): Promise<boolean> {
  // 1. Verify contract exists
  const code = await ctx.blockchain.getCode(navigatorAddress);
  if (!code || code === '0x' || code === '0x0') {
    logger.warn({ navigatorAddress }, 'navigator.allowlist: no contract code at navigatorAddress');
    return false;
  }

  // 2. Verify daoShip() matches claimed daoAddress (prevents cross-DAO spoofing)
  const daoShipResult = await ctx.blockchain.rawCall(navigatorAddress, DAOSHIP_SELECTOR);
  if (!daoShipResult || daoShipResult.length < 66) {
    logger.warn({ navigatorAddress, daoShipResult }, 'navigator.allowlist: daoShip() returned invalid data');
    return false;
  }
  const onChainDaoShip = ('0x' + daoShipResult.slice(26)).toLowerCase();
  if (onChainDaoShip !== daoAddress.toLowerCase()) {
    logger.warn({ navigatorAddress, expected: daoAddress, onChain: onChainDaoShip },
      'navigator.allowlist: daoShip mismatch — possible cross-DAO spoofing');
    return false;
  }

  // 3. Verify allowlistRoot() matches posted root
  const rootResult = await ctx.blockchain.rawCall(navigatorAddress, ALLOWLIST_ROOT_SELECTOR);
  if (!rootResult || rootResult.length < 66) {
    logger.warn({ navigatorAddress, rootResult }, 'navigator.allowlist: allowlistRoot() returned invalid data');
    return false;
  }
  const onChainRoot = ('0x' + rootResult.slice(2).padStart(64, '0')).toLowerCase();
  if (onChainRoot !== expectedRoot.toLowerCase()) {
    logger.warn({ navigatorAddress, expected: expectedRoot, onChain: onChainRoot },
      'navigator.allowlist: root mismatch');
    return false;
  }

  return true;
}

// ── Tag-Specific Content Validators ─────────────────────────────

type ContentValidator = (parsed: Record<string, unknown>) => Record<string, unknown> | null;

// ── Validators: 7 tags per POSTER.md spec ──────────────────────

function validateDaoProfileInitial(p: Record<string, unknown>): Record<string, unknown> | null {
  const daoAddress = str(p.daoAddress, 42);
  const name = str(p.name, 100);
  const description = str(p.description, 1000);
  if (!daoAddress || !name || !description) return null; // all required for initial
  if (!ETH_ADDRESS_RE.test(daoAddress)) return null;
  return clean({ daoAddress, name, description, avatar: urlStr(p.avatar, 2048), banner: urlStr(p.banner, 2048), links: linksObj(p.links, 2048), tags: strArray(p.tags, 20, 50), chainId: num(p.chainId), schemaVersion: str(p.schemaVersion, 10) });
}

function validateDaoProfile(p: Record<string, unknown>): Record<string, unknown> | null {
  const daoAddress = str(p.daoAddress, 42);
  if (!daoAddress) return null; // only daoAddress required — supports partial updates
  if (!ETH_ADDRESS_RE.test(daoAddress)) return null;
  return clean({ daoAddress, name: str(p.name, 100), description: str(p.description, 1000), avatar: urlStr(p.avatar, 2048), banner: urlStr(p.banner, 2048), links: linksObj(p.links, 2048), tags: strArray(p.tags, 20, 50), chainId: num(p.chainId), schemaVersion: str(p.schemaVersion, 10) });
}

function validateDaoAnnouncement(p: Record<string, unknown>): Record<string, unknown> | null {
  const daoAddress = str(p.daoAddress, 42);
  const title = str(p.title, 200);
  if (!daoAddress || !title) return null; // both required
  if (!ETH_ADDRESS_RE.test(daoAddress)) return null;
  const severity = str(p.severity, 10);
  const validSeverity = severity && ['info', 'warning', 'critical'].includes(severity) ? severity : undefined;
  return clean({ daoAddress, title, body: str(p.body, 4096), severity: validSeverity, schemaVersion: str(p.schemaVersion, 10) });
}

function validateMemberProfile(p: Record<string, unknown>): Record<string, unknown> | null {
  const name = str(p.name, 100);
  if (!name) return null; // required
  const daoAddress = str(p.daoAddress, 42); // optional (global if omitted)
  if (daoAddress && !ETH_ADDRESS_RE.test(daoAddress)) return null;
  return clean({ daoAddress, name, bio: str(p.bio, 1000), avatar: urlStr(p.avatar, 2048), schemaVersion: str(p.schemaVersion, 10) });
}

function validateVoteReason(p: Record<string, unknown>): Record<string, unknown> | null {
  const daoAddress = str(p.daoAddress, 42);
  const reason = str(p.reason, 2000);
  if (!daoAddress || !reason) return null; // both required
  return clean({ daoAddress, proposalId: num(p.proposalId), vote: bool(p.vote), reason, schemaVersion: str(p.schemaVersion, 10) });
}


function validateNavigatorAllowlist(p: Record<string, unknown>): Record<string, unknown> | null {
  const daoAddress = str(p.daoAddress, 42);
  const navigatorAddress = str(p.navigatorAddress, 42);
  const root = str(p.root, 66);
  if (!daoAddress || !navigatorAddress || !root) return null;

  if (!ETH_ADDRESS_RE.test(daoAddress)) return null;
  if (!ETH_ADDRESS_RE.test(navigatorAddress)) return null;
  if (!BYTES32_RE.test(root)) return null;

  if (!Array.isArray(p.addresses)) return null;
  const validAddresses = p.addresses.filter(
    (a: unknown) => typeof a === 'string' && ETH_ADDRESS_RE.test(a),
  );
  if (validAddresses.length === 0) return null;

  if (!p.treeDump || typeof p.treeDump !== 'object' || Array.isArray(p.treeDump)) return null;

  return clean({
    daoAddress,
    navigatorAddress,
    root,
    addresses: validAddresses,
    treeDump: sanitizeJsonb(p.treeDump),
    schemaVersion: str(p.schemaVersion, 10),
  });
}

/**
 * Extract DAO metadata updates from validated poster content.
 * Supports merge semantics per POSTER.md:
 * - Field present with value → set field
 * - Field present with null → remove field (set to null in DB)
 * - Field absent → no change (not included in update)
 * @param validated The validated content_json
 * @param raw The raw parsed JSON (for detecting null vs absent)
 */
function extractDaoMetadataUpdates(validated: Record<string, unknown>, raw: Record<string, unknown>): Record<string, unknown> {
  const updates: Record<string, unknown> = {};

  if ('name' in raw) {
    updates.name = raw.name === null ? null : str(raw.name, 100) ?? undefined;
  }
  if ('description' in raw) {
    updates.description = raw.description === null ? null : str(raw.description, 1000) ?? undefined;
  }
  if ('avatar' in raw) {
    if (raw.avatar === null) {
      updates.avatar_img = null;
    } else {
      const url = urlStr(raw.avatar, 2048);
      if (url) updates.avatar_img = url;
    }
  }

  // Strip undefined entries (absent fields should not be sent to DB)
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(updates)) {
    if (val !== undefined) result[key] = val;
  }
  return result;
}

// ── handleNewPost ───────────────────────────────────────────────
// NewPost(address indexed user, string content, string indexed tag)

const MAX_CONTENT_SIZE = 16384; // 16KB — hard limit per POSTER.md

export async function handleNewPost(
  ctx: EventContext,
  args: Record<string, unknown>,
): Promise<void> {
  validateEventArgs(args, ['user', 'content', 'tag'], 'NewPost');
  const user = validateAndNormalizeAddress(args.user, 'user');
  const content: string = String(args.content);
  // Indexed strings in Solidity emit only their keccak256 hash as a topic.
  // quais parseLog returns an Indexed object with a .hash property for these.
  const rawTag = args.tag;
  const tagHash: string = rawTag instanceof Indexed ? (rawTag.hash ?? '') : String(rawTag);

  // Hard reject content exceeding 16KB — per POSTER.md spec
  if (content.length > MAX_CONTENT_SIZE) {
    logger.warn(
      { user, tagHash, size: content.length, max: MAX_CONTENT_SIZE },
      'NewPost content exceeds 16KB limit, rejecting',
    );
    return;
  }

  const tagDef = KNOWN_TAGS[tagHash] ?? null;

  // Only index posts with recognized daoships.* tags. Poster is a shared
  // permissionless contract — anyone can post with any tag. Storing
  // unrecognized tags would bloat the database with irrelevant data.
  if (!tagDef) {
    logger.debug({ user, tagHash }, 'NewPost: unrecognized tag, skipping');
    return;
  }

  const tagName = tagDef.tag;
  const now = new Date(ctx.blockTimestamp * 1000).toISOString();

  // ── Parse content JSON ────────────────────────────────────────

  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(content);
  } catch {
    logger.debug({ user, tagHash }, 'NewPost content is not valid JSON, rejecting');
    return;
  }

  // Enforce schemaVersion — all DAO Ships poster content must include it
  if (!parsed || typeof parsed.schemaVersion !== 'string') {
    logger.warn({ user, tagHash }, 'NewPost missing schemaVersion, rejecting');
    return;
  }

  // ── Determine DAO + Trust ──────────────────────────────────────

  const isNavigatorAllowlist = tagName === 'daoships.navigator.allowlist';
  let daoId: string | null = null;
  let trustLevel: TrustLevel = 'UNTRUSTED';
  let trustDao: Awaited<ReturnType<typeof ctx.db.getDao>> = null;

  if (isNavigatorAllowlist && parsed?.daoAddress && parsed?.navigatorAddress && parsed?.root) {
    // ── Navigator allowlist: on-chain verification path ────────
    // The DAO may not exist yet (navigator deployed before DAO launch).
    // Try normal path first; if DAO doesn't exist, verify on-chain.

    const validator = TAG_VALIDATORS[tagName];
    const preValidated = validator ? validator(parsed) : null;
    if (!preValidated) {
      logger.warn({ user, tagHash, tagName }, 'navigator.allowlist: schema validation failed, skipping');
      return;
    }

    const claimedDao = String(preValidated.daoAddress).toLowerCase();
    const navAddr = String(preValidated.navigatorAddress).toLowerCase();
    const root = String(preValidated.root);

    // Try normal DAO+trust path first
    let normalPathSucceeded = false;
    try {
      const dao = await ctx.db.getDao(claimedDao);
      if (dao) {
        daoId = claimedDao;
        const result = await determineTrustLevel(ctx, user, daoId, tagName);
        trustLevel = result.trust;
        trustDao = result.dao;
        if (meetsMinTrust(trustLevel, tagDef.minTrust)) {
          normalPathSucceeded = true;
        } else {
          // DAO exists but trust insufficient — NO fallback to on-chain
          logger.warn({ user, daoId, tag: tagName, trustLevel, requiredTrust: tagDef.minTrust },
            'NewPost: insufficient trust level, skipping');
          return;
        }
      }
    } catch {
      // DAO lookup failed — fall through to on-chain verification
    }

    if (!normalPathSucceeded) {
      // On-chain verification: getCode + daoShip() + allowlistRoot()
      // Throws on transient RPC errors (processor retries block range).
      const verified = await verifyAllowlistOnChain(ctx, navAddr, claimedDao, root);
      if (!verified) {
        logger.warn({ user, navigatorAddress: navAddr, daoAddress: claimedDao },
          'navigator.allowlist: on-chain verification failed, skipping');
        return;
      }
      daoId = null; // DAO doesn't exist yet — store as orphan
      trustLevel = 'ON_CHAIN_PROVISIONAL';
      logger.info({ daoAddress: claimedDao, navigatorAddress: navAddr },
        'navigator.allowlist: verified via on-chain (pre-DAO)');
    }
  } else {
    // ── Normal path for all other tags ─────────────────────────

    if (parsed?.daoAddress) {
      const candidate = String(parsed.daoAddress).toLowerCase();
      try {
        const dao = await ctx.db.getDao(candidate);
        if (dao) {
          daoId = candidate;
        }
      } catch (err) {
        logger.debug({ candidate, err }, 'NewPost: daoAddress lookup failed');
      }
    }

    if (!daoId) {
      logger.warn({ user, tagHash, tagName }, 'NewPost: could not determine DAO, skipping');
      return;
    }

    const result = await determineTrustLevel(ctx, user, daoId, tagName);
    trustLevel = result.trust;
    trustDao = result.dao;

    if (!meetsMinTrust(trustLevel, tagDef.minTrust)) {
      logger.warn({ user, daoId, tag: tagName, trustLevel, requiredTrust: tagDef.minTrust },
        'NewPost: insufficient trust level, skipping');
      return;
    }
  }

  // ── Validate content_json against tag-specific schema ─────────

  let validatedJson: Record<string, unknown> | null = parsed;
  try {
    const validator = TAG_VALIDATORS[tagName];
    if (validator && parsed) {
      validatedJson = validator(parsed);
    }
  } catch (err) {
    logger.warn({ tag: tagName, err }, 'content_json validation failed, storing null');
    validatedJson = null;
  }

  // ── Insert record ─────────────────────────────────────────────
  // Use daoAddress from content for record ID (always present), even when dao_id is null.

  const daoAddress = parsed?.daoAddress ? String(parsed.daoAddress).toLowerCase() : daoId;
  const recordId = `${daoAddress}-${ctx.log.transactionHash}-${ctx.log.index}`;

  await ctx.db.upsert('ds_records', {
    id: recordId,
    dao_id: daoId,
    created_at: now,
    user_address: user,
    tx_hash: ctx.log.transactionHash,
    tag: tagName,
    content_type: parsed ? 'application/json' : 'text/plain',
    content,
    content_json: validatedJson,
    trust_level: trustLevel,
    block_number: ctx.log.blockNumber,
  });

  // ── Tag-specific routing ──────────────────────────────────────

  if (validatedJson && tagDef) {
    switch (tagDef.tag) {
      case 'daoships.dao.profile.initial': {
        if (!daoId) break; // only possible in normal path where daoId is set
        // Permanently rejected once vault has posted dao.profile
        // Reuse trustDao from determineTrustLevel — no redundant fetch needed.
        const dao = trustDao;
        if (dao?.profile_source === 'vault') {
          logger.debug({ daoId }, 'NewPost: profile.initial permanently rejected — vault profile exists');
          break;
        }
        const updates = extractDaoMetadataUpdates(validatedJson as Record<string, unknown>, parsed!);
        if (Object.keys(updates).length > 0) {
          updates.profile_source = 'launcher';
          await ctx.db.updateDao(daoId, updates);
          logger.info({ daoId, updates }, 'DAO initial profile set from launcher');
        }
        break;
      }

      case 'daoships.dao.profile': {
        if (!daoId) break;
        // Merge semantics: null removes, omitted unchanged, value sets
        const updates = extractDaoMetadataUpdates(validatedJson as Record<string, unknown>, parsed!);
        if (Object.keys(updates).length > 0) {
          updates.profile_source = 'vault';
          await ctx.db.updateDao(daoId, updates);
          logger.info({ daoId, updates }, 'DAO profile updated from vault');
        }
        break;
      }

      case 'daoships.navigator.allowlist': {
        const navAddr = (validatedJson.navigatorAddress as string)?.toLowerCase();
        const addrCount = Array.isArray(validatedJson.addresses) ? validatedJson.addresses.length : 0;
        logger.info({ daoId, navigatorAddress: navAddr, addressCount: addrCount }, 'Navigator allowlist indexed');
        break;
      }

      default:
        break;
    }
  }

  logger.info(
    { daoId, user, tag: tagName, trustLevel },
    'New post indexed',
  );
}
