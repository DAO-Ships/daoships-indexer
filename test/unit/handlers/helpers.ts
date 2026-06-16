/**
 * Shared mock factories for handler unit tests.
 * All test addresses use the Cyprus1 shard range (0x00 prefix).
 */
import { vi } from 'vitest';
import type { EventContext } from '../../../src/handlers/index.js';
import { RangeCache } from '../../../src/services/range-cache.js';
import { config } from '../../../src/config.js';

// ── Canonical test addresses ────────────────────────────────────

export const DAOSHIP  = '0x0000000000000000000000000000000000000001';
export const SHARES   = '0x0000000000000000000000000000000000000002';
export const LOOT     = '0x0000000000000000000000000000000000000003';
export const AVATAR   = '0x0000000000000000000000000000000000000004';
export const MEMBER1  = '0x0000000000000000000000000000000000000005';
export const MEMBER2  = '0x0000000000000000000000000000000000000006';
export const NAVIGATOR = '0x0000000000000000000000000000000000000007';
export const LAUNCHER = '0x0000000000000000000000000000000000000008';
export const TOKEN_A  = '0x0000000000000000000000000000000000000009';
export const ZERO     = '0x0000000000000000000000000000000000000000';
export const TX_HASH  = '0x' + 'aa'.repeat(32);

// U2: Handlers gated on `ctx.log.address` matching a configured contract
// (launcher / poster) need the REAL address from the env config. These
// re-exports let tests set `log: { address: VAULT_LAUNCHER_ADDR }` so
// the emitter check passes. They match whatever `.env` (or test fixture
// .env) is loaded — do not hardcode.
export const VAULT_LAUNCHER_ADDR = config.contracts.daoShipAndVaultLauncher;
export const DAOSHIP_LAUNCHER_ADDR = config.contracts.daoShipLauncher;
export const POSTER_ADDR = config.contracts.poster;

// ── Mock factory ────────────────────────────────────────────────

export function makeMockDb() {
  return {
    getDao: vi.fn().mockResolvedValue(null),
    updateDao: vi.fn().mockResolvedValue(undefined),
    upsertDao: vi.fn().mockResolvedValue(undefined),
    getMember: vi.fn().mockResolvedValue(null),
    upsertMember: vi.fn().mockResolvedValue(undefined),
    insertMemberIfAbsent: vi.fn().mockResolvedValue(false),
    getProposal: vi.fn().mockResolvedValue(null),
    upsertProposal: vi.fn().mockResolvedValue(undefined),
    insertProposalIfAbsent: vi.fn().mockResolvedValue(false),
    updateProposal: vi.fn().mockResolvedValue(undefined),
    upsertVote: vi.fn().mockResolvedValue(undefined),
    upsert: vi.fn().mockResolvedValue(undefined),
    insert: vi.fn().mockResolvedValue(undefined),
    incrementProposalVotes: vi.fn().mockResolvedValue(undefined),
    incrementMemberVotes: vi.fn().mockResolvedValue(undefined),
    incrementProposalCount: vi.fn().mockResolvedValue(undefined),
    adjustDaoTotals: vi.fn().mockResolvedValue(undefined),
    updateActiveMemberCount: vi.fn().mockResolvedValue(undefined),
    updateNavigator: vi.fn().mockResolvedValue(undefined),
    reparentOrphanedRecords: vi.fn().mockResolvedValue(undefined),
    pruneOrphanedRecords: vi.fn().mockResolvedValue(undefined),
    findOrphanNavigator: vi.fn().mockResolvedValue(null),
    getNavigatorByAddress: vi.fn().mockResolvedValue(null),
    pruneOrphanedNavigators: vi.fn().mockResolvedValue(undefined),
    // Navigator trust + sanctioning (read-only navigators)
    consumeSanctionIntent: vi.fn().mockResolvedValue(null),
    getNavigatorTrust: vi.fn().mockResolvedValue(null),
    listSanctionedNavigators: vi.fn().mockResolvedValue([]),
    setNavigatorTrust: vi.fn().mockResolvedValue(undefined),
    writeSanctionIntent: vi.fn().mockResolvedValue(undefined),
    deleteSanctionIntentsForDao: vi.fn().mockResolvedValue(undefined),
    // Signal navigator polls/votes
    markPollCancelled: vi.fn().mockResolvedValue(undefined),
    recomputePollTally: vi.fn().mockResolvedValue(undefined),
    getSignalPoll: vi.fn().mockResolvedValue(null),
    applyPollLabels: vi.fn().mockResolvedValue(undefined),
    // Timelock + Vesting navigators
    updateTimelockChange: vi.fn().mockResolvedValue(undefined),
    updateVestingSchedule: vi.fn().mockResolvedValue(undefined),
    recomputeVestingClaimed: vi.fn().mockResolvedValue(undefined),
    resolveTimelockBypass: vi.fn().mockResolvedValue(undefined),
    // Budget navigator (vault-module authority)
    updateBudget: vi.fn().mockResolvedValue(undefined),
    recomputeBudgetSpent: vi.fn().mockResolvedValue(undefined),
    recomputeModuleTrust: vi.fn().mockResolvedValue(undefined),
    // Subscription navigator (MANAGER-permissioned recurring dues)
    updateSubscriptionMember: vi.fn().mockResolvedValue(undefined),
    recomputeSubscriptionPaid: vi.fn().mockResolvedValue(undefined),
    // Option B idempotent RPCs
    applyTransfer: vi.fn().mockResolvedValue({ alreadyProcessed: false, activeMemberDelta: 0 }),
    recomputeDaoTotals: vi.fn().mockResolvedValue(undefined),
    markLogsProcessedBatch: vi.fn().mockResolvedValue(undefined),
  };
}

