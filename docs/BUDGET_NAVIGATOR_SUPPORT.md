# Indexing the BudgetNavigator

> **STATUS: IMPLEMENTED 2026-06-10.** Handlers, schema, vault-module trust watch, and
> registration are in the codebase. Contract reference:
> `daoships-contracts/contracts/navigators/BudgetNavigator.sol`; canonical spec
> `daoships-contracts/docs/BUDGET_NAVIGATOR.md`; event spec
> `daoships-contracts/docs/INDEXER-GUIDE.md` (BudgetNavigator section).
> Files: `src/handlers/budget.ts` (4 event handlers + `sanctionedDao` gate + `backfillNavigatorBudgets`),
> `src/handlers/vault-modules.ts` (EnabledModule/DisabledModule trust watch → feed + re-derive),
> `src/handlers/daoship.ts` (third MODULE branch in `handleNavigatorDeployed`),
> `src/registry/contract-registry.ts` (`getDaoByAvatarAddress`), `src/config.ts`
> (`MODULE_NAVIGATOR_TYPES`), `src/services/processor.ts` (`dirtyBudgetIds` flush),
> `src/services/database.ts` (`updateBudget` / `recomputeBudgetSpent` / `recomputeModuleTrust`),
> `supabase/migrations/schema.sql` (`ds_budgets` / `ds_budget_disbursements` / `ds_vault_module_events`
> + `ds_recompute_budget_spent` / `ds_recompute_module_trust` + reorg/drop/prune coverage). Tests:
> `test/unit/handlers/budget.test.ts`, `test/unit/handlers/vault-modules.test.ts`; e2e Phases 11g–11i
> in `test/e2e/indexer-lifecycle.test.ts`.

> ### Three corrections applied vs. the original draft of this spec
> 1. **BudgetNavigator is a THIRD trust class, not "permissioned".** `handleNavigatorDeployed`
>    used a binary read-only/permissioned split; a budget nav would have been born `sanctioned` and
>    surfaced budgets **before the vault ever enabled it**. Fixed: a `MODULE_NAVIGATOR_TYPES` branch
>    → born `self_asserted` + `is_active=false`, registered, and (unlike read-only) **not** dropped
>    on an unknown DAO (budget navs can be deployed against a *predicted* DAO address at launch).
> 2. **`total_spent` is derive-from-truth, not `+= amount`.** Inline accumulation double-counts on
>    replay/reorg. The `Disbursed` handler appends a row and flags the budget in `dirtyBudgetIds`;
>    the processor recomputes `total_spent = SUM(disbursements.amount)` once per touched budget at
>    end-of-range (`ds_recompute_budget_spent`), mirroring VestingNavigator `claimed`.
> 3. **Prune predicate fixed.** `ds_prune_orphaned_navigators` would have reaped a legitimately
>    deployed-but-not-yet-enabled budget nav (it never gets `permission_ever_granted=true`).
>    `'BudgetNavigator'` is excluded from the type list + a `NOT EXISTS ds_budgets` guard added.

**What it is.** A **treasury-disbursement** navigator: governance approves a recurring budget
(per-budget manager, per-period allowance, lifetime ceiling) and the manager disburses treasury
funds from the **vault** without a proposal per payment. It mints nothing.

---

## 1. ⚠️ Discovery & trust — a NEW case (read this first)

BudgetNavigator does not fit either existing discovery path:

| | Permissioned (Timelock/Vesting) | Read-only (Signal) | **Budget** |
|---|---|---|---|
| Holds DAOShip permission | yes (`NavigatorSet` fires) | no | **no** (`NavigatorSet` never fires) |
| Authority source | `NavigatorSet` permission bit | none (informational) | **vault module status** |
| Trust signal | `NavigatorSet` → `sanctioned` | Poster `daoships.dao.navigators` | **vault `EnabledModule` event** |

