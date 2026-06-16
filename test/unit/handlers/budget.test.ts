import { describe, it, expect, vi } from 'vitest';
import {
  handleBudgetCreated,
  handleDisbursed,
  handleManagerUpdated,
  handleBudgetCancelled,
} from '../../../src/handlers/budget.js';
import { makeCtx, DAOSHIP, NAVIGATOR, MEMBER1, MEMBER2, TOKEN_A, ZERO } from './helpers.js';

const SANCTIONED = {
  id: `${DAOSHIP}-${NAVIGATOR}`,
  dao_id: DAOSHIP,
  trust_status: 'sanctioned',
  navigator_type: 'BudgetNavigator',
  deploy_block: 50,
};

/** ctx whose emitting navigator is a sanctioned (vault-enabled) BudgetNavigator. */
function ctxSanctioned(logOverrides: Record<string, unknown> = {}) {
  const ctx = makeCtx({
    db: { getNavigatorTrust: vi.fn().mockResolvedValue(SANCTIONED) },
    log: { address: NAVIGATOR, ...logOverrides },
  });
  return { ctx, db: ctx.db as any };
}

describe('BudgetNavigator handlers', () => {
  it('handleBudgetCreated inserts a budget, omitting derived/terminal columns', async () => {
    const { ctx, db } = ctxSanctioned();

    await handleBudgetCreated(ctx, {
      budgetId: 0n,
      manager: MEMBER1,
      token: TOKEN_A,
      allowancePerPeriod: 1000n,
      totalCeiling: 10000n,
      periodLength: 604800n,
      startsAt: 1700000000n,
      endsAt: 0n,
    });

    expect(db.upsert).toHaveBeenCalledWith('ds_budgets', expect.objectContaining({
      id: `${NAVIGATOR}-0`,
      dao_id: DAOSHIP,
      navigator_address: NAVIGATOR,
      budget_id: '0',
      manager: MEMBER1,
      token: TOKEN_A,
      allowance_per_period: '1000',
      total_ceiling: '10000',
      period_length: 604800,
      starts_at: 1700000000,
      ends_at: 0,
      block_number: 100,
    }));
    const payload = db.upsert.mock.calls[0][1];
    expect(payload).not.toHaveProperty('total_spent'); // derive-from-truth
    expect(payload).not.toHaveProperty('cancelled');    // set only by BudgetCancelled
  });

  it('handleBudgetCreated stores the zero address verbatim for native QUAI budgets', async () => {
    const { ctx, db } = ctxSanctioned();

    await handleBudgetCreated(ctx, {
      budgetId: 1n, manager: MEMBER1, token: ZERO,
      allowancePerPeriod: 5n, totalCeiling: 50n, periodLength: 3600n, startsAt: 1n, endsAt: 0n,
    });

    expect(db.upsert).toHaveBeenCalledWith('ds_budgets', expect.objectContaining({ token: ZERO }));
  });

  it('handleDisbursed appends a payout row (keyed nav-budget-tx-logIndex) and marks the budget dirty', async () => {
    const { ctx, db } = ctxSanctioned({ index: 3 });

    await handleDisbursed(ctx, { budgetId: 2n, to: MEMBER2, token: TOKEN_A, amount: 250n });

    expect(db.upsert).toHaveBeenCalledWith('ds_budget_disbursements', expect.objectContaining({
      id: `${NAVIGATOR}-2-${ctx.log.transactionHash}-3`,
      budget_pk: `${NAVIGATOR}-2`,
      dao_id: DAOSHIP,
      budget_id: '2',
      recipient: MEMBER2,
      token: TOKEN_A,
      amount: '250',
      block_number: 100,
    }));
    // total_spent is recomputed from truth at end-of-range, never incremented inline
    expect(ctx.dirtyBudgetIds.has(`${NAVIGATOR}-2`)).toBe(true);
    expect(db.recomputeBudgetSpent).not.toHaveBeenCalled();
  });

  it('handleManagerUpdated targets the budget row (no insert)', async () => {
    const { ctx, db } = ctxSanctioned();

    await handleManagerUpdated(ctx, { budgetId: 0n, oldManager: MEMBER1, newManager: MEMBER2 });

    expect(db.updateBudget).toHaveBeenCalledWith(
      `${NAVIGATOR}-0`,
      expect.objectContaining({ manager: MEMBER2 }),
    );
    expect(db.upsert).not.toHaveBeenCalled();
  });

  it('handleBudgetCancelled sets cancelled=true via targeted update', async () => {
    const { ctx, db } = ctxSanctioned();

    await handleBudgetCancelled(ctx, { budgetId: 0n, caller: MEMBER1 });

    expect(db.updateBudget).toHaveBeenCalledWith(
      `${NAVIGATOR}-0`,
      expect.objectContaining({ cancelled: true }),
    );
  });

  it('defers all writes when the navigator is not sanctioned (never vault-enabled)', async () => {
    const ctx = makeCtx({
      db: { getNavigatorTrust: vi.fn().mockResolvedValue({ ...SANCTIONED, trust_status: 'self_asserted' }) },
      log: { address: NAVIGATOR },
    });
    const db = ctx.db as any;

    await handleBudgetCreated(ctx, {
      budgetId: 0n, manager: MEMBER1, token: TOKEN_A,
      allowancePerPeriod: 1n, totalCeiling: 1n, periodLength: 3600n, startsAt: 1n, endsAt: 0n,
    });
    await handleDisbursed(ctx, { budgetId: 0n, to: MEMBER2, token: TOKEN_A, amount: 1n });
    await handleManagerUpdated(ctx, { budgetId: 0n, oldManager: MEMBER1, newManager: MEMBER2 });
    await handleBudgetCancelled(ctx, { budgetId: 0n, caller: MEMBER1 });

    expect(db.upsert).not.toHaveBeenCalled();
    expect(db.updateBudget).not.toHaveBeenCalled();
    expect(ctx.dirtyBudgetIds.size).toBe(0);
  });

  it('defers when NavigatorDeployed has not been indexed (trust row absent)', async () => {
    const ctx = makeCtx({
      db: { getNavigatorTrust: vi.fn().mockResolvedValue(null) },
      log: { address: NAVIGATOR },
    });
    const db = ctx.db as any;

    await handleDisbursed(ctx, { budgetId: 0n, to: MEMBER2, token: TOKEN_A, amount: 1n });

    expect(db.upsert).not.toHaveBeenCalled();
    expect(ctx.dirtyBudgetIds.size).toBe(0);
  });
});
