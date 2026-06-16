/**
 * A4: BlockProcessor orchestration tests.
 *
 * Covers the core behaviors that must survive future refactoring:
 *  - Happy path: fetch logs → dispatch → mark processed
 *  - Dedup via ds_processed_logs skip
 *  - Launcher-first log sort within the same tx
 *  - Transient vs deterministic error classification
 *  - Empty range / invalid range guards
 *  - Deduped event-transaction recording
 *
 * Reorg + cache behavior lives in `reorg-recovery.test.ts`.
 * Discovery pass overflow lives in `processor-discovery.test.ts`.
 */
import { describe, it, expect, vi } from 'vitest';
import { BlockProcessor } from '../../src/services/processor.js';
import { config } from '../../src/config.js';
import type { Log } from 'quais';

// ── Test fixtures ───────────────────────────────────────────────

// Launcher-first sort keys off the env-configured address. Read from config
// so the test tracks whatever .env the CI/dev is using.
const LAUNCHER = config.contracts.daoShipAndVaultLauncher;
const DAOSHIP = '0x0000000000000000000000000000000000000001';
const TOPIC_LAUNCHER = '0x0000000000000000000000000000000000000000000000000000000000000001';
const TOPIC_OTHER = '0x0000000000000000000000000000000000000000000000000000000000000002';
const TX1 = '0x' + 'aa'.repeat(32);
const TX2 = '0x' + 'bb'.repeat(32);

function makeLog(overrides: Partial<Log> = {}): Log {
  return {
    address: DAOSHIP,
    blockNumber: 100,
    transactionHash: TX1,
    transactionIndex: 0,
    index: 0,
    topics: [TOPIC_OTHER],
    data: '0x',
    ...overrides,
  } as Log;
}

function makeHarness(opts: {
  logs?: Log[];
  processedKeys?: Set<string>;
  registryAddresses?: { daos?: string[]; tokens?: string[]; navigators?: string[] };
  dispatch?: ReturnType<typeof vi.fn>;
} = {}) {
  const blockchain = {
    getBlock: vi.fn().mockResolvedValue({
      hash: '0xblockhash',
      woHeader: { timestamp: 1700000000 },
    }),
    getLogs: vi.fn().mockResolvedValue(opts.logs ?? []),
    getBlockNumber: vi.fn().mockResolvedValue(0),
  } as any;

  const db = {
    getProcessedLogKeys: vi.fn().mockResolvedValue(opts.processedKeys ?? new Set()),
    markLogProcessed: vi.fn().mockResolvedValue(undefined),
    markLogsProcessedBatch: vi.fn().mockResolvedValue(undefined),
    recordEventTransaction: vi.fn().mockResolvedValue(undefined),
    recomputeDaoTotals: vi.fn().mockResolvedValue(undefined),
  } as any;

  const registry = {
    getAllDaoShipAddresses: vi.fn().mockReturnValue(opts.registryAddresses?.daos ?? []),
    getAllTokenAddresses: vi.fn().mockReturnValue(opts.registryAddresses?.tokens ?? []),
    getAllNavigatorAddresses: vi.fn().mockReturnValue(opts.registryAddresses?.navigators ?? []),
    getDaoByDaoShipAddress: vi.fn().mockReturnValue(undefined),
    getDaoByTokenAddress: vi.fn().mockReturnValue(undefined),
    getDaoByNavigatorAddress: vi.fn().mockReturnValue(undefined),
    daoCount: 0,
  } as any;

  const dispatcher = {
    getRegisteredTopics: vi.fn().mockReturnValue([TOPIC_OTHER, TOPIC_LAUNCHER]),
    getUnfilteredTopics: vi.fn().mockReturnValue([]),
    dispatch: opts.dispatch ?? vi.fn().mockResolvedValue({ handled: true, eventName: 'TestEvent' }),
  } as any;

  return { blockchain, db, registry, dispatcher };
}

// ── Validation ─────────────────────────────────────────────────

describe('BlockProcessor.processBlockRange validation', () => {
  it('throws when fromBlock > toBlock', async () => {
    const { blockchain, db, registry, dispatcher } = makeHarness();
    const p = new BlockProcessor(blockchain, db, registry, dispatcher);
    await expect(p.processBlockRange(200, 100)).rejects.toThrow(/Invalid block range/);
  });

  it('returns the last block hash for an empty range (no logs)', async () => {
    const { blockchain, db, registry, dispatcher } = makeHarness({ logs: [] });
    const p = new BlockProcessor(blockchain, db, registry, dispatcher);
    const result = await p.processBlockRange(100, 100);
    expect(result.lastBlockHash).toBe('0xblockhash');
  });
});

// ── Happy path ─────────────────────────────────────────────────

