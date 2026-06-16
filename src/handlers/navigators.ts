import { Interface } from 'quais';
import type { EventContext } from './index.js';
import { bigintToString, safeBigInt } from '../utils/bigint.js';
import { logger } from '../utils/logger.js';
import { validateEventArgs, validateAndNormalizeAddress, validateContractAddress } from '../utils/validation.js';

import OnboarderNavigatorAbi from '../abis/OnboarderNavigator.json' with { type: 'json' };
import NFTGatedNavigatorAbi from '../abis/NFTGatedNavigator.json' with { type: 'json' };

export const onboarderNavigatorIface = new Interface(OnboarderNavigatorAbi);
// NFTGatedNavigator shares Onboard/NavigatorDeployed/Paused/Unpaused topic0s with the
// other navigators (handled elsewhere); only its NFTClaimed signature is unique and
// registered from this interface — see registerAllHandlers in index.ts.
export const nftGatedNavigatorIface = new Interface(NFTGatedNavigatorAbi);

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

export async function getDaoFromNavigator(
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

// A claim is unique per (navigator, tokenId): a token can be claimed exactly
// once, ever. Keying the row on this — rather than txHash-logIndex — makes
// replay/reorg idempotent and gives O(1) "is token #N claimed?" lookups.
function makeNftClaimId(navigatorAddress: string, tokenId: string): string {
  return `${navigatorAddress.toLowerCase()}-${tokenId}`;
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

// ── NFTGatedNavigator.NFTClaimed ───────────────────────────────────
// NFTClaimed(address indexed daoShipAddress, address indexed holder, uint256 indexed tokenId, uint256 shares, uint256 loot)
//
// Fires alongside the generic Onboard event on every successful NFT-gated claim.
// Onboard is the onboarding-activity / member-balance source (handled by
// handleOnboard); NFTClaimed records the per-token claim dimension Onboard does
// not carry: which tokenId was spent, by whom, when. A token can be claimed
// exactly once, ever — so this is the canonical "is token #N still claimable?"
// and provenance record. It is ADDITIVE to Onboard, never a replacement, and
// must NOT mutate member balances (that would double-count with Onboard/Transfer).

export async function handleNFTClaimed(
  ctx: EventContext,
  args: Record<string, unknown>,
): Promise<void> {
  validateEventArgs(args, ['daoShipAddress', 'holder', 'tokenId', 'shares', 'loot'], 'NFTClaimed');
  const daoShipAddress = validateAndNormalizeAddress(args.daoShipAddress, 'daoShipAddress');
  const holder = validateAndNormalizeAddress(args.holder, 'holder');
  const tokenId = bigintToString(safeBigInt(args.tokenId));
  const sharesMinted = bigintToString(safeBigInt(args.shares));
  const lootMinted = bigintToString(safeBigInt(args.loot));

  const navigatorAddress = ctx.log.address.toLowerCase();

  // The event carries the DAO directly (like Onboard). Validate against the
  // registry as defense-in-depth; fall back to on-chain resolution so a claim
  // is never silently dropped when registry hydration lags.
  if (!ctx.registry.getDaoByDaoShipAddress(daoShipAddress)) {
    const resolvedDaoId = await getDaoFromNavigator(ctx, navigatorAddress);
    if (!resolvedDaoId) {
      logger.warn({ navigatorAddress, daoShipAddress, tokenId }, 'NFTClaimed: daoShipAddress not in registry and could not resolve DAO, skipping');
      return;
    }
    if (resolvedDaoId !== daoShipAddress) {
      logger.warn({ navigatorAddress, eventDaoShip: daoShipAddress, resolvedDaoShip: resolvedDaoId }, 'NFTClaimed: daoShipAddress mismatch between event and on-chain, using event value');
    }
  }

  const now = new Date(ctx.blockTimestamp * 1000).toISOString();

  // id keyed on (navigator, tokenId) → upsert is idempotent under replay/reorg,
  // and reorg-safe via the `block_number > p_block_number` prune in schema.sql.
  await ctx.db.upsert('ds_nft_claims', {
    id: makeNftClaimId(navigatorAddress, tokenId),
    dao_id: daoShipAddress,
    navigator_address: navigatorAddress,
    token_id: tokenId,
    holder, // claimer at claim time; the NFT may move later but the claim is permanent
    shares: sharesMinted,
    loot: lootMinted,
    tx_hash: ctx.log.transactionHash,
    block_number: ctx.log.blockNumber,
    created_at: now,
  });

  logger.info(
    { daoId: daoShipAddress, navigatorAddress, holder, tokenId },
    'NFTClaimed event indexed',
  );
}
