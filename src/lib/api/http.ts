/**
 * Shared HTTP helpers for the public Aweb Agent API (v1).
 *
 * The receipts surface is meant to be called by other World mini apps, the x402
 * web, and external agents — so reads are CORS-open and the responses are clean,
 * versioned JSON. Mutating routes are API-key gated (see ./auth).
 */
import { NextResponse } from 'next/server';

export const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization',
  'access-control-max-age': '86400',
};

export function json(body: unknown, init?: { status?: number; headers?: Record<string, string> }): NextResponse {
  return NextResponse.json(body as object, {
    status: init?.status ?? 200,
    headers: { ...CORS_HEADERS, ...(init?.headers ?? {}) },
  });
}

export function apiError(message: string, status = 400, extra?: Record<string, unknown>): NextResponse {
  return json({ error: message, ...(extra ?? {}) }, { status });
}

/** Standard preflight responder for v1 routes. */
export function preflight(): NextResponse {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

/** Best-effort caller identity for rate limiting: bearer-key tail, else client IP. */
export function clientId(req: Request): string {
  const auth = req.headers.get('authorization') || req.headers.get('x-api-key') || '';
  const tok = /Bearer\s+(.+)/i.exec(auth)?.[1] || auth;
  if (tok) return `k:${tok.trim().slice(-12)}`;
  const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || req.headers.get('x-real-ip') || 'anon';
  return `ip:${ip}`;
}

/**
 * One-line rate guard for a route. Returns a 429 NextResponse if over the limit,
 * else null. Limits are overridable via env (WORLD_AGENT_RATE_<BUCKET>).
 */
export async function rateGuard(req: Request, bucket: string, limit: number, windowSec = 60): Promise<NextResponse | null> {
  const { rateLimit } = await import('@/lib/store');
  const envLimit = Number(process.env[`WORLD_AGENT_RATE_${bucket.toUpperCase()}`]);
  const cap = Number.isFinite(envLimit) && envLimit > 0 ? envLimit : limit;
  const r = await rateLimit(`${bucket}:${clientId(req)}`, cap, windowSec, Date.now());
  if (r.ok) return null;
  return json({ error: 'rate limit exceeded — slow down', retryAfterSeconds: r.retryAfter }, { status: 429, headers: { 'retry-after': String(r.retryAfter) } });
}
