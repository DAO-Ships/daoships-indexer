import type { Log } from 'quais';
import { config } from '../config.js';
import { BlockchainService } from './blockchain.js';
import { DatabaseService } from './database.js';
import { ContractRegistry } from '../registry/contract-registry.js';
import { HandlerDispatcher, type EventContext } from '../handlers/index.js';
import { logger } from '../utils/logger.js';
import { extractBlockTimestamp } from '../utils/validation.js';

// Maximum addresses per getLogs call to avoid RPC limits
const GET_LOGS_ADDRESS_CHUNK_SIZE = 100;

/** Patterns indicating a transient/retriable error */
const TRANSIENT_ERROR_PATTERNS = [
  'econnrefused',
  'econnreset',
  'etimedout',
  'enotfound',
  'timeout',
  'network',
  'socket hang up',
  'unavailable',
  'rate limit',
  'too many requests',
  'failed to fetch',
  'fetch failed',
  'connection terminated',
  'connection refused',
];

function isTransientError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // Check error codes first (more reliable than string matching)
  const code = (err as unknown as Record<string, unknown>).code;
  if (typeof code === 'string') {
    const transientCodes = ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'UND_ERR_SOCKET'];
    if (transientCodes.includes(code)) return true;
  }
  const msg = err.message.toLowerCase();
  return TRANSIENT_ERROR_PATTERNS.some(pattern => msg.includes(pattern));
}

export class BlockProcessor {
  private blockchain: BlockchainService;
  private db: DatabaseService;
  private registry: ContractRegistry;
  private dispatcher: HandlerDispatcher;

  /** LRU Cache: blockNumber → unix timestamp (seconds) */
  private blockTimestampCache: Map<number, number> = new Map();

  /** LRU Cache: blockNumber → block hash (populated alongside timestamp) */
  private blockHashCache: Map<number, string> = new Map();

  constructor(
    blockchain: BlockchainService,
    db: DatabaseService,
    registry: ContractRegistry,
    dispatcher: HandlerDispatcher,
  ) {
    this.blockchain = blockchain;
    this.db = db;
    this.registry = registry;
    this.dispatcher = dispatcher;
  }

  async processBlockRange(fromBlock: number, toBlock: number): Promise<{ lastBlockHash: string }> {
    if (fromBlock > toBlock) {
      throw new Error(`Invalid block range: fromBlock ${fromBlock} > toBlock ${toBlock}`);
    }
    logger.info({ fromBlock, toBlock }, 'Processing block range');

    // Snapshot registered addresses BEFORE fetching, so we can detect new
    // DAOs, tokens, and navigators discovered during processing.
    const knownAddresses = new Set([
      ...this.registry.getAllDaoShipAddresses(),
      ...this.registry.getAllTokenAddresses(),
      ...this.registry.getAllNavigatorAddresses(),
    ]);

    const allLogs = await this.fetchAllLogs(fromBlock, toBlock);
    await this.processLogs(allLogs, fromBlock, toBlock);

    // After processing, check for newly discovered addresses. Loop because
    // processing new logs may register further addresses (e.g., NavigatorSet in
    // the second pass registers navigators whose events need a third pass).
    const MAX_DISCOVERY_PASSES = 3;
    for (let pass = 0; pass < MAX_DISCOVERY_PASSES; pass++) {
      const currentAddresses = new Set([
        ...this.registry.getAllDaoShipAddresses(),
        ...this.registry.getAllTokenAddresses(),
        ...this.registry.getAllNavigatorAddresses(),
      ]);

      const newAddresses = [...currentAddresses].filter(a => !knownAddresses.has(a));
      if (newAddresses.length === 0) break;

      logger.info(
        { pass: pass + 1, newCount: newAddresses.length, fromBlock, toBlock },
        'New addresses discovered — re-fetching logs',
      );

      const additionalLogs = await this.fetchLogsForAddresses(newAddresses, fromBlock, toBlock);
      if (additionalLogs.length > 0) {
        await this.processLogs(additionalLogs, fromBlock, toBlock);
      }

      // Add discovered addresses to known set for next iteration
      for (const addr of newAddresses) knownAddresses.add(addr);
    }

    // Return the hash of the last block (may already be cached from getBlockTimestamp)
    let lastBlockHash = this.blockHashCache.get(toBlock) ?? '';
    if (!lastBlockHash) {
      try {
        const block = await this.blockchain.getBlock(toBlock);
        lastBlockHash = block?.hash ?? '';
      } catch (err) {
        logger.warn({ err, blockNumber: toBlock }, 'Failed to fetch block hash (best-effort for reorg detection)');
      }
    }

    return { lastBlockHash };
  }

