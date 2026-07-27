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

const SUPABASE_URL = 'https://anpmmwvxzchumfclhvmr.supabase.co';

// Publishable key for AI agents, SDK consumers, and third-party integrations.
// Published deliberately: RLS makes the database read-only and every row is already
// public on-chain, so this is the same class of value as a Firebase web config. It is
// deliberately NOT the key the DAO Ships web client ships -- the two are separate so
// that integration traffic and application traffic have separate quotas.
const SUPABASE_ANON_KEY = 'sb_publishable_BdCkzZNKGhfs1AJUWFsgWw_yh3OhLi2';

// Schema corresponds to the network: 'testnet' (Orchard, chainId 15000),
// 'mainnet' (Quai, chainId 9), or 'dev'. There is no usable default -- the `public`
// schema holds no ds_* tables, so an unset schema fails with PGRST205.
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

Copy these row types into your frontend. They mirror the database columns exactly. Large numeric fields (`total_shares`, `total_loot`, balances) are typed `string` because they are `NUMERIC(78,0)` -- too large for JavaScript `number`. Use `BigInt()` when doing arithmetic.

> **NUMERIC coercion caveat:** PostgREST deserializes `NUMERIC(78,0)` as a JSON **string** for large values but as a JSON **number** for small ones that fit a JS number (e.g. a `poll_id`/`change_id`/`schedule_id` of `0` arrives as `0`, not `"0"`). The TypeScript types below say `string` as the safe contract, but at runtime always coerce before comparing or doing math — `BigInt(String(x))` (or `String(x)` for display). Never strict-equality a NUMERIC id against a string literal (`row.change_id === '0'` can be `false` when the value is the number `0`).

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

// Read-only DAO-binding trust. Permissioned navigators are implicitly 'sanctioned'
// (vouched by NavigatorSet). Read-only navigators (e.g. SignalNavigator) move
// self_asserted → sanctioned via a vault `daoships.dao.navigators` post.
export type NavigatorTrustStatus = 'self_asserted' | 'sanctioned' | 'unsanctioned' | 'fabricated';

export interface NavigatorRow {
  id: string;
  dao_id: string;                      // Bound from NavigatorDeployed for EVERY navigator (no longer null)
  navigator_address: string;
  deployer?: string;                   // Address that deployed this navigator (from NavigatorDeployed event)
  permission: number;                  // Bitmask: 0=none, 1=admin, 2=manager, 3=admin+manager, 4=governor, 5=admin+governor, 6=manager+governor, 7=all
  permission_label: string;            // 'none' | 'admin' | 'manager' | 'admin_manager' | 'governor' | 'admin_governor' | 'manager_governor' | 'all'
  permission_ever_granted: boolean;    // TRUE once a NavigatorSet(>0) was seen — distinguishes a REVOKED nav (true, now perm 0) from a born read-only one (false)
  trust_status: NavigatorTrustStatus;  // see NavigatorTrustStatus — gate read-only navigators' feeds on this
  is_active: boolean;                  // "functional now?" — read-only navigators stay TRUE at permission 0; FALSE on revoke. NOT a proxy for "has permission"
  paused: boolean;
  navigator_type: string;             // 'OnboarderNavigator' | 'ERC20TributeNavigator' | 'NFTGatedNavigator' | 'SignalNavigator' | 'TimelockNavigator' | 'VestingNavigator' | 'BudgetNavigator' | 'SubscriptionNavigator' (from NavigatorDeployed)
  name?: string;                       // Human-readable name (from NavigatorDeployed event)
  description?: string;                // Human-readable description (from NavigatorDeployed event)
  deploy_block?: number;               // Block of NavigatorDeployed
  created_at: string;
  tx_hash: string;
}

// ── SignalNavigator polls (read-only, non-binding) ──────────────
// Materialized ONLY for navigators with trust_status === 'sanctioned'. A poll's
// status is TIME-DERIVED (no status column) — see computeSignalPollStatus below.
export interface SignalPollRow {
  id: string;                          // `${navigator_address}-${poll_id}`
  dao_id: string;
  navigator_address: string;
  poll_id: string;                     // per-navigator, starts at 0 (NUMERIC as string)
  creator: string;
  question: string | null;             // IPFS CID or short text (resolve CIDs off-chain)
  option_count: number;                // 2..10
  snapshot_timestamp: number;          // votingStarts - 1 (weight measured here)
  voting_starts: number;               // unix seconds
  voting_ends: number;                 // unix seconds (half-open window [start, ends))
  cancelled: boolean;
  tally: string[];                     // per-option running totals (index = option), NUMERIC[] as strings
  // Off-chain option labels — daoships.signal.poll Poster post by the poll creator. NULL until
  // that post is seen; render numeric "Option 1..n" while null. options[i] labels option index i.
  options: string[] | null;
  description: string | null;          // optional poll context
  discussion_url: string | null;       // optional forum/discussion link
  labels_updated_at: string | null;    // last-write-wins timestamp of the labels post
  labels_block_number: number | null;
  tx_hash: string;
  block_number: number;
  created_at: string;
  updated_at?: string;
}

export interface SignalVoteRow {
  id: string;                          // `${navigator_address}-${poll_id}-${voter}`
  poll_pk: string;                     // FK → ds_signal_polls.id
  dao_id: string;
  navigator_address: string;
  poll_id: string;
  voter: string;
  option: number;                      // 0..option_count-1
  weight: string;                      // SHARE voting power at snapshot (loot excluded), NUMERIC as string
  tx_hash: string;
  block_number: number;
  created_at: string;
}

export type SignalPollStatus = 'pending' | 'active' | 'ended' | 'cancelled';

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
  event_type: 'onboard';               // currently the only value — NFT claims live in ds_nft_claims, NOT here
  contributor: string;
  shares_minted: string;
  loot_minted: string;
  amount: string;
  metadata: Record<string, unknown> | null;
  tx_hash: string;
  block_number: number;
  created_at: string;
}

