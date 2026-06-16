/**
 * Property-based test scaffold for Option B handler idempotency work.
 *
 * This file demonstrates the fast-check pattern we'll use to prove each
 * non-idempotent handler becomes idempotent under replay after its
 * Option B rewrite. The concrete tests below exercise the numeric-string
 * BigInt helpers — trivially correct today — purely so the team can see
 * the pattern before Option B starts.
 *
 * When Option B lands, add sibling files like `transfer-idempotency.property.test.ts`
 * that apply a randomly-generated event sequence N times and assert the
 * final DB state matches a single application.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  addNumericStrings,
  subtractNumericStringsFloored,
  wouldClamp,
} from '../../../src/utils/bigint.js';

// Generator for non-negative bigint-as-string values representable in
// Postgres NUMERIC(78,0). Bound at 1e30 for reasonable test runs; real
// values can be larger but coverage doesn't need the extreme tail.
const numericString = fc.bigInt({ min: 0n, max: 10n ** 30n }).map((n) => n.toString());

describe('bigint helpers — properties (fast-check scaffold)', () => {
  it('addNumericStrings is commutative', () => {
    fc.assert(
      fc.property(numericString, numericString, (a, b) => {
        expect(addNumericStrings(a, b)).toBe(addNumericStrings(b, a));
      }),
    );
  });

  it('addNumericStrings is associative', () => {
    fc.assert(
      fc.property(numericString, numericString, numericString, (a, b, c) => {
        const left = addNumericStrings(addNumericStrings(a, b), c);
        const right = addNumericStrings(a, addNumericStrings(b, c));
        expect(left).toBe(right);
      }),
    );
  });

  it('subtractNumericStringsFloored never returns negative', () => {
    fc.assert(
      fc.property(numericString, numericString, (a, b) => {
        const result = subtractNumericStringsFloored(a, b);
        expect(BigInt(result) >= 0n).toBe(true);
      }),
    );
  });

  it('wouldClamp ↔ subtract-floored clamps to zero', () => {
    fc.assert(
      fc.property(numericString, numericString, (a, b) => {
        const willClamp = wouldClamp(a, b);
        const result = subtractNumericStringsFloored(a, b);
        // If we clamped, result must be exactly '0'. If not, result must
        // equal the raw bigint subtraction.
        if (willClamp) {
          expect(result).toBe('0');
        } else {
          expect(BigInt(result)).toBe(BigInt(a) - BigInt(b));
        }
      }),
    );
  });

  it('add then subtract is identity when no clamping occurs', () => {
    fc.assert(
      fc.property(numericString, numericString, (a, b) => {
        // (a + b) - b === a for all non-negative a, b.
        const sum = addNumericStrings(a, b);
        const back = subtractNumericStringsFloored(sum, b);
        expect(back).toBe(a);
      }),
    );
  });
});
