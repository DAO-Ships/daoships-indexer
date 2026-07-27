/**
 * H8: ds_indexer_state.chain_id is `NOT NULL DEFAULT 15000` and nothing ever
 * wrote it, so every schema advertised 15000 regardless of the chain it indexed
 * — including mainnet, which indexes chain 9 and reported Orchard's ID.
 *
 * reconcileChainId() repairs the row from the live RPC value on every boot.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.SUPABASE_URL ||= 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';
process.env.SUPABASE_SCHEMA ||= 'public';

const singleMock = vi.fn();
const selectEqMock = vi.fn();
const selectMock = vi.fn();
const updateEqMock = vi.fn();
const updateMock = vi.fn();
const fromMock = vi.fn();

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ from: fromMock }),
}));

let DatabaseService: any;

beforeEach(async () => {
  vi.clearAllMocks();
  selectEqMock.mockReturnValue({ single: singleMock });
  selectMock.mockReturnValue({ eq: selectEqMock });
  updateEqMock.mockResolvedValue({ error: null });
  updateMock.mockReturnValue({ eq: updateEqMock });
  fromMock.mockReturnValue({ select: selectMock, update: updateMock });

  const mod = await import('../../src/services/database.js');
  DatabaseService = mod.DatabaseService;
});

describe('DatabaseService.reconcileChainId (H8)', () => {
  it('repairs the mainnet row that reported Orchard 15000 while indexing chain 9', async () => {
    singleMock.mockResolvedValue({ data: { chain_id: 15000 }, error: null });

    const db = new DatabaseService();
    const result = await db.reconcileChainId(9);

    expect(result).toEqual({ changed: true, previous: 15000 });
    expect(fromMock).toHaveBeenCalledWith('ds_indexer_state');
    expect(updateMock).toHaveBeenCalledWith({ chain_id: 9 });
    expect(updateEqMock).toHaveBeenCalledWith('id', 1);
  });

  it('does not write when the stored value already matches', async () => {
    singleMock.mockResolvedValue({ data: { chain_id: 9 }, error: null });

    const db = new DatabaseService();
    const result = await db.reconcileChainId(9);

    expect(result).toEqual({ changed: false, previous: 9 });
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('writes through when the column is null', async () => {
    singleMock.mockResolvedValue({ data: { chain_id: null }, error: null });

    const db = new DatabaseService();
    const result = await db.reconcileChainId(15000);

    expect(result).toEqual({ changed: true, previous: null });
    expect(updateMock).toHaveBeenCalledWith({ chain_id: 15000 });
  });

  it('throws when the row cannot be read, rather than guessing', async () => {
    singleMock.mockResolvedValue({ data: null, error: { message: 'boom' } });

    const db = new DatabaseService();
    await expect(db.reconcileChainId(9)).rejects.toThrow(/Failed to read chain_id: boom/);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('throws when the update fails', async () => {
    singleMock.mockResolvedValue({ data: { chain_id: 15000 }, error: null });
    updateEqMock.mockResolvedValue({ error: { message: 'denied' } });

    const db = new DatabaseService();
    await expect(db.reconcileChainId(9)).rejects.toThrow(/Failed to update chain_id: denied/);
  });
});

describe('DatabaseService.getIndexerState (H8)', () => {
  it('surfaces chain_id so /health and consumers can see which chain this schema describes', async () => {
    singleMock.mockResolvedValue({
      data: {
        last_block_number: 9251893,
        last_block_hash: '0xabc',
        chain_id: 9,
        is_syncing: false,
        requires_full_reindex: false,
        reindex_reason: null,
        reindex_flagged_at: null,
      },
      error: null,
    });

    const db = new DatabaseService();
    const state = await db.getIndexerState();

    expect(state.chainId).toBe(9);
    expect(selectMock).toHaveBeenCalledWith(expect.stringContaining('chain_id'));
  });

  it('reports chainId as null rather than defaulting when the column is absent', async () => {
    singleMock.mockResolvedValue({ data: { last_block_number: 1 }, error: null });

    const db = new DatabaseService();
    const state = await db.getIndexerState();

    expect(state.chainId).toBeNull();
  });
});
