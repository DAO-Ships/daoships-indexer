# Navigator Trust & Lifecycle Architecture — Implementation Plan

Supersedes the narrower `SIGNAL_NAVIGATOR_SUPPORT.md`. Sources (contracts repo,
working tree): `docs/INDEXER-GUIDE.md` (§4 SignalNavigator, "Permissionless
(read-only) navigators", "Navigator lifecycle & pruning", "Protecting DAOs from spam
read-only navigators"), `docs/POSTER.md` (`daoships.dao.navigators`), `docs/NAVIGATORS.md`
(SignalNavigator + TimelockNavigator SHIPPED).

> **STATUS: IMPLEMENTED (2026-06-08).** All phases built; `tsc` clean, 367/367 unit tests pass.
> Schema recreated in place (drop + `create_ds_schema`), so a fresh `dev` schema is required.
> The app-facing data model (new `ds_navigators` columns, `ds_signal_polls`/`ds_signal_votes`,
> `trust_status`) is documented for the frontend in `docs/FRONTEND_INTEGRATION.md`. Deferred (not
> built): the archive-RPC weight-reconciliation job (the `trust_status='fabricated'` hook lives in
> `backfillNavigatorPolls`); updating the on-chain `test/e2e/indexer-lifecycle.test.ts` for the new
> navigator fields (needs a funded Cyprus1 testnet). TimelockNavigator is permissioned (GOVERNOR)
> and rides the existing `NavigatorSet` / `Paused` plumbing with no schema change — see §8.

---

## 0. Why this is bigger than "add the SignalNavigator"

The introduction of a **read-only navigator** (holds no permission, never fires `NavigatorSet`)
breaks three assumptions baked into the current code:

1. **"`dao_id` is set by `NavigatorSet`."** Today `handleNavigatorDeployed` writes an *orphan*
   (`dao_id = NULL`) and `handleNavigatorSet` promotes it. A read-only navigator never emits
   `NavigatorSet`, so its row would stay orphaned forever and then get reaped.
2. **"`permission = 0` ⇒ revoked ⇒ `is_active = false`."** For a read-only navigator
   `permission = 0` is its *permanent, healthy* state. `permission = 0` now overloads **three**
   lifecycle states (read-only, never-registered, revoked) that must be told apart.
3. **"DAO association is DAO-authorized."** `NavigatorDeployed` is *permissionless and
   self-asserted* — anyone can deploy a contract emitting `NavigatorDeployed(victimDAO, …)`,
   and our unfiltered topic0 scan ingests it. Binding `dao_id` from the event therefore lets
   anyone inject polls into any DAO's feed unless we add a **trust/curation layer**.

The contracts team's answer is a navigator **trust + lifecycle model**:
- Bind `dao_id` at `NavigatorDeployed` for every navigator (canonical association).
- Add `permission_ever_granted` (the discriminator that separates revoked from born-read-only).
- Add `trust_status` (`self_asserted | sanctioned | unsanctioned | fabricated`) driven by a new
  vault-authenticated Poster tag `daoships.dao.navigators` plus optional weight reconciliation.
- Redefine `is_active` to mean "functional now?" not "has permission."
- Rewrite navigator pruning to key off `permission_ever_granted` + DAO-resolution + event-existence
  + chain-head, **never** off `permission = 0` or `dao_id IS NULL`.

Everything below is sequenced so each phase is shippable and testable on its own.

---

## 1. Schema migration (`supabase/migrations/schema.sql`)

### 1a. `ds_navigators` — two new columns + redefined semantics

```sql
ALTER TABLE %I.ds_navigators
  ADD COLUMN IF NOT EXISTS permission_ever_granted BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS trust_status VARCHAR(16) NOT NULL DEFAULT 'self_asserted';
```

| Column | Meaning |
|---|---|
| `permission_ever_granted` | TRUE the first time a `NavigatorSet(addr, > 0)` from a **known** DAOShip is processed. Separates *revoked* (`permission=0 & ever_granted=true`, keep history) from *born read-only / never-registered* (`permission=0 & ever_granted=false`). Monotonic — never reset to false. |
| `trust_status` | Read-only DAO-binding trust: `self_asserted` (default), `sanctioned`, `unsanctioned`, `fabricated`. Permissioned navigators are implicitly `sanctioned` (vouched by `NavigatorSet`) — set it there. |
| `is_active` *(existing, redefined)* | "Functional right now?" Read-only stays **TRUE** at `permission=0`. Revoke → FALSE. Never-registered permissioned → FALSE (inert until granted). **No longer a proxy for "has permission".** |

Add `'fabricated'`/etc. as a `CHECK` or keep `VARCHAR(16)` free-form (recommend CHECK constraint
to catch typos).

**`dao_id` becomes a plain `VARCHAR(42)` — DROP the FK to `ds_daos(id)` (DECIDED).** The doc's
model binds `dao_id` from `NavigatorDeployed.daoShip` for *every* navigator (§2), including the
self-asserted value before/if the DAO is known — so `dao_id` must be able to hold an address with
no `ds_daos` row, which the FK forbids. The prune logic and handlers resolve "known DAO?" with an
explicit `EXISTS (SELECT 1 FROM ds_daos WHERE id = dao_id)` instead. Cost: lose `ON DELETE CASCADE`
DAO→navigators — non-load-bearing (the reorg-prune cleans navigators via `block_number`/`tx_hash`,
and DAO-launch reorgs are negligible under PoEM). `ds_signal_polls`/`ds_signal_votes` **keep** their
FK to `ds_daos` — the read-only resolution gate (§6.1) guarantees they only reference known DAOs.
Add a `deploy_block BIGINT` column to `ds_navigators` (the block of `NavigatorDeployed`) to bound
the sanction backfill range (§5d).

### 1b. New tables `ds_signal_polls` / `ds_signal_votes`

Per INDEXER-GUIDE's suggested DDL **plus `block_number BIGINT NOT NULL`** on both (the contract
doc omits it, but the reorg prune requires it). Model exactly on `ds_nft_claims`:

