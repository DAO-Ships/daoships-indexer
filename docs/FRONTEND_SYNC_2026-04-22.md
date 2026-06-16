# Frontend Sync — 2026-04-22

Indexer changes on `main` (uncommitted + recent `hardening` commits) that the
`daoships-app` frontend needs to sync with. Every item below has been verified
against the current indexer source and the current `../daoships-app/src` tree
— items the app already handles correctly are called out as **no-op** so you
don't waste time looking.

Scope: changes since indexer commit `620cac4` (Navigator Allowlist indexing
change). Covers the 2026-04-16 audit remediation cycle and the Option A/B
performance work (batch DB round-trips, atomic transfer apply).

---

## TL;DR — what actually needs app work

1. **Health endpoint: new reindex fields + `recentRanges`** — extend
   `HealthStatus` type and add a "reindex required" warning banner.
2. **Health endpoint: 5-second server-side cache** — if the app polls more
   often than every 5s, you're getting cached data. Adjust polling.
3. **`ds_navigators.allowlist_root`** — new column, additive. App can
   optionally use it to skip an RPC; not required.
4. **`content` XSS reminder** — not a change, but re-flagging because the
   schema now carries an explicit comment: raw `ds_records.content` is
   UNTRUSTED. Make sure every render path escapes.

Everything else (trust levels, `profile_source`, `launcher_contract`,
`Navigator.config`) already matches between indexer and app. No refactor
needed.

---

## 1. Schema changes

### `ds_navigators` — additive

| Column | Type | Status | Notes |
|---|---|---|---|
| `allowlist_root` | `VARCHAR(66)` | **NEW** | Merkle root cached at `NavigatorDeployed` time. `NULL` when navigator has no allowlist or `allowlistRoot()` reverted. |

Backfilled automatically via `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, so
existing schemas pick it up on the next indexer startup. Historical rows keep
`NULL` until a reindex re-runs `handleNavigatorDeployed`.

**App impact:** none required. The indexer now verifies NewPost allowlist
records against this cached root instead of making three RPCs per post. If
the app wants to pre-verify a record before showing it, it can read
`allowlist_root` to compare against the claimed root — but this is purely
optional; the indexer will already have set `trust_level` correctly.

**Type update (optional):** `Navigator` in `src/types/navigator.ts` can
grow `allowlist_root: string | null`.

### `ds_indexer_state` — additive (operational)

| Column | Type | Status | Notes |
|---|---|---|---|
| `requires_full_reindex` | `BOOLEAN NOT NULL DEFAULT false` | **NEW** | Set when a reorg deeper than `CONFIRMATION_BLOCKS` is detected. Member balance totals may have drifted. |
| `reindex_reason` | `TEXT` | **NEW** | Human-readable cause (e.g. `"Reorg detected: forkpoint=12345"`). |
| `reindex_flagged_at` | `TIMESTAMPTZ` | **NEW** | When the flag was set. Useful to judge staleness. |

Also additive via `ALTER TABLE ... IF NOT EXISTS`.

**App impact:** the app doesn't read `ds_indexer_state` directly today
(no matches in `../daoships-app/src`). These are surfaced via `/health`
— see §3.

### `ds_members` / `ds_daos` — no schema changes, semantic change

Member balance writes now go through a new atomic SQL function
(`ds_apply_transfer`) instead of client-side read-compute-write. Observable
difference for the app: **fewer transient zero-balance windows**. During
batch replay the handler no longer briefly shows a member at `0` before
writing the new value. If the app has any UI logic that reacts to a
member's balance dropping to zero, it is now strictly correct rather than
occasionally flickering.

`ds_daos.total_shares` / `total_loot` / `active_member_count` are now
recomputed end-of-range via `ds_recompute_dao_totals` (derive-from-truth
sum over `ds_members`). Numerically identical; just more resilient.

### `ds_delegations` — additive index

New `UNIQUE INDEX ux_ds_delegations_dedup (tx_hash, delegator)` enforces
idempotency on DelegateChanged replays. No app impact — the indexer handler
catches the resulting `23505` as idempotent success.

### Record content — policy reminder (unchanged behavior, new schema comment)

`ds_records.content TEXT NOT NULL` now carries the inline comment:

> `-- M6: Raw on-chain data. UNTRUSTED. Frontends MUST escape before rendering. Use content_json for sanitized data.`

This is documentation, not a behavior change. Confirm every app render path
for `record.content` HTML-escapes or renders as plain text (React's default
JSX interpolation is safe; `dangerouslySetInnerHTML` on this field is not).

---

## 2. Trust-level behavior — unchanged, clarified

The canonical enum remains:

```
VERIFIED | VERIFIED_INITIAL | SEMI_TRUSTED | ON_CHAIN_PROVISIONAL | MEMBER | UNTRUSTED
```

The app's `src/types/trust.ts` already mirrors this exactly — **no change
needed**.

What did change under the hood: `handleNewPost` no longer makes RPCs to
verify `navigator.allowlist` records. Verification is now a pure DB lookup
against the cached `ds_navigators.allowlist_root`. Result for the app is
**identical** trust-level writes to `ds_records.trust_level`, just
dramatically cheaper at ingest.

`ON_CHAIN_PROVISIONAL` is still the state for orphan records (posted before
the DAO is registered). They get reparented and promoted to `MEMBER` or
`SEMI_TRUSTED` when the DAO/navigator is later registered. This pre-dated
this PR; flagging because it's adjacent to the allowlist changes.

---

## 3. Health endpoint — real app work here

The app consumes `/health` via `HEALTH_URL` in `src/config/supabase.ts`.
This is where the concrete refactor lives.

### 3a. New fields in the response

Current `details` object gains four fields:

```ts
interface HealthStatus {
  status: 'healthy' | 'unhealthy';
  timestamp: string;
  checks: { quaiRpc: Check; supabase: Check; indexer: Check };
  details: {
    // existing
    blocksBehind: number;
    currentBlock: number;
    daoCount: number;

    // NEW
    requiresFullReindex: boolean;
    reindexReason: string | null;
    reindexFlaggedAt: string | null;  // ISO timestamp
    recentRanges: Array<{
      fromBlock: number;
      toBlock: number;
      logCount: number;
      wallMs: number;
      cache: RangeCacheSummary;       // see src/services/range-cache.ts
    }>;
  };
}
```

- `requiresFullReindex: true` forces `status` to `unhealthy` even if every
  individual check passes.
- `recentRanges` is a ring buffer of the last N `processBlockRange`
  summaries — purely operational telemetry. Safe to ignore in the app, but
  handy if you want to surface indexing velocity / cache hit-rate.

### 3b. Response caching — 5 seconds

`/health` responses are cached server-side for 5000ms. Polling faster than
that returns the same object. If any app UI polls at 1s intervals, drop it
to 5–10s or you're doing pointless work.

### 3c. Suggested UI — reindex-required banner

When `requiresFullReindex === true`:

- Show a persistent warning banner: "Indexer flagged a full reindex —
  member balances may be stale."
- Optionally expose `reindexReason` and `reindexFlaggedAt` in a tooltip /
  details view.
- **Do not** treat this as "indexer is down". The indexer is still serving
  queries; it has flagged that historical totals need recomputing.
- Clearing the flag is an operator action on the backend (manual reset in
  `ds_indexer_state`). The app cannot clear it.

### 3d. Host binding (ops note, not code)

Indexer now binds to `HEALTH_CHECK_HOST` (default `0.0.0.0` for Docker,
overridable to `127.0.0.1` for bare-metal). Docker Compose exposes
`8080:8080`. No app code change — but if you run the app against a
local indexer, `http://localhost:8080/health` still works.

