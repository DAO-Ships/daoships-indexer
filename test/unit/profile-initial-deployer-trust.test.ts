/**
 * Investigation: "initial DAO profile posts from deployers are being dropped."
 *
 * Drives the real end-to-end path — launch (incl. the vault two-step deployer write) →
 * deployer posts daoships.dao.profile.initial — against a STATEFUL db so getDao returns
 * what the launch handlers actually persisted. Confirms the happy path is accepted and
 * characterizes the exact condition under which a post IS dropped (wrong wallet).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleNewPost } from '../../src/handlers/poster.js';
import { handleLaunchDAOShip, handleLaunchDAOShipAndVault } from '../../src/handlers/launcher.js';
import {
  DAOSHIP, AVATAR, SHARES, LOOT, MEMBER1, TX_HASH,
  POSTER_ADDR, VAULT_LAUNCHER_ADDR, DAOSHIP_LAUNCHER_ADDR,
  makeCtx, makeMockDb,
} from './handlers/helpers.js';

const DEPLOYER_EOA = '0x00000000000000000000000000000000000000ee'; // the human who launched
const VAULT = AVATAR;                                            // vault == avatar

/** A db mock whose getDao returns whatever upsertDao/updateDao last persisted. */
function statefulDb() {
  const daos = new Map<string, Record<string, any>>();
  const db = makeMockDb();
  db.upsertDao = vi.fn(async (row: any) => { daos.set(String(row.id).toLowerCase(), { ...row }); });
  db.updateDao = vi.fn(async (id: string, patch: any) => {
    const k = id.toLowerCase();
    daos.set(k, { ...(daos.get(k) ?? { id: k }), ...patch });
  });
  db.getDao = vi.fn(async (id: string) => daos.get(String(id).toLowerCase()) ?? null);
  return { db, daos };
}

async function profileInitialTag() {
  return (await import('quais')).id('daoships.dao.profile.initial');
}

const profileContent = JSON.stringify({
  schemaVersion: '1.1',
  daoAddress: DAOSHIP,
  name: 'My DAO',
  description: 'A community treasury',
});

describe('deployer daoships.dao.profile.initial — trust path', () => {
  beforeEach(() => vi.clearAllMocks());

  it('vault two-step launch resolves stored deployer to the EOA (not the launcher contract)', async () => {
    const { db } = statefulDb();

    // 1. Inner LaunchDAOShip fires first: launcher = the vault-launcher CONTRACT.
    await handleLaunchDAOShip(
      makeCtx({ db, log: { address: DAOSHIP_LAUNCHER_ADDR, transactionHash: TX_HASH, blockNumber: 10 } }),
      { daoShip: DAOSHIP, shares: SHARES, loot: LOOT, avatar: VAULT, launcher: VAULT_LAUNCHER_ADDR },
    );
    expect((await db.getDao(DAOSHIP))!.deployer).toBe(VAULT_LAUNCHER_ADDR); // transient: contract

    // 2. Outer LaunchDAOShipAndVault overwrites with the real EOA deployer.
    await handleLaunchDAOShipAndVault(
      makeCtx({ db, log: { address: VAULT_LAUNCHER_ADDR, transactionHash: TX_HASH, blockNumber: 10 } }),
      { daoShip: DAOSHIP, vault: VAULT, shares: SHARES, loot: LOOT, newVault: true, launcher: DEPLOYER_EOA },
    );
    expect((await db.getDao(DAOSHIP))!.deployer).toBe(DEPLOYER_EOA); // final: EOA
  });

  it('deployer post AFTER a vault two-step launch is ACCEPTED (VERIFIED_INITIAL, not dropped)', async () => {
    const { db } = statefulDb();
    await handleLaunchDAOShip(
      makeCtx({ db, log: { address: DAOSHIP_LAUNCHER_ADDR, transactionHash: TX_HASH, blockNumber: 10 } }),
      { daoShip: DAOSHIP, shares: SHARES, loot: LOOT, avatar: VAULT, launcher: VAULT_LAUNCHER_ADDR },
    );
    await handleLaunchDAOShipAndVault(
      makeCtx({ db, log: { address: VAULT_LAUNCHER_ADDR, transactionHash: TX_HASH, blockNumber: 10 } }),
      { daoShip: DAOSHIP, vault: VAULT, shares: SHARES, loot: LOOT, newVault: true, launcher: DEPLOYER_EOA },
    );

    const ctx = makeCtx({ db, log: { address: POSTER_ADDR, index: 0, transactionHash: TX_HASH } });
    await handleNewPost(ctx, { user: DEPLOYER_EOA, content: profileContent, tag: await profileInitialTag() });

    // Record written at VERIFIED_INITIAL trust + DAO metadata updated (profile_source=launcher).
    expect(db.upsert).toHaveBeenCalledWith('ds_records', expect.objectContaining({
      tag: 'daoships.dao.profile.initial',
      trust_level: 'VERIFIED_INITIAL',
    }));
    expect(db.updateDao).toHaveBeenCalledWith(DAOSHIP, expect.objectContaining({
      name: 'My DAO', description: 'A community treasury', profile_source: 'launcher',
    }));
  });

  it('deployer post for a DIRECT launch (deployer = launcher EOA) is ACCEPTED', async () => {
    const { db } = statefulDb();
    await handleLaunchDAOShip(
      makeCtx({ db, log: { address: DAOSHIP_LAUNCHER_ADDR, transactionHash: TX_HASH, blockNumber: 10 } }),
      { daoShip: DAOSHIP, shares: SHARES, loot: LOOT, avatar: VAULT, launcher: DEPLOYER_EOA },
    );
    const ctx = makeCtx({ db, log: { address: POSTER_ADDR, index: 0, transactionHash: TX_HASH } });
    await handleNewPost(ctx, { user: DEPLOYER_EOA, content: profileContent, tag: await profileInitialTag() });
    expect(db.updateDao).toHaveBeenCalledWith(DAOSHIP, expect.objectContaining({ profile_source: 'launcher' }));
  });

  // ── The conditions under which a post IS legitimately dropped ──

  it('DROPPED when the DAO is not indexed yet (post processed before launch)', async () => {
    const { db } = statefulDb();                 // no launch → getDao returns null
    const ctx = makeCtx({ db, log: { address: POSTER_ADDR, index: 0, transactionHash: TX_HASH } });
    await handleNewPost(ctx, { user: DEPLOYER_EOA, content: profileContent, tag: await profileInitialTag() });
    // "NewPost: could not determine DAO, skipping" — no record, no update.
    expect(db.upsert).not.toHaveBeenCalled();
    expect(db.updateDao).not.toHaveBeenCalled();
  });

  it('DROPPED when posted from a wallet that is NOT the recorded deployer/avatar', async () => {
    const { db } = statefulDb();
    await handleLaunchDAOShip(
      makeCtx({ db, log: { address: DAOSHIP_LAUNCHER_ADDR, transactionHash: TX_HASH, blockNumber: 10 } }),
      { daoShip: DAOSHIP, shares: SHARES, loot: LOOT, avatar: VAULT, launcher: DEPLOYER_EOA },
    );
    // MEMBER1 has no shares (getMember → null) and is neither avatar nor deployer → UNTRUSTED.
    const ctx = makeCtx({ db, log: { address: POSTER_ADDR, index: 0, transactionHash: TX_HASH } });
    await handleNewPost(ctx, { user: MEMBER1, content: profileContent, tag: await profileInitialTag() });
    // "NewPost: insufficient trust level, skipping" — dropped before the record write.
    expect(db.upsert).not.toHaveBeenCalled();
    expect(db.updateDao).not.toHaveBeenCalled();
  });
});
