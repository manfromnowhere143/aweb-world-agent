/**
 * POST /api/v1/missions/:id/execute — run a planned mission to a sealed +
 * anchored receipt (key-gated).
 *
 * If the plan has sensitive steps, the body must include a World ID `proof`
 * bound to the plan-hash; otherwise a 428 is returned with the `signal` to sign.
 * On success, returns the full receipt (hash-chained, Ed25519-sealed, and —
 * when the signer is funded — anchored on World Chain).
 */
import { getMission } from '@/lib/store';
import { completeMission } from '@/lib/agent/run-mission';
import { authenticateAsync } from '@/lib/api/auth';
import { json, apiError, preflight, rateGuard } from '@/lib/api/http';
import type { WorldProofPayload } from '@/lib/world/verify';

export const runtime = 'nodejs';
const now = () => new Date().toISOString();

export function OPTIONS() {
  return preflight();
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const limited = await rateGuard(req, 'execute', 30); if (limited) return limited;
  const caller = await authenticateAsync(req);
  if (!caller) return apiError('unauthorized — provide a Bearer API key', 401);

  const { id } = await params;
  const stored = await getMission(id);
  if (!stored) return apiError('mission not found', 404);

  const { proof, walletAddress } = (await req.json().catch(() => ({}))) as {
    proof?: WorldProofPayload;
    walletAddress?: string;
  };

  const result = await completeMission(stored, { proof, walletAddress }, now);
  if (!result.ok) {
    return apiError(result.error, result.status, result.signal ? { signal: result.signal } : undefined);
  }
  return json({
    missionId: result.missionId,
    state: result.state,
    planHash: result.planHash,
    receipt: result.receipt,
    receiptUrl: `/api/v1/receipts/${result.missionId}`,
  });
}
