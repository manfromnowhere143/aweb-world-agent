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

/** Extract the first JSON object/array from a model response (robust to fences). */
export function extractJson<T>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1]! : text;
  const start = raw.search(/[[{]/);
  if (start === -1) throw new Error('no JSON found in model output');
  // find matching end by scanning
  const open = raw[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  for (let i = start; i < raw.length; i++) {
    if (raw[i] === open) depth++;
    else if (raw[i] === close) {
      depth--;
      if (depth === 0) return JSON.parse(raw.slice(start, i + 1)) as T;
    }
  }
  throw new Error('unbalanced JSON in model output');
}
