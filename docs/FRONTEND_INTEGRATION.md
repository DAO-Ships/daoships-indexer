# DAO Ships Indexer -- Frontend Integration Guide

Production-ready query patterns, realtime subscriptions, and Poster integration for building frontends against the DAO Ships indexer.

---

## 1. Quick Start

### Install

```bash
npm install @supabase/supabase-js
```

### Client Setup

The indexer uses **PostgreSQL schema isolation** -- each network (testnet, mainnet, dev) lives in its own schema. Pass the schema name via the `db` option:

```typescript
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://your-project.supabase.co';
const SUPABASE_ANON_KEY = 'your-anon-key';

// Schema corresponds to the network: 'testnet', 'mainnet', or 'dev'
const NETWORK_SCHEMA = 'testnet';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  db: { schema: NETWORK_SCHEMA },
});
```

### Fetch Your First DAO

```typescript
const { data: dao, error } = await supabase
  .from('ds_daos')
  .select('*')
  .limit(1)
  .single();

if (error) {
  console.error('Failed to fetch DAO:', error.message);
} else {
  console.log('DAO:', dao.id, dao.name);
}
```

### TypeScript Types

Copy these row types into your frontend. They mirror the database columns exactly. Large numeric fields (`total_shares`, `total_loot`, balances) are represented as `string` because they are `NUMERIC(78,0)` -- too large for JavaScript `number`. Use `BigInt()` when doing arithmetic.

```typescript
// ── Core Row Types ──────────────────────────────────────────

export interface DaoRow {
  id: string;                          // DAO contract address (0x...)
  created_at: string;                  // ISO timestamp
  updated_at?: string;
  tx_hash: string;
  shares_address: string;              // ERC20 shares token
  loot_address: string;                // ERC20 loot token
  avatar: string;                      // vault/treasury address
  launcher: string | null;             // deployer wallet
  default_expiry_window: number;       // seconds
  new_vault: boolean;
  voting_period: number;               // seconds
  grace_period: number;                // seconds
  proposal_offering: string;           // wei (NUMERIC string)
  quorum_percent: string;
  sponsor_threshold: string;
  min_retention_percent: string;
  loot_paused: boolean;
  shares_paused: boolean;
  admin_locked: boolean;
  manager_locked: boolean;
  governor_locked: boolean;
  total_shares: string;                // NUMERIC string
  total_loot: string;                  // NUMERIC string
  active_member_count: number;
  proposal_count: number;
  latest_sponsored_proposal_id: number;
  share_token_name?: string;
  share_token_symbol?: string;
  loot_token_name?: string;
  loot_token_symbol?: string;
  name?: string;                       // from Poster profile
  description?: string;                // from Poster profile
  avatar_img?: string;                 // from Poster profile
  profile_source: string | null;       // 'launcher' | 'vault' | null
}

export interface MemberRow {
  id: string;                          // composite: daoId-memberAddress
  dao_id: string;
  member_address: string;
  shares: string;                      // NUMERIC string
  loot: string;                        // NUMERIC string
  delegating_to?: string | null;
  voting_power?: string;               // NUMERIC string (delegated power)
  votes?: number;
  last_activity_at?: string;
  created_at: string;
  updated_at?: string;
}

export interface ProposalRow {
  id: string;                          // composite: daoId-proposalNumber
  dao_id: string;
  proposal_id: number;                 // sequential number within the DAO
  submitter: string | null;
  created_at: string;
  tx_hash: string;
  proposal_data_hash: string;
  proposal_data?: string;
  voting_period: number;
  expiration?: string | null;          // ISO timestamp or null
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
  proposal_id: string;                 // composite row ID, NOT the numeric proposal_id
  voter: string;
  approved: boolean;
  balance: string;                     // voting weight at time of vote
  created_at: string;
  tx_hash: string;
  block_number?: number;
}

export interface NavigatorRow {
  id: string;
  dao_id: string;
  navigator_address: string;
  deployer?: string;                   // Address that deployed this navigator (from NavigatorDeployed event)
  permission: number;                  // Bitmask: 0=none, 1=admin, 2=manager, 3=admin+manager, 4=governor, 5=admin+governor, 6=manager+governor, 7=all
  permission_label: string;            // 'none' | 'admin' | 'manager' | 'admin_manager' | 'governor' | 'admin_governor' | 'manager_governor' | 'all'
  is_active: boolean;
  paused: boolean;
  navigator_type: string;             // e.g. 'OnboarderNavigator' (from NavigatorDeployed event)
  name?: string;                       // Human-readable name (from NavigatorDeployed event)
  description?: string;                // Human-readable description (from NavigatorDeployed event)
  created_at: string;
  tx_hash: string;
}

export interface RecordRow {
  id: string;
  dao_id: string;
  created_at: string;
  user_address: string;
  tx_hash: string;
  tag: string;                         // e.g. 'daoships.dao.profile'
  content_type: string;                // 'application/json' | 'text/plain'
  content: string;                     // raw content string
  content_json?: Record<string, unknown>;  // validated+parsed JSON
  trust_level?: string;                // 'VERIFIED' | 'VERIFIED_INITIAL' | 'SEMI_TRUSTED' | 'MEMBER' | 'UNTRUSTED'
  block_number?: number;
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

export interface GuildTokenRow {
  id: string;
  dao_id: string;
  token_address: string;
  enabled: boolean;
  created_at: string;
  tx_hash: string;
}

export interface IndexerStateRow {
  id: number;
  last_block_number: number;
  last_block_hash: string | null;
  last_indexed_at: string;
  is_syncing: boolean;
}

// ── Proposal Status (computed, not stored) ──────────────────

export type ProposalStatus =
  | 'unborn'
  | 'submitted'
  | 'voting'
  | 'grace'
  | 'ready'
  | 'processed'
  | 'cancelled'
  | 'defeated'
  | 'expired';

// ── Trust Levels ────────────────────────────────────────────

export type TrustLevel =
  | 'VERIFIED'
  | 'VERIFIED_INITIAL'
  | 'SEMI_TRUSTED'
  | 'MEMBER'
  | 'UNTRUSTED';
```

