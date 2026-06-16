import { config } from './config.js';
import { logger } from './utils/logger.js';
import { withRetry, RetryTracker } from './utils/retry.js';
import { BlockchainService } from './services/blockchain.js';
import { DatabaseService } from './services/database.js';
import { BlockProcessor } from './services/processor.js';
import { ContractRegistry } from './registry/contract-registry.js';
import { HandlerDispatcher } from './handlers/index.js';
import { HealthService } from './services/health.js';

// ── Handler imports ─────────────────────────────────────────────

import {
  daoShipAndVaultLauncherIface,
  daoShipLauncherIface,
  handleLaunchDAOShipAndVault,
  handleLaunchDAOShip,
} from './handlers/launcher.js';

import {
  daoShipIface,
  handleSetupComplete,
  handleSubmitProposal,
  handleSponsorProposal,
  handleSubmitVote,
  handleProcessProposal,
  handleCancelProposal,
  handleRagequit,
  handleNavigatorSet,
  handleGovernanceConfigSet,
  handleSetGuildTokens,
  handleMintShares,
  handleMintLoot,
  handleBurnShares,
  handleBurnLoot,
  handleLockAdmin,
  handleLockManager,
  handleLockGovernor,
  handleConvertSharesToLoot,
  handleAdminConfigSet,
  handleNavigatorDeployed,
  iNavIface,
} from './handlers/daoship.js';

import {
  sharesIface,
  handleTransfer,
  handleDelegateChanged,
  handleDelegateVotesChanged,
  handlePaused,
  handleUnpaused,
} from './handlers/tokens.js';

import { posterIface, handleNewPost } from './handlers/poster.js';

import {
  signalNavigatorIface,
  handlePollCreated,
  handleVoted,
  handlePollCancelled,
} from './handlers/signal.js';

import {
  onboarderNavigatorIface,
  nftGatedNavigatorIface,
  handleOnboard,
  handleNFTClaimed,
  clearNavigatorDaoCache,
} from './handlers/navigators.js';

import {
  timelockNavigatorIface,
  handleChangeQueued,
  handleChangeExecuted,
  handleChangeCancelled,
} from './handlers/timelock.js';

import {
  vestingNavigatorIface,
  handleScheduleCreated,
  handleTokensClaimed,
  handleScheduleRevoked,
} from './handlers/vesting.js';

import {
  budgetNavigatorIface,
  handleBudgetCreated,
  handleDisbursed,
  handleManagerUpdated,
  handleBudgetCancelled,
} from './handlers/budget.js';

import {
  avatarModulesIface,
  handleEnabledModule,
  handleDisabledModule,
} from './handlers/vault-modules.js';

import {
  subscriptionNavigatorIface,
  handleMemberEnrolled,
  handleFeePaid,
  handleFeeCollected,
} from './handlers/subscription.js';

// ── Circuit Breaker ─────────────────────────────────────────────

const CIRCUIT_BREAKER = {
  failureThreshold: 10,
  cooldownMs: 30000,
};

// ── Force shutdown timeout ──────────────────────────────────────

const FORCE_SHUTDOWN_MS = 15000;

// ── Bootstrap ───────────────────────────────────────────────────

/**
 * Register all event handlers on a dispatcher (shared by index.ts and backfill.ts).
 *
 * ── Fetch-mode strategy ─────────────────────────────────────────
 * The 4th arg to `registerHandler` flips topic0 fetching to unfiltered
 * (chain-wide scan, no address filter). Default is `true` ("unfiltered")
 * for every topic except three collision-prone OpenZeppelin-standard
 * signatures that are emitted by every contract on chain:
 *
 *   - Transfer(address,address,uint256)  — every ERC-20/ERC-721
 *   - Paused(address)                    — every OZ Pausable
 *   - Unpaused(address)                  — every OZ Pausable
 *
 * Those three stay SCOPED (`unfiltered: false`) to avoid pulling
 * chain-wide volume we'd just filter out in-process. Re-evaluate via
 * `npm run measure:log-volume` once Quai's ERC-20 ecosystem fills in.
 *
 * At 10k DAOs the scoped path costs ~400 getLogs/range; the unfiltered
 * path for the 27 flipped topics costs a flat ~27 getLogs/range — the
 * primary scalability win per docs/PERF_BATCH_DB_ROUNDTRIPS.md.
 */
