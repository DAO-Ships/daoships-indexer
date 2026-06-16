import { Interface, type Log } from 'quais';
import type { EventContext } from './index.js';
import { bigintToString, safeBigInt } from '../utils/bigint.js';
import { logger } from '../utils/logger.js';
import { validateEventArgs, validateAndNormalizeAddress, extractBlockTimestamp } from '../utils/validation.js';
import { config } from '../config.js';

import BudgetNavigatorAbi from '../abis/BudgetNavigator.json' with { type: 'json' };

export const budgetNavigatorIface = new Interface(BudgetNavigatorAbi);

// ── BudgetNavigator (treasury-disbursement, vault-MODULE authority) ─────────────────
// Four events on a per-navigator budgetId (starts at 0):
//   BudgetCreated(uint256 budgetId, address manager, address token, uint256 allowancePerPeriod,
//                 uint256 totalCeiling, uint64 periodLength, uint64 startsAt, uint64 endsAt)
//   Disbursed(uint256 budgetId, address to, address token, uint256 amount)
//   ManagerUpdated(uint256 budgetId, address oldManager, address newManager)
//   BudgetCancelled(uint256 budgetId, address caller)
//
// Budgets are keyed {navigator_address}-{budget_id}; the DAO is resolved from the navigator
// (the events don't carry it). budgetId is PER-NAVIGATOR.
//
// MATERIALIZATION GATE (defer + backfill) — identical posture to SignalNavigator, but the
// sanctioning signal is the vault's EnabledModule event (see handlers/vault-modules.ts), NOT
// a Poster post. Budgets/disbursements are written ONLY for navigators whose trust_status is
// 'sanctioned' (the vault enabled the module). For any other status the handler returns without
// writing — the event is seen (its log marked processed) but not materialized, so a flood of
// never-enabled budget navigators claiming any DAO cannot bloat the tables or inject treasury
// activity into a DAO's feed. When the vault later enables a navigator, backfillNavigatorBudgets
// replays its history. Period / remaining are time-derived from the contract views in the app.
//
// `total_spent` is DERIVE-FROM-TRUTH: each Disbursed appends a row and flags the budget dirty;
// the processor recomputes total_spent = SUM(disbursements.amount) once per touched budget at
// end-of-range (ds_recompute_budget_spent). NEVER `+= amount` inline (double-counts on replay).
// Treasury BALANCES come from the paired vault Transfer in the same tx, NOT from Disbursed.

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/** Budget token may be the zero address (native QUAI), which is not a valid shard address. */
function normalizeTokenAddress(v: unknown): string {
  if (typeof v === 'string' && v.toLowerCase() === ZERO_ADDRESS) return ZERO_ADDRESS;
  return validateAndNormalizeAddress(v, 'token');
}

function makeBudgetPk(navigatorAddress: string, budgetId: string): string {
  return `${navigatorAddress.toLowerCase()}-${budgetId}`;
}

function makeDisbursementId(navigatorAddress: string, budgetId: string, txHash: string, logIndex: number): string {
  return `${navigatorAddress.toLowerCase()}-${budgetId}-${txHash}-${logIndex}`;
}

/**
 * Materialization gate. Returns the resolved dao_id IFF the emitting navigator is a
 * sanctioned BudgetNavigator (the vault enabled it); otherwise null and the caller defers
 * (no write). A budget navigator has exactly one ds_navigators row.
 */
async function sanctionedDao(ctx: EventContext, navigatorAddress: string): Promise<string | null> {
  const nav = await ctx.db.getNavigatorTrust(navigatorAddress);
  if (!nav) return null;                               // NavigatorDeployed not indexed yet
  if (nav.trust_status !== 'sanctioned') return null;  // defer — backfilled on EnabledModule
  return nav.dao_id;
}

// ── BudgetCreated ───────────────────────────────────────────────────────────────────

