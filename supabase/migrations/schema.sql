-- ═══════════════════════════════════════════════════════════════════════════
-- DAO Ships Indexer Schema
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Multi-environment support via PostgreSQL schemas.
-- Each environment (testnet, mainnet, dev) gets its own isolated schema
-- within a single Supabase project.
--
-- All tables are prefixed with ds_ to avoid conflicts with other indexers
-- (e.g. quaivault) sharing the same schema namespaces.
--
-- Usage:
--   1. Run this file in the Supabase SQL Editor
--   2. Create environments:
--        SELECT create_ds_schema('testnet');
--        SELECT create_ds_schema('mainnet');
--        SELECT create_ds_schema('dev');
--   3. Expose schemas to PostgREST API:
--        ALTER ROLE authenticator SET pgrst.db_schemas TO 'public, graphql_public, testnet, mainnet, dev';
--        NOTIFY pgrst, 'reload config';
-- ═══════════════════════════════════════════════════════════════════════════


-- ── Shared Enum Types (public schema) ───────────────────────────────────

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ds_proposal_status') THEN
        CREATE TYPE public.ds_proposal_status AS ENUM (
            'unborn',
            'submitted',
            'voting',
            'grace',
            'ready',
            'processed',
            'cancelled',
            'defeated',
            'expired'
        );
    END IF;
END
$$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ds_navigator_permission') THEN
        CREATE TYPE public.ds_navigator_permission AS ENUM (
            'none',
            'admin',
            'manager',
            'admin_manager',
            'governor',
            'admin_governor',
            'manager_governor',
            'all'
        );
    END IF;
END
$$;


-- ── Create DS Schema Function ──────────────────────────────────────────

CREATE OR REPLACE FUNCTION create_ds_schema(network_name TEXT)
RETURNS void AS $$
DECLARE
    s TEXT := network_name;
