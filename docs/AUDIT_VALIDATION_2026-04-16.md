# DAO Ships Indexer — Audit Validation (2026-04-16)

Second-pass validation of the Backend Architect + Security Engineer audit run on
2026-04-16. Every finding was re-verified against the current code at HEAD. Each
finding gets a status:

- **VALID** — the finding is correct, the fix is worth doing.
- **VALID (low priority)** — correct but the real-world risk or reward is small.
- **PARTIAL** — the finding is partly right; the described fix needs adjustment.
- **FALSE POSITIVE** — the finding is wrong or already mitigated.
- **ACCEPTED** — the finding is correct but fixing it is worse than leaving it.
- **FIXED** — remediated in this cycle; see "Remediation" block.

`C1` (secrets on disk) is intentionally excluded — production secrets live in
Infisical; committed `.env` files are burner accounts only.

## Remediation cycle — 2026-04-16

**H1, M1, M2, M3, M4, M5, S2, SC7, E6, SU1, SU2, E1, and A4 were fixed**
in this cycle. See the updated status blocks below and the summary table
at the bottom.

Verification:
- `npm run typecheck` — clean.
- `npm run test:run` — 306 unit tests pass (added 74 net new across the
  cycle: schema whitelist, `requires_full_reindex` wiring,
  `BlockProcessor.clearCaches`, allowlist root caching at
  `NavigatorDeployed`, DB-indexed allowlist verification,
  discovery-pass overflow throw, `pruneProcessedLogs` guard,
  insert-if-absent stubs for vote/ragequit,
  `processor.test.ts` covering `BlockProcessor` end-to-end,
  `contract-registry.test.ts` covering the registry module, and
  `database-methods.test.ts` covering VALID_TABLES allowlist, H1
  `getNavigatorByAddress`, E1 insert-if-absent wiring, and address
  validation).
- E2E tests deliberately skipped per scope.

---

## Security findings

### H1 — DoS via `Poster.newPost(navigator.allowlist)` on-chain verification spam

**Status: FIXED (2026-04-16).**

Root-cause framing: every allowlist NewPost used to trigger `getCode` +
`daoShip()` + `allowlistRoot()` — three RPC calls per post — because the
verification was done on-chain at post time. An attacker could cheaply
emit many NewPost events with arbitrary navigator addresses and force the
indexer into unbounded RPC work + orphan `ds_records` writes.

Remediation — moved verification from *per-post RPC* to *per-deployment
RPC* by leveraging the fact that `NavigatorDeployed` is already indexed.

1. **Schema (`supabase/migrations/schema.sql`)**: added `allowlist_root
   VARCHAR(66)` column on `ds_navigators`, with an `ALTER TABLE … ADD
   COLUMN IF NOT EXISTS` migration line so existing schemas pick it up.
2. **Change 1 — `handleNavigatorDeployed` (`src/handlers/daoship.ts`)**:
   now calls `allowlistRoot()` **once at navigator deployment time** via
   `rawCall` (best-effort — catches revert for navigators that don't
   expose the function). Result is stored on the `ds_navigators` row
   next to the immutable `deployer` and the daoShip-encoded `id`. Zero
   root is normalized to `NULL` so "open allowlist" is a distinct state.
3. **Change 2 — `handleNewPost` (`src/handlers/poster.ts`)**: replaced
   `verifyAllowlistOnChain` with a pure DB lookup
   (`verifyAllowlistFromIndex` + new `DatabaseService.getNavigatorByAddress`
   using the existing `idx_ds_navigators_address` index). All four checks
   happen against cached data:
   - navigator row exists (miss → reject, no RPC fallback),
   - `user === nav.deployer` (rejects impostors),
   - `id === '${claimedDao}-${navigatorAddress}'` (rejects cross-DAO
     spoofing via the immutable daoShip encoded in the id),
   - `postedRoot === nav.allowlist_root` (rejects junk content).
   Trust level is derived from the row: `SEMI_TRUSTED` if `dao_id` is
   set, `ON_CHAIN_PROVISIONAL` if still orphan.
4. **Dead code removed**: `verifyAllowlistOnChain`,
   `DAOSHIP_SELECTOR`, and the `ALLOWLIST_ROOT_SELECTOR`/`keccak256`
   usage in `poster.ts` were deleted. The selector lives in
   `daoship.ts` where it's now used once per navigator deployment.

Residual attack cost: attacker who wants to store a row in `ds_records`
must deploy a real navigator contract (~200k gas) AND post from the
deployer wallet AND match the navigator's immutable allowlist root.
Gas-bounded and content-bounded. Orphan retention (90 days default)
caps sustained storage.

Tests:
- `test/unit/handlers/daoship.test.ts` — added 4 tests covering
  allowlist root caching (success, deterministic revert, zero-root
  normalization, unexpected return length).
- `test/unit/handlers/poster.test.ts` — replaced the six on-chain
  verification tests with seven new tests covering the DB-indexed
  path: orphan→`ON_CHAIN_PROVISIONAL` accept, registered→`SEMI_TRUSTED`
  accept, DB-miss reject, deployer-mismatch reject, daoShip-mismatch
  reject, root-mismatch reject, null-root reject, plus a sweeping
  "zero RPC on any failure mode" guard.

Original finding (for context):

Code: `src/handlers/poster.ts:182-238` (`verifyAllowlistOnChain`) and
`src/handlers/poster.ts:441-489` (caller).

What I confirmed:
- `Poster` is a permissionless contract. `handleNewPost` filters by the Poster
  contract address (via `config.contracts.poster` plumbed through
  `fetchAllLogs`), so any wallet can emit a `NewPost` event that this indexer
  will accept.
- For tag `daoships.navigator.allowlist` when the claimed DAO is not in the DB,
  three RPC calls fire per event: `getCode` (retried), `daoShip()` rawCall
  (no retry, 10 s timeout), `allowlistRoot()` rawCall (no retry, 10 s timeout).
- A malicious contract that implements `daoShip()` and `allowlistRoot()`
  correctly causes an orphan row in `ds_records` (`dao_id = NULL`,
  `trust_level = 'ON_CHAIN_PROVISIONAL'`).
- `ds_prune_orphaned_records` retention defaults to 90 days (config range
  7-365). During that window storage grows linearly with spam.

Real-world impact:
- **RPC budget exhaustion is the dominant risk**, not storage. Each spam log
  consumes ≤3 tracked RPC calls. At `RATE_LIMIT_REQUESTS=50/s`, an attacker
  who lands 50 spam `NewPost` logs in one block forces ≥150 RPC calls just to
  clear that block's logs, pushing real work behind.
- Storage DoS is real on small Supabase tiers but gated by the 16 KB
  per-content cap and 90-day retention.
- Schema validation (`validateNavigatorAllowlist`) fires *before* on-chain
  verification, so garbage JSON is rejected cheaply. The attack requires
  well-formed content + a deployed malicious contract — nontrivial but cheap
  on Quai testnet.

Fix safety:
- Negative-result memoization (cache "navigator X failed verification" for
  N minutes) is safe — the on-chain state that would change a negative to a
  positive (navigator deploys its contract, DAO gets created) is rare and can
  tolerate cache TTL.
