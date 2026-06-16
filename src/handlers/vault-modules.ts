import { Interface } from 'quais';
import type { EventContext } from './index.js';
import { logger } from '../utils/logger.js';
import { validateEventArgs, validateAndNormalizeAddress } from '../utils/validation.js';
import { MODULE_NAVIGATOR_TYPES } from '../config.js';
import { backfillNavigatorBudgets } from './budget.js';

import IAvatarModulesAbi from '../abis/IAvatarModules.json' with { type: 'json' };

export const avatarModulesIface = new Interface(IAvatarModulesAbi);

// ── Vault (QuaiVault / IAvatar) module events — the BudgetNavigator trust source ──────
//   EnabledModule(address indexed module)
//   DisabledModule(address indexed module)
//
// These are the Gnosis-Safe/Zodiac standard module events, emitted by EVERY safe on chain, so
// they are fetched UNFILTERED (chain-wide topic0 scan) and this handler is an AUTHENTICATED
// FILTER. A BudgetNavigator holds NO DAOShip permission (no NavigatorSet) and is NOT read-only
// (no Poster sanctioning) — its authority is being an enabled module on the DAO's vault, and the
// vault enabling it (msg.sender == vault, gated by a governance proposal) is the unforgeable
// trust signal. The link we authenticate:
//
//   1. emitter (ctx.log.address, the vault) MUST be a known DAO's avatar  → getDaoByAvatarAddress
//   2. module MUST resolve to a BudgetNavigator whose dao_id == that DAO  → getNavigatorTrust
//
// Both must hold. A random safe's module event fails (1); a budget nav bound to DAO-A can only be
// sanctioned by DAO-A's vault (2). The DAOShip itself is also enabled as a module on the vault —
// its address equals the DAO id, so it is filtered explicitly (and would fail the nav lookup
// anyway, since a DAOShip is not a ds_navigators row).
//
// Both events are recorded in the ds_vault_module_events FEED (keyed {tx}-{logIndex}); the
// navigator's trust_status/is_active is then DERIVED from the latest surviving feed row
// (ds_recompute_module_trust) rather than set directly — so a reorg that rolls back an enable or
// disable re-derives the correct state instead of leaving a stale column. On the first enable we
// also backfill the navigator's budget history (deferred while it was self_asserted).

/** A vault-emitted module event, recorded in the feed and used to re-derive trust. */
function makeModuleEventId(txHash: string, logIndex: number): string {
  return `${txHash}-${logIndex}`;
}

async function resolveVaultDao(ctx: EventContext): Promise<{ vault: string; daoId: string } | null> {
  const vault = ctx.log.address.toLowerCase();
  const daoId = ctx.registry.getDaoByAvatarAddress(vault);
  if (!daoId) return null; // emitter is not a vault we index — some other safe's module event
  return { vault, daoId };
}

/** Append an authenticated module event to the feed (idempotent on {tx}-{logIndex}). */
async function writeModuleEvent(
  ctx: EventContext,
  daoId: string,
  vault: string,
  module: string,
  enabled: boolean,
): Promise<void> {
  await ctx.db.upsert('ds_vault_module_events', {
    id: makeModuleEventId(ctx.log.transactionHash, ctx.log.index),
    dao_id: daoId,
    vault,
    navigator_address: module,
    enabled,
    tx_hash: ctx.log.transactionHash,
    log_index: ctx.log.index,
    block_number: ctx.log.blockNumber,
    created_at: new Date(ctx.blockTimestamp * 1000).toISOString(),
  });
}

// ── EnabledModule ─────────────────────────────────────────────────────────────────────

