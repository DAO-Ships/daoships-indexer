/**
 * Validation utilities for addresses, hashes, and event args.
 * Mirrors the audited patterns from quaivault-indexer.
 */

import { isQuaiAddress } from 'quais';

// ── Address Validation ──────────────────────────────────────────

export function isValidAddress(address: unknown): address is string {
  if (typeof address !== 'string') return false;
  if (address.length !== 42 || !address.startsWith('0x')) return false;
  return isQuaiAddress(address);
}

export function validateAndNormalizeAddress(address: unknown, fieldName: string): string {
  if (!isValidAddress(address)) {
    throw new Error(
      `Invalid ${fieldName}: expected valid Quai address, got "${String(address)}"`,
    );
  }
  return address.toLowerCase();
}

// ── Bytes32 / Hash Validation ───────────────────────────────────

export function isValidBytes32(hash: unknown): hash is string {
  if (typeof hash !== 'string') return false;
  if (hash.length !== 66) return false;
  return /^0x[0-9a-fA-F]{64}$/.test(hash);
}

export function validateBytes32(hash: unknown, fieldName: string): string {
  if (!isValidBytes32(hash)) {
    throw new Error(
      `Invalid ${fieldName}: expected 0x-prefixed 64-character hex string, got "${String(hash)}"`,
    );
  }
  return hash.toLowerCase();
}

// ── Hex String Validation ───────────────────────────────────────

export function isValidHexString(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  return /^0x[0-9a-fA-F]+$/.test(value);
}

// ── Array Validation ────────────────────────────────────────────

export function validateArray(value: unknown, fieldName: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`Expected array for ${fieldName}, got ${typeof value}`);
  }
  return value;
}

// ── Event Args Validation ───────────────────────────────────────

export function validateEventArgs<T extends Record<string, unknown>>(
  args: Record<string, unknown>,
  requiredFields: (keyof T)[],
  eventName: string,
): T {
  for (const field of requiredFields) {
    if (args[field as string] === undefined) {
      throw new Error(
        `Missing required field "${String(field)}" in ${eventName} event`,
      );
    }
  }
  return args as T;
}

// ── Contract Call Result Validation ─────────────────────────────

/**
 * Validates that a contract call returned a string-like value.
 * quais.Contract decodes ABI results, but callers often cast blindly.
 * This provides a safe narrowing gate.
 */
export function validateContractString(value: unknown, context: string): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) {
    throw new Error(`Contract call returned null/undefined for ${context}`);
  }
  // quais may return a BigInt or object — coerce safely
  return String(value);
}

/**
 * Validates that a contract call returned an address-like value.
 */
export function validateContractAddress(value: unknown, context: string): string {
  const str = validateContractString(value, context);
  if (!isValidAddress(str)) {
    throw new Error(`Contract call returned invalid address for ${context}: "${str}"`);
  }
  return str.toLowerCase();
}

// ── Block Timestamp Validation ──────────────────────────────────

/**
 * Extracts and validates a unix timestamp from a Quai block object.
 * Handles `block.date` (quais Block getter), `woHeader.timestamp` (hex),
 * `block.timestamp` as number/bigint/string, and falls back to 0 as a last resort.
 */
/**
 * Extracts Unix-seconds timestamp from a quais Block object.
 *
 * go-quai returns timestamp as hex uint64 (Unix seconds) in woHeader.
 * quais RPC formatter converts hex → JS number via getNumber().
 *
 * NEVER use block.date — it has a bug where parseInt(number, 16)
 * re-parses the already-numeric timestamp as hex, inflating it ~56x.
 * See docs/ISSUE-navigator-event-timestamps.md.
 */
export function extractBlockTimestamp(block: Record<string, unknown>, blockNumber: number): number {
  const woHeader = block.woHeader as Record<string, unknown> | undefined;
  if (!woHeader || typeof woHeader !== 'object') {
    throw new Error(`Block ${blockNumber} has no woHeader`);
  }

  const ts = woHeader.timestamp;

  if (typeof ts === 'number' && ts > 0) return ts;
  if (typeof ts === 'bigint' && ts > 0n) return Number(ts);
  if (typeof ts === 'string') {
    const parsed = isValidHexString(ts) ? parseInt(ts, 16) : parseInt(ts);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }

  throw new Error(`Block ${blockNumber} has no valid woHeader.timestamp (got ${typeof ts}: ${ts})`);
}
