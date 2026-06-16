import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  handleSetupComplete,
  handleSubmitProposal,
  handleSponsorProposal,
  handleSubmitVote,
  handleProcessProposal,
  handleCancelProposal,
  handleRagequit,
  handleNavigatorSet,
  handleNavigatorDeployed,
  handleGovernanceConfigSet,
  handleSetGuildTokens,
  handleMintShares,
  handleMintLoot,
  handleBurnShares,
  handleBurnLoot,
  handleLockAdmin,
  handleLockManager,
  handleLockGovernor,
  handleConvertSharesToLoot,
  handleAdminConfigSet,
} from '../../../src/handlers/daoship.js';
import {
  DAOSHIP, SHARES, LOOT, AVATAR, MEMBER1, MEMBER2, NAVIGATOR, LAUNCHER, TOKEN_A, TX_HASH,
  makeCtx, makeMockDb, makeMockBlockchain, makeMockRegistry,
} from './helpers.js';

// Minimal DAO row returned by getDao mock
const MOCK_DAO = {
  id: DAOSHIP,
  total_shares: '1000',
  total_loot: '500',
  voting_period: 3600,
  grace_period: 3600,
};

beforeEach(() => {
  vi.clearAllMocks();
});

// ── handleSetupComplete ─────────────────────────────────────────

describe('handleSetupComplete', () => {
  it('updates DAO with governance params and inserts guild tokens', async () => {
    const db = makeMockDb();
    const ctx = makeCtx({
      db,
      log: { address: DAOSHIP },
    });

    await handleSetupComplete(ctx, {
      lootPaused: false,
      sharesPaused: false,
      gracePeriod: 3600n,
      votingPeriod: 7200n,
      proposalOffering: 0n,
      quorumPercent: 20n,
      sponsorThreshold: 0n,
      minRetentionPercent: 66n,
      defaultExpiryWindow: 0n,
      name: 'My DAO Shares',
      symbol: 'MDS',
      lootName: 'DAO Loot',
      lootSymbol: 'DL',
      guildTokens: [TOKEN_A],
      totalShares: 1000n,
      totalLoot: 500n,
    });

    expect(db.updateDao).toHaveBeenCalledWith(DAOSHIP, expect.objectContaining({
      voting_period: 7200,
      grace_period: 3600,
      quorum_percent: '20',
      total_shares: '1000',
      total_loot: '500',
      share_token_name: 'My DAO Shares',
      loot_token_name: 'DAO Loot',
      loot_token_symbol: 'DL',
    }));

    expect(db.upsert).toHaveBeenCalledWith('ds_guild_tokens', expect.objectContaining({
      dao_id: DAOSHIP,
      token_address: TOKEN_A,
      enabled: true,
    }));
  });
});

// ── handleSubmitProposal ────────────────────────────────────────

describe('handleSubmitProposal', () => {
  it('upserts proposal and increments proposal count', async () => {
    const db = makeMockDb();
    const ctx = makeCtx({
      db,
      log: { address: DAOSHIP },
    });

    const VALID_HASH = '0x' + 'bb'.repeat(32);
    await handleSubmitProposal(ctx, {
      proposal: 1n,
      proposalDataHash: VALID_HASH,
      submitter: MEMBER1,
      votingPeriod: 3600n,
      proposalData: '0x',
      expiration: 0n,
      selfSponsor: false,
      timestamp: 1700000000n,
      details: '{"title":"Test"}',
      proposalOffering: 0n,
    });

    expect(db.upsertProposal).toHaveBeenCalledWith(expect.objectContaining({
      dao_id: DAOSHIP,
      proposal_id: 1,
      sponsored: false,
      cancelled: false,
      processed: false,
    }));
    expect(db.incrementProposalCount).toHaveBeenCalledWith(DAOSHIP);
  });

  it('self-sponsored proposal has sponsored=true', async () => {
    const db = makeMockDb();
    const ctx = makeCtx({
      db,
      log: { address: DAOSHIP },
    });

    const VALID_HASH = '0x' + 'bb'.repeat(32);
    await handleSubmitProposal(ctx, {
      proposal: 2n,
      proposalDataHash: VALID_HASH,
      submitter: MEMBER1,
      votingPeriod: 3600n,
      proposalData: '0x',
      expiration: 0n,
      selfSponsor: true,
      timestamp: 1700000000n,
      details: '',
      proposalOffering: 0n,
    });

    expect(db.upsertProposal).toHaveBeenCalledWith(expect.objectContaining({ sponsored: true }));
  });

  it('truncates oversized details', async () => {
    const db = makeMockDb();
    const ctx = makeCtx({
      db,
      log: { address: DAOSHIP },
    });

    const VALID_HASH = '0x' + 'bb'.repeat(32);
    const bigDetails = 'x'.repeat(70000);
    await handleSubmitProposal(ctx, {
      proposal: 3n,
      proposalDataHash: VALID_HASH,
      submitter: MEMBER1,
      votingPeriod: 3600n,
      proposalData: '0x',
      expiration: 0n,
      selfSponsor: false,
      timestamp: 1700000000n,
      details: bigDetails,
      proposalOffering: 0n,
    });

    const call = db.upsertProposal.mock.calls[0][0];
    expect(call.details.length).toBe(65536);
  });
});

