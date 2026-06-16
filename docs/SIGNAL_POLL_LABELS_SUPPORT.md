# Indexing Signal Poll Option Labels (`daoships.signal.poll`)

> **STATUS: IMPLEMENTED (2026-06-14).** Built per this plan; `tsc` clean, 431 unit tests pass
> (+15: 8 poster `signal.poll` cases, 7 DB-method cases), e2e Phase 6e written & parses (not run —
> needs funded Cyprus1 testnet). It extends the already-built SignalNavigator support
> ([`NAVIGATOR_TRUST_ARCHITECTURE_PLAN.md`](NAVIGATOR_TRUST_ARCHITECTURE_PLAN.md),
> `src/handlers/signal.ts`) — read that first. Files touched: `schema.sql` (5 cols on
> `ds_signal_polls` + additive ALTERs + reorg label-clear in `ds_delete_events_after_block`),
> `types/index.ts` (`SignalPollRow`), `database.ts` (`getSignalPoll`, `applyPollLabels`),
> `handlers/poster.ts` (tag def + `validateSignalPoll` + `applySignalPollLabels` branch),
> `handlers/signal.ts` (export `makePollPk`), `FRONTEND_INTEGRATION.md`.

## 1. The problem & the decision

`SignalNavigator.createPoll(question, optionCount, …)` stores **only `optionCount`** on-chain.
Options are bare indices `0..optionCount-1` — there is **no on-chain home for the human-readable
option labels** ("Teal" / "Magenta" / "Slate"). The `PollCreated.question` is the canonical
headline, but the per-option labels, an optional description, and a discussion link have nowhere
to live.

The contracts team's fix (no contract change) is a **new 8th Poster tag**: `daoships.signal.poll`.
The poll **creator** posts the index→label map directly, in a second tx after `createPoll` mines.
Authoritative spec:

- `daoships-contracts/docs/POSTER.md` → **"Signal Poll Options (`daoships.signal.poll`)"** + Pattern 5
- `daoships-contracts/docs/INDEXER-GUIDE.md` → `PollCreated` handler note + the `ds_signal_polls`
  DDL additions + the 8-tag routing table
- `daoships-contracts/docs/SIGNAL_NAVIGATOR.md` → §4.7 note (`question` stays canonical headline)

**Schema model (locked by the contract doc):** labels **decorate the existing `ds_signal_polls`
row** — they are NOT a new feed table. We add columns (`options`, `description`, `discussion_url`,
…). No new table.

## 2. Spec at a glance

`daoships.signal.poll` content schema:

```json
{
  "schemaVersion": "1.0",
  "daoAddress": "0x…",          // MUST equal navigator's NavigatorDeployed.daoShip
  "navigatorAddress": "0x…",    // the SignalNavigator contract
  "pollId": 0,                  // per-navigator id (NOT global)
  "options": ["Teal", "Magenta", "Slate"],   // options.length MUST == on-chain optionCount
  "description": "Pick the v2 brand color.", // optional, ≤1000 chars
  "discussionUrl": "https://forum…/789"      // optional, http/https/ipfs only
}
```

Hard rules from the spec:

