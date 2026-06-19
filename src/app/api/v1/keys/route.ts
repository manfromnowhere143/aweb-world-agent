/**
 * /api/v1/keys — verified-human-scoped API key management.
 *   GET  → list this human's keys (prefix only; secrets never returned)
 *   POST → mint a new key (secret returned ONCE), bound to this human's nullifier
 *
 * Both require a verified-human session token (x-wa-human-session) obtained from
 * /api/v1/human/session via World ID. Keys authenticate the REST API + MCP server.
 */
import { listApiKeysByHuman, createApiKey, toApiKeyView, type StoredApiKey } from '@/lib/store';
import { mintKey } from '@/lib/api/keys';
import { verifyHumanSession, sessionFromRequest } from '@/lib/api/human-session';
import { json, apiError, preflight, rateGuard } from '@/lib/api/http';

export const runtime = 'nodejs';
const now = () => new Date().toISOString();

const DEFAULT_SCOPES = ['missions.create', 'missions.execute', 'receipts.read', 'mcp'];
const MAX_KEYS = 25;

export function OPTIONS() {
  return preflight();
}

function human(req: Request) {
  return verifyHumanSession(sessionFromRequest(req), Date.now());
}

export async function GET(req: Request) {
  const session = human(req);
  if (!session) return apiError('verify with World ID first (no valid human session)', 401);
  const keys = await listApiKeysByHuman(session.nullifier);
  return json({ keys: keys.map(toApiKeyView), verificationLevel: session.verificationLevel });
}

export async function POST(req: Request) {
  const limited = await rateGuard(req, 'keys', 10); if (limited) return limited;
  const session = human(req);
  if (!session) return apiError('verify with World ID first (no valid human session)', 401);

  const { name, scopes } = (await req.json().catch(() => ({}))) as { name?: string; scopes?: string[] };
  const label = (name || '').trim();
  if (label.length < 2 || label.length > 60) return apiError('key name must be 2–60 characters', 400);

  const existing = await listApiKeysByHuman(session.nullifier);
  if (existing.filter(k => !k.revokedAt).length >= MAX_KEYS) {
    return apiError(`key limit reached (${MAX_KEYS} active) — revoke one first`, 409);
  }

  const minted = mintKey();
  const chosen = Array.isArray(scopes) && scopes.length ? scopes.filter(s => DEFAULT_SCOPES.includes(s)) : DEFAULT_SCOPES;
  const record: StoredApiKey = {
    id: `key_${crypto.randomUUID().slice(0, 12)}`,
    keyHash: minted.hash,
    keyPrefix: minted.prefix,
    name: label,
    humanNullifier: session.nullifier,
    scopes: chosen.length ? chosen : DEFAULT_SCOPES,
    createdAt: now(),
    usageCount: 0,
  };
  await createApiKey(record);

  // The full secret is returned exactly once and never persisted in plaintext.
  return json({ key: toApiKeyView(record), secret: minted.secret, shownOnce: true }, { status: 201 });
}
