# On-Chain E2E Timing Notes (Quai / Orchard)

Hard-won institutional knowledge for `test/e2e/indexer-lifecycle.test.ts` (and the parallel
`daoships-contracts/test/e2e/onchain/OnChainDAOLifecycle.test.ts`). These tests drive a real DAO
lifecycle on **Quai Orchard testnet** and then assert the indexer reflected it. Almost every flaky
failure we've hit was an **on-chain timing race**, not an indexer bug — but they masquerade as
indexer failures because a phase dies before it ever reaches its `expect(ds_*)` assertion.

> **Rule of thumb:** if a phase fails *before* `waitForIndexer`/`waitForRow`, it's a chain/harness
> timing issue. If it fails *on* an `expect(ds_*)` after those, it's a candidate indexer bug. Across
> all runs to date, every phase has passed its indexer assertions in at least one run — the indexer
> logic is validated; the harness fights the testnet.

Orchard is **not** a dependable 5s-block chain. Block time ranges **5s to >15s**, with occasional
**multi-minute stalls** (no blocks produced at all). Every gotcha below stems from that.

---

## The five Quai gotchas

### 1. `getPriorVotes` requires `timepoint < block.timestamp` STRICTLY

`DAOShipVotes.sol:91` — `getPriorVotes(account, timepoint)` does `require(timepoint < block.timestamp,
"DAOShipVotes: not yet determined")`. The main vote path reads
`getPriorVotes(msg.sender, prop.votingStarts)` (`DAOShip.sol:1042`).

But `state()` returns `Voting` as soon as `block.timestamp >= votingStarts`. So at the exact boundary
`votingStarts == block.timestamp` the proposal is "Voting" yet the vote **reverts "not yet
determined"**. Waiting only for `state()==Voting` and voting immediately races straight into it.

- **Fix:** `waitPastVotingStarts()` waits for `state()==Voting` **AND one further mined block**, so the
  vote executes strictly after `votingStarts`, then re-confirms the window is still open.
- **Note:** `SignalNavigator` sidesteps this by snapshotting at `votingStarts - 1` (so the snapshot is
  always strictly in the past) — the main DAOShip vote does **not**, which is why only DAOShip votes
  hit this.

### 2. Work-object header timestamp runs AHEAD of EVM `block.timestamp`

On Quai, `provider.getBlock(...).woHeader.timestamp` (and `getBlockNumber`) can be **ahead** of the
EVM `block.timestamp` that contract code actually reads. So gating a wait on the woHeader clock returns
*before* the EVM clock the state-changing call enforces has advanced. We saw this bite:

- a timelock `executeChange` still `ChangeNotReady` after a woHeader-based delay wait, and
- a vesting `claim` reverting `NothingToClaim` because the schedule hadn't vested in EVM time yet.

