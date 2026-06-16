# Indexing the NFTGatedNavigator

How to support DAO Ships' `NFTGatedNavigator` in this indexer. Contract reference:
`daoships-contracts/docs/NFT_GATE_NAVIGATOR.md`.

> **STATUS: IMPLEMENTED (2026-06-05).** Built per this guide using **Option B** (dedicated
> `ds_nft_claims` table). Two intentional deltas from the original draft below:
> - `NFTClaimed` is registered **unfiltered** (not scoped), matching how `Onboard` is registered in
>   this repo's current fetch strategy — both are navigator-only signatures and the unfiltered topic0
>   scan is a flat ~1 getLogs/range regardless of navigator count. See `registerAllHandlers` in
>   `src/index.ts`.
> - The handler lives in `src/handlers/navigators.ts` (alongside `handleOnboard`), not a separate
>   `navigators.ts`-new-file. The per-type config cache (§4) was **not** implemented — it is explicitly
>   optional and the app reads live config via `useNavigatorConfig`.
>
> Files touched: `src/abis/NFTGatedNavigator.json` (new), `src/handlers/navigators.ts`,
> `src/index.ts`, `src/services/database.ts` (VALID_TABLES), `src/types/index.ts` (`NftClaimRow`),
> `supabase/migrations/schema.sql` (table + indexes + RLS + realtime + reorg-prune + drop),
> `test/unit/handlers/navigators.test.ts`.

**TL;DR — most of it already works with zero changes.** The only net-new work is capturing the
`tokenId` of each claim via a new `NFTClaimed` handler. Everything else (metadata discovery,
DAO association, onboarding activity, pause/unpause) is already covered by existing handlers because
the navigator reuses shared event signatures.

---

## 1. What already works (no change)

`NFTGatedNavigator` deliberately reuses signatures that this indexer already handles:

| Event | Emitted by | Existing handler | Result |
|---|---|---|---|
| `NavigatorDeployed(address,address,string,string,string)` | navigator ctor | `handleNavigatorDeployed` (unfiltered topic0) | `ds_navigators` row gets `navigator_type='NFTGatedNavigator'`, `deployer`, `name`, `description`. **No change** — the signature is shared via `INavigator`. |
| `NavigatorSet(address,uint256)` | DAOShip | `handleNavigatorSet` | DAO association + permission bitmask (2 = MANAGER); registry updated. **No change.** |
| `Onboard(address,address,uint256,uint256,uint256)` | navigator | `handleOnboard` | A `ds_navigator_events` row with `event_type='onboard'`. NFT claims already land here (`amount`=0 in free-mint mode). **No change.** |
| `Paused` / `Unpaused` | navigator (BaseNavigator) | `handlePaused` / `handleUnpaused` | Navigator paused flag. **No change.** |

So NFT onboards are *already* indexed as generic onboard activity. `navigator_type` already
distinguishes them. The gap is only the **per-token claim dimension** (`tokenId`), which `Onboard`
does not carry.

> Optional hardening: add `'NFTGatedNavigator'` to any known-navigator-type allowlist/validation you
> keep, and to the navigator-config fetch in `handleNavigatorSet` if you cache per-type config (see §4).

---

## 2. New: index `NFTClaimed`

```solidity
event NFTClaimed(
    address indexed daoShipAddress,
    address indexed holder,
    uint256 indexed tokenId,
    uint256 shares,
    uint256 loot
);
```

Fires alongside `Onboard` on every successful claim. Use it to record **which `tokenId` was spent**
(a token can be claimed exactly once, ever — useful for "is #N still claimable?" and provenance).

### 2.1 Add the ABI

Drop `NFTGatedNavigator.json` (the `abi` array) into `src/abis/NFTGatedNavigator.json`
(from `daoships-contracts/artifacts/contracts/navigators/NFTGatedNavigator.sol/NFTGatedNavigator.json`).
It also contains `NavigatorDeployed`, `Onboard`, `Paused`, `Unpaused`, `navigatorType`, `daoShip` —
handy as a single interface for this navigator.

### 2.2 Add the handler (`src/handlers/navigators.ts`)

Mirror `handleOnboard`. Two storage options — pick one:

**Option A (minimal, no migration):** reuse `ds_navigator_events` with a distinct `event_type` and
put `tokenId` in the existing `metadata JSONB` column.

```ts
// NFTClaimed(address indexed daoShipAddress, address indexed holder, uint256 indexed tokenId, uint256 shares, uint256 loot)
export async function handleNFTClaimed(
  ctx: EventContext,
  args: Record<string, unknown>,
): Promise<void> {
  validateEventArgs(args, ['daoShipAddress', 'holder', 'tokenId', 'shares', 'loot'], 'NFTClaimed');
  const daoShipAddress = validateAndNormalizeAddress(args.daoShipAddress, 'daoShipAddress');
  const holder = validateAndNormalizeAddress(args.holder, 'holder');
  const tokenId = bigintToString(safeBigInt(args.tokenId));
  const sharesMinted = bigintToString(safeBigInt(args.shares));
  const lootMinted = bigintToString(safeBigInt(args.loot));

  const navigatorAddress = ctx.log.address.toLowerCase();
  const now = new Date(ctx.blockTimestamp * 1000).toISOString();

  await ctx.db.upsert('ds_navigator_events', {
    id: makeNavigatorEventId(ctx.log.transactionHash, ctx.log.index),
    dao_id: daoShipAddress,            // event carries the DAO directly (see handleOnboard)
    navigator_address: navigatorAddress,
    event_type: 'nft_claim',
    contributor: holder,
    shares_minted: sharesMinted,
    loot_minted: lootMinted,
    amount: '0',                       // tribute is on the paired Onboard row
    metadata: { token_id: tokenId },   // <-- the new dimension
    tx_hash: ctx.log.transactionHash,
    block_number: ctx.log.blockNumber,
    created_at: now,
  });

  logger.info({ daoId: daoShipAddress, navigatorAddress, holder, tokenId }, 'NFTClaimed indexed');
}
```