---

## 4. Things the research flagged as changes that AREN'T changes

Documenting these explicitly so you don't chase ghosts:

| Claim | Reality |
|---|---|
| "`launcher` → `launcher_contract` rename" | Already `launcher_contract` long before this PR. App already uses it (`src/types/dao.ts:25`). No change. |
| "`profile_source` narrowed to `'vault' \| 'launcher' \| null`" | Already that shape. App already uses it (`src/types/dao.ts:72`, `src/components/dao/DaoCard.tsx:23`). No change. |
| "`Navigator.config` is new" | `config JSONB` existed on `ds_navigators` before this PR. App type already has it. No change. |
| "`dao_id` is newly nullable on `ds_navigators`" | Was already nullable (orphan navigator / reparenting feature). App's Navigator type currently declares it `string` (non-null) — worth tightening to `string \| null` if you want correctness for orphan rows, but this is pre-existing, not new. |
| "New `ON_CHAIN_PROVISIONAL` / `SEMI_TRUSTED` trust levels" | Pre-existing. App enum already includes them. No change. |

---

## 5. Suggested app-side checklist

Minimal:

- [ ] Extend `HealthStatus.details` type with `requiresFullReindex`,
      `reindexReason`, `reindexFlaggedAt`, `recentRanges`.
- [ ] Add reindex-required warning banner (non-blocking, distinct from
      "indexer down").
- [ ] Audit `/health` polling cadence — drop to ≥5s.
- [ ] Spot-check every render path for `ds_records.content` HTML-escapes.

Optional / nice-to-have:

- [ ] Add `allowlist_root: string | null` to `Navigator` type.
- [ ] Tighten `Navigator.dao_id` to `string | null` to reflect orphan state.
- [ ] Surface `recentRanges` cache hit-rate in an ops-only view.

---

## 6. References

- `docs/AUDIT_VALIDATION_2026-04-16.md` — full audit cycle with H1 allowlist
  rewrite, M2 reindex flag, and schema rationale.
- `docs/PERF_BATCH_DB_ROUNDTRIPS.md` — Option A/B work (atomic
  `ds_apply_transfer`, `ds_recompute_dao_totals`, idempotency hardening).
- `docs/NAVIGATOR_ALLOWLIST_INDEXING.md` — background on the cached
  `allowlist_root` model.
- `docs/FRONTEND_INTEGRATION.md` / `docs/FRONTEND_SECURITY_GUIDE.md` —
  pre-existing frontend guidance, still current.

Questions → ping the indexer team.
