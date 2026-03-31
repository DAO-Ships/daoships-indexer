import { Interface, Indexed, id as keccak256 } from 'quais';
import type { EventContext } from './index.js';
import { logger } from '../utils/logger.js';
import { makeMemberId } from '../utils/addresses.js';
import { validateEventArgs, validateAndNormalizeAddress } from '../utils/validation.js';

import PosterAbi from '../abis/Poster.json' with { type: 'json' };

export const posterIface = new Interface(PosterAbi);

// ── Trust Model ─────────────────────────────────────────────────

type TrustLevel = 'VERIFIED' | 'VERIFIED_INITIAL' | 'SEMI_TRUSTED' | 'MEMBER' | 'UNTRUSTED';

/** Trust level hierarchy for minimum-trust comparisons */
const TRUST_RANK: Record<TrustLevel, number> = {
  UNTRUSTED: 0,
  MEMBER: 1,
  SEMI_TRUSTED: 2,
  VERIFIED_INITIAL: 3,
  VERIFIED: 4,
};

function meetsMinTrust(actual: TrustLevel, required: TrustLevel): boolean {
  return TRUST_RANK[actual] >= TRUST_RANK[required];
}

async function determineTrustLevel(
  ctx: EventContext,
  user: string,
  daoId: string,
  tag: string,
): Promise<TrustLevel> {
  const dao = await ctx.db.getDao(daoId);
  if (!dao) return 'UNTRUSTED';
  if (user === dao.avatar) return 'VERIFIED';
  if (user === dao.launcher && tag === 'daoships.dao.profile.initial') return 'VERIFIED_INITIAL';
  if (user === dao.id) return 'VERIFIED';
  const navigatorDaoId = ctx.registry.getDaoByNavigatorAddress(user);
  if (navigatorDaoId === daoId) return 'SEMI_TRUSTED';
  const member = await ctx.db.getMember(makeMemberId(daoId, user));
  if (member && BigInt(member.shares || '0') > 0n) return 'MEMBER';
  return 'UNTRUSTED';
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
  { tag: 'daoships.navigator.metadata', minTrust: 'SEMI_TRUSTED', updatesDao: false },
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
  'daoships.navigator.metadata': validateNavigatorMetadata,
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

// ── Tag-Specific Content Validators ─────────────────────────────

type ContentValidator = (parsed: Record<string, unknown>) => Record<string, unknown> | null;

// ── Validators: 7 tags per POSTER.md spec ──────────────────────

function validateDaoProfileInitial(p: Record<string, unknown>): Record<string, unknown> | null {
  const daoAddress = str(p.daoAddress, 42);
  const name = str(p.name, 100);
  const description = str(p.description, 1000);
  if (!daoAddress || !name || !description) return null; // all required for initial
  return clean({ daoAddress, name, description, avatar: urlStr(p.avatar, 2048), banner: urlStr(p.banner, 2048), links: linksObj(p.links, 2048), tags: strArray(p.tags, 20, 50), chainId: num(p.chainId), schemaVersion: str(p.schemaVersion, 10) });
}

function validateDaoProfile(p: Record<string, unknown>): Record<string, unknown> | null {
  const daoAddress = str(p.daoAddress, 42);
  if (!daoAddress) return null; // only daoAddress required — supports partial updates
  return clean({ daoAddress, name: str(p.name, 100), description: str(p.description, 1000), avatar: urlStr(p.avatar, 2048), banner: urlStr(p.banner, 2048), links: linksObj(p.links, 2048), tags: strArray(p.tags, 20, 50), chainId: num(p.chainId), schemaVersion: str(p.schemaVersion, 10) });
}

function validateDaoAnnouncement(p: Record<string, unknown>): Record<string, unknown> | null {
  const daoAddress = str(p.daoAddress, 42);
  const title = str(p.title, 200);
  if (!daoAddress || !title) return null; // both required
  const severity = str(p.severity, 10);
  const validSeverity = severity && ['info', 'warning', 'critical'].includes(severity) ? severity : undefined;
  return clean({ daoAddress, title, body: str(p.body, 4096), severity: validSeverity, schemaVersion: str(p.schemaVersion, 10) });
}

function validateMemberProfile(p: Record<string, unknown>): Record<string, unknown> | null {
  const name = str(p.name, 100);
  if (!name) return null; // required
  const daoAddress = str(p.daoAddress, 42); // optional (global if omitted)
  return clean({ daoAddress, name, bio: str(p.bio, 1000), avatar: urlStr(p.avatar, 2048), schemaVersion: str(p.schemaVersion, 10) });
}

function validateVoteReason(p: Record<string, unknown>): Record<string, unknown> | null {
  const daoAddress = str(p.daoAddress, 42);
  const reason = str(p.reason, 2000);
  if (!daoAddress || !reason) return null; // both required
  return clean({ daoAddress, proposalId: num(p.proposalId), vote: bool(p.vote), reason, schemaVersion: str(p.schemaVersion, 10) });
}

function validateNavigatorMetadata(p: Record<string, unknown>): Record<string, unknown> | null {
  const daoAddress = str(p.daoAddress, 42);
  const navigatorAddress = str(p.navigatorAddress, 42);
  if (!daoAddress || !navigatorAddress) return null;
  return clean({ daoAddress, navigatorAddress, name: str(p.name, 100), description: str(p.description, 1000), schemaVersion: str(p.schemaVersion, 10) });
}

const ETH_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;

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
    treeDump: p.treeDump,
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
  if (!parsed || !parsed.schemaVersion) {
    logger.warn({ user, tagHash }, 'NewPost missing schemaVersion, rejecting');
    return;
  }

  // ── Determine DAO ─────────────────────────────────────────────
  // Try to extract daoAddress from the content payload itself.

  let daoId: string | null = null;

  if (parsed?.daoAddress) {
    const candidate = String(parsed.daoAddress).toLowerCase();
    try {
      const dao = await ctx.db.getDao(candidate);
      if (dao) {
        daoId = candidate;
      }
    } catch (err) {
      // Invalid address format in user-supplied content — not a real DAO, fall through
      logger.debug({ candidate, err }, 'NewPost: daoAddress lookup failed, trying member fallback');
    }
  }

  if (!daoId) {
    logger.warn(
      { user, tagHash, tagName },
      'NewPost: could not determine DAO, skipping',
    );
    return;
  }

  // ── Trust verification ────────────────────────────────────────

  const trustLevel = await determineTrustLevel(ctx, user, daoId, tagName);
  const requiredTrust = tagDef.minTrust;

  if (!meetsMinTrust(trustLevel, requiredTrust)) {
    logger.warn(
      { user, daoId, tag: tagName, trustLevel, requiredTrust },
      'NewPost: insufficient trust level, skipping',
    );
    return;
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

  const recordId = `${daoId}-${ctx.log.transactionHash}-${ctx.log.index}`;

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
        // Permanently rejected once vault has posted dao.profile
        const dao = await ctx.db.getDao(daoId);
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
        // Merge semantics: null removes, omitted unchanged, value sets
        const updates = extractDaoMetadataUpdates(validatedJson as Record<string, unknown>, parsed!);
        if (Object.keys(updates).length > 0) {
          updates.profile_source = 'vault';
          await ctx.db.updateDao(daoId, updates);
          logger.info({ daoId, updates }, 'DAO profile updated from vault');
        }
        break;
      }

      case 'daoships.navigator.metadata': {
        if (typeof validatedJson.navigatorAddress === 'string') {
          const navigatorAddr = (validatedJson.navigatorAddress as string).toLowerCase();
          const navigatorId = `${daoId}-${navigatorAddr}`;
          const navUpdates: Record<string, unknown> = {};
          if (typeof validatedJson.name === 'string') navUpdates.name = validatedJson.name;
          if (typeof validatedJson.description === 'string') navUpdates.description = validatedJson.description;
          if (Object.keys(navUpdates).length > 0) {
            try {
              await ctx.db.updateNavigator(navigatorId, navUpdates);
              logger.info({ daoId, navigatorAddr }, 'Navigator metadata updated from post');
            } catch (err) {
              logger.warn({ daoId, navigatorAddr, error: (err as Error).message }, 'Navigator metadata update failed (row may not exist yet)');
            }
          }
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