// ── handleSponsorProposal ───────────────────────────────────────

describe('handleSponsorProposal', () => {
  it('updates proposal with sponsored=true and voting times from event args', async () => {
    const db = makeMockDb();
    const ctx = makeCtx({
      db,
      log: { address: DAOSHIP },
    });

    const votingStartsTs = 1700000000n;
    const votingEndsTs = BigInt(1700000000 + 3600);
    const graceEndsTs = BigInt(1700000000 + 3600 + 1800);

    await handleSponsorProposal(ctx, {
      member: MEMBER1,
      proposal: 1n,
      votingStarts: votingStartsTs,
      votingEnds: votingEndsTs,
      graceEnds: graceEndsTs,
      maxTotalSharesAtSponsor: 1000n,
      maxTotalSharesAndLootAtVote: 1500n,
    });

    expect(db.updateProposal).toHaveBeenCalledWith(
      `${DAOSHIP}-1`,
      expect.objectContaining({
        sponsored: true,
        sponsor: MEMBER1,
        voting_starts: new Date(1700000000 * 1000).toISOString(),
        voting_ends: new Date(Number(votingEndsTs) * 1000).toISOString(),
        grace_ends: new Date(Number(graceEndsTs) * 1000).toISOString(),
        max_total_shares_at_sponsor: '1000',
        max_total_shares_and_loot_at_vote: '1500',
      }),
    );
    expect(db.updateDao).toHaveBeenCalledWith(DAOSHIP, { latest_sponsored_proposal_id: 1 });
  });
});

// ── handleSubmitVote ────────────────────────────────────────────

describe('handleSubmitVote', () => {
  it('upserts vote, increments tallies, and creates stub proposal if missing', async () => {
    const db = makeMockDb();
    // E1: stub path uses insertProposalIfAbsent (no pre-read)
    db.insertProposalIfAbsent.mockResolvedValue(true);  // true = actually inserted
    db.insertMemberIfAbsent.mockResolvedValue(false);   // member already exists
    const ctx = makeCtx({ db, log: { address: DAOSHIP } });

    await handleSubmitVote(ctx, {
      member: MEMBER1,
      balance: 100n,
      proposal: 5n,
      approved: true,
    });

    expect(db.insertProposalIfAbsent).toHaveBeenCalledWith(expect.objectContaining({
      details: '_stub:true',
    }));
    expect(db.upsertVote).toHaveBeenCalledWith(expect.objectContaining({
      voter: MEMBER1,
      approved: true,
      balance: '100',
    }));
    expect(db.incrementProposalVotes).toHaveBeenCalledWith(`${DAOSHIP}-5`, true, '100');
    expect(db.incrementMemberVotes).toHaveBeenCalled();
  });

  it('creates stub member when voter not found', async () => {
    const db = makeMockDb();
    // E1: stub path uses insertMemberIfAbsent (no pre-read)
    db.insertProposalIfAbsent.mockResolvedValue(false); // proposal exists
    db.insertMemberIfAbsent.mockResolvedValue(true);    // member stub inserted
    const ctx = makeCtx({ db, log: { address: DAOSHIP } });

    await handleSubmitVote(ctx, {
      member: MEMBER1, balance: 50n, proposal: 1n, approved: false,
    });

    expect(db.insertMemberIfAbsent).toHaveBeenCalledWith(expect.objectContaining({
      member_address: MEMBER1,
      shares: '0',
      loot: '0',
    }));
  });

  it('does not warn when both proposal and member already exist', async () => {
    const db = makeMockDb();
    db.insertProposalIfAbsent.mockResolvedValue(false);
    db.insertMemberIfAbsent.mockResolvedValue(false);
    const ctx = makeCtx({ db, log: { address: DAOSHIP } });

    await handleSubmitVote(ctx, {
      member: MEMBER1, balance: 50n, proposal: 1n, approved: true,
    });

    // Still records the vote
    expect(db.upsertVote).toHaveBeenCalled();
    // No stub paths fired
    expect(db.upsertMember).not.toHaveBeenCalled();
    expect(db.upsertProposal).not.toHaveBeenCalled();
  });
});

// ── handleProcessProposal ───────────────────────────────────────

describe('handleProcessProposal', () => {
  it('marks proposal as processed with correct fields', async () => {
    const db = makeMockDb();
    const ctx = makeCtx({
      db,
      log: { address: DAOSHIP },
    });

    await handleProcessProposal(ctx, { proposal: 3n, passed: true, actionFailed: false, processor: MEMBER2 });

    expect(db.updateProposal).toHaveBeenCalledWith(`${DAOSHIP}-3`, expect.objectContaining({
      processed: true,
      passed: true,
      action_failed: false,
      processed_by: MEMBER2,
    }));
  });

  it('records actionFailed=true even when passed', async () => {
    const db = makeMockDb();
    const ctx = makeCtx({ db, log: { address: DAOSHIP } });

    await handleProcessProposal(ctx, { proposal: 4n, passed: true, actionFailed: true, processor: MEMBER1 });

    expect(db.updateProposal).toHaveBeenCalledWith(`${DAOSHIP}-4`, expect.objectContaining({
      passed: true,
      action_failed: true,
    }));
  });
});

