import { Interface, id, type Log, type TransactionReceipt, type Block } from 'quais';
import PosterAbi from '../abis/Poster.json' with { type: 'json' };

const poster = new Interface(PosterAbi);
export interface HistoricalRecord {
  id: string; dao_id: string | null; tx_hash: string; block_number: string | number | null;
  user_address: string; tag: string; content: string;
}
type Receipt = Pick<TransactionReceipt, 'hash' | 'blockNumber' | 'blockHash' | 'index' | 'status'> & { logs: readonly Pick<Log, 'address' | 'data' | 'topics' | 'index' | 'transactionIndex' | 'blockHash' | 'blockNumber' | 'transactionHash' | 'removed'>[] };
function requireEvidence(valid: unknown): asserts valid { if (!valid) throw new Error('Historical record lacks matching canonical event-order evidence.'); }
function coordinate(value: number) { return Number.isInteger(value) && value >= 0 && value <= 0x7fffffff; }

/** Derive positions only from a receipt whose log exactly reproduces the stored
 * Poster event. A caller must also pin/check the intended RPC chain. */
export function verifyHistoricalRecordOrder(record: HistoricalRecord, receipt: Receipt | null, block: { hash: Block['hash']; woHeader: Pick<Block['woHeader'], 'number'>; transactions: Block['transactions'] } | null, posterAddress: string) {
  requireEvidence(receipt && block && receipt.status === 1 && coordinate(receipt.index)
    && /^0x[0-9a-fA-F]{64}$/.test(receipt.blockHash) && /^0x[0-9a-fA-F]{64}$/.test(receipt.hash)
    && receipt.hash.toLowerCase() === record.tx_hash.toLowerCase() && block.hash?.toLowerCase() === receipt.blockHash.toLowerCase()
    && block.woHeader.number === receipt.blockNumber && block.transactions[receipt.index]?.toLowerCase() === receipt.hash.toLowerCase()
    && Number.isSafeInteger(receipt.blockNumber) && receipt.blockNumber >= 0
    && record.block_number !== null && String(receipt.blockNumber) === String(record.block_number)
    && record.content.length <= 16384 && receipt.logs.length <= 100_000);
  const content = JSON.parse(record.content) as { daoAddress?: unknown };
  requireEvidence(typeof content.daoAddress === 'string' && /^0x[0-9a-fA-F]{40}$/.test(content.daoAddress));
  const dao = content.daoAddress.toLowerCase();
  requireEvidence(record.dao_id === null || record.dao_id.toLowerCase() === dao);
  const matches = receipt.logs.filter(log => {
    if (log.address.toLowerCase() !== posterAddress.toLowerCase() || log.removed || !coordinate(log.index)
      || log.transactionIndex !== receipt.index || log.blockNumber !== receipt.blockNumber
      || log.blockHash.toLowerCase() !== receipt.blockHash.toLowerCase() || log.transactionHash.toLowerCase() !== receipt.hash.toLowerCase()
      || record.id.toLowerCase() !== `${dao}-${receipt.hash.toLowerCase()}-${log.index}` || log.topics[2]?.toLowerCase() !== id(record.tag)) return false;
    const parsed = poster.parseLog({ topics: [...log.topics], data: log.data });
    return parsed?.name === 'NewPost' && String(parsed.args.user).toLowerCase() === record.user_address.toLowerCase() && parsed.args.content === record.content;
  });
  requireEvidence(matches.length === 1);
  return { transaction_index: receipt.index, log_index: matches[0].index };
}
