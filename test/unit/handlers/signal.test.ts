import { describe, it, expect, vi } from 'vitest';
import {
  handlePollCreated,
  handleVoted,
  handlePollCancelled,
  reconcileSanctionedNavigators,
  backfillNavigatorPolls,
  signalNavigatorIface,
} from '../../../src/handlers/signal.js';
import { config } from '../../../src/config.js';
import {
  makeMockDb,
  makeMockRegistry,
  makeMockBlockchain,
  makeCtx,
  DAOSHIP,
  NAVIGATOR,
  AVATAR,
  MEMBER1,
  MEMBER2,
} from './helpers.js';

const NAV2 = '0x000000000000000000000000000000000000000a';

const sanctionedNav = {
  id: `${DAOSHIP}-${NAVIGATOR}`,
  dao_id: DAOSHIP,
  trust_status: 'sanctioned',
  navigator_type: 'SignalNavigator',
  deploy_block: 100,
};
const selfAssertedNav = { ...sanctionedNav, trust_status: 'self_asserted' };

// ── Materialization gate ───────────────────────────────────────────

describe('SignalNavigator gate', () => {
  it('handlePollCreated writes a poll row when the navigator is sanctioned', async () => {
    const db = makeMockDb();
    db.getNavigatorTrust.mockResolvedValue(sanctionedNav);
    const ctx = makeCtx({ db, log: { address: NAVIGATOR } });

    await handlePollCreated(ctx, {
      pollId: 0n,
      creator: MEMBER1,
      question: 'Ship it?',
      optionCount: 3n,
      snapshotTimestamp: 1699999999n,
      votingStarts: 1700000000n,
      votingEnds: 1700086400n,
    });

    expect(db.upsert).toHaveBeenCalledWith('ds_signal_polls', expect.objectContaining({
      id: `${NAVIGATOR}-0`,
      dao_id: DAOSHIP,
      navigator_address: NAVIGATOR,
      poll_id: '0',
      creator: MEMBER1,
      question: 'Ship it?',
      option_count: 3,
      voting_starts: 1700000000,
      voting_ends: 1700086400,
      block_number: 100,
    }));
    // cancelled is intentionally omitted (preserved by partial upsert across replays)
    expect(db.upsert.mock.calls[0][1]).not.toHaveProperty('cancelled');
  });

  it('handlePollCreated DEFERS (no write) when the navigator is only self_asserted', async () => {
    const db = makeMockDb();
    db.getNavigatorTrust.mockResolvedValue(selfAssertedNav);
    const ctx = makeCtx({ db, log: { address: NAVIGATOR } });

    await handlePollCreated(ctx, {
      pollId: 0n, creator: MEMBER1, question: 'x', optionCount: 2n,
      snapshotTimestamp: 1n, votingStarts: 2n, votingEnds: 3n,
    });

    expect(db.upsert).not.toHaveBeenCalled();
  });

  it('handlePollCreated DEFERS when NavigatorDeployed has not been indexed (null)', async () => {
    const db = makeMockDb();
    db.getNavigatorTrust.mockResolvedValue(null);
    const ctx = makeCtx({ db, log: { address: NAVIGATOR } });

    await handlePollCreated(ctx, {
      pollId: 0n, creator: MEMBER1, question: 'x', optionCount: 2n,
      snapshotTimestamp: 1n, votingStarts: 2n, votingEnds: 3n,
    });

    expect(db.upsert).not.toHaveBeenCalled();
  });
});

// ── Voted ──────────────────────────────────────────────────────────

describe('handleVoted', () => {
  it('writes a vote row and marks the poll dirty when sanctioned', async () => {
    const db = makeMockDb();
    db.getNavigatorTrust.mockResolvedValue(sanctionedNav);
    const dirtyPollIds = new Set<string>();
    const ctx = makeCtx({ db, dirtyPollIds, log: { address: NAVIGATOR } });

    await handleVoted(ctx, { pollId: 0n, voter: MEMBER1, option: 1n, weight: 500n });

    expect(db.upsert).toHaveBeenCalledWith('ds_signal_votes', expect.objectContaining({
      id: `${NAVIGATOR}-0-${MEMBER1}`,
      poll_pk: `${NAVIGATOR}-0`,
      dao_id: DAOSHIP,
      voter: MEMBER1,
      option: 1,
      weight: '500',
    }));
    expect(dirtyPollIds.has(`${NAVIGATOR}-0`)).toBe(true);
  });

  it('DEFERS (no write, no dirty) when not sanctioned', async () => {
    const db = makeMockDb();
    db.getNavigatorTrust.mockResolvedValue(selfAssertedNav);
    const dirtyPollIds = new Set<string>();
    const ctx = makeCtx({ db, dirtyPollIds, log: { address: NAVIGATOR } });

    await handleVoted(ctx, { pollId: 0n, voter: MEMBER1, option: 1n, weight: 500n });

    expect(db.upsert).not.toHaveBeenCalled();
    expect(dirtyPollIds.size).toBe(0);
  });
});

// ── PollCancelled ──────────────────────────────────────────────────