```sql
CREATE TABLE IF NOT EXISTS %I.ds_signal_polls (
    id TEXT PRIMARY KEY,                       -- {navigator_address}-{poll_id}
    dao_id VARCHAR(42) NOT NULL REFERENCES %I.ds_daos(id) ON DELETE CASCADE,
    navigator_address VARCHAR(42) NOT NULL,
    poll_id NUMERIC(78,0) NOT NULL,
    creator VARCHAR(42) NOT NULL,
    question TEXT,
    option_count SMALLINT NOT NULL,
    snapshot_timestamp BIGINT NOT NULL,
    voting_starts BIGINT NOT NULL,
    voting_ends BIGINT NOT NULL,
    cancelled BOOLEAN DEFAULT FALSE,
    tally NUMERIC(78,0)[] DEFAULT '{}',        -- derived-from-truth (§4), not incremented
    created_at TIMESTAMPTZ NOT NULL,
    tx_hash VARCHAR(66) NOT NULL,
    block_number BIGINT NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(navigator_address, poll_id)
);
CREATE TABLE IF NOT EXISTS %I.ds_signal_votes (
    id TEXT PRIMARY KEY,                        -- {navigator_address}-{poll_id}-{voter}
    poll_pk TEXT NOT NULL REFERENCES %I.ds_signal_polls(id) ON DELETE CASCADE,
    dao_id VARCHAR(42) NOT NULL REFERENCES %I.ds_daos(id) ON DELETE CASCADE,
    navigator_address VARCHAR(42) NOT NULL,
    poll_id NUMERIC(78,0) NOT NULL,
    voter VARCHAR(42) NOT NULL,
    option SMALLINT NOT NULL,
    weight NUMERIC(78,0) NOT NULL,             -- snapshot SHARE weight (loot excluded)
    created_at TIMESTAMPTZ NOT NULL,
    tx_hash VARCHAR(66) NOT NULL,
    block_number BIGINT NOT NULL,
    UNIQUE(navigator_address, poll_id, voter)
);
```

