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

describe('handleTransfer', () => {
  let db: ReturnType<typeof makeMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = makeMockDb();
  });

  it('mint: credits receiver, activeMemberDelta=+1 when receiver was zero', async () => {
    // from=ZERO means mint
    db.getMember.mockResolvedValue(null); // receiver has no existing balance
    const ctx = makeCtx({
      db,
      log: { address: SHARES },
      registry: {
        getDaoByTokenAddress: vi.fn().mockReturnValue(DAOSHIP),
        isSharesToken: vi.fn().mockReturnValue(true),
      },
    });

    await handleTransfer(ctx, { from: ZERO, to: MEMBER1, value: 100n });

    // Sender (zero) is skipped — only receiver upserted
    const calls = db.upsertMember.mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toMatchObject({ member_address: MEMBER1, shares: '100' });
    // Active member count incremented by 1
    expect(db.updateActiveMemberCount).toHaveBeenCalledWith(DAOSHIP, 1);
  });

  it('burn: debits sender, activeMemberDelta=-1 when sender hits zero', async () => {
    // to=ZERO means burn; sender had exactly 50 shares
    db.getMember.mockResolvedValue({ id: `${DAOSHIP}-${MEMBER1}`, shares: '50', loot: '0', created_at: 'ts' });
    const ctx = makeCtx({
      db,
      log: { address: SHARES },
      registry: {
        getDaoByTokenAddress: vi.fn().mockReturnValue(DAOSHIP),
        isSharesToken: vi.fn().mockReturnValue(true),
      },
    });

    await handleTransfer(ctx, { from: MEMBER1, to: ZERO, value: 50n });

    const senderCall = db.upsertMember.mock.calls.find((c: any[]) => c[0].member_address === MEMBER1);
    expect(senderCall?.[0]).toMatchObject({ member_address: MEMBER1, shares: '0' });
    expect(db.updateActiveMemberCount).toHaveBeenCalledWith(DAOSHIP, -1);
  });

  it('transfer: debits sender and credits receiver', async () => {
    db.getMember
      .mockResolvedValueOnce({ shares: '100', loot: '0', created_at: 'ts' }) // sender
      .mockResolvedValueOnce({ shares: '20', loot: '0', created_at: 'ts' });  // receiver
    const ctx = makeCtx({
      db,
      log: { address: SHARES },
      registry: {
        getDaoByTokenAddress: vi.fn().mockReturnValue(DAOSHIP),
        isSharesToken: vi.fn().mockReturnValue(true),
      },
    });

    await handleTransfer(ctx, { from: MEMBER1, to: MEMBER2, value: 30n });

    const senderCall = db.upsertMember.mock.calls.find((c: any[]) => c[0].member_address === MEMBER1);
    const receiverCall = db.upsertMember.mock.calls.find((c: any[]) => c[0].member_address === MEMBER2);
    expect(senderCall?.[0]).toMatchObject({ member_address: MEMBER1, shares: '70' });
    expect(receiverCall?.[0]).toMatchObject({ member_address: MEMBER2, shares: '50' });
    // No membership delta when neither side crosses zero
    expect(db.updateActiveMemberCount).not.toHaveBeenCalled();
  });

  it('clamps sender balance to zero when it would go negative', async () => {
    db.getMember.mockResolvedValue({ shares: '10', loot: '0', created_at: 'ts' }); // sender only 10
    const ctx = makeCtx({
      db,
      log: { address: SHARES },
      registry: {
        getDaoByTokenAddress: vi.fn().mockReturnValue(DAOSHIP),
        isSharesToken: vi.fn().mockReturnValue(true),
      },
    });

    // Transfer 50 but only have 10 — should clamp to 0
    await handleTransfer(ctx, { from: MEMBER1, to: ZERO, value: 50n });

    const senderCall = db.upsertMember.mock.calls.find((c: any[]) => c[0].member_address === MEMBER1);
    expect(senderCall?.[0].shares).toBe('0');
  });

  it('skips unknown token address', async () => {
    const ctx = makeCtx({
      db,
      log: { address: SHARES },
      registry: {
        getDaoByTokenAddress: vi.fn().mockReturnValue(undefined), // not known
      },
    });

    await handleTransfer(ctx, { from: ZERO, to: MEMBER1, value: 100n });

    expect(db.upsertMember).not.toHaveBeenCalled();
  });

  it('handles loot token (isSharesToken=false)', async () => {
    db.getMember.mockResolvedValue(null);
    const ctx = makeCtx({
      db,
      log: { address: LOOT },
      registry: {
        getDaoByTokenAddress: vi.fn().mockReturnValue(DAOSHIP),
        isSharesToken: vi.fn().mockReturnValue(false), // loot token
      },
    });

    await handleTransfer(ctx, { from: ZERO, to: MEMBER1, value: 200n });

    const call = db.upsertMember.mock.calls[0];
    expect(call[0]).toMatchObject({ member_address: MEMBER1, loot: '200' });
  });

  it('no activeMemberDelta when zero-value mint', async () => {
    db.getMember.mockResolvedValue(null);
    const ctx = makeCtx({
      db,
      log: { address: SHARES },
      registry: {
        getDaoByTokenAddress: vi.fn().mockReturnValue(DAOSHIP),
        isSharesToken: vi.fn().mockReturnValue(true),
      },
    });

    await handleTransfer(ctx, { from: ZERO, to: MEMBER1, value: 0n });

    // oldTotal=0, newTotal=0 → no delta
    expect(db.updateActiveMemberCount).not.toHaveBeenCalled();
  });

  it('throws on missing required args', async () => {
    const ctx = makeCtx({ log: { address: SHARES } });
    await expect(handleTransfer(ctx, { from: MEMBER1, to: MEMBER2 }))
      .rejects.toThrow('Missing required field "value"');
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
