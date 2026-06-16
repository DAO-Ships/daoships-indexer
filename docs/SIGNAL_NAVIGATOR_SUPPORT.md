# Indexing the SignalNavigator

> **⚠️ SUPERSEDED (2026-06-08) by [`NAVIGATOR_TRUST_ARCHITECTURE_PLAN.md`](NAVIGATOR_TRUST_ARCHITECTURE_PLAN.md).**
> Written when the SignalNavigator looked like an isolated add. The contracts docs were then
> overhauled into a full navigator **trust + lifecycle** model (`dao_id` bound at
> `NavigatorDeployed`, `permission_ever_granted`, `trust_status`, the `daoships.dao.navigators`
> sanctioning tag, and a rewritten prune predicate). The event-mechanics here (§3–§6) are still
> accurate; the discovery/`is_active` design (§2) is **subsumed and corrected** by the new plan.
> Read the architecture plan first.

How to support DAO Ships' `SignalNavigator` in this indexer. Contract reference:
`daoships-contracts/contracts/navigators/SignalNavigator.sol`, docs
`daoships-contracts/docs/NAVIGATORS.md` (SHIPPED section) and
`daoships-contracts/docs/INDEXER-GUIDE.md` (§4 "PollCreated / Voted / PollCancelled").

> **STATUS: PLANNING (2026-06-08).** Contract shipped & audited on the contracts side
> (`contracts/navigators/SignalNavigator.sol`, deploy `006_deploy_signal_navigator.ts`).
> No indexer code written yet. This doc is the build plan.

**TL;DR.** Event *capture* is nearly free — this indexer already fetches navigator
event topics **unfiltered** (chain-wide topic0 scan), so it does **not** rely on
`NavigatorSet` to discover navigator addresses for monitoring. The contract doc's headline
pitfall ("indexers that monitor only via `NavigatorSet` index zero polls") **does not bite
our event ingestion.** It bites exactly one thing here: the `ds_navigators` **metadata row**,
which today is written as a dao-less *orphan* on `NavigatorDeployed` and only promoted (DAO +
`is_active`) by a later `NavigatorSet` that, for a read-only navigator, **never comes**. That
single discovery gap plus two new tables and three new handlers is the whole job.

---

## 1. What already works (no change)

| Event | Emitted by | Existing path | Result |
|---|---|---|---|
| `NavigatorDeployed(address,address,string,string,string)` | SignalNavigator ctor | `handleNavigatorDeployed` (unfiltered topic0) | A `ds_navigators` row is written — but as an **orphan** (`dao_id=NULL`, `is_active=false`). See the gap in §2. |
| `getLogs` topic scan | processor `fetchAllLogs` | unfiltered fetch | New poll-event topic0s are pulled chain-wide with no per-navigator registration, exactly like `Onboard` / `NFTClaimed`. **No change to fetch strategy.** |

Notably there is **no** `Onboard`, no `NavigatorSet`, no `Paused`/`Unpaused` for this navigator
(it never mints, never registers, has no pause). So unlike NFTGated, *none* of the shared
onboarding plumbing applies — every poll event is net-new.

---

## 2. The one discovery gap — orphan never gets promoted

`handleNavigatorDeployed` (`src/handlers/daoship.ts`) deliberately writes `dao_id=NULL`,
`is_active=false`, and relies on `handleNavigatorSet` to set the DAO association, `permission`,
and `is_active=true`. A `SignalNavigator` holds **no permission and never calls
`setNavigators()`**, so **no `NavigatorSet` ever fires** and the row stays orphaned forever —
then gets reaped by `ds_prune_orphaned_navigators` (deletes `dao_id IS NULL` rows past
retention). Polls would then reference a navigator with no metadata row.

**Fix — type-routed self-promotion in `handleNavigatorDeployed`.** When `navigatorType` is a
known **permissionless** type (`"SignalNavigator"`), and the event's `daoShip` is a DAO we
index (`registry.getDaoByDaoShipAddress(daoShip)` is set), write the row *complete* on deploy:

- `dao_id = daoShip` (from the event — it carries the indexed association)
- `permission = 0`, `permission_label = 'none'`
- `is_active = TRUE`  ← **read-only, not revoked.** Distinct from a `NavigatorSet(addr, 0)`
  revocation, which means `is_active = FALSE`.
- `navigator_type`, `deployer`, `name`, `description` as today
- also `registry.registerNavigator(navigator, daoShip)` so it is a known address (harmless;
  event capture does not depend on it because the topics are unfiltered)

If the `daoShip` is **not** a DAO we index, keep the existing orphan behavior (`dao_id=NULL`) —
that naturally filters out SignalNavigators belonging to DAOs outside our scope, and the
prune reaps them as before.

Keep a small allowlist of permissionless types so this stays explicit:

```ts
const PERMISSIONLESS_NAVIGATOR_TYPES = new Set(['SignalNavigator']);
```

