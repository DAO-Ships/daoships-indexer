/**
 * Measurement spike: per-topic0 log volume on Quai.
 *
 * The audit recommendation to flip from address-filtered `getLogs` to
 * chain-wide topic0 fetching (docs/AUDIT_VALIDATION_2026-04-16.md A3/SC1)
 * trades RPC call count for response size. This script measures the
 * actual response size + count per registered topic0 over a configurable
 * block range so we can make the flip decision with data.
 *
 * ── What it does ──────────────────────────────────────────────
 * 1. Loads every Interface the indexer registers against and extracts
 *    the topic0 hash per event.
 * 2. For each distinct topic0, issues an UNFILTERED `getLogs` (no
 *    address filter) over the sample range.
 * 3. Records: log count, approximate bytes (data + topics), number of
 *    distinct emitting addresses.
 * 4. Outputs a table + JSON so the flip threshold rule can be evaluated.
 *
 * ── Flip threshold (proposed) ─────────────────────────────────
 * Topic is safe to flip to unfiltered when BOTH:
 *   - unfilteredLogCount < 50,000 per range, AND
 *   - unfilteredBytesApprox < 5 × estimated scopedBytes
 *
 * The 5× fudge factor accounts for the 400→1 RPC call reduction at 10k
 * DAOs (100-address chunks). The 50k count cap is a CPU+memory bound on
 * in-process filtering. Tune after running this script.
 *
 * ── Usage ─────────────────────────────────────────────────────
 *   npm run measure:log-volume -- --from-block 1000000 --to-block 1001000
 *
 *   Env:
 *     RPC_URL         (required — matches the indexer's .env)
 *     MEASURE_OUT     (optional, default: measurement-<timestamp>.json)
 *     SKIP_TOPICS     (optional, comma-sep topic0 hashes to omit)
 *
 * This script does NOT mutate state. Safe to run against mainnet.
 */

import 'dotenv/config';
import { Interface, quais, Shard } from 'quais';
import { writeFileSync } from 'node:fs';

// Import every Interface registered in src/index.ts so we extract the
// same topic0 set the indexer actually listens for.
import {
  daoShipAndVaultLauncherIface,
  daoShipLauncherIface,
} from '../src/handlers/launcher.js';
import { sharesIface } from '../src/handlers/tokens.js';
import { posterIface } from '../src/handlers/poster.js';
import { nftGatedNavigatorIface } from '../src/handlers/navigators.js';
import { signalNavigatorIface } from '../src/handlers/signal.js';
import { timelockNavigatorIface } from '../src/handlers/timelock.js';
import { vestingNavigatorIface } from '../src/handlers/vesting.js';
import { budgetNavigatorIface } from '../src/handlers/budget.js';
import { avatarModulesIface } from '../src/handlers/vault-modules.js';
import DAOShipAbi from '../src/abis/DAOShip.json' with { type: 'json' };
import INavigatorAbi from '../src/abis/INavigator.json' with { type: 'json' };
import OnboarderNavigatorAbi from '../src/abis/OnboarderNavigator.json' with { type: 'json' };

const daoShipIface = new Interface(DAOShipAbi);
const iNavIface = new Interface(INavigatorAbi);
const onboarderNavigatorIface = new Interface(OnboarderNavigatorAbi);