describe('handlePollCancelled', () => {
  it('marks the poll cancelled (targeted update) when sanctioned', async () => {
    const db = makeMockDb();
    db.getNavigatorTrust.mockResolvedValue(sanctionedNav);
    const ctx = makeCtx({ db, log: { address: NAVIGATOR } });

    await handlePollCancelled(ctx, { pollId: 0n, caller: AVATAR });

    expect(db.markPollCancelled).toHaveBeenCalledWith(`${NAVIGATOR}-0`, expect.any(String));
    expect(db.upsert).not.toHaveBeenCalled();
  });

  it('DEFERS when not sanctioned', async () => {
    const db = makeMockDb();
    db.getNavigatorTrust.mockResolvedValue(null);
    const ctx = makeCtx({ db, log: { address: NAVIGATOR } });

    await handlePollCancelled(ctx, { pollId: 0n, caller: AVATAR });

    expect(db.markPollCancelled).not.toHaveBeenCalled();
  });
});

// ── Sanction reconciliation ────────────────────────────────────────

describe('reconcileSanctionedNavigators', () => {
  it('sanctions a newly-listed read-only navigator and backfills its polls', async () => {
    const db = makeMockDb();
    const blockchain = makeMockBlockchain();
    db.listSanctionedNavigators.mockResolvedValue([]); // none previously sanctioned
    db.getNavigatorTrust.mockResolvedValue(selfAssertedNav); // seen, not yet sanctioned, bound to DAOSHIP
    const ctx = makeCtx({ db, blockchain, log: { address: NAVIGATOR } });

    await reconcileSanctionedNavigators(ctx, DAOSHIP, AVATAR, [{ address: NAVIGATOR, type: 'SignalNavigator' }]);

    expect(db.setNavigatorTrust).toHaveBeenCalledWith(DAOSHIP, NAVIGATOR, 'sanctioned', expect.any(String));
    // Backfill was triggered (chain head + getLogs by address).
    expect(blockchain.getBlockNumber).toHaveBeenCalled();
    expect(blockchain.getLogs).toHaveBeenCalled();
  });

  it('ignores a listed address bound to a DIFFERENT DAO (scoping guard)', async () => {
    const db = makeMockDb();
    db.listSanctionedNavigators.mockResolvedValue([]);
    db.getNavigatorTrust.mockResolvedValue({ ...selfAssertedNav, dao_id: MEMBER2 }); // wrong DAO
    const ctx = makeCtx({ db, log: { address: NAVIGATOR } });

    await reconcileSanctionedNavigators(ctx, DAOSHIP, AVATAR, [{ address: NAVIGATOR }]);

    expect(db.setNavigatorTrust).not.toHaveBeenCalled();
    expect(db.writeSanctionIntent).not.toHaveBeenCalled();
  });

  it('holds an intent for a listed address not yet seen (NavigatorDeployed pending)', async () => {
    const db = makeMockDb();
    db.listSanctionedNavigators.mockResolvedValue([]);
    db.getNavigatorTrust.mockResolvedValue(null); // not indexed yet
    const ctx = makeCtx({ db, log: { address: NAVIGATOR } });

    await reconcileSanctionedNavigators(ctx, DAOSHIP, AVATAR, [{ address: NAVIGATOR }]);

    expect(db.writeSanctionIntent).toHaveBeenCalledWith(DAOSHIP, NAVIGATOR, AVATAR, expect.any(String));
    expect(db.setNavigatorTrust).not.toHaveBeenCalled();
  });

  it('de-sanctions a previously-sanctioned navigator omitted from the new list', async () => {
    const db = makeMockDb();
    db.listSanctionedNavigators.mockResolvedValue([
      { navigator_address: NAV2, navigator_type: 'SignalNavigator' },
    ]);
    const ctx = makeCtx({ db, log: { address: NAVIGATOR } });

    // Empty list → clear all sanctions.
    await reconcileSanctionedNavigators(ctx, DAOSHIP, AVATAR, []);

    expect(db.setNavigatorTrust).toHaveBeenCalledWith(DAOSHIP, NAV2, 'unsanctioned', expect.any(String));
    // Held intents for the DAO are reset (full-set semantics).
    expect(db.deleteSanctionIntentsForDao).toHaveBeenCalledWith(DAOSHIP);
  });
});

// ── Materialize-on-sanction backfill ───────────────────────────────

