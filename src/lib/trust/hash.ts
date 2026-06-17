/**
 * Deterministic canonical hashing for governance + receipt chains.
 *
 * Canonical JSON = recursively key-sorted, so the same logical object always
 * hashes to the same digest regardless of property order. Used for the mission
 * plan-hash (bound to the World ID approval signal) and the hash-chained receipt.
 *
 * Server path uses node:crypto (sync, deterministic). A Web Crypto verifier
 * (browser) lives in `verify-web.ts` so receipts are independently checkable.
 */
import { createHash } from 'node:crypto';

/** Recursively sort object keys so serialization is stable. */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = canonicalize((value as Record<string, unknown>)[k]);
        return acc;
      }, {});
  }
  return value;
}

/** Canonical JSON string (stable key order). */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/** SHA-256 hex of the canonical JSON of `value`. */
export function sha256Hex(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

/** Short, human-friendly digest for UI (first 16 hex chars + ellipsis). */
export function shortHash(hex: string): string {
  return `${hex.slice(0, 16)}…`;
}