describe('BlockProcessor.processBlockRange happy path', () => {
  it('dispatches each log and marks it processed (batched under Option B)', async () => {
    const logs = [
      makeLog({ index: 0, transactionHash: TX1 }),
      makeLog({ index: 1, transactionHash: TX1 }),
    ];
    // Default dispatch omits `idempotent` (undefined) → processor treats
    // it as idempotent and batches the marks at end-of-range.
    const dispatch = vi.fn().mockResolvedValue({ handled: true, eventName: 'E' });
    const { blockchain, db, registry, dispatcher } = makeHarness({ logs, dispatch });
    const p = new BlockProcessor(blockchain, db, registry, dispatcher);

    await p.processBlockRange(100, 100);

    expect(dispatch).toHaveBeenCalledTimes(2);
    // Per-log marks are replaced by a single end-of-range batch.
    expect(db.markLogProcessed).not.toHaveBeenCalled();
    expect(db.markLogsProcessedBatch).toHaveBeenCalledTimes(1);
    const batchRows = db.markLogsProcessedBatch.mock.calls[0][0];
    expect(batchRows).toEqual([
      { txHash: TX1, logIndex: 0, blockNumber: 100 },
      { txHash: TX1, logIndex: 1, blockNumber: 100 },
    ]);
  });

  it('falls back to per-log markLogProcessed when a handler is non-idempotent', async () => {
    const logs = [makeLog({ index: 0, transactionHash: TX1 })];
    const dispatch = vi.fn().mockResolvedValue({ handled: true, eventName: 'E', idempotent: false });
    const { blockchain, db, registry, dispatcher } = makeHarness({ logs, dispatch });
    const p = new BlockProcessor(blockchain, db, registry, dispatcher);

    await p.processBlockRange(100, 100);

    expect(db.markLogProcessed).toHaveBeenCalledTimes(1);
    // Batch still gets called (with 0 rows → early-return no-op inside db).
    // Handler's flip is only protective against widening the replay window.
  });

  it('deduplicates event-transaction records per tx hash', async () => {
    // Three logs across two different txs → two recordEventTransaction calls.
    const logs = [
      makeLog({ index: 0, transactionHash: TX1 }),
      makeLog({ index: 1, transactionHash: TX1 }),
      makeLog({ index: 2, transactionHash: TX2 }),
    ];
    const dispatch = vi.fn().mockResolvedValue({ handled: true, eventName: 'E' });
    const { blockchain, db, registry, dispatcher } = makeHarness({ logs, dispatch });
    const p = new BlockProcessor(blockchain, db, registry, dispatcher);

    await p.processBlockRange(100, 100);

    expect(db.recordEventTransaction).toHaveBeenCalledTimes(2);
    const recordedHashes = db.recordEventTransaction.mock.calls.map((c: any[]) => c[0]);
    expect(recordedHashes).toEqual(expect.arrayContaining([TX1, TX2]));
  });

  it('does not mark unhandled logs as processed', async () => {
    const logs = [makeLog()];
    const dispatch = vi.fn().mockResolvedValue({ handled: false });
    const { blockchain, db, registry, dispatcher } = makeHarness({ logs, dispatch });
    const p = new BlockProcessor(blockchain, db, registry, dispatcher);

    await p.processBlockRange(100, 100);

    expect(db.markLogProcessed).not.toHaveBeenCalled();
    expect(db.recordEventTransaction).not.toHaveBeenCalled();
  });
});

// ── Dedup via ds_processed_logs ────────────────────────────────

describe('BlockProcessor.processBlockRange dedup', () => {
  it('skips logs already in ds_processed_logs', async () => {
    const logs = [
      makeLog({ index: 0, transactionHash: TX1 }),
      makeLog({ index: 1, transactionHash: TX1 }),
    ];
    const alreadyProcessed = new Set([`${TX1}-0`]); // first log already handled
    const dispatch = vi.fn().mockResolvedValue({ handled: true, eventName: 'E' });
    const { blockchain, db, registry, dispatcher } = makeHarness({
      logs,
      processedKeys: alreadyProcessed,
      dispatch,
    });
    const p = new BlockProcessor(blockchain, db, registry, dispatcher);

    await p.processBlockRange(100, 100);

    expect(dispatch).toHaveBeenCalledTimes(1); // only the second log
    // Batched under Option B; the skipped log is not in the batch.
    expect(db.markLogProcessed).not.toHaveBeenCalled();
    expect(db.markLogsProcessedBatch).toHaveBeenCalledTimes(1);
    expect(db.markLogsProcessedBatch.mock.calls[0][0]).toEqual([
      { txHash: TX1, logIndex: 1, blockNumber: 100 },
    ]);
  });
});

// ── Launcher-first sort ────────────────────────────────────────

