import { describe, it, expect } from 'vitest';
import {
  isValidAddress,
  validateAndNormalizeAddress,
  isValidBytes32,
  validateBytes32,
  isValidHexString,
  validateArray,
  validateEventArgs,
  extractBlockTimestamp,
  validateContractString,
  validateContractAddress,
} from '../../src/utils/validation.js';

// ── Address Validation ──────────────────────────────────────────

describe('isValidAddress', () => {
  it('accepts valid Quai addresses', () => {
    // Cyprus1 addresses start with 0x00
    expect(isValidAddress('0x0000000000000000000000000000000000000001')).toBe(true);
  });

  it('rejects non-string inputs', () => {
    expect(isValidAddress(null)).toBe(false);
    expect(isValidAddress(undefined)).toBe(false);
    expect(isValidAddress(42)).toBe(false);
    expect(isValidAddress({})).toBe(false);
  });

  it('rejects wrong-length strings', () => {
    expect(isValidAddress('0x1234')).toBe(false);
    expect(isValidAddress('0x' + 'a'.repeat(41))).toBe(false);
  });

  it('rejects strings without 0x prefix', () => {
    expect(isValidAddress('00' + '0'.repeat(40))).toBe(false);
  });
});

describe('validateAndNormalizeAddress', () => {
  it('returns lowercase address for valid input', () => {
    const addr = '0x0000000000000000000000000000000000000001';
    expect(validateAndNormalizeAddress(addr, 'test')).toBe(addr.toLowerCase());
  });

  it('throws with descriptive message for invalid input', () => {
    expect(() => validateAndNormalizeAddress('not-an-address', 'myField')).toThrow('Invalid myField');
  });
});

// ── Bytes32 Validation ──────────────────────────────────────────

describe('isValidBytes32', () => {
  it('accepts valid 66-char hex string', () => {
    expect(isValidBytes32('0x' + 'a'.repeat(64))).toBe(true);
    expect(isValidBytes32('0x' + '0'.repeat(64))).toBe(true);
    expect(isValidBytes32('0x' + 'AbCdEf0123456789'.repeat(4))).toBe(true);
  });

  it('rejects non-string inputs', () => {
    expect(isValidBytes32(null)).toBe(false);
    expect(isValidBytes32(undefined)).toBe(false);
    expect(isValidBytes32(123)).toBe(false);
  });

  it('rejects wrong-length strings', () => {
    expect(isValidBytes32('0x' + 'a'.repeat(63))).toBe(false);
    expect(isValidBytes32('0x' + 'a'.repeat(65))).toBe(false);
  });

  it('rejects strings with non-hex characters', () => {
    expect(isValidBytes32('0x' + 'g'.repeat(64))).toBe(false);
  });
});

describe('validateBytes32', () => {
  it('returns lowercase hash for valid input', () => {
    const hash = '0x' + 'AB'.repeat(32);
    expect(validateBytes32(hash, 'test')).toBe(hash.toLowerCase());
  });

  it('throws with descriptive message for invalid input', () => {
    expect(() => validateBytes32('invalid', 'txHash')).toThrow('Invalid txHash');
  });
});

// ── Hex String Validation ───────────────────────────────────────

describe('isValidHexString', () => {
  it('accepts valid hex strings with 0x prefix', () => {
    expect(isValidHexString('0x0')).toBe(true);
    expect(isValidHexString('0x1234abcdef')).toBe(true);
  });

  it('rejects bare 0x with no hex digits', () => {
    expect(isValidHexString('0x')).toBe(false);
  });

  it('rejects non-strings', () => {
    expect(isValidHexString(null)).toBe(false);
    expect(isValidHexString(42)).toBe(false);
  });

  it('rejects strings without 0x prefix', () => {
    expect(isValidHexString('1234')).toBe(false);
  });

  it('rejects hex strings with invalid characters', () => {
    expect(isValidHexString('0xGHIJ')).toBe(false);
  });
});

// ── Array Validation ────────────────────────────────────────────

describe('validateArray', () => {
  it('returns array for valid array input', () => {
    expect(validateArray([1, 2, 3], 'test')).toEqual([1, 2, 3]);
    expect(validateArray([], 'test')).toEqual([]);
  });

  it('throws on non-array inputs', () => {
    expect(() => validateArray(null, 'field')).toThrow('Expected array for field');
    expect(() => validateArray(undefined, 'field')).toThrow('Expected array for field');
    expect(() => validateArray('string', 'field')).toThrow('Expected array for field');
    expect(() => validateArray(42, 'field')).toThrow('Expected array for field');
    expect(() => validateArray({}, 'field')).toThrow('Expected array for field');
  });
});

// ── Event Args Validation ───────────────────────────────────────

