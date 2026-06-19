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
import { runE2B } from '../agent/e2b-sandbox';
import { fetchReadable } from '../agent/fetch-tool';
import { deliver } from '../agent/send-tool';
import { isValidAddress } from '../chain/pay';

export interface ToolDef {
  slug: string;
  label: string;
  riskClass: RiskClass;
  description: string;
}

export const TOOLS: ToolDef[] = [
  { slug: 'research', label: 'Research & brief', riskClass: 'READ_ONLY', description: 'Research a question and return a concise, sourced brief. No side effects.' },
  { slug: 'fetch', label: 'Read a web page', riskClass: 'READ_ONLY', description: 'Fetch a specific public https URL and return its readable text + title. No secrets, no side effects.' },
  { slug: 'draft', label: 'Draft content', riskClass: 'REVERSIBLE', description: 'Draft a message, email, or document for the human to review. Editable, no delivery.' },
  { slug: 'compute', label: 'Run code (sandbox)', riskClass: 'REVERSIBLE', description: 'Run code (python/javascript/bash) in a governed, isolated, ephemeral E2B sandbox to compute, analyze, or verify. Returns output + a hashed sandbox proof. No side effects on your accounts.' },
  { slug: 'send', label: 'Send / deliver', riskClass: 'SENSITIVE', description: 'Really deliver a drafted message — email, SMS, Telegram, or webhook (auto-routed by the recipient in args.to). Irreversible — requires human approval.' },
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
    case 'fetch':
      return { expected: `Fetch ${args.url ?? 'a public https URL'} and return its readable text + title (read-only).` };
    case 'draft':
      return { expected: `Draft "${args.title ?? args.subject ?? 'content'}" for your review (reversible, no delivery).` };
    case 'compute':
      return { expected: `Run ${String(args.language ?? 'python')} code in a governed, isolated E2B sandbox and return its output + a hashed sandbox proof (reversible, no side effects on your accounts).` };
    case 'send':
      return { expected: `Really deliver "${args.subject ?? 'message'}" to ${args.to ?? args.webhookUrl ?? 'recipient'} (${args.channel ?? 'auto-routed'}) — irreversible, needs your approval.` };
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
      case 'fetch': {
        const url = String(args.url ?? args.href ?? '');
        const r = await fetchReadable(url);
        if (!r.ok) return { ok: false, outcome: 'fetch failed', error: r.error || `status ${r.status ?? '?'}`, output: { url: r.url, status: r.status } };
        return {
          ok: true,
          outcome: `fetched ${r.url} (${r.status})${r.title ? ` — ${r.title}` : ''}`,
          output: { url: r.url, status: r.status, title: r.title, text: r.text, grounded: true, sources: r.url ? [r.url] : [] },
        };
      }
      case 'draft': {
        const research = lastByTool(priors, 'research') ?? lastByTool(priors, 'fetch');
        const brief = String(args.context ?? args.brief ?? research?.brief ?? research?.text ?? '');
        const sources = Array.isArray(research?.sources) ? (research!.sources as string[]) : [];
        const subject = String(args.subject ?? args.title ?? 'Draft');
        const body = await complete(
          'You are a sharp, professional writer. Produce a clear, ready-to-send draft GROUNDED STRICTLY in the provided research. Use the SPECIFIC names, entities, numbers, and facts from the research verbatim — if the research names particular things (e.g. specific apps, people, figures), the draft MUST name and address those exact items. Do NOT generalize them into vague categories, and do NOT invent details, framings, or examples that are not in the research. Honor the requested format and any length/count the task specifies. Clean, businesslike voice. NO emojis, no filler, no preamble.',
          `Write "${subject}".\nResearch context:\n${brief || '(none)'}\n${sources.length ? `Sources:\n${sources.join('\n')}` : ''}\nAudience/intent: ${String(args.intent ?? 'general')}`,
          1000,
        );
        return { ok: true, outcome: 'draft produced', output: { subject, body, sources } };
      }
      case 'compute': {
        // Run real code DIRECTLY in a governed, ephemeral E2B sandbox (sovereign —
        // no dependency on any other backend). The hashed sandbox proof nests into
        // OUR receipt chain, so the artifact is triple-attested:
        //   verified human (World ID) → governed E2B sandbox → Ed25519-sealed chain.
        const code = String(args.code ?? '');
        const language = String(args.language ?? 'python');
        const r = await runE2B({ code, language, timeoutMs: Number(args.timeoutMs) || 60_000 });

        if (!r.configured) {
          // Missing key must never break the governed mission — clean skip.
          return { ok: true, outcome: 'compute skipped — E2B not configured', output: { skipped: true, configured: false, reason: r.error } };
        }
        return {
          ok: r.ok,
          outcome: r.ok
            ? `ran ${language} in E2B → exit 0${r.durationMs ? ` (${(r.durationMs / 1000).toFixed(1)}s)` : ''}`
            : r.error
              ? `sandbox error: ${r.error}`
              : `sandbox exit ${r.exitCode ?? '?'}`,
          output: {
            language,
            exitCode: r.exitCode,
            stdout: r.stdout,
            stderr: r.stderr,
            sandboxId: r.sandboxId,
            // Nested, hashed governed proof — flows into our hash-chained receipt.
            sandbox_proof: r.sandboxProof,
          },
          ...(r.error ? { error: r.error } : {}),
        };
      }
      case 'send': {
        // This step only runs AFTER a verified human approved the exact plan.
        // REAL delivery — auto-routed by recipient (email/SMS/Telegram/webhook).
        // No mocks: if it can't truly deliver, it fails honestly.
        const draft = lastByTool(priors, 'draft');
        const subject = String(args.subject ?? draft?.subject ?? 'Message from your Aweb Agent');
        const body = String(args.body ?? draft?.body ?? '');
        const r = await deliver({ to: args.to as string, channel: args.channel as string, webhookUrl: (args.webhookUrl ?? args.webhook) as string, subject, body });
        if (!r.ok) return { ok: false, outcome: `delivery failed (${r.channel})`, error: r.error, output: { channel: r.channel, to: r.to, status: r.status } };
        return {
          ok: true,
          outcome: `delivered for real via ${r.channel} → ${r.to}${r.status ? ` (${r.status})` : ''}`,
          output: { channel: r.channel, to: r.to, subject, id: r.id, status: r.status, delivered: true, real: true },
        };
      }
      case 'pay': {
        // Authorize ONLY here. After World ID approval, settlement happens in a
        // separate step: the governed agent treasury settles it on-chain as a
        // NATIVE ETH transfer (server-side), and the real tx is recorded in the
        // receipt. (A client World Wallet path exists only as a fallback.)
        const to = String(args.to ?? args.payee ?? '').trim();
        const amountUsd = Number(args.amountUsd ?? args.amount ?? 0);
        const currency = String(args.currency ?? args.token ?? 'USDC').toUpperCase();
        if (!to || !(amountUsd > 0)) {
          return { ok: false, outcome: 'invalid payment', error: 'pay requires a `to` recipient and a positive `amountUsd`' };
        }
        // Deterministic, authoritative EIP-55 validation (TS — not model-judged). This
        // is the validity the governance gate enforces, so the agent cannot move value
        // to an address that fails it regardless of what a compute step claims.
        const recipientValid = isValidAddress(to);
        return {
          ok: true,
          outcome: recipientValid
            ? `governed payment authorized — ≈$${amountUsd} → ${to}; settles as a native-ETH agent-treasury transfer (awaiting settlement)`
            : `payment authorized but recipient ${to} FAILED deterministic EIP-55 validation — settlement will be WITHHELD by the governance gate`,
          output: { status: 'authorized', awaitingSettlement: true, to, amountUsd, currency, recipientValid, settlementAsset: 'ETH', settlementRail: 'agent-treasury (native ETH on World Chain)' },
        };
      }
      default:
        return { ok: false, outcome: 'unknown tool', error: `no such tool '${slug}'` };
    }
  } catch (e) {
    return { ok: false, outcome: 'tool error', error: e instanceof Error ? e.message : String(e) };
  }
}