// ── handleCancelProposal ────────────────────────────────────────

describe('handleCancelProposal', () => {
  it('marks proposal as cancelled', async () => {
    const db = makeMockDb();
    const ctx = makeCtx({
      db,
      log: { address: DAOSHIP },
    });

    await handleCancelProposal(ctx, { proposal: 2n, canceller: MEMBER1 });

    expect(db.updateProposal).toHaveBeenCalledWith(`${DAOSHIP}-2`, expect.objectContaining({
      cancelled: true,
      cancelled_by: MEMBER1,
    }));
  });
});

// ── handleRagequit ──────────────────────────────────────────────

describe('handleRagequit', () => {
  it('upserts ragequit record with correct fields', async () => {
    const db = makeMockDb();
    db.getMember.mockResolvedValue({ id: `${DAOSHIP}-${MEMBER1}` });
    const ctx = makeCtx({ db, log: { address: DAOSHIP } });

    await handleRagequit(ctx, {
      member: MEMBER1,
      to: MEMBER2,
      lootToBurn: 50n,
      sharesToBurn: 100n,
      tokens: [TOKEN_A],
      amounts: ['1000000000000000000'],
    });

    expect(db.upsert).toHaveBeenCalledWith('ds_ragequits', expect.objectContaining({
      dao_id: DAOSHIP,
      member_address: MEMBER1,
      to_address: MEMBER2,
      shares_burned: '100',
      loot_burned: '50',
      tokens: [TOKEN_A],
    }));
  });

  it('creates stub member if member not found', async () => {
    const db = makeMockDb();
    // E1: stub path uses insertMemberIfAbsent (no pre-read)
    db.insertMemberIfAbsent.mockResolvedValue(true);
    db.getDao.mockResolvedValue(MOCK_DAO);
    const ctx = makeCtx({ db, log: { address: DAOSHIP } });

    await handleRagequit(ctx, {
      member: MEMBER1, to: MEMBER2, lootToBurn: 0n, sharesToBurn: 50n, tokens: [], amounts: [],
    });

    expect(db.insertMemberIfAbsent).toHaveBeenCalledWith(expect.objectContaining({
      member_address: MEMBER1,
      shares: '0',
    }));
  });

  it('queues DAO for end-of-range recompute (Option B — no per-log adjustDaoTotals)', async () => {
    const db = makeMockDb();
    db.getMember.mockResolvedValue({ id: `${DAOSHIP}-${MEMBER1}` });
    const ctx = makeCtx({ db, log: { address: DAOSHIP } });

    await handleRagequit(ctx, {
      member: MEMBER1, to: MEMBER2, lootToBurn: 50n, sharesToBurn: 100n, tokens: [], amounts: [],
    });

    // No per-log total adjustment; member balances come through Transfer
    // events and DAO totals get recomputed once at end-of-range.
    expect(db.adjustDaoTotals).not.toHaveBeenCalled();
    expect(ctx.dirtyDaoIds.has(DAOSHIP)).toBe(true);
  });

  it('does NOT queue dirty DAO when both burn amounts are zero', async () => {
    const db = makeMockDb();
    db.getMember.mockResolvedValue({ id: `${DAOSHIP}-${MEMBER1}` });
    const ctx = makeCtx({ db, log: { address: DAOSHIP } });

    await handleRagequit(ctx, {
      member: MEMBER1, to: MEMBER2, lootToBurn: 0n, sharesToBurn: 0n, tokens: [], amounts: [],
    });

    expect(ctx.dirtyDaoIds.has(DAOSHIP)).toBe(false);
  });

  it('skips when tokens/amounts array lengths mismatch', async () => {
    const db = makeMockDb();
    const ctx = makeCtx({ db, log: { address: DAOSHIP } });

    await handleRagequit(ctx, {
      member: MEMBER1, to: MEMBER2, lootToBurn: 0n, sharesToBurn: 50n,
      tokens: [TOKEN_A, '0x000000000000000000000000000000000000000a'], amounts: ['100'],
    });

    expect(db.upsert).not.toHaveBeenCalled();
  });
});

// ── handleNavigatorSet ─────────────────────────────────────────

