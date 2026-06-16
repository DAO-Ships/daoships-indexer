# Batch Per-Log DB Round-Trips (Top-5 #1)

**Status: Option A SHIPPED (2026-04-18). Option B SHIPPED (2026-04-18).**

Together with the unfiltered topic0 flip (docs §0.4), the indexer's
realistic DAO ceiling moves from ~1,000 (post-Option-A) to ~15,000–20,000
— well inside the 10k target. See §0.5 below for the full Option B
changelog.

**Origin:** Backend Architect audit 2026-04-16 — "Top-5 Highest-Impact
Improvement #1" in `docs/AUDIT_VALIDATION_2026-04-16.md`.

---

## 0. Option A shipped (2026-04-18)

The per-range read cache described in §3 landed in
`src/services/range-cache.ts` with the following deviations from the
original proposal (see "Decisions made" at the bottom of this file for
rationale):

- Scoped to `processBlockRange`, not `processLogs`, so the discovery-pass
  loop shares the warm cache across all passes for the same range.
- `MemberRow` + `DaoRow` only. Proposal cache surface was dropped because
  there are no hot-path `getProposal` consumers today.
- Invalidate-on-write is the default for mutations that don't produce a
  full row locally. Handlers that DO compute the full post-write row
  (the two Transfer debit/credit closures; the launcher skeleton) call
  `setMember` / `setDao` instead. `upsertMember` was NOT changed to
  return the row via `.select().single()` — the invalidate path is
  cheaper on writes and eliminates any partial-shape caching risk.
- Three-state peek API is wrapped by `fetchMember` / `fetchDao`
  helpers so handlers don't have to hand-roll the miss/absent/present
  check.
- Observability: `RangeCache.stats` counters are summarized at the end of
  every `processBlockRange` via a single `logger.info` line, and the
  last 10 summaries are retained in `BlockProcessor.recentRangeStats`
  for `/health` surfacing.
- Pre-existing self-transfer bug in `handleTransfer` (`from === to` was
  reading sender + receiver before either write, then letting credit
  overwrite debit with value + balance) was uncovered during audit and
  fixed in the same cycle by short-circuiting self-transfers to a single
  activity-touch upsert that leaves balance fields untouched.

Invalidation map (by file:line at the time of this writeup):

| Site | Action |
|---|---|
| `tokens.ts` sender/receiver debit/credit | `setMember(fullRow)` after `upsertMember` |
| `tokens.ts` self-transfer touch | `invalidateMember` (timestamps only) |
| `tokens.ts` DelegateChanged / DelegateVotesChanged | `invalidateMember` |
| `tokens.ts` updateActiveMemberCount | `invalidateDao` |
| `tokens.ts` handlePauseState → updateDao | `invalidateDao` |
| `daoship.ts` handleMintOrBurn → adjustDaoTotals | `invalidateDao` |
| `daoship.ts` handleSetupComplete → updateDao | `invalidateDao` |
| `daoship.ts` handleSubmitProposal → incrementProposalCount | `invalidateDao` |
| `daoship.ts` handleSponsorProposal → updateDao | `invalidateDao` |
| `daoship.ts` handleSubmitVote member-stub + incrementMemberVotes | `invalidateMember` |
| `daoship.ts` handleRagequit member-stub + adjustDaoTotals | `invalidateMember` + `invalidateDao` |
| `daoship.ts` handleGovernanceConfigSet → updateDao | `invalidateDao` |
| `daoship.ts` Lock factory → updateDao | `invalidateDao` |
| `daoship.ts` handleConvertSharesToLoot → adjustDaoTotals | `invalidateDao` |
| `daoship.ts` handleAdminConfigSet → updateDao | `invalidateDao` |
| `launcher.ts` handleLaunchDAOShipAndVault → upsertDao | `setDao(fullRow)` |
| `launcher.ts` handleLaunchDAOShip → upsertDao | `setDao(fullRow)` |
| `poster.ts` dao.profile / dao.profile.initial → updateDao | `invalidateDao` |

---

## 0.1 Scope traps (DO NOT EXPAND HERE)

