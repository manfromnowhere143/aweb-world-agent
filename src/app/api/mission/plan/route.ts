import { NextRequest, NextResponse } from 'next/server';
import { planMission } from '@/lib/agent/planner';
import { policyFromPlan } from '@/lib/agent/policy-from-plan';
import { GovernedMission, GovernanceError } from '@/lib/trust/runtime';
import { evaluatePlan } from '@/lib/trust/policy';
import { saveMission } from '@/lib/store';

export const runtime = 'nodejs';
const now = () => new Date().toISOString();

export async function POST(req: NextRequest) {
  try {
    const { goal } = (await req.json()) as { goal?: string };
    if (!goal || goal.trim().length < 3) {
      return NextResponse.json({ error: 'Tell the agent what to do (a sentence).' }, { status: 400 });
    }
    const missionId = `m_${crypto.randomUUID().slice(0, 12)}`;
    const plan = await planMission(goal.trim(), { missionId, now });
    const policy = policyFromPlan(plan);

    // Freeze + evaluate (constructor throws GovernanceError if the plan is denied).
    let planHash = '';
    try {
      const mission = new GovernedMission(plan, policy, { now });
      planHash = mission.planHash;
    } catch (e) {
      if (e instanceof GovernanceError) {
        return NextResponse.json({ error: `Plan blocked by policy: ${e.message}`, plan }, { status: 422 });
      }
      throw e;
    }

    const evaluation = evaluatePlan(plan, policy);
    await saveMission({ missionId, plan, planHash, state: 'planned', createdAt: plan.createdAt });

    return NextResponse.json({
      missionId,
      plan,
      planHash,
      signal: planHash, // the value to pass as the World ID approval signal
      needsApproval: evaluation.needsApproval,
      evaluation: evaluation.evaluations,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
