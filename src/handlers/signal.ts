import { Interface, type Log } from 'quais';
import type { EventContext } from './index.js';
import { bigintToString, safeBigInt } from '../utils/bigint.js';
import { logger } from '../utils/logger.js';
import { validateEventArgs, validateAndNormalizeAddress, extractBlockTimestamp } from '../utils/validation.js';
import { config, READ_ONLY_NAVIGATOR_TYPES } from '../config.js';

import SignalNavigatorAbi from '../abis/SignalNavigator.json' with { type: 'json' };

export const signalNavigatorIface = new Interface(SignalNavigatorAbi);

// ── SignalNavigator (read-only, non-binding polls) ─────────────────
// Three events stand alone (no Onboard, no NavigatorSet, no Paused):
//   PollCreated(uint256 pollId, address creator, string question, uint8 optionCount,
//               uint64 snapshotTimestamp, uint64 votingStarts, uint64 votingEnds)
//   Voted(uint256 pollId, address voter, uint8 option, uint256 weight)
//   PollCancelled(uint256 pollId, address caller)
//
// pollId is PER-NAVIGATOR (starts at 0). Rows are keyed (navigator_address, poll_id);
// the DAO is resolved from the navigator (the poll events don't carry it).
//
// MATERIALIZATION GATE (defer + backfill): polls/votes are written ONLY for navigators
// whose trust_status is 'sanctioned'. For any other status the handler returns without
// writing — the event is seen (and its log marked processed) but not materialized, so a
// flood of unsanctioned/fabricated navigators cannot bloat the signal tables. When a DAO
// later sanctions a navigator (vault daoships.dao.navigators post), backfillNavigatorPolls
// replays its history. Status is time-derived (no status column) — mirror pollStatus().

const QUESTION_MAX_LEN = 2000;

export function makePollPk(navigatorAddress: string, pollId: string): string {
  return `${navigatorAddress.toLowerCase()}-${pollId}`;
}

function makeVoteId(navigatorAddress: string, pollId: string, voter: string): string {
  return `${navigatorAddress.toLowerCase()}-${pollId}-${voter.toLowerCase()}`;
}

/** Strip null bytes + control chars and truncate — question is untrusted free text. */
function sanitizeQuestion(v: unknown): string {
  return String(v).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, '').slice(0, QUESTION_MAX_LEN);
}

/**
 * Materialization gate. Returns the resolved dao_id IFF the emitting navigator is
 * sanctioned; otherwise null and the caller defers (no write). Reads the single
 * ds_navigators row for the address (read-only navigators have exactly one).
 */
async function sanctionedDao(ctx: EventContext, navigatorAddress: string): Promise<string | null> {
  const nav = await ctx.db.getNavigatorTrust(navigatorAddress);
  if (!nav) return null;                          // NavigatorDeployed not indexed yet
  if (nav.trust_status !== 'sanctioned') return null;  // defer — backfilled on sanction
  return nav.dao_id;
}

// ── PollCreated ────────────────────────────────────────────────────

export async function handlePollCreated(
  ctx: EventContext,
  args: Record<string, unknown>,
): Promise<void> {
  validateEventArgs(
    args,
    ['pollId', 'creator', 'question', 'optionCount', 'snapshotTimestamp', 'votingStarts', 'votingEnds'],
    'PollCreated',
  );
  const navigatorAddress = ctx.log.address.toLowerCase();
  const daoId = await sanctionedDao(ctx, navigatorAddress);
  if (!daoId) {
    logger.debug({ navigatorAddress }, 'PollCreated: navigator not sanctioned — deferring (backfill on sanction)');
    return;
  }

  const pollId = bigintToString(safeBigInt(args.pollId));
  const creator = validateAndNormalizeAddress(args.creator, 'creator');
  const question = sanitizeQuestion(args.question);
  const optionCount = Number(safeBigInt(args.optionCount));
  const snapshotTimestamp = Number(safeBigInt(args.snapshotTimestamp));
  const votingStarts = Number(safeBigInt(args.votingStarts));
  const votingEnds = Number(safeBigInt(args.votingEnds));
  const now = new Date(ctx.blockTimestamp * 1000).toISOString();

  // NB: `cancelled` is intentionally OMITTED so the partial upsert never overwrites a
  // cancel applied in a later block when this PollCreated log is re-dispatched on retry.
  await ctx.db.upsert('ds_signal_polls', {
    id: makePollPk(navigatorAddress, pollId),
    dao_id: daoId,
    navigator_address: navigatorAddress,
    poll_id: pollId,
    creator,
    question,
    option_count: optionCount,
    snapshot_timestamp: snapshotTimestamp,
    voting_starts: votingStarts,
    voting_ends: votingEnds,
    tx_hash: ctx.log.transactionHash,
    block_number: ctx.log.blockNumber,
    created_at: now,
    updated_at: now,
  });

  logger.info({ navigatorAddress, daoId, pollId, optionCount }, 'PollCreated indexed');
}

// ── Voted ──────────────────────────────────────────────────────────

