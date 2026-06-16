# Indexing the SubscriptionNavigator

> **STATUS: IMPLEMENTED (2026-06-12).** Handler `src/handlers/subscription.ts`
> (MemberEnrolled/FeePaid/FeeCollected), registered in `src/index.ts`; the three tables, indexes,
> `ds_recompute_subscription_paid`, and reorg-cleanup live in `supabase/migrations/schema.sql`;
> `dirtySubscriptionMemberIds` flushes the derived `total_paid` once per member at end-of-range
> (`src/services/processor.ts`). Tested in `test/unit/handlers/subscription.test.ts` and the
> e2e Phase 11k (register → enroll → payFee) in `test/e2e/indexer-lifecycle.test.ts`. Contract
> reference: `daoships-contracts/contracts/navigators/SubscriptionNavigator.sol`; canonical spec
> `daoships-contracts/docs/SUBSCRIPTION_NAVIGATOR.md`; event spec
> `daoships-contracts/docs/INDEXER-GUIDE.md` (SubscriptionNavigator section). ABI:
> `src/abis/SubscriptionNavigator.json`. App surface:
> `daoships-app/docs/SUBSCRIPTION_NAVIGATOR_SUPPORT.md`; query patterns in
> `docs/FRONTEND_INTEGRATION.md` (Subscription Queries). This is the **9th and final** navigator.

**What it is.** A **MANAGER (2)** navigator for recurring membership dues. Members **pull-pay**
periodic fees (in a governance-set menu of native QUAI / ERC-20 tokens) to the **vault**; the fee is
forwarded straight to the treasury. Once a member is past grace, **anyone** may `collectFee(member)` to
strip their shares — converted to loot (default) or burned — for a small loot keeper reward.

---

## 1. Discovery & trust — the STANDARD permissioned path (unlike Budget)

This is **not** a new trust case. Subscription is a normal MANAGER navigator:

- It is registered via `setNavigators([nav], [2])`, so a **`NavigatorSet(nav, 2)`** event fires →
  set `trust_status = 'sanctioned'`, `permission = 2`, `is_active = true`, `permission_ever_granted = true`.
