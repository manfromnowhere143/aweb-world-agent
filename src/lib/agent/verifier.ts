/**
 * Self-verification — frontier hybrid design (2026 SOTA):
 *   1. DETERMINISTIC layer (free, runs on 100%): checks each step actually produced
 *      substantive output (not just an ok flag) — catches the "rubber-stamp" failure.
 *   2. LLM RUBRIC ENSEMBLE: 3 independent critics with DISTINCT lenses
 *      (completeness · correctness · adversarial skeptic) run in parallel and vote —
 *      "many eyes" cancel single-model idiosyncrasy (ChatEval/MAJ-EVAL line of work).
 *
 * goalMet = deterministic.pass ∧ (majority of lenses pass). The verdict — with the
 * per-lens breakdown and deterministic issues — is appended to the receipt, so it is
 * hash-chained, Ed25519-sealed, and anchored. Never throws: if the model is down, the
 * SUBSTANTIVE deterministic layer stands on its own (no coarse rubber-stamp).
 */
import { z } from 'zod';
import { complete, extractJson } from './anthropic';
import type { ReceiptChain } from '../trust/types';

export interface ExecutedStep {
  stepId: string;
  tool: string;
  ok: boolean;
  outcome: string;
  output: Record<string, unknown>;
}

export interface LensVerdict { lens: string; pass: boolean; confidence: number; rationale: string }

export interface MissionVerdict {
  goalMet: boolean;
  confidence: number; // 0..1
  rationale: string;
  gaps: string[];
  perStep: Array<{ stepId: string; ok: boolean; assessment: string }>;
  deterministic: { pass: boolean; issues: string[] };
  lenses: LensVerdict[];
  model: boolean; // true if the LLM ensemble ran; false = deterministic-only
}

const LensSchema = z.object({
  pass: z.boolean(),
  confidence: z.number().min(0).max(1),
  rationale: z.string().default(''),
});

/** Pure: pull the executed steps out of a receipt chain (no LLM). */
export function gatherExecutedSteps(chain: ReceiptChain): ExecutedStep[] {
  // Fold completed settlement into the matching pay step. The `settle` entry holds
  // the REAL on-chain tx, but it's a separate entry the verifier wouldn't otherwise
  // see — so a settled payment looked like "awaiting settlement / no tx hash" to the
  // critic. Surfacing the tx here keeps the verdict consistent with what settled.
  const settleByStep = new Map<string, { txId?: string; asset?: string; amountUsd?: number; amountWei?: string; explorer?: string | null }>();
  for (const e of chain.entries) {
    if (e.kind === 'settle') {
      const d = e.data as { stepId?: string; txId?: string; asset?: string; amountUsd?: number; amountWei?: string; explorer?: string | null };
      if (d.stepId) settleByStep.set(String(d.stepId), d);
    }
  }
  return chain.entries
    .filter(e => e.kind === 'execute_step')
    .map(e => {
      const d = e.data as { stepId?: string; tool?: string; ok?: boolean; outcome?: string; output?: Record<string, unknown> };
      const stepId = String(d.stepId ?? '');
      let outcome = String(d.outcome ?? '');
      let output = (d.output as Record<string, unknown>) ?? {};
      const s = settleByStep.get(stepId);
      if (s?.txId && (output as { awaitingSettlement?: boolean }).awaitingSettlement) {
        const ethAmt = s.amountWei ? Number(s.amountWei) / 1e18 : 0;
        const ethStr = ethAmt > 0 ? String(Number(ethAmt.toPrecision(3))) : '0';
        outcome = `payment SETTLED on-chain by the governed treasury — runtime-confirmed COMPLETED transaction (not a claim), ${ethStr} ETH (≈ $${s.amountUsd ?? ''}), full tx hash ${s.txId}`;
        output = { ...output, awaitingSettlement: false, settled: true, txId: s.txId, settlementAsset: s.asset ?? 'ETH', amountWei: s.amountWei };
      }
      return {
        stepId,
        tool: String(d.tool ?? ''),
        ok: d.ok !== false,
        outcome,
        output,
      };
    });
}