These items looked tempting during implementation but expand the work
surface beyond what Option A can safely deliver. Anyone revisiting this
doc for Option B or follow-up work must keep them separate:

1. **Do NOT batch `markLogProcessed`.** §2 below enumerates 7
   non-idempotent handlers. Batching the dedup write to end-of-range
   widens the retry replay window from 1 log to the full range, causing
   double-counted DAO totals and re-applied Transfer balances. Requires
   Option B idempotency refactor first.
2. **Do NOT cache `getNavigatorByAddress`.** An intra-range
   `NavigatorDeployed → NewPost` sequence would see a stale cache miss
   and reject a legitimate post, breaking the H1 allowlist-root trust
   chain. If ever cached, invalidate on every `handleNavigatorDeployed`
   and never cache negative results.
3. **Do NOT promote `RangeCache` to a field on `BlockProcessor`.**
   Cross-range survival re-opens the reorg staleness window that M4
   closed. The per-`processBlockRange` scope is load-bearing.
4. **Do NOT bundle Top-5 #3 (lazy `getProcessedLogKeys`) with this
   work.** Cross-range dedup persistence has a different invalidation
   contract from the read cache.
5. **Do NOT cast `MemberUpsert` (partial) as `MemberRow`.** The
   `setMember` signature enforces this; a cast would defeat the
   type boundary and return a row with undefined balance fields on
   the next read.
6. **Do NOT log cached row contents.** Summaries only (hit/miss
   counters, size). The `/health` surface uses counters, not payloads.

---

## 0.5 Option B — SHIPPED (2026-04-18)

Handler idempotency refactor + end-of-range batched writes. Lands
together with unfiltered fetch (§0.4). Backward-compat was explicitly
NOT preserved — the old delta-based `adjustDaoTotals` path is kept only
for reorg recovery (`ds_delete_events_after_block`), not for any
Option B handler.

### SQL surface (schema.sql)

New functions + one unique index:

- **`ds_apply_transfer(tx_hash, log_index, block_number, dao_id, from,
  to, value, is_shares, timestamp)`** — atomic idempotent Transfer RPC.
  Dedups on `(tx_hash, log_index)` via `INSERT INTO ds_processed_logs
  ON CONFLICT DO NOTHING`; on claim, reads sender/receiver, computes
  new balances with floor-at-zero clamp, upserts both sides, detects
  zero-crossings for `active_member_delta`. Self-transfer (from == to
  non-zero) short-circuits to a timestamp-touch upsert. Mint (from ==
  0) skips the debit path; burn (to == 0) skips the credit path.
  Returns `(already_processed BOOLEAN, active_member_delta INT)`.
  Single transaction — replay-safe by construction.