- Discover metadata from `NavigatorDeployed` (carries the indexed `daoShip` binding), exactly as for
  Vesting/Timelock. The `handleNavigatorDeployed` **permissioned** branch already covers it — do NOT add
  a MODULE branch (that is Budget's special case) and do NOT treat it as read-only.
- A `NavigatorSet(nav, 0)` later revokes it (`is_active = false`); normal handling.

No vault-module watch, no Poster sanction path. If your discovery switch keys on `navigatorType`, add
`"SubscriptionNavigator"` to the permissioned set.

---

## 2. Events

```solidity
event MemberEnrolled(address indexed member, uint256 paidThrough);
event FeePaid(address indexed member, address indexed payer, address indexed token,
              uint256 amount, uint256 periods, uint256 paidThrough);  // token: 0x0 = native QUAI
event FeeCollected(address indexed member, address indexed collector,
                   uint256 sharesRemoved, uint256 reward, bool burned); // burned: true=burn, false=convert
event Paused(address indexed caller);
event Unpaused(address indexed caller);
```

**Topic0:**
- `keccak256("MemberEnrolled(address,uint256)")`
- `keccak256("FeePaid(address,address,address,uint256,uint256,uint256)")`
- `keccak256("FeeCollected(address,address,uint256,uint256,bool)")`

Membership is keyed by `(navigator_address, member)` — there is no per-member id. `paidThrough` is the
whole state (`0` ⇒ not enrolled, or collected/un-enrolled). Resolve the DAO from `NavigatorDeployed.daoShip`.

### ⚠️ Token-balance changes come from the CORE events — do not double-count

`payFee` moves the fee **into** the vault (ERC-20 `Transfer` to the vault, or a native transfer).
`collectFee` removes the member's shares through DAOShip, so the same tx carries either:
- **convert mode** (`burned=false`): a `ConvertSharesToLoot(member, amount)` (shares `Transfer`→0 +
  loot `Transfer`←0), or
- **burn mode** (`burned=true`): a `BurnShares([member],[amount])`,

plus a `MintLoot([collector],[reward])` for the keeper reward. Take **balances** from those
Transfer/mint/burn events as usual; treat `FeePaid` / `FeeCollected` as the subscription-activity feeds only.

---

## 3. Handlers

**`MemberEnrolled`** — upsert the member row, set `paid_through` to the event value. Fires on governance
`enroll`/`enrollBatch` and for `_initialMembers` at construction (the complimentary-period grant). A
member's **first `payFee` self-enrolls WITHOUT** a `MemberEnrolled` event, so also upsert-create the row
in the `FeePaid` handler.

**`FeePaid`** — set the member's `paid_through` to the event's `paidThrough` (it is the new **absolute**
value — assign it, do **not** add). Upsert-create the member row if absent (self-enroll). Append one
`ds_subscription_payments` feed row and flag the member dirty. `token == 0x0` is native QUAI.
**`amount` is per-payment — derive cumulative `total_paid` by SUM over the payments feed at end-of-range;
do NOT `+=` inline** (replay/reorg double-counts — same rule as Vesting `claimed` / Budget `total_spent`;
e.g. a `ds_recompute_subscription_paid` SUM flushed from `dirtySubscriptionMemberIds`).

**`FeeCollected`** — set the member's `paid_through = 0` (collection un-enrolls them) and
`last_collected_at`. Append one `ds_subscription_collections` feed row (`shares_removed`, `reward`,
`burned`). Any cumulative collected totals are likewise a SUM over the feed, never an inline `+=`.

**`Paused` / `Unpaused`** — shared handling (`ds_navigators.paused`). For this navigator pause freezes
payFee, enroll, **and** collectFee.

### Status is time-derived (mirror the contract)

Read `graceDuration` once (immutable). With `pt = paid_through`: `not_enrolled` if `pt == 0`; else
`current` while `now <= pt`, `grace` while `pt < now <= pt + grace`, `delinquent` once `now > pt + grace`
(collectible). The fee menu is immutable — read `getAcceptedTokens()` / `feePerPeriod(token)` once at
discovery; `quote(periods, token)` reconciles cost. **Trust is mandatory in the UI**: default views to
`trust_status = 'sanctioned'` only (dues/collection touch the cap table).

---

## 4. Schema

```sql
-- SubscriptionNavigator membership (one row per member per navigator)
CREATE TABLE ds_subscription_members (
    id VARCHAR(128) PRIMARY KEY,           -- {navigator_address}-{member}
    dao_id VARCHAR(42) REFERENCES ds_daos(id),
    navigator_address VARCHAR(42) NOT NULL,
    member VARCHAR(42) NOT NULL,
    paid_through BIGINT DEFAULT 0,         -- absolute ts paid through; 0 = not enrolled / collected
    total_paid NUMERIC(78,0) DEFAULT '0',  -- RECOMPUTE by SUM(ds_subscription_payments.amount); never += inline
    last_collected_at TIMESTAMPTZ,
    tx_hash VARCHAR(66),
    created_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(navigator_address, member)
);

-- payment feed (one row per FeePaid)
CREATE TABLE ds_subscription_payments (
    id VARCHAR(180) PRIMARY KEY,           -- {navigator_address}-{member}-{tx_hash}-{log_index}
    member_pk VARCHAR(128) REFERENCES ds_subscription_members(id),
    dao_id VARCHAR(42) REFERENCES ds_daos(id),
    navigator_address VARCHAR(42) NOT NULL,
    member VARCHAR(42) NOT NULL,
    payer VARCHAR(42) NOT NULL,            -- payFeeFor → differs from member
    token VARCHAR(42) NOT NULL,            -- 0x0000...0000 = native QUAI
    amount NUMERIC(78,0) NOT NULL,         -- per-payment; SUM for cumulative
    periods NUMERIC(78,0) NOT NULL,
    paid_through BIGINT NOT NULL,
    tx_hash VARCHAR(66),
    created_at TIMESTAMPTZ
);

-- collection feed (one row per FeeCollected)
CREATE TABLE ds_subscription_collections (
    id VARCHAR(180) PRIMARY KEY,           -- {navigator_address}-{member}-{tx_hash}-{log_index}
    member_pk VARCHAR(128) REFERENCES ds_subscription_members(id),
    dao_id VARCHAR(42) REFERENCES ds_daos(id),
    navigator_address VARCHAR(42) NOT NULL,
    member VARCHAR(42) NOT NULL,
    collector VARCHAR(42) NOT NULL,
    shares_removed NUMERIC(78,0) NOT NULL,
    reward NUMERIC(78,0) NOT NULL,         -- loot minted to collector
    burned BOOLEAN NOT NULL,               -- true = burnShares, false = convertSharesToLoot
    tx_hash VARCHAR(66),
    created_at TIMESTAMPTZ
);
```

Reorg/drop coverage: the member row's `paid_through`/`total_paid` are derive-from-truth (re-derivable
from the feeds), and `FeeCollected`'s `paid_through = 0` is idempotent. On reorg, recompute `total_paid`
by SUM over surviving payment rows; a rolled-back `FeeCollected` should restore `paid_through` from the
last surviving `FeePaid.paid_through` for that member (or 0 if none) — reconcile against the
`paidThrough(member)` view if in doubt.

---

## 5. Registration checklist

- [x] Permissioned discovery — no config change needed: `SubscriptionNavigator` is neither
      `READ_ONLY_NAVIGATOR_TYPES` nor `MODULE_NAVIGATOR_TYPES`, so it flows through the default
      permissioned `NavigatorSet` path (born `sanctioned` at grant); handlers resolve the DAO via
      `getDaoFromNavigator` with no defer/backfill gate.
- [x] Three event handlers wired by topic0 (§2) — `src/handlers/subscription.ts`, registered in `src/index.ts`
- [x] `dirtySubscriptionMemberIds` flush + `ds_recompute_subscription_paid` SUM at end-of-range
- [x] Migrations for the three tables (§4) + indexes + reorg-cleanup deletes
- [x] `paused` shared-handler coverage — navigator pause flows through the shared `handlePauseState`
      (`src/handlers/tokens.ts`) which updates `ds_navigators.paused`; the `Paused`/`Unpaused` topic0s
      are NOT re-registered (would collide)
- [x] Tests: handler unit tests (`test/unit/handlers/subscription.test.ts`) + e2e Phase 11k mirroring
      contracts Phase 2i (register → enroll → payFee; collect needs a past-grace member — ≥1h
      MIN_PERIOD — so it is covered by the contracts suite + unit tests, not e2e)
