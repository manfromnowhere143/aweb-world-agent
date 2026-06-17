/**
 * Safe, governed tool set for the MVP.
 *
 * READ_ONLY / REVERSIBLE tools do real LLM work and run automatically (logged).
 * SENSITIVE (send) and VALUE_MOVEMENT (pay) tools are the irreversible steps that
 * the Trust Runtime blocks until a verified human approves the exact plan. In the
 * MVP, send/pay perform a governed mock so the loop is end-to-end without spending.
 */
import type { RiskClass } from '../trust/types';
import { complete } from '../agent/anthropic';
import { liveResearch } from '../agent/research';
import { buildComputeRequest, runAwebSandbox } from '../agent/aweb-sandbox';

export interface ToolDef {
  slug: string;
  label: string;
  riskClass: RiskClass;
  description: string;
}

export const TOOLS: ToolDef[] = [
  { slug: 'research', label: 'Research & brief', riskClass: 'READ_ONLY', description: 'Research a question and return a concise, sourced brief. No side effects.' },
  { slug: 'draft', label: 'Draft content', riskClass: 'REVERSIBLE', description: 'Draft a message, email, or document for the human to review. Editable, no delivery.' },
  { slug: 'compute', label: 'Run code (sandbox)', riskClass: 'REVERSIBLE', description: 'Run code (python/javascript/bash) in a governed, isolated, no-network sandbox to compute, analyze, or verify. Returns output + a sandbox proof receipt. No external side effects.' },
  { slug: 'send', label: 'Send / deliver', riskClass: 'SENSITIVE', description: 'Deliver a drafted message (email/notification). Irreversible — requires human approval.' },
  { slug: 'pay', label: 'Pay / transact', riskClass: 'VALUE_MOVEMENT', description: 'Move funds via World Wallet. Requires human approval + value cap. (Gated off in MVP.)' },
];

export const TOOL_SLUGS = TOOLS.map(t => t.slug);
export const toolBySlug = (slug: string) => TOOLS.find(t => t.slug === slug);

export interface ToolRunResult {
  ok: boolean;
  outcome: string;
  output?: Record<string, unknown>;
  costUsd?: number;
  error?: string;
}

/** Dry-run description of what a step would do (no side effects). */
export async function simulateTool(slug: string, args: Record<string, unknown>): Promise<{ expected: string; output?: Record<string, unknown> }> {
  const t = toolBySlug(slug);
  switch (slug) {
    case 'research':
      return { expected: `Research "${args.query ?? args.topic ?? '...'}" and return a sourced brief (read-only).` };
    case 'draft':
      return { expected: `Draft "${args.title ?? args.subject ?? 'content'}" for your review (reversible, no delivery).` };
    case 'compute':
      return { expected: `Run ${String(args.language ?? 'python')} code in a governed no-network sandbox and return its output + a proof receipt (reversible, no external effects).` };
    case 'send':
      return { expected: `Deliver "${args.subject ?? 'message'}" to ${args.to ?? 'recipient'} — irreversible, needs your approval.` };
    case 'pay':
      return { expected: `Pay $${args.amountUsd ?? '?'} to ${args.to ?? 'payee'} via World Wallet — needs approval + within cap.` };
    default:
      return { expected: `Run ${t?.label ?? slug}.` };
  }
}

/** Prior step results, in order, so later steps can build on earlier ones. */
export type PriorOutputs = Array<{ tool: string; output?: Record<string, unknown> }>;
const lastByTool = (priors: PriorOutputs, tool: string) => [...priors].reverse().find(p => p.tool === tool)?.output;