So **neither** `NavigatorSet` **nor** the read-only Poster sanctioning applies. Budget's authority is
being an **enabled Zodiac module on the DAO's vault**, and that grant is itself the authenticated
trust signal (the vault only enables a module via a governance proposal / owner action; `msg.sender
== vault`, unforgeable).

**Implementation:**
1. Discover the navigator from `NavigatorDeployed` (metadata + self-asserted `daoShip` binding), as
   for every navigator. Bind `ds_navigators.dao_id` here. Until enabled on the vault it is
   `self_asserted` — it cannot move funds.
2. **Watch every vault** for the Zodiac module events, registered **unfiltered** by topic0:
   - `EnabledModule(address indexed module)` — `keccak256("EnabledModule(address)")`
   - `DisabledModule(address indexed module)` — `keccak256("DisabledModule(address)")`
   These are emitted by every safe on chain, so the handler is an **authenticated filter**: the
   emitter (`ctx.log.address`) must resolve to a known DAO's avatar (`registry.getDaoByAvatarAddress`)
   **and** the `module` must resolve to a `BudgetNavigator` bound to that same DAO. The DAOShip is
   itself enabled as a module (`module == dao id`) — ignored explicitly.
3. **Record every authenticated module event in `ds_vault_module_events` (the feed)** and **derive**
   `trust_status`/`is_active` from the *latest surviving* feed row (`ds_recompute_module_trust`):
   enabled → `sanctioned`+active, disabled → `unsanctioned`+inactive, no rows → `self_asserted`+inactive.
   The columns are never set directly — so a **reorg that rolls back an enable/disable re-derives the
   correct state** (the reorg delete removes feed rows past the fork, then re-derives each affected
   nav). On the first enable, `backfillNavigatorBudgets` replays the deferred budget history.

A BudgetNavigator that has never been enabled on its claimed DAO's vault must **not** surface its
budgets/disbursements in default views — it is `self_asserted` and powerless until enabled. (You can
still confirm current state at any time via the `vault.isModuleEnabled(budgetNav)` view.)

---

## 2. Events & handler (`src/handlers/budget.ts`)

Register all four **unfiltered** (chain-wide topic0 scan) in `index.ts`. The DAO is resolved from the
navigator (`getDaoFromNavigator`: registry → LRU → on-chain `daoShip()`); the events don't carry it.
`NavigatorDeployed` / `Paused` / `Unpaused` are shared topic0s handled elsewhere — do **not**
re-register them from the budget interface (topic0 collision).

| Event | Signature | Handler action |
|---|---|---|
| `BudgetCreated` | `(uint256 budgetId, address manager, address token, uint256 allowancePerPeriod, uint256 totalCeiling, uint64 periodLength, uint64 startsAt, uint64 endsAt)` | Upsert a `ds_budgets` row (`id = {nav}-{budgetId}`). `token == 0x0` = native QUAI; `endsAt == 0` = perpetual. `startsAt` is absolute (contract resolves `0 → now`). Omit `cancelled`/`manager`-overwrite semantics that a replay could clobber. |
| `Disbursed` | `(uint256 budgetId, address to, address token, uint256 amount)` | Append a `ds_budget_disbursements` row (one per recipient — `disburse` emits one, `disburseBatch` emits N; key on `{nav}-{budgetId}-{tx}-{logIndex}`). **Do NOT `+= amount` inline** (double-counts on replay). Flag `dirtyBudgetIds`; the processor recomputes `total_spent = SUM(disbursements)` once per budget at end-of-range (`ds_recompute_budget_spent`). |
| `ManagerUpdated` | `(uint256 budgetId, address oldManager, address newManager)` | Targeted UPDATE → `manager = newManager`. |
| `BudgetCancelled` | `(uint256 budgetId, address caller)` | Targeted UPDATE → `cancelled = true`. Irreversible. |

Also `Paused(address)` / `Unpaused(address)` → update `ds_navigators.paused` (shared handler). **Note
for this navigator pause freezes ALL disbursement, not just creation** — surface it as a treasury freeze.