---

## 2. Query Patterns

### DAO Queries

#### List all DAOs (paginated)

```typescript
async function listDaos(page: number, pageSize = 20) {
  const from = page * pageSize;
  const to = from + pageSize - 1;

  const { data, error, count } = await supabase
    .from('ds_daos')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(from, to);

  if (error) throw new Error(`listDaos: ${error.message}`);
  return { daos: data as DaoRow[], total: count };
}
```

#### Get single DAO by ID

```typescript
async function getDao(daoId: string) {
  const { data, error } = await supabase
    .from('ds_daos')
    .select('*')
    .eq('id', daoId.toLowerCase())
    .single();

  if (error) throw new Error(`getDao: ${error.message}`);
  return data as DaoRow;
}
```

#### Search DAOs by name

```typescript
async function searchDaos(query: string) {
  const { data, error } = await supabase
    .from('ds_daos')
    .select('id, name, description, avatar_img, active_member_count, proposal_count')
    .ilike('name', `%${query}%`)
    .order('active_member_count', { ascending: false })
    .limit(20);

  if (error) throw new Error(`searchDaos: ${error.message}`);
  return data;
}
```

#### Get DAO governance config

```typescript
async function getDaoGovernance(daoId: string) {
  const { data, error } = await supabase
    .from('ds_daos')
    .select(`
      voting_period,
      grace_period,
      voting_plus_grace_duration,
      proposal_offering,
      quorum_percent,
      sponsor_threshold,
      min_retention_percent,
      default_expiry_window,
      admin_locked,
      manager_locked,
      governor_locked,
      shares_paused,
      loot_paused
    `)
    .eq('id', daoId.toLowerCase())
    .single();

  if (error) throw new Error(`getDaoGovernance: ${error.message}`);
  return data;
}
```

#### Get DAO with member count and proposal count

These are pre-computed columns on `ds_daos`, not aggregations you need to compute:

```typescript
async function getDaoSummary(daoId: string) {
  const { data, error } = await supabase
    .from('ds_daos')
    .select(`
      id, name, description, avatar_img,
      active_member_count, proposal_count,
      total_shares, total_loot,
      share_token_symbol, loot_token_symbol
    `)
    .eq('id', daoId.toLowerCase())
    .single();

  if (error) throw new Error(`getDaoSummary: ${error.message}`);
  return data;
}
```

---

### Member Queries

#### List members of a DAO (sorted by shares)

```typescript
async function listMembers(daoId: string, page = 0, pageSize = 50) {
  const from = page * pageSize;
  const to = from + pageSize - 1;

  const { data, error, count } = await supabase
    .from('ds_members')
    .select('*', { count: 'exact' })
    .eq('dao_id', daoId.toLowerCase())
    .order('shares', { ascending: false })
    .range(from, to);

  if (error) throw new Error(`listMembers: ${error.message}`);
  return { members: data as MemberRow[], total: count };
}
```

#### Get a specific member's balances

The member ID is a composite key: `{daoId}-{memberAddress}` (both lowercase).

```typescript
async function getMember(daoId: string, memberAddress: string) {
  const memberId = `${daoId.toLowerCase()}-${memberAddress.toLowerCase()}`;

  const { data, error } = await supabase
    .from('ds_members')
    .select('*')
    .eq('id', memberId)
    .single();

  if (error) throw new Error(`getMember: ${error.message}`);
  return data as MemberRow;
}
```

#### Check if an address is a member of a DAO

