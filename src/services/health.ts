import { createServer, Server, IncomingMessage, ServerResponse } from 'http';
import { randomUUID } from 'crypto';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import type { BlockchainService } from './blockchain.js';
import type { DatabaseService } from './database.js';

const RATE_LIMIT = {
  windowMs: 60000,
  maxRequests: 60,
  cleanupIntervalMs: 300000,
  maxIPs: 10000,
};


async function withTimeout<T>(promise: Promise<T>, ms: number, name: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${name} timeout after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export interface HealthStatus {
  status: 'healthy' | 'unhealthy';
  timestamp: string;
  checks: {
    quaiRpc: CheckResult;
    supabase: CheckResult;
    indexer: CheckResult;
  };
  details: {
    currentBlock: number | null;
    lastIndexedBlock: number | null;
    blocksBehind: number | null;
    isSyncing: boolean;
  };
}

interface CheckResult {
  status: 'pass' | 'fail';
  message?: string;
}

export class HealthService {
  private server: Server | null = null;
  private blockchain: BlockchainService | null = null;
  private db: DatabaseService | null = null;
  private isIndexerRunning = false;
  private rpcCircuitBreakerOpen = false;

  private rateLimitMap: Map<string, number[]> = new Map();
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  setServices(blockchain: BlockchainService, db: DatabaseService): void {
    this.blockchain = blockchain;
    this.db = db;
  }

  setIndexerRunning(running: boolean): void {
    this.isIndexerRunning = running;
  }

  setRpcCircuitBreakerOpen(isOpen: boolean): void {
    if (this.rpcCircuitBreakerOpen !== isOpen) {
      logger.info({ isOpen }, 'RPC circuit breaker state changed');
    }
    this.rpcCircuitBreakerOpen = isOpen;
  }

  private getClientIp(req: IncomingMessage): string {
    // I6: Only trust x-forwarded-for when config.health.trustProxy is enabled.
    // Unconditional trust allows clients to spoof IPs and bypass rate limiting.
    if (config.health.trustProxy) {
      const forwarded = req.headers['x-forwarded-for'];
      if (forwarded) {
        const ips = Array.isArray(forwarded) ? forwarded[0] : forwarded;
        return ips.split(',')[0].trim();
      }
    }
    return req.socket.remoteAddress || 'unknown';
  }

  private checkRateLimit(ip: string): boolean {
    const now = Date.now();
    const windowStart = now - RATE_LIMIT.windowMs;

    if (this.rateLimitMap.size >= RATE_LIMIT.maxIPs && !this.rateLimitMap.has(ip)) {
      const oldestIp = this.rateLimitMap.keys().next().value;
      if (oldestIp) this.rateLimitMap.delete(oldestIp);
    }

    let requests = this.rateLimitMap.get(ip) || [];
    requests = requests.filter(ts => ts > windowStart);

    if (requests.length >= RATE_LIMIT.maxRequests) {
      this.rateLimitMap.set(ip, requests);
      return false;
    }

    requests.push(now);
    this.rateLimitMap.set(ip, requests);
    return true;
  }

  private cleanupRateLimitMap(): void {
    const windowStart = Date.now() - RATE_LIMIT.windowMs;
    for (const [ip, requests] of this.rateLimitMap.entries()) {
      const valid = requests.filter(ts => ts > windowStart);
      if (valid.length === 0) {
        this.rateLimitMap.delete(ip);
      } else {
        this.rateLimitMap.set(ip, valid);
      }
    }
  }

  private getCorsHeaders(origin: string | undefined): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'",
    };
    if (origin && config.health.corsOrigins.includes(origin)) {
      headers['Access-Control-Allow-Origin'] = origin;
      headers['Access-Control-Allow-Methods'] = 'GET, OPTIONS';
      headers['Access-Control-Allow-Headers'] = 'Content-Type';
    }
    return headers;
  }

  async start(): Promise<void> {
    if (!config.health.enabled) {
      logger.info('Health check endpoint disabled');
      return;
    }

    this.cleanupInterval = setInterval(() => {
      this.cleanupRateLimitMap();
    }, RATE_LIMIT.cleanupIntervalMs);

    this.server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      try {
        const clientIp = this.getClientIp(req);
        const origin = req.headers.origin;
        const headers = this.getCorsHeaders(origin);
        const requestId = randomUUID();
        headers['X-Request-Id'] = requestId;

        if (req.method === 'OPTIONS') {
          res.writeHead(204, headers);
          res.end();
          return;
        }

        if (!this.checkRateLimit(clientIp)) {
          logger.warn({ ip: clientIp, requestId }, 'Rate limit exceeded');
          const retryAfter = Math.ceil(RATE_LIMIT.windowMs / 1000);
          res.writeHead(429, { ...headers, 'Retry-After': String(retryAfter) });
          res.end(JSON.stringify({ error: 'Too Many Requests', retryAfter }));
          return;
        }

        if (req.url === '/health' && req.method === 'GET') {
          await this.handleHealthCheck(res, headers);
        } else if (req.url === '/ready' && req.method === 'GET') {
          await this.handleReadinessCheck(res, headers);
        } else if (req.url === '/live' && req.method === 'GET') {
          res.writeHead(200, headers);
          res.end(JSON.stringify({ alive: true }));
        } else {
          res.writeHead(404, headers);
          res.end(JSON.stringify({ error: 'Not found' }));
        }
      } catch (err) {
        logger.error({ err, url: req.url, method: req.method }, 'Unhandled error in health server');
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Internal Server Error' }));
        }
      }
    });

    this.server.listen(config.health.port, () => {
      logger.info({ port: config.health.port }, 'Health check server started');
    });
  }

  async stop(): Promise<void> {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.rateLimitMap.clear();

    if (this.server) {
      return new Promise((resolve) => {
        const timeout = setTimeout(() => {
          logger.warn('Health check server close timeout, forcing shutdown');
          resolve();
        }, 5000);

        this.server!.close(() => {
          clearTimeout(timeout);
          logger.info('Health check server stopped');
          resolve();
        });

        if (typeof this.server!.closeAllConnections === 'function') {
          this.server!.closeAllConnections();
        }
      });
    }
  }

  private async handleHealthCheck(res: ServerResponse, headers: Record<string, string>): Promise<void> {
    const health = await this.getHealthStatus();
    const statusCode = health.status === 'healthy' ? 200 : 503;
    res.writeHead(statusCode, headers);
    res.end(JSON.stringify(health, null, 2));
  }

  private async handleReadinessCheck(res: ServerResponse, headers: Record<string, string>): Promise<void> {
    const health = await this.getHealthStatus();
    const isReady =
      health.checks.quaiRpc.status === 'pass' &&
      health.checks.supabase.status === 'pass' &&
      health.checks.indexer.status === 'pass';

    res.writeHead(isReady ? 200 : 503, headers);
    res.end(JSON.stringify({ ready: isReady }));
  }

  private async getHealthStatus(): Promise<HealthStatus> {
    const { quaiRpcCheck, currentBlock } = await this.checkQuaiRpc();
    const { supabaseCheck, indexerState } = await this.checkSupabase();
    let indexerCheck: CheckResult = { status: 'pass' };

    let lastIndexedBlock: number | null = null;
    let blocksBehind: number | null = null;
    let isSyncing = false;

    if (indexerState) {
      lastIndexedBlock = indexerState.blockNumber;
      isSyncing = indexerState.isSyncing;
    }

    if (currentBlock !== null && lastIndexedBlock !== null) {
      blocksBehind = Math.max(0, currentBlock - lastIndexedBlock - config.confirmationBlocks);

      if (blocksBehind > config.health.maxBlocksBehind && !isSyncing) {
        indexerCheck = {
          status: 'fail',
          message: `Indexer is ${blocksBehind} blocks behind (max: ${config.health.maxBlocksBehind})`,
        };
      }
    }

    if (!this.isIndexerRunning) {
      indexerCheck = { status: 'fail', message: 'Indexer is not running' };
    }

    const checks = { quaiRpc: quaiRpcCheck, supabase: supabaseCheck, indexer: indexerCheck };
    const allPassing = Object.values(checks).every((c) => c.status === 'pass');

    return {
      status: allPassing ? 'healthy' : 'unhealthy',
      timestamp: new Date().toISOString(),
      checks,
      details: {
        currentBlock,
        lastIndexedBlock,
        blocksBehind,
        isSyncing,
      },
    };
  }

  private async checkQuaiRpc(): Promise<{ quaiRpcCheck: CheckResult; currentBlock: number | null }> {
    if (this.rpcCircuitBreakerOpen) {
      return {
        quaiRpcCheck: { status: 'fail', message: 'RPC circuit breaker open - recovering' },
        currentBlock: null,
      };
    }

    if (!this.blockchain) {
      return {
        quaiRpcCheck: { status: 'fail', message: 'Blockchain service not initialized' },
        currentBlock: null,
      };
    }

    try {
      const currentBlock = await withTimeout(
        this.blockchain.getBlockNumber(),
        config.health.checkTimeoutMs,
        'RPC check',
      );
      return { quaiRpcCheck: { status: 'pass' }, currentBlock };
    } catch (err) {
      logger.error({ err }, 'RPC health check failed');
      return {
        quaiRpcCheck: { status: 'fail', message: 'RPC connection error' },
        currentBlock: null,
      };
    }
  }

  private async checkSupabase(): Promise<{
    supabaseCheck: CheckResult;
    indexerState: { blockNumber: number; isSyncing: boolean } | null;
  }> {
    if (!this.db) {
      return {
        supabaseCheck: { status: 'fail', message: 'Database service not initialized' },
        indexerState: null,
      };
    }

    try {
      const state = await withTimeout(
        this.db.getIndexerState(),
        config.health.checkTimeoutMs,
        'Database check',
      );
      return {
        supabaseCheck: { status: 'pass' },
        indexerState: { blockNumber: state.blockNumber, isSyncing: state.isSyncing },
      };
    } catch (err) {
      logger.error({ err }, 'Database health check failed');
      return {
        supabaseCheck: { status: 'fail', message: 'Database connection error' },
        indexerState: null,
      };
    }
  }
}