**`budgetId` is per-navigator, not global** (`budgetCount`, starts at 0). Key by
`(navigator_address, budget_id)`; resolve the DAO from `NavigatorDeployed.daoShip`.

**Don't double-count balances.** Each `Disbursed` is paired in the same tx with value leaving the
vault (a native transfer or an ERC20 `Transfer` **from the vault**). Take balances from the token
`Transfer`; treat `Disbursed` as the budget-activity feed.

**Period / remaining are time-derived** (mirror the contract): a budget is `active` while
`now >= starts_at && (ends_at == 0 || now < ends_at) && !cancelled`; the per-period allowance resets
every `period_length` (lazily on-chain). For exact figures reconcile via the views
`remainingThisPeriod(id)` / `remainingTotal(id)` rather than trusting a possibly-stale stored
`spent_this_period`.

---

## 3. Schema (`supabase/migrations/schema.sql`)

```sql
CREATE TABLE ds_budgets (
    id VARCHAR(128) PRIMARY KEY,           -- {navigator_address}-{budget_id}
    dao_id VARCHAR(42) REFERENCES ds_daos(id),
    navigator_address VARCHAR(42) NOT NULL,
    budget_id NUMERIC(78,0) NOT NULL,
    manager VARCHAR(42) NOT NULL,
    token VARCHAR(42) NOT NULL,            -- 0x0 = native QUAI
    allowance_per_period NUMERIC(78,0) NOT NULL,
    total_ceiling NUMERIC(78,0) NOT NULL,
    total_spent NUMERIC(78,0) DEFAULT '0',
    period_length BIGINT NOT NULL,
    starts_at BIGINT NOT NULL,
    ends_at BIGINT NOT NULL,               -- 0 = perpetual
    cancelled BOOLEAN DEFAULT FALSE,
    block_number BIGINT,                   -- creation block (reorg-cleanup bound)
    tx_hash VARCHAR(66),
    created_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(navigator_address, budget_id)
);

CREATE TABLE ds_budget_disbursements (
    id VARCHAR(180) PRIMARY KEY,           -- {navigator_address}-{budget_id}-{tx_hash}-{log_index}
    budget_pk VARCHAR(128) REFERENCES ds_budgets(id),
    dao_id VARCHAR(42) REFERENCES ds_daos(id),
    navigator_address VARCHAR(42) NOT NULL,
    budget_id NUMERIC(78,0) NOT NULL,
    recipient VARCHAR(42) NOT NULL,
    token VARCHAR(42) NOT NULL,
    amount NUMERIC(78,0) NOT NULL,
    block_number BIGINT,
    tx_hash VARCHAR(66),
    created_at TIMESTAMPTZ
);
```

Both tables: indexes (`dao_id`, `navigator_address`, `manager`/`recipient`), public-read RLS,
realtime, reorg-delete coverage (`ds_delete_events_after_block` on `block_number`), and
`drop_ds_schema` coverage.

A third table, **`ds_vault_module_events`**, is the trust feed (`{tx}-{logIndex}` PK, `enabled`
bool, `block_number`, `log_index`). The handler appends one authenticated row per
`EnabledModule`/`DisabledModule`; `ds_recompute_module_trust(nav)` derives the navigator's
`trust_status`/`is_active` from the **latest surviving** row. The reorg delete removes feed rows past
the fork and re-derives each affected nav (collected into `affected_modules`), so a rolled-back
enable reverts the nav to `self_asserted` and a rolled-back disable restores it to `sanctioned` —
the trust columns are a pure function of the feed, never a stale directly-set value.

---

## 4. App contract

The app reads `trust_status`/`is_active` (driven by the vault `EnabledModule` event, **not**
`NavigatorSet`) to decide whether to surface a budget navigator at all, then lists budgets with their
live `remainingThisPeriod` / `remainingTotal`, manager, token, and disbursement feed. See
`daoships-app/docs/BUDGET_NAVIGATOR_SUPPORT.md`.
