# Record event ordering rollout

Prepared on 2026-09-10. The migration and backfill have **not** been applied to a live database, and the indexer service has not been restarted or deployed as part of this work.

`ds_records.transaction_index` and `log_index` are nullable INTEGER columns. New Poster records use the actual `quais.Log.transactionIndex` and block-wide `Log.index`; the processor already dispatches logs in that order. Missing or invalid coordinates remain NULL together. Legacy rows receive no defaults or ordering inferred from timestamps, transaction hashes or primary-key suffixes.

## Rollout sequence

1. Review/apply `supabase/migrations/20260910000100_record_event_order.sql` through the operator's migration process. It adds columns only to existing DAOShips schemas, preserves legacy NULLs, adds a nonnegative/pair constraint idempotently, and reloads the PostgREST schema cache. Its five-second lock timeout fails instead of waiting indefinitely for a busy table. It does not reset data or rewind checkpoints.
2. Deploy the new Poster handler **after** the migration. The migration is compatible with the old reader/handler; the new handler requires the columns. Continue normal indexing and verify newly inserted records have both coordinates.
3. Preview a bounded historical backfill, then separately run the same reviewed bounds with `--apply` using server-side credentials. Do not run the general event replay to populate these fields: processed-log deduplication would skip existing events, and forcing business handlers to replay could change materialized state.
4. Enable `recordOrdering: true` in SDK consumers after the target schema is ready. Baseline SDK queries keep their old projection so hosted schemas without the migration continue working. Legacy/mixed unknown order still produces an incomplete profile until verified backfill resolves it.

## Targeted backfill

From the indexer workspace, set these explicit environment variables through the operator's existing secret-management process; the script does not load `.env` files or infer a target:

- `SUPABASE_URL`, `SUPABASE_SCHEMA` and `QUAI_RPC_URL` (explicit HTTPS endpoints). `QUAI_RPC_URL` is the bare host (`https://rpc.quai.network`, `https://orchard.rpc.quai.network`); the provider adds the `/cyprus1` shard path itself.
- `SUPABASE_PUBLISHABLE_KEY` for preview; `SUPABASE_SERVICE_KEY` for `--apply`.
- `CHAIN_ID`, `POSTER_ADDRESS`, `BACKFILL_FROM`, `BACKFILL_TO`.
- Optional `BACKFILL_MAX_ROWS` (default 1,000, maximum 10,000), `BACKFILL_CONFIRMATIONS` (default 64, minimum 1), and `BACKFILL_AFTER_ID` for continuation.

```sh
npm run backfill:record-event-order
# After reviewing the preview and supplying server-side credentials:
npm run backfill:record-event-order -- --apply
```

The maximum block window is 100,000 blocks. Each RPC/HTTP request has a 15-second timeout. The range must be behind the observed head by the requested confirmation depth; this is a bounded risk policy, not an assertion of irreversible finality. The script checks RPC and indexer chain identity and refuses a reindex-required checkpoint. Its keyset scan uses IDs only for pagination; ID sorting never determines event order.

For every candidate, the script verifies the canonical block hash and work-object height, the transaction at the receipt's index in that block, and exactly one matching Poster log. Emitter, author, tag topic, raw content, DAO/record identity, transaction hash, block number and actual log coordinates must all agree. It updates only rows whose coordinates are still NULL and whose original identity/content fields still match. The script does not post transactions, rerun handlers, delete data, alter balances, change checkpoint/sync state, or require the running indexer to stop.

The result reports scanned/verified/updated/unavailable counts, exhaustion, completeness and `continuationAfterId`. Missing receipts stay unknown. A mismatching receipt or RPC/schema failure stops the run, preserving unknown order rather than guessing. Writes already verified before a failure may have completed; rerunning is safe because known coordinates are excluded. Reuse the continuation ID to visit later candidates, and separately retry unavailable earlier receipts when archival RPC data becomes available. A row-budget boundary is conservatively incomplete.

The script's guards coexist with normal indexing: deploy the new handler before applying backfill so replayed/reorg-replaced rows already carry non-NULL order and cannot be overwritten by maintenance. Standard indexer reorg rollback remains authoritative. Cross-system RPC/database reads do not constitute an atomic transaction.

## Historical profile authority

The new Poster handler also marks every accepted DAO profile as vault-controlled and
invalidates the DAO cache after the write succeeds, including banner/theme-only posts.
Omitted name/description/avatar fields retain their existing values. Once vault control
is established, later deployer initial profiles cannot overwrite the materialized profile.

Older handler versions could leave `ds_daos.profile_source` unset or `launcher` after a
vault profile that changed only nonmaterialized fields. The ordering migration/backfill
does **not** repair that flag or metadata already overwritten by a later initial profile.
Such historical DAOs require a separate reviewed repair based on their canonical,
authenticated profile history, including reconstruction of materialized metadata when
necessary. Merely setting the flag cannot undo an earlier overwrite. Prepare and compare
the reconstruction separately before applying any repair; do not bypass processed-log
deduplication or replay business handlers against the running database. No historical
profile repair has been performed by this work.

## Validation

Indexer source typechecking and separate backfill-script typechecking pass. Focused tests cover new record positions, legacy NULL behavior, canonical receipt/block and transaction-position verification, duplicates, malformed/missing receipt data, emitter/author/tag/content mismatches and removed logs. SQL was reviewed and supplied as an idempotent executable migration; no live migration, backfill or service operation was performed.