export function registerAllHandlers(dispatcher: HandlerDispatcher): void {
  // Launcher events — only emitted by 2 known launcher contracts; flip
  // for consistency (saves them from the address-filter list).
  dispatcher.registerHandler(daoShipAndVaultLauncherIface, 'LaunchDAOShipAndVault', handleLaunchDAOShipAndVault, true);
  dispatcher.registerHandler(daoShipLauncherIface, 'LaunchDAOShip', handleLaunchDAOShip, true);

  // DAOShip governance events (19 total) — only DAOShip contracts we've
  // registered can emit these. Flipping to unfiltered drops ~1 DAOShip
  // address per DAO from the scoped filter list.
  dispatcher.registerHandler(daoShipIface, 'SetupComplete', handleSetupComplete, true);
  dispatcher.registerHandler(daoShipIface, 'SubmitProposal', handleSubmitProposal, true);
  dispatcher.registerHandler(daoShipIface, 'SponsorProposal', handleSponsorProposal, true);
  dispatcher.registerHandler(daoShipIface, 'SubmitVote', handleSubmitVote, true);
  dispatcher.registerHandler(daoShipIface, 'ProcessProposal', handleProcessProposal, true);
  dispatcher.registerHandler(daoShipIface, 'CancelProposal', handleCancelProposal, true);
  dispatcher.registerHandler(daoShipIface, 'Ragequit', handleRagequit, true);
  dispatcher.registerHandler(daoShipIface, 'NavigatorSet', handleNavigatorSet, true);
  dispatcher.registerHandler(daoShipIface, 'GovernanceConfigSet', handleGovernanceConfigSet, true);
  dispatcher.registerHandler(daoShipIface, 'SetGuildTokens', handleSetGuildTokens, true);
  dispatcher.registerHandler(daoShipIface, 'MintShares', handleMintShares, true);
  dispatcher.registerHandler(daoShipIface, 'MintLoot', handleMintLoot, true);
  dispatcher.registerHandler(daoShipIface, 'BurnShares', handleBurnShares, true);
  dispatcher.registerHandler(daoShipIface, 'BurnLoot', handleBurnLoot, true);
  dispatcher.registerHandler(daoShipIface, 'LockAdmin', handleLockAdmin, true);
  dispatcher.registerHandler(daoShipIface, 'LockManager', handleLockManager, true);
  dispatcher.registerHandler(daoShipIface, 'LockGovernor', handleLockGovernor, true);
  dispatcher.registerHandler(daoShipIface, 'ConvertSharesToLoot', handleConvertSharesToLoot, true);
  dispatcher.registerHandler(daoShipIface, 'AdminConfigSet', handleAdminConfigSet, true);

  // Token events.
  // Transfer / Paused / Unpaused use universally-common topic0s (every
  // ERC-20 / every OZ Pausable on chain). STAY SCOPED until measurement
  // confirms Quai-wide volume is tractable.
  dispatcher.registerHandler(sharesIface, 'Transfer', handleTransfer);
  dispatcher.registerHandler(sharesIface, 'Paused', handlePaused);
  dispatcher.registerHandler(sharesIface, 'Unpaused', handleUnpaused);
  // Delegate events have DAO-Ships-specific signatures (not ERC-20).
  dispatcher.registerHandler(sharesIface, 'DelegateChanged', handleDelegateChanged, true);
  dispatcher.registerHandler(sharesIface, 'DelegateVotesChanged', handleDelegateVotesChanged, true);

  // Poster — single global contract; flip for consistency.
  dispatcher.registerHandler(posterIface, 'NewPost', handleNewPost, true);

  // Navigator events
  // NavigatorDeployed is emitted by navigator contracts at construction time.
  // Subscribed globally (unfiltered topic0 scan) — not scoped to known addresses.
  dispatcher.registerHandler(iNavIface, 'NavigatorDeployed', handleNavigatorDeployed, true);
  // OnboarderNavigator and ERC20TributeNavigator emit the same Onboard(address,address,uint256,uint256,uint256)
  // signature → identical topic0. Register once; the handler distinguishes by emitting contract address.
  dispatcher.registerHandler(onboarderNavigatorIface, 'Onboard', handleOnboard, true);
  // NFTGatedNavigator additionally emits NFTClaimed (unique topic0, carries the spent tokenId).
  // Flipped unfiltered to match Onboard — both are navigator-only signatures and the
  // unfiltered scan is a flat ~1 getLogs/range regardless of navigator count.
  dispatcher.registerHandler(nftGatedNavigatorIface, 'NFTClaimed', handleNFTClaimed, true);

  // SignalNavigator events (read-only polls). Unfiltered topic0 scan — like Onboard/NFTClaimed,
  // these are navigator-only signatures and the navigator is discovered via NavigatorDeployed,
  // never NavigatorSet. Handlers self-gate on trust_status (only sanctioned navs materialize).
  dispatcher.registerHandler(signalNavigatorIface, 'PollCreated', handlePollCreated, true);
  dispatcher.registerHandler(signalNavigatorIface, 'Voted', handleVoted, true);
  dispatcher.registerHandler(signalNavigatorIface, 'PollCancelled', handlePollCancelled, true);

  // TimelockNavigator events (GOVERNOR-permissioned governance-config timelock). Unfiltered
  // topic0 scan like the other navigator-specific signatures — the navigator is discovered via
  // NavigatorSet, and unfiltered fetch guarantees ChangeExecuted is always in pass 1 so the
  // same-tx bypass pairing with GovernanceConfigSet resolves in one range.
  dispatcher.registerHandler(timelockNavigatorIface, 'ChangeQueued', handleChangeQueued, true);
  dispatcher.registerHandler(timelockNavigatorIface, 'ChangeExecuted', handleChangeExecuted, true);
  dispatcher.registerHandler(timelockNavigatorIface, 'ChangeCancelled', handleChangeCancelled, true);

  // VestingNavigator events (MANAGER-permissioned cliff+linear vesting). Unfiltered topic0 scan.
  dispatcher.registerHandler(vestingNavigatorIface, 'ScheduleCreated', handleScheduleCreated, true);
  dispatcher.registerHandler(vestingNavigatorIface, 'TokensClaimed', handleTokensClaimed, true);
  dispatcher.registerHandler(vestingNavigatorIface, 'ScheduleRevoked', handleScheduleRevoked, true);

  // BudgetNavigator events (treasury budgets; vault-MODULE authority, no NavigatorSet). Unfiltered
  // topic0 scan like the other navigator-specific signatures. Handlers self-gate on trust_status
  // (only navigators the vault has ENABLED materialize — see vault-modules below). Paused/Unpaused/
  // NavigatorDeployed are shared topic0s handled elsewhere — NOT re-registered (would collide).
  dispatcher.registerHandler(budgetNavigatorIface, 'BudgetCreated', handleBudgetCreated, true);
  dispatcher.registerHandler(budgetNavigatorIface, 'Disbursed', handleDisbursed, true);
  dispatcher.registerHandler(budgetNavigatorIface, 'ManagerUpdated', handleManagerUpdated, true);
  dispatcher.registerHandler(budgetNavigatorIface, 'BudgetCancelled', handleBudgetCancelled, true);

  // Vault (QuaiVault / IAvatar) module events — the BudgetNavigator trust signal. These Zodiac
  // standard events are emitted by every safe, so the unfiltered scan is paired with an
  // authenticated in-handler filter (emitter == a known DAO's avatar AND module == a BudgetNavigator
  // bound to that DAO). EnabledModule → sanctioned + active + backfill; DisabledModule → unsanctioned.
  //
  // ⚠️ SCALABILITY WATCH-ITEM: unlike every other unfiltered topic above (DAOShips-specific, rare),
  // EnabledModule/DisabledModule are the Gnosis-Safe/Zodiac STANDARD signatures emitted by EVERY safe
  // on chain, so their getLogs volume scales with the whole Safe ecosystem — not with DAOShips usage.
  // Negligible today; track via `npm run measure:log-volume` (both are flagged collision-prone there).
  // If they dominate, flip these two to scoped (`unfiltered:false`) and add the registry's avatar
  // addresses to the fetch set — the one address-class the scoped fetcher does not track today.
  dispatcher.registerHandler(avatarModulesIface, 'EnabledModule', handleEnabledModule, true);
  dispatcher.registerHandler(avatarModulesIface, 'DisabledModule', handleDisabledModule, true);

  // SubscriptionNavigator events (MANAGER-permissioned recurring membership dues). Unfiltered
  // topic0 scan like the other navigator-specific signatures. Permissioned (standard NavigatorSet
  // discovery), so handlers resolve the DAO from NavigatorDeployed with no defer/backfill gate —
  // trust is enforced in the app. Paused/Unpaused/NavigatorDeployed are shared topic0s handled
  // elsewhere — NOT re-registered (would collide).
  dispatcher.registerHandler(subscriptionNavigatorIface, 'MemberEnrolled', handleMemberEnrolled, true);
  dispatcher.registerHandler(subscriptionNavigatorIface, 'FeePaid', handleFeePaid, true);
  dispatcher.registerHandler(subscriptionNavigatorIface, 'FeeCollected', handleFeeCollected, true);

  logger.info(
    { handlerCount: dispatcher.getRegisteredTopics().length },
    'Event handlers registered',
  );
}

