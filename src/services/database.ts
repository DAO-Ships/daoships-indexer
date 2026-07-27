import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { validateAndNormalizeAddress, validateBytes32 } from '../utils/validation.js';
import type {
  DaoRow,
  DaoUpdate,
  DaoSummary,
  MemberRow,
  MemberUpsert,
  ProposalRow,
  ProposalUpdate,
  VoteRow,
  EventTransactionRow,
} from '../types/index.js';

// M15: Allowlist for generic upsert/insert methods — prevents SQL injection via
// dynamic table names. MUST be updated when adding new tables that use the
// generic upsert() or insert() methods. Tables with dedicated methods (ds_daos,
// ds_members, ds_proposals, ds_votes) don't need to be listed here.
const VALID_TABLES = new Set([
  'ds_guild_tokens',
  'ds_ragequits',
  'ds_navigators',
  'ds_navigator_events',
  'ds_nft_claims',
  'ds_signal_polls',
  'ds_signal_votes',
  'ds_navigator_sanction_intents',
  'ds_records',
  'ds_delegations',
  'ds_timelock_changes',
  'ds_vesting_schedules',
  'ds_vesting_claims',
  'ds_budgets',
  'ds_budget_disbursements',
  'ds_vault_module_events',
  'ds_governance_config_history',
  'ds_subscription_members',
  'ds_subscription_payments',
  'ds_subscription_collections',
]);

export class DatabaseService {
  // Type uses `any` for schema because the schema name is dynamic (testnet, mainnet, dev)
  readonly client: SupabaseClient<any, string>;

  // SC7: Highest cutoff we've successfully pruned processed_logs at, in memory.
  // The cutoff moves forward with indexing; re-pruning at ≤ the same cutoff is
  // always a no-op, so we skip the RTT. Resets to 0 on process restart which
  // triggers exactly one redundant DELETE (acceptable).
  private lastPrunedCutoff = 0;

  constructor() {
    this.client = createClient(
      config.supabaseUrl,
      config.supabaseServiceRoleKey,
      {
        auth: { persistSession: false },
        db: { schema: config.supabaseSchema },
      },
    );
  }

  // ── Indexer State ──────────────────────────────────────────────

  async getLastProcessedBlock(): Promise<{ blockNumber: number; blockHash: string | null }> {
    const { data, error } = await this.client
      .from('ds_indexer_state')
      .select('last_block_number, last_block_hash')
      .eq('id', 1)
      .single();

    if (error) throw new Error(`Failed to get indexer state: ${error.message}`);
    return {
      blockNumber: data?.last_block_number ?? 0,
      blockHash: data?.last_block_hash ?? null,
    };
  }

  async getIndexerState(): Promise<{
    blockNumber: number;
    blockHash: string | null;
    chainId: number | null;
    isSyncing: boolean;
    requiresFullReindex: boolean;
    reindexReason: string | null;
    reindexFlaggedAt: string | null;
  }> {
    const { data, error } = await this.client
      .from('ds_indexer_state')
      .select('last_block_number, last_block_hash, chain_id, is_syncing, requires_full_reindex, reindex_reason, reindex_flagged_at')
      .eq('id', 1)
      .single();

    if (error) throw new Error(`Failed to get indexer state: ${error.message}`);
    return {
      blockNumber: data?.last_block_number ?? 0,
      blockHash: data?.last_block_hash ?? null,
      chainId: data?.chain_id ?? null,
      isSyncing: data?.is_syncing ?? false,
      requiresFullReindex: data?.requires_full_reindex ?? false,
      reindexReason: data?.reindex_reason ?? null,
      reindexFlaggedAt: data?.reindex_flagged_at ?? null,
    };
  }

  /**
   * Persist the chain ID the indexer is actually connected to.
   *
   * `ds_indexer_state.chain_id` is `NOT NULL DEFAULT 15000` in schema.sql, and
   * until now nothing ever wrote it — so every schema reported 15000 regardless
   * of the chain it indexed. The mainnet schema (chain 9) advertised 15000 while
   * indexing mainnet blocks, and consumers are told to gate reads on this table.
   *
   * Writing it from the live RPC rather than from config makes the value
   * self-correcting on deploy and immune to a missing CHAIN_ID env var.
   * Returns the previous value when it changed, so the caller can log the repair.
   */
  async reconcileChainId(actualChainId: number): Promise<{ changed: boolean; previous: number | null }> {
    const { data: before, error: readErr } = await this.client
      .from('ds_indexer_state')
      .select('chain_id')
      .eq('id', 1)
      .single();

    if (readErr) throw new Error(`Failed to read chain_id: ${readErr.message}`);

    const previous: number | null = before?.chain_id ?? null;
    if (previous === actualChainId) return { changed: false, previous };

    const { error } = await this.client
      .from('ds_indexer_state')
      .update({ chain_id: actualChainId })
      .eq('id', 1);

    if (error) throw new Error(`Failed to update chain_id: ${error.message}`);
    return { changed: true, previous };
  }

  // M2: Flag the indexer state as requiring a full reindex. Set by the reorg
  // recovery path when a reorg exceeds the confirmation window — member
  // balances cannot be rebuilt from the replay range alone, so totals may
  // drift until operators run a full reindex. Surfaced via /health.
  async setRequiresFullReindex(reason: string): Promise<void> {
    const { error } = await this.client
      .from('ds_indexer_state')
      .update({
        requires_full_reindex: true,
        reindex_reason: reason,
        reindex_flagged_at: new Date().toISOString(),
      })
      .eq('id', 1);

    if (error) throw new Error(`Failed to set requires_full_reindex: ${error.message}`);
    logger.warn({ reason }, 'Indexer flagged as requires_full_reindex');
  }

