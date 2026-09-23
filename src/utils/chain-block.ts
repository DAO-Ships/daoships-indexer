// ═══════════════════════════════════════════════════════════════════════════
// Raw block reads.
//
// quais (checked through 1.0.0-alpha.57) cannot format older mainnet blocks: the
// node returns totalEntropy as null for blocks more than a few hundred thousand
// behind the head, and provider.getBlock() throws BAD_DATA on every one. Live
// indexing only touches recent blocks, so this surfaces on a resync — and the
// mainnet START_BLOCK is inside the affected range.
//
// Everything that reads a block needs only its hash, height, timestamp and
// transaction hashes. Read the block with quai_getBlockByNumber through the
// provider (keeping its shard routing) and validate just those fields.
// ═══════════════════════════════════════════════════════════════════════════

/** The block fields the indexer reads. */
export interface ChainBlock {
  hash: string;
  woHeader: { number: number; timestamp: number };
  transactions: string[];
}

const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const QUANTITY_RE = /^0x[0-9a-fA-F]+$/;

function quantity(value: unknown, field: string, blockNumber: number): number {
  if (typeof value !== 'string' || !QUANTITY_RE.test(value)) {
    throw new Error(`Block ${blockNumber} has invalid ${field}: ${String(value)}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`Block ${blockNumber} ${field} out of range: ${value}`);
  return parsed;
}

/**
 * Validate a raw quai_getBlockByNumber result (transaction hashes only).
 * Throws on anything malformed, as provider.getBlock() does, rather than
 * returning a partial block.
 */
export function parseChainBlock(raw: unknown, blockNumber: number): ChainBlock {
  if (!raw || typeof raw !== 'object') throw new Error(`Block ${blockNumber} response is not an object`);
  const block = raw as { hash?: unknown; woHeader?: { number?: unknown; timestamp?: unknown }; transactions?: unknown };

  if (typeof block.hash !== 'string' || !HASH_RE.test(block.hash)) {
    throw new Error(`Block ${blockNumber} has invalid hash: ${String(block.hash)}`);
  }
  if (!block.woHeader || typeof block.woHeader !== 'object') throw new Error(`Block ${blockNumber} has no woHeader`);

  const number = quantity(block.woHeader.number, 'woHeader.number', blockNumber);
  if (number !== blockNumber) throw new Error(`Requested block ${blockNumber} but node returned ${number}`);
  const timestamp = quantity(block.woHeader.timestamp, 'woHeader.timestamp', blockNumber);

  if (!Array.isArray(block.transactions) || !block.transactions.every((tx): tx is string => typeof tx === 'string' && HASH_RE.test(tx))) {
    throw new Error(`Block ${blockNumber} has invalid transactions`);
  }

  return { hash: block.hash, woHeader: { number, timestamp }, transactions: block.transactions };
}

/** JSON-RPC block tag for a height. */
export function blockTag(blockNumber: number): string {
  return `0x${blockNumber.toString(16)}`;
}
