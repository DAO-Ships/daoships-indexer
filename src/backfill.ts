/**
 * Standalone backfill script for historical data indexing.
 * Run with: npm run backfill
 *
 * Environment variables:
 * - BACKFILL_FROM: Starting block number (optional, defaults to START_BLOCK)
 * - BACKFILL_TO: Ending block number (optional, defaults to current block)
 */

import { config } from './config.js';
import { logger } from './utils/logger.js';
import { BlockchainService } from './services/blockchain.js';
import { DatabaseService } from './services/database.js';
import { BlockProcessor } from './services/processor.js';
import { ContractRegistry } from './registry/contract-registry.js';
import { HandlerDispatcher } from './handlers/index.js';
import { registerAllHandlers, processChunkedRange } from './index.js';

// ── Backfill ────────────────────────────────────────────────────

async function backfill(): Promise<void> {
  logger.info('Starting backfill script...');

  const blockchain = new BlockchainService();
  const db = new DatabaseService();
  const registry = new ContractRegistry(config.contracts);
  const dispatcher = new HandlerDispatcher();

  // Register all handlers (shared with index.ts)
  registerAllHandlers(dispatcher);

  // ── H4: Isolation check — refuse to run if another process is syncing ──
  const state = await db.getIndexerState();
  if (state.isSyncing) {
    throw new Error('Another process is already syncing (is_syncing=true). Stop it first or reset the flag.');
  }

  // ── Shutdown handling (NEW-3) ──
  let running = true;
  const shutdown = () => {
    logger.info('Shutdown signal received, stopping after current chunk...');
    running = false;
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Load existing DAOs using iterator (NEW-3)
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
    logger.info({ count: daoCount }, 'Loaded existing DAOs');
  } catch (err) {
    logger.warn({ err }, 'Failed to load existing DAOs');
  }

  // Load existing navigators
  try {
    let navigatorCount = 0;
    for await (const navigator of db.getActiveNavigatorsIterator()) {
      registry.registerNavigator(navigator.navigator_address, navigator.dao_id);
      navigatorCount++;
    }
    logger.info({ count: navigatorCount }, 'Loaded existing navigators');
  } catch (err) {
    logger.warn({ err }, 'Failed to load existing navigators');
  }

  const processor = new BlockProcessor(blockchain, db, registry, dispatcher);

  // Determine and validate block range
  const currentBlock = await blockchain.getBlockNumber();
  const fromBlock = parseInt(process.env.BACKFILL_FROM || String(config.startBlock));
  const toBlock = parseInt(process.env.BACKFILL_TO || String(currentBlock));

  if (!Number.isFinite(fromBlock) || !Number.isFinite(toBlock)) {
    throw new Error(
      `Invalid block range: BACKFILL_FROM=${process.env.BACKFILL_FROM ?? '(unset)'}, BACKFILL_TO=${process.env.BACKFILL_TO ?? '(unset)'}`,
    );
  }
  if (fromBlock > toBlock) {
    throw new Error(`BACKFILL_FROM (${fromBlock}) > BACKFILL_TO (${toBlock})`);
  }

  const totalBlocks = toBlock - fromBlock;
  logger.info({ fromBlock, toBlock, totalBlocks }, 'Backfill range');

  // Wrap in try/finally to ensure is_syncing is always cleared (NEW-3)
  await db.setIsSyncing(true);

  try {
    await processChunkedRange(fromBlock, toBlock, processor, db, {
      useRetry: true,
      shouldStop: () => !running,
      onProgress: (start, end) => {
        const progress = totalBlocks > 0
          ? (((end - fromBlock) / totalBlocks) * 100).toFixed(1)
          : '100.0';
        logger.info(
          { start, end, progress: `${progress}%`, daoCount: registry.daoCount },
          'Backfill progress',
        );
      },
    });

    logger.info(
      { totalBlocks, daoCount: registry.daoCount },
      'Backfill complete',
    );
  } finally {
    await db.setIsSyncing(false);
  }
}

backfill().catch((err) => {
  logger.error({ err }, 'Backfill failed');
  process.exit(1);
});