  async clearRequiresFullReindex(): Promise<void> {
    const { error } = await this.client
      .from('ds_indexer_state')
      .update({
        requires_full_reindex: false,
        reindex_reason: null,
        reindex_flagged_at: null,
      })
      .eq('id', 1);

    if (error) throw new Error(`Failed to clear requires_full_reindex: ${error.message}`);
    logger.info('Cleared requires_full_reindex flag');
  }

  async updateLastProcessedBlock(blockNumber: number, blockHash: string): Promise<void> {
    const { error } = await this.withDbTimeout(
      this.client
        .from('ds_indexer_state')
        .update({
          last_block_number: blockNumber,
          last_block_hash: blockHash,
          last_indexed_at: new Date().toISOString(),
        })
        .eq('id', 1),
      'updateLastProcessedBlock',
    );

    if (error) throw new Error(`Failed to update indexer state: ${error.message}`);
  }

  async setIsSyncing(isSyncing: boolean): Promise<void> {
    const { error } = await this.client
      .from('ds_indexer_state')
      .update({ is_syncing: isSyncing })
      .eq('id', 1);

    if (error) throw new Error(`Failed to set is_syncing: ${error.message}`);
    logger.info({ isSyncing }, 'Updated syncing state');
  }

  // ── DAO Operations ─────────────────────────────────────────────

  async upsertDao(dao: DaoRow): Promise<void> {
    validateAndNormalizeAddress(dao.id, 'dao.id');
    const { error } = await this.withDbTimeout(
      this.client.from('ds_daos').upsert(dao, { onConflict: 'id' }),
      'upsertDao',
    );
    if (error) throw new Error(`Failed to upsert DAO ${dao.id}: ${error.message}`);
  }

  async getDao(daoId: string): Promise<DaoRow | null> {
    const normalized = validateAndNormalizeAddress(daoId, 'daoId');
    const { data, error } = await this.withDbTimeout(
      this.client.from('ds_daos').select('*').eq('id', normalized).single(),
      'getDao',
    );
    if (error && error.code !== 'PGRST116') {
      throw new Error(`Failed to get DAO: ${error.message}`);
    }
    return data as DaoRow | null;
  }

  async updateDao(daoId: string, updates: DaoUpdate): Promise<void> {
    const normalized = validateAndNormalizeAddress(daoId, 'daoId');
    const { error } = await this.withDbTimeout(
      this.client
        .from('ds_daos')
        .update({ ...updates, updated_at: new Date().toISOString() })
        .eq('id', normalized),
      'updateDao',
    );
    if (error) throw new Error(`Failed to update DAO ${normalized}: ${error.message}`);
  }

  async updateNavigator(navigatorId: string, updates: Record<string, unknown>): Promise<void> {
    const { error } = await this.withDbTimeout(
      this.client.from('ds_navigators').update(updates).eq('id', navigatorId),
      'updateNavigator',
    );
    if (error) throw new Error(`Failed to update navigator ${navigatorId}: ${error.message}`);
  }

  /** Targeted UPDATE of a timelock change by id ({navigator}-{changeId}). No-op if absent. */
  async updateTimelockChange(id: string, updates: Record<string, unknown>): Promise<void> {
    const { error } = await this.withDbTimeout(
      this.client.from('ds_timelock_changes').update(updates).eq('id', id),
      'updateTimelockChange',
    );
    if (error) throw new Error(`Failed to update timelock change ${id}: ${error.message}`);
  }

  /** Targeted UPDATE of a vesting schedule by id ({navigator}-{scheduleId}). No-op if absent. */
  async updateVestingSchedule(id: string, updates: Record<string, unknown>): Promise<void> {
    const { error } = await this.withDbTimeout(
      this.client.from('ds_vesting_schedules').update(updates).eq('id', id),
      'updateVestingSchedule',
    );
    if (error) throw new Error(`Failed to update vesting schedule ${id}: ${error.message}`);
  }

  /** Targeted UPDATE of a budget by id ({navigator}-{budgetId}). No-op if absent — used by
   *  ManagerUpdated (manager swap) and BudgetCancelled (irreversible halt). */
  async updateBudget(id: string, updates: Record<string, unknown>): Promise<void> {
    const { error } = await this.withDbTimeout(
      this.client.from('ds_budgets').update(updates).eq('id', id),
      'updateBudget',
    );
    if (error) throw new Error(`Failed to update budget ${id}: ${error.message}`);
  }

  /** Targeted UPDATE of a subscription member by id ({navigator}-{member}). No-op if absent —
   *  used by FeeCollected (un-enroll: paid_through → 0, stamp last_collected_at). */
  async updateSubscriptionMember(id: string, updates: Record<string, unknown>): Promise<void> {
    const { error } = await this.withDbTimeout(
      this.client.from('ds_subscription_members').update(updates).eq('id', id),
      'updateSubscriptionMember',
    );
    if (error) throw new Error(`Failed to update subscription member ${id}: ${error.message}`);
  }

  // ── Member Operations ──────────────────────────────────────────

  async getMember(memberId: string): Promise<MemberRow | null> {
    const { data, error } = await this.withDbTimeout(
      this.client.from('ds_members').select('*').eq('id', memberId).single(),
      'getMember',
    );
    if (error && error.code !== 'PGRST116') {
      throw new Error(`Failed to get member: ${error.message}`);
    }
    return data as MemberRow | null;
  }

  async upsertMember(member: MemberUpsert): Promise<void> {
    const { error } = await this.withDbTimeout(
      this.client.from('ds_members').upsert(member, { onConflict: 'id' }),
      'upsertMember',
    );
    if (error) throw new Error(`Failed to upsert member ${member.id}: ${error.message}`);
  }

