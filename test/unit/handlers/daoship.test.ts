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
  DAOSHIP, SHARES, LOOT, MEMBER1, MEMBER2, NAVIGATOR, LAUNCHER, TOKEN_A, TX_HASH,
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

beforeEach(() => vi.clearAllMocks());

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
    db.getProposal.mockResolvedValue(null);   // trigger stub creation
    db.getMember.mockResolvedValue({ id: `${DAOSHIP}-${MEMBER1}` });
    const ctx = makeCtx({ db, log: { address: DAOSHIP } });

    await handleSubmitVote(ctx, {
      member: MEMBER1,
      balance: 100n,
      proposal: 5n,
      approved: true,
    });

    expect(db.upsertProposal).toHaveBeenCalledWith(expect.objectContaining({
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
    db.getProposal.mockResolvedValue({ id: `${DAOSHIP}-1` });
    db.getMember.mockResolvedValue(null); // trigger stub creation
    const ctx = makeCtx({ db, log: { address: DAOSHIP } });

    await handleSubmitVote(ctx, {
      member: MEMBER1, balance: 50n, proposal: 1n, approved: false,
    });

    expect(db.upsertMember).toHaveBeenCalledWith(expect.objectContaining({
      member_address: MEMBER1,
      shares: '0',
      loot: '0',
    }));
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
    db.getMember.mockResolvedValue(null); // trigger stub
    db.getDao.mockResolvedValue(MOCK_DAO);
    const ctx = makeCtx({ db, log: { address: DAOSHIP } });

    await handleRagequit(ctx, {
      member: MEMBER1, to: MEMBER2, lootToBurn: 0n, sharesToBurn: 50n, tokens: [], amounts: [],
    });

    expect(db.upsertMember).toHaveBeenCalledWith(expect.objectContaining({
      member_address: MEMBER1,
      shares: '0',
    }));
  });

  it('decrements DAO total_shares and total_loot on ragequit', async () => {
    const db = makeMockDb();
    db.getMember.mockResolvedValue({ id: `${DAOSHIP}-${MEMBER1}` });
    db.getDao.mockResolvedValue({ ...MOCK_DAO, total_shares: '500', total_loot: '200' });
    const ctx = makeCtx({ db, log: { address: DAOSHIP } });

    await handleRagequit(ctx, {
      member: MEMBER1, to: MEMBER2, lootToBurn: 50n, sharesToBurn: 100n, tokens: [], amounts: [],
    });

    expect(db.updateDao).toHaveBeenCalledWith(DAOSHIP, {
      total_shares: '400',
      total_loot: '150',
    });
  });

  it('only updates total_shares when lootToBurn is zero', async () => {
    const db = makeMockDb();
    db.getMember.mockResolvedValue({ id: `${DAOSHIP}-${MEMBER1}` });
    db.getDao.mockResolvedValue({ ...MOCK_DAO, total_shares: '500', total_loot: '200' });
    const ctx = makeCtx({ db, log: { address: DAOSHIP } });

    await handleRagequit(ctx, {
      member: MEMBER1, to: MEMBER2, lootToBurn: 0n, sharesToBurn: 100n, tokens: [], amounts: [],
    });

    expect(db.updateDao).toHaveBeenCalledWith(DAOSHIP, {
      total_shares: '400',
    });
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

  it('skips permission > 255 (invalid)', async () => {
    const db = makeMockDb();
    const ctx = makeCtx({ db, log: { address: DAOSHIP } });

    await handleNavigatorSet(ctx, { navigator: NAVIGATOR, permission: 256n });

    expect(db.upsert).not.toHaveBeenCalled();
  });

  it('populates deployer, name, description from NavigatorDeployed event', async () => {
    const db = makeMockDb();
    const blockchain = makeMockBlockchain();
    const iface = new (await import('quais')).Interface([{
      type: 'event', name: 'NavigatorDeployed',
      inputs: [
        { name: 'daoShip', type: 'address', indexed: true },
        { name: 'deployer', type: 'address', indexed: true },
        { name: 'navigatorType', type: 'string', indexed: false },
        { name: 'name', type: 'string', indexed: false },
        { name: 'description', type: 'string', indexed: false },
      ],
    }]);
    const fragment = iface.getEvent('NavigatorDeployed')!;
    const encoded = iface.encodeEventLog(fragment, [DAOSHIP, MEMBER1, 'OnboarderNavigator', 'My Nav', 'Does things']);
    blockchain.getLogs.mockResolvedValue([{
      topics: encoded.topics,
      data: encoded.data,
      address: NAVIGATOR,
      blockNumber: 50,
      transactionHash: TX_HASH,
      index: 0,
      transactionIndex: 0,
    }]);
    const registry = makeMockRegistry();
    registry.getDaoByDaoShipAddress.mockReturnValue({ daoShipAddress: DAOSHIP });
    const ctx = makeCtx({ db, blockchain, registry, log: { address: DAOSHIP } });

    await handleNavigatorSet(ctx, { navigator: NAVIGATOR, permission: 4n });

    expect(blockchain.getLogs).toHaveBeenCalled();
    expect(db.upsert).toHaveBeenCalledWith('ds_navigators', expect.objectContaining({
      deployer: MEMBER1,
      navigator_type: 'OnboarderNavigator',
      name: 'My Nav',
      description: 'Does things',
    }));
  });

  it('rejects NavigatorDeployed when daoShip does not match', async () => {
    const db = makeMockDb();
    const blockchain = makeMockBlockchain();
    const iface = new (await import('quais')).Interface([{
      type: 'event', name: 'NavigatorDeployed',
      inputs: [
        { name: 'daoShip', type: 'address', indexed: true },
        { name: 'deployer', type: 'address', indexed: true },
        { name: 'navigatorType', type: 'string', indexed: false },
        { name: 'name', type: 'string', indexed: false },
        { name: 'description', type: 'string', indexed: false },
      ],
    }]);
    const fragment = iface.getEvent('NavigatorDeployed')!;
    const wrongDao = '0x0000000000000000000000000000000000000099';
    const encoded = iface.encodeEventLog(fragment, [wrongDao, MEMBER1, 'OnboarderNavigator', 'Fake', 'Bad']);
    blockchain.getLogs.mockResolvedValue([{
      topics: encoded.topics, data: encoded.data,
      address: NAVIGATOR, blockNumber: 50, transactionHash: TX_HASH, index: 0, transactionIndex: 0,
    }]);
    const registry = makeMockRegistry();
    registry.getDaoByDaoShipAddress.mockReturnValue({ daoShipAddress: DAOSHIP });
    const ctx = makeCtx({ db, blockchain, registry, log: { address: DAOSHIP } });

    await handleNavigatorSet(ctx, { navigator: NAVIGATOR, permission: 4n });

    expect(db.upsert).toHaveBeenCalledWith('ds_navigators', expect.objectContaining({
      deployer: null,
      name: null,
      description: null,
    }));
  });

  it('handles missing NavigatorDeployed gracefully', async () => {
    const db = makeMockDb();
    const blockchain = makeMockBlockchain();
    blockchain.getLogs.mockResolvedValue([]);
    const registry = makeMockRegistry();
    registry.getDaoByDaoShipAddress.mockReturnValue({ daoShipAddress: DAOSHIP });
    const ctx = makeCtx({ db, blockchain, registry, log: { address: DAOSHIP } });

    await handleNavigatorSet(ctx, { navigator: NAVIGATOR, permission: 4n });

    expect(db.upsert).toHaveBeenCalledWith('ds_navigators', expect.objectContaining({
      deployer: null,
      navigator_type: null,
      name: null,
      description: null,
    }));
  });

  it('skips NavigatorDeployed fetch when permission=0', async () => {
    const db = makeMockDb();
    const blockchain = makeMockBlockchain();
    const registry = makeMockRegistry();
    registry.getDaoByDaoShipAddress.mockReturnValue({ daoShipAddress: DAOSHIP });
    const ctx = makeCtx({ db, blockchain, registry, log: { address: DAOSHIP } });

    await handleNavigatorSet(ctx, { navigator: NAVIGATOR, permission: 0n });

    expect(blockchain.getLogs).not.toHaveBeenCalled();
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

describe('handleMintShares', () => {
  it('updates total_shares via getDao + updateDao', async () => {
    const db = makeMockDb();
    db.getDao.mockResolvedValue(MOCK_DAO);
    const ctx = makeCtx({ db, log: { address: DAOSHIP } });

    await handleMintShares(ctx, { to: [MEMBER1, MEMBER2], amount: [100n, 200n] });

    // Total delta = +300
    expect(db.updateDao).toHaveBeenCalledWith(DAOSHIP, { total_shares: '1300' });
  });

  it('clamps total_shares to 0 when burn exceeds total', async () => {
    const db = makeMockDb();
    db.getDao.mockResolvedValue({ ...MOCK_DAO, total_shares: '50' });
    const ctx = makeCtx({ db, log: { address: DAOSHIP } });

    // Burn 100 from a total of 50 — should clamp
    await handleBurnShares(ctx, { from: [MEMBER1], amount: [100n] });

    expect(db.updateDao).toHaveBeenCalledWith(DAOSHIP, { total_shares: '0' });
  });

  it('skips when DAO not found', async () => {
    const db = makeMockDb();
    db.getDao.mockResolvedValue(null);
    const ctx = makeCtx({ db, log: { address: DAOSHIP } });

    await handleMintShares(ctx, { to: [MEMBER1], amount: [100n] });

    expect(db.updateDao).not.toHaveBeenCalled();
  });
});

describe('handleMintLoot', () => {
  it('updates total_loot', async () => {
    const db = makeMockDb();
    db.getDao.mockResolvedValue(MOCK_DAO);
    const ctx = makeCtx({ db, log: { address: DAOSHIP } });

    await handleMintLoot(ctx, { to: [MEMBER1], amount: [250n] });

    expect(db.updateDao).toHaveBeenCalledWith(DAOSHIP, { total_loot: '750' });
  });
});

describe('handleBurnLoot', () => {
  it('updates total_loot on burn', async () => {
    const db = makeMockDb();
    db.getDao.mockResolvedValue(MOCK_DAO);
    const ctx = makeCtx({ db, log: { address: DAOSHIP } });

    await handleBurnLoot(ctx, { from: [MEMBER1], amount: [100n] });

    expect(db.updateDao).toHaveBeenCalledWith(DAOSHIP, { total_loot: '400' });
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

  it('updates DAO totals only (member balances owned by Transfer handler)', async () => {
    const db = makeMockDb();
    db.getDao.mockResolvedValue({ ...MOCK_DAO, total_shares: '1000', total_loot: '500' });
    const ctx = makeCtx({ db, log: { address: DAOSHIP } });

    await handleConvertSharesToLoot(ctx, { from: MEMBER1, amount: 30n });

    // DAO: total_shares 1000-30=970, total_loot 500+30=530
    expect(db.updateDao).toHaveBeenCalledWith(DAOSHIP, {
      total_shares: '970',
      total_loot: '530',
    });
    // Member balance NOT updated — Transfer handler owns that
    expect(db.upsertMember).not.toHaveBeenCalled();
  });

  it('clamps DAO total_shares to 0 when conversion exceeds total (C1 audit fix)', async () => {
    const db = makeMockDb();
    db.getDao.mockResolvedValue({ ...MOCK_DAO, total_shares: '10', total_loot: '500' });
    const ctx = makeCtx({ db, log: { address: DAOSHIP } });

    await handleConvertSharesToLoot(ctx, { from: MEMBER1, amount: 20n });

    // DAO: total_shares clamped to 0, total_loot 500+20=520
    expect(db.updateDao).toHaveBeenCalledWith(DAOSHIP, {
      total_shares: '0',
      total_loot: '520',
    });
    expect(db.upsertMember).not.toHaveBeenCalled();
  });

  it('skips DAO totals when DAO not found', async () => {
    const db = makeMockDb();
    db.getDao.mockResolvedValue(null);
    const ctx = makeCtx({ db, log: { address: DAOSHIP } });

    await handleConvertSharesToLoot(ctx, { from: MEMBER1, amount: 50n });

    expect(db.updateDao).not.toHaveBeenCalled();
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
