import { Interface } from 'quais';
import type { EventContext } from './index.js';
import { bigintToString, safeBigInt } from '../utils/bigint.js';
import { logger } from '../utils/logger.js';
import { validateEventArgs, validateAndNormalizeAddress } from '../utils/validation.js';
import { getDaoFromNavigator } from './navigators.js';

import SubscriptionNavigatorAbi from '../abis/SubscriptionNavigator.json' with { type: 'json' };

export const subscriptionNavigatorIface = new Interface(SubscriptionNavigatorAbi);

// ── SubscriptionNavigator (MANAGER-permissioned recurring membership dues) ────────────
// Three events, membership keyed by (navigator_address, member) — there is NO per-member id;
// `paid_through` is the whole state (0 ⇒ not enrolled / collected):
//   MemberEnrolled(address member, uint256 paidThrough)
//   FeePaid(address member, address payer, address token,
//           uint256 amount, uint256 periods, uint256 paidThrough)   // token 0x0 = native QUAI
//   FeeCollected(address member, address collector,
//                uint256 sharesRemoved, uint256 reward, bool burned) // burned: true=burn, false=convert
//
// PERMISSIONED (the STANDARD path, unlike Budget's vault-module case): registered via
// setNavigators([nav],[2]) → NavigatorSet fires → trust_status='sanctioned'. Discovery + DAO
// binding come from NavigatorDeployed, resolved here via getDaoFromNavigator. No defer/backfill
// gate (mirrors Vesting/Timelock); trust is enforced in the APP (default views to sanctioned).
//
// `total_paid` is DERIVE-FROM-TRUTH: FeePaid.amount is per-payment, so each FeePaid appends a
// ds_subscription_payments row and flags the member dirty; the processor recomputes
// total_paid = SUM(payments.amount) once per touched member at end-of-range
// (ds_recompute_subscription_paid). NEVER `+= amount` inline (double-counts on replay). The
// member's `paid_through` is the event's new ABSOLUTE value — ASSIGN it, never add. Treasury
// BALANCES come from the paired core events (ERC20/native Transfer into the vault on payFee;
// ConvertSharesToLoot/BurnShares + MintLoot on collectFee), NOT from these activity feeds.

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/** FeePaid token may be the zero address (native QUAI), which is not a valid shard address. */
function normalizeTokenAddress(v: unknown): string {
  if (typeof v === 'string' && v.toLowerCase() === ZERO_ADDRESS) return ZERO_ADDRESS;
  return validateAndNormalizeAddress(v, 'token');
}

function makeMemberPk(navigatorAddress: string, member: string): string {
  return `${navigatorAddress.toLowerCase()}-${member.toLowerCase()}`;
}

function makeFeedId(navigatorAddress: string, member: string, txHash: string, logIndex: number): string {
  return `${navigatorAddress.toLowerCase()}-${member.toLowerCase()}-${txHash}-${logIndex}`;
}

// ── MemberEnrolled ────────────────────────────────────────────────────────────────────
// Governance enroll/enrollBatch and the _initialMembers stamp at construction (the
// complimentary-period grant). A member's first payFee SELF-enrolls WITHOUT this event — the
// FeePaid handler upsert-creates the row too.

export async function handleMemberEnrolled(
  ctx: EventContext,
  args: Record<string, unknown>,
): Promise<void> {
  validateEventArgs(args, ['member', 'paidThrough'], 'MemberEnrolled');
  const navigatorAddress = ctx.log.address.toLowerCase();
  const daoId = await getDaoFromNavigator(ctx, navigatorAddress);
  if (!daoId) {
    logger.warn({ navigatorAddress }, 'MemberEnrolled: could not resolve DAO for navigator, skipping');
    return;
  }

  const member = validateAndNormalizeAddress(args.member, 'member');
  const paidThrough = Number(safeBigInt(args.paidThrough));
  const now = new Date(ctx.blockTimestamp * 1000).toISOString();

  // NB: `total_paid` (derive-from-truth via ds_recompute_subscription_paid) and
  // `last_collected_at` (set only by FeeCollected) are OMITTED so a re-dispatch of
  // MemberEnrolled never clobbers a later collection or the derived paid total. On first
  // INSERT they take column DEFAULTs (total_paid=0, last_collected_at=NULL). `paid_through`
  // is the new absolute value — assigned, not added (it monotonically advances on-chain).
  await ctx.db.upsert('ds_subscription_members', {
    id: makeMemberPk(navigatorAddress, member),
    dao_id: daoId,
    navigator_address: navigatorAddress,
    member,
    paid_through: paidThrough,
    tx_hash: ctx.log.transactionHash,
    created_at: now,
    updated_at: now,
  });

  logger.info({ navigatorAddress, daoId, member, paidThrough }, 'MemberEnrolled indexed');
}

// ── FeePaid ───────────────────────────────────────────────────────────────────────────

