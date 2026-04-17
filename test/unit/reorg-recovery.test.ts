import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BlockProcessor } from '../../src/services/processor.js';

// M4: BlockProcessor.clearCaches() should drop cached block hashes so that
// post-reorg processing doesn't re-surface pre-reorg block hashes via the
// cached fast path in processBlockRange().
describe('BlockProcessor.clearCaches (M4)', () => {
  // Feed an unmatched log — processLogs calls getBlockTimestamp before
  // dispatch, which populates blockCache with { timestamp, hash } for toBlock.
  const fakeLog = {
    address: '0x0000000000000000000000000000000000000001',
    blockNumber: 100,
    transactionHash: '0x' + 'aa'.repeat(32),
    index: 0,
    transactionIndex: 0,
    topics: ['0xdeadbeef'],
    data: '0x',
  };

  function makeHarness() {
    const blockchain = {
      getBlock: vi.fn().mockResolvedValue({
        hash: '0xaaaa',
        woHeader: { timestamp: 1700000000 },
      }),
      getLogs: vi.fn().mockResolvedValue([fakeLog]),
      getBlockNumber: vi.fn().mockResolvedValue(0),
    } as any;
    const db = {
      getProcessedLogKeys: vi.fn().mockResolvedValue(new Set()),
      markLogProcessed: vi.fn().mockResolvedValue(undefined),
      recordEventTransaction: vi.fn().mockResolvedValue(undefined),
    } as any;
    const registry = {
      getAllDaoShipAddresses: () => [],
      getAllTokenAddresses: () => [],
      getAllNavigatorAddresses: () => [],
      getDaoByDaoShipAddress: () => undefined,
      getDaoByTokenAddress: () => undefined,
      getDaoByNavigatorAddress: () => undefined,
      daoCount: 0,
    } as any;
    const dispatcher = {
      getRegisteredTopics: () => ['0xtopic'],
      getUnfilteredTopics: () => [],
      dispatch: vi.fn().mockResolvedValue({ handled: false }),
    } as any;
    return { blockchain, db, registry, dispatcher };
  }

  it('clears the internal block cache so next call re-fetches from chain', async () => {
    const { blockchain, db, registry, dispatcher } = makeHarness();
    const processor = new BlockProcessor(blockchain, db, registry, dispatcher);

    // 1. First call: cache miss → one getBlock call for the timestamp path.
    //    The return-hash path at end of processBlockRange reuses the cached entry.
    await processor.processBlockRange(100, 100);
    expect(blockchain.getBlock).toHaveBeenCalledTimes(1);

    // 2. Second call: cache hit → no additional getBlock calls.
    blockchain.getBlock.mockClear();
    await processor.processBlockRange(100, 100);
    expect(blockchain.getBlock).toHaveBeenCalledTimes(0);

    // 3. After clearCaches(): cache miss again → getBlock is called once more.
    processor.clearCaches();
    await processor.processBlockRange(100, 100);
    expect(blockchain.getBlock).toHaveBeenCalledTimes(1);
  });

  it('clearCaches() is safe to call on an empty cache', () => {
    const { blockchain, db, registry, dispatcher } = makeHarness();
    const processor = new BlockProcessor(blockchain, db, registry, dispatcher);
    expect(() => processor.clearCaches()).not.toThrow();
  });
});
