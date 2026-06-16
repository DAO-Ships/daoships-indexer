import { Interface } from 'quais';
import type { EventContext } from './index.js';
import { bigintToString, safeBigInt } from '../utils/bigint.js';
import { logger } from '../utils/logger.js';
import { validateEventArgs, validateAndNormalizeAddress, validateBytes32 } from '../utils/validation.js';
import { getDaoFromNavigator } from './navigators.js';

import TimelockNavigatorAbi from '../abis/TimelockNavigator.json' with { type: 'json' };

export const timelockNavigatorIface = new Interface(TimelockNavigatorAbi);

// ── TimelockNavigator (GOVERNOR-permissioned governance-config timelock) ──────────
// Three lifecycle events on a per-navigator changeId (starts at 0):
//   ChangeQueued(uint256 changeId, address queuedBy, bytes32 configHash, bytes governanceConfig,
//                uint64 executableAfter, uint64 expiresAt)
//   ChangeExecuted(uint256 changeId, address executor, bytes32 configHash)
//   ChangeCancelled(uint256 changeId, address caller)
//
// Rows are keyed {navigator_address}-{change_id}; the DAO is resolved from the navigator
// (the events don't carry it). PERMISSIONED → trust is implicit (sanctioned via NavigatorSet);
// unlike SignalNavigator there is NO defer/backfill gate. Status is time-derived in the app
// (queued→executable→expired by executable_after/expires_at) until a terminal event lands.
//
// Bypass detection: a legitimate timelocked change emits ChangeExecuted in the SAME tx as
// DAOShip.GovernanceConfigSet. Recording executed_tx here is what lets ds_resolve_timelock_bypass
// (end-of-range) distinguish a routed change from a direct setGovernanceConfig bypass.

function makeChangeId(navigatorAddress: string, changeId: string): string {
  return `${navigatorAddress.toLowerCase()}-${changeId}`;
}

// ── ChangeQueued ──────────────────────────────────────────────────────────────────

export async function handleChangeQueued(
  ctx: EventContext,
  args: Record<string, unknown>,
): Promise<void> {
  validateEventArgs(
    args,
    ['changeId', 'queuedBy', 'configHash', 'governanceConfig', 'executableAfter', 'expiresAt'],
    'ChangeQueued',
  );
  const navigatorAddress = ctx.log.address.toLowerCase();
  const daoId = await getDaoFromNavigator(ctx, navigatorAddress);
  if (!daoId) {
    logger.warn({ navigatorAddress }, 'ChangeQueued: could not resolve DAO for navigator, skipping');
    return;
  }

  const changeId = bigintToString(safeBigInt(args.changeId));
  const queuedBy = validateAndNormalizeAddress(args.queuedBy, 'queuedBy');
  const configHash = validateBytes32(args.configHash, 'configHash');
  // `governanceConfig` is `bytes` — quais decodes it to a 0x-hex string. Store verbatim;
  // executeChange(changeId, governanceConfig) needs the exact bytes (only the hash is on-chain).
  const governanceConfig = typeof args.governanceConfig === 'string'
    ? args.governanceConfig
    : String(args.governanceConfig);
  const executableAfter = Number(safeBigInt(args.executableAfter));
  const expiresAt = Number(safeBigInt(args.expiresAt));
  const now = new Date(ctx.blockTimestamp * 1000).toISOString();

  // NB: `status`, `executed_tx`, `cancelled_tx` are intentionally OMITTED so a re-dispatch of
  // this ChangeQueued log on retry never clobbers a terminal state applied by a later
  // ChangeExecuted/ChangeCancelled. On first INSERT, `status` takes the column DEFAULT 'queued'.
  await ctx.db.upsert('ds_timelock_changes', {
    id: makeChangeId(navigatorAddress, changeId),
    dao_id: daoId,
    navigator_address: navigatorAddress,
    change_id: changeId,
    queued_by: queuedBy,
    config_hash: configHash,
    governance_config: governanceConfig,
    executable_after: executableAfter,
    expires_at: expiresAt,
    tx_hash: ctx.log.transactionHash,
    block_number: ctx.log.blockNumber,
    created_at: now,
    updated_at: now,
  });

  logger.info({ navigatorAddress, daoId, changeId, executableAfter, expiresAt }, 'ChangeQueued indexed');
}

// ── ChangeExecuted ────────────────────────────────────────────────────────────────

export async function handleChangeExecuted(
  ctx: EventContext,
  args: Record<string, unknown>,
): Promise<void> {
  validateEventArgs(args, ['changeId', 'executor', 'configHash'], 'ChangeExecuted');
  const navigatorAddress = ctx.log.address.toLowerCase();
  const changeId = bigintToString(safeBigInt(args.changeId));
  const now = new Date(ctx.blockTimestamp * 1000).toISOString();

  // Targeted UPDATE (never insert): the queue row was created by ChangeQueued in an earlier
  // block. A no-op here means the queue was never indexed (e.g. unknown navigator) — harmless.
  await ctx.db.updateTimelockChange(makeChangeId(navigatorAddress, changeId), {
    status: 'executed',
    executed_tx: ctx.log.transactionHash,
    updated_at: now,
  });

  logger.info({ navigatorAddress, changeId, txHash: ctx.log.transactionHash }, 'ChangeExecuted indexed');
}

// ── ChangeCancelled ───────────────────────────────────────────────────────────────

export async function handleChangeCancelled(
  ctx: EventContext,
  args: Record<string, unknown>,
): Promise<void> {
  validateEventArgs(args, ['changeId', 'caller'], 'ChangeCancelled');
  const navigatorAddress = ctx.log.address.toLowerCase();
  const changeId = bigintToString(safeBigInt(args.changeId));
  const now = new Date(ctx.blockTimestamp * 1000).toISOString();

  await ctx.db.updateTimelockChange(makeChangeId(navigatorAddress, changeId), {
    status: 'cancelled',
    cancelled_tx: ctx.log.transactionHash,
    updated_at: now,
  });

  logger.info({ navigatorAddress, changeId, txHash: ctx.log.transactionHash }, 'ChangeCancelled indexed');
}
