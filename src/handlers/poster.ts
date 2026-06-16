import { Interface, Indexed, id as keccak256 } from 'quais';
import type { EventContext } from './index.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { makeMemberId } from '../utils/addresses.js';
import { validateEventArgs, validateAndNormalizeAddress } from '../utils/validation.js';

import { reconcileSanctionedNavigators, makePollPk } from './signal.js';

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
  // RangeCache deduplicates the getDao read across the handler's own
  // earlier `fetchDao(candidate)` and this call (M7's `prefetchedDao`
  // param is no longer needed).
  const dao = await ctx.cache.fetchDao(daoId, () => ctx.db.getDao(daoId));
  if (!dao) return { trust: 'UNTRUSTED', dao: null };
  if (user === dao.avatar) return { trust: 'VERIFIED', dao };
  if (user === dao.deployer && tag === 'daoships.dao.profile.initial') return { trust: 'VERIFIED_INITIAL', dao };
  if (user === dao.id) return { trust: 'VERIFIED', dao };
  const navigatorDaoId = ctx.registry.getDaoByNavigatorAddress(user);
  if (navigatorDaoId === daoId) return { trust: 'SEMI_TRUSTED', dao };
  const memberId = makeMemberId(daoId, user);
  const member = await ctx.cache.fetchMember(memberId, () => ctx.db.getMember(memberId));
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
  // Vault-authenticated allowlist of sanctioned read-only navigators. VERIFIED =
  // msg.sender == dao.avatar. Grants no permission — purely a trust/display signal.
  { tag: 'daoships.dao.navigators', minTrust: 'VERIFIED', updatesDao: false },
  // SignalNavigator poll option labels. minTrust here is a placeholder — this tag is fully
  // special-cased (like navigator.allowlist) and BYPASSES the meetsMinTrust DAO-rank gate; the
  // real gate is msg.sender == PollCreated.creator, enforced in applySignalPollLabels.
  { tag: 'daoships.signal.poll', minTrust: 'UNTRUSTED', updatesDao: false },
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
  'daoships.dao.navigators': validateDaoNavigators,
  'daoships.signal.poll': validateSignalPoll,
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
  // M3: Cap array length to prevent excessive memory during sanitization
  if (Array.isArray(obj)) return obj.slice(0, 1000).map(v => sanitizeJsonb(v, maxDepth, depth + 1));
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

// daoships.dao.profile `theme` palette (schema 1.1+). Strict 3- or 6-digit hex only.
const HEX_COLOR_RE = /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/;
const THEME_COLOR_KEYS = ['primary', 'secondary', 'accent', 'background', 'surface', 'text'] as const;

/**
 * Validate the DAO-profile `theme` color palette. **Security boundary** (POSTER.md → Security:
 * Content Rendering, rule 7): every theme color is a CSS-injection vector — a frontend that
 * interpolates a posted color into a `style` attribute / stylesheet / CSS variable could be fed
 * `#fff; } body { background: url(...)` to inject arbitrary rules. We therefore accept ONLY values
 * matching the strict hex regex per color and constrain `mode` to the literals 'light'/'dark';
 * every non-conforming token is DROPPED (the frontend falls back to its default). We read from a
 * FIXED key allowlist, so unknown/attacker-supplied keys never reach content_json. Replaced as a
 * whole, like `links` — no per-token deep merge.
 */