- Per-user rate limit on orphan posts is safe as long as we count **only posts
  that actually hit the on-chain path**, not posts for existing DAOs.
- Dropping retention to 7-14 days is safe — frontends consume these records
  only as "pre-DAO allowlist hints" and reconcile against live events after
  the DAO launches.

Recommended remediation (in order):
1. Add an in-process LRU of `{ navigatorAddress -> lastFailedAt }` with
   ~15 min TTL. Skip verification for entries still in cache.
2. Add a per-user counter `postsPerUserPerRange`; once over threshold (e.g.,
   10), skip on-chain verification for that user in this block range.
3. Consider lowering `orphanRetentionDays` default from 90 to 30.

---

### H2 — Service-role key used for every DB operation (no least-privilege)

**Status: VALID (low priority).**

Code: `src/services/database.ts:30-43`.

What I confirmed:
- A single Supabase client is created with the service-role key.
- All nine `.rpc(...)` calls (database.ts:241-336) pass **string literal**
  function names. No caller-controlled data flows into the RPC name.
- The `VALID_TABLES` allowlist (database.ts:21-28) blocks the generic
  `upsert()` / `insert()` table-name injection path.

Real-world impact:
- **No current exploit path.** The finding is pure future-proofing.
- Adding a narrower `ds_indexer_writer` role in Supabase is non-trivial: it
  requires SQL-level role creation, a separate JWT minting step, and updates
  to every GRANT in `schema.sql:690-698`. It also introduces a second secret
  to rotate and manage.

Fix safety:
- Splitting the roles is safe in theory but real cost is operational. Given
  no current exploit path, this is a **long-horizon hardening** item, not an
  action-this-quarter item.

Recommended remediation: defer until there is a concrete trigger
(e.g., adding Postgres functions that take caller-derived names, or exposing
the service-role key to any non-indexer code path).

---

### M1 — `SUPABASE_SCHEMA` env var not validated against a whitelist

**Status: FIXED (2026-04-16).**

Remediation:
- Added `validateSupabaseSchema()` in `src/config.ts` with whitelist
  `{testnet, mainnet, dev, public}` — mirrors the SQL-side guard in
  `create_ds_schema`.
- `test/unit/config.test.ts` now covers: accepting each whitelisted value
  (`accepts all whitelisted SUPABASE_SCHEMA values`), rejecting system
  schemas (`rejects SUPABASE_SCHEMA not in whitelist`), and rejecting
  arbitrary non-whitelisted strings.
- No real use case breaks — all existing env files already use whitelisted
  names.

Original finding (for context):

Code: `src/config.ts:67`. `src/services/database.ts:40` consumes it.

What I confirmed:
- `config.supabaseSchema` accepts any string.
- The SQL-side `create_ds_schema` function whitelists to
  `{testnet, mainnet, dev, public}` (`schema.sql:70`) — that is the ONLY
  whitelist. The client-side has nothing.
- Tests at `test/unit/config.test.ts:133` set `SUPABASE_SCHEMA=testnet` and
  check it round-trips. They never test invalid values.
- Real-world misconfig: a dev-env deploy with `SUPABASE_SCHEMA=mainnet`
  would silently write dev-indexed blocks into the mainnet schema.

Fix safety:
- Adding a whitelist `{testnet, mainnet, dev, public}` is a one-line change
  in `config.ts` and does not break any real use case — all existing env
  files (`.env.example`, `.env.testnet.example`, `.env.mainnet.example`)
  already use one of the whitelisted names.
- Keep `public` in the whitelist for test fixtures and `NODE_ENV=test`
  runs that default to `public`.

Recommended remediation: accept this fix now. Lowest-effort, highest-safety
item in the whole audit.

---

### M2 — Reorg recovery permanently desyncs member balances

**Status: FIXED (2026-04-16).**

Remediation:
- Added `requires_full_reindex` (BOOLEAN), `reindex_reason` (TEXT), and
  `reindex_flagged_at` (TIMESTAMPTZ) columns to `ds_indexer_state` in
  `supabase/migrations/schema.sql`, along with `ALTER TABLE … ADD COLUMN
  IF NOT EXISTS` for pre-existing schemas.
- Added `DatabaseService.setRequiresFullReindex(reason)` and
  `clearRequiresFullReindex()` in `src/services/database.ts`. The flag is
  set by `detectAndRecoverReorg` in `src/index.ts` on any detected reorg
  (by construction, any reorg the indexer detects is already deeper than
  `confirmationBlocks` — member balance totals may have drifted).
- `HealthService.getHealthStatus` now reports `requiresFullReindex`,
  `reindexReason`, and `reindexFlaggedAt`, and marks the indexer check
  `fail` when the flag is set — surfacing it via `/health` for operators.
- `test/unit/database-reindex-flag.test.ts` covers: the getter returns
  the new fields; `setRequiresFullReindex` writes the expected row with
  reason+timestamp; `clearRequiresFullReindex` nulls the fields;
  error propagation works.

Original finding (for context):

Code: `supabase/migrations/schema.sql:552-571`
(`ds_delete_events_after_block`); `src/handlers/tokens.ts:70-114`
(accumulator).

What I confirmed:
- The SQL function itself documents that member balances cannot be rebuilt
  from the replay range alone and recomputes `total_shares` / `total_loot`
  from the (potentially stale) `ds_members` table.
- `.env.mainnet.example` sets `CONFIRMATION_BLOCKS=5`, `.env.example` sets
  `3`, `.env.testnet.example` sets `3`. The local burner `.env` has `1`,
  which is the developer-friendly "see events immediately" setting but not
  what prod uses.

Real-world impact:
- On mainnet deployments that use the example config, reorgs deeper than
  5 confirmations are the only trigger, which is extremely rare on Quai's
  finality model.
- On testnet or dev with low confirmation counts, shallow reorgs can leave
  stale balance deltas that no future event will correct.
- The `max_total_shares_and_loot_at_vote` stored per proposal is snapshotted
  at sponsor time and is NOT affected by post-hoc `total_shares` drift, so
  historical quorum calculations remain correct. The risk is limited to
  current-state displays.

Fix safety:
- Raising the mainnet default is safe and already done in the example.
- Surfacing a `requires_full_reindex` health signal on any reorg past
  confirmation window is a small change with no downside.
- A "rebuild member balances from on-chain `balanceOf` at forkPoint" pass
  is the complete fix but is an archive-node-only operation. Defer.

Recommended remediation:
1. Document minimum-safe `CONFIRMATION_BLOCKS` for mainnet (≥ 5).
2. Add a `reorg_exceeded_confirmation_window` flag on `ds_indexer_state` set
   by the reorg recovery path and surfaced through `/health`.

---

### M3 — Dev-dependency CVEs (esbuild/vite/vitest); `quais` alpha not pinned

**Status: PARTIAL → FIXED (2026-04-16) for the pin; dev-CVE portion remains
low-priority follow-up.**

Remediation:
- `package.json`: changed `"quais": "^1.0.0-alpha.53"` to
  `"quais": "1.0.0-alpha.53"` so fresh `npm ci` cannot silently bump to a
  newer alpha.
