import type { Log } from 'quais';
import { config } from '../config.js';
import { BlockchainService } from './blockchain.js';
import { DatabaseService } from './database.js';
import { ContractRegistry } from '../registry/contract-registry.js';
import { HandlerDispatcher, type EventContext } from '../handlers/index.js';
import { logger } from '../utils/logger.js';
import { extractBlockTimestamp } from '../utils/validation.js';
import { RangeCache, summarizeRangeCache, type RangeCacheSummary } from './range-cache.js';

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

  /** M1: Single LRU cache for both timestamp and hash (populated together from getBlock) */
  private blockCache: Map<number, { timestamp: number; hash: string }> = new Map();

  /**
   * Ring buffer of the last N range summaries, one per processBlockRange
   * call. Exposed via /health (HealthService.setServices wires it through
   * `details.recentRanges`) so operators can validate RangeCache hit-rate
   * trends without a metrics backend. Public read-only field — mutation
   * is single-threaded within processBlockRange.
   */
  private readonly RECENT_RANGE_STATS_LIMIT = 10;
  readonly recentRangeStats: Array<{
    fromBlock: number;
    toBlock: number;
    logCount: number;
    wallMs: number;
    cache: RangeCacheSummary;
    /**
     * Per-topic0 log counts captured at fetch time. Only includes topics
     * that actually appeared in the range. Surfaces unfiltered-mode
     * volume per topic so ops can detect when a topic is approaching the
     * byte/count caps BEFORE it breaches and triggers bisect.
     */
    topicCounts: Record<string, number>;
    fetchMode: string;
  }> = [];

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

  /**
   * M4: Clear in-memory block cache. Called from the reorg recovery path
   * because cached `{ timestamp, hash }` entries for blocks ≥ forkPoint
   * reflect the pre-reorg chain and would re-appear as stale results from
   * `getBlockTimestamp()` / the last-hash return in `processBlockRange`.
   */
  clearCaches(): void {
    this.blockCache.clear();
  }

  async processBlockRange(fromBlock: number, toBlock: number): Promise<{ lastBlockHash: string }> {
    if (fromBlock > toBlock) {
      throw new Error(`Invalid block range: fromBlock ${fromBlock} > toBlock ${toBlock}`);
    }
    logger.info({ fromBlock, toBlock }, 'Processing block range');

    // Per-range read cache. Shared across the initial pass AND discovery
    // re-fetches for this range so a DAO fetched in pass 1 is still warm
    // when pass 2 handles its newly-discovered navigator's events. Dies
    // with the function frame — cache CANNOT survive across ranges
    // (reorg-safety invariant, see RangeCache docstring).
    const cache = new RangeCache();
    // Option B — dirty-DAO set accumulated by Mint/Burn/Ragequit/Convert
    // handlers. Flushed into `ds_recompute_dao_totals` calls once per
    // distinct DAO at end-of-range. Bounded by distinct DAOs touched in
    // the range (at 10k DAOs, realistically ≤ a few dozen).
    const dirtyDaoIds = new Set<string>();
    // SignalNavigator Voted handlers add poll PKs here; flushed into
    // ds_recompute_poll_tally once per distinct poll at end-of-range (derive-from-truth).
    const dirtyPollIds = new Set<string>();
    // VestingNavigator TokensClaimed handlers add schedule PKs here; flushed into
    // ds_recompute_vesting_claimed once per distinct schedule at end-of-range (derive-from-truth).
    const dirtyVestingScheduleIds = new Set<string>();
    // BudgetNavigator Disbursed handlers add budget PKs here; flushed into
    // ds_recompute_budget_spent once per distinct budget at end-of-range (derive-from-truth).
    const dirtyBudgetIds = new Set<string>();
    // SubscriptionNavigator FeePaid handlers add member PKs here; flushed into
    // ds_recompute_subscription_paid once per distinct member at end-of-range (derive-from-truth).
    const dirtySubscriptionMemberIds = new Set<string>();
    // handleGovernanceConfigSet adds `${daoId}|${txHash}` here; flushed into
    // ds_resolve_timelock_bypass at end-of-range (after any same-tx ChangeExecuted is persisted).
    const dirtyTimelockBypassChecks = new Set<string>();
    const wallStart = Date.now();
    let totalLogCount = 0;
    // Per-topic0 counters populated from every successful fetch (initial
    // pass + discovery passes). Surfaced via /health so ops can watch the
    // volume-per-topic trend approach the U1/U6 caps.
    const topicCounts: Record<string, number> = {};
    const accumulateTopicCounts = (logs: Log[]): void => {
      for (const log of logs) {
        const topic0 = log.topics[0];
        if (topic0) topicCounts[topic0] = (topicCounts[topic0] ?? 0) + 1;
      }
    };

    // Snapshot registered addresses BEFORE fetching, so we can detect new
    // DAOs, tokens, and navigators discovered during processing.
    const knownAddresses = new Set([
      ...this.registry.getAllDaoShipAddresses(),
      ...this.registry.getAllTokenAddresses(),
      ...this.registry.getAllNavigatorAddresses(),
    ]);

    const allLogs = await this.fetchAllLogs(fromBlock, toBlock);
    totalLogCount += allLogs.length;
    accumulateTopicCounts(allLogs);
    await this.processLogs(allLogs, fromBlock, toBlock, cache, dirtyDaoIds, dirtyPollIds, dirtyVestingScheduleIds, dirtyBudgetIds, dirtySubscriptionMemberIds, dirtyTimelockBypassChecks);

    // After processing, check for newly discovered addresses. Loop because
    // processing new logs may register further addresses (e.g., NavigatorSet in
    // the second pass registers navigators whose events need a third pass).
    const MAX_DISCOVERY_PASSES = 3;
    let pass = 0;
    for (; pass < MAX_DISCOVERY_PASSES; pass++) {
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
        totalLogCount += additionalLogs.length;
        accumulateTopicCounts(additionalLogs);
        await this.processLogs(additionalLogs, fromBlock, toBlock, cache, dirtyDaoIds, dirtyPollIds, dirtyVestingScheduleIds, dirtyBudgetIds, dirtySubscriptionMemberIds, dirtyTimelockBypassChecks);
      }

      // Add discovered addresses to known set for next iteration
      for (const addr of newAddresses) knownAddresses.add(addr);
    }

    // S2: If the cap was reached AND new addresses are still being discovered,
    // events for those addresses have NOT been fetched yet. Silently advancing
    // lastProcessedBlock would permanently drop those events. Throw to fail
    // the block range so it retries — the retry starts with the now-expanded
    // registry and converges in at most 1 pass. Dedup via ds_processed_logs
    // prevents re-handling already-processed logs.
    if (pass === MAX_DISCOVERY_PASSES) {
      const currentAddresses = new Set([
        ...this.registry.getAllDaoShipAddresses(),
        ...this.registry.getAllTokenAddresses(),
        ...this.registry.getAllNavigatorAddresses(),
      ]);
      const stillNew = [...currentAddresses].filter(a => !knownAddresses.has(a));
      if (stillNew.length > 0) {
        logger.error(
          { fromBlock, toBlock, pendingCount: stillNew.length, sample: stillNew.slice(0, 5) },
          'Discovery pass limit reached with addresses still pending — failing range for retry',
        );
        throw new Error(
          `Discovery pass limit (${MAX_DISCOVERY_PASSES}) exceeded for range ${fromBlock}-${toBlock} ` +
          `with ${stillNew.length} new addresses still pending`,
        );
      }
    }

    // Option B P4.3: end-of-range flush of the dirty-DAO set. Mint, Burn,
    // Ragequit, ConvertSharesToLoot handlers add daoId → we recompute
    // total_shares / total_loot from ds_members source-of-truth, ONCE
    // per DAO. Idempotent by construction; replay yields identical state.
    // Errors are logged but don't fail the range — member balances (the
    // authoritative data) are already persisted by ds_apply_transfer.
    for (const daoId of dirtyDaoIds) {
      try {
        await this.db.recomputeDaoTotals(daoId);
        cache.invalidateDao(daoId);
      } catch (err) {
        logger.warn({ daoId, err }, 'Failed to recompute DAO totals — will retry on next range touching this DAO');
      }
    }

    // End-of-range flush of the dirty-poll set: derive each touched poll's per-option
    // tally from ds_signal_votes (idempotent; replay yields identical state). Errors are
    // logged but don't fail the range — the authoritative vote rows are already persisted.
    for (const pollPk of dirtyPollIds) {
      try {
        await this.db.recomputePollTally(pollPk);
      } catch (err) {
        logger.warn({ pollPk, err }, 'Failed to recompute poll tally — will retry on next range touching this poll');
      }
    }

    // End-of-range flush of the dirty vesting-schedule set: derive each touched schedule's
    // `claimed` from ds_vesting_claims (idempotent; replay yields identical state). Errors are
    // logged but don't fail the range — the authoritative claim rows are already persisted.
    for (const schedulePk of dirtyVestingScheduleIds) {
      try {
        await this.db.recomputeVestingClaimed(schedulePk);
      } catch (err) {
        logger.warn({ schedulePk, err }, 'Failed to recompute vesting claimed — will retry on next range touching this schedule');
      }
    }

    // End-of-range flush of the dirty budget set: derive each touched budget's cumulative
    // `total_spent` from ds_budget_disbursements (idempotent; replay yields identical state).
    // Errors are logged but don't fail the range — the authoritative disbursement rows are
    // already persisted. Budgets touched by a sanction backfill flow through here too (the
    // backfill shares this range's dirtyBudgetIds set).
    for (const budgetPk of dirtyBudgetIds) {
      try {
        await this.db.recomputeBudgetSpent(budgetPk);
      } catch (err) {
        logger.warn({ budgetPk, err }, 'Failed to recompute budget spent — will retry on next range touching this budget');
      }
    }

    // End-of-range flush of the dirty subscription-member set: derive each touched member's
    // cumulative `total_paid` from ds_subscription_payments (idempotent; replay yields identical
    // state). Errors are logged but don't fail the range — the authoritative payment rows are
    // already persisted.
    for (const memberPk of dirtySubscriptionMemberIds) {
      try {
        await this.db.recomputeSubscriptionPaid(memberPk);
      } catch (err) {
        logger.warn({ memberPk, err }, 'Failed to recompute subscription paid — will retry on next range touching this member');
      }
    }

    // End-of-range flush of timelock-bypass checks. Resolved AFTER all logs are persisted so a
    // ChangeExecuted that sorts after its paired GovernanceConfigSet is already on record.
    // Idempotent (derives the flag from current truth). Errors are logged, not fatal — the
    // GovernanceConfigSet row exists (bypassed_timelock defaults false) and will be re-resolved
    // if this DAO's config changes again.
    for (const check of dirtyTimelockBypassChecks) {
      const sep = check.indexOf('|');
      const daoId = check.slice(0, sep);
      const txHash = check.slice(sep + 1);
      try {
        await this.db.resolveTimelockBypass(daoId, txHash);
      } catch (err) {
        logger.warn({ daoId, txHash, err }, 'Failed to resolve timelock bypass — governance_config_history row keeps default bypassed_timelock=false');
      }
    }

    // Return the hash of the last block (may already be cached from getBlockTimestamp)
    let lastBlockHash = this.blockCache.get(toBlock)?.hash ?? '';
    if (!lastBlockHash) {
      try {
        const block = await this.blockchain.getBlock(toBlock);
        lastBlockHash = block?.hash ?? '';
      } catch (err) {
        logger.warn({ err, blockNumber: toBlock }, 'Failed to fetch block hash (best-effort for reorg detection)');
      }
    }

    // Emit cache efficacy + per-topic volume for this range. Logged + retained for /health.
    const summary = summarizeRangeCache(cache);
    const wallMs = Date.now() - wallStart;
    logger.info(
      { fromBlock, toBlock, logCount: totalLogCount, wallMs, cache: summary, topicCounts, fetchMode: config.fetch.mode },
      'Range processed',
    );
    this.recentRangeStats.push({
      fromBlock,
      toBlock,
      logCount: totalLogCount,
      wallMs,
      cache: summary,
      topicCounts,
      fetchMode: config.fetch.mode,
    });
    if (this.recentRangeStats.length > this.RECENT_RANGE_STATS_LIMIT) {
      this.recentRangeStats.shift();
    }

    return { lastBlockHash };
  }

  private async processLogs(
    logs: Log[],
    fromBlock: number,
    toBlock: number,
    cache: RangeCache,
    dirtyDaoIds: Set<string>,
    dirtyPollIds: Set<string>,
    dirtyVestingScheduleIds: Set<string>,
    dirtyBudgetIds: Set<string>,
    dirtySubscriptionMemberIds: Set<string>,
    dirtyTimelockBypassChecks: Set<string>,
  ): Promise<void> {
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

    // Option B P5.1 — accumulate (tx_hash, log_index) rows for end-of-range
    // batched markLogProcessed. Per-log marking is only used as a fallback
    // when any handler in the range is flagged non-idempotent; the flag
    // flips as we dispatch, and if it flips we flush the accumulated rows
    // with a batched upsert at the end anyway (the batched path is
    // idempotent via PK conflict). Under normal operation every handler
    // is idempotent → zero per-log markLogProcessed RTTs.
    const markBatch: Array<{ txHash: string; logIndex: number; blockNumber: number }> = [];
    let allIdempotent = true;

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
          cache,
          dirtyDaoIds,
          dirtyPollIds,
          dirtyVestingScheduleIds,
          dirtyBudgetIds,
          dirtySubscriptionMemberIds,
          dirtyTimelockBypassChecks,
        };

        const { handled, eventName, idempotent } = await this.dispatcher.dispatch(ctx);

        if (handled) {
          // Queue mark for batched end-of-range write. For non-idempotent
          // handlers (should be none post-Option-B) we fall back to
          // immediate per-log mark so a partial range failure doesn't
          // widen the replay window. The assertion at dispatch time
          // flips `allIdempotent` to false, which forces immediate mark
          // and disables batching for the remainder of this range.
          if (idempotent === false) {
            allIdempotent = false;
            await this.db.markLogProcessed(log.transactionHash, log.index, log.blockNumber);
          } else {
            markBatch.push({
              txHash: log.transactionHash,
              logIndex: log.index,
              blockNumber: log.blockNumber,
            });
          }

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
          // Transient error: flush whatever we've successfully processed so
          // far (safe because batch upsert is idempotent via PK conflict),
          // then re-throw so the block range retries. Without the flush,
          // already-handled logs would re-run on retry — wasteful but
          // still correct because every handler is idempotent.
          if (markBatch.length > 0) {
            try {
              await this.db.markLogsProcessedBatch(markBatch);
            } catch (flushErr) {
              logger.warn({ flushErr }, 'Failed to flush mark batch on transient error');
            }
          }
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

    // Option B P5.1 — batched end-of-range mark. Single RPC replaces one
    // RTT per handled log. Safe because (a) every handler is idempotent;
    // (b) `ds_apply_transfer` already self-dedups inside its transaction
    // so those rows are present in ds_processed_logs before this flush;
    // (c) the upsert uses `ignoreDuplicates` → flush is replay-safe too.
    if (markBatch.length > 0) {
      await this.db.markLogsProcessedBatch(markBatch);
    }
    if (!allIdempotent) {
      logger.warn(
        { fromBlock, toBlock },
        'Range contained a non-idempotent handler — batched markLogProcessed path was partially disabled',
      );
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
    const registeredTopics = this.dispatcher.getRegisteredTopics();
    const allLogs: Log[] = [];
    for (let i = 0; i < addresses.length; i += GET_LOGS_ADDRESS_CHUNK_SIZE) {
      const batch = addresses.slice(i, i + GET_LOGS_ADDRESS_CHUNK_SIZE);
      const logs = await this.fetchWithBisect(
        (from, to) => this.blockchain.getLogs(batch, from, to, [registeredTopics]),
        fromBlock,
        toBlock,
      );
      allLogs.push(...logs);
    }
    return allLogs;
  }

  /**
   * U1/U6 — oversize-aware getLogs wrapper. Blockchain layer throws an
   * "oversize response" error when a single getLogs return exceeds the
   * configured log-count or byte caps. We catch it, split the range in
   * half, and retry both halves. Keeps recursing until either the call
   * succeeds or the range can't be split further (single block over cap
   * — surface as hard error so the range fails for alerting).
   */
  private async fetchWithBisect(
    fetchFn: (from: number, to: number) => Promise<Log[]>,
    fromBlock: number,
    toBlock: number,
  ): Promise<Log[]> {
    try {
      return await fetchFn(fromBlock, toBlock);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('oversize response')) throw err;

      const rangeSize = toBlock - fromBlock + 1;
      if (rangeSize <= config.fetch.minBisectRange) {
        logger.error(
          { fromBlock, toBlock, err: msg },
          'Oversize getLogs response at minimum bisect range — cannot split further',
        );
        throw err;
      }

      const mid = fromBlock + Math.floor(rangeSize / 2) - 1;
      logger.warn(
        { fromBlock, toBlock, mid, reason: msg },
        'Bisecting range on oversize getLogs response',
      );
      const [left, right] = await Promise.all([
        this.fetchWithBisect(fetchFn, fromBlock, mid),
        this.fetchWithBisect(fetchFn, mid + 1, toBlock),
      ]);
      return [...left, ...right];
    }
  }

  /**
   * Topic + address log fetching — O(1) RPC calls regardless of DAO count.
   *
   * Queries by topic0 hashes (fixed set) AND known addresses (server-side).
   * This avoids pulling chain-wide Transfer events (topic0 0xddf252ad matches
   * every ERC20/ERC721 transfer). For most deployments with a few dozen DAOs +
   * tokens, a single getLogs call handles everything. If the address list grows
   * beyond RPC provider limits (~50-100), batch into multiple calls here.
   *
   * ── U4 (mid-range registration race) ────────────────────────
   * Note: this function does NOT pre-filter logs by the registered address
   * set. Handlers perform their own registry check on every log (e.g.,
   * `ctx.registry.getDaoByTokenAddress(...)` in `handleTransfer`) and
   * return early for unknown emitters. Because of that:
   *   - A log for an address registered mid-range is still dispatched;
   *     its handler just no-ops until the NavigatorDeployed /
   *     LaunchDAOShip fires earlier in the same range's sort order.
   *   - Discovery passes still re-fetch address-scoped topics for newly-
   *     registered addresses (see `fetchLogsForAddresses` above), which
   *     covers Transfer / Paused / Unpaused — the three topics we kept
   *     scoped.
   * If a future change adds a pre-filter here, U4 requires that the raw
   * unfiltered log set be retained and re-filtered after each discovery
   * pass rather than re-fetched.
   */
  private async fetchAllLogs(fromBlock: number, toBlock: number): Promise<Log[]> {
    // All topic0 hashes we care about — fixed set regardless of DAO count
    const registeredTopics = this.dispatcher.getRegisteredTopics();
    if (registeredTopics.length === 0) return [];

    // Topics that need unfiltered scanning (no address filter) — e.g. NavigatorDeployed
    const unfilteredTopics = this.dispatcher.getUnfilteredTopics();
    // Address-scoped topics: everything except unfiltered ones
    const scopedTopics = unfilteredTopics.length > 0
      ? registeredTopics.filter(t => !unfilteredTopics.includes(t))
      : registeredTopics;

    // All known addresses we want logs from
    const knownAddresses = new Set([
      ...Object.values(config.contracts),
      ...this.registry.getAllDaoShipAddresses(),
      ...this.registry.getAllTokenAddresses(),
      ...this.registry.getAllNavigatorAddresses(),
    ]);

    const allLogs: Log[] = [];

    // 1. Address-scoped fetch (the majority of events)
    if (scopedTopics.length > 0) {
      const addressFilter = [...knownAddresses];
      if (addressFilter.length <= GET_LOGS_ADDRESS_CHUNK_SIZE) {
        const logs = await this.fetchWithBisect(
          (from, to) => this.blockchain.getLogs(addressFilter, from, to, [scopedTopics]),
          fromBlock,
          toBlock,
        );
        allLogs.push(...logs);
      } else {
        for (let i = 0; i < addressFilter.length; i += GET_LOGS_ADDRESS_CHUNK_SIZE) {
          const batch = addressFilter.slice(i, i + GET_LOGS_ADDRESS_CHUNK_SIZE);
          const logs = await this.fetchWithBisect(
            (from, to) => this.blockchain.getLogs(batch, from, to, [scopedTopics]),
            fromBlock,
            toBlock,
          );
          allLogs.push(...logs);
        }
      }
    }

    // 2. Unfiltered fetch (global topic0 scan, no address filter). Most
    // exposed to oversize responses because it pulls every chain-wide
    // event matching our topics — the bisect is essential here.
    if (unfilteredTopics.length > 0) {
      const logs = await this.fetchWithBisect(
        (from, to) => this.blockchain.getLogs(null, from, to, [unfilteredTopics]),
        fromBlock,
        toBlock,
      );
      // Deduplicate: an unfiltered log may also match a known address from the scoped fetch
      const seen = new Set(allLogs.map(l => `${l.transactionHash}-${l.index}`));
      for (const log of logs) {
        const key = `${log.transactionHash}-${log.index}`;
        if (!seen.has(key)) {
          allLogs.push(log);
        }
      }
    }

    return allLogs;
  }

  private async getBlockTimestamp(blockNumber: number): Promise<number> {
    const cached = this.blockCache.get(blockNumber);
    if (cached !== undefined) {
      // Re-insert to maintain LRU order (moves to end of Map)
      this.blockCache.delete(blockNumber);
      this.blockCache.set(blockNumber, cached);
      return cached.timestamp;
    }

    const block = await this.blockchain.getBlock(blockNumber);
    if (!block) throw new Error(`Block ${blockNumber} not found`);

    // Use validated extraction — throws clear error instead of silently returning 0
    const timestamp = extractBlockTimestamp(block as unknown as Record<string, unknown>, blockNumber);

    // M1: Single LRU eviction for both timestamp and hash
    if (this.blockCache.size >= config.cache.timestampCacheSize) {
      const oldestKey = this.blockCache.keys().next().value;
      if (oldestKey !== undefined) {
        this.blockCache.delete(oldestKey);
      }
    }
    this.blockCache.set(blockNumber, { timestamp, hash: block.hash ?? '' });

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