function themeObj(v: unknown): Record<string, string> | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const obj = v as Record<string, unknown>;
  const result: Record<string, string> = {};
  if (obj.mode === 'light' || obj.mode === 'dark') result.mode = obj.mode;
  for (const key of THEME_COLOR_KEYS) {
    const raw = obj[key];
    if (typeof raw === 'string' && HEX_COLOR_RE.test(raw)) result[key] = raw;
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

// ── Allowlist Post Verification (H1) ────────────────────────────
// The permissionless Poster contract lets anyone emit NewPost(navigator.allowlist)
// with arbitrary content. Previously we verified each post via three per-event
// RPC calls (getCode + daoShip() + allowlistRoot()) — an uncapped DoS vector
// because an attacker could spam posts for any random navigator address.
//
// We now derive trust entirely from the indexed NavigatorDeployed event:
//   - The navigator's `deployer` is immutable and comes from the constructor event.
//   - The navigator's `daoShip` is immutable and encoded in the ds_navigators.id prefix.
//   - The navigator's `allowlistRoot()` is cached in ds_navigators.allowlist_root
//     when NavigatorDeployed is indexed (one RPC per navigator, not per post).
//
// An allowlist post must satisfy ALL of: the navigator row exists, the post's
// user matches the stored deployer, the claimed DAO matches the navigator's
// declared daoShip, and the posted root matches the cached root. Otherwise
// rejected with zero RPC cost.

type AllowlistVerification = {
  accepted: boolean;
  trust: 'SEMI_TRUSTED' | 'ON_CHAIN_PROVISIONAL' | null;
  daoId: string | null;
  reason?: string;
};

async function verifyAllowlistFromIndex(
  ctx: EventContext,
  user: string,
  navigatorAddress: string,
  claimedDao: string,
  postedRoot: string,
): Promise<AllowlistVerification> {
  // DB errors propagate — processor retries the block range.
  const nav = await ctx.db.getNavigatorByAddress(navigatorAddress);
  if (!nav) {
    return { accepted: false, trust: null, daoId: null, reason: 'navigator not indexed' };
  }

  // The id encodes the navigator's declared daoShip as the 42-char prefix.
  // Expected id = `${claimedDao}-${navigatorAddress}`; any mismatch means the
  // post claims a DAO different from what the navigator contract committed to.
  const expectedId = `${claimedDao}-${navigatorAddress}`;
  if (nav.id !== expectedId) {
    return { accepted: false, trust: null, daoId: null, reason: 'daoShip mismatch' };
  }

  if (!nav.deployer || nav.deployer !== user) {
    return { accepted: false, trust: null, daoId: null, reason: 'user is not navigator deployer' };
  }

  // Missing cached root → navigator's allowlistRoot() call failed at deploy
  // time, or it's an open allowlist (stored as NULL). Either way, reject.
  if (!nav.allowlist_root) {
    return { accepted: false, trust: null, daoId: null, reason: 'no cached allowlist_root for navigator' };
  }

  if (nav.allowlist_root.toLowerCase() !== postedRoot.toLowerCase()) {
    return { accepted: false, trust: null, daoId: null, reason: 'root mismatch' };
  }

  // Pass. Trust level depends on whether the navigator is currently registered
  // (activated via NavigatorSet from a live DAOShip) or still an orphan.
  return nav.dao_id
    ? { accepted: true, trust: 'SEMI_TRUSTED', daoId: nav.dao_id }
    : { accepted: true, trust: 'ON_CHAIN_PROVISIONAL', daoId: null };
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
  return clean({ daoAddress, name, description, avatar: urlStr(p.avatar, 2048), banner: urlStr(p.banner, 2048), links: linksObj(p.links, 2048), theme: themeObj(p.theme), tags: strArray(p.tags, 20, 50), chainId: num(p.chainId), schemaVersion: str(p.schemaVersion, 10) });
}

function validateDaoProfile(p: Record<string, unknown>): Record<string, unknown> | null {
  const daoAddress = str(p.daoAddress, 42);
  if (!daoAddress) return null; // only daoAddress required — supports partial updates
  if (!ETH_ADDRESS_RE.test(daoAddress)) return null;
  return clean({ daoAddress, name: str(p.name, 100), description: str(p.description, 1000), avatar: urlStr(p.avatar, 2048), banner: urlStr(p.banner, 2048), links: linksObj(p.links, 2048), theme: themeObj(p.theme), tags: strArray(p.tags, 20, 50), chainId: num(p.chainId), schemaVersion: str(p.schemaVersion, 10) });
}

function validateDaoAnnouncement(p: Record<string, unknown>): Record<string, unknown> | null {
  const daoAddress = str(p.daoAddress, 42);
  const title = str(p.title, 200);
  if (!daoAddress || !title) return null; // both required
  if (!ETH_ADDRESS_RE.test(daoAddress)) return null;
  const severity = str(p.severity, 10);
  const validSeverity = severity && ['info', 'warning', 'critical'].includes(severity) ? severity : undefined;
  const expiresAt = str(p.expiresAt, 30);
  const validExpiry = expiresAt && !isNaN(Date.parse(expiresAt)) ? expiresAt : undefined;
  return clean({ daoAddress, title, body: str(p.body, 4096), severity: validSeverity, url: urlStr(p.url, 2048), expiresAt: validExpiry, schemaVersion: str(p.schemaVersion, 10) });
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
  if (!ETH_ADDRESS_RE.test(daoAddress)) return null;
  return clean({ daoAddress, proposalId: num(p.proposalId), vote: bool(p.vote), reason, schemaVersion: str(p.schemaVersion, 10) });
}


// CID format: CIDv0 (Qm + 44 base58 chars) or CIDv1 (baf prefix, covers bafy/bafk/etc)
const CID_RE = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|baf[a-z2-7]{51,63})$/;

