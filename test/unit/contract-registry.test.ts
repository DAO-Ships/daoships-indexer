/**
 * A4 remainder: ContractRegistry unit tests.
 *
 * Previously the registry was indirectly covered through handler tests. It's
 * a small but load-bearing module — bugs here cause silent event-fetch gaps
 * (addresses dropped from getLogs filter) or cross-DAO attribution errors.
 */
import { describe, it, expect } from 'vitest';
import { ContractRegistry } from '../../src/registry/contract-registry.js';

// All addresses lowercased here so we can check equality without re-normalizing.
const DAO_A = '0x0000000000000000000000000000000000000001';
const SHARES_A = '0x0000000000000000000000000000000000000002';
const LOOT_A = '0x0000000000000000000000000000000000000003';
const AVATAR_A = '0x0000000000000000000000000000000000000004';

const DAO_B = '0x0000000000000000000000000000000000000010';
const SHARES_B = '0x0000000000000000000000000000000000000011';
const LOOT_B = '0x0000000000000000000000000000000000000012';
const AVATAR_B = '0x0000000000000000000000000000000000000013';

const NAV_1 = '0x0000000000000000000000000000000000000020';
const NAV_2 = '0x0000000000000000000000000000000000000021';

const LAUNCHER = '0x00000000000000000000000000000000000000FF';

function makeRegistry(): ContractRegistry {
  return new ContractRegistry({ daoShipLauncher: LAUNCHER });
}

describe('ContractRegistry.registerDao', () => {
  it('stores the DAO and maps both tokens to it', () => {
    const r = makeRegistry();
    r.registerDao({ daoShipAddress: DAO_A, sharesAddress: SHARES_A, lootAddress: LOOT_A, avatar: AVATAR_A });

    expect(r.getDaoByDaoShipAddress(DAO_A)).toMatchObject({
      daoShipAddress: DAO_A,
      sharesAddress: SHARES_A,
      lootAddress: LOOT_A,
      avatar: AVATAR_A,
    });
    expect(r.getDaoByTokenAddress(SHARES_A)).toBe(DAO_A);
    expect(r.getDaoByTokenAddress(LOOT_A)).toBe(DAO_A);
    // avatar → DAO powers the BudgetNavigator vault-module watch
    expect(r.getDaoByAvatarAddress(AVATAR_A)).toBe(DAO_A);
    expect(r.getDaoByAvatarAddress(AVATAR_A.toUpperCase())).toBe(DAO_A);
    expect(r.daoCount).toBe(1);
  });

  it('drops the stale avatar mapping when a DAO is re-registered with a different avatar', () => {
    const r = makeRegistry();
    r.registerDao({ daoShipAddress: DAO_A, sharesAddress: SHARES_A, lootAddress: LOOT_A, avatar: AVATAR_A });
    r.registerDao({ daoShipAddress: DAO_A, sharesAddress: SHARES_A, lootAddress: LOOT_A, avatar: AVATAR_B });

    expect(r.getDaoByAvatarAddress(AVATAR_A)).toBeUndefined();
    expect(r.getDaoByAvatarAddress(AVATAR_B)).toBe(DAO_A);
  });

  it('normalizes all input addresses to lowercase', () => {
    const r = makeRegistry();
    r.registerDao({
      daoShipAddress: DAO_A.toUpperCase(),
      sharesAddress: SHARES_A.toUpperCase(),
      lootAddress: LOOT_A.toUpperCase(),
      avatar: AVATAR_A.toUpperCase(),
    });
    // Lookup via mixed case resolves
    expect(r.getDaoByDaoShipAddress(DAO_A)).toBeDefined();
    expect(r.getDaoByDaoShipAddress(DAO_A.toUpperCase())).toBeDefined();
    // Stored values are lowercase
    expect(r.getDaoByDaoShipAddress(DAO_A)!.sharesAddress).toBe(SHARES_A);
  });

  it('is a no-op when re-registering the same DAO with identical addresses', () => {
    const r = makeRegistry();
    r.registerDao({ daoShipAddress: DAO_A, sharesAddress: SHARES_A, lootAddress: LOOT_A, avatar: AVATAR_A });
    r.registerDao({ daoShipAddress: DAO_A, sharesAddress: SHARES_A, lootAddress: LOOT_A, avatar: AVATAR_A });

    expect(r.daoCount).toBe(1);
    expect(r.getAllTokenAddresses()).toHaveLength(2);
  });

  it('updates mappings when a DAO is re-registered with different token addresses', () => {
    const r = makeRegistry();
    r.registerDao({ daoShipAddress: DAO_A, sharesAddress: SHARES_A, lootAddress: LOOT_A, avatar: AVATAR_A });
    // Stale-mapping guard: re-register with new tokens must drop the old mappings.
    r.registerDao({ daoShipAddress: DAO_A, sharesAddress: SHARES_B, lootAddress: LOOT_B, avatar: AVATAR_A });

    expect(r.getDaoByTokenAddress(SHARES_A)).toBeUndefined(); // stale mapping removed
    expect(r.getDaoByTokenAddress(LOOT_A)).toBeUndefined();
    expect(r.getDaoByTokenAddress(SHARES_B)).toBe(DAO_A);
    expect(r.getDaoByTokenAddress(LOOT_B)).toBe(DAO_A);
    expect(r.daoCount).toBe(1);
  });
});

