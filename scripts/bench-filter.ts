/**
 * Synthetic benchmark: in-process registry filter throughput.
 *
 * When `FETCH_MODE=unfiltered`, the indexer receives every chain-wide log
 * matching a registered topic0 and filters in-process against the
 * `ContractRegistry`. This script simulates that workload at 10k-DAO scale
 * to answer:
 *
 *   1. What's the wall-clock cost of filtering N logs against M registered
 *      addresses?
 *   2. What's the peak heap allocation for holding a raw unfiltered Log[]
 *      before the filter runs?
 *   3. At what input size does the filter become a bottleneck relative to
 *      the 5-second poll interval?
 *
 * No RPC, no DB. Purely CPU/memory. Safe to run anywhere.
 *
 * ── Usage ─────────────────────────────────────────────────────
 *   npm run bench:filter
 *
 *   Env:
 *     BENCH_DAOS       default 10000  (registered DAO count)
 *     BENCH_LOG_COUNTS default '10000,100000,1000000' (comma-sep input sizes)
 *     BENCH_MATCH_RATE default 0.01  (fraction of logs from registered addresses)
 *     BENCH_ITERATIONS default 3     (runs per config — reports median)
 *
 * ── Interpretation ────────────────────────────────────────────
 * Filter is the fast path; slow here = redesign. Rough budget at 5s poll:
 *   <50 ms filter  → filter is free
 *   50-500 ms      → visible in wall-clock; acceptable
 *   >500 ms        → push back; consider streaming or worker threads
 */

import { ContractRegistry } from '../src/registry/contract-registry.js';

interface BenchResult {
  logCount: number;
  daoCount: number;
  matchRate: number;
  kept: number;
  wallMs: number;
  peakHeapMB: number;
  heapDeltaMB: number;
  logsPerSec: number;
}

function rand32Hex(): string {
  let h = '0x';
  for (let i = 0; i < 40; i++) {
    h += ((Math.random() * 16) | 0).toString(16);
  }
  return h;
}

function parseList(env: string | undefined, fallback: number[]): number[] {
  if (!env) return fallback;
  return env.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
}

function mb(bytes: number): number {
  return +(bytes / (1024 * 1024)).toFixed(1);
}

interface FakeLog {
  address: string;
  blockNumber: number;
  transactionHash: string;
  transactionIndex: number;
  index: number;
  topics: string[];
  data: string;
}

function makeFakeLog(address: string, index: number): FakeLog {
  // Realistic shape: one topic0, two indexed args (from/to for Transfer), 32-byte data
  return {
    address,
    blockNumber: 1_000_000 + (index % 500),
    transactionHash: '0x' + 'a'.repeat(64),
    transactionIndex: index & 0xff,
    index: index & 0xff,
    topics: [
      '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', // Transfer
      '0x' + '1'.repeat(64),
      '0x' + '2'.repeat(64),
    ],
    data: '0x' + '3'.repeat(64),
  };
}

function buildRegistry(daoCount: number): { registry: ContractRegistry; knownAddresses: string[] } {
  const registry = new ContractRegistry({});
  const knownAddresses: string[] = [];
  for (let i = 0; i < daoCount; i++) {
    const daoShip = rand32Hex();
    const shares = rand32Hex();
    const loot = rand32Hex();
    const avatar = rand32Hex();
    registry.registerDao({ daoShipAddress: daoShip, sharesAddress: shares, lootAddress: loot, avatar });
    knownAddresses.push(daoShip, shares, loot);
  }
  return { registry, knownAddresses };
}

function generateLogs(count: number, knownAddresses: string[], matchRate: number): FakeLog[] {
  const logs: FakeLog[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const useKnown = Math.random() < matchRate;
    const address = useKnown
      ? knownAddresses[(Math.random() * knownAddresses.length) | 0]
      : rand32Hex();
    logs[i] = makeFakeLog(address, i);
  }
  return logs;
}

/**
 * The actual filter hot loop. Same shape as what a production
 * `fetchAllLogs(unfiltered)` would run: iterate the raw Log[] and keep
 * only entries whose `address` is a known-registered contract.
 *
 * Uses the registry's O(1) Map lookups — same as processor.ts today.
 */
