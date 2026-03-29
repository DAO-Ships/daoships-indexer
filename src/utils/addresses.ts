export function makeMemberId(daoId: string, memberAddress: string): string {
  return `${daoId.toLowerCase()}-${memberAddress.toLowerCase()}`;
}

export function makeProposalId(daoId: string, proposalId: number): string {
  return `${daoId.toLowerCase()}-${proposalId}`;
}

export function makeNavigatorId(daoId: string, navigatorAddress: string): string {
  return `${daoId.toLowerCase()}-${navigatorAddress.toLowerCase()}`;
}

export function makeGuildTokenId(daoId: string, tokenAddress: string): string {
  return `${daoId.toLowerCase()}-${tokenAddress.toLowerCase()}`;
}

export function makeRagequitId(daoId: string, memberAddress: string, txHash: string): string {
  return `${daoId.toLowerCase()}-${memberAddress.toLowerCase()}-${txHash.toLowerCase()}`;
}

export function permissionToLabel(permission: number): string {
  const labels: Record<number, string> = {
    0: 'none',
    1: 'admin',
    2: 'manager',
    3: 'admin_manager',
    4: 'governor',
    5: 'admin_governor',
    6: 'manager_governor',
    7: 'all',
  };
  // DAOShip uses 3-bit bitmask (admin=1, manager=2, governor=4).
  // Mask to low 3 bits so values 8-255 map to valid enum labels
  // (e.g. 9 = 0b1001 & 0b111 = 1 = 'admin').
  if (permission <= 0) return 'none';
  return labels[permission & 7] ?? 'none';
}