  private async processLogs(logs: Log[], fromBlock: number, toBlock: number): Promise<void> {
    // Launcher addresses create DAO rows that other handlers depend on (FK constraints).
    // Within the same tx, EVM emits NewPost (from setUp) before LaunchDAOShip/LaunchDAOShipAndVault,
    // so we must reorder: launcher events first, then everything else.
    const launcherAddresses = new Set([
      config.contracts.daoShipAndVaultLauncher,
      config.contracts.daoShipLauncher,
    ]);

    logs.sort((a, b) => {
      if (a.blockNumber !== b.blockNumber) return a.blockNumber - b.blockNumber;
      if (a.transactionIndex !== b.transactionIndex) return a.transactionIndex - b.transactionIndex;
      // Within same tx: launcher events first to ensure DAO rows exist
      const aIsLauncher = launcherAddresses.has(a.address.toLowerCase());
      const bIsLauncher = launcherAddresses.has(b.address.toLowerCase());
      if (aIsLauncher !== bIsLauncher) return aIsLauncher ? -1 : 1;
      return a.index - b.index;
    });

    logger.info({ logCount: logs.length, fromBlock, toBlock }, 'Fetched logs');

    // Fetch already-processed log keys for this range (retry idempotency).
    // On first run this set is empty. On a retry after transient failure,
    // it contains keys for logs that were already successfully handled.
    const processedKeys = await this.db.getProcessedLogKeys(fromBlock, toBlock);

    // Track unique tx hashes for deduped event transaction recording
    const seenTxHashes = new Map<string, { daoId: string | null; blockNumber: number; timestamp: Date }>();

    for (const log of logs) {
      // Skip logs already processed in a previous attempt of this block range
      const logKey = `${log.transactionHash}-${log.index}`;
      if (processedKeys.has(logKey)) {
        logger.debug({ txHash: log.transactionHash, logIndex: log.index }, 'Skipping already-processed log');
        continue;
      }

      try {
        const blockTimestamp = await this.getBlockTimestamp(log.blockNumber);
        const ctx: EventContext = {
          log,
          blockTimestamp,
          db: this.db,
          blockchain: this.blockchain,
          registry: this.registry,
        };

        const { handled, eventName } = await this.dispatcher.dispatch(ctx);

        if (handled) {
          // Mark as processed immediately to prevent re-processing on retry
          await this.db.markLogProcessed(log.transactionHash, log.index, log.blockNumber);

          logger.debug({
            event: eventName,
            block: log.blockNumber,
            address: log.address,
            txHash: log.transactionHash?.slice(0, 14),
          }, 'Event handled');

          // Collect for deduped recording (one entry per unique txHash)
          if (!seenTxHashes.has(log.transactionHash)) {
            const daoId = this.resolveDaoId(log.address);
            seenTxHashes.set(log.transactionHash, {
              daoId,
              blockNumber: log.blockNumber,
              timestamp: new Date(blockTimestamp * 1000),
            });
          }
        }
      } catch (err) {
        if (isTransientError(err)) {
          // Transient error: re-throw to fail the block range so it gets retried.
          // Already-processed logs will be skipped on retry via the dedup table.
          logger.error({
            err,
            block: log.blockNumber,
            txHash: log.transactionHash,
            logIndex: log.index,
            address: log.address,
          }, 'Transient error processing log — failing block range for retry');
          throw err;
        }

        // Deterministic error: log at error level and skip permanently
        logger.error({
          err,
          block: log.blockNumber,
          txHash: log.transactionHash,
          logIndex: log.index,
          address: log.address,
        }, 'Deterministic error processing log — permanently skipped');
      }
    }

    // Batch record unique event transactions
    for (const [txHash, info] of seenTxHashes) {
      await this.db.recordEventTransaction(txHash, info.daoId, info.blockNumber, info.timestamp);
    }
  }