**Ordering note.** A `SignalNavigator` is deployed *after* its DAO exists, so by the time we
see `NavigatorDeployed` the `ds_daos` row is normally present and the
`ds_navigators.dao_id → ds_daos(id)` FK is satisfied. The "DAO in registry?" guard above is
also the FK guard — if the DAO isn't known yet, we write the orphan (no FK risk) rather than
failing the upsert.

---

## 3. New events — three handlers

Register all three **unfiltered** (matching `Onboard` / `NFTClaimed`), in a new
`src/handlers/signal.ts`, wired in `registerAllHandlers` (`src/index.ts`):

```solidity
event PollCreated(uint256 indexed pollId, address indexed creator, string question,
                  uint8 optionCount, uint64 snapshotTimestamp, uint64 votingStarts, uint64 votingEnds);
event Voted(uint256 indexed pollId, address indexed voter, uint8 indexed option, uint256 weight);
event PollCancelled(uint256 indexed pollId, address indexed caller);
```

topic0s:
- `keccak256("PollCreated(uint256,address,string,uint8,uint64,uint64,uint64)")`
- `keccak256("Voted(uint256,address,uint8,uint256)")`
- `keccak256("PollCancelled(uint256,address)")`

Each handler resolves DAO from the **navigator address** (the poll events do **not** carry the
DAO), reusing the existing `getDaoFromNavigator(ctx, navigatorAddress)` helper in
`navigators.ts` (registry → LRU cache → on-chain `daoShip()` fallback). `pollId` is
**per-navigator** — key every row by `(navigator_address, poll_id)`.

**`handlePollCreated`** — upsert a `ds_signal_polls` row, id = `{navigator}-{pollId}`. Store
`creator`, `question` (IPFS CID or short text — resolve off-chain like proposals/Poster),
`option_count`, `snapshot_timestamp`, `voting_starts`, `voting_ends`, `block_number`. **Do not
store a status column** — status is time-derived (§5).

**`handleVoted`** — upsert a `ds_signal_votes` row, id = `{navigator}-{pollId}-{voter}`. Store
`option`, `weight` (snapshot **share** power straight from the event — loot excluded; never
re-derive from balances), `block_number`. One vote per address per poll is enforced on-chain,
so the `(navigator,poll,voter)` unique key makes replay/reorg idempotent. **Do not** do
`tally[option] += weight` on the poll row — that delta is not idempotent (§4).

**`handlePollCancelled`** — set `ds_signal_polls.cancelled = TRUE` (terminal). Ignore later
events for a cancelled poll.

---

## 4. Idempotency & the tally — derive-from-truth, not increment

Handlers default to `idempotent: true` (enables batched `markLogProcessed`). An incrementing
`tally[option] += weight` on `PollCreated`'s row would double-count on any replay/reorg
re-dispatch — **not** idempotent. Two acceptable designs; **(A) is recommended** as it mirrors
the existing Option-B dirty-DAO recompute and the NFT-claims "store the row, aggregate later"
approach:

- **(A) Votes are the source of truth; tally is derived.** `ds_signal_votes` rows are
  idempotent by unique key. Compute per-option totals as `SUM(weight) GROUP BY option` — either
  a read-time SQL view / RPC, or a recompute function `ds_recompute_poll_tally(poll_pk)` driven
  by a `dirtyPollIds` set flushed once per range (exactly like `dirtyDaoIds` →
  `ds_recompute_dao_totals`). Idempotent and reorg-safe by construction.
- **(B) Materialized array, recomputed not incremented.** Keep `tally NUMERIC(78,0)[]` on the
  poll row but recompute it from the vote rows on each touch. Simpler reads, but you re-sum on
  every vote; only worth it if read latency matters more than write cost.

Either way: **never** trust current balances for weight, and **never** increment by delta.

---

## 5. Status is time-derived — do not persist it

There is no "poll opened" / "poll ended" event. Mirror the contract's `pollStatus()` at read
time (frontend or a SQL/generated expression), never a stored column that goes stale:

- `Cancelled` if `cancelled` (terminal, overrides all)
- `Pending`  while `now < voting_starts`
- `Active`   while `voting_starts <= now < voting_ends`  (half-open window)
- `Ended`    once `now >= voting_ends`

---

## 6. Suggested schema (model on `ds_nft_claims`)

The contract doc's suggested DDL omits `block_number`; **add it** — it is required by the reorg
prune (`ds_remove_events_after` does `DELETE ... WHERE block_number > p_block_number`).