export async function handleVoted(
  ctx: EventContext,
  args: Record<string, unknown>,
): Promise<void> {
  validateEventArgs(args, ['pollId', 'voter', 'option', 'weight'], 'Voted');
  const navigatorAddress = ctx.log.address.toLowerCase();
  const daoId = await sanctionedDao(ctx, navigatorAddress);
  if (!daoId) {
    logger.debug({ navigatorAddress }, 'Voted: navigator not sanctioned — deferring (backfill on sanction)');
    return;
  }

  const pollId = bigintToString(safeBigInt(args.pollId));
  const voter = validateAndNormalizeAddress(args.voter, 'voter');
  const option = Number(safeBigInt(args.option));
  // weight is the voter's SHARE voting power at the snapshot — loot is already excluded
  // on-chain. Store the event value verbatim; never re-derive from current balances.
  const weight = bigintToString(safeBigInt(args.weight));
  const pollPk = makePollPk(navigatorAddress, pollId);
  const now = new Date(ctx.blockTimestamp * 1000).toISOString();

  // The unique (navigator, poll, voter) key makes replay/reorg idempotent (one vote per
  // address on-chain). poll_pk FK requires the parent poll row — PollCreated always
  // precedes Voted on-chain and the backfill replays in (block, logIndex) order, so it
  // exists. A missing parent surfaces as a deterministic FK error (logged + skipped).
  await ctx.db.upsert('ds_signal_votes', {
    id: makeVoteId(navigatorAddress, pollId, voter),
    poll_pk: pollPk,
    dao_id: daoId,
    navigator_address: navigatorAddress,
    poll_id: pollId,
    voter,
    option,
    weight,
    tx_hash: ctx.log.transactionHash,
    block_number: ctx.log.blockNumber,
    created_at: now,
  });

  // Defer the per-option tally to the end-of-range derive-from-truth recompute
  // (ds_recompute_poll_tally) — never increment inline (would double-count on replay).
  ctx.dirtyPollIds.add(pollPk);

  logger.info({ navigatorAddress, daoId, pollId, voter, option }, 'Voted indexed');
}

// ── PollCancelled ──────────────────────────────────────────────────

export async function handlePollCancelled(
  ctx: EventContext,
  args: Record<string, unknown>,
): Promise<void> {
  validateEventArgs(args, ['pollId', 'caller'], 'PollCancelled');
  const navigatorAddress = ctx.log.address.toLowerCase();
  const daoId = await sanctionedDao(ctx, navigatorAddress);
  if (!daoId) {
    logger.debug({ navigatorAddress }, 'PollCancelled: navigator not sanctioned — deferring (backfill on sanction)');
    return;
  }

  const pollId = bigintToString(safeBigInt(args.pollId));
  const pollPk = makePollPk(navigatorAddress, pollId);
  const now = new Date(ctx.blockTimestamp * 1000).toISOString();

  // Targeted UPDATE (never insert): a cancel for a non-materialized poll is a no-op.
  await ctx.db.markPollCancelled(pollPk, now);

  logger.info({ navigatorAddress, daoId, pollId }, 'PollCancelled indexed');
}

// ═══════════════════════════════════════════════════════════════════
// Sanctioning (daoships.dao.navigators) — full-set, last-write-wins
// ═══════════════════════════════════════════════════════════════════
//
// Called from the poster handler after the VERIFIED (msg.sender == vault) trust gate.
// `listed` is the DAO's COMPLETE sanctioned read-only-navigator set as of this post.

export async function reconcileSanctionedNavigators(
  ctx: EventContext,
  daoId: string,
  vault: string,
  listed: Array<{ address: string; type?: string }>,
): Promise<void> {
  const now = new Date(ctx.blockTimestamp * 1000).toISOString();
  const dao = daoId.toLowerCase();
  const listedAddrs = new Set(listed.map((n) => n.address.toLowerCase()));

  // Prior sanctioned read-only set for this DAO (permissioned navs are 'sanctioned' via
  // NavigatorSet — filter them out so we never touch them here).
  const current = await ctx.db.listSanctionedNavigators(dao);
  const currentReadOnly = current.filter(
    (n) => n.navigator_type !== null && READ_ONLY_NAVIGATOR_TYPES.has(n.navigator_type),
  );
  const currentAddrs = new Set(currentReadOnly.map((n) => n.navigator_address.toLowerCase()));

  // Reset held intents for this DAO (last-write-wins), then re-add for any unseen listed addr.
  await ctx.db.deleteSanctionIntentsForDao(dao);

  // 1. Sanction listed read-only navigators bound to THIS dao; hold an intent for unseen ones.
  for (const addr of listedAddrs) {
    const nav = await ctx.db.getNavigatorTrust(addr);
    if (!nav) {
      // Ordering: sanctioned before its NavigatorDeployed was indexed — hold and apply later.
      await ctx.db.writeSanctionIntent(dao, addr, vault, now);
      logger.info({ daoId: dao, navigatorAddress: addr }, 'Sanction: navigator not yet seen — holding intent');
      continue;
    }
    // Scoping guard: only a read-only navigator whose NavigatorDeployed.daoShip == this DAO.
    const isReadOnly = nav.navigator_type !== null && READ_ONLY_NAVIGATOR_TYPES.has(nav.navigator_type);
    if (!isReadOnly || (nav.dao_id ?? '').toLowerCase() !== dao) {
      logger.warn(
        { daoId: dao, navigatorAddress: addr, navDao: nav.dao_id, navType: nav.navigator_type },
        'Sanction: address out of scope (different DAO / not a read-only type) — ignoring',
      );
      continue;
    }
    if (nav.trust_status !== 'sanctioned') {
      await ctx.db.setNavigatorTrust(dao, addr, 'sanctioned', now);
      logger.info({ daoId: dao, navigatorAddress: addr }, 'Sanction: → sanctioned, backfilling poll history');
      await backfillNavigatorPolls(ctx, addr);
    }
  }

  // 2. De-sanction previously-sanctioned read-only navigators now absent from the list.
  for (const addr of currentAddrs) {
    if (!listedAddrs.has(addr)) {
      await ctx.db.setNavigatorTrust(dao, addr, 'unsanctioned', now);
      logger.info({ daoId: dao, navigatorAddress: addr }, 'Sanction: → unsanctioned (omitted from latest list)');
    }
  }
}

