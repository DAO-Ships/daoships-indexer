# Deferred: Batch Per-Log DB Round-Trips (Top-5 #1)

**Status: DEFERRED (2026-04-16).** Scale doesn't warrant the work yet, and the
architect's original proposal has a correctness trap that requires prerequisite
handler refactoring. This document captures the analysis and implementation
plans so the work can be picked up cold when triggered.

**Origin:** Backend Architect audit 2026-04-16 — "Top-5 Highest-Impact
Improvement #1" in `docs/AUDIT_VALIDATION_2026-04-16.md`.

---

## 1. Problem statement

`src/services/processor.ts:processLogs` dispatches logs serially, and each
dispatched log causes 2-7 Supabase HTTP round-trips:

| Handler | RTTs (common path, post-E1) |
|---|---|
| `handleTransfer` | 4-6 (getMember × 2 parallel + upsertMember × 2 + optional `updateActiveMemberCount` + `markLogProcessed` + amortized `recordEventTransaction`) |
| `handleSubmitVote` | 4-5 (`insertProposalIfAbsent` + `insertMemberIfAbsent` parallel + `upsertVote` + `incrementProposalVotes` + `incrementMemberVotes` + `markLogProcessed`) |
| `handleNewPost` | 3-5 (`getDao` + optional `getMember` + `upsert(ds_records)` + optional `updateDao` + `markLogProcessed`) |
| Mint/Burn/Ragequit | 2-3 (`adjustDaoTotals` + `markLogProcessed`) |

At 100 events/block × 500-block range = 50,000 logs = 100k–300k sequential
Supabase calls per poll cycle. At Supabase median latency ~50ms, that's 80+
minutes per poll. **This is the hard scalability ceiling.**

**Scale breakpoints (approximate, Supabase latency 50ms):**

| Events per range | Total RTTs | Wall clock per range |
|---|---|---|
| 10 (today, quiet range) | ~50 | 2.5 s |
| 50 (today, busy range) | ~250 | 12.5 s |
| 500 (10x growth) | ~2,500 | 2 min |
| 5,000 (100x growth, full mainnet) | ~25,000 | 20 min |

**Triggers to revisit this doc:** `/health` reports `blocksBehind > 100`
persistently, OR average range-processing time > 60s, OR `MAX_BLOCK_RANGE`
has been raised past 2000.

---

## 2. The idempotency complication

The architect's proposal was two-fold:

> 1. Batch `markLogProcessed` to end-of-range.
> 2. Pre-fetch members referenced in a batch via `WHERE id = ANY($1)`.

**The hidden precondition for (1): all handlers must be idempotent under
partial-failure retry.** They aren't.

### Current retry contract

`src/services/processor.ts:processLogs` marks each log as processed
**immediately after** the handler succeeds:

```ts
const { handled } = await this.dispatcher.dispatch(ctx);
if (handled) {
  await this.db.markLogProcessed(log.transactionHash, log.index, log.blockNumber);
  ...
}
```

On retry, `getProcessedLogKeys` skips already-marked logs. The bug window is
exactly **one log wide**: if `markLogProcessed` fails transiently AFTER the
handler succeeded, retry re-runs that handler.

### Non-idempotent handlers (audited 2026-04-16)

| Handler | File / line | Non-idempotent because |
|---|---|---|
| `handleMintShares` / `MintLoot` / `BurnShares` / `BurnLoot` | `src/handlers/daoship.ts` via `handleMintOrBurn:~83` | Calls `adjustDaoTotals(..., +delta, ...)` — delta math |
| `handleConvertSharesToLoot` | `src/handlers/daoship.ts:~838` | Same delta pattern |
| `handleRagequit` | `src/handlers/daoship.ts:~486-492` | Same, with negative delta |
| `handleTransfer` | `src/handlers/tokens.ts:~71-114` | Reads current balance → computes new → writes. Re-read after re-run sees already-updated value and adds `value` again |

### Safe handlers (pre-existing idempotency)

| Handler | Why safe |
|---|---|
| `upsertDao` / `upsertMember` / `upsertVote` / `upsertProposal` | PK conflict → update (same value re-applied is no-op) |
| `insertProposalIfAbsent` / `insertMemberIfAbsent` (E1) | `ignoreDuplicates: true` on PK |
| `ds_increment_proposal_votes` / `ds_increment_member_votes` / `ds_increment_proposal_count` / `ds_update_active_member_count` | Derive from truth (`COUNT`/`SUM` against source table) — idempotent |
| `updateDao` / `updateProposal` | Absolute-value writes |