Wire into every place `ds_nft_claims` already appears in `schema.sql`: indexes (by `dao_id`, by
`(navigator_address, poll_id)`, by `voter`, by `block_number` for prune), RLS public-read,
`REPLICA IDENTITY FULL`, realtime publication, the `ds_remove_events_after` reorg-prune
`DELETE`s, the table drop list, and the `VALID_TABLES` check in `database.ts`.

### 1c. Sanction-intent hold table (for ordering, §5)

```sql
CREATE TABLE IF NOT EXISTS %I.ds_navigator_sanction_intents (
    dao_id VARCHAR(42) NOT NULL,               -- claimed daoAddress from the post
    navigator_address VARCHAR(42) NOT NULL,
    vault VARCHAR(42) NOT NULL,                -- msg.sender (verified == avatar)
    created_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (dao_id, navigator_address)
);
```

Holds "this DAO sanctioned address X" when X's `NavigatorDeployed` hasn't been seen yet. Mirrors
the existing orphan-record reparent pattern (`reparentOrphanedRecords`). Applied + cleared when
the navigator row appears (§2).

### 1d. Rewrite `ds_prune_orphaned_navigators` — see §7.

---

## 2. `handleNavigatorDeployed` rewrite (`src/handlers/daoship.ts`)

Today: writes `dao_id=NULL`, `is_active=false`, waits for promotion. New behavior:

```
navigatorType ∈ READ_ONLY_TYPES ?
  ├─ yes → RESOLUTION GATE: registry.getDaoByDaoShipAddress(daoShip) known?
  │         ├─ no  → IGNORE (no row). Permissionless self-assertion against a non-DAO is spam.
  │         └─ yes → upsert row: dao_id=daoShip, permission=0, permission_ever_granted=false,
  │                  is_active=TRUE, trust_status='self_asserted', + type/deployer/name/desc.
  │                  registry.registerNavigator(addr, daoShip)  // so getDaoFromNavigator resolves w/o RPC
  │                  Apply any held sanction intent for (daoShip, addr) → trust_status='sanctioned' (§5).
  │                  (Optional) identity probe: navigator.daoShip()/navigatorType() must agree (§6.2).
  └─ no  → permissioned navigator:
            registry.getDaoByDaoShipAddress(daoShip) known?
              ├─ yes → upsert row: dao_id=daoShip, permission=0, permission_ever_granted=false,
              │        is_active=FALSE ("deployed, unregistered"), trust_status='sanctioned'*,
              │        + metadata.  *permissioned trust comes from NavigatorSet; default benign.
              └─ no  → still bind dao_id = daoShip (self-asserted; FK is dropped per §1a),
                       is_active=FALSE, permission_ever_granted=false. NavigatorSet later promotes it
                       if the proposal lands; otherwise pruned at head (§7). Resolution uses
                       EXISTS-in-ds_daos, so this row reads as "DAO not (yet) known".
```

`READ_ONLY_TYPES = new Set(['SignalNavigator'])` — the single source of truth for "is this a
permissionless navigator," reused by the prune predicate and the sanction scoping guard. Future
read-only navigators (e.g. `DelegateRegistryNavigator`) join this set.

Keep the existing `allowlistRoot()` best-effort probe.

---

## 3. `handleNavigatorSet` update (`src/handlers/daoship.ts`)

Mostly intact; three changes:

1. On `permission > 0` from a known DAOShip, set `permission_ever_granted = TRUE` (monotonic) and
   `trust_status = 'sanctioned'` (permissioned navigators are vouched by this very event).
2. `is_active = (permission > 0)` is still correct under the new definition (revoke → FALSE;
   grant → TRUE). No change there, but it now coexists with `permission_ever_granted` which is what
   the prune logic reads.
3. The orphan-promotion block still works for permissioned navigators that deployed against a
   then-unknown DAO (dao_id=NULL). With dao_id now usually pre-bound in `handleNavigatorDeployed`,
   promotion becomes a no-op metadata refresh in the common case — verify the upsert is idempotent
   and doesn't clobber `trust_status`/`permission_ever_granted`.

---

## 4. SignalNavigator event handlers (`src/handlers/signal.ts`, new)