- Production audit (`npm audit --omit=dev`) remains clean (0 vulns).
- Vitest v4 migration still outstanding but does not ship to production.

Original finding (for context):

What I confirmed:
- `npm audit --omit=dev` reports **0 vulnerabilities** against production
  deps as of this audit.
- The 5 moderate CVEs the previous audit cited are all in `vitest` →
  `vite` → `esbuild`, which are devDependencies only.

Real-world impact:
- The esbuild dev-server CVE (GHSA-67mh-4wv8-2f99) requires a developer to
  be running `npm run dev` AND visit a malicious site in the same browser
  session AND have the malicious site target localhost:5173. This is a
  local-dev-machine risk only; it does not affect the shipped container.
- `quais@^1.0.0-alpha.53` pinning concern is valid. Caret on an alpha
  version is unusual — a breaking alpha bump via fresh `npm ci` on a clean
  cache is possible.

Fix safety:
- Pinning quais to an exact version is safe and recommended.
- Upgrading vitest to v4 is a dev-only change; worth scheduling but not
  urgent.

Recommended remediation:
1. Change `"quais": "^1.0.0-alpha.53"` to `"quais": "1.0.0-alpha.53"`.
2. Schedule vitest v4 migration; not urgent.
3. Add `npm audit --omit=dev --audit-level=high` as a CI gate.

---

### M4 — `blockCache` not cleared on reorg

**Status: FIXED (2026-04-16).**

Remediation:
- Added `BlockProcessor.clearCaches()` in `src/services/processor.ts`
  that clears the `{ timestamp, hash }` cache.
- Called from the shared `detectAndRecoverReorg` helper in
  `src/index.ts` alongside `clearNavigatorDaoCache()`. Both run on every
  reorg recovery (startup and in-loop).
- `test/unit/reorg-recovery.test.ts` verifies cache-hit → `clearCaches()`
  → cache-miss behaviour, so a follow-on processBlockRange after reorg
  cannot return a pre-reorg block hash from the cache.

Original finding (for context):

Code: `src/services/processor.ts:50, 110, 317-323`.

What I confirmed:
- `BlockProcessor.blockCache` is instance-scoped; each process has exactly
  one. It caches `{ timestamp, hash }` per block number.
- `processor.ts:110` reads the cached hash to return as `lastBlockHash`.
- The only reorg recovery path is the **startup** path
  (`src/index.ts:247-308`). `BlockProcessor` is constructed *before* that
  path runs and its cache is fresh-empty. So at startup the cache cannot
  contain stale entries.
- If in-loop reorg detection were added (see M5), the cache WOULD need
  clearing. Without M5, M4 is effectively dormant.

Real-world impact:
- **Not reachable on HEAD**. The finding is a correct observation about a
  code path that does not exist.
- If we fix M5, we MUST also clear `blockCache` at the same time.

Fix safety:
- Adding a `BlockProcessor.clearCaches()` method and calling it from the
  reorg recovery path is safe. Should be done as part of M5's fix.

Recommended remediation: bundle with M5. Not a standalone fix.

---

### M5 — No in-loop reorg detection

**Status: FIXED (2026-04-16).**

Remediation:
- Extracted the reorg detection + recovery flow into a shared helper
  `detectAndRecoverReorg(lastProcessed, lastHash, blockchain, db, registry,
  processor, origin)` in `src/index.ts`. Called from both:
  1. Startup (`origin: 'startup'`) — replaces the previously inline logic.
  2. The main polling loop (`origin: 'poll-loop'`) — runs once per poll
     iteration before processing new blocks, using an in-memory
     `lastCommittedBlockHash` tracked across iterations.
- `lastCommittedBlockHash` is updated after every successful
  `updateLastProcessedBlock` in the polling loop and refreshed from the
  DB after any `doBackfill` (init and in-loop) to keep the baseline
  accurate.
- Recovery bundles: `deleteEventsAfterBlock(forkPoint)` +
  `setRequiresFullReindex` (M2) + `clearNavigatorDaoCache` +
  `processor.clearCaches()` (M4) + registry rebuild.
- Additional RPC cost: one `getBlock(lastProcessed)` per poll cycle —
  negligible at default 5s interval.

Original finding (for context):

Code: `src/index.ts:380-524` (polling loop has no hash comparison).

What I confirmed:
- Startup (`src/index.ts:247-308`) does hash comparison between
  `db.getLastProcessedBlock().blockHash` and
  `blockchain.getBlock(lastProcessed).hash`.
- The in-loop path at `index.ts:444-464` simply calls `processBlockRange`
  then `updateLastProcessedBlock`. There is no comparison of the
  previously-saved hash against the chain before advancing.
- A reorg that lands between two polls silently replaces the stored
  `last_block_hash` with the new-fork hash. All events from the old fork
  remain in the DB.

Real-world impact:
- High in any long-running deployment. Feeds M2.
- Mitigated — but not solved — by restart cadence; a process restart on the
  order of once per week catches reorgs via the startup check, but
  everything between restarts is vulnerable.

Fix safety:
- Before each `processBlockRange` call, fetch `getBlock(lastProcessedBlock)`
  and compare its hash to the DB-saved hash. On mismatch, trigger the same
  reorg recovery sequence used at startup (including `blockCache.clear()`
  from M4).
- Cost: 1 extra `getBlock` RPC call per poll cycle. Negligible.
- No real use case breaks.

Recommended remediation: add the check in the main loop and extract the
reorg recovery into a shared helper called from both startup and polling.

---

### L1 — `x-forwarded-for` takes only the leftmost IP

**Status: VALID (low priority).**

Code: `src/services/health.ts:83-91`. Trust-proxy mode splits on `,` and
takes index 0. Standard assumption for a single-proxy deployment; breaks
under multi-proxy. Defense-in-depth: add a `TRUSTED_PROXY_HOPS` count.

Real-world impact: only matters when trust-proxy is enabled (`.env.example`
has it default off). Low.

---

### L2 — `rawCall` uses `0x00...00` as `from`

**Status: ACCEPTED.**

Code: `src/services/blockchain.ts:188`. Fine today. Only matters if a
future navigator contract access-guards against `address(0)`. No change
needed now.

---

### L3 — `sanitizeJsonb` doesn't cap object-key count

**Status: VALID (low priority).**

Code: `src/handlers/poster.ts:124-138`. Depth cap (5) and array cap (1000)
are enforced; total key count isn't. The 16 KB `MAX_CONTENT_SIZE`
(`poster.ts:381`) bounds worst case at ~15k short keys — harmless. Low.

---

### L4 — `error.message` logged verbatim

**Status: VALID (informational).**

Code: 40+ locations in `database.ts`, `blockchain.ts`, `retry.ts`.
`logger.redact` paths don't match substrings inside `error.message`.
Supabase and quais errors I inspected do not typically embed URLs/tokens;
the risk is prospective. Add a custom serializer if/when an RPC with
key-in-URL is added (e.g., Alchemy-style). Not urgent.

---

### L5 — Health endpoint missing HSTS

**Status: VALID (informational).**

Code: `src/services/health.ts:127-141`. Only matters behind TLS; the
indexer is typically behind a reverse proxy (Cloudflare / nginx) that
should set HSTS anyway. Adding it at the app layer is cheap defense-in-
depth.

