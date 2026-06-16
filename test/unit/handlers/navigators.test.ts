import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  handleOnboard,
  handleNFTClaimed,
  clearNavigatorDaoCache,
} from '../../../src/handlers/navigators.js';
import {
  DAOSHIP, NAVIGATOR, MEMBER1, TX_HASH,
  makeCtx, makeMockDb,
} from './helpers.js';

// Clear the module-level LRU cache between tests to prevent state leakage
beforeEach(() => {
  vi.clearAllMocks();
  clearNavigatorDaoCache();
});

// ── handleOnboard ───────────────────────────────────────────────

describe('handleOnboard', () => {
  it('resolves DAO from registry and upserts navigator event', async () => {
    const db = makeMockDb();
    const ctx = makeCtx({
      db,
      log: { address: NAVIGATOR },
      registry: { getDaoByDaoShipAddress: vi.fn().mockReturnValue({ daoShipAddress: DAOSHIP }) },
    });

    await handleOnboard(ctx, {
      daoShipAddress: DAOSHIP,
      contributor: MEMBER1,
      amount: 1000n,
      shares: 100n,
      loot: 50n,
    });

    expect(db.upsert).toHaveBeenCalledWith('ds_navigator_events', expect.objectContaining({
      dao_id: DAOSHIP,
      navigator_address: NAVIGATOR,
      event_type: 'onboard',
      contributor: MEMBER1,
      shares_minted: '100',
      loot_minted: '50',
      amount: '1000',
      metadata: null,
      tx_hash: TX_HASH,
    }));
  });

  it('skips when DAO cannot be resolved', async () => {
    const db = makeMockDb();
    const ctx = makeCtx({
      db,
      log: { address: NAVIGATOR },
      registry: { getDaoByDaoShipAddress: vi.fn().mockReturnValue(undefined) },
      // daoShip() on-chain call also unavailable:
      blockchain: { callContract: vi.fn().mockRejectedValue(new Error('no contract')) },
    });

    await handleOnboard(ctx, {
      daoShipAddress: DAOSHIP,
      contributor: MEMBER1, amount: 1000n, shares: 100n, loot: 50n,
    });

    expect(db.upsert).not.toHaveBeenCalled();
  });

  it('falls back to on-chain daoShip() when not in registry', async () => {
    const db = makeMockDb();
    const ctx = makeCtx({
      db,
      log: { address: NAVIGATOR },
      registry: { getDaoByDaoShipAddress: vi.fn().mockReturnValue(undefined) },
      blockchain: { callContract: vi.fn().mockResolvedValue(DAOSHIP) },
    });

    await handleOnboard(ctx, {
      daoShipAddress: DAOSHIP,
      contributor: MEMBER1, amount: 500n, shares: 50n, loot: 25n,
    });

    expect(db.upsert).toHaveBeenCalledWith('ds_navigator_events', expect.objectContaining({
      dao_id: DAOSHIP,
      event_type: 'onboard',
    }));
  });

  it('throws on missing required arg', async () => {
    const ctx = makeCtx({ log: { address: NAVIGATOR }, registry: { getDaoByDaoShipAddress: vi.fn().mockReturnValue({ daoShipAddress: DAOSHIP }) } });
    await expect(handleOnboard(ctx, { daoShipAddress: DAOSHIP, contributor: MEMBER1, amount: 100n, shares: 10n }))
      .rejects.toThrow('Missing required field "loot"');
  });
});

// Note: ERC20TributeNavigator.Onboard shares identical topic0 with OnboarderNavigator.Onboard.
// Both are handled by handleOnboard. Navigator type is determined via navigatorType() constant
// read by handleNavigatorSet in daoship.ts.

// ── handleNFTClaimed (NFTGatedNavigator) ────────────────────────

describe('handleNFTClaimed', () => {
  it('records the per-token claim in ds_nft_claims keyed by navigator-tokenId', async () => {
    const db = makeMockDb();
    const ctx = makeCtx({
      db,
      log: { address: NAVIGATOR },
      registry: { getDaoByDaoShipAddress: vi.fn().mockReturnValue({ daoShipAddress: DAOSHIP }) },
    });

    await handleNFTClaimed(ctx, {
      daoShipAddress: DAOSHIP,
      holder: MEMBER1,
      tokenId: 42n,
      shares: 100n,
      loot: 50n,
    });

    expect(db.upsert).toHaveBeenCalledWith('ds_nft_claims', expect.objectContaining({
      id: `${NAVIGATOR}-42`,
      dao_id: DAOSHIP,
      navigator_address: NAVIGATOR,
      token_id: '42',
      holder: MEMBER1,
      shares: '100',
      loot: '50',
      tx_hash: TX_HASH,
    }));
    // NFTClaimed must NOT touch member balances or ds_navigator_events — that is
    // the paired Onboard's job. Double-writing would double-count.
    expect(db.upsert).toHaveBeenCalledTimes(1);
    expect(db.upsertMember).not.toHaveBeenCalled();
  });

  it('loot-only claim (shares = 0) is recorded', async () => {
    const db = makeMockDb();
    const ctx = makeCtx({
      db,
      log: { address: NAVIGATOR },
      registry: { getDaoByDaoShipAddress: vi.fn().mockReturnValue({ daoShipAddress: DAOSHIP }) },
    });

    await handleNFTClaimed(ctx, {
      daoShipAddress: DAOSHIP, holder: MEMBER1, tokenId: 7n, shares: 0n, loot: 25n,
    });

    expect(db.upsert).toHaveBeenCalledWith('ds_nft_claims', expect.objectContaining({
      token_id: '7', shares: '0', loot: '25',
    }));
  });

  it('skips when DAO cannot be resolved', async () => {
    const db = makeMockDb();
    const ctx = makeCtx({
      db,
      log: { address: NAVIGATOR },
      registry: { getDaoByDaoShipAddress: vi.fn().mockReturnValue(undefined) },
      blockchain: { callContract: vi.fn().mockRejectedValue(new Error('no contract')) },
    });

    await handleNFTClaimed(ctx, {
      daoShipAddress: DAOSHIP, holder: MEMBER1, tokenId: 1n, shares: 10n, loot: 0n,
    });

    expect(db.upsert).not.toHaveBeenCalled();
  });

  it('falls back to on-chain daoShip() when not in registry', async () => {
    const db = makeMockDb();
    const ctx = makeCtx({
      db,
      log: { address: NAVIGATOR },
      registry: { getDaoByDaoShipAddress: vi.fn().mockReturnValue(undefined) },
      blockchain: { callContract: vi.fn().mockResolvedValue(DAOSHIP) },
    });

    await handleNFTClaimed(ctx, {
      daoShipAddress: DAOSHIP, holder: MEMBER1, tokenId: 99n, shares: 1n, loot: 1n,
    });

    expect(db.upsert).toHaveBeenCalledWith('ds_nft_claims', expect.objectContaining({
      id: `${NAVIGATOR}-99`,
      dao_id: DAOSHIP,
    }));
  });

  it('throws on missing required arg', async () => {
    const ctx = makeCtx({
      log: { address: NAVIGATOR },
      registry: { getDaoByDaoShipAddress: vi.fn().mockReturnValue({ daoShipAddress: DAOSHIP }) },
    });
    await expect(handleNFTClaimed(ctx, { daoShipAddress: DAOSHIP, holder: MEMBER1, tokenId: 1n, shares: 10n }))
      .rejects.toThrow('Missing required field "loot"');
  });
});
