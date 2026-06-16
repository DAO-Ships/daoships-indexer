/**
 * DAO Ships Indexer — E2E Lifecycle Test
 *
 * Triggers all 24 DAOShip core events on Cyprus1 testnet, then verifies
 * the running indexer correctly wrote the data into Supabase.
 *
 * Prerequisites:
 *   - daoships-contracts deployed (npm run deploy:all && npm run deploy:navigators)
 *   - Indexer running in a separate terminal (npm run dev)
 *   - Supabase schema created (dev schema with create_ds_schema('dev'))
 *   - .env.e2e configured with wallet keys, contract addresses, and Supabase creds
 *   - Test wallets funded with testnet QUAI
 *   - daoships-contracts repo available at ../daoships-contracts (sibling directory)
 *
 * Run with: npm run test:e2e
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import * as quais from 'quais';
import { Shard } from 'quais';
import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { decode as cborDecode } from 'cbor-x';
import bs58 from 'bs58';
import fs from 'fs';
import path from 'path';
import * as dotenv from 'dotenv';

// ── Load .env.e2e ──────────────────────────────────────────────────────

dotenv.config({ path: path.join(__dirname, '../../.env.e2e') });

// ── Path constants ─────────────────────────────────────────────────────

const CONTRACTS_DIR = path.join(__dirname, '../../../daoships-contracts');
const ARTIFACTS_DIR = path.join(CONTRACTS_DIR, 'artifacts/contracts');
const VAULT_ARTIFACTS_DIR = path.join(CONTRACTS_DIR, 'quaiVaultArtifacts');
const DEPLOYMENT_FILE = path.join(CONTRACTS_DIR, 'deployment-addresses.json');

// ── Contract Minimums ─────────────────────────────────────────────────
// DAOShip.sol: uint32 public constant MIN_VOTING_PERIOD = 60 seconds;
// No minimum grace period enforced by the contract.
const MIN_VOTING_PERIOD_SEC = 60;

// ── Timeouts ───────────────────────────────────────────────────────────
// Voting/grace periods are read from env vars but clamped to contract minimums.
// Default is 180s (3× contract minimum) because running right at the 60s floor
// is flaky: the ~20s checkpoint sleep + quais tx latency + test-runner slack
// can push `submitVote`'s estimateGas past `votingEnds`, reverting with
// `NotVoting()`. 180s gives comfortable headroom. Override with VOTING_PERIOD=60
// if you need to stress-test the lower bound.
const votingPeriodSec = Math.max(
  parseInt(process.env.VOTING_PERIOD || '180'),
  MIN_VOTING_PERIOD_SEC,
);
const gracePeriodSec = parseInt(process.env.GRACE_PERIOD || '60');
const totalWaitSec = votingPeriodSec + gracePeriodSec;

// ── Block-time-variance hardening ────────────────────────────────────────
// Orchard block time is NOT a dependable 5s — it ranges 5s..>15s with occasional
// multi-minute stalls. During a stall the chain mines no blocks, so block.timestamp —
// and every state()/isExecutable/vested view that reads it — FREEZES while wall-clock
// keeps running. Any wait that must watch the contract clock cross a fixed span of
// EVM-time therefore budgets that span PLUS this slack. Raise CHAIN_STALL_SLACK_MS on a
// slow day; it only delays a genuine hang's surfacing, never makes a passing run slower
// (the waits are state-gated and return the instant the condition is met).
const CHAIN_STALL_SLACK_MS = parseInt(process.env.CHAIN_STALL_SLACK_MS || '480000'); // 8 min

// Ready-wait budget: a proposal needs the full voting+grace span to elapse on the contract
// clock before it is processable. Budget the span + stall slack. (Was (totalWaitSec+60)s,
// which left no room for slow/stalled blocks → "ready PX: timed out after 480s".)
const readyWaitMs = totalWaitSec * 1000 + CHAIN_STALL_SLACK_MS;

// Per-proposal it() timeout: submit + waitPastVotingStarts + votes + readyWait + process +
// indexer wait — each step can independently stall, so add another slack over readyWait.
const perProposalMs = readyWaitMs + CHAIN_STALL_SLACK_MS;
// Extra overhead per proposal phase for retries, waitForIndexer polling, etc.
const proposalPhaseOverhead = 300_000; // 5 minutes
// Non-proposal phase timeout: some phases do TWO txs + TWO indexer waits (e.g. Phase 9
// pause+unpause), each of which can stall — budget 2× receipt slack + 2× indexer-wait.
const simplePhaseTimeout = 2 * CHAIN_STALL_SLACK_MS + 720_000; // ~24 min
// Per-attempt timeouts — quais RPC calls can hang indefinitely if the node
// accepts the request but never sends a response.  These prevent that.
const TX_SEND_TIMEOUT_MS = 30_000;   // 30s for a single tx submission attempt
const RPC_CALL_TIMEOUT_MS = 120_000; // 2 min safety net for any other RPC call
// (receipt-polling cadence lives in waitForReceipt's local perRoundWaitMs)
const baseOverheadMs = 420_000; // 7 minutes: salt mining + 4 navigator/token deployments (incl. MockERC721 + NFTGatedNavigator) + launch
const SUITE_TIMEOUT = 4 * (perProposalMs + proposalPhaseOverhead) + baseOverheadMs;

// NFTGatedNavigator (free-mint) config — shared between Phase 1 deploy and the
// NFT-claim phase. sharesPerHolder is fixed per claim; mintCap is the mandatory
// (>0) dilution backstop the contract enforces.
const nftSharesPerHolder = quais.parseQuai('10');
const nftMintCap = quais.parseQuai('1000');

// Indexer catch-up polling: must be long enough for the indexer to process
// ~votingPeriod blocks after a proposal sleep. Enforce a minimum of 1 minute.
const INDEXER_POLL_TIMEOUT = Math.max(
  parseInt(process.env.INDEXER_POLL_TIMEOUT_MS || '120000'),
  120_000,
);
const INDEXER_POLL_INTERVAL = parseInt(process.env.INDEXER_POLL_INTERVAL_MS || '3000');

// Indexer /health endpoint — used by waitForIndexer to distinguish a slow
// indexer (still making forward progress) from a stalled/crashed one (RPC
// circuit breaker open, requires_full_reindex flagged, process not running).
// The indexer binds 0.0.0.0:8080 by default (HEALTH_CHECK_PORT); connect via
// 127.0.0.1. Override the whole URL with INDEXER_HEALTH_URL for remote runs.
const INDEXER_HEALTH_URL =
  process.env.INDEXER_HEALTH_URL ||
  `http://127.0.0.1:${process.env.HEALTH_CHECK_PORT || '8080'}/health`;
// If last_block_number hasn't advanced for this long AND /health reports a
// failing check, waitForIndexer aborts early instead of burning the full
// timeout on an indexer that will never catch up.
const INDEXER_STALL_GRACE_MS = parseInt(process.env.INDEXER_STALL_GRACE_MS || '45000');

// Bounded re-poll for a single Supabase row after the indexer checkpoint has
// advanced. In correct operation the row is already committed once
// last_block_number >= targetBlock, but Supabase read-replica lag (or a row
// written microseconds after the checkpoint) can briefly return null. This
// gives the read a short retry window so a transient miss doesn't flake the
// assertion. NOTE: it does NOT mask a genuinely dropped event — a permanently
// missing row simply times out here and still fails the phase, with a clearer
// "row never appeared" log line than a bare `expected null to be truthy`.
const ROW_POLL_TIMEOUT_MS = parseInt(process.env.ROW_POLL_TIMEOUT_MS || '20000');
const ROW_POLL_INTERVAL_MS = parseInt(process.env.ROW_POLL_INTERVAL_MS || '2000');

interface IndexerHealthSnapshot {
  status?: string;
  checks?: {
    quaiRpc?: { status?: string; message?: string };
    supabase?: { status?: string; message?: string };
    indexer?: { status?: string; message?: string };
  };
  details?: {
    currentBlock?: number | null;
    lastIndexedBlock?: number | null;
    blocksBehind?: number | null;
    isSyncing?: boolean;
    requiresFullReindex?: boolean;
    reindexReason?: string | null;
  };
}

/**
 * Best-effort fetch of the indexer's /health snapshot. Returns null if the
 * endpoint is unreachable or the request times out — callers treat a null
 * snapshot as "no liveness signal available" rather than a failure (the
 * indexer may simply have HEALTH_CHECK_ENABLED=false).
 */
async function fetchIndexerHealth(timeoutMs = 5000): Promise<IndexerHealthSnapshot | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(INDEXER_HEALTH_URL, { signal: controller.signal });
    // /health returns 503 when unhealthy — still a valid, parseable body.
    return (await res.json()) as IndexerHealthSnapshot;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Compact one-line summary of a /health snapshot for failure diagnostics. */
function summarizeHealth(h: IndexerHealthSnapshot | null): string {
  if (!h) return 'health endpoint unreachable (HEALTH_CHECK_ENABLED=false or indexer down)';
  const c = h.checks ?? {};
  const d = h.details ?? {};
  const failing = (['quaiRpc', 'supabase', 'indexer'] as const)
    .map((k) => {
      const check = c[k];
      return check && check.status !== 'pass' ? `${k}=${check.message ?? 'fail'}` : null;
    })
    .filter(Boolean);
  const parts = [
    `status=${h.status ?? '?'}`,
    `lastIndexed=${d.lastIndexedBlock ?? '?'}`,
    `currentBlock=${d.currentBlock ?? '?'}`,
    `blocksBehind=${d.blocksBehind ?? '?'}`,
    `isSyncing=${d.isSyncing ?? '?'}`,
  ];
  if (d.requiresFullReindex) parts.push(`requiresFullReindex=true(${d.reindexReason ?? 'unknown'})`);
  if (failing.length) parts.push(`failingChecks=[${failing.join('; ')}]`);
  return parts.join(' ');
}

/** True when /health reports a check that means "this indexer will not catch up on its own". */
function healthIsTerminal(h: IndexerHealthSnapshot | null): boolean {
  if (!h) return false; // no signal — don't abort early on an unreachable endpoint
  const c = h.checks ?? {};
  const indexerDown = c.indexer?.status === 'fail'
    && /not running|reindex/i.test(c.indexer?.message ?? '');
  const rpcBrokenLong = c.quaiRpc?.status === 'fail';
  return Boolean(indexerDown || rpcBrokenLong || h.details?.requiresFullReindex);
}

// ── IPFS CID Extraction ────────────────────────────────────────────────
// Quai Network requires a 46-char IPFS v0 CID for contract deployment.
// The Solidity compiler embeds the CID in bytecode CBOR metadata.
// We extract it here instead of using the Hardhat deployMetadata plugin.

function extractIPFSHash(bytecode: string): string {
  const hex = bytecode.startsWith('0x') ? bytecode.slice(2) : bytecode;
  // Last 2 bytes (4 hex chars) encode the CBOR section length
  const cborLength = parseInt(hex.slice(-4), 16);
  const cborHex = hex.slice(-(cborLength * 2 + 4), -4);
  const decoded = cborDecode(Buffer.from(cborHex, 'hex'));

  if (!decoded.ipfs) {
    throw new Error('No IPFS hash found in bytecode CBOR metadata');
  }

  const hash = bs58.encode(Buffer.from(decoded.ipfs));
  if (hash.length !== 46) {
    throw new Error(`IPFS hash is ${hash.length} chars, expected 46`);
  }
  return hash;
}

// ── Helpers ────────────────────────────────────────────────────────────

function encodeMultiSend(
  transactions: Array<{
    operation: number;
    to: string;
    value: bigint;
    data: string;
  }>,
): string {
  let packed = '0x';

  for (const tx of transactions) {
    packed += tx.operation.toString(16).padStart(2, '0');
    packed += tx.to.slice(2).toLowerCase();
    packed += tx.value.toString(16).padStart(64, '0');
    const dataBytes = tx.data === '0x' ? '' : tx.data.slice(2);
    packed += (dataBytes.length / 2).toString(16).padStart(64, '0');
    if (dataBytes.length > 0) packed += dataBytes;
  }

  const abiCoder = quais.AbiCoder.defaultAbiCoder();
  const encodedParam = abiCoder.encode(['bytes'], [packed]);
  return '0x8d80ff0a' + encodedParam.slice(2);
}

function getMinimalProxyBytecode(implementationAddress: string): string {
  return (
    '0x3d602d80600a3d3981f3363d3d373d3d3d363d73' +
    implementationAddress.slice(2).toLowerCase() +
    '5af43d82803e903d91602b57fd5bf3'
  );
}

async function mineCloneProxySalt(
  senderAddress: string,
  daoShipLauncherAddress: string,
  singletonAddress: string,
  label: string,
): Promise<{ salt: string; address: string }> {
  const TARGET_PREFIX = '0x00';
  const bytecode = getMinimalProxyBytecode(singletonAddress);
  const initCodeHash = quais.keccak256(bytecode);

  console.log(
    `   Mining ${label} salt (sender=${senderAddress.slice(0, 10)}, deployer=${daoShipLauncherAddress.slice(0, 10)}...)...`,
  );

  for (let i = 0; i < 100_000; i++) {
    const userSalt = quais.hexlify(quais.randomBytes(32));
    const userSaltBigInt = BigInt(userSalt);
    const fullSalt = quais.keccak256(
      quais.solidityPacked(['address', 'uint256'], [senderAddress, userSaltBigInt]),
    );
    const address = quais.getCreate2Address(daoShipLauncherAddress, fullSalt, initCodeHash);

    if (
      address.toLowerCase().startsWith(TARGET_PREFIX.toLowerCase()) &&
      quais.isQuaiAddress(address)
    ) {
      console.log(`   Found ${label}: ${address} (iteration: ${i})`);
      return { salt: userSalt, address };
    }
    if (i % 10_000 === 0 && i > 0) {
      console.log(`   ... tried ${i} salts for ${label}...`);
    }
  }
  throw new Error(`Failed to mine ${label} salt after 100000 attempts`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry helper for RPC calls that may hit ETIMEDOUT on Quai testnet.
 * Only retries on network/timeout errors, not on-chain reverts.
 * Each attempt is guarded by `attemptTimeoutMs` to prevent indefinite hangs
 * when the RPC node accepts a request but never responds.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function withTestRetry(
  fn: () => Promise<any>,
  label: string,
  maxAttempts = 5,
  retryDelayMs = 10000,
  attemptTimeoutMs = RPC_CALL_TIMEOUT_MS,
): Promise<any> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await Promise.race([
        fn(),
        new Promise((_resolve, reject) =>
          setTimeout(
            () => reject(new Error(`${label} attempt ${attempt}/${maxAttempts} timeout after ${attemptTimeoutMs / 1000}s`)),
            attemptTimeoutMs,
          ),
        ),
      ]);
    } catch (err: any) {
      const msg: string = err?.message ?? String(err);
      const isNetworkError =
        err?.code === 'UNKNOWN_ERROR' ||
        err?.code === 'BAD_DATA' ||
        msg.includes('ETIMEDOUT') ||
        msg.includes('ECONNRESET') ||
        msg.includes('timeout') ||
        msg.includes('network error') ||
        msg.includes('missing response');
      if (attempt < maxAttempts && isNetworkError) {
        console.log(
          `   [retry] ${label}: attempt ${attempt}/${maxAttempts} failed (${msg.slice(0, 80)}), retry in ${retryDelayMs / 1000}s...`,
        );
        await sleep(retryDelayMs);
      } else {
        throw err;
      }
    }
  }
  throw new Error(`${label}: all ${maxAttempts} attempts failed`);
}

/**
 * Robustly acquire a tx receipt once the tx is in the mempool.
 *
 * `tx.wait()`'s internal poller can stall on Quai testnet even after the tx has
 * mined (the cause of the Phase 10 ".wait() timeout" failure) — re-`wait()`ing the
 * same hung promise can't recover it. On each wait-timeout we fall back to a DIRECT
 * `getTransactionReceipt(hash)`, which returns the receipt the poller missed. We only
 * give up (genuinely dropped tx) after several rounds with no receipt anywhere.
 *
 * Returns the receipt. Throws on a real on-chain revert (status 0) or a dropped tx.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function waitForReceipt(tx: any, label: string, rounds = 7): Promise<any> {
  // `provider` is describe-scoped; tx.provider is always set on a quais TransactionResponse,
  // so the `?? provider` branch is never evaluated (and must not be — provider isn't in scope here).
  const prov = tx.provider;
  const hash = tx.hash;
  // Tolerate Orchard's variable block time (5s..>15s) and short stalls: a tx may need
  // minutes to mine. ~7×(45s race + 15s sleep) ≈ 420s before declaring it dropped. The
  // direct getTransactionReceipt probe returns the instant it mines, so a fast chain pays
  // nothing. (Vote callers also have a memberVoted safety net in sendVote if a slow receipt
  // is mis-declared dropped.)
  const perRoundWaitMs = 45_000;

  // Kick off the normal poller ONCE. We never re-`wait()` (re-waiting a hung promise
  // can't recover a mined-but-stalled receipt) — subsequent rounds use direct probes.
  // Guard against an unhandled rejection if this loses the race and rejects later
  // (e.g. the tx reverts after we've already returned via a probe): record the verdict.
  let waitDone = false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let waitReceipt: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let waitError: any = null;
  const waitP = Promise.resolve()
    .then(() => tx.wait())
    .then((r: any) => { waitReceipt = r; }, (e: any) => { waitError = e; })
    .finally(() => { waitDone = true; });

  for (let attempt = 1; attempt <= rounds; attempt++) {
    // 1) Time-box the poller. A real revert surfaces here as CALL_EXCEPTION.
    await Promise.race([
      waitP,
      new Promise((resolve) => setTimeout(resolve, perRoundWaitMs)),
    ]);
    if (waitDone) {
      if (waitError) {
        const msg: string = waitError?.message ?? String(waitError);
        // Genuine on-chain revert reported by tx.wait() — propagate, never retry.
        if (waitError?.code === 'CALL_EXCEPTION' || msg.includes('execution reverted')) throw waitError;
        // else a transient poller error — fall through to the direct probe.
      } else if (waitReceipt) {
        return waitReceipt;
      }
    }
    // 2) Direct receipt probe — recovers a receipt the poller stalled on.
    try {
      const receipt = await prov.getTransactionReceipt(hash);
      if (receipt) {
        if (receipt.status === 0) {
          throw new Error(`${label}: tx ${hash} reverted on-chain (status 0, block ${receipt.blockNumber})`);
        }
        console.log(`   [recover] ${label}: receipt found via direct probe (block ${receipt.blockNumber}, attempt ${attempt}/${rounds})`);
        return receipt;
      }
    } catch (err: any) {
      // Re-throw only our explicit status-0 verdict; a probe RPC blip just means "retry".
      if (String(err?.message ?? '').includes('reverted on-chain')) throw err;
    }
    if (attempt < rounds) {
      console.log(`   [wait] ${label}: no receipt yet (attempt ${attempt}/${rounds}) — re-checking in 15s...`);
      await sleep(15_000);
    }
  }
  // No receipt after every round AND no direct probe ever saw it: genuinely dropped.
  throw new Error(`${label}: receipt never appeared after ${rounds} rounds — tx ${hash} likely dropped (re-run; resend is unsafe for votes)`);
}

/**
 * Send a transaction and wait for its receipt, with retry on both steps.
 * Retries the entire send+wait cycle on generic CALL_EXCEPTION reverts
 * (Quai testnet flakiness: random txs revert with no decoded reason due
 * to block.timestamp lag, nonce races, or gas estimation quirks).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function sendTx(
  fn: () => Promise<any>,
  label: string,
  maxAttempts = 3,
): Promise<any> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const tx = await withTestRetry(fn, label, 3, 5000, TX_SEND_TIMEOUT_MS);
      // Robust receipt acquisition: time-boxed tx.wait() with a direct
      // getTransactionReceipt(hash) fallback that recovers a mined-but-stalled
      // receipt (Phase 10), instead of re-waiting the same hung promise.
      return await waitForReceipt(tx, `${label} .wait()`);
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      const data = err?.data ?? '';
      // Timing-related custom errors from Quai testnet block.timestamp lag:
      // 0x44e7e7a8 = NotVoting() — proposal not yet in voting period
      // 0x9488aaa6 = NotReady()  — proposal not yet processable
      const TIMING_ERRORS = ['0x44e7e7a8', '0x9488aaa6'];
      const isTimingError = TIMING_ERRORS.some(sel => data.startsWith(sel) || msg.includes(sel))
        || msg.includes('NotVoting') || msg.includes('NotReady') || msg.includes('not ready')
        || msg.includes('not yet determined');
      // Generic CALL_EXCEPTION with no reason AND no revert data = testnet flake
      const isGenericFlake = err?.code === 'CALL_EXCEPTION' && !err?.reason && (!data || data === '0x');
      if ((isTimingError || isGenericFlake) && attempt < maxAttempts) {
        console.log(
          `   [retry] ${label}: ${isTimingError ? 'timing error' : 'generic revert'} (attempt ${attempt}/${maxAttempts}), retrying in 15s...`,
        );
        await sleep(15_000);
      } else {
        // Final failure — surface the receipt/decoded-error context so a
        // status-0 revert (e.g. Phases 4/10/12) isn't an opaque wall of hex.
        console.log(`   [FAIL] ${label}: giving up after attempt ${attempt}/${maxAttempts}`);
        if (err?.code) console.log(`   [FAIL] code: ${err.code}`);
        if (err?.reason) console.log(`   [FAIL] reason: ${err.reason}`);
        if (data && data !== '0x') console.log(`   [FAIL] revert data/selector: ${String(data).slice(0, 74)}`);
        if (err?.receipt) {
          console.log(
            `   [FAIL] tx status: ${err.receipt.status}, gasUsed: ${err.receipt.gasUsed}, ` +
            `logs: ${err.receipt.logs?.length ?? 0}, hash: ${err.receipt.hash}`,
          );
        }
        throw err;
      }
    }
  }
  throw new Error(`${label}: all ${maxAttempts} attempts failed`);
}

/**
 * Send a processProposal transaction with retry on "not ready" reverts.
 * Blockchain timestamp can lag behind wall-clock time on Quai testnet,
 * so the proposal may not be processable immediately after sleeping
 * votingPeriod + gracePeriod.  This retries with a delay to accommodate
 * the drift rather than adding a large static buffer to every sleep.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function sendProcessProposal(
  daoShip: any,
  signer: any,
  proposalId: any,
  proposalData: string,
  label: string,
  maxAttempts = 6,
  retryDelayMs = 30_000,
): Promise<any> {
  // Pre-flight diagnostics — log proposal state before attempting processProposal
  try {
    const daoShipAddr = await daoShip.getAddress();
    const avatarAddr = await daoShip.avatar();
    const isModuleEnabled = await (new quais.Contract(
      avatarAddr,
      ['function isModuleEnabled(address) view returns (bool)'],
      signer.provider ?? signer,
    )).isModuleEnabled(daoShipAddr);
    const proposalState = await daoShip.state(proposalId);
    const stateNames = ['Unborn', 'Submitted', 'Voting', 'Cancelled', 'Grace', 'Ready', 'Processed', 'Defeated', 'Expired'];
    console.log(`   [diag] ${label}: proposalId=${proposalId}, state=${stateNames[Number(proposalState)] ?? proposalState}, isModuleEnabled=${isModuleEnabled}, daoShip=${daoShipAddr}, avatar=${avatarAddr}`);
  } catch (diagErr: any) {
    console.log(`   [diag] ${label}: pre-flight diagnostics failed: ${diagErr.message}`);
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await sendTx(
        () => daoShip.connect(signer).processProposal(proposalId, proposalData),
        label,
      );
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      // Retry on timing-related reverts. On Quai testnet, block.timestamp can lag
      // behind wall-clock time, so processProposal reverts because the proposal
      // is still in voting/grace period. The revert reason may be "NotReady",
      // "not ready", or a generic CALL_EXCEPTION with no decoded reason (reason=null).
      const isTimingRevert = msg.includes('not ready') || msg.includes('NotReady')
        || (err?.code === 'CALL_EXCEPTION' && !err?.reason);
      if (isTimingRevert && attempt < maxAttempts) {
        // Check proposal state for diagnostics
        let stateInfo = '';
        try {
          const s = await daoShip.state(proposalId);
          const names = ['Unborn', 'Submitted', 'Voting', 'Cancelled', 'Grace', 'Ready', 'Processed', 'Defeated', 'Expired'];
          stateInfo = ` (state=${names[Number(s)] ?? s})`;
        } catch { /* ignore */ }
        console.log(
          `   [retry] ${label}: proposal not processable${stateInfo} (attempt ${attempt}/${maxAttempts}), waiting ${retryDelayMs / 1000}s...`,
        );
        await sleep(retryDelayMs);
      } else {
        // Log detailed failure info before throwing
        console.log(`   [FAIL] ${label}: attempt ${attempt}/${maxAttempts}`);
        console.log(`   [FAIL] error: ${msg.slice(0, 500)}`);
        if (err?.receipt) {
          console.log(`   [FAIL] tx status: ${err.receipt.status}, gasUsed: ${err.receipt.gasUsed}, logs: ${err.receipt.logs?.length ?? 0}`);
        }
        if (err?.code) console.log(`   [FAIL] code: ${err.code}`);
        if (err?.reason) console.log(`   [FAIL] reason: ${err.reason}`);
        if (err?.revert) console.log(`   [FAIL] revert: ${JSON.stringify(err.revert)}`);
        throw err;
      }
    }
  }
  throw new Error(`${label}: all ${maxAttempts} attempts failed`);
}

