/**
 * GET /api/v1/receipts/:id/verify — machine-readable attestation only.
 *
 * Returns the integrity / authenticity / anchor verdict without the full receipt
 * body, for programmatic checks. `?onchain=1` additionally reads the anchor tx
 * calldata from World Chain and confirms it equals the sealed root (trustless).
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
  return json(attestation);
}
