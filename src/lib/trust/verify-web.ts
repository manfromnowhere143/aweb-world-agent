/**
 * Browser-side receipt verifier (Web Crypto) — mirrors the server hashing so a
 * receipt can be independently verified in the user's own device, no trust in us.
 */
import type { ReceiptChain } from './types';

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>).sort().reduce<Record<string, unknown>>((a, k) => {
      a[k] = canonicalize((value as Record<string, unknown>)[k]);
      return a;
    }, {});
  }
  return value;
}
function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}
async function sha256Hex(value: unknown): Promise<string> {
  const data = new TextEncoder().encode(canonicalJson(value));
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Verify the Ed25519 seal over the chain head — proves authenticity in the browser. */
export async function verifySealInBrowser(chain: ReceiptChain): Promise<{ status: 'valid' | 'invalid' | 'unsealed'; reason?: string }> {
  const seal = chain.seal;
  if (!seal) return { status: 'unsealed' };
  const head = chain.entries.length ? chain.entries[chain.entries.length - 1]!.hash : '';
  if (seal.signedHash !== head) return { status: 'invalid', reason: 'sealed hash ≠ chain head' };
  try {
    const key = await crypto.subtle.importKey('spki', b64ToBytes(seal.publicKey) as BufferSource, { name: 'Ed25519' }, false, ['verify']);
    const ok = await crypto.subtle.verify(
      { name: 'Ed25519' }, key,
      b64ToBytes(seal.signature) as BufferSource,
      new TextEncoder().encode(seal.signedHash) as BufferSource,
    );
    return ok ? { status: 'valid' } : { status: 'invalid', reason: 'signature does not verify' };
  } catch (e) {
    return { status: 'invalid', reason: e instanceof Error ? e.message : 'verify error' };
  }
}

export async function verifyChainInBrowser(chain: ReceiptChain): Promise<{ valid: boolean; brokenAt?: number; reason?: string }> {
  let prev: string | null = null;
  for (let i = 0; i < chain.entries.length; i++) {
    const e = chain.entries[i]!;
    if (e.seq !== i) return { valid: false, brokenAt: i, reason: 'seq mismatch' };
    if (e.prevHash !== prev) return { valid: false, brokenAt: i, reason: 'linkage broken' };
    const recomputed = await sha256Hex({ seq: e.seq, kind: e.kind, at: e.at, summary: e.summary, data: e.data, prevHash: e.prevHash });
    if (recomputed !== e.hash) return { valid: false, brokenAt: i, reason: 'hash mismatch (tampered)' };
    prev = e.hash;
  }
  return { valid: true };
}