---

### L6 — Dockerfile not digest-pinned

**Status: ACCEPTED.**

Code: `Dockerfile:2,15`. `node:22-slim` is a trusted image. Digest pinning
adds maintenance overhead (manual bump on security updates). Not worth it
for this project's security posture.

---

### L7 — docker-compose exposes `:8080` on 0.0.0.0

**Status: VALID (low priority).**

Code: `docker-compose.yml:7-8`. Binding `"127.0.0.1:8080:8080"` is safer if
the indexer and its reverse proxy share a host. For cluster deployments
behind a load balancer, `0.0.0.0` binding is correct. Depends on deploy
topology.

---

## Architecture findings

### Top-5 #1 — Batch the per-log DB round-trips

**Status: VALID (high-impact).**

Code: `src/services/processor.ts:152-222`; every handler in
`src/handlers/*.ts`.

What I confirmed (re-counting hot-path RTTs):
- **SubmitVote**: `getProposal` (1) + optional `upsertProposal` (1) +
  `getMember` (1) + optional `upsertMember` (1) + `upsertVote` (1) +
  `incrementProposalVotes` (1) + `incrementMemberVotes` (1) +
  `markLogProcessed` (1) + `recordEventTransaction` once per tx (~0.3). So
  **6-8 round-trips per vote in the common path** (orphan-stub path adds
  the two "optional" writes).
- **Transfer**: parallelized `getMember` × 2 + serial `upsertMember` × 2 +
  optional `updateActiveMemberCount` + `markLogProcessed` +
  `recordEventTransaction` (amortized). **5-6 RTTs per transfer**.
- **NewPost**: `getDao` + optional `getMember` (MEMBER trust) +
  `upsert(ds_records)` + optional `updateDao` + `markLogProcessed`.
  **3-5 RTTs per post**. Plus 3 on-chain calls for unverified-allowlist.

Real-world impact:
- At current DAO count this is fine; Supabase latencies are typically
  30-80 ms, and event rates are low.
- As DAO count grows, this dominates total processing time — the "hard
  ceiling on throughput" claim is correct.

Fix safety:
- Batching `markLogProcessed` to end-of-range via a single `INSERT ... SELECT
  FROM (VALUES ...)` is safe because it is already idempotent (PK on
  `tx_hash, log_index`).
- Pre-fetching all referenced members per batch is safe but requires
  threading the fetched map through `EventContext` to handlers. Bigger
  change.
- Both are invisible to callers and do not break any user-facing behaviour.

Recommended remediation:
1. (Short-term) Defer `markLogProcessed` to an end-of-range batch insert.
2. (Medium-term) Pre-fetch members and proposals referenced in the batch.

---

### Top-5 #2 — `ds_increment_*` RPCs do O(N) subqueries per call

**Status: PARTIAL.** The performance claim is correct; the recommended fix
is wrong.

Code: `supabase/migrations/schema.sql:441-499`.

What I confirmed:
- `ds_increment_proposal_votes` runs 2× `COUNT(*)` + 2× `SUM(balance)`
  over `ds_votes WHERE proposal_id = p_id [AND approved = X]` per call.
  With the composite index `idx_ds_votes_proposal_approved` the scans are
  bounded to rows for that proposal. At 10k votes per proposal ×
  4 subqueries × every new vote = expensive.
- `ds_update_active_member_count` scans `ds_members` filtered on
  `(shares > 0 OR loot > 0)` — with the partial index `idx_ds_members_active`
  this is O(active members in DAO) per Transfer that crosses zero.

Why "flip back to delta" is wrong:
- The architect's suggestion assumes `ds_processed_logs` guarantees exactly
  once semantics. It does — for each `(tx_hash, log_index)` pair. But the
  delta model is vulnerable to **partial handler failure**: if
  `upsertVote` succeeds but `incrementProposalVotes` (delta) fails, the
  retry sees no dedup entry, runs `upsertVote` again (idempotent — same
  composite PK), and THEN runs `incrementProposalVotes` → double-count.
- That is exactly why the H2 rewrite derived-from-truth in the first place.

Correct fix:
- Detect "was this an insert or an update?" in the upsert via a RETURNING
  clause or by checking row existence before upsert. Only call
  `incrementProposalVotes` on insert. The increment itself can then use
  a safe delta model.
- Alternatively, move the increment + insert into a single SQL function
  that checks row existence atomically.

Real-world impact:
- Moderate. Vote counts per proposal are typically <100 today; problem is
  latent until a proposal with 10k+ votes exists.
- Highest absolute-RPS-cost function is currently
  `ds_update_active_member_count` since it runs on EVERY transfer that
  crosses a zero boundary.

Recommended remediation (deferred until a proposal exceeds ~1k votes):
1. Add a `_was_inserted` signal on `upsertVote` (via RETURNING).
2. Gate the increment on insert-only.
3. Convert the increment to safe delta math.

---

### Top-5 #3 — `getProcessedLogKeys` fetched at start of every block range

**Status: VALID.**

Code: `src/services/database.ts:438-466` called from
`src/services/processor.ts:147`.

What I confirmed:
- On a clean run the function paginates 1000 rows at a time until it gets
  empty. When no prior failures exist for the range, the first page comes
  back empty (at most 1 RTT) — not the "thousands of rows" the architect
  implied.
- Under retry after partial failure it can return ≤ `logCount` entries.
- `pruneProcessedLogs` runs after every successful range and deletes rows
  older than `reorgWalkBack * 2`, keeping the table small.

Real-world impact:
- The per-range overhead is one small page fetch, not a full table scan.
- Still a free RTT we don't need on the happy path.

Fix safety:
- Lazy fetch: only call `getProcessedLogKeys` inside the `catch` block that
  handles retry, not on every range. This changes semantics only if a
  different process partially processed logs in the same range, which is
  impossible given `is_syncing` interlock.
- Alternative: switch to `INSERT ... ON CONFLICT DO NOTHING RETURNING *`
  for `markLogProcessed`; if the row already existed, skip downstream
  handler work. That is a deeper refactor.

Recommended remediation: lazy-fetch on retry only. Small, safe.

---

### Top-5 #4 — `ds_delete_events_after_block` single unbounded transaction

**Status: VALID (low real-world priority).**

Code: `supabase/migrations/schema.sql:523-576`.

What I confirmed:
- Nine `DELETE` statements then four per-affected-DAO aggregate
  recomputations, all in one transaction.
- On a reorg with 1 affected DAO (typical), this is fine. On a reorg with
  1000 affected DAOs (hypothetical), the aggregate scans are O(DAOs ×
  rows-per-DAO).

Real-world impact:
- Current production reorgs affect ≤ 1 DAO in the replay window. The
  function is over-engineered for current scale; no actual performance
  problem today.
- The "silent member balance corruption" caveat is M2, already covered.

Fix safety:
- Chunking the aggregate recomputation would help at scale but is
  unnecessary today.
- Adding a `requires_full_reindex` flag for M2 is safe and cheap.

Recommended remediation: bundle with M2 fix (flag emission).

---

### Top-5 #5 — `handleNewPost` DoS

Duplicate of **H1**. Covered above.