function validateNavigatorAllowlist(p: Record<string, unknown>): Record<string, unknown> | null {
  const rawDaoAddress = str(p.daoAddress, 42);
  const rawNavigatorAddress = str(p.navigatorAddress, 42);
  const root = str(p.root, 66);
  if (!rawDaoAddress || !rawNavigatorAddress || !root) return null;

  if (!ETH_ADDRESS_RE.test(rawDaoAddress)) return null;
  if (!ETH_ADDRESS_RE.test(rawNavigatorAddress)) return null;
  if (!BYTES32_RE.test(root)) return null;

  // Lowercase addresses for consistent storage and reparent SQL matching
  const daoAddress = rawDaoAddress.toLowerCase();
  const navigatorAddress = rawNavigatorAddress.toLowerCase();

  const hasInline = Array.isArray(p.addresses) && p.treeDump && typeof p.treeDump === 'object' && !Array.isArray(p.treeDump);
  const ipfsCid = str(p.ipfsCid, 100);
  const hasCid = ipfsCid && CID_RE.test(ipfsCid);

  // Mutually exclusive: inline OR ipfsCid, not both, not neither
  if (hasInline && hasCid) return null;
  if (!hasInline && !hasCid) return null;

  if (hasCid) {
    // IPFS pointer format — no inline data, just CID
    return clean({
      daoAddress,
      navigatorAddress,
      root,
      ipfsCid,
      schemaVersion: str(p.schemaVersion, 10),
    });
  }

  // Legacy inline format — lowercase for consistent comparisons
  const validAddresses = (p.addresses as unknown[]).slice(0, 500)
    .filter((a: unknown) => typeof a === 'string' && ETH_ADDRESS_RE.test(a))
    .map((a) => (a as string).toLowerCase());
  if (validAddresses.length === 0) return null;

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
 * daoships.dao.navigators — the DAO's COMPLETE sanctioned read-only-navigator set.
 * The `navigators` array is canonical (full set, not a delta); an empty array clears
 * all sanctions. Each entry needs a valid hex address; `type` is an optional hint
 * sanity-checked downstream against the on-chain navigator_type. Trust (msg.sender ==
 * vault) is enforced by the VERIFIED tag gate in handleNewPost, not here.
 */
function validateDaoNavigators(p: Record<string, unknown>): Record<string, unknown> | null {
  const daoAddress = str(p.daoAddress, 42);
  if (!daoAddress || !ETH_ADDRESS_RE.test(daoAddress)) return null;
  if (!Array.isArray(p.navigators)) return null; // required; [] is valid (clears all)

  const navigators = (p.navigators as unknown[]).slice(0, 200)
    .map((n): Record<string, unknown> | null => {
      if (!n || typeof n !== 'object' || Array.isArray(n)) return null;
      const rec = n as Record<string, unknown>;
      const address = str(rec.address, 42);
      if (!address || !ETH_ADDRESS_RE.test(address)) return null;
      const type = str(rec.type, 50);
      return clean({ address: address.toLowerCase(), type });
    })
    .filter((n): n is Record<string, unknown> => n !== null);

  return clean({
    daoAddress: daoAddress.toLowerCase(),
    navigators,
    schemaVersion: str(p.schemaVersion, 10),
  });
}

/** Parse a per-navigator pollId into a canonical decimal string (matches signal.ts bigintToString). */
function pollIdStr(v: unknown): string | undefined {
  try {
    let b: bigint;
    if (typeof v === 'bigint') b = v;
    else if (typeof v === 'number' && Number.isInteger(v)) b = BigInt(v);
    else if (typeof v === 'string' && /^[0-9]+$/.test(v)) b = BigInt(v);
    else return undefined;
    return b >= 0n ? b.toString() : undefined;
  } catch {
    return undefined;
  }
}

// SignalNavigator option-count bounds (contract MIN_OPTIONS..MAX_OPTIONS).
const SIGNAL_MIN_OPTIONS = 2;
const SIGNAL_MAX_OPTIONS = 10;

/**
 * daoships.signal.poll — off-chain option labels for a SignalNavigator poll. The contract stores
 * only optionCount; this post carries the index→label map (+ optional description / discussionUrl).
 * `options` is an ordered map, so a single empty/invalid label invalidates the whole post (dropping
 * one entry would shift every later index). The on-chain optionCount match and the creator-identity
 * trust gate are enforced at apply time (applySignalPollLabels), not here.
 */
function validateSignalPoll(p: Record<string, unknown>): Record<string, unknown> | null {
  const daoAddress = str(p.daoAddress, 42);
  const navigatorAddress = str(p.navigatorAddress, 42);
  if (!daoAddress || !ETH_ADDRESS_RE.test(daoAddress)) return null;
  if (!navigatorAddress || !ETH_ADDRESS_RE.test(navigatorAddress)) return null;

  const pollId = pollIdStr(p.pollId);
  if (pollId === undefined) return null;

  if (!Array.isArray(p.options)) return null;
  if (p.options.length < SIGNAL_MIN_OPTIONS || p.options.length > SIGNAL_MAX_OPTIONS) return null;
  const options: string[] = [];
  for (const item of p.options) {
    const label = str(item, 200);
    if (label === undefined) return null; // empty/invalid label would shift indices — reject post
    options.push(label);
  }

  return clean({
    daoAddress: daoAddress.toLowerCase(),
    navigatorAddress: navigatorAddress.toLowerCase(),
    pollId,
    options,
    description: str(p.description, 1000),
    discussionUrl: urlStr(p.discussionUrl, 2048),
    schemaVersion: str(p.schemaVersion, 10),
  });
}

/**
 * Apply daoships.signal.poll labels to a materialized poll row. Gates (all → discard on fail):
 *   1. poll row exists (else out-of-flow unsanctioned poll — discard, do not hold; §3 of plan)
 *   2. msg.sender == PollCreated.creator (the trust gate — wrong wallet is spam)
 *   3. poll not cancelled and not ended at the post's block timestamp (ignore late edits)
 *   4. options.length == on-chain option_count (else frontend renders numeric Option 1..n)
 * applyPollLabels itself adds the last-write-wins-by-block guard.
 */
async function applySignalPollLabels(
  ctx: EventContext,
  user: string,
  validated: Record<string, unknown>,
): Promise<void> {
  const navigatorAddress = String(validated.navigatorAddress).toLowerCase();
  const pollId = String(validated.pollId);
  const pollPk = makePollPk(navigatorAddress, pollId);

  const poll = await ctx.db.getSignalPoll(pollPk);
  if (!poll) {
    logger.debug({ navigatorAddress, pollId }, 'signal.poll: poll not materialized — discarding labels (not held)');
    return;
  }
  if (user.toLowerCase() !== poll.creator.toLowerCase()) {
    logger.warn({ navigatorAddress, pollId, user, creator: poll.creator }, 'signal.poll: sender is not poll creator — discarding');
    return;
  }
  if (poll.cancelled || ctx.blockTimestamp >= poll.voting_ends) {
    logger.debug({ navigatorAddress, pollId }, 'signal.poll: poll cancelled/ended — ignoring late labels');
    return;
  }
  const options = validated.options as string[];
  if (options.length !== poll.option_count) {
    logger.warn(
      { navigatorAddress, pollId, got: options.length, want: poll.option_count },
      'signal.poll: options length != option_count — discarding (frontend renders numeric)',
    );
    return;
  }

  const now = new Date(ctx.blockTimestamp * 1000).toISOString();
  await ctx.db.applyPollLabels(pollPk, {
    options,
    description: (validated.description as string | undefined) ?? null,
    discussionUrl: (validated.discussionUrl as string | undefined) ?? null,
    labelsUpdatedAt: now,
    labelsBlockNumber: ctx.log.blockNumber,
  });
  logger.info({ navigatorAddress, pollId, optionCount: options.length }, 'signal.poll: option labels applied');
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
  // U2: Under unfiltered topic0 mode any contract can emit NewPost. Our
  // Poster is a single global contract (config.contracts.poster) — drop
  // events from any other emitter. This closes the orphan-spam vector
  // that would otherwise exist alongside the H1 allowlist trust chain.
  const emitter = ctx.log.address.toLowerCase();
  if (emitter !== config.contracts.poster) {
    logger.warn({ emitter }, 'NewPost from unauthorized address — dropping');
    return;
  }

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
  const isSignalPoll = tagName === 'daoships.signal.poll';
  let daoId: string | null = null;
  let trustLevel: TrustLevel = 'UNTRUSTED';
  let trustDao: Awaited<ReturnType<typeof ctx.db.getDao>> = null;
  let preValidated: Record<string, unknown> | null = null;

  if (isNavigatorAllowlist && parsed?.daoAddress && parsed?.navigatorAddress && parsed?.root) {
    // ── Navigator allowlist: DB-indexed verification (H1) ──────
    // All verification is derived from the indexed NavigatorDeployed event.
    // Zero RPC calls on the hot path — see verifyAllowlistFromIndex.

    const validator = TAG_VALIDATORS[tagName];
    preValidated = validator ? validator(parsed) : null;
    if (!preValidated) {
      logger.warn({ user, tagHash, tagName }, 'navigator.allowlist: schema validation failed, skipping');
      return;
    }

    const claimedDao = String(preValidated.daoAddress).toLowerCase();
    const navAddr = String(preValidated.navigatorAddress).toLowerCase();
    const root = String(preValidated.root);

    const verdict = await verifyAllowlistFromIndex(ctx, user, navAddr, claimedDao, root);
    if (!verdict.accepted) {
      logger.warn(
        { user, navigatorAddress: navAddr, daoAddress: claimedDao, reason: verdict.reason },
        'navigator.allowlist: verification failed, skipping',
      );
      return;
    }

    daoId = verdict.daoId;
    trustLevel = verdict.trust!;
    logger.info(
      { user, daoAddress: claimedDao, navigatorAddress: navAddr, trustLevel },
      'navigator.allowlist: verified against indexed navigator metadata',
    );
  } else if (isSignalPoll) {
    // ── Signal poll labels: creator-identity trust, NOT DAO rank ──
    // Validate, resolve the claimed DAO (must be one we index), and record at MEMBER trust
    // (the creator provably held shares at createPoll — SignalNavigator gates on voting power).
    // The real creator-match gate runs later in applySignalPollLabels.
    const validator = TAG_VALIDATORS[tagName];
    preValidated = validator ? validator(parsed) : null;
    if (!preValidated) {
      logger.warn({ user, tagHash, tagName }, 'signal.poll: schema validation failed, skipping');
      return;
    }
    const candidate = String(preValidated.daoAddress).toLowerCase();
    const dao = await ctx.cache.fetchDao(candidate, () => ctx.db.getDao(candidate));
    if (!dao) {
      logger.warn({ user, tagName, daoAddress: candidate }, 'signal.poll: unknown DAO, skipping');
      return;
    }
    daoId = candidate;
    trustLevel = 'MEMBER';
  } else {
    // ── Normal path for all other tags ─────────────────────────

    if (parsed?.daoAddress) {
      const candidate = String(parsed.daoAddress).toLowerCase();
      // DB errors propagate — processor retries the block range
      const dao = await ctx.cache.fetchDao(candidate, () => ctx.db.getDao(candidate));
      if (dao) {
        daoId = candidate;
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
  // For navigator.allowlist, preValidated was already computed above — reuse it.

  let validatedJson: Record<string, unknown> | null = parsed;
  if ((isNavigatorAllowlist || isSignalPoll) && preValidated) {
    validatedJson = preValidated;
  } else {
    try {
      const validator = TAG_VALIDATORS[tagName];
      if (validator && parsed) {
        validatedJson = validator(parsed);
      }
    } catch (err) {
      logger.warn({ tag: tagName, err }, 'content_json validation failed, storing null');
      validatedJson = null;
    }
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
    content_type: 'application/json',
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
          ctx.cache.invalidateDao(daoId);
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
          ctx.cache.invalidateDao(daoId);
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

      case 'daoships.dao.navigators': {
        if (!daoId) break; // VERIFIED path always sets daoId, but guard for the type-narrowing
        // VERIFIED gate above already proved msg.sender == vault. Reconcile the DAO's
        // full sanctioned read-only set: sanction listed (+ backfill), de-sanction omitted,
        // hold intents for not-yet-seen addresses. Empty/absent array clears all sanctions.
        const listed = Array.isArray(validatedJson.navigators)
          ? (validatedJson.navigators as Array<{ address: string; type?: string }>)
          : [];
        await reconcileSanctionedNavigators(ctx, daoId, user, listed);
        logger.info({ daoId, sanctionedCount: listed.length }, 'DAO sanctioned-navigator list reconciled');
        break;
      }

      case 'daoships.signal.poll': {
        if (!daoId) break; // signal.poll path always sets daoId, but guard for type-narrowing
        // Creator-match + length + not-expired gates live in the helper; the ds_records audit
        // row above is already written (so the post is always traceable) even if labels are
        // discarded here.
        await applySignalPollLabels(ctx, user, validatedJson);
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