```typescript
async function isMember(daoId: string, address: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('ds_members')
    .select('shares, loot')
    .eq('dao_id', daoId.toLowerCase())
    .eq('member_address', address.toLowerCase())
    .maybeSingle();

  if (error) throw new Error(`isMember: ${error.message}`);
  if (!data) return false;
  return BigInt(data.shares) > 0n || BigInt(data.loot) > 0n;
}
```

#### Get top delegates (by voting power)

```typescript
async function getTopDelegates(daoId: string, limit = 10) {
  const { data, error } = await supabase
    .from('ds_members')
    .select('member_address, shares, voting_power, delegating_to')
    .eq('dao_id', daoId.toLowerCase())
    .gt('voting_power', '0')
    .order('voting_power', { ascending: false })
    .limit(limit);

  if (error) throw new Error(`getTopDelegates: ${error.message}`);
  return data;
}
```

#### Get member activity (recent voters)

```typescript
async function getRecentlyActiveMembers(daoId: string, limit = 20) {
  const { data, error } = await supabase
    .from('ds_members')
    .select('member_address, votes, last_activity_at, shares')
    .eq('dao_id', daoId.toLowerCase())
    .not('last_activity_at', 'is', null)
    .order('last_activity_at', { ascending: false })
    .limit(limit);

  if (error) throw new Error(`getRecentlyActiveMembers: ${error.message}`);
  return data;
}
```

#### Get all DAOs a wallet belongs to

```typescript
async function getDaosForWallet(walletAddress: string) {
  const { data, error } = await supabase
    .from('ds_members')
    .select(`
      dao_id,
      shares,
      loot,
      voting_power,
      ds_daos!inner (
        id, name, avatar_img, active_member_count
      )
    `)
    .eq('member_address', walletAddress.toLowerCase())
    .or('shares.gt.0,loot.gt.0');

  if (error) throw new Error(`getDaosForWallet: ${error.message}`);
  return data;
}
```

---

### Proposal Queries

#### List proposals for a DAO

Proposals are stored with raw boolean fields (`cancelled`, `processed`, `passed`, `sponsored`) and timestamps (`voting_ends`, `grace_ends`, `expiration`). **Status is computed client-side.** See Section 5 for the computation function.

```typescript
async function listProposals(daoId: string, page = 0, pageSize = 20) {
  const from = page * pageSize;
  const to = from + pageSize - 1;

  const { data, error, count } = await supabase
    .from('ds_proposals')
    .select('*', { count: 'exact' })
    .eq('dao_id', daoId.toLowerCase())
    .order('proposal_id', { ascending: false })
    .range(from, to);

  if (error) throw new Error(`listProposals: ${error.message}`);

  const proposals = (data as ProposalRow[]).map((p) => ({
    ...p,
    status: computeProposalStatus(p),
  }));

  return { proposals, total: count };
}
```

#### Get single proposal with vote tallies

```typescript
async function getProposal(daoId: string, proposalNumber: number) {
  const proposalId = `${daoId.toLowerCase()}-${proposalNumber}`;

  const { data, error } = await supabase
    .from('ds_proposals')
    .select('*')
    .eq('id', proposalId)
    .single();

  if (error) throw new Error(`getProposal: ${error.message}`);

  const proposal = data as ProposalRow;
  return {
    ...proposal,
    status: computeProposalStatus(proposal),
  };
}
```

#### List active proposals (voting or grace period)

There is no stored `status` column. Filter on the raw fields instead:

```typescript
async function getActiveProposals(daoId: string) {
  const now = new Date().toISOString();

  const { data, error } = await supabase
    .from('ds_proposals')
    .select('*')
    .eq('dao_id', daoId.toLowerCase())
    .eq('cancelled', false)
    .eq('processed', false)
    .eq('sponsored', true)
    .gt('grace_ends', now)  // grace period hasn't ended yet
    .order('proposal_id', { ascending: false });

  if (error) throw new Error(`getActiveProposals: ${error.message}`);

  return (data as ProposalRow[]).map((p) => ({
    ...p,
    status: computeProposalStatus(p),
  }));
}
```

#### Get proposal votes (with voter addresses)

```typescript
async function getProposalVotes(daoId: string, proposalNumber: number) {
  const proposalId = `${daoId.toLowerCase()}-${proposalNumber}`;

  const { data, error } = await supabase
    .from('ds_votes')
    .select('voter, approved, balance, created_at, tx_hash')
    .eq('proposal_id', proposalId)
    .order('created_at', { ascending: true });

  if (error) throw new Error(`getProposalVotes: ${error.message}`);
  return data as VoteRow[];
}
```

#### Get proposals awaiting processing ("ready" state)

