/**
 * Property-based idempotency tests for handleTransfer under Option B.
 *
 * The RPC-level idempotency (the ds_apply_transfer INSERT...ON CONFLICT
 * DO NOTHING claim) is tested against real Postgres in integration tests
 * not runnable from this harness. What we CAN verify at the handler
 * level:
 *
 *   - The handler is a pure dispatcher into applyTransfer. Calling it N
 *     times on the same log args should result in N applyTransfer calls
 *     with identical payloads — the server owns the replay-safety.
 *   - When applyTransfer returns `alreadyProcessed: true`, the handler
 *     MUST NOT queue the DAO dirty or update member count. That contract
 *     is what makes end-of-range batched markLogProcessed safe.
 *   - `dirtyDaoIds` accumulates exactly the DAOs whose Transfers were
 *     NOT already-processed.
 *
 * Companion file: `bigint.property.test.ts` (scaffold). Option B's SQL-
 * level idempotency is tested via integration fixtures outside this
 * harness.
 */
import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';
import { handleTransfer } from '../../../src/handlers/tokens.js';
import { DAOSHIP, SHARES, MEMBER1, MEMBER2, ZERO, TX_HASH, makeCtx, makeMockDb } from '../handlers/helpers.js';

// Restrict to the shape ABI decoding actually produces for Transfer.
// Exclude {ZERO → ZERO} — that would be a mint-and-burn with no real side,
// which ERC-20 semantics don't emit. Real Transfers always have at least
// one non-zero side.
const transferEventArb = fc.record({
  from: fc.constantFrom(ZERO, MEMBER1, MEMBER2),
  to: fc.constantFrom(ZERO, MEMBER1, MEMBER2),
  value: fc.bigInt({ min: 0n, max: 10n ** 30n }),
}).filter((e) => !(e.from === ZERO && e.to === ZERO));

// Simulated RPC return — either success with a delta, or already-processed.
const rpcOutcomeArb = fc.oneof(
  fc.record({
    alreadyProcessed: fc.constant(false),
    activeMemberDelta: fc.integer({ min: -1, max: 1 }),
  }),
  fc.record({
    alreadyProcessed: fc.constant(true),
    activeMemberDelta: fc.constant(0),
  }),
);

describe('handleTransfer — Option B idempotency properties', () => {
  it('N-way dispatch: N calls → N applyTransfer calls with identical payloads', async () => {
    await fc.assert(
      fc.asyncProperty(transferEventArb, fc.integer({ min: 1, max: 6 }), async (event, n) => {
        const db = makeMockDb();
        db.applyTransfer.mockResolvedValue({ alreadyProcessed: false, activeMemberDelta: 0 });
        const ctx = makeCtx({
          db,
          log: { address: SHARES },
          registry: {
            getDaoByTokenAddress: vi.fn().mockReturnValue(DAOSHIP),
            isSharesToken: vi.fn().mockReturnValue(true),
          },
        });

        for (let i = 0; i < n; i++) {
          await handleTransfer(ctx, event);
        }

        expect(db.applyTransfer).toHaveBeenCalledTimes(n);
        // Every call gets the same args shape.
        const calls = db.applyTransfer.mock.calls.map((c: any[]) => c[0]);
        for (let i = 1; i < calls.length; i++) {
          expect(calls[i]).toEqual(calls[0]);
        }
      }),
      { numRuns: 30 },
    );
  });

  it('already-processed return never bumps dirtyDaoIds or active count', async () => {
    await fc.assert(
      fc.asyncProperty(transferEventArb, async (event) => {
        const db = makeMockDb();
        db.applyTransfer.mockResolvedValue({ alreadyProcessed: true, activeMemberDelta: 0 });
        const ctx = makeCtx({
          db,
          log: { address: SHARES },
          registry: {
            getDaoByTokenAddress: vi.fn().mockReturnValue(DAOSHIP),
            isSharesToken: vi.fn().mockReturnValue(true),
          },
        });

        await handleTransfer(ctx, event);

        expect(ctx.dirtyDaoIds.size).toBe(0);
        expect(db.updateActiveMemberCount).not.toHaveBeenCalled();
      }),
      { numRuns: 50 },
    );
  });

  it('not-processed return always marks the DAO dirty', async () => {
    await fc.assert(
      fc.asyncProperty(transferEventArb, fc.integer({ min: -1, max: 1 }), async (event, delta) => {
        const db = makeMockDb();
        db.applyTransfer.mockResolvedValue({ alreadyProcessed: false, activeMemberDelta: delta });
        const ctx = makeCtx({
          db,
          log: { address: SHARES },
          registry: {
            getDaoByTokenAddress: vi.fn().mockReturnValue(DAOSHIP),
            isSharesToken: vi.fn().mockReturnValue(true),
          },
        });

        await handleTransfer(ctx, event);

        expect(ctx.dirtyDaoIds.has(DAOSHIP)).toBe(true);
        if (delta !== 0) {
          expect(db.updateActiveMemberCount).toHaveBeenCalledWith(DAOSHIP, delta);
        } else {
          expect(db.updateActiveMemberCount).not.toHaveBeenCalled();
        }
      }),
      { numRuns: 50 },
    );
  });

  it('mixed not-processed / already-processed sequence: dirty DAO reflects first real apply', async () => {
    await fc.assert(
      fc.asyncProperty(
        transferEventArb,
        fc.array(rpcOutcomeArb, { minLength: 2, maxLength: 6 }),
        async (event, outcomes) => {
          const db = makeMockDb();
          const ctx = makeCtx({
            db,
            log: { address: SHARES },
            registry: {
              getDaoByTokenAddress: vi.fn().mockReturnValue(DAOSHIP),
              isSharesToken: vi.fn().mockReturnValue(true),
            },
          });

          for (const outcome of outcomes) {
            db.applyTransfer.mockResolvedValueOnce(outcome);
            await handleTransfer(ctx, event);
          }

          const anyRealApply = outcomes.some((o) => !o.alreadyProcessed);
          expect(ctx.dirtyDaoIds.has(DAOSHIP)).toBe(anyRealApply);
        },
      ),
      { numRuns: 30 },
    );
  });
});