---

### S1 — Launcher-first sort breaks within-tx ordering

**Status: FALSE POSITIVE.**

Code: `src/services/processor.ts:132-140`.

What I confirmed:
- The sort moves launcher events ahead of non-launcher events within the
  same tx but preserves `log.index` ordering among non-launcher events
  (via the `return a.index - b.index` fallback).
- The architect's concern was hypothetical "future contract emits MintShares
  and LaunchDAOShip in the same tx with a required interleave". Today's
  contracts don't do this; the launcher tx emits launcher events plus
  setup events from the clone (NewPost, SetupComplete, MintShares for
  initial members). Setup events all fire AFTER the launcher event in
  real chain order, so the sort is a no-op in practice for the intended
  case — it only activates when chain order puts `NewPost(from setUp)`
  before `LaunchDAOShip`, which the comment documents as the known case.

Real-world impact: none. The sort is correct and the fallback preserves
intended ordering.

---

### S2 — `MAX_DISCOVERY_PASSES = 3` silent cap

**Status: FIXED (2026-04-16).**

Remediation:
- `src/services/processor.ts`: after the discovery loop, snapshot the
  registry one more time and compare against the known-addresses set. If
  any addresses were discovered on the final pass, throw with a
  descriptive message including the pending count and a sample of
  addresses. The throw propagates to the polling loop / backfill retry
  tracker, which re-processes the range. Since `ds_processed_logs`
  dedupes already-handled logs, the retry only fetches-and-processes the
  events for the newly discovered addresses — converges in ≤1 extra
  iteration for any realistic deployment.
- `test/unit/processor-discovery.test.ts`: new file with 2 tests covering
  (a) a pathological registry that always returns a new address → throws;
  (b) a stable registry → resolves normally.

Original finding (for context):

Code: `src/services/processor.ts:84-107`.

What I confirmed:
- After pass 3, if any new addresses remain in the delta, the loop exits
  without logging at `error` or throwing. `updateLastProcessedBlock`
  advances and the events are permanently missed.
- Current contract topology requires exactly 2 passes
  (DAO-launch → navigator-deployed). Margin of 1.
- Any future contract that deploys via a deeper constructor chain would
  silently lose events.

Fix safety:
- Adding a post-loop check "did we still have pending addresses?" + throw
  on that condition is safe: the transient throw triggers block-range
  retry, which will pick up the new addresses on the next pass without
  changing correctness.

Recommended remediation: add the post-loop check. ~5 LOC.

---

### S3 — `waitForRpcConnection` sleep race with SIGINT

**Status: VALID (cosmetic).**

Code: `src/index.ts:547-574`. SIGINT during startup RPC wait will wake the
sleep, but the outer `for` doesn't check a shouldStop; init continues
until force-exit. Cosmetic — force-exit catches it.

Recommended remediation: low priority.

---

### S4 — `recordEventTransaction` serial loop

**Status: VALID (low impact).**

Code: `src/services/processor.ts:219-221`. N unique txs × 1 RTT each.

Fix safety:
- The Supabase JS client supports `.upsert([...])` with an array for batch
  inserts. Collapsing the loop into a single batch upsert is safe.

Recommended remediation: small refactor; bundle with Top-5 #1.

---

### S5 — `is_syncing` stale flag under Supabase outage

**Status: VALID.**

Code: `src/index.ts:653-655` (doBackfill finally block);
`src/index.ts:206-214` (startup stale check).

What I confirmed:
- The startup check fires on *any* `is_syncing=true`, even if
  `last_indexed_at` is 5 seconds old. This is safe because startup only
  happens on restart, so a stuck flag clears.
- If two processes ever ran simultaneously (shouldn't happen; backfill.ts
  refuses if `is_syncing=true`), the startup check would clear the other
  process's flag. Risk is low because the operational contract forbids
  concurrent processes.

Fix safety:
- Architect's "5 min staleness threshold before clearing" is safer but
  adds a failure mode (what if `last_indexed_at` was never set?). Current
  unconditional clear at startup is simpler and not demonstrably broken.

Recommended remediation: accept current behaviour.

---

### S6 — Process-level crash handlers swallow async failures

**Status: VALID (documented behavior).**

Code: `src/index.ts:146-166`. `db.setIsSyncing(false).catch(() => {})`
followed by `process.exit(1)` — the promise cannot complete. The comments
say "Best-effort" and "The startup stale check handles cases where this
doesn't complete" — so this is known and accepted.

Real-world impact: none — startup recovery is reliable.

Recommended remediation: delete the fire-and-forget calls OR replace with
`process.exitCode = 1; await …` — but either change increases the chance
of hanging on crash. Current behaviour is the right tradeoff.

---

### S7-S10

All accurately observed. S7 (Supabase outage recovery) and S10 (AbortController
usage) are positive. S8 (circuit breaker labeled "RPC" but covers DB too) is
a minor naming issue. S9 (reorg detection + registry rebuild) is well-designed
as-is.

---

### SC1, SC2, SC5 — Scaling ceilings

**Status: VALID (latent).**

The in-memory registry, 100-address `getLogs` chunking, and single-threaded
polling all impose ceilings at roughly ~300 DAOs. The architect's numbers
are correct. No fix is needed today but they should be on the roadmap.

The architect's recommendation "flip to unfiltered topic0 fetching past
~300 DAOs" is correct in principle but requires measurement of actual log
volume on Quai before committing.

---

### SC3 — `MAX_DISCOVERY_PASSES = 3` at scale

Duplicate of S2.

---

### SC4, SC6, SC7

- **SC4** (`timestampCacheSize` memory): negligible at any reasonable DAO
  count. ACCEPTED.
- **SC6** (RTT counts per event): already covered in Top-5 #1. VALID.
- **SC7** (`pruneProcessedLogs` runs every range): **FIXED
  (2026-04-16)**. Added `private lastPrunedCutoff` on `DatabaseService`;
  `pruneProcessedLogs` now returns early when `cutoff <= lastPrunedCutoff`
  (skipping the DELETE RTT on retry-after-failure where `currentBlock`
  repeats). The cutoff is only advanced on successful prune, so
  transient errors re-trigger the DELETE on the next call. Tested in
  `test/unit/database-prune-guard.test.ts` (5 cases: first-call prunes,
  same-cutoff skipped, advancing-cutoff prunes, error-does-not-advance,
  early-blocks short-circuit).

---

### E1 — SubmitVote reads before writes

**Status: FIXED (2026-04-16).**

Remediation — the original validation claim "saves 2 RTTs per vote" was
wrong: the pre-reads ARE the 2 RTTs in the common case (the upserts only
fire on the stub path). The fix combined two optimizations:

1. **Insert-if-absent** via `ignoreDuplicates: true` with `.select()` so
   callers can detect whether a stub was actually materialized. Added
   `DatabaseService.insertProposalIfAbsent` and `insertMemberIfAbsent`.
2. **Parallelize** the two independent operations via `Promise.all` since
   they target different tables. Previously the pre-reads were
   sequential; now the insert-if-absents run concurrently.

Combined wall-clock saving in the common case: ~1 RTT per vote (down from
2 sequential pre-reads to 2 parallel upsert-if-absents). Rare-stub case
saves more (2-3 RTTs) because the fallback upsert is eliminated.