1. **Trust gate is creator-identity, NOT DAO rank.** Index ONLY when
   `msg.sender == PollCreated.creator` for that `(navigatorAddress, pollId)`. This is the
   poll-creator analogue of `vote.reason`. A post from any other wallet is spam → discard.
   (Creator is read from the stored poll row's `creator`, never re-derived from a shares check.)
2. **`options.length == option_count`** (the on-chain count). Mismatch → discard, frontend
   renders numeric `Option 1..n`.
3. **Last-write-wins** per `(creator, navigatorAddress, pollId)` — the creator may repost to fix a
   label/description/link. Full history stays in `ds_records` / event logs.

## 3. Two project invariants that keep this simple (no hold table)

> Per product owner, 2026-06-13.

**(I1) Sanction-before-poll.** The app sanctions a SignalNavigator (vault
`daoships.dao.navigators` proposal) **before** any poll is created on it. Polls are therefore
only created on **already-sanctioned** navigators, so `PollCreated` is **not deferred** — it
materializes the `ds_signal_polls` row at the moment it is processed.

The poll creator then submits **two transactions: `createPoll` first, then the meta post** (the
meta needs the assigned `pollId`, so it can never precede the poll tx). The two may even land in
the **same block**, but never out of order. The processor sorts **all** fetched logs across every
contract by `(blockNumber, transactionIndex, …, logIndex)` before dispatch
(`src/services/processor.ts:345`), so:

- *Different blocks* → poll block < meta block → `PollCreated` dispatched first.
- *Same block* → the meta is a later transaction (higher `transactionIndex`) → `PollCreated` still
  dispatched first. (The launcher-first tiebreak at line 348 only applies *within a single
  transaction*; these are two distinct txs, already separated at line 347.)
- *Across a range boundary* → the poll's range is fully persisted before the meta's range starts.

Therefore **the poll row always exists by the time the labels post is processed** — different
block, same block, or split across ranges. No hold-until-discovered mechanism is needed.

**(I2) Ignore labels for expired/cancelled polls.** A labels post is only honored while the poll
is `Pending` or `Active`. If the poll is already `Ended` (`postBlockTs >= voting_ends`) or
`cancelled`, the post is discarded. Status is evaluated against the **post's block timestamp**
(`ctx.blockTimestamp`), never wall-clock `now`, so re-dispatch on reorg is deterministic.

Consequence accepted under I1: the indexer cannot *enforce* sanction-first on a permissionless
chain. If a poll is ever created on an **unsanctioned** navigator (irregular — the app won't do
this), its `PollCreated` is deferred and the labels post lands while the poll row is absent → the
labels post is **discarded** (we do not hold it). If such a navigator is later sanctioned,
`backfillNavigatorPolls` materializes the polls **without** labels; the creator must re-post labels
after sanction. This is acceptable because such polls are outside the supported app flow.

## 4. Schema changes (`supabase/migrations/schema.sql`)

### 4a. New columns on `ds_signal_polls` (per INDEXER-GUIDE DDL)

```sql
options          TEXT[],            -- index->label map; NULL until labels post seen (render Option 1..n)
description      TEXT,              -- optional poll context
discussion_url   TEXT,              -- optional forum/discussion link
labels_updated_at   TIMESTAMPTZ,    -- last-write-wins timestamp of the labels post
labels_block_number BIGINT          -- block of the labels post (for reorg-safe clearing) ← see 4b
```

Add to the `CREATE TABLE` body AND emit additive `ALTER TABLE … ADD COLUMN IF NOT EXISTS` lines
(mirror the existing M2 `ds_indexer_state` additive block) so deployed schemas migrate without a
full re-create. The columns ride the existing `ds_signal_polls` realtime publication automatically.

### 4b. Reorg safety — two distinct block numbers

`ds_remove_events_after(p_block_number)` deletes rows by `block_number`. The poll row's
`block_number` is from `PollCreated`; the **labels** arrive at a *different, later* block. If a
reorg rolls back only the labels post, deleting `ds_signal_polls WHERE block_number > X` would
**not** clear the now-orphaned labels. Fix: store `labels_block_number` (4a) and add to
`ds_remove_events_after`:

```sql
-- clear label columns whose labels post was rolled back (poll row itself survives)
UPDATE %I.ds_signal_polls
   SET options = NULL, description = NULL, discussion_url = NULL,
       labels_updated_at = NULL, labels_block_number = NULL
 WHERE labels_block_number > p_block_number;
```

No new table → no drop-list / RLS / prune changes.

## 5. Type changes (`src/types/index.ts`)

Extend `SignalPollRow` (all optional, NULL until labels seen):

```ts
options?: string[] | null;
description?: string | null;
discussion_url?: string | null;
labels_updated_at?: string | null;
labels_block_number?: number | null;
```

No new interface.

## 6. Database methods (`src/services/database.ts`)

- `getSignalPoll(pollPk)` → `{ creator, option_count, voting_ends, cancelled } | null` — the
  lightweight read backing the trust + expiry gate.
- `applyPollLabels(pollPk, { options, description, discussionUrl, labelsUpdatedAt, labelsBlockNumber })`
  → targeted `UPDATE ds_signal_polls` (never insert). Last-write-wins guard: only overwrite when
  `labels_block_number IS NULL OR labels_block_number <= :newBlock`, so a replayed older post can't
  clobber a newer edit.

No new table → no `VALID_TABLES` change, no intent methods.

## 7. Poster handler (`src/handlers/poster.ts`)

### 7a. Register the tag

- `TAG_DEFINITIONS`: `{ tag: 'daoships.signal.poll', minTrust: 'UNTRUSTED', updatesDao: false }`.
  `minTrust` is a placeholder — this tag is **fully special-cased** (like
  `daoships.navigator.allowlist`) and **bypasses** the generic `meetsMinTrust` DAO-rank gate,
  because creator-identity is not a DAO trust rank.
- `validateSignalPoll` in `TAG_VALIDATORS`.

### 7b. Validator `validateSignalPoll`

```
daoAddress       required, ETH_ADDRESS_RE, lowercased
navigatorAddress required, ETH_ADDRESS_RE, lowercased
pollId           required, integer >= 0  (store as string for NUMERIC(78,0))
options          required, array; each str(label, 200); length 2..10 after sanitize → else null
description      optional, str(_, 1000)
discussionUrl    optional, urlStr(_, 2048)   ← reuses existing http/https/ipfs allowlist
```

The validator can't enforce `options.length == option_count` (it doesn't know the on-chain count)
— that check happens at **apply time** against the poll row (§7c).

