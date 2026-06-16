import { describe, it, expect } from 'vitest';
import {
  handleScheduleCreated,
  handleTokensClaimed,
  handleScheduleRevoked,
} from '../../../src/handlers/vesting.js';
import { makeMockDb, makeMockRegistry, makeCtx, DAOSHIP, NAVIGATOR, MEMBER1, MEMBER2 } from './helpers.js';

function ctxForNavigator(overrides: Record<string, unknown> = {}) {
  const db = makeMockDb();
  const registry = makeMockRegistry();
  registry.getDaoByNavigatorAddress.mockReturnValue(DAOSHIP);
  return { db, ctx: makeCtx({ db, registry, log: { address: NAVIGATOR, ...overrides } }) };
}

describe('VestingNavigator handlers', () => {
  it('handleScheduleCreated inserts a schedule, omitting derived/terminal columns', async () => {
    const { db, ctx } = ctxForNavigator();

    await handleScheduleCreated(ctx, {
      scheduleId: 0n,
      beneficiary: MEMBER1,
      totalAmount: 1000n,
      startTime: 1700000000n,
      cliffEnd: 1700100000n,
      vestingEnd: 1700200000n,
      isLoot: false,
    });

    expect(db.upsert).toHaveBeenCalledWith('ds_vesting_schedules', expect.objectContaining({
      id: `${NAVIGATOR}-0`,
      dao_id: DAOSHIP,
      navigator_address: NAVIGATOR,
      schedule_id: '0',
      beneficiary: MEMBER1,
      total_amount: '1000',
      is_loot: false,
      start_time: 1700000000,
      cliff_end: 1700100000,
      vesting_end: 1700200000,
      block_number: 100,
    }));
    const payload = db.upsert.mock.calls[0][1];
    expect(payload).not.toHaveProperty('claimed');
    expect(payload).not.toHaveProperty('revoked');
    expect(payload).not.toHaveProperty('vested_at_revoke');
  });

  it('handleTokensClaimed appends a claim row (keyed by tx-logIndex) and marks the schedule dirty', async () => {
    const { db, ctx } = ctxForNavigator({ index: 5 });

    await handleTokensClaimed(ctx, {
      scheduleId: 2n,
      beneficiary: MEMBER2,
      amount: 250n,
      isLoot: true,
    });

    expect(db.upsert).toHaveBeenCalledWith('ds_vesting_claims', expect.objectContaining({
      id: `${ctx.log.transactionHash}-5`,
      schedule_pk: `${NAVIGATOR}-2`,
      dao_id: DAOSHIP,
      schedule_id: '2',
      beneficiary: MEMBER2,
      amount: '250',
      is_loot: true,
    }));
    // claimed is recomputed from truth at end-of-range, never incremented inline
    expect(ctx.dirtyVestingScheduleIds.has(`${NAVIGATOR}-2`)).toBe(true);
    expect(db.recomputeVestingClaimed).not.toHaveBeenCalled();
  });

  it('handleScheduleRevoked freezes the schedule at revoked_at / vested_at_revoke', async () => {
    const { db, ctx } = ctxForNavigator();

    await handleScheduleRevoked(ctx, {
      scheduleId: 0n,
      caller: MEMBER1,
      revokedAt: 1700150000n,
      vestedAtRevoke: 400n,
    });

    expect(db.updateVestingSchedule).toHaveBeenCalledWith(
      `${NAVIGATOR}-0`,
      expect.objectContaining({ revoked: true, revoked_at: 1700150000, vested_at_revoke: '400' }),
    );
  });

  it('handleTokensClaimed skips when the DAO cannot be resolved', async () => {
    const db = makeMockDb();
    const registry = makeMockRegistry();
    const ctx = makeCtx({ db, registry, log: { address: NAVIGATOR } });

    await handleTokensClaimed(ctx, { scheduleId: 0n, beneficiary: MEMBER2, amount: 1n, isLoot: false });

    expect(db.upsert).not.toHaveBeenCalled();
    expect(ctx.dirtyVestingScheduleIds.size).toBe(0);
  });
});
