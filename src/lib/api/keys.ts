/**
 * API key minting + hashing (pure). Matches the Aweb family convention:
 * `sk-aweb-` + 32 random bytes hex; the full secret is shown ONCE at creation,
 * and only the SHA-256 hash + a short display prefix are ever stored.
 */
import { randomBytes, createHash } from 'node:crypto';

export const KEY_PREFIX = 'sk-aweb-';

export interface MintedKey {
  secret: string; // full key — returned to the caller ONE time, never stored
  hash: string; // sha256(secret) — what we persist + look up by
  prefix: string; // sk-aweb-XXXXXXXX — safe to display in a ledger
}

export function hashKey(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/** Generate a fresh API key. The secret is unrecoverable after this call. */
export function mintKey(): MintedKey {
  const raw = randomBytes(32).toString('hex');
  const secret = `${KEY_PREFIX}${raw}`;
  return { secret, hash: hashKey(secret), prefix: `${KEY_PREFIX}${raw.slice(0, 8)}` };
}