Three handlers, registered **unfiltered** in `registerAllHandlers` (matching `Onboard`/`NFTClaimed`).
DAO resolved from the **navigator address** via the existing `getDaoFromNavigator` helper
(`navigators.ts`); `pollId` is per-navigator → key `(navigator_address, poll_id)`.

**Materialization gate (DECIDED: defer + backfill).** All three handlers check the navigator's
`trust_status` first and **only write rows when it is `sanctioned`**. For any other status
(`self_asserted`/`unsanctioned`/`fabricated`) the handler **marks the log processed and returns
without writing** — the event is seen but not materialized, so a flood of unsanctioned navigators
cannot bloat the signal tables. Materialization happens later via the sanction backfill (§5d).
Helper: `isSanctioned(ctx, navigatorAddress)` reading `ds_navigators.trust_status` (cache it per
range like the navigator→DAO cache).

- **`handlePollCreated`** → (if sanctioned) upsert `ds_signal_polls` (id `{nav}-{pollId}`). Store
  timestamps; **no status column** (time-derived, §pollStatus).
- **`handleVoted`** → upsert `ds_signal_votes` (id `{nav}-{pollId}-{voter}`). Store `weight` straight
  from the event (share power, loot already excluded on-chain — never re-derive). Unique
  `(nav,poll,voter)` makes replay/reorg idempotent.
- **`handlePollCancelled`** → set `cancelled=true` (terminal).

**Tally = derive-from-truth, never `tally[option] += weight`.** Handlers default `idempotent: true`
(enables batched `markLogProcessed`); an incrementing delta double-counts on replay. Recommended:
a `dirtyPollIds` set flushed once per range to `ds_recompute_poll_tally(poll_pk)` —
`SUM(weight) GROUP BY option` from `ds_signal_votes` — exactly mirroring the existing
`dirtyDaoIds → ds_recompute_dao_totals` Option-B pattern. (Alt: read-time SQL view; alt: keep the
`tally` array but recompute, not increment.)

**Status (read side):** mirror `pollStatus()` — `Cancelled` (terminal) > `Pending` (`now <
voting_starts`) > `Active` (`[voting_starts, voting_ends)`) > `Ended` (`now >= voting_ends`). Do
not persist a status column.

**Missing parent poll on `Voted`** (poll created by a navigator we skipped/deferred): resolve DAO;
if the poll row is absent, warn+skip or upsert a stub — decide in §10.

---

## 5. Sanctioning — `daoships.dao.navigators` Poster handler (`src/handlers/poster.ts`)

This is the **authoritative "DAO authorized it" signal** and the most intricate new piece.

### 5a. Tag registration
Add to `TAG_DEFINITIONS`: `{ tag: 'daoships.dao.navigators', minTrust: 'VERIFIED', updatesDao: false }`
(`VERIFIED` == `msg.sender === dao.avatar`, the vault — exactly the trust the doc requires). Add a
`validateDaoNavigators` content validator (schemaVersion, daoAddress hex, `navigators[]` of
`{address, type?}`, ≤16 KB) to `TAG_VALIDATORS`, and a `case 'daoships.dao.navigators'` in the
`handleNewPost` switch.

### 5b. Full-set, last-write-wins reconciliation
The `navigators` array is the DAO's **complete** sanctioned set, not a delta. On a valid vault post:
1. Load the DAO's currently-`sanctioned` read-only navigators.
2. For each **listed** address that resolves to a read-only navigator bound to this DAO
   (`NavigatorDeployed.daoShip == daoAddress` AND `navigator_type ∈ READ_ONLY_TYPES`):
   set `trust_status = 'sanctioned'`. **Scoping guard:** silently ignore addresses pointing at a
   different DAO, permissioned types (already vouched), or unknown contracts.
3. For each **previously-sanctioned** address now **absent**: set `trust_status = 'unsanctioned'`.
4. Empty array → de-sanction all read-only navigators for the DAO.
Dedup key: vault + tag + `daoAddress`.

