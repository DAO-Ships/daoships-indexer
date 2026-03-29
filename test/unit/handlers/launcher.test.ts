import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  handleLaunchDAOShipAndVault,
  handleLaunchDAOShip,
} from '../../../src/handlers/launcher.js';
import {
  DAOSHIP, SHARES, LOOT, AVATAR, LAUNCHER, TX_HASH,
  makeCtx, makeMockDb, makeMockRegistry,
} from './helpers.js';

// ── handleLaunchDAOShipAndVault ────────────────────────────────────

describe('handleLaunchDAOShipAndVault', () => {
  beforeEach(() => vi.clearAllMocks());

  it('registers the DAO in registry and upserts to DB', async () => {
    const db = makeMockDb();
    const registry = makeMockRegistry();
    const ctx = makeCtx({ db, registry });

    await handleLaunchDAOShipAndVault(ctx, {
      daoShip: DAOSHIP,
      vault: AVATAR,
      shares: SHARES,
      loot: LOOT,
      newVault: true,
      launcher: LAUNCHER,
    });

    expect(registry.registerDao).toHaveBeenCalledWith({
      daoShipAddress: DAOSHIP,
      sharesAddress: SHARES,
      lootAddress: LOOT,
      avatar: AVATAR,
    });

    expect(db.upsertDao).toHaveBeenCalledWith(expect.objectContaining({
      id: DAOSHIP,
      loot_address: LOOT,
      shares_address: SHARES,
      avatar: AVATAR,
      new_vault: true, // newVault=true → new_vault=true
      launcher: LAUNCHER,
      tx_hash: TX_HASH,
    }));
  });

  it('sets new_vault=false when newVault=false', async () => {
    const db = makeMockDb();
    const ctx = makeCtx({ db });

    await handleLaunchDAOShipAndVault(ctx, {
      daoShip: DAOSHIP, vault: AVATAR, shares: SHARES, loot: LOOT,
      newVault: false, launcher: LAUNCHER,
    });

    expect(db.upsertDao).toHaveBeenCalledWith(expect.objectContaining({ new_vault: false }));
  });

  it('zeros out governance params in initial upsert', async () => {
    const db = makeMockDb();
    const ctx = makeCtx({ db });

    await handleLaunchDAOShipAndVault(ctx, {
      daoShip: DAOSHIP, vault: AVATAR, shares: SHARES, loot: LOOT,
      newVault: true, launcher: LAUNCHER,
    });

    expect(db.upsertDao).toHaveBeenCalledWith(expect.objectContaining({
      voting_period: 0,
      grace_period: 0,
      proposal_offering: '0',
      total_shares: '0',
      total_loot: '0',
      active_member_count: 0,
      proposal_count: 0,
    }));
  });

  it('throws on missing required arg', async () => {
    const ctx = makeCtx({});
    await expect(handleLaunchDAOShipAndVault(ctx, { daoShip: DAOSHIP, vault: AVATAR, shares: SHARES, loot: LOOT }))
      .rejects.toThrow('Missing required field "launcher"');
  });
});

// ── handleLaunchDAOShip ────────────────────────────────────────────

describe('handleLaunchDAOShip', () => {
  beforeEach(() => vi.clearAllMocks());

  it('registers DAO and upserts with new_vault=false', async () => {
    const db = makeMockDb();
    const registry = makeMockRegistry();
    registry.getDaoByDaoShipAddress.mockReturnValue(undefined); // not already registered
    const ctx = makeCtx({ db, registry });

    await handleLaunchDAOShip(ctx, {
      daoShip: DAOSHIP, shares: SHARES, loot: LOOT,
      avatar: AVATAR, launcher: LAUNCHER,
    });

    expect(registry.registerDao).toHaveBeenCalledWith({
      daoShipAddress: DAOSHIP,
      sharesAddress: SHARES,
      lootAddress: LOOT,
      avatar: AVATAR,
    });
    expect(db.upsertDao).toHaveBeenCalledWith(expect.objectContaining({
      new_vault: false, // always false for LaunchDAOShip
    }));
  });

  it('skips registration if DAO already registered via LaunchDAOShipAndVault', async () => {
    const db = makeMockDb();
    const registry = makeMockRegistry();
    // Already registered — simulate pre-existing entry
    registry.getDaoByDaoShipAddress.mockReturnValue({ daoShipAddress: DAOSHIP });
    const ctx = makeCtx({ db, registry });

    await handleLaunchDAOShip(ctx, {
      daoShip: DAOSHIP, shares: SHARES, loot: LOOT,
      avatar: AVATAR, launcher: LAUNCHER,
    });

    expect(registry.registerDao).not.toHaveBeenCalled();
    expect(db.upsertDao).not.toHaveBeenCalled();
  });

  it('throws on missing required arg', async () => {
    const ctx = makeCtx({});
    await expect(handleLaunchDAOShip(ctx, { daoShip: DAOSHIP, shares: SHARES, loot: LOOT, avatar: AVATAR }))
      .rejects.toThrow('Missing required field "launcher"');
  });
});