/**
 * Submit a vote with state-aware retry. The generic `sendTx` treats the
 * NotVoting() selector (0x44e7e7a8) as a timing error and blindly waits 15s
 * before retrying — correct when the voting window hasn't OPENED yet (RPC head
 * skew / block.timestamp lag after waitForProposalState returned Voting), but
 * actively harmful once voting has CLOSED, where every retry just burns 15s on
 * a vote that can never succeed.
 *
 * This wrapper inspects on-chain state() when a NotVoting revert surfaces:
 *   - state < Voting (Unborn/Submitted): window not open yet → short wait, retry.
 *   - state == Voting (2):               estimateGas raced a lagging replica → retry.
 *   - state >= Grace (3+):               window CLOSED → fail fast, no point retrying.
 * Non-NotVoting reverts propagate straight to sendTx's own retry/throw logic.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function sendVote(
  daoShip: any,
  signer: any,
  proposalId: any,
  approve: boolean,
  label: string,
  maxAttempts = 6,
): Promise<any> {
  const names = ['Unborn', 'Submitted', 'Voting', 'Cancelled', 'Grace', 'Ready', 'Processed', 'Defeated', 'Expired'];
  // `provider` is describe-scoped; derive it from the contract runner (see waitPastVotingStarts).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const prov: any = (daoShip.runner as any)?.provider ?? daoShip.runner;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      // Single-attempt send (sendTx's own NotVoting retry is disabled here by
      // catching below; we keep its network-retry + receipt handling).
      return await sendTx(
        () => daoShip.connect(signer).submitVote(proposalId, approve),
        label,
        1,
      );
    } catch (err: any) {
      const msg: string = err?.message ?? String(err);
      const data: string = err?.data ?? '';

      // Did the vote actually land — on this attempt or a prior one? A status-0 revert can
      // mask AlreadyVoted, and a "reverted" send can still race a real confirmation. The
      // on-chain memberVoted flag (public getter) is authoritative; if set, we're done.
      try {
        const voter: string = await signer.getAddress();
        if (await daoShip.memberVoted(voter, proposalId)) {
          console.log(`   ${label}: vote already recorded on-chain (memberVoted=true) — treating as success`);
          return;
        }
      } catch { /* view blip — fall through to retry logic */ }

      const isNotVoting = data.startsWith('0x44e7e7a8') || msg.includes('0x44e7e7a8') || msg.includes('NotVoting');
      // "DAOShipVotes: not yet determined" — a STRING revert (Error(string), 0x08c379a0),
      // distinct from NotVoting(). The vote-weight checkpoint hasn't matured: at the
      // votingStarts boundary, estimateGas runs against a block where the snapshot
      // timepoint >= block.timestamp, so getPriorVotes reverts. Same transient race as
      // NotVoting — clears once the chain timestamp advances a block. Retry it identically.
      const isSnapshotNotReady = msg.includes('not yet determined');
      // A status-0 on-chain revert with NO decoded reason (estimateGas passed, then the tx
      // reverted when mined). On Quai this is the window closing between send and mine during
      // a slow-block spell — i.e. NotVoting() that the receipt didn't decode. We confirmed
      // just above that the vote did NOT land, so it's safe to re-send if still in Voting.
      const isOpaqueRevert = (err?.code === 'CALL_EXCEPTION' && !err?.reason && (!data || data === '0x'))
        || msg.includes('execution reverted') || msg.includes('reverted on-chain');
      const isVoteTimingRace = isNotVoting || isSnapshotNotReady || isOpaqueRevert;
      if (!isVoteTimingRace || attempt >= maxAttempts) throw err;

      let state = -1;
      try { state = Number(await daoShip.state(proposalId)); } catch { /* RPC blip — treat as not-open */ }

      if (state >= 3) {
        // Voting window has closed (Grace/Ready/terminal). Retrying is futile.
        throw new Error(
          `${label}: voting window CLOSED (proposal state=${names[state] ?? state}) — ` +
          `vote cannot land. This is a test-timing gap between waitPastVotingStarts ` +
          `and submitVote (window overshot), not an indexer issue. Original revert: ${msg.slice(0, 120)}`,
        );
      }

      const reason = isSnapshotNotReady ? 'snapshot not yet determined' : isNotVoting ? 'NotVoting' : 'opaque on-chain revert';
      console.log(
        `   [retry] ${label}: ${reason}, on-chain state=${names[state] ?? state} ` +
        `(vote-timing race on this RPC view) — attempt ${attempt}/${maxAttempts}, waiting for next block...`,
      );
      // Wait for a NEW block before re-estimating: both NotVoting and "not yet determined"
      // clear only once block.timestamp advances. Re-estimating against the SAME (possibly
      // stalled) block just reverts again — wasting attempts during a Quai slow-block spell.
      // Cap the per-attempt wait so a hard stall doesn't hang; the wide 360s window tolerates it.
      try {
        const before = Number(await prov.getBlockNumber(Shard.Cyprus1));
        const blockDeadline = Date.now() + 30_000;
        for (;;) {
          await sleep(5_000);
          const cur = Number(await prov.getBlockNumber(Shard.Cyprus1));
          if (cur > before || Date.now() > blockDeadline) break;
        }
      } catch {
        await sleep(10_000); // getBlockNumber blip — fall back to a flat wait
      }
    }
  }
  throw new Error(`${label}: all ${maxAttempts} attempts failed`);
}

/**
 * Cast multiple votes CONCURRENTLY. Voting sequentially on a slow Quai testnet lets the
 * first voter's confirmation time eat into the finite voting window, starving the second
 * voter → "voting window CLOSED (state=Grace)". Firing all sends at once gives every voter
 * the full window. Voters have independent nonces, so concurrency is safe. allSettled (not
 * Promise.all) avoids an unhandled rejection from the loser when one vote fails; we re-throw
 * the first failure after all settle.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function castVotes(daoShip: any, proposalId: any, votes: { signer: any; label: string }[]): Promise<void> {
  const results = await Promise.allSettled(
    votes.map((v) => sendVote(daoShip, v.signer, proposalId, true, v.label)),
  );
  const failed = results.find((r) => r.status === 'rejected');
  if (failed) throw (failed as PromiseRejectedResult).reason;
}

/**
 * Run a full governance proposal end-to-end: submit → wait for Voting → cast votes →
 * wait for Ready → process. Returns the processProposal receipt. Mirrors the inline flow
 * used by Phases 4/6/10/12; factored out for the navigator phases that each need one.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function runProposal(
  daoShip: any,
  proposer: any,
  voters: any[],
  proposalData: string,
  details: string,
  label: string,
): Promise<any> {
  const submitReceipt = await sendTx(
    () => daoShip.connect(proposer).submitProposal(proposalData, 0, details),
    `submitProposal ${label}`,
  );
  const proposalEvent = submitReceipt.logs.find((log: any) => {
    try { return daoShip.interface.parseLog(log)?.name === 'SubmitProposal'; } catch { return false; }
  });
  const proposalId = daoShip.interface.parseLog(proposalEvent!)?.args[0];
  console.log(`   ${label}: proposal ID ${proposalId}`);

  await waitPastVotingStarts(daoShip, proposalId, `voting window ${label}`);
  await castVotes(daoShip, proposalId, voters.map((v, i) => ({ signer: v, label: `submitVote ${label} #${i}` })));
  await waitForProposalState(daoShip, proposalId, [5], `ready ${label}`, readyWaitMs);
  return sendProcessProposal(daoShip, proposer, proposalId, proposalData, `processProposal ${label}`);
}

/**
 * Poll the proposal's on-chain state() until it reaches one of the target
 * values. Replaces fixed wall-clock sleeps in proposal phases — the contract
 * is the source of truth for when voting opens and when a proposal becomes
 * processable, so we wait for the actual state transition instead of guessing
 * based on block.timestamp math that lags wall-clock on Quai testnet.
 *
 * State enum (AUTHORITATIVE — DAOShip.sol:228, "Ordering is significant"):
 *   0 Unborn  1 Submitted  2 Voting  3 Cancelled  4 Grace
 *   5 Ready   6 Processed  7 Defeated 8 Expired
 *
 * Throws if the proposal reaches a terminal state (3 Cancelled, 6 Processed,
 * 7 Defeated, 8 Expired) before hitting a target, or if the max wait elapses.
 * NOTE: Ready is 5 (not 4) and Grace is 4 (not 3) — an earlier version of this
 * file had the enum off by one from Cancelled onward, so it waited on Grace while
 * calling it "Ready" and misclassified the real Ready(5) as terminal.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function waitForProposalState(
  daoShip: any,
  proposalId: any,
  acceptableStates: number[],
  label: string,
  maxWaitMs: number,
  pollIntervalMs = 5_000,
): Promise<number> {
  const names = ['Unborn', 'Submitted', 'Voting', 'Cancelled', 'Grace', 'Ready', 'Processed', 'Defeated', 'Expired'];
  const terminalStates = new Set([3, 6, 7, 8]); // Cancelled, Processed, Defeated, Expired
  const start = Date.now();
  let lastLoggedState = -1;

  while (Date.now() - start < maxWaitMs) {
    let state: number;
    try {
      state = Number(await daoShip.state(proposalId));
    } catch {
      // Transient RPC failure — keep polling until maxWaitMs.
      await sleep(pollIntervalMs);
      continue;
    }
    if (acceptableStates.includes(state)) {
      console.log(`   ${label}: state=${names[state] ?? state} reached after ${((Date.now() - start) / 1000).toFixed(1)}s`);
      return state;
    }
    if (terminalStates.has(state) && !acceptableStates.includes(state)) {
      throw new Error(
        `${label}: proposal reached terminal state ${names[state] ?? state} before hitting target [${acceptableStates.map(s => names[s] ?? s).join(',')}]`,
      );
    }
    if (state !== lastLoggedState) {
      console.log(`   ${label}: state=${names[state] ?? state} (waiting for ${acceptableStates.map(s => names[s] ?? s).join('|')})`);
      lastLoggedState = state;
    }
    await sleep(pollIntervalMs);
  }
  throw new Error(
    `${label}: timed out after ${(maxWaitMs / 1000).toFixed(0)}s waiting for state in [${acceptableStates.map(s => names[s] ?? s).join(',')}]`,
  );
}

/**
 * Wait until a proposal is open for voting AND a further block has been mined, so a
 * vote tx executes STRICTLY after `votingStarts`.
 *
 * Why this exists (mirrors daoships-contracts `waitPastVotingStarts`): the contract
 * computes vote weight via `getPriorVotes(voter, prop.votingStarts)`, and
 * `getPriorVotes` requires `timepoint < block.timestamp` STRICTLY (DAOShipVotes.sol:91,
 * "not yet determined"). But `state()` flips to Voting at `block.timestamp >= votingStarts`.
 * So at the exact boundary the proposal is "Voting" yet the vote reverts
 * "DAOShipVotes: not yet determined". Waiting only for state==Voting (the old behavior)
 * raced straight into that boundary. We additionally wait for one more mined block, then
 * re-confirm the window is still open. Also avoids the Quai woHeader-vs-EVM clock skew by
 * gating on `state()` (EVM clock), exactly as the vote tx does.
 *
 * Throws loudly if the proposal already left Voting (window overshot) — a too-short
 * VOTING_PERIOD vs. PoW block-time variance must fail visibly, not silently skip a vote.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function waitPastVotingStarts(
  daoShip: any,
  proposalId: any,
  label: string,
  // votingStarts is set at sponsor and Voting opens ~immediately after — but a stall right
  // after submit can delay it, so budget stall slack (was a flat 120s).
  maxWaitMs = CHAIN_STALL_SLACK_MS + 120_000,
): Promise<void> {
  const names = ['Unborn', 'Submitted', 'Voting', 'Cancelled', 'Grace', 'Ready', 'Processed', 'Defeated', 'Expired'];
  const STATE_SUBMITTED = 1;
  const STATE_VOTING = 2;
  // `provider` is describe-scoped, not visible to this module-level helper. The base
  // daoShip was created as `new quais.Contract(addr, abi, provider)`, so its runner IS
  // that provider (a signer-connected contract would expose it as runner.provider).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const prov: any = (daoShip.runner as any)?.provider ?? daoShip.runner;
  const prop = await withTestRetry(() => daoShip.proposals(proposalId), `${label} proposals()`, 3, 5000);
  if (Number(prop.votingStarts) === 0) {
    throw new Error(`${label}: proposal ${proposalId} not sponsored (votingStarts==0) — cannot open voting`);
  }

  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    let state: number;
    try {
      state = Number(await daoShip.state(proposalId));
    } catch {
      await sleep(5_000);
      continue;
    }

    if (state === STATE_VOTING) {
      // Mine past the current block so the vote lands strictly after votingStarts,
      // then re-confirm the window is still open (PoW block-time variance can overshoot).
      const seenAt = await withTestRetry(() => prov.getBlockNumber(Shard.Cyprus1), `${label} blockNo`, 3, 5000);
      while (Date.now() < deadline) {
        const now = await withTestRetry(() => prov.getBlockNumber(Shard.Cyprus1), `${label} blockNo`, 3, 5000);
        if (now > seenAt) break;
        await sleep(3_000);
      }
      const recheck = Number(await daoShip.state(proposalId));
      if (recheck === STATE_VOTING) {
        console.log(`   ${label}: open for voting (state=Voting, block>${seenAt})`);
        return;
      }
      if (recheck !== STATE_SUBMITTED) {
        throw new Error(
          `${label}: proposal ${proposalId} left Voting (state=${names[recheck] ?? recheck}) while confirming the ` +
          `window — VOTING_PERIOD is too short for PoW block-time variance.`,
        );
      }
      // recheck === Submitted (re-sponsor race) — keep polling.
    } else if (state !== STATE_SUBMITTED) {
      throw new Error(
        `${label}: proposal ${proposalId} left Voting before a vote could be cast (state=${names[state] ?? state}). ` +
        `Voting window overshot — VOTING_PERIOD too short for PoW block-time variance.`,
      );
    }
    await sleep(3_000);
  }
  throw new Error(`${label}: timed out after ${(maxWaitMs / 1000).toFixed(0)}s waiting for proposal ${proposalId} to open for voting`);
}

/**
 * Poll Supabase until the indexer has processed at least `targetBlock`.
 * Accounts for confirmation lag — the indexer's `last_block_number` needs
 * to be >= targetBlock.
 */
async function waitForIndexer(
  supabase: SupabaseClient,
  targetBlock: number,
  label = '',
): Promise<void> {
  const start = Date.now();
  const tag = label ? ` [${label}]` : '';

  // Liveness tracking: remember the highest last_block_number we've seen and
  // when it last advanced. A slow-but-progressing indexer keeps moving this
  // forward; a stalled one does not. Combined with /health, this lets us fail
  // fast with a root cause instead of silently burning the full timeout.
  let highestSeen = -1;
  let lastProgressAt = start;
  let lastHealth: IndexerHealthSnapshot | null = null;

  while (Date.now() - start < INDEXER_POLL_TIMEOUT) {
    const { data } = await supabase
      .from('ds_indexer_state')
      .select('last_block_number')
      .eq('id', 1)
      .single();

    const lastBlock = data?.last_block_number ?? -1;
    if (lastBlock > highestSeen) {
      highestSeen = lastBlock;
      lastProgressAt = Date.now();
    }

    if (lastBlock >= targetBlock) {
      console.log(
        `   Indexer caught up to block ${targetBlock}${tag} (at ${lastBlock})`,
      );
      return;
    }

    // No forward progress for INDEXER_STALL_GRACE_MS → consult /health. If it
    // reports a terminal condition (process not running, RPC circuit breaker
    // open, requires_full_reindex), the indexer will not recover on its own —
    // abort now with the diagnosis rather than waiting out the full timeout.
    const stalledMs = Date.now() - lastProgressAt;
    if (stalledMs >= INDEXER_STALL_GRACE_MS) {
      lastHealth = await fetchIndexerHealth();
      if (healthIsTerminal(lastHealth)) {
        throw new Error(
          `Indexer stalled before reaching block ${targetBlock}${tag}: ` +
          `no progress for ${(stalledMs / 1000).toFixed(0)}s (stuck at ${highestSeen}). ` +
          `Health: ${summarizeHealth(lastHealth)}`,
        );
      }
      // Not terminal — log the snapshot once per stall window and keep waiting.
      console.log(
        `   [waitForIndexer]${tag} no progress for ${(stalledMs / 1000).toFixed(0)}s ` +
        `(at ${highestSeen}, target ${targetBlock}) — ${summarizeHealth(lastHealth)}`,
      );
      // Reset the stall clock so we re-probe health roughly once per grace window
      // instead of on every poll.
      lastProgressAt = Date.now();
    }

    await sleep(INDEXER_POLL_INTERVAL);
  }

  // Final timeout — attach the freshest /health snapshot so the failure says
  // WHY (slow vs crashed vs reindex-required) instead of just "didn't reach".
  const finalHealth = (await fetchIndexerHealth()) ?? lastHealth;
  throw new Error(
    `Indexer did not reach block ${targetBlock}${tag} within ${INDEXER_POLL_TIMEOUT}ms ` +
    `(highest seen: ${highestSeen}). Health: ${summarizeHealth(finalHealth)}`,
  );
}

/**
 * Bounded re-poll of a single-row Supabase read. Re-runs `queryFn` until it
 * returns a truthy `data`, or ROW_POLL_TIMEOUT_MS elapses. Returns the last
 * observed `data` (possibly null) so the caller's existing
 * `expect(row).toBeTruthy()` still fails — just after giving read-replica lag
 * a chance to settle. Each call builds a fresh query (PostgREST builders are
 * single-use thenables).
 */
async function waitForRow<T = unknown>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  queryFn: () => PromiseLike<{ data: T | null; error: any }>,
  label: string,
  timeoutMs = ROW_POLL_TIMEOUT_MS,
  intervalMs = ROW_POLL_INTERVAL_MS,
): Promise<T | null> {
  const start = Date.now();
  let last: T | null = null;
  for (;;) {
    const { data } = await queryFn();
    last = data;
    if (data) return data;
    if (Date.now() - start >= timeoutMs) {
      console.log(
        `   [waitForRow] ${label}: row still absent after ${(timeoutMs / 1000).toFixed(0)}s ` +
        `(indexer checkpoint passed this block — event may have been dropped, not just delayed)`,
      );
      return last;
    }
    await sleep(intervalMs);
  }
}

// ── Phase result tracking ──────────────────────────────────────────────
// The Summary test used to be pure console.log — it asserted nothing, so it
// always "passed" and printed "All 24 events triggered, indexed, and verified"
// even when phases failed (false confidence). We record each phase's real
// pass/fail outcome here via onTestFinished (which receives the final result)
// so Summary can assert the suite actually succeeded.
const passedPhases: string[] = [];
const failedPhases: string[] = [];

// ── Test Suite ─────────────────────────────────────────────────────────