export async function handleEnabledModule(
  ctx: EventContext,
  args: Record<string, unknown>,
): Promise<void> {
  validateEventArgs(args, ['module'], 'EnabledModule');
  const resolved = await resolveVaultDao(ctx);
  if (!resolved) return;
  const { vault, daoId } = resolved;
  const module = validateAndNormalizeAddress(args.module, 'module');

  // The DAOShip is itself enabled as a module on its own vault (module == dao id). Ignore it —
  // it is not a navigator and carries no budget activity.
  if (module === daoId) return;

  const now = new Date(ctx.blockTimestamp * 1000).toISOString();
  const nav = await ctx.db.getNavigatorTrust(module);

  if (!nav) {
    // Ordering defense: the module was enabled before we indexed its NavigatorDeployed. On-chain
    // a BudgetNavigator's deploy strictly precedes its enable, so this is rare, but a held intent
    // (consumed by handleNavigatorDeployed, verified vault == avatar) keeps us correct under
    // reorg/replay reordering. A non-navigator third-party module also lands here and leaves a
    // harmless orphan intent that never resolves (no matching NavigatorDeployed ever arrives).
    await ctx.db.writeSanctionIntent(daoId, module, vault, now);
    logger.info({ vault, daoId, module }, 'EnabledModule: module not yet seen — holding enable intent');
    return;
  }

  // Scope guard: only a BudgetNavigator (module type) whose NavigatorDeployed.daoShip == this DAO.
  const isModule = nav.navigator_type !== null && MODULE_NAVIGATOR_TYPES.has(nav.navigator_type);
  if (!isModule || (nav.dao_id ?? '').toLowerCase() !== daoId) {
    logger.warn(
      { vault, daoId, module, navDao: nav.dao_id, navType: nav.navigator_type },
      'EnabledModule: module out of scope (different DAO / not a module navigator) — ignoring',
    );
    return;
  }

  const wasSanctioned = nav.trust_status === 'sanctioned';

  // Record the event in the feed, then derive trust from the latest surviving row.
  await writeModuleEvent(ctx, daoId, vault, module, true);
  await ctx.db.recomputeModuleTrust(module);

  if (wasSanctioned) {
    // Already materialized (a re-emitted/duplicate enable) — feed row + re-derive keep it
    // sanctioned, but its budget history is already present, so skip the backfill.
    logger.debug({ vault, daoId, module }, 'EnabledModule: already sanctioned — feed recorded, no backfill');
    return;
  }
  logger.info({ vault, daoId, module }, 'EnabledModule: → sanctioned + active, backfilling budget history');
  await backfillNavigatorBudgets(ctx, module);
}

// ── DisabledModule ────────────────────────────────────────────────────────────────────

export async function handleDisabledModule(
  ctx: EventContext,
  args: Record<string, unknown>,
): Promise<void> {
  validateEventArgs(args, ['module'], 'DisabledModule');
  const resolved = await resolveVaultDao(ctx);
  if (!resolved) return;
  const { daoId } = resolved;
  const module = validateAndNormalizeAddress(args.module, 'module');

  if (module === daoId) return; // DAOShip-as-module; never a budget navigator

  const { vault } = resolved;
  const nav = await ctx.db.getNavigatorTrust(module);

  if (!nav) {
    // Disable before the navigator's deploy was indexed — clear any held enable intent so a
    // later NavigatorDeployed does NOT sanction a module that ended up disabled.
    await ctx.db.consumeSanctionIntent(daoId, module);
    return;
  }

  const isModule = nav.navigator_type !== null && MODULE_NAVIGATOR_TYPES.has(nav.navigator_type);
  if (!isModule || (nav.dao_id ?? '').toLowerCase() !== daoId) {
    logger.warn(
      { daoId, module, navDao: nav.dao_id, navType: nav.navigator_type },
      'DisabledModule: module out of scope — ignoring',
    );
    return;
  }

  // Record the disable in the feed, then derive trust from the latest surviving row.
  await writeModuleEvent(ctx, daoId, vault, module, false);
  await ctx.db.recomputeModuleTrust(module);
  logger.info({ daoId, module }, 'DisabledModule: → unsanctioned + inactive');
}