/** Actually run a step (only reached after governance permits it). */
export async function runTool(slug: string, args: Record<string, unknown>, priors: PriorOutputs = []): Promise<ToolRunResult> {
  try {
    switch (slug) {
      case 'research': {
        const q = String(args.query ?? args.topic ?? '');
        const r = await liveResearch(q);
        return {
          ok: true,
          outcome: r.grounded ? `web-grounded brief (${r.citations.length} sources)` : 'brief produced (model knowledge)',
          output: { brief: r.answer, sources: r.citations, grounded: r.grounded },
        };
      }
      case 'draft': {
        const research = lastByTool(priors, 'research');
        const brief = String(args.context ?? args.brief ?? research?.brief ?? '');
        const sources = Array.isArray(research?.sources) ? (research!.sources as string[]) : [];
        const subject = String(args.subject ?? args.title ?? 'Draft');
        const body = await complete(
          'You are a sharp writer. Produce a clear, ready-to-send draft grounded in the provided research. No preamble. If sources are given, weave the facts in faithfully.',
          `Write "${subject}".\nResearch context:\n${brief || '(none)'}\n${sources.length ? `Sources:\n${sources.join('\n')}` : ''}\nAudience/intent: ${String(args.intent ?? 'general')}`,
          1000,
        );
        return { ok: true, outcome: 'draft produced', output: { subject, body, sources } };
      }
      case 'compute': {
        // Run real code in Aweb's governed E2B sandbox (no-network, secret-forbid,
        // budget-capped). The returned Aweb receipts are nested into OUR receipt
        // chain as proof, so the artifact is triple-attested:
        //   verified human (World ID) → governed sandbox (Aweb) → sealed chain (us).
        const { files, command } = buildComputeRequest(args);
        const reason = String(args.intent ?? args.reason ?? 'World agent governed compute step.');
        const sandbox = await runAwebSandbox({ files, command, reason });

        if (!sandbox.configured) {
          // Missing backend must never break the governed mission — clean skip.
          return {
            ok: true,
            outcome: 'compute skipped — Aweb sandbox not configured',
            output: { skipped: true, configured: false, reason: sandbox.error },
          };
        }

        const langLabel = String(args.language ?? (Array.isArray(args.files) ? 'files' : 'python'));
        return {
          ok: sandbox.ok,
          outcome: sandbox.ok
            ? `sandbox run exited 0${sandbox.durationMs ? ` (${(sandbox.durationMs / 1000).toFixed(1)}s)` : ''}`
            : sandbox.error
              ? `sandbox error: ${sandbox.error}`
              : `sandbox run exited ${sandbox.exitCode ?? '?'}`,
          output: {
            language: langLabel,
            exitCode: sandbox.exitCode,
            stdout: sandbox.stdout,
            stderr: sandbox.stderr,
            sessionId: sandbox.sessionId,
            // Nested governed proof — flows into our hash-chained receipt.
            aweb_sandbox_receipt: sandbox.sandboxReceipt,
            aweb_agent_receipt: sandbox.agentReceipt,
          },
          ...(sandbox.error ? { error: sandbox.error } : {}),
        };
      }
      case 'send': {
        // MVP: governed mock delivery (no real send). Real adapters wire in later.
        const draft = lastByTool(priors, 'draft');
        const subject = String(args.subject ?? draft?.subject ?? 'message');
        const body = String(args.body ?? draft?.body ?? '');
        return { ok: true, outcome: 'delivered (governed mock)', output: { to: args.to ?? 'recipient', subject, preview: body.slice(0, 140), deliveredMock: true } };
      }
      case 'pay': {
        // Authorize ONLY. Funds never move server-side — settlement happens
        // client-side via the World Wallet (MiniKit Pay) after World ID approval,
        // then the on-chain tx is verified and recorded in the receipt.
        const to = String(args.to ?? args.payee ?? '').trim();
        const amountUsd = Number(args.amountUsd ?? args.amount ?? 0);
        const currency = String(args.currency ?? args.token ?? 'USDC').toUpperCase();
        if (!to || !(amountUsd > 0)) {
          return { ok: false, outcome: 'invalid payment', error: 'pay requires a `to` recipient and a positive `amountUsd`' };
        }
        return {
          ok: true,
          outcome: `payment authorized — ${amountUsd} ${currency} → ${to} (awaiting wallet settlement)`,
          output: { status: 'authorized', awaitingSettlement: true, to, amountUsd, currency },
        };
      }
      default:
        return { ok: false, outcome: 'unknown tool', error: `no such tool '${slug}'` };
    }
  } catch (e) {
    return { ok: false, outcome: 'tool error', error: e instanceof Error ? e.message : String(e) };
  }
}