```typescript
async function getReadyProposals(daoId: string) {
  const now = new Date().toISOString();

  const { data, error } = await supabase
    .from('ds_proposals')
    .select('*')
    .eq('dao_id', daoId.toLowerCase())
    .eq('cancelled', false)
    .eq('processed', false)
    .eq('sponsored', true)
    .lt('grace_ends', now)  // grace period has ended
    .order('proposal_id', { ascending: true });

  if (error) throw new Error(`getReadyProposals: ${error.message}`);

  // Further filter out expired proposals client-side
  return (data as ProposalRow[])
    .filter((p) => !p.expiration || new Date(p.expiration) > new Date())
    .map((p) => ({ ...p, status: 'ready' as ProposalStatus }));
}
```

#### Get unsponsored proposals

```typescript
async function getUnsponsoredProposals(daoId: string) {
  const { data, error } = await supabase
    .from('ds_proposals')
    .select('*')
    .eq('dao_id', daoId.toLowerCase())
    .eq('sponsored', false)
    .eq('cancelled', false)
    .order('created_at', { ascending: false });

  if (error) throw new Error(`getUnsponsoredProposals: ${error.message}`);
  return data as ProposalRow[];
}
```

---

### Navigator Queries

#### List navigators for a DAO

```typescript
async function listNavigators(daoId: string) {
  const { data, error } = await supabase
    .from('ds_navigators')
    .select('*')
    .eq('dao_id', daoId.toLowerCase())
    .eq('is_active', true)
    .order('created_at', { ascending: true });

  if (error) throw new Error(`listNavigators: ${error.message}`);
  return data as NavigatorRow[];
}
```

#### Get navigator by type

```typescript
async function getNavigatorsByType(daoId: string, navigatorType: string) {
  const { data, error } = await supabase
    .from('ds_navigators')
    .select('*')
    .eq('dao_id', daoId.toLowerCase())
    .eq('navigator_type', navigatorType)
    .eq('is_active', true);

  if (error) throw new Error(`getNavigatorsByType: ${error.message}`);
  return data as NavigatorRow[];
}
```

#### Get onboard events for a navigator

```typescript
async function getOnboardEvents(
  daoId: string,
  navigatorAddress: string,
  page = 0,
  pageSize = 50,
) {
  const from = page * pageSize;
  const to = from + pageSize - 1;

  const { data, error, count } = await supabase
    .from('ds_navigator_events')
    .select('*', { count: 'exact' })
    .eq('dao_id', daoId.toLowerCase())
    .eq('navigator_address', navigatorAddress.toLowerCase())
    .eq('event_type', 'onboard')
    .order('created_at', { ascending: false })
    .range(from, to);

  if (error) throw new Error(`getOnboardEvents: ${error.message}`);
  return { events: data as NavigatorEventRow[], total: count };
}
```

#### Check navigator pause status

```typescript
async function isNavigatorPaused(daoId: string, navigatorAddress: string): Promise<boolean> {
  const navigatorId = `${daoId.toLowerCase()}-${navigatorAddress.toLowerCase()}`;

  const { data, error } = await supabase
    .from('ds_navigators')
    .select('paused')
    .eq('id', navigatorId)
    .single();

  if (error) throw new Error(`isNavigatorPaused: ${error.message}`);
  return data.paused;
}
```

---

### Poster / Records Queries

Records are stored in `ds_records`. Each record has a `tag`, `trust_level`, and optionally validated `content_json`. Use `tag` filtering and `trust_level` to retrieve the right data.

#### Get DAO profile (latest, verified)

```typescript
async function getDaoProfile(daoId: string) {
  // Try vault-verified profile first, fall back to initial
  const { data, error } = await supabase
    .from('ds_records')
    .select('content_json, trust_level, created_at, user_address')
    .eq('dao_id', daoId.toLowerCase())
    .in('tag', ['daoships.dao.profile', 'daoships.dao.profile.initial'])
    .in('trust_level', ['VERIFIED', 'VERIFIED_INITIAL'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`getDaoProfile: ${error.message}`);
  return data;
}
```

#### Get member profiles

```typescript
async function getMemberProfile(daoId: string, memberAddress: string) {
  const { data, error } = await supabase
    .from('ds_records')
    .select('content_json, trust_level, created_at')
    .eq('dao_id', daoId.toLowerCase())
    .eq('user_address', memberAddress.toLowerCase())
    .eq('tag', 'daoships.member.profile')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`getMemberProfile: ${error.message}`);
  return data?.content_json ?? null;
}
```

#### Get vote reasons for a proposal

```typescript
async function getVoteReasons(daoId: string, proposalNumber: number) {
  const { data, error } = await supabase
    .from('ds_records')
    .select('content_json, user_address, trust_level, created_at')
    .eq('dao_id', daoId.toLowerCase())
    .eq('tag', 'daoships.proposal.vote.reason')
    .order('created_at', { ascending: true });

  if (error) throw new Error(`getVoteReasons: ${error.message}`);

  return (data ?? []).filter(
    (r) => r.content_json && (r.content_json as any).proposalId === proposalNumber,
  );
}
```

#### Get DAO announcements

