import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  handleOnboard,
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
