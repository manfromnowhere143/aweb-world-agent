/**
 * Planner — turns a human's natural-language task into a typed, governed
 * MissionPlan. The model proposes ordered steps using only the allow-listed
 * tools; we derive the risk class from the tool (not the model) so governance
 * is never something the model can talk its way around.
 */
import { z } from 'zod';
import { complete, extractJson } from './anthropic';
import { TOOLS, TOOL_SLUGS, toolBySlug } from '../tools';
import type { MissionPlan, MissionStep } from '../trust/types';

const StepSchema = z.object({
  tool: z.enum(TOOL_SLUGS as [string, ...string[]]),
  intent: z.string().min(1),
  args: z.record(z.unknown()).default({}),
  valueUsd: z.number().nonnegative().optional(),
});
const PlanSchema = z.object({
  steps: z.array(StepSchema).min(1).max(8),
  dataBoundaries: z.array(z.string()).default(['public information only']),
  valueCapUsd: z.number().nonnegative().default(0),
});

const SYSTEM = `You are the planning core of a GOVERNED AI agent that acts on behalf of a verified human inside the World App.
Decompose the user's task into an ordered list of concrete steps. Each step must use exactly one tool from this set:
${TOOLS.map(t => `- ${t.slug} (${t.riskClass}): ${t.description}`).join('\n')}

Rules:
- Prefer read-only research and reversible drafting first; only include an irreversible "send" or "pay" step if the task truly requires delivering or transacting.
- Never invent tools. Use only the slugs above.
- For "pay", set "valueUsd" and put {"to":"0x...","amountUsd":N,"currency":"USDC"} in args. Keep value modest.
- Keep args concrete (e.g. {"query": "..."} for research, {"subject":"...","to":"..."} for send).
- Output STRICT JSON only: {"steps":[{"tool","intent","args","valueUsd?"}],"dataBoundaries":[...],"valueCapUsd":N}. No prose.`;

export async function planMission(goal: string, opts: { missionId: string; now: () => string }): Promise<MissionPlan> {
  const raw = await complete(SYSTEM, `Task: ${goal}`, 1400);
  const parsed = PlanSchema.parse(extractJson(raw));

  const steps: MissionStep[] = parsed.steps.map((s, i) => {
    const tool = toolBySlug(s.tool)!;
    const args = { ...(s.args ?? {}) };
    let valueUsd: number | undefined;
    if (tool.riskClass === 'VALUE_MOVEMENT') {
      // Reconcile the declared value with the tool's amount so the cap and the
      // tool agree on a single authoritative figure.
      valueUsd = Number(s.valueUsd ?? args.amountUsd ?? args.amount ?? 0);
      args.amountUsd = valueUsd;
    }
    return {
      id: `s${i + 1}`,
      index: i,
      tool: s.tool,
      intent: s.intent,
      args,
      riskClass: tool.riskClass, // authoritative — derived from the tool, not the model
      ...(valueUsd !== undefined ? { valueUsd } : {}),
    };
  });

  // Value cap: at least cover declared movements, capped sensibly for MVP.
  const declared = steps.reduce((a, s) => a + (s.valueUsd ?? 0), 0);
  const valueCapUsd = Math.max(parsed.valueCapUsd, declared);

  return {
    missionId: opts.missionId,
    goal,
    createdAt: opts.now(),
    steps,
    dataBoundaries: parsed.dataBoundaries,
    valueCapUsd,
  };
}