Files:
- `src/services/database.ts` — `insertProposalIfAbsent`,
  `insertMemberIfAbsent`.
- `src/handlers/daoship.ts` — `handleSubmitVote` now runs both stub
  inserts in `Promise.all`, and `handleRagequit` member-stub pre-read
  replaced with `insertMemberIfAbsent` (the only upsert in its path).
  Operational "data gap detected" log warnings preserved by checking
  the returned boolean.
- `test/unit/handlers/daoship.test.ts` — updated 2 existing stub tests
  and added a new "both exist, no stub fired" test.
- `test/unit/handlers/helpers.ts` — added mocks for the two new methods.

Original finding (for context):

Code: `src/handlers/daoship.ts:295-332`.

What I confirmed:
- Pre-reads exist to avoid overwriting real rows with stub data
  (`details: '_stub:true'`, `voting_period: 0`, etc.).
- Architect suggested "just upsert with ON CONFLICT DO NOTHING". The
  Supabase JS client exposes this via `upsert(..., { ignoreDuplicates:
  true })`. This is a valid optimization.

Fix safety:
- `ignoreDuplicates: true` does NOT overwrite existing rows, so the stub
  wouldn't clobber real proposals. Safe.
- Eliminates 2 RTTs per vote on the common path.

Recommended remediation: convert both stub upserts to `ignoreDuplicates:
true` and remove the pre-reads. Save 2 RTTs per vote.

---

### E2 — Transfer member reads before writes

**Status: PARTIAL.**

Code: `src/handlers/tokens.ts:57-67`.

What I confirmed:
- The reads compute the old balance to:
  - Detect zero-crossing for `active_member_count` delta.
  - Log warning on clamp-to-zero (`wouldClamp`).
- Both could be server-side via a `ds_adjust_member_balance` RPC that
  returns `old`/`new`.

Fix safety:
- Moving balance arithmetic server-side via RPC eliminates the read race
  at `tokens.ts:74-77` and collapses Transfer to 2 RPCs (one per side) or
  1 RPC for both sides.
- Non-trivial refactor. Worth doing as scale grows.

Recommended remediation: defer until Top-5 #1 is addressed, then tackle
as a follow-on.

---

### E3, E4, E5

Duplicates of Top-5 #2, Top-5 #4, and H1 respectively. Covered above.

---

### E6 — Transfer upserts are serial (not parallel)

**Status: FIXED (2026-04-16).**

Remediation:
- `src/handlers/tokens.ts`: refactored the sender-debit and receiver-
  credit blocks into local `debitSender` / `creditReceiver` async
  functions. When `hasSender && hasReceiver && from !== to`, both run
  via `Promise.all`. Self-transfers (`from === to`) stay sequential to
  avoid read-modify-write races on the same row.
- The synchronous `activeMemberDelta` math runs BEFORE the await in each
  helper, so the aggregate delta is deterministic regardless of promise
  completion order (both `-=` / `+=` apply before Promise.all yields).
- Existing `transfer: debits sender and credits receiver` test covers
  the parallel path — no new test needed for the behavior-preserving
  perf change.

Original finding (for context):

Code: `src/handlers/tokens.ts:83, 105`.

Fix safety:
- Parallelizing with `Promise.all([upsertMember(sender), upsertMember(receiver)])`
  when `from !== to` is safe. Self-transfers must remain sequential.

Recommended remediation: small patch. ~10 LOC.

---

### E7 — Sequential upserts in setUp / SetGuildTokens

**Status: VALID (low impact).**

Code: `daoship.ts:142-152, 680-691`. Arrays are typically ≤ 5 items.
Batching with `upsert([...])` is safe and cheaper.

Recommended remediation: bundle with Top-5 #1.

---

### E8 — BigInt re-parsing

**Status: ACCEPTED.** Cheap operations. No change needed.

---

### E9 — `registeredTopics` recomputed per call

**Status: VALID (trivial).**

Code: `src/services/processor.ts:229, 250`. `Array.from(map.keys())` is
O(N) but N ≤ 24 events. Caching saves microseconds per call. ACCEPTED.

---

### E10 — Block cache consolidation

Positive observation. Preserve.

---

### SU1 — Mint/Burn handler family duplication

**Status: FIXED (2026-04-16).**

Remediation:
- `src/handlers/daoship.ts`: replaced the four nearly-identical
  `handleMintShares` / `handleMintLoot` / `handleBurnShares` /
  `handleBurnLoot` (each ~8 LOC) with a single `makeMintBurnHandler`
  factory that takes `{ eventName, addrField, tokenType, operation }`.
  Each of the four exports is now a one-line call to the factory.
  Net: ~60 LOC removed, behavior identical, existing 4 handler tests
  still pass.

Original finding (for context):

Code: `src/handlers/daoship.ts:698-760`. Four handlers × ~8 LOC each, all
differing in: the address field name (`to` vs `from`), token type
(`shares` vs `loot`), operation (`mint` vs `burn`).

Fix safety:
- Factory function approach: `makeMintBurnHandler({ addrField, tokenType,
  operation })` returns an `EventHandler`. Registration site changes from
  `handleMintShares` to `makeMintBurnHandler(...)` — no change to the
  dispatcher registration API.
- No real use case breaks. Each handler's observable behavior is
  unchanged.
- Refactor reduces ~50 LOC to ~20.

Recommended remediation: straightforward. Do it.

---

### SU2 — Lock handler family duplication

**Status: FIXED (2026-04-16).**

Remediation:
- `src/handlers/daoship.ts`: replaced the three near-identical
  `handleLockAdmin` / `handleLockManager` / `handleLockGovernor` (each
  ~8 LOC) with a single `makeLockHandler` factory keyed on
  `{ eventName, field }`. ~30 LOC removed, behavior identical, existing
  lock handler tests still pass.

Original finding (for context):

Code: `src/handlers/daoship.ts:766-808`. Three near-identical handlers,
each 8 LOC. Collapses to a factory taking the column name
(`admin_locked` / `manager_locked` / `governor_locked`).

Recommended remediation: straightforward. Do it.

---

### SU3 — Registry parallel maps

**Status: ACCEPTED.**

Code: `src/registry/contract-registry.ts`. Four maps keyed by address. The
current structure is clearer than the proposed single-map-with-kind tag —
direct lookups are O(1) with zero branching. Consolidation trades clarity
for negligible code reduction.

Recommended remediation: leave as-is.

---

### SU4 — Typed vs generic DB methods

**Status: ACCEPTED.**

Code: `src/services/database.ts`. Dedicated typed methods exist for the
four hot-path tables (DAOs, members, proposals, votes); six low-frequency
tables go through generic `upsert/insert` with a table-name allowlist.
The asymmetry is intentional — typed methods for performance-critical
tables, generic for the rest.

Recommended remediation: leave as-is. Typing every table is busywork.

---

### SU5 — `validateEventArgs + safeBigInt + logger.info` boilerplate

**Status: VALID (low priority).**

A `decodeDaoEvent<T>(ctx, args, schema)` helper would halve each handler.
Real cleanup, but no correctness benefit. Low priority.

