import type { EventContext, EventHandler } from './index.js';
import { logger } from '../utils/logger.js';
import { Interface, id as keccak256 } from 'quais';
import { safeBigInt, strictBigInt } from '../utils/bigint.js';
import {
  validateEventArgs,
  validateArray,
  validateAndNormalizeAddress,
  validateBytes32,
} from '../utils/validation.js';
import {
  makeMemberId,
  makeProposalId,
  makeNavigatorId,
  makeGuildTokenId,
  makeRagequitId,
  permissionToLabel,
} from '../utils/addresses.js';

import { evictNavigatorFromCache } from './navigators.js';
import { config, READ_ONLY_NAVIGATOR_TYPES, MODULE_NAVIGATOR_TYPES } from '../config.js';

import INavigatorAbi from '../abis/INavigator.json' with { type: 'json' };
import DAOShipAbi from '../abis/DAOShip.json' with { type: 'json' };

export const daoShipIface = new Interface(DAOShipAbi);
export const iNavIface = new Interface(INavigatorAbi);

// H1: selector for the optional `allowlistRoot()` view. Navigators that
// implement it expose a bytes32 — we cache it at deployment time so allowlist
// posts (poster.ts) can be verified against the DB instead of an RPC call.
// Zero root (0x000…) signals an open allowlist; we normalize it to NULL.
const ALLOWLIST_ROOT_SELECTOR = keccak256('allowlistRoot()').slice(0, 10);
const BYTES32_ZERO = '0x' + '0'.repeat(64);

const MAX_DETAILS_SIZE = 65536; // 64KB — matches poster content limit

/** M5: Strip null bytes + C0/C1 control chars, truncate. Matches poster.ts str(). */
function sanitizeStr(v: string, maxLen: number): string | null {
  const s = v.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, '').slice(0, maxLen);
  return s.length > 0 ? s : null;
}

