import { Interface } from 'quais';
import type { EventContext } from './index.js';
import { makeMemberId } from '../utils/addresses.js';
import { bigintToString, safeBigInt, strictBigInt } from '../utils/bigint.js';
import { logger } from '../utils/logger.js';
import { validateEventArgs, validateAndNormalizeAddress } from '../utils/validation.js';

import SharesAbi from '../abis/SharesERC20.json' with { type: 'json' };

// M10: LootERC20 has a separate ABI but shares the same event topic0 hashes
// as SharesERC20 for all events we handle. lootIface was unused; sharesIface
// handles both token types via topic0 matching in the dispatcher.
export const sharesIface = new Interface(SharesAbi);

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

// ── Transfer ────────────────────────────────────────────────────
// Transfer(address indexed from, address indexed to, uint256 value)
// Same topic0 on both SharesERC20 and LootERC20.
// Handles ALL transfers: mints (from=0), burns (to=0), and member-to-member.
// DAOShip MintShares/BurnShares events only update DAO-level totals — member
// balances are always tracked here since setUp() mints via sharesToken.mint()
// directly without emitting MintShares.

/**
 * Option B — atomic, idempotent Transfer handler.
 *
 * All balance math + active-member-delta computation + log-dedup happens
 * server-side inside `ds_apply_transfer`. The handler is strictly a
 * dispatcher into the RPC — no client-side read-modify-write, no ordering
 * races between debit and credit. Replay safety is guaranteed by the
 * RPC's `INSERT INTO ds_processed_logs ON CONFLICT DO NOTHING` claim.
 *
 * Consequences of this design:
 *   - The RangeCache no longer mirrors member balance writes from here —
 *     the server-side math is the authoritative source. We invalidate on
 *     touched members so any subsequent read in this range re-fetches
 *     the fresh row.
 *   - `updateActiveMemberCount` is no longer called directly; the RPC
 *     returns `active_member_delta` and the handler queues the daoId for
 *     the end-of-range `ds_recompute_dao_totals` flush (which also
 *     derives active_member_count via `ds_update_active_member_count`
 *     triggered implicitly, OR we can call updateActiveMemberCount
 *     immediately since it's already idempotent — see below).
 *   - The handler is marked `idempotent: true` in the dispatcher.
 */
export async function handleTransfer(
  ctx: EventContext,
  args: Record<string, unknown>,
): Promise<void> {
  validateEventArgs(args, ['from', 'to', 'value'], 'Transfer');
  const from: string = validateAndNormalizeAddress(args.from, 'from');
  const to: string = validateAndNormalizeAddress(args.to, 'to');
  const value: bigint = strictBigInt(args.value, 'Transfer.value');

  const tokenAddress = ctx.log.address.toLowerCase();
  const daoId = ctx.registry.getDaoByTokenAddress(tokenAddress);
  if (!daoId) {
    logger.warn({ tokenAddress }, 'Transfer: unknown token address, skipping');
    return;
  }

  const isShares = ctx.registry.isSharesToken(tokenAddress);
  const valueStr = bigintToString(value);
  const timestamp = new Date(ctx.blockTimestamp * 1000);

  const { alreadyProcessed, activeMemberDelta } = await ctx.db.applyTransfer({
    txHash: ctx.log.transactionHash,
    logIndex: ctx.log.index,
    blockNumber: ctx.log.blockNumber,
    daoId,
    fromAddress: from,
    toAddress: to,
    value: valueStr,
    isShares,
    timestamp,
  });

  if (alreadyProcessed) {
    logger.debug(
      { txHash: ctx.log.transactionHash, logIndex: ctx.log.index },
      'Transfer: already processed (idempotent replay short-circuit)',
    );
    return;
  }

  // Invalidate cache entries for touched members so the next same-range
  // read sees the server's authoritative post-write row instead of our
  // stale pre-RPC snapshot (which we never loaded under Option B).
  const hasSender = from !== ZERO_ADDRESS;
  const hasReceiver = to !== ZERO_ADDRESS;
  if (hasSender) ctx.cache.invalidateMember(makeMemberId(daoId, from));
  if (hasReceiver && from !== to) ctx.cache.invalidateMember(makeMemberId(daoId, to));

  // Apply the membership count delta via the existing idempotent
  // (derive-from-truth) RPC. The delta value is only used as a hint for
  // log output; the RPC itself recomputes from ds_members.
  if (activeMemberDelta !== 0) {
    try {
      await ctx.db.updateActiveMemberCount(daoId, activeMemberDelta);
      ctx.cache.invalidateDao(daoId);
    } catch (err) {
      logger.warn({ daoId, activeMemberDelta, err }, 'Transfer - failed to update active member count');
    }
  }

  // Queue for end-of-range total_shares / total_loot recompute. Cheap —
  // deduped into a Set by the processor.
  ctx.dirtyDaoIds.add(daoId);

  const kind = from === ZERO_ADDRESS ? 'mint' : to === ZERO_ADDRESS ? 'burn' : 'transfer';
  logger.info(
    { daoId, from, to, value: valueStr, field: isShares ? 'shares' : 'loot', kind, activeMemberDelta },
    'Token transfer applied via ds_apply_transfer',
  );
}