### Why batch-mark widens the bug

With end-of-range batch `markLogProcessed`, the "handler succeeded but not yet
marked" window stretches to the **entire range**. A transient Supabase failure
between the last handler and the batch commit causes **every non-idempotent
handler in the range** to re-fire on retry → double-counted DAO totals,
double-applied Transfer balances. Ugly, persistent, and hard to detect
because the bookkeeping drifts silently.

---

## 3. Option A — Lazy per-range caches (Safe, modest)

### What it does

Introduce per-`processLogs`-call caches for read-heavy entities:
`getMember`, `getDao`, `getProposal`. Cache is empty at start of each range;
first read hits DB and populates; subsequent reads within the same range hit
the cache. Mutations (`upsertMember` etc.) update the cache in-place.

No change to `markLogProcessed` timing. No idempotency risk.

### Expected savings

| Scenario | RTTs saved per range |
|---|---|
| Quiet DAO (5-10 events, mostly different members) | 0-2 |
| Active DAO (50 events, ~15 unique members, frequent repeat) | 15-30 |
| Very active (500 events, ~30 unique members) | 200-400 |

Cache hit rate depends on member diversity. Realistic DAOs have a long-tail
distribution: a few dozen members dominate activity.

### Implementation plan

**File: `src/handlers/index.ts`** — extend `EventContext`:

```ts
export interface EventContext {
  log: Log;
  blockTimestamp: number;
  db: DatabaseService;
  blockchain: BlockchainService;
  registry: ContractRegistry;
  cache: RangeCache;  // NEW
}
```

**New file: `src/services/range-cache.ts`:**

```ts
import type { DaoRow, MemberRow, ProposalRow } from '../types/index.js';

export class RangeCache {
  private members = new Map<string, MemberRow | null>();
  private daos = new Map<string, DaoRow | null>();
  private proposals = new Map<string, ProposalRow | null>();

  getMember(id: string): MemberRow | null | undefined {
    return this.members.has(id) ? this.members.get(id)! : undefined;
  }
  setMember(id: string, row: MemberRow | null): void { this.members.set(id, row); }

  getDao(id: string): DaoRow | null | undefined {
    return this.daos.has(id) ? this.daos.get(id)! : undefined;
  }
  setDao(id: string, row: DaoRow | null): void { this.daos.set(id, row); }

  getProposal(id: string): ProposalRow | null | undefined {
    return this.proposals.has(id) ? this.proposals.get(id)! : undefined;
  }
  setProposal(id: string, row: ProposalRow | null): void { this.proposals.set(id, row); }

  clear(): void {
    this.members.clear();
    this.daos.clear();
    this.proposals.clear();
  }
}
```

**File: `src/services/processor.ts`** — construct `RangeCache` per
`processLogs` call, pass via `EventContext`:

```ts
private async processLogs(logs: Log[], fromBlock: number, toBlock: number): Promise<void> {
  ...
  const cache = new RangeCache();
  ...
  for (const log of logs) {
    ...
    const ctx: EventContext = {
      log,
      blockTimestamp,
      db: this.db,
      blockchain: this.blockchain,
      registry: this.registry,
      cache,  // NEW
    };
    ...
  }
}
```

**Callers to modify** (wrap `db.getX` with cache check):

