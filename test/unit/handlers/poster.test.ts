import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleNewPost } from '../../../src/handlers/poster.js';
import {
  DAOSHIP, AVATAR, MEMBER1, MEMBER2, LAUNCHER, TX_HASH, NAVIGATOR,
  POSTER_ADDR,
  makeCtx as baseMakeCtx, makeMockDb, makeMockBlockchain, makeMockRegistry,
} from './helpers.js';

// The daoships.dao.navigators routing delegates the full-set reconciliation to
// signal.ts (covered in signal.test.ts). Here we only assert that the poster
// *routes* correctly: validates content, enforces the VERIFIED (vault) gate,
// and hands the parsed full set + the vault author to reconcile. Mock the
// collaborator so these tests stay focused on the poster's contract.
vi.mock('../../../src/handlers/signal.js', () => ({
  reconcileSanctionedNavigators: vi.fn().mockResolvedValue(undefined),
  // poster.ts imports makePollPk to single-source the poll-key derivation; keep it real.
  makePollPk: (nav: string, pollId: string) => `${nav.toLowerCase()}-${pollId}`,
}));
import { reconcileSanctionedNavigators } from '../../../src/handlers/signal.js';

// U2: handleNewPost rejects events from any address other than the
// configured Poster contract. Wrap makeCtx to default log.address to
// POSTER_ADDR unless a test explicitly overrides it — mirrors the real
// fetch path where the dispatcher would only route genuine Poster logs
// here.
const makeCtx: typeof baseMakeCtx = (overrides = {}) =>
  baseMakeCtx({
    ...overrides,
    log: { address: POSTER_ADDR, ...(overrides.log ?? {}) },
  });

// ── handleNewPost ────────────────────────────────────────────────

