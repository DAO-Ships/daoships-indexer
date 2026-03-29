/** Safely convert a bigint to string for Postgres NUMERIC(78,0) */
export function bigintToString(value: bigint): string {
  return value.toString();
}

/** Add two NUMERIC strings */
export function addNumericStrings(a: string, b: string): string {
  return (BigInt(a || '0') + BigInt(b || '0')).toString();
}

/**
 * Subtract two NUMERIC strings, floored at zero.
 * Used for member balances to prevent negative values caused by race conditions,
 * reorg replays, or out-of-order event delivery. Returns the floor-clamped
 * result; callers should log a warning when `a < b` (indicates data inconsistency).
 */
export function subtractNumericStringsFloored(a: string, b: string): string {
  const result = BigInt(a || '0') - BigInt(b || '0');
  return (result < 0n ? 0n : result).toString();
}

/**
 * Returns true when subtracting b from a would produce a negative result.
 * Use alongside subtractNumericStringsFloored to detect clamping for warning logs.
 */
export function wouldClamp(a: string, b: string): boolean {
  return BigInt(a || '0') - BigInt(b || '0') < 0n;
}

/** Safely convert a value to BigInt, returning a default on failure */
export function safeBigInt(value: unknown, defaultValue: bigint = 0n): bigint {
  if (value === undefined || value === null) return defaultValue;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isFinite(value)) {
    try { return BigInt(value); } catch { return defaultValue; }
  }
  if (typeof value === 'string') {
    try { return BigInt(value); } catch { return defaultValue; }
  }
  return defaultValue;
}

/** Convert a value to BigInt, throwing on failure (use for critical fields) */
export function strictBigInt(value: unknown, fieldName: string): bigint {
  if (value === undefined || value === null) {
    throw new Error(`Expected bigint for ${fieldName}, got ${value}`);
  }
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isFinite(value)) {
    try { return BigInt(value); } catch {
      throw new Error(`Invalid bigint for ${fieldName}: ${value}`);
    }
  }
  if (typeof value === 'string') {
    try { return BigInt(value); } catch {
      throw new Error(`Invalid bigint for ${fieldName}: "${value}"`);
    }
  }
  throw new Error(`Invalid bigint for ${fieldName}: ${typeof value}`);
}
