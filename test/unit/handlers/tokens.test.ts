import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  handleTransfer,
  handleDelegateChanged,
  handleDelegateVotesChanged,
  handlePaused,
  handleUnpaused,
} from '../../../src/handlers/tokens.js';
import {
  DAOSHIP, SHARES, LOOT, MEMBER1, MEMBER2, ZERO, TX_HASH,
  makeCtx, makeMockDb,
} from './helpers.js';

// ── handleTransfer ──────────────────────────────────────────────

/**
 * Option B: handleTransfer is now a thin dispatcher into the
 * `ds_apply_transfer` RPC. All balance math + dedup happens server-side.
 * These tests verify the handler calls the RPC with correct args and
 * reacts to its return value (delta → updateActiveMemberCount; alwaysQueue
 * dirtyDaoIds for end-of-range recompute).
 */
describe('handleTransfer', () => {
  let db: ReturnType<typeof makeMockDb>;
  const makeTransferCtx = (isShares: boolean, logAddr = SHARES) => makeCtx({
    db,
    log: { address: logAddr, index: 3, transactionHash: TX_HASH, blockNumber: 500 },
    registry: {
      getDaoByTokenAddress: vi.fn().mockReturnValue(DAOSHIP),
      isSharesToken: vi.fn().mockReturnValue(isShares),
    },
  });

  beforeEach(() => {
    vi.clearAllMocks();
    db = makeMockDb();
  });

  it('mint: calls applyTransfer with from=ZERO, forwards delta to updateActiveMemberCount', async () => {
    db.applyTransfer.mockResolvedValue({ alreadyProcessed: false, activeMemberDelta: 1 });
    const ctx = makeTransferCtx(true);

    await handleTransfer(ctx, { from: ZERO, to: MEMBER1, value: 100n });

    expect(db.applyTransfer).toHaveBeenCalledTimes(1);
    const args = db.applyTransfer.mock.calls[0][0];
    expect(args).toMatchObject({
      txHash: TX_HASH,
      logIndex: 3,
      blockNumber: 500,
      daoId: DAOSHIP,
      fromAddress: ZERO,
      toAddress: MEMBER1,
      value: '100',
      isShares: true,
    });
    expect(db.updateActiveMemberCount).toHaveBeenCalledWith(DAOSHIP, 1);
    expect(ctx.dirtyDaoIds.has(DAOSHIP)).toBe(true);
  });

  it('burn: forwards negative delta', async () => {
    db.applyTransfer.mockResolvedValue({ alreadyProcessed: false, activeMemberDelta: -1 });
    const ctx = makeTransferCtx(true);

    await handleTransfer(ctx, { from: MEMBER1, to: ZERO, value: 50n });

    const args = db.applyTransfer.mock.calls[0][0];
    expect(args.fromAddress).toBe(MEMBER1);
    expect(args.toAddress).toBe(ZERO);
    expect(db.updateActiveMemberCount).toHaveBeenCalledWith(DAOSHIP, -1);
  });

  it('transfer: no membership delta when neither side crosses zero', async () => {
    db.applyTransfer.mockResolvedValue({ alreadyProcessed: false, activeMemberDelta: 0 });
    const ctx = makeTransferCtx(true);

    await handleTransfer(ctx, { from: MEMBER1, to: MEMBER2, value: 30n });

    expect(db.applyTransfer).toHaveBeenCalledTimes(1);
    expect(db.updateActiveMemberCount).not.toHaveBeenCalled();
    expect(ctx.dirtyDaoIds.has(DAOSHIP)).toBe(true);
  });

  it('already-processed: short-circuits without queueing anything', async () => {
    db.applyTransfer.mockResolvedValue({ alreadyProcessed: true, activeMemberDelta: 0 });
    const ctx = makeTransferCtx(true);

    await handleTransfer(ctx, { from: MEMBER1, to: MEMBER2, value: 30n });

    expect(db.applyTransfer).toHaveBeenCalledTimes(1);
    expect(db.updateActiveMemberCount).not.toHaveBeenCalled();
    // When the RPC says "already processed" we do NOT re-queue the dirty
    // DAO or re-invalidate active member count — replay is a pure no-op.
    expect(ctx.dirtyDaoIds.has(DAOSHIP)).toBe(false);
  });

  it('skips unknown token address (no applyTransfer call)', async () => {
    const ctx = makeCtx({
      db,
      log: { address: SHARES },
      registry: { getDaoByTokenAddress: vi.fn().mockReturnValue(undefined) },
    });

    await handleTransfer(ctx, { from: ZERO, to: MEMBER1, value: 100n });

    expect(db.applyTransfer).not.toHaveBeenCalled();
    expect(ctx.dirtyDaoIds.has(DAOSHIP)).toBe(false);
  });

  it('loot token: applyTransfer.isShares=false', async () => {
    db.applyTransfer.mockResolvedValue({ alreadyProcessed: false, activeMemberDelta: 1 });
    const ctx = makeTransferCtx(false, LOOT);

    await handleTransfer(ctx, { from: ZERO, to: MEMBER1, value: 200n });

    expect(db.applyTransfer.mock.calls[0][0].isShares).toBe(false);
  });

  it('zero-value mint: still calls applyTransfer, delta=0 → no membership update', async () => {
    db.applyTransfer.mockResolvedValue({ alreadyProcessed: false, activeMemberDelta: 0 });
    const ctx = makeTransferCtx(true);

    await handleTransfer(ctx, { from: ZERO, to: MEMBER1, value: 0n });

    expect(db.applyTransfer).toHaveBeenCalledTimes(1);
    expect(db.updateActiveMemberCount).not.toHaveBeenCalled();
  });

  it('throws on missing required args (pre-RPC validation)', async () => {
    const ctx = makeCtx({ log: { address: SHARES } });
    await expect(handleTransfer(ctx, { from: MEMBER1, to: MEMBER2 }))
      .rejects.toThrow('Missing required field "value"');
    expect(db.applyTransfer).not.toHaveBeenCalled();
  });

  it('self-transfer routes through the same RPC (server decides no-op)', async () => {
    // Self-transfer correctness now lives in the ds_apply_transfer SQL —
    // handler just forwards the args. The server-side test verifies the
    // no-op balance behavior; here we just check the handler didn't special-case.
    db.applyTransfer.mockResolvedValue({ alreadyProcessed: false, activeMemberDelta: 0 });
    const ctx = makeTransferCtx(true);

    await handleTransfer(ctx, { from: MEMBER1, to: MEMBER1, value: 20n });

    const args = db.applyTransfer.mock.calls[0][0];
    expect(args.fromAddress).toBe(MEMBER1);
    expect(args.toAddress).toBe(MEMBER1);
  });

  it('invalidates cache entries for touched members (non-self-transfer)', async () => {
    db.applyTransfer.mockResolvedValue({ alreadyProcessed: false, activeMemberDelta: 0 });
    const ctx = makeTransferCtx(true);
    // Pre-populate cache so we can detect invalidation.
    ctx.cache.setMember(`${DAOSHIP}-${MEMBER1}`, {
      id: `${DAOSHIP}-${MEMBER1}`, dao_id: DAOSHIP, member_address: MEMBER1,
      shares: '999', loot: '0', created_at: 'ts',
    } as any);
    ctx.cache.setMember(`${DAOSHIP}-${MEMBER2}`, {
      id: `${DAOSHIP}-${MEMBER2}`, dao_id: DAOSHIP, member_address: MEMBER2,
      shares: '0', loot: '0', created_at: 'ts',
    } as any);

    await handleTransfer(ctx, { from: MEMBER1, to: MEMBER2, value: 30n });

    expect(ctx.cache.peekMember(`${DAOSHIP}-${MEMBER1}`)).toBeUndefined();
    expect(ctx.cache.peekMember(`${DAOSHIP}-${MEMBER2}`)).toBeUndefined();
  });
});