describe('ContractRegistry token lookups', () => {
  it('isSharesToken distinguishes shares from loot', () => {
    const r = makeRegistry();
    r.registerDao({ daoShipAddress: DAO_A, sharesAddress: SHARES_A, lootAddress: LOOT_A, avatar: AVATAR_A });

    expect(r.isSharesToken(SHARES_A)).toBe(true);
    expect(r.isSharesToken(LOOT_A)).toBe(false);
    expect(r.isSharesToken(DAO_A)).toBe(false); // not a token at all
  });

  it('isSharesToken is case-insensitive', () => {
    const r = makeRegistry();
    r.registerDao({ daoShipAddress: DAO_A, sharesAddress: SHARES_A, lootAddress: LOOT_A, avatar: AVATAR_A });
    expect(r.isSharesToken(SHARES_A.toUpperCase())).toBe(true);
  });

  it('returns undefined for unknown addresses', () => {
    const r = makeRegistry();
    expect(r.getDaoByDaoShipAddress(DAO_A)).toBeUndefined();
    expect(r.getDaoByTokenAddress(SHARES_A)).toBeUndefined();
    expect(r.isSharesToken(SHARES_A)).toBe(false);
  });

  it('getAllTokenAddresses returns both shares and loot across multiple DAOs', () => {
    const r = makeRegistry();
    r.registerDao({ daoShipAddress: DAO_A, sharesAddress: SHARES_A, lootAddress: LOOT_A, avatar: AVATAR_A });
    r.registerDao({ daoShipAddress: DAO_B, sharesAddress: SHARES_B, lootAddress: LOOT_B, avatar: AVATAR_B });

    const tokens = new Set(r.getAllTokenAddresses());
    expect(tokens).toEqual(new Set([SHARES_A, LOOT_A, SHARES_B, LOOT_B]));
  });

  it('getAllDaoShipAddresses returns all registered DAOs', () => {
    const r = makeRegistry();
    r.registerDao({ daoShipAddress: DAO_A, sharesAddress: SHARES_A, lootAddress: LOOT_A, avatar: AVATAR_A });
    r.registerDao({ daoShipAddress: DAO_B, sharesAddress: SHARES_B, lootAddress: LOOT_B, avatar: AVATAR_B });

    expect(new Set(r.getAllDaoShipAddresses())).toEqual(new Set([DAO_A, DAO_B]));
    expect(r.daoCount).toBe(2);
  });
});

