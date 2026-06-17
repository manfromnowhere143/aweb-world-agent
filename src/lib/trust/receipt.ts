/**
 * Hash-chained, redaction-by-design receipts.
 *
 * Every lifecycle event appends one entry whose hash covers the previous hash,
 * so any tampering with an earlier entry breaks the chain. This is the
 * non-repudiable evidence layer AgentKit lacks.
 */
import { sha256Hex } from './hash';
import type { MissionAuthority, ReceiptChain, ReceiptEntry, ReceiptKind } from './types';

/** Keys that must never appear raw in a receipt. Redacted before hashing. */
const REDACT_KEYS = new Set(['proof', 'apiKey', 'api_key', 'secret', 'token', 'password', 'authorization', 'privateKey']);

/** Recursively redact sensitive keys (e.g. raw ZK proof blobs, secrets). */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) =>
        REDACT_KEYS.has(k) ? [k, '[redacted]'] : [k, redact(v)],
      ),
    );
  }
  return value;
}

function entryHash(e: Omit<ReceiptEntry, 'hash'>): string {
  return sha256Hex({ seq: e.seq, kind: e.kind, at: e.at, summary: e.summary, data: e.data, prevHash: e.prevHash });
}

export class ReceiptBuilder {
  private entries: ReceiptEntry[] = [];
  constructor(
    public readonly missionId: string,
    public readonly planHash: string,
    public authority: MissionAuthority = {},
    private onEntry?: (entry: ReceiptEntry) => void,
  ) {}

  /** Append a redacted, hash-chained entry. `at` is injected (no Date in core). */
  append(kind: ReceiptKind, at: string, summary: string, data: Record<string, unknown> = {}): ReceiptEntry {
    const prevHash = this.entries.length ? this.entries[this.entries.length - 1]!.hash : null;
    const base: Omit<ReceiptEntry, 'hash'> = {
      seq: this.entries.length,
      kind,
      at,
      summary,
      data: redact(data) as Record<string, unknown>,
      prevHash,
    };
    const entry: ReceiptEntry = { ...base, hash: entryHash(base) };
    this.entries.push(entry);
    this.onEntry?.(entry);
    return entry;
  }

  setAuthority(a: MissionAuthority) {
    this.authority = { ...this.authority, ...a };
  }

  chain(): ReceiptChain {
    return { missionId: this.missionId, planHash: this.planHash, authority: this.authority, entries: [...this.entries] };
  }
}

/**
 * Append a properly hash-chained, redacted entry to an EXISTING chain (e.g. an
 * on-chain settlement recorded after the governed run). Returns the new entry.
 * Caller should re-seal the chain afterward.
 */
export function appendToChain(chain: ReceiptChain, kind: ReceiptKind, at: string, summary: string, data: Record<string, unknown> = {}): ReceiptEntry {
  const prevHash = chain.entries.length ? chain.entries[chain.entries.length - 1]!.hash : null;
  const base: Omit<ReceiptEntry, 'hash'> = {
    seq: chain.entries.length,
    kind,
    at,
    summary,
    data: redact(data) as Record<string, unknown>,
    prevHash,
  };
  const entry: ReceiptEntry = { ...base, hash: entryHash(base) };
  chain.entries.push(entry);
  return entry;
}

/** Verify a receipt chain: recompute every hash and check linkage. */
export function verifyReceiptChain(chain: ReceiptChain): { valid: boolean; brokenAt?: number; reason?: string } {
  let prev: string | null = null;
  for (let i = 0; i < chain.entries.length; i++) {
    const e = chain.entries[i]!;
    if (e.seq !== i) return { valid: false, brokenAt: i, reason: `seq mismatch (${e.seq} != ${i})` };
    if (e.prevHash !== prev) return { valid: false, brokenAt: i, reason: 'prevHash linkage broken' };
    const recomputed = entryHash({ seq: e.seq, kind: e.kind, at: e.at, summary: e.summary, data: e.data, prevHash: e.prevHash });
    if (recomputed !== e.hash) return { valid: false, brokenAt: i, reason: 'entry hash mismatch (tampered)' };
    prev = e.hash;
  }
  return { valid: true };
}