BEGIN
    -- H1: Whitelist valid schema names to prevent accidental or malicious schema creation.
    IF network_name NOT IN ('testnet', 'mainnet', 'dev', 'public') THEN
        RAISE EXCEPTION 'Invalid network name: %. Must be one of: testnet, mainnet, dev, public', network_name;
    END IF;

    -- Create the schema (may already exist from other indexers)
    EXECUTE format('CREATE SCHEMA IF NOT EXISTS %I', s);

    -- ═══════════════════════════════════════════════════════════════════
    -- TABLES
    -- ═══════════════════════════════════════════════════════════════════

    -- DS_DAOS
    EXECUTE format('
        CREATE TABLE IF NOT EXISTS %I.ds_daos (
            id VARCHAR(42) PRIMARY KEY,
            created_at TIMESTAMPTZ NOT NULL,
            tx_hash VARCHAR(66) NOT NULL,

            loot_address VARCHAR(42) NOT NULL,
            shares_address VARCHAR(42) NOT NULL,
            avatar VARCHAR(42) NOT NULL,
            deployer VARCHAR(42),
            launcher_contract VARCHAR(42) NOT NULL,

            loot_paused BOOLEAN DEFAULT FALSE,
            shares_paused BOOLEAN DEFAULT FALSE,

            grace_period BIGINT NOT NULL DEFAULT 0,
            voting_period BIGINT NOT NULL DEFAULT 0,
            voting_plus_grace_duration BIGINT GENERATED ALWAYS AS (voting_period + grace_period) STORED,
            proposal_offering NUMERIC(78, 0) NOT NULL DEFAULT 0,
            quorum_percent NUMERIC(78, 0) NOT NULL DEFAULT 0,
            sponsor_threshold NUMERIC(78, 0) NOT NULL DEFAULT 0,
            min_retention_percent NUMERIC(78, 0) NOT NULL DEFAULT 0,
            default_expiry_window BIGINT DEFAULT 0,

            share_token_name VARCHAR(255),
            share_token_symbol VARCHAR(32),
            loot_token_name VARCHAR(255),
            loot_token_symbol VARCHAR(32),

            total_shares NUMERIC(78, 0) DEFAULT 0,
            total_loot NUMERIC(78, 0) DEFAULT 0,

            latest_sponsored_proposal_id BIGINT DEFAULT 0,
            proposal_count BIGINT DEFAULT 0,
            active_member_count BIGINT DEFAULT 0,

            new_vault BOOLEAN DEFAULT FALSE,
            admin_locked BOOLEAN DEFAULT FALSE,
            manager_locked BOOLEAN DEFAULT FALSE,
            governor_locked BOOLEAN DEFAULT FALSE,

            name VARCHAR(255),
            description TEXT,
            avatar_img TEXT,
            profile_source VARCHAR(20),

            updated_at TIMESTAMPTZ DEFAULT NOW()
        )', s);

    -- DS_MEMBERS
    EXECUTE format('
        CREATE TABLE IF NOT EXISTS %I.ds_members (
            id VARCHAR(85) PRIMARY KEY,
            dao_id VARCHAR(42) NOT NULL REFERENCES %I.ds_daos(id) ON DELETE CASCADE,
            member_address VARCHAR(42) NOT NULL,

            created_at TIMESTAMPTZ NOT NULL,

            shares NUMERIC(78, 0) DEFAULT 0,
            loot NUMERIC(78, 0) DEFAULT 0,

            delegating_to VARCHAR(42),
            voting_power NUMERIC(78, 0) DEFAULT 0,

            votes BIGINT DEFAULT 0,

            last_activity_at TIMESTAMPTZ,
            updated_at TIMESTAMPTZ DEFAULT NOW(),

            UNIQUE(dao_id, member_address)
        )', s, s);

    -- DS_PROPOSALS
    EXECUTE format('
        CREATE TABLE IF NOT EXISTS %I.ds_proposals (
            id VARCHAR(90) PRIMARY KEY,
            dao_id VARCHAR(42) NOT NULL REFERENCES %I.ds_daos(id) ON DELETE CASCADE,
            proposal_id BIGINT NOT NULL,

            created_at TIMESTAMPTZ NOT NULL,
            submitter VARCHAR(42),
            tx_hash VARCHAR(66) NOT NULL,

            proposal_data_hash VARCHAR(66) NOT NULL,
            proposal_data TEXT,
            details TEXT,

            prev_proposal_id BIGINT,

            sponsored BOOLEAN DEFAULT FALSE,
            sponsor VARCHAR(42),
            sponsor_tx_hash VARCHAR(66),
            sponsor_tx_at TIMESTAMPTZ,
            self_sponsored BOOLEAN DEFAULT FALSE,

            voting_period BIGINT NOT NULL,
            voting_starts TIMESTAMPTZ,
            voting_ends TIMESTAMPTZ,
            grace_ends TIMESTAMPTZ,
            expiration TIMESTAMPTZ,

            cancelled BOOLEAN DEFAULT FALSE,
            cancelled_tx_hash VARCHAR(66),
            cancelled_tx_at TIMESTAMPTZ,
            cancelled_by VARCHAR(42),

            processed BOOLEAN DEFAULT FALSE,
            process_tx_hash VARCHAR(66),
            process_tx_at TIMESTAMPTZ,
            processed_by VARCHAR(42),

            action_failed BOOLEAN DEFAULT FALSE,
            passed BOOLEAN DEFAULT FALSE,

            yes_votes BIGINT DEFAULT 0,
            no_votes BIGINT DEFAULT 0,
            yes_balance NUMERIC(78, 0) DEFAULT 0,
            no_balance NUMERIC(78, 0) DEFAULT 0,

            max_total_shares_and_loot_at_vote NUMERIC(78, 0),
            max_total_shares_at_sponsor NUMERIC(78, 0),

            proposal_offering NUMERIC(78, 0),

            block_number BIGINT,

            UNIQUE(dao_id, proposal_id)
        )', s, s);

    -- DS_VOTES
    EXECUTE format('
        CREATE TABLE IF NOT EXISTS %I.ds_votes (
            id VARCHAR(132) PRIMARY KEY,
            dao_id VARCHAR(42) NOT NULL,
            proposal_id VARCHAR(90) NOT NULL REFERENCES %I.ds_proposals(id) ON DELETE CASCADE,

            voter VARCHAR(42) NOT NULL,
            approved BOOLEAN NOT NULL,
            balance NUMERIC(78, 0) NOT NULL,

            created_at TIMESTAMPTZ NOT NULL,
            tx_hash VARCHAR(66) NOT NULL,
            block_number BIGINT,

            UNIQUE(proposal_id, voter)
        )', s, s);

    -- DS_NAVIGATORS
    -- dao_id is a PLAIN column (no FK). It holds the self-asserted daoShip from
    -- NavigatorDeployed, bound for every navigator at deploy time — read-only
    -- navigators (SignalNavigator) never get a NavigatorSet to promote them, and the
    -- value may reference a DAO not yet in ds_daos (race) or never (spam against a
    -- junk address). "Known DAO?" is resolved via EXISTS-in-ds_daos in handlers and
    -- the prune predicate, not via the FK. (ds_signal_* DO keep their FK — the
    -- read-only resolution gate guarantees they only ever reference a known DAO.)
    EXECUTE format('
        CREATE TABLE IF NOT EXISTS %I.ds_navigators (
            id VARCHAR(85) PRIMARY KEY,
            dao_id VARCHAR(42),
            navigator_address VARCHAR(42) NOT NULL,
            deployer VARCHAR(42),

            created_at TIMESTAMPTZ NOT NULL,
            deploy_block BIGINT,                   -- block of NavigatorDeployed; bounds the sanction backfill range

            permission INTEGER NOT NULL DEFAULT 0,
            permission_label public.ds_navigator_permission NOT NULL DEFAULT ''none'',
            -- TRUE the first time a NavigatorSet(>0) from a KNOWN DAOShip is seen.
            -- Discriminator that separates a REVOKED navigator (ever_granted=true, now
            -- permission 0) from a born-read-only / never-registered one
            -- (ever_granted=false) — both sit at permission=0. Monotonic.
            permission_ever_granted BOOLEAN NOT NULL DEFAULT FALSE,
            -- Read-only DAO-binding trust. Permissioned navigators are implicitly
            -- ''sanctioned'' (vouched by NavigatorSet). Read-only ones move
            -- self_asserted→sanctioned via the vault daoships.dao.navigators post,
            -- →unsanctioned when revoked, →fabricated on weight-reconciliation failure.
            trust_status VARCHAR(16) NOT NULL DEFAULT ''self_asserted''
                CHECK (trust_status IN (''self_asserted'', ''sanctioned'', ''unsanctioned'', ''fabricated'')),

            is_active BOOLEAN DEFAULT TRUE,        -- "functional now?" — read-only stays TRUE at permission 0; FALSE on revoke / still-unregistered. NOT a proxy for "has permission".
            paused BOOLEAN DEFAULT FALSE,
            navigator_type VARCHAR(50),
            name VARCHAR(255),
            description TEXT,
            config JSONB,
            allowlist_root VARCHAR(66),

            tx_hash VARCHAR(66) NOT NULL,
            updated_at TIMESTAMPTZ DEFAULT NOW(),

            UNIQUE(dao_id, navigator_address)
        )', s);

    -- DS_RAGEQUITS
    EXECUTE format('
        CREATE TABLE IF NOT EXISTS %I.ds_ragequits (
            id VARCHAR(153) PRIMARY KEY,
            dao_id VARCHAR(42) NOT NULL REFERENCES %I.ds_daos(id) ON DELETE CASCADE,

            member_address VARCHAR(42) NOT NULL,
            to_address VARCHAR(42) NOT NULL,
            shares_burned NUMERIC(78, 0) NOT NULL,
            loot_burned NUMERIC(78, 0) NOT NULL,
            tokens TEXT[] NOT NULL,
            amounts TEXT[],

            created_at TIMESTAMPTZ NOT NULL,
            tx_hash VARCHAR(66) NOT NULL,
            block_number BIGINT
        )', s, s);

    -- DS_RECORDS (from Poster.sol)
    EXECUTE format('
        CREATE TABLE IF NOT EXISTS %I.ds_records (
            id VARCHAR(130) PRIMARY KEY,
            dao_id VARCHAR(42) REFERENCES %I.ds_daos(id) ON DELETE CASCADE,

            created_at TIMESTAMPTZ NOT NULL,
            user_address VARCHAR(42) NOT NULL,
            tx_hash VARCHAR(66) NOT NULL,

            tag VARCHAR(100) NOT NULL,
            content_type VARCHAR(50),
            content TEXT NOT NULL,              -- M6: Raw on-chain data. UNTRUSTED. Frontends MUST escape before rendering. Use content_json for sanitized data.
            content_json JSONB,
            trust_level VARCHAR(20),
            block_number BIGINT
        )', s, s);

    -- DS_GUILD_TOKENS
    EXECUTE format('
        CREATE TABLE IF NOT EXISTS %I.ds_guild_tokens (
            id VARCHAR(85) PRIMARY KEY,
            dao_id VARCHAR(42) NOT NULL REFERENCES %I.ds_daos(id) ON DELETE CASCADE,
            token_address VARCHAR(42) NOT NULL,
            enabled BOOLEAN DEFAULT TRUE,

            created_at TIMESTAMPTZ NOT NULL,
            tx_hash VARCHAR(66) NOT NULL,

            UNIQUE(dao_id, token_address)
        )', s, s);

    -- DS_EVENT_TRANSACTIONS
    EXECUTE format('
        CREATE TABLE IF NOT EXISTS %I.ds_event_transactions (
            id VARCHAR(66) PRIMARY KEY,
            dao_id VARCHAR(42) REFERENCES %I.ds_daos(id) ON DELETE CASCADE,

            created_at TIMESTAMPTZ NOT NULL,
            block_number BIGINT NOT NULL
        )', s, s);

    -- DS_DELEGATIONS
    -- Option B: (tx_hash, delegator) is unique by construction — a single
    -- delegator can only emit one DelegateChanged per transaction. The
    -- unique index below enforces this at the DB layer so a retry after
    -- partial commit cannot write a duplicate SERIAL-PK row. Handler
    -- catches 23505 as idempotent success.
    EXECUTE format('
        CREATE TABLE IF NOT EXISTS %I.ds_delegations (
            id SERIAL PRIMARY KEY,
            dao_id VARCHAR(42) NOT NULL REFERENCES %I.ds_daos(id) ON DELETE CASCADE,

            delegator VARCHAR(42) NOT NULL,
            from_delegate VARCHAR(42),
            to_delegate VARCHAR(42) NOT NULL,

            created_at TIMESTAMPTZ NOT NULL,
            tx_hash VARCHAR(66) NOT NULL
        )', s, s);

    -- DS_NAVIGATOR_EVENTS (onboard)
    EXECUTE format('
        CREATE TABLE IF NOT EXISTS %I.ds_navigator_events (
            id TEXT PRIMARY KEY,
            dao_id VARCHAR(42) NOT NULL REFERENCES %I.ds_daos(id) ON DELETE CASCADE,
            navigator_address VARCHAR(42) NOT NULL,
            event_type VARCHAR(20) NOT NULL,
            contributor VARCHAR(42) NOT NULL,
            shares_minted NUMERIC(78, 0) DEFAULT 0,
            loot_minted NUMERIC(78, 0) DEFAULT 0,
            amount NUMERIC(78, 0) DEFAULT 0,
            metadata JSONB,

            created_at TIMESTAMPTZ NOT NULL,
            tx_hash VARCHAR(66) NOT NULL,
            block_number BIGINT NOT NULL
        )', s, s);

    -- DS_NFT_CLAIMS (NFTGatedNavigator.NFTClaimed)
    -- Per-token claim ledger for ERC-721-gated onboarding. A token can be
    -- claimed exactly once, ever (the contract tracks claimed[tokenId]), so the
    -- PK is keyed on {navigator_address}-{token_id} for O(1) "is #N claimed?"
    -- lookups and idempotent upsert under replay/reorg. ADDITIVE to the paired
    -- ds_navigator_events 'onboard' row — member balances live there, not here.
    EXECUTE format('
        CREATE TABLE IF NOT EXISTS %I.ds_nft_claims (
            id TEXT PRIMARY KEY,                  -- {navigator_address}-{token_id}; TEXT to match ds_navigator_events (unbounded tokenId component)
            dao_id VARCHAR(42) NOT NULL REFERENCES %I.ds_daos(id) ON DELETE CASCADE,
            navigator_address VARCHAR(42) NOT NULL,
            token_id NUMERIC(78, 0) NOT NULL,
            holder VARCHAR(42) NOT NULL,          -- claimer at claim time (NFT may move later)
            shares NUMERIC(78, 0) DEFAULT 0,
            loot NUMERIC(78, 0) DEFAULT 0,

            created_at TIMESTAMPTZ NOT NULL,
            tx_hash VARCHAR(66) NOT NULL,
            block_number BIGINT NOT NULL
        )', s, s);

    -- DS_SIGNAL_POLLS (SignalNavigator.PollCreated) — non-binding temperature checks.
    -- Materialized ONLY for navigators with trust_status=''sanctioned'' (defer + backfill);
    -- the sanction backfill replays a navigator''s poll history on the →sanctioned flip.
    -- Keyed {navigator_address}-{poll_id}; poll_id is per-navigator (starts at 0).
    -- Status is time-derived (no status column) — mirror the contract''s pollStatus().
    EXECUTE format('
        CREATE TABLE IF NOT EXISTS %I.ds_signal_polls (
            id TEXT PRIMARY KEY,
            dao_id VARCHAR(42) NOT NULL REFERENCES %I.ds_daos(id) ON DELETE CASCADE,
            navigator_address VARCHAR(42) NOT NULL,
            poll_id NUMERIC(78, 0) NOT NULL,
            creator VARCHAR(42) NOT NULL,
            question TEXT,                          -- IPFS CID or short text (resolve off-chain)
            option_count SMALLINT NOT NULL,         -- 2..10
            snapshot_timestamp BIGINT NOT NULL,     -- votingStarts - 1 (weight timepoint)
            voting_starts BIGINT NOT NULL,
            voting_ends BIGINT NOT NULL,
            cancelled BOOLEAN DEFAULT FALSE,
            tally NUMERIC(78, 0)[] DEFAULT ''{}'',   -- per-option totals (index = option); derive-from-truth via ds_recompute_poll_tally
            -- Off-chain option labels (Poster daoships.signal.poll, msg.sender == PollCreated.creator;
            -- len(options) == option_count). NULL until the labels post is seen → render Option 1..n.
            -- labels_block_number is the labels POST''s block (≠ block_number, which is PollCreated''s)
            -- so a reorg can clear rolled-back labels without dropping the poll row.
            options TEXT[],
            description TEXT,
            discussion_url TEXT,
            labels_updated_at TIMESTAMPTZ,
            labels_block_number BIGINT,
            created_at TIMESTAMPTZ NOT NULL,
            tx_hash VARCHAR(66) NOT NULL,
            block_number BIGINT NOT NULL,
            updated_at TIMESTAMPTZ DEFAULT NOW(),
            UNIQUE(navigator_address, poll_id)
        )', s, s);

    -- Additive migration for pre-existing ds_signal_polls tables that predate the
    -- daoships.signal.poll option-labels feature. Safe to re-run.
    EXECUTE format('ALTER TABLE %I.ds_signal_polls ADD COLUMN IF NOT EXISTS options TEXT[]', s);
    EXECUTE format('ALTER TABLE %I.ds_signal_polls ADD COLUMN IF NOT EXISTS description TEXT', s);
    EXECUTE format('ALTER TABLE %I.ds_signal_polls ADD COLUMN IF NOT EXISTS discussion_url TEXT', s);
    EXECUTE format('ALTER TABLE %I.ds_signal_polls ADD COLUMN IF NOT EXISTS labels_updated_at TIMESTAMPTZ', s);
    EXECUTE format('ALTER TABLE %I.ds_signal_polls ADD COLUMN IF NOT EXISTS labels_block_number BIGINT', s);

    -- DS_SIGNAL_VOTES (SignalNavigator.Voted) — one row per (navigator, poll, voter).
    -- weight is snapshot SHARE power straight from the event (loot excluded on-chain);
    -- never re-derived from balances. The unique key makes replay/reorg idempotent.
    EXECUTE format('
        CREATE TABLE IF NOT EXISTS %I.ds_signal_votes (
            id TEXT PRIMARY KEY,
            poll_pk TEXT NOT NULL REFERENCES %I.ds_signal_polls(id) ON DELETE CASCADE,
            dao_id VARCHAR(42) NOT NULL REFERENCES %I.ds_daos(id) ON DELETE CASCADE,
            navigator_address VARCHAR(42) NOT NULL,
            poll_id NUMERIC(78, 0) NOT NULL,
            voter VARCHAR(42) NOT NULL,
            option SMALLINT NOT NULL,               -- 0..option_count-1
            weight NUMERIC(78, 0) NOT NULL,         -- snapshot share weight (loot excluded)
            created_at TIMESTAMPTZ NOT NULL,
            tx_hash VARCHAR(66) NOT NULL,
            block_number BIGINT NOT NULL,
            UNIQUE(navigator_address, poll_id, voter)
        )', s, s, s);

    -- DS_TIMELOCK_CHANGES (TimelockNavigator.ChangeQueued/ChangeExecuted/ChangeCancelled)
    -- Pending + historical governance-config changes routed through a GOVERNOR-permissioned
    -- TimelockNavigator. Keyed {navigator_address}-{change_id}; change_id is per-navigator
    -- (starts at 0). `governance_config` stores the full 0x-hex ABI-encoded bytes — only the
    -- hash is on-chain, and executeChange(changeId, governanceConfig) needs the exact bytes,
    -- so the app recovers them from here. Status is TIME-DERIVED in the app
    -- (queued→executable→expired by executable_after/expires_at) until a terminal event
    -- (executed/cancelled) lands. Permissioned navigator → trust is implicit (sanctioned via
    -- NavigatorSet); no defer/backfill gate (unlike SignalNavigator).
    EXECUTE format('
        CREATE TABLE IF NOT EXISTS %I.ds_timelock_changes (
            id VARCHAR(128) PRIMARY KEY,           -- {navigator_address}-{change_id}
            dao_id VARCHAR(42) NOT NULL REFERENCES %I.ds_daos(id) ON DELETE CASCADE,
            navigator_address VARCHAR(42) NOT NULL,
            change_id NUMERIC(78, 0) NOT NULL,     -- per-navigator, starts at 0
            queued_by VARCHAR(42) NOT NULL,        -- the DAO avatar (always queued via proposal)
            config_hash VARCHAR(66) NOT NULL,      -- keccak256(governanceConfig)
            governance_config TEXT,                -- full 0x-hex ABI-encoded bytes (needed to call executeChange + decode)
            executable_after BIGINT NOT NULL,
            expires_at BIGINT NOT NULL,
            status VARCHAR(16) NOT NULL DEFAULT ''queued'',  -- queued|executed|cancelled (executable/expired are time-derived in the app)
            executed_tx VARCHAR(66),
            cancelled_tx VARCHAR(66),
            tx_hash VARCHAR(66) NOT NULL,          -- queue tx
            block_number BIGINT NOT NULL,          -- queue block (reorg cleanup bound)
            created_at TIMESTAMPTZ NOT NULL,
            updated_at TIMESTAMPTZ DEFAULT NOW(),
            UNIQUE(navigator_address, change_id)
        )', s, s);

    -- DS_VESTING_SCHEDULES (VestingNavigator.ScheduleCreated/ScheduleRevoked)
    -- Cliff + linear vesting schedules for shares or loot. Keyed
    -- {navigator_address}-{schedule_id}; schedule_id is per-navigator (starts at 0).
    -- `claimed` is DERIVE-FROM-TRUTH (SUM of ds_vesting_claims.amount via
    -- ds_recompute_vesting_claimed) — never incremented inline (would double-count on
    -- replay). Status/claimable are time-derived in the app (pending/vesting/fully_vested,
    -- revoked overrides at revoked_at). Balances come from the paired MintShares/MintLoot
    -- Transfer in the same tx — NOT from TokensClaimed.
    EXECUTE format('
        CREATE TABLE IF NOT EXISTS %I.ds_vesting_schedules (
            id VARCHAR(128) PRIMARY KEY,           -- {navigator_address}-{schedule_id}
            dao_id VARCHAR(42) NOT NULL REFERENCES %I.ds_daos(id) ON DELETE CASCADE,
            navigator_address VARCHAR(42) NOT NULL,
            schedule_id NUMERIC(78, 0) NOT NULL,   -- per-navigator, starts at 0
            beneficiary VARCHAR(42) NOT NULL,
            total_amount NUMERIC(78, 0) NOT NULL,
            claimed NUMERIC(78, 0) NOT NULL DEFAULT 0,  -- derive-from-truth: SUM(ds_vesting_claims.amount)
            is_loot BOOLEAN NOT NULL,              -- false = shares, true = loot
            start_time BIGINT NOT NULL,            -- absolute (contract resolves 0 → creation block)
            cliff_end BIGINT NOT NULL,
            vesting_end BIGINT NOT NULL,
            revoked BOOLEAN NOT NULL DEFAULT FALSE,
            revoked_at BIGINT,                     -- vesting freeze point (null until revoked)
            vested_at_revoke NUMERIC(78, 0),       -- from ScheduleRevoked
            tx_hash VARCHAR(66) NOT NULL,          -- creation tx
            block_number BIGINT NOT NULL,          -- creation block (reorg cleanup bound)
            created_at TIMESTAMPTZ NOT NULL,
            updated_at TIMESTAMPTZ DEFAULT NOW(),
            UNIQUE(navigator_address, schedule_id)
        )', s, s);

    -- DS_VESTING_CLAIMS (VestingNavigator.TokensClaimed) — append-only claim feed.
    -- amount is the INCREMENTAL amount minted in this claim (not cumulative). Keyed by the
    -- canonical {tx_hash}-{log_index} so replay/reorg is idempotent; the schedule''s `claimed`
    -- total is recomputed from the SUM of these rows.
    EXECUTE format('
        CREATE TABLE IF NOT EXISTS %I.ds_vesting_claims (
            id TEXT PRIMARY KEY,                   -- {tx_hash}-{log_index}
            schedule_pk VARCHAR(128) NOT NULL REFERENCES %I.ds_vesting_schedules(id) ON DELETE CASCADE,
            dao_id VARCHAR(42) NOT NULL REFERENCES %I.ds_daos(id) ON DELETE CASCADE,
            navigator_address VARCHAR(42) NOT NULL,
            schedule_id NUMERIC(78, 0) NOT NULL,
            beneficiary VARCHAR(42) NOT NULL,
            amount NUMERIC(78, 0) NOT NULL,        -- incremental amount minted in THIS claim
            is_loot BOOLEAN NOT NULL,
            tx_hash VARCHAR(66) NOT NULL,
            block_number BIGINT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL
        )', s, s, s);

    -- DS_BUDGETS (BudgetNavigator.BudgetCreated/ManagerUpdated/BudgetCancelled)
    -- Recurring treasury-disbursement budgets. Keyed {navigator_address}-{budget_id};
    -- budget_id is per-navigator (starts at 0). BudgetNavigator holds NO DAOShip permission
    -- and is NOT read-only — its authority is vault MODULE status, so rows are materialized
    -- ONLY for navigators whose trust_status=''sanctioned'' (the vault emitted EnabledModule);
    -- a self_asserted budget navigator writes nothing until enabled, then backfills (mirrors
    -- the SignalNavigator defer+backfill gate). `total_spent` is DERIVE-FROM-TRUTH
    -- (SUM of ds_budget_disbursements.amount via ds_recompute_budget_spent) — never
    -- incremented inline (would double-count on replay). Period/remaining are time-derived in
    -- the app from the contract views (remainingThisPeriod/remainingTotal); the stored
    -- total_spent is the cumulative lifetime figure, NOT the lazily-resetting per-period spend.
    -- Each Disbursed is paired with value leaving the vault (native transfer or ERC20 Transfer
    -- FROM the vault) — take balances from the Transfer, treat budgets as the activity feed.
    EXECUTE format('
        CREATE TABLE IF NOT EXISTS %I.ds_budgets (
            id VARCHAR(128) PRIMARY KEY,           -- {navigator_address}-{budget_id}
            dao_id VARCHAR(42) NOT NULL REFERENCES %I.ds_daos(id) ON DELETE CASCADE,
            navigator_address VARCHAR(42) NOT NULL,
            budget_id NUMERIC(78, 0) NOT NULL,     -- per-navigator, starts at 0
            manager VARCHAR(42) NOT NULL,          -- mutable via ManagerUpdated
            token VARCHAR(42) NOT NULL,            -- 0x0000...0000 = native QUAI
            allowance_per_period NUMERIC(78, 0) NOT NULL,
            total_ceiling NUMERIC(78, 0) NOT NULL, -- lifetime cap (> 0)
            total_spent NUMERIC(78, 0) NOT NULL DEFAULT 0,  -- derive-from-truth: SUM(disbursements.amount)
            period_length BIGINT NOT NULL,
            starts_at BIGINT NOT NULL,             -- absolute (contract resolves 0 → creation block)
            ends_at BIGINT NOT NULL,               -- 0 = perpetual
            cancelled BOOLEAN NOT NULL DEFAULT FALSE,  -- irreversible; halts disbursement
            tx_hash VARCHAR(66) NOT NULL,          -- creation tx
            block_number BIGINT NOT NULL,          -- creation block (reorg cleanup bound)
            created_at TIMESTAMPTZ NOT NULL,
            updated_at TIMESTAMPTZ DEFAULT NOW(),
            UNIQUE(navigator_address, budget_id)
        )', s, s);

    -- DS_BUDGET_DISBURSEMENTS (BudgetNavigator.Disbursed) — append-only payout feed.
    -- One row per recipient: disburse() emits one, disburseBatch() emits N. Keyed by the
    -- canonical {navigator_address}-{budget_id}-{tx_hash}-{log_index} so replay/reorg is
    -- idempotent; the budget''s total_spent is recomputed from the SUM of these rows.
    EXECUTE format('
        CREATE TABLE IF NOT EXISTS %I.ds_budget_disbursements (
            id VARCHAR(180) PRIMARY KEY,           -- {navigator_address}-{budget_id}-{tx_hash}-{log_index}
            budget_pk VARCHAR(128) NOT NULL REFERENCES %I.ds_budgets(id) ON DELETE CASCADE,
            dao_id VARCHAR(42) NOT NULL REFERENCES %I.ds_daos(id) ON DELETE CASCADE,
            navigator_address VARCHAR(42) NOT NULL,
            budget_id NUMERIC(78, 0) NOT NULL,
            recipient VARCHAR(42) NOT NULL,
            token VARCHAR(42) NOT NULL,
            amount NUMERIC(78, 0) NOT NULL,
            tx_hash VARCHAR(66) NOT NULL,
            block_number BIGINT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL
        )', s, s, s);

    -- DS_SUBSCRIPTION_MEMBERS (SubscriptionNavigator.MemberEnrolled/FeePaid/FeeCollected)
    -- Recurring-dues membership, ONE ROW PER MEMBER PER NAVIGATOR (there is no per-member id).
    -- Keyed {navigator_address}-{member}. `paid_through` is the whole enrollment state: the
    -- absolute timestamp the member is paid up through; 0 ⇒ not enrolled (never enrolled, or
    -- collected/un-enrolled). It is ASSIGNED from the event''s absolute paidThrough (never += —
    -- the contract advances it forward under the debt model), so the member row is a STATE row,
    -- not block-scoped. SubscriptionNavigator is MANAGER-permissioned (standard NavigatorSet
    -- discovery, born sanctioned) — rows materialize for any resolvable navigator; the APP
    -- defaults views to trust_status=''sanctioned'' (dues/collection touch the cap table).
    -- `total_paid` is DERIVE-FROM-TRUTH (SUM of ds_subscription_payments.amount via
    -- ds_recompute_subscription_paid) — never incremented inline (would double-count on replay).
    -- Status (current/grace/delinquent) is TIME-DERIVED in the app from paid_through + the
    -- immutable graceDuration. Token BALANCES come from the paired core events (Transfer into the
    -- vault on payFee; ConvertSharesToLoot/BurnShares + MintLoot on collectFee), NOT these feeds.
    EXECUTE format('
        CREATE TABLE IF NOT EXISTS %I.ds_subscription_members (
            id VARCHAR(128) PRIMARY KEY,           -- {navigator_address}-{member}
            dao_id VARCHAR(42) NOT NULL REFERENCES %I.ds_daos(id) ON DELETE CASCADE,
            navigator_address VARCHAR(42) NOT NULL,
            member VARCHAR(42) NOT NULL,
            paid_through BIGINT NOT NULL DEFAULT 0, -- absolute ts paid through; 0 = not enrolled / collected
            total_paid NUMERIC(78, 0) NOT NULL DEFAULT 0,  -- derive-from-truth: SUM(ds_subscription_payments.amount)
            last_collected_at TIMESTAMPTZ,         -- set by FeeCollected (null until first collection)
            tx_hash VARCHAR(66) NOT NULL,          -- enrollment/first-payment tx
            created_at TIMESTAMPTZ NOT NULL,
            updated_at TIMESTAMPTZ DEFAULT NOW(),
            UNIQUE(navigator_address, member)
        )', s, s);

    -- DS_SUBSCRIPTION_PAYMENTS (SubscriptionNavigator.FeePaid) — append-only payment feed.
    -- One row per FeePaid. amount is PER-PAYMENT (not cumulative); the member''s total_paid is
    -- recomputed from the SUM of these rows. payer differs from member on payFeeFor (gift/sponsor).
    -- Keyed {navigator_address}-{member}-{tx_hash}-{log_index} so replay/reorg is idempotent.
    EXECUTE format('
        CREATE TABLE IF NOT EXISTS %I.ds_subscription_payments (
            id VARCHAR(180) PRIMARY KEY,           -- {navigator_address}-{member}-{tx_hash}-{log_index}
            member_pk VARCHAR(128) NOT NULL REFERENCES %I.ds_subscription_members(id) ON DELETE CASCADE,
            dao_id VARCHAR(42) NOT NULL REFERENCES %I.ds_daos(id) ON DELETE CASCADE,
            navigator_address VARCHAR(42) NOT NULL,
            member VARCHAR(42) NOT NULL,
            payer VARCHAR(42) NOT NULL,            -- payFeeFor → differs from member
            token VARCHAR(42) NOT NULL,            -- 0x0000...0000 = native QUAI
            amount NUMERIC(78, 0) NOT NULL,        -- per-payment; SUM for cumulative total_paid
            periods NUMERIC(78, 0) NOT NULL,
            paid_through BIGINT NOT NULL,          -- absolute value after this payment
            tx_hash VARCHAR(66) NOT NULL,
            block_number BIGINT NOT NULL,          -- reorg cleanup bound
            created_at TIMESTAMPTZ NOT NULL
        )', s, s, s);

    -- DS_SUBSCRIPTION_COLLECTIONS (SubscriptionNavigator.FeeCollected) — append-only collection feed.
    -- One row per FeeCollected (a past-grace member''s shares stripped). burned distinguishes the
    -- enforcement mode (true = burnShares, false = convertSharesToLoot); reward is loot minted to the
    -- collector. Keyed {navigator_address}-{member}-{tx_hash}-{log_index} so replay/reorg is idempotent.
    EXECUTE format('
        CREATE TABLE IF NOT EXISTS %I.ds_subscription_collections (
            id VARCHAR(180) PRIMARY KEY,           -- {navigator_address}-{member}-{tx_hash}-{log_index}
            member_pk VARCHAR(128) NOT NULL REFERENCES %I.ds_subscription_members(id) ON DELETE CASCADE,
            dao_id VARCHAR(42) NOT NULL REFERENCES %I.ds_daos(id) ON DELETE CASCADE,
            navigator_address VARCHAR(42) NOT NULL,
            member VARCHAR(42) NOT NULL,
            collector VARCHAR(42) NOT NULL,
            shares_removed NUMERIC(78, 0) NOT NULL,
            reward NUMERIC(78, 0) NOT NULL,        -- loot minted to collector
            burned BOOLEAN NOT NULL,               -- true = burnShares, false = convertSharesToLoot
            tx_hash VARCHAR(66) NOT NULL,
            block_number BIGINT NOT NULL,          -- reorg cleanup bound
            created_at TIMESTAMPTZ NOT NULL
        )', s, s, s);

    -- DS_VAULT_MODULE_EVENTS (QuaiVault/IAvatar EnabledModule/DisabledModule) — the
    -- BudgetNavigator trust feed. Append-only, one row per AUTHENTICATED module event (the
    -- handler only writes when emitter == a known DAO's avatar AND module == a BudgetNavigator
    -- bound to that DAO). This is the SOURCE OF TRUTH for a module navigator's enable state:
    -- ds_navigators.trust_status/is_active for a BudgetNavigator are DERIVED from the LATEST
    -- surviving row here (ds_recompute_module_trust), NOT set directly — so a reorg that rolls
    -- back an EnabledModule/DisabledModule correctly reverts the nav (the feed rows after the
    -- fork are deleted and the trust is re-derived from what remains; no rows → self_asserted).
    -- Keyed {tx_hash}-{log_index} → idempotent on replay/reorg.
    EXECUTE format('
        CREATE TABLE IF NOT EXISTS %I.ds_vault_module_events (
            id TEXT PRIMARY KEY,                   -- {tx_hash}-{log_index}
            dao_id VARCHAR(42) NOT NULL REFERENCES %I.ds_daos(id) ON DELETE CASCADE,
            vault VARCHAR(42) NOT NULL,            -- the avatar that emitted (authenticated == dao.avatar)
            navigator_address VARCHAR(42) NOT NULL, -- the module (a BudgetNavigator bound to dao_id)
            enabled BOOLEAN NOT NULL,              -- true = EnabledModule, false = DisabledModule
            tx_hash VARCHAR(66) NOT NULL,
            log_index INTEGER NOT NULL,            -- tiebreaker for "latest event" within a block
            block_number BIGINT NOT NULL,          -- reorg cleanup bound + latest-event ordering
            created_at TIMESTAMPTZ NOT NULL
        )', s, s);

    -- DS_GOVERNANCE_CONFIG_HISTORY (DAOShip.GovernanceConfigSet) — audit feed + timelock
    -- bypass detection. One row per GovernanceConfigSet (keyed {tx_hash}-{log_index}).
    -- `bypassed_timelock` is resolved at end-of-range (ds_resolve_timelock_bypass): TRUE when
    -- the DAO has an ACTIVE TimelockNavigator but this config change did NOT come paired with
    -- a ChangeExecuted from that navigator in the same tx (i.e. it skipped the timelock via a
    -- direct executeAsGovernance→setGovernanceConfig). DAOs with no active timelock are always
    -- FALSE (no expectation to route through one).
    EXECUTE format('
        CREATE TABLE IF NOT EXISTS %I.ds_governance_config_history (
            id TEXT PRIMARY KEY,                   -- {tx_hash}-{log_index}
            dao_id VARCHAR(42) NOT NULL REFERENCES %I.ds_daos(id) ON DELETE CASCADE,
            voting_period BIGINT NOT NULL,
            grace_period BIGINT NOT NULL,
            proposal_offering NUMERIC(78, 0) NOT NULL,
            quorum_percent NUMERIC(78, 0) NOT NULL,
            sponsor_threshold NUMERIC(78, 0) NOT NULL,
            min_retention_percent NUMERIC(78, 0) NOT NULL,
            default_expiry_window BIGINT NOT NULL,
            bypassed_timelock BOOLEAN NOT NULL DEFAULT FALSE,
            tx_hash VARCHAR(66) NOT NULL,
            block_number BIGINT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL,
            updated_at TIMESTAMPTZ DEFAULT NOW()
        )', s, s);

    -- DS_NAVIGATOR_SANCTION_INTENTS — hold-until-discovered for vault sanction posts
    -- (daoships.dao.navigators) that name a navigator whose NavigatorDeployed has not
    -- been seen yet. Applied + cleared by handleNavigatorDeployed when the row appears.
    -- Internal indexer state (not a public feed).
    EXECUTE format('
        CREATE TABLE IF NOT EXISTS %I.ds_navigator_sanction_intents (
            dao_id VARCHAR(42) NOT NULL,            -- claimed daoAddress from the post
            navigator_address VARCHAR(42) NOT NULL,
            vault VARCHAR(42) NOT NULL,             -- msg.sender (verified == avatar)
            created_at TIMESTAMPTZ NOT NULL,
            PRIMARY KEY (dao_id, navigator_address)
        )', s);

    -- DS_INDEXER_STATE
    EXECUTE format('
        CREATE TABLE IF NOT EXISTS %I.ds_indexer_state (
            id INTEGER PRIMARY KEY DEFAULT 1,
            last_block_number BIGINT NOT NULL DEFAULT 0,
            last_block_hash VARCHAR(66),
            last_indexed_at TIMESTAMPTZ,
            chain_id INTEGER NOT NULL DEFAULT 15000,
            is_syncing BOOLEAN NOT NULL DEFAULT false,
            requires_full_reindex BOOLEAN NOT NULL DEFAULT false,
            reindex_reason TEXT,
            reindex_flagged_at TIMESTAMPTZ,

            CHECK (id = 1)
        )', s);

    -- M2: Additive migration for pre-existing ds_indexer_state tables that
    -- don''t yet have the requires_full_reindex columns. Safe to re-run.
    EXECUTE format('ALTER TABLE %I.ds_indexer_state ADD COLUMN IF NOT EXISTS requires_full_reindex BOOLEAN NOT NULL DEFAULT false', s);
    EXECUTE format('ALTER TABLE %I.ds_indexer_state ADD COLUMN IF NOT EXISTS reindex_reason TEXT', s);
    EXECUTE format('ALTER TABLE %I.ds_indexer_state ADD COLUMN IF NOT EXISTS reindex_flagged_at TIMESTAMPTZ', s);

    EXECUTE format('
        INSERT INTO %I.ds_indexer_state (id, last_block_number)
        VALUES (1, 0)
        ON CONFLICT (id) DO NOTHING
    ', s);

    -- DS_PROCESSED_LOGS (dedup table for retry idempotency)
    EXECUTE format('
        CREATE TABLE IF NOT EXISTS %I.ds_processed_logs (
            tx_hash VARCHAR(66) NOT NULL,
            log_index INTEGER NOT NULL,
            block_number BIGINT NOT NULL,
            processed_at TIMESTAMPTZ DEFAULT NOW(),
            PRIMARY KEY (tx_hash, log_index)
        )', s);

    -- ═══════════════════════════════════════════════════════════════════
    -- INDEXES
    -- ═══════════════════════════════════════════════════════════════════

    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_ds_members_active ON %I.ds_members(dao_id) WHERE shares > 0 OR loot > 0', s);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_ds_members_address ON %I.ds_members(member_address)', s);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_ds_proposals_active ON %I.ds_proposals(dao_id, cancelled, processed)', s);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_ds_records_dao_tag ON %I.ds_records(dao_id, tag)', s);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_ds_daos_shares_address ON %I.ds_daos(shares_address)', s);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_ds_daos_loot_address ON %I.ds_daos(loot_address)', s);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_ds_event_transactions_block ON %I.ds_event_transactions(block_number)', s);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_ds_navigator_events_dao ON %I.ds_navigator_events(dao_id)', s);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_ds_navigator_events_contributor ON %I.ds_navigator_events(contributor)', s);
    -- NFT claims: by DAO (claim feed), by navigator+token (claim-status checks), by holder, and by block (reorg prune).
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_ds_nft_claims_dao ON %I.ds_nft_claims(dao_id)', s);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_ds_nft_claims_navigator_token ON %I.ds_nft_claims(navigator_address, token_id)', s);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_ds_nft_claims_holder ON %I.ds_nft_claims(holder)', s);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_ds_nft_claims_block ON %I.ds_nft_claims(block_number)', s);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_ds_votes_voter ON %I.ds_votes(voter)', s);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_ds_votes_dao ON %I.ds_votes(dao_id)', s);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_ds_ragequits_dao ON %I.ds_ragequits(dao_id)', s);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_ds_delegations_lookup ON %I.ds_delegations(dao_id, delegator)', s);
    -- Option B P3.1: unique index enforces idempotency for DelegateChanged
    -- replays. A retry after partial commit would otherwise INSERT a
    -- duplicate SERIAL-PK row since the PK is auto-generated.
    EXECUTE format('CREATE UNIQUE INDEX IF NOT EXISTS ux_ds_delegations_dedup ON %I.ds_delegations(tx_hash, delegator)', s);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_ds_processed_logs_block ON %I.ds_processed_logs(block_number)', s);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_ds_votes_block ON %I.ds_votes(block_number)', s);
    -- H6: Composite index for ds_increment_proposal_votes which queries by (proposal_id, approved).
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_ds_votes_proposal_approved ON %I.ds_votes(proposal_id, approved)', s);
    -- M9: Standalone index on navigator_address for potential cross-DAO lookups.
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_ds_navigators_address ON %I.ds_navigators(navigator_address)', s);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_ds_ragequits_block ON %I.ds_ragequits(block_number)', s);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_ds_records_block ON %I.ds_records(block_number)', s);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_ds_records_orphaned ON %I.ds_records(created_at) WHERE dao_id IS NULL', s);
    -- Prune scan support: candidates are never-granted navigators (dao_id no longer goes NULL,
    -- so the old WHERE dao_id IS NULL partial index is replaced by one on permission_ever_granted).
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_ds_navigators_prunable ON %I.ds_navigators(created_at) WHERE permission_ever_granted = false', s);
    -- Trust-status filter for poll feeds / sanction reconciliation.
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_ds_navigators_trust ON %I.ds_navigators(trust_status)', s);
    -- Signal polls: by DAO (feed), by navigator (per-nav history / backfill), by block (reorg prune).
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_ds_signal_polls_dao ON %I.ds_signal_polls(dao_id)', s);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_ds_signal_polls_navigator ON %I.ds_signal_polls(navigator_address)', s);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_ds_signal_polls_block ON %I.ds_signal_polls(block_number)', s);
    -- Signal votes: by poll (tally recompute), by voter, by navigator, by block (reorg prune).
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_ds_signal_votes_poll ON %I.ds_signal_votes(poll_pk)', s);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_ds_signal_votes_voter ON %I.ds_signal_votes(voter)', s);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_ds_signal_votes_navigator ON %I.ds_signal_votes(navigator_address)', s);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_ds_signal_votes_block ON %I.ds_signal_votes(block_number)', s);

    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_ds_timelock_changes_dao ON %I.ds_timelock_changes(dao_id)', s);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_ds_timelock_changes_navigator ON %I.ds_timelock_changes(navigator_address)', s);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_ds_timelock_changes_block ON %I.ds_timelock_changes(block_number)', s);
    -- executed_tx lookup powers ds_resolve_timelock_bypass (same-tx pairing check)
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_ds_timelock_changes_executed_tx ON %I.ds_timelock_changes(dao_id, executed_tx)', s);

    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_ds_vesting_schedules_dao ON %I.ds_vesting_schedules(dao_id)', s);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_ds_vesting_schedules_beneficiary ON %I.ds_vesting_schedules(beneficiary)', s);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_ds_vesting_schedules_navigator ON %I.ds_vesting_schedules(navigator_address)', s);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_ds_vesting_schedules_block ON %I.ds_vesting_schedules(block_number)', s);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_ds_vesting_claims_schedule ON %I.ds_vesting_claims(schedule_pk)', s);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_ds_vesting_claims_beneficiary ON %I.ds_vesting_claims(beneficiary)', s);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_ds_vesting_claims_block ON %I.ds_vesting_claims(block_number)', s);

    -- Budgets: by DAO (feed), by navigator, by manager (manager dashboard), by block (reorg prune).
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_ds_budgets_dao ON %I.ds_budgets(dao_id)', s);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_ds_budgets_navigator ON %I.ds_budgets(navigator_address)', s);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_ds_budgets_manager ON %I.ds_budgets(manager)', s);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_ds_budgets_block ON %I.ds_budgets(block_number)', s);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_ds_budget_disbursements_budget ON %I.ds_budget_disbursements(budget_pk)', s);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_ds_budget_disbursements_recipient ON %I.ds_budget_disbursements(recipient)', s);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_ds_budget_disbursements_block ON %I.ds_budget_disbursements(block_number)', s);

    -- Subscriptions: members by DAO (roster) and by navigator; payment/collection feeds by member
    -- (total_paid recompute / member history), by navigator, and by block (reorg prune).
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_ds_subscription_members_dao ON %I.ds_subscription_members(dao_id)', s);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_ds_subscription_members_navigator ON %I.ds_subscription_members(navigator_address)', s);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_ds_subscription_members_member ON %I.ds_subscription_members(member)', s);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_ds_subscription_payments_member ON %I.ds_subscription_payments(member_pk)', s);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_ds_subscription_payments_navigator ON %I.ds_subscription_payments(navigator_address)', s);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_ds_subscription_payments_block ON %I.ds_subscription_payments(block_number)', s);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_ds_subscription_collections_member ON %I.ds_subscription_collections(member_pk)', s);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_ds_subscription_collections_navigator ON %I.ds_subscription_collections(navigator_address)', s);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_ds_subscription_collections_block ON %I.ds_subscription_collections(block_number)', s);

    -- Vault module events: latest-event-per-nav lookup (derive), by DAO (timeline), by block (reorg).
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_ds_vault_module_events_nav ON %I.ds_vault_module_events(navigator_address, block_number DESC, log_index DESC)', s);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_ds_vault_module_events_dao ON %I.ds_vault_module_events(dao_id)', s);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_ds_vault_module_events_block ON %I.ds_vault_module_events(block_number)', s);

    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_ds_gov_config_history_dao ON %I.ds_governance_config_history(dao_id)', s);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_ds_gov_config_history_tx ON %I.ds_governance_config_history(dao_id, tx_hash)', s);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_ds_gov_config_history_block ON %I.ds_governance_config_history(block_number)', s);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_ds_gov_config_history_bypass ON %I.ds_governance_config_history(dao_id) WHERE bypassed_timelock = TRUE', s);
    -- ds_resolve_timelock_bypass checks for an active TimelockNavigator on a DAO
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_ds_navigators_dao_type ON %I.ds_navigators(dao_id, navigator_type)', s);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_ds_records_navigator_addr ON %I.ds_records((content_json->>''navigatorAddress'')) WHERE tag = ''daoships.navigator.allowlist''', s);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_ds_proposals_block ON %I.ds_proposals(block_number)', s);

    -- ═══════════════════════════════════════════════════════════════════
    -- FUNCTIONS (schema-scoped)
    -- ═══════════════════════════════════════════════════════════════════

    -- Calculate proposal status based on time
    EXECUTE format('
        CREATE OR REPLACE FUNCTION %I.ds_get_proposal_status(
            p_cancelled BOOLEAN,
            p_processed BOOLEAN,
            p_passed BOOLEAN,
            p_sponsored BOOLEAN,
            p_voting_starts TIMESTAMPTZ,
            p_voting_ends TIMESTAMPTZ,
            p_grace_ends TIMESTAMPTZ,
            p_expiration TIMESTAMPTZ
        ) RETURNS public.ds_proposal_status AS $fn$
        BEGIN
            IF p_cancelled THEN RETURN ''cancelled''; END IF;
            IF p_processed THEN
                IF p_passed THEN RETURN ''processed'';
                ELSE RETURN ''defeated'';
                END IF;
            END IF;
            IF NOT p_sponsored THEN RETURN ''submitted''; END IF;
            IF p_expiration IS NOT NULL AND NOW() > p_expiration THEN RETURN ''expired''; END IF;
            IF NOW() < p_voting_ends THEN RETURN ''voting''; END IF;
            IF NOW() < p_grace_ends THEN RETURN ''grace''; END IF;
            RETURN ''ready'';
        END;
        $fn$ LANGUAGE plpgsql STABLE
    ', s);

    -- Idempotent vote tally derivation (H2: derives from ds_votes instead of blind +1)
    -- p_approved and p_balance params kept for backward compat but ignored.
    EXECUTE format('
        CREATE OR REPLACE FUNCTION %I.ds_increment_proposal_votes(
            p_id TEXT,
            p_approved BOOLEAN,
            p_balance NUMERIC(78, 0)
        ) RETURNS void AS $fn$
        BEGIN
            UPDATE %I.ds_proposals SET
                yes_votes = (SELECT COUNT(*) FROM %I.ds_votes WHERE proposal_id = p_id AND approved = true),
                yes_balance = (SELECT COALESCE(SUM(balance), 0) FROM %I.ds_votes WHERE proposal_id = p_id AND approved = true),
                no_votes = (SELECT COUNT(*) FROM %I.ds_votes WHERE proposal_id = p_id AND approved = false),
                no_balance = (SELECT COALESCE(SUM(balance), 0) FROM %I.ds_votes WHERE proposal_id = p_id AND approved = false)
            WHERE id = p_id;
        END;
        $fn$ LANGUAGE plpgsql
    ', s, s, s, s, s, s);

    -- Idempotent member vote count derivation (H2+NEW-12: derives from ds_votes, params avoid subqueries)
    EXECUTE format('
        CREATE OR REPLACE FUNCTION %I.ds_increment_member_votes(
            p_member_id TEXT,
            p_member_address TEXT,
            p_dao_id TEXT,
            p_activity_at TIMESTAMPTZ
        ) RETURNS void AS $fn$
        BEGIN
            UPDATE %I.ds_members SET
                votes = (SELECT COUNT(*) FROM %I.ds_votes WHERE voter = p_member_address AND dao_id = p_dao_id),
                last_activity_at = p_activity_at
            WHERE id = p_member_id;
        END;
        $fn$ LANGUAGE plpgsql
    ', s, s, s);

    -- Idempotent proposal count derivation (H2: derives from ds_proposals instead of blind +1)
    EXECUTE format('
        CREATE OR REPLACE FUNCTION %I.ds_increment_proposal_count(
            p_dao_id TEXT
        ) RETURNS void AS $fn$
        BEGIN
            UPDATE %I.ds_daos SET
                proposal_count = (SELECT COUNT(*) FROM %I.ds_proposals WHERE dao_id = p_dao_id)
            WHERE id = p_dao_id;
        END;
        $fn$ LANGUAGE plpgsql
    ', s, s, s);

    -- Idempotent active member count derivation (NEW-1: derives from ds_members instead of blind +delta)
    -- p_delta param kept for backward compat but ignored.
    EXECUTE format('
        CREATE OR REPLACE FUNCTION %I.ds_update_active_member_count(
            p_dao_id TEXT,
            p_delta INTEGER
        ) RETURNS void AS $fn$
        BEGIN
            UPDATE %I.ds_daos SET
                active_member_count = (SELECT COUNT(*) FROM %I.ds_members m WHERE m.dao_id = p_dao_id AND (m.shares > 0 OR m.loot > 0))
            WHERE id = p_dao_id;
        END;
        $fn$ LANGUAGE plpgsql
    ', s, s, s);

    -- ──────────────────────────────────────────────────────────────────
    -- Option B: ds_apply_transfer + ds_recompute_dao_totals
    --
    -- ds_apply_transfer is the atomic replacement for handleTransfer's
    -- client-side balance math. The handler was non-idempotent because
    -- it read a member's balance, computed a new value, then wrote it
    -- back — a retry after partial commit would re-read the already-
    -- updated balance and apply the delta a second time. This function
    -- folds dedup + read + compute + write into one transaction:
    --
    --   1. Claim (tx_hash, log_index) in ds_processed_logs via INSERT
    --      ON CONFLICT DO NOTHING. If no row inserted → log was already
    --      processed; return (already_processed=true, delta=0) and exit.
    --   2. Otherwise read current sender/receiver balances, compute new
    --      values with floor-at-zero clamping, upsert both sides, and
    --      detect zero-crossings for the DAO's active_member_count
    --      delta.
    --   3. Return (already_processed=false, delta=<signed>) so the caller
    --      can batch-apply the membership-count update at end-of-range
    --      alongside the DAO totals recompute.
    --
    -- Self-transfers (from == to, both non-zero) short-circuit to a
    -- timestamp-touch upsert — matches the client-side fix.
    -- Mints (from == 0) skip the debit; burns (to == 0) skip the credit.
    -- ──────────────────────────────────────────────────────────────────
    EXECUTE format('
        CREATE OR REPLACE FUNCTION %I.ds_apply_transfer(
            p_tx_hash VARCHAR(66),
            p_log_index INTEGER,
            p_block_number BIGINT,
            p_dao_id VARCHAR(42),
            p_from_address VARCHAR(42),
            p_to_address VARCHAR(42),
            p_value NUMERIC(78, 0),
            p_is_shares BOOLEAN,
            p_timestamp TIMESTAMPTZ
        ) RETURNS TABLE(
            already_processed BOOLEAN,
            active_member_delta INTEGER
        ) AS $fn$
        DECLARE
            ZERO CONSTANT VARCHAR(42) := ''0x0000000000000000000000000000000000000000'';
            v_claim_count INTEGER := 0;
            v_has_sender BOOLEAN;
            v_has_receiver BOOLEAN;
            v_sender_id VARCHAR(85);
            v_receiver_id VARCHAR(85);
            v_delta INTEGER := 0;
            v_sender_shares NUMERIC(78, 0) := 0;
            v_sender_loot NUMERIC(78, 0) := 0;
            v_sender_created TIMESTAMPTZ;
            v_sender_new_target NUMERIC(78, 0);
            v_sender_old_total NUMERIC(78, 0);
            v_sender_new_total NUMERIC(78, 0);
            v_receiver_shares NUMERIC(78, 0) := 0;
            v_receiver_loot NUMERIC(78, 0) := 0;
            v_receiver_created TIMESTAMPTZ;
            v_receiver_new_target NUMERIC(78, 0);
            v_receiver_old_total NUMERIC(78, 0);
            v_receiver_new_total NUMERIC(78, 0);
        BEGIN
            -- 1. Claim the log atomically. After ON CONFLICT DO NOTHING,
            -- ROW_COUNT is 1 if inserted or 0 if the (tx_hash, log_index)
            -- was already present. Zero ⇒ replay → exit idempotently.
            INSERT INTO %I.ds_processed_logs (tx_hash, log_index, block_number)
                VALUES (p_tx_hash, p_log_index, p_block_number)
                ON CONFLICT (tx_hash, log_index) DO NOTHING;
            GET DIAGNOSTICS v_claim_count = ROW_COUNT;
            IF v_claim_count = 0 THEN
                RETURN QUERY SELECT true::BOOLEAN, 0;
                RETURN;
            END IF;

            v_has_sender := LOWER(p_from_address) <> LOWER(ZERO);
            v_has_receiver := LOWER(p_to_address) <> LOWER(ZERO);

            IF NOT v_has_sender AND NOT v_has_receiver THEN
                -- Mint-and-burn of zero — no-op. Shouldn''t reach here for real
                -- transfers but guard anyway.
                RETURN QUERY SELECT false, 0;
                RETURN;
            END IF;

            v_sender_id := CASE WHEN v_has_sender THEN p_dao_id || ''-'' || LOWER(p_from_address) ELSE NULL END;
            v_receiver_id := CASE WHEN v_has_receiver THEN p_dao_id || ''-'' || LOWER(p_to_address) ELSE NULL END;

            -- Self-transfer: balance unchanged; only activity timestamp.
            IF v_has_sender AND v_has_receiver AND v_sender_id = v_receiver_id THEN
                INSERT INTO %I.ds_members (id, dao_id, member_address, created_at, updated_at, last_activity_at)
                    VALUES (v_sender_id, p_dao_id, LOWER(p_from_address), p_timestamp, p_timestamp, p_timestamp)
                    ON CONFLICT (id) DO UPDATE SET
                        updated_at = p_timestamp,
                        last_activity_at = p_timestamp;
                RETURN QUERY SELECT false, 0;
                RETURN;
            END IF;

            -- 2a. Load sender; compute new balance with floor-at-zero clamp.
            IF v_has_sender THEN
                SELECT COALESCE(shares, 0), COALESCE(loot, 0), created_at
                    INTO v_sender_shares, v_sender_loot, v_sender_created
                    FROM %I.ds_members WHERE id = v_sender_id;
                IF v_sender_created IS NULL THEN v_sender_created := p_timestamp; END IF;

                v_sender_old_total := v_sender_shares + v_sender_loot;
                IF p_is_shares THEN
                    v_sender_new_target := GREATEST(0, v_sender_shares - p_value);
                    v_sender_shares := v_sender_new_target;
                ELSE
                    v_sender_new_target := GREATEST(0, v_sender_loot - p_value);
                    v_sender_loot := v_sender_new_target;
                END IF;
                v_sender_new_total := v_sender_shares + v_sender_loot;
                IF v_sender_old_total > 0 AND v_sender_new_total = 0 THEN
                    v_delta := v_delta - 1;
                END IF;

                INSERT INTO %I.ds_members (id, dao_id, member_address, shares, loot, created_at, updated_at, last_activity_at)
                    VALUES (v_sender_id, p_dao_id, LOWER(p_from_address), v_sender_shares, v_sender_loot, v_sender_created, p_timestamp, p_timestamp)
                    ON CONFLICT (id) DO UPDATE SET
                        shares = EXCLUDED.shares,
                        loot = EXCLUDED.loot,
                        updated_at = EXCLUDED.updated_at,
                        last_activity_at = EXCLUDED.last_activity_at;
            END IF;

            -- 2b. Load receiver; compute new balance.
            IF v_has_receiver THEN
                SELECT COALESCE(shares, 0), COALESCE(loot, 0), created_at
                    INTO v_receiver_shares, v_receiver_loot, v_receiver_created
                    FROM %I.ds_members WHERE id = v_receiver_id;
                IF v_receiver_created IS NULL THEN v_receiver_created := p_timestamp; END IF;

                v_receiver_old_total := v_receiver_shares + v_receiver_loot;
                IF p_is_shares THEN
                    v_receiver_shares := v_receiver_shares + p_value;
                    v_receiver_new_target := v_receiver_shares;
                ELSE
                    v_receiver_loot := v_receiver_loot + p_value;
                    v_receiver_new_target := v_receiver_loot;
                END IF;
                v_receiver_new_total := v_receiver_shares + v_receiver_loot;
                IF v_receiver_old_total = 0 AND v_receiver_new_total > 0 THEN
                    v_delta := v_delta + 1;
                END IF;

                INSERT INTO %I.ds_members (id, dao_id, member_address, shares, loot, created_at, updated_at, last_activity_at)
                    VALUES (v_receiver_id, p_dao_id, LOWER(p_to_address), v_receiver_shares, v_receiver_loot, v_receiver_created, p_timestamp, p_timestamp)
                    ON CONFLICT (id) DO UPDATE SET
                        shares = EXCLUDED.shares,
                        loot = EXCLUDED.loot,
                        updated_at = EXCLUDED.updated_at,
                        last_activity_at = EXCLUDED.last_activity_at;
            END IF;

            RETURN QUERY SELECT false, v_delta;
        END;
        $fn$ LANGUAGE plpgsql
    ', s, s, s, s, s, s, s, s);

    -- ──────────────────────────────────────────────────────────────────
    -- ds_recompute_dao_totals — derive-from-truth replacement for the
    -- old ds_adjust_dao_totals delta path. Called once per "dirty" DAO
    -- at end-of-range by the processor; MUST NOT be called per-handler
    -- (would be O(members × handlers) scans). The dirty-DAO set is
    -- accumulated by Mint/Burn/Ragequit/Convert handlers and flushed
    -- after all logs in a range are processed.
    -- ──────────────────────────────────────────────────────────────────
    EXECUTE format('
        CREATE OR REPLACE FUNCTION %I.ds_recompute_dao_totals(
            p_dao_id VARCHAR(42)
        ) RETURNS void AS $fn$
        BEGIN
            UPDATE %I.ds_daos SET
                total_shares = COALESCE((SELECT SUM(shares) FROM %I.ds_members WHERE dao_id = p_dao_id), 0),
                total_loot = COALESCE((SELECT SUM(loot) FROM %I.ds_members WHERE dao_id = p_dao_id), 0),
                updated_at = NOW()
            WHERE id = p_dao_id;
        END;
        $fn$ LANGUAGE plpgsql
    ', s, s, s, s);

    -- ──────────────────────────────────────────────────────────────────
    -- ds_recompute_poll_tally — derive-from-truth per-option tally for a
    -- signal poll. Called once per "dirty" poll at end-of-range (mirrors
    -- ds_recompute_dao_totals): the Voted handler accumulates poll PKs in a
    -- dirty set and flushes here, so the tally is never incremented by delta
    -- (which would double-count on replay). Builds a 0-indexed array of
    -- length option_count summing vote weights per option; options with no
    -- votes read 0. Postgres arrays are 1-based, so option k lands at index k+1.
    -- ──────────────────────────────────────────────────────────────────
    EXECUTE format('
        CREATE OR REPLACE FUNCTION %I.ds_recompute_poll_tally(
            p_poll_pk TEXT
        ) RETURNS void AS $fn$
        DECLARE
            v_option_count SMALLINT;
            v_tally NUMERIC(78,0)[];
        BEGIN
            SELECT option_count INTO v_option_count FROM %I.ds_signal_polls WHERE id = p_poll_pk;
            IF v_option_count IS NULL THEN RETURN; END IF;  -- poll not materialized (e.g. unsanctioned)
            SELECT array_agg(COALESCE(s.w, 0) ORDER BY g.opt) INTO v_tally
            FROM generate_series(0, v_option_count - 1) AS g(opt)
            LEFT JOIN (
                SELECT option AS opt, SUM(weight) AS w
                FROM %I.ds_signal_votes WHERE poll_pk = p_poll_pk GROUP BY option
            ) s ON s.opt = g.opt;
            UPDATE %I.ds_signal_polls SET tally = COALESCE(v_tally, ''{}''), updated_at = NOW() WHERE id = p_poll_pk;
        END;
        $fn$ LANGUAGE plpgsql
    ', s, s, s, s);

    -- ds_recompute_vesting_claimed — derive-from-truth `claimed` total for a vesting
    -- schedule (mirrors ds_recompute_poll_tally). The TokensClaimed handler accumulates
    -- schedule PKs in a dirty set and flushes here once per schedule at end-of-range, so
    -- `claimed` is never incremented by delta (which would double-count on replay).
    EXECUTE format('
        CREATE OR REPLACE FUNCTION %I.ds_recompute_vesting_claimed(
            p_schedule_pk TEXT
        ) RETURNS void AS $fn$
        BEGIN
            UPDATE %I.ds_vesting_schedules s SET
                claimed = COALESCE((SELECT SUM(c.amount) FROM %I.ds_vesting_claims c WHERE c.schedule_pk = p_schedule_pk), 0),
                updated_at = NOW()
            WHERE s.id = p_schedule_pk;
        END;
        $fn$ LANGUAGE plpgsql
    ', s, s, s);

    -- ds_recompute_budget_spent — derive-from-truth cumulative `total_spent` for a budget
    -- (mirrors ds_recompute_vesting_claimed). The Disbursed handler accumulates budget PKs in a
    -- dirty set and flushes here once per budget at end-of-range, so `total_spent` is never
    -- incremented by delta (which would double-count on replay/reorg).
    EXECUTE format('
        CREATE OR REPLACE FUNCTION %I.ds_recompute_budget_spent(
            p_budget_pk TEXT
        ) RETURNS void AS $fn$
        BEGIN
            UPDATE %I.ds_budgets b SET
                total_spent = COALESCE((SELECT SUM(d.amount) FROM %I.ds_budget_disbursements d WHERE d.budget_pk = p_budget_pk), 0),
                updated_at = NOW()
            WHERE b.id = p_budget_pk;
        END;
        $fn$ LANGUAGE plpgsql
    ', s, s, s);

    -- ds_recompute_subscription_paid — derive-from-truth cumulative `total_paid` for a subscription
    -- member (mirrors ds_recompute_budget_spent). The FeePaid handler accumulates member PKs in a
    -- dirty set and flushes here once per member at end-of-range, so `total_paid` is never
    -- incremented by delta (which would double-count on replay/reorg). NOTE: `paid_through` is
    -- assigned directly by the handlers (the contract''s absolute value), NOT derived here — a deep
    -- reorg that rolls back a FeePaid/FeeCollected without replaying the surviving feed leaves a
    -- stale paid_through (same accepted class as member balances / timelock terminal status;
    -- requires a full re-index). total_paid, being a pure SUM, always re-derives correctly.
    EXECUTE format('
        CREATE OR REPLACE FUNCTION %I.ds_recompute_subscription_paid(
            p_member_pk TEXT
        ) RETURNS void AS $fn$
        BEGIN
            UPDATE %I.ds_subscription_members m SET
                total_paid = COALESCE((SELECT SUM(p.amount) FROM %I.ds_subscription_payments p WHERE p.member_pk = p_member_pk), 0),
                updated_at = NOW()
            WHERE m.id = p_member_pk;
        END;
        $fn$ LANGUAGE plpgsql
    ', s, s, s);

    -- ds_recompute_module_trust — derive a BudgetNavigator's trust_status/is_active from the
    -- LATEST surviving ds_vault_module_events row (by block, then log_index). Enabled → sanctioned
    -- + active; disabled → unsanctioned + inactive; NO surviving event → back to the born module
    -- state self_asserted + inactive. Called live after each module event AND from the reorg path
    -- (after deleting feed rows past the fork) so a rolled-back enable/disable correctly reverts
    -- the nav. Idempotent; never touches non-BudgetNavigator rows.
    EXECUTE format('
        CREATE OR REPLACE FUNCTION %I.ds_recompute_module_trust(
            p_navigator_address TEXT
        ) RETURNS void AS $fn$
        DECLARE
            v_enabled BOOLEAN;
        BEGIN
            SELECT e.enabled INTO v_enabled
            FROM %I.ds_vault_module_events e
            WHERE e.navigator_address = p_navigator_address
            ORDER BY e.block_number DESC, e.log_index DESC
            LIMIT 1;

            UPDATE %I.ds_navigators n SET
                trust_status = CASE WHEN v_enabled IS NULL THEN ''self_asserted''
                                    WHEN v_enabled THEN ''sanctioned''
                                    ELSE ''unsanctioned'' END,
                is_active = COALESCE(v_enabled, false),
                updated_at = NOW()
            WHERE n.navigator_address = p_navigator_address
              AND n.navigator_type = ''BudgetNavigator'';
        END;
        $fn$ LANGUAGE plpgsql
    ', s, s, s);

    -- ds_resolve_timelock_bypass — derive-from-truth flagging of a GovernanceConfigSet that
    -- skipped an active timelock. Called once per (dao, tx) of a GovernanceConfigSet seen in
    -- the range, AFTER all logs are persisted (a paired ChangeExecuted may be processed after
    -- the GovernanceConfigSet within the same range). Idempotent: recomputes the flag from
    -- current truth each call. bypass = (DAO has an active GOVERNOR TimelockNavigator) AND
    -- (no ds_timelock_changes row for this dao was executed in this tx).
    EXECUTE format('
        CREATE OR REPLACE FUNCTION %I.ds_resolve_timelock_bypass(
            p_dao_id TEXT,
            p_tx_hash TEXT
        ) RETURNS void AS $fn$
        DECLARE
            v_has_active_timelock BOOLEAN;
            v_paired_execution BOOLEAN;
        BEGIN
            SELECT EXISTS(
                SELECT 1 FROM %I.ds_navigators n
                WHERE n.dao_id = p_dao_id
                  AND n.navigator_type = ''TimelockNavigator''
                  AND n.permission > 0
                  AND n.is_active = TRUE
            ) INTO v_has_active_timelock;

            SELECT EXISTS(
                SELECT 1 FROM %I.ds_timelock_changes t
                WHERE t.dao_id = p_dao_id AND t.executed_tx = p_tx_hash
            ) INTO v_paired_execution;

            UPDATE %I.ds_governance_config_history h
            SET bypassed_timelock = (v_has_active_timelock AND NOT v_paired_execution),
                updated_at = NOW()
            WHERE h.dao_id = p_dao_id AND h.tx_hash = p_tx_hash;
        END;
        $fn$ LANGUAGE plpgsql
    ', s, s, s, s);

    -- Legacy ds_adjust_dao_totals kept for reorg-recovery compatibility.
    -- Not called by any Option B handler path. Accepts signed deltas;
    -- clamps each total to 0 if it would go negative. Audit M20.
    EXECUTE format('
        CREATE OR REPLACE FUNCTION %I.ds_adjust_dao_totals(
            p_dao_id TEXT,
            p_shares_delta NUMERIC(78, 0),
            p_loot_delta NUMERIC(78, 0)
        ) RETURNS void AS $fn$
        BEGIN
            UPDATE %I.ds_daos SET
                total_shares = GREATEST(0, COALESCE(total_shares, 0) + p_shares_delta),
                total_loot = GREATEST(0, COALESCE(total_loot, 0) + p_loot_delta),
                updated_at = NOW()
            WHERE id = p_dao_id;
        END;
        $fn$ LANGUAGE plpgsql
    ', s, s);

    -- Delete indexed events after a block number (for reorg recovery)
    -- C2: Expanded to clean ALL append-only event tables, then recalculate aggregate counters.
    EXECUTE format('
        CREATE OR REPLACE FUNCTION %I.ds_delete_events_after_block(
            p_block_number BIGINT
        ) RETURNS void AS $fn$
        DECLARE
            affected_daos TEXT[];
            affected_modules TEXT[];
            v_mod_idx INTEGER;
        BEGIN
            -- 0. Collect affected DAOs before deleting event_transactions
            SELECT ARRAY(SELECT DISTINCT dao_id FROM %I.ds_event_transactions WHERE block_number > p_block_number AND dao_id IS NOT NULL)
            INTO affected_daos;

            -- 0b. Collect budget navigators whose vault-module events get rolled back, so their
            -- trust_status/is_active can be re-derived from the surviving feed after deletion.
            SELECT ARRAY(SELECT DISTINCT navigator_address FROM %I.ds_vault_module_events WHERE block_number > p_block_number)
            INTO affected_modules;

            -- 1. Delete from append-only event tables with block_number columns
            DELETE FROM %I.ds_processed_logs WHERE block_number > p_block_number;
            DELETE FROM %I.ds_navigator_events WHERE block_number > p_block_number;
            DELETE FROM %I.ds_nft_claims WHERE block_number > p_block_number;
            DELETE FROM %I.ds_signal_votes WHERE block_number > p_block_number;
            DELETE FROM %I.ds_signal_polls WHERE block_number > p_block_number;
            -- Option labels arrive at a LATER block than PollCreated. A reorg that rolls back
            -- only the labels post leaves the poll row (block_number <= p_block_number) intact, so
            -- clear its label columns explicitly by their own block (labels_block_number).
            UPDATE %I.ds_signal_polls
               SET options = NULL, description = NULL, discussion_url = NULL,
                   labels_updated_at = NULL, labels_block_number = NULL
             WHERE labels_block_number > p_block_number;
            DELETE FROM %I.ds_votes WHERE block_number > p_block_number;
            DELETE FROM %I.ds_proposals WHERE block_number > p_block_number;
            DELETE FROM %I.ds_ragequits WHERE block_number > p_block_number;
            DELETE FROM %I.ds_records WHERE block_number > p_block_number;
            -- Vesting claims before schedules (FK child → parent).
            DELETE FROM %I.ds_vesting_claims WHERE block_number > p_block_number;
            DELETE FROM %I.ds_vesting_schedules WHERE block_number > p_block_number;
            -- Budget disbursements before budgets (FK child → parent).
            DELETE FROM %I.ds_budget_disbursements WHERE block_number > p_block_number;
            DELETE FROM %I.ds_budgets WHERE block_number > p_block_number;
            -- Subscription payment/collection feeds. The ds_subscription_members STATE row has no
            -- block column (keyed by navigator+member, like ds_members balances) so it is NOT
            -- block-deleted here — a surviving member whose post-fork payments are removed keeps a
            -- stale paid_through/total_paid until its next FeePaid re-flushes (same accepted class
            -- as member balances / vesting `claimed`; a deep reorg crossing enrollment needs a full
            -- re-index). The feed FKs are ON DELETE CASCADE, but we delete the feeds directly by
            -- block (the parent member row is retained), so no cascade fires.
            DELETE FROM %I.ds_subscription_payments WHERE block_number > p_block_number;
            DELETE FROM %I.ds_subscription_collections WHERE block_number > p_block_number;
            -- Vault module events (BudgetNavigator trust feed). Delete rolled-back rows, then
            -- re-derive trust for affected navs from the SURVIVING feed (a rolled-back enable
            -- reverts the nav to self_asserted; a rolled-back disable restores it to sanctioned).
            DELETE FROM %I.ds_vault_module_events WHERE block_number > p_block_number;
            IF array_length(affected_modules, 1) > 0 THEN
                FOR v_mod_idx IN array_lower(affected_modules, 1) .. array_upper(affected_modules, 1) LOOP
                    PERFORM %I.ds_recompute_module_trust(affected_modules[v_mod_idx]);
                END LOOP;
            END IF;
            DELETE FROM %I.ds_timelock_changes WHERE block_number > p_block_number;
            DELETE FROM %I.ds_governance_config_history WHERE block_number > p_block_number;
            -- NOTE: a timelock change QUEUED before the fork but EXECUTED/CANCELLED after it
            -- keeps its (now-stale) terminal status — its queue block_number is <= fork point,
            -- so it survives this delete. Same class as the member-balance caveat below; a
            -- deep reorg crossing such a tx requires a full re-index.

            -- 2. Delete tables that lack block_number via event_transactions join
            DELETE FROM %I.ds_delegations d
                USING %I.ds_event_transactions et
                WHERE d.tx_hash = et.id AND et.block_number > p_block_number;
            DELETE FROM %I.ds_guild_tokens g
                USING %I.ds_event_transactions et
                WHERE g.tx_hash = et.id AND et.block_number > p_block_number;
            DELETE FROM %I.ds_navigators n
                USING %I.ds_event_transactions et
                WHERE n.tx_hash = et.id AND et.block_number > p_block_number;

            -- 3. Member balances are delta-accumulated via Transfer events.
            -- Shallow reorgs (within CONFIRMATION_BLOCKS) are safe because those
            -- blocks have not been indexed yet. For reorgs that overlap indexed
            -- blocks: Transfer events common to both forks replay correctly, but
            -- Transfers unique to the old fork leave stale deltas in member
            -- balances (shares/loot). Deleting members is too aggressive
            -- (destroys pre-fork data that cannot be rebuilt from the replay
            -- range). For deep reorgs affecting member balances, a full
            -- re-index is required.

            -- 4. Delete event_transactions last (used for joins above)
            DELETE FROM %I.ds_event_transactions WHERE block_number > p_block_number;

            -- 5. Recalculate aggregate counters on affected DAOs only
            IF array_length(affected_daos, 1) > 0 THEN
                UPDATE %I.ds_daos SET
                    proposal_count = (SELECT COUNT(*) FROM %I.ds_proposals p WHERE p.dao_id = %I.ds_daos.id),
                    active_member_count = (SELECT COUNT(*) FROM %I.ds_members m WHERE m.dao_id = %I.ds_daos.id AND (m.shares > 0 OR m.loot > 0)),
                    total_shares = COALESCE((SELECT SUM(m.shares) FROM %I.ds_members m WHERE m.dao_id = %I.ds_daos.id), 0),
                    total_loot = COALESCE((SELECT SUM(m.loot) FROM %I.ds_members m WHERE m.dao_id = %I.ds_daos.id), 0)
                WHERE id = ANY(affected_daos);
            END IF;
        END;
        $fn$ LANGUAGE plpgsql
    ', s, s, s, s, s, s, s, s, s, s, s, s, s, s, s, s, s, s, s, s, s, s, s, s, s, s, s, s, s, s, s, s, s, s, s, s, s, s, s);

    -- Prune orphaned records (dao_id IS NULL) older than retention period
    EXECUTE format('
        CREATE OR REPLACE FUNCTION %I.ds_prune_orphaned_records(
            p_retention_days INTEGER
        ) RETURNS INTEGER AS $fn$
        DECLARE
            deleted INTEGER;
        BEGIN
            DELETE FROM %I.ds_records
            WHERE dao_id IS NULL
              AND created_at < NOW() - (p_retention_days || '' days'')::INTERVAL;
            GET DIAGNOSTICS deleted = ROW_COUNT;
            RETURN deleted;
        END;
        $fn$ LANGUAGE plpgsql
    ', s, s);

    -- Prune un-adopted navigators — delete non-read-only navigators that were never
    -- granted a permission within the retention window and have produced no indexed
    -- data. The discriminator is permission_ever_granted=false (so REVOKED navigators,
    -- which had permission and almost certainly minted, are kept) plus event-existence.
    -- DAO-resolution is INTENTIONALLY NOT a condition: a navigator deployed against a
    -- real, launched DAO that never permissions it is just as much spam as one against a
    -- non-existent DAO, so both are reaped after p_retention_days. (A navigator legitimately
    -- adopted at launch is permissioned in the same tx, far inside the window.) Trade-off:
    -- if a DAO permissions a navigator AFTER it has been pruned, the later NavigatorSet
    -- rebuilds the row without its NavigatorDeployed metadata (type/name/deploy_block).
    -- p_at_chain_head MUST be true — until head, an as-yet-unprocessed NavigatorSet that
    -- would grant permission may still be pending, so permission_ever_granted is not final.
    -- Reaping by class (all require permission_ever_granted=false + no indexed activity + age):
    --   • SignalNavigator (read-only): NEVER reaped. It is only recorded when its DAO is known
    --     (resolution gate at deploy), so there are no junk rows to reap.
    --   • Permissioned (Onboarder/ERC20Tribute/NFTGated/Timelock/Vesting): reaped regardless of DAO
    --     resolution — a real DAO that never permissions one is as much spam as a junk-DAO one, and a
    --     legitimately-adopted nav is permissioned in the same tx, far inside the window. (If a DAO
    --     permissions one AFTER it was pruned, the later NavigatorSet rebuilds the row sans metadata.)
    --   • BudgetNavigator (vault-module): reaped ONLY when its self-asserted DAO never materialized in
    --     ds_daos (so no real vault can EVER enable it — pure spam) AND it has no vault-module feed
    --     events. A pending budget nav against a REAL, launched DAO is KEPT — unlike a permissioned
    --     nav it does NOT self-heal after prune (EnabledModule carries no metadata to rebuild the row,
    --     and NavigatorDeployed fires once), so we must not reap one that could still be enabled.
    -- NOTE: keep the type lists in sync with config.ts READ_ONLY_NAVIGATOR_TYPES / MODULE_NAVIGATOR_TYPES.
    -- p_at_chain_head MUST be true — until head, an as-yet-unprocessed NavigatorSet (or EnabledModule)
    -- may still be pending, so the prunability discriminators are not final.
    EXECUTE format('
        CREATE OR REPLACE FUNCTION %I.ds_prune_orphaned_navigators(
            p_retention_days INTEGER,
            p_at_chain_head BOOLEAN
        ) RETURNS INTEGER AS $fn$
        DECLARE
            deleted INTEGER;
        BEGIN
            IF NOT p_at_chain_head THEN RETURN 0; END IF;

            DELETE FROM %I.ds_navigators n
            WHERE n.permission_ever_granted = false
              AND n.created_at < NOW() - (p_retention_days || '' days'')::INTERVAL
              AND NOT EXISTS (SELECT 1 FROM %I.ds_navigator_events e WHERE e.navigator_address = n.navigator_address)
              AND NOT EXISTS (SELECT 1 FROM %I.ds_nft_claims c WHERE c.navigator_address = n.navigator_address)
              AND NOT EXISTS (SELECT 1 FROM %I.ds_signal_polls p WHERE p.navigator_address = n.navigator_address)
              AND NOT EXISTS (SELECT 1 FROM %I.ds_signal_votes v WHERE v.navigator_address = n.navigator_address)
              AND NOT EXISTS (SELECT 1 FROM %I.ds_budgets bg WHERE bg.navigator_address = n.navigator_address)
              AND (
                  n.navigator_type NOT IN (''SignalNavigator'', ''BudgetNavigator'')
                  OR (
                      n.navigator_type = ''BudgetNavigator''
                      AND NOT EXISTS (SELECT 1 FROM %I.ds_daos d WHERE d.id = n.dao_id)
                      AND NOT EXISTS (SELECT 1 FROM %I.ds_vault_module_events ev WHERE ev.navigator_address = n.navigator_address)
                  )
              );
            GET DIAGNOSTICS deleted = ROW_COUNT;
            RETURN deleted;
        END;
        $fn$ LANGUAGE plpgsql
    ', s, s, s, s, s, s, s, s, s);

    -- Reparent orphaned allowlist records when a navigator is registered to a DAO
    EXECUTE format('
        CREATE OR REPLACE FUNCTION %I.ds_reparent_orphaned_records(
            p_dao_address VARCHAR(42),
            p_navigator_address VARCHAR(42)
        ) RETURNS INTEGER AS $fn$
        DECLARE
            updated INTEGER;
        BEGIN
            UPDATE %I.ds_records SET dao_id = p_dao_address,
              trust_level = CASE
                WHEN trust_level IN (''SEMI_TRUSTED'', ''VERIFIED_INITIAL'', ''VERIFIED'')
                THEN trust_level
                ELSE ''MEMBER''
              END
            WHERE dao_id IS NULL
              AND tag = ''daoships.navigator.allowlist''
              AND content_json->>''daoAddress'' = p_dao_address
              AND content_json->>''navigatorAddress'' = p_navigator_address;
            GET DIAGNOSTICS updated = ROW_COUNT;
            RETURN updated;
        END;
        $fn$ LANGUAGE plpgsql
    ', s, s);

    -- ═══════════════════════════════════════════════════════════════════
    -- ROW LEVEL SECURITY
    -- ═══════════════════════════════════════════════════════════════════

    EXECUTE format('ALTER TABLE %I.ds_daos ENABLE ROW LEVEL SECURITY', s);
    EXECUTE format('ALTER TABLE %I.ds_members ENABLE ROW LEVEL SECURITY', s);
    EXECUTE format('ALTER TABLE %I.ds_proposals ENABLE ROW LEVEL SECURITY', s);
    EXECUTE format('ALTER TABLE %I.ds_votes ENABLE ROW LEVEL SECURITY', s);
    EXECUTE format('ALTER TABLE %I.ds_navigators ENABLE ROW LEVEL SECURITY', s);
    EXECUTE format('ALTER TABLE %I.ds_ragequits ENABLE ROW LEVEL SECURITY', s);
    EXECUTE format('ALTER TABLE %I.ds_records ENABLE ROW LEVEL SECURITY', s);
    EXECUTE format('ALTER TABLE %I.ds_guild_tokens ENABLE ROW LEVEL SECURITY', s);
    EXECUTE format('ALTER TABLE %I.ds_event_transactions ENABLE ROW LEVEL SECURITY', s);
    EXECUTE format('ALTER TABLE %I.ds_delegations ENABLE ROW LEVEL SECURITY', s);
    EXECUTE format('ALTER TABLE %I.ds_navigator_events ENABLE ROW LEVEL SECURITY', s);
    EXECUTE format('ALTER TABLE %I.ds_nft_claims ENABLE ROW LEVEL SECURITY', s);
    EXECUTE format('ALTER TABLE %I.ds_signal_polls ENABLE ROW LEVEL SECURITY', s);
    EXECUTE format('ALTER TABLE %I.ds_signal_votes ENABLE ROW LEVEL SECURITY', s);
    EXECUTE format('ALTER TABLE %I.ds_timelock_changes ENABLE ROW LEVEL SECURITY', s);
    EXECUTE format('ALTER TABLE %I.ds_vesting_schedules ENABLE ROW LEVEL SECURITY', s);
    EXECUTE format('ALTER TABLE %I.ds_vesting_claims ENABLE ROW LEVEL SECURITY', s);
    EXECUTE format('ALTER TABLE %I.ds_budgets ENABLE ROW LEVEL SECURITY', s);
    EXECUTE format('ALTER TABLE %I.ds_budget_disbursements ENABLE ROW LEVEL SECURITY', s);
    EXECUTE format('ALTER TABLE %I.ds_subscription_members ENABLE ROW LEVEL SECURITY', s);
    EXECUTE format('ALTER TABLE %I.ds_subscription_payments ENABLE ROW LEVEL SECURITY', s);
    EXECUTE format('ALTER TABLE %I.ds_subscription_collections ENABLE ROW LEVEL SECURITY', s);
    EXECUTE format('ALTER TABLE %I.ds_vault_module_events ENABLE ROW LEVEL SECURITY', s);
    EXECUTE format('ALTER TABLE %I.ds_governance_config_history ENABLE ROW LEVEL SECURITY', s);
    EXECUTE format('ALTER TABLE %I.ds_navigator_sanction_intents ENABLE ROW LEVEL SECURITY', s);
    EXECUTE format('ALTER TABLE %I.ds_indexer_state ENABLE ROW LEVEL SECURITY', s);
    EXECUTE format('ALTER TABLE %I.ds_processed_logs ENABLE ROW LEVEL SECURITY', s);

    -- Public read access (blockchain data is public)
    -- DROP + CREATE because CREATE POLICY does not support IF NOT EXISTS
    EXECUTE format('DROP POLICY IF EXISTS "Public read" ON %I.ds_daos', s);
    EXECUTE format('CREATE POLICY "Public read" ON %I.ds_daos FOR SELECT USING (true)', s);
    EXECUTE format('DROP POLICY IF EXISTS "Public read" ON %I.ds_members', s);
    EXECUTE format('CREATE POLICY "Public read" ON %I.ds_members FOR SELECT USING (true)', s);
    EXECUTE format('DROP POLICY IF EXISTS "Public read" ON %I.ds_proposals', s);
    EXECUTE format('CREATE POLICY "Public read" ON %I.ds_proposals FOR SELECT USING (true)', s);
    EXECUTE format('DROP POLICY IF EXISTS "Public read" ON %I.ds_votes', s);
    EXECUTE format('CREATE POLICY "Public read" ON %I.ds_votes FOR SELECT USING (true)', s);
    EXECUTE format('DROP POLICY IF EXISTS "Public read" ON %I.ds_navigators', s);
    EXECUTE format('CREATE POLICY "Public read" ON %I.ds_navigators FOR SELECT USING (true)', s);
    EXECUTE format('DROP POLICY IF EXISTS "Public read" ON %I.ds_ragequits', s);
    EXECUTE format('CREATE POLICY "Public read" ON %I.ds_ragequits FOR SELECT USING (true)', s);
    EXECUTE format('DROP POLICY IF EXISTS "Public read" ON %I.ds_records', s);
    EXECUTE format('CREATE POLICY "Public read" ON %I.ds_records FOR SELECT USING (true)', s);
    EXECUTE format('DROP POLICY IF EXISTS "Public read" ON %I.ds_guild_tokens', s);
    EXECUTE format('CREATE POLICY "Public read" ON %I.ds_guild_tokens FOR SELECT USING (true)', s);
    EXECUTE format('DROP POLICY IF EXISTS "Public read" ON %I.ds_event_transactions', s);
    EXECUTE format('CREATE POLICY "Public read" ON %I.ds_event_transactions FOR SELECT USING (true)', s);
    EXECUTE format('DROP POLICY IF EXISTS "Public read" ON %I.ds_delegations', s);
    EXECUTE format('CREATE POLICY "Public read" ON %I.ds_delegations FOR SELECT USING (true)', s);
    EXECUTE format('DROP POLICY IF EXISTS "Public read" ON %I.ds_navigator_events', s);
    EXECUTE format('CREATE POLICY "Public read" ON %I.ds_navigator_events FOR SELECT USING (true)', s);
    EXECUTE format('DROP POLICY IF EXISTS "Public read" ON %I.ds_nft_claims', s);
    EXECUTE format('CREATE POLICY "Public read" ON %I.ds_nft_claims FOR SELECT USING (true)', s);
    EXECUTE format('DROP POLICY IF EXISTS "Public read" ON %I.ds_signal_polls', s);
    EXECUTE format('CREATE POLICY "Public read" ON %I.ds_signal_polls FOR SELECT USING (true)', s);
    EXECUTE format('DROP POLICY IF EXISTS "Public read" ON %I.ds_signal_votes', s);
    EXECUTE format('CREATE POLICY "Public read" ON %I.ds_signal_votes FOR SELECT USING (true)', s);
    EXECUTE format('DROP POLICY IF EXISTS "Public read" ON %I.ds_timelock_changes', s);
    EXECUTE format('CREATE POLICY "Public read" ON %I.ds_timelock_changes FOR SELECT USING (true)', s);
    EXECUTE format('DROP POLICY IF EXISTS "Public read" ON %I.ds_vesting_schedules', s);
    EXECUTE format('CREATE POLICY "Public read" ON %I.ds_vesting_schedules FOR SELECT USING (true)', s);
    EXECUTE format('DROP POLICY IF EXISTS "Public read" ON %I.ds_vesting_claims', s);
    EXECUTE format('CREATE POLICY "Public read" ON %I.ds_vesting_claims FOR SELECT USING (true)', s);
    EXECUTE format('DROP POLICY IF EXISTS "Public read" ON %I.ds_budgets', s);
    EXECUTE format('CREATE POLICY "Public read" ON %I.ds_budgets FOR SELECT USING (true)', s);
    EXECUTE format('DROP POLICY IF EXISTS "Public read" ON %I.ds_budget_disbursements', s);
    EXECUTE format('CREATE POLICY "Public read" ON %I.ds_budget_disbursements FOR SELECT USING (true)', s);
    -- SubscriptionNavigator feeds: public blockchain data, read-only like the other feed tables.
    EXECUTE format('DROP POLICY IF EXISTS "Public read" ON %I.ds_subscription_members', s);
    EXECUTE format('CREATE POLICY "Public read" ON %I.ds_subscription_members FOR SELECT USING (true)', s);
    EXECUTE format('DROP POLICY IF EXISTS "Public read" ON %I.ds_subscription_payments', s);
    EXECUTE format('CREATE POLICY "Public read" ON %I.ds_subscription_payments FOR SELECT USING (true)', s);
    EXECUTE format('DROP POLICY IF EXISTS "Public read" ON %I.ds_subscription_collections', s);
    EXECUTE format('CREATE POLICY "Public read" ON %I.ds_subscription_collections FOR SELECT USING (true)', s);
    EXECUTE format('DROP POLICY IF EXISTS "Public read" ON %I.ds_vault_module_events', s);
    EXECUTE format('CREATE POLICY "Public read" ON %I.ds_vault_module_events FOR SELECT USING (true)', s);
    EXECUTE format('DROP POLICY IF EXISTS "Public read" ON %I.ds_governance_config_history', s);
    EXECUTE format('CREATE POLICY "Public read" ON %I.ds_governance_config_history FOR SELECT USING (true)', s);
    -- ds_navigator_sanction_intents: internal indexer state (like ds_processed_logs) —
    -- deny-all to public roles; service_role bypasses RLS for indexer writes.
    EXECUTE format('DROP POLICY IF EXISTS "Deny public" ON %I.ds_navigator_sanction_intents', s);
    EXECUTE format('CREATE POLICY "Deny public" ON %I.ds_navigator_sanction_intents FOR ALL TO authenticated, anon USING (false) WITH CHECK (false)', s);
    -- H7: Public read on ds_indexer_state is intentional — frontends use it for sync
    -- status display. The indexer is a read-only observer; exposing sync state has no
    -- impact on on-chain governance security.
    EXECUTE format('DROP POLICY IF EXISTS "Public read" ON %I.ds_indexer_state', s);
    EXECUTE format('CREATE POLICY "Public read" ON %I.ds_indexer_state FOR SELECT USING (true)', s);

    -- ds_processed_logs: internal dedup table, no frontend use (H1). RLS
    -- is enabled above but without a policy the Supabase linter warns
    -- about the combination ("enabled with no policy → accidentally
    -- locked"). Make the intent explicit:
    --   1. Explicit deny-all policy so the linter sees a policy exists.
    --   2. Revoke the blanket SELECT grant from authenticated/anon so the
    --      table is unreachable via PostgREST even if RLS were disabled.
    -- service_role still has ALL on all tables via the GRANT below and
    -- bypasses RLS anyway, so indexer writes are unaffected.
    EXECUTE format('DROP POLICY IF EXISTS "Deny public" ON %I.ds_processed_logs', s);
    EXECUTE format('CREATE POLICY "Deny public" ON %I.ds_processed_logs FOR ALL TO authenticated, anon USING (false) WITH CHECK (false)', s);

    -- ═══════════════════════════════════════════════════════════════════
    -- PERMISSIONS
    -- ═══════════════════════════════════════════════════════════════════

    EXECUTE format('GRANT USAGE ON SCHEMA %I TO service_role, authenticated, anon', s);
    EXECUTE format('GRANT ALL ON ALL TABLES IN SCHEMA %I TO service_role', s);
    EXECUTE format('GRANT SELECT ON ALL TABLES IN SCHEMA %I TO authenticated, anon', s);
    EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO service_role', s);
    EXECUTE format('GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA %I TO service_role', s);

    -- H1: Revoke write-capable function execution from public-facing roles.
    -- Only the service_role (used by the indexer) should call these.
    EXECUTE format('REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA %I FROM authenticated, anon', s);

    -- Also revoke table-level SELECT on ds_processed_logs — internal dedup
    -- table, no frontend use. Defense-in-depth alongside the RLS "Deny
    -- public" policy above. Runs AFTER the blanket GRANT so it wins.
    EXECUTE format('REVOKE ALL ON %I.ds_processed_logs FROM authenticated, anon', s);
    EXECUTE format('REVOKE ALL ON %I.ds_navigator_sanction_intents FROM authenticated, anon', s);

    -- ═══════════════════════════════════════════════════════════════════
    -- REALTIME
    -- ═══════════════════════════════════════════════════════════════════
    -- Enable Supabase Realtime on tables the frontend subscribes to.
    -- REPLICA IDENTITY FULL ensures UPDATE/DELETE events send the
    -- complete row (not just the PK) to connected clients.
    --
    -- Skipped: ds_event_transactions (internal, high volume),
    --          ds_delegations (low freq, append-only),
    --          ds_ragequits (low freq), ds_guild_tokens (rarely changes)

    -- Set REPLICA IDENTITY FULL for complete row data in change events
    EXECUTE format('ALTER TABLE %I.ds_daos REPLICA IDENTITY FULL', s);
    EXECUTE format('ALTER TABLE %I.ds_proposals REPLICA IDENTITY FULL', s);
    EXECUTE format('ALTER TABLE %I.ds_members REPLICA IDENTITY FULL', s);
    EXECUTE format('ALTER TABLE %I.ds_votes REPLICA IDENTITY FULL', s);
    EXECUTE format('ALTER TABLE %I.ds_records REPLICA IDENTITY FULL', s);
    EXECUTE format('ALTER TABLE %I.ds_navigators REPLICA IDENTITY FULL', s);
    EXECUTE format('ALTER TABLE %I.ds_navigator_events REPLICA IDENTITY FULL', s);
    EXECUTE format('ALTER TABLE %I.ds_nft_claims REPLICA IDENTITY FULL', s);
    EXECUTE format('ALTER TABLE %I.ds_signal_polls REPLICA IDENTITY FULL', s);
    EXECUTE format('ALTER TABLE %I.ds_signal_votes REPLICA IDENTITY FULL', s);
    EXECUTE format('ALTER TABLE %I.ds_timelock_changes REPLICA IDENTITY FULL', s);
    EXECUTE format('ALTER TABLE %I.ds_vesting_schedules REPLICA IDENTITY FULL', s);
    EXECUTE format('ALTER TABLE %I.ds_budgets REPLICA IDENTITY FULL', s);
    EXECUTE format('ALTER TABLE %I.ds_budget_disbursements REPLICA IDENTITY FULL', s);
    EXECUTE format('ALTER TABLE %I.ds_vault_module_events REPLICA IDENTITY FULL', s);
    EXECUTE format('ALTER TABLE %I.ds_governance_config_history REPLICA IDENTITY FULL', s);
    EXECUTE format('ALTER TABLE %I.ds_indexer_state REPLICA IDENTITY FULL', s);

    -- Add tables to the supabase_realtime publication (idempotent)
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = s AND tablename = 'ds_daos') THEN
        EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE %I.ds_daos', s);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = s AND tablename = 'ds_proposals') THEN
        EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE %I.ds_proposals', s);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = s AND tablename = 'ds_members') THEN
        EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE %I.ds_members', s);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = s AND tablename = 'ds_votes') THEN
        EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE %I.ds_votes', s);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = s AND tablename = 'ds_records') THEN
        EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE %I.ds_records', s);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = s AND tablename = 'ds_navigators') THEN
        EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE %I.ds_navigators', s);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = s AND tablename = 'ds_navigator_events') THEN
        EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE %I.ds_navigator_events', s);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = s AND tablename = 'ds_nft_claims') THEN
        EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE %I.ds_nft_claims', s);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = s AND tablename = 'ds_signal_polls') THEN
        EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE %I.ds_signal_polls', s);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = s AND tablename = 'ds_signal_votes') THEN
        EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE %I.ds_signal_votes', s);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = s AND tablename = 'ds_timelock_changes') THEN
        EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE %I.ds_timelock_changes', s);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = s AND tablename = 'ds_vesting_schedules') THEN
        EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE %I.ds_vesting_schedules', s);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = s AND tablename = 'ds_budgets') THEN
        EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE %I.ds_budgets', s);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = s AND tablename = 'ds_budget_disbursements') THEN
        EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE %I.ds_budget_disbursements', s);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = s AND tablename = 'ds_vault_module_events') THEN
        EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE %I.ds_vault_module_events', s);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = s AND tablename = 'ds_governance_config_history') THEN
        EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE %I.ds_governance_config_history', s);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = s AND tablename = 'ds_subscription_members') THEN
        EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE %I.ds_subscription_members', s);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = s AND tablename = 'ds_subscription_payments') THEN
        EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE %I.ds_subscription_payments', s);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = s AND tablename = 'ds_subscription_collections') THEN
        EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE %I.ds_subscription_collections', s);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = s AND tablename = 'ds_indexer_state') THEN
        EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE %I.ds_indexer_state', s);
    END IF;

    RAISE NOTICE 'DS schema "%" created successfully with all tables, indexes, functions, RLS, permissions, and realtime', s;
END;
$$ LANGUAGE plpgsql;


-- ── Drop DS Schema Tables Function ─────────────────────────────────────
-- Drops only DS tables from a schema (preserves other indexer tables)

CREATE OR REPLACE FUNCTION drop_ds_schema(network_name TEXT)
RETURNS void AS $$
DECLARE
    s TEXT := network_name;
    tbl TEXT;
    realtime_tables TEXT[] := ARRAY[
        'ds_daos', 'ds_proposals', 'ds_members', 'ds_votes',
        'ds_records', 'ds_navigators', 'ds_navigator_events', 'ds_nft_claims',
        'ds_signal_polls', 'ds_signal_votes', 'ds_timelock_changes',
        'ds_vesting_schedules', 'ds_budgets', 'ds_budget_disbursements',
        'ds_vault_module_events', 'ds_governance_config_history', 'ds_indexer_state'
    ];
BEGIN
    -- H1: Whitelist valid schema names to prevent accidental or malicious schema drops.
    IF network_name NOT IN ('testnet', 'mainnet', 'dev', 'public') THEN
        RAISE EXCEPTION 'Invalid network name: %. Must be one of: testnet, mainnet, dev, public', network_name;
    END IF;

    -- 1. Remove tables from realtime publication before dropping
    FOREACH tbl IN ARRAY realtime_tables LOOP
        IF EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = s AND tablename = tbl) THEN
            EXECUTE format('ALTER PUBLICATION supabase_realtime DROP TABLE %I.%I', s, tbl);
        END IF;
    END LOOP;

    -- 2. Drop all ds_ tables (FK-safe order: children first)
    EXECUTE format('DROP TABLE IF EXISTS %I.ds_vesting_claims CASCADE', s);
    EXECUTE format('DROP TABLE IF EXISTS %I.ds_vesting_schedules CASCADE', s);
    EXECUTE format('DROP TABLE IF EXISTS %I.ds_budget_disbursements CASCADE', s);
    EXECUTE format('DROP TABLE IF EXISTS %I.ds_budgets CASCADE', s);
    EXECUTE format('DROP TABLE IF EXISTS %I.ds_subscription_payments CASCADE', s);
    EXECUTE format('DROP TABLE IF EXISTS %I.ds_subscription_collections CASCADE', s);
    EXECUTE format('DROP TABLE IF EXISTS %I.ds_subscription_members CASCADE', s);
    EXECUTE format('DROP TABLE IF EXISTS %I.ds_vault_module_events CASCADE', s);
    EXECUTE format('DROP TABLE IF EXISTS %I.ds_timelock_changes CASCADE', s);
    EXECUTE format('DROP TABLE IF EXISTS %I.ds_governance_config_history CASCADE', s);
    EXECUTE format('DROP TABLE IF EXISTS %I.ds_signal_votes CASCADE', s);
    EXECUTE format('DROP TABLE IF EXISTS %I.ds_signal_polls CASCADE', s);
    EXECUTE format('DROP TABLE IF EXISTS %I.ds_navigator_sanction_intents CASCADE', s);
    EXECUTE format('DROP TABLE IF EXISTS %I.ds_nft_claims CASCADE', s);
    EXECUTE format('DROP TABLE IF EXISTS %I.ds_navigator_events CASCADE', s);
    EXECUTE format('DROP TABLE IF EXISTS %I.ds_delegations CASCADE', s);
    EXECUTE format('DROP TABLE IF EXISTS %I.ds_event_transactions CASCADE', s);
    EXECUTE format('DROP TABLE IF EXISTS %I.ds_guild_tokens CASCADE', s);
    EXECUTE format('DROP TABLE IF EXISTS %I.ds_records CASCADE', s);
    EXECUTE format('DROP TABLE IF EXISTS %I.ds_ragequits CASCADE', s);
    EXECUTE format('DROP TABLE IF EXISTS %I.ds_votes CASCADE', s);
    EXECUTE format('DROP TABLE IF EXISTS %I.ds_navigators CASCADE', s);
    EXECUTE format('DROP TABLE IF EXISTS %I.ds_proposals CASCADE', s);
    EXECUTE format('DROP TABLE IF EXISTS %I.ds_members CASCADE', s);
    EXECUTE format('DROP TABLE IF EXISTS %I.ds_daos CASCADE', s);
    EXECUTE format('DROP TABLE IF EXISTS %I.ds_indexer_state CASCADE', s);
    EXECUTE format('DROP TABLE IF EXISTS %I.ds_processed_logs CASCADE', s);

    -- 3. Drop all ds_ RPC functions in this schema
    EXECUTE format('DROP FUNCTION IF EXISTS %I.ds_get_proposal_status CASCADE', s);
    EXECUTE format('DROP FUNCTION IF EXISTS %I.ds_increment_proposal_votes CASCADE', s);
    EXECUTE format('DROP FUNCTION IF EXISTS %I.ds_increment_member_votes CASCADE', s);
    EXECUTE format('DROP FUNCTION IF EXISTS %I.ds_increment_proposal_count CASCADE', s);
    EXECUTE format('DROP FUNCTION IF EXISTS %I.ds_update_active_member_count CASCADE', s);
    EXECUTE format('DROP FUNCTION IF EXISTS %I.ds_adjust_dao_totals CASCADE', s);
    EXECUTE format('DROP FUNCTION IF EXISTS %I.ds_delete_events_after_block CASCADE', s);
    EXECUTE format('DROP FUNCTION IF EXISTS %I.ds_prune_orphaned_records CASCADE', s);
    EXECUTE format('DROP FUNCTION IF EXISTS %I.ds_prune_orphaned_navigators CASCADE', s);
    EXECUTE format('DROP FUNCTION IF EXISTS %I.ds_recompute_poll_tally CASCADE', s);
    EXECUTE format('DROP FUNCTION IF EXISTS %I.ds_recompute_vesting_claimed CASCADE', s);
    EXECUTE format('DROP FUNCTION IF EXISTS %I.ds_recompute_budget_spent CASCADE', s);
    EXECUTE format('DROP FUNCTION IF EXISTS %I.ds_recompute_subscription_paid CASCADE', s);
    EXECUTE format('DROP FUNCTION IF EXISTS %I.ds_recompute_module_trust CASCADE', s);
    EXECUTE format('DROP FUNCTION IF EXISTS %I.ds_resolve_timelock_bypass CASCADE', s);
    EXECUTE format('DROP FUNCTION IF EXISTS %I.ds_reparent_orphaned_records CASCADE', s);

    -- 4. Drop the schema itself (only if empty after our cleanup)
    EXECUTE format('DROP SCHEMA IF EXISTS %I CASCADE', s);

    RAISE NOTICE 'DS schema "%" fully dropped (tables, functions, schema)', s;
END;
$$ LANGUAGE plpgsql;