  // E1: Counterpart to insertProposalIfAbsent for member stubs.
  async insertMemberIfAbsent(member: MemberUpsert): Promise<boolean> {
    const { data, error } = await this.withDbTimeout(
      this.client.from('ds_members')
        .upsert(member, { onConflict: 'id', ignoreDuplicates: true })
        .select('id'),
      'insertMemberIfAbsent',
    );
    if (error) throw new Error(`Failed to insert-if-absent member ${member.id}: ${error.message}`);
    return (data?.length ?? 0) > 0;
  }

  // ── Proposal Operations ────────────────────────────────────────

  async getProposal(proposalId: string): Promise<ProposalRow | null> {
    const { data, error } = await this.withDbTimeout(
      this.client.from('ds_proposals').select('*').eq('id', proposalId).single(),
      'getProposal',
    );
    if (error && error.code !== 'PGRST116') {
      throw new Error(`Failed to get proposal: ${error.message}`);
    }
    return data as ProposalRow | null;
  }

  async upsertProposal(proposal: ProposalRow): Promise<void> {
    const { error } = await this.withDbTimeout(
      this.client.from('ds_proposals').upsert(proposal, { onConflict: 'id' }),
      'upsertProposal',
    );
    if (error) throw new Error(`Failed to upsert proposal ${proposal.id}: ${error.message}`);
  }

  // E1: INSERT … ON CONFLICT DO NOTHING, returning whether the row was
  // actually inserted. Used by vote/ragequit handlers to materialize a stub
  // row when the canonical event (SubmitProposal / MintShares) landed in a
  // failed block range. Callers get the insert/no-op signal so they can
  // distinguish a legitimate data gap from a re-run.
  async insertProposalIfAbsent(proposal: ProposalRow): Promise<boolean> {
    const { data, error } = await this.withDbTimeout(
      this.client.from('ds_proposals')
        .upsert(proposal, { onConflict: 'id', ignoreDuplicates: true })
        .select('id'),
      'insertProposalIfAbsent',
    );
    if (error) throw new Error(`Failed to insert-if-absent proposal ${proposal.id}: ${error.message}`);
    return (data?.length ?? 0) > 0;
  }

  async updateProposal(proposalId: string, updates: ProposalUpdate): Promise<void> {
    const { error } = await this.withDbTimeout(
      this.client.from('ds_proposals').update(updates).eq('id', proposalId),
      'updateProposal',
    );
    if (error) throw new Error(`Failed to update proposal ${proposalId}: ${error.message}`);
  }

  // ── Vote Operations ────────────────────────────────────────────

  async upsertVote(vote: VoteRow): Promise<void> {
    const { error } = await this.withDbTimeout(
      this.client.from('ds_votes').upsert(vote, { onConflict: 'id' }),
      'upsertVote',
    );
    if (error) throw new Error(`Failed to upsert vote ${vote.id}: ${error.message}`);
  }

  // ── Generic Operations ─────────────────────────────────────────

  async upsert(table: string, data: Record<string, unknown>): Promise<void> {
    if (!VALID_TABLES.has(table)) {
      throw new Error(`Invalid table name for generic upsert: ${table}`);
    }
    const { error } = await this.withDbTimeout(
      this.client.from(table).upsert(data, { onConflict: 'id' }),
      `upsert:${table}`,
    );
    if (error) throw new Error(`Failed to upsert into ${table}: ${error.message}`);
  }

  async insert(table: string, data: Record<string, unknown>): Promise<void> {
    if (!VALID_TABLES.has(table)) {
      throw new Error(`Invalid table name for generic insert: ${table}`);
    }
    const { error } = await this.withDbTimeout(
      this.client.from(table).insert(data),
      `insert:${table}`,
    );
    if (error) {
      // Ignore duplicate key violations (expected during re-indexing)
      if (error.code === '23505') return;
      throw new Error(`Failed to insert into ${table}: ${error.message}`);
    }
  }

  // ── RPC Functions ──────────────────────────────────────────────

  async incrementProposalVotes(proposalId: string, approved: boolean, balance: string): Promise<void> {
    const { error } = await this.withDbTimeout(
      this.client.rpc('ds_increment_proposal_votes', {
        p_id: proposalId,
        p_approved: approved,
        p_balance: balance,
      }),
      'incrementProposalVotes',
    );
    if (error) throw new Error(`Failed to increment votes: ${error.message}`);
  }

  async incrementMemberVotes(memberId: string, memberAddress: string, daoId: string, activityAt: string): Promise<void> {
    const { error } = await this.withDbTimeout(
      this.client.rpc('ds_increment_member_votes', {
        p_member_id: memberId,
        p_member_address: memberAddress,
        p_dao_id: daoId,
        p_activity_at: activityAt,
      }),
      'incrementMemberVotes',
    );
    if (error) throw new Error(`Failed to increment member votes: ${error.message}`);
  }

  async incrementProposalCount(daoId: string): Promise<void> {
    const normalized = validateAndNormalizeAddress(daoId, 'daoId');
    const { error } = await this.withDbTimeout(
      this.client.rpc('ds_increment_proposal_count', { p_dao_id: normalized }),
      'incrementProposalCount',
    );
    if (error) throw new Error(`Failed to increment proposal count: ${error.message}`);
  }

  async adjustDaoTotals(daoId: string, sharesDelta: string, lootDelta: string): Promise<void> {
    const normalized = validateAndNormalizeAddress(daoId, 'daoId');
    const { error } = await this.withDbTimeout(
      this.client.rpc('ds_adjust_dao_totals', {
        p_dao_id: normalized,
        p_shares_delta: sharesDelta,
        p_loot_delta: lootDelta,
      }),
      'adjustDaoTotals',
    );
    if (error) throw new Error(`Failed to adjust DAO totals for ${normalized}: ${error.message}`);
  }