// ── URL masking helper (I10) ─────────────────────────────────────
// Strips query strings and passwords from RPC URLs before logging
// to prevent API keys from appearing in log files.

function maskUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.search) parsed.search = '?***';
    if (parsed.password) parsed.password = '***';
    return parsed.toString();
  } catch { return '[invalid-url]'; }
}

async function main(): Promise<void> {
  // ── Process-level error handlers (H2) ──────────────────────────
  // Declared early so health and db can be referenced for cleanup.
  let health: HealthService | null = null;
  // Declared here (not const) so crash handlers can clear is_syncing (I5)
  let db: DatabaseService | null = null;

  process.on('unhandledRejection', (reason) => {
    logger.fatal({ reason }, 'Unhandled promise rejection');
    // Best-effort: attempt to clear is_syncing before exiting.
    // The startup stale check handles cases where this doesn't complete (I5).
    if (db) db.setIsSyncing(false).catch(() => {});
    if (health) {
      health.setIndexerRunning(false);
      health.stop().catch(() => {});
    }
    process.exit(1);
  });
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'Uncaught exception');
    // Best-effort: attempt to clear is_syncing before exiting (I5).
    if (db) db.setIsSyncing(false).catch(() => {});
    if (health) {
      health.setIndexerRunning(false);
      health.stop().catch(() => {});
    }
    process.exit(1);
  });

  logger.info({
    chainId: config.chainId,
    rpcUrl: maskUrl(config.rpcUrl),
    schema: config.supabaseSchema,
  }, 'Starting DAO Ships Indexer');

  // Initialize services
  const blockchain = new BlockchainService();
  db = new DatabaseService();
  const registry = new ContractRegistry(config.contracts);
  const dispatcher = new HandlerDispatcher();
  health = new HealthService();

  // ── Register event handlers ─────────────────────────────────

  registerAllHandlers(dispatcher);

  // ── Create block processor ──────────────────────────────────

  const processor = new BlockProcessor(blockchain, db, registry, dispatcher);

  // Wire services into the health server BEFORE starting it so the first
  // /health probe can include RangeCache stats via processor.recentRangeStats.
  health.setServices(blockchain, db, processor);

  // ── Start health server ───────────────────────────────────────

  await health.start();

  // Wrap init in try/catch so health server is stopped on fatal init errors
  let lastProcessedBlock: number;
  // M5: Track the last committed block hash in memory so we can detect reorgs
  // inside the polling loop (not only at startup). Updated whenever we
  // persist a block via updateLastProcessedBlock.
  let lastCommittedBlockHash: string | null = null;
  try {
    // Flip the health flag BEFORE init-phase backfill. Backfill can take
    // hours for deep chains — during that window the indexer IS running
    // and making forward progress, so reporting "not running" is misleading
    // to ops. If init fails fatally, the catch block below flips the flag
    // back to false. The fatal handlers (SIGINT, uncaughtException) also
    // flip it to false on real process exit.
    health.setIndexerRunning(true);

    // ── Wait for RPC connection ───────────────────────────────────

    await waitForRpcConnection(blockchain);

    // ── Wait for DB connection ────────────────────────────────────
    // Gate init on Supabase reachability so a transient `fetch failed` blip
    // during startup waits-and-retries instead of crashing the process at the
    // first unguarded DB call below.
    await waitForDbConnection(db);

    // ── Clear stale is_syncing flag from previous crash (I5) ────
    // If the indexer crashed during backfill, is_syncing may still be true.
    // The crash handlers attempt to clear it but may not complete before exit.
    // This startup check is the reliable safety net.
    try {
      const startupState = await db.getIndexerState();
      if (startupState.isSyncing) {
        logger.warn('Found stale is_syncing=true from previous crash, clearing');
        await db.setIsSyncing(false);
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to check/clear stale is_syncing at startup');
    }

    // ── Load existing DAOs from Supabase into registry ──────────

    try {
      let daoCount = 0;
      for await (const dao of db.getAllDaosIterator()) {
        registry.registerDao({
          daoShipAddress: dao.id,
          sharesAddress: dao.shares_address,
          lootAddress: dao.loot_address,
          avatar: dao.avatar,
        });
        daoCount++;
      }
      logger.info({ count: daoCount }, 'Loaded existing DAOs into registry');
    } catch (err) {
      logger.warn({ err }, 'Failed to load existing DAOs (table may not exist yet)');
    }

    // ── Load existing navigators from Supabase into registry ────────

    try {
      let navigatorCount = 0;
      for await (const navigator of db.getActiveNavigatorsIterator()) {
        registry.registerNavigator(navigator.navigator_address, navigator.dao_id);
        navigatorCount++;
      }
      logger.info({ count: navigatorCount }, 'Loaded existing navigators into registry');
    } catch (err) {
      logger.warn({ err }, 'Failed to load existing navigators (table may not exist yet)');
    }

    // ── Reorg detection (I8 note: single block hash check) ──────
    // We check only the last processed block hash to detect reorgs. A deep
    // reorg that goes past the last saved block would be caught by the
    // reorgWalkBack window. Checking N hashes would require N extra RPC calls
    // at startup — the current approach is a deliberate tradeoff.

    const indexerState = await db.getLastProcessedBlock();
    lastProcessedBlock = indexerState.blockNumber;
    const lastBlockHash = indexerState.blockHash;

    const newLastProcessed = await detectAndRecoverReorg(
      lastProcessedBlock,
      lastBlockHash,
      blockchain,
      db,
      registry,
      processor,
      'startup',
    );
    if (newLastProcessed !== null) {
      lastProcessedBlock = newLastProcessed;
      // After rewind we have no trustworthy hash for the new tip — it will be
      // populated again by the next successful processBlockRange.
      lastCommittedBlockHash = null;
    } else {
      lastCommittedBlockHash = lastBlockHash;
    }

    // Use start block if we haven't indexed anything yet
    if (lastProcessedBlock === 0 && config.startBlock > 0) {
      lastProcessedBlock = config.startBlock;
      logger.info({ startBlock: lastProcessedBlock }, 'Starting from configured start block');
    }

    // ── Initial backfill if needed ────────────────────────────────

    const currentBlock = await blockchain.getBlockNumber();
    const safeBlock = currentBlock - config.confirmationBlocks;
    const startFrom = Math.max(lastProcessedBlock + 1, config.startBlock);

    if (startFrom < safeBlock) {
      const gap = safeBlock - startFrom;
      if (gap > config.maxBlockRange) {
        logger.info({ startFrom, safeBlock, gap }, 'Large gap detected, starting backfill');
        lastProcessedBlock = await doBackfill(
          startFrom,
          safeBlock,
          processor,
          db,
          registry,
          health,
          () => true, // no shutdown signal during init
        );
        // M5: Refresh the in-memory hash after init backfill so reorg
        // detection in the polling loop has a valid baseline.
        try {
          const refreshed = await db.getLastProcessedBlock();
          lastCommittedBlockHash = refreshed.blockHash;
        } catch (err) {
          logger.warn({ err }, 'Failed to refresh lastCommittedBlockHash after init backfill');
          lastCommittedBlockHash = null;
        }
      }
    }
  } catch (initErr) {
    logger.fatal({ err: initErr }, 'Fatal error during initialization — stopping health server');
    health.setIndexerRunning(false);
    await health.stop();
    throw initErr;
  }

  // ── Polling loop ────────────────────────────────────────────

  let running = true;
  let shuttingDown = false;

  const shutdown = () => {
    if (shuttingDown) {
      logger.warn('Double shutdown signal — forcing exit');
      process.exit(1);
    }
    shuttingDown = true;
    logger.info('Shutdown signal received, stopping after current block range...');
    running = false;

    // M24: Wake any active sleep so the loop can check `running` immediately
    if (sleepResolve) sleepResolve();

    // Force exit after timeout
    setTimeout(() => {
      logger.error('Graceful shutdown timed out, forcing exit');
      process.exit(1);
    }, FORCE_SHUTDOWN_MS).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // `setIndexerRunning(true)` already fired at the top of init so /health
  // reports healthy during backfill. Keep no-op here to preserve the
  // existing ordering contract for any callers relying on it.

  const pollRetryTracker = new RetryTracker();
  const circuitBreaker = { failures: 0, isOpen: false, openUntil: 0 };
  let lastPruneTime = Date.now();

  logger.info(
    { lastProcessedBlock, pollIntervalMs: config.pollIntervalMs },
    'Entering polling loop',
  );

  while (running) {
    // Check circuit breaker
    if (circuitBreaker.isOpen) {
      if (Date.now() < circuitBreaker.openUntil) {
        const waitTime = circuitBreaker.openUntil - Date.now();
        logger.debug({ waitMs: waitTime }, 'Circuit breaker open, waiting');
        await sleep(Math.min(waitTime, config.pollIntervalMs));
        continue;
      }
      // Cooldown expired, allow retry (half-open)
      logger.info('Circuit breaker cooldown expired, attempting recovery');
      circuitBreaker.isOpen = false;
      circuitBreaker.failures = 0;
    }

    try {
      const currentBlock = await blockchain.getBlockNumber();
      const safeBlock = currentBlock - config.confirmationBlocks;

      // Honor START_BLOCK config
      const startBlock = Math.max(lastProcessedBlock + 1, config.startBlock);

      if (startBlock > safeBlock) {
        await sleep(config.pollIntervalMs);
        continue;
      }

      // M5: In-loop reorg detection. Before advancing, verify the chain's
      // hash at lastProcessedBlock still matches what we persisted. If not,
      // a reorg landed between polls — rewind before indexing further.
      if (lastCommittedBlockHash !== null) {
        const newLastProcessed = await detectAndRecoverReorg(
          lastProcessedBlock,
          lastCommittedBlockHash,
          blockchain,
          db,
          registry,
          processor,
          'poll-loop',
        );
        if (newLastProcessed !== null) {
          lastProcessedBlock = newLastProcessed;
          lastCommittedBlockHash = null;
          // Restart this iteration with fresh start/safe block math.
          continue;
        }
      }

      const blocksToIndex = safeBlock - startBlock + 1;

      // If gap exceeds maxBlockRange * 2, trigger backfill mode
      if (blocksToIndex > config.maxBlockRange * 2) {
        logger.info(
          { lastIndexed: lastProcessedBlock, startBlock, safeBlock, blocksToIndex },
          'Large gap detected in poll loop, triggering backfill',
        );

        // Reload DAOs in case DB was reset
        try {
          for await (const dao of db.getAllDaosIterator()) {
            registry.registerDao({
              daoShipAddress: dao.id,
              sharesAddress: dao.shares_address,
              lootAddress: dao.loot_address,
              avatar: dao.avatar,
            });
          }
            } catch (err) { logger.warn({ err }, 'Failed to reload DAOs before backfill'); }

        // Reload navigators in case DB was reset
        try {
          for await (const navigator of db.getActiveNavigatorsIterator()) {
            registry.registerNavigator(navigator.navigator_address, navigator.dao_id);
          }
        } catch (err) { logger.warn({ err }, 'Failed to reload navigators before backfill'); }

        lastProcessedBlock = await doBackfill(
          startBlock,
          safeBlock,
          processor,
          db,
          registry,
          health,
          () => running,
        );
        // M5: Refresh the in-memory hash after backfill so reorg detection
        // on the next poll has a valid baseline. processChunkedRange persists
        // per-chunk but doesn't surface the final hash back here.
        try {
          const refreshed = await db.getLastProcessedBlock();
          lastCommittedBlockHash = refreshed.blockHash;
        } catch (err) {
          logger.warn({ err }, 'Failed to refresh lastCommittedBlockHash after backfill');
          lastCommittedBlockHash = null;
        }
      } else {
        // Normal polling: process in chunks
        let from = startBlock;
        while (from <= safeBlock && running) {
          const to = Math.min(from + config.maxBlockRange - 1, safeBlock);

          const { lastBlockHash } = await processor.processBlockRange(from, to);

          await db.updateLastProcessedBlock(to, lastBlockHash);
          lastProcessedBlock = to;
          // M5: Track the committed hash so the next poll can detect reorgs.
          lastCommittedBlockHash = lastBlockHash || null;

          // H4: Prune old dedup entries (best-effort, non-blocking)
          await db.pruneProcessedLogs(to, config.reorgWalkBack);

          logger.info(
            { from, to, currentBlock, daoCount: registry.daoCount },
            'Block range processed',
          );

          from = to + 1;
        }
      }

      // Success — reset retry tracker and circuit breaker (M2 fix)
      pollRetryTracker.recordSuccess();
      if (circuitBreaker.failures > 0) {
        logger.info({ previousFailures: circuitBreaker.failures }, 'Circuit breaker: recovered');
      }
      circuitBreaker.failures = 0;
      circuitBreaker.isOpen = false;
      health.setRpcCircuitBreakerOpen(false);

    } catch (err) {
      const retryDelay = pollRetryTracker.recordFailure(err as Error, 'poll');

      // Circuit breaker tracking
      circuitBreaker.failures++;
      if (circuitBreaker.failures >= CIRCUIT_BREAKER.failureThreshold) {
        circuitBreaker.isOpen = true;
        circuitBreaker.openUntil = Date.now() + CIRCUIT_BREAKER.cooldownMs;
        health.setRpcCircuitBreakerOpen(true);
        logger.error(
          { failures: circuitBreaker.failures, cooldownMs: CIRCUIT_BREAKER.cooldownMs },
          'Circuit breaker opened — pausing indexer',
        );
      }

      if (pollRetryTracker.isExhausted()) {
        logger.error(
          { consecutiveFailures: pollRetryTracker.getFailureCount() },
          'Poll retry limit reached — continuing but intervention may be needed',
        );
        pollRetryTracker.reset();
      }

      await sleep(retryDelay);
      continue;
    }

    // Daily orphan pruning (pre-DAO allowlist records and navigator metadata that were never claimed)
    if (Date.now() - lastPruneTime > 86_400_000) {
      try {
        // Navigator pruning reaps non-read-only navigators never granted a permission
        // within ORPHAN_RETENTION_DAYS, whether or not their DAO exists. Only deletes when
        // caught up to chain head — until head, an unprocessed NavigatorSet that would grant
        // permission may still be pending, so the RPC no-ops unless atChainHead is true.
        const chainHead = await blockchain.getBlockNumber().catch(() => lastProcessedBlock);
        const atChainHead = lastProcessedBlock >= chainHead - config.confirmationBlocks;
        await db.pruneOrphanedRecords(config.orphanRetentionDays);
        await db.pruneOrphanedNavigators(config.orphanRetentionDays, atChainHead);
        lastPruneTime = Date.now();
      } catch (err) {
        logger.warn({ err }, 'Orphan pruning failed (non-fatal)');
      }
    }

    // Only sleep when caught up — skip sleep if there may be more blocks to process
    const latestSafe = (await blockchain.getBlockNumber().catch(() => lastProcessedBlock)) - config.confirmationBlocks;
    if (lastProcessedBlock >= latestSafe) {
      await sleep(config.pollIntervalMs);
    } else {
      logger.debug(
        { lastProcessed: lastProcessedBlock, latestSafe, behind: latestSafe - lastProcessedBlock },
        'Still behind — skipping poll sleep',
      );
    }
  }

  // ── Graceful shutdown ─────────────────────────────────────────

  health.setIndexerRunning(false);
  await health.stop();
  logger.info('Indexer shut down gracefully');
}

// ── Helpers ─────────────────────────────────────────────────────

// M24: Interruptible sleep — resolve is captured so shutdown can wake it early.
// M14: Single module-level mutable by design — only one sleep is ever active
// at a time (single-threaded polling loop). Tests don't call sleep() directly.
let sleepResolve: (() => void) | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { sleepResolve = null; resolve(); }, ms);
    sleepResolve = () => { clearTimeout(timer); sleepResolve = null; resolve(); };
  });
}

