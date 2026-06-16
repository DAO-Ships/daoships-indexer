import type { Log, Interface } from 'quais';
import type { DatabaseService } from '../services/database.js';
import type { BlockchainService } from '../services/blockchain.js';
import type { ContractRegistry } from '../registry/contract-registry.js';
import type { RangeCache } from '../services/range-cache.js';
import { config } from '../config.js';

export interface EventContext {
  log: Log;
  blockTimestamp: number; // Unix seconds
  db: DatabaseService;
  blockchain: BlockchainService;
  registry: ContractRegistry;
  /**
   * Per-`processBlockRange` read cache for `ds_members` and `ds_daos`.
   * Handlers should route `getMember` / `getDao` through `cache.fetchMember`
   * / `cache.fetchDao`, and invalidate (or `setMember` with a full row)
   * AFTER any write succeeds. See `services/range-cache.ts` for the full
   * contract.
   */
  cache: RangeCache;
  /**
   * Option B — dirty-DAO set. Mint/Burn/Ragequit/Convert handlers add a
   * `dao_id` here instead of calling the non-idempotent `adjustDaoTotals`
   * RPC. After all logs in the range are processed, the processor calls
   * `ds_recompute_dao_totals(dao_id)` ONCE per entry — derives
   * total_shares / total_loot from source-of-truth ds_members data. The
   * recompute is idempotent by construction and the N-way flush is
   * bounded by distinct DAOs touched in the range.
   */
  dirtyDaoIds: Set<string>;
  /**
   * Dirty-poll set — the SignalNavigator Voted handler adds a poll PK
   * (`{navigator}-{pollId}`) here instead of incrementing the per-option tally
   * inline (which would double-count on replay). After all logs in the range are
   * processed, the processor calls `ds_recompute_poll_tally(poll_pk)` ONCE per
   * entry, deriving the tally from the source-of-truth ds_signal_votes rows.
   * Mirrors `dirtyDaoIds` → `ds_recompute_dao_totals`.
   */
  dirtyPollIds: Set<string>;
  /**
   * Dirty vesting-schedule set — the VestingNavigator TokensClaimed handler adds a
   * schedule PK (`{navigator}-{scheduleId}`) here instead of incrementing `claimed`
   * inline (TokensClaimed.amount is incremental → inline += double-counts on replay).
   * After all logs in the range are processed, the processor calls
   * `ds_recompute_vesting_claimed(schedule_pk)` ONCE per entry, deriving `claimed` from
   * the source-of-truth ds_vesting_claims rows. Mirrors `dirtyPollIds`.
   */
  dirtyVestingScheduleIds: Set<string>;
  /**
   * Dirty budget set — the BudgetNavigator Disbursed handler adds a budget PK
   * (`{navigator}-{budgetId}`) here instead of incrementing `total_spent` inline
   * (Disbursed.amount is per-payout → inline += double-counts on replay). After all
   * logs in the range are processed, the processor calls
   * `ds_recompute_budget_spent(budget_pk)` ONCE per entry, deriving `total_spent` from
   * the source-of-truth ds_budget_disbursements rows. Mirrors `dirtyVestingScheduleIds`.
   */
  dirtyBudgetIds: Set<string>;
  /**
   * Dirty subscription-member set — the SubscriptionNavigator FeePaid handler adds a member PK
   * (`{navigator}-{member}`) here instead of incrementing `total_paid` inline (FeePaid.amount is
   * per-payment → inline += double-counts on replay). After all logs in the range are processed,
   * the processor calls `ds_recompute_subscription_paid(member_pk)` ONCE per entry, deriving
   * `total_paid` from the source-of-truth ds_subscription_payments rows. Mirrors `dirtyBudgetIds`.
   */
  dirtySubscriptionMemberIds: Set<string>;
  /**
   * Timelock-bypass check set — handleGovernanceConfigSet adds `${daoId}|${txHash}` here.
   * After the range is processed (so any paired TimelockNavigator.ChangeExecuted in the same
   * tx — which may sort after the GovernanceConfigSet — is persisted), the processor calls
   * `ds_resolve_timelock_bypass(daoId, txHash)` ONCE per entry to flag direct
   * setGovernanceConfig calls that skipped an active timelock.
   */
  dirtyTimelockBypassChecks: Set<string>;
}

export type EventHandler = (ctx: EventContext, parsedArgs: Record<string, unknown>) => Promise<void>;