describe('validateEventArgs', () => {
  it('returns args unchanged when all required fields present', () => {
    const args = { a: 1, b: 'two', c: true };
    const result = validateEventArgs(args, ['a', 'b'], 'TestEvent');
    expect(result).toBe(args);
  });

  it('throws when a required field is missing', () => {
    const args = { a: 1 };
    expect(() => validateEventArgs(args, ['a', 'b'], 'TestEvent')).toThrow(
      'Missing required field "b" in TestEvent event',
    );
  });

  it('allows fields with falsy but defined values', () => {
    const args = { a: 0, b: false, c: '' };
    expect(() => validateEventArgs(args, ['a', 'b', 'c'], 'TestEvent')).not.toThrow();
  });

  it('treats undefined fields as missing', () => {
    const args = { a: undefined };
    expect(() => validateEventArgs(args, ['a'], 'TestEvent')).toThrow('Missing required field "a"');
  });
});

// ── Block Timestamp Extraction ──────────────────────────────────

describe('extractBlockTimestamp', () => {
  // Primary path: woHeader.timestamp as number (what quais actually returns at runtime)
  it('extracts from woHeader.timestamp (number)', () => {
    const block = { woHeader: { timestamp: 1774725543 } };
    expect(extractBlockTimestamp(block as any, 100)).toBe(1774725543);
  });

  it('extracts from woHeader.timestamp (BigInt)', () => {
    const block = { woHeader: { timestamp: BigInt(1774725543) } };
    expect(extractBlockTimestamp(block as any, 100)).toBe(1774725543);
  });

  it('extracts from woHeader.timestamp (hex string)', () => {
    const block = { woHeader: { timestamp: '0x' + (1705312200).toString(16) } };
    expect(extractBlockTimestamp(block as any, 100)).toBe(1705312200);
  });

  it('extracts from woHeader.timestamp (decimal string)', () => {
    const block = { woHeader: { timestamp: '1705312200' } };
    expect(extractBlockTimestamp(block as any, 100)).toBe(1705312200);
  });

  // Error cases
  it('throws when block has no woHeader', () => {
    expect(() => extractBlockTimestamp({}, 42)).toThrow('Block 42 has no woHeader');
  });

  it('throws when woHeader.timestamp is 0', () => {
    expect(() => extractBlockTimestamp({ woHeader: { timestamp: 0 } }, 42)).toThrow('Block 42 has no valid woHeader.timestamp');
  });

  it('throws when woHeader.timestamp is null', () => {
    expect(() => extractBlockTimestamp({ woHeader: { timestamp: null } }, 42)).toThrow('Block 42 has no valid woHeader.timestamp');
  });

  // Does NOT use block.date or block.timestamp (buggy/unreliable in quais)
  it('ignores block.date and block.timestamp without woHeader', () => {
    const block = { date: new Date('2024-01-15T10:30:00Z'), timestamp: 1705312200 };
    expect(() => extractBlockTimestamp(block as any, 42)).toThrow('Block 42 has no woHeader');
  });

  // Regression: the year-5162 bug
  it('does not produce year-5162 timestamps (regression)', () => {
    // The bug: block.date getter calls parseInt(1774725543, 16) on a number.
    // Our fix reads woHeader.timestamp directly as a number.
    const block = { woHeader: { timestamp: 1774725543 } };
    const ts = extractBlockTimestamp(block as any, 100);
    expect(ts).toBe(1774725543);
    expect(new Date(ts * 1000).getFullYear()).toBe(2026);
  });
});

// ── Contract Call Result Validation ────────────────────────────

describe('validateContractString', () => {
  it('returns string values directly', () => {
    expect(validateContractString('hello', 'test')).toBe('hello');
  });

  it('coerces non-null values to string', () => {
    expect(validateContractString(42, 'test')).toBe('42');
    expect(validateContractString(true, 'test')).toBe('true');
  });

  it('throws on null', () => {
    expect(() => validateContractString(null, 'ctx')).toThrow('null/undefined for ctx');
  });

  it('throws on undefined', () => {
    expect(() => validateContractString(undefined, 'ctx')).toThrow('null/undefined for ctx');
  });
});

describe('validateContractAddress', () => {
  it('returns lowercase address for valid Quai address', () => {
    const addr = '0x0000000000000000000000000000000000000001';
    expect(validateContractAddress(addr, 'test')).toBe(addr.toLowerCase());
  });

  it('throws on non-address string', () => {
    expect(() => validateContractAddress('hello', 'ctx')).toThrow('invalid address for ctx');
  });

  it('throws on null', () => {
    expect(() => validateContractAddress(null, 'ctx')).toThrow('null/undefined for ctx');
  });
});
