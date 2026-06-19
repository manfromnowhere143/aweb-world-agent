/**
 * API-key authentication for the governed mutating endpoints (create / execute).
 *
 * Reads come open (receipts are public, verifiable proofs); writes that spend
 * the agent's resources are gated by a bearer key. Keys live in the
 * `WORLD_AGENT_API_KEYS` env var as a comma-separated list of `label:secret`
 * (or bare `secret`). Comparison is constant-time to avoid timing leaks.
 *
 * Default posture follows Aweb's "full power, no read-only gates" rule: if NO
 * keys are configured at all, the API is OPEN (the agent runs at full power and
 * the operator opted out of gating). Configure keys to lock writes down.
 */
import { timingSafeEqual } from 'node:crypto';

export interface ApiCaller {
  label: string;
  authenticated: boolean;
}

function parseKeys(): Array<{ label: string; secret: string }> {
  const raw = process.env.WORLD_AGENT_API_KEYS;
  if (!raw) return [];
  return raw
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(pair => {
      const idx = pair.indexOf(':');
      return idx > 0
        ? { label: pair.slice(0, idx).trim(), secret: pair.slice(idx + 1).trim() }
        : { label: 'client', secret: pair };
    })
    .filter(k => k.secret.length > 0);
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function bearer(req: Request): string | null {
  const h = req.headers.get('authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  if (m) return m[1]!.trim();
  const x = req.headers.get('x-api-key');
  return x ? x.trim() : null;
}

/**
 * Authenticate a request. Returns the caller when allowed, or null when a key
 * is required but missing/invalid. When no keys are configured the API is open
 * (caller label `open`), per the no-read-only-gates default.
 */
export function authenticate(req: Request): ApiCaller | null {
  const keys = parseKeys();
  if (keys.length === 0) return { label: 'open', authenticated: false };
  const presented = bearer(req);
  if (!presented) return null;
  for (const k of keys) {
    if (safeEqual(presented, k.secret)) return { label: k.label, authenticated: true };
  }
  return null;
}

/** True when at least one ENV API key is configured. */
export function keysConfigured(): boolean {
  return parseKeys().length > 0;
}

/**
 * Async authenticate — checks env keys (admin/bootstrap) AND minted, hashed keys
 * persisted in the store (the verified-human-scoped keys from the console). This
 * is the gate the public API + MCP server use.
 *
 * Posture: open only when NEITHER an env key NOR any minted key could apply, i.e.
 * no env keys configured (per the no-read-only-gates default). If a bearer token
 * is presented, it must validate against an env key or an active minted key.
 */
export async function authenticateAsync(req: Request): Promise<(ApiCaller & { humanNullifier?: string }) | null> {
  const presented = bearer(req);
  const envKeys = parseKeys();

  if (presented) {
    for (const k of envKeys) {
      if (safeEqual(presented, k.secret)) return { label: k.label, authenticated: true };
    }
    // Try a minted, hashed key from the store.
    try {
      const { hashKey } = await import('./keys');
      const { findActiveApiKeyByHash } = await import('@/lib/store');
      const found = await findActiveApiKeyByHash(hashKey(presented), new Date().toISOString());
      if (found) return { label: found.name, authenticated: true, humanNullifier: found.humanNullifier };
    } catch {
      /* store unavailable → fall through */
    }
    return null; // a token was presented but matched nothing
  }

  // No token presented: open only if no env keys are configured.
  if (envKeys.length === 0) return { label: 'open', authenticated: false };
  return null;
}