/**
 * Per-handler registration options.
 *
 * - `unfiltered` — if true, this topic0 is fetched chain-wide (no
 *   address filter) and the handler filters in-process. See
 *   `docs/PERF_BATCH_DB_ROUNDTRIPS.md` §0.4.
 *
 * - `idempotent` — if true, the handler guarantees replay safety: calling
 *   it N times on the same log produces the same end state as calling it
 *   once. This is the prerequisite for end-of-range batching of
 *   `markLogProcessed` (Option B). Handlers that write balance math via
 *   `ds_apply_transfer`-style transactional RPCs are idempotent. Handlers
 *   that derive-from-truth (e.g. `ds_increment_proposal_votes`) are also
 *   idempotent. Delta-based handlers (old Mint/Burn via `adjustDaoTotals`)
 *   are NOT — those must be rewritten before being marked true.
 *
 *   The processor fails closed: if ANY log dispatched in a range hits a
 *   handler marked `idempotent: false`, batched `markLogProcessed` is
 *   disabled for the range and the per-log path runs instead. Treat
 *   `idempotent: false` as an opt-out — every handler ships with `true`.
 */
export interface HandlerOptions {
  unfiltered?: boolean;
  idempotent?: boolean;
}

interface HandlerEntry {
  iface: Interface;
  eventName: string;
  handler: EventHandler;
  idempotent: boolean;
}

export class HandlerDispatcher {
  private handlers: Map<string, HandlerEntry> = new Map();
  private unfilteredTopicSet: Set<string> = new Set();

  /**
   * Register a handler. Defaults: `unfiltered=false`, `idempotent=true`.
   * Idempotency defaults TO true so the batched `markLogProcessed` path
   * is usable immediately after Option B ships. A handler that is
   * genuinely not idempotent MUST pass `{ idempotent: false }` and be
   * fixed before shipping.
   *
   * Legacy 4-arg form `registerHandler(iface, event, handler, unfiltered)`
   * is still accepted for call-site compatibility with the unfiltered
   * flip.
   */
  registerHandler(
    iface: Interface,
    eventName: string,
    handler: EventHandler,
    unfilteredOrOpts: boolean | HandlerOptions = false,
  ): void {
    const opts: HandlerOptions = typeof unfilteredOrOpts === 'boolean'
      ? { unfiltered: unfilteredOrOpts }
      : unfilteredOrOpts;

    const fragment = iface.getEvent(eventName);
    if (!fragment) throw new Error(`Event ${eventName} not found in interface`);
    const topic0 = fragment.topicHash;

    if (this.handlers.has(topic0)) {
      const existing = this.handlers.get(topic0)!;
      throw new Error(`Topic0 collision: ${topic0} already registered as "${existing.eventName}", cannot register "${eventName}"`);
    }

    this.handlers.set(topic0, {
      iface,
      eventName,
      handler,
      idempotent: opts.idempotent ?? true,
    });
    if (opts.unfiltered) this.unfilteredTopicSet.add(topic0);
  }

  async dispatch(ctx: EventContext): Promise<{ handled: boolean; eventName?: string; idempotent?: boolean }> {
    const topic0 = ctx.log.topics[0];
    if (!topic0) return { handled: false };

    const entry = this.handlers.get(topic0);
    if (!entry) return { handled: false };

    const parsed = entry.iface.parseLog({
      topics: ctx.log.topics as string[],
      data: ctx.log.data,
    });
    if (!parsed) return { handled: false };

    // Let handler errors propagate to the processor's transient/deterministic
    // classification (processor.ts processLogs). The processor owns error
    // handling — transient errors fail the block range for retry, deterministic
    // errors are logged and skipped.
    await entry.handler(ctx, parsed.args);
    return { handled: true, eventName: entry.eventName, idempotent: entry.idempotent };
  }

  /** Exposed for tests and for the processor's idempotency assertion. */
  isHandlerIdempotent(topic0: string): boolean | undefined {
    return this.handlers.get(topic0)?.idempotent;
  }

  getRegisteredTopics(): string[] {
    return Array.from(this.handlers.keys());
  }

  /**
   * Returns the set of topics to fetch unfiltered (chain-wide, no address
   * filter), computed from:
   *   1. FETCH_MODE env: `scoped` → none, `unfiltered` → all, `hybrid` →
   *      respect per-handler registration.
   *   2. UNFILTERED_TOPICS env override list, always union'd in (lets ops
   *      flip a specific topic without a code change).
   */
  getUnfilteredTopics(): string[] {
    const mode = config.fetch.mode;
    if (mode === 'scoped') {
      // Even in full scoped mode, the override list is honored — that's
      // the whole point of the override.
      const overrides = config.fetch.unfilteredTopics.filter((t) => this.handlers.has(t));
      return overrides;
    }
    const base = mode === 'unfiltered'
      ? Array.from(this.handlers.keys())
      : Array.from(this.unfilteredTopicSet);
    const overrideSet = new Set(config.fetch.unfilteredTopics);
    for (const t of base) overrideSet.add(t);
    // Filter to only registered topics — an override for an unknown topic
    // hash is a no-op.
    return Array.from(overrideSet).filter((t) => this.handlers.has(t));
  }
}