function filter(logs: FakeLog[], registry: ContractRegistry): FakeLog[] {
  const kept: FakeLog[] = [];
  for (const log of logs) {
    const addr = log.address.toLowerCase();
    if (
      registry.getDaoByDaoShipAddress(addr) ||
      registry.getDaoByTokenAddress(addr) ||
      registry.getDaoByNavigatorAddress(addr)
    ) {
      kept.push(log);
    }
  }
  return kept;
}

function runOnce(
  logCount: number,
  daoCount: number,
  matchRate: number,
): BenchResult {
  // Force GC before measuring (only effective with --expose-gc).
  if (typeof global.gc === 'function') global.gc();
  const baselineHeap = process.memoryUsage().heapUsed;

  const { registry, knownAddresses } = buildRegistry(daoCount);
  const logs = generateLogs(logCount, knownAddresses, matchRate);
  const preFilterHeap = process.memoryUsage().heapUsed;

  const t0 = performance.now();
  const kept = filter(logs, registry);
  const wallMs = performance.now() - t0;

  const peakHeap = process.memoryUsage().heapUsed;

  return {
    logCount,
    daoCount,
    matchRate,
    kept: kept.length,
    wallMs: +wallMs.toFixed(2),
    peakHeapMB: mb(peakHeap),
    heapDeltaMB: mb(peakHeap - baselineHeap),
    logsPerSec: Math.round((logCount / wallMs) * 1000),
  };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

function main(): void {
  const daoCount = Number(process.env.BENCH_DAOS ?? '10000');
  const logCounts = parseList(process.env.BENCH_LOG_COUNTS, [10_000, 100_000, 1_000_000]);
  const matchRate = Number(process.env.BENCH_MATCH_RATE ?? '0.01');
  const iterations = Number(process.env.BENCH_ITERATIONS ?? '3');

  if (typeof global.gc !== 'function') {
    console.log('NOTE: Run with `node --expose-gc` (or `NODE_OPTIONS=--expose-gc`) for accurate heap measurements.');
  }
  console.log('');
  console.log(`Registry: ${daoCount.toLocaleString()} DAOs → ${(daoCount * 3).toLocaleString()} registered addresses`);
  console.log(`Match rate: ${(matchRate * 100).toFixed(2)}% (fraction of raw logs from registered addresses)`);
  console.log(`Iterations: ${iterations} per config (median reported)`);
  console.log('');

  const col = (s: string, w: number) => s.padStart(w);
  console.log(
    col('logs', 12) +
    col('kept', 10) +
    col('wall (ms)', 12) +
    col('logs/sec', 14) +
    col('heap Δ (MB)', 14) +
    col('peak heap (MB)', 18),
  );
  console.log('-'.repeat(80));

  for (const logCount of logCounts) {
    const runs: BenchResult[] = [];
    for (let i = 0; i < iterations; i++) {
      runs.push(runOnce(logCount, daoCount, matchRate));
    }
    const r = {
      logCount,
      kept: Math.round(median(runs.map((x) => x.kept))),
      wallMs: +median(runs.map((x) => x.wallMs)).toFixed(1),
      logsPerSec: Math.round(median(runs.map((x) => x.logsPerSec))),
      heapDeltaMB: +median(runs.map((x) => x.heapDeltaMB)).toFixed(1),
      peakHeapMB: +median(runs.map((x) => x.peakHeapMB)).toFixed(1),
    };
    console.log(
      col(r.logCount.toLocaleString(), 12) +
      col(r.kept.toLocaleString(), 10) +
      col(String(r.wallMs), 12) +
      col(r.logsPerSec.toLocaleString(), 14) +
      col(String(r.heapDeltaMB), 14) +
      col(String(r.peakHeapMB), 18),
    );
  }

  console.log('');
  console.log('Budget guide (per 5-second poll interval):');
  console.log('  <50 ms filter     → free, noise-level');
  console.log('  50-500 ms filter  → acceptable, visible in wall-clock');
  console.log('  >500 ms filter    → redesign needed (streaming filter, worker thread, or stay scoped)');
}

main();