export function makeMockBlockchain() {
  return {
    callContract: vi.fn().mockResolvedValue(''),
    rawCall: vi.fn().mockResolvedValue('0x'),
    getCode: vi.fn().mockResolvedValue('0x'),
    getLogs: vi.fn().mockResolvedValue([]),
    getTransaction: vi.fn().mockResolvedValue(null),
    getBlockNumber: vi.fn().mockResolvedValue(1000),
    getBlock: vi.fn().mockResolvedValue({ woHeader: { timestamp: 1700000000 }, hash: '0x' + 'bb'.repeat(32) }),
  };
}

export function makeMockRegistry() {
  return {
    getDaoByDaoShipAddress: vi.fn().mockReturnValue(undefined),
    getDaoByTokenAddress: vi.fn().mockReturnValue(undefined),
    getDaoByAvatarAddress: vi.fn().mockReturnValue(undefined),
    isSharesToken: vi.fn().mockReturnValue(true),
    registerDao: vi.fn(),
    registerNavigator: vi.fn(),
    unregisterNavigator: vi.fn(),
    getDaoByNavigatorAddress: vi.fn().mockReturnValue(undefined),
  };
}

export function makeLog(overrides: Record<string, unknown> = {}) {
  return {
    address: DAOSHIP,
    blockNumber: 100,
    transactionHash: TX_HASH,
    index: 0,
    transactionIndex: 0,
    topics: [] as string[],
    data: '0x',
    ...overrides,
  };
}

export function makeCtx(overrides: {
  db?: Partial<ReturnType<typeof makeMockDb>>;
  blockchain?: Partial<ReturnType<typeof makeMockBlockchain>>;
  registry?: Partial<ReturnType<typeof makeMockRegistry>>;
  log?: Record<string, unknown>;
  blockTimestamp?: number;
  cache?: RangeCache;
  dirtyDaoIds?: Set<string>;
  dirtyPollIds?: Set<string>;
  dirtyVestingScheduleIds?: Set<string>;
  dirtyBudgetIds?: Set<string>;
  dirtySubscriptionMemberIds?: Set<string>;
  dirtyTimelockBypassChecks?: Set<string>;
} = {}): EventContext {
  return {
    log: makeLog(overrides.log ?? {}) as any,
    blockTimestamp: overrides.blockTimestamp ?? 1700000000,
    db: { ...makeMockDb(), ...(overrides.db ?? {}) } as any,
    blockchain: { ...makeMockBlockchain(), ...(overrides.blockchain ?? {}) } as any,
    registry: { ...makeMockRegistry(), ...(overrides.registry ?? {}) } as any,
    cache: overrides.cache ?? new RangeCache(),
    dirtyDaoIds: overrides.dirtyDaoIds ?? new Set<string>(),
    dirtyPollIds: overrides.dirtyPollIds ?? new Set<string>(),
    dirtyVestingScheduleIds: overrides.dirtyVestingScheduleIds ?? new Set<string>(),
    dirtyBudgetIds: overrides.dirtyBudgetIds ?? new Set<string>(),
    dirtySubscriptionMemberIds: overrides.dirtySubscriptionMemberIds ?? new Set<string>(),
    dirtyTimelockBypassChecks: overrides.dirtyTimelockBypassChecks ?? new Set<string>(),
  };
}