describe('backfillNavigatorPolls', () => {
  /** Build a Log for a SignalNavigator event emitted by NAVIGATOR. */
  function makeEventLog(
    event: 'PollCreated' | 'Voted' | 'PollCancelled',
    values: unknown[],
    overrides: Partial<{ blockNumber: number; transactionIndex: number; index: number }> = {},
  ) {
    const { topics, data } = signalNavigatorIface.encodeEventLog(
      signalNavigatorIface.getEvent(event)!,
      values,
    );
    return {
      address: NAVIGATOR,
      topics,
      data,
      blockNumber: overrides.blockNumber ?? 995,
      transactionIndex: overrides.transactionIndex ?? 0,
      index: overrides.index ?? 0,
      transactionHash: `0x${'cc'.repeat(32)}`,
    };
  }

  it('returns without fetching when NavigatorDeployed was never indexed', async () => {
    const db = makeMockDb();
    db.getNavigatorTrust.mockResolvedValue(null);
    const blockchain = makeMockBlockchain();
    const ctx = makeCtx({ db, blockchain });

    await backfillNavigatorPolls(ctx, NAVIGATOR);

    expect(blockchain.getLogs).not.toHaveBeenCalled();
  });

  it('bounds the getLogs scan at the navigator deploy_block', async () => {
    const db = makeMockDb();
    // Deploy near the head so a single maxBlockRange chunk covers the whole span.
    db.getNavigatorTrust.mockResolvedValue({ ...sanctionedNav, deploy_block: 990 });
    const blockchain = makeMockBlockchain();
    blockchain.getBlockNumber.mockResolvedValue(1000); // head = 1000 - confirmationBlocks
    blockchain.getLogs.mockResolvedValue([]);
    const ctx = makeCtx({ db, blockchain });

    await backfillNavigatorPolls(ctx, NAVIGATOR);

    expect(blockchain.getLogs).toHaveBeenCalledTimes(1);
    const [addrs, start, end] = blockchain.getLogs.mock.calls[0];
    expect(addrs).toEqual([NAVIGATOR]);
    expect(start).toBe(990); // deploy_block, not config.startBlock
    expect(end).toBe(1000 - config.confirmationBlocks);
  });

  it('skips entirely when the chain head cannot be read (retries on next sanction)', async () => {
    const db = makeMockDb();
    db.getNavigatorTrust.mockResolvedValue({ ...sanctionedNav, deploy_block: 990 });
    const blockchain = makeMockBlockchain();
    blockchain.getBlockNumber.mockRejectedValue(new Error('rpc down'));
    const ctx = makeCtx({ db, blockchain });

    await backfillNavigatorPolls(ctx, NAVIGATOR);

    expect(blockchain.getLogs).not.toHaveBeenCalled();
  });

  it('no-ops when the head is below the deploy_block (nothing to replay yet)', async () => {
    const db = makeMockDb();
    db.getNavigatorTrust.mockResolvedValue({ ...sanctionedNav, deploy_block: 5000 });
    const blockchain = makeMockBlockchain();
    blockchain.getBlockNumber.mockResolvedValue(1000);
    const ctx = makeCtx({ db, blockchain });

    await backfillNavigatorPolls(ctx, NAVIGATOR);

    expect(blockchain.getLogs).not.toHaveBeenCalled();
  });

  it('replays fetched logs through the live handlers so polls materialize on sanction', async () => {
    const db = makeMockDb();
    db.getNavigatorTrust.mockResolvedValue({ ...sanctionedNav, deploy_block: 990 });
    const blockchain = makeMockBlockchain();
    blockchain.getBlockNumber.mockResolvedValue(1000);
    blockchain.getBlock.mockResolvedValue({ woHeader: { timestamp: 1700000000 }, hash: `0x${'bb'.repeat(32)}` });
    // One PollCreated emitted historically while the navigator was only self_asserted.
    const pollLog = makeEventLog(
      'PollCreated',
      [0n, MEMBER1, 'Ship it?', 3, 1699999999n, 1700000000n, 1700086400n],
      { blockNumber: 995 },
    );
    blockchain.getLogs.mockResolvedValueOnce([pollLog]).mockResolvedValue([]);
    const dirtyPollIds = new Set<string>();
    const ctx = makeCtx({ db, blockchain, dirtyPollIds });

    await backfillNavigatorPolls(ctx, NAVIGATOR);

    // The PollCreated dispatched through handlePollCreated (gate now passes) → row written.
    expect(db.upsert).toHaveBeenCalledWith('ds_signal_polls', expect.objectContaining({
      id: `${NAVIGATOR}-0`,
      dao_id: DAOSHIP,
      poll_id: '0',
      block_number: 995,
    }));
  });

  it('continues past a single bad/undecodable log without aborting the backfill', async () => {
    const db = makeMockDb();
    db.getNavigatorTrust.mockResolvedValue({ ...sanctionedNav, deploy_block: 990 });
    const blockchain = makeMockBlockchain();
    blockchain.getBlockNumber.mockResolvedValue(1000);
    blockchain.getBlock.mockResolvedValue({ woHeader: { timestamp: 1700000000 }, hash: `0x${'bb'.repeat(32)}` });
    const goodLog = makeEventLog(
      'PollCreated',
      [1n, MEMBER1, 'Q', 2, 1n, 2n, 3n],
      { blockNumber: 996, index: 1 },
    );
    // A log whose topic0 matches nothing in the signal iface — must be skipped, not fatal.
    const junkLog = { ...goodLog, topics: [`0x${'ff'.repeat(32)}`], data: '0x', index: 0, blockNumber: 995 };
    blockchain.getLogs.mockResolvedValueOnce([junkLog, goodLog]).mockResolvedValue([]);
    const ctx = makeCtx({ db, blockchain });

    await backfillNavigatorPolls(ctx, NAVIGATOR);

    expect(db.upsert).toHaveBeenCalledWith('ds_signal_polls', expect.objectContaining({ id: `${NAVIGATOR}-1` }));
  });
});
