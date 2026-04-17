/**
 * SC7: pruneProcessedLogs should skip its DELETE RTT when the cutoff has
 * not advanced since the last successful prune.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.SUPABASE_URL ||= 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';
process.env.SUPABASE_SCHEMA ||= 'public';

const deleteMock = vi.fn();
const ltMock = vi.fn();
const fromMock = vi.fn();

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ from: fromMock }),
}));

let DatabaseService: any;

beforeEach(async () => {
  vi.clearAllMocks();
  ltMock.mockResolvedValue({ error: null });
  deleteMock.mockReturnValue({ lt: ltMock });
  fromMock.mockReturnValue({ delete: deleteMock });

  const mod = await import('../../src/services/database.js');
  DatabaseService = mod.DatabaseService;
});

describe('DatabaseService.pruneProcessedLogs (SC7)', () => {
  it('prunes on the first call and advances lastPrunedCutoff', async () => {
    const db = new DatabaseService();
    // currentBlock=100, reorgWalkBack=10 → cutoff = 80
    await db.pruneProcessedLogs(100, 10);

    expect(fromMock).toHaveBeenCalledWith('ds_processed_logs');
    expect(deleteMock).toHaveBeenCalledTimes(1);
    expect(ltMock).toHaveBeenCalledWith('block_number', 80);
  });

  it('skips the DELETE RTT when the same cutoff is seen again (e.g. retry after failure)', async () => {
    const db = new DatabaseService();
    await db.pruneProcessedLogs(100, 10); // cutoff 80 → prunes
    await db.pruneProcessedLogs(100, 10); // same cutoff → no-op

    expect(deleteMock).toHaveBeenCalledTimes(1);
  });

  it('prunes again when the cutoff advances', async () => {
    const db = new DatabaseService();
    await db.pruneProcessedLogs(100, 10); // cutoff 80
    await db.pruneProcessedLogs(200, 10); // cutoff 180 > 80 → prunes

    expect(deleteMock).toHaveBeenCalledTimes(2);
    expect(ltMock).toHaveBeenNthCalledWith(1, 'block_number', 80);
    expect(ltMock).toHaveBeenNthCalledWith(2, 'block_number', 180);
  });

  it('does not advance lastPrunedCutoff when the DELETE errors (will retry next time)', async () => {
    const db = new DatabaseService();
    ltMock.mockResolvedValueOnce({ error: { message: 'transient' } });
    await db.pruneProcessedLogs(100, 10); // cutoff 80 — errors
    // Next call at same cutoff SHOULD retry the DELETE because we didn't
    // record a successful prune. This keeps the guard from silently
    // accepting error state as "done."
    await db.pruneProcessedLogs(100, 10);

    expect(deleteMock).toHaveBeenCalledTimes(2);
  });

  it('returns early without calling the client when cutoff <= 0 (early blocks)', async () => {
    const db = new DatabaseService();
    await db.pruneProcessedLogs(5, 10); // cutoff = -15
    expect(fromMock).not.toHaveBeenCalled();
  });
});