export async function handleBudgetCreated(
  ctx: EventContext,
  args: Record<string, unknown>,
): Promise<void> {
  validateEventArgs(
    args,
    ['budgetId', 'manager', 'token', 'allowancePerPeriod', 'totalCeiling', 'periodLength', 'startsAt', 'endsAt'],
    'BudgetCreated',
  );
  const navigatorAddress = ctx.log.address.toLowerCase();
  const daoId = await sanctionedDao(ctx, navigatorAddress);
  if (!daoId) {
    logger.debug({ navigatorAddress }, 'BudgetCreated: navigator not sanctioned — deferring (backfill on EnabledModule)');
    return;
  }

  const budgetId = bigintToString(safeBigInt(args.budgetId));
  const manager = validateAndNormalizeAddress(args.manager, 'manager');
  const token = normalizeTokenAddress(args.token);
  const allowancePerPeriod = bigintToString(safeBigInt(args.allowancePerPeriod));
  const totalCeiling = bigintToString(safeBigInt(args.totalCeiling));
  const periodLength = Number(safeBigInt(args.periodLength));
  const startsAt = Number(safeBigInt(args.startsAt));   // absolute (contract resolves 0 → creation block)
  const endsAt = Number(safeBigInt(args.endsAt));       // 0 = perpetual
  const now = new Date(ctx.blockTimestamp * 1000).toISOString();

  // NB: `total_spent` is OMITTED (derive-from-truth via ds_recompute_budget_spent) and
  // `cancelled` is OMITTED so a re-dispatch of BudgetCreated never clobbers a later
  // BudgetCancelled or the derived spend total. On first INSERT both take column DEFAULTs
  // (total_spent=0, cancelled=false). `manager` IS written here (creation-time value, NOT
  // NULL); a later ManagerUpdated is a targeted UPDATE — logs are applied in (block, tx,
  // logIndex) order both live and in backfill, so BudgetCreated never re-runs after a
  // ManagerUpdated out of order.
  await ctx.db.upsert('ds_budgets', {
    id: makeBudgetPk(navigatorAddress, budgetId),
    dao_id: daoId,
    navigator_address: navigatorAddress,
    budget_id: budgetId,
    manager,
    token,
    allowance_per_period: allowancePerPeriod,
    total_ceiling: totalCeiling,
    period_length: periodLength,
    starts_at: startsAt,
    ends_at: endsAt,
    tx_hash: ctx.log.transactionHash,
    block_number: ctx.log.blockNumber,
    created_at: now,
    updated_at: now,
  });

  logger.info({ navigatorAddress, daoId, budgetId, manager, token }, 'BudgetCreated indexed');
}

// ── Disbursed ───────────────────────────────────────────────────────────────────────

export async function handleDisbursed(
  ctx: EventContext,
  args: Record<string, unknown>,
): Promise<void> {
  validateEventArgs(args, ['budgetId', 'to', 'token', 'amount'], 'Disbursed');
  const navigatorAddress = ctx.log.address.toLowerCase();
  const daoId = await sanctionedDao(ctx, navigatorAddress);
  if (!daoId) {
    logger.debug({ navigatorAddress }, 'Disbursed: navigator not sanctioned — deferring (backfill on EnabledModule)');
    return;
  }

  const budgetId = bigintToString(safeBigInt(args.budgetId));
  const recipient = validateAndNormalizeAddress(args.to, 'to');
  const token = normalizeTokenAddress(args.token);
  const amount = bigintToString(safeBigInt(args.amount));
  const budgetPk = makeBudgetPk(navigatorAddress, budgetId);
  const now = new Date(ctx.blockTimestamp * 1000).toISOString();

  // Append-only feed row keyed by (navigator, budget, tx, logIndex) → idempotent on
  // replay/reorg (disburseBatch emits N Disbursed in one tx, distinguished by logIndex).
  // The budget_pk FK requires the parent budget row; BudgetCreated always precedes on-chain
  // and the backfill replays in (block, tx, logIndex) order, so it exists. A missing parent
  // surfaces as a deterministic FK error (logged + skipped by the processor).
  await ctx.db.upsert('ds_budget_disbursements', {
    id: makeDisbursementId(navigatorAddress, budgetId, ctx.log.transactionHash, ctx.log.index),
    budget_pk: budgetPk,
    dao_id: daoId,
    navigator_address: navigatorAddress,
    budget_id: budgetId,
    recipient,
    token,
    amount,
    tx_hash: ctx.log.transactionHash,
    block_number: ctx.log.blockNumber,
    created_at: now,
  });

  // Defer the cumulative total_spent recompute to the end-of-range derive-from-truth flush
  // (ds_recompute_budget_spent) — never increment inline (would double-count on replay).
  ctx.dirtyBudgetIds.add(budgetPk);

  logger.info({ navigatorAddress, daoId, budgetId, recipient, amount }, 'Disbursed indexed');
}

// ── ManagerUpdated ────────────────────────────────────────────────────────────────────

export async function handleManagerUpdated(
  ctx: EventContext,
  args: Record<string, unknown>,
): Promise<void> {
  validateEventArgs(args, ['budgetId', 'oldManager', 'newManager'], 'ManagerUpdated');
  const navigatorAddress = ctx.log.address.toLowerCase();
  const daoId = await sanctionedDao(ctx, navigatorAddress);
  if (!daoId) {
    logger.debug({ navigatorAddress }, 'ManagerUpdated: navigator not sanctioned — deferring (backfill on EnabledModule)');
    return;
  }

  const budgetId = bigintToString(safeBigInt(args.budgetId));
  const newManager = validateAndNormalizeAddress(args.newManager, 'newManager');
  const now = new Date(ctx.blockTimestamp * 1000).toISOString();

  // Targeted UPDATE (never insert): a manager change for a non-materialized budget is a no-op.
  await ctx.db.updateBudget(makeBudgetPk(navigatorAddress, budgetId), { manager: newManager, updated_at: now });

  logger.info({ navigatorAddress, daoId, budgetId, newManager }, 'ManagerUpdated indexed');
}

