import { Interface } from 'quais';
import type { EventContext } from './index.js';
import { bigintToString, safeBigInt } from '../utils/bigint.js';
import { logger } from '../utils/logger.js';
import { validateEventArgs, validateAndNormalizeAddress, validateContractAddress } from '../utils/validation.js';

import OnboarderNavigatorAbi from '../abis/OnboarderNavigator.json' with { type: 'json' };

export const onboarderNavigatorIface = new Interface(OnboarderNavigatorAbi);

// ── Navigator → DAO cache (LRU-bounded) ────────────────────────────
// Avoids repeated on-chain calls to daoShip() for the same navigator address.

const NAVIGATOR_CACHE_MAX_SIZE = 500;
const navigatorDaoCache: Map<string, string> = new Map();

/**
 * I13: Clear the navigator->DAO cache.
 * Must be called from the reorg recovery path in index.ts to prevent stale
 * mappings from pre-reorg events being used after a chain rollback.
 */
export function clearNavigatorDaoCache(): void {
  navigatorDaoCache.clear();
}

/** Remove a specific navigator from the cache (called when permission set to 0). */
export function evictNavigatorFromCache(navigatorAddress: string): void {
  navigatorDaoCache.delete(navigatorAddress.toLowerCase());
}

async function getDaoFromNavigator(
  ctx: EventContext,
  navigatorAddress: string,
): Promise<string | null> {
  const key = navigatorAddress.toLowerCase();

  // 1. Check registry (populated by NavigatorSet handler + startup hydration)
  const registryResult = ctx.registry.getDaoByNavigatorAddress(key);
  if (registryResult) return registryResult;

  // 2. Check module-level LRU cache (fallback for navigators not yet in registry,
  //    e.g. static navigators from config that never had a NavigatorSet event processed)
  const cached = navigatorDaoCache.get(key);
  if (cached) {
    // Re-insert to maintain LRU order (moves to end of Map)
    navigatorDaoCache.delete(key);
    navigatorDaoCache.set(key, cached);
    return cached;
  }

  // 3. Fall back to on-chain call
  try {
    // All navigator contracts expose a daoShip() view function
    const daoShipAddress = await ctx.blockchain.callContract(
      navigatorAddress,
      onboarderNavigatorIface,
      'daoShip',
    );
    const daoId = validateContractAddress(daoShipAddress, 'navigator.daoShip()');

    // LRU eviction: remove oldest entry if at capacity
    if (navigatorDaoCache.size >= NAVIGATOR_CACHE_MAX_SIZE) {
      const oldestKey = navigatorDaoCache.keys().next().value;
      if (oldestKey !== undefined) {
        navigatorDaoCache.delete(oldestKey);
      }
    }

    navigatorDaoCache.set(key, daoId);
    return daoId;
  } catch (err) {
    logger.error(
      { navigatorAddress, err },
      'Failed to call daoShip() on navigator contract',
    );
    return null;
  }
}

function makeNavigatorEventId(txHash: string, logIndex: number): string {
  return `${txHash}-${logIndex}`;
}

// ── OnboarderNavigator.Onboard ─────────────────────────────────────
// Onboard(address indexed daoShipAddress, address indexed contributor, uint256 amount, uint256 shares, uint256 loot)

export async function handleOnboard(
  ctx: EventContext,
  args: Record<string, unknown>,
): Promise<void> {
  validateEventArgs(args, ['daoShipAddress', 'contributor', 'amount', 'shares', 'loot'], 'Onboard');
  const daoShipAddress = validateAndNormalizeAddress(args.daoShipAddress, 'daoShipAddress');
  const contributor = validateAndNormalizeAddress(args.contributor, 'contributor');
  const amount = bigintToString(safeBigInt(args.amount));
  const sharesMinted = bigintToString(safeBigInt(args.shares));
  const lootMinted = bigintToString(safeBigInt(args.loot));

  const navigatorAddress = ctx.log.address.toLowerCase();

  // Use daoShipAddress directly from the event. Validate against registry as defense-in-depth.
  const registryDao = ctx.registry.getDaoByDaoShipAddress(daoShipAddress);
  if (!registryDao) {
    // Fall back to on-chain resolution if not in registry
    const resolvedDaoId = await getDaoFromNavigator(ctx, navigatorAddress);
    if (!resolvedDaoId) {
      logger.warn({ navigatorAddress, daoShipAddress }, 'Onboard: daoShipAddress not in registry and could not resolve DAO, skipping');
      return;
    }
    if (resolvedDaoId !== daoShipAddress) {
      logger.warn({ navigatorAddress, eventDaoShip: daoShipAddress, resolvedDaoShip: resolvedDaoId }, 'Onboard: daoShipAddress mismatch between event and on-chain, using event value');
    }
  }

  const daoId = daoShipAddress;
  const now = new Date(ctx.blockTimestamp * 1000).toISOString();

  await ctx.db.upsert('ds_navigator_events', {
    id: makeNavigatorEventId(ctx.log.transactionHash, ctx.log.index),
    dao_id: daoId,
    navigator_address: navigatorAddress,
    event_type: 'onboard',
    contributor,
    shares_minted: sharesMinted,
    loot_minted: lootMinted,
    amount,
    metadata: null,
    tx_hash: ctx.log.transactionHash,
    block_number: ctx.log.blockNumber,
    created_at: now,
  });

  logger.info(
    { daoId, navigatorAddress, contributor, amount, shares_minted: sharesMinted, loot_minted: lootMinted },
    'Onboard event indexed',
  );
}

// Note: ERC20TributeNavigator.Onboard has identical topic0 to OnboarderNavigator.Onboard
// (Solidity event hashes use types only, not parameter names). Both are handled by
// handleOnboard above. Navigator type is determined via the navigator_type column
// populated by handleNavigatorSet reading the contract's navigatorType() constant.