const isSkipped = (s: ExecutedStep) => !!(s.output as { skipped?: boolean })?.skipped;

/**
 * DETERMINISTIC checks — substantive, per-tool (not just the ok flag). This is the
 * floor that holds even with no LLM, and it kills the rubber-stamp: a step that
 * "ran" but produced nothing fails here.
 */
export function deterministicChecks(executed: ExecutedStep[]): { pass: boolean; issues: string[] } {
  const issues: string[] = [];
  const real = executed.filter(s => !isSkipped(s));
  if (real.length === 0) issues.push('no executed steps produced output');
  for (const s of real) {
    if (!s.ok) { issues.push(`${s.stepId} (${s.tool}) failed: ${s.outcome}`); continue; }
    const o = s.output as Record<string, unknown>;
    if (s.tool === 'research' && !(typeof o.brief === 'string' && o.brief.length > 20)) issues.push(`${s.stepId} research produced no substantive brief`);
    if (s.tool === 'fetch' && !(typeof o.text === 'string' && o.text.length > 0)) issues.push(`${s.stepId} fetch returned no readable text`);
    if (s.tool === 'draft' && !(typeof o.body === 'string' && o.body.length > 20)) issues.push(`${s.stepId} draft produced no substantive body`);
    if (s.tool === 'compute' && o.exitCode !== undefined && o.exitCode !== 0) issues.push(`${s.stepId} compute exited ${String(o.exitCode)}`);
    if (s.tool === 'send' && !(o.delivered === true)) issues.push(`${s.stepId} send did not confirm real delivery`);
  }
  return { pass: issues.length === 0, issues };
}

// Clip a value for the critic prompt, but mark display-truncation EXPLICITLY so a
// critic never mistakes "my view was shortened" for "the document is cut off".
function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)} […display-truncated for review; the actual content continues and is complete]` : s;
}
function summarizeOutput(output: Record<string, unknown>): string {
  const o = output;
  const parts: string[] = [];
  if (typeof o.brief === 'string') parts.push(`brief: ${clip(o.brief, 1500)}`);
  if (typeof o.body === 'string') parts.push(`draft (the deliverable, judge in full): ${clip(o.body, 4000)}`);
  if (typeof o.stdout === 'string') parts.push(`stdout: ${clip(o.stdout, 600)}`);
  if (typeof o.text === 'string') parts.push(`fetched: ${clip(o.text, 900)}`);
  if (Array.isArray(o.sources)) parts.push(`sources: ${(o.sources as string[]).length}`);
  if (o.delivered) parts.push(`delivered via ${String(o.channel ?? '?')}`);
  if (o.deliveredMock) parts.push('delivery: mock');
  if (typeof o.recipientValid === 'boolean') parts.push(`recipient address EIP-55 validity (deterministic, runtime-authoritative): ${o.recipientValid}`);
  if (o.settled || o.txId) parts.push(`payment SETTLED on-chain by the governed treasury (runtime-confirmed completed tx, not a claim) · ${String(o.settlementAsset ?? 'ETH')} · full tx ${String(o.txId ?? '')}`);
  else if (o.status === 'authorized') parts.push('payment authorized (awaiting settlement)');
  if (o.skipped) parts.push('skipped');
  return parts.join(' · ') || '(no output)';
}

const LENSES: Array<{ lens: string; instruction: string }> = [
  { lens: 'completeness', instruction: 'Did the agent address EVERY part of the goal? Pass only if nothing the goal asked for is missing.' },
  { lens: 'correctness', instruction: 'Are the outputs actually correct, faithful to sources, and free of fabrication? Pass only if the substance is sound.' },
  { lens: 'skeptic', instruction: 'You are an adversarial reviewer. Find the STRONGEST reason the goal was NOT truly met. Default to pass=false if you find a real gap; pass=true only if you genuinely cannot.' },
];

function lensPrompt(lens: string, instruction: string): string {
  return `You are the "${lens}" critic in a verification ensemble for a governed AI agent. ${instruction}
