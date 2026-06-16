# Indexing the TimelockNavigator

> **STATUS: IMPLEMENTED (2026-06-08).** Handlers, schema, registration, and end-of-range bypass
> resolution are shipped. Contract reference:
> `daoships-contracts/contracts/navigators/TimelockNavigator.sol`; spec
> `daoships-contracts/docs/INDEXER-GUIDE.md` (TimelockNavigator section) and `NAVIGATORS.md`.

**What it is.** A **GOVERNOR (permission 4)** navigator that wraps `DAOShip.setGovernanceConfig`
behind a mandatory delay. Unlike `SignalNavigator` it is **permissioned**: it is registered via
`setNavigators()`, so a `NavigatorSet(address,4)` fires and its `trust_status` is `sanctioned`
through the standard permissioned path. There is **no** defer/backfill materialization gate.

**TL;DR.** Three lifecycle events on a per-navigator `changeId` (starts at 0), plus the
indexer's single most important responsibility for this navigator: **timelock bypass detection.**

---

## 1. Events & handler (`src/handlers/timelock.ts`)

All three are registered **unfiltered** (chain-wide topic0 scan) in `index.ts`, exactly like the
other navigator-specific signatures. The DAO is resolved from the navigator
(`getDaoFromNavigator`: registry → LRU cache → on-chain `daoShip()`); the events don't carry it.
`NavigatorDeployed` / `Paused` / `Unpaused` are shared topic0s already handled elsewhere — they
are **not** re-registered from the timelock interface (would be a topic0 collision).

| Event | Signature | Handler action |
|---|---|---|
| `ChangeQueued` | `(uint256 changeId, address queuedBy, bytes32 configHash, bytes governanceConfig, uint64 executableAfter, uint64 expiresAt)` | Upsert a `ds_timelock_changes` row (`id = {nav}-{changeId}`). **Stores the full `governanceConfig` 0x-hex bytes** — only the hash is on-chain, and `executeChange(changeId, governanceConfig)` needs the exact bytes. `status`/`executed_tx`/`cancelled_tx` are **omitted** from the upsert so a replay never clobbers a terminal state. |
| `ChangeExecuted` | `(uint256 changeId, address executor, bytes32 configHash)` | Targeted UPDATE → `status='executed'`, `executed_tx=<tx>`. Recording `executed_tx` is what powers bypass detection. |
| `ChangeCancelled` | `(uint256 changeId, address caller)` | Targeted UPDATE → `status='cancelled'`, `cancelled_tx=<tx>`. |

**Status is time-derived in the app** (like Signal polls): `queued` while `now < executable_after`,
`executable` while `executable_after <= now <= expires_at`, `expired` once past `expires_at` —
unless a terminal event (`executed`/`cancelled`) has landed. No cron; the columns carry the
timestamps. The delay window is a second ragequit window — surface a countdown to `executable_after`.

---

## 2. Timelock bypass detection (the key responsibility)

The timelock is **advisory, not enforced on-chain**: a proposal can still change governance config
directly via `executeAsGovernance → setGovernanceConfig`, skipping the timelock. The on-chain tell:
a **legitimate** timelocked change emits the timelock's `ChangeExecuted` in the **same transaction**
as DAOShip's `GovernanceConfigSet`.

Implementation:

1. `handleGovernanceConfigSet` (in `daoship.ts`) now writes a `ds_governance_config_history` row
   for **every** config change (keyed `{tx}-{logIndex}`), `bypassed_timelock` defaulting `false`,
   and adds `${daoId}|${txHash}` to `ctx.dirtyTimelockBypassChecks`.
2. At **end-of-range** (after all logs are persisted — a `ChangeExecuted` may sort *after* its
   paired `GovernanceConfigSet` within the range), the processor calls
   `ds_resolve_timelock_bypass(dao, tx)`. It sets `bypassed_timelock = TRUE` iff the DAO has an
   **active** (`permission > 0 AND is_active`) `navigator_type='TimelockNavigator'` **and** no
   `ds_timelock_changes` row was `executed_tx`-stamped for this DAO in that tx.

The resolver is idempotent (derives the flag from current truth), so replay/reorg re-runs converge.
DAOs with no active TimelockNavigator are always `false` (no expectation to route through one).

**App contract:** force timelock-enabled DAOs to route config changes through the timelock, and warn
on any proposal whose `GovernanceConfigSet` produced `ds_governance_config_history.bypassed_timelock = TRUE`.

---

## 3. Schema (`supabase/migrations/schema.sql`)

- `ds_timelock_changes` — one row per change; `UNIQUE(navigator_address, change_id)`; `block_number`
  is the queue block (reorg-cleanup bound).
- `ds_governance_config_history` — audit feed + `bypassed_timelock` flag.
- `ds_resolve_timelock_bypass(p_dao_id, p_tx_hash)` — derive-from-truth flag resolver.
- Both tables: indexes, public-read RLS, realtime, reorg-delete (`ds_delete_events_after_block`),
  and `drop_ds_schema` coverage.

**Reorg caveat:** a change queued before a fork but executed/cancelled after it keeps its (stale)
terminal status — its queue `block_number` is below the fork point so it survives the delete. Same
class as the documented member-balance caveat; a deep reorg crossing such a tx needs a full reindex.