---

### SU6 — `sanitizeStr` / `str` / `urlStr` / `num` pattern

Positive observation. Preserve.

---

### SU7 — Error-message consistency

**Status: VALID (informational).**

Minor audit: `handleNavigatorSet` logs `warn` on invalid permission
(daoship.ts:549) while all other "malformed input" sites log `error`.
Not a bug, but worth aligning.

---

### SU8 — Dead code check

Clean. Positive observation.

---

### A1 — Service boundaries

Positive observation. Preserve.

---

### A2 — Event-ownership rules implicit

**Status: VALID (informational).**

The ownership rules (Transfer owns member balances; MintShares/BurnShares
own DAO totals; Ragequit owns its own totals) are enforced by convention
and documented in inline comments. A central doc or per-handler annotation
would reduce the risk of a future handler breaking the invariants.

Recommended remediation: promote the ownership rules from inline comments
to a top-of-file docstring in `handlers/index.ts`.

---

### A3 — Discovery-loop vs speculative fetching

**Status: VALID (measurement needed).**

Needs log-volume measurement on Quai before committing to either approach.
The architect's framing is right: at <300 DAOs the current design is fine;
past that, pure topic0 scanning may win.

Recommended remediation: defer pending measurement.

---

### A4 — Test coverage gaps

**Status: FIXED (2026-04-16).**

Confirmed missing unit tests for `processor.ts`, `database.ts`,
`contract-registry.ts`. All three are testable with mocks. Architect's
prioritization (processor first) is right — it is the highest-risk
untested code.

Recommended remediation: add `processor.test.ts` as the next test file.

Remediation: `test/unit/processor.test.ts` added — 15 tests covering:
- validation: `fromBlock > toBlock` rejection, empty-range behavior
- happy path: dispatch, markLogProcessed, deduped event-tx recording
- dedup: skip logs already in `ds_processed_logs`
- launcher-first sort within same tx + log-index preservation otherwise
- error classification: transient (ECONNRESET / ETIMEDOUT code) rethrows;
  deterministic errors logged and skipped without aborting the range
- block-hash return: cached, fallback-fetch, and fallback-failure paths

Remaining files added in this cycle:

- `test/unit/contract-registry.test.ts` — 20 tests covering
  `registerDao` (fresh, idempotent, token-re-map), `getDaoByTokenAddress`,
  `isSharesToken`, navigator register/unregister/re-register,
  `clear()` idempotency + post-clear re-registration, address case
  normalization, counters.
- `test/unit/database-methods.test.ts` — 20 tests covering:
  - `VALID_TABLES` allowlist enforcement on generic `upsert()` /
    `insert()` (SQL-injection defense): rejects unknown tables,
    typed-table names, and pg_catalog/DROP-TABLE injection attempts.
    Accepts each whitelisted table.
  - `insert()` ignoring `23505` duplicate-key errors (retry
    idempotency contract).
  - H1 `getNavigatorByAddress` return shape, null-on-miss,
    invalid-address pre-check, DB-error propagation.
  - E1 `insertProposalIfAbsent` / `insertMemberIfAbsent` boolean
    wiring (true on insert, false on conflict), `ignoreDuplicates`
    option passed through, error propagation.
  - Address + bytes32 validation on `upsertDao`, `getDao`,
    `updateDao`, `recordEventTransaction` inputs.

Residual coverage gaps:

- `blockchain.ts` — thin wrapper around `quais.JsonRpcProvider`; unit
  testing mostly validates the mock layer. Lower ROI.
- `health.ts` — HTTP server + rate limiting; integration testing
  (via a dev server) would be more valuable than unit tests.
- Iterator methods (`getAllDaosIterator`, `getActiveNavigatorsIterator`)
  — exercised via e2e and existing handler tests indirectly.

---

### A5-A9

All accurate. A5 (multi-env via schema) is sound with M1 applied. A6
(dedup table) is the right primitive. A7 (no cross-handler ordering
guarantees in same-block) is a latent concern but currently unreachable.
A8 (no observability metrics) is worth adding after Top-5 #1 to measure
the improvement. A9 (graceful shutdown) is well-designed.

---

## Validated action list (priority order)

### Tier 0 — FIXED (2026-04-16)
- **H1** — allowlist NewPost verification moved from per-post RPC to per-
  deployment RPC via cached `allowlist_root` on `ds_navigators`.
- **M1** — SUPABASE_SCHEMA whitelist in `config.ts`.
- **M2** — `requires_full_reindex` flag on `ds_indexer_state`, set on reorg,
  surfaced through `/health` (indexer check goes `fail` when set).
- **M3 (pin)** — `quais` pinned to exact alpha version.
- **M4** — `BlockProcessor.clearCaches()` called from reorg recovery.
- **M5** — In-loop reorg detection via shared `detectAndRecoverReorg` helper.
- **S2** — Discovery-pass overflow now throws for retry instead of silently
  dropping events.
- **SC7** — `pruneProcessedLogs` guards on `lastPrunedCutoff` to skip
  no-op DELETEs.
- **E6** — `handleTransfer` parallelizes sender/receiver upserts for
  non-self transfers.
- **SU1** — Mint/Burn handler family collapsed via `makeMintBurnHandler`.
- **SU2** — Lock handler family collapsed via `makeLockHandler`.
- **E1** — `handleSubmitVote` and `handleRagequit` use parallel
  `insertProposalIfAbsent` / `insertMemberIfAbsent` (no pre-reads).
- **A4** — `processor.test.ts` (15 tests) +
  `contract-registry.test.ts` (20 tests) +
  `database-methods.test.ts` (20 tests) — covers all three files that
  were untested pre-cycle.

### Tier 1 — Do next (high value, low risk)
1. Document `CONFIRMATION_BLOCKS ≥ 5` as mainnet minimum (already the
   value in `.env.mainnet.example`; just needs a README note).

### Tier 2 — Do this quarter
6. **Top-5 #1 — Options A AND B SHIPPED (2026-04-18).**
   - Option A: lazy per-range `RangeCache` for members + DAOs, scoped
     to `processBlockRange`, with `fetchMember`/`fetchDao` read-through
     helpers and invalidate-on-write. Pre-existing self-transfer
     balance bug found and fixed in the same cycle.
   - Option B: handler idempotency refactor (`ds_apply_transfer` RPC
     replaces client-side balance math) + end-of-range batched writes
     (dirty-DAO recompute, batched `markLogProcessed`). Delta-based
     `adjustDaoTotals` removed from the Option B handler path; kept
     for reorg recovery only.
   - Combined with unfiltered topic0 fetching (A3 / SC1), the
     realistic DAO ceiling moves from ~1,000 to ~15,000–20,000.
   - See `docs/PERF_BATCH_DB_ROUNDTRIPS.md` §0.4 (unfiltered) and
     §0.5 (Option B) for full changelogs, schema migrations, and
     security mitigations (Security Engineer B1–B7 all addressed).

### Tier 3 — Measure before committing
10. **Top-5 #2** — revisit only after a proposal exceeds ~1k votes.
11. **SC1 / SC2 / SC5** — scaling redesign after DAO count > 300.
12. **A3** — topic0-only fetching after log-volume measurement.
13. **M3 (dev CVEs)** — vitest v4 migration (dev-only, not urgent).

