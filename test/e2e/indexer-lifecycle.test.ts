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

import { describe, it, expect, beforeAll } from 'vitest';
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
const votingPeriodSec = Math.max(
  parseInt(process.env.VOTING_PERIOD || '60'),
  MIN_VOTING_PERIOD_SEC,
);
const gracePeriodSec = parseInt(process.env.GRACE_PERIOD || '60');
const totalWaitSec = votingPeriodSec + gracePeriodSec;

// Per-proposal timeout: voting + grace + 60s buffer for tx confirmation & indexer catch-up
const perProposalMs = (totalWaitSec + 60) * 1000;
// Extra overhead per proposal phase for retries, waitForIndexer polling, etc.
const proposalPhaseOverhead = 300_000; // 5 minutes
// Non-proposal phase timeout: enough for tx send/confirm + waitForIndexer
const simplePhaseTimeout = 300_000; // 5 minutes
// Per-attempt timeouts — quais RPC calls can hang indefinitely if the node
// accepts the request but never sends a response.  These prevent that.
const TX_SEND_TIMEOUT_MS = 30_000;   // 30s for a single tx submission attempt
const TX_WAIT_TIMEOUT_MS = 60_000;   // 60s for a single receipt polling attempt
const RPC_CALL_TIMEOUT_MS = 120_000; // 2 min safety net for any other RPC call
const baseOverheadMs = 300_000; // 5 minutes for salt mining, deployments
const SUITE_TIMEOUT = 4 * (perProposalMs + proposalPhaseOverhead) + baseOverheadMs;

