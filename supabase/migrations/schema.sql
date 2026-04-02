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
            launcher VARCHAR(42) NOT NULL,

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
    EXECUTE format('
        CREATE TABLE IF NOT EXISTS %I.ds_navigators (
            id VARCHAR(85) PRIMARY KEY,
            dao_id VARCHAR(42) NOT NULL REFERENCES %I.ds_daos(id) ON DELETE CASCADE,
            navigator_address VARCHAR(42) NOT NULL,
            deployer VARCHAR(42),

            created_at TIMESTAMPTZ NOT NULL,

            permission INTEGER NOT NULL,
            permission_label public.ds_navigator_permission NOT NULL,

            is_active BOOLEAN DEFAULT TRUE,
            paused BOOLEAN DEFAULT FALSE,
            navigator_type VARCHAR(50),
            name VARCHAR(255),
            description TEXT,

            tx_hash VARCHAR(66) NOT NULL,

            UNIQUE(dao_id, navigator_address)
        )', s, s);

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
            dao_id VARCHAR(42) NOT NULL REFERENCES %I.ds_daos(id) ON DELETE CASCADE,

            created_at TIMESTAMPTZ NOT NULL,
            user_address VARCHAR(42) NOT NULL,
            tx_hash VARCHAR(66) NOT NULL,

            tag VARCHAR(100) NOT NULL,
            content_type VARCHAR(50),
            content TEXT NOT NULL,
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

    -- DS_INDEXER_STATE
    EXECUTE format('
        CREATE TABLE IF NOT EXISTS %I.ds_indexer_state (
            id INTEGER PRIMARY KEY DEFAULT 1,
            last_block_number BIGINT NOT NULL DEFAULT 0,
            last_block_hash VARCHAR(66),
            last_indexed_at TIMESTAMPTZ,
            chain_id INTEGER NOT NULL DEFAULT 15000,
            is_syncing BOOLEAN NOT NULL DEFAULT false,

            CHECK (id = 1)
        )', s);

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
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_ds_votes_voter ON %I.ds_votes(voter)', s);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_ds_votes_dao ON %I.ds_votes(dao_id)', s);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_ds_ragequits_dao ON %I.ds_ragequits(dao_id)', s);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_ds_delegations_lookup ON %I.ds_delegations(dao_id, delegator)', s);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_ds_processed_logs_block ON %I.ds_processed_logs(block_number)', s);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_ds_votes_block ON %I.ds_votes(block_number)', s);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_ds_ragequits_block ON %I.ds_ragequits(block_number)', s);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_ds_records_block ON %I.ds_records(block_number)', s);
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

    -- Delete indexed events after a block number (for reorg recovery)
    -- C2: Expanded to clean ALL append-only event tables, then recalculate aggregate counters.
    EXECUTE format('
        CREATE OR REPLACE FUNCTION %I.ds_delete_events_after_block(
            p_block_number BIGINT
        ) RETURNS void AS $fn$
        DECLARE
            affected_daos TEXT[];
        BEGIN
            -- 0. Collect affected DAOs before deleting event_transactions
            SELECT ARRAY(SELECT DISTINCT dao_id FROM %I.ds_event_transactions WHERE block_number > p_block_number AND dao_id IS NOT NULL)
            INTO affected_daos;

            -- 1. Delete from append-only event tables with block_number columns
            DELETE FROM %I.ds_processed_logs WHERE block_number > p_block_number;
            DELETE FROM %I.ds_navigator_events WHERE block_number > p_block_number;
            DELETE FROM %I.ds_votes WHERE block_number > p_block_number;
            DELETE FROM %I.ds_proposals WHERE block_number > p_block_number;
            DELETE FROM %I.ds_ragequits WHERE block_number > p_block_number;
            DELETE FROM %I.ds_records WHERE block_number > p_block_number;

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

            -- 3. Delete event_transactions last (used for joins above)
            DELETE FROM %I.ds_event_transactions WHERE block_number > p_block_number;

            -- 4. Recalculate aggregate counters on affected DAOs only
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
    ', s, s, s, s, s, s, s, s, s, s, s, s, s, s, s, s, s, s, s, s, s, s, s, s);

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
    EXECUTE format('DROP POLICY IF EXISTS "Public read" ON %I.ds_indexer_state', s);
    EXECUTE format('CREATE POLICY "Public read" ON %I.ds_indexer_state FOR SELECT USING (true)', s);
    -- ds_processed_logs: no public read policy (H1: internal dedup table, no frontend use)

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
        'ds_records', 'ds_navigators', 'ds_navigator_events', 'ds_indexer_state'
    ];
BEGIN
    -- 1. Remove tables from realtime publication before dropping
    FOREACH tbl IN ARRAY realtime_tables LOOP
        IF EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = s AND tablename = tbl) THEN
            EXECUTE format('ALTER PUBLICATION supabase_realtime DROP TABLE %I.%I', s, tbl);
        END IF;
    END LOOP;

    -- 2. Drop all ds_ tables (FK-safe order: children first)
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
    EXECUTE format('DROP FUNCTION IF EXISTS %I.ds_delete_events_after_block CASCADE', s);

    -- 4. Drop the schema itself (only if empty after our cleanup)
    EXECUTE format('DROP SCHEMA IF EXISTS %I CASCADE', s);

    RAISE NOTICE 'DS schema "%" fully dropped (tables, functions, schema)', s;
END;
$$ LANGUAGE plpgsql;