async function waitForRpcConnection(
  blockchain: BlockchainService,
  maxAttempts = 30,
  initialDelayMs = 2000,
): Promise<void> {
  let delay = initialDelayMs;
  const maxDelay = 30000;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const block = await blockchain.getBlockNumber();
      logger.info({ block, attempts: attempt }, 'RPC connection established');
      return;
    } catch (err) {
      logger.warn(
        { attempt, maxAttempts, nextRetryMs: delay, err: (err as Error).message },
        'Waiting for RPC connection...',
      );

      if (attempt === maxAttempts) {
        throw new Error(`Failed to connect to RPC after ${maxAttempts} attempts: ${(err as Error).message}`);
      }

      await sleep(delay);
      delay = Math.min(delay * 1.5, maxDelay);
    }
  }
}

/**
 * DB-readiness gate, mirror of waitForRpcConnection. A transient Supabase blip
 * (`TypeError: fetch failed`) during init would otherwise crash the process at
 * the first unguarded DB call (getLastProcessedBlock / registry hydration),
 * even though the DB recovers seconds later. Probe is getLastProcessedBlock():
 * ds_indexer_state always has a seeded id=1 row (schema.sql), so the only way
 * this throws is the DB being unreachable — exactly the condition to wait on.
 */
async function waitForDbConnection(
  db: DatabaseService,
  maxAttempts = 30,
  initialDelayMs = 2000,
): Promise<void> {
  let delay = initialDelayMs;
  const maxDelay = 30000;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const { blockNumber } = await db.getLastProcessedBlock();
      logger.info({ lastProcessedBlock: blockNumber, attempts: attempt }, 'Database connection established');
      return;
    } catch (err) {
      logger.warn(
        { attempt, maxAttempts, nextRetryMs: delay, err: (err as Error).message },
        'Waiting for database connection...',
      );

      if (attempt === maxAttempts) {
        throw new Error(`Failed to connect to database after ${maxAttempts} attempts: ${(err as Error).message}`);
      }

      await sleep(delay);
      delay = Math.min(delay * 1.5, maxDelay);
    }
  }
}

