/**
 * TypeScript interfaces for all database models and event structures.
 * Provides compile-time safety for Supabase operations and event handlers.
 */

// ── Database Models ──────────────────────────────────────────────

export interface DaoRow {
  id: string;
  created_at: string;
  updated_at?: string;
  tx_hash: string;
  shares_address: string;
  loot_address: string;
  avatar: string;
  launcher: string | null;
  default_expiry_window: number;
  new_vault: boolean;
  voting_period: number;
  grace_period: number;
  proposal_offering: string;
  quorum_percent: string;
  sponsor_threshold: string;
  min_retention_percent: string;
  loot_paused: boolean;
  shares_paused: boolean;
  admin_locked: boolean;
  manager_locked: boolean;
  governor_locked: boolean;
  total_shares: string;
  total_loot: string;
  active_member_count: number;
  proposal_count: number;
  latest_sponsored_proposal_id: number;
  share_token_name?: string;
  share_token_symbol?: string;
  loot_token_name?: string;
  loot_token_symbol?: string;
  name?: string;
  description?: string;
  avatar_img?: string;
  profile_source: string | null;
}

export interface MemberRow {
  id: string;
  dao_id: string;
  member_address: string;
  shares: string;
  loot: string;
  delegating_to?: string | null;
  voting_power?: string;
  votes?: number;
  last_activity_at?: string;
  created_at: string;
  updated_at?: string;
}

export interface ProposalRow {
  id: string;
  dao_id: string;
  proposal_id: number;
  submitter: string | null;
  created_at: string;
  tx_hash: string;
  proposal_data_hash: string;
  proposal_data?: string;
  voting_period: number;
  expiration?: string | null;
  self_sponsored?: boolean;
  details?: string;
  proposal_offering?: string;
  sponsored: boolean;
  sponsor?: string;
  sponsor_tx_hash?: string;
  sponsor_tx_at?: string;
  voting_starts?: string;
  voting_ends?: string;
  grace_ends?: string;
  cancelled: boolean;
  cancelled_by?: string | null;
  cancelled_tx_hash?: string;
  cancelled_tx_at?: string;
  processed: boolean;
  processed_by?: string | null;
  process_tx_hash?: string;
  process_tx_at?: string;
  passed: boolean;
  action_failed: boolean;
  yes_balance: string;
  no_balance: string;
  yes_votes: number;
  no_votes: number;
  max_total_shares_and_loot_at_vote: string;
  max_total_shares_at_sponsor?: string;
  block_number?: number;
}

export interface VoteRow {
  id: string;
  dao_id: string;
  /** M19: Composite proposal row ID (dao_id-proposalNumber), NOT the numeric proposal_id from ProposalRow */
  proposal_id: string;
  voter: string;
  approved: boolean;
  balance: string;
  created_at: string;
  tx_hash: string;
  block_number?: number;
}

export interface NavigatorRow {
  id: string;
  dao_id: string;
  navigator_address: string;
  permission: number;
  permission_label: string;
  is_active: boolean;
  paused: boolean;
  navigator_type: string;
  name?: string;
  description?: string;
  created_at: string;
  tx_hash: string;
}

export interface RagequitRow {
  id: string;
  dao_id: string;
  member_address: string;
  to_address: string;
  shares_burned: string;
  loot_burned: string;
  tokens: string[];
  amounts: string[];
  tx_hash: string;
  created_at: string;
  block_number?: number;
}

export interface RecordRow {
  id: string;
  dao_id: string;
  created_at: string;
  user_address: string;
  tx_hash: string;
  tag: string;
  content_type: string;
  content: string;
  content_json?: Record<string, unknown>;
  trust_level?: string;
  block_number?: number;
}

export interface GuildTokenRow {
  id: string;
  dao_id: string;
  token_address: string;
  enabled: boolean;
  created_at: string;
  tx_hash: string;
}

export interface DelegationRow {
  dao_id: string;
  delegator: string;
  from_delegate: string;
  to_delegate: string;
  tx_hash: string;
  created_at: string;
}

export interface NavigatorEventRow {
  id: string;
  dao_id: string;
  navigator_address: string;
  event_type: 'onboard';
  contributor: string;
  shares_minted: string;
  loot_minted: string;
  amount: string;
  metadata: Record<string, unknown> | null;
  tx_hash: string;
  block_number: number;
  created_at: string;
}

export interface EventTransactionRow {
  id: string;
  dao_id: string | null;
  block_number: number;
  created_at: string;
}

export interface IndexerStateRow {
  id: number;
  last_block_number: number;
  last_block_hash: string | null;
  last_indexed_at: string;
  is_syncing: boolean;
}

// ── Partial update types ────────────────────────────────────────

export type DaoUpdate = Partial<Omit<DaoRow, 'id'>>;
export type ProposalUpdate = Partial<Omit<ProposalRow, 'id' | 'dao_id' | 'proposal_id'>>;
export type MemberUpsert = Partial<MemberRow> & Pick<MemberRow, 'id' | 'dao_id' | 'member_address'>;

// ── DAO summary for registry loading ────────────────────────────

export interface DaoSummary {
  id: string;
  shares_address: string;
  loot_address: string;
  avatar: string;
}
