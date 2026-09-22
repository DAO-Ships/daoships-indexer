import { describe, it, expect } from 'vitest';
import { Interface } from 'quais';
import { verifyHistoricalRecordOrder } from '../../src/utils/record-event-order.js';
import PosterAbi from '../../src/abis/Poster.json' with { type: 'json' };

const dao = '0x0011111111111111111111111111111111111111', author = '0x0022222222222222222222222222222222222222', posterAddress = '0x0033333333333333333333333333333333333333';
const hash = '0x' + 'ab'.repeat(32), blockHash = '0x' + 'cd'.repeat(32);
const content = JSON.stringify({ schemaVersion: '1.0', daoAddress: dao, banner: 'https://example.test/new' });
const tag = 'daoships.dao.profile';
const iface = new Interface(PosterAbi), event = iface.encodeEventLog(iface.getEvent('NewPost')!, [author, content, tag]);
const log = { address: posterAddress, data: event.data, topics: event.topics, index: 17, transactionIndex: 4, blockHash, blockNumber: 100, transactionHash: hash, removed: false };
const receipt = { hash, blockNumber: 100, blockHash, index: 4, status: 1, logs: [log] };
const record = { id: `${dao}-${hash}-17`, dao_id: dao, tx_hash: hash, block_number: '100', user_address: author, tag, content };
const block = { hash: blockHash, woHeader: { number: 100 }, transactions: ['', '', '', '', hash] };

describe('verified historical Poster event order', () => {
  it('uses exact receipt/log coordinates and supports orphan records without inventing hash order', () => {
    expect(verifyHistoricalRecordOrder(record, receipt, block, posterAddress)).toEqual({ transaction_index: 4, log_index: 17 });
    expect(verifyHistoricalRecordOrder({ ...record, dao_id: null }, receipt, block, posterAddress)).toEqual({ transaction_index: 4, log_index: 17 });
  });
  it('rejects unavailable/reorged/wrong-transaction receipts and identity/content mismatches', () => {
    for (const candidate of [null, { ...receipt, hash: blockHash }, { ...receipt, status: 0 }, { ...receipt, index: -1 }, { ...receipt, logs: [] }, { ...receipt, logs: [log, log] }]) {
      expect(() => verifyHistoricalRecordOrder(record, candidate, block, posterAddress)).toThrow();
    }
    expect(() => verifyHistoricalRecordOrder(record, receipt, { ...block, hash }, posterAddress)).toThrow();
    expect(() => verifyHistoricalRecordOrder(record, receipt, { ...block, transactions: [hash] }, posterAddress)).toThrow();
    for (const patch of [{ id: `${dao}-${hash}-18` }, { block_number: '101' }, { user_address: dao }, { dao_id: author }, { tag: 'daoships.dao.profile.initial' }, { content: content + ' ' }]) {
      expect(() => verifyHistoricalRecordOrder({ ...record, ...patch }, receipt, block, posterAddress)).toThrow();
    }
    for (const patch of [{ removed: true }, { transactionIndex: 5 }, { index: -1 }, { address: author }, { blockHash: hash }, { transactionHash: blockHash }, { blockNumber: 99 }]) {
      expect(() => verifyHistoricalRecordOrder(record, { ...receipt, logs: [{ ...log, ...patch }] }, block, posterAddress)).toThrow();
    }
  });
});
