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
  reasoning: z.string().default(''),
  critique: z.string().default(''),
  steps: z.array(StepSchema).min(1).max(8),
  dataBoundaries: z.array(z.string()).default(['public information only']),
  valueCapUsd: z.number().nonnegative().default(0),
});

const SYSTEM = `You are the planning core of a GOVERNED AI agent that acts on behalf of a verified human inside the World App. You think like a careful senior engineer: decompose, draft, then critique your own plan before committing.

Each step must use exactly one tool from this set:
${TOOLS.map(t => `- ${t.slug} (${t.riskClass}): ${t.description}`).join('\n')}

DELIBERATE in three internal passes, then output the result of all three:
1. REASON — decompose the task: what is actually being asked, what's the minimal sequence of steps, what data is touched, what could go wrong, what must be verified.
2. DRAFT — an ordered plan using only the tools above.
3. SELF-CRITIQUE — review your own draft against the goal: Is it complete? Is it MINIMAL (no unnecessary steps, no over-reach into send/pay unless truly required)? Are the tools right? Is anything unverified that "compute" could prove? Then output the FINAL, refined plan.

Rules:
- Prefer read-only research/fetch and reversible drafting first; include an irreversible "send" or "pay" step ONLY if the task truly requires delivering or transacting.
- "send" delivers FOR REAL (email / SMS / Telegram / webhook), auto-routed by the recipient. Only include "send" when the task names a real recipient; put it in args.to as an email address, a +E.164 phone, "tg:<chatId>", or an "https://" webhook URL (or set args.channel explicitly). If NO recipient is given, STOP at "draft" — never invent a recipient and never add a send that cannot really deliver.
- For ANY calculation, data analysis, parsing, or numeric verification, use "compute" — never do math in your head. Give a clear, specific intent describing exactly what to compute/verify; you may OMIT args.code entirely — the system generates correct code from your intent (prefer this; keep the plan compact). If you DO include code: Python standard library only, print to stdout, NO third-party imports and NO network. For Ethereum hashing/checksums, helpers keccak_256(data) and eip55(address) are pre-injected in Python — use them; never import pysha3/web3 or use hashlib.sha3_256 for keccak. compute returns a verifiable sandbox proof receipt.
- Use "fetch" to read a specific public https URL the task references; use "research" for open-ended web questions.
- Never invent tools. Use only the slugs above.
- For "pay", set "valueUsd" and put {"to":"0x...","amountUsd":N,"currency":"USDC"} in args. Keep value modest.
- Keep args concrete (e.g. {"query":"..."} for research, {"url":"https://..."} for fetch, {"code":"...","language":"python"} for compute, {"subject":"...","to":"..."} for send).
- Output STRICT JSON only, no prose:
{"reasoning":"<2-4 sentences of your decomposition + risks>","critique":"<1-3 sentences on why this final plan is complete, minimal, and safe>","steps":[{"tool","intent","args","valueUsd?"}],"dataBoundaries":[...],"valueCapUsd":N}`;

// Codegen backstop: the planner is told to always include runnable code for a
// "compute" step, but if the model ever emits one with empty args.code the step
// would silently skip ("no code to run") and NO E2B sandbox is created. This fills
// missing code from the step intent so compute ALWAYS executes for real in the
// isolated sandbox — producing a real sandbox + hashed proof in the receipt.
const CODEGEN_SYSTEM = `You write ONE self-contained code snippet for a governed agent's ISOLATED, ephemeral sandbox. Given a step intent and the overall goal, output runnable code that performs the computation/verification and PRINTS its result to stdout. Prefer Python.
HARD CONSTRAINTS (the sandbox has no extra packages): use ONLY the Python standard library — do NOT import third-party packages (pysha3, sha3, web3, eth_utils, eth_hash, pycryptodome/Crypto are NOT installed) and do NOT use the network. For Ethereum hashing, two correct helpers are PRE-INJECTED and already in scope — use them, do not reimplement or import:
  keccak_256(data: bytes|str) -> bytes   # Ethereum keccak-256 (NOT hashlib.sha3_256)
  eip55(address_hex: str) -> str         # returns the EIP-55 checksummed address
EIP-55 VALIDITY (get this right): a 40-hex-char address is VALID if it is all-lowercase, OR all-uppercase, OR mixed-case that exactly equals eip55(address). It is INVALID only when it is mixed-case AND does not match eip55(address). Do NOT mark an all-lowercase address invalid just because it differs from the checksummed form.
OUTPUT HYGIENE: when printing a hash or any bytes, print its hexadecimal string with a 0x prefix (e.g. '0x' + value.hex()), never the raw Python bytes repr (no b'\\x..').
GATE RULE: if this step exists to verify a PRECONDITION before a later sensitive/payment step (e.g. "verify the address is valid before paying"), and that precondition is genuinely NOT met, print the reason and then call sys.exit(1) — a failed precondition MUST fail the step so the governance runtime withholds the dependent payment. Otherwise print results and exit normally (0).
Output STRICT JSON only: {"language":"python"|"javascript"|"bash","code":"<runnable code that prints its result>"}`;