```typescript
async function getDaoAnnouncements(daoId: string) {
  const { data, error } = await supabase
    .from('ds_records')
    .select('content_json, user_address, trust_level, created_at')
    .eq('dao_id', daoId.toLowerCase())
    .eq('tag', 'daoships.dao.announcement')
    .eq('trust_level', 'VERIFIED')
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) throw new Error(`getDaoAnnouncements: ${error.message}`);
  return data;
}
```

---

### Other Queries

#### Get ragequit history

```typescript
async function getRagequitHistory(daoId: string) {
  const { data, error } = await supabase
    .from('ds_ragequits')
    .select('*')
    .eq('dao_id', daoId.toLowerCase())
    .order('created_at', { ascending: false });

  if (error) throw new Error(`getRagequitHistory: ${error.message}`);
  return data as RagequitRow[];
}
```

#### Get delegation history

```typescript
async function getDelegationHistory(daoId: string, delegator: string) {
  const { data, error } = await supabase
    .from('ds_delegations')
    .select('*')
    .eq('dao_id', daoId.toLowerCase())
    .eq('delegator', delegator.toLowerCase())
    .order('created_at', { ascending: false });

  if (error) throw new Error(`getDelegationHistory: ${error.message}`);
  return data as DelegationRow[];
}
```

#### Get guild tokens

```typescript
async function getGuildTokens(daoId: string) {
  const { data, error } = await supabase
    .from('ds_guild_tokens')
    .select('*')
    .eq('dao_id', daoId.toLowerCase())
    .eq('enabled', true);

  if (error) throw new Error(`getGuildTokens: ${error.message}`);
  return data as GuildTokenRow[];
}
```

#### Get indexer sync status (health check)

```typescript
async function getIndexerHealth() {
  const { data, error } = await supabase
    .from('ds_indexer_state')
    .select('*')
    .eq('id', 1)
    .single();

  if (error) throw new Error(`getIndexerHealth: ${error.message}`);

  const state = data as IndexerStateRow;
  const lastIndexedAt = new Date(state.last_indexed_at);
  const staleSecs = (Date.now() - lastIndexedAt.getTime()) / 1000;

  return {
    ...state,
    isHealthy: staleSecs < 120 && !state.is_syncing,
    staleSecs: Math.round(staleSecs),
  };
}
```

---

## 3. Realtime Subscriptions

The following tables have Supabase Realtime enabled with `REPLICA IDENTITY FULL`:

- `ds_daos` -- governance config changes, new DAOs, profile updates
- `ds_proposals` -- sponsorship, vote tallies, processing
- `ds_members` -- share/loot balance changes, delegation changes
- `ds_votes` -- new votes cast
- `ds_records` -- new Poster records (profiles, vote reasons, etc.)
- `ds_navigators` -- navigator added/removed/paused
- `ds_navigator_events` -- onboard events
- `ds_indexer_state` -- sync progress

### Subscribe to DAO updates

```typescript
const daoChannel = supabase
  .channel('dao-updates')
  .on(
    'postgres_changes',
    {
      event: 'UPDATE',
      schema: NETWORK_SCHEMA,
      table: 'ds_daos',
      filter: `id=eq.${daoId}`,
    },
    (payload) => {
      const updated = payload.new as DaoRow;
      console.log('DAO updated:', updated.name, 'members:', updated.active_member_count);
      // Update your UI state here
    },
  )
  .on(
    'postgres_changes',
    {
      event: 'INSERT',
      schema: NETWORK_SCHEMA,
      table: 'ds_members',
      filter: `dao_id=eq.${daoId}`,
    },
    (payload) => {
      const member = payload.new as MemberRow;
      console.log('New member:', member.member_address);
    },
  )
  .subscribe();
```

### Subscribe to proposal state changes

```typescript
const proposalChannel = supabase
  .channel('proposal-updates')
  .on(
    'postgres_changes',
    {
      event: '*',   // INSERT (new proposal), UPDATE (sponsored, processed, etc.)
      schema: NETWORK_SCHEMA,
      table: 'ds_proposals',
      filter: `dao_id=eq.${daoId}`,
    },
    (payload) => {
      const proposal = payload.new as ProposalRow;
      const status = computeProposalStatus(proposal);
      console.log(`Proposal #${proposal.proposal_id}: ${status}`);
    },
  )
  .subscribe();
```

### Subscribe to new votes on a specific proposal

```typescript
const proposalRowId = `${daoId}-${proposalNumber}`;

const voteChannel = supabase
  .channel(`votes-${proposalRowId}`)
  .on(
    'postgres_changes',
    {
      event: 'INSERT',
      schema: NETWORK_SCHEMA,
      table: 'ds_votes',
      filter: `proposal_id=eq.${proposalRowId}`,
    },
    (payload) => {
      const vote = payload.new as VoteRow;
      console.log(`${vote.voter} voted ${vote.approved ? 'YES' : 'NO'} (${vote.balance})`);
    },
  )
  .subscribe();