```sql
-- SignalNavigator polls (non-binding temperature checks)
CREATE TABLE IF NOT EXISTS %I.ds_signal_polls (
    id TEXT PRIMARY KEY,                       -- {navigator_address}-{poll_id}
    dao_id VARCHAR(42) NOT NULL REFERENCES %I.ds_daos(id) ON DELETE CASCADE,
    navigator_address VARCHAR(42) NOT NULL,
    poll_id NUMERIC(78,0) NOT NULL,            -- per-navigator, starts at 0
    creator VARCHAR(42) NOT NULL,
    question TEXT,                             -- IPFS CID or short text
    option_count SMALLINT NOT NULL,            -- 2..10
    snapshot_timestamp BIGINT NOT NULL,        -- votingStarts - 1 (weight timepoint)
    voting_starts BIGINT NOT NULL,
    voting_ends BIGINT NOT NULL,
    cancelled BOOLEAN DEFAULT FALSE,
    tally NUMERIC(78,0)[] DEFAULT '{}',        -- optional (design B); else derive from votes
    created_at TIMESTAMPTZ NOT NULL,
    tx_hash VARCHAR(66) NOT NULL,
    block_number BIGINT NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(navigator_address, poll_id)
);

-- SignalNavigator votes (one row per address per poll)
CREATE TABLE IF NOT EXISTS %I.ds_signal_votes (
    id TEXT PRIMARY KEY,                       -- {navigator_address}-{poll_id}-{voter}
    poll_pk TEXT NOT NULL REFERENCES %I.ds_signal_polls(id) ON DELETE CASCADE,
    dao_id VARCHAR(42) NOT NULL REFERENCES %I.ds_daos(id) ON DELETE CASCADE,
    navigator_address VARCHAR(42) NOT NULL,
    poll_id NUMERIC(78,0) NOT NULL,
    voter VARCHAR(42) NOT NULL,
    option SMALLINT NOT NULL,                  -- 0..option_count-1
    weight NUMERIC(78,0) NOT NULL,             -- snapshot SHARE weight (loot excluded)
    created_at TIMESTAMPTZ NOT NULL,
    tx_hash VARCHAR(66) NOT NULL,
    block_number BIGINT NOT NULL,
    UNIQUE(navigator_address, poll_id, voter)
);
```

**Reorg ordering caveat for the `poll_pk` FK.** `PollCreated` always precedes any `Voted` for
the same poll (you cannot vote in a poll that does not exist), and within a range logs are
processed in `(block, logIndex)` order, so the parent poll row exists first. Across ranges the
parent is already persisted. The one residual risk is a `Voted` whose `PollCreated` we skipped
(e.g. navigator's DAO not yet known) — handle it the same way other handlers handle unknown
emitters: resolve DAO; if the poll row is absent, either upsert a stub poll or `warn` + skip
rather than letting the FK throw. Decide this when implementing `handleVoted`.

---

## 7. Files to touch (checklist)

- `src/abis/SignalNavigator.json` *(new)* — extract `jq '.abi'` from the compiled artifact.
- `src/handlers/signal.ts` *(new)* — `handlePollCreated`, `handleVoted`, `handlePollCancelled`,
  `signalNavigatorIface`. Reuse `getDaoFromNavigator` from `navigators.ts`.
- `src/handlers/daoship.ts` — `handleNavigatorDeployed`: type-routed self-promotion for
  permissionless types (§2).
- `src/index.ts` — import + register the three handlers **unfiltered**; export from
  `handlers/index.ts` barrel.
- `src/services/database.ts` — add `ds_signal_polls`, `ds_signal_votes` to `VALID_TABLES`.
- `src/types/index.ts` — `SignalPollRow`, `SignalVoteRow`.
- `supabase/migrations/schema.sql` — two tables; indexes (by dao, by navigator+poll, by voter,
  by block for prune); RLS public-read; `REPLICA IDENTITY FULL`; realtime publication; reorg
  prune `DELETE`s in `ds_remove_events_after`; drop list; optional
  `ds_recompute_poll_tally` (design A).
- `test/unit/handlers/signal.test.ts` *(new)* — happy path tallies, double-vote dedupe,
  cancel terminal, per-navigator pollId isolation, unknown-DAO skip, derive-not-increment
  idempotency (dispatch a `Voted` twice → tally unchanged).
- `test/unit/handlers/daoship.test.ts` — read-only self-promotion: `NavigatorDeployed` for a
  `SignalNavigator` against a known DAO yields `dao_id` set + `is_active=true` + `permission=0`,
  with **no** `NavigatorSet`; and orphan retained when DAO unknown.
- Consider an e2e lifecycle assertion in `test/e2e/indexer-lifecycle.test.ts`.

---

## 8. Open decisions for review

1. **Tally: design A (derive) vs B (materialized-recompute).** Recommend A.
2. **`handleVoted` with missing parent poll** — stub poll vs warn-skip (§6).
3. **`question` CID resolution** — out of scope for the indexer (store raw), same as proposals?
   Confirm the frontend resolves, consistent with current Poster/proposal handling.
4. **`snapshot_timestamp` storage** — keep it (cheap, lets the frontend verify tallies via
   `getPriorVotes`), or drop as redundant with `voting_starts - 1`? Recommend keep.
