import { describe, it, expect, vi } from 'vitest';
import { Shard } from 'quais';
import { blockTag, parseChainBlock } from '../../src/utils/chain-block.js';
import { BlockchainService } from '../../src/services/blockchain.js';
import { extractBlockTimestamp } from '../../src/utils/validation.js';

const hash = '0x' + 'ab'.repeat(32);
const tx = '0x' + 'cd'.repeat(32);

// Shape of a real older mainnet quai_getBlockByNumber result (block 9153196),
// trimmed: totalEntropy is null, which is what makes quais' getBlock() throw.
const raw = (overrides: Record<string, unknown> = {}) => ({
  hash,
  totalEntropy: null,
  header: { number: ['0x1edd95', '0x4af034'], gasUsed: '0xe5d487' },
  woHeader: { number: '0x8baaac', timestamp: '0x6a5ff543', hash, location: '0x0000' },
  transactions: [tx],
  ...overrides,
});

describe('parseChainBlock', () => {
  it('reads the fields the indexer uses from a block quais cannot format', () => {
    expect(parseChainBlock(raw(), 9153196)).toEqual({
      hash, woHeader: { number: 9153196, timestamp: 0x6a5ff543 }, transactions: [tx],
    });
  });

  it('yields a timestamp extractBlockTimestamp accepts', () => {
    const block = parseChainBlock(raw(), 9153196);
    expect(extractBlockTimestamp(block as unknown as Record<string, unknown>, 9153196)).toBe(0x6a5ff543);
  });

  it('accepts a block with no transactions', () => {
    expect(parseChainBlock(raw({ transactions: [] }), 9153196).transactions).toEqual([]);
  });

  it('rejects a block other than the one requested', () => {
    expect(() => parseChainBlock(raw(), 9153197)).toThrow('Requested block 9153197 but node returned 9153196');
  });

  it.each([
    ['a non-object', null],
    ['a missing hash', raw({ hash: undefined })],
    ['a short hash', raw({ hash: '0xabcd' })],
    ['a missing woHeader', raw({ woHeader: undefined })],
    ['a decimal woHeader.number', raw({ woHeader: { number: '9153196', timestamp: '0x6a5ff543' } })],
    ['a missing timestamp', raw({ woHeader: { number: '0x8baaac' } })],
    ['transactions that are not an array', raw({ transactions: tx })],
    ['a transaction that is not a hash', raw({ transactions: [{ hash: tx }] })],
  ])('throws on %s rather than returning a partial block', (_label, input) => {
    expect(() => parseChainBlock(input, 9153196)).toThrow();
  });
});

describe('blockTag', () => {
  it('encodes a height as a JSON-RPC quantity', () => {
    expect(blockTag(0)).toBe('0x0');
    expect(blockTag(9153196)).toBe('0x8baaac');
  });
});

describe('BlockchainService.getBlock', () => {
  function serviceWith(send: ReturnType<typeof vi.fn>) {
    const service = new BlockchainService();
    (service as unknown as { provider: { send: typeof send } }).provider = { send };
    return service;
  }

  it('reads the block raw through the provider, on the indexer shard', async () => {
    const send = vi.fn().mockResolvedValue(raw());
    const block = await serviceWith(send).getBlock(9153196);
    expect(send).toHaveBeenCalledWith('quai_getBlockByNumber', ['0x8baaac', false], Shard.Cyprus1);
    expect(block).toEqual({ hash, woHeader: { number: 9153196, timestamp: 0x6a5ff543 }, transactions: [tx] });
  });

  it('returns null for a block the node does not have, as provider.getBlock() does', async () => {
    const send = vi.fn().mockResolvedValue(null);
    expect(await serviceWith(send).getBlock(99_999_999)).toBeNull();
  });
});
