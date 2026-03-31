import type { EventContext, EventHandler } from './index.js';
import { logger } from '../utils/logger.js';
import { Interface } from 'quais';
import { safeBigInt, strictBigInt, addNumericStrings, subtractNumericStringsFloored } from '../utils/bigint.js';
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
import DAOShipAbi from '../abis/DAOShip.json' with { type: 'json' };

export const daoShipIface = new Interface(DAOShipAbi);

const MAX_DETAILS_SIZE = 65536; // 64KB — matches poster content limit

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

  const sign = operation === 'mint' ? 1n : -1n;
  const daoTotalDelta = amounts.reduce((sum, amt) => sum + amt * sign, 0n);

  const dao = await ctx.db.getDao(daoId);
  if (!dao) {
    logger.warn({ daoId }, 'handleMintOrBurn - DAO not found, skipping total update');
    return;
  }

  const totalField = tokenType === 'shares' ? 'total_shares' : 'total_loot';
  const currentTotalStr = (dao[totalField] as string) || '0';
  const currentTotal = BigInt(currentTotalStr);
  const updatedRaw = currentTotal + daoTotalDelta;
  if (updatedRaw < 0n) {
    logger.warn({ daoId, tokenType, operation, currentTotal: currentTotalStr, daoTotalDelta: daoTotalDelta.toString() }, 'handleMintOrBurn: DAO total would go negative — clamping to 0 (possible reorg or out-of-order event)');
  }
  const updatedTotal = (updatedRaw < 0n ? 0n : updatedRaw).toString();

  await ctx.db.updateDao(daoId, {
    [totalField]: updatedTotal,
  });
}

// ---------------------------------------------------------------------------
// 1. SetupComplete
// ---------------------------------------------------------------------------

