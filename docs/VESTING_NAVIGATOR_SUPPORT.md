# Indexing the VestingNavigator

> **STATUS: IMPLEMENTED (2026-06-08).** Handlers, schema, and registration are shipped. Contract
> reference: `daoships-contracts/contracts/navigators/VestingNavigator.sol`; spec
> `daoships-contracts/docs/INDEXER-GUIDE.md` (VestingNavigator section) and `NAVIGATORS.md`.

**What it is.** A **MANAGER (permission 2)** navigator that vests shares or loot on a cliff +
linear schedule, minting incrementally via `claim`. **Permissioned** — registered via
`setNavigators()`, so `NavigatorSet(address,2)` fires and `trust_status` is `sanctioned` (standard
path; no defer/backfill gate).

**TL;DR.** Three events on a per-navigator `scheduleId` (starts at 0). The one trap: **balances
come from the paired `Transfer`, never from `TokensClaimed`** (would double-count), and `claimed`
is **derive-from-truth** (incremental amounts summed at end-of-range).

---

## 1. Events & handler (`src/handlers/vesting.ts`)

Registered **unfiltered** in `index.ts`. DAO resolved via `getDaoFromNavigator`. Shared
`NavigatorDeployed`/`Paused`/`Unpaused` topic0s are handled elsewhere (not re-registered here).

| Event | Signature | Handler action |
|---|---|---|
| `ScheduleCreated` | `(uint256 scheduleId, address beneficiary, uint256 totalAmount, uint64 startTime, uint64 cliffEnd, uint64 vestingEnd, bool isLoot)` | Upsert a `ds_vesting_schedules` row (`id = {nav}-{scheduleId}`). `startTime`/`cliffEnd`/`vestingEnd` are absolute (the contract resolves `startTime==0` to the creation block before emitting). `claimed`/`revoked`/`revoked_at`/`vested_at_revoke` are **omitted** so a replay never clobbers a later revoke or the derived `claimed`. |
| `TokensClaimed` | `(uint256 scheduleId, address beneficiary, uint256 amount, bool isLoot)` | `amount` is the **incremental** amount minted in *this* claim (not cumulative). Append a `ds_vesting_claims` feed row (`id = {tx}-{logIndex}`), then add the schedule PK to `ctx.dirtyVestingScheduleIds`. |
| `ScheduleRevoked` | `(uint256 scheduleId, address caller, uint64 revokedAt, uint256 vestedAtRevoke)` | Targeted UPDATE → `revoked=true`, `revoked_at`, `vested_at_revoke`. Non-destructive: already-minted tokens stay; future vesting freezes at `revoked_at`. |

**`claimed` is derive-from-truth.** Never incremented inline (would double-count on replay). At
end-of-range the processor calls `ds_recompute_vesting_claimed(schedule_pk)`, which sets
`claimed = SUM(ds_vesting_claims.amount)`. Mirrors the Signal poll-tally pattern.

**Balances.** Claims mint through DAOShip, so a `MintShares`/`MintLoot` + token `Transfer` fire in
the same tx. Member balances come from `Transfer` **as usual** — `TokensClaimed` is purely the
vesting-activity feed. Do **not** apply it to `ds_members`.

**Status / claimable are time-derived in the app** (mirror the contract's `_vestedAmount`):
`pending` while `now < cliff_end`, `vesting` while `cliff_end <= now < vesting_end`, `fully_vested`
once `now >= vesting_end`; `revoked` overrides with the freeze at `revoked_at`.
`claimable = vested(effectiveEnd) - claimed`, `effectiveEnd = revoked_at if revoked else now`.

---

## 2. Schema (`supabase/migrations/schema.sql`)

- `ds_vesting_schedules` — one row per schedule; `UNIQUE(navigator_address, schedule_id)`;
  `claimed` derived; `block_number` = creation block.
- `ds_vesting_claims` — append-only claim feed; `schedule_pk` FK → schedules (children-first in
  reorg delete + drop); `block_number` = claim block.
- `ds_recompute_vesting_claimed(p_schedule_pk)` — derive-from-truth `claimed` recompute.
- Indexes, public-read RLS, realtime (schedules only; claims skipped like other append-only feeds),
  reorg-delete, and `drop_ds_schema` coverage.