- **Fix:** gate on the **contract's own view** (`isExecutable(changeId)`, `vested()`/`claimable()`,
  `state()`), never on `woHeader.timestamp`. A view reads the same `block.timestamp` the state-changing
  call will. (Mirrors the contracts repo's `waitForContractClock(predicate)`.)

### 3. A stall FREEZES `state()` while wall-clock keeps running

During a stall the chain mines no blocks, so `block.timestamp` — and every `state()`/`isExecutable`/
`vested` view that reads it — **freezes**. Wall-clock keeps running. So the wall-clock time to watch
the contract clock cross a fixed span of EVM-time = (the span) + (total stall time during it). A budget
sized at "span + a few seconds" times out the moment blocks pause.

- **Fix:** every contract-clock-gated wait budgets **span + `CHAIN_STALL_SLACK_MS`** (see budget model
  below). This is the single most common cause of "ready PX: timed out".

### 4. `NUMERIC(78,0)` deserializes as a JS **number** for small values

PostgREST/supabase-js returns `NUMERIC(78,0)` as a JSON **string** for large values (precision) but as
a JSON **number** for small ones that fit a JS number. A `change_id`/`poll_id`/`schedule_id` of `0`
arrives as `0`, not `"0"`. A strict `row.change_id === '0'` then fails.

- **Fix (tests & frontend):** never strict-equality a `NUMERIC` id against a string literal. Coerce —
  `BigInt(row.change_id) === 0n` or `String(row.change_id)`. (Documented for the app in
  `docs/FRONTEND_INTEGRATION.md`.)

### 5. Confirmation lag at the chain tip

The indexer only indexes **confirmed** blocks (head − `CONFIRMATION_BLOCKS`). A tx landing in the
current head block isn't indexed until the chain produces the next block(s). On a stall, `waitForIndexer`
for that exact block times out even though the indexer is healthy (`blocksBehind=0`, `lastIndexed=head-1`).

- **Fix:** `INDEXER_POLL_TIMEOUT_MS` budgets minutes, not seconds, to ride out the stall until the head
  advances and the target block confirms.

---

## The budget model

One env knob drives everything: **`CHAIN_STALL_SLACK_MS`** (default `480000` = 8 min). It is the
wall-clock slack added on top of any EVM-time span to absorb block-time variance + short stalls.

```
readyWaitMs          = totalWaitSec*1000 + CHAIN_STALL_SLACK_MS      // proposal → Ready
waitPastVotingStarts = CHAIN_STALL_SLACK_MS + 120_000               // proposal → Voting (+1 block)
perProposalMs        = readyWaitMs + CHAIN_STALL_SLACK_MS           // per-proposal it() base
simplePhaseTimeout   = 2*CHAIN_STALL_SLACK_MS + 720_000             // non-proposal phases (2 tx + 2 indexer waits)
waitForReceipt       = 7 rounds × (45s race + 15s probe) ≈ 420s     // tx confirm (direct getReceipt probe each round)
INDEXER_POLL_TIMEOUT = 360_000 (env)                                // indexer catch-up incl. confirmation lag
```

With the production e2e config (`VOTING_PERIOD=360`, `GRACE_PERIOD=60`, slack 8 min):
ready-wait **15 min**, per-proposal `it()` **28 min** (56 min for double-proposal phases 11c/12),
simple phase **28 min**, `waitPastVotingStarts` **10 min**.

**These are ceilings, not durations.** Every wait is **state-gated** — it returns the instant its
condition is met, so a healthy chain pays nothing. Big budgets only delay how long a *genuine* hang
takes to surface. On an awful day, crank the knob without editing code:

```bash
CHAIN_STALL_SLACK_MS=900000 npm run test:e2e   # 15-min slack everywhere
```

`VOTING_PERIOD` must stay in sync with `daoships-contracts/.env.e2e` (currently **360**). 60s/180s
windows proved too tight: `waitPastVotingStarts` burns a block, and a stall closes the window before a
vote lands (`NotVoting()`). A wider window only makes the run slower, never less valid.

---

## Harness helpers and what each defends against

| Helper | Defends against |
|---|---|
| `waitPastVotingStarts` | Gotcha 1 (strict `getPriorVotes`) + 3 (stall) — Voting + 1 block, state-gated |
| `waitForProposalState([5], readyWaitMs)` | Gotcha 3 — uses the **correct** enum (Ready=**5**, Grace=**4**; see below) |
| `waitForReceipt` | Slow/stalled tx confirm — time-boxed `tx.wait()` + direct `getTransactionReceipt(hash)` probe that recovers a mined-but-stalled receipt; detects real status-0 reverts; declares "dropped" only after the full budget |
| `sendVote` | Vote races — retries `not yet determined` / `NotVoting` / opaque status-0 reverts; **checks `memberVoted(voter, id)` first** so a landed-but-reported-reverted vote (or `AlreadyVoted`) is treated as success |
| `castVotes` | Sequential-vote starvation — fires all votes **concurrently** (independent nonces) so the 2nd voter isn't starved of the window by the 1st's confirm time |
| `sendProcessProposal` | `NotReady` clock skew — retries after we've already waited for `Ready(5)` |
| `waitForContractClock`-style poll (`isExecutable`) | Gotcha 2 (woHeader skew) for timelock/vesting deadlines |
| `waitForIndexer` | Gotcha 5 (tip confirmation lag) — polls `/health` + `last_block_number` |

### The `ProposalState` enum — get it right

Authoritative: `DAOShip.sol:228` (comment: *"Ordering is significant — external consumers rely on these
integer values"*):

```
0 Unborn  1 Submitted  2 Voting  3 Cancelled  4 Grace  5 Ready  6 Processed  7 Defeated  8 Expired
```

An earlier harness copy was off by one from Cancelled onward (it had `3 Grace, 4 Ready, …`), so it waited
on **Grace** while calling it "Ready" and misclassified the real **Ready(5)** as terminal. Wait for
**`[5]`** to process; terminal set is **`{3,6,7,8}`**.

---

## Triage cheat-sheet

| Symptom | Cause | Lever |
|---|---|---|
| `"DAOShipVotes: not yet determined"` on submitVote | Gotcha 1 boundary | already retried in `sendVote`; if persistent, chain stalled past retries |
| `ready PX: timed out after Ns` | Gotcha 3 — stall during voting+grace | raise `CHAIN_STALL_SLACK_MS` |
| `submitVote … voting window CLOSED (state=Grace)` | window closed before vote mined (stall > window) | raise `VOTING_PERIOD` (sync with contracts) |
| `receipt never appeared … likely dropped` | tx confirm slower than budget (or truly dropped) | raise `CHAIN_STALL_SLACK_MS` / re-run |
| `executeChange` `ChangeNotReady` / `claim` `NothingToClaim` | Gotcha 2 — woHeader gate returned early | gate on the contract view, not woHeader |
| `expected +0 to be '0'` | Gotcha 4 — NUMERIC coercion | compare with `BigInt(...)` |
| `Indexer did not reach block N … (highest seen N-1)` | Gotcha 5 — tip confirmation lag | raise `INDEXER_POLL_TIMEOUT_MS` |
| Fails on an `expect(ds_*)` **after** `waitForIndexer` | **actual indexer bug** — investigate the handler | — |

---

## Why the contracts e2e and indexer e2e must stay in sync

Both drive the same on-chain lifecycle; they share these timing helpers and the `.env.e2e` governance
params. The indexer e2e drifted once (wrong enum, missing `waitPastVotingStarts`) and burned several
multi-hour runs rediscovering what the contracts e2e already knew. If you touch one, mirror the other —
or better, factor the shared timing helpers + enum into a common module so they can't diverge again.