// ── handleDelegateChanged ───────────────────────────────────────

describe('handleDelegateChanged', () => {
  beforeEach(() => vi.clearAllMocks());

  it('inserts delegation record and updates member delegating_to', async () => {
    const db = makeMockDb();
    const ctx = makeCtx({
      db,
      log: { address: SHARES },
      registry: { getDaoByTokenAddress: vi.fn().mockReturnValue(DAOSHIP) },
    });

    await handleDelegateChanged(ctx, { delegator: MEMBER1, fromDelegate: MEMBER1, toDelegate: MEMBER2 });

    expect(db.insert).toHaveBeenCalledWith('ds_delegations', expect.objectContaining({
      delegator: MEMBER1,
      from_delegate: MEMBER1,
      to_delegate: MEMBER2,
    }));
    expect(db.upsertMember).toHaveBeenCalledWith(expect.objectContaining({
      member_address: MEMBER1,
      delegating_to: MEMBER2, // different address → not self-delegation
    }));
  });

  it('sets delegating_to=null when self-delegating', async () => {
    const db = makeMockDb();
    const ctx = makeCtx({
      db,
      log: { address: SHARES },
      registry: { getDaoByTokenAddress: vi.fn().mockReturnValue(DAOSHIP) },
    });

    await handleDelegateChanged(ctx, { delegator: MEMBER1, fromDelegate: MEMBER2, toDelegate: MEMBER1 });

    expect(db.upsertMember).toHaveBeenCalledWith(expect.objectContaining({
      delegating_to: null,
    }));
  });

  it('skips unknown token', async () => {
    const db = makeMockDb();
    const ctx = makeCtx({
      db,
      log: { address: SHARES },
      registry: { getDaoByTokenAddress: vi.fn().mockReturnValue(undefined) },
    });

    await handleDelegateChanged(ctx, { delegator: MEMBER1, fromDelegate: MEMBER1, toDelegate: MEMBER2 });

    expect(db.insert).not.toHaveBeenCalled();
  });
});

// ── handleDelegateVotesChanged ──────────────────────────────────

