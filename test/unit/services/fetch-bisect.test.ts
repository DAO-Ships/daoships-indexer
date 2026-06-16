/**
 * Tests for the U1/U6 getLogs oversize + bisect path.
 *
 * Covers the processor's `fetchWithBisect` contract:
 *   - When the fetcher returns cleanly, logs flow through unchanged.
 *   - When it throws "oversize response", the range splits and both
 *     halves retry.
 *   - When bisection hits the minimum range, the error is surfaced.
 *   - Non-oversize errors propagate without bisecting.
 *
 * We exercise `fetchAllLogs` via a full `processBlockRange` so the
 * bisect wiring is actually tested (fetchWithBisect is private).
 */
import { describe, it, expect, vi } from 'vitest';
import { BlockProcessor } from '../../../src/services/processor.js';
import type { Log } from 'quais';

const LOG_TOPIC = '0x' + '1'.repeat(64);

function makeLog(idx: number): Log {
  return {
    address: '0x' + '1'.repeat(40),
    blockNumber: 100,
    transactionHash: '0x' + 'a'.repeat(64),
    transactionIndex: 0,
    index: idx,
    topics: [LOG_TOPIC],
    data: '0x',
  } as Log;
}

function makeHarness(opts: {
  getLogs?: ReturnType<typeof vi.fn>;
  unfilteredTopics?: string[];
} = {}) {
  const blockchain = {
    getBlock: vi.fn().mockResolvedValue({ hash: '0xabc', woHeader: { timestamp: 1700000000 } }),
    getLogs: opts.getLogs ?? vi.fn().mockResolvedValue([]),
    getBlockNumber: vi.fn().mockResolvedValue(0),
  } as any;
  const db = {
    getProcessedLogKeys: vi.fn().mockResolvedValue(new Set()),
    markLogProcessed: vi.fn().mockResolvedValue(undefined),
    recordEventTransaction: vi.fn().mockResolvedValue(undefined),
  } as any;
  const registry = {
    getAllDaoShipAddresses: vi.fn().mockReturnValue([]),
    getAllTokenAddresses: vi.fn().mockReturnValue([]),
    getAllNavigatorAddresses: vi.fn().mockReturnValue([]),
    getDaoByDaoShipAddress: vi.fn().mockReturnValue(undefined),
    getDaoByTokenAddress: vi.fn().mockReturnValue(undefined),
    getDaoByNavigatorAddress: vi.fn().mockReturnValue(undefined),
    daoCount: 0,
  } as any;
  const dispatcher = {
    getRegisteredTopics: vi.fn().mockReturnValue([LOG_TOPIC]),
    getUnfilteredTopics: vi.fn().mockReturnValue(opts.unfilteredTopics ?? []),
    dispatch: vi.fn().mockResolvedValue({ handled: false }),
  } as any;
  return { blockchain, db, registry, dispatcher };
}

describe('fetchWithBisect — oversize handling', () => {
  it('passes through clean responses without bisecting', async () => {
    const getLogs = vi.fn().mockResolvedValue([makeLog(0)]);
    const { blockchain, db, registry, dispatcher } = makeHarness({ getLogs, unfilteredTopics: [LOG_TOPIC] });
    const p = new BlockProcessor(blockchain, db, registry, dispatcher);

    await p.processBlockRange(100, 200);

    // Exactly one call — no bisect triggered.
    expect(getLogs).toHaveBeenCalledTimes(1);
  });

  it('bisects on oversize and retries both halves', async () => {
    let call = 0;
    const getLogs = vi.fn().mockImplementation(async () => {
      call++;
      // First call (full range 100-200) throws oversize. Subsequent
      // calls (100-150, 151-200) succeed.
      if (call === 1) {
        throw new Error('getLogs oversize response: 200000 logs exceeds FETCH_MAX_LOGS_PER_CALL=100000');
      }
      return [];
    });
    const { blockchain, db, registry, dispatcher } = makeHarness({ getLogs, unfilteredTopics: [LOG_TOPIC] });
    const p = new BlockProcessor(blockchain, db, registry, dispatcher);

    await p.processBlockRange(100, 200);

    // 1 failed + 2 halves = 3 calls total.
    expect(getLogs).toHaveBeenCalledTimes(3);
  });

  it('recursively bisects when halves are also oversize', async () => {
    const oversizeErr = new Error('getLogs oversize response: 200000 logs exceeds FETCH_MAX_LOGS_PER_CALL');
    const getLogs = vi.fn().mockImplementation(async (_addr: any, from: number, to: number) => {
      // Ranges of size > 25 throw; smaller succeed.
      if (to - from + 1 > 25) throw oversizeErr;
      return [];
    });
    const { blockchain, db, registry, dispatcher } = makeHarness({ getLogs, unfilteredTopics: [LOG_TOPIC] });
    const p = new BlockProcessor(blockchain, db, registry, dispatcher);

    await p.processBlockRange(100, 199); // 100 blocks

    // Expect the range to bisect down until each leaf is ≤25 blocks.
    // 100 → 50+50 → 25+25+25+25 = 4 leaf calls + 3 internal throws = 7
    expect(getLogs.mock.calls.length).toBeGreaterThanOrEqual(7);
  });

  it('surfaces oversize error when the range cannot be split further', async () => {
    const oversizeErr = new Error('getLogs oversize response: 200000 logs exceeds FETCH_MAX_LOGS_PER_CALL');
    const getLogs = vi.fn().mockRejectedValue(oversizeErr);
    const { blockchain, db, registry, dispatcher } = makeHarness({ getLogs, unfilteredTopics: [LOG_TOPIC] });
    const p = new BlockProcessor(blockchain, db, registry, dispatcher);

    // Single-block range: can't bisect further with default minBisectRange=1.
    await expect(p.processBlockRange(100, 100)).rejects.toThrow(/oversize response/);
  });

  it('non-oversize errors propagate without bisecting', async () => {
    const getLogs = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    const { blockchain, db, registry, dispatcher } = makeHarness({ getLogs, unfilteredTopics: [LOG_TOPIC] });
    const p = new BlockProcessor(blockchain, db, registry, dispatcher);

    await expect(p.processBlockRange(100, 200)).rejects.toThrow(/ECONNRESET/);
    // One call, no bisect.
    expect(getLogs).toHaveBeenCalledTimes(1);
  });
});

describe('BlockProcessor — per-topic counters', () => {
  it('tracks per-topic log counts in recentRangeStats', async () => {
    const TOPIC_A = '0x' + 'a'.repeat(64);
    const TOPIC_B = '0x' + 'b'.repeat(64);
    const logs: Log[] = [
      { ...makeLog(0), topics: [TOPIC_A] } as Log,
      { ...makeLog(1), topics: [TOPIC_A] } as Log,
      { ...makeLog(2), topics: [TOPIC_B] } as Log,
    ];
    const getLogs = vi.fn().mockResolvedValue(logs);
    const { blockchain, db, registry, dispatcher } = makeHarness({ getLogs, unfilteredTopics: [TOPIC_A, TOPIC_B] });
    dispatcher.getRegisteredTopics.mockReturnValue([TOPIC_A, TOPIC_B]);
    const p = new BlockProcessor(blockchain, db, registry, dispatcher);

    await p.processBlockRange(100, 100);

    expect(p.recentRangeStats).toHaveLength(1);
    const stats = p.recentRangeStats[0];
    expect(stats.topicCounts[TOPIC_A]).toBe(2);
    expect(stats.topicCounts[TOPIC_B]).toBe(1);
    expect(stats.fetchMode).toBeDefined();
  });
});