```

### Subscribe to navigator events (onboards)

```typescript
const onboardChannel = supabase
  .channel('onboard-events')
  .on(
    'postgres_changes',
    {
      event: 'INSERT',
      schema: NETWORK_SCHEMA,
      table: 'ds_navigator_events',
      filter: `dao_id=eq.${daoId}`,
    },
    (payload) => {
      const event = payload.new as NavigatorEventRow;
      console.log(
        `${event.contributor} onboarded via ${event.navigator_address}`,
        `shares: ${event.shares_minted}, tribute: ${event.amount}`,
      );
    },
  )
  .subscribe();
```

### Subscribe to indexer state (sync progress)

Useful for showing a "syncing" indicator in the UI:

```typescript
const syncChannel = supabase
  .channel('indexer-sync')
  .on(
    'postgres_changes',
    {
      event: 'UPDATE',
      schema: NETWORK_SCHEMA,
      table: 'ds_indexer_state',
    },
    (payload) => {
      const state = payload.new as IndexerStateRow;
      if (state.is_syncing) {
        console.log(`Syncing... block ${state.last_block_number}`);
      } else {
        console.log(`Synced to block ${state.last_block_number}`);
      }
    },
  )
  .subscribe();
```

### Subscribe to new Poster records for a DAO

```typescript
const recordChannel = supabase
  .channel('dao-records')
  .on(
    'postgres_changes',
    {
      event: 'INSERT',
      schema: NETWORK_SCHEMA,
      table: 'ds_records',
      filter: `dao_id=eq.${daoId}`,
    },
    (payload) => {
      const record = payload.new as RecordRow;
      console.log(`New ${record.tag} from ${record.user_address}`);
    },
  )
  .subscribe();
```

### Unsubscribe and cleanup

Always clean up subscriptions when components unmount:

```typescript
// Unsubscribe a single channel
await supabase.removeChannel(daoChannel);

// Unsubscribe all channels (on app teardown)
await supabase.removeAllChannels();
```

React cleanup pattern:

```typescript
import { useEffect } from 'react';

