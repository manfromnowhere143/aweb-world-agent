import { TOOL_SLUGS } from '../tools';
import type { MissionPlan, PolicyConfig } from '../trust/types';

/** Build the governance policy for a mission from its plan. */
export function policyFromPlan(plan: MissionPlan): PolicyConfig {
  return {
    allowedTools: [...TOOL_SLUGS],
    valueCapUsd: plan.valueCapUsd, // already >= declared movements (planner guarantees)
    autoApproveRiskClasses: ['READ_ONLY', 'REVERSIBLE'],
  };
}