describe('handleNavigatorSet', () => {
  it('registers navigator in registry when permission > 0', async () => {
    const db = makeMockDb();
    const registry = makeMockRegistry();
    registry.getDaoByDaoShipAddress.mockReturnValue({ daoShipAddress: DAOSHIP });
    const ctx = makeCtx({ db, registry, log: { address: DAOSHIP } });

    await handleNavigatorSet(ctx, { navigator: NAVIGATOR, permission: 4n });

    expect(db.upsert).toHaveBeenCalledWith('ds_navigators', expect.objectContaining({
      navigator_address: NAVIGATOR,
      permission: 4,
      is_active: true,
      permission_label: 'governor',
    }));
    expect(registry.registerNavigator).toHaveBeenCalledWith(NAVIGATOR, DAOSHIP);
    expect(registry.unregisterNavigator).not.toHaveBeenCalled();
  });

  it('unregisters navigator when permission=0', async () => {
    const db = makeMockDb();
    const registry = makeMockRegistry();
    registry.getDaoByDaoShipAddress.mockReturnValue({ daoShipAddress: DAOSHIP });
    const ctx = makeCtx({ db, registry, log: { address: DAOSHIP } });

    await handleNavigatorSet(ctx, { navigator: NAVIGATOR, permission: 0n });

    expect(db.upsert).toHaveBeenCalledWith('ds_navigators', expect.objectContaining({
      is_active: false,
      permission: 0,
    }));
    expect(registry.unregisterNavigator).toHaveBeenCalledWith(NAVIGATOR);
    expect(registry.registerNavigator).not.toHaveBeenCalled();
  });

  it('skips negative permission (invalid)', async () => {
    const db = makeMockDb();
    const ctx = makeCtx({ db, log: { address: DAOSHIP } });

    await handleNavigatorSet(ctx, { navigator: NAVIGATOR, permission: -1n });

    expect(db.upsert).not.toHaveBeenCalled();
  });

  it('skips permission > 7 (reserved bits)', async () => {
    const db = makeMockDb();
    const ctx = makeCtx({ db, log: { address: DAOSHIP } });

    await handleNavigatorSet(ctx, { navigator: NAVIGATOR, permission: 8n });

    expect(db.upsert).not.toHaveBeenCalled();
  });

  it('flips permission_ever_granted + trust_status=sanctioned on a grant from a known DAO', async () => {
    const db = makeMockDb();
    const registry = makeMockRegistry();
    registry.getDaoByDaoShipAddress.mockReturnValue({ daoShipAddress: DAOSHIP });
    const ctx = makeCtx({ db, registry, log: { address: DAOSHIP } });

    await handleNavigatorSet(ctx, { navigator: NAVIGATOR, permission: 4n });

    // Metadata (deployer/type/name) is NOT re-written here — it was bound by
    // NavigatorDeployed and is preserved by the partial upsert. The grant only moves
    // permission + the monotonic discriminator + trust.
    const upsertData = db.upsert.mock.calls[0][1];
    expect(upsertData).toMatchObject({
      permission: 4,
      is_active: true,
      permission_ever_granted: true,
      trust_status: 'sanctioned',
    });
    expect(upsertData).not.toHaveProperty('deployer');
  });

  it('preserves permission_ever_granted/trust_status on revoke (keeps revoked history)', async () => {
    const db = makeMockDb();
    const registry = makeMockRegistry();
    registry.getDaoByDaoShipAddress.mockReturnValue({ daoShipAddress: DAOSHIP });
    const ctx = makeCtx({ db, registry, log: { address: DAOSHIP } });

    await handleNavigatorSet(ctx, { navigator: NAVIGATOR, permission: 0n });

    const upsertData = db.upsert.mock.calls[0][1];
    expect(upsertData).toMatchObject({ permission: 0, is_active: false });
    // Omitted on revoke so the existing values survive (revoked => ever_granted stays true).
    expect(upsertData).not.toHaveProperty('permission_ever_granted');
    expect(upsertData).not.toHaveProperty('trust_status');
  });

  it('does not flip permission_ever_granted when the grant is from an UNKNOWN DAOShip', async () => {
    const db = makeMockDb();
    const registry = makeMockRegistry();
    registry.getDaoByDaoShipAddress.mockReturnValue(undefined); // emitter not a known DAOShip
    const ctx = makeCtx({ db, registry, log: { address: DAOSHIP } });

    await handleNavigatorSet(ctx, { navigator: NAVIGATOR, permission: 4n });

    // trust_status is still set (permission > 0), but the monotonic discriminator only
    // flips for a KNOWN DAOShip (per the doc), and the navigator isn't registered.
    const upsertData = db.upsert.mock.calls[0][1];
    expect(upsertData).not.toHaveProperty('permission_ever_granted');
    expect(registry.registerNavigator).not.toHaveBeenCalled();
  });

  it('upserts to DB but skips registry when daoship not in registry', async () => {
    const db = makeMockDb();
    const registry = makeMockRegistry();
    registry.getDaoByDaoShipAddress.mockReturnValue(undefined); // unknown DAO
    const ctx = makeCtx({ db, registry, log: { address: DAOSHIP } });

    await handleNavigatorSet(ctx, { navigator: NAVIGATOR, permission: 4n });

    expect(db.upsert).toHaveBeenCalled();
    expect(registry.registerNavigator).not.toHaveBeenCalled();
  });
});