export async function processChunkedRange(
  fromBlock: number,
  toBlock: number,
  processor: BlockProcessor,
  db: DatabaseService,
  options?: {
    useRetry?: boolean;
    onProgress?: (start: number, end: number) => void;
    shouldStop?: () => boolean;
  },
): Promise<number> {
  const batchSize = config.maxBlockRange;
  let lastProcessed = fromBlock - 1;

  for (let start = fromBlock; start <= toBlock; start += batchSize) {
    // Check for shutdown signal before processing next chunk (H3)
    if (options?.shouldStop?.()) {
      logger.info({ lastProcessed, start, toBlock }, 'processChunkedRange interrupted by shutdown signal');
      break;
    }

    const end = Math.min(start + batchSize - 1, toBlock);

    let result: { lastBlockHash: string };
    if (options?.useRetry) {
      result = await withRetry(
        () => processor.processBlockRange(start, end),
        { operation: `batch-${start}-${end}` },
      );
    } else {
      result = await processor.processBlockRange(start, end);
    }

    await db.updateLastProcessedBlock(end, result.lastBlockHash);
    lastProcessed = end;

    // M2: Prune old dedup entries during chunked processing (backfill/catch-up),
    // matching the pruning that the main polling loop does.
    await db.pruneProcessedLogs(end, config.reorgWalkBack);

    options?.onProgress?.(start, end);
  }

  return lastProcessed;
}

