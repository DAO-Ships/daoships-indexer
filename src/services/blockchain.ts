import { quais, Shard, type Block, type Log, type TransactionResponse, Interface } from 'quais';
import { config } from '../config.js';
import { withRetry } from '../utils/retry.js';
import { logger } from '../utils/logger.js';

// RPC connection health thresholds
const RPC_HEALTH = {
  staleThresholdMs: 60000,
  failureThreshold: 3,
};

export class BlockchainService {
  private provider: quais.JsonRpcProvider;
  private shard = Shard.Cyprus1;

  // Rate limiting state
  private requestTimestamps: number[] = [];

  // RPC connection state tracking
  private lastSuccessfulCall: number = Date.now();
  private consecutiveFailures: number = 0;

  constructor() {
    this.provider = new quais.JsonRpcProvider(
      config.rpcUrl,
      undefined,
      { usePathing: true },
    );
  }

  // ── RPC Health ────────────────────────────────────────────────

  isHealthy(): boolean {
    const timeSinceSuccess = Date.now() - this.lastSuccessfulCall;
    return timeSinceSuccess <= RPC_HEALTH.staleThresholdMs &&
      this.consecutiveFailures < RPC_HEALTH.failureThreshold;
  }

  getConnectionStats(): {
    lastSuccessfulCall: number;
    consecutiveFailures: number;
    isHealthy: boolean;
    msSinceLastSuccess: number;
  } {
    return {
      lastSuccessfulCall: this.lastSuccessfulCall,
      consecutiveFailures: this.consecutiveFailures,
      isHealthy: this.isHealthy(),
      msSinceLastSuccess: Date.now() - this.lastSuccessfulCall,
    };
  }

  private recordSuccess(): void {
    this.lastSuccessfulCall = Date.now();
    this.consecutiveFailures = 0;
  }

  private recordFailure(): void {
    this.consecutiveFailures++;
    if (this.consecutiveFailures === RPC_HEALTH.failureThreshold) {
      logger.warn(
        {
          consecutiveFailures: this.consecutiveFailures,
          msSinceLastSuccess: Date.now() - this.lastSuccessfulCall,
        },
        'RPC connection degraded - multiple consecutive failures',
      );
    }
  }

  private async withTrackedRetry<T>(fn: () => Promise<T>, operation: string): Promise<T> {
    try {
      const result = await withRetry(fn, { operation });
      this.recordSuccess();
      return result;
    } catch (err) {
      this.recordFailure();
      throw err;
    }
  }

  // ── Rate Limiting ─────────────────────────────────────────────

  private async rateLimit(): Promise<void> {
    const now = Date.now();
    const windowMs = config.rateLimit.windowMs;
    const maxRequests = config.rateLimit.requestsPerWindow;

    this.requestTimestamps = this.requestTimestamps.filter(
      (ts) => now - ts < windowMs,
    );

    if (this.requestTimestamps.length >= maxRequests) {
      const waitTime = windowMs - (now - this.requestTimestamps[0]);
      if (waitTime > 0) {
        await new Promise((resolve) => setTimeout(resolve, waitTime));
      }
    }

    this.requestTimestamps.push(Date.now());
  }

  // ── RPC Methods ───────────────────────────────────────────────

  async getBlockNumber(): Promise<number> {
    await this.rateLimit();
    return this.withTrackedRetry(
      () => this.provider.getBlockNumber(this.shard),
      'getBlockNumber',
    );
  }

  async getBlock(blockNumber: number): Promise<Block | null> {
    await this.rateLimit();
    return this.withTrackedRetry(
      () => this.provider.getBlock(this.shard, blockNumber, false),
      `getBlock(${blockNumber})`,
    );
  }

  async getLogs(
    address: string | string[],
    fromBlock: number,
    toBlock: number,
    topics?: Array<string | string[] | null>,
  ): Promise<Log[]> {
    await this.rateLimit();
    return this.withTrackedRetry(
      () => this.provider.getLogs({
        address,
        fromBlock,
        toBlock,
        // quais Filter type doesn't match our topics signature
        topics: topics as any,
        nodeLocation: [0, 0],
      }),
      `getLogs(${fromBlock}-${toBlock})`,
    );
  }

  async getTransaction(hash: string): Promise<TransactionResponse | null> {
    await this.rateLimit();
    return this.withTrackedRetry(
      () => this.provider.getTransaction(hash) as Promise<TransactionResponse | null>,
      `getTransaction(${hash.slice(0, 10)})`,
    );
  }

  async callContract(
    address: string,
    iface: Interface,
    method: string,
    args: unknown[] = [],
  ): Promise<unknown> {
    await this.rateLimit();
    const contract = new quais.Contract(address, iface, this.provider);
    const fn = (contract as Record<string, unknown>)[method];
    if (typeof fn !== 'function') {
      throw new Error(`Method "${method}" not found on contract at ${address}`);
    }
    return this.withTrackedRetry(
      () => (fn as Function).call(contract, ...args) as Promise<unknown>,
      `call ${method} on ${address.slice(0, 10)}`,
    );
  }

  /**
   * Rate-limited raw eth_call — no retry (for best-effort probes like navigatorType()).
   * BAD_DATA or revert responses are deterministic, not transient, so retry is skipped.
   */
  async rawCall(to: string, data: string): Promise<string> {
    await this.rateLimit();
    const result = await Promise.race([
      this.provider.call({ to, from: '0x0000000000000000000000000000000000000000', data }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('rawCall timeout (10s)')), 10_000)),
    ]);
    return result;
  }

  getProvider(): quais.JsonRpcProvider {
    return this.provider;
  }
}
