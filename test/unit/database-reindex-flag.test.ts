/**
 * M2: DatabaseService surface for the requires_full_reindex flag.
 *
 * We test the wiring against a hand-rolled Supabase client mock rather than
 * a live DB, so the assertions focus on: the right table/column is targeted,
 * the right filter is applied, and errors propagate.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Ensure config loads before importing DatabaseService
process.env.SUPABASE_URL ||= 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';
process.env.SUPABASE_SCHEMA ||= 'public';

// Mock createClient before importing the module that uses it
const updateMock = vi.fn();
const eqMock = vi.fn();
const singleMock = vi.fn();
const selectMock = vi.fn();
const fromMock = vi.fn();

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: fromMock,
  }),
}));

let DatabaseService: any;

beforeEach(async () => {
  vi.clearAllMocks();
  // Chainable .update(...).eq(...) returning { error }
  eqMock.mockResolvedValue({ error: null });
  updateMock.mockReturnValue({ eq: eqMock, abortSignal: (_s: any) => Promise.resolve({ error: null }) });
  // Chainable .select(...).eq(...).single() returning { data, error }
  singleMock.mockResolvedValue({
    data: {
      last_block_number: 42,
      last_block_hash: '0xdeadbeef',
      is_syncing: false,
      requires_full_reindex: true,
      reindex_reason: 'test reason',
      reindex_flagged_at: '2026-04-16T12:00:00Z',
    },
    error: null,
  });
  eqMock.mockImplementation(() => ({ single: singleMock, abortSignal: (_s: any) => Promise.resolve({ error: null }) }));
  selectMock.mockReturnValue({ eq: eqMock });
  fromMock.mockReturnValue({ select: selectMock, update: updateMock });

  const mod = await import('../../src/services/database.js');
  DatabaseService = mod.DatabaseService;
});

describe('DatabaseService.getIndexerState (M2)', () => {
  it('returns the requires_full_reindex fields from ds_indexer_state', async () => {
    const db = new DatabaseService();
    const state = await db.getIndexerState();

    expect(fromMock).toHaveBeenCalledWith('ds_indexer_state');
    expect(selectMock).toHaveBeenCalledWith(expect.stringContaining('requires_full_reindex'));
    expect(state.requiresFullReindex).toBe(true);
    expect(state.reindexReason).toBe('test reason');
    expect(state.reindexFlaggedAt).toBe('2026-04-16T12:00:00Z');
  });
});

describe('DatabaseService.setRequiresFullReindex (M2)', () => {
  it('sets requires_full_reindex=true with reason + timestamp on row id=1', async () => {
    const db = new DatabaseService();
    await db.setRequiresFullReindex('reorg past confirmation window');

    expect(fromMock).toHaveBeenCalledWith('ds_indexer_state');
    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        requires_full_reindex: true,
        reindex_reason: 'reorg past confirmation window',
      }),
    );
    // Timestamp is generated on call; assert it was included
    const payload = updateMock.mock.calls[0][0];
    expect(payload.reindex_flagged_at).toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(eqMock).toHaveBeenCalledWith('id', 1);
  });

  it('throws when the update errors', async () => {
    eqMock.mockResolvedValueOnce({ error: { message: 'boom' } });
    const db = new DatabaseService();
    await expect(db.setRequiresFullReindex('x')).rejects.toThrow(/boom/);
  });
});

describe('DatabaseService.clearRequiresFullReindex (M2)', () => {
  it('clears the flag fields to false/null', async () => {
    const db = new DatabaseService();
    await db.clearRequiresFullReindex();

    expect(updateMock).toHaveBeenCalledWith({
      requires_full_reindex: false,
      reindex_reason: null,
      reindex_flagged_at: null,
    });
    expect(eqMock).toHaveBeenCalledWith('id', 1);
  });
});