export const handleSetupComplete: EventHandler = async (
  ctx: EventContext,
  args: Record<string, unknown>,
): Promise<void> => {
  const daoId = ctx.log.address.toLowerCase();
  validateEventArgs(args, ['lootPaused', 'sharesPaused', 'gracePeriod', 'votingPeriod', 'proposalOffering', 'quorumPercent', 'sponsorThreshold', 'minRetentionPercent', 'name', 'symbol', 'lootName', 'lootSymbol', 'guildTokens', 'totalShares', 'totalLoot'], 'SetupComplete');

  const lootPaused = Boolean(args.lootPaused);
  const sharesPaused = Boolean(args.sharesPaused);
  const gracePeriod = Number(args.gracePeriod);
  const votingPeriod = Number(args.votingPeriod);
  const proposalOffering = safeBigInt(args.proposalOffering).toString();
  const quorumPercent = safeBigInt(args.quorumPercent).toString();
  const sponsorThreshold = safeBigInt(args.sponsorThreshold).toString();
  const minRetentionPercent = safeBigInt(args.minRetentionPercent).toString();
  const name = String(args.name);
  const symbol = String(args.symbol);
  const guildTokens: string[] = validateArray(args.guildTokens, 'guildTokens').map((a) => String(a).toLowerCase());
  const totalShares = safeBigInt(args.totalShares).toString();
  const totalLoot = safeBigInt(args.totalLoot).toString();

  const lootTokenName = String(args.lootName);
  const lootTokenSymbol = String(args.lootSymbol);

  logger.info({ daoId, name, symbol }, 'SetupComplete');

  await ctx.db.updateDao(daoId, {
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
    total_shares: totalShares,
    total_loot: totalLoot,
    loot_token_name: lootTokenName,
    loot_token_symbol: lootTokenSymbol,
  });

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
  const votingPeriod = Number(args.votingPeriod);
  const proposalData = String(args.proposalData);
  const expiration = Number(args.expiration);
  const selfSponsor = Boolean(args.selfSponsor);
  const timestamp = Number(args.timestamp);
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
  const votingStarts = Number(args.votingStarts);
  const votingEnds = new Date(Number(args.votingEnds) * 1000).toISOString();
  const graceEnds = new Date(Number(args.graceEnds) * 1000).toISOString();
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

  // Ensure proposal exists (may be missing if SubmitProposal was in a failed block range).
  const existingProposal = await ctx.db.getProposal(proposalId);
  if (!existingProposal) {
    logger.error({ proposalId, daoId }, 'Proposal not found — creating stub for orphaned vote (data gap detected)');
    await ctx.db.upsertProposal({
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
    });
  }

  // Ensure member exists (they must hold shares to vote, but we upsert defensively).
  const existingMember = await ctx.db.getMember(memberId);
  if (!existingMember) {
    await ctx.db.upsertMember({
      id: memberId,
      dao_id: daoId,
      member_address: memberAddress,
      shares: '0',
      loot: '0',
      created_at: now,
      updated_at: now,
    });
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

  // Increment member vote count.
  await ctx.db.incrementMemberVotes(memberId, memberAddress, daoId, now);
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

  // Ensure member exists (may be missing if MintShares was in a failed block range).
  const existing = await ctx.db.getMember(memberId);
  if (!existing) {
    logger.error({ memberId, daoId }, 'Member not found — creating stub for orphaned ragequit (data gap detected)');
    await ctx.db.upsertMember({
      id: memberId,
      dao_id: daoId,
      member_address: memberAddress,
      shares: '0',
      loot: '0',
      created_at: now,
      updated_at: now,
    });
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

  // Update DAO totals. ragequit() burns shares/loot directly via
  // sharesToken.burn() / lootToken.burn() but does NOT emit BurnShares /
  // BurnLoot events — only Transfer + Ragequit. So this handler is the
  // sole owner of the DAO total adjustment for ragequit operations.
  const dao = await ctx.db.getDao(daoId);
  if (dao) {
    const updates: Record<string, unknown> = {};
    if (sharesToBurn > 0n) {
      updates.total_shares = subtractNumericStringsFloored(dao.total_shares || '0', sharesToBurn.toString());
    }
    if (lootToBurn > 0n) {
      updates.total_loot = subtractNumericStringsFloored(dao.total_loot || '0', lootToBurn.toString());
    }
    if (Object.keys(updates).length > 0) {
      await ctx.db.updateDao(daoId, updates);
    }
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
  // M14: Validate permission is within the 0-255 range DAOShip contracts use
  if (!Number.isFinite(permission) || permission < 0 || permission > 255) {
    logger.warn({ daoId, rawPermission: args.permission }, 'NavigatorSet: invalid permission value, skipping');
    return;
  }

  const id = makeNavigatorId(daoId, navigatorAddress);

  logger.info(
    { daoId, navigator: navigatorAddress, permission },
    'NavigatorSet',
  );

  // Read navigator type from the contract's public constant (one call per registration).
  // Best-effort probe — EOAs and older contracts won't have this function.
  // Uses rawCall (rate-limited, no retry) since BAD_DATA is deterministic.
  let navigatorType: string | null = null;
  if (permission > 0) {
    try {
      const navTypeIface = new Interface(['function navigatorType() view returns (string)']);
      const callData = navTypeIface.encodeFunctionData('navigatorType');
      const result = await ctx.blockchain.rawCall(navigatorAddress, callData);
      if (result && result !== '0x') {
        const decoded = navTypeIface.decodeFunctionResult('navigatorType', result);
        const rawType = String(decoded[0]);
        if (rawType.length > 0) {
          navigatorType = rawType.slice(0, 50);
        }
      }
    } catch {
      // Navigator may not implement navigatorType() — EOAs, older contracts, or custom navigators.
      logger.debug({ navigatorAddress }, 'NavigatorSet: navigatorType() not available');
    }
  }

  await ctx.db.upsert('ds_navigators', {
    id,
    dao_id: daoId,
    navigator_address: navigatorAddress,
    permission,
    permission_label: permissionToLabel(permission),
    is_active: permission > 0,
    navigator_type: navigatorType,
    created_at: new Date(ctx.blockTimestamp * 1000).toISOString(),
    tx_hash: ctx.log.transactionHash,
  });

  // Register navigator for log fetching — only if this NavigatorSet came from a known DAOShip
  if (ctx.registry.getDaoByDaoShipAddress(daoId)) {
    if (permission > 0) {
      ctx.registry.registerNavigator(navigatorAddress, daoId);
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

  const votingPeriod = Number(args.votingPeriod);
  const gracePeriod = Number(args.gracePeriod);
  const proposalOffering = safeBigInt(args.proposalOffering).toString();
  const quorumPercent = safeBigInt(args.quorumPercent).toString();
  const sponsorThreshold = safeBigInt(args.sponsorThreshold).toString();
  const minRetentionPercent = safeBigInt(args.minRetentionPercent).toString();
  const defaultExpiryWindow = Number(args.defaultExpiryWindow);

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
// 11. MintShares
// ---------------------------------------------------------------------------

export const handleMintShares: EventHandler = async (
  ctx: EventContext,
  args: Record<string, unknown>,
): Promise<void> => {
  const daoId = ctx.log.address.toLowerCase();
  validateEventArgs(args, ['to', 'amount'], 'MintShares');
  const addresses: string[] = validateArray(args.to, 'to').map((a, i) => validateAndNormalizeAddress(a, `to[${i}]`));
  const amounts: bigint[] = validateArray(args.amount, 'amount').map((a, i) => strictBigInt(a, `MintShares.amount[${i}]`));

  logger.info({ daoId, count: addresses.length }, 'MintShares');
  await handleMintOrBurn(ctx, daoId, addresses, amounts, 'shares', 'mint');
};

// ---------------------------------------------------------------------------
// 12. MintLoot
// ---------------------------------------------------------------------------

export const handleMintLoot: EventHandler = async (
  ctx: EventContext,
  args: Record<string, unknown>,
): Promise<void> => {
  const daoId = ctx.log.address.toLowerCase();
  validateEventArgs(args, ['to', 'amount'], 'MintLoot');
  const addresses: string[] = validateArray(args.to, 'to').map((a, i) => validateAndNormalizeAddress(a, `to[${i}]`));
  const amounts: bigint[] = validateArray(args.amount, 'amount').map((a, i) => strictBigInt(a, `MintLoot.amount[${i}]`));

  logger.info({ daoId, count: addresses.length }, 'MintLoot');
  await handleMintOrBurn(ctx, daoId, addresses, amounts, 'loot', 'mint');
};

// ---------------------------------------------------------------------------
// 13. BurnShares
// ---------------------------------------------------------------------------

export const handleBurnShares: EventHandler = async (
  ctx: EventContext,
  args: Record<string, unknown>,
): Promise<void> => {
  const daoId = ctx.log.address.toLowerCase();
  validateEventArgs(args, ['from', 'amount'], 'BurnShares');
  const addresses: string[] = validateArray(args.from, 'from').map((a, i) => validateAndNormalizeAddress(a, `from[${i}]`));
  const amounts: bigint[] = validateArray(args.amount, 'amount').map((a, i) => strictBigInt(a, `BurnShares.amount[${i}]`));

  logger.info({ daoId, count: addresses.length }, 'BurnShares');
  await handleMintOrBurn(ctx, daoId, addresses, amounts, 'shares', 'burn');
};

// ---------------------------------------------------------------------------
// 14. BurnLoot
// ---------------------------------------------------------------------------

export const handleBurnLoot: EventHandler = async (
  ctx: EventContext,
  args: Record<string, unknown>,
): Promise<void> => {
  const daoId = ctx.log.address.toLowerCase();
  validateEventArgs(args, ['from', 'amount'], 'BurnLoot');
  const addresses: string[] = validateArray(args.from, 'from').map((a, i) => validateAndNormalizeAddress(a, `from[${i}]`));
  const amounts: bigint[] = validateArray(args.amount, 'amount').map((a, i) => strictBigInt(a, `BurnLoot.amount[${i}]`));

  logger.info({ daoId, count: addresses.length }, 'BurnLoot');
  await handleMintOrBurn(ctx, daoId, addresses, amounts, 'loot', 'burn');
};

// ---------------------------------------------------------------------------
// 15. LockAdmin
// ---------------------------------------------------------------------------

export const handleLockAdmin: EventHandler = async (
  ctx: EventContext,
  args: Record<string, unknown>,
): Promise<void> => {
  const daoId = ctx.log.address.toLowerCase();
  validateEventArgs(args, ['lock'], 'LockAdmin');
  const lock = Boolean(args.lock);

  logger.info({ daoId, lock }, 'LockAdmin');
  await ctx.db.updateDao(daoId, { admin_locked: lock });
};

// ---------------------------------------------------------------------------
// 16. LockManager
// ---------------------------------------------------------------------------

export const handleLockManager: EventHandler = async (
  ctx: EventContext,
  args: Record<string, unknown>,
): Promise<void> => {
  const daoId = ctx.log.address.toLowerCase();
  validateEventArgs(args, ['lock'], 'LockManager');
  const lock = Boolean(args.lock);

  logger.info({ daoId, lock }, 'LockManager');
  await ctx.db.updateDao(daoId, { manager_locked: lock });
};

// ---------------------------------------------------------------------------
// 17. LockGovernor
// ---------------------------------------------------------------------------

export const handleLockGovernor: EventHandler = async (
  ctx: EventContext,
  args: Record<string, unknown>,
): Promise<void> => {
  const daoId = ctx.log.address.toLowerCase();
  validateEventArgs(args, ['lock'], 'LockGovernor');
  const lock = Boolean(args.lock);

  logger.info({ daoId, lock }, 'LockGovernor');
  await ctx.db.updateDao(daoId, { governor_locked: lock });
};

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
  const memberId = makeMemberId(daoId, from);

  logger.info(
    { daoId, member: from, amount: amountStr },
    'ConvertSharesToLoot',
  );

  // Member balances are updated by the Transfer events that fire when
  // sharesToken.burn() and lootToken.mint() are called internally by the
  // contract. This handler only updates DAO-level totals — same ownership
  // split as MintShares/BurnShares handlers.
  //
  // Note: convertSharesToLoot does NOT emit BurnShares or MintLoot, so
  // handleMintOrBurn won't fire for these. This handler is the sole owner
  // of the DAO total adjustment for this operation.
  const dao = await ctx.db.getDao(daoId);
  if (dao) {
    await ctx.db.updateDao(daoId, {
      total_shares: subtractNumericStringsFloored(dao.total_shares || '0', amountStr),
      total_loot: addNumericStrings(dao.total_loot || '0', amountStr),
    });
  }
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
};