describe('handleDelegateVotesChanged', () => {
  beforeEach(() => vi.clearAllMocks());

  it('updates voting_power', async () => {
    const db = makeMockDb();
    const ctx = makeCtx({
      db,
      log: { address: SHARES },
      registry: { getDaoByTokenAddress: vi.fn().mockReturnValue(DAOSHIP) },
    });

    await handleDelegateVotesChanged(ctx, { delegate: MEMBER1, previousBalance: 0n, newBalance: 500n });

    expect(db.upsertMember).toHaveBeenCalledWith(expect.objectContaining({
      member_address: MEMBER1,
      voting_power: '500',
    }));
  });

  it('skips unknown token', async () => {
    const db = makeMockDb();
    const ctx = makeCtx({
      db,
      log: { address: SHARES },
      registry: { getDaoByTokenAddress: vi.fn().mockReturnValue(undefined) },
    });

    await handleDelegateVotesChanged(ctx, { delegate: MEMBER1, previousBalance: 0n, newBalance: 500n });

    expect(db.upsertMember).not.toHaveBeenCalled();
  });
});

// ── handlePaused / handleUnpaused ───────────────────────────────

describe('handlePaused', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sets shares_paused=true for shares token', async () => {
    const db = makeMockDb();
    const ctx = makeCtx({
      db,
      log: { address: SHARES },
      registry: {
        getDaoByTokenAddress: vi.fn().mockReturnValue(DAOSHIP),
        isSharesToken: vi.fn().mockReturnValue(true),
      },
    });

    await handlePaused(ctx, { account: MEMBER1 });

    expect(db.updateDao).toHaveBeenCalledWith(DAOSHIP, { shares_paused: true });
  });

  it('sets loot_paused=true for loot token', async () => {
    const db = makeMockDb();
    const ctx = makeCtx({
      db,
      log: { address: LOOT },
      registry: {
        getDaoByTokenAddress: vi.fn().mockReturnValue(DAOSHIP),
        isSharesToken: vi.fn().mockReturnValue(false),
      },
    });

    await handlePaused(ctx, { account: MEMBER1 });

    expect(db.updateDao).toHaveBeenCalledWith(DAOSHIP, { loot_paused: true });
  });

  it('skips unknown token', async () => {
    const db = makeMockDb();
    const ctx = makeCtx({
      db,
      registry: { getDaoByTokenAddress: vi.fn().mockReturnValue(undefined) },
    });

    await handlePaused(ctx, { account: MEMBER1 });

    expect(db.updateDao).not.toHaveBeenCalled();
  });
});

describe('handleUnpaused', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sets shares_paused=false for shares token', async () => {
    const db = makeMockDb();
    const ctx = makeCtx({
      db,
      log: { address: SHARES },
      registry: {
        getDaoByTokenAddress: vi.fn().mockReturnValue(DAOSHIP),
        isSharesToken: vi.fn().mockReturnValue(true),
      },
    });

    await handleUnpaused(ctx, { account: MEMBER1 });

    expect(db.updateDao).toHaveBeenCalledWith(DAOSHIP, { shares_paused: false });
  });

  it('sets loot_paused=false for loot token', async () => {
    const db = makeMockDb();
    const ctx = makeCtx({
      db,
      log: { address: LOOT },
      registry: {
        getDaoByTokenAddress: vi.fn().mockReturnValue(DAOSHIP),
        isSharesToken: vi.fn().mockReturnValue(false),
      },
    });

    await handleUnpaused(ctx, { account: MEMBER1 });

    expect(db.updateDao).toHaveBeenCalledWith(DAOSHIP, { loot_paused: false });
  });
});

// ── RangeCache integration ────────────────────────────────────
// Proves that repeat member reads within the same range hit the cache
// (populated by setMember after successful writes) rather than firing
// redundant `getMember` calls.

describe('handleTransfer — Option B cache invalidation', () => {
  let db: ReturnType<typeof makeMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = makeMockDb();
    db.applyTransfer.mockResolvedValue({ alreadyProcessed: false, activeMemberDelta: 0 });
  });

  it('DelegateChanged invalidates member; subsequent Transfer still calls applyTransfer (no client-side read)', async () => {
    const ctx = makeCtx({
      db,
      log: { address: SHARES },
      registry: {
        getDaoByTokenAddress: vi.fn().mockReturnValue(DAOSHIP),
        isSharesToken: vi.fn().mockReturnValue(true),
      },
    });

    await handleTransfer(ctx, { from: MEMBER1, to: MEMBER2, value: 10n });
    await handleDelegateChanged(ctx, { delegator: MEMBER1, fromDelegate: MEMBER1, toDelegate: MEMBER2 });
    await handleTransfer(ctx, { from: MEMBER1, to: MEMBER2, value: 5n });

    // Under Option B the handler never reads members client-side.
    expect(db.getMember).not.toHaveBeenCalled();
    // Each Transfer hits the RPC.
    expect(db.applyTransfer).toHaveBeenCalledTimes(2);
  });
});
