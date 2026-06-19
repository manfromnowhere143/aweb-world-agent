/**
 * Plan + freeze + evaluate + persist a governed mission. Shared by the internal
 * /api/mission/plan route and the public /api/v1/missions API so a mission is
 * created identically regardless of entry point.
 */
import { planMission } from '@/lib/agent/planner';
import { policyFromPlan } from '@/lib/agent/policy-from-plan';
import { GovernedMission } from '@/lib/trust/runtime';
import { evaluatePlan } from '@/lib/trust/policy';
import { saveMission, recallMemory } from '@/lib/store';
import type { MissionPlan, StepEvaluation } from '@/lib/trust/types';

export interface CreatedMission {
  missionId: string;
  plan: MissionPlan;
  planHash: string;
  signal: string; // the value to pass as the World ID approval signal
  needsApproval: boolean;
  evaluation: StepEvaluation[];
}

/** Throws GovernanceError if the plan is denied outright by policy. `subject`
 *  (wallet / World ID nullifier) keys the per-human memory recalled into planning. */
export async function createMission(goal: string, now: () => string, subject?: string): Promise<CreatedMission> {
  const missionId = `m_${crypto.randomUUID().slice(0, 12)}`;
  const memory = subject ? (await recallMemory(subject, 5).catch(() => [])).map(m => m.summary) : [];
  const plan = await planMission(goal.trim(), { missionId, now, memory });
  const policy = policyFromPlan(plan);

  // Constructor freezes + evaluates the plan (throws GovernanceError if denied).
  const mission = new GovernedMission(plan, policy, { now });
  const planHash = mission.planHash;

  const evaluation = evaluatePlan(plan, policy);
  await saveMission({ missionId, plan, planHash, state: 'planned', createdAt: plan.createdAt });

  return { missionId, plan, planHash, signal: planHash, needsApproval: evaluation.needsApproval, evaluation: evaluation.evaluations };
}