async function generateComputeCode(goal: string, intent: string): Promise<{ language: string; code: string } | null> {
  try {
    const raw = await complete(CODEGEN_SYSTEM, `GOAL: ${goal}\n\nSTEP INTENT: ${intent}\n\nWrite the code.`, 800);
    const j = extractJson(raw) as { language?: string; code?: string };
    if (j && typeof j.code === 'string' && j.code.trim()) {
      const language = j.language === 'javascript' || j.language === 'bash' ? j.language : 'python';
      return { language, code: j.code };
    }
  } catch { /* leave the step as-is — the graceful "no code to run" skip is preserved */ }
  return null;
}

/** Ensure every compute step carries runnable code so it ACTUALLY executes in E2B. */
async function ensureComputeCode(goal: string, steps: MissionStep[]): Promise<void> {
  await Promise.all(steps.map(async s => {
    if (s.tool !== 'compute') return;
    if (String((s.args as { code?: unknown }).code ?? '').trim()) return;
    const gen = await generateComputeCode(goal, s.intent);
    if (gen) {
      s.args.code = gen.code;
      if (!String((s.args as { language?: unknown }).language ?? '').trim()) s.args.language = gen.language;
    }
  }));
}

export async function planMission(goal: string, opts: { missionId: string; now: () => string; memory?: string[] }): Promise<MissionPlan> {
  // Per-human memory: prior missions for THIS verified human, to personalize +
  // avoid repeating finished work. Recency-ordered, the human's own data.
  const mem = opts.memory?.length
    ? `\n\nPRIOR CONTEXT — what you have already done for this same human (use it to personalize and to avoid repeating work; do not assume anything not stated here):\n${opts.memory.map(m => `- ${m}`).join('\n')}`
    : '';
  const raw = await complete(SYSTEM, `Task: ${goal}${mem}`, 4096);
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

  // Backstop: guarantee compute steps carry runnable code (real E2B execution).
  await ensureComputeCode(goal, steps);

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
    ...(parsed.reasoning ? { reasoning: parsed.reasoning } : {}),
    ...(parsed.critique ? { critique: parsed.critique } : {}),
  };
}

// ── Self-repair (Reflexion, grounded in REAL execution feedback) ──────────────
// Only read-only / reversible tools may be proposed: a corrective step that would
// move value or deliver irreversibly must NOT auto-run — it requires a fresh human
// approval, so governance is never bypassed by the repair loop.
const REPAIR_TOOLS = TOOLS.filter(t => t.riskClass === 'READ_ONLY' || t.riskClass === 'REVERSIBLE');
const RepairSchema = z.object({
  steps: z.array(z.object({ tool: z.enum(REPAIR_TOOLS.map(t => t.slug) as [string, ...string[]]), intent: z.string().min(1), args: z.record(z.unknown()).default({}) })).max(4),
});
const REPAIR_SYSTEM = `You are the self-repair core of a governed AI agent. A mission just ran and a verifier found GAPS. Propose the MINIMAL corrective steps to close those gaps, using ONLY these reversible/read-only tools:
${REPAIR_TOOLS.map(t => `- ${t.slug} (${t.riskClass}): ${t.description}`).join('\n')}
Ground every step in the ACTUAL gaps + prior outputs given to you — do not repeat what already succeeded. If the gaps cannot be closed with these tools (e.g. they need a human-approved send/pay), return {"steps":[]}.
Output STRICT JSON only: {"steps":[{"tool","intent","args"}]}`;

export async function replanRepair(
  goal: string,
  gaps: string[],
  priorSummary: string,
  opts: { now: () => string },
): Promise<MissionStep[]> {
  const raw = await complete(REPAIR_SYSTEM, `GOAL: ${goal}\n\nGAPS the verifier found:\n${gaps.map(g => `- ${g}`).join('\n')}\n\nWhat already ran:\n${priorSummary}`, 1000);
  let parsed: z.infer<typeof RepairSchema>;
  try { parsed = RepairSchema.parse(extractJson(raw)); } catch { return []; }
  const steps = parsed.steps.map((s, i) => {
    const tool = toolBySlug(s.tool)!;
    return { id: `r${i + 1}`, index: i, tool: s.tool, intent: s.intent, args: { ...(s.args ?? {}) }, riskClass: tool.riskClass };
  });
  // Same backstop on repair steps: compute must carry runnable code to really run.
  await ensureComputeCode(goal, steps);
  return steps;
}
