import { describe, it, expect } from 'vitest';
import {
  makeMemberId,
  makeProposalId,
  makeNavigatorId,
  makeGuildTokenId,
  makeRagequitId,
  permissionToLabel,
} from '../../src/utils/addresses.js';

describe('makeMemberId', () => {
  it('creates lowercase composite ID', () => {
    expect(makeMemberId('0xDAO', '0xMEMBER')).toBe('0xdao-0xmember');
  });
});

describe('makeProposalId', () => {
  it('creates composite ID with proposal number', () => {
    expect(makeProposalId('0xDAO', 42)).toBe('0xdao-42');
  });
});

describe('makeNavigatorId', () => {
  it('creates lowercase composite ID', () => {
    expect(makeNavigatorId('0xDAO', '0xNAVIGATOR')).toBe('0xdao-0xnavigator');
  });
});

describe('makeGuildTokenId', () => {
  it('creates lowercase composite ID', () => {
    expect(makeGuildTokenId('0xDAO', '0xTOKEN')).toBe('0xdao-0xtoken');
  });
});

describe('makeRagequitId', () => {
  it('creates lowercase composite ID with tx hash', () => {
    expect(makeRagequitId('0xDAO', '0xMEMBER', '0xTXHASH')).toBe('0xdao-0xmember-0xtxhash');
  });
});

describe('permissionToLabel', () => {
  it('maps known permission values', () => {
    expect(permissionToLabel(0)).toBe('none');
    expect(permissionToLabel(1)).toBe('admin');
    expect(permissionToLabel(2)).toBe('manager');
    expect(permissionToLabel(3)).toBe('admin_manager');
    expect(permissionToLabel(4)).toBe('governor');
    expect(permissionToLabel(5)).toBe('admin_governor');
    expect(permissionToLabel(6)).toBe('manager_governor');
    expect(permissionToLabel(7)).toBe('all');
  });

  it('masks to low 3 bits for out-of-range values (8+), none for 0 and negative', () => {
    // DAOShip uses 3-bit bitmask: admin=1, manager=2, governor=4.
    // Values > 7 are masked: 8 & 7 = 0 (none), 9 & 7 = 1 (admin), 100 & 7 = 4 (governor)
    expect(permissionToLabel(8)).toBe('none');
    expect(permissionToLabel(9)).toBe('admin');
    expect(permissionToLabel(100)).toBe('governor');
    expect(permissionToLabel(255)).toBe('all');
    // 0 and negatives have no permissions
    expect(permissionToLabel(0)).toBe('none');
    expect(permissionToLabel(-1)).toBe('none');
  });
});