// ── DelegateChanged ─────────────────────────────────────────────
// DelegateChanged(address indexed delegator, address indexed fromDelegate, address indexed toDelegate)
// Only on SharesERC20 (LootERC20 does NOT have delegation).

export async function handleDelegateChanged(
  ctx: EventContext,
  args: Record<string, unknown>,
): Promise<void> {
  validateEventArgs(args, ['delegator', 'fromDelegate', 'toDelegate'], 'DelegateChanged');
  const delegator: string = validateAndNormalizeAddress(args.delegator, 'delegator');
  const fromDelegate: string = validateAndNormalizeAddress(args.fromDelegate, 'fromDelegate');
  const toDelegate: string = validateAndNormalizeAddress(args.toDelegate, 'toDelegate');

  const tokenAddress = ctx.log.address.toLowerCase();
  const daoId = ctx.registry.getDaoByTokenAddress(tokenAddress);
  if (!daoId) {
    logger.warn({ tokenAddress }, 'DelegateChanged: unknown token address, skipping');
    return;
  }

  const now = new Date(ctx.blockTimestamp * 1000).toISOString();

  // Option B: the ds_delegations table has a unique index on
  // (tx_hash, delegator). A retry of this log after partial commit
  // would otherwise insert a duplicate SERIAL-PK row; the index makes
  // it fail with 23505, which `DatabaseService.insert` swallows as an
  // idempotent no-op.
  await ctx.db.insert('ds_delegations', {
    dao_id: daoId,
    delegator,
    from_delegate: fromDelegate,
    to_delegate: toDelegate,
    tx_hash: ctx.log.transactionHash,
    created_at: now,
  });

  // Update member's delegating_to field (null if self-delegating)
  const memberId = makeMemberId(daoId, delegator);
  const delegatingTo = toDelegate === delegator ? null : toDelegate;

  await ctx.db.upsertMember({
    id: memberId,
    dao_id: daoId,
    member_address: delegator,
    delegating_to: delegatingTo,
    created_at: now,
    updated_at: now,
    last_activity_at: now,
  });
  // Partial upsert — don't cache the partial shape. Invalidate so the next
  // read re-fetches the merged row from DB.
  ctx.cache.invalidateMember(memberId);

  logger.info(
    { daoId, delegator, fromDelegate, toDelegate },
    'Delegate changed',
  );
}

// ── DelegateVotesChanged ────────────────────────────────────────
// DelegateVotesChanged(address indexed delegate, uint256 previousBalance, uint256 newBalance)
// Only on SharesERC20.

export async function handleDelegateVotesChanged(
  ctx: EventContext,
  args: Record<string, unknown>,
): Promise<void> {
  validateEventArgs(args, ['delegate', 'newBalance'], 'DelegateVotesChanged');
  const delegate: string = validateAndNormalizeAddress(args.delegate, 'delegate');
  const newBalance: bigint = safeBigInt(args.newBalance);

  const tokenAddress = ctx.log.address.toLowerCase();
  const daoId = ctx.registry.getDaoByTokenAddress(tokenAddress);
  if (!daoId) {
    logger.warn({ tokenAddress }, 'DelegateVotesChanged: unknown token address, skipping');
    return;
  }

  const memberId = makeMemberId(daoId, delegate);
  const now = new Date(ctx.blockTimestamp * 1000).toISOString();

  await ctx.db.upsertMember({
    id: memberId,
    dao_id: daoId,
    member_address: delegate,
    voting_power: bigintToString(newBalance),
    created_at: now,
    updated_at: now,
    last_activity_at: now,
  });
  ctx.cache.invalidateMember(memberId);

  logger.info(
    { daoId, delegate, newBalance: bigintToString(newBalance) },
    'Delegate votes changed',
  );
}

// ── Paused / Unpaused ───────────────────────────────────────────
// Same topic0 on SharesERC20, LootERC20, and navigator contracts.

async function handlePauseState(ctx: EventContext, paused: boolean): Promise<void> {
  const addr = ctx.log.address.toLowerCase();
  const label = paused ? 'paused' : 'unpaused';

  const tokenDaoId = ctx.registry.getDaoByTokenAddress(addr);
  if (tokenDaoId) {
    const field = ctx.registry.isSharesToken(addr) ? 'shares_paused' : 'loot_paused';
    await ctx.db.updateDao(tokenDaoId, { [field]: paused });
    ctx.cache.invalidateDao(tokenDaoId);
    logger.info({ daoId: tokenDaoId, field }, `Token ${label}`);
    return;
  }

  const navDaoId = ctx.registry.getDaoByNavigatorAddress(addr);
  if (navDaoId) {
    await ctx.db.updateNavigator(`${navDaoId}-${addr}`, { paused, updated_at: new Date(ctx.blockTimestamp * 1000).toISOString() });
    logger.info({ daoId: navDaoId, navigator: addr }, `Navigator ${label}`);
    return;
  }

  logger.warn({ tokenAddress: addr }, `${label}: unknown address, skipping`);
}

export async function handlePaused(ctx: EventContext, _args: Record<string, unknown>): Promise<void> {
  await handlePauseState(ctx, true);
}

export async function handleUnpaused(ctx: EventContext, _args: Record<string, unknown>): Promise<void> {
  await handlePauseState(ctx, false);
}