/** M4: Convert bigint/unknown to Number with bounds check for time-based fields. */
function safeNumber(value: unknown, fieldName: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n > Number.MAX_SAFE_INTEGER || n < 0) {
    logger.warn({ fieldName, raw: String(value) }, `${fieldName} out of safe range, clamping to 0`);
    return 0;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Shared logic for MintShares, MintLoot, BurnShares, and BurnLoot events.
 *
 * Iterates the parallel `addresses` / `amounts` arrays, upserts each member
 * with the adjusted token balance, and updates the DAO-level totals and
 * active-member count.
 */
async function handleMintOrBurn(
  ctx: EventContext,
  daoId: string,
  addresses: string[],
  amounts: bigint[],
  tokenType: 'shares' | 'loot',
  operation: 'mint' | 'burn',
): Promise<void> {
  // Member balances are updated by the Transfer event handler (which fires
  // before MintShares/BurnShares). This handler only updates DAO-level totals.
  // setUp() mints via sharesToken.mint() directly without emitting MintShares,
  // so Transfer is the canonical source for member balances.

  // H4: Defensive length check (arrays come from ABI decoding so should always
  // match, but validates the invariant explicitly like handleRagequit does).
  if (addresses.length !== amounts.length) {
    logger.error({ daoId, addressesLen: addresses.length, amountsLen: amounts.length },
      'handleMintOrBurn: array length mismatch, skipping');
    return;
  }

  // Option B: member balances are authoritative via the Transfer handler's
  // `ds_apply_transfer` call. This handler only flags the DAO as dirty so
  // `ds_recompute_dao_totals` runs once at end-of-range — derive-from-truth
  // from ds_members, guaranteed idempotent under replay.
  // (Unused but kept for parity with the event shape: `operation`,
  // `tokenType`, `amounts` no longer drive any write path here.)
  void operation; void tokenType; void amounts;
  ctx.dirtyDaoIds.add(daoId);
  ctx.cache.invalidateDao(daoId);
}

// ---------------------------------------------------------------------------
// 1. SetupComplete
// ---------------------------------------------------------------------------

export const handleSetupComplete: EventHandler = async (
  ctx: EventContext,
  args: Record<string, unknown>,
): Promise<void> => {
  const daoId = ctx.log.address.toLowerCase();
  validateEventArgs(args, ['lootPaused', 'sharesPaused', 'votingPeriod', 'gracePeriod', 'proposalOffering', 'quorumPercent', 'sponsorThreshold', 'minRetentionPercent', 'defaultExpiryWindow', 'name', 'symbol', 'lootName', 'lootSymbol', 'guildTokens', 'totalShares', 'totalLoot'], 'SetupComplete');

  const lootPaused = Boolean(args.lootPaused);
  const sharesPaused = Boolean(args.sharesPaused);
  const gracePeriod = safeNumber(args.gracePeriod, 'SetupComplete.gracePeriod');
  const votingPeriod = safeNumber(args.votingPeriod, 'SetupComplete.votingPeriod');
  const proposalOffering = safeBigInt(args.proposalOffering).toString();
  const quorumPercent = safeBigInt(args.quorumPercent).toString();
  const sponsorThreshold = safeBigInt(args.sponsorThreshold).toString();
  const minRetentionPercent = safeBigInt(args.minRetentionPercent).toString();
  const defaultExpiryWindow = safeNumber(args.defaultExpiryWindow, 'SetupComplete.defaultExpiryWindow');
  const name = String(args.name).slice(0, 255);
  const symbol = String(args.symbol).slice(0, 32);
  const guildTokens: string[] = validateArray(args.guildTokens, 'guildTokens').map((a) => String(a).toLowerCase());
  const totalShares = safeBigInt(args.totalShares).toString();
  const totalLoot = safeBigInt(args.totalLoot).toString();

  const lootTokenName = String(args.lootName).slice(0, 255);
  const lootTokenSymbol = String(args.lootSymbol).slice(0, 32);

  logger.info({ daoId, name, symbol }, 'SetupComplete');

  // The 15 fields this handler sets are a known merge onto the DAO row.
  // In the common case the launcher's setDao populated the cache with
  // the skeleton in the same range, so fetchDao is a hit; we merge the
  // updates locally and setDao the full row so subsequent NewPost /
  // SubmitProposal handlers in this range hit cache. On a cache miss
  // (e.g., mid-life SetupComplete in a fresh range), fetchDao issues
  // one DB read, still a net win vs. invalidate + re-fetch-later.
  const updates = {
    share_token_name: name,
    share_token_symbol: symbol,
    loot_paused: lootPaused,
    shares_paused: sharesPaused,
    grace_period: gracePeriod,
    voting_period: votingPeriod,
    proposal_offering: proposalOffering,
    quorum_percent: quorumPercent,
    sponsor_threshold: sponsorThreshold,
    min_retention_percent: minRetentionPercent,
    default_expiry_window: defaultExpiryWindow,
    total_shares: totalShares,
    total_loot: totalLoot,
    loot_token_name: lootTokenName,
    loot_token_symbol: lootTokenSymbol,
  };
  const existing = await ctx.cache.fetchDao(daoId, () => ctx.db.getDao(daoId));
  await ctx.db.updateDao(daoId, updates);
  if (existing) {
    ctx.cache.setDao(daoId, { ...existing, ...updates });
  } else {
    // Row didn't exist before this handler (shouldn't happen post-launch
    // but defensive); fall back to invalidate so the next reader fetches
    // the freshly-updated row.
    ctx.cache.invalidateDao(daoId);
  }

  // Insert guild tokens.
  for (const tokenAddr of guildTokens) {
    const guildTokenId = makeGuildTokenId(daoId, tokenAddr);
    await ctx.db.upsert('ds_guild_tokens', {
      id: guildTokenId,
      dao_id: daoId,
      token_address: tokenAddr,
      enabled: true,
      created_at: new Date(ctx.blockTimestamp * 1000).toISOString(),
      tx_hash: ctx.log.transactionHash,
    });
  }
};

// ---------------------------------------------------------------------------
// 2. SubmitProposal
// ---------------------------------------------------------------------------

export const handleSubmitProposal: EventHandler = async (
  ctx: EventContext,
  args: Record<string, unknown>,
): Promise<void> => {
  const daoId = ctx.log.address.toLowerCase();
  validateEventArgs(args, ['proposal', 'proposalDataHash', 'submitter', 'votingPeriod', 'proposalData', 'expiration', 'selfSponsor', 'timestamp', 'details', 'proposalOffering'], 'SubmitProposal');
  // safe: proposal IDs are sequential from 1, overflow at 2^53 (~9 quadrillion) is impossible in practice
  const proposalIdNum = Number(args.proposal);
  const proposalDataHash = validateBytes32(args.proposalDataHash, 'proposalDataHash');
  const submitter = validateAndNormalizeAddress(args.submitter, 'submitter');
  const votingPeriod = safeNumber(args.votingPeriod, 'SubmitProposal.votingPeriod');
  const proposalData = String(args.proposalData);
  const expiration = safeNumber(args.expiration, 'SubmitProposal.expiration');
  const selfSponsor = Boolean(args.selfSponsor);
  const timestamp = safeNumber(args.timestamp, 'SubmitProposal.timestamp');
  let details = String(args.details);
  if (details.length > MAX_DETAILS_SIZE) {
    logger.warn({ daoId, proposalId: proposalIdNum, originalSize: details.length }, 'SubmitProposal details truncated');
    details = details.slice(0, MAX_DETAILS_SIZE);
  }
  const txHash = ctx.log.transactionHash;

  const id = makeProposalId(daoId, proposalIdNum);

  logger.info({ daoId, proposalId: proposalIdNum, submitter, selfSponsor }, 'SubmitProposal');

  const proposalOffering = safeBigInt(args.proposalOffering).toString();

  const createdAt = new Date(timestamp * 1000).toISOString();
  const expirationTs = expiration > 0 ? new Date(expiration * 1000).toISOString() : null;

  await ctx.db.upsertProposal({
    id,
    dao_id: daoId,
    proposal_id: proposalIdNum,
    submitter,
    created_at: createdAt,
    tx_hash: txHash,
    proposal_data_hash: proposalDataHash,
    proposal_data: proposalData,
    voting_period: votingPeriod,
    expiration: expirationTs,
    self_sponsored: selfSponsor,
    details,
    proposal_offering: proposalOffering,
    // Status fields - defaults.
    sponsored: selfSponsor,
    cancelled: false,
    processed: false,
    passed: false,
    action_failed: false,
    yes_balance: '0',
    no_balance: '0',
    yes_votes: 0,
    no_votes: 0,
    max_total_shares_and_loot_at_vote: '0',
    block_number: ctx.log.blockNumber,
  });

  // Atomically increment DAO proposal count (best-effort — non-critical counter).
  try {
    await ctx.db.incrementProposalCount(daoId);
    ctx.cache.invalidateDao(daoId);
  } catch (err) {
    logger.warn({ daoId, err }, 'SubmitProposal - failed to increment proposal count');
  }
};

// ---------------------------------------------------------------------------
// 3. SponsorProposal
// ---------------------------------------------------------------------------

export const handleSponsorProposal: EventHandler = async (
  ctx: EventContext,
  args: Record<string, unknown>,
): Promise<void> => {
  const daoId = ctx.log.address.toLowerCase();
  validateEventArgs(args, ['member', 'proposal', 'votingStarts', 'votingEnds', 'graceEnds', 'maxTotalSharesAtSponsor', 'maxTotalSharesAndLootAtVote'], 'SponsorProposal');
  const memberAddress = validateAndNormalizeAddress(args.member, 'member');
  // safe: proposal IDs are sequential from 1, overflow at 2^53 (~9 quadrillion) is impossible in practice
  const proposalIdNum = Number(args.proposal);
  const votingStarts = safeNumber(args.votingStarts, 'SponsorProposal.votingStarts');
  const votingEnds = new Date(safeNumber(args.votingEnds, 'SponsorProposal.votingEnds') * 1000).toISOString();
  const graceEnds = new Date(safeNumber(args.graceEnds, 'SponsorProposal.graceEnds') * 1000).toISOString();
  const maxTotalSharesAtSponsor = safeBigInt(args.maxTotalSharesAtSponsor).toString();
  const maxTotalSharesAndLootAtVote = safeBigInt(args.maxTotalSharesAndLootAtVote).toString();

  const id = makeProposalId(daoId, proposalIdNum);

  logger.info({ daoId, proposalId: proposalIdNum, sponsor: memberAddress }, 'SponsorProposal');

  await ctx.db.updateProposal(id, {
    sponsored: true,
    sponsor: memberAddress,
    sponsor_tx_hash: ctx.log.transactionHash,
    sponsor_tx_at: new Date(ctx.blockTimestamp * 1000).toISOString(),
    voting_starts: new Date(votingStarts * 1000).toISOString(),
    voting_ends: votingEnds,
    grace_ends: graceEnds,
    max_total_shares_at_sponsor: maxTotalSharesAtSponsor,
    max_total_shares_and_loot_at_vote: maxTotalSharesAndLootAtVote,
  });

  // Update DAO latest_sponsored_proposal_id.
  await ctx.db.updateDao(daoId, {
    latest_sponsored_proposal_id: proposalIdNum,
  });
  ctx.cache.invalidateDao(daoId);
};

// ---------------------------------------------------------------------------
// 4. SubmitVote
// ---------------------------------------------------------------------------

export const handleSubmitVote: EventHandler = async (
  ctx: EventContext,
  args: Record<string, unknown>,
): Promise<void> => {
  const daoId = ctx.log.address.toLowerCase();
  validateEventArgs(args, ['member', 'balance', 'proposal', 'approved'], 'SubmitVote');
  const memberAddress = validateAndNormalizeAddress(args.member, 'member');
  const balance = strictBigInt(args.balance, 'SubmitVote.balance').toString();
  // safe: proposal IDs are sequential from 1, overflow at 2^53 (~9 quadrillion) is impossible in practice
  const proposalIdNum = Number(args.proposal);
  const approved = Boolean(args.approved);

  const proposalId = makeProposalId(daoId, proposalIdNum);
  const memberId = makeMemberId(daoId, memberAddress);
  const voteId = `${proposalId}-${memberAddress}`;

  logger.info(
    { daoId, proposalId: proposalIdNum, member: memberAddress, approved },
    'SubmitVote',
  );

  const now = new Date(ctx.blockTimestamp * 1000).toISOString();

  // E1: Ensure proposal and member rows exist via parallel insert-if-absent.
  // No pre-read — the DB enforces "don't clobber an existing row" via the
  // ignoreDuplicates path. The returned booleans let us preserve the
  // operational data-gap warning when a stub is actually materialized.
  const [proposalInserted, memberInserted] = await Promise.all([
    ctx.db.insertProposalIfAbsent({
      id: proposalId,
      dao_id: daoId,
      proposal_id: proposalIdNum,
      created_at: now,
      submitter: memberAddress,
      tx_hash: ctx.log.transactionHash,
      proposal_data_hash: '0x0000000000000000000000000000000000000000000000000000000000000000',
      voting_period: 0,
      sponsored: false,
      cancelled: false,
      processed: false,
      passed: false,
      action_failed: false,
      yes_balance: '0',
      no_balance: '0',
      yes_votes: 0,
      no_votes: 0,
      max_total_shares_and_loot_at_vote: '0',
      details: '_stub:true',
    }),
    ctx.db.insertMemberIfAbsent({
      id: memberId,
      dao_id: daoId,
      member_address: memberAddress,
      shares: '0',
      loot: '0',
      created_at: now,
      updated_at: now,
    }),
  ]);
  if (proposalInserted) {
    logger.error({ proposalId, daoId }, 'Proposal not found — created stub for orphaned vote (data gap detected)');
  }
  if (memberInserted) {
    // Stub member written — invalidate so any subsequent getMember in this
    // range re-fetches the materialized row. (No proposal cache consumers
    // today, so skip proposal invalidation.)
    ctx.cache.invalidateMember(memberId);
    logger.warn({ memberId, daoId }, 'Member not found — created stub for orphaned vote');
  }

  await ctx.db.upsertVote({
    id: voteId,
    dao_id: daoId,
    proposal_id: proposalId,
    voter: memberAddress,
    approved,
    balance,
    created_at: now,
    tx_hash: ctx.log.transactionHash,
    block_number: ctx.log.blockNumber,
  });

  // Increment proposal vote tallies via RPC function.
  await ctx.db.incrementProposalVotes(proposalId, approved, balance);

  // Increment member vote count. Invalidate the member in the cache so any
  // later handler in the same range re-reads fresh `votes`/`last_activity_at`.
  await ctx.db.incrementMemberVotes(memberId, memberAddress, daoId, now);
  ctx.cache.invalidateMember(memberId);
};

// ---------------------------------------------------------------------------
// 5. ProcessProposal
// ---------------------------------------------------------------------------

export const handleProcessProposal: EventHandler = async (
  ctx: EventContext,
  args: Record<string, unknown>,
): Promise<void> => {
  const daoId = ctx.log.address.toLowerCase();
  validateEventArgs(args, ['proposal', 'passed', 'actionFailed', 'processor'], 'ProcessProposal');
  // safe: proposal IDs are sequential from 1, overflow at 2^53 (~9 quadrillion) is impossible in practice
  const proposalIdNum = Number(args.proposal);
  const passed = Boolean(args.passed);
  const actionFailed = Boolean(args.actionFailed);
  const processedBy = validateAndNormalizeAddress(args.processor, 'processor');

  const id = makeProposalId(daoId, proposalIdNum);

  logger.info({ daoId, proposalId: proposalIdNum, passed, actionFailed }, 'ProcessProposal');

  await ctx.db.updateProposal(id, {
    processed: true,
    passed,
    action_failed: actionFailed,
    processed_by: processedBy,
    process_tx_hash: ctx.log.transactionHash,
    process_tx_at: new Date(ctx.blockTimestamp * 1000).toISOString(),
  });
};

// ---------------------------------------------------------------------------
// 6. CancelProposal
// ---------------------------------------------------------------------------

export const handleCancelProposal: EventHandler = async (
  ctx: EventContext,
  args: Record<string, unknown>,
): Promise<void> => {
  const daoId = ctx.log.address.toLowerCase();
  validateEventArgs(args, ['proposal', 'canceller'], 'CancelProposal');
  // safe: proposal IDs are sequential from 1, overflow at 2^53 (~9 quadrillion) is impossible in practice
  const proposalIdNum = Number(args.proposal);
  const cancelledBy = validateAndNormalizeAddress(args.canceller, 'canceller');

  const id = makeProposalId(daoId, proposalIdNum);

  logger.info({ daoId, proposalId: proposalIdNum }, 'CancelProposal');

  await ctx.db.updateProposal(id, {
    cancelled: true,
    cancelled_by: cancelledBy,
    cancelled_tx_hash: ctx.log.transactionHash,
    cancelled_tx_at: new Date(ctx.blockTimestamp * 1000).toISOString(),
  });
};

// ---------------------------------------------------------------------------
// 7. Ragequit
// ---------------------------------------------------------------------------

export const handleRagequit: EventHandler = async (
  ctx: EventContext,
  args: Record<string, unknown>,
): Promise<void> => {
  const daoId = ctx.log.address.toLowerCase();
  validateEventArgs(args, ['member', 'to', 'lootToBurn', 'sharesToBurn', 'tokens', 'amounts'], 'Ragequit');
  const memberAddress = validateAndNormalizeAddress(args.member, 'member');
  const toAddress = validateAndNormalizeAddress(args.to, 'to');
  const lootToBurn = safeBigInt(args.lootToBurn);
  const sharesToBurn = safeBigInt(args.sharesToBurn);
  const tokens: string[] = validateArray(args.tokens, 'tokens').map(
    (a, i) => validateAndNormalizeAddress(a, `ragequit.tokens[${i}]`),
  );
  const amountsArr: string[] = validateArray(args.amounts, 'amounts').map(
    (a) => safeBigInt(a).toString(),
  );

  // Validate parallel array lengths match
  if (tokens.length !== amountsArr.length) {
    logger.error(
      { daoId, tokensLen: tokens.length, amountsLen: amountsArr.length },
      'Ragequit: tokens/amounts array length mismatch, skipping',
    );
    return;
  }

  const txHash = ctx.log.transactionHash;
  const now = new Date(ctx.blockTimestamp * 1000).toISOString();

  const memberId = makeMemberId(daoId, memberAddress);
  const ragequitId = makeRagequitId(daoId, memberAddress, txHash);

  logger.info(
    { daoId, member: memberAddress, sharesToBurn: sharesToBurn.toString(), lootToBurn: lootToBurn.toString() },
    'Ragequit',
  );

  // E1: Ensure member row exists via insert-if-absent (no pre-read).
  const memberStubInserted = await ctx.db.insertMemberIfAbsent({
    id: memberId,
    dao_id: daoId,
    member_address: memberAddress,
    shares: '0',
    loot: '0',
    created_at: now,
    updated_at: now,
  });
  if (memberStubInserted) {
    ctx.cache.invalidateMember(memberId);
    logger.error({ memberId, daoId }, 'Member not found — created stub for orphaned ragequit (data gap detected)');
  }

  // Record the ragequit event.
  await ctx.db.upsert('ds_ragequits', {
    id: ragequitId,
    dao_id: daoId,
    member_address: memberAddress,
    to_address: toAddress,
    shares_burned: sharesToBurn.toString(),
    loot_burned: lootToBurn.toString(),
    tokens,
    amounts: amountsArr,
    tx_hash: txHash,
    created_at: now,
    block_number: ctx.log.blockNumber,
  });

  // Option B: member balances for the burn go through the Transfer
  // handler (ragequit emits Transfer(from=member, to=0) for both tokens).
  // We only need to flag the DAO dirty so end-of-range recompute updates
  // total_shares / total_loot from source-of-truth ds_members.
  if (sharesToBurn > 0n || lootToBurn > 0n) {
    ctx.dirtyDaoIds.add(daoId);
    ctx.cache.invalidateDao(daoId);
  }
};

// ---------------------------------------------------------------------------
// 7b. NavigatorDeployed (INavigator — emitted once in constructor)
//
// Binds ds_navigators.dao_id from the event's self-asserted `daoShip` for EVERY
// navigator — this is the canonical DAO association; NavigatorSet only ever
// updates permission/is_active afterward (and never arrives for read-only
// navigators). Type-routed:
//   - Read-only type (SignalNavigator): RESOLUTION GATE — ignore entirely if the
//     claimed DAO is unknown (permissionless self-assertion against a junk address
//     is spam). Otherwise create the row complete: permission 0, is_active TRUE
//     (read-only is functional at permission 0), trust_status 'self_asserted'
//     (or 'sanctioned' if a vault sanction intent was already held), and register
//     the navigator so getDaoFromNavigator resolves without RPC.
//   - Module type (BudgetNavigator): a THIRD class — holds no DAOShip permission
//     (no NavigatorSet) and is not read-only (no Poster sanctioning). Its authority
//     is vault MODULE status. Bind dao_id (self-asserted; may be an as-yet-unknown
//     DAO — budget navs can be deployed against a PREDICTED DAO address at launch, so
//     unlike read-only we do NOT apply the resolution gate). Born is_active FALSE +
//     trust_status 'self_asserted'; flipped to 'sanctioned'/is_active TRUE only when
//     the DAO's vault emits EnabledModule (see handlers/vault-modules.ts). Events
//     defer-and-backfill like read-only. A held EnabledModule intent (enable seen
//     before this deploy) is consumed here.
//   - Permissioned type (Onboarder/ERC20Tribute/NFTGated): bind dao_id (self-
//     asserted; may be an as-yet-unknown DAO — dao_id has no FK), is_active FALSE
//     (inert until a NavigatorSet grants permission), trust_status 'sanctioned'
//     (it will be vouched by NavigatorSet; permissioned navs never enter the
//     read-only trust machine).
// ---------------------------------------------------------------------------

export const handleNavigatorDeployed: EventHandler = async (
  ctx: EventContext,
  args: Record<string, unknown>,
): Promise<void> => {
  const navigatorAddress = ctx.log.address.toLowerCase();
  validateEventArgs(args, ['daoShip', 'deployer', 'navigatorType', 'name', 'description'], 'NavigatorDeployed');

  const daoShip = validateAndNormalizeAddress(args.daoShip, 'NavigatorDeployed.daoShip');
  const deployerAddress = validateAndNormalizeAddress(args.deployer, 'NavigatorDeployed.deployer');
  const navigatorType = sanitizeStr(String(args.navigatorType), 50);
  const navName = sanitizeStr(String(args.name), 255);
  const navDescription = sanitizeStr(String(args.description), 1000);

  const isReadOnly = navigatorType !== null && READ_ONLY_NAVIGATOR_TYPES.has(navigatorType);
  const isModule = navigatorType !== null && MODULE_NAVIGATOR_TYPES.has(navigatorType);
  const daoKnown = ctx.registry.getDaoByDaoShipAddress(daoShip) !== undefined;

  // Resolution gate: a read-only navigator's DAO binding is self-asserted and
  // unauthenticated, so we refuse to even record one aimed at a DAO we don't index.
  // (A permissioned navigator against an unknown DAO IS recorded — it stays inert
  // and is prunable at chain head; its NavigatorSet will only ever come from a real DAO.)
  if (isReadOnly && !daoKnown) {
    logger.debug(
      { navigatorAddress, daoShip, navigatorType },
      'NavigatorDeployed: read-only navigator against unknown DAO — ignoring (resolution gate)',
    );
    return;
  }

  const id = makeNavigatorId(daoShip, navigatorAddress);
  const now = new Date(ctx.blockTimestamp * 1000).toISOString();

  // H1: Best-effort cache of allowlistRoot() so allowlist NewPost events can
  // be verified against the DB instead of making per-post RPC calls. The
  // selector may revert on navigators that don't implement it — that's
  // deterministic and expected, not a transient failure.
  let allowlistRoot: string | null = null;
  try {
    const raw = await ctx.blockchain.rawCall(navigatorAddress, ALLOWLIST_ROOT_SELECTOR);
    if (raw && raw.length === 66) {
      const normalized = raw.toLowerCase();
      if (normalized !== BYTES32_ZERO) allowlistRoot = normalized;
    }
  } catch (err) {
    logger.debug(
      { navigatorAddress, err: (err as Error).message },
      'NavigatorDeployed: allowlistRoot() not available (navigator type has no allowlist)',
    );
  }

  // Trust + active born-state, by class:
  //   read-only → self_asserted, is_active TRUE  (functional at permission 0)
  //   module    → self_asserted, is_active FALSE (powerless until vault enables it)
  //   permissioned → sanctioned, is_active FALSE (inert until NavigatorSet grants)
  // For read-only AND module navs a sanction may have been recorded BEFORE we saw the
  // deploy (ordering): a vault daoships.dao.navigators post (read-only) or a vault
  // EnabledModule (module). Both land a row in ds_navigator_sanction_intents keyed
  // (dao, navigator) with the posting/enabling vault — consume + verify it here.
  // (No event backfill is needed: a brand-new navigator has emitted nothing yet.)
  let trustStatus = isReadOnly || isModule ? 'self_asserted' : 'sanctioned';
  let isActive = isReadOnly; // module + permissioned start inert
  if (isReadOnly || isModule) {
    const heldVault = await ctx.db.consumeSanctionIntent(daoShip, navigatorAddress);
    if (heldVault) {
      const dao = ctx.registry.getDaoByDaoShipAddress(daoShip);
      if (dao && heldVault.toLowerCase() === dao.avatar) {
        trustStatus = 'sanctioned';
        if (isModule) isActive = true; // vault enabled it → it can move treasury funds
        logger.info({ navigatorAddress, daoShip, isModule }, 'NavigatorDeployed: applied held vault sanction → sanctioned');
      } else {
        logger.warn({ navigatorAddress, daoShip, heldVault }, 'NavigatorDeployed: held sanction vault mismatch — ignoring intent');
      }
    }
  }

  logger.info(
    { navigatorAddress, daoShip, navigatorType, deployer: deployerAddress, isReadOnly, trustStatus, hasAllowlist: allowlistRoot !== null },
    'NavigatorDeployed',
  );

  await ctx.db.upsert('ds_navigators', {
    id,
    dao_id: daoShip,
    navigator_address: navigatorAddress,
    deployer: deployerAddress,
    navigator_type: navigatorType,
    name: navName,
    description: navDescription,
    permission: 0,
    permission_label: permissionToLabel(0),
    permission_ever_granted: false,
    trust_status: trustStatus,
    // read-only is functional immediately; module is inert until EnabledModule (or a
    // held enable intent flips isActive above); permissioned is inert until NavigatorSet.
    is_active: isActive,
    paused: false,
    allowlist_root: allowlistRoot,
    deploy_block: ctx.log.blockNumber,
    created_at: now,
    tx_hash: ctx.log.transactionHash,
    updated_at: now,
  });

  // Register read-only AND module navigators now: both are discovered exclusively via
  // NavigatorDeployed (no NavigatorSet ever fires), so registering here lets
  // getDaoFromNavigator resolve without an RPC and the vault-module watch resolve a
  // module's DAO. Register module navs even against an unknown (predicted) DAO — the
  // mapping is harmless and the materialization gate still defers until sanctioned.
  // Permissioned navigators are registered on NavigatorSet (permission > 0).
  if (isReadOnly || isModule) {
    ctx.registry.registerNavigator(navigatorAddress, daoShip);
  }
};

// ---------------------------------------------------------------------------
// 8. NavigatorSet
// ---------------------------------------------------------------------------

export const handleNavigatorSet: EventHandler = async (
  ctx: EventContext,
  args: Record<string, unknown>,
): Promise<void> => {
  const daoId = ctx.log.address.toLowerCase();
  validateEventArgs(args, ['navigator', 'permission'], 'NavigatorSet');
  const navigatorAddress = validateAndNormalizeAddress(args.navigator, 'navigator');
  const permission = Number(args.permission);
  // Validate permission is within defined range (bits 0-2); bits 3-7 are reserved
  if (!Number.isFinite(permission) || permission < 0 || permission > 7) {
    logger.warn({ daoId, rawPermission: args.permission }, 'NavigatorSet: invalid permission value, skipping');
    return;
  }

  const daoKnown = ctx.registry.getDaoByDaoShipAddress(daoId) !== undefined;
  const id = makeNavigatorId(daoId, navigatorAddress);
  const now = new Date(ctx.blockTimestamp * 1000).toISOString();

  logger.info(
    { daoId, navigator: navigatorAddress, permission },
    'NavigatorSet',
  );

  // dao_id and metadata (deployer/type/name/description/deploy_block) were already
  // bound by NavigatorDeployed under the same id (dao_id = daoShip = this daoId), so
  // this upsert only moves permission/is_active. Unprovided columns are preserved by
  // the partial upsert; created_at is included for insert-safety in the rare
  // mid-history case where NavigatorSet is somehow seen before NavigatorDeployed.
  const fields: Record<string, unknown> = {
    id,
    dao_id: daoId,
    navigator_address: navigatorAddress,
    permission,
    permission_label: permissionToLabel(permission),
    is_active: permission > 0,
    created_at: now,
    tx_hash: ctx.log.transactionHash,
    updated_at: now,
  };

  if (permission > 0) {
    // First (and every) grant from a KNOWN DAOShip flips the monotonic discriminator
    // and vouches the navigator. Both are idempotent/monotonic, safe to re-set.
    if (daoKnown) fields.permission_ever_granted = true;
    fields.trust_status = 'sanctioned';
  }
  // On revoke (permission == 0) we deliberately OMIT permission_ever_granted and
  // trust_status so their existing values survive. is_active=false + permission=0 +
  // permission_ever_granted=true is exactly the "revoked, keep history" state the
  // prune predicate must never delete — distinguished from a born-read-only nav (false).

  await ctx.db.upsert('ds_navigators', fields);

  // Register navigator for log fetching — only if this NavigatorSet came from a known DAOShip
  if (daoKnown) {
    if (permission > 0) {
      ctx.registry.registerNavigator(navigatorAddress, daoId);
      // Reparent orphaned allowlist records for this specific navigator+DAO pair
      await ctx.db.reparentOrphanedRecords(daoId, navigatorAddress);
    } else {
      ctx.registry.unregisterNavigator(navigatorAddress);
      evictNavigatorFromCache(navigatorAddress);
    }
  }
};

// ---------------------------------------------------------------------------
// 9. GovernanceConfigSet
// ---------------------------------------------------------------------------

export const handleGovernanceConfigSet: EventHandler = async (
  ctx: EventContext,
  args: Record<string, unknown>,
): Promise<void> => {
  const daoId = ctx.log.address.toLowerCase();
  validateEventArgs(args, ['votingPeriod', 'gracePeriod', 'proposalOffering', 'quorumPercent', 'sponsorThreshold', 'minRetentionPercent', 'defaultExpiryWindow'], 'GovernanceConfigSet');

  const votingPeriod = safeNumber(args.votingPeriod, 'GovernanceConfigSet.votingPeriod');
  const gracePeriod = safeNumber(args.gracePeriod, 'GovernanceConfigSet.gracePeriod');
  const proposalOffering = safeBigInt(args.proposalOffering).toString();
  const quorumPercent = safeBigInt(args.quorumPercent).toString();
  const sponsorThreshold = safeBigInt(args.sponsorThreshold).toString();
  const minRetentionPercent = safeBigInt(args.minRetentionPercent).toString();
  const defaultExpiryWindow = safeNumber(args.defaultExpiryWindow, 'GovernanceConfigSet.defaultExpiryWindow');

  logger.info(
    { daoId, votingPeriod, gracePeriod, defaultExpiryWindow },
    'GovernanceConfigSet',
  );

  await ctx.db.updateDao(daoId, {
    voting_period: votingPeriod,
    grace_period: gracePeriod,
    proposal_offering: proposalOffering,
    quorum_percent: quorumPercent,
    sponsor_threshold: sponsorThreshold,
    min_retention_percent: minRetentionPercent,
    default_expiry_window: defaultExpiryWindow,
  });
  ctx.cache.invalidateDao(daoId);

  // Audit feed + timelock-bypass detection. Record every config change keyed by the
  // canonical (tx, logIndex). `bypassed_timelock` is resolved at end-of-range
  // (ds_resolve_timelock_bypass) once any paired TimelockNavigator.ChangeExecuted in the
  // same tx has also been persisted — a ChangeExecuted may sort AFTER this log within the
  // range, so the flag cannot be decided inline. Defaults false until resolved.
  const now = new Date(ctx.blockTimestamp * 1000).toISOString();
  await ctx.db.upsert('ds_governance_config_history', {
    id: `${ctx.log.transactionHash}-${ctx.log.index}`,
    dao_id: daoId,
    voting_period: votingPeriod,
    grace_period: gracePeriod,
    proposal_offering: proposalOffering,
    quorum_percent: quorumPercent,
    sponsor_threshold: sponsorThreshold,
    min_retention_percent: minRetentionPercent,
    default_expiry_window: defaultExpiryWindow,
    tx_hash: ctx.log.transactionHash,
    block_number: ctx.log.blockNumber,
    created_at: now,
  });
  ctx.dirtyTimelockBypassChecks.add(`${daoId}|${ctx.log.transactionHash}`);
};

// ---------------------------------------------------------------------------
// 10. SetGuildTokens
// ---------------------------------------------------------------------------

export const handleSetGuildTokens: EventHandler = async (
  ctx: EventContext,
  args: Record<string, unknown>,
): Promise<void> => {
  const daoId = ctx.log.address.toLowerCase();
  validateEventArgs(args, ['tokens', 'enabled'], 'SetGuildTokens');
  const tokensArr = validateArray(args.tokens, 'tokens');
  const enabledArr = validateArray(args.enabled, 'enabled');
  if (tokensArr.length !== enabledArr.length) {
    logger.error(
      { daoId, tokensLen: tokensArr.length, enabledLen: enabledArr.length },
      'SetGuildTokens: tokens/enabled array length mismatch, skipping',
    );
    return;
  }
  const tokens: string[] = tokensArr.map((a, i) => validateAndNormalizeAddress(a, `tokens[${i}]`));
  const enabled: boolean[] = enabledArr.map((v) => Boolean(v));
  const now = new Date(ctx.blockTimestamp * 1000).toISOString();

  logger.info({ daoId, tokenCount: tokens.length }, 'SetGuildTokens');

  for (let i = 0; i < tokens.length; i++) {
    const tokenAddr = tokens[i];
    const guildTokenId = makeGuildTokenId(daoId, tokenAddr);
    await ctx.db.upsert('ds_guild_tokens', {
      id: guildTokenId,
      dao_id: daoId,
      token_address: tokenAddr,
      enabled: enabled[i],
      created_at: now,
      tx_hash: ctx.log.transactionHash,
    });
  }
};

// ---------------------------------------------------------------------------
// 11-14. MintShares / MintLoot / BurnShares / BurnLoot (SU1)
// ---------------------------------------------------------------------------

/**
 * Factory for the four near-identical mint/burn event handlers. Each one
 * reads a parallel `{addresses, amounts}` array pair from a single named arg
 * and delegates to handleMintOrBurn for DAO-total adjustment.
 */
function makeMintBurnHandler(opts: {
  eventName: 'MintShares' | 'MintLoot' | 'BurnShares' | 'BurnLoot';
  addrField: 'to' | 'from';
  tokenType: 'shares' | 'loot';
  operation: 'mint' | 'burn';
}): EventHandler {
  const { eventName, addrField, tokenType, operation } = opts;
  return async (ctx, args) => {
    const daoId = ctx.log.address.toLowerCase();
    validateEventArgs(args, [addrField, 'amount'], eventName);
    const addresses: string[] = validateArray(args[addrField], addrField)
      .map((a, i) => validateAndNormalizeAddress(a, `${addrField}[${i}]`));
    const amounts: bigint[] = validateArray(args.amount, 'amount')
      .map((a, i) => strictBigInt(a, `${eventName}.amount[${i}]`));

    logger.info({ daoId, count: addresses.length }, eventName);
    await handleMintOrBurn(ctx, daoId, addresses, amounts, tokenType, operation);
  };
}

export const handleMintShares = makeMintBurnHandler({ eventName: 'MintShares', addrField: 'to', tokenType: 'shares', operation: 'mint' });
export const handleMintLoot = makeMintBurnHandler({ eventName: 'MintLoot', addrField: 'to', tokenType: 'loot', operation: 'mint' });
export const handleBurnShares = makeMintBurnHandler({ eventName: 'BurnShares', addrField: 'from', tokenType: 'shares', operation: 'burn' });
export const handleBurnLoot = makeMintBurnHandler({ eventName: 'BurnLoot', addrField: 'from', tokenType: 'loot', operation: 'burn' });

// ---------------------------------------------------------------------------
// 15-17. LockAdmin / LockManager / LockGovernor (SU2)
// ---------------------------------------------------------------------------

/**
 * Factory for the three near-identical lock event handlers. Each one sets a
 * single boolean column on ds_daos based on the `lock` arg.
 */
function makeLockHandler(opts: {
  eventName: 'LockAdmin' | 'LockManager' | 'LockGovernor';
  field: 'admin_locked' | 'manager_locked' | 'governor_locked';
}): EventHandler {
  const { eventName, field } = opts;
  return async (ctx, args) => {
    const daoId = ctx.log.address.toLowerCase();
    validateEventArgs(args, ['lock'], eventName);
    const lock = Boolean(args.lock);

    logger.info({ daoId, lock }, eventName);
    await ctx.db.updateDao(daoId, { [field]: lock });
    ctx.cache.invalidateDao(daoId);
  };
}

export const handleLockAdmin = makeLockHandler({ eventName: 'LockAdmin', field: 'admin_locked' });
export const handleLockManager = makeLockHandler({ eventName: 'LockManager', field: 'manager_locked' });
export const handleLockGovernor = makeLockHandler({ eventName: 'LockGovernor', field: 'governor_locked' });

// ---------------------------------------------------------------------------
// 18. ConvertSharesToLoot
// ---------------------------------------------------------------------------

export const handleConvertSharesToLoot: EventHandler = async (
  ctx: EventContext,
  args: Record<string, unknown>,
): Promise<void> => {
  const daoId = ctx.log.address.toLowerCase();
  validateEventArgs(args, ['from', 'amount'], 'ConvertSharesToLoot');
  const from = validateAndNormalizeAddress(args.from, 'from');
  const amount = strictBigInt(args.amount, 'amount');
  const amountStr = amount.toString();

  logger.info(
    { daoId, member: from, amount: amountStr },
    'ConvertSharesToLoot',
  );

  // Option B: member balances go through Transfer events emitted by
  // sharesToken.burn() + lootToken.mint(). This handler only flags the
  // DAO dirty for end-of-range total recompute.
  ctx.dirtyDaoIds.add(daoId);
  ctx.cache.invalidateDao(daoId);
};

// ---------------------------------------------------------------------------
// 19. AdminConfigSet
// ---------------------------------------------------------------------------

export const handleAdminConfigSet: EventHandler = async (
  ctx: EventContext,
  args: Record<string, unknown>,
): Promise<void> => {
  const daoId = ctx.log.address.toLowerCase();
  validateEventArgs(args, ['sharesPaused', 'lootPaused'], 'AdminConfigSet');
  const sharesPaused = Boolean(args.sharesPaused);
  const lootPaused = Boolean(args.lootPaused);

  logger.info({ daoId, sharesPaused, lootPaused }, 'AdminConfigSet');

  await ctx.db.updateDao(daoId, {
    shares_paused: sharesPaused,
    loot_paused: lootPaused,
  });
  ctx.cache.invalidateDao(daoId);
};