describe('BlockProcessor.processBlockRange launcher-first sort', () => {
  it('dispatches launcher logs before other logs within the same tx', async () => {
    // config.contracts.daoShipAndVaultLauncher is the launcher sentinel. The
    // sort should reorder the non-launcher log (index 0) AFTER the launcher
    // log (index 5) because their addresses trigger the launcher-first tie-
    // break, even though log index order would place them oppositely.
    const nonLauncherLog = makeLog({
      address: DAOSHIP,
      index: 0,
      transactionHash: TX1,
      transactionIndex: 0,
    });
    const launcherLog = makeLog({
      address: LAUNCHER,
      index: 5,
      transactionHash: TX1,
      transactionIndex: 0,
      topics: [TOPIC_LAUNCHER],
    });

    const dispatch = vi.fn().mockResolvedValue({ handled: true, eventName: 'E' });
    const { blockchain, db, registry, dispatcher } = makeHarness({
      logs: [nonLauncherLog, launcherLog],
      dispatch,
    });
    const p = new BlockProcessor(blockchain, db, registry, dispatcher);

    await p.processBlockRange(100, 100);

    const addressOrder = dispatch.mock.calls.map((c: any[]) => c[0].log.address);
    expect(addressOrder[0]).toBe(LAUNCHER);
    expect(addressOrder[1]).toBe(DAOSHIP);
  });

  it('preserves original log-index order for non-launcher logs within the same tx', async () => {
    const log0 = makeLog({ index: 2, transactionHash: TX1 });
    const log1 = makeLog({ index: 0, transactionHash: TX1 });
    const log2 = makeLog({ index: 1, transactionHash: TX1 });

    const dispatch = vi.fn().mockResolvedValue({ handled: true, eventName: 'E' });
    const { blockchain, db, registry, dispatcher } = makeHarness({
      logs: [log0, log1, log2],
      dispatch,
    });
    const p = new BlockProcessor(blockchain, db, registry, dispatcher);

    await p.processBlockRange(100, 100);

    const indexOrder = dispatch.mock.calls.map((c: any[]) => c[0].log.index);
    expect(indexOrder).toEqual([0, 1, 2]);
  });
});

// ── Error classification ───────────────────────────────────────

describe('BlockProcessor.processBlockRange error handling', () => {
  it('fails the range on transient handler errors (so it retries)', async () => {
    const logs = [makeLog()];
    const transientErr = new Error('ECONNRESET: connection reset');
    const dispatch = vi.fn().mockRejectedValueOnce(transientErr);
    const { blockchain, db, registry, dispatcher } = makeHarness({ logs, dispatch });
    const p = new BlockProcessor(blockchain, db, registry, dispatcher);

    await expect(p.processBlockRange(100, 100)).rejects.toThrow(/ECONNRESET/);
    // The log was not marked as processed — retry will re-run it
    expect(db.markLogProcessed).not.toHaveBeenCalled();
  });

  it('treats errors with transient code (not just message) as transient', async () => {
    const logs = [makeLog()];
    const err = Object.assign(new Error('something'), { code: 'ETIMEDOUT' });
    const dispatch = vi.fn().mockRejectedValueOnce(err);
    const { blockchain, db, registry, dispatcher } = makeHarness({ logs, dispatch });
    const p = new BlockProcessor(blockchain, db, registry, dispatcher);
    await expect(p.processBlockRange(100, 100)).rejects.toThrow();
  });

  it('logs and skips on deterministic handler errors (no retry)', async () => {
    // Deterministic errors: e.g., validation failure, bad contract data.
    // The range should complete successfully, with the bad log NOT marked.
    const logs = [
      makeLog({ index: 0, transactionHash: TX1 }),
      makeLog({ index: 1, transactionHash: TX1 }),
    ];
    const dispatch = vi.fn()
      .mockRejectedValueOnce(new Error('Invalid proposal data: deterministic')) // log 0 fails
      .mockResolvedValueOnce({ handled: true, eventName: 'E' });                // log 1 succeeds
    const { blockchain, db, registry, dispatcher } = makeHarness({ logs, dispatch });
    const p = new BlockProcessor(blockchain, db, registry, dispatcher);

    // Should NOT throw — deterministic errors are skipped, processing continues.
    await p.processBlockRange(100, 100);

    expect(dispatch).toHaveBeenCalledTimes(2);
    // Only the successful log shows up in the end-of-range batch.
    expect(db.markLogProcessed).not.toHaveBeenCalled();
    expect(db.markLogsProcessedBatch).toHaveBeenCalledTimes(1);
    expect(db.markLogsProcessedBatch.mock.calls[0][0]).toEqual([
      { txHash: TX1, logIndex: 1, blockNumber: 100 },
    ]);
  });

  it('does not fall into infinite discovery loop when registry is stable', async () => {
    // Proves the MAX_DISCOVERY_PASSES loop exits cleanly when registry
    // hasn't changed between passes.
    const logs = [makeLog()];
    const dispatch = vi.fn().mockResolvedValue({ handled: true, eventName: 'E' });
    const { blockchain, db, registry, dispatcher } = makeHarness({ logs, dispatch });
    const p = new BlockProcessor(blockchain, db, registry, dispatcher);
    await expect(p.processBlockRange(100, 100)).resolves.toBeDefined();
  });
});