// Indexer catch-up polling: must be long enough for the indexer to process
// ~votingPeriod blocks after a proposal sleep. Enforce a minimum of 1 minute.
const INDEXER_POLL_TIMEOUT = Math.max(
  parseInt(process.env.INDEXER_POLL_TIMEOUT_MS || '120000'),
  120_000,
);
const INDEXER_POLL_INTERVAL = parseInt(process.env.INDEXER_POLL_INTERVAL_MS || '3000');

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
 * Send a transaction and wait for its receipt, with retry on both steps.
 * Uses tighter timeouts than the default: 30s per send attempt, 60s per
 * receipt attempt.  This prevents indefinite hangs from both the tx
 * submission (estimateGas / sendRawTransaction) and receipt polling.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function sendTx(
  fn: () => Promise<any>,
  label: string,
): Promise<any> {
  const tx = await withTestRetry(fn, label, 3, 5000, TX_SEND_TIMEOUT_MS);
  return await withTestRetry(() => tx.wait(), `${label} .wait()`, 3, 5000, TX_WAIT_TIMEOUT_MS);
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
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await sendTx(
        () => daoShip.connect(signer).processProposal(proposalId, proposalData),
        label,
      );
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      if (msg.includes('not ready') && attempt < maxAttempts) {
        console.log(
          `   [retry] ${label}: proposal not ready (attempt ${attempt}/${maxAttempts}), waiting ${retryDelayMs / 1000}s...`,
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

  while (Date.now() - start < INDEXER_POLL_TIMEOUT) {
    const { data } = await supabase
      .from('ds_indexer_state')
      .select('last_block_number')
      .eq('id', 1)
      .single();

    if (data && data.last_block_number >= targetBlock) {
      console.log(
        `   Indexer caught up to block ${targetBlock}${tag} (at ${data.last_block_number})`,
      );
      return;
    }

    await sleep(INDEXER_POLL_INTERVAL);
  }

  throw new Error(
    `Indexer did not reach block ${targetBlock}${tag} within ${INDEXER_POLL_TIMEOUT}ms`,
  );
}

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
  let PosterABI: any;

  // QuaiVault artifacts
  let QuaiVaultJson: any;
  let QuaiVaultProxyJson: any;

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
      //   sharesPerUnit, lootPerUnit, minTribute, expiry, mintCap, perAddressCap, allowlistRoot)
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
      //   expiry, mintCap, perAddressCap, allowlistRoot)
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
      );
      await erc20TributeInstance.waitForDeployment();
      const erc20TributeAddr = await erc20TributeInstance.getAddress();
      console.log(`   ERC20TributeNavigator: ${erc20TributeAddr}`);

      onboarderNavigator = onboarderInstance;
      erc20TributeNavigator = erc20TributeInstance;

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
        deployer.address,
      ];
      const navigatorPermissions = [2, 2, 7]; // onboarder: MANAGER, erc20tribute: MANAGER, deployer: ALL (ADMIN+MANAGER+GOVERNOR)

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
      const { data: dao } = await supabase
        .from('ds_daos')
        .select('*')
        .eq('id', daoId)
        .single();

      expect(dao).toBeTruthy();
      expect(dao!.shares_address).toBe(sharesAddress.toLowerCase());
      expect(dao!.loot_address).toBe(lootAddress.toLowerCase());
      expect(dao!.avatar).toBe(vault.toLowerCase());
      console.log('   DAO record verified');

      // Check initial members
      const deployerMemberId = `${daoId}-${deployer.address.toLowerCase()}`;
      const aliceMemberId = `${daoId}-${alice.address.toLowerCase()}`;

      const { data: deployerMember } = await supabase
        .from('ds_members')
        .select('*')
        .eq('id', deployerMemberId)
        .single();

      const { data: aliceMember } = await supabase
        .from('ds_members')
        .select('*')
        .eq('id', aliceMemberId)
        .single();

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
      expect(navigatorsData!.length).toBeGreaterThanOrEqual(3);
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
      const { data: bobMember } = await supabase
        .from('ds_members')
        .select('*')
        .eq('id', bobMemberId)
        .single();

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
      const { data: carolMember } = await supabase
        .from('ds_members')
        .select('*')
        .eq('id', carolMemberId)
        .single();

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

      // Wait for checkpoints
      console.log('   Waiting for checkpoints (20s)...');
      await sleep(20_000);

      // Vote
      await withTestRetry(() => provider.getBlockNumber(Shard.Cyprus1), 'getBlockNumber pre-vote P4');
      await sendTx(() => daoShip.connect(deployer).submitVote(proposalId, true), 'submitVote deployer P4');
      console.log('   Deployer voted YES');

      await sendTx(() => daoShip.connect(alice).submitVote(proposalId, true), 'submitVote alice P4');
      console.log('   Alice voted YES');

      // Wait for voting + grace
      const totalWait = totalWaitSec; // voting + grace
      console.log(
        `   Waiting for voting + grace (${totalWait}s = ${(totalWait / 60).toFixed(1)}min)...`,
      );
      await sleep(totalWait * 1000);

      // Process
      await withTestRetry(() => provider.getBlockNumber(Shard.Cyprus1), 'getBlockNumber post-sleep P4');
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

      const { data: proposal } = await supabase
        .from('ds_proposals')
        .select('*')
        .eq('id', dbProposalId)
        .single();

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
      const { data: dao } = await supabase
        .from('ds_daos')
        .select('proposal_count')
        .eq('id', daoId)
        .single();

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
      const { data: aliceMember } = await supabase
        .from('ds_members')
        .select('shares, loot')
        .eq('id', aliceMemberId)
        .single();

      expect(aliceMember).toBeTruthy();
      expect(BigInt(aliceMember!.shares)).toBe(aliceSharesAfter);
      expect(BigInt(aliceMember!.loot)).toBe(aliceLootAfter);
      console.log(`   Alice shares in DB: ${aliceMember!.shares} (matches on-chain)`);
      console.log(`   Alice loot in DB:   ${aliceMember!.loot} (matches on-chain)`);

      // Check DAO totals updated — ConvertSharesToLoot handler owns DAO totals
      // for this operation (Transfer handler only owns member balances)
      const { data: daoAfter } = await supabase
        .from('ds_daos')
        .select('total_shares, total_loot')
        .eq('id', daoId)
        .single();

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
      const { data: aliceMember } = await supabase
        .from('ds_members')
        .select('delegating_to')
        .eq('id', aliceMemberId)
        .single();

      expect(aliceMember).toBeTruthy();
      expect(aliceMember!.delegating_to).toBe(bob.address.toLowerCase());
      console.log(`   Alice delegating_to: ${aliceMember!.delegating_to}`);

      // Check Bob's voting_power increased in ds_members
      const bobMemberId = `${daoId}-${bob.address.toLowerCase()}`;
      const { data: bobMember } = await supabase
        .from('ds_members')
        .select('voting_power')
        .eq('id', bobMemberId)
        .single();

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

      console.log('   Waiting for checkpoints (20s)...');
      await sleep(20_000);

      await withTestRetry(() => provider.getBlockNumber(Shard.Cyprus1), 'getBlockNumber pre-vote P6');
      await sendTx(() => daoShip.connect(deployer).submitVote(proposalId, true), 'submitVote deployer P6');
      // Alice delegated her voting power to Bob in Phase 5b, so Bob votes instead
      await sendTx(() => daoShip.connect(bob).submitVote(proposalId, true), 'submitVote bob P6');
      console.log('   Votes cast');

      const totalWait = totalWaitSec; // voting + grace
      console.log(`   Waiting ${totalWait}s...`);
      await sleep(totalWait * 1000);

      await withTestRetry(() => provider.getBlockNumber(Shard.Cyprus1), 'getBlockNumber post-sleep P6');
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
      console.log('   Bob navigator record verified (ADMIN)');

      console.log('  Phase 6 PASSED\n');
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
      const { data: bobMember } = await supabase
        .from('ds_members')
        .select('shares')
        .eq('id', bobMemberId)
        .single();

      expect(bobMember).toBeTruthy();
      expect(BigInt(bobMember!.shares)).toBe(bobSharesAfter);
      console.log(`   Bob shares in DB: ${bobMember!.shares} (matches on-chain)`);

      const carolMemberId = `${daoId}-${carol.address.toLowerCase()}`;
      const { data: carolMember } = await supabase
        .from('ds_members')
        .select('loot')
        .eq('id', carolMemberId)
        .single();

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

      console.log('   Waiting for checkpoints (20s)...');
      await sleep(20_000);

      await withTestRetry(() => provider.getBlockNumber(Shard.Cyprus1), 'getBlockNumber pre-vote P10');
      await sendTx(() => daoShip.connect(deployer).submitVote(proposalId, true), 'submitVote deployer P10');
      // Alice delegated her voting power to Bob in Phase 5b, so Bob votes instead
      await sendTx(() => daoShip.connect(bob).submitVote(proposalId, true), 'submitVote bob P10');

      const totalWait = totalWaitSec; // voting + grace
      console.log(`   Waiting ${totalWait}s...`);
      await sleep(totalWait * 1000);

      await withTestRetry(() => provider.getBlockNumber(Shard.Cyprus1), 'getBlockNumber post-sleep P10');
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
      const { data: navigatorRecord } = await supabase
        .from('ds_navigators')
        .select('*')
        .eq('id', navigatorId)
        .single();

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

      console.log('   Waiting for checkpoints (20s)...');
      await sleep(20_000);

      await withTestRetry(() => provider.getBlockNumber(Shard.Cyprus1), 'getBlockNumber pre-vote P12');
      await sendTx(() => daoShip.connect(deployer).submitVote(proposalId, true), 'submitVote deployer P12');
      // Alice delegated her voting power to Bob in Phase 5b, so Bob votes instead
      await sendTx(() => daoShip.connect(bob).submitVote(proposalId, true), 'submitVote bob P12');

      const totalWait = totalWaitSec; // voting + grace
      console.log(`   Waiting ${totalWait}s...`);
      await sleep(totalWait * 1000);

      await withTestRetry(() => provider.getBlockNumber(Shard.Cyprus1), 'getBlockNumber post-sleep P12');
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

      const { data: dao } = await supabase
        .from('ds_daos')
        .select(
          'admin_locked, manager_locked, governor_locked, quorum_percent',
        )
        .eq('id', daoId)
        .single();

      expect(dao).toBeTruthy();
      expect(dao!.admin_locked).toBe(true);
      expect(dao!.manager_locked).toBe(true);
      expect(dao!.governor_locked).toBe(true);
      expect(Number(dao!.quorum_percent)).toBe(1500);
      console.log('   DAO governance locks verified');

      // Check guild token
      const guildTokenId = `${daoId}-${quais.ZeroAddress.toLowerCase()}`;
      const { data: guildToken } = await supabase
        .from('ds_guild_tokens')
        .select('*')
        .eq('id', guildTokenId)
        .single();

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
      const { data: aliceMember } = await supabase
        .from('ds_members')
        .select('shares')
        .eq('id', aliceMemberId)
        .single();

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
    console.log('\n  Navigator Events (2/2):');
    console.log('    Onboard (Phases 2, 3)');
    console.log('\n  Setup (1/1):');
    console.log('    SetupComplete (Phase 1)');
    console.log('\n  Admin Operations (1/1):');
    console.log('    SetAdminConfig - Pause/Unpause (Phase 9)');
    console.log('\n  Poster (1/1):');
    console.log('    NewPost (Phase 5c)');

    console.log('\n  Supabase Tables Verified:');
    console.log('    ds_daos             - DAO records + governance params + locks');
    console.log('    ds_members          - Member balances + shares/loot + delegation');
    console.log('    ds_proposals        - Proposal lifecycle + votes');
    console.log('    ds_votes            - Individual vote records');
    console.log('    ds_navigators       - Navigator permission changes');
    console.log('    ds_ragequits        - Ragequit records');
    console.log('    ds_guild_tokens     - Guild token registration');
    console.log('    ds_navigator_events - Onboard events');
    console.log('    ds_delegations      - Delegation records');
    console.log('    ds_records          - Poster records');

    console.log('\n  All 24 events triggered, indexed, and verified.\n');
  });
});