// ── handleGovernanceConfigSet ───────────────────────────────────

describe('handleGovernanceConfigSet', () => {
  it('updates DAO governance fields', async () => {
    const db = makeMockDb();
    const ctx = makeCtx({ db, log: { address: DAOSHIP } });

    await handleGovernanceConfigSet(ctx, {
      votingPeriod: 7200n,
      gracePeriod: 3600n,
      proposalOffering: 0n,
      quorumPercent: 30n,
      sponsorThreshold: 0n,
      minRetentionPercent: 50n,
      defaultExpiryWindow: 0n,
    });

    expect(db.updateDao).toHaveBeenCalledWith(DAOSHIP, expect.objectContaining({
      voting_period: 7200,
      grace_period: 3600,
      quorum_percent: '30',
      min_retention_percent: '50',
    }));
  });
});

// ── handleSetGuildTokens ────────────────────────────────────────

describe('handleSetGuildTokens', () => {
  it('upserts each token/enabled pair', async () => {
    const db = makeMockDb();
    const ctx = makeCtx({ db, log: { address: DAOSHIP } });

    await handleSetGuildTokens(ctx, {
      tokens: [TOKEN_A, MEMBER1], // valid addresses
      enabled: [true, false],
    });

    expect(db.upsert).toHaveBeenCalledTimes(2);
    const calls = db.upsert.mock.calls;
    expect(calls[0][1]).toMatchObject({ token_address: TOKEN_A, enabled: true });
    expect(calls[1][1]).toMatchObject({ token_address: MEMBER1, enabled: false });
  });

  it('validates each token address', async () => {
    const db = makeMockDb();
    const ctx = makeCtx({ db, log: { address: DAOSHIP } });

    await expect(
      handleSetGuildTokens(ctx, { tokens: ['not-an-address'], enabled: [true] })
    ).rejects.toThrow('Invalid tokens[0]');
  });

  it('skips all tokens when lengths mismatch', async () => {
    const db = makeMockDb();
    const ctx = makeCtx({ db, log: { address: DAOSHIP } });

    await handleSetGuildTokens(ctx, { tokens: [TOKEN_A, MEMBER1], enabled: [true] });

    expect(db.upsert).not.toHaveBeenCalled();
  });
});

// ── handleMintShares / handleBurnShares / handleMintLoot / handleBurnLoot ──

// Option B: Mint/Burn handlers no longer call adjustDaoTotals. They only
// flag the DAO dirty for end-of-range `ds_recompute_dao_totals`. Member
// balances are authoritative via the Transfer event handler.

describe('handleMintShares', () => {
  it('queues dirty DAO for end-of-range recompute', async () => {
    const db = makeMockDb();
    const ctx = makeCtx({ db, log: { address: DAOSHIP } });

    await handleMintShares(ctx, { to: [MEMBER1, MEMBER2], amount: [100n, 200n] });

    expect(db.adjustDaoTotals).not.toHaveBeenCalled();
    expect(ctx.dirtyDaoIds.has(DAOSHIP)).toBe(true);
  });

  it('handleBurnShares also queues the DAO dirty', async () => {
    const db = makeMockDb();
    const ctx = makeCtx({ db, log: { address: DAOSHIP } });

    await handleBurnShares(ctx, { from: [MEMBER1], amount: [100n] });

    expect(db.adjustDaoTotals).not.toHaveBeenCalled();
    expect(ctx.dirtyDaoIds.has(DAOSHIP)).toBe(true);
  });
});

describe('handleMintLoot', () => {
  it('queues dirty DAO', async () => {
    const db = makeMockDb();
    const ctx = makeCtx({ db, log: { address: DAOSHIP } });

    await handleMintLoot(ctx, { to: [MEMBER1], amount: [250n] });

    expect(db.adjustDaoTotals).not.toHaveBeenCalled();
    expect(ctx.dirtyDaoIds.has(DAOSHIP)).toBe(true);
  });
});

describe('handleBurnLoot', () => {
  it('queues dirty DAO', async () => {
    const db = makeMockDb();
    const ctx = makeCtx({ db, log: { address: DAOSHIP } });

    await handleBurnLoot(ctx, { from: [MEMBER1], amount: [100n] });

    expect(db.adjustDaoTotals).not.toHaveBeenCalled();
    expect(ctx.dirtyDaoIds.has(DAOSHIP)).toBe(true);
  });
});

// ── handleLockAdmin / handleLockManager / handleLockGovernor ────

describe('handleLockAdmin', () => {
  it('sets admin_locked=true', async () => {
    const db = makeMockDb();
    const ctx = makeCtx({ db, log: { address: DAOSHIP } });
    await handleLockAdmin(ctx, { lock: true });
    expect(db.updateDao).toHaveBeenCalledWith(DAOSHIP, { admin_locked: true });
  });

  it('sets admin_locked=false', async () => {
    const db = makeMockDb();
    const ctx = makeCtx({ db, log: { address: DAOSHIP } });
    await handleLockAdmin(ctx, { lock: false });
    expect(db.updateDao).toHaveBeenCalledWith(DAOSHIP, { admin_locked: false });
  });
});

