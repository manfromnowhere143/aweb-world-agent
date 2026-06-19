/**
 * GET /api/v1/receipts/:id — the public, verifiable agent receipt.
 *
 * This is the B2B surface the grant thesis promises: a counterparty (merchant,
 * platform, another mini app, an x402 service) fetches the receipt for an action
 * its user's agent claims to have performed, and gets the sealed + anchored
 * evidence plus a server attestation. CORS-open; no key required — proofs are
 * meant to be checked by anyone.
 */
import { getMission } from '@/lib/store';
import { attestReceipt } from '@/lib/trust/verify-server';
import { json, apiError, preflight } from '@/lib/api/http';

export const runtime = 'nodejs';
const now = () => new Date().toISOString();

export function OPTIONS() {
  return preflight();
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const mission = await getMission(id);
  if (!mission?.receipt) return apiError('receipt not found', 404);

  const onchain = new URL(req.url).searchParams.get('onchain') === '1';
  const attestation = await attestReceipt(mission.receipt, now, { verifyOnChain: onchain });

  return json({
    missionId: mission.missionId,
    goal: mission.plan.goal,
    planHash: mission.planHash,
    state: mission.state,
    createdAt: mission.createdAt,
    receipt: mission.receipt,
    attestation,
    verifyUrl: `/api/v1/receipts/${mission.missionId}/verify`,
    humanUrl: `/receipt/${mission.missionId}`,
  });
}
