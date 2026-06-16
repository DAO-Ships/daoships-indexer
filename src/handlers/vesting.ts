import { Interface } from 'quais';
import type { EventContext } from './index.js';
import { bigintToString, safeBigInt } from '../utils/bigint.js';
import { logger } from '../utils/logger.js';
import { validateEventArgs, validateAndNormalizeAddress } from '../utils/validation.js';
import { getDaoFromNavigator } from './navigators.js';

import VestingNavigatorAbi from '../abis/VestingNavigator.json' with { type: 'json' };

export const vestingNavigatorIface = new Interface(VestingNavigatorAbi);

// ── VestingNavigator (MANAGER-permissioned cliff+linear vesting) ──────────────────
// Three events on a per-navigator scheduleId (starts at 0):
//   ScheduleCreated(uint256 scheduleId, address beneficiary, uint256 totalAmount,
//                   uint64 startTime, uint64 cliffEnd, uint64 vestingEnd, bool isLoot)
//   TokensClaimed(uint256 scheduleId, address beneficiary, uint256 amount, bool isLoot)
//   ScheduleRevoked(uint256 scheduleId, address caller, uint64 revokedAt, uint256 vestedAtRevoke)
//
// Schedules are keyed {navigator_address}-{schedule_id}; the DAO is resolved from the navigator.
// PERMISSIONED → trust implicit (no defer/backfill gate). Status/claimable are time-derived
// in the app. `claimed` is DERIVE-FROM-TRUTH: TokensClaimed.amount is INCREMENTAL, so we append
// a claim row and recompute claimed = SUM(claims) once per schedule at end-of-range (never
// increment inline → replay-safe). Member balances come from the paired MintShares/MintLoot
// Transfer in the same tx, NOT from TokensClaimed (would double-count).

function makeScheduleId(navigatorAddress: string, scheduleId: string): string {
  return `${navigatorAddress.toLowerCase()}-${scheduleId}`;
}

function makeClaimId(txHash: string, logIndex: number): string {
  return `${txHash}-${logIndex}`;
}

// ── ScheduleCreated ───────────────────────────────────────────────────────────────

export async function handleScheduleCreated(
  ctx: EventContext,
  args: Record<string, unknown>,
): Promise<void> {
  validateEventArgs(
    args,
    ['scheduleId', 'beneficiary', 'totalAmount', 'startTime', 'cliffEnd', 'vestingEnd', 'isLoot'],
    'ScheduleCreated',
  );
  const navigatorAddress = ctx.log.address.toLowerCase();
  const daoId = await getDaoFromNavigator(ctx, navigatorAddress);
  if (!daoId) {
    logger.warn({ navigatorAddress }, 'ScheduleCreated: could not resolve DAO for navigator, skipping');
    return;
  }

  const scheduleId = bigintToString(safeBigInt(args.scheduleId));
  const beneficiary = validateAndNormalizeAddress(args.beneficiary, 'beneficiary');
  const totalAmount = bigintToString(safeBigInt(args.totalAmount));
  const startTime = Number(safeBigInt(args.startTime));
  const cliffEnd = Number(safeBigInt(args.cliffEnd));
  const vestingEnd = Number(safeBigInt(args.vestingEnd));
  const isLoot = Boolean(args.isLoot);
  const now = new Date(ctx.blockTimestamp * 1000).toISOString();

  // NB: `claimed`, `revoked`, `revoked_at`, `vested_at_revoke` are OMITTED so a re-dispatch of
  // ScheduleCreated never clobbers a later ScheduleRevoked or the derived claimed total. On first
  // INSERT they take column DEFAULTs (claimed=0, revoked=false).
  await ctx.db.upsert('ds_vesting_schedules', {
    id: makeScheduleId(navigatorAddress, scheduleId),
    dao_id: daoId,
    navigator_address: navigatorAddress,
    schedule_id: scheduleId,
    beneficiary,
    total_amount: totalAmount,
    is_loot: isLoot,
    start_time: startTime,
    cliff_end: cliffEnd,
    vesting_end: vestingEnd,
    tx_hash: ctx.log.transactionHash,
    block_number: ctx.log.blockNumber,
    created_at: now,
    updated_at: now,
  });

  logger.info({ navigatorAddress, daoId, scheduleId, isLoot, totalAmount }, 'ScheduleCreated indexed');
}

// ── TokensClaimed ─────────────────────────────────────────────────────────────────

export async function handleTokensClaimed(
  ctx: EventContext,
  args: Record<string, unknown>,
): Promise<void> {
  validateEventArgs(args, ['scheduleId', 'beneficiary', 'amount', 'isLoot'], 'TokensClaimed');
  const navigatorAddress = ctx.log.address.toLowerCase();
  const daoId = await getDaoFromNavigator(ctx, navigatorAddress);
  if (!daoId) {
    logger.warn({ navigatorAddress }, 'TokensClaimed: could not resolve DAO for navigator, skipping');
    return;
  }

  const scheduleId = bigintToString(safeBigInt(args.scheduleId));
  const beneficiary = validateAndNormalizeAddress(args.beneficiary, 'beneficiary');
  const amount = bigintToString(safeBigInt(args.amount)); // INCREMENTAL amount minted this claim
  const isLoot = Boolean(args.isLoot);
  const schedulePk = makeScheduleId(navigatorAddress, scheduleId);
  const now = new Date(ctx.blockTimestamp * 1000).toISOString();

  // Append-only feed row keyed by canonical (tx, logIndex) → idempotent on replay/reorg.
  // The schedule_pk FK requires the parent row; ScheduleCreated always precedes on-chain.
  await ctx.db.upsert('ds_vesting_claims', {
    id: makeClaimId(ctx.log.transactionHash, ctx.log.index),
    schedule_pk: schedulePk,
    dao_id: daoId,
    navigator_address: navigatorAddress,
    schedule_id: scheduleId,
    beneficiary,
    amount,
    is_loot: isLoot,
    tx_hash: ctx.log.transactionHash,
    block_number: ctx.log.blockNumber,
    created_at: now,
  });

  // Defer the cumulative `claimed` recompute to the end-of-range derive-from-truth flush
  // (ds_recompute_vesting_claimed) — never increment inline (would double-count on replay).
  ctx.dirtyVestingScheduleIds.add(schedulePk);

  logger.info({ navigatorAddress, daoId, scheduleId, beneficiary, amount, isLoot }, 'TokensClaimed indexed');
}

// ── ScheduleRevoked ───────────────────────────────────────────────────────────────

export async function handleScheduleRevoked(
  ctx: EventContext,
  args: Record<string, unknown>,
): Promise<void> {
  validateEventArgs(args, ['scheduleId', 'caller', 'revokedAt', 'vestedAtRevoke'], 'ScheduleRevoked');
  const navigatorAddress = ctx.log.address.toLowerCase();
  const scheduleId = bigintToString(safeBigInt(args.scheduleId));
  const revokedAt = Number(safeBigInt(args.revokedAt));
  const vestedAtRevoke = bigintToString(safeBigInt(args.vestedAtRevoke));
  const now = new Date(ctx.blockTimestamp * 1000).toISOString();

  // Targeted UPDATE (never insert): a revoke for a non-materialized schedule is a no-op.
  await ctx.db.updateVestingSchedule(makeScheduleId(navigatorAddress, scheduleId), {
    revoked: true,
    revoked_at: revokedAt,
    vested_at_revoke: vestedAtRevoke,
    updated_at: now,
  });

  logger.info({ navigatorAddress, scheduleId, revokedAt }, 'ScheduleRevoked indexed');
}