// ── NFTGatedNavigator claims (per-token claim ledger) ────────────
// A claim writes BOTH a generic `event_type='onboard'` NavigatorEventRow (activity feed +
// member balances) AND a dedicated ds_nft_claims row (per-token provenance). One row per
// tokenId ever claimed — a tokenId can be claimed exactly once, forever. There is no
// `event_type='nft_claim'`; use this table for "is token #N claimed?" and claim history.
export interface NftClaimRow {
  id: string;                          // `${navigator_address}-${token_id}`
  dao_id: string;
  navigator_address: string;
  token_id: string;                    // NUMERIC as string
  holder: string;                      // claimer at claim time (the NFT may move later; the claim is permanent)
  shares: string;                      // minted shares (NUMERIC string)
  loot: string;                        // minted loot (NUMERIC string)
  tx_hash: string;
  block_number: number;
  created_at: string;
}

// ── TimelockNavigator changes (GOVERNOR — delayed setGovernanceConfig) ──
// Permissioned, so always trust_status='sanctioned'. Status is PARTLY time-derived: the
// stored `status` covers the explicit/terminal states (queued|executed|cancelled); the
// 'executable' and 'expired' states are derived from executable_after / expires_at — see
// computeTimelockStatus below.
export type TimelockChangeStatus = 'queued' | 'executable' | 'expired' | 'executed' | 'cancelled';

export interface TimelockChangeRow {
  id: string;                          // `${navigator_address}-${change_id}`
  dao_id: string;
  navigator_address: string;
  change_id: string;                   // per-navigator, starts at 0 (NUMERIC as string)
  queued_by: string;                   // the DAO avatar (a change is always queued via a passed proposal)
  config_hash: string;                 // keccak256(governanceConfig)
  governance_config: string | null;    // FULL 0x-hex ABI-encoded bytes — required VERBATIM by executeChange(changeId, bytes)
  executable_after: number;            // unix seconds — start of the execution window (second ragequit window)
  expires_at: number;                  // unix seconds — end of the execution window
  status: 'queued' | 'executed' | 'cancelled';  // STORED status only; 'executable'/'expired' are time-derived
  executed_tx: string | null;
  cancelled_tx: string | null;
  tx_hash: string;                     // queue tx
  block_number: number;
  created_at: string;
  updated_at?: string;
}

// Audit feed of every DAOShip GovernanceConfigSet, with the timelock-bypass flag.
// `bypassed_timelock = true` means a config change applied directly (via executeAsGovernance →
// setGovernanceConfig) while the DAO had an active TimelockNavigator — i.e. it skipped the delay.
// The flag is derive-from-truth (resolved end-of-range) and reorg-safe.
export interface GovernanceConfigHistoryRow {
  id: string;                          // `${tx_hash}-${log_index}`
  dao_id: string;
  voting_period: number;
  grace_period: number;
  proposal_offering: string;           // NUMERIC string
  quorum_percent: string;
  sponsor_threshold: string;
  min_retention_percent: string;
  default_expiry_window: number;
  bypassed_timelock: boolean;          // TRUE = direct config change on a timelock-enabled DAO (warn in the UI)
  tx_hash: string;
  block_number: number;
  created_at: string;
  updated_at?: string;
}

// ── VestingNavigator schedules (MANAGER — cliff+linear mint authorization) ──
// Permissioned, so always trust_status='sanctioned'. `claimed` is DERIVE-FROM-TRUTH
// (SUM of ds_vesting_claims.amount) — never read it as authoritative voting/economic weight.
// Member balances come from the paired token Transfer, NOT from these rows. Status and
// `claimable` are time-derived — see computeVestingStatus / vestedAmount below.
export type VestingStatus = 'pending' | 'vesting' | 'fully_vested' | 'revoked';

export interface VestingScheduleRow {
  id: string;                          // `${navigator_address}-${schedule_id}`
  dao_id: string;
  navigator_address: string;
  schedule_id: string;                 // per-navigator, starts at 0 (NUMERIC as string)
  beneficiary: string;
  total_amount: string;                // NUMERIC string
  claimed: string;                     // DERIVED: SUM(ds_vesting_claims.amount) — NUMERIC string
  is_loot: boolean;                    // false = shares (dilutes votes on claim), true = loot (economic only)
  start_time: number;                  // absolute unix seconds (contract resolves a 0 startTime to the creation block)
  cliff_end: number;                   // unix seconds — nothing claimable before this
  vesting_end: number;                 // unix seconds — fully vested at/after this
  revoked: boolean;
  revoked_at: number | null;           // accrual freeze point (null until revoked)
  vested_at_revoke: string | null;     // NUMERIC string, snapshot from ScheduleRevoked
  tx_hash: string;                     // creation tx
  block_number: number;
  created_at: string;
  updated_at?: string;
}

export interface VestingClaimRow {
  id: string;                          // `${tx_hash}-${log_index}`
  schedule_pk: string;                 // FK → ds_vesting_schedules.id
  dao_id: string;
  navigator_address: string;
  schedule_id: string;
  beneficiary: string;
  amount: string;                      // INCREMENTAL amount minted in THIS claim (not cumulative) — NUMERIC string
  is_loot: boolean;
  tx_hash: string;
  block_number: number;
  created_at: string;
}

// ── BudgetNavigator (treasury budgets — vault-MODULE authority) ──
// NOT permissioned and NOT read-only: a budget navigator's authority is being an enabled
// Zodiac MODULE on the DAO's vault. Trust is driven by the vault's EnabledModule/DisabledModule
// events (NOT NavigatorSet, NOT the read-only Poster sanction). So you MUST trust-gate exactly as
// for read-only navigators — join ds_navigators.trust_status (keyed by navigator_address) and
// default the UI to `sanctioned` only. A `self_asserted` budget navigator (deployed but never
// enabled on the vault) is powerless and must not surface its budgets. `total_spent` is
// DERIVE-FROM-TRUTH (SUM of ds_budget_disbursements.amount); the live per-period figure resets
// lazily on-chain, so for exact "remaining" numbers read the contract views remainingThisPeriod /
// remainingTotal rather than trusting the stored cumulative total. Treasury BALANCES come from the
// paired vault Transfer in the same tx, NOT from these rows (don't double-count).
export type BudgetStatus = 'pending' | 'active' | 'ended' | 'cancelled';