  /**
   * Fetch logs for specific addresses (used for discovery passes when new
   * DAOs/tokens/navigators are found during processing).
   */
  private async fetchLogsForAddresses(addresses: string[], fromBlock: number, toBlock: number): Promise<Log[]> {
    const allLogs: Log[] = [];
    for (let i = 0; i < addresses.length; i += GET_LOGS_ADDRESS_CHUNK_SIZE) {
      const batch = addresses.slice(i, i + GET_LOGS_ADDRESS_CHUNK_SIZE);
      const logs = await this.blockchain.getLogs(batch, fromBlock, toBlock);
      allLogs.push(...logs);
    }
    return allLogs;
  }

  /**
   * Topic + address log fetching — O(1) RPC calls regardless of DAO count.
   *
   * Queries by topic0 hashes (fixed set) AND known addresses (server-side).
   * This avoids pulling chain-wide Transfer events (topic0 0xddf252ad matches
   * every ERC20/ERC721 transfer). For most deployments with a few dozen DAOs +
   * tokens, a single getLogs call handles everything. If the address list grows
   * beyond RPC provider limits (~50-100), batch into multiple calls here.
   */
  private async fetchAllLogs(fromBlock: number, toBlock: number): Promise<Log[]> {
    // All topic0 hashes we care about — fixed set regardless of DAO count
    const registeredTopics = this.dispatcher.getRegisteredTopics();
    if (registeredTopics.length === 0) return [];

    // All known addresses we want logs from
    const knownAddresses = new Set([
      ...Object.values(config.contracts),
      ...this.registry.getAllDaoShipAddresses(),
      ...this.registry.getAllTokenAddresses(),
      ...this.registry.getAllNavigatorAddresses(),
    ]);

    // Single RPC call: fetch all logs matching our topic0 hashes, scoped to
    // known addresses. Server-side address filter avoids pulling chain-wide
    // Transfer events (topic0 0xddf252ad matches all ERC20/ERC721 transfers).
    const addressFilter = [...knownAddresses];
    const allLogs = await this.blockchain.getLogs(
      addressFilter,
      fromBlock,
      toBlock,
      [registeredTopics],  // topics[0] = array of topic0 hashes (OR)
    );

    return allLogs;
  }

  private async getBlockTimestamp(blockNumber: number): Promise<number> {
    const cached = this.blockTimestampCache.get(blockNumber);
    if (cached !== undefined) {
      // Re-insert to maintain LRU order (moves to end of Map)
      this.blockTimestampCache.delete(blockNumber);
      this.blockTimestampCache.set(blockNumber, cached);
      return cached;
    }

    const block = await this.blockchain.getBlock(blockNumber);
    if (!block) throw new Error(`Block ${blockNumber} not found`);

    // Use validated extraction — throws clear error instead of silently returning 0
    const timestamp = extractBlockTimestamp(block as unknown as Record<string, unknown>, blockNumber);

    // LRU eviction: remove oldest entry if at capacity
    if (this.blockTimestampCache.size >= config.cache.timestampCacheSize) {
      const oldestKey = this.blockTimestampCache.keys().next().value;
      if (oldestKey !== undefined) {
        this.blockTimestampCache.delete(oldestKey);
      }
    }
    this.blockTimestampCache.set(blockNumber, timestamp);

    // Also cache block hash (for processBlockRange to return without extra RPC call)
    if (this.blockHashCache.size >= config.cache.timestampCacheSize) {
      const oldestKey = this.blockHashCache.keys().next().value;
      if (oldestKey !== undefined) {
        this.blockHashCache.delete(oldestKey);
      }
    }
    this.blockHashCache.set(blockNumber, block.hash ?? '');

    return timestamp;
  }

  /** Resolve a log address to a DAO ID (if it's a known DAOShip, token, or navigator) */
  private resolveDaoId(address: string): string | null {
    const lower = address.toLowerCase();
    // Direct DAOShip address
    if (this.registry.getDaoByDaoShipAddress(lower)) return lower;
    // Token address → DAO
    const daoFromToken = this.registry.getDaoByTokenAddress(lower);
    if (daoFromToken) return daoFromToken;
    // Navigator address → DAO (best-effort for event transaction recording)
    const daoFromNavigator = this.registry.getDaoByNavigatorAddress(lower);
    if (daoFromNavigator) return daoFromNavigator;
    // Static contracts don't map to a specific DAO
    return null;
  }
}
