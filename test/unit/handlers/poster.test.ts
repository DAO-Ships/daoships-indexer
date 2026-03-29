import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleNewPost } from '../../../src/handlers/poster.js';
import {
  DAOSHIP, AVATAR, MEMBER1, MEMBER2, LAUNCHER, TX_HASH, NAVIGATOR,
  makeCtx, makeMockDb, makeMockRegistry,
} from './helpers.js';

// ── handleNewPost ────────────────────────────────────────────────

describe('handleNewPost', () => {
  beforeEach(() => vi.clearAllMocks());

  it('resolves DAO from content.daoAddress and upserts record with recognized tag', async () => {
    const db = makeMockDb();
    db.getDao.mockResolvedValue({ id: DAOSHIP, avatar: AVATAR, launcher: LAUNCHER });
    db.getMember.mockResolvedValue({ shares: '100' });
    const ctx = makeCtx({
      db,
      log: { address: '0x0000000000000000000000000000000000000099', index: 0, transactionHash: TX_HASH },
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
    db.getDao.mockResolvedValue({ id: DAOSHIP, avatar: AVATAR, launcher: LAUNCHER });
    const ctx = makeCtx({ db });
    const { id: keccak256 } = await import('quais');
    const tagHash = keccak256('daoships.member.profile');

    await handleNewPost(ctx, { user: MEMBER1, content: 'plain text content', tag: tagHash });

    expect(db.upsert).not.toHaveBeenCalled();
  });

  it('hard rejects content exceeding 16KB', async () => {
    const db = makeMockDb();
    db.getDao.mockResolvedValue({ id: DAOSHIP, avatar: AVATAR, launcher: LAUNCHER });
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
    db.getDao.mockResolvedValue({ id: DAOSHIP, avatar: AVATAR, launcher: LAUNCHER });
    db.getMember.mockResolvedValue({ shares: '100' });
    const ctx = makeCtx({
      db,
      log: { address: '0x0000000000000000000000000000000000000099', index: 0, transactionHash: TX_HASH },
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
    db.getDao.mockResolvedValue({ id: DAOSHIP, avatar: AVATAR, launcher: LAUNCHER });
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
    db.getDao.mockResolvedValue({ id: DAOSHIP, avatar: AVATAR, launcher: LAUNCHER });
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
    db.getDao.mockResolvedValue({ id: DAOSHIP, avatar: AVATAR, launcher: LAUNCHER });
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

    db.getDao.mockResolvedValue({ id: DAOSHIP, avatar: AVATAR, launcher: LAUNCHER });
    db.getMember.mockResolvedValue(null);
    const registry = makeMockRegistry();
    registry.getDaoByNavigatorAddress.mockReturnValue(undefined);
    const ctx = makeCtx({
      db,
      registry,
      log: { address: '0x0000000000000000000000000000000000000099', index: 0, transactionHash: TX_HASH },
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

    db.getDao.mockResolvedValue({ id: DAOSHIP, avatar: AVATAR, launcher: LAUNCHER });
    const ctx = makeCtx({
      db,
      log: { address: '0x0000000000000000000000000000000000000099', index: 0, transactionHash: TX_HASH },
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

    db.getDao.mockResolvedValue({ id: DAOSHIP, avatar: AVATAR, launcher: LAUNCHER, profile_source: null });
    const ctx = makeCtx({
      db,
      log: { address: '0x0000000000000000000000000000000000000099', index: 0, transactionHash: TX_HASH },
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
    db.getDao.mockResolvedValue({ id: DAOSHIP, avatar: AVATAR, launcher: LAUNCHER, profile_source: 'vault' });
    const ctx = makeCtx({
      db,
      log: { address: '0x0000000000000000000000000000000000000099', index: 0, transactionHash: TX_HASH },
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
    db.getDao.mockResolvedValue({ id: DAOSHIP, avatar: AVATAR, launcher: LAUNCHER });
    db.getMember.mockResolvedValue(null);
    const registry = makeMockRegistry();
    registry.getDaoByNavigatorAddress.mockReturnValue(DAOSHIP); // makes user SEMI_TRUSTED
    const ctx = makeCtx({
      db,
      registry,
      log: { address: '0x0000000000000000000000000000000000000099', index: 0, transactionHash: TX_HASH },
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

    db.getDao.mockResolvedValue({ id: DAOSHIP, avatar: AVATAR, launcher: LAUNCHER });
    const ctx = makeCtx({
      db,
      log: { address: '0x0000000000000000000000000000000000000099', index: 0, transactionHash: TX_HASH },
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

    db.getDao.mockResolvedValue({ id: DAOSHIP, avatar: AVATAR, launcher: LAUNCHER });
    const ctx = makeCtx({
      db,
      log: { address: '0x0000000000000000000000000000000000000099', index: 0, transactionHash: TX_HASH },
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
    db.getDao.mockResolvedValue({ id: DAOSHIP, avatar: AVATAR, launcher: LAUNCHER });
    db.getMember.mockResolvedValue({ shares: '100' });
    opts.dbSetup?.(db);
    const registry = makeMockRegistry();
    opts.registrySetup?.(registry);
    const ctx = makeCtx({
      db,
      registry,
      log: { address: '0x0000000000000000000000000000000000000099', index: 0, transactionHash: TX_HASH },
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
    db.getDao.mockResolvedValue({ id: DAOSHIP, avatar: AVATAR, launcher: LAUNCHER });
    db.getMember.mockResolvedValue({ shares: '100' });
    const ctx = makeCtx({
      db,
      log: { address: '0x0000000000000000000000000000000000000099', index: 0, transactionHash: TX_HASH },
    });
    const tagHash = keccak('daoships.dao.profile');
    const content = JSON.stringify({ daoAddress: DAOSHIP, name: 'Test' });

    await handleNewPost(ctx, { user: AVATAR, content, tag: tagHash });

    expect(db.upsert).not.toHaveBeenCalled();
  });

  it('rejects non-JSON content (no record stored)', async () => {
    const db = makeMockDb();
    db.getDao.mockResolvedValue({ id: DAOSHIP, avatar: AVATAR, launcher: LAUNCHER });
    const ctx = makeCtx({
      db,
      log: { address: '0x0000000000000000000000000000000000000099', index: 0, transactionHash: TX_HASH },
    });
    const tagHash = keccak('daoships.dao.profile');

    await handleNewPost(ctx, { user: AVATAR, content: 'not json at all', tag: tagHash });

    expect(db.upsert).not.toHaveBeenCalled();
  });

  it('hard rejects content exceeding 16KB (no record stored)', async () => {
    const db = makeMockDb();
    db.getDao.mockResolvedValue({ id: DAOSHIP, avatar: AVATAR, launcher: LAUNCHER });
    db.getMember.mockResolvedValue({ shares: '100' });
    const ctx = makeCtx({
      db,
      log: { address: '0x0000000000000000000000000000000000000099', index: 0, transactionHash: TX_HASH },
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
        db.getDao.mockResolvedValue({ id: DAOSHIP, avatar: AVATAR, launcher: LAUNCHER, profile_source: 'vault' });
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

  // ── navigator.metadata (simplified: name + description only) ───

  it('navigator.metadata has no config, sourceCode, auditReport, or permissions', async () => {
    const navigatorAddr = NAVIGATOR;
    const { db } = await postAndGetContentJson({
      tag: 'daoships.navigator.metadata',
      user: MEMBER1,
      content: {
        schemaVersion: '1.0',
        daoAddress: DAOSHIP,
        navigatorAddress: navigatorAddr,
        name: 'My Navigator',
        description: 'Nav description',
        config: { key: 'value' },
        sourceCode: 'https://github.com/example',
        auditReport: 'https://example.com/audit',
        permissions: ['read', 'write'],
      },
      registrySetup: (reg) => {
        reg.getDaoByNavigatorAddress.mockReturnValue(DAOSHIP);
      },
    });
    const json = getContentJson(db);
    expect(json).not.toHaveProperty('config');
    expect(json).not.toHaveProperty('sourceCode');
    expect(json).not.toHaveProperty('auditReport');
    expect(json).not.toHaveProperty('permissions');
    expect(json!.name).toBe('My Navigator');
    expect(json!.description).toBe('Nav description');
  });

  it('navigator.metadata with name + description — accepted', async () => {
    const navigatorAddr = NAVIGATOR;
    const { db } = await postAndGetContentJson({
      tag: 'daoships.navigator.metadata',
      user: MEMBER1,
      content: {
        schemaVersion: '1.0',
        daoAddress: DAOSHIP,
        navigatorAddress: navigatorAddr,
        name: 'My Navigator',
        description: 'A useful navigator',
      },
      registrySetup: (reg) => {
        reg.getDaoByNavigatorAddress.mockReturnValue(DAOSHIP);
      },
    });
    const json = getContentJson(db);
    expect(json).toEqual({
      daoAddress: DAOSHIP,
      navigatorAddress: navigatorAddr,
      name: 'My Navigator',
      description: 'A useful navigator',
      schemaVersion: '1.0',
    });
  });

  // ── treasury.label ─────────────────────────────────────────────

  it('treasury.label with valid labels — accepted', async () => {
    const { db } = await postAndGetContentJson({
      tag: 'daoships.treasury.label',
      user: AVATAR,
      content: {
        schemaVersion: '1.0',
        daoAddress: DAOSHIP,
        labels: [
          { address: '0x0000000000000000000000000000000000000042', label: 'Treasury', purpose: 'Main fund' },
        ],
      },
    });
    const json = getContentJson(db);
    expect(json).toEqual({
      daoAddress: DAOSHIP,
      labels: [
        { address: '0x0000000000000000000000000000000000000042', label: 'Treasury', purpose: 'Main fund' },
      ],
      schemaVersion: '1.0',
    });
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

  it('navigator.metadata — updateNavigator receives name + description only', async () => {
    const navigatorAddr = NAVIGATOR;
    const { db } = await postAndGetContentJson({
      tag: 'daoships.navigator.metadata',
      user: MEMBER1,
      content: {
        schemaVersion: '1.0',
        daoAddress: DAOSHIP,
        navigatorAddress: navigatorAddr,
        name: 'Nav Name',
        description: 'Nav Description',
        evilField: 'should not reach updateNavigator',
      },
      registrySetup: (reg) => {
        reg.getDaoByNavigatorAddress.mockReturnValue(DAOSHIP);
      },
    });
    expect(db.updateNavigator).toHaveBeenCalled();
    const [navId, navData] = db.updateNavigator.mock.calls[0] as [string, Record<string, unknown>];
    expect(navId).toBe(`${DAOSHIP}-${navigatorAddr}`);
    expect(navData.name).toBe('Nav Name');
    expect(navData.description).toBe('Nav Description');
    expect(navData).not.toHaveProperty('evilField');
    expect(navData).not.toHaveProperty('config');
  });
});