// Match src/index.ts registration list. Keep in sync if handlers change.
const REGISTRATIONS: Array<{ iface: Interface; event: string }> = [
  { iface: daoShipAndVaultLauncherIface, event: 'LaunchDAOShipAndVault' },
  { iface: daoShipLauncherIface, event: 'LaunchDAOShip' },
  { iface: daoShipIface, event: 'SetupComplete' },
  { iface: daoShipIface, event: 'SubmitProposal' },
  { iface: daoShipIface, event: 'SponsorProposal' },
  { iface: daoShipIface, event: 'SubmitVote' },
  { iface: daoShipIface, event: 'ProcessProposal' },
  { iface: daoShipIface, event: 'CancelProposal' },
  { iface: daoShipIface, event: 'Ragequit' },
  { iface: daoShipIface, event: 'NavigatorSet' },
  { iface: daoShipIface, event: 'GovernanceConfigSet' },
  { iface: daoShipIface, event: 'SetGuildTokens' },
  { iface: daoShipIface, event: 'MintShares' },
  { iface: daoShipIface, event: 'MintLoot' },
  { iface: daoShipIface, event: 'BurnShares' },
  { iface: daoShipIface, event: 'BurnLoot' },
  { iface: daoShipIface, event: 'LockAdmin' },
  { iface: daoShipIface, event: 'LockManager' },
  { iface: daoShipIface, event: 'LockGovernor' },
  { iface: daoShipIface, event: 'ConvertSharesToLoot' },
  { iface: daoShipIface, event: 'AdminConfigSet' },
  { iface: sharesIface, event: 'Transfer' },
  { iface: sharesIface, event: 'DelegateChanged' },
  { iface: sharesIface, event: 'DelegateVotesChanged' },
  { iface: sharesIface, event: 'Paused' },
  { iface: sharesIface, event: 'Unpaused' },
  { iface: posterIface, event: 'NewPost' },
  { iface: iNavIface, event: 'NavigatorDeployed' },
  { iface: onboarderNavigatorIface, event: 'Onboard' },
  { iface: nftGatedNavigatorIface, event: 'NFTClaimed' },
  { iface: signalNavigatorIface, event: 'PollCreated' },
  { iface: signalNavigatorIface, event: 'Voted' },
  { iface: signalNavigatorIface, event: 'PollCancelled' },
  { iface: timelockNavigatorIface, event: 'ChangeQueued' },
  { iface: timelockNavigatorIface, event: 'ChangeExecuted' },
  { iface: timelockNavigatorIface, event: 'ChangeCancelled' },
  { iface: vestingNavigatorIface, event: 'ScheduleCreated' },
  { iface: vestingNavigatorIface, event: 'TokensClaimed' },
  { iface: vestingNavigatorIface, event: 'ScheduleRevoked' },
  { iface: budgetNavigatorIface, event: 'BudgetCreated' },
  { iface: budgetNavigatorIface, event: 'Disbursed' },
  { iface: budgetNavigatorIface, event: 'ManagerUpdated' },
  { iface: budgetNavigatorIface, event: 'BudgetCancelled' },
  // ⚠️ WATCH-ITEM: EnabledModule/DisabledModule are the Gnosis-Safe/Zodiac STANDARD module
  // events — emitted by EVERY safe on chain, not just DAOShips vaults. Unlike every other
  // navigator signature here (which is DAOShips-specific and rare), their chain-wide volume
  // scales with the whole Safe ecosystem. Watch these two rows: if they dominate, scope them to
  // the registry's avatar addresses instead of fetching unfiltered (see src/index.ts).
  { iface: avatarModulesIface, event: 'EnabledModule' },
  { iface: avatarModulesIface, event: 'DisabledModule' },
];

interface TopicMeta {
  topic0: string;
  eventNames: string[];
  /** True if this topic0 has a universally-common signature (ERC-20 Transfer, OZ Paused, etc.) */
  collisionProne: boolean;
}

const KNOWN_COMMON_SIGNATURES = new Set<string>([
  'Transfer(address,address,uint256)',
  'Approval(address,address,uint256)',
  'Paused(address)',
  'Unpaused(address)',
  'OwnershipTransferred(address,address)',
  // Gnosis-Safe/Zodiac module events — emitted by every safe on chain, so chain-wide volume
  // is NOT bounded by DAOShips usage. Flagged collision-prone so the report calls them out.
  'EnabledModule(address)',
  'DisabledModule(address)',
]);

interface PerTopicResult {
  topic0: string;
  eventNames: string[];
  collisionProne: boolean;
  logCount: number;
  approxBytes: number;
  distinctAddresses: number;
  sampleAddresses: string[];
  errors: string[];
}

function parseArgs(): { fromBlock: number; toBlock: number } {
  const args = process.argv.slice(2);
  let fromBlock: number | undefined;
  let toBlock: number | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--from-block') fromBlock = Number(args[++i]);
    else if (args[i] === '--to-block') toBlock = Number(args[++i]);
  }
  if (fromBlock === undefined || toBlock === undefined || !Number.isFinite(fromBlock) || !Number.isFinite(toBlock)) {
    throw new Error('Usage: --from-block <n> --to-block <n>');
  }
  if (toBlock < fromBlock) throw new Error('toBlock must be >= fromBlock');
  return { fromBlock, toBlock };
}

