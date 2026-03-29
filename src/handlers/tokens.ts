import { Interface } from 'quais';
import type { EventContext } from './index.js';
import { makeMemberId } from '../utils/addresses.js';
import { addNumericStrings, subtractNumericStringsFloored, wouldClamp, bigintToString, safeBigInt, strictBigInt } from '../utils/bigint.js';
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
  const field = isShares ? 'shares' : 'loot';
  const otherField = isShares ? 'loot' : 'shares';
  const valueStr = bigintToString(value);
  const now = new Date(ctx.blockTimestamp * 1000).toISOString();
  let activeMemberDelta = 0;

  // ── Debit sender (skip for mints where from is zero address) ──

  if (from !== ZERO_ADDRESS) {
    const senderId = makeMemberId(daoId, from);
    const sender = await ctx.db.getMember(senderId);
    const senderOldBalance = (sender?.[field] as string) || '0';
    const senderOtherBalance = (sender?.[otherField] as string) || '0';
    if (wouldClamp(senderOldBalance, valueStr)) {
      logger.warn({ daoId, from, field, senderOldBalance, valueStr }, 'Transfer: sender balance would go negative — clamping to 0 (possible reorg or out-of-order event)');
    }
    const senderNewBalance = subtractNumericStringsFloored(senderOldBalance, valueStr);

    const oldTotal = BigInt(senderOldBalance) + BigInt(senderOtherBalance);
    const newTotal = BigInt(senderNewBalance) + BigInt(senderOtherBalance);
    if (oldTotal > 0n && newTotal === 0n) activeMemberDelta -= 1;

    await ctx.db.upsertMember({
      id: senderId,
      dao_id: daoId,
      member_address: from,
      [field]: senderNewBalance,
      created_at: sender ? (sender.created_at as string) : now,
      last_activity_at: now,
    });
  }

  // ── Credit receiver (skip for burns where to is zero address) ─

  if (to !== ZERO_ADDRESS) {
    const receiverId = makeMemberId(daoId, to);
    const receiver = await ctx.db.getMember(receiverId);
    const receiverOldBalance = (receiver?.[field] as string) || '0';
    const receiverOtherBalance = (receiver?.[otherField] as string) || '0';
    const receiverNewBalance = addNumericStrings(receiverOldBalance, valueStr);

    const oldTotal = BigInt(receiverOldBalance) + BigInt(receiverOtherBalance);
    const newTotal = BigInt(receiverNewBalance) + BigInt(receiverOtherBalance);
    if (oldTotal === 0n && newTotal > 0n) activeMemberDelta += 1;

    await ctx.db.upsertMember({
      id: receiverId,
      dao_id: daoId,
      member_address: to,
      [field]: receiverNewBalance,
      created_at: receiver ? (receiver.created_at as string) : now,
      last_activity_at: now,
    });
  }

  // Atomically update DAO active member count if transitions occurred (best-effort — non-critical counter).
  if (activeMemberDelta !== 0) {
    try {
      await ctx.db.updateActiveMemberCount(daoId, activeMemberDelta);
    } catch (err) {
      logger.warn({ daoId, activeMemberDelta, err }, 'Transfer - failed to update active member count');
    }
  }

  const kind = from === ZERO_ADDRESS ? 'mint' : to === ZERO_ADDRESS ? 'burn' : 'transfer';
  logger.info({ daoId, from, to, value: valueStr, field, kind }, 'Token transfer');
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

  // Insert delegation record (SERIAL PK — always insert, never upsert)
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
    last_activity_at: now,
  });

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
    last_activity_at: now,
  });

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
    logger.info({ daoId: tokenDaoId, field }, `Token ${label}`);
    return;
  }

  const navDaoId = ctx.registry.getDaoByNavigatorAddress(addr);
  if (navDaoId) {
    await ctx.db.updateNavigator(`${navDaoId}-${addr}`, { paused });
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
