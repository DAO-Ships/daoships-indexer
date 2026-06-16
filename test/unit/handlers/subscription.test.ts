import { describe, it, expect } from 'vitest';
import {
  handleMemberEnrolled,
  handleFeePaid,
  handleFeeCollected,
} from '../../../src/handlers/subscription.js';
import { makeMockDb, makeMockRegistry, makeCtx, DAOSHIP, NAVIGATOR, MEMBER1, MEMBER2, TOKEN_A, ZERO } from './helpers.js';

function ctxForNavigator(overrides: Record<string, unknown> = {}) {
  const db = makeMockDb();
  const registry = makeMockRegistry();
  registry.getDaoByNavigatorAddress.mockReturnValue(DAOSHIP);
  return { db, ctx: makeCtx({ db, registry, log: { address: NAVIGATOR, ...overrides } }) };
}

describe('SubscriptionNavigator handlers', () => {
  it('handleMemberEnrolled upserts a member, omitting derived/terminal columns', async () => {
    const { db, ctx } = ctxForNavigator();

    await handleMemberEnrolled(ctx, {
      member: MEMBER1,
      paidThrough: 1700100000n,
    });

    expect(db.upsert).toHaveBeenCalledWith('ds_subscription_members', expect.objectContaining({
      id: `${NAVIGATOR}-${MEMBER1}`,
      dao_id: DAOSHIP,
      navigator_address: NAVIGATOR,
      member: MEMBER1,
      paid_through: 1700100000,
    }));
    const payload = db.upsert.mock.calls[0][1];
    expect(payload).not.toHaveProperty('total_paid');
    expect(payload).not.toHaveProperty('last_collected_at');
  });

  it('handleFeePaid upsert-creates the member (self-enroll), appends a payment row, and marks dirty', async () => {
    const { db, ctx } = ctxForNavigator({ index: 3 });

    await handleFeePaid(ctx, {
      member: MEMBER1,
      payer: MEMBER2,            // payFeeFor → payer differs from member
      token: TOKEN_A,
      amount: 500n,
      periods: 2n,
      paidThrough: 1700200000n,
    });

    // Member row upserted with the new ABSOLUTE paid_through (assigned, not added)
    expect(db.upsert).toHaveBeenCalledWith('ds_subscription_members', expect.objectContaining({
      id: `${NAVIGATOR}-${MEMBER1}`,
      dao_id: DAOSHIP,
      member: MEMBER1,
      paid_through: 1700200000,
    }));
    // Payment feed row keyed by (navigator, member, tx, logIndex)
    expect(db.upsert).toHaveBeenCalledWith('ds_subscription_payments', expect.objectContaining({
      id: `${NAVIGATOR}-${MEMBER1}-${ctx.log.transactionHash}-3`,
      member_pk: `${NAVIGATOR}-${MEMBER1}`,
      dao_id: DAOSHIP,
      member: MEMBER1,
      payer: MEMBER2,
      token: TOKEN_A,
      amount: '500',
      periods: '2',
      paid_through: 1700200000,
    }));
    // total_paid is recomputed from truth at end-of-range, never incremented inline
    expect(ctx.dirtySubscriptionMemberIds.has(`${NAVIGATOR}-${MEMBER1}`)).toBe(true);
    expect(db.recomputeSubscriptionPaid).not.toHaveBeenCalled();
  });

  it('handleFeePaid records native QUAI (token 0x0) without choking on the zero address', async () => {
    const { db, ctx } = ctxForNavigator();

    await handleFeePaid(ctx, {
      member: MEMBER1,
      payer: MEMBER1,
      token: ZERO,
      amount: 1000n,
      periods: 1n,
      paidThrough: 1700300000n,
    });

    expect(db.upsert).toHaveBeenCalledWith('ds_subscription_payments', expect.objectContaining({
      token: ZERO,
      amount: '1000',
    }));
  });

  it('handleFeeCollected un-enrolls the member (paid_through → 0) and appends a collection row', async () => {
    const { db, ctx } = ctxForNavigator({ index: 7 });

    await handleFeeCollected(ctx, {
      member: MEMBER1,
      collector: MEMBER2,
      sharesRemoved: 750n,
      reward: 75n,
      burned: false,
    });

    // Targeted UPDATE that un-enrolls and stamps last_collected_at (never inserts)
    expect(db.updateSubscriptionMember).toHaveBeenCalledWith(
      `${NAVIGATOR}-${MEMBER1}`,
      expect.objectContaining({ paid_through: 0, last_collected_at: expect.any(String) }),
    );
    expect(db.upsert).toHaveBeenCalledWith('ds_subscription_collections', expect.objectContaining({
      id: `${NAVIGATOR}-${MEMBER1}-${ctx.log.transactionHash}-7`,
      member_pk: `${NAVIGATOR}-${MEMBER1}`,
      dao_id: DAOSHIP,
      member: MEMBER1,
      collector: MEMBER2,
      shares_removed: '750',
      reward: '75',
      burned: false,
    }));
  });

  it('handleFeePaid skips when the DAO cannot be resolved', async () => {
    const db = makeMockDb();
    const registry = makeMockRegistry();   // getDaoByNavigatorAddress → undefined
    const ctx = makeCtx({ db, registry, log: { address: NAVIGATOR } });

    await handleFeePaid(ctx, {
      member: MEMBER1, payer: MEMBER1, token: ZERO, amount: 1n, periods: 1n, paidThrough: 1n,
    });

    expect(db.upsert).not.toHaveBeenCalled();
    expect(ctx.dirtySubscriptionMemberIds.size).toBe(0);
  });
});
