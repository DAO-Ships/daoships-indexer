import type { DaoRow, MemberRow } from '../types/index.js';

/**
 * Per-`processBlockRange` read cache for `ds_members` and `ds_daos`.
 *
 * Designed to eliminate redundant Supabase round-trips within a single block
 * range. A range typically touches a small set of members and DAOs many
 * times (the same sender appears across multiple Transfer events, the same
 * DAO is resolved by `determineTrustLevel` for every NewPost, etc.).
 *
 * ── Scope and lifetime ─────────────────────────────────────────
 *
 * Instantiated in `BlockProcessor.processBlockRange` and passed through
 * `EventContext.cache`. Shared across the inner `processLogs` loop AND
 * its discovery-pass re-invocations for the same range, so a DAO fetched
 * during pass 1 is still warm when pass 2 handles a newly-discovered
 * navigator's events.
 *
 * MUST NOT be promoted to a field on `BlockProcessor` — cross-range
 * survival would re-introduce the reorg staleness window that M4 closed
 * (`processor.ts:clearCaches`). The cache dies with the function frame.
 *
 * ── Write-after-success contract (load-bearing) ─────────────────
 *
 * Callers MUST update the cache only AFTER the corresponding DB write
 * succeeds. A handler that calls `setMember` before awaiting `upsertMember`
 * and then encounters a deterministic error leaves a post-mutation row in
 * the cache that the next handler in the range reads as authoritative —
 * silent balance drift. Pattern:
 *
 *   await ctx.db.upsertMember(...);     // succeeds or throws
 *   cache.setMember(id, fullRow);        // only reached on success
 *
 * ── Three-state semantics ──────────────────────────────────────
 *
 * `peek*` methods return:
 *   `undefined` — cache miss, fetch needed
 *   `null`      — known absent (confirmed no DB row)
 *   `Row`       — known present
 *
 * The `fetch*` helpers wrap this three-state check so call sites don't
 * duplicate the `=== undefined` / `!= null` dance.
 *
 * ── Partial-shape trap ─────────────────────────────────────────
 *
 * `setMember` takes a full `MemberRow`, NOT `MemberUpsert`. TypeScript
 * enforces this at the type boundary — do not cast. Caching a partial
 * (e.g., a DelegateChanged upsert payload without shares/loot) would
 * return a `MemberRow` with undefined balance fields on the next read,
 * coercing to `'0'` downstream and corrupting Transfer math. For any
 * handler that doesn't compute the full post-write row locally, call
 * `invalidateMember` / `invalidateDao` instead.
 */
export class RangeCache {
  // Three-state: absent from Map = miss; value = null or row.
  private members = new Map<string, MemberRow | null>();
  private daos = new Map<string, DaoRow | null>();

  readonly stats = {
    /**
     * Reads served from cache (no distinct-key DB fetch). Includes both
     * true pre-populated hits AND "concurrent hits" — fetches that raced
     * another inflight fetch and discovered the cache was populated by
     * the time their await resolved. A serialized cache would have
     * served those as hits, so they're counted here for an honest
     * efficacy ratio.
     */
    memberHits: 0,
    /**
     * Reads that triggered a DB fetch AND were the sole fetch for their
     * key (no concurrent race). `memberHits + memberMisses` equals
     * total `fetchMember` calls, so hit rate is a clean ratio.
     */
    memberMisses: 0,
    daoHits: 0,
    daoMisses: 0,
    invalidations: 0,
    /**
     * Diagnostic counter: how many `fetchMember`/`fetchDao` calls ran a
     * duplicate DB fetch because a parallel call was already inflight.
     * SUBSET of `memberHits + daoHits` — each concurrent miss is also
     * credited as a hit. Non-zero values indicate intra-handler
     * `Promise.all` patterns (e.g., `handleTransfer`) that could benefit
     * from promise memoization. Not part of the hit-rate denominator.
     */
    concurrentMisses: 0,
  };

  peekMember(id: string): MemberRow | null | undefined {
    return this.members.has(id) ? this.members.get(id)! : undefined;
  }

  setMember(id: string, row: MemberRow | null): void {
    this.members.set(id, row);
  }

  invalidateMember(id: string): void {
    if (this.members.delete(id)) this.stats.invalidations += 1;
  }

  peekDao(id: string): DaoRow | null | undefined {
    return this.daos.has(id) ? this.daos.get(id)! : undefined;
  }

  setDao(id: string, row: DaoRow | null): void {
    this.daos.set(id, row);
  }

  invalidateDao(id: string): void {
    if (this.daos.delete(id)) this.stats.invalidations += 1;
  }

  /**
   * Read-through helper. Checks the cache; on miss, calls `fetchFn`
   * and populates. Race-aware: if two concurrent callers hit the same
   * missing key, both will invoke `fetchFn` (Map writes are synchronous
   * but awaits are not) — the second populate is tracked via
   * `stats.concurrentMisses` for observability.
   */
  async fetchMember(id: string, fetchFn: () => Promise<MemberRow | null>): Promise<MemberRow | null> {
    const peeked = this.peekMember(id);
    if (peeked !== undefined) {
      this.stats.memberHits += 1;
      return peeked;
    }
    const row = await fetchFn();
    // Classify AFTER the await: if another fetch populated while we
    // waited, this is a concurrent race — count as hit so the efficacy
    // ratio isn't distorted by parallel fetch patterns.
    if (this.members.has(id)) {
      this.stats.concurrentMisses += 1;
      this.stats.memberHits += 1;
    } else {
      this.stats.memberMisses += 1;
    }
    this.members.set(id, row);
    return row;
  }

  async fetchDao(id: string, fetchFn: () => Promise<DaoRow | null>): Promise<DaoRow | null> {
    const peeked = this.peekDao(id);
    if (peeked !== undefined) {
      this.stats.daoHits += 1;
      return peeked;
    }
    const row = await fetchFn();
    if (this.daos.has(id)) {
      this.stats.concurrentMisses += 1;
      this.stats.daoHits += 1;
    } else {
      this.stats.daoMisses += 1;
    }
    this.daos.set(id, row);
    return row;
  }

  /** Total rows cached (useful for logging + bounding checks). */
  size(): number {
    return this.members.size + this.daos.size;
  }
}

/**
 * Summary of cache efficacy for a single processBlockRange call. Emitted
 * via `logger.info` at the end of `processLogs` and retained in
 * `BlockProcessor.recentRangeStats` for `/health` surfacing.
 */
export interface RangeCacheSummary {
  memberHits: number;
  memberMisses: number;
  memberHitRate: number;
  daoHits: number;
  daoMisses: number;
  daoHitRate: number;
  invalidations: number;
  concurrentMisses: number;
  size: number;
}

export function summarizeRangeCache(cache: RangeCache): RangeCacheSummary {
  const { memberHits, memberMisses, daoHits, daoMisses, invalidations, concurrentMisses } = cache.stats;
  const memberTotal = memberHits + memberMisses;
  const daoTotal = daoHits + daoMisses;
  return {
    memberHits,
    memberMisses,
    memberHitRate: memberTotal === 0 ? 0 : memberHits / memberTotal,
    daoHits,
    daoMisses,
    daoHitRate: daoTotal === 0 ? 0 : daoHits / daoTotal,
    invalidations,
    concurrentMisses,
    size: cache.size(),
  };
}
