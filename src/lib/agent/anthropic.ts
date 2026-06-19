/** Clean Anthropic client for the Web3 department (no coupling to core Aweb). */
import Anthropic from '@anthropic-ai/sdk';

export const AGENT_MODEL = 'claude-sonnet-4-6';

let client: Anthropic | null = null;
export function anthropic(): Anthropic {
  if (!client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
    client = new Anthropic({ apiKey });
  }
  return client;
}

/** Single-turn text completion with a system + user prompt. */
export async function complete(system: string, user: string, maxTokens = 1500): Promise<string> {
  const res = await anthropic().messages.create({
    model: AGENT_MODEL,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: user }],
  });
  return res.content.filter(b => b.type === 'text').map(b => (b as { text: string }).text).join('\n').trim();
}

/** Extract the first JSON object/array from a model response (robust to fences).
 * STRING-AWARE: braces/brackets inside JSON string values (e.g. code in args.code)
 * are ignored, so embedded `{ }` no longer break the boundary scan. */
export function extractJson<T>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1]! : text;
  const start = raw.search(/[[{]/);
  if (start === -1) throw new Error('no JSON found in model output');
  const open = raw[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return JSON.parse(raw.slice(start, i + 1)) as T;
    }
  }
  throw new Error('unbalanced JSON in model output (likely truncated — raise max_tokens)');
}