### 5c. Ordering hold
If a listed address has no `ds_navigators` row yet, write a `ds_navigator_sanction_intents` row
(§1c) and return. `handleNavigatorDeployed` (§2) applies and clears it when the navigator appears.

### 5d. Materialize-on-sanction backfill (DECIDED: defer + backfill — the step devs miss)
Because live signal handlers skip writes for non-`sanctioned` navigators (§4 gate), a freshly
`sanctioned` navigator's polls were *seen but not written*. On the `self_asserted|unsanctioned →
sanctioned` transition, **backfill** its full poll history. Mechanism (this is the main new infra):

1. **Re-fetch by address, not replay.** `ds_processed_logs` records only that a log was processed
   (id + block), not decoded args — so we cannot replay from it. Instead call
   `blockchain.getLogs([navigatorAddress], deploy_block … chainHead, [[PollCreated, Voted, PollCancelled]])`.
   `deploy_block` comes from the new `ds_navigators.deploy_block` column (§1a); the upper bound is
   current chain head (or last-indexed block) so backfill never races ahead of confirmed data.
2. **Dispatch through the normal handlers** with the gate now passing (status is `sanctioned`).
   Upserts are idempotent by key, so a poll/vote already written (e.g. created after the sanction
   landed) is a no-op — backfill and live path converge safely.
3. **Recompute tallies** for the affected polls (`dirtyPollIds` → `ds_recompute_poll_tally`, §4).
4. **Bound the work.** One `getLogs` per newly-sanctioned navigator over its own lifetime; chunk
   with the same bisect the processor already uses for oversized ranges. Sanctioning is a rare,
   governance-paced event, so this is not hot-path cost.

Implement as `backfillNavigatorPolls(ctx, navigatorAddress)` callable from the sanction handler
(§5b, on each `→ sanctioned` flip) and reusable by an admin/repair command.

> **Optional weight reconciliation at backfill (§6.4).** Because materialization now happens only at
> sanction, the natural place to sample-check `getPriorVotes` for fabricated weights is *inside*
> `backfillNavigatorPolls`, before/just-after writing. A mismatch sets `trust_status='fabricated'`
> and aborts the backfill. Still optional for v1 (a DAO must actively sanction a fabricating
> navigator for this to matter), but the hook lives here, not on the live path.

### 5e. De-sanction = hide, never delete
On `→ unsanctioned`, keep rows; exclude from default feeds by `trust_status`. Reversible.

---

## 6. Trust labelling layers (cheap → strong)

Record the verdict in `ds_navigators.trust_status`. Implement in this order; 1–3 are required for
a correct v1, 4 is optional/lazy:

1. **Resolution gate** — §2 (ignore read-only against unknown DAO).
2. **Identity probe** — one cached RPC pair (`daoShip()`, `navigatorType()`) must agree with the
   event; defeats lazy mimics. Reuse `blockchain.callContract` / the navigator→DAO cache.
3. **Sanctioning** — §5. `self_asserted` → `sanctioned`.
4. **Weight reconciliation** *(optional, lazy/sampled, archive-RPC-heavy)* — recompute
   `getPriorVotes(voter, snapshot_timestamp)` on the claimed DAO for a sample of a navigator's votes.
   All match → real (confidence up). Any mismatch → `trust_status = 'fabricated'` (terminal, suppress).
   The only check that unmasks fabricated weights. Run off the hot path (background job / on first
   sanction), never inline in the handler.

**Presentation policy** is the frontend's job: default feed shows `sanctioned`; `self_asserted`
behind a toggle/badge; `unsanctioned`/`fabricated` hidden. The indexer only labels.

---

## 7. Navigator pruning rewrite (`schema.sql` + `database.ts`)

The current `ds_prune_orphaned_navigators` deletes `dao_id IS NULL` rows past retention — wrong
under the new model. Replace with the predicate; **delete only rows that satisfy ALL**:

```
permission_ever_granted = false
  AND navigator_type NOT IN (<READ_ONLY_TYPES>)     -- never reap read-only
  AND no rows reference the address in ds_signal_*/ds_navigator_events/ds_nft_claims
  AND indexer is caught up to chain head            -- never prune mid-backfill
