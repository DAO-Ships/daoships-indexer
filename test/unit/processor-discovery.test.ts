/**
 * S2: When processBlockRange reaches MAX_DISCOVERY_PASSES (3) and the
 * registry is STILL discovering new addresses, we must throw so the block
 * range retries. Silently advancing would permanently drop events for those
 * addresses.
 */
import { describe, it, expect, vi } from 'vitest';
import { BlockProcessor } from '../../src/services/processor.js';

function makeHarness(registryHook: {
  daoIdx: { value: number };
  addressList: string[];
}) {
  const blockchain = {
    getBlock: vi.fn().mockResolvedValue({ hash: '0xaaaa', woHeader: { timestamp: 1700000000 } }),
    getLogs: vi.fn().mockResolvedValue([]),
    getBlockNumber: vi.fn().mockResolvedValue(0),
  } as any;
  const db = {
    getProcessedLogKeys: vi.fn().mockResolvedValue(new Set()),
    markLogProcessed: vi.fn().mockResolvedValue(undefined),
    recordEventTransaction: vi.fn().mockResolvedValue(undefined),
  } as any;
  const registry = {
    // Every call to getAllDaoShipAddresses adds a new fake address to the
    // list. This simulates processing uncovering new DAOs in every pass so
    // that the discovery loop never settles — the pathological case S2
    // defends against.
    getAllDaoShipAddresses: () => {
      const addr = `0x${String(registryHook.daoIdx.value).padStart(40, '0')}`;
      registryHook.daoIdx.value += 1;
      registryHook.addressList.push(addr);
      return [...registryHook.addressList];
    },
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

describe('BlockProcessor discovery pass overflow (S2)', () => {
  it('throws when MAX_DISCOVERY_PASSES is reached with addresses still pending', async () => {
    const hook = { daoIdx: { value: 1 }, addressList: [] as string[] };
    const { blockchain, db, registry, dispatcher } = makeHarness(hook);
    const processor = new BlockProcessor(blockchain, db, registry, dispatcher);

    await expect(processor.processBlockRange(100, 100)).rejects.toThrow(
      /Discovery pass limit \(3\) exceeded/,
    );
  });

  it('does not throw when discovery settles before the cap (stable registry)', async () => {
    // Stable registry — never returns a new address.
    const blockchain = {
      getBlock: vi.fn().mockResolvedValue({ hash: '0xbbbb', woHeader: { timestamp: 1700000000 } }),
      getLogs: vi.fn().mockResolvedValue([]),
      getBlockNumber: vi.fn().mockResolvedValue(0),
    } as any;
    const db = {
      getProcessedLogKeys: vi.fn().mockResolvedValue(new Set()),
      markLogProcessed: vi.fn().mockResolvedValue(undefined),
      recordEventTransaction: vi.fn().mockResolvedValue(undefined),
    } as any;
    const stableRegistry = {
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

    const processor = new BlockProcessor(blockchain, db, stableRegistry, dispatcher);
    await expect(processor.processBlockRange(100, 100)).resolves.toMatchObject({
      lastBlockHash: '0xbbbb',
    });
  });
});