export async function handleFeePaid(
  ctx: EventContext,
  args: Record<string, unknown>,
): Promise<void> {
  validateEventArgs(args, ['member', 'payer', 'token', 'amount', 'periods', 'paidThrough'], 'FeePaid');
  const navigatorAddress = ctx.log.address.toLowerCase();
  const daoId = await getDaoFromNavigator(ctx, navigatorAddress);
  if (!daoId) {
    logger.warn({ navigatorAddress }, 'FeePaid: could not resolve DAO for navigator, skipping');
    return;
  }

  const member = validateAndNormalizeAddress(args.member, 'member');
  const payer = validateAndNormalizeAddress(args.payer, 'payer');   // payFeeFor → differs from member
  const token = normalizeTokenAddress(args.token);                  // 0x0 = native QUAI
  const amount = bigintToString(safeBigInt(args.amount));           // per-payment; SUM for cumulative
  const periods = bigintToString(safeBigInt(args.periods));
  const paidThrough = Number(safeBigInt(args.paidThrough));         // new ABSOLUTE value
  const memberPk = makeMemberPk(navigatorAddress, member);
  const now = new Date(ctx.blockTimestamp * 1000).toISOString();

  // Upsert-create the member row (self-enroll if no prior MemberEnrolled). Set paid_through to
  // the event's absolute value (assign, NOT add — the contract already advanced it forward from
  // wherever it stood under the debt model). `total_paid` / `last_collected_at` OMITTED (see
  // MemberEnrolled note) — total_paid is recomputed from the payments feed below.
  await ctx.db.upsert('ds_subscription_members', {
    id: memberPk,
    dao_id: daoId,
    navigator_address: navigatorAddress,
    member,
    paid_through: paidThrough,
    tx_hash: ctx.log.transactionHash,
    created_at: now,
    updated_at: now,
  });

  // Append-only feed row keyed by (navigator, member, tx, logIndex) → idempotent on replay/reorg.
  // The member_pk FK requires the parent row, which the upsert above just guaranteed.
  await ctx.db.upsert('ds_subscription_payments', {
    id: makeFeedId(navigatorAddress, member, ctx.log.transactionHash, ctx.log.index),
    member_pk: memberPk,
    dao_id: daoId,
    navigator_address: navigatorAddress,
    member,
    payer,
    token,
    amount,
    periods,
    paid_through: paidThrough,
    tx_hash: ctx.log.transactionHash,
    block_number: ctx.log.blockNumber,
    created_at: now,
  });

  // Defer the cumulative total_paid recompute to the end-of-range derive-from-truth flush
  // (ds_recompute_subscription_paid) — never increment inline (would double-count on replay).
  ctx.dirtySubscriptionMemberIds.add(memberPk);

  logger.info({ navigatorAddress, daoId, member, payer, token, amount, periods, paidThrough }, 'FeePaid indexed');
}

// ── FeeCollected ────────────────────────────────────────────────────────────────────────
// A past-grace member is collected by anyone; collection UN-ENROLLS them (paidThrough → 0).

export async function handleFeeCollected(
  ctx: EventContext,
  args: Record<string, unknown>,
): Promise<void> {
  validateEventArgs(args, ['member', 'collector', 'sharesRemoved', 'reward', 'burned'], 'FeeCollected');
  const navigatorAddress = ctx.log.address.toLowerCase();
  const daoId = await getDaoFromNavigator(ctx, navigatorAddress);
  if (!daoId) {
    logger.warn({ navigatorAddress }, 'FeeCollected: could not resolve DAO for navigator, skipping');
    return;
  }

  const member = validateAndNormalizeAddress(args.member, 'member');
  const collector = validateAndNormalizeAddress(args.collector, 'collector');
  const sharesRemoved = bigintToString(safeBigInt(args.sharesRemoved));
  const reward = bigintToString(safeBigInt(args.reward));     // loot minted to collector
  const burned = Boolean(args.burned);                        // true = burnShares, false = convertSharesToLoot
  const memberPk = makeMemberPk(navigatorAddress, member);
  const now = new Date(ctx.blockTimestamp * 1000).toISOString();

  // Targeted UPDATE (never insert): a collection un-enrolls the member (paid_through → 0) and
  // stamps last_collected_at. A collection for a non-materialized member is a no-op — on-chain
  // a member must be enrolled & past grace to be collectible, so MemberEnrolled/FeePaid precedes.
  await ctx.db.updateSubscriptionMember(memberPk, {
    paid_through: 0,
    last_collected_at: now,
    updated_at: now,
  });

  // Append-only collection feed row keyed by (navigator, member, tx, logIndex) → idempotent.
  await ctx.db.upsert('ds_subscription_collections', {
    id: makeFeedId(navigatorAddress, member, ctx.log.transactionHash, ctx.log.index),
    member_pk: memberPk,
    dao_id: daoId,
    navigator_address: navigatorAddress,
    member,
    collector,
    shares_removed: sharesRemoved,
    reward,
    burned,
    tx_hash: ctx.log.transactionHash,
    block_number: ctx.log.blockNumber,
    created_at: now,
  });

  logger.info({ navigatorAddress, daoId, member, collector, sharesRemoved, reward, burned }, 'FeeCollected indexed');
}