1. `src/handlers/tokens.ts:handleTransfer` — sender + receiver `getMember` calls (lines ~57-67).
2. `src/handlers/tokens.ts:handleDelegateChanged` — if it reads member (it doesn't currently, just upserts).
3. `src/handlers/daoship.ts:handleSubmitVote` — no longer reads member directly (E1 removed the pre-read), but the `insertMemberIfAbsent` result could be cached for subsequent reads in same range.
4. `src/handlers/poster.ts:determineTrustLevel` — the `getMember` call for MEMBER trust check (line ~44).
5. `src/handlers/poster.ts:handleNewPost` — the `getDao(claimedDao)` call (lines ~459, ~496).

**Mutation paths to invalidate/update:**

- `handleTransfer` upserts → `cache.setMember(id, updatedRow)` after each upsert.
- `handleLaunchDAOShip*` upserts → `cache.setDao(id, row)`.
- `handleSetupComplete` / `handleGovernanceConfigSet` / etc. update DAO → invalidate via `cache.setDao(id, null)` or refetch.

### Implementation-level gotchas

1. **`upsertMember` in tokens.ts currently does not return the row.** Two
   options:
   - Change `upsertMember` to return the row via `.select().single()`.
   - Skip cache update on mutation; next read will re-fetch (acceptable
     since the caching handler already computed the new balance locally).
2. **Cache MUST be cleared on reorg recovery.** Today `BlockProcessor.clearCaches()` clears `blockCache`; add `cache.clear()` here too. But actually since
   `cache` is scoped to `processLogs`, it's already per-range and doesn't
   survive across ranges. No extra work.
3. **Handlers that use `ctx.db.getMember` directly bypass the cache.** Must
   audit every `getMember` / `getDao` / `getProposal` call site and route
   through the cache.

### Tests to add

- `test/unit/services/range-cache.test.ts` — basic get/set/clear.
- Extend `test/unit/handlers/tokens.test.ts` — verify a second Transfer
  from the same sender does NOT call `db.getMember` again (cache hit).

### Effort

- ~4 hours build + tests.
- Low regression risk.
- Gains modest at today's scale; grows roughly linearly with member reuse.

---

## 4. Option B — Full refactor (handler idempotency + batched writes)

### What it does

1. Convert all delta-based handlers to derive-from-truth RPCs (like
   `ds_update_active_member_count` already does).
2. Batch `markLogProcessed` at end-of-range.
3. Batch `upsertMember` and similar writes at end-of-range (collect mutations,
   flush once).
4. Optionally: multi-row upsert for `ds_records` etc.

### Expected savings

50-90% RTT reduction across the board. Transforms the 2-hour ceiling at 100x
scale into a ~10-minute one. See scale table in §1.

### Prerequisite: handler idempotency

Every non-idempotent handler in §2 must be rewritten to be idempotent under
replay. Strategy per handler:

#### `handleMintOrBurn` (calls `adjustDaoTotals`)

Replace `adjustDaoTotals(daoId, sharesDelta, lootDelta)` with a
derive-from-truth function that computes totals from `ds_members`:

```sql
CREATE OR REPLACE FUNCTION ds_recompute_dao_totals(p_dao_id TEXT) RETURNS void AS $$
BEGIN
  UPDATE ds_daos SET
    total_shares = COALESCE((SELECT SUM(shares) FROM ds_members WHERE dao_id = p_dao_id), 0),
    total_loot = COALESCE((SELECT SUM(loot) FROM ds_members WHERE dao_id = p_dao_id), 0)
  WHERE id = p_dao_id;
END; $$ LANGUAGE plpgsql;
```

Handler calls this instead of `adjustDaoTotals`. Now idempotent — replay
gives the same result.

**But**: This only works if `ds_members` itself is already updated correctly.
Transfer handler must also be idempotent — see below.

#### `handleTransfer` (reads balance, computes new, writes)

The core issue: the handler reads `ds_members.shares`, adds/subtracts
`value`, writes back. If replay runs against the already-updated row, it
re-adds `value`.

Fix: the handler should compute member balance from the
**source of truth** (Transfer events in `ds_records` or similar) rather than
accumulating deltas.

This is a much bigger refactor. Options:

1. **Track processed Transfers separately** — store each Transfer event in
   a new `ds_transfers` table (permanent, append-only), derive member
   balance via `SUM(value) WHERE to = member GROUP BY` minus `SUM(value)
   WHERE from = member GROUP BY`. Expensive per-write but idempotent.

2. **Server-side atomic update with replay check** — pass `log.transactionHash`
   + `log.index` to the upsert RPC; the RPC checks a local dedup table
   before applying the delta. Effectively moves `markLogProcessed`
   inside the same transaction as the balance update.

Option 2 is cleaner but requires a SQL function per handler.

#### `handleRagequit` / `handleConvertSharesToLoot`

Same pattern. Either use `ds_recompute_dao_totals` or transaction-scoped
dedup.

### Implementation plan outline

1. **Week 1 — Idempotency refactor:**
   - Write `ds_recompute_dao_totals`, `ds_recompute_member_balance` SQL functions.
   - Add per-handler SQL functions that do `mark-processed` + `update` in one
     transaction (one per handler: SubmitVote, Transfer, Mint/Burn/Convert,
     Ragequit).
   - Rewrite handlers to call the new RPCs.
   - Property tests: random replay of same log N times → final state same as
     once.

2. **Week 2 — Batching layer:**
   - Collect handler operations in an in-memory buffer within `processLogs`.
   - Flush in a single multi-op RPC at end-of-range.
   - Rework `markLogProcessed` to batch-insert the whole range.
   - Integration tests: failure mid-flush must leave state consistent
     (transaction rollback).

### Tests required

- Property tests for idempotency (fast-check or similar): generate random
  event sequences, verify replay produces same state.
- End-to-end reorg tests: reorg to forkpoint, verify recomputed balances
  match a from-scratch re-index.
- Partial-failure tests: simulate Supabase connection drop between
  handler buffer flush and markLogProcessed batch.

### Effort

- 1-2 weeks build.
- **High regression risk** — rewriting core math that's worked in production.
- Needs weeks of real-world runtime before trusted.
- Also fixes the latent double-count bug from §2 (narrow but real).

---

## 5. Interaction with already-shipped work

This cycle already shipped several items that overlap or set up Top-5 #1:

- **E1** (`handleSubmitVote` + `handleRagequit`): pre-reads replaced with
  parallel `insertProposalIfAbsent` / `insertMemberIfAbsent`. Saves 1 RTT
  per vote today. These new methods are already idempotent — no further
  work needed in §4 for this handler.
- **SC7** (`pruneProcessedLogs` guard): unrelated but adjacent.
- **M4 + M5** (reorg detection + cache clears): the `RangeCache` proposed in
  Option A must be added to `BlockProcessor.clearCaches()` if it's ever
  promoted to a field (Option A has it per-`processLogs`-call, so no).
- **A4** (`processor.test.ts`): covers `processLogs` orchestration —
  invaluable baseline for refactor validation.

The `ds_increment_*` derive-from-truth RPCs in `schema.sql` are the
template for Option B's `ds_recompute_*` functions.

---

## 6. Decision triggers

Revisit this doc when any of the following is true:

| Signal | Source | Threshold |
|---|---|---|
| Indexer falls behind tip | `/health` `blocksBehind` | > 100 sustained for > 10 min |
| Range processing latency | observability (not yet wired) | > 60s median |
| `MAX_BLOCK_RANGE` raised past 2000 | ops | any |
| DAO count | `ds_daos` size | > 300 |
| Event count per range | observability | > 500 median |
| User complaints about stale data | support | any |

**If triggered**, the ordered recommendation is:
1. Ship **Option A** first (1 day). Measure impact.
2. If still insufficient, start **Option B** (2 weeks). Do the handler
   idempotency refactor in isolation before the batching layer.

---

## 7. Context captured for cold-start

A future implementer needs to know:

- **The 7 non-idempotent handlers** (§2): MintShares, MintLoot, BurnShares,
  BurnLoot, ConvertSharesToLoot, Ragequit, Transfer.
- **The existing idempotency template**: see `ds_increment_proposal_votes`
  in `supabase/migrations/schema.sql:~438` for a handler RPC that derives
  state from source-of-truth tables.
- **The retry contract today**: per-log `markLogProcessed` after handler
  success; `ds_processed_logs` (schema.sql:~368) is the dedup table;
  `getProcessedLogKeys` reads it at start of `processLogs`.
- **The existing transient/deterministic classification**:
  `isTransientError` in `src/services/processor.ts:~31`. Transient errors
  (network / timeout) retry; deterministic errors (validation) log and
  skip.
- **Current RTT counts per handler**: see table in §1. Used as the baseline
  for measuring improvement.
- **Related memory notes**:
  `/home/mpoletiek/.claude/projects/-home-mpoletiek-Devspace-DAOSHIPS-daoships-indexer/memory/project_quai_poem_reorgs.md` —
  Quai's PoEM makes reorgs rare; so reorg-window correctness isn't the
  dominant concern when choosing between Options A and B.

---

*Created 2026-04-16. Update on revisit.*