/** Extract topic0 + whether the event signature is a known-common one. */
function buildTopicMetas(): Map<string, TopicMeta> {
  const skip = new Set(
    (process.env.SKIP_TOPICS ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );

  const out = new Map<string, TopicMeta>();
  for (const { iface, event } of REGISTRATIONS) {
    const frag = iface.getEvent(event);
    if (!frag) {
      console.warn(`[WARN] Event not found in ABI: ${event}`);
      continue;
    }
    const topic0 = frag.topicHash.toLowerCase();
    if (skip.has(topic0)) continue;
    const sig = `${frag.name}(${frag.inputs.map((i) => i.type).join(',')})`;
    const collisionProne = KNOWN_COMMON_SIGNATURES.has(sig);

    const existing = out.get(topic0);
    if (existing) {
      existing.eventNames.push(event);
    } else {
      out.set(topic0, { topic0, eventNames: [event], collisionProne });
    }
  }
  return out;
}

function approxLogBytes(log: quais.Log): number {
  // Rough: each topic is 32 bytes, data is hex-encoded bytes.
  const topicBytes = log.topics.length * 32;
  const dataHex = log.data ?? '0x';
  const dataBytes = Math.max(0, (dataHex.length - 2) / 2);
  return topicBytes + dataBytes;
}

async function measureTopic(
  provider: quais.JsonRpcProvider,
  meta: TopicMeta,
  fromBlock: number,
  toBlock: number,
): Promise<PerTopicResult> {
  const result: PerTopicResult = {
    topic0: meta.topic0,
    eventNames: meta.eventNames,
    collisionProne: meta.collisionProne,
    logCount: 0,
    approxBytes: 0,
    distinctAddresses: 0,
    sampleAddresses: [],
    errors: [],
  };
  try {
    const logs = await provider.getLogs({
      fromBlock,
      toBlock,
      topics: [meta.topic0],
      // Quai requires shard context
      nodeLocation: [0, 0],
    } as any);
    result.logCount = logs.length;
    const addrs = new Set<string>();
    for (const log of logs) {
      result.approxBytes += approxLogBytes(log);
      addrs.add(log.address.toLowerCase());
    }
    result.distinctAddresses = addrs.size;
    result.sampleAddresses = [...addrs].slice(0, 10);
  } catch (err) {
    result.errors.push((err as Error).message);
  }
  return result;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function printTable(results: PerTopicResult[], fromBlock: number, toBlock: number): void {
  const blockCount = toBlock - fromBlock + 1;
  console.log('');
  console.log(`Sample range: blocks ${fromBlock}-${toBlock} (${blockCount} blocks)`);
  console.log('');

  // Sort by logCount descending — busy topics first
  const sorted = [...results].sort((a, b) => b.logCount - a.logCount);

  const col = (s: string, w: number) => s.padEnd(w).slice(0, w);
  console.log(
    col('Event(s)', 48) +
    col('Topic0 (8)', 12) +
    col('Logs', 10) +
    col('Bytes', 12) +
    col('Unique Addr', 13) +
    col('Collision?', 11) +
    col('Flip OK?', 9),
  );
  console.log('-'.repeat(115));

  for (const r of sorted) {
    const label = r.eventNames.join(',');
    const topic = r.topic0.slice(2, 10);
    const flipOk = r.logCount < 50_000 && r.approxBytes < 50 * 1024 * 1024; // 50MB placeholder
    const flipStr = r.errors.length > 0 ? 'ERR' : (flipOk ? 'YES' : 'NO');
    console.log(
      col(label, 48) +
      col(topic, 12) +
      col(String(r.logCount), 10) +
      col(formatBytes(r.approxBytes), 12) +
      col(String(r.distinctAddresses), 13) +
      col(r.collisionProne ? 'YES' : 'no', 11) +
      col(flipStr, 9),
    );
    if (r.errors.length > 0) {
      for (const e of r.errors) console.log(`   ERROR: ${e}`);
    }
  }

  const totalLogs = sorted.reduce((s, r) => s + r.logCount, 0);
  const totalBytes = sorted.reduce((s, r) => s + r.approxBytes, 0);
  console.log('-'.repeat(115));
  console.log(
    col('TOTAL', 60) +
    col(String(totalLogs), 10) +
    col(formatBytes(totalBytes), 12),
  );

  console.log('');
  console.log('Flip criteria (both must hold):');
  console.log('  - logCount < 50,000 per sample range');
  console.log('  - approxBytes < 50 MB per sample range');
  console.log('  (Bytes cap is a placeholder — calibrate against the scoped-mode baseline before committing.)');
  console.log('');
  console.log('Collision-prone topics (Transfer, Paused, etc.) need additional scrutiny:');
  console.log('  every contract on Quai with a matching signature emits the same topic0.');
  console.log('  Post-filter via ContractRegistry is correct but large payloads risk U1 (response-size DoS).');
}

async function main(): Promise<void> {
  const { fromBlock, toBlock } = parseArgs();
  const rpcUrl = process.env.RPC_URL;
  if (!rpcUrl) {
    console.error('RPC_URL not set. Add it to .env or export it.');
    process.exit(1);
  }

  console.log(`RPC: ${rpcUrl.replace(/:[^/@]+@/, ':***@')}`);
  const provider = new quais.JsonRpcProvider(rpcUrl, undefined, { usePathing: true });

  const metas = [...buildTopicMetas().values()];
  console.log(`Measuring ${metas.length} distinct topic0 values.`);
  console.log('');

  const results: PerTopicResult[] = [];
  for (const meta of metas) {
    process.stdout.write(`  ${meta.eventNames.join(',')} ... `);
    const r = await measureTopic(provider, meta, fromBlock, toBlock);
    if (r.errors.length > 0) {
      console.log(`ERROR`);
    } else {
      console.log(`${r.logCount} logs, ${formatBytes(r.approxBytes)}`);
    }
    results.push(r);
  }

  printTable(results, fromBlock, toBlock);

  const outPath = process.env.MEASURE_OUT ?? `measurement-${Date.now()}.json`;
  writeFileSync(outPath, JSON.stringify({
    rpcUrl: rpcUrl.replace(/:[^/@]+@/, ':***@'),
    fromBlock,
    toBlock,
    shard: Shard.Cyprus1,
    measuredAt: new Date().toISOString(),
    results,
  }, null, 2));
  console.log(`Full report: ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