`makeNavigatorEventId` keys on `txHash-logIndex`, so the paired `Onboard` and `NFTClaimed` rows in the
same tx get distinct ids (different `log.index`) — no collision, reorg-safe via the existing
`block_number > p_block_number` prune path in `schema.sql`.

**Option B (richer queries):** add a dedicated table for O(1) "is this token claimed?" lookups and
uniqueness. Add to `supabase/migrations/schema.sql` (per-schema `EXECUTE format(...)` like the others):

```sql
CREATE TABLE IF NOT EXISTS %I.ds_nft_claims (
    id VARCHAR(128) PRIMARY KEY,          -- {navigator_address}-{token_id}
    dao_id VARCHAR(42) NOT NULL,
    navigator_address VARCHAR(42) NOT NULL,
    token_id NUMERIC(78,0) NOT NULL,
    holder VARCHAR(42) NOT NULL,          -- claimer at claim time (NFT may move later)
    shares NUMERIC(78,0) DEFAULT '0',
    loot NUMERIC(78,0) DEFAULT '0',
    block_number BIGINT,
    tx_hash VARCHAR(66),
    created_at TIMESTAMPTZ
);
-- index, RLS public-read, realtime publication, and a
-- `DELETE FROM %I.ds_nft_claims WHERE block_number > p_block_number` line in the reorg prune fn,
-- mirroring ds_navigator_events.
```

Use `id = {navigator}-{tokenId}` and `upsert` so a reorg/replay is idempotent. Recommended if the app
needs to paginate claimed tokens or check claim status without an on-chain call.

> Either way also write the generic `Onboard` row (existing handler) so the onboarding activity feed
> and member balances stay consistent — `NFTClaimed` is *additive*, not a replacement.

### 2.3 Register the handler (`src/index.ts`)

`NFTClaimed`'s topic0 is unique (it is not the shared `Onboard` topic), so registration never collides.
Register it **unfiltered** — matching how `Onboard` is registered in this repo's current fetch strategy.
Both are navigator-only signatures, and the unfiltered topic0 scan is a flat ~1 getLogs/range regardless
of navigator count (see the `registerAllHandlers` doc-comment in `src/index.ts`):

```ts
import { nftGatedNavigatorIface, handleNFTClaimed, /* ... */ } from './handlers/navigators.js';
// ...
// NFTGatedNavigator additionally emits NFTClaimed (unique topic0, carries the spent tokenId).
dispatcher.registerHandler(nftGatedNavigatorIface, 'NFTClaimed', handleNFTClaimed, true);
```

> **Historical note:** an earlier draft of this guide recommended *scoped* registration on the
> reasoning that `NFTClaimed` is only emitted by already-discovered navigators. That is true, but this
> repo deliberately flipped `Onboard` (and the other navigator-only signatures) to unfiltered for the
> flat-getLogs scalability win documented in `PERF_BATCH_DB_ROUNDTRIPS.md`; `NFTClaimed` follows suit
> for consistency. The dispatcher keys on `topic0` and throws on collisions, so registration is clean
> either way.

---

## 3. Reorg / idempotency

- Use `upsert` keyed by `txHash-logIndex` (Option A) or `{navigator}-{tokenId}` (Option B).
- Add the matching `DELETE ... WHERE block_number > p_block_number` line to the reorg-recovery
  function in `schema.sql` for any new table (Option B). `ds_navigator_events` is already covered.
- The navigator→DAO cache (`clearNavigatorDaoCache`) is unaffected — `NFTClaimed` carries
  `daoShipAddress` directly, like `Onboard`.

---

## 4. Optional: cache NFT-gate config

If `handleNavigatorSet` caches per-type config into `ds_navigators.config` (JSONB), add a branch for
`navigator_type === 'NFTGatedNavigator'` that reads the immutable views once via RPC and stores them:
`gateToken`, `sharesPerHolder`, `lootPerHolder`, `requireTribute`, `tributeAmount`, `expiry`,
`mintCap`, `perAddressCap`, `allowlistRoot`. All immutable → fetch once, cache forever. The app reads
live values via `useNavigatorConfig`, so this is purely a convenience cache.

---

## 5. Checklist

- [x] Copy `NFTGatedNavigator.json` ABI → `src/abis/`.
- [x] Add `handleNFTClaimed` to `src/handlers/navigators.ts` (**Option B** — dedicated table).
- [x] (Option B) Add `ds_nft_claims` to `schema.sql` incl. indexes, RLS, realtime, reorg-prune, drop.
- [x] Register `NFTClaimed` in `src/index.ts` (**unfiltered**, matching `Onboard` — see status note above).
- [ ] (Optional) Add `'NFTGatedNavigator'` config branch in `handleNavigatorSet`. — *skipped (optional)*
- [x] Add a unit test mirroring the `handleOnboard` test; asserts `ds_nft_claims` row.
- [x] Confirm `navigator_type='NFTGatedNavigator'` flows through `NavigatorDeployed` (already works).