### 7c. Dedicated branch in `handleNewPost`

Parallel to the `isNavigatorAllowlist` special path. After parse + `validateSignalPoll`:

1. Resolve the claimed DAO (`fetchDao(daoAddress)`); if unknown → skip.
2. Insert the audit row into `ds_records` (raw `content` + validated json + `dao_id`,
   `trust_level = 'MEMBER'` — see §10.1; the real gate is the creator-match below, not this label).
3. `pollPk = makePollPk(navigatorAddress, pollId)` (import from `signal.ts`); `poll = getSignalPoll(pollPk)`.
   - **Poll absent** → discard (`debug` log). Under I1 this only happens for out-of-flow
     unsanctioned polls; we do not hold.
   - **`user !== poll.creator`** → `warn` + skip (spam — wrong wallet).
   - **`poll.cancelled` OR `ctx.blockTimestamp >= poll.voting_ends`** → discard (I2 — expired/cancelled).
   - **`options.length !== poll.option_count`** → `warn` + skip (render numeric).
   - Else → `applyPollLabels(pollPk, { …, labelsUpdatedAt: now, labelsBlockNumber: ctx.log.blockNumber })`.

## 8. Signal handler (`src/handlers/signal.ts`)

Only one tiny change: **export `makePollPk`** so `poster.ts` derives the poll key from a single
source. No changes to `handlePollCreated` / `handleVoted` / `backfillNavigatorPolls` — there is no
drain step (no hold table).

## 9. Files to touch (checklist)

- [ ] `supabase/migrations/schema.sql` — 5 cols on `ds_signal_polls` (+ additive ALTERs); reorg
      label-clear in `ds_remove_events_after`.
- [ ] `src/types/index.ts` — extend `SignalPollRow`.
- [ ] `src/services/database.ts` — `getSignalPoll`, `applyPollLabels`.
- [ ] `src/handlers/poster.ts` — tag def + `validateSignalPoll` + dedicated `signal.poll` branch.
- [ ] `src/handlers/signal.ts` — export `makePollPk`.
- [ ] `test/unit/handlers/poster.test.ts` — creator-match apply; creator-mismatch skip;
      length-mismatch skip; expired/cancelled skip; unknown-DAO skip; poll-absent discard;
      last-write-wins (older-block replay no-op).
- [ ] `test/unit/database-methods.test.ts` — `getSignalPoll`, `applyPollLabels` (incl. LWW guard).
- [ ] `test/e2e/indexer-lifecycle.test.ts` — Phase 6e: creator posts labels after a sanctioned,
      active poll → `options`/`description`/`discussion_url` populated; wrong-wallet post → ignored.
- [ ] `docs/FRONTEND_INTEGRATION.md` — `SignalPollRow` new fields; render rule
      (`options[i]` else `Option ${i+1}`); `daoships.signal.poll` post pattern.
- [ ] No new ABI (Poster event unchanged; `signalNavigatorIface` already has everything).

## 10. Resolved decisions

1. **`ds_records.trust_level` for `signal.poll` → reuse `'MEMBER'` (RESOLVED 2026-06-13).**
   No new enum value, no migration. Justified: `createPoll` gates on
   `getPriorVotes(creator, now-1) >= minSharesToCreatePoll` (`SignalNavigator.sol:213`), so the
   creator provably held shares at creation — `'MEMBER'` is accurate and is already the codebase
   baseline for wallet-attributed content (`vote.reason`, `member.profile`,
   `ds_reparent_orphaned_records` default). It is only an audit label; the access gate is the
   `msg.sender == poll.creator` match. (A creator who divests later still labels at `'MEMBER'` —
   reflecting creation-time membership, which is the on-chain truth.) `trust_level` is
   `VARCHAR(20)` with no CHECK constraint, confirming no schema change is needed either way.
2. **Poll rows persist; expired/cancelled labels ignored (RESOLVED 2026-06-13).** A labels post is
   honored only while the poll is `Pending`/`Active` (I2, §3): discard if `poll.cancelled` or
   `ctx.blockTimestamp >= poll.voting_ends`. De-sanction does not delete poll rows, so a labels
   post for an in-window poll on a since-de-sanctioned navigator still applies — harmless and
   consistent with current behavior; no extra sanction re-check.
3. **Question/CID resolution** unchanged — still off-chain/frontend (this feature doesn't touch
   `question`).
```