// ── Materialize-on-sanction backfill ───────────────────────────────
// Replays a navigator's PollCreated/Voted/PollCancelled history through the live
// handlers (which now pass the sanction gate) so its polls land in the signal tables.
// Re-fetches by address over deploy_block..head (chunked); upserts are idempotent, so
// any rows already written by the live path are no-ops. Also reusable as a repair entry.

export async function backfillNavigatorPolls(ctx: EventContext, navigatorAddress: string): Promise<void> {
  const addr = navigatorAddress.toLowerCase();
  const nav = await ctx.db.getNavigatorTrust(addr);
  if (!nav) return;
  const fromBlock = nav.deploy_block ?? config.startBlock;

  let head: number;
  try {
    head = (await ctx.blockchain.getBlockNumber()) - config.confirmationBlocks;
  } catch (err) {
    logger.warn({ navigatorAddress: addr, err }, 'backfillNavigatorPolls: failed to read chain head — skipping (retry on next sanction)');
    return;
  }
  if (head < fromBlock) return;

  const tPollCreated = signalNavigatorIface.getEvent('PollCreated')!.topicHash;
  const tVoted = signalNavigatorIface.getEvent('Voted')!.topicHash;
  const tPollCancelled = signalNavigatorIface.getEvent('PollCancelled')!.topicHash;
  const topics: Array<string | string[]> = [[tPollCreated, tVoted, tPollCancelled]];

  const tsCache = new Map<number, number>();
  let processed = 0;
  const STEP = config.maxBlockRange;

  // Chunk by maxBlockRange to stay under the getLogs oversize cap. Chunks are ascending,
  // and we sort within each chunk, so PollCreated is always applied before its Voted/Cancel.
  for (let start = fromBlock; start <= head; start += STEP) {
    const end = Math.min(start + STEP - 1, head);
    let logs: Log[];
    try {
      logs = await ctx.blockchain.getLogs([addr], start, end, topics);
    } catch (err) {
      logger.warn({ navigatorAddress: addr, start, end, err }, 'backfillNavigatorPolls: getLogs failed for chunk — skipping chunk');
      continue;
    }
    logs.sort((a, b) => {
      if (a.blockNumber !== b.blockNumber) return a.blockNumber - b.blockNumber;
      if (a.transactionIndex !== b.transactionIndex) return a.transactionIndex - b.transactionIndex;
      return a.index - b.index;
    });

    for (const log of logs) {
      const topic0 = log.topics[0];
      const handler =
        topic0 === tPollCreated ? handlePollCreated :
        topic0 === tVoted ? handleVoted :
        topic0 === tPollCancelled ? handlePollCancelled : null;
      if (!handler) continue;

      let parsed;
      try {
        parsed = signalNavigatorIface.parseLog({ topics: log.topics as string[], data: log.data });
      } catch {
        continue;
      }
      if (!parsed) continue;

      let blockTs = tsCache.get(log.blockNumber);
      if (blockTs === undefined) {
        const block = await ctx.blockchain.getBlock(log.blockNumber).catch(() => null);
        blockTs = block
          ? extractBlockTimestamp(block as unknown as Record<string, unknown>, log.blockNumber)
          : ctx.blockTimestamp;
        tsCache.set(log.blockNumber, blockTs);
      }

      // Synthetic context: reuse db/blockchain/registry/cache/dirty-sets; swap log + timestamp.
      const childCtx: EventContext = { ...ctx, log, blockTimestamp: blockTs };
      try {
        await handler(childCtx, parsed.args);
        processed++;
      } catch (err) {
        logger.warn({ navigatorAddress: addr, txHash: log.transactionHash, err }, 'backfillNavigatorPolls: handler error on a log — continuing');
      }
    }
  }

  logger.info({ navigatorAddress: addr, fromBlock, head, processed }, 'backfillNavigatorPolls: complete');
}
