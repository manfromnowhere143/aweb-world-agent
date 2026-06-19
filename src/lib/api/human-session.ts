/**
 * Verified-human session tokens for the developer console.
 *
 * After a human proves themselves once with World ID (verify-human), the server
 * issues a short-lived signed token carrying their stable nullifier. The console
 * then mints/lists/revokes API keys scoped to that human without re-running the
 * World ID flow on every action. HMAC-SHA256 signed, so it's tamper-evident and
 * stateless (no server session store needed).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

const TTL_MS = 24 * 60 * 60 * 1000; // 24h

function secret(): string {
  return (
    process.env.WORLD_AGENT_SESSION_SECRET ||
    process.env.TRUST_SIGNING_PRIVATE_KEY ||
    'wa-dev-session-secret-change-in-prod'
  );
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64url(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}
function mac(body: string): string {
  return b64url(createHmac('sha256', secret()).update(body).digest());
}

export interface HumanSession {
  nullifier: string;
  verificationLevel: 'orb' | 'device';
  iat: number;
  exp: number;
}

/** Issue a signed session for a verified human. `now` injected (no Date in core). */
export function issueHumanSession(nullifier: string, verificationLevel: 'orb' | 'device', nowMs: number): string {
  const payload: HumanSession = { nullifier, verificationLevel, iat: nowMs, exp: nowMs + TTL_MS };
  const body = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  return `${body}.${mac(body)}`;
}

/** Verify + decode a session token. Returns null if malformed, forged, or expired. */
export function verifyHumanSession(token: string | null | undefined, nowMs: number): HumanSession | null {
  if (!token) return null;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = mac(body);
  const a = fromB64url(sig);
  const b = fromB64url(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(fromB64url(body).toString('utf8')) as HumanSession;
    if (!payload.nullifier || typeof payload.exp !== 'number' || payload.exp < nowMs) return null;
    return payload;
  } catch {
    return null;
  }
}

/** Pull a session token from the request (header set by the console client). */
export function sessionFromRequest(req: Request): string | null {
  return req.headers.get('x-wa-human-session');
}