export interface BudgetRow {
  id: string;                          // `${navigator_address}-${budget_id}`
  dao_id: string;
  navigator_address: string;
  budget_id: string;                   // per-navigator, starts at 0 (NUMERIC as string)
  manager: string;                     // disbursement authority (mutable via ManagerUpdated)
  token: string;                       // 0x0000…0000 = native QUAI
  allowance_per_period: string;        // NUMERIC string — resets each period (no roll-over)
  total_ceiling: string;               // NUMERIC string — lifetime cap (> 0)
  total_spent: string;                 // DERIVED: SUM(ds_budget_disbursements.amount) — NUMERIC string
  period_length: number;               // seconds
  starts_at: number;                   // absolute unix seconds (contract resolves a 0 startTime to creation block)
  ends_at: number;                     // unix seconds, 0 = perpetual
  cancelled: boolean;                  // irreversible; halts disbursement
  tx_hash: string;                     // creation tx
  block_number: number;
  created_at: string;
  updated_at?: string;
}

export interface BudgetDisbursementRow {
  id: string;                          // `${navigator_address}-${budget_id}-${tx_hash}-${log_index}`
  budget_pk: string;                   // FK → ds_budgets.id
  dao_id: string;
  navigator_address: string;
  budget_id: string;
  recipient: string;
  token: string;
  amount: string;                      // NUMERIC string (gross requested; fee-on-transfer tokens deliver less)
  tx_hash: string;
  block_number: number;
  created_at: string;
}

// Vault module enable/disable feed (ds_vault_module_events) — the BudgetNavigator trust source.
// Append-only, authenticated (emitter == DAO avatar, module == a BudgetNavigator bound to that DAO).
// A navigator's ds_navigators.trust_status/is_active is DERIVED from the latest row here, so this is
// also a human-readable "treasury module enabled/disabled" timeline. You normally trust-gate via
// ds_navigators.trust_status (above); query this feed directly only to render that history.
export interface VaultModuleEventRow {
  id: string;                          // `${tx_hash}-${log_index}`
  dao_id: string;
  vault: string;                       // the avatar that emitted (== dao.avatar)
  navigator_address: string;           // the BudgetNavigator module
  enabled: boolean;                    // true = EnabledModule, false = DisabledModule
  tx_hash: string;
  log_index: number;
  block_number: number;
  created_at: string;
}

// ── SubscriptionNavigator (MANAGER — recurring membership dues) ──
// PERMISSIONED like Vesting (registered via setNavigators → NavigatorSet → trust_status
// 'sanctioned'). Membership is ONE ROW PER MEMBER PER NAVIGATOR (no per-member id), keyed
// `${navigator_address}-${member}`. `paid_through` is the whole enrollment state: the absolute
// unix-seconds timestamp the member is paid up through; 0 ⇒ not enrolled (never enrolled, or
// collected/un-enrolled). Dues/collection touch the cap table — trust-gate the UI: join
// ds_navigators.trust_status (keyed by navigator_address) and default views to `sanctioned`.
// `total_paid` is DERIVE-FROM-TRUTH (SUM of ds_subscription_payments.amount) — never read it as
// an authoritative economic figure. Status is TIME-DERIVED — see computeSubscriptionStatus below.
// Token BALANCES come from the core events (Transfer into the vault on payFee;
// ConvertSharesToLoot/BurnShares + MintLoot on collectFee), NOT these activity feeds.
export type SubscriptionStatus = 'not_enrolled' | 'current' | 'grace' | 'delinquent';

export interface SubscriptionMemberRow {
  id: string;                          // `${navigator_address}-${member}`
  dao_id: string;
  navigator_address: string;
  member: string;
  paid_through: number;                // absolute unix seconds; 0 = not enrolled / collected
  total_paid: string;                  // DERIVED: SUM(ds_subscription_payments.amount) — NUMERIC string
  last_collected_at: string | null;    // ISO timestamp; null until first collection
  tx_hash: string;
  created_at: string;
  updated_at: string;
}

export interface SubscriptionPaymentRow {
  id: string;                          // `${navigator_address}-${member}-${tx_hash}-${log_index}`
  member_pk: string;                   // FK → ds_subscription_members.id
  dao_id: string;
  navigator_address: string;
  member: string;
  payer: string;                       // payFeeFor → differs from member (gift/sponsor)
  token: string;                       // 0x0000…0000 = native QUAI
  amount: string;                      // per-payment — NUMERIC string (SUM for cumulative total_paid)
  periods: string;                     // NUMERIC string
  paid_through: number;                // absolute value after this payment
  tx_hash: string;
  block_number: number;
  created_at: string;
}

