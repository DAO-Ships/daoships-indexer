import { describe, it, expect } from 'vitest';
import {
  handleChangeQueued,
  handleChangeExecuted,
  handleChangeCancelled,
} from '../../../src/handlers/timelock.js';
import { makeMockDb, makeMockRegistry, makeCtx, DAOSHIP, NAVIGATOR, AVATAR, MEMBER1 } from './helpers.js';

const CONFIG_HASH = '0x' + 'cd'.repeat(32);
const GOV_CONFIG = '0x' + '00'.repeat(32) + 'ab';

function ctxForNavigator() {
  const db = makeMockDb();
  const registry = makeMockRegistry();
  registry.getDaoByNavigatorAddress.mockReturnValue(DAOSHIP);
  return { db, ctx: makeCtx({ db, registry, log: { address: NAVIGATOR } }) };
}

describe('TimelockNavigator handlers', () => {
  it('handleChangeQueued inserts a queued change with the full governanceConfig bytes', async () => {
    const { db, ctx } = ctxForNavigator();

    await handleChangeQueued(ctx, {
      changeId: 0n,
      queuedBy: AVATAR,
      configHash: CONFIG_HASH,
      governanceConfig: GOV_CONFIG,
      executableAfter: 1700000000n,
      expiresAt: 1700086400n,
    });

    expect(db.upsert).toHaveBeenCalledWith('ds_timelock_changes', expect.objectContaining({
      id: `${NAVIGATOR}-0`,
      dao_id: DAOSHIP,
      navigator_address: NAVIGATOR,
      change_id: '0',
      queued_by: AVATAR,
      config_hash: CONFIG_HASH,
      governance_config: GOV_CONFIG,
      executable_after: 1700000000,
      expires_at: 1700086400,
      block_number: 100,
    }));
    // status/executed_tx/cancelled_tx omitted so a replay never clobbers a terminal state
    const payload = db.upsert.mock.calls[0][1];
    expect(payload).not.toHaveProperty('status');
    expect(payload).not.toHaveProperty('executed_tx');
    expect(payload).not.toHaveProperty('cancelled_tx');
  });

  it('handleChangeQueued skips when the DAO cannot be resolved', async () => {
    const db = makeMockDb();
    const registry = makeMockRegistry(); // getDaoByNavigatorAddress → undefined; callContract → ''
    const ctx = makeCtx({ db, registry, log: { address: NAVIGATOR } });

    await handleChangeQueued(ctx, {
      changeId: 1n, queuedBy: AVATAR, configHash: CONFIG_HASH,
      governanceConfig: GOV_CONFIG, executableAfter: 1n, expiresAt: 2n,
    });

    expect(db.upsert).not.toHaveBeenCalled();
  });

  it('handleChangeExecuted marks the change executed and records executed_tx', async () => {
    const { db, ctx } = ctxForNavigator();

    await handleChangeExecuted(ctx, { changeId: 0n, executor: MEMBER1, configHash: CONFIG_HASH });

    expect(db.updateTimelockChange).toHaveBeenCalledWith(
      `${NAVIGATOR}-0`,
      expect.objectContaining({ status: 'executed', executed_tx: ctx.log.transactionHash }),
    );
  });

  it('handleChangeCancelled marks the change cancelled and records cancelled_tx', async () => {
    const { db, ctx } = ctxForNavigator();

    await handleChangeCancelled(ctx, { changeId: 0n, caller: MEMBER1 });

    expect(db.updateTimelockChange).toHaveBeenCalledWith(
      `${NAVIGATOR}-0`,
      expect.objectContaining({ status: 'cancelled', cancelled_tx: ctx.log.transactionHash }),
    );
  });
});
