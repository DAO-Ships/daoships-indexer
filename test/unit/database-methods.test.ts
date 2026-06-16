/**
 * A4 remainder: DatabaseService coverage for security-critical and recently-
 * added paths not covered elsewhere.
 *
 * Covers:
 *  - Generic upsert/insert VALID_TABLES allowlist (SQL-injection defense-in-
 *    depth for dynamic table names).
 *  - Address + bytes32 validation on input paths.
 *  - H1 getNavigatorByAddress shape.
 *  - E1 insertProposalIfAbsent / insertMemberIfAbsent boolean return wiring.
 *  - insert() ignores 23505 duplicate-key errors (retry idempotency).
 *
 * The existing database-reindex-flag.test.ts and database-prune-guard.test.ts
 * cover M2 and SC7 respectively; this file fills remaining gaps.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.SUPABASE_URL ||= 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';
process.env.SUPABASE_SCHEMA ||= 'public';

// Chainable builder that resolves to { data, error } and supports abortSignal.
// We expose a settable { data, error } pair per-chain via the `nextResult` ref.
type Resolved = { data: any; error: any };
const nextResult: Resolved = { data: null, error: null };

const fromMock = vi.fn();
const upsertMock = vi.fn();
const insertMock = vi.fn();
const updateMock = vi.fn();
const selectMock = vi.fn();
const eqMock = vi.fn();
const limitMock = vi.fn();
const orMock = vi.fn();
const rpcMock = vi.fn();

function makeThenable() {
  const resolveWith = () => Promise.resolve({ data: nextResult.data, error: nextResult.error });
  return {
    abortSignal: (_s: any) => resolveWith(),
    // Allow `await chain` to resolve directly
    then: (onFulfilled: any, onRejected: any) => resolveWith().then(onFulfilled, onRejected),
    // Allow chaining .select(), .eq(), .limit(), .update(), .or()
    select: selectMock,
    eq: eqMock,
    limit: limitMock,
    update: updateMock,
    or: orMock,
  };
}

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: fromMock,
    rpc: rpcMock,
  }),
}));

let DatabaseService: any;

beforeEach(async () => {
  vi.clearAllMocks();
  nextResult.data = null;
  nextResult.error = null;

  // Each builder method returns a thenable so `await chain` and
  // `.abortSignal()` / `.select()` / `.eq()` / `.limit()` all resolve.
  const t = makeThenable();
  upsertMock.mockReturnValue(t);
  insertMock.mockReturnValue(t);
  updateMock.mockReturnValue(t);
  selectMock.mockReturnValue(t);
  eqMock.mockReturnValue(t);
  limitMock.mockReturnValue(t);
  orMock.mockReturnValue(t);
  // rpc() returns the same abortSignal-capable thenable as the query builder
  // (withDbTimeout requires `.abortSignal()`); results are driven via nextResult.
  rpcMock.mockReturnValue(t);
  fromMock.mockReturnValue({ upsert: upsertMock, insert: insertMock, update: updateMock, select: selectMock });

  const mod = await import('../../src/services/database.js');
  DatabaseService = mod.DatabaseService;
});

// ── Allowlist enforcement (security) ───────────────────────────

describe('DatabaseService.upsert — VALID_TABLES allowlist', () => {
  it('throws on unknown table names (SQL-injection defense)', async () => {
    const db = new DatabaseService();
    await expect(db.upsert('ds_daos', { id: '0x1' })).rejects.toThrow(/Invalid table name/);
    await expect(db.upsert('pg_catalog.pg_tables', { id: 'x' })).rejects.toThrow(/Invalid table name/);
    await expect(db.upsert('; DROP TABLE ds_daos;--', { id: 'x' })).rejects.toThrow(/Invalid table name/);
    // Critical: the client's from() must NOT have been called for any of these.
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('accepts each whitelisted generic-upsert table', async () => {
    const db = new DatabaseService();
    const allowed = ['ds_guild_tokens', 'ds_ragequits', 'ds_navigators', 'ds_navigator_events', 'ds_records', 'ds_delegations'];
    for (const table of allowed) {
      await db.upsert(table, { id: 'x' });
      expect(fromMock).toHaveBeenCalledWith(table);
    }
    expect(fromMock).toHaveBeenCalledTimes(allowed.length);
  });

  it('rejects typed tables that have dedicated methods (forces caller through the typed API)', async () => {
    const db = new DatabaseService();
    // These have upsertDao/upsertMember/upsertProposal/upsertVote — generic
    // path is intentionally closed for them.
    await expect(db.upsert('ds_daos', {})).rejects.toThrow(/Invalid table name/);
    await expect(db.upsert('ds_members', {})).rejects.toThrow(/Invalid table name/);
    await expect(db.upsert('ds_proposals', {})).rejects.toThrow(/Invalid table name/);
    await expect(db.upsert('ds_votes', {})).rejects.toThrow(/Invalid table name/);
  });
});

describe('DatabaseService.insert — VALID_TABLES allowlist', () => {
  it('throws on unknown tables', async () => {
    const db = new DatabaseService();
    await expect(db.insert('not_a_table', {})).rejects.toThrow(/Invalid table name/);
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('ignores 23505 duplicate-key errors (idempotent retry contract)', async () => {
    const db = new DatabaseService();
    nextResult.error = { code: '23505', message: 'duplicate key value violates unique constraint' };
    // Should NOT throw — 23505 is expected during re-indexing.
    await expect(db.insert('ds_delegations', { id: 1 })).resolves.toBeUndefined();
  });

  it('throws on non-duplicate errors', async () => {
    const db = new DatabaseService();
    nextResult.error = { code: '23502', message: 'not null violation' };
    await expect(db.insert('ds_delegations', { id: 1 })).rejects.toThrow(/not null violation/);
  });
});

// ── H1: getNavigatorByAddress ──────────────────────────────────

describe('DatabaseService.getNavigatorByAddress (H1)', () => {
  it('returns the navigator row shape used by poster verification', async () => {
    const db = new DatabaseService();
    nextResult.data = [{
      id: '0xdao-0xnav',
      dao_id: '0xdao',
      deployer: '0xdeployer',
      allowlist_root: '0x' + 'ab'.repeat(32),
    }];

    const nav = await db.getNavigatorByAddress('0x0000000000000000000000000000000000000007');

    expect(fromMock).toHaveBeenCalledWith('ds_navigators');
    expect(selectMock).toHaveBeenCalledWith('id, dao_id, deployer, allowlist_root');
    expect(eqMock).toHaveBeenCalledWith('navigator_address', '0x0000000000000000000000000000000000000007');
    expect(nav).toEqual({
      id: '0xdao-0xnav',
      dao_id: '0xdao',
      deployer: '0xdeployer',
      allowlist_root: '0x' + 'ab'.repeat(32),
    });
  });

  it('returns null when no row exists (DB miss → post rejected)', async () => {
    const db = new DatabaseService();
    nextResult.data = [];
    const nav = await db.getNavigatorByAddress('0x0000000000000000000000000000000000000007');
    expect(nav).toBeNull();
  });

  it('throws on rejects invalid navigator address (pre-query validation)', async () => {
    const db = new DatabaseService();
    await expect(db.getNavigatorByAddress('not-an-address')).rejects.toThrow();
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('throws on DB error (caller propagates, processor retries block range)', async () => {
    const db = new DatabaseService();
    nextResult.error = { message: 'connection terminated' };
    await expect(
      db.getNavigatorByAddress('0x0000000000000000000000000000000000000007'),
    ).rejects.toThrow(/connection terminated/);
  });
});

// ── E1: insertProposalIfAbsent / insertMemberIfAbsent ──────────

describe('DatabaseService.insertProposalIfAbsent (E1)', () => {
  it('returns true when the row was actually inserted', async () => {
    const db = new DatabaseService();
    nextResult.data = [{ id: 'x' }]; // data has rows → inserted
    const inserted = await db.insertProposalIfAbsent({ id: 'x' } as any);
    expect(inserted).toBe(true);
    expect(upsertMock).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ onConflict: 'id', ignoreDuplicates: true }),
    );
  });

  it('returns false when the row already existed (conflict suppressed)', async () => {
    const db = new DatabaseService();
    nextResult.data = []; // empty → conflict, no insert
    const inserted = await db.insertProposalIfAbsent({ id: 'x' } as any);
    expect(inserted).toBe(false);
  });

  it('propagates errors from the DB', async () => {
    const db = new DatabaseService();
    nextResult.error = { message: 'boom' };
    await expect(db.insertProposalIfAbsent({ id: 'x' } as any)).rejects.toThrow(/boom/);
  });
});

describe('DatabaseService.insertMemberIfAbsent (E1)', () => {
  it('returns true when the row was actually inserted', async () => {
    const db = new DatabaseService();
    nextResult.data = [{ id: 'x' }];
    expect(await db.insertMemberIfAbsent({ id: 'x' } as any)).toBe(true);
    expect(fromMock).toHaveBeenCalledWith('ds_members');
  });

  it('returns false on conflict (row already present)', async () => {
    const db = new DatabaseService();
    nextResult.data = [];
    expect(await db.insertMemberIfAbsent({ id: 'x' } as any)).toBe(false);
  });

  it('uses ignoreDuplicates: true on the upsert', async () => {
    const db = new DatabaseService();
    nextResult.data = [];
    await db.insertMemberIfAbsent({ id: 'x' } as any);
    expect(upsertMock).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ ignoreDuplicates: true }),
    );
  });
});

// ── Address + bytes32 validation on input paths ────────────────

describe('DatabaseService input validation', () => {
  it('upsertDao rejects invalid dao.id', async () => {
    const db = new DatabaseService();
    await expect(db.upsertDao({ id: 'not-an-address' } as any)).rejects.toThrow();
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('getDao rejects invalid daoId', async () => {
    const db = new DatabaseService();
    await expect(db.getDao('not-an-address')).rejects.toThrow();
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('updateDao rejects invalid daoId', async () => {
    const db = new DatabaseService();
    await expect(db.updateDao('nope', {})).rejects.toThrow();
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('recordEventTransaction rejects invalid tx hash (bytes32 check)', async () => {
    const db = new DatabaseService();
    await expect(
      db.recordEventTransaction('not-a-hash', null, 100, new Date()),
    ).rejects.toThrow();
  });
});

// ── Navigator trust + signal RPCs ──────────────────────────────
// The trust-model prune must NEVER delete mid-backfill. The caller decides
// "caught up to chain head?" and passes it through; the RPC no-ops on false.
// These pin the call contract so a refactor can't silently drop the guard.

describe('DatabaseService.pruneOrphanedNavigators (trust-model prune)', () => {
  it('forwards atChainHead=true to the ds_prune_orphaned_navigators RPC', async () => {
    const db = new DatabaseService();
    await db.pruneOrphanedNavigators(7, true);

    expect(rpcMock).toHaveBeenCalledWith('ds_prune_orphaned_navigators', {
      p_retention_days: 7,
      p_at_chain_head: true,
    });
  });

  it('forwards atChainHead=false (RPC no-ops while not caught up — never reap mid-backfill)', async () => {
    const db = new DatabaseService();
    await db.pruneOrphanedNavigators(30, false);

    expect(rpcMock).toHaveBeenCalledWith('ds_prune_orphaned_navigators', {
      p_retention_days: 30,
      p_at_chain_head: false,
    });
  });

  it('swallows RPC errors (pruning is non-fatal to the indexer loop)', async () => {
    nextResult.error = { message: 'boom' };
    const db = new DatabaseService();
    await expect(db.pruneOrphanedNavigators(7, true)).resolves.toBeUndefined();
  });
});

describe('DatabaseService.recomputePollTally (derive-from-truth)', () => {
  it('calls ds_recompute_poll_tally with the poll pk', async () => {
    const db = new DatabaseService();
    await db.recomputePollTally('0xnav-3');

    expect(rpcMock).toHaveBeenCalledWith('ds_recompute_poll_tally', { p_poll_pk: '0xnav-3' });
  });

  it('throws on RPC error so the processor retries the range (tally must converge)', async () => {
    nextResult.error = { message: 'deadlock' };
    const db = new DatabaseService();
    await expect(db.recomputePollTally('0xnav-3')).rejects.toThrow(/deadlock/);
  });
});

// ── Signal poll option labels (daoships.signal.poll) ───────────

describe('DatabaseService.getSignalPoll (labels trust + expiry gate inputs)', () => {
  it('reads the gate fields and maps types', async () => {
    const db = new DatabaseService();
    nextResult.data = [{
      creator: '0xcreator', option_count: 3, voting_ends: 1700086400, cancelled: false, labels_block_number: null,
    }];

    const poll = await db.getSignalPoll('0xnav-0');

    expect(fromMock).toHaveBeenCalledWith('ds_signal_polls');
    expect(selectMock).toHaveBeenCalledWith('creator, option_count, voting_ends, cancelled, labels_block_number');
    expect(eqMock).toHaveBeenCalledWith('id', '0xnav-0');
    expect(poll).toEqual({
      creator: '0xcreator', option_count: 3, voting_ends: 1700086400, cancelled: false, labels_block_number: null,
    });
  });

  it('returns null when the poll is not materialized (labels post discarded, not held)', async () => {
    const db = new DatabaseService();
    nextResult.data = [];
    expect(await db.getSignalPoll('0xnav-0')).toBeNull();
  });

  it('coerces a present labels_block_number to a number', async () => {
    const db = new DatabaseService();
    nextResult.data = [{ creator: '0xc', option_count: 2, voting_ends: 1, cancelled: true, labels_block_number: '512' }];
    const poll = await db.getSignalPoll('0xnav-1');
    expect(poll?.labels_block_number).toBe(512);
    expect(poll?.cancelled).toBe(true);
  });

  it('throws on DB error (processor retries the block range)', async () => {
    nextResult.error = { message: 'connection reset' };
    const db = new DatabaseService();
    await expect(db.getSignalPoll('0xnav-0')).rejects.toThrow(/connection reset/);
  });
});

describe('DatabaseService.applyPollLabels (targeted update + last-write-wins guard)', () => {
  it('updates label columns and guards on labels_block_number (null OR <= new block)', async () => {
    const db = new DatabaseService();
    await db.applyPollLabels('0xnav-0', {
      options: ['A', 'B'],
      description: 'ctx',
      discussionUrl: 'https://x.example/1',
      labelsUpdatedAt: '2026-06-14T00:00:00.000Z',
      labelsBlockNumber: 100,
    });

    expect(fromMock).toHaveBeenCalledWith('ds_signal_polls');
    expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({
      options: ['A', 'B'],
      description: 'ctx',
      discussion_url: 'https://x.example/1',
      labels_updated_at: '2026-06-14T00:00:00.000Z',
      labels_block_number: 100,
    }));
    expect(eqMock).toHaveBeenCalledWith('id', '0xnav-0');
    // Older-or-absent guard: a replayed older post (block <= existing) cannot clobber a newer edit.
    expect(orMock).toHaveBeenCalledWith('labels_block_number.is.null,labels_block_number.lte.100');
  });

  it('persists null description/discussion_url when absent', async () => {
    const db = new DatabaseService();
    await db.applyPollLabels('0xnav-0', {
      options: ['A', 'B'], description: null, discussionUrl: null,
      labelsUpdatedAt: '2026-06-14T00:00:00.000Z', labelsBlockNumber: 5,
    });
    expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({ description: null, discussion_url: null }));
  });

  it('throws on DB error', async () => {
    nextResult.error = { message: 'update failed' };
    const db = new DatabaseService();
    await expect(db.applyPollLabels('0xnav-0', {
      options: ['A', 'B'], description: null, discussionUrl: null,
      labelsUpdatedAt: 't', labelsBlockNumber: 1,
    })).rejects.toThrow(/update failed/);
  });
});