describe('handleLockManager', () => {
  it('sets manager_locked', async () => {
    const db = makeMockDb();
    const ctx = makeCtx({ db, log: { address: DAOSHIP } });
    await handleLockManager(ctx, { lock: true });
    expect(db.updateDao).toHaveBeenCalledWith(DAOSHIP, { manager_locked: true });
  });
});

describe('handleLockGovernor', () => {
  it('sets governor_locked', async () => {
    const db = makeMockDb();
    const ctx = makeCtx({ db, log: { address: DAOSHIP } });
    await handleLockGovernor(ctx, { lock: true });
    expect(db.updateDao).toHaveBeenCalledWith(DAOSHIP, { governor_locked: true });
  });
});

// ── handleConvertSharesToLoot ──────────────────────────────────

describe('handleConvertSharesToLoot', () => {
  // ConvertSharesToLoot handler only updates DAO totals. Member balances
  // are updated by the Transfer events (burn shares + mint loot) that fire
  // from the contract's sharesToken.burn() / lootToken.mint() calls.

  it('queues DAO dirty for end-of-range recompute (member balances owned by Transfer handler)', async () => {
    const db = makeMockDb();
    const ctx = makeCtx({ db, log: { address: DAOSHIP } });

    await handleConvertSharesToLoot(ctx, { from: MEMBER1, amount: 30n });

    expect(db.adjustDaoTotals).not.toHaveBeenCalled();
    expect(ctx.dirtyDaoIds.has(DAOSHIP)).toBe(true);
    // Member balance NOT updated — Transfer handler owns that.
    expect(db.upsertMember).not.toHaveBeenCalled();
  });
});

// ── handleAdminConfigSet ──────────────────────────────────────

describe('handleAdminConfigSet', () => {
  it('sets both sharesPaused=true and lootPaused=true', async () => {
    const db = makeMockDb();
    const ctx = makeCtx({ db, log: { address: DAOSHIP } });

    await handleAdminConfigSet(ctx, { sharesPaused: true, lootPaused: true });

    expect(db.updateDao).toHaveBeenCalledWith(DAOSHIP, {
      shares_paused: true,
      loot_paused: true,
    });
  });

  it('sets both sharesPaused=false and lootPaused=false', async () => {
    const db = makeMockDb();
    const ctx = makeCtx({ db, log: { address: DAOSHIP } });

    await handleAdminConfigSet(ctx, { sharesPaused: false, lootPaused: false });

    expect(db.updateDao).toHaveBeenCalledWith(DAOSHIP, {
      shares_paused: false,
      loot_paused: false,
    });
  });

  it('handles mixed flags: sharesPaused=true, lootPaused=false', async () => {
    const db = makeMockDb();
    const ctx = makeCtx({ db, log: { address: DAOSHIP } });

    await handleAdminConfigSet(ctx, { sharesPaused: true, lootPaused: false });

    expect(db.updateDao).toHaveBeenCalledWith(DAOSHIP, {
      shares_paused: true,
      loot_paused: false,
    });
  });
});

// ── handleGovernanceConfigSet: default_expiry_window ──────────

describe('handleGovernanceConfigSet (default_expiry_window)', () => {
  it('stores default_expiry_window field', async () => {
    const db = makeMockDb();
    const ctx = makeCtx({ db, log: { address: DAOSHIP } });

    await handleGovernanceConfigSet(ctx, {
      votingPeriod: 7200n,
      gracePeriod: 3600n,
      proposalOffering: 0n,
      quorumPercent: 30n,
      sponsorThreshold: 0n,
      minRetentionPercent: 50n,
      defaultExpiryWindow: 86400n,
    });

    expect(db.updateDao).toHaveBeenCalledWith(DAOSHIP, expect.objectContaining({
      default_expiry_window: 86400,
    }));
  });
});

// ── handleSetupComplete: default_expiry_window ──────────────────

describe('handleSetupComplete (default_expiry_window)', () => {
  it('decodes defaultExpiryWindow and writes default_expiry_window to DB', async () => {
    const db = makeMockDb();
    const ctx = makeCtx({
      db,
      log: { address: DAOSHIP },
    });

    await handleSetupComplete(ctx, {
      lootPaused: false,
      sharesPaused: false,
      gracePeriod: 3600n,
      votingPeriod: 7200n,
      proposalOffering: 0n,
      quorumPercent: 20n,
      sponsorThreshold: 0n,
      minRetentionPercent: 66n,
      defaultExpiryWindow: 86400n,
      name: 'My DAO Shares',
      symbol: 'MDS',
      lootName: 'DAO Loot',
      lootSymbol: 'DL',
      guildTokens: [TOKEN_A],
      totalShares: 1000n,
      totalLoot: 500n,
    });

    expect(db.updateDao).toHaveBeenCalledWith(DAOSHIP, expect.objectContaining({
      default_expiry_window: 86400,
    }));
  });
});