// ── Block-hash return ──────────────────────────────────────────

describe('BlockProcessor.processBlockRange block-hash return', () => {
  it('returns the cached hash after logs populate blockCache via getBlockTimestamp', async () => {
    const logs = [makeLog({ blockNumber: 100 })];
    const { blockchain, db, registry, dispatcher } = makeHarness({ logs });
    const p = new BlockProcessor(blockchain, db, registry, dispatcher);

    const { lastBlockHash } = await p.processBlockRange(100, 100);
    expect(lastBlockHash).toBe('0xblockhash');
    // getBlock called once via the timestamp path; the return-hash path
    // found the value in the cache (no extra call).
    expect(blockchain.getBlock).toHaveBeenCalledTimes(1);
  });

  it('falls back to fetching block hash when cache is empty (no logs)', async () => {
    const { blockchain, db, registry, dispatcher } = makeHarness({ logs: [] });
    const p = new BlockProcessor(blockchain, db, registry, dispatcher);

    const { lastBlockHash } = await p.processBlockRange(100, 100);
    expect(lastBlockHash).toBe('0xblockhash');
    expect(blockchain.getBlock).toHaveBeenCalledWith(100);
  });

  it('returns empty string when the fallback getBlock throws', async () => {
    // Ensures block-hash failure is non-fatal for the range. Reorg detection
    // upstream will handle the stale hash on the next cycle.
    const { blockchain, db, registry, dispatcher } = makeHarness({ logs: [] });
    blockchain.getBlock.mockRejectedValueOnce(new Error('RPC unavailable'));
    const p = new BlockProcessor(blockchain, db, registry, dispatcher);

    const { lastBlockHash } = await p.processBlockRange(100, 100);
    expect(lastBlockHash).toBe('');
  });
});

// ── RangeCache scope ───────────────────────────────────────────

describe('BlockProcessor.processBlockRange — RangeCache', () => {
  it('injects a RangeCache into every EventContext and records range stats', async () => {
    const logs = [
      makeLog({ index: 0, transactionHash: TX1 }),
      makeLog({ index: 1, transactionHash: TX1 }),
    ];
    const seenCaches: unknown[] = [];
    const dispatch = vi.fn().mockImplementation(async (ctx: any) => {
      seenCaches.push(ctx.cache);
      return { handled: true, eventName: 'E' };
    });
    const { blockchain, db, registry, dispatcher } = makeHarness({ logs, dispatch });
    const p = new BlockProcessor(blockchain, db, registry, dispatcher);

    await p.processBlockRange(100, 100);

    // Same cache instance is threaded through every log in the range.
    expect(seenCaches).toHaveLength(2);
    expect(seenCaches[0]).toBeDefined();
    expect(seenCaches[0]).toBe(seenCaches[1]);

    // The range stats ring buffer captured this call.
    expect(p.recentRangeStats).toHaveLength(1);
    expect(p.recentRangeStats[0]).toMatchObject({
      fromBlock: 100,
      toBlock: 100,
      logCount: 2,
    });
    expect(p.recentRangeStats[0].cache).toBeDefined();
  });

  it('creates a fresh cache per processBlockRange call (no cross-range carryover)', async () => {
    const logs = [makeLog({ index: 0, transactionHash: TX1 })];
    const seenCaches: unknown[] = [];
    const dispatch = vi.fn().mockImplementation(async (ctx: any) => {
      seenCaches.push(ctx.cache);
      return { handled: true, eventName: 'E' };
    });
    const { blockchain, db, registry, dispatcher } = makeHarness({ logs, dispatch });
    const p = new BlockProcessor(blockchain, db, registry, dispatcher);

    await p.processBlockRange(100, 100);
    await p.processBlockRange(101, 101);

    // Two ranges → two distinct cache instances.
    expect(seenCaches).toHaveLength(2);
    expect(seenCaches[0]).not.toBe(seenCaches[1]);
  });

  it('ring buffer retains at most the last 10 ranges', async () => {
    const { blockchain, db, registry, dispatcher } = makeHarness({ logs: [] });
    const p = new BlockProcessor(blockchain, db, registry, dispatcher);

    for (let i = 0; i < 15; i++) {
      await p.processBlockRange(100 + i, 100 + i);
    }
    expect(p.recentRangeStats).toHaveLength(10);
    // Oldest retained range should be #5, newest #14.
    expect(p.recentRangeStats[0].fromBlock).toBe(105);
    expect(p.recentRangeStats[p.recentRangeStats.length - 1].fromBlock).toBe(114);
  });
});
