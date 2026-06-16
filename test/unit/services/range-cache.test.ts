import { describe, it, expect, vi } from 'vitest';
import { RangeCache, summarizeRangeCache } from '../../../src/services/range-cache.js';
import type { DaoRow, MemberRow } from '../../../src/types/index.js';

const memberRow = (id: string, shares = '100'): MemberRow => ({
  id,
  dao_id: 'dao-1',
  member_address: '0x' + '1'.repeat(40),
  shares,
  loot: '0',
  created_at: 'ts',
});

const daoRow = (id: string): DaoRow => ({
  id,
  created_at: 'ts',
  tx_hash: '0x' + 'a'.repeat(64),
  shares_address: '0x' + '2'.repeat(40),
  loot_address: '0x' + '3'.repeat(40),
  avatar: '0x' + '4'.repeat(40),
  launcher_contract: '0x' + '5'.repeat(40),
  default_expiry_window: 0,
  new_vault: false,
  voting_period: 0,
  grace_period: 0,
  proposal_offering: '0',
  quorum_percent: '0',
  sponsor_threshold: '0',
  min_retention_percent: '0',
  loot_paused: false,
  shares_paused: false,
  admin_locked: false,
  manager_locked: false,
  governor_locked: false,
  total_shares: '0',
  total_loot: '0',
  active_member_count: 0,
  proposal_count: 0,
  latest_sponsored_proposal_id: 0,
  profile_source: null,
});

describe('RangeCache — three-state peek', () => {
  it('peekMember returns undefined on miss, distinct from null known-absent', () => {
    const cache = new RangeCache();
    expect(cache.peekMember('m1')).toBeUndefined();
    cache.setMember('m1', null);
    expect(cache.peekMember('m1')).toBeNull();
    const row = memberRow('m1');
    cache.setMember('m1', row);
    expect(cache.peekMember('m1')).toBe(row);
  });

  it('peekDao returns undefined on miss, distinct from null known-absent', () => {
    const cache = new RangeCache();
    expect(cache.peekDao('d1')).toBeUndefined();
    cache.setDao('d1', null);
    expect(cache.peekDao('d1')).toBeNull();
    const row = daoRow('d1');
    cache.setDao('d1', row);
    expect(cache.peekDao('d1')).toBe(row);
  });

  it('invalidate removes the key (not sets to null)', () => {
    const cache = new RangeCache();
    cache.setMember('m1', memberRow('m1'));
    cache.invalidateMember('m1');
    expect(cache.peekMember('m1')).toBeUndefined();

    cache.setDao('d1', daoRow('d1'));
    cache.invalidateDao('d1');
    expect(cache.peekDao('d1')).toBeUndefined();
  });

  it('invalidate on missing key is a no-op (does not bump stats)', () => {
    const cache = new RangeCache();
    cache.invalidateMember('absent');
    cache.invalidateDao('absent');
    expect(cache.stats.invalidations).toBe(0);
  });
});

describe('RangeCache — fetch helpers', () => {
  it('fetchMember populates on miss, serves from cache on hit', async () => {
    const cache = new RangeCache();
    const fetchFn = vi.fn().mockResolvedValue(memberRow('m1'));
    const first = await cache.fetchMember('m1', fetchFn);
    const second = await cache.fetchMember('m1', fetchFn);
    expect(first).toEqual(memberRow('m1'));
    expect(second).toBe(first);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(cache.stats.memberHits).toBe(1);
    expect(cache.stats.memberMisses).toBe(1);
  });

  it('fetchDao populates on miss, serves from cache on hit', async () => {
    const cache = new RangeCache();
    const fetchFn = vi.fn().mockResolvedValue(daoRow('d1'));
    await cache.fetchDao('d1', fetchFn);
    await cache.fetchDao('d1', fetchFn);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(cache.stats.daoHits).toBe(1);
    expect(cache.stats.daoMisses).toBe(1);
  });

  it('fetch* caches null (known-absent) and serves it on subsequent calls', async () => {
    const cache = new RangeCache();
    const fetchFn = vi.fn().mockResolvedValue(null);
    const first = await cache.fetchMember('m1', fetchFn);
    const second = await cache.fetchMember('m1', fetchFn);
    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('concurrent fetches on the same key: second counted as hit, miss counter honest', async () => {
    const cache = new RangeCache();
    const fetchFn = vi.fn().mockResolvedValue(memberRow('m1'));
    // Both calls start before either awaits have resolved.
    const [a, b] = await Promise.all([
      cache.fetchMember('m1', fetchFn),
      cache.fetchMember('m1', fetchFn),
    ]);
    expect(a).toEqual(memberRow('m1'));
    expect(b).toEqual(memberRow('m1'));
    // Both calls ran fetchFn (duplicate work — the race signal).
    expect(fetchFn).toHaveBeenCalledTimes(2);
    // One true miss (the first to resolve) + one concurrent-miss
    // credited as a hit. `hits + misses` stays equal to call count.
    expect(cache.stats.memberMisses).toBe(1);
    expect(cache.stats.memberHits).toBe(1);
    expect(cache.stats.concurrentMisses).toBe(1);
  });

  it('invalidate forces the next fetch to re-run the fetchFn', async () => {
    const cache = new RangeCache();
    const fetchFn = vi.fn().mockResolvedValue(memberRow('m1'));
    await cache.fetchMember('m1', fetchFn);
    cache.invalidateMember('m1');
    await cache.fetchMember('m1', fetchFn);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(cache.stats.memberMisses).toBe(2);
  });
});

describe('RangeCache — setMember does not accept partial shapes (type contract)', () => {
  it('setMember stores a new reference each call (no in-place mutation)', () => {
    const cache = new RangeCache();
    const v1 = memberRow('m1', '100');
    const v2 = memberRow('m1', '80');
    cache.setMember('m1', v1);
    cache.setMember('m1', v2);
    expect(cache.peekMember('m1')).toBe(v2);
    // v1 is not mutated — important because handlers hold `sender`/`receiver`
    // variables captured before the setMember replaces the entry.
    expect(v1.shares).toBe('100');
  });
});

describe('summarizeRangeCache', () => {
  it('computes hit rates and size', async () => {
    const cache = new RangeCache();
    const fetchM = vi.fn().mockResolvedValue(memberRow('m1'));
    const fetchD = vi.fn().mockResolvedValue(daoRow('d1'));
    await cache.fetchMember('m1', fetchM); // miss
    await cache.fetchMember('m1', fetchM); // hit
    await cache.fetchMember('m1', fetchM); // hit
    await cache.fetchDao('d1', fetchD); // miss

    const s = summarizeRangeCache(cache);
    expect(s.memberHits).toBe(2);
    expect(s.memberMisses).toBe(1);
    expect(s.memberHitRate).toBeCloseTo(2 / 3);
    expect(s.daoHits).toBe(0);
    expect(s.daoMisses).toBe(1);
    expect(s.daoHitRate).toBe(0);
    expect(s.size).toBe(2);
  });

  it('returns zero hit rate when no reads were issued', () => {
    const cache = new RangeCache();
    const s = summarizeRangeCache(cache);
    expect(s.memberHitRate).toBe(0);
    expect(s.daoHitRate).toBe(0);
  });
});
