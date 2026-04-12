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
  // M11: Caller (handleNavigatorSet) already validates 0-7 range, so the & 7
  // mask is defense-in-depth only — it never triggers in normal operation.
  if (permission <= 0) return 'none';
  return labels[permission & 7] ?? 'none';
}
