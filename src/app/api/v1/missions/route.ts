/**
 * POST /api/v1/missions — create + plan a governed mission via API.
 *
 * Key-gated (Bearer / x-api-key). Returns the typed plan, the plan-hash (which is
 * the World ID approval signal), and whether human approval is required before
 * execution. The caller then drives /api/v1/missions/:id/execute.
 */
import { GovernanceError } from '@/lib/trust/runtime';
import { createMission } from '@/lib/agent/create-mission';
import { authenticateAsync } from '@/lib/api/auth';
import { json, apiError, preflight, rateGuard } from '@/lib/api/http';

export const runtime = 'nodejs';
const now = () => new Date().toISOString();

export function OPTIONS() {
  return preflight();
}

export async function POST(req: Request) {
  const limited = await rateGuard(req, 'missions', 30); if (limited) return limited;
  const caller = await authenticateAsync(req);
  if (!caller) return apiError('unauthorized — provide a Bearer API key', 401);
  try {
    const { goal, walletAddress } = (await req.json().catch(() => ({}))) as { goal?: string; walletAddress?: string };
    if (!goal || goal.trim().length < 3) return apiError('goal required (a sentence describing the task)', 400);
    // memory subject: the API key's verified human, else a passed wallet
    const subject = caller.humanNullifier || walletAddress;
    const created = await createMission(goal, now, subject);
    return json({ ...created, executeUrl: `/api/v1/missions/${created.missionId}/execute` }, { status: 201 });
  } catch (e) {
    if (e instanceof GovernanceError) return apiError(`plan blocked by policy: ${e.message}`, 422);
    return apiError(e instanceof Error ? e.message : String(e), 500);
  }
}
