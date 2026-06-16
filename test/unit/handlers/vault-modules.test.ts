import { describe, it, expect, vi } from 'vitest';
import { handleEnabledModule, handleDisabledModule } from '../../../src/handlers/vault-modules.js';
import { makeCtx, DAOSHIP, AVATAR, NAVIGATOR } from './helpers.js';

const BUDGET_NAV = {
  id: `${DAOSHIP}-${NAVIGATOR}`,
  dao_id: DAOSHIP,
  trust_status: 'self_asserted',
  navigator_type: 'BudgetNavigator',
  deploy_block: 50,
};

/** ctx for a module event emitted by AVATAR, which is DAOSHIP's known vault. */
function ctxVault(navTrust: unknown, logOverrides: Record<string, unknown> = {}) {
  const ctx = makeCtx({
    db: { getNavigatorTrust: vi.fn().mockResolvedValue(navTrust) },
    registry: { getDaoByAvatarAddress: vi.fn().mockReturnValue(DAOSHIP) },
    blockchain: { getBlockNumber: vi.fn().mockResolvedValue(1000), getLogs: vi.fn().mockResolvedValue([]) },
    log: { address: AVATAR, ...logOverrides },
  });
  return { ctx, db: ctx.db as any };
}

describe('Vault module events (BudgetNavigator trust)', () => {
  it('EnabledModule records a feed row, re-derives trust, and backfills a newly-enabled budget navigator', async () => {
    const { ctx, db } = ctxVault(BUDGET_NAV, { index: 4 });

    await handleEnabledModule(ctx, { module: NAVIGATOR });

    // Feed row is the source of truth (keyed by tx-logIndex), enabled=true.
    expect(db.upsert).toHaveBeenCalledWith('ds_vault_module_events', expect.objectContaining({
      id: `${ctx.log.transactionHash}-4`,
      dao_id: DAOSHIP,
      vault: AVATAR,
      navigator_address: NAVIGATOR,
      enabled: true,
      log_index: 4,
      block_number: 100,
    }));
    // Trust is DERIVED from the feed, not set directly.
    expect(db.recomputeModuleTrust).toHaveBeenCalledWith(NAVIGATOR);
    // Backfill ran (re-reads chain head + getLogs).
    expect(ctx.blockchain.getLogs).toHaveBeenCalled();
    expect(db.writeSanctionIntent).not.toHaveBeenCalled();
  });

  it('EnabledModule from an unknown emitter (not a DAO vault) is dropped', async () => {
    const ctx = makeCtx({
      db: { getNavigatorTrust: vi.fn() },
      registry: { getDaoByAvatarAddress: vi.fn().mockReturnValue(undefined) },
      log: { address: AVATAR },
    });
    const db = ctx.db as any;

    await handleEnabledModule(ctx, { module: NAVIGATOR });

    expect(db.getNavigatorTrust).not.toHaveBeenCalled();
    expect(db.upsert).not.toHaveBeenCalled();
    expect(db.recomputeModuleTrust).not.toHaveBeenCalled();
  });

  it('EnabledModule ignores the DAOShip-as-module (module == dao id)', async () => {
    const { ctx, db } = ctxVault(BUDGET_NAV);

    await handleEnabledModule(ctx, { module: DAOSHIP });

    expect(db.getNavigatorTrust).not.toHaveBeenCalled();
    expect(db.upsert).not.toHaveBeenCalled();
    expect(db.recomputeModuleTrust).not.toHaveBeenCalled();
  });

  it('EnabledModule holds an intent (no feed row) when the module navigator has not been seen yet', async () => {
    const { ctx, db } = ctxVault(null);

    await handleEnabledModule(ctx, { module: NAVIGATOR });

    expect(db.writeSanctionIntent).toHaveBeenCalledWith(DAOSHIP, NAVIGATOR, AVATAR, expect.any(String));
    expect(db.upsert).not.toHaveBeenCalled();
    expect(db.recomputeModuleTrust).not.toHaveBeenCalled();
  });

  it('EnabledModule ignores an out-of-scope module (wrong navigator type)', async () => {
    const { ctx, db } = ctxVault({ ...BUDGET_NAV, navigator_type: 'SignalNavigator' });

    await handleEnabledModule(ctx, { module: NAVIGATOR });

    expect(db.upsert).not.toHaveBeenCalled();
    expect(db.recomputeModuleTrust).not.toHaveBeenCalled();
    expect(db.writeSanctionIntent).not.toHaveBeenCalled();
  });

  it('EnabledModule ignores a budget navigator bound to a different DAO', async () => {
    const otherDao = '0x000000000000000000000000000000000000000a';
    const { ctx, db } = ctxVault({ ...BUDGET_NAV, dao_id: otherDao });

    await handleEnabledModule(ctx, { module: NAVIGATOR });

    expect(db.upsert).not.toHaveBeenCalled();
    expect(db.recomputeModuleTrust).not.toHaveBeenCalled();
  });

  it('EnabledModule on an already-sanctioned nav records the feed + re-derives but skips backfill', async () => {
    const { ctx, db } = ctxVault({ ...BUDGET_NAV, trust_status: 'sanctioned' });

    await handleEnabledModule(ctx, { module: NAVIGATOR });

    expect(db.upsert).toHaveBeenCalledWith('ds_vault_module_events', expect.objectContaining({ enabled: true }));
    expect(db.recomputeModuleTrust).toHaveBeenCalledWith(NAVIGATOR);
    expect(ctx.blockchain.getLogs).not.toHaveBeenCalled(); // no backfill
  });

  it('DisabledModule records a disable feed row and re-derives trust', async () => {
    const { ctx, db } = ctxVault({ ...BUDGET_NAV, trust_status: 'sanctioned' }, { index: 7 });

    await handleDisabledModule(ctx, { module: NAVIGATOR });

    expect(db.upsert).toHaveBeenCalledWith('ds_vault_module_events', expect.objectContaining({
      id: `${ctx.log.transactionHash}-7`,
      navigator_address: NAVIGATOR,
      enabled: false,
      vault: AVATAR,
    }));
    expect(db.recomputeModuleTrust).toHaveBeenCalledWith(NAVIGATOR);
  });

  it('DisabledModule clears a held enable intent when the navigator was never indexed', async () => {
    const { ctx, db } = ctxVault(null);

    await handleDisabledModule(ctx, { module: NAVIGATOR });

    expect(db.consumeSanctionIntent).toHaveBeenCalledWith(DAOSHIP, NAVIGATOR);
    expect(db.upsert).not.toHaveBeenCalled();
    expect(db.recomputeModuleTrust).not.toHaveBeenCalled();
  });
});