// ── handleNavigatorDeployed ────────────────────────────────────

describe('handleNavigatorDeployed', () => {
  const VALID_ROOT = '0x' + 'ab'.repeat(32);
  const BYTES32_ZERO = '0x' + '0'.repeat(64);

  it('binds dao_id for a permissioned navigator and leaves it inert until NavigatorSet', async () => {
    const db = makeMockDb();
    const blockchain = makeMockBlockchain();
    // Default: rawCall rejects — navigator has no allowlistRoot()
    blockchain.rawCall.mockRejectedValue(new Error('execution reverted'));
    const ctx = makeCtx({
      db,
      blockchain,
      log: { address: NAVIGATOR },
    });

    await handleNavigatorDeployed(ctx, {
      daoShip: DAOSHIP,
      deployer: MEMBER1,
      navigatorType: 'OnboarderNavigator',
      name: 'My Nav',
      description: 'Does things',
    });

    // dao_id is bound from the event for EVERY navigator now (no more dao_id: null orphan).
    // A permissioned navigator is inert (is_active false) until a NavigatorSet grants permission,
    // and is implicitly 'sanctioned' (it will be vouched by NavigatorSet).
    expect(db.upsert).toHaveBeenCalledWith('ds_navigators', expect.objectContaining({
      id: `${DAOSHIP}-${NAVIGATOR}`,
      dao_id: DAOSHIP,
      navigator_address: NAVIGATOR,
      deployer: MEMBER1,
      navigator_type: 'OnboarderNavigator',
      name: 'My Nav',
      description: 'Does things',
      permission: 0,
      permission_ever_granted: false,
      trust_status: 'sanctioned',
      is_active: false,
      deploy_block: 100,
      allowlist_root: null, // no allowlist — rawCall reverted
    }));
  });

  it('binds a read-only (SignalNavigator) row as self_asserted + active when the DAO is known', async () => {
    const db = makeMockDb();
    const registry = makeMockRegistry();
    registry.getDaoByDaoShipAddress.mockReturnValue({ daoShipAddress: DAOSHIP, avatar: AVATAR });
    const ctx = makeCtx({ db, registry, log: { address: NAVIGATOR } });

    await handleNavigatorDeployed(ctx, {
      daoShip: DAOSHIP,
      deployer: MEMBER1,
      navigatorType: 'SignalNavigator',
      name: 'Polls',
      description: 'Temperature checks',
    });

    expect(db.upsert).toHaveBeenCalledWith('ds_navigators', expect.objectContaining({
      dao_id: DAOSHIP,
      navigator_type: 'SignalNavigator',
      permission: 0,
      permission_ever_granted: false,
      trust_status: 'self_asserted',
      is_active: true, // read-only is functional at permission 0
    }));
    // Registered so getDaoFromNavigator resolves without an RPC.
    expect(registry.registerNavigator).toHaveBeenCalledWith(NAVIGATOR, DAOSHIP);
  });

  it('IGNORES a read-only navigator whose claimed DAO is unknown (resolution gate)', async () => {
    const db = makeMockDb();
    const registry = makeMockRegistry();
    registry.getDaoByDaoShipAddress.mockReturnValue(undefined); // DAO not indexed
    const ctx = makeCtx({ db, registry, log: { address: NAVIGATOR } });

    await handleNavigatorDeployed(ctx, {
      daoShip: DAOSHIP,
      deployer: MEMBER1,
      navigatorType: 'SignalNavigator',
      name: 'Spam',
      description: 'x',
    });

    expect(db.upsert).not.toHaveBeenCalled();
    expect(registry.registerNavigator).not.toHaveBeenCalled();
  });

  it('applies a held vault sanction intent on a read-only deploy (ordering)', async () => {
    const db = makeMockDb();
    db.consumeSanctionIntent.mockResolvedValue(AVATAR); // vault had pre-sanctioned this address
    const registry = makeMockRegistry();
    registry.getDaoByDaoShipAddress.mockReturnValue({ daoShipAddress: DAOSHIP, avatar: AVATAR });
    const ctx = makeCtx({ db, registry, log: { address: NAVIGATOR } });

    await handleNavigatorDeployed(ctx, {
      daoShip: DAOSHIP,
      deployer: MEMBER1,
      navigatorType: 'SignalNavigator',
      name: 'Polls',
      description: 'x',
    });

    expect(db.consumeSanctionIntent).toHaveBeenCalledWith(DAOSHIP, NAVIGATOR);
    expect(db.upsert).toHaveBeenCalledWith('ds_navigators', expect.objectContaining({
      trust_status: 'sanctioned',
    }));
  });

  it('binds a module (BudgetNavigator) row as self_asserted + INACTIVE, registered, even vs an unknown DAO', async () => {
    const db = makeMockDb();
    const registry = makeMockRegistry();
    registry.getDaoByDaoShipAddress.mockReturnValue(undefined); // predicted/unknown DAO at deploy time
    const ctx = makeCtx({ db, registry, log: { address: NAVIGATOR } });

    await handleNavigatorDeployed(ctx, {
      daoShip: DAOSHIP,
      deployer: MEMBER1,
      navigatorType: 'BudgetNavigator',
      name: 'Treasury',
      description: 'Payroll',
    });

    // NOT dropped by the resolution gate (that gate is read-only only): a budget nav can be
    // deployed against a predicted DAO. Born powerless (is_active false) until the vault enables it.
    expect(db.upsert).toHaveBeenCalledWith('ds_navigators', expect.objectContaining({
      dao_id: DAOSHIP,
      navigator_type: 'BudgetNavigator',
      permission: 0,
      permission_ever_granted: false,
      trust_status: 'self_asserted',
      is_active: false,
    }));
    // Registered so the vault-module watch can resolve module → DAO without an RPC.
    expect(registry.registerNavigator).toHaveBeenCalledWith(NAVIGATOR, DAOSHIP);
  });

  it('applies a held vault EnabledModule intent on a budget deploy → sanctioned + active (ordering)', async () => {
    const db = makeMockDb();
    db.consumeSanctionIntent.mockResolvedValue(AVATAR); // vault enabled it before we saw the deploy
    const registry = makeMockRegistry();
    registry.getDaoByDaoShipAddress.mockReturnValue({ daoShipAddress: DAOSHIP, avatar: AVATAR });
    const ctx = makeCtx({ db, registry, log: { address: NAVIGATOR } });

    await handleNavigatorDeployed(ctx, {
      daoShip: DAOSHIP,
      deployer: MEMBER1,
      navigatorType: 'BudgetNavigator',
      name: 'Treasury',
      description: 'x',
    });

    expect(db.consumeSanctionIntent).toHaveBeenCalledWith(DAOSHIP, NAVIGATOR);
    expect(db.upsert).toHaveBeenCalledWith('ds_navigators', expect.objectContaining({
      trust_status: 'sanctioned',
      is_active: true, // vault already enabled the module
    }));
  });

  // H1: allowlistRoot() is best-effort cached at deploy time so allowlist
  // NewPost events can be verified without further RPC calls.
  it('caches allowlist_root from rawCall when navigator has a non-zero allowlist', async () => {
    const db = makeMockDb();
    const blockchain = makeMockBlockchain();
    blockchain.rawCall.mockResolvedValue(VALID_ROOT);
    const ctx = makeCtx({ db, blockchain, log: { address: NAVIGATOR } });

    await handleNavigatorDeployed(ctx, {
      daoShip: DAOSHIP,
      deployer: MEMBER1,
      navigatorType: 'OnboarderNavigator',
      name: 'Nav',
      description: 'x',
    });

    expect(db.upsert).toHaveBeenCalledWith('ds_navigators', expect.objectContaining({
      allowlist_root: VALID_ROOT,
    }));
  });

  it('normalizes zero allowlist root to NULL (open allowlist)', async () => {
    const db = makeMockDb();
    const blockchain = makeMockBlockchain();
    blockchain.rawCall.mockResolvedValue(BYTES32_ZERO);
    const ctx = makeCtx({ db, blockchain, log: { address: NAVIGATOR } });

    await handleNavigatorDeployed(ctx, {
      daoShip: DAOSHIP,
      deployer: MEMBER1,
      navigatorType: 'OnboarderNavigator',
      name: 'Nav',
      description: 'x',
    });

    expect(db.upsert).toHaveBeenCalledWith('ds_navigators', expect.objectContaining({
      allowlist_root: null,
    }));
  });

  it('leaves allowlist_root NULL when rawCall reverts (deterministic)', async () => {
    const db = makeMockDb();
    const blockchain = makeMockBlockchain();
    blockchain.rawCall.mockRejectedValue(new Error('execution reverted'));
    const ctx = makeCtx({ db, blockchain, log: { address: NAVIGATOR } });

    await handleNavigatorDeployed(ctx, {
      daoShip: DAOSHIP,
      deployer: MEMBER1,
      navigatorType: 'SomeNavigatorWithoutAllowlist',
      name: 'Nav',
      description: 'x',
    });

    expect(db.upsert).toHaveBeenCalledWith('ds_navigators', expect.objectContaining({
      allowlist_root: null,
    }));
    // The write should still succeed — allowlistRoot() absence is expected.
    expect(db.upsert).toHaveBeenCalled();
  });

  it('leaves allowlist_root NULL on unexpected rawCall return length', async () => {
    const db = makeMockDb();
    const blockchain = makeMockBlockchain();
    blockchain.rawCall.mockResolvedValue('0x1234'); // too short
    const ctx = makeCtx({ db, blockchain, log: { address: NAVIGATOR } });

    await handleNavigatorDeployed(ctx, {
      daoShip: DAOSHIP,
      deployer: MEMBER1,
      navigatorType: 'OnboarderNavigator',
      name: 'Nav',
      description: 'x',
    });

    expect(db.upsert).toHaveBeenCalledWith('ds_navigators', expect.objectContaining({
      allowlist_root: null,
    }));
  });
});