### Tier 4 — Defer indefinitely
14. **H2** — least-privilege Postgres role.
15. **SU3 / SU4** — registry and DB-method consolidation (no real benefit).
16. **L1 / L2 / L5 / L6 / L7** — low-impact hardening.

---

## Summary of corrections to the original audit

| Original finding | Corrected status | Why |
|---|---|---|
| C1 (secrets on disk) | Not applicable | Production uses Infisical; dev files are burners |
| H1 (DoS) | **FIXED 2026-04-16** | Cached `allowlist_root` at NavigatorDeployed; DB lookup replaces 3-call RPC verification |
| M1 (schema whitelist) | **FIXED 2026-04-16** | Added whitelist + tests |
| M2 (reorg desync) | **FIXED 2026-04-16** | Added `requires_full_reindex` flag, surfaced via `/health` |
| M3 (deps) | Partial FIX / otherwise clean | `quais` pinned; prod audit clean; dev CVEs remain |
| M4 (blockCache) | **FIXED 2026-04-16** | `clearCaches()` called on reorg recovery |
| M5 (in-loop reorg) | **FIXED 2026-04-16** | Shared helper called from both startup and polling |
| S1 (launcher sort) | False positive | Sort is correct for current contracts |
| S2 (discovery cap) | **FIXED 2026-04-16** | Throw on overflow triggers block-range retry |
| SC7 (prune on every range) | **FIXED 2026-04-16** | `lastPrunedCutoff` guard |
| E6 (transfer upserts serial) | **FIXED 2026-04-16** | Promise.all in non-self-transfer path |
| SU1 (mint/burn duplication) | **FIXED 2026-04-16** | `makeMintBurnHandler` factory |
| SU2 (lock duplication) | **FIXED 2026-04-16** | `makeLockHandler` factory |
| E1 (SubmitVote pre-reads) | **FIXED 2026-04-16** | Parallel insert-if-absent; ~1 RTT saved per vote |
| A4 (processor / registry / database tests) | **FIXED 2026-04-16** | 55 tests covering BlockProcessor, ContractRegistry, and DB security/H1/E1 paths |
| Top-5 #2 (delta rewrite) | Wrong fix | Delta model fails under partial handler failure |
| Top-5 #3 (scan) | Overstated | First page is small; still worth lazy-fetch |
| Top-5 #4 (reorg fn) | Overstated | Current reorg scope is ≤1 DAO; latent only |
| SU3 / SU4 (collapse) | Accepted as-is | Current structure is clearer than proposed |

---

## Remediation changelog (2026-04-16)

Files touched:
- `src/config.ts` — added `VALID_SCHEMAS` whitelist + `validateSupabaseSchema`.
- `src/services/database.ts` — extended `getIndexerState` return shape;
  added `setRequiresFullReindex`, `clearRequiresFullReindex`, and
  `getNavigatorByAddress` (H1 DB lookup).
- `src/services/health.ts` — extended `HealthStatus`, `checkSupabase`, and
  `computeHealthStatus` to read and report the reindex flag.
- `src/services/processor.ts` — added `clearCaches()`.
- `src/index.ts` — extracted `detectAndRecoverReorg` shared helper; added
  in-loop reorg check using a new `lastCommittedBlockHash` tracker;
  refreshed hash after init and in-loop backfills.
- `src/handlers/daoship.ts` — added `ALLOWLIST_ROOT_SELECTOR` constant;
  extended `handleNavigatorDeployed` to best-effort cache
  `allowlist_root` (H1 Change 1).
- `src/handlers/poster.ts` — removed `verifyAllowlistOnChain`,
  `DAOSHIP_SELECTOR`, and `ALLOWLIST_ROOT_SELECTOR`; added
  `verifyAllowlistFromIndex` DB-only verification (H1 Change 2);
  rewrote the `isNavigatorAllowlist` branch in `handleNewPost`.
- `supabase/migrations/schema.sql` — added `requires_full_reindex`,
  `reindex_reason`, `reindex_flagged_at` columns to `ds_indexer_state`
  and `allowlist_root` column to `ds_navigators`, all with
  `ADD COLUMN IF NOT EXISTS` migration lines for pre-existing schemas.
- `package.json` — pinned `quais` to exact alpha version.
- `test/unit/config.test.ts` — added whitelist accept/reject tests.
- `test/unit/handlers/daoship.test.ts` — added 4 allowlist-root caching
  tests for `handleNavigatorDeployed`.
- `test/unit/handlers/poster.test.ts` — replaced 6 on-chain verification
  tests with 7 DB-indexed tests covering every accept/reject branch.
- `test/unit/handlers/helpers.ts` — added `getNavigatorByAddress` mock.
- `test/unit/database-reindex-flag.test.ts` — new file, 4 tests.
- `test/unit/reorg-recovery.test.ts` — new file, 2 tests.
- `src/services/processor.ts` — added post-discovery-loop throw (S2).
- `src/services/database.ts` — added `lastPrunedCutoff` guard on
  `pruneProcessedLogs` (SC7).
- `src/handlers/tokens.ts` — refactored sender/receiver into
  `debitSender` / `creditReceiver` helpers parallelized via `Promise.all`
  for non-self transfers (E6).
- `src/handlers/daoship.ts` — replaced 4 mint/burn handlers with
  `makeMintBurnHandler` factory (SU1) and 3 lock handlers with
  `makeLockHandler` factory (SU2). ~90 LOC removed.
- `test/unit/processor-discovery.test.ts` — new file, 2 tests for S2.
- `test/unit/database-prune-guard.test.ts` — new file, 5 tests for SC7.
- `src/services/database.ts` — added `insertProposalIfAbsent` and
  `insertMemberIfAbsent` (E1).
- `src/handlers/daoship.ts` — `handleSubmitVote` and `handleRagequit`
  use the new insert-if-absent methods in `Promise.all` (E1).
- `test/unit/handlers/daoship.test.ts` — updated 2 stub tests + 1 new
  "both exist" test for E1.
- `test/unit/handlers/helpers.ts` — added `insertProposalIfAbsent` /
  `insertMemberIfAbsent` mocks.
- `test/unit/processor.test.ts` — new file, 15 tests for A4.
- `test/unit/contract-registry.test.ts` — new file, 20 tests for A4
  (register, unregister, token/navigator lookup, counters, clear).
- `test/unit/database-methods.test.ts` — new file, 20 tests for A4
  (VALID_TABLES allowlist, H1 `getNavigatorByAddress`, E1
  insert-if-absent wiring, duplicate-key ignoring, input validation).

Test summary: 306 unit tests pass (was 232 pre-remediation; +74 net new).
No e2e run in this cycle.

### Schema migration required

Before deploying the new indexer build, run:

```sql
SELECT create_ds_schema('dev');
SELECT create_ds_schema('testnet');
SELECT create_ds_schema('mainnet');
```

The function is idempotent and uses `ADD COLUMN IF NOT EXISTS` for both
the M2 and H1 columns, so re-running is safe.

---

*Validation date: 2026-04-16. Re-validate after any significant handler or
processor change.*