export interface SubscriptionCollectionRow {
  id: string;                          // `${navigator_address}-${member}-${tx_hash}-${log_index}`
  member_pk: string;                   // FK → ds_subscription_members.id
  dao_id: string;
  navigator_address: string;
  member: string;
  collector: string;
  shares_removed: string;              // NUMERIC string
  reward: string;                      // loot minted to collector — NUMERIC string
  burned: boolean;                     // true = burnShares, false = convertSharesToLoot
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

> **Two semantics changed — read these before querying navigators:**
> 1. **`is_active` is "functional now?", not "has permission".** A **read-only** navigator
>    (`SignalNavigator`) holds no permission yet is fully functional, so it stays `is_active = true`
>    at `permission = 0`. A **module** navigator (`BudgetNavigator`) is the opposite: `is_active = false`
>    until the vault enables it as a module, then `true`. Otherwise `is_active = false` means revoked,
>    paused-by-governance, or a permissioned navigator deployed-but-not-yet-registered. Filtering
>    `is_active = true` is still the right "show me usable navigators" filter.
> 2. **`dao_id` is bound for every navigator at deploy time** (no more dao-less orphan rows), but for
>    a **read-only** OR **module** navigator that binding is *self-asserted* (anyone can deploy a
>    contract claiming any DAO). **Always gate a read-only or module navigator's UI on `trust_status`**
>    — see below. Permissioned navigators are vouched by `NavigatorSet`, so they are always `sanctioned`.

> **Three trust classes (know which one you're rendering):**
> | Class | Types | Authority / sanction signal | Born trust | `is_active` at perm 0 |
> |---|---|---|---|---|
> | Permissioned | Onboarder, ERC20Tribute, NFTGated, Timelock, Vesting | `NavigatorSet` permission bit | `sanctioned` | n/a (perm > 0) |
> | Read-only | Signal | Poster `daoships.dao.navigators` (vault) | `self_asserted` | `true` |
> | **Module** | **Budget** | **vault `EnabledModule` event** | `self_asserted` | `false` (until enabled) |

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

#### Trust gating for read-only AND module navigators (mandatory)

A `SignalNavigator` or `BudgetNavigator` row looks identical on-chain whether the DAO endorsed it or
not — the only thing separating a real, DAO-sanctioned navigator from injected spam is `trust_status`.
Permissioned navigators are always `'sanctioned'` (vouched by `NavigatorSet`), so gating affects only
the **read-only** (Signal) and **module** (Budget) classes. The two differ in the *sanction signal*:
- **Signal** → a vault `daoships.dao.navigators` Poster post.
- **Budget** → a vault `EnabledModule` event (the indexer derives trust from `ds_vault_module_events`).

Either way the query is the same — filter on `trust_status = 'sanctioned'`:

```typescript
// Default feed: sanctioned only. Works for any gated type (pass 'SignalNavigator' or 'BudgetNavigator').
async function listSanctionedNavigators(daoId: string, navigatorType: string) {
  const { data, error } = await supabase
    .from('ds_navigators')
    .select('*')
    .eq('dao_id', daoId.toLowerCase())
    .eq('navigator_type', navigatorType)
    .eq('trust_status', 'sanctioned');
  if (error) throw new Error(`listSanctionedNavigators: ${error.message}`);
  return data as NavigatorRow[];
}
```

Presentation policy (the indexer labels; the UI decides):
| `trust_status` | Meaning | Default UI |
|---|---|---|
| `sanctioned` | DAO endorsed it — Signal via a `daoships.dao.navigators` proposal, Budget via `vault.enableModule` | **Show** |
| `self_asserted` | Deployed against the DAO but not (yet) endorsed/enabled | Hide behind a "show unverified" toggle / "unverified" badge |
| `unsanctioned` | Endorsement revoked (Signal de-listed, or Budget module disabled) | Hide |
| `fabricated` | (Signal only) weights failed reconciliation against DAO checkpoints | **Never show** |

> **Activity is only materialized for `sanctioned` navigators.** `ds_signal_polls`/`ds_signal_votes`
> (Signal) and `ds_budgets`/`ds_budget_disbursements` (Budget) stay empty for a navigator until the DAO
> sanctions/enables it — the indexer then backfills its history. So "no rows" for a `self_asserted`
> navigator is expected, not a bug.

> **A read-only navigator deployed before its DAO is indexed has NO `ds_navigators` row at all.** The
> resolution gate in `handleNavigatorDeployed` ignores a read-only `NavigatorDeployed` whose `daoShip`
> isn't a known DAO (and the log is not retried) — so it's dropped permanently, recoverable only by
> redeploying after the DAO exists. **Frontends must therefore deploy read-only navigators (Signal)
> post-launch only, never in the launch flow.** Permissioned navigators are recorded even against an
> unknown DAO and promoted by `NavigatorSet`, so they're unaffected.

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

### Signal Poll Queries (SignalNavigator)

Non-binding, share-weighted polls ("temperature checks"). Rows exist only for **sanctioned**
navigators (see trust gating above). Poll **status is time-derived** — never stored — so compute it
client-side exactly as the contract's `pollStatus()` does:

```typescript
function computeSignalPollStatus(poll: SignalPollRow, nowSec = Math.floor(Date.now() / 1000)): SignalPollStatus {
  if (poll.cancelled) return 'cancelled';            // terminal, overrides the rest
  if (nowSec < poll.voting_starts) return 'pending';
  if (nowSec >= poll.voting_ends) return 'ended';
  return 'active';                                    // half-open window [voting_starts, voting_ends)
}
```

#### List a DAO's polls (across all sanctioned navigators)

```typescript
async function listSignalPolls(daoId: string, page = 0, pageSize = 20) {
  const from = page * pageSize;
  const { data, error } = await supabase
    .from('ds_signal_polls')
    .select('*')
    .eq('dao_id', daoId.toLowerCase())
    .order('voting_starts', { ascending: false })
    .range(from, from + pageSize - 1);
  if (error) throw new Error(`listSignalPolls: ${error.message}`);
  return data as SignalPollRow[];
}
```

#### Read one poll's results

`tally` is a per-option array (index = option) the indexer derives from the vote rows — it is the
authoritative, snapshot-weighted result. Do **not** sum `ds_signal_votes` client-side or read on-chain
balances; `weight` is frozen at `voting_starts - 1` and **excludes loot** (shares only).

```typescript
async function getSignalPoll(navigatorAddress: string, pollId: string) {
  const id = `${navigatorAddress.toLowerCase()}-${pollId}`;
  const { data, error } = await supabase.from('ds_signal_polls').select('*').eq('id', id).single();
  if (error) throw new Error(`getSignalPoll: ${error.message}`);
  const poll = data as SignalPollRow;
  const totals = poll.tally.map((t) => BigInt(t));
  const grand = totals.reduce((a, b) => a + b, 0n);
  const percentages = totals.map((t) => (grand === 0n ? 0 : Number((t * 10000n) / grand) / 100));
  return { poll, totals, percentages, status: computeSignalPollStatus(poll) };
}
```

#### Render option labels (with numeric fallback)

The contract stores only `option_count` — the human-readable labels live off-chain in a
`daoships.signal.poll` Poster post by the poll **creator** (`msg.sender == PollCreated.creator`,
`options.length == option_count`, last-write-wins). The indexer applies them to
`ds_signal_polls.options`; the headline stays in `question`. `options` is **null** until that post
is indexed (and the indexer ignores label edits once a poll is `ended`/`cancelled`), so always fall
back to numeric labels:

```typescript
// options[i] is the label for option index i. Null/short → "Option i+1".
function optionLabel(poll: SignalPollRow, i: number): string {
  return poll.options?.[i] ?? `Option ${i + 1}`;
}
// poll.description and poll.discussion_url are optional context the same post may carry.
```

To **set or correct** labels, the poll creator posts `daoships.signal.poll` from the wallet that
opened the poll (a second tx after `createPoll`, since `pollId` must exist first):

```typescript
await poster.post(
  JSON.stringify({
    schemaVersion: '1.0',
    daoAddress,                       // == navigator's NavigatorDeployed.daoShip
    navigatorAddress,
    pollId: Number(pollId),
    options: ['Teal', 'Magenta', 'Slate'], // length MUST equal the poll's optionCount
    description: 'Pick the v2 brand color.',
    discussionUrl: 'https://forum.mydao.xyz/t/brand-color/789',
  }),
  'daoships.signal.poll',
);
```

#### Has a wallet voted? / list voters

```typescript
async function hasVoted(navigatorAddress: string, pollId: string, voter: string) {
  const id = `${navigatorAddress.toLowerCase()}-${pollId}-${voter.toLowerCase()}`;
  const { data } = await supabase.from('ds_signal_votes').select('option').eq('id', id).maybeSingle();
  return data ? { voted: true, option: (data as { option: number }).option } : { voted: false };
}

async function listPollVotes(navigatorAddress: string, pollId: string) {
  const { data, error } = await supabase
    .from('ds_signal_votes')
    .select('voter, option, weight, created_at')
    .eq('navigator_address', navigatorAddress.toLowerCase())
    .eq('poll_id', pollId)
    .order('created_at', { ascending: true });
  if (error) throw new Error(`listPollVotes: ${error.message}`);
  return data as Pick<SignalVoteRow, 'voter' | 'option' | 'weight' | 'created_at'>[];
}
```

> Creating polls and voting are **on-chain writes to the SignalNavigator contract** (not Poster) —
> `createPoll`, `vote`, `cancelPoll`. The indexer reflects them after confirmation. See
> `daoships-app/docs/SIGNAL_NAVIGATOR_SUPPORT.md` for the write flows.

---

### NFT Claim Queries (NFTGatedNavigator)

Per-token claim ledger. A token can be claimed **exactly once, ever** — `ds_nft_claims` is the O(1)
source of truth for "is token #N still claimable?" and for claim provenance. (Onboarding *activity* and
member balances also flow through the generic `ds_navigator_events` `event_type='onboard'` rows; the two
are written together in the same tx and are complementary, not duplicates.)

```typescript
// Is a specific tokenId already claimed? (cheaper than an on-chain navigator.claimed(tokenId) call)
async function isNftClaimed(navigatorAddress: string, tokenId: string): Promise<NftClaimRow | null> {
  const id = `${navigatorAddress.toLowerCase()}-${tokenId}`;
  const { data, error } = await supabase.from('ds_nft_claims').select('*').eq('id', id).maybeSingle();
  if (error) throw new Error(`isNftClaimed: ${error.message}`);
  return (data as NftClaimRow) ?? null;   // null = unclaimed; a row = claimed (holder = original claimer)
}

// Claim history for a navigator (paginated)
async function listNftClaims(navigatorAddress: string, page = 0, pageSize = 50) {
  const from = page * pageSize;
  const { data, error, count } = await supabase
    .from('ds_nft_claims')
    .select('*', { count: 'exact' })
    .eq('navigator_address', navigatorAddress.toLowerCase())
    .order('block_number', { ascending: false })
    .range(from, from + pageSize - 1);
  if (error) throw new Error(`listNftClaims: ${error.message}`);
  return { claims: data as NftClaimRow[], total: count };
}
```

> `holder` is the **claimer at claim time**. The NFT can be sold afterward, but the shares/loot stay with
> the original claimer and the token stays claimed — render `holder` + "claimed" status, never infer
> current ownership from this table.

---

### Timelock Change Queries (TimelockNavigator)

A `TimelockNavigator` (GOVERNOR) wraps `setGovernanceConfig` behind a mandatory delay. Each queued change
lives in `ds_timelock_changes`. Status is **partly time-derived**: `queued`/`executed`/`cancelled` are
stored, but a `queued` row becomes `executable` then `expired` purely by clock — compute it client-side:

```typescript
function computeTimelockStatus(c: TimelockChangeRow, nowSec = Math.floor(Date.now() / 1000)): TimelockChangeStatus {
  if (c.status === 'executed') return 'executed';     // terminal
  if (c.status === 'cancelled') return 'cancelled';   // terminal
  if (nowSec < c.executable_after) return 'queued';   // delay (second ragequit window) still running
  if (nowSec <= c.expires_at) return 'executable';    // crankable now (anyone may call executeChange)
  return 'expired';                                   // window passed; can only be cancelled for bookkeeping
}
```

```typescript
// All changes for a DAO's timelock(s), newest first
async function listTimelockChanges(daoId: string) {
  const { data, error } = await supabase
    .from('ds_timelock_changes')
    .select('*')
    .eq('dao_id', daoId.toLowerCase())
    .order('block_number', { ascending: false });
  if (error) throw new Error(`listTimelockChanges: ${error.message}`);
  return (data as TimelockChangeRow[]).map((c) => ({ ...c, computedStatus: computeTimelockStatus(c) }));
}
```

> **`governance_config` is the only place the full config bytes exist.** On-chain, only the hash is stored.
> To call `executeChange(changeId, governanceConfig)` the dapp must pass these **exact** bytes back
> (`ConfigHashMismatch` otherwise) — read them from this column. Surface a countdown to `executable_after`
> (the second ragequit window) and an "execute" button while `computedStatus === 'executable'`.

**Timelock bypass detection.** `ds_governance_config_history` records every governance-config change with a
`bypassed_timelock` flag. `true` means the change applied **directly** (a proposal called
`setGovernanceConfig` via `executeAsGovernance`, skipping an active TimelockNavigator). The timelock is
advisory on-chain — this flag is how the UI enforces it socially:

```typescript
// Surface a warning banner if any recent config change bypassed an active timelock
async function getBypassedConfigChanges(daoId: string) {
  const { data, error } = await supabase
    .from('ds_governance_config_history')
    .select('*')
    .eq('dao_id', daoId.toLowerCase())
    .eq('bypassed_timelock', true)
    .order('block_number', { ascending: false });
  if (error) throw new Error(`getBypassedConfigChanges: ${error.message}`);
  return data as GovernanceConfigHistoryRow[];
}
```

> The dapp should **route all config changes through `queueChange`** for timelock-enabled DAOs, and **warn**
> on any proposal whose effect shows up here with `bypassed_timelock = true`.

---

### Vesting Schedule Queries (VestingNavigator)

A `VestingNavigator` (MANAGER) mints shares **or** loot on a cliff+linear schedule. Schedules live in
`ds_vesting_schedules`; each `claim` appends to `ds_vesting_claims`. `claimed` on the schedule is the
indexer's derived `SUM` of claim amounts. Status, `vested`, and `claimable` are **time-derived** — mirror
the contract's `_vestedAmount` (linear from `start_time`, with the cliff a delayed unlock of accrued-since-start):

```typescript
function vestedAmount(s: VestingScheduleRow, nowSec = Math.floor(Date.now() / 1000)): bigint {
  const total = BigInt(s.total_amount);
  const effectiveEnd = s.revoked && s.revoked_at != null ? s.revoked_at : nowSec;
  if (effectiveEnd < s.cliff_end) return 0n;                       // before cliff → nothing
  if (effectiveEnd >= s.vesting_end) return total;                 // at/after end → full total (sweeps dust)
  return (total * BigInt(effectiveEnd - s.start_time)) / BigInt(s.vesting_end - s.start_time);
}

function computeVestingStatus(s: VestingScheduleRow, nowSec = Math.floor(Date.now() / 1000)): VestingStatus {
  if (s.revoked) return 'revoked';                                 // accrual frozen at revoked_at
  if (nowSec < s.cliff_end) return 'pending';
  if (nowSec >= s.vesting_end) return 'fully_vested';
  return 'vesting';
}

// claimable = vested(effectiveEnd) - already claimed
function claimable(s: VestingScheduleRow, nowSec = Math.floor(Date.now() / 1000)): bigint {
  const v = vestedAmount(s, nowSec) - BigInt(s.claimed);
  return v > 0n ? v : 0n;
}
```

```typescript
// All schedules for a beneficiary across a DAO's vesting navigator(s)
async function listVestingSchedulesForBeneficiary(daoId: string, beneficiary: string) {
  const { data, error } = await supabase
    .from('ds_vesting_schedules')
    .select('*')
    .eq('dao_id', daoId.toLowerCase())
    .eq('beneficiary', beneficiary.toLowerCase())
    .order('start_time', { ascending: true });
  if (error) throw new Error(`listVestingSchedulesForBeneficiary: ${error.message}`);
  return data as VestingScheduleRow[];
}

// Claim history for one schedule (the incremental mint feed)
async function listVestingClaims(navigatorAddress: string, scheduleId: string) {
  const schedulePk = `${navigatorAddress.toLowerCase()}-${scheduleId}`;
  const { data, error } = await supabase
    .from('ds_vesting_claims')
    .select('*')
    .eq('schedule_pk', schedulePk)
    .order('block_number', { ascending: true });
  if (error) throw new Error(`listVestingClaims: ${error.message}`);
  return data as VestingClaimRow[];
}
```

> **Do not treat vesting as balance.** Unclaimed/unvested tokens don't exist on-chain — they carry no
> voting power and can't be ragequit. Member voting/economic weight comes from `ds_members` (fed by token
> `Transfer`s on each claim), **never** from `total_amount`/`vested`/`claimed`. Use vesting rows only to
> render schedules, progress, and the claim CTA.

> Creating/revoking schedules and claiming are **on-chain writes to the VestingNavigator contract** —
> `createSchedule` (avatar, via proposal), `revoke` (avatar), `claim` (beneficiary or avatar). See
> `daoships-app/docs/VESTING_NAVIGATOR_SUPPORT.md` for the write flows.

---

### Budget Queries (BudgetNavigator)

A `BudgetNavigator` is the **module** trust class — gate every budget query on its navigator's
`trust_status = 'sanctioned'` (it can move treasury funds only while enabled on the vault; see Trust
gating above). Budgets live in `ds_budgets`; each payout appends to `ds_budget_disbursements`.
`total_spent` is the indexer's derived `SUM` of disbursement amounts. **Status and `remaining` are
time-derived / lazily-reset on-chain** — for exact live figures read the contract views
`remainingThisPeriod(id)` / `remainingTotal(id)`; the stored `total_spent` is the lifetime cumulative,
NOT the per-period spend.

```typescript
function computeBudgetStatus(b: BudgetRow, nowSec = Math.floor(Date.now() / 1000)): BudgetStatus {
  if (b.cancelled) return 'cancelled';                          // irreversible
  if (nowSec < b.starts_at) return 'pending';
  if (b.ends_at !== 0 && nowSec >= b.ends_at) return 'ended';
  return 'active';
}

// A budget is exhausted forever once total_spent == total_ceiling.
function ceilingRemaining(b: BudgetRow): bigint {
  const r = BigInt(b.total_ceiling) - BigInt(b.total_spent);
  return r > 0n ? r : 0n;
}
```

```typescript
// Budgets for a DAO — only from SANCTIONED (vault-enabled) budget navigators. Join trust via a
// two-step read (list sanctioned budget navs, then their budgets) or filter client-side on a join.
async function listBudgets(daoId: string) {
  const navs = await listSanctionedNavigators(daoId, 'BudgetNavigator'); // from Trust gating section
  const addrs = navs.map((n) => n.navigator_address);
  if (addrs.length === 0) return [] as BudgetRow[];
  const { data, error } = await supabase
    .from('ds_budgets')
    .select('*')
    .in('navigator_address', addrs)
    .order('created_at', { ascending: false });
  if (error) throw new Error(`listBudgets: ${error.message}`);
  return data as BudgetRow[];
}

// Disbursement feed for one budget (one row per recipient; disburseBatch emits N).
async function listDisbursements(navigatorAddress: string, budgetId: string) {
  const budgetPk = `${navigatorAddress.toLowerCase()}-${budgetId}`;
  const { data, error } = await supabase
    .from('ds_budget_disbursements')
    .select('*')
    .eq('budget_pk', budgetPk)
    .order('block_number', { ascending: false });
  if (error) throw new Error(`listDisbursements: ${error.message}`);
  return data as BudgetDisbursementRow[];
}

// Module enable/disable timeline — the audit trail behind trust_status (e.g. "treasury access
// granted/revoked"). Latest row's `enabled` is what the indexer derived trust from.
async function listModuleHistory(navigatorAddress: string) {
  const { data, error } = await supabase
    .from('ds_vault_module_events')
    .select('*')
    .eq('navigator_address', navigatorAddress.toLowerCase())
    .order('block_number', { ascending: false });
  if (error) throw new Error(`listModuleHistory: ${error.message}`);
  return data as VaultModuleEventRow[];
}
```

> **Don't double-count treasury balances.** Each `Disbursed` is paired with value leaving the vault (a
> native transfer or an ERC20 `Transfer` from the vault). Treat `ds_budget_disbursements` as the
> **budget-activity feed**; take actual balances from the token transfer / on-chain balance, never by
> summing disbursements.

