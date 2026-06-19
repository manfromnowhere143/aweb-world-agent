/**
 * GET /api/v1/missions/:id — mission status + plan (public read).
 *
 * Once a mission has a receipt, the canonical evidence lives at
 * /api/v1/receipts/:id. This endpoint exposes the plan + lifecycle state for
 * polling between create and execute.
 */
import { getMission } from '@/lib/store';
import { json, apiError, preflight } from '@/lib/api/http';

export const runtime = 'nodejs';

export function OPTIONS() {
  return preflight();
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const mission = await getMission(id);
  if (!mission) return apiError('mission not found', 404);
  return json({
    missionId: mission.missionId,
    goal: mission.plan.goal,
    planHash: mission.planHash,
    state: mission.state,
    createdAt: mission.createdAt,
    plan: mission.plan,
    hasReceipt: !!mission.receipt,
    receiptUrl: mission.receipt ? `/api/v1/receipts/${mission.missionId}` : null,
  });
}
