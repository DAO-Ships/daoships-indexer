import { describe, it, expect } from 'vitest';
import {
  bigintToString,
  addNumericStrings,
  safeBigInt,
  strictBigInt,
} from '../../src/utils/bigint.js';

describe('bigintToString', () => {
  it('converts bigints to string', () => {
    expect(bigintToString(0n)).toBe('0');
    expect(bigintToString(123456789n)).toBe('123456789');
    expect(bigintToString(-42n)).toBe('-42');
  });

  it('handles very large bigints (uint256 range)', () => {
    const max = 2n ** 256n - 1n;
    expect(bigintToString(max)).toBe(max.toString());
  });
});

describe('addNumericStrings', () => {
  it('adds two numeric strings', () => {
    expect(addNumericStrings('100', '200')).toBe('300');
  });

  it('handles empty strings as zero', () => {
    expect(addNumericStrings('', '100')).toBe('100');
    expect(addNumericStrings('50', '')).toBe('50');
  });

  it('handles large numbers', () => {
    const a = '999999999999999999999999';
    const b = '1';
    expect(addNumericStrings(a, b)).toBe('1000000000000000000000000');
  });
});

describe('safeBigInt', () => {
  it('converts valid bigint values', () => {
    expect(safeBigInt(42n)).toBe(42n);
    expect(safeBigInt(0n)).toBe(0n);
  });

  it('converts valid numeric strings', () => {
    expect(safeBigInt('123')).toBe(123n);
    expect(safeBigInt('0')).toBe(0n);
  });

  it('converts numbers', () => {
    expect(safeBigInt(42)).toBe(42n);
  });

  it('returns default for null/undefined', () => {
    expect(safeBigInt(null)).toBe(0n);
    expect(safeBigInt(undefined)).toBe(0n);
  });

  it('returns default for invalid values', () => {
    expect(safeBigInt('not-a-number')).toBe(0n);
    expect(safeBigInt({})).toBe(0n);
  });

  it('uses custom default value', () => {
    expect(safeBigInt(null, 99n)).toBe(99n);
    expect(safeBigInt('invalid', 42n)).toBe(42n);
  });
});

describe('strictBigInt', () => {
  it('converts valid bigint values', () => {
    expect(strictBigInt(42n, 'test')).toBe(42n);
    expect(strictBigInt(0n, 'test')).toBe(0n);
  });

  it('converts valid numeric strings', () => {
    expect(strictBigInt('123', 'test')).toBe(123n);
    expect(strictBigInt('0', 'test')).toBe(0n);
  });

  it('converts numbers', () => {
    expect(strictBigInt(42, 'test')).toBe(42n);
  });

  it('throws on null', () => {
    expect(() => strictBigInt(null, 'field')).toThrow('Expected bigint for field');
  });

  it('throws on undefined', () => {
    expect(() => strictBigInt(undefined, 'field')).toThrow('Expected bigint for field');
  });

  it('throws on non-numeric string', () => {
    expect(() => strictBigInt('not-a-number', 'field')).toThrow('Invalid bigint for field');
  });

  it('throws on object', () => {
    expect(() => strictBigInt({}, 'field')).toThrow('Invalid bigint for field');
  });
});