> Wiring and write flows are **on the vault**, not `setNavigators`: enable via `vault.enableModule`
> (proposal), create/update/cancel budgets via proposals targeting the navigator (avatar-only), and
> `disburse`/`disburseBatch` directly as the budget's manager. See
> `daoships-app/docs/BUDGET_NAVIGATOR_SUPPORT.md`.

### Subscription Queries (SubscriptionNavigator)

A `SubscriptionNavigator` is **permissioned** (MANAGER, like Vesting) — registered via
`setNavigators` so `trust_status = 'sanctioned'`. Dues and collection touch the cap table, so
**trust-gate every query** and default views to sanctioned navigators only. Membership is one row
per `(navigator, member)` in `ds_subscription_members`; each `payFee` appends to
`ds_subscription_payments` and each `collectFee` to `ds_subscription_collections`. `total_paid` is
the indexer's derived `SUM` of payment amounts. **Status is time-derived** from `paid_through` and
the navigator's immutable `graceDuration` (read once from the contract: `nextDeadline` /
`isCurrent` / `inGracePeriod` / `isDelinquent`):

```typescript
// graceDurationSec: read once from the contract (immutable) — e.g. via getAcceptedTokens()/views.
function computeSubscriptionStatus(
  m: SubscriptionMemberRow,
  graceDurationSec: number,
  nowSec = Math.floor(Date.now() / 1000),
): SubscriptionStatus {
  if (m.paid_through === 0) return 'not_enrolled';            // never enrolled, or collected
  if (nowSec <= m.paid_through) return 'current';
  if (nowSec <= m.paid_through + graceDurationSec) return 'grace';
  return 'delinquent';                                       // past grace → collectible by anyone
}
```