function useDaoSubscription(daoId: string, onUpdate: (dao: DaoRow) => void) {
  useEffect(() => {
    const channel = supabase
      .channel(`dao-${daoId}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: NETWORK_SCHEMA,
          table: 'ds_daos',
          filter: `id=eq.${daoId}`,
        },
        (payload) => onUpdate(payload.new as DaoRow),
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [daoId, onUpdate]);
}
```

---

## 4. Poster Integration (Writing Data)

Writing data through Poster requires an on-chain transaction. Poster is a shared, permissionless contract -- you call `post(content, tag)` and the indexer picks it up from the event log.

### Prerequisites

```typescript
import { quais } from 'quais';
// or: import { ethers } from 'ethers';

const POSTER_ABI = [
  'function post(string content, string tag) external',
];

// Poster is deployed once per network -- use the correct address
const POSTER_ADDRESS = '0x...'; // from deployment-addresses.json

const provider = new quais.BrowserProvider(window.ethereum);
const signer = await provider.getSigner();
const poster = new quais.Contract(POSTER_ADDRESS, POSTER_ABI, signer);
```

### Post a DAO profile (deployer initial)

Called directly by the deployer wallet right after launching a DAO, before governance exists:

```typescript
async function postInitialDaoProfile(daoAddress: string, profile: {
  name: string;
  description: string;
  avatar?: string;       // URL: https://, ipfs://
  banner?: string;       // URL: https://, ipfs://
  links?: Record<string, string>;
  tags?: string[];
  chainId?: number;
}) {
  const content = JSON.stringify({
    schemaVersion: '1.0',
    daoAddress: daoAddress.toLowerCase(),
    ...profile,
  });

  const tx = await poster.post(content, 'daoships.dao.profile.initial');
  await tx.wait();
  return tx.hash;
}
```

### Post a DAO profile via governance proposal

This must be submitted as a proposal that calls Poster from the DAO's vault (avatar) address. The vault is `msg.sender`, so the indexer assigns `VERIFIED` trust.

```typescript
async function encodeDaoProfileProposal(
  daoAddress: string,
  posterAddress: string,
  profile: { name?: string; description?: string; avatar?: string; banner?: string; links?: Record<string, string>; tags?: string[] },
): Promise<string> {
  const posterInterface = new quais.Interface(POSTER_ABI);
  const content = JSON.stringify({
    schemaVersion: '1.0',
    daoAddress: daoAddress.toLowerCase(),
    ...profile,
  });

  const postData = posterInterface.encodeFunctionData('post', [
    content,
    'daoships.dao.profile',
  ]);

  // Encode as MultiSend for the proposal
  // target: posterAddress, value: 0, data: postData
  return encodeProposalData([posterAddress], [0n], [postData]);
}
```

### Post a member profile

Members post directly from their wallet -- no governance needed:

```typescript
async function postMemberProfile(daoAddress: string, profile: {
  name: string;
  bio?: string;
  avatar?: string;
}) {
  const content = JSON.stringify({
    schemaVersion: '1.0',
    daoAddress: daoAddress.toLowerCase(),
    ...profile,
  });

  const tx = await poster.post(content, 'daoships.member.profile');
  await tx.wait();
  return tx.hash;
}
```

### Post a vote reason

Call after submitting your vote on-chain:

```typescript
async function postVoteReason(
  daoAddress: string,
  proposalId: number,
  vote: boolean,
  reason: string,
) {
  const content = JSON.stringify({
    schemaVersion: '1.0',
    daoAddress: daoAddress.toLowerCase(),
    proposalId,
    vote,
    reason,
  });

  const tx = await poster.post(content, 'daoships.proposal.vote.reason');
  await tx.wait();
  return tx.hash;
}
```

### Navigator metadata

Navigator metadata (name, description, deployer, type) is set automatically at deployment via the `NavigatorDeployed` constructor event emitted by all `INavigator`-compliant contracts. No Poster interaction is needed — the indexer fetches the event when the navigator is registered via `NavigatorSet`.

### Tag reference

| Tag | Who Posts | Trust Required | Content Schema |
|-----|----------|---------------|----------------|
| `daoships.dao.profile.initial` | Deployer (directly, at launch) | `VERIFIED_INITIAL` | `{ schemaVersion*, daoAddress*, name*, description*, avatar?, banner?, links?, tags?, chainId? }` |
| `daoships.dao.profile` | DAO vault (via governance proposal) | `VERIFIED` | `{ schemaVersion*, daoAddress*, name?, description?, avatar?, banner?, links?, tags?, chainId? }` |
| `daoships.dao.announcement` | DAO vault (via proposal) | `VERIFIED` | `{ schemaVersion*, daoAddress*, title*, body?, severity? }` |
| `daoships.member.profile` | Member wallet | `MEMBER` | `{ schemaVersion*, daoAddress?, name*, bio?, avatar? }` |
| `daoships.proposal.vote.reason` | Voter wallet | `MEMBER` | `{ schemaVersion*, daoAddress*, proposalId?, vote?, reason* }` |
| `daoships.navigator.allowlist` | Navigator deployer (member) | `MEMBER` | `{ schemaVersion*, daoAddress*, navigatorAddress*, root*, addresses*, treeDump* }` |

> **Note:** All content payloads require a `schemaVersion` field (e.g. `"1.0"`). Posts missing `schemaVersion` are rejected. Maximum content size is **16KB** (hard rejection above 16,384 bytes).

---

## 5. Computed Values

### Proposal Status State Machine

The database stores raw fields. Status is computed at query time using the `ds_get_proposal_status` function on the server side (or client-side with the logic below). The state machine:

```
                      +-----------+
                      | cancelled |
                      +-----^-----+
                            |
  +-----------+     +-------+-------+     +--------+     +-------+     +-------+     +-----+------+
  | submitted | --> |    voting     | --> | grace  | --> | ready | --> | processed  |
  +-----------+     +---------------+     +--------+     +-------+     +-----+------+
       |                                                    |                |
       |                                                    v                v
       +--------------------------------------------->  expired         defeated
```

Transitions:
- **submitted**: Proposal created, not yet sponsored. `sponsored = false`.
- **voting**: Sponsored and `now < voting_ends`.
- **grace**: Voting ended, `now < grace_ends`.
- **ready**: Grace ended, not yet processed, not expired.
- **processed**: `processed = true` and `passed = true`.
- **defeated**: `processed = true` and `passed = false`.
- **cancelled**: `cancelled = true` (can happen at any stage).
- **expired**: `expiration` is set and `now > expiration`.

```typescript
function computeProposalStatus(p: ProposalRow): ProposalStatus {
  if (p.cancelled) return 'cancelled';
  if (p.processed) {
    return p.passed ? 'processed' : 'defeated';
  }
  if (!p.sponsored) return 'submitted';
  if (p.expiration && new Date() > new Date(p.expiration)) return 'expired';
  if (p.voting_ends && new Date() < new Date(p.voting_ends)) return 'voting';
  if (p.grace_ends && new Date() < new Date(p.grace_ends)) return 'grace';
  return 'ready';
}
```

### Active member count semantics

`active_member_count` on `ds_daos` counts members where `shares > 0 OR loot > 0`. This is maintained by the indexer via the `ds_update_active_member_count` function. A member with zero shares and zero loot is considered inactive (they may have ragequit or been slashed).

### Voting power vs shares

- **shares**: The member's own share tokens. Gives both voting rights and economic rights (claim on treasury via ragequit).
- **loot**: Economic-only tokens. Gives claim on treasury but NO voting rights.
- **voting_power**: The total delegated voting power. When other members delegate to you, your `voting_power` increases. This is the value used for vote weight.
- When a member votes, their `balance` on the vote record reflects their voting power at the time of the vote.

### Delegation chain

Delegation is tracked in two places:
- `ds_members.delegating_to`: The current delegate for this member (null = self-delegated).
- `ds_delegations`: Append-only history of all delegation changes.

To resolve who a member is currently delegating to:

```typescript
async function getCurrentDelegate(daoId: string, memberAddress: string) {
  const member = await getMember(daoId, memberAddress);
  return member.delegating_to ?? member.member_address; // null means self-delegated
}
```

---

## 6. Pagination Patterns

### Offset pagination (simple, works for most cases)

```typescript
async function paginatedQuery<T>(
  table: string,
  filters: Record<string, unknown>,
  options: {
    page?: number;
    pageSize?: number;
    orderBy?: string;
    ascending?: boolean;
  } = {},
): Promise<{ data: T[]; total: number | null; page: number; pageSize: number }> {
  const page = options.page ?? 0;
  const pageSize = options.pageSize ?? 20;
  const from = page * pageSize;
  const to = from + pageSize - 1;

  let query = supabase
    .from(table)
    .select('*', { count: 'exact' });

  for (const [key, value] of Object.entries(filters)) {
    query = query.eq(key, value);
  }

  if (options.orderBy) {
    query = query.order(options.orderBy, { ascending: options.ascending ?? false });
  }

  const { data, error, count } = await query.range(from, to);

  if (error) throw new Error(`paginatedQuery(${table}): ${error.message}`);

  return {
    data: data as T[],
    total: count,
    page,
    pageSize,
  };
}

// Usage:
const result = await paginatedQuery<MemberRow>('ds_members', {
  dao_id: daoId,
}, { page: 2, pageSize: 25, orderBy: 'shares', ascending: false });
```

### Cursor-based pagination (for infinite scroll)

Use the last item's sort value as the cursor. More efficient for large datasets and avoids page drift when new data is inserted.

```typescript
async function cursorPaginate<T extends Record<string, unknown>>(
  table: string,
  daoId: string,
  options: {
    cursor?: string;           // ISO timestamp or numeric string
    cursorColumn?: string;     // default: 'created_at'
    pageSize?: number;
    ascending?: boolean;
  } = {},
): Promise<{ data: T[]; nextCursor: string | null }> {
  const pageSize = options.pageSize ?? 20;
  const cursorColumn = options.cursorColumn ?? 'created_at';
  const ascending = options.ascending ?? false;

  let query = supabase
    .from(table)
    .select('*')
    .eq('dao_id', daoId)
    .order(cursorColumn, { ascending })
    .limit(pageSize + 1); // fetch one extra to detect if there's a next page

  if (options.cursor) {
    query = ascending
      ? query.gt(cursorColumn, options.cursor)
      : query.lt(cursorColumn, options.cursor);
  }

  const { data, error } = await query;
  if (error) throw new Error(`cursorPaginate(${table}): ${error.message}`);

  const items = data as T[];
  const hasMore = items.length > pageSize;
  const page = hasMore ? items.slice(0, pageSize) : items;
  const nextCursor = hasMore
    ? String(page[page.length - 1][cursorColumn])
    : null;

  return { data: page, nextCursor };
}

// Usage:
const firstPage = await cursorPaginate<ProposalRow>('ds_proposals', daoId, {
  cursorColumn: 'created_at',
  pageSize: 20,
});

// Next page:
const secondPage = await cursorPaginate<ProposalRow>('ds_proposals', daoId, {
  cursor: firstPage.nextCursor!,
  cursorColumn: 'created_at',
  pageSize: 20,
});
```

### React hook for infinite scroll

```typescript
import { useState, useCallback } from 'react';

function useInfiniteQuery<T extends Record<string, unknown>>(
  table: string,
  daoId: string,
  cursorColumn = 'created_at',
  pageSize = 20,
) {
  const [data, setData] = useState<T[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);

  const loadMore = useCallback(async () => {
    if (loading || !hasMore) return;
    setLoading(true);

    try {
      const result = await cursorPaginate<T>(table, daoId, {
        cursor: cursor ?? undefined,
        cursorColumn,
        pageSize,
      });

      setData((prev) => [...prev, ...result.data]);
      setCursor(result.nextCursor);
      setHasMore(result.nextCursor !== null);
    } finally {
      setLoading(false);
    }
  }, [table, daoId, cursor, cursorColumn, pageSize, loading, hasMore]);

  const reset = useCallback(() => {
    setData([]);
    setCursor(null);
    setHasMore(true);
  }, []);

  return { data, loadMore, hasMore, loading, reset };
}
```
