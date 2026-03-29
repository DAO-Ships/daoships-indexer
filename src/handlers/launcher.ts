import type { EventContext, EventHandler } from './index.js';
import type { DaoRow } from '../types/index.js';
import { logger } from '../utils/logger.js';
import { Interface } from 'quais';
import { validateEventArgs, validateAndNormalizeAddress } from '../utils/validation.js';

import DAOShipAndVaultLauncherAbi from '../abis/DAOShipAndVaultLauncher.json' with { type: 'json' };
import DAOShipLauncherAbi from '../abis/DAOShipLauncher.json' with { type: 'json' };

export const daoShipAndVaultLauncherIface = new Interface(DAOShipAndVaultLauncherAbi);
export const daoShipLauncherIface = new Interface(DAOShipLauncherAbi);

/** Build a default DAO row skeleton with zeroed governance params. */
function buildDaoSkeleton(fields: {
  id: string;
  sharesAddress: string;
  lootAddress: string;
  avatar: string;
  launcher: string;
  newVault: boolean;
  txHash: string;
  createdAt: string;
}): DaoRow {
  return {
    id: fields.id,
    created_at: fields.createdAt,
    updated_at: fields.createdAt,
    launcher: fields.launcher,
    tx_hash: fields.txHash,
    loot_address: fields.lootAddress,
    shares_address: fields.sharesAddress,
    avatar: fields.avatar,
    new_vault: fields.newVault,
    voting_period: 0,
    grace_period: 0,
    proposal_offering: '0',
    quorum_percent: '0',
    sponsor_threshold: '0',
    min_retention_percent: '0',
    loot_paused: false,
    shares_paused: false,
    admin_locked: false,
    manager_locked: false,
    governor_locked: false,
    total_shares: '0',
    total_loot: '0',
    active_member_count: 0,
    proposal_count: 0,
    latest_sponsored_proposal_id: 0,
    default_expiry_window: 0,
    profile_source: null,
  };
}

/**
 * Handle LaunchDAOShipAndVault(address indexed daoShip, address indexed vault,
 *   address shares, address loot, bool newVault, address launcher)
 */
export const handleLaunchDAOShipAndVault: EventHandler = async (
  ctx: EventContext,
  args: Record<string, unknown>,
): Promise<void> => {
  const validated = validateEventArgs<{
    daoShip: string; vault: string; shares: string; loot: string;
    newVault: boolean; launcher: string;
  }>(args, ['daoShip', 'vault', 'shares', 'loot', 'launcher'], 'LaunchDAOShipAndVault');

  const daoShipAddress = validateAndNormalizeAddress(validated.daoShip, 'daoShip');
  const vaultAddress = validateAndNormalizeAddress(validated.vault, 'vault');
  const sharesAddress = validateAndNormalizeAddress(validated.shares, 'shares');
  const lootAddress = validateAndNormalizeAddress(validated.loot, 'loot');
  const newVault = Boolean(validated.newVault);
  const launcher = validateAndNormalizeAddress(validated.launcher, 'launcher');

  logger.info(
    { daoShip: daoShipAddress, vault: vaultAddress, launcher },
    'LaunchDAOShipAndVault - registering new DAO',
  );

  ctx.registry.registerDao({ daoShipAddress, sharesAddress, lootAddress, avatar: vaultAddress });

  await ctx.db.upsertDao(buildDaoSkeleton({
    id: daoShipAddress,
    sharesAddress,
    lootAddress,
    avatar: vaultAddress,
    launcher,
    newVault,
    txHash: ctx.log.transactionHash,
    createdAt: new Date(ctx.blockTimestamp * 1000).toISOString(),
  }));
};

/**
 * Handle LaunchDAOShip(address indexed daoShip, address indexed shares,
 *   address indexed loot, address avatar, address launcher)
 *
 * DAOShipAndVaultLauncher internally calls DAOShipLauncher.launchDAOShip,
 * which emits this event. When that is the case the DAO has already been
 * registered by handleLaunchDAOShipAndVault, so we skip the duplicate.
 */
export const handleLaunchDAOShip: EventHandler = async (
  ctx: EventContext,
  args: Record<string, unknown>,
): Promise<void> => {
  const validated = validateEventArgs<{
    daoShip: string; shares: string; loot: string; avatar: string; launcher: string;
  }>(args, ['daoShip', 'shares', 'loot', 'avatar', 'launcher'], 'LaunchDAOShip');

  const daoShipAddress = validateAndNormalizeAddress(validated.daoShip, 'daoShip');
  const sharesAddress = validateAndNormalizeAddress(validated.shares, 'shares');
  const lootAddress = validateAndNormalizeAddress(validated.loot, 'loot');
  const avatarAddress = validateAndNormalizeAddress(validated.avatar, 'avatar');
  const launcher = validateAndNormalizeAddress(validated.launcher, 'launcher');

  if (ctx.registry.getDaoByDaoShipAddress(daoShipAddress)) {
    logger.debug({ daoShip: daoShipAddress }, 'LaunchDAOShip - already registered via LaunchDAOShipAndVault, skipping');
    return;
  }

  logger.info(
    { daoShip: daoShipAddress, avatar: avatarAddress, launcher },
    'LaunchDAOShip - registering new DAO (direct launch)',
  );

  ctx.registry.registerDao({ daoShipAddress, sharesAddress, lootAddress, avatar: avatarAddress });

  await ctx.db.upsertDao(buildDaoSkeleton({
    id: daoShipAddress,
    sharesAddress,
    lootAddress,
    avatar: avatarAddress,
    launcher,
    newVault: false, // LaunchDAOShip always uses a pre-existing vault
    txHash: ctx.log.transactionHash,
    createdAt: new Date(ctx.blockTimestamp * 1000).toISOString(),
  }));
};