```typescript
// Members of a DAO — only from SANCTIONED subscription navigators (mirror listBudgets).
async function listSubscriptionMembers(daoId: string) {
  const navs = await listSanctionedNavigators(daoId, 'SubscriptionNavigator'); // from Trust gating section
  const addrs = navs.map((n) => n.navigator_address);
  if (addrs.length === 0) return [] as SubscriptionMemberRow[];
  const { data, error } = await supabase
    .from('ds_subscription_members')
    .select('*')
    .in('navigator_address', addrs)
    .order('paid_through', { ascending: true });             // soonest-to-lapse first
  if (error) throw new Error(`listSubscriptionMembers: ${error.message}`);
  return data as SubscriptionMemberRow[];
}

// Payment feed for one member (payer differs from member on payFeeFor / sponsorship).
async function listSubscriptionPayments(navigatorAddress: string, member: string) {
  const memberPk = `${navigatorAddress.toLowerCase()}-${member.toLowerCase()}`;
  const { data, error } = await supabase
    .from('ds_subscription_payments')
    .select('*')
    .eq('member_pk', memberPk)
    .order('block_number', { ascending: false });
  if (error) throw new Error(`listSubscriptionPayments: ${error.message}`);
  return data as SubscriptionPaymentRow[];
}

// Collection feed for a navigator — keepers who stripped lapsed members (burned vs converted).
async function listSubscriptionCollections(navigatorAddress: string) {
  const { data, error } = await supabase
    .from('ds_subscription_collections')
    .select('*')
    .eq('navigator_address', navigatorAddress.toLowerCase())
    .order('block_number', { ascending: false });
  if (error) throw new Error(`listSubscriptionCollections: ${error.message}`);
  return data as SubscriptionCollectionRow[];
}
```