describe('E2E: Indexer Lifecycle Verification (Cyprus1)', () => {
  let provider: quais.JsonRpcProvider;
  let deployer: quais.Wallet;
  let alice: quais.Wallet;
  let bob: quais.Wallet;
  let carol: quais.Wallet;
  let deploymentAddresses: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let supabase: SupabaseClient<any, any, any>;

  // Contract instances — typed as `any` because quais.Contract
  // doesn't have ABI-generated methods without codegen.
  let daoShip: any;
  let shares: any;
  let loot: any;
  let vault: string;
  let onboarderNavigator: any;
  let erc20TributeNavigator: any;
  let nftGatedNavigator: any;
  let nftGateToken: any; // MockERC721 gate collection
  // SignalNavigator (read-only, permissionless) — deployed AFTER launch so the DAO
  // is already indexed (the resolution gate drops read-only deploys for unknown DAOs).
  let signalNavigator: any;
  let signalNavAddr: string;        // lowercase
  let signalNavDeployBlock: number; // NavigatorDeployed block — backfill lower bound
  let signalPollId: bigint;
  // TimelockNavigator (GOVERNOR) + VestingNavigator (MANAGER) — permissioned, deployed
  // AFTER launch and registered via NavigatorSet (before Phase 12 locks governance).
  let timelockNavigator: any;
  let timelockAddr: string;         // lowercase
  let vestingNavigator: any;
  let vestingAddr: string;          // lowercase
  let budgetNavigator: any;
  let budgetAddr: string;           // lowercase
  let budgetNavDeployBlock: number; // NavigatorDeployed block — backfill lower bound
  // TimelockNavigator delay — MIN_DELAY is 10 min on-chain; the executeChange path must
  // wait it out in real wall-clock (no testnet time-travel), so it's opt-in via env.
  const TIMELOCK_DELAY_SEC = 600;   // MIN_DELAY (10 minutes)
  const TIMELOCK_EXPIRY_SEC = 86_400; // 1 day executable window (within [1h, 3650d])
  // Addresses — checksummed for contract calls, lowercase `daoId` for DB queries
  let daoShipAddress: string;   // EIP-55 checksummed (for contract calls)
  let daoId: string;            // lowercase (for Supabase queries — indexer stores lowercase)
  let sharesAddress: string;
  let lootAddress: string;

  // ABIs
  let DAOShipABI: any;
  let SharesABI: any;
  let LootABI: any;
  let DAOShipAndVaultLauncherABI: any;
  let OnboarderNavigatorABI: any;
  let ERC20TributeNavigatorABI: any;
  let NFTGatedNavigatorABI: any;
  let MockERC721ABI: any;
  let SignalNavigatorABI: any;
  let PosterABI: any;

  // QuaiVault artifacts
  let QuaiVaultJson: any;
  let QuaiVaultProxyJson: any;

  // Record each phase's true outcome. `onTestFinished` runs after the test
  // body completes and receives the final TaskResult, so it reflects real
  // pass/fail (an in-body assertion failure → result.state === 'fail'). The
  // Summary test reads these arrays to assert the suite actually succeeded.
  beforeEach((ctx) => {
    const name = ctx.task.name;
    ctx.onTestFinished((result) => {
      // Don't let Summary grade itself.
      if (name.startsWith('Summary')) return;
      if (result.state === 'fail') failedPhases.push(name);
      else passedPhases.push(name);
    });
  });

  // ── Setup ──────────────────────────────────────────────────────────

  beforeAll(async () => {
    console.log('\n============================================================');
    console.log('  DAO Ships Indexer E2E — Lifecycle + Supabase Verification');
    console.log('============================================================');
    console.log(
      `  Voting: ${votingPeriodSec}s | Grace: ${gracePeriodSec}s | Timeout: ${Math.round(SUITE_TIMEOUT / 60_000)}min\n`,
    );

    // ── Check daoships-contracts exists ────────────────────────────

    if (!fs.existsSync(ARTIFACTS_DIR)) {
      console.log('daoships-contracts artifacts not found at:', ARTIFACTS_DIR);
      console.log('Ensure daoships-contracts is deployed at ../daoships-contracts');
      process.exit(1);
    }

    // ── Load ABIs (with bytecode for deployment) ──────────────────

    DAOShipABI = JSON.parse(
      fs.readFileSync(path.join(ARTIFACTS_DIR, 'core/DAOShip.sol/DAOShip.json'), 'utf-8'),
    ).abi;
    SharesABI = JSON.parse(
      fs.readFileSync(
        path.join(ARTIFACTS_DIR, 'tokens/SharesERC20.sol/SharesERC20.json'),
        'utf-8',
      ),
    ).abi;
    LootABI = JSON.parse(
      fs.readFileSync(
        path.join(ARTIFACTS_DIR, 'tokens/LootERC20.sol/LootERC20.json'),
        'utf-8',
      ),
    ).abi;
    DAOShipAndVaultLauncherABI = JSON.parse(
      fs.readFileSync(
        path.join(
          ARTIFACTS_DIR,
          'core/DAOShipAndVaultLauncher.sol/DAOShipAndVaultLauncher.json',
        ),
        'utf-8',
      ),
    ).abi;
    OnboarderNavigatorABI = JSON.parse(
      fs.readFileSync(
        path.join(
          ARTIFACTS_DIR,
          'navigators/OnboarderNavigator.sol/OnboarderNavigator.json',
        ),
        'utf-8',
      ),
    ).abi;
    ERC20TributeNavigatorABI = JSON.parse(
      fs.readFileSync(
        path.join(
          ARTIFACTS_DIR,
          'navigators/ERC20TributeNavigator.sol/ERC20TributeNavigator.json',
        ),
        'utf-8',
      ),
    ).abi;
    NFTGatedNavigatorABI = JSON.parse(
      fs.readFileSync(
        path.join(
          ARTIFACTS_DIR,
          'navigators/NFTGatedNavigator.sol/NFTGatedNavigator.json',
        ),
        'utf-8',
      ),
    ).abi;
    MockERC721ABI = JSON.parse(
      fs.readFileSync(
        path.join(ARTIFACTS_DIR, 'test/MockERC721.sol/MockERC721.json'),
        'utf-8',
      ),
    ).abi;
    SignalNavigatorABI = JSON.parse(
      fs.readFileSync(
        path.join(
          ARTIFACTS_DIR,
          'navigators/SignalNavigator.sol/SignalNavigator.json',
        ),
        'utf-8',
      ),
    ).abi;
    PosterABI = JSON.parse(
      fs.readFileSync(path.join(__dirname, '../../src/abis/Poster.json'), 'utf-8'),
    );
    // QuaiVault artifacts
    if (!fs.existsSync(path.join(VAULT_ARTIFACTS_DIR, 'QuaiVault.json'))) {
      console.log('QuaiVault artifacts not found at:', VAULT_ARTIFACTS_DIR);
      process.exit(1);
    }
    QuaiVaultJson = JSON.parse(
      fs.readFileSync(path.join(VAULT_ARTIFACTS_DIR, 'QuaiVault.json'), 'utf-8'),
    );
    QuaiVaultProxyJson = JSON.parse(
      fs.readFileSync(
        path.join(VAULT_ARTIFACTS_DIR, 'QuaiVaultProxy.json'),
        'utf-8',
      ),
    );

    // ── Provider + Wallets ────────────────────────────────────────

    const rpcUrl = process.env.RPC_URL || 'https://rpc.orchard.quai.network';
    provider = new quais.JsonRpcProvider(rpcUrl, undefined, {
      usePathing: true,
    });

    // Suppress unhandled 'error' events from batch response mismatches.
    // quais emits an error event AND rejects the promise; without this listener
    // Node treats the emit as an uncaught exception.
    provider.on('error', (...args: any[]) => {
      const msg = args[1]?.message ?? args[0]?.message ?? 'unknown';
      console.warn(`   [provider error event] ${String(msg).slice(0, 120)}`);
    });

    const deployerPK = process.env.DEPLOYER_PK;
    const alicePK = process.env.ALICE_PK;
    const bobPK = process.env.BOB_PK;
    const carolPK = process.env.CAROL_PK;

    if (!deployerPK || !alicePK || !bobPK || !carolPK) {
      console.log('Missing test wallet private keys in .env.e2e');
      process.exit(1);
    }

    deployer = new quais.Wallet(deployerPK.trim(), provider);
    alice = new quais.Wallet(alicePK.trim(), provider);
    bob = new quais.Wallet(bobPK.trim(), provider);
    carol = new quais.Wallet(carolPK.trim(), provider);

    console.log(`  Deployer: ${deployer.address}`);
    console.log(`  Alice:    ${alice.address}`);
    console.log(`  Bob:      ${bob.address}`);
    console.log(`  Carol:    ${carol.address}`);

    // ── Supabase Client ───────────────────────────────────────────

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const supabaseSchema = process.env.SUPABASE_SCHEMA || 'dev';

    if (!supabaseUrl || !supabaseKey) {
      console.log('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.e2e');
      process.exit(1);
    }

    supabase = createClient(supabaseUrl, supabaseKey, {
      db: { schema: supabaseSchema },
    });

    // Verify Supabase connection
    const { error: sbError } = await supabase
      .from('ds_indexer_state')
      .select('last_block_number')
      .eq('id', 1)
      .single();

    if (sbError) {
      console.log('Supabase connection failed:', sbError.message);
      console.log('Ensure the schema is created and indexer_state has a row');
      process.exit(1);
    }

    console.log(`  Supabase: ${supabaseUrl} (schema: ${supabaseSchema})`);

    // ── Warm up provider ──────────────────────────────────────────

    const blockNumber = await provider.getBlockNumber(Shard.Cyprus1);
    console.log(`  Current block: ${blockNumber}`);

    // ── Deployment addresses ──────────────────────────────────────

    if (!fs.existsSync(DEPLOYMENT_FILE)) {
      console.log('No deployment-addresses.json found at:', DEPLOYMENT_FILE);
      process.exit(1);
    }
    deploymentAddresses = JSON.parse(fs.readFileSync(DEPLOYMENT_FILE, 'utf-8'));
    console.log(
      `  Network: ${deploymentAddresses.network} (Chain ID: ${deploymentAddresses.chainId})`,
    );

    // ── Check balances ────────────────────────────────────────────

    const bal = await Promise.all([
      provider.getBalance(deployer.address),
      provider.getBalance(alice.address),
      provider.getBalance(bob.address),
      provider.getBalance(carol.address),
    ]);

    console.log(`\n  Balances:`);
    console.log(`    Deployer: ${quais.formatQuai(bal[0])} QUAI`);
    console.log(`    Alice:    ${quais.formatQuai(bal[1])} QUAI`);
    console.log(`    Bob:      ${quais.formatQuai(bal[2])} QUAI`);
    console.log(`    Carol:    ${quais.formatQuai(bal[3])} QUAI`);

    if (
      bal[0] < quais.parseQuai('2') ||
      bal[1] < quais.parseQuai('0.5') ||
      bal[2] < quais.parseQuai('0.6') ||
      bal[3] < quais.parseQuai('0.3')
    ) {
      console.log('\n  Insufficient testnet QUAI. Fund wallets at https://faucet.quai.network');
      process.exit(1);
    }

    console.log('\n  Setup complete\n');
  }, SUITE_TIMEOUT);

  // ════════════════════════════════════════════════════════════════════
  // PHASE 1: Mine Salts & Launch DAO
  // ════════════════════════════════════════════════════════════════════

  it(
    'Phase 1: Mine salts, deploy navigators, and launch DAO',
    async () => {
      console.log('\n== PHASE 1: Mine Salts & Launch DAO ==\n');

      const daoShipAndVaultLauncher =
        deploymentAddresses.contracts.DAOShipAndVaultLauncher;
      const daoShipLauncherAddr = deploymentAddresses.contracts.DAOShipLauncher;
      const multisendLibrary = process.env.MULTISEND_CALL_ONLY_LIBRARY!;

      // Read vault factory + implementation from on-chain contracts
      // (env values can be stale after redeployments)
      const launcherContract = new quais.Contract(
        daoShipAndVaultLauncher,
        ['function quaiVaultFactory() view returns (address)'],
        provider,
      );
      const quaiVaultFactory: string = await launcherContract.quaiVaultFactory();
      console.log(`  QuaiVaultFactory (from contract): ${quaiVaultFactory}`);

      const factoryContract = new quais.Contract(
        quaiVaultFactory,
        [
          'function implementation() view returns (address)',
          'function predictWalletAddress(address deployer, bytes32 salt, address[] calldata owners, uint256 threshold, uint32 minExecutionDelay, address[] calldata initialModules, address[] calldata initialDelegatecallTargets) view returns (address)',
        ],
        provider,
      );
      const quaiVaultImplementation: string = await factoryContract.implementation();
      console.log(`  VaultImplementation (from factory): ${quaiVaultImplementation}`);

      // ── Mine salts ────────────────────────────────────────────

      const vaultOwners = [deployer.address];
      const vaultThreshold = 1;

      // Mine DAOShip component salts first (vault salt depends on predicted DAOShip address)
      const sharesSalt = await mineCloneProxySalt(
        daoShipAndVaultLauncher,
        daoShipLauncherAddr,
        deploymentAddresses.contracts.SharesERC20Singleton,
        'shares',
      );
      const lootSalt = await mineCloneProxySalt(
        daoShipAndVaultLauncher,
        daoShipLauncherAddr,
        deploymentAddresses.contracts.LootERC20Singleton,
        'loot',
      );
      const daoShipSalt = await mineCloneProxySalt(
        daoShipAndVaultLauncher,
        daoShipLauncherAddr,
        deploymentAddresses.contracts.DAOShipSingleton,
        'daoship',
      );

      const predictedDaoShipAddress = daoShipSalt.address;

      // Vault salt — compute init code hash locally for fast mining.
      // The factory's createWallet(6-param) calls initialize with 5 params:
      //   initialize(owners, threshold, minExecutionDelay, initialModules, initialDelegatecallTargets)
      // The launcher passes initialModules=[predictedDAOShip], initialDelegatecallTargets=[multisendCallOnly].
      const proxyBytecode = QuaiVaultProxyJson.bytecode;
      const vaultABI = QuaiVaultJson.abi;
      const setupData = new quais.Interface(vaultABI).encodeFunctionData(
        'initialize',
        [vaultOwners, vaultThreshold, 0, [predictedDaoShipAddress], [multisendLibrary]],
      );
      const constructorData = quais.AbiCoder.defaultAbiCoder().encode(
        ['address', 'bytes'],
        [quaiVaultImplementation, setupData],
      );
      const fullVaultBytecode = proxyBytecode + constructorData.slice(2);
      const vaultInitCodeHash = quais.keccak256(fullVaultBytecode);

      console.log('  Mining vault salt...');
      let vaultSalt: { salt: string; address: string } | null = null;
      for (let i = 0; i < 100_000; i++) {
        const userSalt = quais.hexlify(quais.randomBytes(32));
        const fullSalt = quais.keccak256(
          quais.solidityPacked(
            ['address', 'bytes32'],
            [daoShipAndVaultLauncher, userSalt],
          ),
        );
        const address = quais.getCreate2Address(
          quaiVaultFactory,
          fullSalt,
          vaultInitCodeHash,
        );
        if (
          address.toLowerCase().startsWith('0x00') &&
          quais.isQuaiAddress(address)
        ) {
          console.log(`   Found vault: ${address} (iteration: ${i})`);
          vaultSalt = { salt: userSalt, address };
          break;
        }
        if (i % 10_000 === 0 && i > 0)
          console.log(`   ... tried ${i} vault salts...`);
      }
      if (!vaultSalt)
        throw new Error('Failed to mine vault salt after 100000 attempts');

      // ── Deploy navigators ────────────────────────────────────

      const sharesPerQuai = process.env.ONBOARDER_SHARES_PER_QUAI || '20000';
      const lootPerQuai = process.env.ONBOARDER_LOOT_PER_QUAI || '0';
      const minTribute = quais.parseQuai(
        process.env.ONBOARDER_MIN_TRIBUTE || '0.01',
      );
      const expiry = process.env.ONBOARDER_EXPIRY || '0';

      const pricePerUnit = quais.parseQuai(
        process.env.QUAI_ONBOARDER_PRICE_PER_UNIT || '0.1',
      );
      const sharesPerUnit = quais.parseQuai(
        process.env.QUAI_ONBOARDER_SHARES_PER_UNIT || '1',
      );
      const sharesLoot = process.env.QUAI_ONBOARDER_SHARES_LOOT || '0';
      const lootLoot = process.env.QUAI_ONBOARDER_LOOT_LOOT || '0';

      // Read full artifacts (with bytecode) for navigator deployment
      const OnboarderNavigatorJson = JSON.parse(
        fs.readFileSync(
          path.join(
            ARTIFACTS_DIR,
            'navigators/OnboarderNavigator.sol/OnboarderNavigator.json',
          ),
          'utf-8',
        ),
      );
      const ERC20TributeNavigatorJson = JSON.parse(
        fs.readFileSync(
          path.join(
            ARTIFACTS_DIR,
            'navigators/ERC20TributeNavigator.sol/ERC20TributeNavigator.json',
          ),
          'utf-8',
        ),
      );
      console.log('  Extracting IPFS hashes from bytecode...');
      const onboarderIpfsHash = extractIPFSHash(OnboarderNavigatorJson.bytecode);
      const erc20TributeIpfsHash = extractIPFSHash(ERC20TributeNavigatorJson.bytecode);
      console.log(`   OnboarderNavigator IPFS: ${onboarderIpfsHash}`);
      console.log(`   ERC20TributeNavigator IPFS: ${erc20TributeIpfsHash}`);

      console.log('  Deploying OnboarderNavigator...');
      const OnboarderFactory = new quais.ContractFactory(
        OnboarderNavigatorABI,
        OnboarderNavigatorJson.bytecode,
        deployer,
        onboarderIpfsHash,
      );
      // OnboarderNavigator(daoShip, shareMultiplier, lootMultiplier, pricePerUnit,
      //   sharesPerUnit, lootPerUnit, minTribute, expiry, mintCap, perAddressCap, allowlistRoot, name, description)
      const onboarderInstance = await OnboarderFactory.deploy(
        predictedDaoShipAddress,
        sharesPerQuai,     // shareMultiplier (basis points)
        lootPerQuai,       // lootMultiplier
        0,                 // pricePerUnit (0 = multiplier mode)
        0,                 // sharesPerUnit (unused in multiplier mode)
        0,                 // lootPerUnit (unused in multiplier mode)
        minTribute,        // minTribute
        expiry,            // expiry (0 = no expiry)
        0,                 // mintCap (0 = unlimited)
        0,                 // perAddressCap (0 = unlimited)
        '0x' + '00'.repeat(32), // allowlistRoot (0 = open)
        'Test Onboarder',  // name
        'Open onboarding navigator for E2E tests', // description
      );
      await onboarderInstance.waitForDeployment();
      const onboarderAddr = await onboarderInstance.getAddress();
      console.log(`   OnboarderNavigator: ${onboarderAddr}`);

      console.log('  Deploying ERC20TributeNavigator...');
      const ERC20TributeFactory = new quais.ContractFactory(
        ERC20TributeNavigatorABI,
        ERC20TributeNavigatorJson.bytecode,
        deployer,
        erc20TributeIpfsHash,
      );
      // ERC20TributeNavigator(daoShip, tributeToken, pricePerShare, pricePerLoot,
      //   expiry, mintCap, perAddressCap, allowlistRoot, name, description)
      // Use the predicted shares address as the tribute token (it's a valid ERC20)
      const predictedSharesAddress = sharesSalt.address;
      const erc20TributeInstance = await ERC20TributeFactory.deploy(
        predictedDaoShipAddress,
        predictedSharesAddress, // tributeToken (use shares token — a real ERC20)
        pricePerUnit,           // pricePerShare
        0,                      // pricePerLoot
        0,                      // expiry (0 = no expiry)
        0,                      // mintCap (0 = unlimited)
        0,                      // perAddressCap (0 = unlimited)
        '0x' + '00'.repeat(32), // allowlistRoot (0 = open)
        'Test ERC20 Tribute',   // name
        'ERC20 tribute navigator for E2E tests', // description
      );
      await erc20TributeInstance.waitForDeployment();
      const erc20TributeAddr = await erc20TributeInstance.getAddress();
      console.log(`   ERC20TributeNavigator: ${erc20TributeAddr}`);

      // ── Deploy MockERC721 gate collection + NFTGatedNavigator ──
      // Free-mint ERC-721 gate: holding a token of the gate collection lets you
      // claim a fixed amount of shares exactly once per tokenId.
      const MockERC721Json = JSON.parse(
        fs.readFileSync(
          path.join(ARTIFACTS_DIR, 'test/MockERC721.sol/MockERC721.json'),
          'utf-8',
        ),
      );
      const NFTGatedNavigatorJson = JSON.parse(
        fs.readFileSync(
          path.join(
            ARTIFACTS_DIR,
            'navigators/NFTGatedNavigator.sol/NFTGatedNavigator.json',
          ),
          'utf-8',
        ),
      );
      const mockErc721IpfsHash = extractIPFSHash(MockERC721Json.bytecode);
      const nftGatedIpfsHash = extractIPFSHash(NFTGatedNavigatorJson.bytecode);

      console.log('  Deploying MockERC721 gate collection...');
      const MockERC721Factory = new quais.ContractFactory(
        MockERC721ABI,
        MockERC721Json.bytecode,
        deployer,
        mockErc721IpfsHash,
      );
      const nftGateTokenInstance = await MockERC721Factory.deploy();
      await nftGateTokenInstance.waitForDeployment();
      const nftGateTokenAddr = await nftGateTokenInstance.getAddress();
      console.log(`   MockERC721 (gate): ${nftGateTokenAddr}`);

      console.log('  Deploying NFTGatedNavigator...');
      const NFTGatedFactory = new quais.ContractFactory(
        NFTGatedNavigatorABI,
        NFTGatedNavigatorJson.bytecode,
        deployer,
        nftGatedIpfsHash,
      );
      // NFTGatedNavigator(daoShip, gateToken, sharesPerHolder, lootPerHolder,
      //   requireTribute, tributeAmount, expiry, mintCap, perAddressCap, allowlistRoot, name, description)
      const nftGatedInstance = await NFTGatedFactory.deploy(
        predictedDaoShipAddress,
        nftGateTokenAddr,         // gateToken (the deployed ERC-721)
        nftSharesPerHolder,       // sharesPerHolder
        0,                        // lootPerHolder
        false,                    // requireTribute (free mint)
        0,                        // tributeAmount (must be 0 in free-mint mode)
        0,                        // expiry (0 = no expiry)
        nftMintCap,               // mintCap (MANDATORY, > 0 — dilution backstop)
        0,                        // perAddressCap (0 = unlimited)
        '0x' + '00'.repeat(32),   // allowlistRoot (0 = open)
        'Test NFT Gate',          // name
        'NFT-gated navigator for E2E tests', // description
      );
      await nftGatedInstance.waitForDeployment();
      const nftGatedAddr = await nftGatedInstance.getAddress();
      console.log(`   NFTGatedNavigator: ${nftGatedAddr}`);

      onboarderNavigator = onboarderInstance;
      erc20TributeNavigator = erc20TributeInstance;
      nftGatedNavigator = nftGatedInstance;
      nftGateToken = nftGateTokenInstance;

      // ── Launch DAO ────────────────────────────────────────────

      const votingPeriod = votingPeriodSec;
      const gracePeriod = gracePeriodSec;
      const proposalOffering = quais.parseQuai(
        process.env.PROPOSAL_OFFERING || '0.001',
      );
      const quorumPercent = parseInt(process.env.QUORUM_PERCENT || '2000');
      const sponsorThreshold = quais.parseQuai(
        process.env.SPONSOR_THRESHOLD || '1',
      );
      const minRetentionPercent = parseInt(
        process.env.MIN_RETENTION_PERCENT || '6600',
      );

      const defaultExpiryWindow = 0; // 0 = no default expiry
      const governanceConfig = quais.AbiCoder.defaultAbiCoder().encode(
        ['uint32', 'uint32', 'uint256', 'uint256', 'uint256', 'uint256', 'uint32'],
        [
          votingPeriod,
          gracePeriod,
          proposalOffering,
          quorumPercent,
          sponsorThreshold,
          minRetentionPercent,
          defaultExpiryWindow,
        ],
      );

      const initialMembers = [deployer.address, alice.address];
      const initialShares = [quais.parseQuai('100'), quais.parseQuai('50')];
      const initialLoot = [quais.parseQuai('0'), quais.parseQuai('25')];

      const navigators = [
        onboarderAddr,
        erc20TributeAddr,
        nftGatedAddr,
        deployer.address,
      ];
      const navigatorPermissions = [2, 2, 2, 7]; // onboarder/erc20tribute/nftgated: MANAGER, deployer: ALL (ADMIN+MANAGER+GOVERNOR)

      const initializationParams = quais.AbiCoder.defaultAbiCoder().encode(
        [
          'address',   // lootToken (placeholder — launcher replaces)
          'address',   // sharesToken (placeholder — launcher replaces)
          'address',   // avatar (placeholder — launcher replaces)
          'address',   // multisendLibrary
          'bytes',     // governanceConfig
          'address[]', // navigators
          'uint256[]', // navigatorPermissions
          'address[]', // initMembers
          'uint256[]', // initShareAmounts
          'uint256[]', // initLootAmounts
          'address[]', // guildTokens
          'bool',      // pauseSharesOnLaunch
          'bool',      // pauseLootOnLaunch
        ],
        [
          quais.ZeroAddress,   // lootToken placeholder
          quais.ZeroAddress,   // sharesToken placeholder
          quais.ZeroAddress,   // avatar placeholder
          multisendLibrary,
          governanceConfig,
          navigators,
          navigatorPermissions,
          initialMembers,
          initialShares,
          initialLoot,
          [],                  // guildTokens
          false,               // pauseSharesOnLaunch
          false,               // pauseLootOnLaunch
        ],
      );

      console.log(`\n  Launching DAO (voting: ${votingPeriod}s, grace: ${gracePeriod}s)...`);

      const launcher = new quais.Contract(
        daoShipAndVaultLauncher,
        DAOShipAndVaultLauncherABI,
        deployer,
      );

      await provider.getBlockNumber(Shard.Cyprus1);

      const tx = await launcher.launchDAOShipAndVault(
        initializationParams,
        'Test DAO Shares',      // shareTokenName
        'TDAO',                 // shareTokenSymbol
        'Test DAO Loot',        // lootTokenName
        'TDAO-LOOT',            // lootTokenSymbol
        vaultOwners,
        vaultThreshold,
        BigInt(vaultSalt.salt),
        BigInt(sharesSalt.salt),
        BigInt(lootSalt.salt),
        BigInt(daoShipSalt.salt),
      );

      console.log(`   TX: ${tx.hash}`);
      const receipt = await tx.wait();
      const launchBlock = receipt.blockNumber;
      console.log(`   Confirmed in block ${launchBlock}`);

      // Extract addresses
      const launchEvent = receipt.logs.find((log: any) => {
        try {
          return launcher.interface.parseLog(log)?.name === 'LaunchDAOShipAndVault';
        } catch {
          return false;
        }
      });
      expect(launchEvent).toBeTruthy();

      const parsed = launcher.interface.parseLog(launchEvent!);
      daoShipAddress = quais.getAddress(String(parsed?.args[0]));
      daoId = daoShipAddress.toLowerCase();
      const vaultAddr = quais.getAddress(String(parsed?.args[1]));

      console.log(`   DAOShip:  ${daoShipAddress}`);
      console.log(`   Vault: ${vaultAddr}`);

      // Initialize contract instances
      daoShip = new quais.Contract(daoShipAddress, DAOShipABI, provider);
      sharesAddress = quais.getAddress(await daoShip.sharesToken());
      lootAddress = quais.getAddress(await daoShip.lootToken());
      shares = new quais.Contract(sharesAddress, SharesABI, provider);
      loot = new quais.Contract(lootAddress, LootABI, provider);
      vault = vaultAddr;

      console.log(`   Shares: ${sharesAddress}`);
      console.log(`   Loot:   ${lootAddress}`);

      // Enable DAOShip as module on vault
      console.log('  Enabling DAOShip as vault module...');
      const vaultContract = new quais.Contract(
        vault,
        QuaiVaultJson.abi,
        deployer,
      );

      let isModuleEnabled = await vaultContract.isModuleEnabled(daoShipAddress);
      if (!isModuleEnabled) {
        const enableData = vaultContract.interface.encodeFunctionData(
          'enableModule',
          [daoShipAddress],
        );
        const proposeTx = await vaultContract.proposeTransaction(
          vault,
          0,
          enableData,
        );
        const proposeReceipt = await proposeTx.wait();
        const proposeLog = proposeReceipt.logs.find((log: any) => {
          try {
            return (
              vaultContract.interface.parseLog(log)?.name ===
              'TransactionProposed'
            );
          } catch {
            return false;
          }
        });
        const txHash = vaultContract.interface.parseLog(proposeLog!)?.args
          .txHash;
        const approveTx = await vaultContract.approveTransaction(txHash);
        await approveTx.wait();
        const executeTx = await vaultContract.executeTransaction(txHash);
        await executeTx.wait();
        isModuleEnabled = await vaultContract.isModuleEnabled(daoShipAddress);
        expect(isModuleEnabled).toBe(true);
      }
      console.log('   DAOShip module enabled');

      // Fund treasury
      console.log('  Funding treasury...');
      const fundTx = await deployer.sendTransaction({
        to: vault,
        value: quais.parseQuai('1'),
        from: deployer.address,
      });
      const fundReceipt = (await fundTx.wait())!;
      const lastBlock = fundReceipt.blockNumber as number;

      // ── INDEXER VERIFICATION ────────────────────────────────

      console.log('\n  Verifying indexer...');
      await waitForIndexer(supabase, lastBlock, 'Phase 1');

      // Check DAO record
      const dao = await waitForRow<any>(
        () => supabase.from('ds_daos').select('*').eq('id', daoId).single(),
        'dao P1',
      );

      expect(dao).toBeTruthy();
      expect(dao!.shares_address).toBe(sharesAddress.toLowerCase());
      expect(dao!.loot_address).toBe(lootAddress.toLowerCase());
      expect(dao!.avatar).toBe(vault.toLowerCase());
      console.log('   DAO record verified');

      // Check initial members
      const deployerMemberId = `${daoId}-${deployer.address.toLowerCase()}`;
      const aliceMemberId = `${daoId}-${alice.address.toLowerCase()}`;

      const deployerMember = await waitForRow<any>(
        () => supabase.from('ds_members').select('*').eq('id', deployerMemberId).single(),
        'deployerMember P1',
      );

      const aliceMember = await waitForRow<any>(
        () => supabase.from('ds_members').select('*').eq('id', aliceMemberId).single(),
        'aliceMember P1',
      );

      expect(deployerMember).toBeTruthy();
      expect(BigInt(deployerMember!.shares)).toBe(quais.parseQuai('100'));
      expect(aliceMember).toBeTruthy();
      expect(BigInt(aliceMember!.shares)).toBe(quais.parseQuai('50'));
      expect(BigInt(aliceMember!.loot)).toBe(quais.parseQuai('25'));
      console.log('   Initial members verified');

      // Check navigators
      const { data: navigatorsData } = await supabase
        .from('ds_navigators')
        .select('*')
        .eq('dao_id', daoId);

      expect(navigatorsData).toBeTruthy();
      expect(navigatorsData!.length).toBeGreaterThanOrEqual(4);

      // Verify NavigatorDeployed metadata was indexed
      const onboarderNav = navigatorsData!.find((n: any) => n.navigator_type === 'OnboarderNavigator');
      if (onboarderNav) {
        expect(onboarderNav.name).toBe('Test Onboarder');
        expect(onboarderNav.description).toBe('Open onboarding navigator for E2E tests');
        expect(onboarderNav.deployer).toBeTruthy();
        console.log(`   OnboarderNavigator metadata verified (deployer: ${onboarderNav.deployer})`);
      }
      const erc20Nav = navigatorsData!.find((n: any) => n.navigator_type === 'ERC20TributeNavigator');
      if (erc20Nav) {
        expect(erc20Nav.name).toBe('Test ERC20 Tribute');
        expect(erc20Nav.description).toBe('ERC20 tribute navigator for E2E tests');
        expect(erc20Nav.deployer).toBeTruthy();
        console.log(`   ERC20TributeNavigator metadata verified (deployer: ${erc20Nav.deployer})`);
      }
      const nftGatedNav = navigatorsData!.find((n: any) => n.navigator_type === 'NFTGatedNavigator');
      expect(nftGatedNav, 'NFTGatedNavigator should be indexed via NavigatorDeployed').toBeTruthy();
      expect(nftGatedNav.name).toBe('Test NFT Gate');
      expect(nftGatedNav.description).toBe('NFT-gated navigator for E2E tests');
      expect(nftGatedNav.deployer).toBeTruthy();
      expect(nftGatedNav.permission).toBe(2); // MANAGER
      console.log(`   NFTGatedNavigator metadata verified (deployer: ${nftGatedNav.deployer})`);
      console.log(`   Navigators verified (${navigatorsData!.length} registered)`);

      // Check governance params are populated (from SetupComplete)
      expect(dao!.voting_period).toBeTruthy();
      expect(dao!.grace_period).toBeTruthy();
      console.log('   Governance params verified');

      console.log('  Phase 1 PASSED\n');
    },
    baseOverheadMs,
  );

  // ════════════════════════════════════════════════════════════════════
  // PHASE 2: Bob Onboards via OnboarderNavigator
  // ════════════════════════════════════════════════════════════════════

  it(
    'Phase 2: Bob onboards via OnboarderNavigator',
    async () => {
      console.log('\n== PHASE 2: Bob Onboards (OnboarderNavigator) ==\n');

      const tributeAmount = quais.parseQuai('0.5');
      await withTestRetry(() => provider.getBlockNumber(Shard.Cyprus1), 'getBlockNumber P2');

      const receipt = await sendTx(
        () => onboarderNavigator.connect(bob)['onboard()']({ value: tributeAmount }),
        'onboard P2',
      );
      const blockNum = receipt.blockNumber;
      console.log(`   Confirmed in block ${blockNum}`);

      const bobSharesAfter = await shares.balanceOf(bob.address);
      expect(bobSharesAfter).toBeGreaterThan(0n);
      console.log(`   Bob shares: ${quais.formatQuai(bobSharesAfter)}`);

      // ── INDEXER VERIFICATION ────────────────────────────────

      console.log('\n  Verifying indexer...');
      await waitForIndexer(supabase, blockNum, 'Phase 2');

      const bobMemberId = `${daoId}-${bob.address.toLowerCase()}`;
      const bobMember = await waitForRow<any>(
        () => supabase.from('ds_members').select('*').eq('id', bobMemberId).single(),
        'bobMember P2',
      );

      expect(bobMember).toBeTruthy();
      expect(BigInt(bobMember!.shares)).toBeGreaterThan(0n);
      console.log('   Bob member record verified');

      // Check navigator event — dynamic navigator discovery should index events
      // from test-deployed navigators via NavigatorSet → registry → log fetching
      const { data: navigatorEvents } = await supabase
        .from('ds_navigator_events')
        .select('*')
        .eq('dao_id', daoId)
        .eq('contributor', bob.address.toLowerCase())
        .eq('event_type', 'onboard');

      expect(navigatorEvents).toBeTruthy();
      expect(navigatorEvents!.length).toBeGreaterThanOrEqual(1);
      console.log('   Onboard navigator event verified');

      console.log('  Phase 2 PASSED\n');
    },
    simplePhaseTimeout,
  );

  // ════════════════════════════════════════════════════════════════════
  // PHASE 3: Carol Onboards via ERC20TributeNavigator
  // ════════════════════════════════════════════════════════════════════

  it(
    'Phase 3: Carol onboards via ERC20TributeNavigator',
    async () => {
      console.log('\n== PHASE 3: Carol Onboards (ERC20TributeNavigator) ==\n');

      // ERC20TributeNavigator uses shares token as tribute token.
      // Carol needs shares to pay tribute. Transfer from deployer first.
      const sharesToMint = quais.parseQuai('1'); // 1 share to mint
      // pricePerShare was set to pricePerUnit (0.1 QUAI = 1e17 wei of shares token)
      // tribute = (sharesToMint * pricePerShare) / 1e18 = (1e18 * 1e17) / 1e18 = 1e17
      const tributeNeeded = (sharesToMint * quais.parseQuai(
        process.env.QUAI_ONBOARDER_PRICE_PER_UNIT || '0.1',
      )) / (10n ** 18n);

      console.log(`   Tribute needed: ${quais.formatQuai(tributeNeeded)} shares tokens`);

      // Transfer shares from deployer to Carol so she can pay tribute
      const transferAmount = tributeNeeded * 2n; // extra buffer
      await withTestRetry(() => provider.getBlockNumber(Shard.Cyprus1), 'getBlockNumber P3 transfer');
      await sendTx(
        () => shares.connect(deployer).transfer(carol.address, transferAmount),
        'transfer shares to Carol P3',
      );
      console.log(`   Transferred ${quais.formatQuai(transferAmount)} shares to Carol`);

      // Carol approves ERC20TributeNavigator to spend her shares
      const erc20TributeAddr = await erc20TributeNavigator.getAddress();
      await sendTx(
        () => shares.connect(carol).approve(erc20TributeAddr, transferAmount),
        'approve tribute P3',
      );
      console.log('   Carol approved tribute navigator');

      const carolSharesBefore = await shares.balanceOf(carol.address);

      // Onboard: call onboard(sharesToMint, lootToMint) — NOT payable
      const receipt = await sendTx(
        () => erc20TributeNavigator.connect(carol)['onboard(uint256,uint256)'](sharesToMint, 0),
        'onboard P3',
      );
      const blockNum = receipt.blockNumber;
      console.log(`   Confirmed in block ${blockNum}`);

      const carolSharesAfter = await shares.balanceOf(carol.address);
      // Carol should have more shares than before (minted shares - tribute cost)
      console.log(`   Carol shares: ${quais.formatQuai(carolSharesBefore)} -> ${quais.formatQuai(carolSharesAfter)}`);

      // ── INDEXER VERIFICATION ────────────────────────────────

      console.log('\n  Verifying indexer...');
      await waitForIndexer(supabase, blockNum, 'Phase 3');

      const carolMemberId = `${daoId}-${carol.address.toLowerCase()}`;
      const carolMember = await waitForRow<any>(
        () => supabase.from('ds_members').select('*').eq('id', carolMemberId).single(),
        'carolMember P3',
      );

      expect(carolMember).toBeTruthy();
      expect(BigInt(carolMember!.shares)).toBeGreaterThan(0n);
      console.log('   Carol member record verified');

      const { data: navigatorEvents } = await supabase
        .from('ds_navigator_events')
        .select('*')
        .eq('dao_id', daoId)
        .eq('contributor', carol.address.toLowerCase())
        .eq('event_type', 'onboard');

      expect(navigatorEvents).toBeTruthy();
      expect(navigatorEvents!.length).toBeGreaterThanOrEqual(1);
      console.log('   Onboard navigator event verified');

      console.log('  Phase 3 PASSED\n');
    },
    simplePhaseTimeout,
  );

  // ════════════════════════════════════════════════════════════════════
  // PHASE 3b: Alice Onboards via NFTGatedNavigator (per-token NFT claim)
  // ════════════════════════════════════════════════════════════════════

  it(
    'Phase 3b: Alice onboards via NFTGatedNavigator (NFT claim)',
    async () => {
      console.log('\n== PHASE 3b: Alice Onboards (NFTGatedNavigator) ==\n');

      const tokenId = 1n;
      const nftGatedAddr = (await nftGatedNavigator.getAddress()).toLowerCase();

      // Mint a gate NFT to Alice (deployer can mint on the mock collection),
      // then claim membership with it (free mint, one claim per tokenId forever).
      await sendTx(
        () => nftGateToken.connect(deployer).mint(alice.address, tokenId),
        'mint gate NFT P3b',
      );
      console.log(`   Minted gate NFT #${tokenId} to Alice`);

      const aliceSharesBefore = await shares.balanceOf(alice.address);

      // onboard is overloaded (onboard(uint256) / onboard(uint256,bytes32[])) —
      // use the explicit signature to select the no-allowlist entry point.
      const receipt = await sendTx(
        () => nftGatedNavigator.connect(alice)['onboard(uint256)'](tokenId),
        'nft onboard P3b',
      );
      const blockNum = receipt.blockNumber;
      console.log(`   Confirmed in block ${blockNum}`);

      // On-chain: shares minted, and the tokenId is now permanently spent.
      const aliceSharesAfter = await shares.balanceOf(alice.address);
      expect(aliceSharesAfter).toBe(aliceSharesBefore + nftSharesPerHolder);
      expect(await nftGatedNavigator.claimed(tokenId)).toBe(true);
      console.log(
        `   Alice shares: ${quais.formatQuai(aliceSharesBefore)} → ${quais.formatQuai(aliceSharesAfter)} (+${quais.formatQuai(nftSharesPerHolder)} via NFT gate)`,
      );

      // ── INDEXER VERIFICATION ────────────────────────────────

      console.log('\n  Verifying indexer...');
      await waitForIndexer(supabase, blockNum, 'Phase 3b');

      // Member balance reflects the mint (via the paired Onboard/Transfer path).
      const aliceMemberId = `${daoId}-${alice.address.toLowerCase()}`;
      const aliceMember = await waitForRow<any>(
        () => supabase.from('ds_members').select('*').eq('id', aliceMemberId).single(),
        'aliceMember P3b',
      );
      expect(aliceMember).toBeTruthy();
      expect(BigInt(aliceMember!.shares)).toBe(aliceSharesAfter);
      console.log('   Alice member balance verified');

      // The generic Onboard row lands in ds_navigator_events (additive — NFTClaimed
      // does not replace it). Filter by navigator_address to isolate this claim.
      const { data: onboardEvents } = await supabase
        .from('ds_navigator_events')
        .select('*')
        .eq('dao_id', daoId)
        .eq('navigator_address', nftGatedAddr)
        .eq('event_type', 'onboard');
      expect(onboardEvents).toBeTruthy();
      expect(onboardEvents!.length).toBeGreaterThanOrEqual(1);
      console.log('   Onboard navigator event verified');

      // The new per-token claim row: keyed {navigator}-{tokenId}, carries the
      // tokenId dimension Onboard cannot.
      const claimId = `${nftGatedAddr}-${tokenId.toString()}`;
      const nftClaim = await waitForRow<any>(
        () => supabase.from('ds_nft_claims').select('*').eq('id', claimId).single(),
        'nftClaim P3b',
      );
      expect(nftClaim, 'ds_nft_claims row should exist for the spent tokenId').toBeTruthy();
      expect(nftClaim!.dao_id).toBe(daoId);
      expect(nftClaim!.navigator_address).toBe(nftGatedAddr);
      expect(BigInt(nftClaim!.token_id)).toBe(tokenId);
      expect(nftClaim!.holder).toBe(alice.address.toLowerCase());
      expect(BigInt(nftClaim!.shares)).toBe(nftSharesPerHolder);
      expect(BigInt(nftClaim!.loot)).toBe(0n);
      console.log(`   NFT claim row verified (tokenId #${tokenId} → ${nftClaim!.holder})`);

      console.log('  Phase 3b PASSED\n');
    },
    simplePhaseTimeout,
  );

  // ════════════════════════════════════════════════════════════════════
  // PHASE 4: Submit, Vote, and Process Funding Proposal
  // ════════════════════════════════════════════════════════════════════

  it(
    'Phase 4: Submit, vote, and process funding proposal',
    async () => {
      console.log('\n== PHASE 4: Submit, Vote & Process Proposal ==\n');

      const transferAmount = quais.parseQuai('0.5');

      const proposalData = encodeMultiSend([
        {
          operation: 0,
          to: carol.address,
          value: transferAmount,
          data: '0x',
        },
      ]);

      const details = JSON.stringify({
        title: 'Fund Carol',
        description: 'Transfer 0.5 QUAI to Carol for early contribution',
      });

      await withTestRetry(() => provider.getBlockNumber(Shard.Cyprus1), 'getBlockNumber pre-submit P4');

      const submitReceipt = await sendTx(
        () => daoShip.connect(deployer).submitProposal(proposalData, 0, details),
        'submitProposal P4',
      );
      console.log(`   Proposal submitted in block ${submitReceipt.blockNumber}`);

      const proposalEvent = submitReceipt.logs.find((log: any) => {
        try {
          return daoShip.interface.parseLog(log)?.name === 'SubmitProposal';
        } catch {
          return false;
        }
      });

      const parsedEvent = daoShip.interface.parseLog(proposalEvent!);
      const proposalId = parsedEvent?.args[0];
      console.log(`   Proposal ID: ${proposalId}`);

      // Wait for the voting window to open on-chain instead of sleeping
      // wall-clock seconds — Quai block.timestamp lags wall-clock, so a
      // fixed sleep reliably races `submitVote` against `votingStarts` and
      // reverts with NotVoting(). Poll state() until it flips to Voting.
      await waitPastVotingStarts(daoShip, proposalId, 'voting window P4');

      // Vote
      await castVotes(daoShip, proposalId, [
        { signer: deployer, label: 'submitVote deployer P4' },
        { signer: alice, label: 'submitVote alice P4' },
      ]);
      console.log('   Deployer + Alice voted YES');

      // Wait for the grace period to complete (Ready state). Same rationale
      // as pre-vote: contract-state gate is immune to chain-time drift.
      await waitForProposalState(daoShip, proposalId, [5], 'ready P4', readyWaitMs);
      const processReceipt = await sendProcessProposal(
        daoShip, deployer, proposalId, proposalData, 'processProposal P4',
      );
      const processBlock = processReceipt.blockNumber;
      console.log(`   Processed in block ${processBlock}`);

      const proposalStatus = await daoShip.getProposalStatus(proposalId);
      console.log(
        `   Status: cancelled=${proposalStatus[0]}, processed=${proposalStatus[1]}, passed=${proposalStatus[2]}, actionFailed=${proposalStatus[3]}`,
      );

      // ── INDEXER VERIFICATION ────────────────────────────────

      console.log('\n  Verifying indexer...');
      await waitForIndexer(supabase, processBlock, 'Phase 4');

      const dbProposalId = `${daoId}-${proposalId}`;

      const proposal = await waitForRow<any>(
        () => supabase.from('ds_proposals').select('*').eq('id', dbProposalId).single(),
        'proposal P4',
      );

      expect(proposal).toBeTruthy();
      expect(proposal!.dao_id).toBe(daoId);
      expect(proposal!.sponsored).toBe(true);
      expect(proposal!.processed).toBe(true);
      expect(proposal!.passed).toBe(true);
      console.log('   Proposal record verified (sponsored, processed, passed)');

      // Check votes
      const { data: votes } = await supabase
        .from('ds_votes')
        .select('*')
        .eq('proposal_id', dbProposalId);

      expect(votes).toBeTruthy();
      expect(votes!.length).toBe(2);
      expect(votes!.every((v: any) => v.approved === true)).toBe(true);
      console.log(`   Votes verified (${votes!.length} YES votes)`);

      // Check DAO proposal_count
      const dao = await waitForRow<any>(
        () => supabase.from('ds_daos').select('proposal_count').eq('id', daoId).single(),
        'dao proposal_count P4',
      );

      expect(dao).toBeTruthy();
      expect(Number(dao!.proposal_count)).toBeGreaterThanOrEqual(1);
      console.log(`   DAO proposal_count: ${dao!.proposal_count}`);

      console.log('  Phase 4 PASSED\n');
    },
    perProposalMs + proposalPhaseOverhead,
  );

  // ════════════════════════════════════════════════════════════════════
  // PHASE 5: Convert Shares to Loot
  // ════════════════════════════════════════════════════════════════════

  it(
    'Phase 5: Convert shares to loot',
    async () => {
      console.log('\n== PHASE 5: Convert Shares to Loot ==\n');

      // Snapshot Alice's balances before conversion
      const aliceSharesBefore = await shares.balanceOf(alice.address);
      const aliceLootBefore = await loot.balanceOf(alice.address);
      const convertAmount = quais.parseQuai('5');

      console.log(`  Alice shares before: ${quais.formatQuai(aliceSharesBefore)}`);
      console.log(`  Alice loot before:   ${quais.formatQuai(aliceLootBefore)}`);
      console.log(`  Converting: ${quais.formatQuai(convertAmount)} shares -> loot`);

      // Snapshot DAO totals before conversion
      const { data: daoBefore } = await supabase
        .from('ds_daos')
        .select('total_shares, total_loot')
        .eq('id', daoId)
        .single();

      await withTestRetry(() => provider.getBlockNumber(Shard.Cyprus1), 'getBlockNumber P5');

      const receipt = await sendTx(
        () => daoShip.connect(deployer).convertSharesToLoot(alice.address, convertAmount),
        'convertSharesToLoot P5',
      );
      const blockNum = receipt.blockNumber;
      console.log(`   Confirmed in block ${blockNum}`);

      // Verify on-chain balances changed
      const aliceSharesAfter = await shares.balanceOf(alice.address);
      const aliceLootAfter = await loot.balanceOf(alice.address);
      expect(aliceSharesAfter).toBe(aliceSharesBefore - convertAmount);
      expect(aliceLootAfter).toBe(aliceLootBefore + convertAmount);
      console.log(`   Alice shares after: ${quais.formatQuai(aliceSharesAfter)}`);
      console.log(`   Alice loot after:   ${quais.formatQuai(aliceLootAfter)}`);

      // ── INDEXER VERIFICATION ────────────────────────────────

      console.log('\n  Verifying indexer...');
      await waitForIndexer(supabase, blockNum, 'Phase 5');

      const aliceMemberId = `${daoId}-${alice.address.toLowerCase()}`;
      const aliceMember = await waitForRow<any>(
        () => supabase.from('ds_members').select('shares, loot').eq('id', aliceMemberId).single(),
        'aliceMember P5',
      );

      expect(aliceMember).toBeTruthy();
      expect(BigInt(aliceMember!.shares)).toBe(aliceSharesAfter);
      expect(BigInt(aliceMember!.loot)).toBe(aliceLootAfter);
      console.log(`   Alice shares in DB: ${aliceMember!.shares} (matches on-chain)`);
      console.log(`   Alice loot in DB:   ${aliceMember!.loot} (matches on-chain)`);

      // Check DAO totals updated — ConvertSharesToLoot handler owns DAO totals
      // for this operation (Transfer handler only owns member balances)
      const daoAfter = await waitForRow<any>(
        () => supabase.from('ds_daos').select('total_shares, total_loot').eq('id', daoId).single(),
        'daoAfter P5',
      );

      expect(daoAfter).toBeTruthy();
      if (daoBefore) {
        expect(BigInt(daoAfter!.total_shares)).toBeLessThan(BigInt(daoBefore.total_shares));
        expect(BigInt(daoAfter!.total_loot)).toBeGreaterThan(BigInt(daoBefore.total_loot));
        console.log(`   DAO total_shares: ${daoBefore.total_shares} -> ${daoAfter!.total_shares}`);
        console.log(`   DAO total_loot:   ${daoBefore.total_loot} -> ${daoAfter!.total_loot}`);
      }

      console.log('  Phase 5 PASSED\n');
    },
    simplePhaseTimeout,
  );

  // ════════════════════════════════════════════════════════════════════
  // PHASE 5b: Delegate Votes
  // ════════════════════════════════════════════════════════════════════

  it(
    'Phase 5b: Delegate votes',
    async () => {
      console.log('\n== PHASE 5b: Delegate Votes ==\n');

      console.log(`  Alice delegates voting power to Bob`);

      await withTestRetry(() => provider.getBlockNumber(Shard.Cyprus1), 'getBlockNumber P5b');

      const receipt = await sendTx(
        () => shares.connect(alice).delegate(bob.address),
        'delegate P5b',
      );
      const blockNum = receipt.blockNumber;
      console.log(`   Confirmed in block ${blockNum}`);

      // ── INDEXER VERIFICATION ────────────────────────────────

      console.log('\n  Verifying indexer...');
      await waitForIndexer(supabase, blockNum, 'Phase 5b');

      // Check ds_delegations table for the delegation record
      const { data: delegations } = await supabase
        .from('ds_delegations')
        .select('*')
        .eq('dao_id', daoId)
        .eq('delegator', alice.address.toLowerCase())
        .eq('to_delegate', bob.address.toLowerCase());

      expect(delegations).toBeTruthy();
      expect(delegations!.length).toBeGreaterThanOrEqual(1);
      console.log(`   Delegation record verified (${delegations!.length} record(s))`);

      // Check Alice's delegating_to in ds_members
      const aliceMemberId = `${daoId}-${alice.address.toLowerCase()}`;
      const aliceMember = await waitForRow<any>(
        () => supabase.from('ds_members').select('delegating_to').eq('id', aliceMemberId).single(),
        'aliceMember P5b',
      );

      expect(aliceMember).toBeTruthy();
      expect(aliceMember!.delegating_to).toBe(bob.address.toLowerCase());
      console.log(`   Alice delegating_to: ${aliceMember!.delegating_to}`);

      // Check Bob's voting_power increased in ds_members
      const bobMemberId = `${daoId}-${bob.address.toLowerCase()}`;
      const bobMember = await waitForRow<any>(
        () => supabase.from('ds_members').select('voting_power').eq('id', bobMemberId).single(),
        'bobMember P5b',
      );

      expect(bobMember).toBeTruthy();
      expect(BigInt(bobMember!.voting_power)).toBeGreaterThan(0n);
      console.log(`   Bob voting_power: ${bobMember!.voting_power}`);

      console.log('  Phase 5b PASSED\n');
    },
    simplePhaseTimeout,
  );

  // ════════════════════════════════════════════════════════════════════
  // PHASE 5c: Post DAO Profile via Poster
  // ════════════════════════════════════════════════════════════════════

  it(
    'Phase 5c: Post DAO profile via Poster',
    async () => {
      console.log('\n== PHASE 5c: Post DAO Profile via Poster ==\n');

      const posterAddress = deploymentAddresses.contracts.Poster;
      expect(posterAddress).toBeTruthy();
      console.log(`  Poster contract: ${posterAddress}`);

      const poster = new quais.Contract(posterAddress, PosterABI, provider);

      const postContent = JSON.stringify({
        schemaVersion: '1.0',
        daoAddress: daoId,
        proposalId: 1,
        vote: true,
        reason: 'E2E test vote reason',
        extraField: 'this should be stripped by validation',
        __proto__: 'prototype pollution attempt',
      });
      // Use daoships.proposal.vote.reason (MEMBER min trust) — deployer has shares from init.
      const postTag = 'daoships.proposal.vote.reason';

      console.log(`  Posting with tag: ${postTag}`);

      await withTestRetry(() => provider.getBlockNumber(Shard.Cyprus1), 'getBlockNumber P5c');

      const receipt = await sendTx(
        () => poster.connect(deployer)['post(string,string)'](postContent, postTag),
        'post P5c',
      );
      const blockNum = receipt.blockNumber;
      console.log(`   Confirmed in block ${blockNum}`);

      // ── INDEXER VERIFICATION ────────────────────────────────

      console.log('\n  Verifying indexer...');
      await waitForIndexer(supabase, blockNum, 'Phase 5c');

      // Check ds_records table for the posted record
      const { data: records } = await supabase
        .from('ds_records')
        .select('*')
        .eq('dao_id', daoId)
        .eq('tag', postTag);

      expect(records).toBeTruthy();
      expect(records!.length).toBeGreaterThanOrEqual(1);

      const record = records![0];
      expect(record.user_address).toBe(deployer.address.toLowerCase());
      expect(record.content).toBeTruthy();
      expect(record.trust_level).toBeTruthy();
      console.log(`   Record verified: tag=${record.tag}, user=${record.user_address}, trust=${record.trust_level}`);

      // Verify raw content preserves original (including extra fields)
      const rawContent = JSON.parse(record.content);
      expect(rawContent.extraField).toBe('this should be stripped by validation');
      console.log('   Raw content preserved (includes extra fields)');

      // Verify content_json has only validated/spec-compliant fields
      const validated = record.content_json;
      expect(validated).toBeTruthy();
      expect(validated.daoAddress).toBe(daoId);
      expect(validated.reason).toBe('E2E test vote reason');
      expect(validated.schemaVersion).toBe('1.0');
      expect(validated.extraField).toBeUndefined(); // stripped by validator
      expect(Object.hasOwn(validated, '__proto__')).toBe(false); // prototype key stripped
      console.log('   content_json validated: extra fields stripped, spec fields preserved');

      console.log('  Phase 5c PASSED\n');
    },
    simplePhaseTimeout,
  );

  // ════════════════════════════════════════════════════════════════════
  // PHASE 6: Update Navigators (NavigatorSet)
  // ════════════════════════════════════════════════════════════════════

  it(
    'Phase 6: Update navigators via governance (NavigatorSet event)',
    async () => {
      console.log('\n== PHASE 6: Update Navigators (NavigatorSet) ==\n');

      const daoShipAddr = await daoShip.getAddress();

      const setNavigatorsData = daoShip.interface.encodeFunctionData('setNavigators', [
        [bob.address],
        [1], // ADMIN
      ]);
      const executeData = daoShip.interface.encodeFunctionData('executeAsGovernance', [
        daoShipAddr,
        0,
        setNavigatorsData,
      ]);
      const proposalData = encodeMultiSend([
        { operation: 0, to: daoShipAddr, value: 0n, data: executeData },
      ]);

      const details = JSON.stringify({
        title: 'Add Bob as Admin Navigator',
        description: 'Grant Bob ADMIN permission (1)',
      });

      await withTestRetry(() => provider.getBlockNumber(Shard.Cyprus1), 'getBlockNumber pre-submit P6');
      const submitReceipt = await sendTx(
        () => daoShip.connect(deployer).submitProposal(proposalData, 0, details),
        'submitProposal P6',
      );

      const proposalEvent = submitReceipt.logs.find((log: any) => {
        try {
          return daoShip.interface.parseLog(log)?.name === 'SubmitProposal';
        } catch {
          return false;
        }
      });
      const proposalId = daoShip.interface.parseLog(proposalEvent!)?.args[0];
      console.log(`   Proposal ID: ${proposalId}`);

      await waitPastVotingStarts(daoShip, proposalId, 'voting window P6');
      // Alice delegated her voting power to Bob in Phase 5b, so Bob votes instead.
      await castVotes(daoShip, proposalId, [
        { signer: deployer, label: 'submitVote deployer P6' },
        { signer: bob, label: 'submitVote bob P6' },
      ]);
      console.log('   Votes cast');

      await waitForProposalState(daoShip, proposalId, [5], 'ready P6', readyWaitMs);
      const processReceipt = await sendProcessProposal(
        daoShip, deployer, proposalId, proposalData, 'processProposal P6',
      );
      const processBlock = processReceipt.blockNumber;
      console.log(`   Processed in block ${processBlock}`);

      const bobPerm = await daoShip.navigators(bob.address);
      expect(bobPerm).toBe(1n);
      console.log(`   Bob permission on-chain: ${bobPerm} (ADMIN)`);

      // ── INDEXER VERIFICATION ────────────────────────────────

      console.log('\n  Verifying indexer...');
      await waitForIndexer(supabase, processBlock, 'Phase 6');

      const bobNavigatorId = `${daoId}-${bob.address.toLowerCase()}`;
      const { data: navigatorRecord } = await supabase
        .from('ds_navigators')
        .select('*')
        .eq('id', bobNavigatorId)
        .single();

      expect(navigatorRecord).toBeTruthy();
      expect(navigatorRecord!.permission).toBe(1);
      expect(navigatorRecord!.permission_label).toBe('admin');
      // Trust model: a NavigatorSet grant from a known DAO flips permission_ever_granted
      // (monotonic) and stamps trust_status='sanctioned' (permissioned navs are vouched
      // by the grant itself). is_active = (permission > 0) under the redefined semantics.
      expect(navigatorRecord!.permission_ever_granted).toBe(true);
      expect(navigatorRecord!.trust_status).toBe('sanctioned');
      expect(navigatorRecord!.is_active).toBe(true);
      console.log('   Bob navigator record verified (ADMIN, ever_granted, sanctioned)');

      console.log('  Phase 6 PASSED\n');
    },
    perProposalMs + proposalPhaseOverhead,
  );

  // ════════════════════════════════════════════════════════════════════
  // PHASE 6b: Deploy SignalNavigator (read-only) — self_asserted binding
  // ════════════════════════════════════════════════════════════════════
  // A SignalNavigator holds NO permission and NEVER fires NavigatorSet. It is
  // deployed AFTER the DAO is live so the indexer's resolution gate (which drops
  // read-only deploys aimed at unknown DAOs) recognizes daoShip. On NavigatorDeployed
  // the indexer binds dao_id from the event and records the row as self_asserted +
  // is_active=true (functional at permission 0), permission_ever_granted=false.

  it(
    'Phase 6b: Deploy SignalNavigator → self_asserted, active, dao-bound',
    async () => {
      console.log('\n== PHASE 6b: Deploy SignalNavigator (read-only) ==\n');

      const SignalNavigatorJson = JSON.parse(
        fs.readFileSync(
          path.join(ARTIFACTS_DIR, 'navigators/SignalNavigator.sol/SignalNavigator.json'),
          'utf-8',
        ),
      );
      const signalIpfsHash = extractIPFSHash(SignalNavigatorJson.bytecode);
      console.log(`   SignalNavigator IPFS: ${signalIpfsHash}`);

      await withTestRetry(() => provider.getBlockNumber(Shard.Cyprus1), 'getBlockNumber P6b');

      const SignalFactory = new quais.ContractFactory(
        SignalNavigatorABI,
        SignalNavigatorJson.bytecode,
        deployer,
        signalIpfsHash,
      );
      // SignalNavigator(daoShip, minSharesToCreatePoll, minDuration, maxDuration,
      //   maxStartDelay, name, description)
      const signalInstance = await SignalFactory.deploy(
        daoShipAddress,
        0,        // minSharesToCreatePoll (0 = anyone with power)
        60,       // minDuration (contract requires > 0)
        86_400,   // maxDuration (1 day)
        86_400,   // maxStartDelay
        'Test Signal',
        'SignalNavigator for E2E tests',
      );
      await signalInstance.waitForDeployment();
      signalNavigator = signalInstance;
      signalNavAddr = (await signalInstance.getAddress()).toLowerCase();

      // The NavigatorDeployed log is in the deployment block — backfill's lower bound.
      const deployReceipt = await signalInstance.deploymentTransaction()!.wait();
      signalNavDeployBlock = deployReceipt!.blockNumber;
      console.log(`   SignalNavigator: ${signalNavAddr} (deploy block ${signalNavDeployBlock})`);

      // ── INDEXER VERIFICATION ────────────────────────────────

      console.log('\n  Verifying indexer...');
      await waitForIndexer(supabase, signalNavDeployBlock, 'Phase 6b');

      const { data: navRow } = await supabase
        .from('ds_navigators')
        .select('*')
        .eq('id', `${daoId}-${signalNavAddr}`)
        .single();

      expect(navRow, 'SignalNavigator row should be bound on NavigatorDeployed').toBeTruthy();
      expect(navRow!.navigator_type).toBe('SignalNavigator');
      expect(navRow!.dao_id).toBe(daoId);              // bound from the event, not NavigatorSet
      expect(navRow!.permission).toBe(0);              // read-only — no permission, ever
      expect(navRow!.permission_ever_granted).toBe(false);
      expect(navRow!.trust_status).toBe('self_asserted'); // not yet sanctioned by the DAO
      expect(navRow!.is_active).toBe(true);            // functional at permission 0 (NOT revoked)
      expect(Number(navRow!.deploy_block)).toBe(signalNavDeployBlock);
      console.log('   SignalNavigator row verified (self_asserted, active, dao-bound)');

      console.log('  Phase 6b PASSED\n');
    },
    simplePhaseTimeout,
  );

  // ════════════════════════════════════════════════════════════════════
  // PHASE 6c: Create a poll + vote BEFORE sanction → deferred (not materialized)
  // ════════════════════════════════════════════════════════════════════
  // The materialization gate: PollCreated/Voted are SEEN (logs marked processed)
  // but NOT written while the navigator is only self_asserted. This proves a flood
  // of unsanctioned read-only navigators cannot bloat the signal tables.

  it(
    'Phase 6c: Poll + votes on a self_asserted navigator are deferred (no rows)',
    async () => {
      console.log('\n== PHASE 6c: Poll + votes deferred (pre-sanction) ==\n');

      await withTestRetry(() => provider.getBlockNumber(Shard.Cyprus1), 'getBlockNumber P6c');

      // duration generous enough to cast both votes inside the half-open window.
      const createReceipt = await sendTx(
        () => signalNavigator.connect(deployer).createPoll('Ship v2?', 3, 0, 300),
        'createPoll P6c',
      );
      const pollEvent = createReceipt.logs.find((log: any) => {
        try { return signalNavigator.interface.parseLog(log)?.name === 'PollCreated'; }
        catch { return false; }
      });
      expect(pollEvent, 'PollCreated should be emitted').toBeTruthy();
      signalPollId = signalNavigator.interface.parseLog(pollEvent!)?.args[0];
      console.log(`   Poll created: id=${signalPollId}`);

      // Two voters with voting power: deployer (init shares) and bob (onboarded +
      // Alice's delegation from Phase 5b). Half-open [start, end) window is open now.
      await sendTx(() => signalNavigator.connect(deployer).vote(signalPollId, 0), 'vote deployer P6c');
      const voteReceipt = await sendTx(() => signalNavigator.connect(bob).vote(signalPollId, 1), 'vote bob P6c');
      const voteBlock = voteReceipt.blockNumber;
      console.log(`   Votes cast (deployer→0, bob→1), block ${voteBlock}`);

      // ── INDEXER VERIFICATION ────────────────────────────────

      console.log('\n  Verifying indexer...');
      await waitForIndexer(supabase, voteBlock, 'Phase 6c');

      const pollPk = `${signalNavAddr}-${signalPollId}`;
      const { data: polls } = await supabase
        .from('ds_signal_polls')
        .select('*')
        .eq('id', pollPk);
      expect(polls ?? [], 'poll must NOT be materialized while self_asserted').toHaveLength(0);

      const { data: votes } = await supabase
        .from('ds_signal_votes')
        .select('*')
        .eq('navigator_address', signalNavAddr);
      expect(votes ?? [], 'votes must NOT be materialized while self_asserted').toHaveLength(0);
      console.log('   Deferred correctly: no poll/vote rows pre-sanction');

      console.log('  Phase 6c PASSED\n');
    },
    simplePhaseTimeout,
  );

  // ════════════════════════════════════════════════════════════════════
  // PHASE 6d: Vault sanctions the navigator → backfill materializes history
  // ════════════════════════════════════════════════════════════════════
  // The DAO's vault (avatar) posts daoships.dao.navigators — the authoritative
  // "DAO authorized it" signal (VERIFIED = msg.sender == avatar). The indexer flips
  // trust_status self_asserted→sanctioned and BACKFILLS the navigator's poll history
  // (getLogs by address from deploy_block), so the Phase 6c poll/votes now appear.

  it(
    'Phase 6d: Vault sanction flips trust + backfills the deferred poll/votes',
    async () => {
      console.log('\n== PHASE 6d: Vault sanction + backfill ==\n');

      const posterAddress = deploymentAddresses.contracts.Poster;
      const poster = new quais.Contract(posterAddress, PosterABI, provider);

      // Full-set sanction list (canonical; not a delta). The vault must be msg.sender,
      // so route the Poster.post through the vault's propose→approve→execute flow.
      const sanctionContent = JSON.stringify({
        schemaVersion: '1.0',
        daoAddress: daoId,
        navigators: [{ address: signalNavAddr, type: 'SignalNavigator' }],
      });
      const postData = poster.interface.encodeFunctionData('post(string,string)', [
        sanctionContent,
        'daoships.dao.navigators',
      ]);

      const vaultContract = new quais.Contract(vault, QuaiVaultJson.abi, deployer);

      await withTestRetry(() => provider.getBlockNumber(Shard.Cyprus1), 'getBlockNumber P6d');

      const proposeReceipt = await sendTx(
        () => vaultContract.proposeTransaction(posterAddress, 0, postData),
        'vault proposeTransaction P6d',
      );
      const proposeLog = proposeReceipt.logs.find((log: any) => {
        try { return vaultContract.interface.parseLog(log)?.name === 'TransactionProposed'; }
        catch { return false; }
      });
      const vaultTxHash = vaultContract.interface.parseLog(proposeLog!)?.args.txHash;
      await sendTx(() => vaultContract.approveTransaction(vaultTxHash), 'vault approveTransaction P6d');
      const execReceipt = await sendTx(
        () => vaultContract.executeTransaction(vaultTxHash),
        'vault executeTransaction P6d',
      );
      const sanctionBlock = execReceipt.blockNumber;
      console.log(`   Vault posted daoships.dao.navigators in block ${sanctionBlock}`);

      // ── INDEXER VERIFICATION ────────────────────────────────

      console.log('\n  Verifying indexer...');
      await waitForIndexer(supabase, sanctionBlock, 'Phase 6d');

      // 1. Trust flipped to sanctioned (still permission 0, still active, never granted).
      const { data: navRow } = await supabase
        .from('ds_navigators')
        .select('*')
        .eq('id', `${daoId}-${signalNavAddr}`)
        .single();
      expect(navRow!.trust_status).toBe('sanctioned');
      expect(navRow!.permission_ever_granted).toBe(false); // sanctioning grants no permission
      expect(navRow!.is_active).toBe(true);
      console.log('   trust_status flipped to sanctioned');

      // 2. Backfill materialized the deferred poll (created while self_asserted).
      const pollPk = `${signalNavAddr}-${signalPollId}`;
      const { data: poll } = await supabase
        .from('ds_signal_polls')
        .select('*')
        .eq('id', pollPk)
        .single();
      expect(poll, 'poll should be backfilled on sanction').toBeTruthy();
      expect(poll!.dao_id).toBe(daoId);
      expect(poll!.navigator_address).toBe(signalNavAddr);
      expect(poll!.creator).toBe(deployer.address.toLowerCase());
      expect(poll!.option_count).toBe(3);
      expect(poll!.cancelled).toBe(false);
      console.log('   Poll backfilled and verified');

      // 3. Both votes materialized, keyed (navigator, poll, voter).
      const { data: votes } = await supabase
        .from('ds_signal_votes')
        .select('*')
        .eq('poll_pk', pollPk);
      expect(votes, 'votes should be backfilled on sanction').toBeTruthy();
      expect(votes!.length).toBe(2);
      const byVoter = Object.fromEntries(votes!.map((v: any) => [v.voter, v]));
      expect(byVoter[deployer.address.toLowerCase()].option).toBe(0);
      expect(byVoter[bob.address.toLowerCase()].option).toBe(1);
      expect(votes!.every((v: any) => BigInt(v.weight) > 0n)).toBe(true);
      console.log('   Both votes backfilled (deployer→0, bob→1)');

      // 4. Tally is derived-from-truth (ds_recompute_poll_tally), not incremented.
      if (poll!.tally != null) {
        const tally = poll!.tally as any[];
        expect(tally.length).toBe(3);
        expect(BigInt(tally[0])).toBe(BigInt(byVoter[deployer.address.toLowerCase()].weight));
        expect(BigInt(tally[1])).toBe(BigInt(byVoter[bob.address.toLowerCase()].weight));
        expect(BigInt(tally[2])).toBe(0n);
        console.log(`   Tally derived from votes: [${tally.join(', ')}]`);
      }

      console.log('  Phase 6d PASSED\n');
    },
    perProposalMs + proposalPhaseOverhead,
  );

  // ════════════════════════════════════════════════════════════════════
  // PHASE 6e: Poll option labels via Poster (daoships.signal.poll)
  // ════════════════════════════════════════════════════════════════════
  // The SignalNavigator stores only optionCount — option LABELS live off-chain in a
  // daoships.signal.poll Poster post by the poll CREATOR (msg.sender == PollCreated.creator).
  // The navigator is sanctioned (Phase 6d), so a freshly created poll materializes live; the
  // labels post then decorates ds_signal_polls.options. A non-creator post is ignored.
  // See docs/SIGNAL_POLL_LABELS_SUPPORT.md.

  it(
    'Phase 6e: Poll creator labels options via daoships.signal.poll; non-creator post ignored',
    async () => {
      console.log('\n== PHASE 6e: Signal poll option labels ==\n');

      const posterAddress = deploymentAddresses.contracts.Poster;
      const poster = new quais.Contract(posterAddress, PosterABI, provider);

      await withTestRetry(() => provider.getBlockNumber(Shard.Cyprus1), 'getBlockNumber P6e');

      // 1. New poll on the now-sanctioned navigator — long window so labels land while Active.
      const createReceipt = await sendTx(
        () => signalNavigator.connect(deployer).createPoll('Which v2 brand color?', 3, 0, 3600),
        'createPoll P6e',
      );
      const pollEvent = createReceipt.logs.find((log: any) => {
        try { return signalNavigator.interface.parseLog(log)?.name === 'PollCreated'; }
        catch { return false; }
      });
      expect(pollEvent, 'PollCreated should be emitted').toBeTruthy();
      const labelPollId: bigint = signalNavigator.interface.parseLog(pollEvent!)?.args[0];
      const labelPollPk = `${signalNavAddr}-${labelPollId}`;
      console.log(`   Poll created: id=${labelPollId}`);

      await waitForIndexer(supabase, createReceipt.blockNumber, 'Phase 6e (poll)');

      // Sanctioned navigator → poll materializes live; labels not set yet.
      const { data: prePoll } = await supabase
        .from('ds_signal_polls').select('*').eq('id', labelPollPk).single();
      expect(prePoll, 'poll should materialize live on a sanctioned navigator').toBeTruthy();
      expect(prePoll!.options ?? null, 'options NULL until labels post seen').toBeNull();
      console.log('   Poll materialized live; options NULL (render Option 1..n)');

      // 2. Creator posts option labels DIRECTLY (msg.sender == creator == deployer).
      const labelContent = JSON.stringify({
        schemaVersion: '1.0',
        daoAddress: daoId,
        navigatorAddress: signalNavAddr,
        pollId: Number(labelPollId),
        options: ['Teal', 'Magenta', 'Slate'],
        description: 'Pick the v2 brand color.',
        discussionUrl: 'https://forum.example.xyz/t/brand-color/789',
      });
      const labelReceipt = await sendTx(
        () => poster.connect(deployer)['post(string,string)'](labelContent, 'daoships.signal.poll'),
        'creator signal.poll post P6e',
      );
      console.log(`   Creator posted labels in block ${labelReceipt.blockNumber}`);

      await waitForIndexer(supabase, labelReceipt.blockNumber, 'Phase 6e (labels)');

      const { data: labeled } = await supabase
        .from('ds_signal_polls').select('*').eq('id', labelPollPk).single();
      expect(labeled!.options, 'options applied from creator post').toEqual(['Teal', 'Magenta', 'Slate']);
      expect(labeled!.description).toBe('Pick the v2 brand color.');
      expect(labeled!.discussion_url).toBe('https://forum.example.xyz/t/brand-color/789');
      expect(Number(labeled!.labels_block_number)).toBe(labelReceipt.blockNumber);
      console.log('   Option labels applied: [Teal, Magenta, Slate]');

      // 3. Non-creator (bob) posts different labels → discarded (trust gate). Options unchanged.
      const spoofContent = JSON.stringify({
        schemaVersion: '1.0',
        daoAddress: daoId,
        navigatorAddress: signalNavAddr,
        pollId: Number(labelPollId),
        options: ['Hacked', 'Spoofed', 'Fake'],
      });
      const spoofReceipt = await sendTx(
        () => poster.connect(bob)['post(string,string)'](spoofContent, 'daoships.signal.poll'),
        'non-creator signal.poll post P6e',
      );
      await waitForIndexer(supabase, spoofReceipt.blockNumber, 'Phase 6e (spoof)');

      const { data: afterSpoof } = await supabase
        .from('ds_signal_polls').select('options').eq('id', labelPollPk).single();
      expect(afterSpoof!.options, 'non-creator labels must be ignored').toEqual(['Teal', 'Magenta', 'Slate']);
      console.log('   Non-creator labels correctly ignored');

      console.log('  Phase 6e PASSED\n');
    },
    perProposalMs + proposalPhaseOverhead,
  );

  // ════════════════════════════════════════════════════════════════════
  // PHASE 7: Mint Loot
  // ════════════════════════════════════════════════════════════════════

  it(
    'Phase 7: Mint loot via navigator',
    async () => {
      console.log('\n== PHASE 7: Mint Loot ==\n');

      const carolLootBefore = await loot.balanceOf(carol.address);
      await withTestRetry(() => provider.getBlockNumber(Shard.Cyprus1), 'getBlockNumber P7');

      const mintReceipt = await sendTx(
        () => daoShip.connect(deployer).mintLoot([carol.address], [quais.parseQuai('50')]),
        'mintLoot P7',
      );
      const blockNum = mintReceipt.blockNumber;
      console.log(`   Loot minted in block ${blockNum}`);

      const carolLootAfter = await loot.balanceOf(carol.address);
      console.log(
        `   Carol loot: ${quais.formatQuai(carolLootBefore)} -> ${quais.formatQuai(carolLootAfter)}`,
      );
      expect(carolLootAfter).toBeGreaterThan(carolLootBefore);

      // ── INDEXER VERIFICATION ────────────────────────────────

      console.log('\n  Verifying indexer...');
      await waitForIndexer(supabase, blockNum, 'Phase 7');

      const carolMemberId = `${daoId}-${carol.address.toLowerCase()}`;
      const { data: carolMember } = await supabase
        .from('ds_members')
        .select('loot')
        .eq('id', carolMemberId)
        .single();

      expect(carolMember).toBeTruthy();
      expect(BigInt(carolMember!.loot)).toBeGreaterThan(0n);
      console.log(`   Carol loot in DB: ${carolMember!.loot}`);

      // Check DAO total_loot
      const { data: dao } = await supabase
        .from('ds_daos')
        .select('total_loot')
        .eq('id', daoId)
        .single();

      expect(dao).toBeTruthy();
      expect(BigInt(dao!.total_loot)).toBeGreaterThan(0n);
      console.log(`   DAO total_loot: ${dao!.total_loot}`);

      console.log('  Phase 7 PASSED\n');
    },
    simplePhaseTimeout,
  );

  // ════════════════════════════════════════════════════════════════════
  // PHASE 8: Burn Shares & Loot
  // ════════════════════════════════════════════════════════════════════

  it(
    'Phase 8: Burn shares and loot',
    async () => {
      console.log('\n== PHASE 8: Burn Shares & Loot ==\n');

      // Burn shares from Bob
      const bobSharesBefore = await shares.balanceOf(bob.address);
      await withTestRetry(() => provider.getBlockNumber(Shard.Cyprus1), 'getBlockNumber P8 shares');

      const burnSharesReceipt = await sendTx(
        () => daoShip.connect(deployer).burnShares([bob.address], [quais.parseQuai('0.5')]),
        'burnShares P8',
      );
      console.log(`   Shares burned in block ${burnSharesReceipt.blockNumber}`);

      const bobSharesAfter = await shares.balanceOf(bob.address);
      expect(bobSharesAfter).toBe(bobSharesBefore - quais.parseQuai('0.5'));

      // Burn loot from Carol
      const carolLootBefore = await loot.balanceOf(carol.address);
      await withTestRetry(() => provider.getBlockNumber(Shard.Cyprus1), 'getBlockNumber P8 loot');

      const burnLootReceipt = await sendTx(
        () => daoShip.connect(deployer).burnLoot([carol.address], [quais.parseQuai('10')]),
        'burnLoot P8',
      );
      const lastBlock = burnLootReceipt.blockNumber;
      console.log(`   Loot burned in block ${lastBlock}`);

      const carolLootAfter = await loot.balanceOf(carol.address);
      expect(carolLootAfter).toBe(carolLootBefore - quais.parseQuai('10'));

      // ── INDEXER VERIFICATION ────────────────────────────────

      console.log('\n  Verifying indexer...');
      await waitForIndexer(supabase, lastBlock, 'Phase 8');

      const bobMemberId = `${daoId}-${bob.address.toLowerCase()}`;
      const bobMember = await waitForRow<any>(
        () => supabase.from('ds_members').select('shares').eq('id', bobMemberId).single(),
        'bobMember P8',
      );

      expect(bobMember).toBeTruthy();
      expect(BigInt(bobMember!.shares)).toBe(bobSharesAfter);
      console.log(`   Bob shares in DB: ${bobMember!.shares} (matches on-chain)`);

      const carolMemberId = `${daoId}-${carol.address.toLowerCase()}`;
      const carolMember = await waitForRow<any>(
        () => supabase.from('ds_members').select('loot').eq('id', carolMemberId).single(),
        'carolMember P8',
      );

      expect(carolMember).toBeTruthy();
      expect(BigInt(carolMember!.loot)).toBe(carolLootAfter);
      console.log(`   Carol loot in DB: ${carolMember!.loot} (matches on-chain)`);

      console.log('  Phase 8 PASSED\n');
    },
    simplePhaseTimeout,
  );

  // ════════════════════════════════════════════════════════════════════
  // PHASE 9: Pause / Unpause Tokens
  // ════════════════════════════════════════════════════════════════════

  it(
    'Phase 9: Pause and unpause tokens',
    async () => {
      console.log('\n== PHASE 9: Pause/Unpause Tokens ==\n');

      // Step 1: Pause both
      console.log('  Pausing tokens...');
      await withTestRetry(() => provider.getBlockNumber(Shard.Cyprus1), 'getBlockNumber P9 pause');
      const pauseReceipt = await sendTx(
        () => daoShip.connect(deployer).setAdminConfig(true, true),
        'setAdminConfig pause P9',
      );
      const pauseBlock = pauseReceipt.blockNumber;
      console.log(`   Paused in block ${pauseBlock}`);

      expect(await shares.paused()).toBe(true);
      expect(await loot.paused()).toBe(true);

      // Verify indexer sees pause
      console.log('  Verifying pause...');
      await waitForIndexer(supabase, pauseBlock, 'Phase 9 pause');

      const { data: daoPaused } = await supabase
        .from('ds_daos')
        .select('shares_paused, loot_paused')
        .eq('id', daoId)
        .single();

      expect(daoPaused).toBeTruthy();
      expect(daoPaused!.shares_paused).toBe(true);
      expect(daoPaused!.loot_paused).toBe(true);
      console.log('   Pause state verified in DB');

      // Step 2: Unpause both
      console.log('  Unpausing tokens...');
      await withTestRetry(() => provider.getBlockNumber(Shard.Cyprus1), 'getBlockNumber P9 unpause');
      const unpauseReceipt = await sendTx(
        () => daoShip.connect(deployer).setAdminConfig(false, false),
        'setAdminConfig unpause P9',
      );
      const unpauseBlock = unpauseReceipt.blockNumber;
      console.log(`   Unpaused in block ${unpauseBlock}`);

      expect(await shares.paused()).toBe(false);
      expect(await loot.paused()).toBe(false);

      // Verify indexer sees unpause
      console.log('  Verifying unpause...');
      await waitForIndexer(supabase, unpauseBlock, 'Phase 9 unpause');

      const { data: daoUnpaused } = await supabase
        .from('ds_daos')
        .select('shares_paused, loot_paused')
        .eq('id', daoId)
        .single();

      expect(daoUnpaused).toBeTruthy();
      expect(daoUnpaused!.shares_paused).toBe(false);
      expect(daoUnpaused!.loot_paused).toBe(false);
      console.log('   Unpause state verified in DB');

      console.log('  Phase 9 PASSED\n');
    },
    simplePhaseTimeout,
  );

  // ════════════════════════════════════════════════════════════════════
  // PHASE 10: Remove Navigator
  // ════════════════════════════════════════════════════════════════════

  it(
    'Phase 10: Remove navigator via governance',
    async () => {
      console.log('\n== PHASE 10: Remove Navigator ==\n');

      const daoShipAddr = await daoShip.getAddress();
      const onboarderAddr = await onboarderNavigator.getAddress();

      const setNavigatorsData = daoShip.interface.encodeFunctionData('setNavigators', [
        [onboarderAddr],
        [0], // Remove
      ]);
      const executeData = daoShip.interface.encodeFunctionData('executeAsGovernance', [
        daoShipAddr,
        0,
        setNavigatorsData,
      ]);
      const proposalData = encodeMultiSend([
        { operation: 0, to: daoShipAddr, value: 0n, data: executeData },
      ]);

      const details = JSON.stringify({
        title: 'Remove OnboarderNavigator',
        description: 'Set permission to 0',
      });

      await withTestRetry(() => provider.getBlockNumber(Shard.Cyprus1), 'getBlockNumber pre-submit P10');
      const submitReceipt = await sendTx(
        () => daoShip.connect(deployer).submitProposal(proposalData, 0, details),
        'submitProposal P10',
      );

      const proposalEvent = submitReceipt.logs.find((log: any) => {
        try {
          return daoShip.interface.parseLog(log)?.name === 'SubmitProposal';
        } catch {
          return false;
        }
      });
      const proposalId = daoShip.interface.parseLog(proposalEvent!)?.args[0];
      console.log(`   Proposal ID: ${proposalId}`);

      await waitPastVotingStarts(daoShip, proposalId, 'voting window P10');
      // Alice delegated her voting power to Bob in Phase 5b, so Bob votes instead.
      await castVotes(daoShip, proposalId, [
        { signer: deployer, label: 'submitVote deployer P10' },
        { signer: bob, label: 'submitVote bob P10' },
      ]);

      await waitForProposalState(daoShip, proposalId, [5], 'ready P10', readyWaitMs);
      const processReceipt = await sendProcessProposal(
        daoShip, deployer, proposalId, proposalData, 'processProposal P10',
      );
      const processBlock = processReceipt.blockNumber;
      console.log(`   Processed in block ${processBlock}`);

      const permAfter = await daoShip.navigators(onboarderAddr);
      expect(permAfter).toBe(0n);

      // ── INDEXER VERIFICATION ────────────────────────────────

      console.log('\n  Verifying indexer...');
      await waitForIndexer(supabase, processBlock, 'Phase 10');

      const navigatorId = `${daoId}-${onboarderAddr.toLowerCase()}`;
      const navigatorRecord = await waitForRow<any>(
        () => supabase.from('ds_navigators').select('*').eq('id', navigatorId).single(),
        'navigatorRecord P10',
      );

      expect(navigatorRecord).toBeTruthy();
      expect(navigatorRecord!.permission).toBe(0);
      expect(navigatorRecord!.permission_label).toBe('none');
      console.log('   OnboarderNavigator removed (permission=0)');

      console.log('  Phase 10 PASSED\n');
    },
    perProposalMs + proposalPhaseOverhead,
  );

  // ════════════════════════════════════════════════════════════════════
  // PHASE 11: Cancel Proposal
  // ════════════════════════════════════════════════════════════════════

  it(
    'Phase 11: Cancel a proposal',
    async () => {
      console.log('\n== PHASE 11: Cancel Proposal ==\n');

      const proposalData = encodeMultiSend([
        {
          operation: 0,
          to: deployer.address,
          value: quais.parseQuai('0.01'),
          data: '0x',
        },
      ]);

      const details = JSON.stringify({
        title: 'Test Cancellation',
        description: 'This proposal will be cancelled',
      });

      await withTestRetry(() => provider.getBlockNumber(Shard.Cyprus1), 'getBlockNumber pre-submit P11');
      // Alice delegated her voting power to Bob in Phase 5b, so she can't
      // self-sponsor. She must send proposalOffering as msg.value instead.
      const proposalOffering = await daoShip.proposalOffering();
      const submitReceipt = await sendTx(
        () => daoShip.connect(alice).submitProposal(proposalData, 0, details, { value: proposalOffering }),
        'submitProposal P11',
      );

      const proposalEvent = submitReceipt.logs.find((log: any) => {
        try {
          return daoShip.interface.parseLog(log)?.name === 'SubmitProposal';
        } catch {
          return false;
        }
      });
      const proposalId = daoShip.interface.parseLog(proposalEvent!)?.args[0];
      console.log(`   Proposal ID: ${proposalId}`);

      await withTestRetry(() => provider.getBlockNumber(Shard.Cyprus1), 'getBlockNumber pre-cancel P11');
      const cancelReceipt = await sendTx(
        () => daoShip.connect(alice).cancelProposal(proposalId),
        'cancelProposal P11',
      );
      const cancelBlock = cancelReceipt.blockNumber;
      console.log(`   Cancelled in block ${cancelBlock}`);

      const proposalStatus = await daoShip.getProposalStatus(proposalId);
      expect(proposalStatus[0]).toBe(true); // cancelled

      // ── INDEXER VERIFICATION ────────────────────────────────

      console.log('\n  Verifying indexer...');
      await waitForIndexer(supabase, cancelBlock, 'Phase 11');

      const dbProposalId = `${daoId}-${proposalId}`;
      const { data: proposal } = await supabase
        .from('ds_proposals')
        .select('cancelled, cancelled_by')
        .eq('id', dbProposalId)
        .single();

      expect(proposal).toBeTruthy();
      expect(proposal!.cancelled).toBe(true);
      expect(proposal!.cancelled_by).toBe(alice.address.toLowerCase());
      console.log('   Proposal cancelled record verified');

      console.log('  Phase 11 PASSED\n');
    },
    simplePhaseTimeout,
  );

  // ════════════════════════════════════════════════════════════════════
  // PHASE 11b: Deploy + register TimelockNavigator (GOVERNOR) & VestingNavigator (MANAGER)
  // ════════════════════════════════════════════════════════════════════
  // Both are PERMISSIONED — registered via setNavigators → NavigatorSet fires and the
  // indexer marks them sanctioned. MUST run before Phase 12 (which locks manager/governor,
  // after which setNavigators/setGovernanceConfig revert).

  it(
    'Phase 11b: Deploy + register Timelock (GOVERNOR) & Vesting (MANAGER)',
    async () => {
      console.log('\n== PHASE 11b: Deploy + register Timelock & Vesting ==\n');

      // ── Deploy TimelockNavigator ──
      const TimelockJson = JSON.parse(
        fs.readFileSync(path.join(ARTIFACTS_DIR, 'navigators/TimelockNavigator.sol/TimelockNavigator.json'), 'utf-8'),
      );
      const timelockIpfs = extractIPFSHash(TimelockJson.bytecode);
      await withTestRetry(() => provider.getBlockNumber(Shard.Cyprus1), 'getBlockNumber P11b tl');
      const TimelockFactory = new quais.ContractFactory(TimelockJson.abi, TimelockJson.bytecode, deployer, timelockIpfs);
      // TimelockNavigator(daoShip, delay, expiryWindow, name, description)
      const timelockInstance = await TimelockFactory.deploy(
        daoShipAddress, TIMELOCK_DELAY_SEC, TIMELOCK_EXPIRY_SEC, 'Test Timelock', 'Timelock for E2E tests',
      );
      await timelockInstance.waitForDeployment();
      timelockNavigator = timelockInstance;
      timelockAddr = (await timelockInstance.getAddress()).toLowerCase();
      console.log(`   TimelockNavigator: ${timelockAddr}`);

      // ── Deploy VestingNavigator ──
      const VestingJson = JSON.parse(
        fs.readFileSync(path.join(ARTIFACTS_DIR, 'navigators/VestingNavigator.sol/VestingNavigator.json'), 'utf-8'),
      );
      const vestingIpfs = extractIPFSHash(VestingJson.bytecode);
      const VestingFactory = new quais.ContractFactory(VestingJson.abi, VestingJson.bytecode, deployer, vestingIpfs);
      // VestingNavigator(daoShip, name, description)
      const vestingInstance = await VestingFactory.deploy(daoShipAddress, 'Test Vesting', 'Vesting for E2E tests');
      await vestingInstance.waitForDeployment();
      vestingNavigator = vestingInstance;
      vestingAddr = (await vestingInstance.getAddress()).toLowerCase();
      const vestingDeployBlock = (await vestingInstance.deploymentTransaction()!.wait())!.blockNumber;
      console.log(`   VestingNavigator: ${vestingAddr} (deploy block ${vestingDeployBlock})`);

      // ── Register both in one governance proposal: setNavigators([tl,vesting],[4,2]) ──
      const timelockCs = await timelockInstance.getAddress();
      const vestingCs = await vestingInstance.getAddress();
      const setNavData = daoShip.interface.encodeFunctionData('setNavigators', [
        [timelockCs, vestingCs],
        [4, 2], // GOVERNOR, MANAGER
      ]);
      const execData = daoShip.interface.encodeFunctionData('executeAsGovernance', [daoShipAddress, 0, setNavData]);
      const proposalData = encodeMultiSend([{ operation: 0, to: daoShipAddress, value: 0n, data: execData }]);

      const processReceipt = await runProposal(
        daoShip, deployer, [deployer, bob], proposalData,
        JSON.stringify({ title: 'Register Timelock + Vesting navigators' }), 'P11b register',
      );
      const processBlock = processReceipt.blockNumber;

      expect(await daoShip.navigators(timelockCs)).toBe(4n);
      expect(await daoShip.navigators(vestingCs)).toBe(2n);
      console.log('   On-chain permissions: timelock=4 (GOVERNOR), vesting=2 (MANAGER)');

      // ── INDEXER VERIFICATION ────────────────────────────────
      console.log('\n  Verifying indexer...');
      await waitForIndexer(supabase, processBlock, 'Phase 11b');

      const tlRow = await waitForRow<any>(
        () => supabase.from('ds_navigators').select('*').eq('id', `${daoId}-${timelockAddr}`).single(),
        'timelock navigator P11b',
      );
      expect(tlRow, 'TimelockNavigator row').toBeTruthy();
      expect(tlRow!.navigator_type).toBe('TimelockNavigator');
      expect(tlRow!.permission).toBe(4);
      expect(tlRow!.permission_label).toBe('governor');
      expect(tlRow!.trust_status).toBe('sanctioned');
      expect(tlRow!.is_active).toBe(true);

      const vRow = await waitForRow<any>(
        () => supabase.from('ds_navigators').select('*').eq('id', `${daoId}-${vestingAddr}`).single(),
        'vesting navigator P11b',
      );
      expect(vRow, 'VestingNavigator row').toBeTruthy();
      expect(vRow!.navigator_type).toBe('VestingNavigator');
      expect(vRow!.permission).toBe(2);
      expect(vRow!.permission_label).toBe('manager');
      expect(vRow!.trust_status).toBe('sanctioned');
      console.log('   Both navigator records verified (GOVERNOR/MANAGER, sanctioned)');

      console.log('  Phase 11b PASSED\n');
    },
    perProposalMs + proposalPhaseOverhead,
  );

  // ════════════════════════════════════════════════════════════════════
  // PHASE 11c: Timelock — queue a config change, then cancel it
  // ════════════════════════════════════════════════════════════════════
  // queueChange / cancelChange are avatar-only → driven via governance proposals.
  // Neither applies the config (only executeChange does), so this leaves DAO config untouched.

  it(
    'Phase 11c: Timelock queue + cancel a governance-config change',
    async () => {
      console.log('\n== PHASE 11c: Timelock queue + cancel ==\n');

      // Encode a governanceConfig (the 7 fields, in DAOShip.setGovernanceConfig order)
      const coder = quais.AbiCoder.defaultAbiCoder();
      const newCfg = coder.encode(
        ['uint32', 'uint32', 'uint256', 'uint256', 'uint256', 'uint256', 'uint32'],
        [180, 60, quais.parseQuai('0.001'), 1000, quais.parseQuai('1'), 6600, 0],
      );
      const configHash = quais.keccak256(newCfg);
      const timelockCs = await timelockNavigator.getAddress();

      // ── Queue (changeId 0) ──
      const queueData = timelockNavigator.interface.encodeFunctionData('queueChange', [newCfg]);
      const queueProposal = encodeMultiSend([{ operation: 0, to: timelockCs, value: 0n, data: queueData }]);
      const queueReceipt = await runProposal(
        daoShip, deployer, [deployer, bob], queueProposal,
        JSON.stringify({ title: 'Queue timelock config change' }), 'P11c queue',
      );
      console.log(`   Queued in block ${queueReceipt.blockNumber}`);

      await waitForIndexer(supabase, queueReceipt.blockNumber, 'Phase 11c queue');
      const change = await waitForRow<any>(
        () => supabase.from('ds_timelock_changes').select('*').eq('id', `${timelockAddr}-0`).single(),
        'timelock change 0 P11c',
      );
      expect(change, 'ds_timelock_changes row for change 0').toBeTruthy();
      expect(change!.dao_id).toBe(daoId);
      expect(change!.navigator_address).toBe(timelockAddr);
      // NUMERIC(78,0): PostgREST deserializes small values as JS numbers (0), large ones as
      // strings — compare numerically, matching the token_id BigInt pattern above.
      expect(BigInt(change!.change_id)).toBe(0n);
      expect(change!.queued_by).toBe(vault.toLowerCase()); // avatar queues via the proposal
      expect(change!.config_hash).toBe(configHash);
      expect(change!.governance_config).toBe(newCfg); // full bytes stored for executeChange recovery
      expect(change!.status).toBe('queued');
      expect(Number(change!.executable_after)).toBeGreaterThan(0);
      expect(Number(change!.expires_at)).toBeGreaterThan(Number(change!.executable_after));
      console.log('   Queued change row verified (status=queued, full config bytes stored)');

      // ── Cancel (changeId 0) ──
      const cancelData = timelockNavigator.interface.encodeFunctionData('cancelChange', [0]);
      const cancelProposal = encodeMultiSend([{ operation: 0, to: timelockCs, value: 0n, data: cancelData }]);
      const cancelReceipt = await runProposal(
        daoShip, deployer, [deployer, bob], cancelProposal,
        JSON.stringify({ title: 'Cancel timelock config change' }), 'P11c cancel',
      );
      console.log(`   Cancelled in block ${cancelReceipt.blockNumber}`);

      await waitForIndexer(supabase, cancelReceipt.blockNumber, 'Phase 11c cancel');
      const cancelled = await waitForRow<any>(
        () => supabase.from('ds_timelock_changes').select('*').eq('id', `${timelockAddr}-0`)
          .eq('status', 'cancelled').single(),
        'timelock change 0 cancelled P11c',
      );
      expect(cancelled, 'change 0 should be cancelled').toBeTruthy();
      expect(cancelled!.status).toBe('cancelled');
      expect(cancelled!.cancelled_tx).toBeTruthy();
      console.log('   Cancelled change row verified (status=cancelled)');

      console.log('  Phase 11c PASSED\n');
    },
    2 * (perProposalMs + proposalPhaseOverhead),
  );

  // ════════════════════════════════════════════════════════════════════
  // PHASE 11d: Timelock BYPASS detection — direct setGovernanceConfig is flagged
  // ════════════════════════════════════════════════════════════════════
  // With an ACTIVE TimelockNavigator, a proposal that changes governance config DIRECTLY
  // (executeAsGovernance → setGovernanceConfig, no paired ChangeExecuted) is a timelock
  // bypass. The indexer flags ds_governance_config_history.bypassed_timelock = TRUE.

  it(
    'Phase 11d: Direct setGovernanceConfig on a timelock-enabled DAO is flagged as bypass',
    async () => {
      console.log('\n== PHASE 11d: Timelock bypass detection ==\n');

      const coder = quais.AbiCoder.defaultAbiCoder();
      const directCfg = coder.encode(
        ['uint32', 'uint32', 'uint256', 'uint256', 'uint256', 'uint256', 'uint32'],
        [180, 60, quais.parseQuai('0.001'), 1000, quais.parseQuai('1'), 6600, 0],
      );
      const setGovData = daoShip.interface.encodeFunctionData('setGovernanceConfig', [directCfg]);
      const execData = daoShip.interface.encodeFunctionData('executeAsGovernance', [daoShipAddress, 0, setGovData]);
      const proposalData = encodeMultiSend([{ operation: 0, to: daoShipAddress, value: 0n, data: execData }]);

      const processReceipt = await runProposal(
        daoShip, deployer, [deployer, bob], proposalData,
        JSON.stringify({ title: 'Direct config change (bypasses timelock)' }), 'P11d bypass',
      );
      const processBlock = processReceipt.blockNumber;
      const processTx = String(processReceipt.hash).toLowerCase();
      console.log(`   Direct GovernanceConfigSet in tx ${processTx} (block ${processBlock})`);

      await waitForIndexer(supabase, processBlock, 'Phase 11d');
      // The bypass flag is resolved at END of the range — give it a moment beyond catch-up.
      const row = await waitForRow<any>(
        () => supabase.from('ds_governance_config_history').select('*')
          .eq('dao_id', daoId).eq('tx_hash', processTx).single(),
        'governance_config_history P11d',
      );
      expect(row, 'governance config history row for the direct change').toBeTruthy();
      expect(row!.bypassed_timelock).toBe(true);
      console.log('   Bypass correctly flagged: bypassed_timelock = true');

      console.log('  Phase 11d PASSED\n');
    },
    perProposalMs + proposalPhaseOverhead,
  );

  // ════════════════════════════════════════════════════════════════════
  // PHASE 11e: Timelock EXECUTE path (opt-in) — routed change is NOT flagged
  // ════════════════════════════════════════════════════════════════════
  // Proves the bypass resolver's negative case: a change pushed through executeChange emits
  // ChangeExecuted in the SAME tx as GovernanceConfigSet → bypassed_timelock = FALSE.
  // Gated behind E2E_TIMELOCK_EXECUTE because executeChange must wait out MIN_DELAY (10 min)
  // of real wall-clock — there is no time-travel on a live testnet.

  (process.env.E2E_TIMELOCK_EXECUTE ? it : it.skip)(
    'Phase 11e: executeChange after delay applies config WITHOUT a bypass flag',
    async () => {
      console.log('\n== PHASE 11e: Timelock execute path (opt-in) ==\n');

      const coder = quais.AbiCoder.defaultAbiCoder();
      const cfg = coder.encode(
        ['uint32', 'uint32', 'uint256', 'uint256', 'uint256', 'uint256', 'uint32'],
        [180, 60, quais.parseQuai('0.001'), 1000, quais.parseQuai('1'), 6600, 0],
      );
      const timelockCs = await timelockNavigator.getAddress();

      // Queue change 1 via proposal
      const queueData = timelockNavigator.interface.encodeFunctionData('queueChange', [cfg]);
      const queueProposal = encodeMultiSend([{ operation: 0, to: timelockCs, value: 0n, data: queueData }]);
      await runProposal(daoShip, deployer, [deployer, bob], queueProposal,
        JSON.stringify({ title: 'Queue change for execute path' }), 'P11e queue');

      // changeCount is now 2 (0 from P11c, 1 here) → our change is id 1
      const changeId = 1;
      const onchain = await timelockNavigator.queuedChanges(changeId);
      const executableAfter = Number(onchain.executableAfter);
      console.log(`   Waiting for delay (executableAfter=${executableAfter}); polling chain time...`);

      // Gate on the CONTRACT's own clock via the isExecutable() view, NOT woHeader.timestamp:
      // on Quai the work-object header time runs AHEAD of the EVM block.timestamp that
      // executeChange actually enforces, so a woHeader gate returns while the change is still
      // ChangeNotReady. Polling the view sees the same block.timestamp the state-changing call
      // will (mirrors daoships-contracts `waitForContractClock`). Real ~10 min wait.
      const execDeadline = Date.now() + (TIMELOCK_DELAY_SEC + 300) * 1000;
      for (;;) {
        let ready = false;
        try { ready = await timelockNavigator.isExecutable(changeId); } catch { /* transient RPC blip */ }
        if (ready) break;
        if (Date.now() > execDeadline) throw new Error('P11e: timed out waiting for timelock delay to elapse');
        await sleep(15_000);
      }

      const execReceipt = await sendTx(
        () => timelockNavigator.connect(deployer).executeChange(changeId, cfg),
        'executeChange P11e',
      );
      const execTx = String(execReceipt.hash).toLowerCase();
      console.log(`   Executed change ${changeId} in tx ${execTx} (block ${execReceipt.blockNumber})`);

      await waitForIndexer(supabase, execReceipt.blockNumber, 'Phase 11e');

      const executed = await waitForRow<any>(
        () => supabase.from('ds_timelock_changes').select('*').eq('id', `${timelockAddr}-${changeId}`)
          .eq('status', 'executed').single(),
        'timelock change executed P11e',
      );
      expect(executed!.status).toBe('executed');
      expect(String(executed!.executed_tx).toLowerCase()).toBe(execTx);

      // The paired GovernanceConfigSet in the same tx → NOT a bypass.
      const histRow = await waitForRow<any>(
        () => supabase.from('ds_governance_config_history').select('*')
          .eq('dao_id', daoId).eq('tx_hash', execTx).single(),
        'governance_config_history P11e',
      );
      expect(histRow, 'config history row for the executed change').toBeTruthy();
      expect(histRow!.bypassed_timelock).toBe(false);
      console.log('   Routed change verified: status=executed, bypassed_timelock=false');

      console.log('  Phase 11e PASSED\n');
    },
    perProposalMs + proposalPhaseOverhead + (TIMELOCK_DELAY_SEC + 600) * 1000,
  );

  // ════════════════════════════════════════════════════════════════════
  // PHASE 11f: Vesting — create schedule, claim, revoke
  // ════════════════════════════════════════════════════════════════════
  // createSchedule / revoke are avatar-only (proposals); claim is called by the beneficiary.
  // A short fully-vesting schedule keeps the claim deterministic on a live testnet.

  it(
    'Phase 11f: Vesting create + claim + revoke',
    async () => {
      console.log('\n== PHASE 11f: Vesting create + claim + revoke ==\n');

      const vestingCs = await vestingNavigator.getAddress();
      const totalAmount = quais.parseQuai('5');

      // ── Create schedule (changeId 0) for Carol: cliff 0, vesting 1s (fully vests immediately) ──
      // createSchedule(beneficiary, totalAmount, startTime, cliffDuration, vestingDuration, isLoot)
      const createData = vestingNavigator.interface.encodeFunctionData('createSchedule', [
        carol.address, totalAmount, 0, 0, 1, false,
      ]);
      const createProposal = encodeMultiSend([{ operation: 0, to: vestingCs, value: 0n, data: createData }]);
      const createReceipt = await runProposal(
        daoShip, deployer, [deployer, bob], createProposal,
        JSON.stringify({ title: 'Create vesting schedule for Carol' }), 'P11f create',
      );
      console.log(`   Schedule created in block ${createReceipt.blockNumber}`);

      await waitForIndexer(supabase, createReceipt.blockNumber, 'Phase 11f create');
      const schedule = await waitForRow<any>(
        () => supabase.from('ds_vesting_schedules').select('*').eq('id', `${vestingAddr}-0`).single(),
        'vesting schedule 0 P11f',
      );
      expect(schedule, 'ds_vesting_schedules row').toBeTruthy();
      expect(schedule!.dao_id).toBe(daoId);
      expect(schedule!.beneficiary).toBe(carol.address.toLowerCase());
      expect(BigInt(schedule!.total_amount)).toBe(totalAmount);
      expect(schedule!.is_loot).toBe(false);
      expect(schedule!.revoked).toBe(false);
      console.log('   Schedule row verified (beneficiary=Carol, 5 shares, not revoked)');

      // ── Claim (by Carol) — schedule is fully vested (vesting=1s elapsed) ──
      const carolSharesBefore = await shares.balanceOf(carol.address);
      const claimReceipt = await sendTx(
        () => vestingNavigator.connect(carol).claim(0),
        'vesting claim P11f',
      );
      const carolSharesAfter = await shares.balanceOf(carol.address);
      const claimedDelta = carolSharesAfter - carolSharesBefore;
      expect(claimedDelta).toBeGreaterThan(0n);
      console.log(`   Carol claimed ${quais.formatQuai(claimedDelta)} shares in block ${claimReceipt.blockNumber}`);

      await waitForIndexer(supabase, claimReceipt.blockNumber, 'Phase 11f claim');
      // claimed is recomputed from the SUM of ds_vesting_claims at end-of-range.
      const claimedSchedule = await waitForRow<any>(
        () => supabase.from('ds_vesting_schedules').select('*').eq('id', `${vestingAddr}-0`).single(),
        'vesting schedule claimed P11f',
      );
      expect(BigInt(claimedSchedule!.claimed)).toBe(claimedDelta);

      const { data: claims } = await supabase
        .from('ds_vesting_claims')
        .select('*')
        .eq('schedule_pk', `${vestingAddr}-0`);
      expect(claims).toBeTruthy();
      expect(claims!.length).toBeGreaterThanOrEqual(1);
      const claimSum = claims!.reduce((acc: bigint, c: any) => acc + BigInt(c.amount), 0n);
      expect(claimSum).toBe(claimedDelta);
      expect(claims!.every((c: any) => c.is_loot === false)).toBe(true);
      console.log(`   Claim feed verified (${claims!.length} row(s), Σamount matches on-chain mint)`);

      // ── Revoke (avatar via proposal) ──
      const revokeData = vestingNavigator.interface.encodeFunctionData('revoke', [0]);
      const revokeProposal = encodeMultiSend([{ operation: 0, to: vestingCs, value: 0n, data: revokeData }]);
      const revokeReceipt = await runProposal(
        daoShip, deployer, [deployer, bob], revokeProposal,
        JSON.stringify({ title: 'Revoke Carol vesting schedule' }), 'P11f revoke',
      );
      console.log(`   Revoked in block ${revokeReceipt.blockNumber}`);

      await waitForIndexer(supabase, revokeReceipt.blockNumber, 'Phase 11f revoke');
      const revoked = await waitForRow<any>(
        () => supabase.from('ds_vesting_schedules').select('*').eq('id', `${vestingAddr}-0`)
          .eq('revoked', true).single(),
        'vesting schedule revoked P11f',
      );
      expect(revoked, 'schedule should be revoked').toBeTruthy();
      expect(revoked!.revoked).toBe(true);
      expect(Number(revoked!.revoked_at)).toBeGreaterThan(0);
      expect(revoked!.vested_at_revoke).toBeTruthy();
      console.log('   Revoked schedule row verified (revoked=true, revoked_at + vested_at_revoke set)');

      console.log('  Phase 11f PASSED\n');
    },
    2 * (perProposalMs + proposalPhaseOverhead),
  );

  // ════════════════════════════════════════════════════════════════════
  // PHASE 11g: Deploy BudgetNavigator → self_asserted, INACTIVE, dao-bound
  // ════════════════════════════════════════════════════════════════════
  // BudgetNavigator is the THIRD trust class: it holds NO DAOShip permission (no
  // NavigatorSet, like Signal) but is NOT read-only — its authority is being an enabled
  // module on the DAO's vault. So at NavigatorDeployed it is born self_asserted AND
  // is_active=false (powerless until the vault enables it), unlike a read-only nav which is
  // active at permission 0. Native zero address = QUAI; SENTINEL = Safe module linked-list head.
  const NATIVE_TOKEN = '0x0000000000000000000000000000000000000000';
  const SENTINEL_MODULES = '0x0000000000000000000000000000000000000001';

  it(
    'Phase 11g: Deploy BudgetNavigator → self_asserted, inactive, dao-bound',
    async () => {
      console.log('\n== PHASE 11g: Deploy BudgetNavigator (vault-module authority) ==\n');

      const BudgetJson = JSON.parse(
        fs.readFileSync(path.join(ARTIFACTS_DIR, 'navigators/BudgetNavigator.sol/BudgetNavigator.json'), 'utf-8'),
      );
      const budgetIpfs = extractIPFSHash(BudgetJson.bytecode);
      await withTestRetry(() => provider.getBlockNumber(Shard.Cyprus1), 'getBlockNumber P11g');

      const BudgetFactory = new quais.ContractFactory(BudgetJson.abi, BudgetJson.bytecode, deployer, budgetIpfs);
      // BudgetNavigator(daoShip, name, description) — constructor makes NO call to the DAO,
      // so it is safe against the (already-launched) DAO address.
      const budgetInstance = await BudgetFactory.deploy(daoShipAddress, 'Test Budget', 'BudgetNavigator for E2E tests');
      await budgetInstance.waitForDeployment();
      budgetNavigator = budgetInstance;
      budgetAddr = (await budgetInstance.getAddress()).toLowerCase();
      const deployReceipt = await budgetInstance.deploymentTransaction()!.wait();
      budgetNavDeployBlock = deployReceipt!.blockNumber;
      console.log(`   BudgetNavigator: ${budgetAddr} (deploy block ${budgetNavDeployBlock})`);

      // ── INDEXER VERIFICATION ────────────────────────────────
      console.log('\n  Verifying indexer...');
      await waitForIndexer(supabase, budgetNavDeployBlock, 'Phase 11g');

      const navRow = await waitForRow<any>(
        () => supabase.from('ds_navigators').select('*').eq('id', `${daoId}-${budgetAddr}`).single(),
        'budget navigator P11g',
      );
      expect(navRow, 'BudgetNavigator row should be bound on NavigatorDeployed').toBeTruthy();
      expect(navRow!.navigator_type).toBe('BudgetNavigator');
      expect(navRow!.dao_id).toBe(daoId);                 // bound from the event
      expect(navRow!.permission).toBe(0);                 // module nav — no permission, ever
      expect(navRow!.permission_ever_granted).toBe(false);
      expect(navRow!.trust_status).toBe('self_asserted'); // not yet enabled on the vault
      expect(navRow!.is_active).toBe(false);              // powerless until EnabledModule (≠ read-only)
      expect(Number(navRow!.deploy_block)).toBe(budgetNavDeployBlock);
      console.log('   BudgetNavigator row verified (self_asserted, INACTIVE, dao-bound)');

      console.log('  Phase 11g PASSED\n');
    },
    simplePhaseTimeout,
  );

  // ════════════════════════════════════════════════════════════════════
  // PHASE 11h: createBudget BEFORE enable → deferred (no ds_budgets row)
  // ════════════════════════════════════════════════════════════════════
  // The materialization gate: BudgetCreated is SEEN (log marked processed) but NOT written
  // while the navigator is only self_asserted — exactly like Signal polls pre-sanction. This
  // proves a never-enabled budget navigator cannot inject treasury activity into a DAO's feed.
  // createBudget is avatar-only → routed through the vault's propose→approve→execute flow
  // (msg.sender == vault == avatar). The budget's manager is the deployer (disburses in 11i).

  it(
    'Phase 11h: createBudget on a self_asserted navigator is deferred (no row)',
    async () => {
      console.log('\n== PHASE 11h: createBudget deferred (pre-enable) ==\n');

      const vaultContract = new quais.Contract(vault, QuaiVaultJson.abi, deployer);
      // createBudget(manager, token, allowancePerPeriod, totalCeiling, periodLength, startTime, endTime)
      const createData = budgetNavigator.interface.encodeFunctionData('createBudget', [
        deployer.address,            // manager (will disburse)
        NATIVE_TOKEN,                // native QUAI
        quais.parseQuai('0.05'),     // allowancePerPeriod
        quais.parseQuai('0.05'),     // totalCeiling
        3600,                        // periodLength (MIN_PERIOD = 1 hour)
        0,                           // startTime (0 = now)
        0,                           // endTime (0 = perpetual)
      ]);

      await withTestRetry(() => provider.getBlockNumber(Shard.Cyprus1), 'getBlockNumber P11h');
      const proposeReceipt = await sendTx(
        () => vaultContract.proposeTransaction(budgetAddr, 0, createData),
        'vault proposeTransaction createBudget P11h',
      );
      const proposeLog = proposeReceipt.logs.find((log: any) => {
        try { return vaultContract.interface.parseLog(log)?.name === 'TransactionProposed'; }
        catch { return false; }
      });
      const vaultTxHash = vaultContract.interface.parseLog(proposeLog!)?.args.txHash;
      await sendTx(() => vaultContract.approveTransaction(vaultTxHash), 'vault approve createBudget P11h');
      const execReceipt = await sendTx(
        () => vaultContract.executeTransaction(vaultTxHash),
        'vault execute createBudget P11h',
      );
      const createBlock = execReceipt.blockNumber;
      console.log(`   createBudget executed (budgetId 0) in block ${createBlock}`);

      // ── INDEXER VERIFICATION ────────────────────────────────
      console.log('\n  Verifying indexer...');
      await waitForIndexer(supabase, createBlock, 'Phase 11h');

      const { data: budgets } = await supabase
        .from('ds_budgets')
        .select('*')
        .eq('id', `${budgetAddr}-0`);
      expect(budgets ?? [], 'budget must NOT be materialized while self_asserted').toHaveLength(0);
      console.log('   Deferred correctly: no ds_budgets row pre-enable');

      console.log('  Phase 11h PASSED\n');
    },
    simplePhaseTimeout,
  );

  // ════════════════════════════════════════════════════════════════════
  // PHASE 11i: Enable module → sanctioned + active + feed + backfill; then disburse
  // ════════════════════════════════════════════════════════════════════
  // The vault enables the BudgetNavigator as a Zodiac module (msg.sender == vault). The indexer
  // records the authenticated event in ds_vault_module_events, DERIVES trust_status→sanctioned /
  // is_active→true from the feed, and BACKFILLS the deferred budget (created in 11h). The manager
  // then disburses; total_spent is derive-from-truth (SUM of ds_budget_disbursements).

  it(
    'Phase 11i: EnabledModule flips trust, backfills the budget, and a disburse is recorded',
    async () => {
      console.log('\n== PHASE 11i: Enable module + backfill + disburse ==\n');

      const vaultContract = new quais.Contract(vault, QuaiVaultJson.abi, deployer);

      // ── Enable the BudgetNavigator as a vault module ──
      let enableBlock: number;
      if (!(await vaultContract.isModuleEnabled(budgetAddr))) {
        const enableData = vaultContract.interface.encodeFunctionData('enableModule', [budgetAddr]);
        await withTestRetry(() => provider.getBlockNumber(Shard.Cyprus1), 'getBlockNumber P11i enable');
        const proposeReceipt = await sendTx(
          () => vaultContract.proposeTransaction(vault, 0, enableData),
          'vault proposeTransaction enableModule P11i',
        );
        const proposeLog = proposeReceipt.logs.find((log: any) => {
          try { return vaultContract.interface.parseLog(log)?.name === 'TransactionProposed'; }
          catch { return false; }
        });
        const vaultTxHash = vaultContract.interface.parseLog(proposeLog!)?.args.txHash;
        await sendTx(() => vaultContract.approveTransaction(vaultTxHash), 'vault approve enableModule P11i');
        const execReceipt = await sendTx(
          () => vaultContract.executeTransaction(vaultTxHash),
          'vault execute enableModule P11i',
        );
        expect(await vaultContract.isModuleEnabled(budgetAddr)).toBe(true);
        enableBlock = execReceipt.blockNumber;
      } else {
        enableBlock = await provider.getBlockNumber(Shard.Cyprus1);
      }
      console.log(`   BudgetNavigator enabled as vault module (block ${enableBlock})`);

      // ── INDEXER VERIFICATION: trust flip + feed + backfill ──
      console.log('\n  Verifying indexer (trust + feed + backfill)...');
      await waitForIndexer(supabase, enableBlock, 'Phase 11i enable');

      // 1. Trust derived from the feed → sanctioned + active.
      const navRow = await waitForRow<any>(
        () => supabase.from('ds_navigators').select('*').eq('id', `${daoId}-${budgetAddr}`)
          .eq('trust_status', 'sanctioned').single(),
        'budget nav sanctioned P11i',
      );
      expect(navRow!.trust_status).toBe('sanctioned');
      expect(navRow!.is_active).toBe(true);
      expect(navRow!.permission_ever_granted).toBe(false); // enabling grants no DAOShip permission
      console.log('   trust_status derived → sanctioned, is_active → true');

      // 2. Authenticated enable event recorded in the trust feed.
      const { data: feed } = await supabase
        .from('ds_vault_module_events')
        .select('*')
        .eq('navigator_address', budgetAddr)
        .eq('enabled', true);
      expect(feed, 'enable feed row').toBeTruthy();
      expect(feed!.length).toBeGreaterThanOrEqual(1);
      expect(feed![0].dao_id).toBe(daoId);
      expect(feed![0].vault.toLowerCase()).toBe(vault.toLowerCase());
      console.log('   ds_vault_module_events enable row verified');

      // 3. Budget deferred in 11h is now backfilled.
      const budget = await waitForRow<any>(
        () => supabase.from('ds_budgets').select('*').eq('id', `${budgetAddr}-0`).single(),
        'budget backfilled P11i',
      );
      expect(budget, 'budget should be backfilled on enable').toBeTruthy();
      expect(budget!.dao_id).toBe(daoId);
      expect(budget!.manager).toBe(deployer.address.toLowerCase());
      expect(budget!.token).toBe(NATIVE_TOKEN);
      expect(BigInt(budget!.allowance_per_period)).toBe(quais.parseQuai('0.05'));
      expect(BigInt(budget!.total_ceiling)).toBe(quais.parseQuai('0.05'));
      expect(BigInt(budget!.total_spent)).toBe(0n);
      expect(budget!.cancelled).toBe(false);
      console.log('   Budget backfilled and verified (manager, native token, caps)');

      // ── Disburse (manager = deployer) → feed row + derived total_spent ──
      const disburseAmount = quais.parseQuai('0.01');
      const disburseReceipt = await sendTx(
        () => budgetNavigator.connect(deployer).disburse(0, carol.address, disburseAmount),
        'budget disburse P11i',
      );
      const disburseBlock = disburseReceipt.blockNumber;
      console.log(`   Disbursed ${quais.formatQuai(disburseAmount)} QUAI to Carol in block ${disburseBlock}`);

      await waitForIndexer(supabase, disburseBlock, 'Phase 11i disburse');

      const { data: disb } = await supabase
        .from('ds_budget_disbursements')
        .select('*')
        .eq('navigator_address', budgetAddr);
      expect(disb, 'disbursement feed row').toBeTruthy();
      expect(disb!.length).toBeGreaterThanOrEqual(1);
      const row = disb!.find((d: any) => d.recipient === carol.address.toLowerCase());
      expect(row, 'disbursement to Carol').toBeTruthy();
      expect(BigInt(row!.amount)).toBe(disburseAmount);
      expect(row!.budget_pk).toBe(`${budgetAddr}-0`);

      // total_spent is recomputed (SUM of disbursements), never incremented inline.
      const spentBudget = await waitForRow<any>(
        () => supabase.from('ds_budgets').select('*').eq('id', `${budgetAddr}-0`)
          .gt('total_spent', '0').single(),
        'budget total_spent P11i',
      );
      expect(BigInt(spentBudget!.total_spent)).toBe(disburseAmount);
      console.log('   Disbursement feed + derived total_spent verified');

      console.log('  Phase 11i PASSED\n');
    },
    perProposalMs + proposalPhaseOverhead,
  );

  // ════════════════════════════════════════════════════════════════════
  // PHASE 11j: DisableModule → unsanctioned (derived from the feed)
  // ════════════════════════════════════════════════════════════════════
  // Removing the module is the capability revocation. The indexer appends a disable row to
  // ds_vault_module_events and RE-DERIVES trust from the latest event → unsanctioned + inactive,
  // so the app drops the navigator's budgets from default (trust-gated) views. Gnosis disableModule
  // needs the linked-list predecessor, resolved via getModulesPaginated.

  it(
    'Phase 11j: DisabledModule re-derives trust → unsanctioned',
    async () => {
      console.log('\n== PHASE 11j: Disable module → unsanctioned ==\n');

      const vaultContract = new quais.Contract(vault, QuaiVaultJson.abi, deployer);

      // Resolve prevModule for budgetAddr in the module linked list (most-recent-first).
      const [modules] = await vaultContract.getModulesPaginated(SENTINEL_MODULES, 50);
      const lowered = (modules as string[]).map((m) => m.toLowerCase());
      const idx = lowered.indexOf(budgetAddr);
      expect(idx, 'budget module present in vault module list').toBeGreaterThanOrEqual(0);
      const prevModule = idx === 0 ? SENTINEL_MODULES : (modules as string[])[idx - 1];

      const disableData = vaultContract.interface.encodeFunctionData('disableModule', [prevModule, budgetAddr]);
      await withTestRetry(() => provider.getBlockNumber(Shard.Cyprus1), 'getBlockNumber P11j');
      const proposeReceipt = await sendTx(
        () => vaultContract.proposeTransaction(vault, 0, disableData),
        'vault proposeTransaction disableModule P11j',
      );
      const proposeLog = proposeReceipt.logs.find((log: any) => {
        try { return vaultContract.interface.parseLog(log)?.name === 'TransactionProposed'; }
        catch { return false; }
      });
      const vaultTxHash = vaultContract.interface.parseLog(proposeLog!)?.args.txHash;
      await sendTx(() => vaultContract.approveTransaction(vaultTxHash), 'vault approve disableModule P11j');
      const execReceipt = await sendTx(
        () => vaultContract.executeTransaction(vaultTxHash),
        'vault execute disableModule P11j',
      );
      const disableBlock = execReceipt.blockNumber;
      expect(await vaultContract.isModuleEnabled(budgetAddr)).toBe(false);
      console.log(`   BudgetNavigator disabled as vault module (block ${disableBlock})`);

      // ── INDEXER VERIFICATION ────────────────────────────────
      console.log('\n  Verifying indexer...');
      await waitForIndexer(supabase, disableBlock, 'Phase 11j');

      // Trust re-derived from the latest feed event → unsanctioned + inactive.
      const navRow = await waitForRow<any>(
        () => supabase.from('ds_navigators').select('*').eq('id', `${daoId}-${budgetAddr}`)
          .eq('trust_status', 'unsanctioned').single(),
        'budget nav unsanctioned P11j',
      );
      expect(navRow!.trust_status).toBe('unsanctioned');
      expect(navRow!.is_active).toBe(false);
      console.log('   trust_status re-derived → unsanctioned, is_active → false');

      // The disable event is recorded in the feed (alongside the prior enable row).
      const { data: feed } = await supabase
        .from('ds_vault_module_events')
        .select('*')
        .eq('navigator_address', budgetAddr)
        .eq('enabled', false);
      expect(feed, 'disable feed row').toBeTruthy();
      expect(feed!.length).toBeGreaterThanOrEqual(1);
      console.log('   ds_vault_module_events disable row verified');

      console.log('  Phase 11j PASSED\n');
    },
    simplePhaseTimeout,
  );

  // ════════════════════════════════════════════════════════════════════
  // PHASE 11k: Subscription — deploy + register (MANAGER), enroll, pay fee
  // ════════════════════════════════════════════════════════════════════
  // SubscriptionNavigator is PERMISSIONED (MANAGER, like Vesting): registered via
  // setNavigators([sub],[2]) → NavigatorSet fires → indexer marks it sanctioned. Mirrors the
  // contracts on-chain Phase 2i (register → payFee → enroll). MUST run before Phase 12 (which
  // locks manager/governor, after which setNavigators reverts).
  //
  // Covered: MemberEnrolled (governance enroll → complimentary period) and FeePaid (a member's
  // own payFee → self-enroll, payment feed, derive-from-truth total_paid). FeeCollected is NOT
  // exercised — collection requires a member past grace, and MIN_PERIOD is 1h on-chain (the same
  // wall-clock constraint that kept Phase 11f's vesting schedule to a 1s vest); the collect path
  // is covered by the contracts suite + the handler unit tests.

  it(
    'Phase 11k: Subscription deploy + register (MANAGER) + enroll + payFee',
    async () => {
      console.log('\n== PHASE 11k: Subscription register + enroll + payFee ==\n');

      // ── Deploy SubscriptionNavigator (native-QUAI menu) ──
      const SubscriptionJson = JSON.parse(
        fs.readFileSync(path.join(ARTIFACTS_DIR, 'navigators/SubscriptionNavigator.sol/SubscriptionNavigator.json'), 'utf-8'),
      );
      const subIpfs = extractIPFSHash(SubscriptionJson.bytecode);
      await withTestRetry(() => provider.getBlockNumber(Shard.Cyprus1), 'getBlockNumber P11k');
      const SubFactory = new quais.ContractFactory(SubscriptionJson.abi, SubscriptionJson.bytecode, deployer, subIpfs);
      const feePerPeriod = quais.parseQuai('0.001');
      const PERIOD_DURATION = 3600; // MIN_PERIOD (1h) — smallest the contract allows
      // constructor(daoShip, tokens[], feesPerPeriod[], periodDuration, graceDuration, startTime,
      //             collectorRewardBps, burnOnCollect, initialMembers[], name, description)
      const subInstance = await SubFactory.deploy(
        daoShipAddress, [NATIVE_TOKEN], [feePerPeriod], PERIOD_DURATION, 0, 0, 500, false, [],
        'Test Subscription', 'Subscription for E2E tests',
      );
      await subInstance.waitForDeployment();
      const subscriptionNavigator: any = subInstance;
      const subAddr = (await subInstance.getAddress()).toLowerCase();
      console.log(`   SubscriptionNavigator: ${subAddr}`);

      // ── Register via governance: setNavigators([sub],[2]) ──
      const subCs = await subInstance.getAddress();
      const setNavData = daoShip.interface.encodeFunctionData('setNavigators', [[subCs], [2]]);
      const execData = daoShip.interface.encodeFunctionData('executeAsGovernance', [daoShipAddress, 0, setNavData]);
      const registerProposal = encodeMultiSend([{ operation: 0, to: daoShipAddress, value: 0n, data: execData }]);
      const registerReceipt = await runProposal(
        daoShip, deployer, [deployer, bob], registerProposal,
        JSON.stringify({ title: 'Register Subscription navigator' }), 'P11k register',
      );
      expect(await daoShip.navigators(subCs)).toBe(2n);
      console.log(`   On-chain permission: subscription=2 (MANAGER), registered in block ${registerReceipt.blockNumber}`);

      await waitForIndexer(supabase, registerReceipt.blockNumber, 'Phase 11k register');
      const subRow = await waitForRow<any>(
        () => supabase.from('ds_navigators').select('*').eq('id', `${daoId}-${subAddr}`).single(),
        'subscription navigator P11k',
      );
      expect(subRow, 'SubscriptionNavigator row').toBeTruthy();
      expect(subRow!.navigator_type).toBe('SubscriptionNavigator');
      expect(subRow!.permission).toBe(2);
      expect(subRow!.permission_label).toBe('manager');
      expect(subRow!.trust_status).toBe('sanctioned');
      expect(subRow!.is_active).toBe(true);
      console.log('   Navigator row verified (MANAGER, sanctioned, active)');

      // ── MemberEnrolled: governance enroll(carol) grants one complimentary period ──
      const enrollData = subscriptionNavigator.interface.encodeFunctionData('enroll', [carol.address]);
      const enrollProposal = encodeMultiSend([{ operation: 0, to: subCs, value: 0n, data: enrollData }]);
      const enrollReceipt = await runProposal(
        daoShip, deployer, [deployer, bob], enrollProposal,
        JSON.stringify({ title: 'Enroll Carol in subscription' }), 'P11k enroll',
      );
      console.log(`   Carol enrolled (governance) in block ${enrollReceipt.blockNumber}`);

      await waitForIndexer(supabase, enrollReceipt.blockNumber, 'Phase 11k enroll');
      const carolPk = `${subAddr}-${carol.address.toLowerCase()}`;
      const carolMember = await waitForRow<any>(
        () => supabase.from('ds_subscription_members').select('*').eq('id', carolPk).single(),
        'subscription member carol P11k',
      );
      expect(carolMember, 'ds_subscription_members row for Carol').toBeTruthy();
      expect(carolMember!.dao_id).toBe(daoId);
      expect(carolMember!.member).toBe(carol.address.toLowerCase());
      // Complimentary period → paid_through is in the future and matches the contract clock.
      expect(Number(carolMember!.paid_through)).toBeGreaterThan(0);
      expect(BigInt(carolMember!.paid_through)).toBe(await subscriptionNavigator.paidThrough(carol.address));
      console.log('   MemberEnrolled row verified (complimentary period set)');

      // ── FeePaid: Bob's own payFee self-enrolls him (no MemberEnrolled) ──
      const payReceipt = await sendTx(
        () => subscriptionNavigator.connect(bob).payFee(1, NATIVE_TOKEN, { value: feePerPeriod }),
        'subscription payFee P11k',
      );
      console.log(`   Bob paid 1 period (${quais.formatQuai(feePerPeriod)} QUAI) in block ${payReceipt.blockNumber}`);

      await waitForIndexer(supabase, payReceipt.blockNumber, 'Phase 11k payFee');
      const bobPk = `${subAddr}-${bob.address.toLowerCase()}`;
      // total_paid is recomputed (SUM of ds_subscription_payments) at end-of-range, never inline.
      const bobMember = await waitForRow<any>(
        () => supabase.from('ds_subscription_members').select('*').eq('id', bobPk).gt('total_paid', '0').single(),
        'subscription member bob P11k',
      );
      expect(bobMember, 'ds_subscription_members row for Bob (self-enrolled)').toBeTruthy();
      expect(Number(bobMember!.paid_through)).toBeGreaterThan(0);
      expect(BigInt(bobMember!.total_paid)).toBe(feePerPeriod);

      const { data: payments } = await supabase
        .from('ds_subscription_payments')
        .select('*')
        .eq('member_pk', bobPk);
      expect(payments, 'payment feed rows for Bob').toBeTruthy();
      expect(payments!.length).toBeGreaterThanOrEqual(1);
      const payRow = payments![0];
      expect(payRow.payer).toBe(bob.address.toLowerCase());
      expect(payRow.token).toBe(NATIVE_TOKEN);
      expect(BigInt(payRow.amount)).toBe(feePerPeriod);
      const paySum = payments!.reduce((acc: bigint, p: any) => acc + BigInt(p.amount), 0n);
      expect(paySum).toBe(BigInt(bobMember!.total_paid));
      console.log('   FeePaid row + derived total_paid verified (self-enroll, payment feed)');

      console.log('  Phase 11k PASSED\n');
    },
    2 * (perProposalMs + proposalPhaseOverhead),
  );

  // ════════════════════════════════════════════════════════════════════
  // PHASE 12: Governance Management (Batched)
  // ════════════════════════════════════════════════════════════════════

  it(
    'Phase 12: Governance management proposal (batched events)',
    async () => {
      console.log('\n== PHASE 12: Governance Management (Batched) ==\n');

      const daoShipAddr = await daoShip.getAddress();

      // 1. SetGuildTokens
      const setGuildTokensData = daoShip.interface.encodeFunctionData(
        'setGuildTokens',
        [[quais.ZeroAddress], [true]],
      );
      const execGuildTokens = daoShip.interface.encodeFunctionData(
        'executeAsGovernance',
        [daoShipAddr, 0, setGuildTokensData],
      );

      // 2. GovernanceConfigSet
      const newGovConfig = quais.AbiCoder.defaultAbiCoder().encode(
        ['uint32', 'uint32', 'uint256', 'uint256', 'uint256', 'uint256', 'uint32'],
        [
          60, // voting period (must be >= MIN_VOTING_PERIOD of 60 seconds)
          30,
          quais.parseQuai('0.001'),
          1500, // 15% quorum (changed from 20%)
          quais.parseQuai('1'),
          6600,
          0, // defaultExpiryWindow (0 = no default expiry)
        ],
      );
      const setGovData = daoShip.interface.encodeFunctionData(
        'setGovernanceConfig',
        [newGovConfig],
      );
      const execGov = daoShip.interface.encodeFunctionData('executeAsGovernance', [
        daoShipAddr,
        0,
        setGovData,
      ]);

      // 3-5. Locks
      const lockAdmin = daoShip.interface.encodeFunctionData('executeAsGovernance', [
        daoShipAddr,
        0,
        daoShip.interface.encodeFunctionData('lockAdmin', []),
      ]);
      const lockManager = daoShip.interface.encodeFunctionData('executeAsGovernance', [
        daoShipAddr,
        0,
        daoShip.interface.encodeFunctionData('lockManager', []),
      ]);
      const lockGovernor = daoShip.interface.encodeFunctionData('executeAsGovernance', [
        daoShipAddr,
        0,
        daoShip.interface.encodeFunctionData('lockGovernor', []),
      ]);

      const proposalData = encodeMultiSend([
        { operation: 0, to: daoShipAddr, value: 0n, data: execGuildTokens },
        { operation: 0, to: daoShipAddr, value: 0n, data: execGov },
        { operation: 0, to: daoShipAddr, value: 0n, data: lockAdmin },
        { operation: 0, to: daoShipAddr, value: 0n, data: lockManager },
        { operation: 0, to: daoShipAddr, value: 0n, data: lockGovernor },
      ]);

      const details = JSON.stringify({
        title: 'Governance Management',
        description:
          'Set guild tokens, update quorum, lock admin/manager/governor',
      });

      console.log('  Batched changes:');
      console.log('    1. Enable native QUAI as guild token');
      console.log('    2. Update quorum to 15%');
      console.log('    3. Lock admin/manager/governor');

      await withTestRetry(() => provider.getBlockNumber(Shard.Cyprus1), 'getBlockNumber pre-submit P12');
      const submitReceipt = await sendTx(
        () => daoShip.connect(deployer).submitProposal(proposalData, 0, details),
        'submitProposal P12',
      );

      const proposalEvent = submitReceipt.logs.find((log: any) => {
        try {
          return daoShip.interface.parseLog(log)?.name === 'SubmitProposal';
        } catch {
          return false;
        }
      });
      const proposalId = daoShip.interface.parseLog(proposalEvent!)?.args[0];
      console.log(`\n   Proposal ID: ${proposalId}`);

      await waitPastVotingStarts(daoShip, proposalId, 'voting window P12');

      // ── DIAGNOSTIC PROBE ────────────────────────────────────
      // Phase 12 has been observed reverting on `submitVote` with custom
      // error 0x44e7e7a8 while sibling phases (P10/P11/P13) pass the same
      // flow. Capture pre-vote state so the next failure surfaces a
      // concrete root cause (not-sponsored / voting-not-started / voting-
      // ended / insufficient shares) instead of a bare selector.
      try {
        const prop = await daoShip.proposals(proposalId);
        const tipBlock = await provider.getBlock(Shard.Cyprus1, 'latest', false);
        const chainNow = Number((tipBlock as any)?.woHeader?.timestamp ?? 0);
        const deployerShares = await shares.balanceOf(deployer.address);
        const bobShares = await shares.balanceOf(bob.address);
        const sponsorThreshold = await daoShip.sponsorThreshold();
        console.log('   P12 pre-vote diagnostics:');
        console.log(`     proposal.sponsor:       ${prop.sponsor}`);
        console.log(`     proposal.submitter:     ${prop.submitter}`);
        console.log(`     proposal.votingStarts:  ${prop.votingStarts} (${prop.votingStarts > 0n ? new Date(Number(prop.votingStarts) * 1000).toISOString() : 'unset'})`);
        console.log(`     proposal.votingEnds:    ${prop.votingEnds} (${prop.votingEnds > 0n ? new Date(Number(prop.votingEnds) * 1000).toISOString() : 'unset'})`);
        console.log(`     chain now:              ${chainNow} (${chainNow > 0 ? new Date(chainNow * 1000).toISOString() : 'unset'})`);
        console.log(`     deployer shares:        ${deployerShares}`);
        console.log(`     bob shares:             ${bobShares}`);
        console.log(`     sponsorThreshold:       ${sponsorThreshold}`);
        const sponsored = prop.sponsor !== quais.ZeroAddress;
        const inVotingWindow = chainNow >= Number(prop.votingStarts) && chainNow < Number(prop.votingEnds);
        console.log(`     derived: sponsored=${sponsored}, inVotingWindow=${inVotingWindow}`);
        if (!sponsored) {
          console.log('     ⚠  Proposal NOT sponsored — submitVote will revert.');
          console.log('        Likely cause: auto-sponsor requires deployer shares ≥ sponsorThreshold at submit time,');
          console.log('        OR the proposal needs an explicit sponsorProposal() call before voting.');
        } else if (!inVotingWindow) {
          console.log('     ⚠  Not in voting window — submitVote will revert.');
          console.log(`        Fix: increase pre-vote sleep (currently 20s) if votingStarts > chainNow,`);
          console.log(`        or reduce it if chainNow >= votingEnds.`);
        }
      } catch (diagErr) {
        console.log(`   P12 diagnostic probe failed: ${(diagErr as Error).message}`);
      }

      // Alice delegated her voting power to Bob in Phase 5b, so Bob votes instead.
      await castVotes(daoShip, proposalId, [
        { signer: deployer, label: 'submitVote deployer P12' },
        { signer: bob, label: 'submitVote bob P12' },
      ]);

      await waitForProposalState(daoShip, proposalId, [5], 'ready P12', readyWaitMs);
      const processReceipt = await sendProcessProposal(
        daoShip, deployer, proposalId, proposalData, 'processProposal P12',
      );
      const processBlock = processReceipt.blockNumber;
      console.log(`   Processed in block ${processBlock}`);

      // Verify on-chain
      expect(await daoShip.guildTokens(quais.ZeroAddress)).toBe(true);
      expect(await daoShip.quorumPercent()).toBe(1500n);
      expect(await daoShip.adminLock()).toBe(true);
      expect(await daoShip.managerLock()).toBe(true);
      expect(await daoShip.governorLock()).toBe(true);

      // ── INDEXER VERIFICATION ────────────────────────────────

      console.log('\n  Verifying indexer...');
      await waitForIndexer(supabase, processBlock, 'Phase 12');

      const dao = await waitForRow<any>(
        () => supabase
          .from('ds_daos')
          .select('admin_locked, manager_locked, governor_locked, quorum_percent')
          .eq('id', daoId)
          .single(),
        'dao P12',
      );

      expect(dao).toBeTruthy();
      expect(dao!.admin_locked).toBe(true);
      expect(dao!.manager_locked).toBe(true);
      expect(dao!.governor_locked).toBe(true);
      expect(Number(dao!.quorum_percent)).toBe(1500);
      console.log('   DAO governance locks verified');

      // Check guild token
      const guildTokenId = `${daoId}-${quais.ZeroAddress.toLowerCase()}`;
      const guildToken = await waitForRow<any>(
        () => supabase.from('ds_guild_tokens').select('*').eq('id', guildTokenId).single(),
        'guildToken P12',
      );

      expect(guildToken).toBeTruthy();
      expect(guildToken!.enabled).toBe(true);
      console.log('   Guild token (native QUAI) verified');

      console.log('  Phase 12 PASSED\n');
    },
    perProposalMs + proposalPhaseOverhead,
  );

  // ════════════════════════════════════════════════════════════════════
  // PHASE 13: Ragequit
  // ════════════════════════════════════════════════════════════════════

  it(
    'Phase 13: Alice ragequits',
    async () => {
      console.log('\n== PHASE 13: Ragequit ==\n');

      const aliceSharesBefore = await shares.balanceOf(alice.address);
      const sharesToBurn = quais.parseQuai('30');

      console.log(
        `  Alice shares: ${quais.formatQuai(aliceSharesBefore)}, burning ${quais.formatQuai(sharesToBurn)}`,
      );

      await withTestRetry(() => provider.getBlockNumber(Shard.Cyprus1), 'getBlockNumber P13');
      const ragequitReceipt = await sendTx(
        () => daoShip.connect(alice).ragequit(
          alice.address,
          sharesToBurn,
          0, // no loot
          [], // no token claims — avoids dependency on Phase 12 guild token setup
        ),
        'ragequit P13',
      );
      const ragequitBlock = ragequitReceipt.blockNumber;
      console.log(`   Ragequit in block ${ragequitBlock}`);

      const aliceSharesAfter = await shares.balanceOf(alice.address);
      expect(aliceSharesAfter).toBe(aliceSharesBefore - sharesToBurn);
      console.log(`   Alice shares after: ${quais.formatQuai(aliceSharesAfter)}`);

      // ── INDEXER VERIFICATION ────────────────────────────────

      console.log('\n  Verifying indexer...');
      await waitForIndexer(supabase, ragequitBlock, 'Phase 13');

      // Check ragequit record
      const { data: ragequits } = await supabase
        .from('ds_ragequits')
        .select('*')
        .eq('dao_id', daoId)
        .eq('member_address', alice.address.toLowerCase());

      expect(ragequits).toBeTruthy();
      expect(ragequits!.length).toBeGreaterThanOrEqual(1);

      const rq = ragequits![ragequits!.length - 1];
      expect(BigInt(rq.shares_burned)).toBe(sharesToBurn);
      console.log('   Ragequit record verified');

      // Check Alice shares in members table
      const aliceMemberId = `${daoId}-${alice.address.toLowerCase()}`;
      const aliceMember = await waitForRow<any>(
        () => supabase.from('ds_members').select('shares').eq('id', aliceMemberId).single(),
        'aliceMember P13',
      );

      expect(aliceMember).toBeTruthy();
      expect(BigInt(aliceMember!.shares)).toBe(aliceSharesAfter);
      console.log(
        `   Alice shares in DB: ${aliceMember!.shares} (matches on-chain)`,
      );

      console.log('  Phase 13 PASSED\n');
    },
    simplePhaseTimeout,
  );

  // ════════════════════════════════════════════════════════════════════
  // SUMMARY
  // ════════════════════════════════════════════════════════════════════

  it('Summary: All events triggered and indexed', async () => {
    console.log('============================================================');
    console.log('  DAO SHIPS INDEXER E2E TEST COMPLETE');
    console.log('============================================================\n');

    console.log('  Events Triggered (24/24 DAOShip core events):\n');
    console.log('  Core Governance (5/5):');
    console.log('    SubmitProposal (Phases 4, 6, 10, 11, 12)');
    console.log('    SponsorProposal (Phases 4, 6, 10, 12)');
    console.log('    SubmitVote (Phases 4, 6, 10, 12)');
    console.log('    ProcessProposal (Phases 4, 6, 10, 12)');
    console.log('    CancelProposal (Phase 11)');
    console.log('\n  Governance Management (6/6):');
    console.log('    SetGuildTokens (Phase 12)');
    console.log('    NavigatorSet - ADD (Phase 6), REMOVE (Phase 10)');
    console.log('    GovernanceConfigSet (Phase 12)');
    console.log('    LockAdmin (Phase 12)');
    console.log('    LockManager (Phase 12)');
    console.log('    LockGovernor (Phase 12)');
    console.log('\n  Token Operations (5/5):');
    console.log('    MintShares (Phases 2, 3)');
    console.log('    MintLoot (Phase 7)');
    console.log('    BurnShares (Phase 8)');
    console.log('    BurnLoot (Phase 8)');
    console.log('    ConvertSharesToLoot (Phase 5)');
    console.log('\n  Delegation (2/2):');
    console.log('    DelegateChanged (Phase 5b)');
    console.log('    DelegateVotesChanged (Phase 5b)');
    console.log('\n  Exit Mechanism (1/1):');
    console.log('    Ragequit (Phase 13)');
    console.log('\n  Navigator Events:');
    console.log('    Onboard (Phases 2, 3)');
    console.log('    Timelock ChangeQueued/ChangeCancelled (Phase 11c), ChangeExecuted (Phase 11e, opt-in)');
    console.log('    Vesting ScheduleCreated/TokensClaimed/ScheduleRevoked (Phase 11f)');
    console.log('    GovernanceConfigSet timelock-bypass flag (Phase 11d)');
    console.log('\n  Setup (1/1):');
    console.log('    SetupComplete (Phase 1)');
    console.log('\n  Admin Operations (1/1):');
    console.log('    SetAdminConfig - Pause/Unpause (Phase 9)');
    console.log('\n  Poster (1/1):');
    console.log('    NewPost (Phase 5c)');

    console.log('\n  Supabase Tables Verified:');
    console.log('    ds_daos                    - DAO records + governance params + locks');
    console.log('    ds_members                 - Member balances + shares/loot + delegation');
    console.log('    ds_proposals               - Proposal lifecycle + votes');
    console.log('    ds_votes                   - Individual vote records');
    console.log('    ds_navigators              - Navigator permission changes (incl. Timelock/Vesting)');
    console.log('    ds_ragequits               - Ragequit records');
    console.log('    ds_guild_tokens            - Guild token registration');
    console.log('    ds_navigator_events        - Onboard events');
    console.log('    ds_delegations             - Delegation records');
    console.log('    ds_records                 - Poster records');
    console.log('    ds_timelock_changes        - Timelock queue/execute/cancel lifecycle (Phase 11c/e)');
    console.log('    ds_vesting_schedules       - Vesting schedules + claimed (Phase 11f)');
    console.log('    ds_vesting_claims          - Vesting claim feed (Phase 11f)');
    console.log('    ds_governance_config_history - Config-change audit + timelock-bypass flag (Phase 11d)');

    // ── Real outcome (no more unconditional "all verified") ──────────────
    // failedPhases/passedPhases are populated by the onTestFinished hook in
    // beforeEach. This Summary asserts the suite actually succeeded instead of
    // printing a success banner regardless of what happened.
    const total = passedPhases.length + failedPhases.length;
    console.log(`\n  Phase results: ${passedPhases.length}/${total} passed`);
    if (failedPhases.length > 0) {
      console.log(`\n  ❌ ${failedPhases.length} phase(s) FAILED:`);
      for (const name of failedPhases) console.log(`     - ${name}`);
      console.log('\n  Not all events were verified — see failures above.\n');
    } else {
      console.log('\n  ✅ All triggered events were indexed and verified.\n');
    }

    expect(
      failedPhases,
      `Indexer E2E had ${failedPhases.length} failing phase(s): ${failedPhases.join(', ')}`,
    ).toEqual([]);
  });
});
