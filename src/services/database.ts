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

const VALID_TABLES = new Set([
  'ds_guild_tokens',
  'ds_ragequits',
  'ds_navigators',
  'ds_navigator_events',
  'ds_records',
  'ds_delegations',
]);

export class DatabaseService {
  // Type uses `any` for schema because the schema name is dynamic (testnet, mainnet, dev)
  readonly client: SupabaseClient<any, string>;

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
    isSyncing: boolean;
  }> {
    const { data, error } = await this.client
      .from('ds_indexer_state')
      .select('last_block_number, last_block_hash, is_syncing')
      .eq('id', 1)
      .single();

    if (error) throw new Error(`Failed to get indexer state: ${error.message}`);
    return {
      blockNumber: data?.last_block_number ?? 0,
      blockHash: data?.last_block_hash ?? null,
      isSyncing: data?.is_syncing ?? false,
    };
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
   * H4: Prune old processed_logs entries that are no longer needed for dedup.
   * Rows are only useful during the retry window (current block range) and the
   * reorg walk-back window. Once a block is well past both, its dedup entries
   * can be safely deleted.
   */
  async pruneProcessedLogs(currentBlock: number, reorgWalkBack: number): Promise<void> {
    const cutoff = currentBlock - (reorgWalkBack * 2); // 2x safety margin
    if (cutoff <= 0) return;
    try {
      const { error } = await this.client
        .from('ds_processed_logs')
        .delete()
        .lt('block_number', cutoff);
      if (error) {
        logger.warn({ error: error.message, cutoff }, 'Failed to prune processed_logs');
      } else {
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
      let promise: PromiseLike<T>;
      if ('abortSignal' in promiseOrBuilder && typeof promiseOrBuilder.abortSignal === 'function') {
        promise = promiseOrBuilder.abortSignal(controller.signal);
      } else {
        promise = promiseOrBuilder as PromiseLike<T>;
      }

      return await promise;
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