> **Don't double-count treasury balances or `total_paid` as voting weight.** Each `FeePaid` pairs
> with value moving **into** the vault and each `FeeCollected` with a `ConvertSharesToLoot`/`BurnShares`
> + `MintLoot` on the cap table. Treat the subscription tables as **activity feeds**; take actual
> balances/shares from the token transfer + mint/burn events. See
> `daoships-app/docs/SUBSCRIPTION_NAVIGATOR_SUPPORT.md`.

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

#### Apply the DAO brand theme (`content_json.theme`, schema 1.1+)

`content_json.theme` is an optional color palette a DAO sets to brand webapps that render it. It is a
single field **replaced as a whole** (like `links`) — `theme: null`/omitted means "no change/unset",
so read it off the **latest** profile post. Shape (all keys optional):

```typescript
interface DaoTheme {
  mode?: 'light' | 'dark';   // which base the palette targets
  primary?: string; secondary?: string; accent?: string;   // brand colors
  background?: string; surface?: string; text?: string;     // surfaces + foreground
}
```

**The indexer already strict-hex-validates every color** (`^#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$`) and
constrains `mode` to `light`/`dark` before storing — any non-conforming token is dropped, so a value
that survives in `content_json.theme` is **safe to assign to a CSS variable / `style`**. That closes the
CSS-injection vector; you do **not** re-validate, but you DO still:

- **Fall back to your own defaults** for any unset token (a DAO may set only `primary`/`background`).
- **Own the contrast check.** A DAO can post a readable-but-ugly or unreadable pair (e.g. `text` ==
  `background`). Verify posted pairs against WCAG AA (4.5:1 text, 3:1 UI/large) and fall back when a pair
  fails — the indexer guarantees *format*, not *legibility*.