- **`ds_recompute_dao_totals(dao_id)`** — derive-from-truth replacement
  for `adjustDaoTotals`. Called ONCE per dirty DAO at end-of-range
  (Security Engineer's B3 mandatory mitigation); `UPDATE ds_daos SET
  total_shares = SUM(ds_members.shares), total_loot = SUM(ds_members.loot)`.
  Idempotent by construction.

- **`ux_ds_delegations_dedup` (UNIQUE INDEX on `(tx_hash, delegator)`)** —
  closes the SERIAL-PK retry hole the Backend Architect identified.
  `handleDelegateChanged` relies on `DatabaseService.insert`'s existing
  23505 swallow for idempotency.

### Handler changes

- **`handleTransfer`** — rewritten from ~200 lines of client-side
  balance math to a ~50-line dispatcher into `ds_apply_transfer`. No
  more client-side `getMember`, no more partial-failure replay window.
  Returns early if the RPC reports `already_processed`.
- **`handleMintShares` / `MintLoot` / `BurnShares` / `BurnLoot` /
  `handleRagequit` / `handleConvertSharesToLoot`** — no longer call
  `adjustDaoTotals`. Instead, queue the `daoId` into
  `ctx.dirtyDaoIds`. The processor flushes one
  `ds_recompute_dao_totals(daoId)` per entry at end-of-range.
- **`handleDelegateChanged`** — relies on the unique index for
  replay-safety; `DatabaseService.insert` already swallows 23505.

### Dispatcher changes

`HandlerDispatcher.registerHandler` gained a third options parameter
`{ idempotent?: boolean }` (default true). The 2-arg boolean form
`registerHandler(iface, event, handler, unfiltered=true)` is still
accepted for backward compat with the unfiltered flip. `dispatch`
returns `{ handled, eventName, idempotent }`; the processor uses the
`idempotent` flag to gate the batched `markLogProcessed` path
(Security B1 fail-closed).

### Processor changes

- **`EventContext.dirtyDaoIds: Set<string>`** — new field accumulated
  across all logs in a range.
- End-of-range flush: loop over `dirtyDaoIds`, call
  `db.recomputeDaoTotals(daoId)` once each. Errors are logged but don't
  fail the range — member balances (the source of truth) are already
  persisted by `ds_apply_transfer`, so the next range touching the DAO
  will recompute again.
- **`DatabaseService.markLogsProcessedBatch(rows[])`** — multi-row
  upsert into `ds_processed_logs` chunked at 1000 rows per RPC
  (Security B4). Idempotent via PK conflict.
- `processLogs` accumulates handled-log marks into a per-range buffer
  and flushes at end-of-range via `markLogsProcessedBatch`. Any
  handler marked `idempotent: false` falls back to per-log
  `markLogProcessed` and flips an `allIdempotent` flag that logs a
  warning.

### RTT arithmetic

Before Option B (post-Option-A, post-Unfiltered):

- Transfer: 1 applyTransfer (would-be) + 4 RTTs of client-side reads+writes + 1 markLogProcessed + amortized updateActiveMemberCount = 5–6 RTTs/log
- Mint/Burn/Ragequit/Convert: 1 adjustDaoTotals + 1 markLogProcessed + updateActiveMemberCount = 2–3 RTTs/log
- markLogProcessed: 1 RTT per handled log

After Option B:

- Transfer: 1 RTT (ds_apply_transfer) + amortized updateActiveMemberCount (only on zero-crossing)
- Mint/Burn/Ragequit/Convert: 0 RTTs in the hot loop (just queue dirty DAO)
- End-of-range: N dirty-DAO recomputes (bounded, usually ≤ dozens) + 1 batched markLogProcessed upsert

Net: 4–7× RTT reduction on the hot path. Enables the 10k-DAO ceiling.

### Security mitigations landed

All Security Engineer mandatory mitigations from the pre-ship threat
model:

- **B1** — `HandlerDispatcher.isHandlerIdempotent` + dispatch-time
  flag; processor refuses batched markLogProcessed for any dispatched
  log flagged non-idempotent.
- **B2** — handler write + dedup claim in one transaction
  (`ds_apply_transfer`). No client-side sequencing of
  `markLogProcessed` and balance updates.
- **B3** — dirty-DAO set; recompute runs ONCE per DAO at
  end-of-range, never per-log.
- **B4** — `markLogsProcessedBatch` chunked at 1000 rows to stay under
  Supabase's 30s statement timeout.
- **B5** — no `SECURITY DEFINER` on new functions; all
  `LANGUAGE plpgsql` matches existing convention. Service-role grant
  via schema default.
- **B6** — no caller-passed aggregate params; recompute always SUMs
  from source tables.
- **B7** — Transfer idempotency shipped BEFORE recompute is used for
  totals. Recompute reads the authoritative ds_members data that
  `ds_apply_transfer` maintains.

### Tests

- `test/unit/property/transfer-idempotency.property.test.ts` (4
  fast-check properties): N-way dispatch yields N identical applyTransfer
  payloads; already-processed never bumps dirtyDaoIds; not-processed
  always does; mixed sequences reflect first real apply.
- Handler unit tests rewritten to assert the new contract (applyTransfer
  call shape; dirtyDaoIds accumulation; no per-log adjustDaoTotals).
- Processor tests assert end-of-range batched markLogProcessed + fall-
  back path for non-idempotent handlers.

### Verification

- `npm run typecheck` clean
- `npm run test:run` — 346 unit tests pass
- Schema migration required before deploy: `SELECT create_ds_schema('<env>')`
  for each environment. New functions + unique index are additive;
  existing tables/data are preserved.

### Rollback

- No rollback at the handler level — Option B code is the new baseline.
- If `ds_apply_transfer` has a bug in production, `FETCH_MODE=scoped`
  does NOT help (Option B changes write path, not read path).
- Schema-level rollback: the old `ds_adjust_dao_totals` function is
  preserved for reorg-recovery compatibility. A full rollback would
  require git-revert on the handler diff.

---

## 0.4 Unfiltered topic0 fetching — SHIPPED (2026-04-18)

Audit items A3 + SC1 + Security Engineer mandatory mitigations U1/U2/U4/U6.
Shipped in the same cycle as Option A cache + pre-ship Option B scaffolding.

**27 of 30 topics flipped to unfiltered**; `Transfer`, `Paused`, and
`Unpaused` stay scoped because their topic0 hashes are universally
common (every ERC-20 / every OZ Pausable on chain). Re-evaluate once
Quai's ERC-20 ecosystem fills in.

### Config surface
`src/config.ts` adds a `fetch` block:

| Var | Default | Purpose |
|---|---|---|
| `FETCH_MODE` | `hybrid` | `scoped` \| `unfiltered` \| `hybrid`. Hybrid respects per-handler flag. Scoped forces all scoped (rollback). Unfiltered forces all unfiltered (override for measurement) |
| `UNFILTERED_TOPICS` | `` | Comma-sep topic0 hashes to force unfiltered regardless of mode |
| `FETCH_MAX_LOGS_PER_CALL` | `100000` | U1 — hard cap per getLogs response; triggers bisect on breach |
| `FETCH_MAX_BYTES_PER_CALL` | `52428800` (50 MB) | U1 — approx byte cap per getLogs response |
| `FETCH_MIN_BISECT_RANGE` | `1` | Lower bound for bisect recursion; below this the oversize error surfaces |

### Security mitigations landed
- **U1/U6** (`src/services/blockchain.ts`): `getLogs` post-fetch size/count
  check throws a tagged `oversize response` error on breach. Protects
  against response-size DoS at chain-wide volume.
- **U1/U6 bisect** (`src/services/processor.ts:fetchWithBisect`):
  catches the oversize error, splits the block range in half, retries
  both halves. Recurses until `minBisectRange` or until a leaf succeeds.
  Non-oversize errors propagate unchanged.
- **U2** (`src/handlers/launcher.ts`, `src/handlers/poster.ts`): emitter
  address validated against `config.contracts` before any write. Spoofed
  events from unauthorized emitters are silently dropped. DAOShip event
  handlers are implicitly protected via the `ds_proposals.dao_id → ds_daos.id`
  FK constraint chain — spoofed events fail the insert.
- **U4**: documented design decision — no pre-filter in `fetchAllLogs`;
  handlers perform their own registry check. Mid-range registrations
  resolve naturally via the launcher-first log sort.
- **Per-topic observability** (`src/services/processor.ts:recentRangeStats`):
  tracks log count per topic0 per range; surfaced via `/health` so ops
  see trend before hitting caps.

### Ceiling update
Before flip: ~1,000 DAOs (address-chunked getLogs = 400 RPC calls/range).
After flip: expected ~5,000 DAOs (27 topics = flat 27 RPC calls/range,
plus 3 scoped topics = DAO-count-proportional). Chain-wide log volume
becomes the new ceiling; per-topic counters + U1/U6 bisect provide the
guard rail. Option B (write-path batching) still needed for 10k.

### Rollback
`FETCH_MODE=scoped` env flip, restart. No schema change, no state drift.

### Verification
- `npm run typecheck` clean
- `npm run test:run` — 344 unit tests pass (338 pre-flip + 6 bisect coverage)
- `scripts/bench-filter.ts` budget: ≤100k logs/range at 280k logs/sec
- `scripts/measure-log-volume.ts` run against mainnet + testnet: 0 logs
  across all 24 topics (Quai + DAO Ships too new to extrapolate from —
  flip is free today)

---

## 0.3 Measurement spike (Option B + unfiltered fetch)

Option B and the unfiltered-topic0 scaling fetch are both gated on a
measurement spike. Two tools land in `scripts/`:

### `npm run measure:log-volume -- --from-block N --to-block M`

Hits Quai RPC with an UNFILTERED `getLogs` per registered topic0 over a
sample range. Reports per-topic log count, approximate bytes, distinct
emitting addresses, and a provisional FLIP / NO-FLIP verdict against the
default thresholds (50k logs, 50MB bytes per range).

Reads only — safe against mainnet. Requires `RPC_URL` in env.

**Run 2–3 sample ranges spanning different chain activity profiles**
(quiet vs. busy). For each topic, decide:

- **Flip to unfiltered** if logCount < 50,000 AND bytes < 50 MB across
  all samples. Non-collision-prone topics (everything except `Transfer`,
  `Paused`/`Unpaused`, `Approval`) usually clear this trivially because
  only DAO Ships contracts emit them.
- **Stay scoped** if either threshold is breached. Most critical for
  `Transfer` (topic0 `0xddf252ad...` is every ERC20 on chain).
- **Measure further** if borderline — sample more ranges before flipping.

### `npm run bench:filter`

Synthetic benchmark of the in-process registry filter at 10k-DAO scale.
No RPC, no DB — pure CPU/memory. Budget guide per 5-second poll:

| Filter wall-clock | Verdict |
|---|---|
| <50 ms | Free, noise-level |
| 50–500 ms | Acceptable |
| >500 ms | Redesign required (streaming filter, worker thread, or stay scoped) |

**Observed (10k DAOs, 1% match rate, V8 with --expose-gc):**

| Input logs | Kept | Filter wall | Heap delta |
|---|---|---|---|
| 10,000 | ~90 | ~50 ms | ~30 MB |
| 100,000 | ~1,000 | ~350 ms | ~200 MB |
| 1,000,000 | ~10,000 | ~3,400 ms | ~1.7 GB |

**Takeaway:** filter CPU scales ~linearly (~280k logs/sec). At 1M
logs/range we blow both the wall-clock budget (>3s) AND heap ceiling
(~1.7 GB pressure on a 2 GB container). Hard cap per range must be
enforced client-side — aligns with Security Engineer's U1 mandatory
mitigation. Practical cap: **100k logs per range** for a 1 GB process.

### Decision rule (combined)

A topic flips to unfiltered only when ALL hold:

1. Real-Quai `measure:log-volume` verdict is FLIP across 3 sample ranges.
2. Synthetic filter cost at the observed logCount stays under 500 ms.
3. Raw response size per range stays under the RPC provider's cap AND
   under the client-side byte limit we set (proposal: 100 MB).

Transfer will almost certainly fail (1) and possibly (2) at mainnet
scale — plan to keep it scoped until a dedicated measurement says
otherwise.

---

## 0.2 Decisions made

1. **Cache scope: `processBlockRange`, not `processLogs`.** Lets the
   discovery-pass loop share warm entries across passes within the same
   range. Same reorg-safety guarantee because the cache dies with the
   function frame.
2. **Invalidate-on-write > `.select().single()` for partial writes.**
   Changing `upsertMember` to return the row would require a
   `.select().single()` on every write path, costing an RTT per write.
   Invalidating is cheaper and removes the partial-shape caching risk
   at the type boundary.
3. **Write-after-success rule is load-bearing.** Any handler that
   populates the cache before the DB write resolves would leave a
   post-mutation row in cache if the write then fails deterministically
   and the log is skipped. All `setMember`/`setDao` calls land AFTER
   the corresponding `await ctx.db.upsertX(...)`.
4. **Drop Proposal cache surface.** No hot-path consumers; API was
   forward-looking dead code. Re-add when a consumer appears.
5. **Invalidate after `incrementMemberVotes`.** The RPC updates
   `votes`/`last_activity_at` server-side. Even though no current
   handler reads those fields from a cached row, invalidating keeps the
   "any write invalidates cache[X]" invariant intact.
6. **E6 `Promise.all` race accepted.** Two concurrent `fetchMember`
   calls on the same key both miss on the first Transfer of a range.
   Tracked via `stats.concurrentMisses`; promotable to promise-
   memoization if post-deploy data shows it as a hot path.

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