// ── BudgetCancelled ───────────────────────────────────────────────────────────────────

export async function handleBudgetCancelled(
  ctx: EventContext,
  args: Record<string, unknown>,
): Promise<void> {
  validateEventArgs(args, ['budgetId', 'caller'], 'BudgetCancelled');
  const navigatorAddress = ctx.log.address.toLowerCase();
  const daoId = await sanctionedDao(ctx, navigatorAddress);
  if (!daoId) {
    logger.debug({ navigatorAddress }, 'BudgetCancelled: navigator not sanctioned — deferring (backfill on EnabledModule)');
    return;
  }

  const budgetId = bigintToString(safeBigInt(args.budgetId));
  const now = new Date(ctx.blockTimestamp * 1000).toISOString();

  // Targeted UPDATE (never insert): irreversible. A cancel for a non-materialized budget is a no-op.
  await ctx.db.updateBudget(makeBudgetPk(navigatorAddress, budgetId), { cancelled: true, updated_at: now });

  logger.info({ navigatorAddress, daoId, budgetId }, 'BudgetCancelled indexed');
}

// ── Materialize-on-enable backfill ─────────────────────────────────────────────────────
// Replays a navigator's BudgetCreated/Disbursed/ManagerUpdated/BudgetCancelled history through
// the live handlers (which now pass the sanction gate) so its budgets land in the tables.
// Re-fetches by address over deploy_block..head (chunked); upserts are idempotent, so any rows
// already written by the live path are no-ops. Mirror of signal.ts backfillNavigatorPolls. The
// disbursements it replays flow into ctx.dirtyBudgetIds (shared Set) → recomputed at end-of-range.

export async function backfillNavigatorBudgets(ctx: EventContext, navigatorAddress: string): Promise<void> {
  const addr = navigatorAddress.toLowerCase();
  const nav = await ctx.db.getNavigatorTrust(addr);
  if (!nav) return;
  const fromBlock = nav.deploy_block ?? config.startBlock;

  let head: number;
  try {
    head = (await ctx.blockchain.getBlockNumber()) - config.confirmationBlocks;
  } catch (err) {
    logger.warn({ navigatorAddress: addr, err }, 'backfillNavigatorBudgets: failed to read chain head — skipping (retry on next enable)');
    return;
  }
  if (head < fromBlock) return;

  const tCreated = budgetNavigatorIface.getEvent('BudgetCreated')!.topicHash;
  const tDisbursed = budgetNavigatorIface.getEvent('Disbursed')!.topicHash;
  const tManager = budgetNavigatorIface.getEvent('ManagerUpdated')!.topicHash;
  const tCancelled = budgetNavigatorIface.getEvent('BudgetCancelled')!.topicHash;
  const topics: Array<string | string[]> = [[tCreated, tDisbursed, tManager, tCancelled]];

  const tsCache = new Map<number, number>();
  let processed = 0;
  const STEP = config.maxBlockRange;

  // Chunk by maxBlockRange to stay under the getLogs oversize cap. Chunks are ascending, and
  // we sort within each chunk, so BudgetCreated is always applied before its Disbursed/etc.
  for (let start = fromBlock; start <= head; start += STEP) {
    const end = Math.min(start + STEP - 1, head);
    let logs: Log[];
    try {
      logs = await ctx.blockchain.getLogs([addr], start, end, topics);
    } catch (err) {
      logger.warn({ navigatorAddress: addr, start, end, err }, 'backfillNavigatorBudgets: getLogs failed for chunk — skipping chunk');
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
        topic0 === tCreated ? handleBudgetCreated :
        topic0 === tDisbursed ? handleDisbursed :
        topic0 === tManager ? handleManagerUpdated :
        topic0 === tCancelled ? handleBudgetCancelled : null;
      if (!handler) continue;

      let parsed;
      try {
        parsed = budgetNavigatorIface.parseLog({ topics: log.topics as string[], data: log.data });
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
        logger.warn({ navigatorAddress: addr, txHash: log.transactionHash, err }, 'backfillNavigatorBudgets: handler error on a log — continuing');
      }
    }
  }

  logger.info({ navigatorAddress: addr, fromBlock, head, processed }, 'backfillNavigatorBudgets: complete');
}
