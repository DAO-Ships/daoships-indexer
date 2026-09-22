/** Explicit, bounded maintenance. Preview by default; --apply writes only verified
 * still-unknown coordinates. Does not replay handlers, rewind or alter checkpoints. */
import { createClient } from '@supabase/supabase-js';
import { FetchRequest, JsonRpcProvider, Shard, isQuaiAddress } from 'quais';
import { verifyHistoricalRecordOrder, type HistoricalRecord } from '../src/utils/record-event-order.js';

function required(name: string): string { const value = process.env[name]; if (!value) throw new Error(`Missing ${name}.`); return value; }
function integer(name: string, fallback?: number): number {
  const text = process.env[name] ?? String(fallback ?? '');
  const value = Number(text);
  if (!/^(0|[1-9]\d*)$/.test(text) || !Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${name}.`);
  return value;
}
async function main() {
  const apply = process.argv.includes('--apply');
  if (process.argv.slice(2).some(arg => arg !== '--apply')) throw new Error('Only --apply is supported; preview is the default.');
  const url = new URL(required('SUPABASE_URL')), rpcUrl = new URL(required('QUAI_RPC_URL'));
  for (const value of [url, rpcUrl]) if (value.protocol !== 'https:' || value.username || value.password || value.search || value.hash) throw new Error('Expected explicit HTTPS service URLs without credentials/query/fragment.');
  const schema = required('SUPABASE_SCHEMA');
  if (!['testnet', 'mainnet', 'dev', 'public'].includes(schema)) throw new Error('Invalid SUPABASE_SCHEMA.');
  const key = required(apply ? 'SUPABASE_SERVICE_KEY' : 'SUPABASE_PUBLISHABLE_KEY');
  if (apply && key.startsWith('sb_publishable_')) throw new Error('--apply requires server-side write credentials.');
  const chainId = integer('CHAIN_ID'), from = integer('BACKFILL_FROM'), to = integer('BACKFILL_TO'), maxRows = integer('BACKFILL_MAX_ROWS', 1000), confirmations = integer('BACKFILL_CONFIRMATIONS', 64);
  if (chainId < 1 || from > to || to - from > 100_000 || maxRows < 1 || maxRows > 10_000 || confirmations < 1) throw new Error('Invalid chain/range/row bounds.');
  const poster = required('POSTER_ADDRESS');
  if (!isQuaiAddress(poster) || !poster.toLowerCase().startsWith('0x00')) throw new Error('Expected the intended Cyprus-1 Poster address.');
  let cursor = process.env.BACKFILL_AFTER_ID ?? '';
  if (cursor && !/^0x[0-9a-fA-F]{40}-0x[0-9a-fA-F]{64}-(0|[1-9]\d{0,9})$/.test(cursor)) throw new Error('Invalid BACKFILL_AFTER_ID.');
  const db = createClient(url.href, key, { db: { schema }, auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(15_000) }) } });
  const request = new FetchRequest(rpcUrl.href); request.timeout = 15_000;
  const provider = new JsonRpcProvider(request, undefined, { usePathing: true });
  let scanned = 0, verified = 0, updated = 0, unavailable = 0, exhausted = false;
  try {
    if ((await provider.getNetwork()).chainId !== BigInt(chainId)) throw new Error('RPC chain mismatch.');
    if (to > (await provider.getBlockNumber(Shard.Cyprus1)) - confirmations) throw new Error('Backfill range has insufficient confirmations.');
    const state = await db.from('ds_indexer_state').select('chain_id,requires_full_reindex').eq('id', 1).single();
    if (state.error || state.data.chain_id !== chainId || state.data.requires_full_reindex) throw new Error('Indexer checkpoint unavailable, wrong-chain or requires reindex.');
    while (scanned < maxRows) {
      const page = await db.from('ds_records').select('id,dao_id,tx_hash,block_number::text,user_address,tag,content')
        .is('transaction_index', null).is('log_index', null).gte('block_number', from).lte('block_number', to)
        .gt('id', cursor).order('id').limit(Math.min(100, maxRows - scanned));
      if (page.error) throw new Error('Cannot read ordering candidates; apply the schema migration first.');
      if (!page.data.length) { exhausted = true; break; }
      for (const record of page.data as unknown as HistoricalRecord[]) {
        scanned++; cursor = record.id;
        const receipt = await provider.getTransactionReceipt(record.tx_hash);
        if (!receipt) { unavailable++; continue; }
        const block = await provider.getBlock(Shard.Cyprus1, receipt.blockNumber, false);
        const positions = verifyHistoricalRecordOrder(record, receipt, block, poster);
        if ((await provider.getNetwork()).chainId !== BigInt(chainId)) throw new Error('RPC chain changed.');
        verified++;
        if (apply) {
          const result = await db.from('ds_records').update(positions).eq('id', record.id).eq('tx_hash', record.tx_hash)
            .eq('block_number', record.block_number).eq('content', record.content).eq('user_address', record.user_address).eq('tag', record.tag)
            .is('transaction_index', null).is('log_index', null).select('id');
          if (result.error) throw new Error('Guarded record ordering update failed.');
          updated += result.data.length;
        }
      }
    }
    console.log(JSON.stringify({ mode: apply ? 'apply' : 'preview', chainId, from, to, scanned, verified, updated, unavailable, exhausted, complete: exhausted && unavailable === 0, continuationAfterId: cursor || null }));
  } finally { provider.destroy(); }
}
main().catch(() => { console.error('Record-order backfill failed; no transaction/hash order was guessed. Check explicit configuration, migration, and canonical RPC evidence.'); process.exitCode = 1; });