describe('ContractRegistry navigators', () => {
  it('registers a navigator and maps it to its DAO', () => {
    const r = makeRegistry();
    r.registerNavigator(NAV_1, DAO_A);

    expect(r.getAllNavigatorAddresses()).toContain(NAV_1);
    expect(r.getDaoByNavigatorAddress(NAV_1)).toBe(DAO_A);
    expect(r.navigatorCount).toBe(1);
  });

  it('normalizes navigator and DAO addresses to lowercase', () => {
    const r = makeRegistry();
    r.registerNavigator(NAV_1.toUpperCase(), DAO_A.toUpperCase());
    expect(r.getDaoByNavigatorAddress(NAV_1)).toBe(DAO_A);
  });

  it('unregister removes the navigator from both the set and the map', () => {
    const r = makeRegistry();
    r.registerNavigator(NAV_1, DAO_A);
    r.unregisterNavigator(NAV_1);

    expect(r.getAllNavigatorAddresses()).not.toContain(NAV_1);
    expect(r.getDaoByNavigatorAddress(NAV_1)).toBeUndefined();
    expect(r.navigatorCount).toBe(0);
  });

  it('unregister is a no-op for unknown navigators', () => {
    const r = makeRegistry();
    r.unregisterNavigator(NAV_1);
    expect(r.navigatorCount).toBe(0);
  });

  it('allows multiple navigators for the same DAO', () => {
    const r = makeRegistry();
    r.registerNavigator(NAV_1, DAO_A);
    r.registerNavigator(NAV_2, DAO_A);

    expect(r.navigatorCount).toBe(2);
    expect(r.getDaoByNavigatorAddress(NAV_1)).toBe(DAO_A);
    expect(r.getDaoByNavigatorAddress(NAV_2)).toBe(DAO_A);
  });

  it('re-registering the same navigator overwrites its DAO mapping', () => {
    const r = makeRegistry();
    r.registerNavigator(NAV_1, DAO_A);
    r.registerNavigator(NAV_1, DAO_B);

    expect(r.getDaoByNavigatorAddress(NAV_1)).toBe(DAO_B);
    // Set semantics: still only one entry
    expect(r.navigatorCount).toBe(1);
  });
});

describe('ContractRegistry.clear', () => {
  it('empties all internal maps', () => {
    const r = makeRegistry();
    r.registerDao({ daoShipAddress: DAO_A, sharesAddress: SHARES_A, lootAddress: LOOT_A, avatar: AVATAR_A });
    r.registerDao({ daoShipAddress: DAO_B, sharesAddress: SHARES_B, lootAddress: LOOT_B, avatar: AVATAR_B });
    r.registerNavigator(NAV_1, DAO_A);
    r.registerNavigator(NAV_2, DAO_B);

    r.clear();

    expect(r.daoCount).toBe(0);
    expect(r.navigatorCount).toBe(0);
    expect(r.getAllDaoShipAddresses()).toEqual([]);
    expect(r.getAllTokenAddresses()).toEqual([]);
    expect(r.getAllNavigatorAddresses()).toEqual([]);
    expect(r.getDaoByDaoShipAddress(DAO_A)).toBeUndefined();
    expect(r.getDaoByNavigatorAddress(NAV_1)).toBeUndefined();
  });

  it('is idempotent', () => {
    const r = makeRegistry();
    r.clear();
    r.clear();
    expect(r.daoCount).toBe(0);
  });

  it('allows re-registration after clear', () => {
    const r = makeRegistry();
    r.registerDao({ daoShipAddress: DAO_A, sharesAddress: SHARES_A, lootAddress: LOOT_A, avatar: AVATAR_A });
    r.clear();
    r.registerDao({ daoShipAddress: DAO_A, sharesAddress: SHARES_A, lootAddress: LOOT_A, avatar: AVATAR_A });
    expect(r.daoCount).toBe(1);
    expect(r.getDaoByTokenAddress(SHARES_A)).toBe(DAO_A);
  });
});

describe('ContractRegistry counts', () => {
  it('daoCount reflects registered DAOs', () => {
    const r = makeRegistry();
    expect(r.daoCount).toBe(0);
    r.registerDao({ daoShipAddress: DAO_A, sharesAddress: SHARES_A, lootAddress: LOOT_A, avatar: AVATAR_A });
    expect(r.daoCount).toBe(1);
    r.registerDao({ daoShipAddress: DAO_B, sharesAddress: SHARES_B, lootAddress: LOOT_B, avatar: AVATAR_B });
    expect(r.daoCount).toBe(2);
  });

  it('navigatorCount reflects the navigator Set, not the map', () => {
    // Sanity check: these must stay in sync.
    const r = makeRegistry();
    r.registerNavigator(NAV_1, DAO_A);
    r.registerNavigator(NAV_2, DAO_B);
    expect(r.navigatorCount).toBe(2);
    expect(r.getAllNavigatorAddresses()).toHaveLength(2);

    r.unregisterNavigator(NAV_1);
    expect(r.navigatorCount).toBe(1);
    expect(r.getAllNavigatorAddresses()).toHaveLength(1);
  });
});
