import { describe, it, expect } from 'vitest';
import { handleGovernanceConfigSet } from '../../../src/handlers/daoship.js';
import { makeMockDb, makeCtx, DAOSHIP } from './helpers.js';

const args = {
  votingPeriod: 60n,
  gracePeriod: 30n,
  proposalOffering: 1000n,
  quorumPercent: 1500n,
  sponsorThreshold: 1n,
  minRetentionPercent: 6600n,
  defaultExpiryWindow: 0n,
};

describe('handleGovernanceConfigSet — audit feed + timelock-bypass queueing', () => {
  it('writes a ds_governance_config_history row and queues a bypass check for (dao|tx)', async () => {
    const db = makeMockDb();
    const ctx = makeCtx({ db, log: { address: DAOSHIP } });

    await handleGovernanceConfigSet(ctx, args);

    // DAO config still updated as before
    expect(db.updateDao).toHaveBeenCalledWith(DAOSHIP, expect.objectContaining({
      voting_period: 60,
      default_expiry_window: 0,
    }));

    // History row keyed by canonical (tx, logIndex); bypassed_timelock NOT set inline (defaults false)
    expect(db.upsert).toHaveBeenCalledWith('ds_governance_config_history', expect.objectContaining({
      id: `${ctx.log.transactionHash}-0`,
      dao_id: DAOSHIP,
      voting_period: 60,
      quorum_percent: '1500',
      default_expiry_window: 0,
      block_number: 100,
    }));
    expect(db.upsert.mock.calls[0][1]).not.toHaveProperty('bypassed_timelock');

    // End-of-range resolution is queued, not run inline
    expect(ctx.dirtyTimelockBypassChecks.has(`${DAOSHIP}|${ctx.log.transactionHash}`)).toBe(true);
    expect(db.resolveTimelockBypass).not.toHaveBeenCalled();
  });
});
