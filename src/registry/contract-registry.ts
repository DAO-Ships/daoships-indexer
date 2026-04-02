import { logger } from '../utils/logger.js';

export interface DaoRegistryEntry {
  daoShipAddress: string;
  sharesAddress: string;
  lootAddress: string;
  avatar: string;
}

export class ContractRegistry {
  /** Static contract name → address */
  private staticContracts: Map<string, string> = new Map();

  /** DaoShip address → full entry */
  private daos: Map<string, DaoRegistryEntry> = new Map();

  /** Token address → DaoShip address */
  private tokenToDaoMap: Map<string, string> = new Map();

  /** Navigator addresses to fetch logs from */
  private navigators: Set<string> = new Set();

  /** Navigator address → DaoShip address (best-effort for resolveDaoId) */
  private navigatorToDaoMap: Map<string, string> = new Map();

  constructor(staticContracts: Record<string, string>) {
    for (const [name, address] of Object.entries(staticContracts)) {
      this.staticContracts.set(address.toLowerCase(), name);
    }
  }

  registerDao(entry: DaoRegistryEntry): void {
    const daoShip = entry.daoShipAddress.toLowerCase();
    const newShares = entry.sharesAddress.toLowerCase();
    const newLoot = entry.lootAddress.toLowerCase();
    const newAvatar = entry.avatar.toLowerCase();

    const existing = this.daos.get(daoShip);
    if (existing) {
      // Return early when nothing changed — no update needed
      if (existing.sharesAddress === newShares && existing.lootAddress === newLoot && existing.avatar === newAvatar) {
        return;
      }
      // Addresses changed: warn (indicates re-summoning or config drift) and update
      logger.warn(
        { daoShip, oldShares: existing.sharesAddress, newShares, oldLoot: existing.lootAddress, newLoot },
        'DAO re-registered with different addresses',
      );
      // Remove stale token mappings before adding updated ones
      this.tokenToDaoMap.delete(existing.sharesAddress);
      this.tokenToDaoMap.delete(existing.lootAddress);
    }

    this.daos.set(daoShip, {
      daoShipAddress: daoShip,
      sharesAddress: newShares,
      lootAddress: newLoot,
      avatar: newAvatar,
    });
    this.tokenToDaoMap.set(newShares, daoShip);
    this.tokenToDaoMap.set(newLoot, daoShip);
  }

  getDaoByDaoShipAddress(address: string): DaoRegistryEntry | undefined {
    return this.daos.get(address.toLowerCase());
  }

  getDaoByTokenAddress(tokenAddress: string): string | undefined {
    return this.tokenToDaoMap.get(tokenAddress.toLowerCase());
  }

  isSharesToken(tokenAddress: string): boolean {
    const daoId = this.tokenToDaoMap.get(tokenAddress.toLowerCase());
    if (!daoId) return false;
    const dao = this.daos.get(daoId);
    return dao?.sharesAddress === tokenAddress.toLowerCase();
  }

  getAllDaoShipAddresses(): string[] {
    return Array.from(this.daos.keys());
  }

  getAllTokenAddresses(): string[] {
    return Array.from(this.tokenToDaoMap.keys());
  }

  registerNavigator(navigatorAddress: string, daoShipAddress: string): void {
    const addr = navigatorAddress.toLowerCase();
    const daoShip = daoShipAddress.toLowerCase();
    this.navigators.add(addr);
    this.navigatorToDaoMap.set(addr, daoShip);
  }

  unregisterNavigator(navigatorAddress: string): void {
    const addr = navigatorAddress.toLowerCase();
    this.navigators.delete(addr);
    this.navigatorToDaoMap.delete(addr);
  }

  getAllNavigatorAddresses(): string[] {
    return Array.from(this.navigators);
  }

  getDaoByNavigatorAddress(navigatorAddress: string): string | undefined {
    return this.navigatorToDaoMap.get(navigatorAddress.toLowerCase());
  }

  clear(): void {
    this.daos.clear();
    this.tokenToDaoMap.clear();
    this.navigators.clear();
    this.navigatorToDaoMap.clear();
  }

  get daoCount(): number {
    return this.daos.size;
  }

  get navigatorCount(): number {
    return this.navigators.size;
  }
}
