/**
 * Policy engine — classifies each step and decides whether it may run
 * automatically, requires a World ID human approval, or is denied outright.
 *
 * Default-deny: a tool that is not allow-listed, a value over the cap, or an
 * unknown risk class is DENIED, never silently allowed.
 */
import type {
  MissionPlan,
  MissionStep,
  PolicyConfig,
  StepDecision,
  StepEvaluation,
} from './types';

const KNOWN_RISK = new Set(['READ_ONLY', 'REVERSIBLE', 'SENSITIVE', 'VALUE_MOVEMENT']);

export const DEFAULT_POLICY: PolicyConfig = {
  allowedTools: [],
  valueCapUsd: 0,
  autoApproveRiskClasses: ['READ_ONLY', 'REVERSIBLE'],
};

export function evaluateStep(step: MissionStep, policy: PolicyConfig): StepEvaluation {
  const base = { stepId: step.id };

  if (!KNOWN_RISK.has(step.riskClass)) {
    return { ...base, decision: 'denied' as StepDecision, reason: `unknown risk class '${step.riskClass}' (default-deny)` };
  }
  if (!policy.allowedTools.includes(step.tool)) {
    return { ...base, decision: 'denied', reason: `tool '${step.tool}' is not allow-listed` };
  }
  if (step.riskClass === 'VALUE_MOVEMENT') {
    const v = step.valueUsd ?? 0;
    if (v <= 0) return { ...base, decision: 'denied', reason: 'value movement with no declared amount' };
    if (v > policy.valueCapUsd) return { ...base, decision: 'denied', reason: `value $${v} exceeds mission cap $${policy.valueCapUsd}` };
    // Value movement always needs explicit human approval, even within cap.
    return { ...base, decision: 'needs_approval', reason: `value movement $${v} requires human approval` };
  }
  if (policy.autoApproveRiskClasses.includes(step.riskClass)) {
    return { ...base, decision: 'auto', reason: `${step.riskClass} auto-approved (logged)` };
  }
  // SENSITIVE (and anything not auto-approved) requires human approval.
  return { ...base, decision: 'needs_approval', reason: `${step.riskClass} requires human approval` };
}

export interface PlanEvaluation {
  evaluations: StepEvaluation[];
  needsApproval: boolean;
  denied: StepEvaluation[];
  totalValueUsd: number;
  withinCap: boolean;
}

export function evaluatePlan(plan: MissionPlan, policy: PolicyConfig): PlanEvaluation {
  const evaluations = plan.steps.map(s => evaluateStep(s, policy));
  const totalValueUsd = plan.steps.reduce((a, s) => a + (s.riskClass === 'VALUE_MOVEMENT' ? s.valueUsd ?? 0 : 0), 0);
  return {
    evaluations,
    needsApproval: evaluations.some(e => e.decision === 'needs_approval'),
    denied: evaluations.filter(e => e.decision === 'denied'),
    totalValueUsd,
    withinCap: totalValueUsd <= policy.valueCapUsd,
  };
}