  /**
   * Option B — idempotent Transfer handler RPC. Atomically dedups on
   * `(tx_hash, log_index)` and applies balance math + active-member
   * delta in a single transaction. If the log was already processed,
   * returns `already_processed: true` and the caller short-circuits.
   *
   * See `supabase/migrations/schema.sql:ds_apply_transfer` for the full
   * invariant.
   */
  async applyTransfer(args: {
    txHash: string;
    logIndex: number;
    blockNumber: number;
    daoId: string;
    fromAddress: string;
    toAddress: string;
    value: string; // NUMERIC(78,0) as string
    isShares: boolean;
    timestamp: Date;
  }): Promise<{ alreadyProcessed: boolean; activeMemberDelta: number }> {
    const { data, error } = await this.withDbTimeout(
      this.client.rpc('ds_apply_transfer', {
        p_tx_hash: args.txHash,
        p_log_index: args.logIndex,
        p_block_number: args.blockNumber,
        p_dao_id: validateAndNormalizeAddress(args.daoId, 'daoId'),
        p_from_address: validateAndNormalizeAddress(args.fromAddress, 'fromAddress'),
        p_to_address: validateAndNormalizeAddress(args.toAddress, 'toAddress'),
        p_value: args.value,
        p_is_shares: args.isShares,
        p_timestamp: args.timestamp.toISOString(),
      }),
      'applyTransfer',
    );
    if (error) throw new Error(`Failed ds_apply_transfer: ${error.message}`);
    // RPC returns a table — Supabase wraps it as an array of rows.
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) throw new Error('ds_apply_transfer returned no row');
    return {
      alreadyProcessed: Boolean(row.already_processed),
      activeMemberDelta: Number(row.active_member_delta ?? 0),
    };
  }

  /**
   * Option B — derive-from-truth DAO totals recompute. Called ONCE per
   * dirty DAO at end-of-range by the processor, never per-log. Replaces
   * the non-idempotent `adjustDaoTotals` delta path for Mint, Burn,
   * Ragequit, and ConvertSharesToLoot flows.
   */
  async recomputeDaoTotals(daoId: string): Promise<void> {
    const normalized = validateAndNormalizeAddress(daoId, 'daoId');
    const { error } = await this.withDbTimeout(
      this.client.rpc('ds_recompute_dao_totals', { p_dao_id: normalized }),
      'recomputeDaoTotals',
    );
    if (error) throw new Error(`Failed to recompute DAO totals for ${normalized}: ${error.message}`);
  }

  /**
   * Mark a signal poll cancelled (terminal). Targeted UPDATE — never inserts — so a
   * PollCancelled for a poll that was not materialized (unsanctioned navigator) is a
   * harmless no-op rather than resurrecting a stub row.
   */
  async markPollCancelled(pollPk: string, updatedAt: string): Promise<void> {
    const { error } = await this.withDbTimeout(
      this.client.from('ds_signal_polls')
        .update({ cancelled: true, updated_at: updatedAt })
        .eq('id', pollPk),
      'markPollCancelled',
    );
    if (error) throw new Error(`Failed to mark poll cancelled for ${pollPk}: ${error.message}`);
  }

  /**
   * Read the fields a daoships.signal.poll labels post needs to gate against: the on-chain
   * `creator` (trust: msg.sender must match), `option_count` (options.length must equal it),
   * and the time-derived status inputs (`voting_ends`, `cancelled`) so an expired/cancelled poll
   * rejects late label edits. Returns null if the poll isn't materialized (unsanctioned navigator
   * → labels post is discarded, not held — see SIGNAL_POLL_LABELS_SUPPORT.md §3).
   */
  async getSignalPoll(pollPk: string): Promise<{
    creator: string;
    option_count: number;
    voting_ends: number;
    cancelled: boolean;
    labels_block_number: number | null;
  } | null> {
    const { data, error } = await this.withDbTimeout(
      this.client.from('ds_signal_polls')
        .select('creator, option_count, voting_ends, cancelled, labels_block_number')
        .eq('id', pollPk)
        .limit(1),
      'getSignalPoll',
    );
    if (error) throw new Error(`Failed to read signal poll ${pollPk}: ${error.message}`);
    const row = Array.isArray(data) && data.length > 0 ? data[0] as Record<string, unknown> : null;
    if (!row) return null;
    return {
      creator: String(row.creator),
      option_count: Number(row.option_count),
      voting_ends: Number(row.voting_ends),
      cancelled: row.cancelled === true,
      labels_block_number: row.labels_block_number == null ? null : Number(row.labels_block_number),
    };
  }

  /**
   * Apply off-chain option labels (daoships.signal.poll) to a materialized poll row. Targeted
   * UPDATE — never inserts. Last-write-wins guarded by block: only overwrites when the existing
   * labels post is older (or absent), so a replayed/out-of-order older post can't clobber a newer
   * edit. The caller has already verified creator-match, length-match, and not-expired.
   */
  async applyPollLabels(
    pollPk: string,
    labels: {
      options: string[];
      description: string | null;
      discussionUrl: string | null;
      labelsUpdatedAt: string;
      labelsBlockNumber: number;
    },
  ): Promise<void> {
    const { error } = await this.withDbTimeout(
      this.client.from('ds_signal_polls')
        .update({
          options: labels.options,
          description: labels.description,
          discussion_url: labels.discussionUrl,
          labels_updated_at: labels.labelsUpdatedAt,
          labels_block_number: labels.labelsBlockNumber,
          updated_at: labels.labelsUpdatedAt,
        })
        .eq('id', pollPk)
        .or(`labels_block_number.is.null,labels_block_number.lte.${labels.labelsBlockNumber}`),
      'applyPollLabels',
    );
    if (error) throw new Error(`Failed to apply poll labels for ${pollPk}: ${error.message}`);
  }

  /** Derive a signal poll's per-option tally from ds_signal_votes (idempotent). */
  async recomputePollTally(pollPk: string): Promise<void> {
    const { error } = await this.withDbTimeout(
      this.client.rpc('ds_recompute_poll_tally', { p_poll_pk: pollPk }),
      'recomputePollTally',
    );
    if (error) throw new Error(`Failed to recompute poll tally for ${pollPk}: ${error.message}`);
  }

  /** Derive a vesting schedule's cumulative `claimed` from ds_vesting_claims (idempotent). */
  async recomputeVestingClaimed(schedulePk: string): Promise<void> {
    const { error } = await this.withDbTimeout(
      this.client.rpc('ds_recompute_vesting_claimed', { p_schedule_pk: schedulePk }),
      'recomputeVestingClaimed',
    );
    if (error) throw new Error(`Failed to recompute vesting claimed for ${schedulePk}: ${error.message}`);
  }

  /** Derive a budget's cumulative `total_spent` from ds_budget_disbursements (idempotent). */
  async recomputeBudgetSpent(budgetPk: string): Promise<void> {
    const { error } = await this.withDbTimeout(
      this.client.rpc('ds_recompute_budget_spent', { p_budget_pk: budgetPk }),
      'recomputeBudgetSpent',
    );
    if (error) throw new Error(`Failed to recompute budget spent for ${budgetPk}: ${error.message}`);
  }

  /** Derive a subscription member's cumulative `total_paid` from ds_subscription_payments (idempotent). */
  async recomputeSubscriptionPaid(memberPk: string): Promise<void> {
    const { error } = await this.withDbTimeout(
      this.client.rpc('ds_recompute_subscription_paid', { p_member_pk: memberPk }),
      'recomputeSubscriptionPaid',
    );
    if (error) throw new Error(`Failed to recompute subscription paid for ${memberPk}: ${error.message}`);
  }

  /**
   * Flag (or clear) timelock bypass on the ds_governance_config_history rows for a (dao, tx).
   * Idempotent — derives bypassed_timelock from current truth: TRUE iff the DAO has an active
   * TimelockNavigator and no ChangeExecuted was recorded for it in this tx.
   */
  async resolveTimelockBypass(daoId: string, txHash: string): Promise<void> {
    const { error } = await this.withDbTimeout(
      this.client.rpc('ds_resolve_timelock_bypass', {
        p_dao_id: validateAndNormalizeAddress(daoId, 'daoId'),
        p_tx_hash: txHash,
      }),
      'resolveTimelockBypass',
    );
    if (error) throw new Error(`Failed to resolve timelock bypass for ${daoId}@${txHash}: ${error.message}`);
  }

  /**
   * Trust + identity of a navigator by address (single row — read-only navigators
   * have exactly one NavigatorDeployed). Used by the signal materialization gate
   * (only `trust_status === 'sanctioned'` polls/votes are written) and by the
   * sanction backfill. Returns null if NavigatorDeployed hasn't been indexed yet.
   */
  async getNavigatorTrust(navigatorAddress: string): Promise<{
    id: string;
    dao_id: string | null;
    trust_status: string | null;
    navigator_type: string | null;
    deploy_block: number | null;
  } | null> {
    const normalized = validateAndNormalizeAddress(navigatorAddress, 'navigatorAddress');
    const { data, error } = await this.withDbTimeout(
      this.client.from('ds_navigators')
        .select('id, dao_id, trust_status, navigator_type, deploy_block')
        .eq('navigator_address', normalized)
        .limit(1),
      'getNavigatorTrust',
    );
    if (error) {
      logger.warn({ navigatorAddress: normalized, error: error.message }, 'Failed to read navigator trust (non-fatal)');
      return null;
    }
    return data && data.length > 0 ? (data[0] as {
      id: string; dao_id: string | null; trust_status: string | null; navigator_type: string | null; deploy_block: number | null;
    }) : null;
  }

  async updateActiveMemberCount(daoId: string, delta: number): Promise<void> {
    const normalized = validateAndNormalizeAddress(daoId, 'daoId');
    const { error } = await this.withDbTimeout(
      this.client.rpc('ds_update_active_member_count', { p_dao_id: normalized, p_delta: delta }),
      'updateActiveMemberCount',
    );
    if (error) throw new Error(`Failed to update active member count: ${error.message}`);
  }

  async deleteEventsAfterBlock(blockNumber: number): Promise<void> {
    const { error } = await this.withDbTimeout(
      this.client.rpc('ds_delete_events_after_block', { p_block_number: blockNumber }),
      'deleteEventsAfterBlock',
    );
    if (error) throw new Error(`Failed to delete events after block ${blockNumber}: ${error.message}`);
    logger.info({ blockNumber }, 'Deleted indexed events after block for reorg recovery');
  }

  // Count dedupe-log rows with block_number > cutoff. Used by the reorg
  // recovery path to decide whether the rewound window contained any
  // processed events — if zero, no balance-affecting event was ever
  // recorded on the abandoned fork and the requires_full_reindex flag
  // can be skipped. Must be called BEFORE deleteEventsAfterBlock, which
  // cascades through ds_processed_logs.
  async countProcessedLogsAfterBlock(blockNumber: number): Promise<number> {
    const { count, error } = await this.withDbTimeout(
      this.client
        .from('ds_processed_logs')
        .select('*', { count: 'exact', head: true })
        .gt('block_number', blockNumber),
      'countProcessedLogsAfterBlock',
    );
    if (error) throw new Error(`Failed to count processed_logs after block ${blockNumber}: ${error.message}`);
    return count ?? 0;
  }

  async reparentOrphanedRecords(daoAddress: string, navigatorAddress: string): Promise<void> {
    const normalizedDao = validateAndNormalizeAddress(daoAddress, 'daoAddress');
    const normalizedNav = validateAndNormalizeAddress(navigatorAddress, 'navigatorAddress');
    const { data, error } = await this.withDbTimeout(
      this.client.rpc('ds_reparent_orphaned_records', { p_dao_address: normalizedDao, p_navigator_address: normalizedNav }),
      'reparentOrphanedRecords',
    );
    if (error) {
      logger.warn({ daoAddress: normalizedDao, navigatorAddress: normalizedNav, error: error.message }, 'Failed to reparent orphaned records (non-fatal)');
      return;
    }
    if (data && data > 0) {
      logger.info({ daoAddress: normalizedDao, navigatorAddress: normalizedNav, count: data }, 'Reparented orphaned allowlist records');
    }
  }

  async pruneOrphanedRecords(retentionDays: number): Promise<void> {
    const { data, error } = await this.withDbTimeout(
      this.client.rpc('ds_prune_orphaned_records', { p_retention_days: retentionDays }),
      'pruneOrphanedRecords',
    );
    if (error) {
      logger.warn({ retentionDays, error: error.message }, 'Failed to prune orphaned records (non-fatal)');
      return;
    }
    if (data && data > 0) {
      logger.info({ retentionDays, deleted: data }, 'Pruned orphaned records');
    }
  }

  /**
   * Prune genuine orphan navigators. `atChainHead` MUST reflect whether the
   * indexer has caught up to the chain head — the RPC no-ops when false, since
   * a navigator whose DAO simply has not been ingested yet is indistinguishable
   * from an orphan mid-backfill. See ds_prune_orphaned_navigators (schema.sql).
   */
  async pruneOrphanedNavigators(retentionDays: number, atChainHead: boolean): Promise<void> {
    const { data, error } = await this.withDbTimeout(
      this.client.rpc('ds_prune_orphaned_navigators', { p_retention_days: retentionDays, p_at_chain_head: atChainHead }),
      'pruneOrphanedNavigators',
    );
    if (error) {
      logger.warn({ retentionDays, error: error.message }, 'Failed to prune orphaned navigators (non-fatal)');
      return;
    }
    if (data && data > 0) {
      logger.info({ retentionDays, deleted: data }, 'Pruned orphaned navigators');
    }
  }

  /**
   * Atomically consume a held sanction intent for (daoAddress, navigatorAddress):
   * deletes the row and returns true if one existed. Written by the
   * daoships.dao.navigators handler when it sanctions a navigator we have not yet
   * seen NavigatorDeployed for; applied by handleNavigatorDeployed when the row
   * appears. Returns the vault that posted it (for optional re-verification), or null.
   */
  /** List a DAO's currently-sanctioned navigators (address + type). The caller
   *  filters to read-only types — permissioned navigators are 'sanctioned' via
   *  NavigatorSet and must not be touched by the daoships.dao.navigators path. */
  async listSanctionedNavigators(daoId: string): Promise<Array<{ navigator_address: string; navigator_type: string | null }>> {
    const dao = validateAndNormalizeAddress(daoId, 'daoId');
    const { data, error } = await this.withDbTimeout(
      this.client.from('ds_navigators')
        .select('navigator_address, navigator_type')
        .eq('dao_id', dao)
        .eq('trust_status', 'sanctioned'),
      'listSanctionedNavigators',
    );
    if (error) {
      logger.warn({ daoId: dao, error: error.message }, 'Failed to list sanctioned navigators (non-fatal)');
      return [];
    }
    return (data ?? []) as Array<{ navigator_address: string; navigator_type: string | null }>;
  }

  /**
   * Derive a BudgetNavigator's trust_status/is_active from the LATEST surviving
   * ds_vault_module_events row (enabled → sanctioned+active, disabled → unsanctioned+inactive,
   * none → self_asserted+inactive). Idempotent. Called after writing a vault-module event so the
   * column is always a pure function of the (reorg-deletable) feed — never a directly-set value
   * that could go stale when an EnabledModule/DisabledModule is rolled back.
   */
  async recomputeModuleTrust(navigatorAddress: string): Promise<void> {
    const nav = validateAndNormalizeAddress(navigatorAddress, 'navigatorAddress');
    const { error } = await this.withDbTimeout(
      this.client.rpc('ds_recompute_module_trust', { p_navigator_address: nav }),
      'recomputeModuleTrust',
    );
    if (error) throw new Error(`Failed to recompute module trust for ${nav}: ${error.message}`);
  }

  /** Set a navigator's read-only trust_status, scoped to (dao_id, navigator_address). */
  async setNavigatorTrust(daoId: string, navigatorAddress: string, trustStatus: string, updatedAt: string): Promise<void> {
    const dao = validateAndNormalizeAddress(daoId, 'daoId');
    const nav = validateAndNormalizeAddress(navigatorAddress, 'navigatorAddress');
    const { error } = await this.withDbTimeout(
      this.client.from('ds_navigators')
        .update({ trust_status: trustStatus, updated_at: updatedAt })
        .eq('dao_id', dao)
        .eq('navigator_address', nav),
      'setNavigatorTrust',
    );
    if (error) throw new Error(`Failed to set navigator trust for ${nav}@${dao}: ${error.message}`);
  }

  /** Record a sanction intent to apply when the navigator's NavigatorDeployed arrives. */
  async writeSanctionIntent(daoId: string, navigatorAddress: string, vault: string, createdAt: string): Promise<void> {
    const dao = validateAndNormalizeAddress(daoId, 'daoId');
    const nav = validateAndNormalizeAddress(navigatorAddress, 'navigatorAddress');
    const vlt = validateAndNormalizeAddress(vault, 'vault');
    const { error } = await this.withDbTimeout(
      this.client.from('ds_navigator_sanction_intents')
        .upsert({ dao_id: dao, navigator_address: nav, vault: vlt, created_at: createdAt }, { onConflict: 'dao_id,navigator_address' }),
      'writeSanctionIntent',
    );
    if (error) throw new Error(`Failed to write sanction intent for ${nav}@${dao}: ${error.message}`);
  }

  /** Clear all held sanction intents for a DAO (full-set, last-write-wins replacement). */
  async deleteSanctionIntentsForDao(daoId: string): Promise<void> {
    const dao = validateAndNormalizeAddress(daoId, 'daoId');
    const { error } = await this.withDbTimeout(
      this.client.from('ds_navigator_sanction_intents').delete().eq('dao_id', dao),
      'deleteSanctionIntentsForDao',
    );
    if (error) throw new Error(`Failed to delete sanction intents for ${dao}: ${error.message}`);
  }

  async consumeSanctionIntent(daoAddress: string, navigatorAddress: string): Promise<string | null> {
    const dao = validateAndNormalizeAddress(daoAddress, 'daoAddress');
    const nav = validateAndNormalizeAddress(navigatorAddress, 'navigatorAddress');
    const { data, error } = await this.withDbTimeout(
      this.client.from('ds_navigator_sanction_intents')
        .delete()
        .eq('dao_id', dao)
        .eq('navigator_address', nav)
        .select('vault'),
      'consumeSanctionIntent',
    );
    if (error) {
      logger.warn({ daoAddress: dao, navigatorAddress: nav, error: error.message }, 'Failed to consume sanction intent (non-fatal)');
      return null;
    }
    return Array.isArray(data) && data.length > 0 ? (data[0] as { vault: string }).vault : null;
  }

  async findOrphanNavigator(navigatorAddress: string): Promise<Record<string, unknown> | null> {
    const normalized = validateAndNormalizeAddress(navigatorAddress, 'navigatorAddress');
    const { data, error } = await this.withDbTimeout(
      this.client.from('ds_navigators')
        .select('id, dao_id, deployer, navigator_type, name, description')
        .eq('navigator_address', normalized)
        .is('dao_id', null)
        .limit(1),
      'findOrphanNavigator',
    );
    if (error) {
      logger.warn({ navigatorAddress: normalized, error: error.message }, 'Failed to find orphan navigator (non-fatal)');
      return null;
    }
    return data && data.length > 0 ? data[0] as Record<string, unknown> : null;
  }

  /**
   * H1: Look up a navigator by address, returning the fields needed to verify
   * allowlist posts against cached on-chain metadata (deployer, daoShip
   * encoded in the id prefix, cached allowlist_root, and current dao_id).
   * Replaces the per-post on-chain RPC verification path.
   *
   * Returns null if no row exists (post should be rejected — NavigatorDeployed
   * has not been indexed for this address).
   */
  async getNavigatorByAddress(navigatorAddress: string): Promise<{
    id: string;
    dao_id: string | null;
    deployer: string | null;
    allowlist_root: string | null;
  } | null> {
    const normalized = validateAndNormalizeAddress(navigatorAddress, 'navigatorAddress');
    const { data, error } = await this.withDbTimeout(
      this.client.from('ds_navigators')
        .select('id, dao_id, deployer, allowlist_root')
        .eq('navigator_address', normalized)
        .limit(1),
      'getNavigatorByAddress',
    );
    if (error) {
      throw new Error(`Failed to look up navigator ${normalized}: ${error.message}`);
    }
    return data && data.length > 0
      ? data[0] as { id: string; dao_id: string | null; deployer: string | null; allowlist_root: string | null }
      : null;
  }

  // ── Lookup Helpers ─────────────────────────────────────────────

  async *getAllDaosIterator(): AsyncGenerator<DaoSummary> {
    const PAGE_SIZE = 1000;
    let offset = 0;

    while (true) {
      const { data, error } = await this.client
        .from('ds_daos')
        .select('id, shares_address, loot_address, avatar')
        .order('id')
        .range(offset, offset + PAGE_SIZE - 1);

      if (error) throw new Error(`Failed to get DAOs: ${error.message}`);
      if (!data || data.length === 0) break;

      for (const dao of data) {
        yield dao as DaoSummary;
      }

      if (data.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
    }
  }

  async *getActiveNavigatorsIterator(): AsyncGenerator<{ navigator_address: string; dao_id: string }> {
    const PAGE_SIZE = 1000;
    let offset = 0;

    while (true) {
      const { data, error } = await this.client
        .from('ds_navigators')
        .select('navigator_address, dao_id')
        .eq('is_active', true)
        .order('id')
        .range(offset, offset + PAGE_SIZE - 1);

      if (error) throw new Error(`Failed to get navigators: ${error.message}`);
      if (!data || data.length === 0) break;

      for (const row of data) {
        yield row as { navigator_address: string; dao_id: string };
      }

      if (data.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
    }
  }

  // ── Event Transactions ─────────────────────────────────────────

  async recordEventTransaction(txHash: string, daoId: string | null, blockNumber: number, timestamp: Date): Promise<void> {
    const validated: Omit<EventTransactionRow, 'dao_id'> & { dao_id: string | null } = {
      id: validateBytes32(txHash, 'txHash'),
      dao_id: daoId,
      created_at: timestamp.toISOString(),
      block_number: blockNumber,
    };
    const { error } = await this.withDbTimeout(
      this.client.from('ds_event_transactions').upsert(validated, { onConflict: 'id' }),
      'recordEventTransaction',
    );
    if (error) {
      // Best-effort — tx recording is supplementary; warn-log suffices for monitoring.
      logger.warn({ error, txHash }, 'Failed to record event transaction');
    }
  }

  // ── Processed Log Deduplication ─────────────────────────────────
  // Tracks which (txHash, logIndex) pairs have been successfully processed.
  // Prevents double-processing when a block range is retried after a
  // transient error partway through processLogs().

  async getProcessedLogKeys(fromBlock: number, toBlock: number): Promise<Set<string>> {
    const PAGE_SIZE = 1000;
    const keys = new Set<string>();
    let offset = 0;

    while (true) {
      const { data, error } = await this.withDbTimeout(
        this.client
          .from('ds_processed_logs')
          .select('tx_hash, log_index')
          .gte('block_number', fromBlock)
          .lte('block_number', toBlock)
          .order('tx_hash')
          .range(offset, offset + PAGE_SIZE - 1),
        'getProcessedLogKeys',
      );

      if (error) throw new Error(`Failed to get processed logs: ${error.message}`);
      if (!data || data.length === 0) break;

      for (const r of data as { tx_hash: string; log_index: number }[]) {
        keys.add(`${r.tx_hash}-${r.log_index}`);
      }
      if (data.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
    }

    return keys;
  }

  async markLogProcessed(txHash: string, logIndex: number, blockNumber: number): Promise<void> {
    const { error } = await this.withDbTimeout(
      this.client
        .from('ds_processed_logs')
        .upsert(
          { tx_hash: txHash, log_index: logIndex, block_number: blockNumber },
          { onConflict: 'tx_hash,log_index' },
        ),
      'markLogProcessed',
    );
    if (error) throw new Error(`Failed to mark log as processed: ${error.message}`);
  }

  /**
   * Option B P5.1 — batch end-of-range dedup write. Safe ONLY when every
   * handler dispatched in the range is idempotent (their own RPCs either
   * embed a dedup check like `ds_apply_transfer`, or derive-from-truth
   * so replay is a no-op). The dispatcher's `isHandlerIdempotent` gate
   * is the enforcement point — `BlockProcessor.processLogs` refuses the
   * batched path if it sees a non-idempotent handler.
   *
   * Chunked at `BATCH_CAP` per call to stay under Supabase's statement
   * timeout (default ~8s). At 50 ms median upsert-per-row via
   * single-row API, 1000 rows batched = one ~500 ms RTT instead of
   * 1000 × 50 ms = 50 s of sequential work (Security B4).
   */
  async markLogsProcessedBatch(
    rows: Array<{ txHash: string; logIndex: number; blockNumber: number }>,
  ): Promise<void> {
    if (rows.length === 0) return;
    const BATCH_CAP = 1000;
    for (let i = 0; i < rows.length; i += BATCH_CAP) {
      const chunk = rows.slice(i, i + BATCH_CAP).map((r) => ({
        tx_hash: r.txHash,
        log_index: r.logIndex,
        block_number: r.blockNumber,
      }));
      const { error } = await this.withDbTimeout(
        this.client
          .from('ds_processed_logs')
          .upsert(chunk, { onConflict: 'tx_hash,log_index', ignoreDuplicates: true }),
        `markLogsProcessedBatch:${chunk.length}`,
      );
      if (error) throw new Error(`Failed batched markLogProcessed (${chunk.length} rows): ${error.message}`);
    }
  }

  /**
   * H4: Prune old processed_logs entries that are no longer needed for dedup.
   * Rows are only useful during the retry window (current block range) and the
   * reorg walk-back window. Once a block is well past both, its dedup entries
   * can be safely deleted.
   */
  async pruneProcessedLogs(currentBlock: number, reorgWalkBack: number): Promise<void> {
    const cutoff = currentBlock - (reorgWalkBack * 2); // 2x safety margin
    if (cutoff <= 0) return;
    // SC7: Skip the DELETE RTT if we've already pruned at this cutoff or
    // higher. In steady-state polling the cutoff advances every range so this
    // only fires on retries-after-failure (where `currentBlock` can repeat).
    if (cutoff <= this.lastPrunedCutoff) return;
    try {
      const { error } = await this.client
        .from('ds_processed_logs')
        .delete()
        .lt('block_number', cutoff);
      if (error) {
        logger.warn({ error: error.message, cutoff }, 'Failed to prune processed_logs');
      } else {
        this.lastPrunedCutoff = cutoff;
        logger.debug({ cutoff }, 'Pruned processed_logs');
      }
    } catch (err) {
      // Best-effort — don't let pruning failure affect indexing
      logger.warn({ err, cutoff }, 'Error pruning processed_logs');
    }
  }

  // ── Timeout wrapper for hot-path DB operations ──────────────────
  // Creates an AbortController that cancels the in-flight HTTP request to
  // Supabase/PostgREST when the timeout fires. This prevents orphaned
  // connections from accumulating under sustained Supabase slowness (M4).

  private async withDbTimeout<T>(
    promiseOrBuilder: PromiseLike<T> | { abortSignal: (signal: AbortSignal) => PromiseLike<T> },
    operation: string,
  ): Promise<T> {
    const DB_TIMEOUT_MS = 30000;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, DB_TIMEOUT_MS);

    try {
      // If the builder supports abortSignal, use it to cancel the fetch.
      // Otherwise fall back to Promise.race (for RPC calls that return plain promises).
      if (!('abortSignal' in promiseOrBuilder) || typeof promiseOrBuilder.abortSignal !== 'function') {
        throw new Error(`withDbTimeout: '${operation}' builder does not support abortSignal`);
      }

      return await promiseOrBuilder.abortSignal(controller.signal);
    } catch (err) {
      if (controller.signal.aborted) {
        throw new Error(`Database operation '${operation}' timed out after ${DB_TIMEOUT_MS}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}