```

> **Policy update (2026-06-09): DAO-resolution is NOT a prune condition.** A navigator deployed
> against a real, launched DAO that never permissions it is reaped after `ORPHAN_RETENTION_DAYS`
> (default 90) just like one against a non-existent DAO — "deployed but never permissioned" is the
> sole signal. The earlier `NOT EXISTS ds_daos` clause (which kept known-DAO inert navigators
> forever) is removed. A navigator legitimately adopted at launch is permissioned in the same tx,
> far inside the window. Trade-off: if a DAO permissions a navigator *after* it has been pruned, the
> later `NavigatorSet` rebuilds the row without its `NavigatorDeployed` metadata (type/name/deploy_block).

Lifecycle matrix the predicate enforces:

| State | `ever_granted` | `is_active` | Prune? |
|---|---|---|---|
| Read-only (SignalNavigator) | false | true | **Never** |
| Deployed, never permissioned, known DAO | false | false | Yes — at chain head, after retention |
| Deployed, never permissioned, unknown DAO | false | false | Yes — at chain head, after retention |
| Active permissioned | true | true | Never |
| Revoked | true | false | **Never** (durable history) |

The chain-head guard needs the prune caller to pass "caught up" (compare indexer state head vs chain
head) — surface it as a parameter the scheduler already knows, or gate the call site. The "no events
ever indexed" check is a set of `NOT EXISTS` subqueries against the event tables.

---

## 8. TimelockNavigator + VestingNavigator — ✅ IMPLEMENTED (2026-06-08)

`TimelockNavigator` (GOVERNOR) and `VestingNavigator` (MANAGER) are both permissioned and ride the
existing `NavigatorSet` + `Paused`/`Unpaused` + `NavigatorDeployed` plumbing. Their navigator-specific
events are now fully indexed — see [`TIMELOCK_NAVIGATOR_SUPPORT.md`](TIMELOCK_NAVIGATOR_SUPPORT.md)
and [`VESTING_NAVIGATOR_SUPPORT.md`](VESTING_NAVIGATOR_SUPPORT.md):

- **Timelock:** `ds_timelock_changes` (queue/execute/cancel lifecycle, full `governanceConfig` bytes,
  time-derived status). **Bypass detection implemented:** `handleGovernanceConfigSet` writes
  `ds_governance_config_history` and queues an end-of-range `ds_resolve_timelock_bypass(dao, tx)` that
  flags any direct `setGovernanceConfig` on a timelock-enabled DAO without a same-tx `ChangeExecuted`.
- **Vesting:** `ds_vesting_schedules` + `ds_vesting_claims` (incremental claims, derive-from-truth
  `claimed`; balances still come from the paired `Transfer`, never `TokensClaimed`).

**`SubscriptionNavigator` (MANAGER) — ✅ IMPLEMENTED (2026-06-12)** rides this same permissioned path
(registered via `NavigatorSet(nav, 2)` → born `sanctioned`; no defer/backfill gate). Recurring dues:
`ds_subscription_members` (one row per member, `paid_through` = enrollment state) + `ds_subscription_payments`
/ `ds_subscription_collections` feeds, with derive-from-truth `total_paid` and time-derived status — see
[`SUBSCRIPTION_NAVIGATOR_SUPPORT.md`](SUBSCRIPTION_NAVIGATOR_SUPPORT.md). This is the **9th and final**
navigator. (For contrast, `BudgetNavigator` is the separate **module** trust class — authority is a vault
`EnabledModule`, not `NavigatorSet`; see [`BUDGET_NAVIGATOR_SUPPORT.md`](BUDGET_NAVIGATOR_SUPPORT.md).)

The original "optional / separate ticket" framing below is superseded — these were implemented in the
same pass once the app committed to forcing timelock routing and warning on bypasses.

---

## 9. Files to touch (checklist)

- `supabase/migrations/schema.sql` — `ds_navigators` +2 cols; `ds_signal_polls`/`ds_signal_votes`
  (+indexes/RLS/realtime/replica-identity/reorg-prune/drop); `ds_navigator_sanction_intents`;
  `ds_recompute_poll_tally`; rewrite `ds_prune_orphaned_navigators`.
- `src/config.ts` — `READ_ONLY_NAVIGATOR_TYPES` (or a constant in a shared module).
- `src/abis/SignalNavigator.json` *(new)* — `jq '.abi'` from artifact. (TimelockNavigator ABI only
  if §8 events are captured.)
- `src/handlers/signal.ts` *(new)* — 3 handlers + `signalNavigatorIface`.
- `src/handlers/daoship.ts` — rewrite `handleNavigatorDeployed` (§2); update `handleNavigatorSet` (§3).
- `src/handlers/poster.ts` — `daoships.dao.navigators` tag def + validator + switch case +
  sanction reconciliation (§5).
- `src/handlers/index.ts` / `src/index.ts` — export + register 3 signal handlers (unfiltered).
- `src/services/database.ts` — `VALID_TABLES`; sanction-intent read/write/clear; poll-tally recompute;
  rewritten prune call; (optional) re-fetch-by-address replay for §5d-B.
- `src/registry/contract-registry.ts` — register read-only navigators at deploy (already has
  `registerNavigator`); confirm no assumption that registered ⇒ permissioned.
- `src/types/index.ts` — `SignalPollRow`, `SignalVoteRow`, `NavigatorRow` (+`trust_status`,
  `permission_ever_granted`), sanction-intent row.
- `src/services/blockchain.ts` — (optional §6.2/§6.4) `getPriorVotes` / `navigatorType` probes.
- Tests — `test/unit/handlers/signal.test.ts` (new); extend
  `test/unit/handlers/daoship.test.ts` (read-only self-bind, permissioned inert, prune matrix),
  `test/unit/handlers/poster.test.ts` (sanction full-set/scoping/hold/transition), and
  `test/e2e/indexer-lifecycle.test.ts`.

---

## 10. Decisions (locked 2026-06-08)

1. **Materialization policy → DEFER + BACKFILL (§4 gate, §5d backfill).** Live handlers write only
   for `sanctioned` navigators; backfill on the `→ sanctioned` flip via `getLogs`-by-address. ✅
2. **`dao_id` → always bind from `NavigatorDeployed.daoShip`; DROP the FK (§1a, §2).** Plain
   `VARCHAR(42)`; "known DAO?" via `EXISTS`-in-`ds_daos`. No `claimed_dao_ship` column. `ds_signal_*`
   keep their FK. Add `ds_navigators.deploy_block`. ✅
3. **Weight reconciliation → deferred to a post-v1 hook inside `backfillNavigatorPolls` (§5d/§6.4).**
   Machinery (`trust_status='fabricated'`) lands now; the archive-RPC sampling job is optional and
   off the hot path. ✅
4. **`tally` → `dirtyPollIds` → `ds_recompute_poll_tally` RPC (§4)**, mirroring `dirtyDaoIds`. ✅
5. **`handleVoted` with missing parent poll → warn + skip.** Under defer+backfill, backfill replays
   in `(block, logIndex)` order so `PollCreated` always precedes `Voted`; a missing parent is a
   genuine anomaly, not normal flow. ✅
6. **TimelockNavigator change events + direct-`setGovernanceConfig` advisory (§8) → separate ticket.**
   Not in this build. ✅

### Suggested build order
1. Schema migration (§1) — `ds_navigators` cols + `deploy_block` + drop FK, signal tables,
   sanction-intent table, `ds_recompute_poll_tally`, prune rewrite. Recreate dev schema.
2. `handleNavigatorDeployed` / `handleNavigatorSet` rewrite (§2–§3) + registry tweak.
3. SignalNavigator ABI + `signal.ts` handlers with the sanction gate (§4), registered unfiltered.
4. `daoships.dao.navigators` Poster handler: tag/validator/trust gate + full-set reconciliation +
   ordering hold (§5a–§5c).
5. `backfillNavigatorPolls` + wire into the sanction flip (§5d).
6. Prune function call-site with chain-head guard (§7).
7. Tests across all of the above (§9).
