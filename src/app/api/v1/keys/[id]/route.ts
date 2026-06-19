/**
 * DELETE /api/v1/keys/:id — revoke a key. Only the verified human who owns it
 * (matching World ID nullifier in their session) can revoke it. Soft-delete.
 */
import { revokeApiKey } from '@/lib/store';
import { verifyHumanSession, sessionFromRequest } from '@/lib/api/human-session';
import { json, apiError, preflight } from '@/lib/api/http';

export const runtime = 'nodejs';
const now = () => new Date().toISOString();

export function OPTIONS() {
  return preflight();
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = verifyHumanSession(sessionFromRequest(req), Date.now());
  if (!session) return apiError('verify with World ID first (no valid human session)', 401);
  const { id } = await params;
  const revoked = await revokeApiKey(id, session.nullifier, now());
  if (!revoked) return apiError('key not found or not yours', 404);
  return json({ revoked: true, id });
}