```tsx
// Colors are pre-validated hex → safe to interpolate into CSS variables.
function themeVars(theme?: DaoTheme): React.CSSProperties {
  if (!theme) return {};
  const v: Record<string, string> = {};
  for (const k of ['primary','secondary','accent','background','surface','text'] as const) {
    if (theme[k]) v[`--dao-${k}`] = theme[k]!;   // already strict hex
  }
  return v as React.CSSProperties;
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
- `ds_navigators` -- navigator added/removed/paused, trust_status changes (sanctioned/unsanctioned)
- `ds_navigator_events` -- onboard events
- `ds_nft_claims` -- NFT-gate per-token claims
- `ds_signal_polls` -- poll created/cancelled, tally updates (sanctioned navigators only)
- `ds_signal_votes` -- new signal votes
- `ds_timelock_changes` -- timelock change queued/executed/cancelled
- `ds_governance_config_history` -- governance-config changes + bypass flag
- `ds_vesting_schedules` -- vesting schedule created/revoked, derived `claimed` updates
- `ds_budgets` -- budget created/cancelled, manager updates, derived `total_spent` updates
- `ds_subscription_members` -- enrollment + payment state, derived `total_paid`, un-enroll on collect
- `ds_indexer_state` -- sync progress

> `ds_vesting_claims` is **append-only** and intentionally **not** in the realtime publication (like other
> high-volume feeds). Subscribe to `ds_vesting_schedules` instead — its `claimed`/`updated_at` change on
> every claim — and re-read the claim feed on demand. The same pattern applies to subscriptions:
> subscribe to `ds_subscription_members` (its `paid_through`/`total_paid`/`updated_at` change on every
> `payFee`/`collectFee`) and re-read `ds_subscription_payments` / `ds_subscription_collections` on demand.

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

### Subscribe to signal polls + votes

Live poll creation, new votes, and cancellations (only sanctioned navigators emit rows). On a vote,
re-read the poll for the authoritative `tally` (the indexer recomputes it from the vote rows):

```typescript
const pollChannel = supabase
  .channel('signal-polls')
  .on(
    'postgres_changes',
    { event: '*', schema: NETWORK_SCHEMA, table: 'ds_signal_polls', filter: `dao_id=eq.${daoId}` },
    (payload) => {
      const poll = payload.new as SignalPollRow;
      console.log('poll', poll.poll_id, 'tally:', poll.tally, 'status:', computeSignalPollStatus(poll));
    },
  )
  .on(
    'postgres_changes',
    { event: 'INSERT', schema: NETWORK_SCHEMA, table: 'ds_signal_votes', filter: `dao_id=eq.${daoId}` },
    (payload) => {
      const vote = payload.new as SignalVoteRow;
      console.log(`${vote.voter} voted option ${vote.option} (weight ${vote.weight})`);
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
  avatar?: string;       // URL: https://, ipfs://  (the DAO icon)
  banner?: string;       // URL: https://, ipfs://
  links?: Record<string, string>;
  theme?: DaoTheme;      // strict-hex colors (schema 1.1+); see "Apply the DAO brand theme"
  tags?: string[];
  chainId?: number;
}) {
  const content = JSON.stringify({
    schemaVersion: '1.1',
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
  profile: { name?: string; description?: string; avatar?: string; banner?: string; links?: Record<string, string>; theme?: DaoTheme; tags?: string[] },
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

Navigator metadata (name, description, deployer, type) is set automatically at deployment via the `NavigatorDeployed` constructor event emitted by all `INavigator`-compliant contracts. No Poster interaction is needed — the indexer binds the DAO association and metadata directly from that event (it no longer waits for `NavigatorSet`).

### Sanction a read-only navigator (governance proposal)

This is how a DAO **endorses** a `SignalNavigator` (or any future read-only navigator) so its polls
surface by default (`trust_status → 'sanctioned'`, and the indexer backfills its poll history). It is
a **vault post** of the DAO's *complete* sanctioned set — the list is canonical, not a delta, so
**re-list every navigator you still endorse**; an omitted address is de-sanctioned, and `[]` clears all.

```typescript
async function encodeSanctionNavigatorsProposal(
  daoAddress: string,
  posterAddress: string,
  navigators: { address: string; type?: string }[],   // the FULL set to keep endorsed
): Promise<string> {
  const posterInterface = new quais.Interface(POSTER_ABI);
  const content = JSON.stringify({
    schemaVersion: '1.0',
    daoAddress: daoAddress.toLowerCase(),
    navigators: navigators.map((n) => ({ address: n.address.toLowerCase(), type: n.type })),
  });
  const postData = posterInterface.encodeFunctionData('post', [content, 'daoships.dao.navigators']);
  // Executes from the vault (avatar) → indexer assigns VERIFIED trust.
  return encodeProposalData([posterAddress], [0n], [postData]);
}
```

> The post grants **no on-chain permission** — it only changes how the navigator is *displayed*. The
> navigator already functions whether sanctioned or not; sanctioning governs the feed. Scoping is
> enforced indexer-side: a vault can only sanction read-only navigators whose `NavigatorDeployed.daoShip`
> equals its own DAO.

### Tag reference

| Tag | Who Posts | Trust Required | Content Schema |
|-----|----------|---------------|----------------|
| `daoships.dao.profile.initial` | Deployer (directly, at launch) | `VERIFIED_INITIAL` | `{ schemaVersion*, daoAddress*, name*, description*, avatar?, banner?, links?, tags?, chainId? }` |
| `daoships.dao.profile` | DAO vault (via governance proposal) | `VERIFIED` | `{ schemaVersion*, daoAddress*, name?, description?, avatar?, banner?, links?, tags?, chainId? }` |
| `daoships.dao.announcement` | DAO vault (via proposal) | `VERIFIED` | `{ schemaVersion*, daoAddress*, title*, body?, severity? }` |
| `daoships.dao.navigators` | DAO vault (via proposal) | `VERIFIED` | `{ schemaVersion*, daoAddress*, navigators*: [{ address*, type? }] }` — full sanctioned set (last-write-wins) |
| `daoships.member.profile` | Member wallet | `MEMBER` | `{ schemaVersion*, daoAddress?, name*, bio?, avatar? }` |
| `daoships.proposal.vote.reason` | Voter wallet | `MEMBER` | `{ schemaVersion*, daoAddress*, proposalId?, vote?, reason* }` |
| `daoships.navigator.allowlist` | Navigator deployer (member) | `MEMBER` | `{ schemaVersion*, daoAddress*, navigatorAddress*, root*, addresses*, treeDump* }` |
| `daoships.signal.poll` | Poll creator (`== PollCreated.creator`) | creator-match | `{ schemaVersion*, daoAddress*, navigatorAddress*, pollId*, options*: string[], description?, discussionUrl? }` — labels for an existing poll; `options.length` must equal on-chain `optionCount`; last-write-wins; ignored once the poll is ended/cancelled |

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