describe('handleNewPost', () => {
  beforeEach(() => vi.clearAllMocks());

  it('resolves DAO from content.daoAddress and upserts record with recognized tag', async () => {
    const db = makeMockDb();
    db.getDao.mockResolvedValue({ id: DAOSHIP, avatar: AVATAR, deployer: LAUNCHER, launcher_contract: LAUNCHER });
    db.getMember.mockResolvedValue({ shares: '100' });
    const ctx = makeCtx({
      db,
      log: { address: POSTER_ADDR, index: 0, transactionHash: TX_HASH },
    });
    const content = JSON.stringify({
      schemaVersion: '1.0',
      daoAddress: DAOSHIP,
      proposalId: 1,
      vote: true,
      reason: 'I support this',
    });
    const { id: keccak256 } = await import('quais');
    const tagHash = keccak256('daoships.proposal.vote.reason');

    await handleNewPost(ctx, { user: MEMBER1, content, tag: tagHash });

    expect(db.upsert).toHaveBeenCalledWith('ds_records', expect.objectContaining({
      dao_id: DAOSHIP,
      user_address: MEMBER1,
      content_type: 'application/json',
    }));
  });

  it('skips posts with unrecognized tags (bloat prevention)', async () => {
    const db = makeMockDb();
    const ctx = makeCtx({ db });
    const content = JSON.stringify({ schemaVersion: '1.0', daoAddress: DAOSHIP });

    await handleNewPost(ctx, { user: MEMBER1, content, tag: 'unknown-tag-hash' });

    expect(db.upsert).not.toHaveBeenCalled();
  });

  it('skips when daoAddress absent in content', async () => {
    const db = makeMockDb();
    const ctx = makeCtx({ db });
    const content = JSON.stringify({ schemaVersion: '1.0', someOtherField: 'value' });
    const { id: keccak256 } = await import('quais');
    const tagHash = keccak256('daoships.member.profile');

    await handleNewPost(ctx, { user: MEMBER1, content, tag: tagHash });

    expect(db.upsert).not.toHaveBeenCalled();
  });

  it('rejects non-JSON content (not stored as raw text)', async () => {
    const db = makeMockDb();
    db.getDao.mockResolvedValue({ id: DAOSHIP, avatar: AVATAR, deployer: LAUNCHER, launcher_contract: LAUNCHER });
    const ctx = makeCtx({ db });
    const { id: keccak256 } = await import('quais');
    const tagHash = keccak256('daoships.member.profile');

    await handleNewPost(ctx, { user: MEMBER1, content: 'plain text content', tag: tagHash });

    expect(db.upsert).not.toHaveBeenCalled();
  });

  it('hard rejects content exceeding 16KB', async () => {
    const db = makeMockDb();
    db.getDao.mockResolvedValue({ id: DAOSHIP, avatar: AVATAR, deployer: LAUNCHER, launcher_contract: LAUNCHER });
    db.getMember.mockResolvedValue({ shares: '100' });
    const ctx = makeCtx({ db });
    const { id: keccak256 } = await import('quais');
    const tagHash = keccak256('daoships.member.profile');
    const oversized = `{"schemaVersion":"1.0","daoAddress":"${DAOSHIP}","name":"${'x'.repeat(17000)}"}`;

    await handleNewPost(ctx, { user: MEMBER1, content: oversized, tag: tagHash });

    // Hard reject — no record stored at all
    expect(db.upsert).not.toHaveBeenCalled();
  });

  it('rejects posts missing schemaVersion', async () => {
    const db = makeMockDb();
    db.getDao.mockResolvedValue({ id: DAOSHIP, avatar: AVATAR, deployer: LAUNCHER, launcher_contract: LAUNCHER });
    db.getMember.mockResolvedValue({ shares: '100' });
    const ctx = makeCtx({
      db,
      log: { address: POSTER_ADDR, index: 0, transactionHash: TX_HASH },
    });
    const content = JSON.stringify({
      daoAddress: DAOSHIP,
      name: 'No Schema Version',
      // schemaVersion intentionally omitted
    });
    const { id: keccak256 } = await import('quais');
    const tagHash = keccak256('daoships.dao.profile');

    await handleNewPost(ctx, { user: AVATAR, content, tag: tagHash });

    expect(db.upsert).not.toHaveBeenCalled();
  });

  it('updates DAO name/description for daoships.dao.profile.initial tag', async () => {
    const db = makeMockDb();
    db.getDao.mockResolvedValue({ id: DAOSHIP, avatar: AVATAR, deployer: LAUNCHER, launcher_contract: LAUNCHER });
    const ctx = makeCtx({ db });
    const profileContent = JSON.stringify({
      schemaVersion: '1.0',
      daoAddress: DAOSHIP,
      name: 'My DAO',
      description: 'A description',
    });
    const { id: keccak256 } = await import('quais');
    const tagHash = keccak256('daoships.dao.profile.initial');

    await handleNewPost(ctx, { user: LAUNCHER, content: profileContent, tag: tagHash });

    expect(db.updateDao).toHaveBeenCalledWith(DAOSHIP, expect.objectContaining({
      name: 'My DAO',
      description: 'A description',
    }));
  });

  it('ignores invalid avatar URL schemes', async () => {
    const db = makeMockDb();
    db.getDao.mockResolvedValue({ id: DAOSHIP, avatar: AVATAR, deployer: LAUNCHER, launcher_contract: LAUNCHER });
    const ctx = makeCtx({ db });
    const { id: keccak256 } = await import('quais');
    const tagHash = keccak256('daoships.dao.profile.initial');
    const content = JSON.stringify({
      schemaVersion: '1.0',
      daoAddress: DAOSHIP,
      name: 'Test DAO',
      description: 'A valid description',
      avatar: 'javascript:alert(1)', // invalid scheme
    });

    await handleNewPost(ctx, { user: LAUNCHER, content, tag: tagHash });

    const update = db.updateDao.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(update.name).toBe('Test DAO');
    expect(update.avatar_img).toBeUndefined();
  });

  it('accepts http/https/ipfs avatar URL schemes', async () => {
    const db = makeMockDb();
    db.getDao.mockResolvedValue({ id: DAOSHIP, avatar: AVATAR, deployer: LAUNCHER, launcher_contract: LAUNCHER });
    const ctx = makeCtx({ db });
    const { id: keccak256 } = await import('quais');
    const tagHash = keccak256('daoships.dao.profile.initial');
    const content = JSON.stringify({
      schemaVersion: '1.0',
      daoAddress: DAOSHIP,
      name: 'Test DAO',
      description: 'A valid description',
      avatar: 'ipfs://bafybeihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku',
    });

    await handleNewPost(ctx, { user: LAUNCHER, content, tag: tagHash });

    const update = db.updateDao.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(update.avatar_img).toMatch(/^ipfs:\/\//);
  });

  it('throws on invalid user address', async () => {
    const ctx = makeCtx({});
    await expect(handleNewPost(ctx, { user: 'not-an-address', content: 'hi', tag: 'tag' }))
      .rejects.toThrow('Invalid user');
  });

  // ── POSTER Trust Model Tests (SECURITY CRITICAL) ──────────────

  it('POSTER-1: random wallet posts dao.profile - insufficient trust, skipped', async () => {
    const db = makeMockDb();
    const { id: keccak256 } = await import('quais');
    const tagHash = keccak256('daoships.dao.profile');
    const randomWallet = '0x0000000000000000000000000000000000000099';

    db.getDao.mockResolvedValue({ id: DAOSHIP, avatar: AVATAR, deployer: LAUNCHER, launcher_contract: LAUNCHER });
    db.getMember.mockResolvedValue(null);
    const registry = makeMockRegistry();
    registry.getDaoByNavigatorAddress.mockReturnValue(undefined);
    const ctx = makeCtx({
      db,
      registry,
      log: { address: POSTER_ADDR, index: 0, transactionHash: TX_HASH },
    });

    const content = JSON.stringify({ schemaVersion: '1.0', daoAddress: DAOSHIP, name: 'Hacked Name', description: 'Hacked' });
    await handleNewPost(ctx, { user: randomWallet, content, tag: tagHash });

    // Trust level is UNTRUSTED which does not meet VERIFIED requirement for dao.profile
    expect(db.updateDao).not.toHaveBeenCalled();
  });

  it('POSTER-2: vault posts dao.profile - metadata updated with profile_source=vault', async () => {
    const db = makeMockDb();
    const { id: keccak256 } = await import('quais');
    const tagHash = keccak256('daoships.dao.profile');

    db.getDao.mockResolvedValue({ id: DAOSHIP, avatar: AVATAR, deployer: LAUNCHER, launcher_contract: LAUNCHER });
    const ctx = makeCtx({
      db,
      log: { address: POSTER_ADDR, index: 0, transactionHash: TX_HASH },
    });

    const content = JSON.stringify({ schemaVersion: '1.0', daoAddress: DAOSHIP, name: 'Vault DAO', description: 'From vault' });
    await handleNewPost(ctx, { user: AVATAR, content, tag: tagHash });

    expect(db.updateDao).toHaveBeenCalledWith(DAOSHIP, expect.objectContaining({
      name: 'Vault DAO',
      description: 'From vault',
      profile_source: 'vault',
    }));
  });

  it('POSTER-3: launcher posts profile.initial (no vault profile) - metadata updated', async () => {
    const db = makeMockDb();
    const { id: keccak256 } = await import('quais');
    const tagHash = keccak256('daoships.dao.profile.initial');

    db.getDao.mockResolvedValue({ id: DAOSHIP, avatar: AVATAR, deployer: LAUNCHER, launcher_contract: LAUNCHER, profile_source: null });
    const ctx = makeCtx({
      db,
      log: { address: POSTER_ADDR, index: 0, transactionHash: TX_HASH },
    });

    const content = JSON.stringify({ schemaVersion: '1.0', daoAddress: DAOSHIP, name: 'Launcher DAO', description: 'Initial profile' });
    await handleNewPost(ctx, { user: LAUNCHER, content, tag: tagHash });

    expect(db.updateDao).toHaveBeenCalledWith(DAOSHIP, expect.objectContaining({
      name: 'Launcher DAO',
      description: 'Initial profile',
      profile_source: 'launcher',
    }));
  });

  it('POSTER-4: launcher posts profile.initial (vault profile exists) - permanently rejected', async () => {
    const db = makeMockDb();
    const { id: keccak256 } = await import('quais');
    const tagHash = keccak256('daoships.dao.profile.initial');

    // profile_source is already 'vault' => permanently rejected
    db.getDao.mockResolvedValue({ id: DAOSHIP, avatar: AVATAR, deployer: LAUNCHER, launcher_contract: LAUNCHER, profile_source: 'vault' });
    const ctx = makeCtx({
      db,
      log: { address: POSTER_ADDR, index: 0, transactionHash: TX_HASH },
    });

    const content = JSON.stringify({ schemaVersion: '1.0', daoAddress: DAOSHIP, name: 'Override Attempt', description: 'Should not apply' });
    await handleNewPost(ctx, { user: LAUNCHER, content, tag: tagHash });

    // Record is stored in ds_records but updateDao is NOT called for metadata
    expect(db.upsert).toHaveBeenCalledWith('ds_records', expect.objectContaining({
      dao_id: DAOSHIP,
      user_address: LAUNCHER,
    }));
    expect(db.updateDao).not.toHaveBeenCalled();
  });

  it('POSTER-5: dao.announcement requires VERIFIED trust (not SEMI_TRUSTED)', async () => {
    const db = makeMockDb();
    const { id: keccak256 } = await import('quais');
    const tagHash = keccak256('daoships.dao.announcement');

    // Navigator has SEMI_TRUSTED trust, but announcement now requires VERIFIED
    db.getDao.mockResolvedValue({ id: DAOSHIP, avatar: AVATAR, deployer: LAUNCHER, launcher_contract: LAUNCHER });
    db.getMember.mockResolvedValue(null);
    const registry = makeMockRegistry();
    registry.getDaoByNavigatorAddress.mockReturnValue(DAOSHIP); // makes user SEMI_TRUSTED
    const ctx = makeCtx({
      db,
      registry,
      log: { address: POSTER_ADDR, index: 0, transactionHash: TX_HASH },
    });

    const content = JSON.stringify({ schemaVersion: '1.0', daoAddress: DAOSHIP, title: 'Nav Announcement' });
    await handleNewPost(ctx, { user: NAVIGATOR, content, tag: tagHash });

    // SEMI_TRUSTED < VERIFIED, so announcement is rejected
    expect(db.upsert).not.toHaveBeenCalled();
  });

  it('POSTER-6: vault posts dao.announcement with VERIFIED trust - accepted', async () => {
    const db = makeMockDb();
    const { id: keccak256 } = await import('quais');
    const tagHash = keccak256('daoships.dao.announcement');

    db.getDao.mockResolvedValue({ id: DAOSHIP, avatar: AVATAR, deployer: LAUNCHER, launcher_contract: LAUNCHER });
    const ctx = makeCtx({
      db,
      log: { address: POSTER_ADDR, index: 0, transactionHash: TX_HASH },
    });

    const content = JSON.stringify({ schemaVersion: '1.0', daoAddress: DAOSHIP, title: 'Important Update' });
    await handleNewPost(ctx, { user: AVATAR, content, tag: tagHash });

    expect(db.upsert).toHaveBeenCalledWith('ds_records', expect.objectContaining({
      dao_id: DAOSHIP,
      tag: 'daoships.dao.announcement',
    }));
  });

  it('POSTER-10: javascript: URL scheme in avatar is rejected', async () => {
    const db = makeMockDb();
    const { id: keccak256 } = await import('quais');
    const tagHash = keccak256('daoships.dao.profile');

    db.getDao.mockResolvedValue({ id: DAOSHIP, avatar: AVATAR, deployer: LAUNCHER, launcher_contract: LAUNCHER });
    const ctx = makeCtx({
      db,
      log: { address: POSTER_ADDR, index: 0, transactionHash: TX_HASH },
    });

    const content = JSON.stringify({
      schemaVersion: '1.0',
      daoAddress: DAOSHIP,
      name: 'Legit Name',
      avatar: 'javascript:alert(1)',
    });
    await handleNewPost(ctx, { user: AVATAR, content, tag: tagHash });

    const updateCall = db.updateDao.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(updateCall.name).toBe('Legit Name');
    expect(updateCall.avatar_img).toBeUndefined();
    expect(updateCall.profile_source).toBe('vault');
  });
});

// ── content_json schema validation ─────────────────────────────

describe('content_json schema validation', () => {
  let keccak: typeof import('quais').id;

  beforeEach(async () => {
    vi.clearAllMocks();
    const quais = await import('quais');
    keccak = quais.id;
  });

  /** Helper: run handleNewPost and return the content_json stored in ds_records. */
  async function postAndGetContentJson(opts: {
    tag: string;
    content: Record<string, unknown>;
    user?: string;
    dbSetup?: (db: ReturnType<typeof makeMockDb>) => void;
    registrySetup?: (reg: ReturnType<typeof makeMockRegistry>) => void;
  }) {
    const db = makeMockDb();
    db.getDao.mockResolvedValue({ id: DAOSHIP, avatar: AVATAR, deployer: LAUNCHER, launcher_contract: LAUNCHER });
    db.getMember.mockResolvedValue({ shares: '100' });
    // navigator.allowlist helper path needs a matching ds_navigators row.
    // Tests that want a different scenario can override via dbSetup.
    const defaultNavAddr = (opts.content as { navigatorAddress?: string }).navigatorAddress;
    const defaultDao = (opts.content as { daoAddress?: string }).daoAddress;
    const defaultRoot = (opts.content as { root?: string }).root;
    if (opts.tag === 'daoships.navigator.allowlist' && defaultNavAddr && defaultDao && defaultRoot) {
      db.getNavigatorByAddress.mockResolvedValue({
        id: `${String(defaultDao).toLowerCase()}-${String(defaultNavAddr).toLowerCase()}`,
        dao_id: null,
        deployer: opts.user ?? MEMBER1,
        allowlist_root: defaultRoot,
      });
    }
    opts.dbSetup?.(db);
    const registry = makeMockRegistry();
    opts.registrySetup?.(registry);
    const ctx = makeCtx({
      db,
      registry,
      log: { address: POSTER_ADDR, index: 0, transactionHash: TX_HASH },
    });
    const tagHash = keccak(opts.tag);
    const user = opts.user ?? MEMBER1;
    await handleNewPost(ctx, {
      user,
      content: JSON.stringify(opts.content),
      tag: tagHash,
    });
    return { db, ctx };
  }

  function getContentJson(db: ReturnType<typeof makeMockDb>): Record<string, unknown> | null {
    if (db.upsert.mock.calls.length === 0) return null;
    for (const call of db.upsert.mock.calls) {
      if (call[0] === 'ds_records') return call[1].content_json;
    }
    return null;
  }

  // ── schemaVersion enforcement ──────────────────────────────────

  it('rejects post with missing schemaVersion (no record stored)', async () => {
    const db = makeMockDb();
    db.getDao.mockResolvedValue({ id: DAOSHIP, avatar: AVATAR, deployer: LAUNCHER, launcher_contract: LAUNCHER });
    db.getMember.mockResolvedValue({ shares: '100' });
    const ctx = makeCtx({
      db,
      log: { address: POSTER_ADDR, index: 0, transactionHash: TX_HASH },
    });
    const tagHash = keccak('daoships.dao.profile');
    const content = JSON.stringify({ daoAddress: DAOSHIP, name: 'Test' });

    await handleNewPost(ctx, { user: AVATAR, content, tag: tagHash });

    expect(db.upsert).not.toHaveBeenCalled();
  });

  it('rejects non-JSON content (no record stored)', async () => {
    const db = makeMockDb();
    db.getDao.mockResolvedValue({ id: DAOSHIP, avatar: AVATAR, deployer: LAUNCHER, launcher_contract: LAUNCHER });
    const ctx = makeCtx({
      db,
      log: { address: POSTER_ADDR, index: 0, transactionHash: TX_HASH },
    });
    const tagHash = keccak('daoships.dao.profile');

    await handleNewPost(ctx, { user: AVATAR, content: 'not json at all', tag: tagHash });

    expect(db.upsert).not.toHaveBeenCalled();
  });

  it('hard rejects content exceeding 16KB (no record stored)', async () => {
    const db = makeMockDb();
    db.getDao.mockResolvedValue({ id: DAOSHIP, avatar: AVATAR, deployer: LAUNCHER, launcher_contract: LAUNCHER });
    db.getMember.mockResolvedValue({ shares: '100' });
    const ctx = makeCtx({
      db,
      log: { address: POSTER_ADDR, index: 0, transactionHash: TX_HASH },
    });
    const tagHash = keccak('daoships.member.profile');
    // 16384 = 16KB limit
    const oversized = `{"schemaVersion":"1.0","daoAddress":"${DAOSHIP}","name":"${'x'.repeat(17000)}"}`;

    await handleNewPost(ctx, { user: MEMBER1, content: oversized, tag: tagHash });

    expect(db.upsert).not.toHaveBeenCalled();
  });

  // ── dao.profile (partial updates / merge semantics) ────────────

  it('dao.profile with valid content — content_json has recognized fields only', async () => {
    const { db } = await postAndGetContentJson({
      tag: 'daoships.dao.profile',
      user: AVATAR,
      content: {
        schemaVersion: '1.0',
        daoAddress: DAOSHIP,
        name: 'My DAO',
        description: 'A great DAO',
        avatar: 'https://example.com/avatar.png',
        banner: 'https://example.com/banner.png',
        links: { website: 'https://example.com' },
        tags: ['defi', 'governance'],
        chainId: 9000,
      },
    });
    const json = getContentJson(db);
    expect(json).toEqual({
      daoAddress: DAOSHIP,
      name: 'My DAO',
      description: 'A great DAO',
      avatar: 'https://example.com/avatar.png',
      banner: 'https://example.com/banner.png',
      links: { website: 'https://example.com' },
      tags: ['defi', 'governance'],
      chainId: 9000,
      schemaVersion: '1.0',
    });
  });

  it('dao.profile with extra unrecognized fields — extra fields stripped', async () => {
    const { db } = await postAndGetContentJson({
      tag: 'daoships.dao.profile',
      user: AVATAR,
      content: {
        schemaVersion: '1.0',
        daoAddress: DAOSHIP,
        name: 'My DAO',
        extraField: 'should be gone',
        secretKey: '0xdeadbeef',
        nested: { deep: true },
      },
    });
    const json = getContentJson(db);
    expect(json).toBeDefined();
    expect(json).not.toHaveProperty('extraField');
    expect(json).not.toHaveProperty('secretKey');
    expect(json).not.toHaveProperty('nested');
    expect(json!.name).toBe('My DAO');
  });

  it('dao.profile supports partial updates (only daoAddress required)', async () => {
    const { db } = await postAndGetContentJson({
      tag: 'daoships.dao.profile',
      user: AVATAR,
      content: {
        schemaVersion: '1.0',
        daoAddress: DAOSHIP,
        description: 'Updated description only',
      },
    });
    const json = getContentJson(db);
    expect(json).toEqual({
      daoAddress: DAOSHIP,
      description: 'Updated description only',
      schemaVersion: '1.0',
    });
  });

  // ── dao.profile `theme` palette (schema 1.1) — strict hex security boundary ──

  it('dao.profile theme: valid palette kept (3- and 6-digit hex, mode)', async () => {
    const { db } = await postAndGetContentJson({
      tag: 'daoships.dao.profile',
      user: AVATAR,
      content: {
        schemaVersion: '1.1',
        daoAddress: DAOSHIP,
        theme: {
          mode: 'dark',
          primary: '#5B8DEF',
          secondary: '#22D3AA',
          accent: '#F59E0B',
          background: '#0E1116',
          surface: '#abc',          // 3-digit hex is valid
          text: '#E6EAF2',
        },
      },
    });
    expect(getContentJson(db)!.theme).toEqual({
      mode: 'dark',
      primary: '#5B8DEF',
      secondary: '#22D3AA',
      accent: '#F59E0B',
      background: '#0E1116',
      surface: '#abc',
      text: '#E6EAF2',
    });
  });

  it('dao.profile theme: CSS-injection / malformed colors are DROPPED (security boundary)', async () => {
    const { db } = await postAndGetContentJson({
      tag: 'daoships.dao.profile',
      user: AVATAR,
      content: {
        schemaVersion: '1.1',
        daoAddress: DAOSHIP,
        theme: {
          primary: '#5B8DEF',                              // valid → kept
          secondary: '#fff; } body { background: url(//evil) ', // CSS injection → dropped
          accent: 'red',                                   // named color → dropped
          background: 'rgb(0,0,0)',                        // functional → dropped
          surface: '#12',                                  // wrong length → dropped
          text: '#1234567',                                // too long → dropped
        },
      },
    });
    // Only the strictly-hex token survives; every injection/malformed value is gone.
    expect(getContentJson(db)!.theme).toEqual({ primary: '#5B8DEF' });
  });

  it('dao.profile theme: invalid mode dropped, valid colors retained; unknown keys ignored', async () => {
    const { db } = await postAndGetContentJson({
      tag: 'daoships.dao.profile',
      user: AVATAR,
      content: {
        schemaVersion: '1.1',
        daoAddress: DAOSHIP,
        theme: {
          mode: 'neon',                 // not light|dark → dropped
          primary: '#000000',
          evilKey: '#000000',           // not in the fixed allowlist → never read
          __proto__: 'x',               // prototype-pollution attempt → never read
        },
      },
    });
    expect(getContentJson(db)!.theme).toEqual({ primary: '#000000' });
  });

  it('dao.profile theme: all-invalid palette yields no theme key at all', async () => {
    const { db } = await postAndGetContentJson({
      tag: 'daoships.dao.profile',
      user: AVATAR,
      content: {
        schemaVersion: '1.1',
        daoAddress: DAOSHIP,
        theme: { primary: 'blue', background: 'transparent' },
      },
    });
    expect(getContentJson(db)).not.toHaveProperty('theme');
  });

  it('dao.profile theme: non-object theme is ignored', async () => {
    const { db } = await postAndGetContentJson({
      tag: 'daoships.dao.profile',
      user: AVATAR,
      content: { schemaVersion: '1.1', daoAddress: DAOSHIP, theme: '#5B8DEF' },
    });
    expect(getContentJson(db)).not.toHaveProperty('theme');
  });

  it('dao.profile.initial accepts a launch theme (same strict rules)', async () => {
    const { db } = await postAndGetContentJson({
      tag: 'daoships.dao.profile.initial',
      user: LAUNCHER,
      dbSetup: (d) => d.getDao.mockResolvedValue({ id: DAOSHIP, avatar: AVATAR, deployer: LAUNCHER, launcher_contract: LAUNCHER, profile_source: null }),
      content: {
        schemaVersion: '1.1',
        daoAddress: DAOSHIP,
        name: 'My DAO',
        description: 'A great DAO',
        theme: { mode: 'light', primary: '#5B8DEF', accent: 'not-a-color' },
      },
    });
    expect(getContentJson(db)!.theme).toEqual({ mode: 'light', primary: '#5B8DEF' });
  });

  // ── dao.profile.initial (requires name AND description) ────────

  it('dao.profile.initial requires both name and description', async () => {
    // Missing description => validator returns null
    const { db } = await postAndGetContentJson({
      tag: 'daoships.dao.profile.initial',
      user: LAUNCHER,
      content: {
        schemaVersion: '1.0',
        daoAddress: DAOSHIP,
        name: 'Only Name',
        // description intentionally omitted
      },
    });
    const json = getContentJson(db);
    expect(json).toBeNull();
  });

  it('dao.profile.initial with both name and description — accepted', async () => {
    const { db } = await postAndGetContentJson({
      tag: 'daoships.dao.profile.initial',
      user: LAUNCHER,
      content: {
        schemaVersion: '1.0',
        daoAddress: DAOSHIP,
        name: 'New DAO',
        description: 'A fresh DAO',
      },
    });
    const json = getContentJson(db);
    expect(json).toEqual(expect.objectContaining({
      daoAddress: DAOSHIP,
      name: 'New DAO',
      description: 'A fresh DAO',
      schemaVersion: '1.0',
    }));
  });

  it('profile.initial permanently rejected when profile_source=vault', async () => {
    const { db } = await postAndGetContentJson({
      tag: 'daoships.dao.profile.initial',
      user: LAUNCHER,
      content: {
        schemaVersion: '1.0',
        daoAddress: DAOSHIP,
        name: 'Override',
        description: 'Should not apply',
      },
      dbSetup: (db) => {
        db.getDao.mockResolvedValue({ id: DAOSHIP, avatar: AVATAR, deployer: LAUNCHER, launcher_contract: LAUNCHER, profile_source: 'vault' });
      },
    });
    // Record is stored but updateDao is NOT called
    expect(db.upsert).toHaveBeenCalledWith('ds_records', expect.objectContaining({
      dao_id: DAOSHIP,
    }));
    expect(db.updateDao).not.toHaveBeenCalled();
  });

  // ── dao.announcement (requires title, no pinned) ──────────────

  it('dao.announcement requires title', async () => {
    const { db } = await postAndGetContentJson({
      tag: 'daoships.dao.announcement',
      user: AVATAR,
      content: {
        schemaVersion: '1.0',
        daoAddress: DAOSHIP,
        body: 'No title here',
        // title intentionally omitted
      },
    });
    const json = getContentJson(db);
    expect(json).toBeNull();
  });

  it('dao.announcement with valid title — accepted', async () => {
    const { db } = await postAndGetContentJson({
      tag: 'daoships.dao.announcement',
      user: AVATAR,
      content: {
        schemaVersion: '1.0',
        daoAddress: DAOSHIP,
        title: 'Important Update',
        body: 'Details here',
        severity: 'info',
      },
    });
    const json = getContentJson(db);
    expect(json).toEqual({
      daoAddress: DAOSHIP,
      title: 'Important Update',
      body: 'Details here',
      severity: 'info',
      schemaVersion: '1.0',
    });
  });

  it('dao.announcement does not include pinned field', async () => {
    const { db } = await postAndGetContentJson({
      tag: 'daoships.dao.announcement',
      user: AVATAR,
      content: {
        schemaVersion: '1.0',
        daoAddress: DAOSHIP,
        title: 'Update',
        pinned: true,
      },
    });
    const json = getContentJson(db);
    expect(json).not.toHaveProperty('pinned');
  });

  // ── member.profile (requires name, no links/skills) ────────────

  it('member.profile requires name', async () => {
    const { db } = await postAndGetContentJson({
      tag: 'daoships.member.profile',
      user: MEMBER1,
      content: {
        schemaVersion: '1.0',
        daoAddress: DAOSHIP,
        bio: 'A bio without a name',
        // name intentionally omitted
      },
    });
    const json = getContentJson(db);
    expect(json).toBeNull();
  });

  it('member.profile with name — accepted, no links or skills fields', async () => {
    const { db } = await postAndGetContentJson({
      tag: 'daoships.member.profile',
      user: MEMBER1,
      content: {
        schemaVersion: '1.0',
        daoAddress: DAOSHIP,
        name: 'Alice',
        bio: 'Web3 developer',
        avatar: 'https://example.com/alice.png',
        links: { github: 'https://github.com/alice' },
        skills: ['solidity', 'typescript'],
      },
    });
    const json = getContentJson(db);
    expect(json).toEqual({
      daoAddress: DAOSHIP,
      name: 'Alice',
      bio: 'Web3 developer',
      avatar: 'https://example.com/alice.png',
      schemaVersion: '1.0',
    });
    // links and skills are removed from the schema
    expect(json).not.toHaveProperty('links');
    expect(json).not.toHaveProperty('skills');
  });

  it('member.profile rejected for UNTRUSTED user (non-member)', async () => {
    const randomWallet = '0x0000000000000000000000000000000000000042';
    const { db } = await postAndGetContentJson({
      tag: 'daoships.member.profile',
      user: randomWallet,
      content: {
        schemaVersion: '1.0',
        daoAddress: DAOSHIP,
        name: 'Impersonator',
      },
      dbSetup: (db) => {
        db.getMember.mockResolvedValue(null); // not a member
      },
    });
    // UNTRUSTED does not meet MEMBER requirement — record not stored
    expect(db.upsert).not.toHaveBeenCalled();
  });

  // ── vote.reason (requires reason) ──────────────────────────────

  it('vote.reason requires reason field', async () => {
    const { db } = await postAndGetContentJson({
      tag: 'daoships.proposal.vote.reason',
      user: MEMBER1,
      content: {
        schemaVersion: '1.0',
        daoAddress: DAOSHIP,
        proposalId: 7,
        vote: true,
        // reason intentionally omitted
      },
    });
    const json = getContentJson(db);
    expect(json).toBeNull();
  });

  it('vote.reason with valid content — matches schema', async () => {
    const { db } = await postAndGetContentJson({
      tag: 'daoships.proposal.vote.reason',
      user: MEMBER1,
      content: {
        schemaVersion: '1.0',
        daoAddress: DAOSHIP,
        proposalId: 7,
        vote: true,
        reason: 'I agree with this proposal',
      },
    });
    const json = getContentJson(db);
    expect(json).toEqual({
      daoAddress: DAOSHIP,
      proposalId: 7,
      vote: true,
      reason: 'I agree with this proposal',
      schemaVersion: '1.0',
    });
  });

  // ── navigator.allowlist ────────────────────────────────────────

  it('navigator.allowlist with valid data — accepted', async () => {
    const navigatorAddr = '0x0000000000000000000000000000000000000007';
    const root = '0x' + 'ab'.repeat(32);
    const { db } = await postAndGetContentJson({
      tag: 'daoships.navigator.allowlist',
      user: MEMBER1,
      content: {
        schemaVersion: '1.0',
        daoAddress: DAOSHIP,
        navigatorAddress: navigatorAddr,
        root,
        addresses: ['0x0000000000000000000000000000000000000001', '0x0000000000000000000000000000000000000002'],
        treeDump: { format: 'standard-v1', values: [] },
      },
    });
    const json = getContentJson(db);
    expect(json).toEqual({
      daoAddress: DAOSHIP,
      navigatorAddress: navigatorAddr,
      root,
      addresses: ['0x0000000000000000000000000000000000000001', '0x0000000000000000000000000000000000000002'],
      treeDump: { format: 'standard-v1', values: [] },
      schemaVersion: '1.0',
    });
  });

  it('navigator.allowlist rejects missing root', async () => {
    const { db } = await postAndGetContentJson({
      tag: 'daoships.navigator.allowlist',
      user: MEMBER1,
      content: {
        schemaVersion: '1.0',
        daoAddress: DAOSHIP,
        navigatorAddress: '0x0000000000000000000000000000000000000007',
        addresses: ['0x0000000000000000000000000000000000000001'],
        treeDump: { format: 'standard-v1' },
      },
    });
    const json = getContentJson(db);
    expect(json).toBeNull();
  });

  it('navigator.allowlist rejects invalid root format', async () => {
    const { db } = await postAndGetContentJson({
      tag: 'daoships.navigator.allowlist',
      user: MEMBER1,
      content: {
        schemaVersion: '1.0',
        daoAddress: DAOSHIP,
        navigatorAddress: '0x0000000000000000000000000000000000000007',
        root: 'not-a-hex-root',
        addresses: ['0x0000000000000000000000000000000000000001'],
        treeDump: { format: 'standard-v1' },
      },
    });
    const json = getContentJson(db);
    expect(json).toBeNull();
  });

  it('navigator.allowlist rejects empty addresses array', async () => {
    const { db } = await postAndGetContentJson({
      tag: 'daoships.navigator.allowlist',
      user: MEMBER1,
      content: {
        schemaVersion: '1.0',
        daoAddress: DAOSHIP,
        navigatorAddress: '0x0000000000000000000000000000000000000007',
        root: '0x' + 'ab'.repeat(32),
        addresses: [],
        treeDump: { format: 'standard-v1' },
      },
    });
    const json = getContentJson(db);
    expect(json).toBeNull();
  });

  it('navigator.allowlist rejects missing treeDump', async () => {
    const { db } = await postAndGetContentJson({
      tag: 'daoships.navigator.allowlist',
      user: MEMBER1,
      content: {
        schemaVersion: '1.0',
        daoAddress: DAOSHIP,
        navigatorAddress: '0x0000000000000000000000000000000000000007',
        root: '0x' + 'ab'.repeat(32),
        addresses: ['0x0000000000000000000000000000000000000001'],
      },
    });
    const json = getContentJson(db);
    expect(json).toBeNull();
  });

  it('navigator.allowlist filters invalid addresses from array', async () => {
    const root = '0x' + 'ab'.repeat(32);
    const { db } = await postAndGetContentJson({
      tag: 'daoships.navigator.allowlist',
      user: MEMBER1,
      content: {
        schemaVersion: '1.0',
        daoAddress: DAOSHIP,
        navigatorAddress: '0x0000000000000000000000000000000000000007',
        root,
        addresses: ['0x0000000000000000000000000000000000000001', 'not-an-address', 12345],
        treeDump: { values: [] },
      },
    });
    const json = getContentJson(db);
    expect(json!.addresses).toEqual(['0x0000000000000000000000000000000000000001']);
  });

  it('navigator.allowlist strips unrecognized fields', async () => {
    const root = '0x' + 'ab'.repeat(32);
    const { db } = await postAndGetContentJson({
      tag: 'daoships.navigator.allowlist',
      user: MEMBER1,
      content: {
        schemaVersion: '1.0',
        daoAddress: DAOSHIP,
        navigatorAddress: '0x0000000000000000000000000000000000000007',
        root,
        addresses: ['0x0000000000000000000000000000000000000001'],
        treeDump: { values: [] },
        extraField: 'should be stripped',
        malicious: '<script>alert(1)</script>',
      },
    });
    const json = getContentJson(db);
    expect(json).not.toHaveProperty('extraField');
    expect(json).not.toHaveProperty('malicious');
  });

  // ── navigator.allowlist: DB-indexed verification (H1) ──────────
  // All verification is now derived from the indexed NavigatorDeployed event
  // via ds_navigators — zero RPC calls per NewPost.

  const VALID_ROOT = '0x' + 'ab'.repeat(32);
  const VALID_NAV = '0x0000000000000000000000000000000000000007';
  const VALID_ALLOWLIST_CONTENT = {
    schemaVersion: '1.0',
    daoAddress: DAOSHIP,
    navigatorAddress: VALID_NAV,
    root: VALID_ROOT,
    addresses: [MEMBER1],
    treeDump: { format: 'standard-v1', values: [] },
  };

  // Matches makeNavigatorId(daoShip, navigatorAddress) in src/utils/addresses.ts
  const VALID_NAV_ROW_ORPHAN = {
    id: `${DAOSHIP}-${VALID_NAV}`,
    dao_id: null,
    deployer: MEMBER1,
    allowlist_root: VALID_ROOT,
  };
  const VALID_NAV_ROW_REGISTERED = {
    id: `${DAOSHIP}-${VALID_NAV}`,
    dao_id: DAOSHIP,
    deployer: MEMBER1,
    allowlist_root: VALID_ROOT,
  };

  it('navigator.allowlist accepted with ON_CHAIN_PROVISIONAL when navigator is an orphan', async () => {
    const db = makeMockDb();
    db.getNavigatorByAddress.mockResolvedValue(VALID_NAV_ROW_ORPHAN);
    const blockchain = makeMockBlockchain();
    const ctx = makeCtx({
      db, blockchain,
      log: { address: POSTER_ADDR, index: 0, transactionHash: TX_HASH },
    });
    await handleNewPost(ctx, {
      user: MEMBER1,
      content: JSON.stringify(VALID_ALLOWLIST_CONTENT),
      tag: keccak('daoships.navigator.allowlist'),
    });
    expect(db.upsert).toHaveBeenCalledWith('ds_records', expect.objectContaining({
      dao_id: null,
      trust_level: 'ON_CHAIN_PROVISIONAL',
      tag: 'daoships.navigator.allowlist',
    }));
    // Zero RPC calls on the hot path — the point of the whole fix
    expect(blockchain.getCode).not.toHaveBeenCalled();
    expect(blockchain.rawCall).not.toHaveBeenCalled();
  });

  it('navigator.allowlist accepted with SEMI_TRUSTED when navigator is registered to a DAO', async () => {
    const db = makeMockDb();
    db.getNavigatorByAddress.mockResolvedValue(VALID_NAV_ROW_REGISTERED);
    const blockchain = makeMockBlockchain();
    const ctx = makeCtx({
      db, blockchain,
      log: { address: POSTER_ADDR, index: 0, transactionHash: TX_HASH },
    });
    await handleNewPost(ctx, {
      user: MEMBER1,
      content: JSON.stringify(VALID_ALLOWLIST_CONTENT),
      tag: keccak('daoships.navigator.allowlist'),
    });
    expect(db.upsert).toHaveBeenCalledWith('ds_records', expect.objectContaining({
      dao_id: DAOSHIP,
      trust_level: 'SEMI_TRUSTED',
    }));
    expect(blockchain.getCode).not.toHaveBeenCalled();
    expect(blockchain.rawCall).not.toHaveBeenCalled();
  });

  it('navigator.allowlist rejected when navigator is not indexed (DB miss)', async () => {
    const db = makeMockDb();
    db.getNavigatorByAddress.mockResolvedValue(null); // not indexed
    const blockchain = makeMockBlockchain();
    const ctx = makeCtx({
      db, blockchain,
      log: { address: POSTER_ADDR, index: 0, transactionHash: TX_HASH },
    });
    await handleNewPost(ctx, {
      user: MEMBER1,
      content: JSON.stringify(VALID_ALLOWLIST_CONTENT),
      tag: keccak('daoships.navigator.allowlist'),
    });
    expect(db.upsert).not.toHaveBeenCalled();
    // No RPC fallback for unknown navigators — the DoS defense.
    expect(blockchain.getCode).not.toHaveBeenCalled();
    expect(blockchain.rawCall).not.toHaveBeenCalled();
  });

  it('navigator.allowlist rejected when user is not the navigator deployer', async () => {
    const db = makeMockDb();
    db.getNavigatorByAddress.mockResolvedValue(VALID_NAV_ROW_ORPHAN);
    const ctx = makeCtx({
      db,
      log: { address: POSTER_ADDR, index: 0, transactionHash: TX_HASH },
    });
    const impostor = '0x0000000000000000000000000000000000000042';
    await handleNewPost(ctx, {
      user: impostor, // not the deployer
      content: JSON.stringify(VALID_ALLOWLIST_CONTENT),
      tag: keccak('daoships.navigator.allowlist'),
    });
    expect(db.upsert).not.toHaveBeenCalled();
  });

  it('navigator.allowlist rejected when claimed daoAddress does not match stored daoShip', async () => {
    const db = makeMockDb();
    // Navigator's stored id says daoShip = DAOSHIP, but the post claims a different DAO
    db.getNavigatorByAddress.mockResolvedValue(VALID_NAV_ROW_ORPHAN);
    const ctx = makeCtx({
      db,
      log: { address: POSTER_ADDR, index: 0, transactionHash: TX_HASH },
    });
    const otherDao = '0x0000000000000000000000000000000000000042';
    await handleNewPost(ctx, {
      user: MEMBER1,
      content: JSON.stringify({ ...VALID_ALLOWLIST_CONTENT, daoAddress: otherDao }),
      tag: keccak('daoships.navigator.allowlist'),
    });
    expect(db.upsert).not.toHaveBeenCalled();
  });

  it('navigator.allowlist rejected when posted root does not match cached allowlist_root', async () => {
    const db = makeMockDb();
    db.getNavigatorByAddress.mockResolvedValue({
      ...VALID_NAV_ROW_ORPHAN,
      allowlist_root: '0x' + 'ff'.repeat(32), // different from posted root
    });
    const ctx = makeCtx({
      db,
      log: { address: POSTER_ADDR, index: 0, transactionHash: TX_HASH },
    });
    await handleNewPost(ctx, {
      user: MEMBER1,
      content: JSON.stringify(VALID_ALLOWLIST_CONTENT),
      tag: keccak('daoships.navigator.allowlist'),
    });
    expect(db.upsert).not.toHaveBeenCalled();
  });

  it('navigator.allowlist rejected when cached allowlist_root is null (e.g. navigator has no allowlist)', async () => {
    const db = makeMockDb();
    db.getNavigatorByAddress.mockResolvedValue({
      ...VALID_NAV_ROW_ORPHAN,
      allowlist_root: null,
    });
    const ctx = makeCtx({
      db,
      log: { address: POSTER_ADDR, index: 0, transactionHash: TX_HASH },
    });
    await handleNewPost(ctx, {
      user: MEMBER1,
      content: JSON.stringify(VALID_ALLOWLIST_CONTENT),
      tag: keccak('daoships.navigator.allowlist'),
    });
    expect(db.upsert).not.toHaveBeenCalled();
  });

  it('navigator.allowlist never triggers on-chain RPC for any failure mode', async () => {
    // Sweep through every reject path and confirm zero RPC calls fire.
    const blockchain = makeMockBlockchain();
    const tagHash = keccak('daoships.navigator.allowlist');

    for (const dbSetup of [
      // DB miss
      (db: ReturnType<typeof makeMockDb>) => db.getNavigatorByAddress.mockResolvedValue(null),
      // daoShip mismatch
      (db: ReturnType<typeof makeMockDb>) => db.getNavigatorByAddress.mockResolvedValue({
        id: `0x0000000000000000000000000000000000000042-${VALID_NAV}`,
        dao_id: null, deployer: MEMBER1, allowlist_root: VALID_ROOT,
      }),
      // deployer mismatch
      (db: ReturnType<typeof makeMockDb>) => db.getNavigatorByAddress.mockResolvedValue({
        ...VALID_NAV_ROW_ORPHAN, deployer: '0x0000000000000000000000000000000000000099',
      }),
      // root mismatch
      (db: ReturnType<typeof makeMockDb>) => db.getNavigatorByAddress.mockResolvedValue({
        ...VALID_NAV_ROW_ORPHAN, allowlist_root: '0x' + 'ff'.repeat(32),
      }),
    ]) {
      const db = makeMockDb();
      dbSetup(db);
      const ctx = makeCtx({
        db, blockchain,
        log: { address: POSTER_ADDR, index: 0, transactionHash: TX_HASH },
      });
      await handleNewPost(ctx, {
        user: MEMBER1,
        content: JSON.stringify(VALID_ALLOWLIST_CONTENT),
        tag: tagHash,
      });
      expect(db.upsert).not.toHaveBeenCalled();
    }
    expect(blockchain.getCode).not.toHaveBeenCalled();
    expect(blockchain.rawCall).not.toHaveBeenCalled();
  });

  // ── navigator.allowlist: ipfsCid format ────────────────────────

  it('navigator.allowlist with ipfsCid only — accepted', async () => {
    const { db } = await postAndGetContentJson({
      tag: 'daoships.navigator.allowlist',
      user: MEMBER1,
      content: {
        schemaVersion: '1.0',
        daoAddress: DAOSHIP,
        navigatorAddress: VALID_NAV,
        root: VALID_ROOT,
        ipfsCid: 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
      },
    });
    const json = getContentJson(db);
    expect(json).toBeTruthy();
    expect(json!.ipfsCid).toBe('bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi');
    expect(json).not.toHaveProperty('addresses');
    expect(json).not.toHaveProperty('treeDump');
  });

  it('navigator.allowlist rejects both ipfsCid and inline data', async () => {
    const { db } = await postAndGetContentJson({
      tag: 'daoships.navigator.allowlist',
      user: MEMBER1,
      content: {
        schemaVersion: '1.0',
        daoAddress: DAOSHIP,
        navigatorAddress: VALID_NAV,
        root: VALID_ROOT,
        ipfsCid: 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
        addresses: [MEMBER1],
        treeDump: { format: 'standard-v1', values: [] },
      },
    });
    const json = getContentJson(db);
    expect(json).toBeNull();
  });

  it('navigator.allowlist rejects invalid CID format', async () => {
    const { db } = await postAndGetContentJson({
      tag: 'daoships.navigator.allowlist',
      user: MEMBER1,
      content: {
        schemaVersion: '1.0',
        daoAddress: DAOSHIP,
        navigatorAddress: VALID_NAV,
        root: VALID_ROOT,
        ipfsCid: 'not-a-valid-cid',
      },
    });
    const json = getContentJson(db);
    expect(json).toBeNull();
  });

  // ── String limit enforcement (tightened) ───────────────────────

  it('name truncated at 100 chars', async () => {
    const longName = 'x'.repeat(200);
    const { db } = await postAndGetContentJson({
      tag: 'daoships.dao.profile',
      user: AVATAR,
      content: {
        schemaVersion: '1.0',
        daoAddress: DAOSHIP,
        name: longName,
      },
    });
    const json = getContentJson(db);
    expect(json!.name).toHaveLength(100);
  });

  it('description truncated at 1000 chars', async () => {
    const longDesc = 'y'.repeat(2000);
    const { db } = await postAndGetContentJson({
      tag: 'daoships.dao.profile',
      user: AVATAR,
      content: {
        schemaVersion: '1.0',
        daoAddress: DAOSHIP,
        name: 'Test',
        description: longDesc,
      },
    });
    const json = getContentJson(db);
    expect(json!.description).toHaveLength(1000);
  });

  it('reason truncated at 2000 chars', async () => {
    const longReason = 'z'.repeat(3000);
    const { db } = await postAndGetContentJson({
      tag: 'daoships.proposal.vote.reason',
      user: MEMBER1,
      content: {
        schemaVersion: '1.0',
        daoAddress: DAOSHIP,
        proposalId: 1,
        vote: true,
        reason: longReason,
      },
    });
    const json = getContentJson(db);
    expect((json!.reason as string)).toHaveLength(2000);
  });

  it('title truncated at 200 chars', async () => {
    const longTitle = 't'.repeat(300);
    const { db } = await postAndGetContentJson({
      tag: 'daoships.dao.announcement',
      user: AVATAR,
      content: {
        schemaVersion: '1.0',
        daoAddress: DAOSHIP,
        title: longTitle,
      },
    });
    const json = getContentJson(db);
    expect((json!.title as string)).toHaveLength(200);
  });

  // ── Security hardening ────────────────────────────────────────

  it('string with null bytes — null bytes stripped', async () => {
    const { db } = await postAndGetContentJson({
      tag: 'daoships.dao.profile',
      user: AVATAR,
      content: {
        schemaVersion: '1.0',
        daoAddress: DAOSHIP,
        name: 'My\x00DAO\x00Name',
        description: 'Clean\x00description',
      },
    });
    const json = getContentJson(db);
    expect(json!.name).toBe('MyDAOName');
    expect(json!.description).toBe('Cleandescription');
  });

  it('string with C0 control chars (\\x01\\x02) — stripped', async () => {
    const { db } = await postAndGetContentJson({
      tag: 'daoships.dao.profile',
      user: AVATAR,
      content: {
        schemaVersion: '1.0',
        daoAddress: DAOSHIP,
        name: 'DAO\x01with\x02controls',
      },
    });
    const json = getContentJson(db);
    expect(json!.name).toBe('DAOwithcontrols');
  });

  it('links with __proto__ key — key stripped', async () => {
    const { db } = await postAndGetContentJson({
      tag: 'daoships.dao.profile',
      user: AVATAR,
      content: {
        schemaVersion: '1.0',
        daoAddress: DAOSHIP,
        name: 'Test DAO',
        links: {
          __proto__: 'https://evil.com',
          website: 'https://example.com',
        },
      },
    });
    const json = getContentJson(db);
    const links = json!.links as Record<string, string>;
    expect(links).not.toHaveProperty('__proto__');
    expect(links.website).toBe('https://example.com');
  });

  it('links with constructor key — key stripped', async () => {
    const { db } = await postAndGetContentJson({
      tag: 'daoships.dao.profile',
      user: AVATAR,
      content: {
        schemaVersion: '1.0',
        daoAddress: DAOSHIP,
        name: 'Test DAO',
        links: {
          constructor: 'https://evil.com',
          discord: 'https://discord.gg/test',
        },
      },
    });
    const json = getContentJson(db);
    const links = json!.links as Record<string, string>;
    expect(links).not.toHaveProperty('constructor');
    expect(links.discord).toBe('https://discord.gg/test');
  });

  it('links with invalid key charset ("my link!") — key stripped', async () => {
    const { db } = await postAndGetContentJson({
      tag: 'daoships.dao.profile',
      user: AVATAR,
      content: {
        schemaVersion: '1.0',
        daoAddress: DAOSHIP,
        name: 'Test DAO',
        links: {
          'my link!': 'https://example.com',
          'has spaces': 'https://example.com',
          valid_key: 'https://example.com',
        },
      },
    });
    const json = getContentJson(db);
    const links = json!.links as Record<string, string>;
    expect(links).not.toHaveProperty('my link!');
    expect(links).not.toHaveProperty('has spaces');
    expect(links.valid_key).toBe('https://example.com');
  });

  it('URL field with javascript: scheme — field omitted', async () => {
    const { db } = await postAndGetContentJson({
      tag: 'daoships.dao.profile',
      user: AVATAR,
      content: {
        schemaVersion: '1.0',
        daoAddress: DAOSHIP,
        name: 'Test DAO',
        avatar: 'javascript:alert(document.cookie)',
        banner: 'javascript:void(0)',
      },
    });
    const json = getContentJson(db);
    expect(json).not.toHaveProperty('avatar');
    expect(json).not.toHaveProperty('banner');
    expect(json!.name).toBe('Test DAO');
  });

  it('URL field with null bytes — null bytes stripped before URL validation', async () => {
    const { db } = await postAndGetContentJson({
      tag: 'daoships.dao.profile',
      user: AVATAR,
      content: {
        schemaVersion: '1.0',
        daoAddress: DAOSHIP,
        name: 'Test DAO',
        avatar: 'https://example\x00.com/avatar.png',
      },
    });
    const json = getContentJson(db);
    expect(json!.avatar).toBe('https://example.com/avatar.png');
  });

  // ── Edge cases ────────────────────────────────────────────────

  it('validator returns null on bad input — content_json is null, record still stored', async () => {
    // dao.profile.initial requires name AND description; passing number for name triggers null
    const { db } = await postAndGetContentJson({
      tag: 'daoships.dao.profile.initial',
      user: LAUNCHER,
      content: {
        schemaVersion: '1.0',
        daoAddress: DAOSHIP,
        name: 12345 as any, // not a string — str() returns undefined
        description: 'Valid desc',
      },
    });
    expect(db.upsert).toHaveBeenCalledWith('ds_records', expect.objectContaining({
      dao_id: DAOSHIP,
      content_json: null,
    }));
  });

  it('empty object for tag with required fields — content_json is null', async () => {
    const { db } = await postAndGetContentJson({
      tag: 'daoships.proposal.vote.reason',
      user: MEMBER1,
      content: {
        schemaVersion: '1.0',
        daoAddress: DAOSHIP,
        // vote.reason requires reason — missing => null
      },
    });
    const json = getContentJson(db);
    expect(json).toBeNull();
  });

  it('string array with >20 items — truncated to 20', async () => {
    const tags = Array.from({ length: 30 }, (_, i) => `tag${i}`);
    const { db } = await postAndGetContentJson({
      tag: 'daoships.dao.profile',
      user: AVATAR,
      content: {
        schemaVersion: '1.0',
        daoAddress: DAOSHIP,
        name: 'Tag Test DAO',
        tags,
      },
    });
    const json = getContentJson(db);
    expect((json!.tags as string[]).length).toBe(20);
  });

  it('string array item exceeding max length — item truncated', async () => {
    const longTag = 'x'.repeat(100); // max is 50
    const { db } = await postAndGetContentJson({
      tag: 'daoships.dao.profile',
      user: AVATAR,
      content: {
        schemaVersion: '1.0',
        daoAddress: DAOSHIP,
        name: 'Tag Test DAO',
        tags: [longTag, 'short'],
      },
    });
    const json = getContentJson(db);
    const resultTags = json!.tags as string[];
    expect(resultTags[0].length).toBe(50);
    expect(resultTags[1]).toBe('short');
  });

  // ── Side-effect routing ───────────────────────────────────────

  it('dao.profile from vault — updateDao receives validated data (extra fields stripped)', async () => {
    const { db } = await postAndGetContentJson({
      tag: 'daoships.dao.profile',
      user: AVATAR,
      content: {
        schemaVersion: '1.0',
        daoAddress: DAOSHIP,
        name: 'Legit DAO',
        description: 'Real description',
        evilField: 'should not reach updateDao',
        avatar: 'https://example.com/avatar.png',
      },
    });
    expect(db.updateDao).toHaveBeenCalled();
    const updateArgs = db.updateDao.mock.calls[0][1] as Record<string, unknown>;
    expect(updateArgs.name).toBe('Legit DAO');
    expect(updateArgs.description).toBe('Real description');
    expect(updateArgs.avatar_img).toBe('https://example.com/avatar.png');
    expect(updateArgs.profile_source).toBe('vault');
    expect(updateArgs).not.toHaveProperty('evilField');
  });

});

// ── RangeCache integration ────────────────────────────────────
// Proves that the cache deduplicates `getDao` reads within a single
// handler call (handleNewPost + nested determineTrustLevel) and across
// repeated calls that share an EventContext.cache (same range).

describe('handleNewPost — cache efficacy', () => {
  beforeEach(() => vi.clearAllMocks());

  it('fetches DAO once per handler invocation (not twice across handleNewPost + determineTrustLevel)', async () => {
    const db = makeMockDb();
    db.getDao.mockResolvedValue({ id: DAOSHIP, avatar: AVATAR, deployer: LAUNCHER, launcher_contract: LAUNCHER });
    db.getMember.mockResolvedValue({ shares: '100' });
    const ctx = makeCtx({ db });
    const content = JSON.stringify({
      schemaVersion: '1.0',
      daoAddress: DAOSHIP,
      proposalId: 1,
      vote: true,
      reason: 'single-fetch guarantee',
    });
    const { id: keccak256 } = await import('quais');
    const tagHash = keccak256('daoships.proposal.vote.reason');

    await handleNewPost(ctx, { user: MEMBER1, content, tag: tagHash });

    // Pre-cache, the handler fetched the DAO twice (once in handleNewPost
    // at line 474, once inside determineTrustLevel at line 37). The cache
    // collapses this to a single DB read.
    expect(db.getDao).toHaveBeenCalledTimes(1);
    expect(ctx.cache.stats.daoHits).toBeGreaterThanOrEqual(1);
  });

  it('two sequential posts for the same DAO share one getDao call', async () => {
    const db = makeMockDb();
    db.getDao.mockResolvedValue({ id: DAOSHIP, avatar: AVATAR, deployer: LAUNCHER, launcher_contract: LAUNCHER });
    db.getMember.mockResolvedValue({ shares: '100' });
    const ctx = makeCtx({ db });
    const content = JSON.stringify({
      schemaVersion: '1.0',
      daoAddress: DAOSHIP,
      proposalId: 1,
      vote: true,
      reason: 'first',
    });
    const content2 = JSON.stringify({
      schemaVersion: '1.0',
      daoAddress: DAOSHIP,
      proposalId: 2,
      vote: true,
      reason: 'second',
    });
    const { id: keccak256 } = await import('quais');
    const tagHash = keccak256('daoships.proposal.vote.reason');

    await handleNewPost(ctx, { user: MEMBER1, content, tag: tagHash });
    await handleNewPost(ctx, { user: MEMBER1, content: content2, tag: tagHash });

    // One miss for the first post, hits for everything else.
    expect(db.getDao).toHaveBeenCalledTimes(1);
    expect(ctx.cache.stats.daoMisses).toBe(1);
    expect(ctx.cache.stats.daoHits).toBeGreaterThanOrEqual(3);
  });

  it('updateDao from dao.profile invalidates cache so next read refetches', async () => {
    const db = makeMockDb();
    db.getDao
      .mockResolvedValueOnce({ id: DAOSHIP, avatar: AVATAR, deployer: LAUNCHER, launcher_contract: LAUNCHER, profile_source: null })
      .mockResolvedValueOnce({ id: DAOSHIP, avatar: AVATAR, deployer: LAUNCHER, launcher_contract: LAUNCHER, profile_source: 'vault', name: 'Updated' });
    const ctx = makeCtx({ db });
    const { id: keccak256 } = await import('quais');
    const tagHash = keccak256('daoships.dao.profile');

    // Avatar is the trusted vault → VERIFIED trust → updateDao fires →
    // cache invalidated.
    const content = JSON.stringify({
      schemaVersion: '1.0',
      daoAddress: DAOSHIP,
      name: 'Updated',
    });
    await handleNewPost(ctx, { user: AVATAR, content, tag: tagHash });
    expect(db.updateDao).toHaveBeenCalled();

    // Second post for the same DAO should re-fetch (cache was invalidated).
    await handleNewPost(ctx, { user: AVATAR, content, tag: tagHash });
    expect(db.getDao).toHaveBeenCalledTimes(2);
  });
});

// ── daoships.dao.navigators (sanctioning) ───────────────────────────
// The vault-authenticated full-set sanction list. The poster's job: VERIFIED
// gate (msg.sender == dao.avatar), validate the content, and hand the parsed
// full set + the vault author to reconcileSanctionedNavigators (which is mocked
// here; its full-set/scoping/hold/de-sanction behavior is in signal.test.ts).

describe('handleNewPost — daoships.dao.navigators sanctioning', () => {
  const NAV2 = '0x000000000000000000000000000000000000000a';
  const makeCtx: typeof baseMakeCtx = (overrides = {}) =>
    baseMakeCtx({ ...overrides, log: { address: POSTER_ADDR, ...(overrides.log ?? {}) } });

  async function navTagHash() {
    const { id: keccak256 } = await import('quais');
    return keccak256('daoships.dao.navigators');
  }

  beforeEach(() => vi.clearAllMocks());

  it('routes the vault full-set to reconcileSanctionedNavigators (lowercased addrs, vault as author)', async () => {
    const db = makeMockDb();
    db.getDao.mockResolvedValue({ id: DAOSHIP, avatar: AVATAR, deployer: LAUNCHER, launcher_contract: LAUNCHER });
    const ctx = makeCtx({ db, log: { address: POSTER_ADDR, index: 0, transactionHash: TX_HASH } });
    const content = JSON.stringify({
      schemaVersion: '1.0',
      daoAddress: DAOSHIP,
      navigators: [
        { address: NAVIGATOR, type: 'SignalNavigator' },
        { address: NAV2 },
      ],
    });

    await handleNewPost(ctx, { user: AVATAR, content, tag: await navTagHash() });

    expect(reconcileSanctionedNavigators).toHaveBeenCalledTimes(1);
    const [, daoId, author, listed] = (reconcileSanctionedNavigators as any).mock.calls[0];
    expect(daoId).toBe(DAOSHIP);
    expect(author).toBe(AVATAR); // the vault (msg.sender), used to stamp held intents
    expect(listed).toEqual([
      { address: NAVIGATOR, type: 'SignalNavigator' },
      { address: NAV2 },
    ]);
    // The post itself is recorded for the feed.
    expect(db.upsert).toHaveBeenCalledWith('ds_records', expect.objectContaining({ tag: 'daoships.dao.navigators' }));
  });

  it('passes an empty full-set through (empty array clears all sanctions)', async () => {
    const db = makeMockDb();
    db.getDao.mockResolvedValue({ id: DAOSHIP, avatar: AVATAR, deployer: LAUNCHER, launcher_contract: LAUNCHER });
    const ctx = makeCtx({ db });
    const content = JSON.stringify({ schemaVersion: '1.0', daoAddress: DAOSHIP, navigators: [] });

    await handleNewPost(ctx, { user: AVATAR, content, tag: await navTagHash() });

    expect(reconcileSanctionedNavigators).toHaveBeenCalledTimes(1);
    expect((reconcileSanctionedNavigators as any).mock.calls[0][3]).toEqual([]);
  });

  it('drops malformed navigator entries before reconciling (validator filters bad addresses)', async () => {
    const db = makeMockDb();
    db.getDao.mockResolvedValue({ id: DAOSHIP, avatar: AVATAR, deployer: LAUNCHER, launcher_contract: LAUNCHER });
    const ctx = makeCtx({ db });
    const content = JSON.stringify({
      schemaVersion: '1.0',
      daoAddress: DAOSHIP,
      navigators: [
        { address: NAVIGATOR },
        { address: 'not-an-address' },
        { notAnAddress: true },
        'garbage',
      ],
    });

    await handleNewPost(ctx, { user: AVATAR, content, tag: await navTagHash() });

    expect((reconcileSanctionedNavigators as any).mock.calls[0][3]).toEqual([{ address: NAVIGATOR }]);
  });

  it('REJECTS a non-vault author (MEMBER trust < VERIFIED): no reconcile, no record', async () => {
    const db = makeMockDb();
    db.getDao.mockResolvedValue({ id: DAOSHIP, avatar: AVATAR, deployer: LAUNCHER, launcher_contract: LAUNCHER });
    db.getMember.mockResolvedValue({ shares: '100' }); // a real member, but not the vault
    const ctx = makeCtx({ db });
    const content = JSON.stringify({
      schemaVersion: '1.0',
      daoAddress: DAOSHIP,
      navigators: [{ address: NAVIGATOR }],
    });

    await handleNewPost(ctx, { user: MEMBER1, content, tag: await navTagHash() });

    expect(reconcileSanctionedNavigators).not.toHaveBeenCalled();
    expect(db.upsert).not.toHaveBeenCalled(); // insufficient trust short-circuits before the record write
  });

  it('records the post but skips reconcile when content fails validation (no navigators array)', async () => {
    const db = makeMockDb();
    db.getDao.mockResolvedValue({ id: DAOSHIP, avatar: AVATAR, deployer: LAUNCHER, launcher_contract: LAUNCHER });
    const ctx = makeCtx({ db });
    // Vault author clears the trust gate, but the body is missing the required
    // `navigators` array → validator returns null → routing block is skipped.
    const content = JSON.stringify({ schemaVersion: '1.0', daoAddress: DAOSHIP });

    await handleNewPost(ctx, { user: AVATAR, content, tag: await navTagHash() });

    expect(reconcileSanctionedNavigators).not.toHaveBeenCalled();
    expect(db.upsert).toHaveBeenCalledWith('ds_records', expect.objectContaining({
      tag: 'daoships.dao.navigators',
      content_json: null,
    }));
  });
});

// ── daoships.signal.poll (option labels) ─────────────────────────
// Trust gate is creator-identity (msg.sender == PollCreated.creator), NOT DAO rank.
// Labels decorate an already-materialized poll row; see SIGNAL_POLL_LABELS_SUPPORT.md.

describe('handleNewPost — daoships.signal.poll', () => {
  beforeEach(() => vi.clearAllMocks());

  const NOW = 1700000000;                         // makeCtx default blockTimestamp
  const FUTURE_END = NOW + 86400;                 // active poll: voting_ends in the future
  const pollPk = `${NAVIGATOR.toLowerCase()}-0`;

  const pollTagHash = async () => (await import('quais')).id('daoships.signal.poll');

  const makeContent = (over: Record<string, unknown> = {}) => JSON.stringify({
    schemaVersion: '1.0',
    daoAddress: DAOSHIP,
    navigatorAddress: NAVIGATOR,
    pollId: 0,
    options: ['Teal', 'Magenta', 'Slate'],
    description: 'Pick the v2 brand color.',
    discussionUrl: 'https://forum.example.xyz/t/789',
    ...over,
  });

  // creator == MEMBER1, 3 options, active poll
  const activePoll = {
    creator: MEMBER1, option_count: 3, voting_ends: FUTURE_END, cancelled: false, labels_block_number: null,
  };

  it('applies labels when sender is the poll creator, length matches, and poll is active', async () => {
    const db = makeMockDb();
    db.getDao.mockResolvedValue({ id: DAOSHIP, avatar: AVATAR });
    db.getSignalPoll.mockResolvedValue(activePoll);
    const ctx = makeCtx({ db, log: { address: POSTER_ADDR, index: 0, transactionHash: TX_HASH, blockNumber: 100 } });

    await handleNewPost(ctx, { user: MEMBER1, content: makeContent(), tag: await pollTagHash() });

    // Audit row written at MEMBER trust
    expect(db.upsert).toHaveBeenCalledWith('ds_records', expect.objectContaining({
      tag: 'daoships.signal.poll',
      trust_level: 'MEMBER',
      dao_id: DAOSHIP,
    }));
    // Labels applied to the materialized poll row
    expect(db.applyPollLabels).toHaveBeenCalledWith(pollPk, expect.objectContaining({
      options: ['Teal', 'Magenta', 'Slate'],
      description: 'Pick the v2 brand color.',
      discussionUrl: 'https://forum.example.xyz/t/789',
      labelsBlockNumber: 100,
    }));
  });

  it('discards labels (still records audit) when the sender is NOT the poll creator', async () => {
    const db = makeMockDb();
    db.getDao.mockResolvedValue({ id: DAOSHIP, avatar: AVATAR });
    db.getSignalPoll.mockResolvedValue({ ...activePoll, creator: MEMBER2 }); // poll opened by someone else
    const ctx = makeCtx({ db });

    await handleNewPost(ctx, { user: MEMBER1, content: makeContent(), tag: await pollTagHash() });

    expect(db.upsert).toHaveBeenCalledWith('ds_records', expect.objectContaining({ tag: 'daoships.signal.poll' }));
    expect(db.applyPollLabels).not.toHaveBeenCalled();
  });

  it('discards labels when options.length != on-chain option_count', async () => {
    const db = makeMockDb();
    db.getDao.mockResolvedValue({ id: DAOSHIP, avatar: AVATAR });
    db.getSignalPoll.mockResolvedValue({ ...activePoll, option_count: 2 }); // contract says 2, post has 3
    const ctx = makeCtx({ db });

    await handleNewPost(ctx, { user: MEMBER1, content: makeContent(), tag: await pollTagHash() });

    expect(db.applyPollLabels).not.toHaveBeenCalled();
  });

  it('ignores labels once the poll has ended (post block timestamp >= voting_ends)', async () => {
    const db = makeMockDb();
    db.getDao.mockResolvedValue({ id: DAOSHIP, avatar: AVATAR });
    db.getSignalPoll.mockResolvedValue({ ...activePoll, voting_ends: NOW - 1 }); // already ended
    const ctx = makeCtx({ db });

    await handleNewPost(ctx, { user: MEMBER1, content: makeContent(), tag: await pollTagHash() });

    expect(db.applyPollLabels).not.toHaveBeenCalled();
  });

  it('ignores labels for a cancelled poll', async () => {
    const db = makeMockDb();
    db.getDao.mockResolvedValue({ id: DAOSHIP, avatar: AVATAR });
    db.getSignalPoll.mockResolvedValue({ ...activePoll, cancelled: true });
    const ctx = makeCtx({ db });

    await handleNewPost(ctx, { user: MEMBER1, content: makeContent(), tag: await pollTagHash() });

    expect(db.applyPollLabels).not.toHaveBeenCalled();
  });

  it('discards labels (does not hold) when the poll row is not materialized', async () => {
    const db = makeMockDb();
    db.getDao.mockResolvedValue({ id: DAOSHIP, avatar: AVATAR });
    db.getSignalPoll.mockResolvedValue(null); // poll absent (out-of-flow unsanctioned navigator)
    const ctx = makeCtx({ db });

    await handleNewPost(ctx, { user: MEMBER1, content: makeContent(), tag: await pollTagHash() });

    expect(db.upsert).toHaveBeenCalledWith('ds_records', expect.objectContaining({ tag: 'daoships.signal.poll' }));
    expect(db.applyPollLabels).not.toHaveBeenCalled();
  });

  it('skips entirely (no record) when the claimed DAO is not indexed', async () => {
    const db = makeMockDb();
    db.getDao.mockResolvedValue(null); // unknown DAO
    const ctx = makeCtx({ db });

    await handleNewPost(ctx, { user: MEMBER1, content: makeContent(), tag: await pollTagHash() });

    expect(db.upsert).not.toHaveBeenCalled();
    expect(db.getSignalPoll).not.toHaveBeenCalled();
    expect(db.applyPollLabels).not.toHaveBeenCalled();
  });

  it('rejects malformed content before any DB work (options below minimum)', async () => {
    const db = makeMockDb();
    db.getDao.mockResolvedValue({ id: DAOSHIP, avatar: AVATAR });
    const ctx = makeCtx({ db });
    const content = makeContent({ options: ['OnlyOne'] }); // < MIN_OPTIONS(2) → validator returns null

    await handleNewPost(ctx, { user: MEMBER1, content, tag: await pollTagHash() });

    expect(db.upsert).not.toHaveBeenCalled();
    expect(db.applyPollLabels).not.toHaveBeenCalled();
  });
});
