import type { Log, Interface } from 'quais';
import type { DatabaseService } from '../services/database.js';
import type { BlockchainService } from '../services/blockchain.js';
import type { ContractRegistry } from '../registry/contract-registry.js';

export interface EventContext {
  log: Log;
  blockTimestamp: number; // Unix seconds
  db: DatabaseService;
  blockchain: BlockchainService;
  registry: ContractRegistry;
}

export type EventHandler = (ctx: EventContext, parsedArgs: Record<string, unknown>) => Promise<void>;

interface HandlerEntry {
  iface: Interface;
  eventName: string;
  handler: EventHandler;
}

export class HandlerDispatcher {
  private handlers: Map<string, HandlerEntry> = new Map();

  registerHandler(iface: Interface, eventName: string, handler: EventHandler): void {
    const fragment = iface.getEvent(eventName);
    if (!fragment) throw new Error(`Event ${eventName} not found in interface`);
    const topic0 = fragment.topicHash;

    if (this.handlers.has(topic0)) {
      const existing = this.handlers.get(topic0)!;
      throw new Error(`Topic0 collision: ${topic0} already registered as "${existing.eventName}", cannot register "${eventName}"`);
    }

    this.handlers.set(topic0, { iface, eventName, handler });
  }

  async dispatch(ctx: EventContext): Promise<{ handled: boolean; eventName?: string }> {
    const topic0 = ctx.log.topics[0];
    if (!topic0) return { handled: false };

    const entry = this.handlers.get(topic0);
    if (!entry) return { handled: false };

    const parsed = entry.iface.parseLog({
      topics: ctx.log.topics as string[],
      data: ctx.log.data,
    });
    if (!parsed) return { handled: false };

    // Let handler errors propagate to the processor's transient/deterministic
    // classification (processor.ts processLogs). The processor owns error
    // handling — transient errors fail the block range for retry, deterministic
    // errors are logged and skipped.
    await entry.handler(ctx, parsed.args);
    return { handled: true, eventName: entry.eventName };
  }

  getRegisteredTopics(): string[] {
    return Array.from(this.handlers.keys());
  }
}