/**
 * M5: Reorg detection + recovery. Returns the new lastProcessedBlock if a
 * reorg was detected and recovered from; returns null if no reorg (no change).
 *
 * Used from both the startup path and the in-loop polling path. On detection:
 *  1. Delete indexed events after the fork point (SQL ds_delete_events_after_block).
 *  2. Clear in-memory caches (navigator DAO cache, block cache) that may hold
 *     pre-reorg mappings (M4).
 *  3. Rebuild the registry from surviving DB rows.
 *  4. Flag ds_indexer_state.requires_full_reindex (M2) — any detected reorg is
 *     by construction deeper than confirmationBlocks, so member balance totals
 *     may have drifted and require operator attention.
 */
async function detectAndRecoverReorg(
  lastProcessedBlock: number,
  lastBlockHash: string | null,
  blockchain: BlockchainService,
  db: DatabaseService,
  registry: ContractRegistry,
  processor: BlockProcessor,
  origin: 'startup' | 'poll-loop',
): Promise<number | null> {
  if (lastProcessedBlock <= 0 || !lastBlockHash) return null;

  let block: Awaited<ReturnType<typeof blockchain.getBlock>> | null = null;
  try {
    block = await blockchain.getBlock(lastProcessedBlock);
  } catch (err) {
    logger.error({ err, origin }, 'Reorg check: block fetch failed, continuing from last saved block');
    return null;
  }

  if (!block || block.hash === lastBlockHash) return null;

  logger.warn(
    { savedHash: lastBlockHash, chainHash: block.hash, block: lastProcessedBlock, origin },
    'Block hash mismatch detected — possible reorg',
  );

  const forkPoint = Math.max(0, lastProcessedBlock - config.reorgWalkBack);

  logger.warn(
    { forkPoint, lastProcessedBlock, walkBack: config.reorgWalkBack, origin },
    'Rewinding to safe fork point and cleaning up orphaned data',
  );

  // Check whether the rewound window actually contained any processed events
  // BEFORE deletion (deleteEventsAfterBlock cascades through ds_processed_logs).
  // Zero processed logs ⇒ no Transfer/Mint/Burn/Ragequit/etc. was ever recorded
  // on the abandoned fork ⇒ no balance drift possible ⇒ skip the flag. This
  // is best-effort; on query failure we fall through to the conservative path
  // (flag set) to match pre-existing behavior.
  let rewoundLogCount: number | null = null;
  try {
    rewoundLogCount = await db.countProcessedLogsAfterBlock(forkPoint);
  } catch (err) {
    logger.warn({ err, origin, forkPoint }, 'Clean-window check failed; falling back to setting reindex flag');
  }

  // Fatal on failure — must not continue with stale data after a detected reorg.
  await db.deleteEventsAfterBlock(forkPoint);

  // M2: A reorg is deeper than confirmationBlocks by construction
  // (the indexer only persists blocks at currentBlock - confirmationBlocks).
  // Member balances cannot be rebuilt from the replay range alone IF any
  // balance-affecting event was recorded in the window. When the dedupe log
  // shows zero processed rows in the rewound range, the reorg only moved
  // empty blocks and there is no drift to recover from — skip the flag.
  // Best-effort: don't fail recovery if the flag write fails.
  if (rewoundLogCount === 0) {
    logger.info(
      { forkPoint, lastProcessedBlock, origin },
      'Reorg window had zero processed logs — skipping requires_full_reindex flag',
    );
  } else {
    try {
      await db.setRequiresFullReindex(
        `${origin}: reorg detected at block ${lastProcessedBlock}, rewound to ${forkPoint}` +
          (rewoundLogCount !== null ? ` (${rewoundLogCount} processed logs in window)` : ''),
      );
    } catch (err) {
      logger.error({ err, origin }, 'Failed to set requires_full_reindex flag (continuing)');
    }
  }

  // M4: Clear in-memory caches that may contain stale mappings from
  // pre-reorg events now being rolled back.
  clearNavigatorDaoCache();
  processor.clearCaches();

  // Rebuild the in-memory registry from surviving DB rows.
  registry.clear();
  for await (const dao of db.getAllDaosIterator()) {
    registry.registerDao({
      daoShipAddress: dao.id,
      sharesAddress: dao.shares_address,
      lootAddress: dao.loot_address,
      avatar: dao.avatar,
    });
  }
  for await (const nav of db.getActiveNavigatorsIterator()) {
    registry.registerNavigator(nav.navigator_address, nav.dao_id);
  }
  logger.info(
    { daos: registry.daoCount, navigators: registry.navigatorCount, origin },
    'Registry rebuilt from surviving DB rows after reorg',
  );

  return forkPoint;
}

async function doBackfill(
  fromBlock: number,
  toBlock: number,
  processor: BlockProcessor,
  db: DatabaseService,
  registry: ContractRegistry,
  health: HealthService,
  isRunning: () => boolean,
): Promise<number> {
  logger.info({ fromBlock, toBlock }, 'Starting backfill');
  await db.setIsSyncing(true);

  const totalBlocks = toBlock - fromBlock;

  try {
    const lastProcessed = await processChunkedRange(fromBlock, toBlock, processor, db, {
      useRetry: true,
      shouldStop: () => !isRunning(),
      onProgress: (_start, end) => {
        const progress = totalBlocks > 0
          ? (((end - fromBlock) / totalBlocks) * 100).toFixed(1)
          : '100.0';
        logger.info(
          { start: _start, end, progress: `${progress}%`, daoCount: registry.daoCount },
          'Backfill progress',
        );
      },
    });

    logger.info('Backfill complete');
    return lastProcessed;
  } finally {
    await db.setIsSyncing(false);
  }
}

// ── Run ─────────────────────────────────────────────────────────

main().catch((err) => {
  logger.fatal({ err }, 'Fatal error in indexer');
  process.exit(1);
});
