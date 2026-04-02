/**
 * Shared mock factories for handler unit tests.
 * All test addresses use the Cyprus1 shard range (0x00 prefix).
 */
import { vi } from 'vitest';
import type { EventContext } from '../../../src/handlers/index.js';

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

// ── Mock factory ────────────────────────────────────────────────

export function makeMockDb() {
  return {
    getDao: vi.fn().mockResolvedValue(null),
    updateDao: vi.fn().mockResolvedValue(undefined),
    upsertDao: vi.fn().mockResolvedValue(undefined),
    getMember: vi.fn().mockResolvedValue(null),
    upsertMember: vi.fn().mockResolvedValue(undefined),
    getProposal: vi.fn().mockResolvedValue(null),
    upsertProposal: vi.fn().mockResolvedValue(undefined),
    updateProposal: vi.fn().mockResolvedValue(undefined),
    upsertVote: vi.fn().mockResolvedValue(undefined),
    upsert: vi.fn().mockResolvedValue(undefined),
    insert: vi.fn().mockResolvedValue(undefined),
    incrementProposalVotes: vi.fn().mockResolvedValue(undefined),
    incrementMemberVotes: vi.fn().mockResolvedValue(undefined),
    incrementProposalCount: vi.fn().mockResolvedValue(undefined),
    updateActiveMemberCount: vi.fn().mockResolvedValue(undefined),
    updateNavigator: vi.fn().mockResolvedValue(undefined),
  };
}

export function makeMockBlockchain() {
  return {
    callContract: vi.fn().mockResolvedValue(''),
    rawCall: vi.fn().mockResolvedValue('0x'),
    getLogs: vi.fn().mockResolvedValue([]),
    getTransaction: vi.fn().mockResolvedValue(null),
  };
}

export function makeMockRegistry() {
  return {
    getDaoByDaoShipAddress: vi.fn().mockReturnValue(undefined),
    getDaoByTokenAddress: vi.fn().mockReturnValue(undefined),
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
} = {}): EventContext {
  return {
    log: makeLog(overrides.log ?? {}) as any,
    blockTimestamp: overrides.blockTimestamp ?? 1700000000,
    db: { ...makeMockDb(), ...(overrides.db ?? {}) } as any,
    blockchain: { ...makeMockBlockchain(), ...(overrides.blockchain ?? {}) } as any,
    registry: { ...makeMockRegistry(), ...(overrides.registry ?? {}) } as any,
  };
}