GROUND TRUTH: facts marked "runtime-confirmed" or "deterministic" (e.g. a SETTLED on-chain payment with a full tx hash, or a deterministic EIP-55 address validation) are verified by the runtime/blockchain — treat them as TRUE; never call them unverifiable, fabricated, or hallucinated. A full 0x tx hash IS the on-chain evidence. Judge only whether the GOAL's intent was actually met by the work shown.
Output STRICT JSON only: {"pass":boolean,"confidence":0..1,"rationale":"<1-2 sentences>"}`;
}

async function runLens(lens: string, instruction: string, goal: string, stepsText: string): Promise<LensVerdict | null> {
  try {
    const raw = await complete(lensPrompt(lens, instruction), `GOAL: ${goal}\n\nEXECUTED STEPS:\n${stepsText}`, 400);
    const v = LensSchema.parse(extractJson(raw));
    return { lens, pass: v.pass, confidence: v.confidence, rationale: v.rationale };
  } catch {
    return null;
  }
}

/** Verify a completed mission against its goal (hybrid: deterministic + LLM ensemble). Never throws. */
export async function verifyMission(goal: string, executed: ExecutedStep[]): Promise<MissionVerdict> {
  const deterministic = deterministicChecks(executed);
  const perStep = executed.map(s => ({ stepId: s.stepId, ok: s.ok, assessment: s.outcome }));

  if (executed.length === 0) {
    return { goalMet: false, confidence: 0.2, rationale: 'No steps executed.', gaps: deterministic.issues, perStep, deterministic, lenses: [], model: false };
  }

  const stepsText = executed.map(s => `- ${s.stepId} [${s.tool}] ok=${s.ok} — ${s.outcome}\n    ${summarizeOutput(s.output)}`).join('\n');
  const lenses = (await Promise.all(LENSES.map(l => runLens(l.lens, l.instruction, goal, stepsText)))).filter((x): x is LensVerdict => x !== null);

  // Deterministic-only fallback (LLM down) — still substantive.
  if (lenses.length === 0) {
    return {
      goalMet: deterministic.pass,
      confidence: deterministic.pass ? 0.6 : 0.3,
      rationale: deterministic.pass ? 'All steps produced substantive output (deterministic check; LLM ensemble unavailable).' : `Deterministic check found gaps: ${deterministic.issues.join('; ')}`,
      gaps: deterministic.issues,
      perStep, deterministic, lenses: [], model: false,
    };
  }

  const passes = lenses.filter(l => l.pass).length;
  const ensemblePass = passes > lenses.length / 2; // strict majority
  const goalMet = deterministic.pass && ensemblePass;
  const meanConf = lenses.reduce((a, l) => a + l.confidence, 0) / lenses.length;
  const confidence = goalMet ? meanConf : Math.min(meanConf, 0.5);
  const gaps = [
    ...deterministic.issues,
    ...lenses.filter(l => !l.pass).map(l => `[${l.lens}] ${l.rationale}`),
  ];
  const rationale = goalMet
    ? `${passes}/${lenses.length} critics confirm the goal was met; deterministic checks passed.`
    : `Goal not fully met — ${deterministic.pass ? '' : 'deterministic gaps; '}${lenses.length - passes}/${lenses.length} critics dissent.`;

  return { goalMet, confidence, rationale, gaps, perStep, deterministic, lenses, model: true };
}

/** Human-readable receipt summary line for a verdict. */
export function verdictSummary(v: MissionVerdict): string {
  const pct = Math.round(v.confidence * 100);
  const ens = v.lenses.length ? ` · ${v.lenses.filter(l => l.pass).length}/${v.lenses.length} critics` : '';
  return v.goalMet ? `Self-verified: goal met (confidence ${pct}%${ens})` : `Self-verified: goal NOT fully met (confidence ${pct}%${ens})`;
}
